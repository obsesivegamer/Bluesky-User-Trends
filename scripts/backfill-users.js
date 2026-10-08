#!/usr/bin/env node
// Rebuilds data/users-samples.json (the provenance of the daily users series) from every
// archive of Bluesky's total user count. Re-runnable: downloads are cached in .cache/ and the
// samples already in data/users-samples.json (e.g. jazco readings saved by updateData.js) are kept.
//
// Usage: node scripts/backfill-users.js [options]
//   --seed-from DIR      copy a research download folder (wiki/, wb/, hourlybot/, elaval/,
//                        krekeny/, jazco_stats.json) into the cache first
//   --offline            use only the cache and the existing samples file
//   --refresh            re-download the live sources (bot feed, Krekeny, jazco)
//   --no-wayback         don't fetch Wayback captures missing from the cache
//   --wayback-limit N    fetch at most N missing captures this run (default: all)
//   --retry-failed       retry captures that came back empty three times before
//   --out FILE           output path (default data/users-samples.json)
//   --cache DIR          cache directory (default .cache)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const users = require('../lib/users.js');

const ROOT = path.join(__dirname, '..');
const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const COMMONS_API =
  'https://commons.wikimedia.org/w/api.php?action=query&titles=File:Bluesky_Registered_Users.svg' +
  '&prop=revisions&rvprop=content|timestamp&rvslots=main&format=json';
const WAYBACK_CDX =
  'https://web.archive.org/cdx/search/cdx?url=bsky-search.jazco.io/stats&output=json' +
  '&fl=timestamp,statuscode,mimetype&filter=statuscode:200';
const waybackUrl = (ts) => `https://web.archive.org/web/${ts}id_/https://bsky-search.jazco.io/stats`;
const BOT_ACTOR = 'did:plc:5he4nkza7eqhmirg3azchqy6';
const BOT_FEED = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${BOT_ACTOR}&limit=100&filter=posts_no_replies`;
const BOT_PATTERN = /Total Bluesky users: ([\d,]+)/;
const ELAVAL_CSV = 'https://raw.githubusercontent.com/elaval/bskyusers/refs/heads/main/bsky_users_history.csv';
const KREKENY_JSON = 'https://raw.githubusercontent.com/Krekeny/bluesky-stats/main/docs/data/stats.json';
const JAZCO_STATS = 'https://bsky-search.jazco.io/stats';
// Krekeny stores only the date. Matching its values against the hourly bot puts the reading at
// a median of 02:58 UTC (10th–90th percentile 02:18–05:24), so it is timestamped at 03:00.
const KREKENY_TIME = 'T03:00:00Z';
const WAYBACK_GAP_MS = 6500;
const WAYBACK_MAX_ATTEMPTS = 3;
const WAYBACK_GIVE_UP_AFTER = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { seedFrom: null, offline: false, refresh: false, wayback: true, waybackLimit: Infinity, retryFailed: false,
    out: path.join(ROOT, 'data', 'users-samples.json'), cache: path.join(ROOT, '.cache') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed-from') opts.seedFrom = argv[++i];
    else if (a === '--offline') opts.offline = true;
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '--no-wayback') opts.wayback = false;
    else if (a === '--wayback-limit') opts.waybackLimit = Number(argv[++i]);
    else if (a === '--retry-failed') opts.retryFailed = true;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--cache') opts.cache = path.resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const readJson = (file, fallback = null) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));

async function get(url, { binary = false, timeoutMs = 60000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

// ---------- parsers (input is untrusted data: parse, never evaluate) ----------

// The file page wikitext embeds `data_array = [ "YYYY-MM-DD, N", ... ]` (a Python list).
function parseCommons(apiJson) {
  const pages = Object.values(apiJson?.query?.pages || {});
  const text = pages[0]?.revisions?.[0]?.slots?.main?.['*'] ?? pages[0]?.revisions?.[0]?.slots?.main?.content;
  if (typeof text !== 'string') throw new Error('commons: no wikitext in API response');
  const start = text.indexOf('data_array = [');
  const end = text.indexOf(']', start);
  if (start === -1 || end === -1) throw new Error('commons: data_array not found');
  const points = [...text.slice(start, end).matchAll(/"(\d{4}-\d{2}-\d{2}),\s*(\d+)"/g)].map((m) => ({ date: m[1], users: Number(m[2]) }));
  if (points.length < 500) throw new Error(`commons: only ${points.length} points parsed`);
  return points;
}

function commonsSamples(points) {
  return points
    .filter((p) => p.date <= users.COMMONS_LAST_DATE && !users.COMMONS_INTERPOLATED.some(([a, b]) => p.date >= a && p.date <= b))
    .map((p) => ({ t: users.boundaryMs(p.date), src: 'commons', users: p.users }));
}

function decodeWaybackBody(buf) {
  const bytes = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const text = bytes.toString('utf8').trim();
  if (!text) return null;
  const json = JSON.parse(text);
  return { updated_at: json.updated_at ?? null, total_users: Number.isSafeInteger(json.total_users) ? json.total_users : null };
}

function parseBotPost(item) {
  const post = item?.post;
  if (!post || item.reason || post.author?.did !== BOT_ACTOR) return null;
  const m = BOT_PATTERN.exec(post.record?.text || '');
  const t = Date.parse(post.record?.createdAt);
  if (!m || !Number.isFinite(t)) return null;
  return [post.record.createdAt, Number(m[1].replace(/,/g, ''))];
}

function parseElavalCsv(text) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const [ts, n] = line.trim().split(',');
    if (!ts || !n) continue;
    const t = Date.parse(ts.replace(' ', 'T') + 'Z');
    if (Number.isFinite(t) && /^\d+$/.test(n)) out.push({ t, src: 'elaval', users: Number(n) });
  }
  return out;
}

// ---------- cache seeding ----------

function seedCache(dir, cache, log) {
  const copy = (from, to) => {
    const src = path.join(dir, from);
    const dst = path.join(cache, to);
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    log(`seeded ${to}`);
  };
  copy('wiki/file.json', 'commons/file.json');
  copy('hourlybot/rows.json', 'hourlybot/rows.json');
  copy('elaval/hist.csv', 'elaval/hist.csv');
  copy('krekeny/stats.json', 'krekeny/stats.json');
  copy('jazco_stats.json', 'jazco/stats.json');
  copy('wb/cdx_jazco.json', 'wayback/cdx-daily.json');
  const snapsDir = path.join(dir, 'wb', 'snaps');
  if (fs.existsSync(snapsDir)) {
    let n = 0;
    for (const f of fs.readdirSync(snapsDir)) {
      const m = /^(\d{14})\.json$/.exec(f);
      const dst = path.join(cache, 'wayback', 'snaps', `${m?.[1]}.json`);
      if (!m || fs.existsSync(dst)) continue;
      let entry;
      try {
        entry = decodeWaybackBody(fs.readFileSync(path.join(snapsDir, f)));
      } catch {
        continue;
      }
      if (!entry) continue;
      writeJson(dst, { timestamp: m[1], ...entry });
      n++;
    }
    if (n) log(`seeded ${n} Wayback captures`);
  }
}

// ---------- sources ----------

async function loadCommons(opts, log) {
  const file = path.join(opts.cache, 'commons', 'file.json');
  if (!fs.existsSync(file) && !opts.offline) {
    log('fetching Commons file page');
    writeFile(file, await get(COMMONS_API));
  }
  if (!fs.existsSync(file)) return [];
  return commonsSamples(parseCommons(readJson(file)));
}

async function loadWayback(opts, log) {
  const dir = path.join(opts.cache, 'wayback');
  const snapsDir = path.join(dir, 'snaps');
  const failedFile = path.join(dir, 'failed.json');
  const failed = readJson(failedFile, {});
  if (opts.wayback && !opts.offline) {
    let cdx = null;
    try {
      log('fetching Wayback CDX list');
      cdx = JSON.parse(await get(WAYBACK_CDX, { timeoutMs: 120000 }));
      writeJson(path.join(dir, 'cdx.json'), cdx);
    } catch (err) {
      log(`Wayback CDX unavailable (${err.message}); using cached captures only`);
      cdx = readJson(path.join(dir, 'cdx.json'));
    }
    const want = (cdx || []).slice(1).map((r) => r[0]).filter((ts) => /^\d{14}$/.test(ts));
    const missing = want.filter((ts) => !fs.existsSync(path.join(snapsDir, `${ts}.json`)) && (opts.retryFailed || (failed[ts] || 0) < WAYBACK_MAX_ATTEMPTS));
    const todo = missing.slice(0, opts.waybackLimit);
    log(`Wayback: ${want.length} captures listed, ${missing.length} not cached, fetching ${todo.length}`);
    let streak = 0;
    for (const [i, ts] of todo.entries()) {
      if (streak >= WAYBACK_GIVE_UP_AFTER) {
        log(`Wayback: ${streak} failures in a row, giving up for this run`);
        break;
      }
      await sleep(i ? WAYBACK_GAP_MS : 0);
      try {
        const entry = decodeWaybackBody(await get(waybackUrl(ts), { binary: true }));
        if (!entry) throw new Error('empty body');
        writeJson(path.join(snapsDir, `${ts}.json`), { timestamp: ts, ...entry });
        if (failed[ts]) {
          delete failed[ts];
          writeJson(failedFile, failed);
        }
        streak = 0;
      } catch (err) {
        failed[ts] = (failed[ts] || 0) + 1;
        writeJson(failedFile, failed);
        streak++;
        log(`Wayback ${ts}: ${err.message} (attempt ${failed[ts]})`);
        await sleep(WAYBACK_GAP_MS * 2 ** Math.min(streak, 4));
      }
      if ((i + 1) % 20 === 0) log(`Wayback: ${i + 1}/${todo.length}`);
    }
  }
  if (!fs.existsSync(snapsDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(snapsDir).sort()) {
    if (!/^\d{14}\.json$/.test(f)) continue;
    const e = readJson(path.join(snapsDir, f));
    const t = Date.parse(e?.updated_at);
    if (e && Number.isSafeInteger(e.total_users) && Number.isFinite(t)) out.push({ t, src: 'wayback', users: e.total_users });
  }
  return out;
}

async function loadBot(opts, log) {
  const file = path.join(opts.cache, 'hourlybot', 'rows.json');
  let rows = readJson(file, []);
  if (!opts.offline && (opts.refresh || !rows.length)) {
    const newest = rows.length ? Date.parse(rows[0][0]) : 0;
    const fresh = [];
    let cursor = null;
    for (let page = 0; page < 400; page++) {
      const url = BOT_FEED + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const body = JSON.parse(await get(url));
      const items = (body.feed || []).map(parseBotPost).filter(Boolean);
      fresh.push(...items);
      cursor = body.cursor;
      if (!cursor || !items.length || Date.parse(items[items.length - 1][0]) <= newest) break;
      await sleep(1000);
    }
    const byTs = new Map([...rows, ...fresh].map((r) => [r[0], r]));
    rows = [...byTs.values()].sort((a, b) => Date.parse(b[0]) - Date.parse(a[0]));
    writeJson(file, rows);
    log(`bot feed: ${fresh.length} posts read, ${rows.length} cached`);
  }
  return rows.map(([ts, n]) => ({ t: Date.parse(ts), src: 'bot', users: n }));
}

async function loadText(opts, rel, url, log, { refreshable }) {
  const file = path.join(opts.cache, rel);
  if (!opts.offline && (!fs.existsSync(file) || (opts.refresh && refreshable))) {
    try {
      writeFile(file, await get(url));
      log(`downloaded ${rel}`);
    } catch (err) {
      log(`${rel}: ${err.message}${fs.existsSync(file) ? ' (using cached copy)' : ''}`);
    }
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

async function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parseArgs(argv);
  if (opts.seedFrom) seedCache(path.resolve(opts.seedFrom), opts.cache, log);

  const existing = fs.existsSync(opts.out) ? users.parseSamplesFile(fs.readFileSync(opts.out, 'utf8')) : [];
  const commons = await loadCommons(opts, log);
  const bot = await loadBot(opts, log);
  const elavalText = await loadText(opts, 'elaval/hist.csv', ELAVAL_CSV, log, { refreshable: false });
  const elaval = elavalText ? parseElavalCsv(elavalText) : [];
  const krekenyText = await loadText(opts, 'krekeny/stats.json', KREKENY_JSON, log, { refreshable: true });
  const krekeny = krekenyText
    ? JSON.parse(krekenyText)
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r?.date) && Number.isSafeInteger(r.total_users))
        .map((r) => ({ t: Date.parse(r.date + KREKENY_TIME), src: 'krekeny', users: r.total_users }))
    : [];
  const jazcoText = await loadText(opts, 'jazco/stats.json', JAZCO_STATS, log, { refreshable: true });
  const jazcoJson = jazcoText ? JSON.parse(jazcoText) : null;
  const jazco = jazcoJson && Number.isSafeInteger(jazcoJson.total_users) && Number.isFinite(Date.parse(jazcoJson.updated_at))
    ? [{ t: Date.parse(jazcoJson.updated_at), src: 'jazco', users: jazcoJson.total_users }]
    : [];
  const wayback = await loadWayback(opts, log);

  const all = [...existing, ...commons, ...bot, ...elaval, ...krekeny, ...jazco, ...wayback];
  if (!commons.length && !existing.some((s) => s.src === 'commons')) throw new Error('no Commons data: the series cannot start in 2022');
  const { kept, dropped } = users.cleanSamples(all);
  const thinned = users.thinSamples(kept);
  writeFile(opts.out, users.serializeSamplesFile(thinned));

  const count = (list) => list.reduce((acc, s) => ((acc[s.src] = (acc[s.src] || 0) + 1), acc), {});
  log('input readings:', JSON.stringify(count(users.dedupeSamples(all))));
  log('dropped:', JSON.stringify(dropped.reduce((acc, s) => ((acc[`${s.src}/${s.reason}`] = (acc[`${s.src}/${s.reason}`] || 0) + 1), acc), {})));
  for (const run of summarizeDrops(dropped)) log(`  ${run}`);
  log('kept after thinning:', JSON.stringify(count(thinned)));
  log(`wrote ${path.relative(ROOT, opts.out)} (${fs.statSync(opts.out).size} bytes, ${thinned.length} samples)`);
  return { kept: thinned, dropped };
}

// "2026-02-24T01:00Z..2026-02-28T08:00Z plateau 42722227 (104 readings)" lines for the log.
function summarizeDrops(dropped) {
  const out = [];
  let cur = null;
  for (const s of dropped) {
    if (cur && cur.reason === s.reason && cur.users === s.users && s.t - cur.to <= 12 * users.HOUR_MS) {
      cur.to = s.t;
      cur.n++;
    } else {
      if (cur) out.push(cur);
      cur = { reason: s.reason, users: s.users, from: s.t, to: s.t, n: 1 };
    }
  }
  if (cur) out.push(cur);
  const fmt = (t) => new Date(t).toISOString().slice(0, 16) + 'Z';
  return out.map((r) => `${fmt(r.from)}..${fmt(r.to)} ${r.reason} ${r.users} (${r.n} readings)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main, parseCommons, commonsSamples, decodeWaybackBody, parseBotPost, parseElavalCsv, summarizeDrops, KREKENY_TIME };
