#!/usr/bin/env node
// Daily updater (run by .github/workflows/update-data.yml):
//   1. GET Jaz's /stats (activity history + the current total) and the @hourlybskyusers feed.
//   2. Append the new user-count readings to data/users-samples.json.
//   3. Rebuild data/bluesky-data.js and data/bluesky-daily.csv.
//   4. Pre-render index.html and sitemap.xml with lib/prerender.js when it exists.
// Nothing is written unless every step succeeds; a jazco failure exits non-zero.
//
// Env (test hooks): DATA_DIR, INDEX_FILE, SITEMAP_FILE, NOW (ISO time used as "now").

const fs = require('fs');
const path = require('path');
const users = require('./lib/users.js');
const jazco = require('./lib/jazco.js');
const build = require('./lib/build.js');

const ROOT = __dirname;
const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const JAZCO_URL = 'https://bsky-search.jazco.io/stats';
const BOT_URL =
  `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${build.LIVE_SOURCE.actor}` +
  '&limit=100&filter=posts_no_replies';
const BOT_PATTERN = new RegExp(build.LIVE_SOURCE.pattern);
const SNAPSHOT_MAX_AGE_MS = 2 * 3600e3;
const CLOCK_SKEW_MS = 10 * 60e3;
const FETCH_TIMEOUT_MS = 60e3;
const JAZCO_ATTEMPTS = 3;

async function fetchJson(fetchImpl, url, { attempts = 1, sleep, log }) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(5000 * i);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempts > 1) log.warn(`GET ${url} failed (attempt ${i + 1}/${attempts}): ${err.message}`);
    }
  }
  throw lastErr;
}

// Readings from the bot's posts: [{t, src:'bot', users}]. Reposts and other authors are ignored.
function botSamples(feed, nowMs) {
  const out = [];
  for (const item of feed?.feed || []) {
    const post = item?.post;
    if (!post || item.reason || post.author?.did !== build.LIVE_SOURCE.actor) continue;
    const m = BOT_PATTERN.exec(post.record?.text || '');
    const t = Date.parse(post.record?.createdAt);
    if (!m || !Number.isFinite(t) || t > nowMs + CLOCK_SKEW_MS) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isSafeInteger(n) && n > 0) out.push({ t, src: 'bot', users: n });
  }
  return out;
}

// Jaz's total only counts as a reading when its cache is fresh: a stale updated_at would put an
// old value at the wrong time.
function jazcoSample(snapshot, nowMs) {
  if (!snapshot) return null;
  const t = Date.parse(snapshot.updated_at);
  if (!(nowMs - t <= SNAPSHOT_MAX_AGE_MS && t <= nowMs + CLOCK_SKEW_MS)) return null;
  return { t, src: 'jazco', users: snapshot.total_users };
}

const SNAPSHOT_SOURCES = {
  jazco: 'bsky-search.jazco.io/stats',
  bot: 'hourlybskyusers.bsky.social (relays bsky-search.jazco.io/stats)',
};
const INDEX_TOTALS = ['total_posts', 'total_likes', 'total_follows'];

// The published headline never goes backwards in time: it is the newest of the readings that
// survived cleaning (a fresh jazco total only gets there when it is under 2h old and not part of a
// frozen plateau) and the snapshot already published. Index totals come from the newer of jazco's
// response and the published snapshot, field by field, so one missing total never blanks the page.
function pickSnapshot({ fresh, archive, samples }) {
  const at = (snap) => (snap ? Date.parse(snap.updated_at) : -Infinity);
  const newest = samples.filter((s) => s.src !== 'commons').at(-1);
  const freshT = fresh ? Math.floor(at(fresh) / 1000) * 1000 : NaN;
  let head = null;
  if (newest && newest.t > at(archive)) {
    head = newest.src === 'jazco' && newest.t === freshT && newest.users === fresh.total_users
      ? { total_users: fresh.total_users, updated_at: fresh.updated_at, source: fresh.source }
      : { total_users: newest.users, updated_at: new Date(newest.t).toISOString(), source: SNAPSHOT_SOURCES[newest.src] || `${newest.src} archive` };
  } else if (archive) {
    head = { total_users: archive.total_users, updated_at: archive.updated_at, source: archive.source };
  } else if (fresh) {
    head = { total_users: fresh.total_users, updated_at: fresh.updated_at, source: fresh.source };
  }
  if (!head) return null;
  const freshFirst = fresh && at(fresh) >= at(archive);
  const totals = {};
  for (const k of INDEX_TOTALS) {
    const a = fresh ? fresh[k] : null;
    const b = archive && Number.isSafeInteger(archive[k]) ? archive[k] : null;
    totals[k] = (freshFirst ? a ?? b : b ?? a) ?? null;
  }
  return { total_users: head.total_users, updated_at: head.updated_at, ...totals, source: head.source };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function loadPrerender(env) {
  const file = env.PRERENDER_MODULE || path.join(ROOT, 'lib', 'prerender.js');
  return fs.existsSync(file) ? require(file) : null;
}

async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  prerender = loadPrerender(env),
} = {}) {
  const dataDir = env.DATA_DIR || path.join(ROOT, 'data');
  const indexFile = env.INDEX_FILE || path.join(ROOT, 'index.html');
  const sitemapFile = env.SITEMAP_FILE || path.join(ROOT, 'sitemap.xml');
  const nowMs = env.NOW ? Date.parse(env.NOW) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`NOW is not a valid time: ${env.NOW}`);
  const today = jazco.todayUtc(nowMs);
  const lastCompleteDay = users.addDays(today, -1);
  const files = {
    data: path.join(dataDir, 'bluesky-data.js'),
    csv: path.join(dataDir, 'bluesky-daily.csv'),
    samples: path.join(dataDir, 'users-samples.json'),
    plc: path.join(dataDir, 'sources', 'plc-rate-samples.json'),
  };

  let stats;
  try {
    stats = jazco.normalizeStats(await fetchJson(fetchImpl, JAZCO_URL, { attempts: JAZCO_ATTEMPTS, sleep, log }), { today });
  } catch (err) {
    throw new Error(`jazco /stats unavailable: ${err.message}`);
  }
  if (!stats.rows.length) throw new Error('jazco /stats returned no usable daily rows');
  log.log(`jazco: ${stats.rows.length} days ${stats.rows[0].date}..${stats.rows.at(-1).date} (dropped today ${stats.counts.today}, future ${stats.counts.future}, invalid ${stats.counts.invalid})`);

  let feed = null;
  try {
    feed = await fetchJson(fetchImpl, BOT_URL, { sleep, log });
  } catch (err) {
    log.warn(`warning: bot feed unavailable (${err.message}); continuing without it`);
  }

  if (!fs.existsSync(files.samples)) throw new Error(`${files.samples} is missing: run "npm run backfill" first`);
  const archive = fs.existsSync(files.data) ? build.parseDataJs(fs.readFileSync(files.data, 'utf8')) : null;
  if (!stats.snapshot) log.warn('warning: jazco total_users missing or invalid; keeping the previous snapshot');
  for (const k of INDEX_TOTALS) {
    if (stats.snapshot && stats.snapshot[k] === null) log.warn(`warning: jazco ${k} missing or invalid; keeping the previous value`);
  }

  const fresh = [...botSamples(feed, nowMs)];
  const js = jazcoSample(stats.snapshot, nowMs);
  if (js) fresh.push(js);
  else if (stats.snapshot) log.warn(`warning: jazco updated_at ${stats.snapshot.updated_at} is over 2h old; not saved as a reading`);
  const previous = users.parseSamplesFile(fs.readFileSync(files.samples, 'utf8'));
  const { kept, dropped } = users.cleanSamples([...previous, ...fresh]);
  const samples = users.thinSamples(kept);
  const sampleKey = (s) => `${s.src}|${s.t}`;
  const previousKeys = new Set(previous.map(sampleKey));
  const added = samples.filter((s) => !previousKeys.has(sampleKey(s))).length;
  if (dropped.length) log.log(`samples: dropped ${dropped.length} stale/impossible readings (${[...new Set(dropped.map((d) => d.reason))].join(', ')})`);
  const snapshot = pickSnapshot({ fresh: stats.snapshot, archive: archive?.snapshot || null, samples });
  if (!snapshot) throw new Error('no valid total_users snapshot from jazco or the archive');
  if (stats.snapshot && snapshot.updated_at !== stats.snapshot.updated_at) {
    log.warn(`warning: jazco total_users (${stats.snapshot.updated_at}) not used; headline is ${snapshot.total_users} from ${snapshot.source} at ${snapshot.updated_at}`);
  }

  const plcSamples = fs.existsSync(files.plc) ? JSON.parse(fs.readFileSync(files.plc, 'utf8')).samples : null;
  if (!plcSamples) log.warn('warning: PLC rate samples missing; 2024 gaps fall back to linear interpolation');
  const series = users.buildUsersSeries(samples, { endDate: lastCompleteDay, plcSamples });
  const activity = build.mergeActivity(stats.rows, archive?.days || []);
  const days = build.assembleDays({ users: series, activity, lastCompleteDay });
  const data = build.buildDataset({ generatedAt: new Date(nowMs).toISOString(), snapshot, days });
  build.validateDataset(data);

  const outputs = [
    [files.samples, users.serializeSamplesFile(samples)],
    [files.data, build.serializeDataJs(data)],
    [files.csv, build.serializeCsv(data)],
  ];
  if (prerender) {
    if (fs.existsSync(indexFile)) {
      const res = prerender.prerenderIndex(fs.readFileSync(indexFile, 'utf8'), data);
      if (res.missing?.length) log.warn(`warning: index.html has no marker for: ${res.missing.join(', ')}`);
      outputs.push([indexFile, res.html]);
    } else log.warn(`warning: ${indexFile} not found; skipping pre-render`);
    if (fs.existsSync(sitemapFile)) outputs.push([sitemapFile, prerender.updateSitemap(fs.readFileSync(sitemapFile, 'utf8'), data)]);
  }
  for (const [file, text] of outputs) writeAtomic(file, text);

  const last = days[days.length - 1];
  const summary = {
    last_complete_day: last.date,
    users: last.users,
    users_src: last.users_src,
    new_users: last.new_users,
    dau: last.dau,
    posters: last.posters,
    snapshot_total: snapshot.total_users,
    samples_added: added,
    bot_readings: fresh.filter((s) => s.src === 'bot').length,
    jazco_reading: Boolean(js && kept.some((s) => s.src === 'jazco' && s.t === Math.floor(js.t / 1000) * 1000)),
    flagged_days: days.filter((d) => d.flags.length).length,
    written: outputs.map(([f]) => (f.startsWith(ROOT + path.sep) ? path.relative(ROOT, f) : f)),
  };
  log.log('updated:', JSON.stringify(summary));
  return summary;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`updateData failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, botSamples, jazcoSample, pickSnapshot, JAZCO_URL, BOT_URL, UA };
