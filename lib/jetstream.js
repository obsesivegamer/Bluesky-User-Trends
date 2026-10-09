'use strict';
// Pure logic for the Jetstream replay collector (scripts/collect-social.js): window choice,
// gap/coverage accounting, per-subject tallies, day-file building, merging and pruning.
// No I/O, no clock, no sockets. See docs/ARCHITECTURE.md for the data flow.

const SECOND_MS = 1000;
const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;

// Measured 2026-10-09: every instance replays about 36h; an older cursor is clamped to ~36h ago.
const RETENTION_MS = 36 * HOUR_MS;
const RETENTION_MARGIN_MS = 2 * HOUR_MS;
const LIVE_SAFETY_MS = 60e3;
const GAP_MS = 120e3;
const SAMPLE_GAP_MS = 30e3;
const COMPLETE_RATIO = 0.99;
const TOP_ACCOUNTS = 3000;
const TOP_POSTS = 1000;
const KEEP_DAYS = 35;
const SAMPLE_WINDOWS = 24;
const SAMPLE_SECONDS = 150;
const MIN_PIECE_MS = 60e3;
// A host change rewinds the cursor this far and drops commits already counted, remembering their keys
// for this long (event time), so memory stays bounded however long the replay runs.
const REWIND_US = 10e6;
const DEDUPE_US = 60e6;
const MAX_MESSAGE_BYTES = 1048576;
// An unfinished day keeps its biggest per-subject counts here (see foldPiece). The size is chosen so the
// committed sidecar stays around a megabyte.
const PARTIAL_ACCOUNTS = 12000;
const PARTIAL_POSTS = 6000;

const HOSTS = ['jetstream2.us-east', 'jetstream1.us-east', 'jetstream2.us-west', 'jetstream1.us-west'];
const FOLLOW = 'app.bsky.graph.follow';
const BLOCK = 'app.bsky.graph.block';
const LIKE = 'app.bsky.feed.like';
const REPOST = 'app.bsky.feed.repost';
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,120}$/;
const POST_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]{1,120}\/app\.bsky\.feed\.post\/[A-Za-z0-9._:~-]{1,512}$/;
const PARTIAL_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.partial\.json$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function dayWindow(date) {
  if (!DATE_RE.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || isoDate(Date.parse(date + 'T00:00:00Z')) !== date) {
    throw new Error(`bad date: ${date}`);
  }
  const start = Date.parse(date + 'T00:00:00Z');
  return { start, end: start + DAY_MS };
}

// ---------- intervals: sorted [startMs, endMs] pairs ----------

function normalizeIntervals(list) {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractIntervals(base, removed) {
  const cut = normalizeIntervals(removed);
  const out = [];
  for (const [a, b] of normalizeIntervals(base)) {
    let cursor = a;
    for (const [c, d] of cut) {
      if (d <= cursor) continue;
      if (c >= b) break;
      if (c > cursor) out.push([cursor, c]);
      cursor = Math.max(cursor, d);
    }
    if (cursor < b) out.push([cursor, b]);
  }
  return out;
}

function intersectIntervals(a, b) {
  const out = [];
  const x = normalizeIntervals(a);
  const y = normalizeIntervals(b);
  for (let i = 0, j = 0; i < x.length && j < y.length;) {
    const lo = Math.max(x[i][0], y[j][0]);
    const hi = Math.min(x[i][1], y[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return out;
}

const totalMs = (list) => list.reduce((sum, [a, b]) => sum + (b - a), 0);

// ---------- window choice ----------

// Picks the window to collect. Default date is the previous UTC day. The start is pulled forward to
// stay inside Jetstream's replay retention (minus a margin) and the end back to just before "now".
function chooseWindow(nowMs, opts = {}) {
  const retention = opts.retentionMs ?? RETENTION_MS;
  const margin = opts.marginMs ?? RETENTION_MARGIN_MS;
  const date = opts.date || isoDate(nowMs - DAY_MS);
  const day = dayWindow(date);
  let from = opts.fromMs ?? day.start;
  let to = opts.toMs ?? day.end;
  if (from < day.start || to > day.end) throw new Error(`window ${iso(from)}..${iso(to)} is outside ${date}`);
  const earliest = nowMs - retention + margin;
  const latest = nowMs - LIVE_SAFETY_MS;
  const clamped = from < earliest || to > latest;
  from = Math.max(from, Math.ceil(earliest / SECOND_MS) * SECOND_MS);
  to = Math.min(to, Math.floor(latest / SECOND_MS) * SECOND_MS);
  return { date, fromMs: from, toMs: to, clamped, empty: to - from < MIN_PIECE_MS };
}

// What is still missing of [fromMs, toMs] given the day file already on disk (null if none).
function missingPieces(existing, fromMs, toMs) {
  const have = existing ? coveredIntervals(existing) : [];
  return subtractIntervals([[fromMs, toMs]], have).filter(([a, b]) => b - a >= MIN_PIECE_MS);
}

// Sampled like/repost windows spread evenly over [fromMs, toMs], each centred in its slot.
function sampleWindows(fromMs, toMs, count, seconds = SAMPLE_SECONDS) {
  const span = toMs - fromMs;
  if (count < 1 || span <= 0) return [];
  const slot = span / count;
  const len = Math.min(seconds * SECOND_MS, slot);
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = Math.round(fromMs + i * slot + (slot - len) / 2);
    out.push([start, start + Math.round(len)]);
  }
  return out;
}

const sampleCountFor = (fromMs, toMs, perDay = SAMPLE_WINDOWS) => Math.max(1, Math.round((perDay * (toMs - fromMs)) / DAY_MS));

// ---------- connection policy ----------

const backoffMs = (attempt) => Math.min(30e3, 1000 * 2 ** Math.max(0, attempt));
const nextHost = (hosts, index) => (index + 1) % hosts.length;

// ---------- coverage ----------

// Watches the stream of event times (ms) for one window. A silence longer than gapMs between two
// events (or before the first / after the last) is a gap: the interval is reported as not covered.
class CoverageTracker {
  constructor(startMs, endMs, gapMs = GAP_MS) {
    this.start = startMs;
    this.end = endMs;
    this.gapMs = gapMs;
    this.last = startMs;
    this.gaps = [];
    this.events = 0;
  }

  observe(tMs) {
    if (tMs < this.last) return;
    const t = Math.min(tMs, this.end);
    if (t - this.last > this.gapMs) this.gaps.push([this.last, t]);
    this.last = t;
    this.events++;
  }

  // Call when the window is done or collection gave up. After reaching the end, only a silence longer
  // than gapMs counts as a gap. If the caller gave up, whatever is left to `end` was never seen, however
  // short, so it is a gap.
  finish(gaveUp = false) {
    if (this.end - this.last > (gaveUp ? 0 : this.gapMs)) this.gaps.push([this.last, this.end]);
    this.last = this.end;
    return this.result();
  }

  result() {
    const gaps = normalizeIntervals(this.gaps);
    return { start: this.start, end: this.end, gaps, coveredMs: this.end - this.start - totalMs(gaps) };
  }
}

// ---------- tallies ----------

const isObject = (x) => x !== null && typeof x === 'object';
const isDid = (x) => typeof x === 'string' && DID_RE.test(x);

function createEvent(ev) {
  const c = ev.kind === 'commit' && isObject(ev.commit) ? ev.commit : null;
  return c && c.operation === 'create' && isObject(c.record) ? c : null;
}

// Identity of a commit across Jetstream instances (their time_us stamps differ). null when the event
// lacks any part of it, in which case it cannot be deduplicated.
function commitKey(ev, c) {
  if (typeof ev.did !== 'string' || typeof c.rkey !== 'string' || typeof c.rev !== 'string') return null;
  return `${ev.did}|${c.collection}|${c.rkey}|${c.rev}`;
}

// Commit keys of the most recent events (by event time), to drop repeats after a host change.
class RecentCommits {
  constructor(windowUs = DEDUPE_US) {
    this.windowUs = windowUs;
    this.keys = new Set();
    this.queueUs = [];
    this.queueKey = [];
    this.head = 0;
    this.maxUs = 0;
  }

  // True if the key is already remembered; otherwise remembers it.
  seen(key, us) {
    if (us > this.maxUs) this.maxUs = us;
    const floor = this.maxUs - this.windowUs;
    while (this.head < this.queueUs.length && this.queueUs[this.head] < floor) {
      this.keys.delete(this.queueKey[this.head]);
      this.head++;
    }
    if (this.head >= 50000 && this.head * 2 >= this.queueUs.length) {
      this.queueUs = this.queueUs.slice(this.head);
      this.queueKey = this.queueKey.slice(this.head);
      this.head = 0;
    }
    if (key === null) return false;
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    this.queueUs.push(us);
    this.queueKey.push(key);
    return false;
  }

  get size() {
    return this.keys.size;
  }
}

// Follow + block replay: counts create events per subject DID inside [startMs, endMs).
class FollowBlockTally {
  constructor(startMs, endMs, gapMs) {
    this.startUs = startMs * 1000;
    this.endUs = endMs * 1000;
    this.coverage = new CoverageTracker(startMs, endMs, gapMs);
    this.follows = new Map();
    this.blocks = new Map();
    this.nFollows = 0;
    this.nBlocks = 0;
    this.lastUs = 0;
    this.recent = new RecentCommits();
  }

  // Returns true once the window is over (an event at or past its end).
  add(ev) {
    if (!isObject(ev) || typeof ev.time_us !== 'number') return false;
    const us = ev.time_us;
    if (!(us > this.lastUs)) return false;
    if (us >= this.endUs) return true;
    this.lastUs = us;
    if (us < this.startUs) return false;
    this.coverage.observe(us / 1000);
    const c = createEvent(ev);
    if (!c || (c.collection !== FOLLOW && c.collection !== BLOCK) || !isDid(c.record.subject)) return false;
    if (this.recent.seen(commitKey(ev, c), us)) return false;
    const subject = c.record.subject;
    if (c.collection === FOLLOW) {
      this.follows.set(subject, (this.follows.get(subject) || 0) + 1);
      this.nFollows++;
    } else {
      this.blocks.set(subject, (this.blocks.get(subject) || 0) + 1);
      this.nBlocks++;
    }
    return false;
  }

  // The next connection goes to a different Jetstream instance, whose time_us clock is not ours.
  // Rewinds so nothing it stamped slightly earlier is lost; commits already counted are dropped by key.
  // Returns the cursor (microseconds) to connect with.
  failover() {
    if (!this.lastUs) return this.startUs;
    const cursor = Math.max(this.startUs, this.lastUs - REWIND_US);
    this.lastUs = cursor - 1;
    return cursor;
  }
}

// Sampled like/repost windows: counts create events per liked/reposted post URI.
class PostSampleTally {
  constructor(gapMs = SAMPLE_GAP_MS) {
    this.gapMs = gapMs;
    this.likes = new Map();
    this.reposts = new Map();
    this.nLikes = 0;
    this.nReposts = 0;
    this.sampleMs = 0;
    this.windows = [];
  }

  window(startMs, endMs) {
    return new SampleWindow(this, startMs, endMs);
  }
}

// Buffers its counts and only adds them to the tally in finish(true), so a window that did not run to
// its end contributes nothing and can be sampled again by a later run.
class SampleWindow {
  constructor(tally, startMs, endMs) {
    this.tally = tally;
    this.startMs = startMs;
    this.endMs = endMs;
    this.startUs = startMs * 1000;
    this.endUs = endMs * 1000;
    this.reset();
  }

  reset() {
    this.coverage = new CoverageTracker(this.startMs, this.endMs, this.tally.gapMs);
    this.lastUs = 0;
    this.likes = new Map();
    this.reposts = new Map();
    this.nLikes = 0;
    this.nReposts = 0;
  }

  // A window is a couple of minutes of replay: after a host change start it over instead of merging.
  failover() {
    this.reset();
    return this.startUs;
  }

  // Returns true once the window is over.
  add(ev) {
    if (!isObject(ev) || typeof ev.time_us !== 'number') return false;
    const us = ev.time_us;
    if (!(us > this.lastUs)) return false;
    if (us >= this.endUs) return true;
    this.lastUs = us;
    if (us < this.startUs) return false;
    this.coverage.observe(us / 1000);
    const c = createEvent(ev);
    const uri = c && isObject(c.record.subject) ? c.record.subject.uri : null;
    if (typeof uri !== 'string' || !POST_URI.test(uri)) return false;
    if (c.collection === LIKE) {
      this.likes.set(uri, (this.likes.get(uri) || 0) + 1);
      this.nLikes++;
    } else if (c.collection === REPOST) {
      this.reposts.set(uri, (this.reposts.get(uri) || 0) + 1);
      this.nReposts++;
    }
    return false;
  }

  // completed: the replay reached the end of the window. Only then are its counts and the seconds
  // actually observed added to the tally, and the window recorded as sampled.
  finish(completed = true) {
    const r = this.coverage.finish(!completed);
    if (!completed) return { ...r, committed: false };
    const t = this.tally;
    for (const [k, v] of this.likes) t.likes.set(k, (t.likes.get(k) || 0) + v);
    for (const [k, v] of this.reposts) t.reposts.set(k, (t.reposts.get(k) || 0) + v);
    t.nLikes += this.nLikes;
    t.nReposts += this.nReposts;
    t.sampleMs += r.coveredMs;
    t.windows.push([this.startMs, this.endMs]);
    return { ...r, committed: true };
  }
}

// Candidate sample windows minus those that overlap a window already counted in the day file.
function freshSampleWindows(candidates, committed) {
  return candidates.filter(([a, b]) => !committed.some(([c, d]) => a < d && c < b));
}

// ---------- top-N ----------

// entries: Map or [[key, count]]. Highest count first; ties by key ascending so output is stable.
function topCounts(entries, n = TOP_ACCOUNTS) {
  const list = [...entries].filter(([, v]) => v > 0);
  list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return list.slice(0, n);
}

// likes/reposts: Maps uri -> count. Ranked by likes, then reposts, then uri; only posts with a like.
function topPosts(likes, reposts, n = TOP_POSTS) {
  const list = [];
  for (const [uri, l] of likes) list.push([uri, l, reposts.get(uri) || 0]);
  list.sort((a, b) => b[1] - a[1] || b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return list.slice(0, n);
}

// ---------- day files ----------

function windowFields({ startMs, endMs, gaps }) {
  const gapList = normalizeIntervals(gaps);
  return {
    start: iso(startMs),
    end: iso(endMs),
    covered_seconds: Math.round((endMs - startMs - totalMs(gapList)) / SECOND_MS),
    gaps: gapList.map(([a, b]) => [iso(a), iso(b)]),
  };
}

function assembleDayFile(date, win, totals, followsTop, blocksTop, postCandidates, sampleWindowList = []) {
  const window = windowFields(win);
  return {
    schema: 1,
    date,
    window,
    complete: window.covered_seconds >= COMPLETE_RATIO * 86400,
    totals,
    follows_top: followsTop,
    blocks_top: blocksTop,
    post_candidates: postCandidates,
    sample_windows: sampleWindowList.map(([a, b]) => [iso(a), iso(b)]),
  };
}

// result: {startMs, endMs, gaps, follows: Map, blocks: Map, nFollows, nBlocks, posts: PostSampleTally|null}
function buildDayFile(date, result) {
  const p = result.posts;
  return assembleDayFile(
    date,
    result,
    {
      follows: result.nFollows,
      blocks: result.nBlocks,
      likes_sampled: p ? p.nLikes : 0,
      reposts_sampled: p ? p.nReposts : 0,
      sample_seconds: p ? Math.round(p.sampleMs / SECOND_MS) : 0,
    },
    topCounts(result.follows),
    topCounts(result.blocks),
    p ? topPosts(p.likes, p.reposts) : [],
    p ? p.windows : [],
  );
}

// The seconds of the window that really carry data: window minus gaps.
function coveredIntervals(file) {
  const gaps = (file.window.gaps || []).map(([a, b]) => [Date.parse(a), Date.parse(b)]);
  return subtractIntervals([[Date.parse(file.window.start), Date.parse(file.window.end)]], gaps);
}

// The like/repost windows already counted in a day file, as [startMs, endMs]. Files written before
// `sample_windows` existed are reconstructed from the fixed schedule (whole windows of SAMPLE_SECONDS
// spread over the file's window), which is how they were collected.
function daySampleWindows(file) {
  if (Array.isArray(file.sample_windows)) return file.sample_windows.map(([a, b]) => [Date.parse(a), Date.parse(b)]);
  const n = Math.round((file.totals.sample_seconds || 0) / SAMPLE_SECONDS);
  return sampleWindows(Date.parse(file.window.start), Date.parse(file.window.end), n, SAMPLE_SECONDS);
}

function sumLists(a, b, n) {
  const m = new Map();
  for (const [k, v] of a) m.set(k, (m.get(k) || 0) + v);
  for (const [k, v] of b) m.set(k, (m.get(k) || 0) + v);
  return topCounts(m, n);
}

function sumPosts(a, b) {
  const likes = new Map();
  const reposts = new Map();
  for (const [uri, l, r] of [...a, ...b]) {
    likes.set(uri, (likes.get(uri) || 0) + l);
    reposts.set(uri, (reposts.get(uri) || 0) + r);
  }
  return topPosts(likes, reposts);
}

// Merges two day files of the same date collected over different parts of the day. Refuses if the
// time they cover, or the like/repost windows they sampled, overlap (summing would double count). The
// top lists are sums of lists already cut at 3,000, so an account just below the cut in one of them can
// be under-counted; foldPiece avoids that for the collector.
function mergeDayFiles(a, b) {
  if (a.date !== b.date) throw new Error(`cannot merge ${a.date} with ${b.date}`);
  const covA = coveredIntervals(a);
  const covB = coveredIntervals(b);
  const overlap = intersectIntervals(covA, covB);
  if (overlap.length) {
    const [lo, hi] = overlap[0];
    throw new Error(`overlapping windows for ${a.date}: ${iso(lo)}..${iso(hi)} is covered twice`);
  }
  const swA = daySampleWindows(a);
  const swB = daySampleWindows(b);
  const swOverlap = intersectIntervals(swA, swB);
  if (swOverlap.length) {
    const [lo, hi] = swOverlap[0];
    throw new Error(`overlapping sample windows for ${a.date}: ${iso(lo)}..${iso(hi)} is sampled twice`);
  }
  const startMs = Math.min(Date.parse(a.window.start), Date.parse(b.window.start));
  const endMs = Math.max(Date.parse(a.window.end), Date.parse(b.window.end));
  const gaps = subtractIntervals([[startMs, endMs]], [...covA, ...covB]);
  const ta = a.totals;
  const tb = b.totals;
  return assembleDayFile(
    a.date,
    { startMs, endMs, gaps },
    {
      follows: ta.follows + tb.follows,
      blocks: ta.blocks + tb.blocks,
      likes_sampled: ta.likes_sampled + tb.likes_sampled,
      reposts_sampled: ta.reposts_sampled + tb.reposts_sampled,
      sample_seconds: ta.sample_seconds + tb.sample_seconds,
    },
    sumLists(a.follows_top, b.follows_top, TOP_ACCOUNTS),
    sumLists(a.blocks_top, b.blocks_top, TOP_ACCOUNTS),
    sumPosts(a.post_candidates, b.post_candidates),
    [...swA, ...swB].sort((x, y) => x[0] - y[0]),
  );
}

// ---------- unfinished days: the sidecar ----------
//
// Cutting each piece to its top 3,000 before merging can reorder accounts near the cut. So while a day
// is incomplete, `data/social/days/<date>.partial.json` keeps a much longer list of counts, and the
// day file's lists are cut from the merged long lists. It is committed because the 03:00 and 09:00
// Actions are separate checkouts. The full maps (measured 2026-10-09: 146k distinct accounts followed in
// 2.6 hours, so roughly 600k per half day) are far too large to commit, so it keeps the top PARTIAL_ACCOUNTS follows, PARTIAL_ACCOUNTS blocks and
// PARTIAL_POSTS posts. Stored counts are lower bounds; `error` is the most any subject's true count can
// exceed its stored one (it grows by the largest dropped count every time the list is cut). The day
// file only ever lists the top 3,000, so this matters only for accounts within `error` of that cut.

function countMap(rows) {
  const m = new Map();
  for (const [k, v] of rows) m.set(k, (m.get(k) || 0) + v);
  return m;
}

function mergeCountMaps(base, more) {
  const m = new Map(base);
  for (const [k, v] of more) m.set(k, (m.get(k) || 0) + v);
  return m;
}

// {list, cut}: the top n and the largest count that was dropped (0 if nothing was).
function cutCounts(entries, n) {
  const all = topCounts(entries, Infinity);
  return { list: all.slice(0, n), cut: all.length > n ? all[n][1] : 0 };
}

function cutPosts(likes, reposts, n) {
  const all = topPosts(likes, reposts, Infinity);
  return { list: all.slice(0, n), cut: all.length > n ? all[n][1] : 0 };
}

// What a day file alone tells: a list at its cap was cut at its last count.
function stateFromDayFile(file) {
  const cutOf = (list, n) => (list.length >= n ? list[n - 1][1] : 0);
  return {
    follows: { list: file.follows_top, error: cutOf(file.follows_top, TOP_ACCOUNTS) },
    blocks: { list: file.blocks_top, error: cutOf(file.blocks_top, TOP_ACCOUNTS) },
    posts: { list: file.post_candidates, error: cutOf(file.post_candidates, TOP_POSTS) },
  };
}

// The sidecar is only trusted if it describes exactly the day file on disk.
function usablePartial(file, partial) {
  if (!partial || partial.schema !== 1 || partial.date !== file.date) return null;
  if (partial.covered_seconds !== file.window.covered_seconds) return null;
  for (const k of Object.keys(file.totals)) if (!partial.totals || partial.totals[k] !== file.totals[k]) return null;
  for (const k of ['follows', 'blocks', 'posts']) if (!partial[k] || !Array.isArray(partial[k].list)) return null;
  return partial;
}

const EMPTY_STATE = () => ({ follows: { list: [], error: 0 }, blocks: { list: [], error: 0 }, posts: { list: [], error: 0 } });

// Folds one collected piece into the day file on disk. existing: the day file or null; partial: its
// sidecar or null; piece: the collectPiece result with its full maps. Returns {file, partial} where
// partial is the sidecar to store (null once the day is complete: delete it).
function foldPiece(date, existing, partial, piece) {
  const pieceFile = buildDayFile(date, piece);
  const base = existing ? usablePartial(existing, partial) || stateFromDayFile(existing) : EMPTY_STATE();
  const file = existing ? mergeDayFiles(existing, pieceFile) : pieceFile;

  const follows = mergeCountMaps(countMap(base.follows.list), piece.follows);
  const blocks = mergeCountMaps(countMap(base.blocks.list), piece.blocks);
  const likes = countMap(base.posts.list.map(([uri, l]) => [uri, l]));
  const reposts = countMap(base.posts.list.map(([uri, , r]) => [uri, r]));
  if (piece.posts) {
    for (const [k, v] of piece.posts.likes) likes.set(k, (likes.get(k) || 0) + v);
    for (const [k, v] of piece.posts.reposts) reposts.set(k, (reposts.get(k) || 0) + v);
  }
  file.follows_top = topCounts(follows, TOP_ACCOUNTS);
  file.blocks_top = topCounts(blocks, TOP_ACCOUNTS);
  file.post_candidates = topPosts(likes, reposts, TOP_POSTS);
  if (file.complete) return { file, partial: null };

  const f = cutCounts(follows, PARTIAL_ACCOUNTS);
  const b = cutCounts(blocks, PARTIAL_ACCOUNTS);
  const p = cutPosts(likes, reposts, PARTIAL_POSTS);
  return {
    file,
    partial: {
      schema: 1,
      date,
      covered_seconds: file.window.covered_seconds,
      totals: file.totals,
      follows: { list: f.list, error: base.follows.error + f.cut },
      blocks: { list: b.list, error: base.blocks.error + b.cut },
      posts: { list: p.list, error: base.posts.error + p.cut },
    },
  };
}

// Names to delete: day files but the newest `keep`, and sidecars of days that no longer have a day file.
function pruneList(names, keep = KEEP_DAYS) {
  const days = names
    .filter((n) => DAY_FILE_RE.test(n))
    .sort()
    .reverse();
  const kept = new Set(days.slice(0, keep).map((n) => n.slice(0, 10)));
  const orphans = names.filter((n) => PARTIAL_FILE_RE.test(n) && !kept.has(n.slice(0, 10)));
  return [...days.slice(keep), ...orphans];
}

module.exports = {
  DAY_MS,
  RETENTION_MS,
  GAP_MS,
  HOSTS,
  FOLLOW,
  BLOCK,
  LIKE,
  REPOST,
  TOP_ACCOUNTS,
  TOP_POSTS,
  KEEP_DAYS,
  SAMPLE_WINDOWS,
  SAMPLE_SECONDS,
  iso,
  isoDate,
  dayWindow,
  normalizeIntervals,
  subtractIntervals,
  intersectIntervals,
  totalMs,
  chooseWindow,
  missingPieces,
  sampleWindows,
  sampleCountFor,
  backoffMs,
  nextHost,
  CoverageTracker,
  RecentCommits,
  FollowBlockTally,
  PostSampleTally,
  freshSampleWindows,
  daySampleWindows,
  foldPiece,
  PARTIAL_ACCOUNTS,
  PARTIAL_POSTS,
  REWIND_US,
  DEDUPE_US,
  MAX_MESSAGE_BYTES,
  topCounts,
  topPosts,
  buildDayFile,
  coveredIntervals,
  mergeDayFiles,
  pruneList,
};
