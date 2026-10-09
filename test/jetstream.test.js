'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const js = require('../lib/jetstream.js');

const ms = (iso) => Date.parse(iso);
const D = '2026-10-08';
const at = (hhmmss) => ms(`${D}T${hhmmss}Z`);
const H = 3600e3;

const follow = (sec, subject, base = at('00:00:00')) => ({
  kind: 'commit',
  time_us: (base + sec * 1000) * 1000,
  commit: { operation: 'create', collection: js.FOLLOW, record: { subject } },
});
const block = (sec, subject, base = at('00:00:00')) => ({
  kind: 'commit',
  time_us: (base + sec * 1000) * 1000,
  commit: { operation: 'create', collection: js.BLOCK, record: { subject } },
});
const del = (sec, collection = js.FOLLOW, base = at('00:00:00')) => ({
  kind: 'commit',
  time_us: (base + sec * 1000) * 1000,
  commit: { operation: 'delete', collection },
});
const like = (sec, uri, collection = js.LIKE, base = at('00:00:00')) => ({
  kind: 'commit',
  time_us: (base + sec * 1000) * 1000,
  commit: { operation: 'create', collection, record: { subject: { uri, cid: 'x' } } },
});
const post = (n) => `at://did:plc:a${n}/app.bsky.feed.post/r${n}`;

// Day-file fixture: a window with counts, built the way the script builds it.
function dayFile({ from, to, gaps = [], follows = {}, blocks = {}, likes = {}, reposts = {}, sampleMs = 0, date = D }) {
  const m = (o) => new Map(Object.entries(o));
  const posts = new js.PostSampleTally();
  for (const [u, n] of Object.entries(likes)) { posts.likes.set(u, n); posts.nLikes += n; }
  for (const [u, n] of Object.entries(reposts)) { posts.reposts.set(u, n); posts.nReposts += n; }
  posts.sampleMs = sampleMs;
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return js.buildDayFile(date, {
    startMs: ms(from),
    endMs: ms(to),
    gaps: gaps.map(([a, b]) => [ms(a), ms(b)]),
    follows: m(follows),
    blocks: m(blocks),
    nFollows: sum(follows),
    nBlocks: sum(blocks),
    posts,
  });
}

test('dayWindow is the UTC day and rejects junk dates', () => {
  assert.deepEqual(js.dayWindow(D), { start: ms('2026-10-08T00:00:00Z'), end: ms('2026-10-09T00:00:00Z') });
  assert.throws(() => js.dayWindow('2026-02-30'), /bad date/);
  assert.throws(() => js.dayWindow('yesterday'), /bad date/);
});

test('interval helpers: normalize, subtract, intersect', () => {
  assert.deepEqual(js.normalizeIntervals([[5, 8], [1, 3], [3, 4], [7, 9], [6, 6]]), [[1, 4], [5, 9]]);
  assert.deepEqual(js.subtractIntervals([[0, 10]], [[2, 3], [5, 7]]), [[0, 2], [3, 5], [7, 10]]);
  assert.deepEqual(js.subtractIntervals([[0, 10]], [[-5, 12]]), []);
  assert.deepEqual(js.subtractIntervals([[0, 10]], []), [[0, 10]]);
  assert.deepEqual(js.subtractIntervals([[0, 4], [6, 10]], [[3, 7]]), [[0, 3], [7, 10]]);
  assert.deepEqual(js.intersectIntervals([[0, 5], [8, 12]], [[4, 9]]), [[4, 5], [8, 9]]);
  assert.deepEqual(js.intersectIntervals([[0, 5]], [[5, 9]]), [], 'touching is not overlapping');
  assert.equal(js.totalMs([[0, 5], [8, 12]]), 9);
});

test('chooseWindow: a 03:00 UTC run collects the whole previous day', () => {
  const w = js.chooseWindow(ms('2026-10-09T03:00:00Z'));
  assert.equal(w.date, D);
  assert.equal(w.fromMs, at('00:00:00'));
  assert.equal(w.toMs, ms('2026-10-09T00:00:00Z'));
  assert.equal(w.clamped, false);
  assert.equal(w.empty, false);
});

test('chooseWindow: start is pulled inside the replay retention (36h minus 2h margin)', () => {
  const now = ms('2026-10-09T18:00:00Z');
  const w = js.chooseWindow(now);
  assert.equal(w.date, D);
  assert.equal(w.fromMs, now - 34 * H);
  assert.equal(w.clamped, true);
  const old = js.chooseWindow(ms('2026-10-10T12:00:00Z'), { date: D });
  assert.equal(old.empty, true, 'a day entirely older than retention has nothing replayable');
});

test('chooseWindow: end is held back from "now" and a half-day window is respected', () => {
  const now = ms('2026-10-08T12:20:00Z');
  const w = js.chooseWindow(now, { date: D, fromMs: at('00:00:00'), toMs: at('12:00:00') });
  assert.equal(w.toMs, at('12:00:00'));
  assert.equal(w.clamped, false);
  const live = js.chooseWindow(now, { date: D, fromMs: at('12:00:00'), toMs: ms('2026-10-09T00:00:00Z') });
  assert.equal(live.toMs, now - 60e3);
  assert.equal(live.fromMs, at('12:00:00'));
  assert.equal(live.empty, false);
});

test('chooseWindow: rejects a window outside the requested date', () => {
  assert.throws(() => js.chooseWindow(ms('2026-10-09T03:00:00Z'), { date: D, fromMs: at('00:00:00') - 1000 }), /outside/);
  assert.throws(() => js.chooseWindow(ms('2026-10-09T03:00:00Z'), { date: D, toMs: ms('2026-10-09T00:00:01Z') }), /outside/);
});

test('sampleWindows: 24 x 150s spread evenly, centred in hourly slots', () => {
  const day = js.dayWindow(D);
  const w = js.sampleWindows(day.start, day.end, 24, 150);
  assert.equal(w.length, 24);
  assert.deepEqual(w[0], [day.start + 1725e3, day.start + 1875e3]);
  for (const [a, b] of w) assert.equal(b - a, 150e3);
  for (let i = 1; i < w.length; i++) assert.equal(w[i][0] - w[i - 1][0], H);
  assert.ok(w[23][1] < day.end);
});

test('sampleWindows: short spans shrink the windows instead of overlapping', () => {
  const w = js.sampleWindows(0, 200e3, 2, 150);
  assert.deepEqual(w, [[0, 100e3], [100e3, 200e3]]);
  assert.deepEqual(js.sampleWindows(0, 0, 3), []);
  assert.deepEqual(js.sampleWindows(0, 1e6, 0), []);
});

test('sampleCountFor scales with the span, at least one', () => {
  assert.equal(js.sampleCountFor(0, 86400e3), 24);
  assert.equal(js.sampleCountFor(0, 43200e3), 12);
  assert.equal(js.sampleCountFor(0, 60e3), 1);
});

test('backoff doubles to a 30s cap and failover rotates through every instance', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(js.backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  const hosts = ['a', 'b', 'c'];
  assert.deepEqual([0, 1, 2, 3].map((i) => js.nextHost(hosts, i)), [1, 2, 0, 1]);
  assert.ok(js.HOSTS.some((h) => h.includes('us-east')) && js.HOSTS.some((h) => h.includes('us-west')));
});

test('CoverageTracker: steady events leave no gap', () => {
  const t = new js.CoverageTracker(at('00:00:00'), at('00:10:00'));
  for (let s = 0; s <= 600; s += 30) t.observe(at('00:00:00') + s * 1000);
  const r = t.finish();
  assert.deepEqual(r.gaps, []);
  assert.equal(r.coveredMs, 600e3);
});

test('CoverageTracker: silence over 120s is a gap, exactly 120s is not', () => {
  const t = new js.CoverageTracker(at('00:00:00'), at('00:20:00'));
  t.observe(at('00:00:10'));
  t.observe(at('00:02:10'));
  assert.deepEqual(t.gaps, [], '120s exactly');
  t.observe(at('00:02:11') + 120e3 + 1);
  assert.deepEqual(t.gaps, [[at('00:02:10'), at('00:04:11') + 1]]);
});

test('CoverageTracker: gaps at the start and the end of the window count too', () => {
  const t = new js.CoverageTracker(at('00:00:00'), at('00:30:00'));
  t.observe(at('00:05:00'));
  t.observe(at('00:06:00'));
  t.observe(at('00:20:00'));
  const r = t.finish();
  assert.deepEqual(r.gaps, [[at('00:00:00'), at('00:05:00')], [at('00:06:00'), at('00:30:00')]]);
  assert.equal(r.coveredMs, 60e3);
});

test('CoverageTracker: giving up early leaves the rest of the window as one gap', () => {
  const t = new js.CoverageTracker(at('00:00:00'), at('06:00:00'));
  for (let s = 0; s < 3600; s += 20) t.observe(at('00:00:00') + s * 1000);
  const r = t.finish();
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0][1], at('06:00:00'));
  assert.equal(r.coveredMs, 3600e3 - 20e3);
});

test('CoverageTracker: out-of-order and past-the-end times do not break the math', () => {
  const t = new js.CoverageTracker(at('00:00:00'), at('00:10:00'));
  t.observe(at('00:05:00'));
  t.observe(at('00:01:00'));
  assert.equal(t.last, at('00:05:00'));
  t.observe(at('00:09:59'));
  t.observe(at('00:10:30'));
  assert.equal(t.last, at('00:10:00'));
});

test('FollowBlockTally counts create events per subject, ignores deletes and other shapes', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  t.add(follow(1, 'did:plc:a'));
  t.add(follow(2, 'did:plc:a'));
  t.add(follow(3, 'did:plc:b'));
  t.add(block(4, 'did:plc:a'));
  t.add(del(5));
  t.add(del(6, js.BLOCK));
  t.add({ kind: 'identity', time_us: (at('00:00:00') + 7000) * 1000 });
  t.add(follow(8, 'not-a-did'));
  t.add({ kind: 'commit', time_us: (at('00:00:00') + 9000) * 1000, commit: { operation: 'create', collection: js.FOLLOW, record: {} } });
  assert.deepEqual([...t.follows], [['did:plc:a', 2], ['did:plc:b', 1]]);
  assert.deepEqual([...t.blocks], [['did:plc:a', 1]]);
  assert.equal(t.nFollows, 3);
  assert.equal(t.nBlocks, 1);
});

test('FollowBlockTally stops at the window end and skips events before the start', () => {
  const t = new js.FollowBlockTally(at('01:00:00'), at('01:10:00'));
  assert.equal(t.add(follow(-5, 'did:plc:early', at('01:00:00'))), false);
  assert.equal(t.add(follow(1, 'did:plc:a', at('01:00:00'))), false);
  assert.equal(t.add(follow(599, 'did:plc:a', at('01:00:00'))), false);
  assert.equal(t.add(follow(600, 'did:plc:late', at('01:00:00'))), true, 'an event at the end time ends the window uncounted');
  assert.deepEqual([...t.follows], [['did:plc:a', 2]]);
});

test('FollowBlockTally ignores replayed duplicates after a reconnect (time_us not increasing)', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  const e = follow(10, 'did:plc:a');
  t.add(e);
  t.add(e);
  t.add(follow(9, 'did:plc:a'));
  assert.equal(t.nFollows, 1);
});

test('FollowBlockTally: every event, including deletes, feeds gap detection', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  t.add(follow(1, 'did:plc:a'));
  t.add(del(100));
  t.add(del(200));
  t.add(follow(300, 'did:plc:b'));
  t.add(del(400));
  t.add(del(500));
  t.add(follow(600, 'did:plc:c'));
  assert.deepEqual(t.coverage.finish().gaps, []);
});

test('PostSampleTally counts likes and reposts per post URI, only for posts', () => {
  const p = new js.PostSampleTally();
  const w = p.window(at('00:00:00'), at('00:02:30'));
  w.add(like(1, post(1)));
  w.add(like(2, post(1)));
  w.add(like(3, post(2)));
  w.add(like(4, post(1), js.REPOST));
  w.add(like(5, 'at://did:plc:g/app.bsky.feed.generator/feed'));
  w.add(like(6, 'at://did:plc:g/app.bsky.graph.list/l'));
  w.add(del(7, js.LIKE));
  assert.equal(w.add(like(150, post(9))), true);
  assert.equal(p.nLikes, 0, 'nothing reaches the tally before the window is finished');
  w.finish();
  assert.deepEqual([...p.likes], [[post(1), 2], [post(2), 1]]);
  assert.deepEqual([...p.reposts], [[post(1), 1]]);
  assert.equal(p.nLikes, 3);
  assert.equal(p.nReposts, 1);
});

test('PostSampleTally records the sample seconds actually covered (a stalled window counts less)', () => {
  const p = new js.PostSampleTally();
  const ok = p.window(at('00:00:00'), at('00:02:30'));
  for (let s = 0; s < 150; s += 5) ok.add(like(s, post(1)));
  ok.finish();
  assert.equal(p.sampleMs, 150e3, 'events every 5s: the 5s before the end are inside the 30s tolerance');
  const bad = p.window(at('01:00:00'), at('01:02:30'));
  for (let s = 0; s < 60; s += 5) bad.add(like(s, post(2), js.LIKE, at('01:00:00')));
  bad.finish();
  assert.equal(p.sampleMs, 150e3 + 55e3, 'only the first 55s of the stalled window were observed');
});

test('topCounts: highest first, ties by key, zeros dropped, capped', () => {
  const m = new Map([['did:c', 5], ['did:a', 5], ['did:b', 9], ['did:z', 0], ['did:d', 1]]);
  assert.deepEqual(js.topCounts(m), [['did:b', 9], ['did:a', 5], ['did:c', 5], ['did:d', 1]]);
  assert.deepEqual(js.topCounts(m, 2), [['did:b', 9], ['did:a', 5]]);
  assert.equal(js.topCounts(new Map(Array.from({ length: 4000 }, (_, i) => [`did:${i}`, i + 1]))).length, 3000);
});

test('topPosts: likes, then reposts, then uri; capped at 1000', () => {
  const likes = new Map([[post(1), 10], [post(2), 10], [post(3), 10], [post(4), 50]]);
  const reposts = new Map([[post(2), 7], [post(3), 7], [post(1), 1], [post(9), 99]]);
  assert.deepEqual(js.topPosts(likes, reposts), [[post(4), 50, 0], [post(2), 10, 7], [post(3), 10, 7], [post(1), 10, 1]]);
  const many = new Map(Array.from({ length: 1500 }, (_, i) => [post(i), i + 1]));
  const top = js.topPosts(many, new Map());
  assert.equal(top.length, 1000);
  assert.equal(top[0][1], 1500);
});

test('buildDayFile matches contract A', () => {
  const f = dayFile({
    from: `${D}T00:00:00Z`,
    to: '2026-10-09T00:00:00Z',
    gaps: [[`${D}T05:00:00Z`, `${D}T05:10:00Z`]],
    follows: { 'did:plc:a': 3, 'did:plc:b': 7 },
    blocks: { 'did:plc:b': 2 },
    likes: { [post(1)]: 4 },
    reposts: { [post(1)]: 1 },
    sampleMs: 3600e3,
  });
  assert.deepEqual(f, {
    schema: 1,
    date: D,
    window: {
      start: '2026-10-08T00:00:00Z',
      end: '2026-10-09T00:00:00Z',
      covered_seconds: 86400 - 600,
      gaps: [['2026-10-08T05:00:00Z', '2026-10-08T05:10:00Z']],
    },
    complete: true,
    totals: { follows: 10, blocks: 2, likes_sampled: 4, reposts_sampled: 1, sample_seconds: 3600 },
    follows_top: [['did:plc:b', 7], ['did:plc:a', 3]],
    blocks_top: [['did:plc:b', 2]],
    post_candidates: [[post(1), 4, 1]],
    sample_windows: [],
  });
});

test('complete means at least 99% of the day covered', () => {
  const day = { from: `${D}T00:00:00Z`, to: '2026-10-09T00:00:00Z' };
  const gap = (sec) => [[`${D}T01:00:00Z`, new Date(ms(`${D}T01:00:00Z`) + sec * 1000).toISOString()]];
  assert.equal(dayFile({ ...day, gaps: gap(864) }).complete, true, 'exactly 99%');
  assert.equal(dayFile({ ...day, gaps: gap(865) }).complete, false);
  assert.equal(dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z` }).complete, false, 'half a day');
});

test('buildDayFile without samples has empty candidates and zero sample totals', () => {
  const f = js.buildDayFile(D, {
    startMs: at('00:00:00'), endMs: at('01:00:00'), gaps: [], follows: new Map(), blocks: new Map(), nFollows: 0, nBlocks: 0, posts: null,
  });
  assert.deepEqual(f.post_candidates, []);
  assert.deepEqual(f.totals, { follows: 0, blocks: 0, likes_sampled: 0, reposts_sampled: 0, sample_seconds: 0 });
});

test('mergeDayFiles: two halves add up to the full day', () => {
  const a = dayFile({
    from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, follows: { 'did:plc:x': 10, 'did:plc:y': 5 }, blocks: { 'did:plc:x': 4 },
    likes: { [post(1)]: 8, [post(2)]: 3 }, reposts: { [post(1)]: 2 }, sampleMs: 1800e3,
  });
  const b = dayFile({
    from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', follows: { 'did:plc:x': 1, 'did:plc:z': 9 }, blocks: { 'did:plc:y': 6 },
    likes: { [post(1)]: 1, [post(3)]: 20 }, reposts: { [post(3)]: 5 }, sampleMs: 1800e3,
  });
  assert.equal(a.complete, false);
  const m = js.mergeDayFiles(a, b);
  assert.equal(m.complete, true);
  assert.deepEqual(m.window, { start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z', covered_seconds: 86400, gaps: [] });
  assert.deepEqual(m.follows_top, [['did:plc:x', 11], ['did:plc:z', 9], ['did:plc:y', 5]]);
  assert.deepEqual(m.blocks_top, [['did:plc:y', 6], ['did:plc:x', 4]]);
  assert.deepEqual(m.post_candidates, [[post(3), 20, 5], [post(1), 9, 2], [post(2), 3, 0]]);
  assert.deepEqual(m.totals, { follows: 25, blocks: 10, likes_sampled: 32, reposts_sampled: 7, sample_seconds: 3600 });
  assert.deepEqual(js.mergeDayFiles(b, a), m, 'order does not matter');
});

test('mergeDayFiles: merged halves keep the gaps found inside each half', () => {
  const a = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, gaps: [[`${D}T03:00:00Z`, `${D}T03:05:00Z`]], follows: { 'did:plc:x': 1 } });
  const b = dayFile({ from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', gaps: [[`${D}T20:00:00Z`, `${D}T20:02:00Z`]], follows: { 'did:plc:x': 1 } });
  const m = js.mergeDayFiles(a, b);
  assert.deepEqual(m.window.gaps, [[`${D}T03:00:00Z`, `${D}T03:05:00Z`], [`${D}T20:00:00Z`, `${D}T20:02:00Z`]]);
  assert.equal(m.window.covered_seconds, 86400 - 300 - 120);
  assert.equal(m.complete, true);
});

test('mergeDayFiles: a hole between non-adjacent windows becomes a gap', () => {
  const a = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T06:00:00Z`, follows: { 'did:plc:x': 1 } });
  const b = dayFile({ from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', follows: { 'did:plc:x': 1 } });
  const m = js.mergeDayFiles(a, b);
  assert.deepEqual(m.window.gaps, [[`${D}T06:00:00Z`, `${D}T12:00:00Z`]]);
  assert.equal(m.window.covered_seconds, 18 * 3600);
  assert.equal(m.complete, false);
});

test('mergeDayFiles: refuses windows whose covered time overlaps', () => {
  const a = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, follows: { 'did:plc:x': 1 } });
  const b = dayFile({ from: `${D}T11:59:00Z`, to: '2026-10-09T00:00:00Z', follows: { 'did:plc:x': 1 } });
  assert.throws(() => js.mergeDayFiles(a, b), /overlapping windows.*2026-10-08T11:59:00Z/);
  assert.throws(() => js.mergeDayFiles(a, a), /overlapping/);
});

test('mergeDayFiles: a later run may fill exactly the gap of an earlier one, and not a covered part', () => {
  const full = dayFile({
    from: `${D}T00:00:00Z`, to: '2026-10-09T00:00:00Z', gaps: [[`${D}T10:00:00Z`, `${D}T10:30:00Z`]], follows: { 'did:plc:x': 100 },
  });
  const fill = dayFile({ from: `${D}T10:00:00Z`, to: `${D}T10:30:00Z`, follows: { 'did:plc:x': 3, 'did:plc:y': 2 } });
  const m = js.mergeDayFiles(full, fill);
  assert.deepEqual(m.window.gaps, []);
  assert.equal(m.complete, true);
  assert.deepEqual(m.follows_top, [['did:plc:x', 103], ['did:plc:y', 2]]);
  const bad = dayFile({ from: `${D}T09:59:00Z`, to: `${D}T10:30:00Z`, follows: { 'did:plc:x': 3 } });
  assert.throws(() => js.mergeDayFiles(full, bad), /overlapping/);
});

test('mergeDayFiles: refuses different dates; merged top lists stay capped', () => {
  const a = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z` });
  const other = dayFile({ from: '2026-10-09T12:00:00Z', to: '2026-10-10T00:00:00Z', date: '2026-10-09' });
  assert.throws(() => js.mergeDayFiles(a, other), /cannot merge/);
  const many = (prefix) => Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`did:plc:${prefix}${i}`, i + 1]));
  const x = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, follows: many('a') });
  const y = dayFile({ from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', follows: many('b') });
  const m = js.mergeDayFiles(x, y);
  assert.equal(m.follows_top.length, 3000);
  assert.equal(m.totals.follows, 2 * (3000 * 3001) / 2);
});

test('missingPieces: nothing on disk means the whole request; a complete file means nothing', () => {
  const from = at('00:00:00');
  const to = ms('2026-10-09T00:00:00Z');
  assert.deepEqual(js.missingPieces(null, from, to), [[from, to]]);
  const full = dayFile({ from: `${D}T00:00:00Z`, to: '2026-10-09T00:00:00Z' });
  assert.deepEqual(js.missingPieces(full, from, to), []);
});

test('missingPieces: the second half run only asks for the second half; gaps are re-collected', () => {
  const first = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, gaps: [[`${D}T04:00:00Z`, `${D}T04:30:00Z`]] });
  const pieces = js.missingPieces(first, at('00:00:00'), ms('2026-10-09T00:00:00Z'));
  assert.deepEqual(pieces, [[at('04:00:00'), at('04:30:00')], [at('12:00:00'), ms('2026-10-09T00:00:00Z')]]);
});

test('missingPieces: slivers under a minute are not worth a connection', () => {
  const nearly = dayFile({ from: `${D}T00:00:00Z`, to: '2026-10-08T23:59:30Z' });
  assert.deepEqual(js.missingPieces(nearly, at('00:00:00'), ms('2026-10-09T00:00:00Z')), []);
});

test('pruneList keeps the newest 35 day files and ignores other names', () => {
  const names = [];
  for (let i = 0; i < 40; i++) names.push(`${js.isoDate(ms('2026-08-01T00:00:00Z') + i * js.DAY_MS)}.json`);
  names.push('notes.txt', '2026-09-30.json.tmp', '.gitkeep');
  const gone = js.pruneList(names);
  assert.equal(gone.length, 5);
  assert.deepEqual(gone.sort(), ['2026-08-01.json', '2026-08-02.json', '2026-08-03.json', '2026-08-04.json', '2026-08-05.json']);
  assert.deepEqual(js.pruneList(names.slice(0, 35)), []);
  assert.deepEqual(js.pruneList(['2026-01-01.json', '2026-01-02.json'], 1), ['2026-01-01.json']);
});

test('end to end: a replay with an outage in the middle ends up with one gap and exact counts', () => {
  const base = at('00:00:00');
  const t = new js.FollowBlockTally(base, base + 20 * 60e3);
  let done = false;
  for (let s = 0; s < 1200 && !done; s += 10) {
    if (s >= 300 && s < 600) continue;
    done = t.add(follow(s, `did:plc:${s % 20 === 0 ? 'a' : 'b'}`));
  }
  assert.equal(done, false);
  t.add(follow(1200, 'did:plc:end'));
  const cov = t.coverage.finish();
  assert.deepEqual(cov.gaps, [[base + 290e3, base + 600e3]]);
  const file = js.buildDayFile(D, {
    startMs: base, endMs: base + 1200e3, gaps: cov.gaps, follows: t.follows, blocks: t.blocks, nFollows: t.nFollows, nBlocks: t.nBlocks, posts: null,
  });
  assert.equal(file.window.covered_seconds, 1200 - 310);
  assert.equal(file.totals.follows, 90);
});

// ---------- regressions from the Part 1 review ----------

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const collect = require('../scripts/collect-social.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'collect-social.js');
const END_OF_DAY = ms('2026-10-09T00:00:00Z');

// A follow with the identity fields real Jetstream events carry. `skew` models an instance whose
// clock stamps the same commit later (or earlier).
const commit = (sec, subject, id, { skew = 0, collection = js.FOLLOW } = {}) => ({
  did: `did:plc:actor${id}`,
  kind: 'commit',
  time_us: (at('00:00:00') + (sec + skew) * 1000) * 1000,
  commit: { rev: `rev${id}`, operation: 'create', collection, rkey: `rk${id}`, record: { subject } },
});

test('review 1: the same commit stamped differently by another instance counts once', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('01:00:00'));
  t.add(commit(100, 'did:plc:bob', 1));
  t.failover();
  t.add(commit(100, 'did:plc:bob', 1, { skew: 2 }));
  assert.equal(t.nFollows, 1);
  assert.deepEqual([...t.follows], [['did:plc:bob', 1]]);
});

test('review 1: events the new instance stamped before the old cursor are kept, and the cursor rewinds', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('01:00:00'));
  t.add(commit(100, 'did:plc:bob', 1));
  const cursor = t.failover();
  assert.equal(cursor, (at('00:00:00') + 100e3) * 1000 - js.REWIND_US);
  t.add(commit(95, 'did:plc:dave', 3));
  t.add(commit(99, 'did:plc:carol', 2));
  assert.equal(t.nFollows, 3, 'a commit the old instance never delivered is counted although it is stamped earlier');
  t.add(commit(98, 'did:plc:erin', 4));
  assert.equal(t.nFollows, 3, 'time_us still has to increase on the new instance');
});

test('review 1: without a host change an out-of-order time_us is still ignored', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('01:00:00'));
  t.add(commit(100, 'did:plc:bob', 1));
  t.add(commit(99, 'did:plc:carol', 2));
  assert.equal(t.nFollows, 1);
});

test('review 1: the rewind never goes before the window start; no events yet means the start', () => {
  const base = at('01:00:00');
  const t = new js.FollowBlockTally(base, base + 3600e3);
  assert.equal(t.failover(), base * 1000);
  t.add({ ...commit(0, 'did:plc:a', 1), time_us: (base + 5000) * 1000 });
  assert.equal(t.failover(), base * 1000, 'rewinding 10s from 5s in would pass the start');
});

test('review 1: events without commit identity are never treated as duplicates', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('01:00:00'));
  t.add(follow(10, 'did:plc:a'));
  t.failover();
  t.add(follow(11, 'did:plc:a'));
  assert.equal(t.nFollows, 2);
});

test('review 1: remembered commit keys are bounded by a sliding window of event time', () => {
  const r = new js.RecentCommits(60e6);
  for (let i = 0; i < 200000; i++) r.seen(`k${i}`, i * 1000);
  assert.ok(r.size <= 60001, `kept ${r.size}`);
  assert.equal(r.seen('k199999', 199999 * 1000), true);
  assert.equal(r.seen('k10', 10 * 1000), false, 'old keys are forgotten');
});

// Scriptable Jetstream: step(call, onEvent, n) returns how the connection ended.
function fakeNet(step) {
  const calls = [];
  const connect = async (url, onEvent) => {
    const m = /^wss:\/\/([^.]+\.[^.]+)\.bsky\.network\/subscribe\?.*cursor=(\d+)$/.exec(url);
    const call = { host: m[1], cursor: Number(m[2]), url };
    calls.push(call);
    return step(call, onEvent, calls.length);
  };
  const delays = [];
  return { calls, delays, deps: { hosts: ['h1.east', 'h2.east', 'h3.west'], connect, sleep: async (d) => { delays.push(d); }, log: () => {} } };
}

const feed = (onEvent, events) => {
  for (const e of events) if (onEvent(e)) return true;
  return false;
};

test('review 1: a dropped connection retries the same instance with the same cursor first', async () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  const net = fakeNet((call, onEvent, n) => {
    if (n === 1) { feed(onEvent, [commit(10, 'did:plc:a', 1), commit(20, 'did:plc:b', 2)]); return 'closed'; }
    if (n === 2) return 'error';
    feed(onEvent, [commit(20, 'did:plc:b', 2), commit(30, 'did:plc:c', 3), commit(600, 'did:plc:end', 9)]);
    return 'done';
  });
  assert.equal(await collect.replay({ collections: [js.FOLLOW], startMs: at('00:00:00'), tally: t, label: 'x' }, net.deps), true);
  assert.deepEqual(net.calls.map((c) => c.host), ['h1.east', 'h1.east', 'h1.east']);
  assert.equal(net.calls[1].cursor, (at('00:00:00') + 20e3) * 1000, 'resumes exactly at the last event');
  assert.equal(net.calls[2].cursor, net.calls[1].cursor);
  assert.equal(t.nFollows, 3, 'the resent event at the cursor is not counted twice');
});

test('review 1: after repeated failures it fails over with a rewound cursor and loses or duplicates nothing', async () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  const net = fakeNet((call, onEvent, n) => {
    if (n === 1) { feed(onEvent, [commit(90, 'did:plc:a', 1), commit(100, 'did:plc:b', 2)]); return 'closed'; }
    if (call.host === 'h1.east') return 'error';
    // h2 runs 2s behind h1: it stamps commit 2 at 98s and still has commit 3, which h1 never delivered, at 99s.
    feed(onEvent, [commit(90, 'did:plc:a', 1, { skew: -2 }), commit(98, 'did:plc:b', 2), commit(99, 'did:plc:c', 3), commit(103, 'did:plc:d', 4), commit(600, 'did:plc:end', 9)]);
    return 'done';
  });
  assert.equal(await collect.replay({ collections: [js.FOLLOW], startMs: at('00:00:00'), tally: t, label: 'x' }, net.deps), true);
  assert.deepEqual(net.calls.map((c) => c.host), ['h1.east', 'h1.east', 'h1.east', 'h1.east', 'h2.east']);
  assert.equal(net.calls[4].cursor, (at('00:00:00') + 100e3) * 1000 - js.REWIND_US);
  assert.deepEqual([...t.follows.keys()].sort(), ['did:plc:a', 'did:plc:b', 'did:plc:c', 'did:plc:d']);
  assert.equal(t.nFollows, 4);
});

test('review 7: gives up after exactly MAX_FAILURES fruitless connections; progress resets the count', async () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  const dead = fakeNet(() => 'closed');
  assert.equal(await collect.replay({ collections: [js.FOLLOW], startMs: at('00:00:00'), tally: t, label: 'x' }, dead.deps), false);
  assert.equal(dead.calls.length, collect.MAX_FAILURES);

  const t2 = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  const once = fakeNet((call, onEvent, n) => {
    if (n === 1) feed(onEvent, [commit(10, 'did:plc:a', 1)]);
    return 'closed';
  });
  assert.equal(await collect.replay({ collections: [js.FOLLOW], startMs: at('00:00:00'), tally: t2, label: 'x' }, once.deps), false);
  assert.equal(once.calls.length, 1 + collect.MAX_FAILURES, 'a connection with progress does not count toward the cap');
});

test('review 7: pruning runs even when the run does nothing, and the process exits on its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-social-'));
  const days = path.join(dir, 'days');
  fs.mkdirSync(days, { recursive: true });
  const yesterday = js.isoDate(Date.now() - js.DAY_MS);
  const w = js.dayWindow(yesterday);
  const full = dayFile({ from: js.iso(w.start), to: js.iso(w.end), date: yesterday });
  fs.writeFileSync(path.join(days, `${yesterday}.json`), JSON.stringify(full));
  const old = [];
  for (let i = 0; i < 36; i++) old.push(js.isoDate(ms('2026-01-01T00:00:00Z') + i * js.DAY_MS));
  for (const d of old) fs.writeFileSync(path.join(days, `${d}.json`), '{}');
  fs.writeFileSync(path.join(days, `${old[0]}.partial.json`), '{}');
  const env = { ...process.env, STATE_DIR: dir };

  const covered = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(covered.status, 0, covered.stderr);
  assert.match(covered.stdout, /already covered/);
  const left = fs.readdirSync(days).sort();
  assert.equal(left.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).length, 35);
  assert.ok(!left.includes(`${old[0]}.json`) && !left.includes(`${old[1]}.json`));
  assert.ok(!left.includes(`${old[0]}.partial.json`), 'a sidecar without its day file goes too');
  assert.ok(left.includes(`${yesterday}.json`));

  fs.writeFileSync(path.join(days, '2025-01-01.json'), '{}');
  const empty = spawnSync(process.execPath, [SCRIPT, '--date', '2020-01-01'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /nothing replayable/);
  assert.ok(!fs.existsSync(path.join(days, '2025-01-01.json')), 'also pruned on the "nothing replayable" exit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 7: a bad argument still exits 1', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
});

// ---------- review 2: sockets that never finish closing ----------

class StuckSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.closeCalls = 0;
    StuckSocket.last = this;
  }
  close() { this.closeCalls++; }
}

test('review 2: a socket whose close handshake never completes is released after a short wait', async () => {
  const how = await collect.connect('wss://x.bsky.network/subscribe', () => false, { WebSocket: StuckSocket, idleMs: 10, closeTimeoutMs: 20 });
  assert.equal(how, 'idle');
  const sock = StuckSocket.last;
  assert.equal(sock.closeCalls, 1);
  assert.equal(sock.onmessage, null, 'frames after the decision are not processed');
  assert.equal(typeof sock.onclose, 'function', 'still listening for a late close');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sock.onclose, null);
  assert.equal(sock.onerror, null);
});

// ---------- review 3: rankings survive the per-piece cut ----------

function pieceResult({ from, to, follows = {}, blocks = {}, likes = {}, reposts = {}, windows = [], sampleMs = 0, gaps = [] }) {
  const posts = new js.PostSampleTally();
  for (const [u, n] of Object.entries(likes)) { posts.likes.set(u, n); posts.nLikes += n; }
  for (const [u, n] of Object.entries(reposts)) { posts.reposts.set(u, n); posts.nReposts += n; }
  posts.windows = windows.map(([a, b]) => [ms(a), ms(b)]);
  posts.sampleMs = sampleMs;
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    startMs: ms(from), endMs: ms(to), gaps, follows: new Map(Object.entries(follows)), blocks: new Map(Object.entries(blocks)),
    nFollows: sum(follows), nBlocks: sum(blocks), posts,
  };
}

test('review 3: an account just below the cut in one half keeps its true rank', () => {
  const first = { 'did:plc:x': 39 };
  for (let i = 0; i < 3000; i++) first[`did:plc:a${String(i).padStart(4, '0')}`] = 40;
  const a = js.foldPiece(D, null, null, pieceResult({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, follows: first }));
  assert.equal(a.file.follows_top.length, 3000);
  assert.ok(!a.file.follows_top.some(([k]) => k === 'did:plc:x'), 'x is below the day-file cut');
  assert.ok(a.partial, 'an unfinished day gets a sidecar');
  assert.ok(a.partial.follows.list.some(([k]) => k === 'did:plc:x'), 'but the sidecar still has it');

  const b = js.foldPiece(D, a.file, JSON.parse(JSON.stringify(a.partial)), pieceResult({
    from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', follows: { 'did:plc:x': 100, 'did:plc:a0000': 80 },
  }));
  assert.equal(b.partial, null, 'a complete day needs no sidecar');
  assert.equal(b.file.complete, true);
  assert.deepEqual(b.file.follows_top.slice(0, 2), [['did:plc:x', 139], ['did:plc:a0000', 120]]);
  assert.equal(b.file.totals.follows, 3000 * 40 + 39 + 180);
});

test('review 3: blocks and post candidates are ranked from the full counts too', () => {
  const blocks = {};
  for (let i = 0; i < 3100; i++) blocks[`did:plc:b${i}`] = 5;
  blocks['did:plc:late'] = 4;
  const likes = {};
  for (let i = 0; i < 1100; i++) likes[post(i)] = 10;
  likes[post(5000)] = 9;
  const a = js.foldPiece(D, null, null, pieceResult({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z`, blocks, likes }));
  assert.ok(!a.file.blocks_top.some(([k]) => k === 'did:plc:late'));
  assert.ok(!a.file.post_candidates.some(([u]) => u === post(5000)));
  const b = js.foldPiece(D, a.file, a.partial, pieceResult({
    from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', blocks: { 'did:plc:late': 20 }, likes: { [post(5000)]: 30 }, reposts: { [post(5000)]: 2 },
  }));
  assert.deepEqual(b.file.blocks_top[0], ['did:plc:late', 24]);
  assert.deepEqual(b.file.post_candidates[0], [post(5000), 39, 2]);
});

test('review 3: the sidecar is capped, tracks how wrong a count can be, and survives a JSON round trip', () => {
  const many = {};
  for (let i = 0; i < js.PARTIAL_ACCOUNTS + 500; i++) many[`did:plc:m${i}`] = 1 + (i % 7);
  const a = js.foldPiece(D, null, null, pieceResult({ from: `${D}T00:00:00Z`, to: `${D}T06:00:00Z`, follows: many }));
  assert.equal(a.partial.follows.list.length, js.PARTIAL_ACCOUNTS);
  assert.ok(a.partial.follows.error > 0 && a.partial.follows.error <= 7);
  const b = js.foldPiece(D, a.file, JSON.parse(JSON.stringify(a.partial)), pieceResult({ from: `${D}T06:00:00Z`, to: `${D}T12:00:00Z`, follows: { 'did:plc:m1': 1 } }));
  assert.ok(b.partial.follows.error >= a.partial.follows.error);
  assert.equal(b.partial.follows.list.length, js.PARTIAL_ACCOUNTS);
});

test('review 3: a stale or foreign sidecar is ignored; a day file with no sidecar still folds', () => {
  const a = js.foldPiece(D, null, null, pieceResult({ from: `${D}T00:00:00Z`, to: `${D}T06:00:00Z`, follows: { 'did:plc:x': 50, 'did:plc:y': 10 } }));
  const next = () => pieceResult({ from: `${D}T06:00:00Z`, to: `${D}T12:00:00Z`, follows: { 'did:plc:y': 5 } });
  const stale = { ...JSON.parse(JSON.stringify(a.partial)), covered_seconds: 1, follows: { list: [['did:plc:bogus', 99999]], error: 0 } };
  const b = js.foldPiece(D, a.file, stale, next());
  assert.deepEqual(b.file.follows_top, [['did:plc:x', 50], ['did:plc:y', 15]]);
  assert.deepEqual(js.foldPiece(D, a.file, null, next()).file.follows_top, b.file.follows_top);
  const foreign = JSON.parse(JSON.stringify(a.partial));
  foreign.date = '2026-10-01';
  foreign.follows.list = [['did:plc:bogus', 99999]];
  assert.deepEqual(js.foldPiece(D, a.file, foreign, next()).file.follows_top, b.file.follows_top);
  const wrongTotals = JSON.parse(JSON.stringify(a.partial));
  wrongTotals.totals.follows += 1;
  wrongTotals.follows.list = [['did:plc:bogus', 99999]];
  assert.deepEqual(js.foldPiece(D, a.file, wrongTotals, next()).file.follows_top, b.file.follows_top);
});

test('review 3: the fields the board builder reads are unchanged', () => {
  const r = js.foldPiece(D, null, null, pieceResult({ from: `${D}T00:00:00Z`, to: `${D}T06:00:00Z`, follows: { 'did:plc:x': 2 }, likes: { [post(1)]: 3 } }));
  assert.deepEqual(Object.keys(r.file), ['schema', 'date', 'window', 'complete', 'totals', 'follows_top', 'blocks_top', 'post_candidates', 'sample_windows', 'errors']);
  assert.deepEqual(Object.keys(r.file.totals), ['follows', 'blocks', 'likes_sampled', 'reposts_sampled', 'sample_seconds']);
  assert.deepEqual(r.file.follows_top, [['did:plc:x', 2]]);
  assert.deepEqual(r.file.post_candidates, [[post(1), 3, 0]]);
});

test('review 3: pruneList removes sidecars whose day file is gone', () => {
  const names = ['2026-10-08.json', '2026-10-08.partial.json', '2026-10-01.partial.json', '2026-10-09.partial.json'];
  assert.deepEqual(js.pruneList(names, 1), ['2026-10-01.partial.json', '2026-10-09.partial.json']);
});

// ---------- review 4: sampled windows are remembered ----------

test('review 4: the day file records the windows it sampled; unfinished windows count for nothing', () => {
  const p = new js.PostSampleTally();
  const base = at('12:28:45');
  const done = p.window(base, base + 150e3);
  done.add(like(1, post(1), js.LIKE, base));
  done.add(like(2, post(1), js.LIKE, base));
  assert.equal(done.finish(true).committed, true);
  const b2 = at('13:28:45');
  const cut = p.window(b2, b2 + 150e3);
  cut.add(like(1, post(2), js.LIKE, b2));
  assert.equal(cut.finish(false).committed, false);
  assert.deepEqual([...p.likes], [[post(1), 2]]);
  assert.equal(p.nLikes, 2);
  assert.equal(p.sampleMs, 2000, 'only what the finished window observed');
  assert.deepEqual(p.windows, [[base, base + 2000]], 'and only that stretch is recorded as sampled');
  const f = js.buildDayFile(D, { startMs: at('12:00:00'), endMs: at('13:00:00'), gaps: [], follows: new Map(), blocks: new Map(), nFollows: 0, nBlocks: 0, posts: p });
  assert.deepEqual(f.sample_windows, [[`${D}T12:28:45Z`, `${D}T12:28:47Z`]]);
});

test('review 4: a refill of a follow gap skips windows that are already counted', () => {
  const day = js.dayWindow(D);
  const full = js.sampleWindows(day.start, day.end, 24, 150);
  const afternoon = js.sampleWindows(at('12:00:00'), day.end, js.sampleCountFor(at('12:00:00'), day.end), 150);
  assert.equal(afternoon[0][0], at('12:28:45'), 'the two schedules really coincide');
  assert.deepEqual(js.freshSampleWindows(afternoon, []), afternoon);
  assert.deepEqual(js.freshSampleWindows(afternoon, full), []);
  const fresh = js.freshSampleWindows(afternoon, full.slice(0, 20));
  assert.equal(fresh.length, 4);
  assert.equal(fresh[0][0], at('20:28:45'));
});

test('review 4: a gapped file plus a fill over the same instants keeps the likes at 10', () => {
  const win = [`${D}T12:28:45Z`, `${D}T12:31:15Z`];
  const first = js.foldPiece(D, null, null, pieceResult({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z` }));
  const gapped = js.foldPiece(D, first.file, first.partial, pieceResult({
    from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z', likes: { [post(1)]: 10 }, windows: [win], sampleMs: 150e3, gaps: [[at('12:00:00'), at('13:00:00')]],
  }));
  const sampled = js.daySampleWindows(gapped.file);
  assert.deepEqual(sampled, [[ms(win[0]), ms(win[1])]]);
  const wanted = js.sampleWindows(at('12:00:00'), at('13:00:00'), js.sampleCountFor(at('12:00:00'), at('13:00:00')), 150);
  assert.deepEqual(wanted, sampled, 'the fill would pick exactly the same instants');
  assert.deepEqual(js.freshSampleWindows(wanted, sampled), [], 'so it skips them');
  const fill = js.foldPiece(D, gapped.file, gapped.partial, pieceResult({ from: `${D}T12:00:00Z`, to: `${D}T13:00:00Z`, follows: { 'did:plc:a': 1 } }));
  assert.deepEqual(fill.file.post_candidates, [[post(1), 10, 0]]);
  assert.equal(fill.file.totals.likes_sampled, 10);
  assert.equal(fill.file.window.gaps.length, 0);
});

test('review 4: merging files whose sampled windows overlap is refused; older files get windows rebuilt', () => {
  const a = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T12:00:00Z` });
  const b = dayFile({ from: `${D}T12:00:00Z`, to: '2026-10-09T00:00:00Z' });
  a.sample_windows = [[`${D}T11:00:00Z`, `${D}T11:02:30Z`]];
  b.sample_windows = [[`${D}T11:01:00Z`, `${D}T11:03:30Z`]];
  assert.throws(() => js.mergeDayFiles(a, b), /sampled twice/);
  b.sample_windows = [[`${D}T13:00:00Z`, `${D}T13:02:30Z`]];
  assert.deepEqual(js.mergeDayFiles(a, b).sample_windows, [[`${D}T11:00:00Z`, `${D}T11:02:30Z`], [`${D}T13:00:00Z`, `${D}T13:02:30Z`]]);

  const legacy = dayFile({ from: `${D}T00:00:00Z`, to: '2026-10-09T00:00:00Z', sampleMs: 24 * 150e3 });
  delete legacy.sample_windows;
  assert.deepEqual(js.daySampleWindows(legacy), js.sampleWindows(at('00:00:00'), END_OF_DAY, 24, 150));
  const none = dayFile({ from: `${D}T00:00:00Z`, to: `${D}T01:00:00Z` });
  delete none.sample_windows;
  assert.deepEqual(js.daySampleWindows(none), []);
});

// ---------- review 5: hostile or odd frames ----------

test('review 5: non-object frames and odd shapes are ignored, not fatal', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  for (const junk of [null, 5, true, 'x', [], undefined, {}, { time_us: 'soon' }, { time_us: NaN }]) assert.equal(t.add(junk), false);
  assert.equal(t.add({ kind: 'commit', time_us: (at('00:00:00') + 1000) * 1000, commit: 'oops' }), false);
  assert.equal(t.add({ kind: 'commit', time_us: (at('00:00:00') + 2000) * 1000, commit: { operation: 'create', collection: js.FOLLOW, record: 'x' } }), false);
  const w = new js.PostSampleTally().window(at('00:00:00'), at('00:02:30'));
  for (const junk of [null, 5, true, [], {}]) assert.equal(w.add(junk), false);
  assert.equal(w.add({ kind: 'commit', time_us: (at('00:00:00') + 1000) * 1000, commit: { operation: 'create', collection: js.LIKE, record: { subject: 'x' } } }), false);
  assert.equal(t.nFollows, 0);
});

test('review 5: only short DIDs and real post URIs become subjects', () => {
  const t = new js.FollowBlockTally(at('00:00:00'), at('00:10:00'));
  const subjects = ['did:plc:ok', 'did:web:example.com', 'did:', 'did:plc:', `did:plc:${'a'.repeat(121)}`, 'did:PLC:abc', 'did:plc:a b', 'did:plc:a\n', 'at://did:plc:a', ''];
  subjects.forEach((s, i) => t.add(follow(i + 1, s)));
  assert.deepEqual([...t.follows.keys()], ['did:plc:ok', 'did:web:example.com']);
  const p = new js.PostSampleTally();
  const w = p.window(at('00:00:00'), at('00:02:30'));
  const uris = [
    post(1), 'at://did:plc:a/app.bsky.feed.post/', 'at://did:plc:a/app.bsky.feed.post/a/b', 'at://not-a-did/app.bsky.feed.post/r',
    `at://did:plc:a/app.bsky.feed.post/${'r'.repeat(513)}`, `at://did:plc:${'a'.repeat(200)}/app.bsky.feed.post/r`, 'at://did:plc:a/app.bsky.feed.post/r s',
  ];
  uris.forEach((u, i) => w.add(like(i + 1, u)));
  w.finish();
  assert.deepEqual([...p.likes.keys()], [post(1)]);
});

test('review 5: the subscribe URL caps the frame size, and odd frames are dropped client side', async () => {
  const url = collect.buildUrl('jetstream2.us-east', [js.FOLLOW, js.BLOCK], 123);
  assert.equal(url, `wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=${js.FOLLOW}&wantedCollections=${js.BLOCK}&maxMessageSizeBytes=${js.MAX_MESSAGE_BYTES}&cursor=123`);

  class Feeder {
    constructor() { Feeder.last = this; }
    close() { setTimeout(() => this.onclose && this.onclose(), 0); }
  }
  const seen = [];
  const p = collect.connect('wss://x.bsky.network/s', (ev) => { seen.push(ev); return seen.length >= 2; }, { WebSocket: Feeder, idleMs: 1000 });
  const huge = `{"a":"${'x'.repeat(js.MAX_MESSAGE_BYTES)}"}`;
  for (const data of ['null', '5', 'true', '"s"', 'not json', Buffer.from('{"z":1}'), huge, '[]', '{"a":1}', '[1]', '{"b":2}']) Feeder.last.onmessage({ data });
  assert.equal(await p, 'done');
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

// ---------- review 6: giving up marks the unseen tail as a gap ----------

test('review 6: giving up within the gap threshold of the end still leaves the tail uncovered', () => {
  const t = new js.CoverageTracker(0, 119e3);
  t.observe(0);
  assert.deepEqual(t.finish(false).gaps, [], 'a window that ran to its end tolerates a short silence');
  const g = new js.CoverageTracker(0, 119e3);
  g.observe(0);
  const r = g.finish(true);
  assert.deepEqual(r.gaps, [[0, 119e3]]);
  assert.equal(r.coveredMs, 0);
  const none = new js.CoverageTracker(10e3, 20e3);
  assert.deepEqual(none.finish(true).gaps, [[10e3, 20e3]], 'no event at all');
});

test('review 6: the same for a sample window that was cut short', () => {
  const p = new js.PostSampleTally();
  const w = p.window(at('00:00:00'), at('00:02:30'));
  w.add(like(1, post(1)));
  const r = w.finish(false);
  assert.deepEqual(r.gaps, [[at('00:00:01'), at('00:02:30')]]);
  assert.equal(p.sampleMs, 0);
  assert.deepEqual(p.windows, []);
});

test('review 6: a follow pass that gave up in the last two minutes leaves a gap for a later run to refill', () => {
  const base = at('00:00:00');
  const t = new js.FollowBlockTally(base, base + 119e3);
  t.add(follow(1, 'did:plc:a'));
  assert.deepEqual(t.coverage.finish(true).gaps, [[base + 1e3, base + 119e3]]);
});
