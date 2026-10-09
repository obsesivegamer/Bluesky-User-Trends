#!/usr/bin/env node
// Replays Jetstream history for one UTC day (or a part of it) and writes <STATE_DIR>/days/<date>.json:
// follow/block counts per subject DID over the whole window, plus sampled like/repost windows for
// top-post candidates. Several runs over different parts of a day merge into the same file.
//
//   node scripts/collect-social.js [--date YYYY-MM-DD] [--from ISO --to ISO] [--samples N]
//                                  [--sample-seconds S] [--force]
//
// Default: yesterday (UTC), minus whatever the existing day file already covers. Jetstream keeps
// ~36h of replay, so the start is pulled forward to stay inside it (see lib/jetstream.js).
// Env: STATE_DIR (default ./.state/social, git-ignored: the day files name small accounts by DID, so they
// never go into git), JETSTREAM_HOSTS (comma list, e.g. jetstream2.us-east).

const fs = require('fs');
const path = require('path');
const js = require('../lib/jetstream.js');

const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..', '.state', 'social');
const DAYS_DIR = path.join(STATE_DIR, 'days');
const HOSTS = process.env.JETSTREAM_HOSTS ? process.env.JETSTREAM_HOSTS.split(',').map((h) => h.trim()) : js.HOSTS;
const IDLE_MS = 30e3;
const CLOSE_TIMEOUT_MS = 3e3;
// Consecutive connections without progress on one instance before moving to the next, and in total
// before giving up. A connection that delivered anything resets both.
const SAME_HOST_ATTEMPTS = 3;
const MAX_FAILURES = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (['--date', '--from', '--to', '--samples', '--sample-seconds'].includes(a)) opts[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function buildUrl(host, collections, cursor) {
  const q = collections.map((c) => `wantedCollections=${c}`);
  q.push(`maxMessageSizeBytes=${js.MAX_MESSAGE_BYTES}`, `cursor=${cursor}`);
  return `wss://${host}.bsky.network/subscribe?${q.join('&')}`;
}

// Opens one socket and feeds parsed frames to onEvent until it returns true. Resolves with how it ended:
// 'done', 'idle', 'error' or 'closed'. Node's WebSocket has no terminate(): a peer that never answers
// the close handshake keeps the socket in CLOSING, so after a short wait the handlers and the
// reference are dropped instead of waiting for onclose.
function connect(url, onEvent, deps = {}) {
  const WS = deps.WebSocket || WebSocket;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const closeTimeoutMs = deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let ws;
    let idle;
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      const sock = ws;
      ws = null;
      resolve(how);
      if (!sock) return;
      sock.onmessage = null;
      const drop = () => {
        clearTimeout(timer);
        sock.onclose = null;
        sock.onerror = null;
      };
      sock.onclose = drop;
      sock.onerror = () => {};
      const timer = setTimeout(drop, closeTimeoutMs);
      if (timer.unref) timer.unref();
      try { sock.close(); } catch { drop(); }
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish('idle'), idleMs);
    };
    try {
      ws = new WS(url, { headers: { 'User-Agent': UA } });
    } catch {
      settled = true;
      return resolve('error');
    }
    arm();
    ws.onmessage = (e) => {
      arm();
      if (typeof e.data !== 'string' || e.data.length > js.MAX_MESSAGE_BYTES) return;
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return;
      if (onEvent(ev)) finish('done');
    };
    ws.onerror = () => finish('error');
    ws.onclose = () => finish('closed');
  });
}

// Streams events into tally.add() until it returns true (resolves true). Reconnects from the last seen
// time_us. A dropped connection is retried on the same instance with the same cursor, with backoff; only
// after SAME_HOST_ATTEMPTS fruitless tries does it move to the next instance, where tally.failover()
// rewinds the cursor and the tally drops commits it already counted (instances stamp time_us on their
// own clocks). Resolves false after MAX_FAILURES fruitless connections in a row.
async function replay({ collections, startMs, tally, label }, deps = {}) {
  const hosts = deps.hosts || HOSTS;
  const open = deps.connect || connect;
  const wait = deps.sleep || sleep;
  const say = deps.log || log;
  let hostIdx = 0;
  let failures = 0;
  let hostFailures = 0;
  let lastReport = Date.now();
  let count = 0;
  let cursor = startMs * 1000;
  for (;;) {
    const before = tally.lastUs || 0;
    const how = await open(buildUrl(hosts[hostIdx], collections, cursor), (ev) => {
      count++;
      if (Date.now() - lastReport > 60e3) {
        lastReport = Date.now();
        say(`${label}: ${count} events, at ${new Date(ev.time_us / 1000).toISOString().slice(0, 19)}Z (${hosts[hostIdx]})`);
      }
      return tally.add(ev);
    });
    if (how === 'done') return true;
    if ((tally.lastUs || 0) > before) failures = hostFailures = 0;
    else {
      failures++;
      hostFailures++;
    }
    if (failures >= MAX_FAILURES) {
      say(`${label}: giving up after ${failures} failed attempts (${how})`);
      return false;
    }
    const delay = js.backoffMs(failures - 1);
    if (hostFailures >= SAME_HOST_ATTEMPTS) {
      hostIdx = js.nextHost(hosts, hostIdx);
      hostFailures = 0;
      cursor = tally.failover();
      say(`${label}: ${how}, switching to ${hosts[hostIdx]} (cursor rewound) in ${delay / 1000}s`);
    } else {
      cursor = Math.max(startMs * 1000, tally.lastUs || 0);
      say(`${label}: ${how}, retrying ${hosts[hostIdx]} in ${delay / 1000}s`);
    }
    await wait(delay);
  }
}

// Replays each window in turn into `posts`. A window that did not run to its end, or had a silence
// inside it, commits nothing (see SampleWindow.finish), so a later run samples its slot again.
async function runSamples(windows, posts) {
  for (const [s, e] of windows) {
    const win = posts.window(s, e);
    const label = `sample ${js.iso(s).slice(11, 19)}`;
    const ok = await replay({ collections: [js.LIKE, js.REPOST], startMs: s, tally: win, label });
    const r = win.finish(ok);
    const why = !ok ? 'incomplete, dropped' : r.committed ? `${Math.round(r.coveredMs / 1000)}s covered` : `${r.gaps.length} silent gaps, dropped (sampled again by a later run)`;
    log(`${label}: ${why}, ${posts.nLikes} likes / ${posts.nReposts} reposts so far`);
  }
}

// The slots of the day's full schedule (24 windows over the UTC day) that lie inside what can be
// replayed now, [fromMs, toMs], and that no committed window overlaps yet.
function missingSampleSlots(existing, date, fromMs, toMs, sampleCount, sampleSeconds) {
  const day = js.dayWindow(date);
  const slots = js.sampleWindows(day.start, day.end, sampleCount, sampleSeconds).filter(([a, b]) => a >= fromMs && b <= toMs);
  return js.freshSampleWindows(slots, existing ? js.daySampleWindows(existing) : []);
}

// Samples only: no follow/block replay. Returns a piece that claims no follow/block coverage (its whole
// range is a gap), so folding it adds the sampled posts and leaves the follow/block lists alone.
async function collectSamples(windows) {
  const startMs = windows[0][0];
  const endMs = windows[windows.length - 1][1];
  log(`samples only ${js.iso(startMs)} .. ${js.iso(endMs)}, ${windows.length} missing sample windows`);
  const posts = new js.PostSampleTally();
  await runSamples(windows, posts);
  return { startMs, endMs, gaps: [[startMs, endMs]], follows: new Map(), blocks: new Map(), nFollows: 0, nBlocks: 0, posts };
}

async function collectPiece(fromMs, toMs, sampleCount, sampleSeconds, sampledWindows = []) {
  const windows = js.freshSampleWindows(js.sampleWindows(fromMs, toMs, sampleCount, sampleSeconds), sampledWindows);
  log(`piece ${js.iso(fromMs)} .. ${js.iso(toMs)}, ${windows.length} sample windows (${sampleCount - windows.length} already sampled)`);
  const tally = new js.FollowBlockTally(fromMs, toMs);
  const posts = windows.length ? new js.PostSampleTally() : null;

  const followPass = replay({ collections: [js.FOLLOW, js.BLOCK], startMs: fromMs, tally, label: 'follow/block' });
  const samplePass = runSamples(windows, posts);
  const [followsDone] = await Promise.all([followPass, samplePass]);

  const cov = tally.coverage.finish(!followsDone);
  log(`follow/block: ${tally.nFollows} follows, ${tally.nBlocks} blocks, ${Math.round(cov.coveredMs / 1000)}s covered, ${cov.gaps.length} gaps`);
  return {
    startMs: fromMs,
    endMs: toMs,
    gaps: cov.gaps,
    follows: tally.follows,
    blocks: tally.blocks,
    nFollows: tally.nFollows,
    nBlocks: tally.nBlocks,
    posts,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n');
  fs.renameSync(tmp, file);
}

function prune() {
  let names;
  try {
    names = fs.readdirSync(DAYS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const name of js.pruneList(names)) {
    fs.unlinkSync(path.join(DAYS_DIR, name));
    log(`pruned ${name}`);
  }
}

async function run(args) {
  const now = Date.now();
  const choice = js.chooseWindow(now, {
    date: args.date,
    fromMs: args.from ? Date.parse(args.from) : undefined,
    toMs: args.to ? Date.parse(args.to) : undefined,
  });
  if (Number.isNaN(choice.fromMs) || Number.isNaN(choice.toMs)) throw new Error('bad --from/--to');
  const { date } = choice;
  if (choice.clamped) log(`window clamped to replay retention / now: ${js.iso(choice.fromMs)} .. ${js.iso(choice.toMs)}`);
  if (choice.empty) {
    log(`nothing replayable for ${date}`);
    return;
  }

  const file = path.join(DAYS_DIR, `${date}.json`);
  const partialFile = path.join(DAYS_DIR, `${date}.partial.json`);
  const existing = args.force ? null : readJson(file);
  let partial = existing ? readJson(partialFile) : null;
  const pieces = js.missingPieces(existing, choice.fromMs, choice.toMs);
  const sampleSeconds = Number(args['sample-seconds'] || js.SAMPLE_SECONDS);
  // An explicit --samples N is a manual run: it never adds slots on its own.
  const slotsOf = (file) => (args.samples !== undefined ? [] : missingSampleSlots(file, date, choice.fromMs, choice.toMs, js.SAMPLE_WINDOWS, sampleSeconds));
  if (!pieces.length && !slotsOf(existing).length) {
    log(`${date}: already covered${existing && existing.complete ? ' (complete)' : ''}, nothing to do`);
    return;
  }

  let current = existing;
  const started = Date.now();
  for (const [from, to] of pieces) {
    const n = args.samples !== undefined ? Number(args.samples) : js.sampleCountFor(from, to);
    const sampled = current ? js.daySampleWindows(current) : [];
    const folded = js.foldPiece(date, current, partial, await collectPiece(from, to, n, sampleSeconds, sampled));
    current = folded.file;
    partial = folded.partial;
    if (partial) {
      writeJson(partialFile, partial);
      writeJson(file, current);
    } else {
      writeJson(file, current);
      fs.rmSync(partialFile, { force: true });
    }
    log(`wrote ${path.relative(process.cwd(), file)}: covered ${current.window.covered_seconds}s, complete=${current.complete}${partial ? ', sidecar kept' : ''}`);
  }

  // Sample slots still missing after the pieces: a window that ended in a silence is not committed, so
  // its slot is sampled here, even when follows and blocks are fully covered (and without replaying
  // them). Slots inside a piece collected just now were already tried this run and are left to the next.
  const slots = current ? slotsOf(current).filter(([a, b]) => !pieces.some(([from, to]) => a < to && from < b)) : [];
  if (slots.length) {
    const folded = js.foldSamples(date, current, partial, await collectSamples(slots));
    current = folded.file;
    partial = folded.partial;
    writeJson(file, current);
    if (partial) writeJson(partialFile, partial);
    else fs.rmSync(partialFile, { force: true });
    log(`wrote ${path.relative(process.cwd(), file)}: ${current.totals.sample_seconds}s sampled${partial ? ', sidecar kept' : ''}`);
  }

  log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(current.totals)}`);
  if (!current.complete) log(`note: ${date} is not complete (${current.window.covered_seconds}s covered, ${current.window.gaps.length} gaps)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await run(args);
  } finally {
    prune();
  }
}

module.exports = { connect, replay, buildUrl, collectPiece, collectSamples, missingSampleSlots, SAME_HOST_ATTEMPTS, MAX_FAILURES };

// A socket stuck in CLOSING would keep the process (and the Action) alive, so exit explicitly.
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
