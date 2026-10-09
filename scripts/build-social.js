#!/usr/bin/env node
// Builds data/social.js (window.BLUESKY_SOCIAL) from the Jetstream day files in <STATE_DIR>/days/ plus
// Bluesky AppView profiles/posts, Constellation block counts and PLC directory documents.
//
//   node scripts/build-social.js
//
// Env: DATA_DIR (default ./data, where social.js is written), STATE_DIR (default ./.state/social, git-
// ignored), NOW (ISO time, for tests). Also writes <STATE_DIR>/pool.json (the account pool and its
// caches) and <STATE_DIR>/followers-history.json (daily follower snapshots). The raw state names small
// accounts by DID, so it never goes into git; only the guardrail-filtered data/social.js is published.
// Exits non-zero and writes nothing if an essential AppView call keeps failing or validation fails. With
// no day files at all (an empty or evicted state directory) it warns, leaves data/social.js as it is and
// exits 0, so an empty board is never published over a good one.

const fs = require('fs');
const path = require('path');
const social = require('../lib/social.js');

const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const APPVIEW = 'https://public.api.bsky.app/xrpc';
const CONSTELLATION = 'https://constellation.microcosm.blue/links/count';
const PLC = 'https://plc.directory';

const POOL_TOP = social.POOL_PER_LIST;
const PROFILE_BATCH = 25;
const POST_BATCH = 25;
const CONCURRENCY = 4;
const CANDIDATE_POSTS = 1000;
const BLOCKED_ALL_FROM_BLOCKED = 150;
const BLOCKED_ALL_FROM_FOLLOWED = 100;
const CONSTELLATION_BUDGET = 400;
const RETRY_PAUSE_MS = 2000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const chunks = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

// HTTP client: spaces request starts per host (the public AppView allows ~3,000 requests per 5 minutes),
// retries 429 / 5xx / network errors with backoff, and gives up at once on other 4xx.
function createClient({ fetchImpl, sleep, intervals, stats }) {
  const nextSlot = new Map();
  async function pace(host) {
    const gap = intervals[host] || intervals['*'] || 0;
    if (!gap) return;
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(host) || 0);
    nextSlot.set(host, at + gap);
    if (at > now) await sleep(at - now);
  }

  async function getJson(url, { retries = 3 } = {}) {
    const host = new URL(url).host;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await pace(host);
      stats[host] = (stats[host] || 0) + 1;
      let wait = 1000 * 2 ** attempt;
      try {
        const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (res.ok) return await res.json();
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        lastErr.status = res.status;
        if (res.status === 429) {
          const reset = Number(res.headers && res.headers.get && res.headers.get('ratelimit-reset'));
          const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          if (Number.isFinite(reset) && reset > 1e9) wait = Math.min(60e3, Math.max(1000, reset * 1000 - Date.now() + 500));
          else if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(60e3, retryAfter * 1000);
          else wait = 5000 * (attempt + 1);
        } else if (res.status < 500) {
          throw lastErr;
        }
      } catch (e) {
        if (e === lastErr && e.status && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
      }
      if (attempt < retries) await sleep(wait);
    }
    throw lastErr;
  }
  return { getJson };
}

function loadDays(daysDir, log) {
  let names = [];
  try {
    names = fs.readdirSync(daysDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const files = new Map();
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(daysDir, n), 'utf8'));
      if (d.schema !== 1 || d.date !== n.slice(0, 10) || !Array.isArray(d.follows_top) || !Array.isArray(d.blocks_top)) throw new Error('unexpected shape');
      files.set(d.date, d);
    } catch (e) {
      log(`skipping ${n}: ${e.message}`);
    }
  }
  return files;
}

async function main({ env = process.env, fetchImpl = globalThis.fetch, sleep = sleepReal, log = (...a) => console.log(...a), intervals } = {}) {
  const started = Date.now();
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
  const stateDir = env.STATE_DIR || path.join(__dirname, '..', '.state', 'social');
  const nowMs = env.NOW ? Date.parse(env.NOW) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`bad NOW: ${env.NOW}`);
  const nowIso = new Date(nowMs).toISOString();
  const stats = {};
  const client = createClient({
    fetchImpl,
    sleep,
    stats,
    intervals: intervals || { 'public.api.bsky.app': 120, 'constellation.microcosm.blue': 520, 'plc.directory': 60, '*': 250 },
  });
  const warnings = [];
  const warn = (m) => { warnings.push(m); log(`warning: ${m}`); };

  // ---- 1. day selection and sums
  const files = loadDays(path.join(stateDir, 'days'), log);
  const sel = social.selectDays([...files.values()].map((d) => ({ date: d.date, complete: d.complete })));
  if (!sel) {
    warn(`no day files in ${path.join(stateDir, 'days')} (empty or evicted state); keeping the existing data/social.js`);
    return { out: null, summary: { skipped: true, warnings: warnings.length } };
  }
  const dayFile = files.get(sel.day);
  const weekFiles = sel.week.map((d) => files.get(d));
  const follows24 = new Map(dayFile.follows_top);
  const blocks24 = new Map(dayFile.blocks_top);
  const follows7 = social.sumLists(weekFiles.map((f) => f.follows_top));
  const blocks7 = social.sumLists(weekFiles.map((f) => f.blocks_top));
  log(`day ${sel.day} (${sel.complete ? 'complete' : 'partial'}), 7d = ${sel.week.length} day file(s), first day ${sel.firstDay}`);

  // ---- 2. pool
  const poolFile = path.join(stateDir, 'pool.json');
  const prevPool = readJson(poolFile, { schema: 1, accounts: {} });
  const seen = new Map();
  const see = (did, date) => { if (!seen.has(did) || date > seen.get(did)) seen.set(did, date); };
  for (const f of weekFiles) {
    for (const [did] of f.follows_top.slice(0, POOL_TOP)) see(did, f.date);
    for (const [did] of f.blocks_top.slice(0, POOL_TOP)) see(did, f.date);
  }
  for (const [did] of social.rankEntries(follows7).slice(0, POOL_TOP)) see(did, sel.day);
  for (const [did] of social.rankEntries(blocks7).slice(0, POOL_TOP)) see(did, sel.day);
  for (const m of [blocks24, blocks7]) for (const [did, n] of m) if (n >= social.MIN_CONTROVERSIAL_BLOCKS) see(did, sel.day);
  const pool = social.prunePool(social.mergePool(prevPool.accounts, seen), nowMs);
  log(`pool: ${Object.keys(prevPool.accounts || {}).length} before, ${Object.keys(pool).length} after merge/prune`);

  // Runs fetchOne over every batch. A batch that fails (after the client's own retries) is retried once,
  // alone, after a pause. Any batch still failing aborts the build: a missing batch would silently drop
  // accounts or posts from the ranks, and a board with a hole in it can name the wrong leader.
  async function fetchBatches(batches, label, kind, fetchOne) {
    const failed = [];
    await mapLimit(batches, CONCURRENCY, async (batch) => {
      try {
        await fetchOne(batch);
      } catch (e) {
        failed.push(batch);
        log(`${label}: ${kind} batch failed (${e.message}); will retry once`);
      }
    });
    if (!failed.length) return;
    await sleep(RETRY_PAUSE_MS);
    let still = 0;
    let lastMessage = '';
    for (const batch of failed) {
      try {
        await fetchOne(batch);
      } catch (e) {
        still++;
        lastMessage = e.message;
        log(`${label}: ${kind} batch failed again (${e.message})`);
      }
    }
    if (still) throw new Error(`${label}: ${still} of ${batches.length} ${kind} batches failed after a retry (${lastMessage})`);
  }

  // ---- 3. profiles
  async function fetchProfiles(dids, label) {
    const profiles = new Map();
    await fetchBatches(chunks(dids, PROFILE_BATCH), label, 'profile', async (batch) => {
      const url = `${APPVIEW}/app.bsky.actor.getProfiles?${batch.map((d) => `actors=${encodeURIComponent(d)}`).join('&')}`;
      const res = await client.getJson(url);
      for (const p of res.profiles || []) if (p && typeof p.did === 'string') profiles.set(p.did, p);
    });
    return profiles;
  }
  const profiles = await fetchProfiles(Object.keys(pool), 'pool profiles');
  log(`profiles: ${profiles.size} of ${Object.keys(pool).length} resolved`);

  for (const [did, p] of profiles) {
    const e = pool[did];
    e.handle = p.handle;
    e.followers = p.followersCount;
    if (p.createdAt) e.created_at = p.createdAt;
  }
  const eligible = new Set([...profiles].filter(([, p]) => social.isEligibleProfile(p)).map(([did]) => did));
  log(`eligible: ${eligible.size}`);

  // ---- 4. boards from Jetstream counts and followers
  const boards = {};
  boards.blocked_24h = social.topEligible(social.rankEntries(blocks24), eligible);
  boards.blocked_7d = social.topEligible(social.rankEntries(blocks7), eligible);
  boards.growing_24h = social.topEligible(social.rankEntries(follows24), eligible);
  boards.growing_7d = social.topEligible(social.rankEntries(follows7), eligible);
  const byFollowers = [...eligible].map((did) => [did, profiles.get(did).followersCount]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  boards.followed = social.topEligible(byFollowers, eligible);
  const followsError = (f) => (f.errors && Number.isFinite(f.errors.follows) ? f.errors.follows : null);
  const bound24 = social.followsWithBounds([dayFile.follows_top], undefined, [followsError(dayFile)]).bound;
  const bound7 = social.followsWithBounds(weekFiles.map((f) => f.follows_top), undefined, weekFiles.map(followsError)).bound;
  boards.controversial_24h = social.controversialRows(blocks24, follows24, eligible, undefined, undefined, bound24);
  boards.controversial_7d = social.controversialRows(blocks7, follows7, eligible, undefined, undefined, bound7);

  // ---- 5. follower snapshots, gainers / losers
  const historyFile = path.join(stateDir, 'followers-history.json');
  const prevHistory = readJson(historyFile, { schema: 1, snapshots: [] });
  const current = new Map([...eligible].map((did) => [did, profiles.get(did).followersCount]));
  for (const win of ['24h', '7d']) {
    const b = social.BASELINES[win];
    const base = social.pickBaseline(prevHistory.snapshots, nowMs, b.target, b.min, b.max);
    const { gainers, losers } = social.moverBoards(current, base);
    boards[`gainers_${win}`] = gainers;
    boards[`losers_${win}`] = losers;
    log(`movers ${win}: ${base ? `baseline ${base.at}` : 'no baseline snapshot yet'}`);
  }
  const bigFollowers = {};
  for (const [did, p] of profiles) if (p.followersCount >= social.MIN_FOLLOWERS) bigFollowers[did] = p.followersCount;
  const history = social.addSnapshot(prevHistory, nowMs, bigFollowers);

  // ---- 6. all-time blocks (Constellation, partial)
  const candidates = [];
  const addCandidate = (did) => { if (!candidates.includes(did)) candidates.push(did); };
  social.topEligible(social.rankEntries(blocks7), eligible, BLOCKED_ALL_FROM_BLOCKED).forEach((r) => addCandidate(r.did));
  byFollowers.slice(0, BLOCKED_ALL_FROM_FOLLOWED).forEach(([did]) => addCandidate(did));
  const due = social.blocksAllDue(candidates, pool, nowMs, CONSTELLATION_BUDGET);
  let constellationFailures = 0;
  let constellationOk = 0;
  const constellationHost = new URL(CONSTELLATION).host;
  for (const did of due) {
    if (constellationFailures >= 5) { warn('Constellation failed 5 times in a row; keeping cached all-time block counts'); break; }
    // The budget counts HTTP attempts, retries included, so a flaky run still stays within it.
    const left = CONSTELLATION_BUDGET - (stats[constellationHost] || 0);
    if (left <= 0) { warn(`Constellation budget of ${CONSTELLATION_BUDGET} requests used; keeping cached all-time block counts for the rest`); break; }
    try {
      const url = `${CONSTELLATION}?target=${encodeURIComponent(did)}&collection=app.bsky.graph.block&path=.subject`;
      const res = await client.getJson(url, { retries: Math.min(2, left - 1) });
      if (!Number.isFinite(res.total)) throw new Error('no total in response');
      pool[did].blocks_all = { total: res.total, at: nowIso };
      constellationFailures = 0;
      constellationOk++;
    } catch (e) {
      constellationFailures++;
      log(`constellation ${did}: ${e.message}`);
    }
  }
  log(`constellation: ${constellationOk} of ${due.length} due refreshed (${candidates.length} candidates)`);
  const allTime = candidates
    .map((did) => [did, pool[did] && pool[did].blocks_all ? pool[did].blocks_all.total : null])
    .filter(([, v]) => v != null && v > 0);
  boards.blocked_all = social.topEligible(social.rankEntries(allTime), eligible);

  // ---- 7. top posts
  const uris = dayFile.post_candidates.slice(0, CANDIDATE_POSTS).map((c) => c[0]);
  const postViews = [];
  await fetchBatches(chunks(uris, POST_BATCH), 'top posts', 'getPosts', async (batch) => {
    const url = `${APPVIEW}/app.bsky.feed.getPosts?${batch.map((u) => `uris=${encodeURIComponent(u)}`).join('&')}`;
    const res = await client.getJson(url);
    postViews.push(...(res.posts || []));
  });
  const start = Date.parse(`${sel.day}T00:00:00Z`);
  const onDay = postViews.filter((p) => {
    const t = Date.parse(p && p.record && p.record.createdAt);
    return t >= start && t < start + social.DAY_MS;
  });
  const extraAuthors = [...new Set(onDay.map((p) => p.author && p.author.did).filter((d) => d && !profiles.has(d)))];
  const authorProfiles = await fetchProfiles(extraAuthors, 'post author profiles');
  const allProfiles = new Map([...profiles, ...authorProfiles]);
  const topPosts = social.selectTopPosts(onDay, allProfiles, sel.day);
  log(`posts: ${uris.length} candidates, ${postViews.length} found, ${onDay.length} created on ${sel.day}, ${topPosts.length} kept`);

  // ---- 8. displayed accounts and their metadata
  const displayed = new Set(topPosts.map((p) => p.author));
  for (const rows of Object.values(boards)) for (const r of rows) displayed.add(r.did);
  const accounts = {};
  for (const did of displayed) accounts[did] = social.toAccount(allProfiles.get(did), pool[did]);
  for (const p of topPosts) {
    if (!pool[p.author]) {
      pool[p.author] = { last_seen: sel.day, handle: allProfiles.get(p.author).handle, followers: allProfiles.get(p.author).followersCount };
    }
  }

  let metaFailures = 0;
  await mapLimit([...displayed], CONCURRENCY, async (did) => {
    const entry = pool[did] || (pool[did] = { last_seen: sel.day });
    const a = accounts[did];
    if (!entry.pds) {
      try {
        const docUrl = did.startsWith('did:web:') ? social.didWebUrl(did) : `${PLC}/${did}`;
        if (docUrl) entry.pds = social.pdsFromDidDoc(await client.getJson(docUrl, { retries: 2 }));
      } catch (e) {
        metaFailures++;
        log(`pds ${did}: ${e.message}`);
      }
    }
    if (!a.created_at && did.startsWith('did:plc:')) {
      try {
        const audit = await client.getJson(`${PLC}/${did}/log/audit`, { retries: 2 });
        if (Array.isArray(audit) && audit[0] && audit[0].createdAt) entry.created_at = audit[0].createdAt;
      } catch (e) {
        metaFailures++;
        log(`created_at ${did}: ${e.message}`);
      }
    }
    if (entry.created_at) a.created_at = entry.created_at;
    a.pds = entry.pds || null;

    const scan = social.newFeedScan(did, nowMs);
    try {
      let cursor = '';
      for (;;) {
        const url = `${APPVIEW}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&filter=posts_with_replies&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await client.getJson(url, { retries: 2 });
        cursor = res.cursor || '';
        if (social.scanFeedPage(scan, res.feed, Boolean(cursor))) break;
      }
      Object.assign(a, social.scanResult(scan));
    } catch (e) {
      metaFailures++;
      log(`author feed ${did}: ${e.message}`);
    }
  });
  if (metaFailures) warn(`${metaFailures} metadata call(s) failed; those fields are null`);

  // ---- 9. assemble, validate, write
  const out = {
    schema: 1,
    generated_at: nowIso,
    day: sel.day,
    coverage: { days_7d: sel.week.length, complete_24h: sel.complete, first_day: sel.firstDay },
    guardrails: {
      min_followers: social.MIN_FOLLOWERS,
      excluded_labels: "any label starting with '!'",
      adult_labels: social.ADULT_LABELS,
    },
    accounts,
    boards,
    top_posts: topPosts,
    totals: { follows_24h: dayFile.totals.follows, blocks_24h: dayFile.totals.blocks },
  };
  const problems = social.validateSocial(out);
  if (problems.length) throw new Error(`validation failed:\n  ${problems.slice(0, 20).join('\n  ')}`);

  const poolOut = { schema: 1, updated_at: nowIso, accounts: pool };
  const poolText = `{"schema":1,"updated_at":${JSON.stringify(nowIso)},"accounts":{\n${Object.entries(pool).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n}}\n`;
  JSON.parse(poolText);
  const historyText = `{"schema":1,"snapshots":[\n${history.snapshots.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`;
  writeAtomic(poolFile, poolText);
  writeAtomic(historyFile, historyText);
  writeAtomic(path.join(dataDir, 'social.js'), social.renderScript(out));

  const summary = {
    seconds: Math.round((Date.now() - started) / 1000),
    requests: stats,
    pool: Object.keys(pool).length,
    resolved: profiles.size,
    eligible: eligible.size,
    displayed: displayed.size,
    warnings: warnings.length,
  };
  log(`done: ${JSON.stringify(summary)}`);
  return { out, summary, poolOut };
}

module.exports = { main, createClient, mapLimit, chunks };

if (require.main === module) {
  main().catch((e) => {
    console.error(`build-social failed: ${e.message}`);
    process.exit(1);
  });
}
