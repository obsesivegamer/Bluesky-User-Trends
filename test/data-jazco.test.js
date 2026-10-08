'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jazco = require('../lib/jazco.js');
const { loadJazcoStats } = require('./fixtures/data-helpers.js');

const ALL = jazco.METRICS;
const row = (date, v = {}) => ({ date, likers: 1000, posters: 600, followers: 300, blockers: 60, posts: 3000, likes: 20000, follows: 1500, blocks: 300, ...v });
const days = (from, n, fn = () => ({})) =>
  Array.from({ length: n }, (_, i) => {
    const date = new Date(Date.parse(from + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10);
    return row(date, fn(i, date));
  });
const flagsOn = (rows, date) => rows.find((r) => r.date === date).flags;

test('normalizeStats drops today and future-dated rows, sorts ascending, keeps the snapshot', () => {
  const raw = loadJazcoStats();
  const { rows, counts, snapshot } = jazco.normalizeStats(raw, { today: '2026-10-08' });
  assert.equal(counts.today, 1);
  assert.equal(counts.future, 1);
  assert.equal(rows.length, 1317);
  assert.equal(rows[0].date, '2023-03-01');
  assert.equal(rows.at(-1).date, '2026-10-07');
  assert.deepEqual(rows.at(-1), { date: '2026-10-07', likers: 988944, posters: 576400, followers: 279824, blockers: 56571, posts: 3440538, likes: 19903762, follows: 1702144, blocks: 301046 });
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].date < rows[i].date);
  assert.deepEqual(snapshot, {
    total_users: 46899364,
    updated_at: '2026-10-08T03:47:33.401020879Z',
    total_posts: 3286036562,
    total_likes: 18190891741,
    total_follows: 3928005731,
    source: 'bsky-search.jazco.io/stats',
  });
});

test('normalizeStats uses the given UTC day, not the newest row', () => {
  const raw = loadJazcoStats();
  const { rows, counts } = jazco.normalizeStats(raw, { today: '2026-10-06' });
  assert.equal(rows.at(-1).date, '2026-10-05');
  assert.equal(counts.future, 3);
  assert.equal(jazco.todayUtc(Date.parse('2026-10-08T23:59:59Z')), '2026-10-08');
});

test('normalizeStats rejects bad shapes and skips invalid rows', () => {
  assert.throws(() => jazco.normalizeStats({}, { today: '2026-01-01' }), /daily_data/);
  assert.throws(() => jazco.normalizeStats(null, { today: '2026-01-01' }), /daily_data/);
  const raw = {
    total_users: 0,
    updated_at: 'nope',
    daily_data: [
      { date: '2025-02-30', num_likes: 1, num_likers: 1, num_posters: 1, num_posts: 1, num_follows: 1, num_followers: 1, num_blocks: 1, num_blockers: 1 },
      { date: '2025-03-01', num_likes: '5', num_likers: 1, num_posters: 1, num_posts: 1, num_follows: 1, num_followers: 1, num_blocks: 1, num_blockers: 1 },
      { date: '2025-03-02', num_likes: 5, num_likers: 1, num_posters: 1, num_posts: 1, num_follows: 1, num_followers: 1, num_blocks: 1, num_blockers: 1 },
      { date: '2025-03-02', num_likes: 9, num_likers: 9, num_posters: 9, num_posts: 9, num_follows: 9, num_followers: 9, num_blocks: 9, num_blockers: 9 },
      { date: '2022-12-31', num_likes: 5, num_likers: 1, num_posters: 1, num_posts: 1, num_follows: 1, num_followers: 1, num_blocks: 1, num_blockers: 1 },
    ],
  };
  const { rows, counts, snapshot } = jazco.normalizeStats(raw, { today: '2026-01-01' });
  assert.deepEqual(rows.map((r) => [r.date, r.likes]), [['2025-03-02', 5]]);
  assert.equal(counts.invalid, 2);
  assert.equal(counts.duplicate, 1);
  assert.equal(counts.beforeStart, 1);
  assert.equal(snapshot, null);
});

test('real history: flags exactly the known outages, the blocks gap and the early blockers placeholder', () => {
  const { rows } = jazco.normalizeStats(loadJazcoStats(), { today: '2026-10-08' });
  const flagged = jazco.flagActivity(rows);
  const all = (d) => assert.deepEqual(flagsOn(flagged, d), ALL, d);
  ['2024-08-31', '2024-09-01', '2024-09-02', '2024-09-03', '2024-09-04', '2024-09-05', '2024-09-06', '2024-09-07', '2024-09-10', '2025-04-22', '2026-04-13', '2026-04-14', '2026-04-15'].forEach(all);
  assert.deepEqual(flagsOn(flagged, '2024-10-23'), ['likers', 'likes']);
  assert.deepEqual(flagsOn(flagged, '2025-05-20'), ['likers', 'likes']);
  for (const d of ['2025-09-19', '2025-11-01', '2025-12-19']) assert.deepEqual(flagsOn(flagged, d), ['blockers', 'blocks']);
  assert.deepEqual(flagsOn(flagged, '2025-12-20'), []);
  assert.deepEqual(flagsOn(flagged, '2023-04-10'), ['blockers'], 'blockers reported as a constant 3 before collection');

  const expected = new Set(['2024-08-31', '2024-09-01', '2024-09-02', '2024-09-03', '2024-09-04', '2024-09-05', '2024-09-06', '2024-09-07', '2024-09-10', '2024-10-23', '2025-04-22', '2025-05-20', '2026-04-13', '2026-04-14', '2026-04-15']);
  const surprises = flagged.filter((r) => r.flags.length && !expected.has(r.date) && !(r.date >= '2025-09-19' && r.date <= '2025-12-19') && r.date >= '2023-05-02');
  assert.deepEqual(surprises.map((r) => `${r.date}:${r.flags}`), []);
  // Real waves and the verified Oct 2024 lull stay unflagged.
  for (const d of ['2024-02-06', '2024-02-07', '2024-08-30', '2024-10-12', '2024-10-13', '2024-10-15', '2024-10-17', '2024-10-30', '2024-11-18', '2024-11-19', '2023-09-12']) {
    assert.deepEqual(flagsOn(flagged, d), [], d);
  }
});

test('rolling rule: an isolated collapse is flagged, a step change (wave) is not', () => {
  const rows = days('2025-01-01', 60, (i) => {
    if (i === 20) return { likers: 300, likes: 6000 }; // partial day: actors and records both drop
    if (i >= 40) return { likers: 3000, posters: 1800, followers: 900, likes: 60000, posts: 9000 }; // a wave
    return {};
  });
  const f = jazco.flagActivity(rows);
  assert.deepEqual(flagsOn(f, '2025-01-21'), ['likers', 'likes']);
  for (const r of f) if (r.date !== '2025-01-21') assert.deepEqual(r.flags, [], r.date);
});

test('rolling rule: bursty record counts need a collapse, not just a dip, to be flagged', () => {
  const rows = days('2025-01-01', 60, (i) => {
    if (i === 20) return { follows: 600 }; // 40% of normal: plausible after a mass-follow burst
    if (i === 30) return { blocks: 10 + 11 }; // 7%: a collapse
    return {};
  });
  const f = jazco.flagActivity(rows);
  assert.deepEqual(flagsOn(f, '2025-01-21'), []);
  assert.deepEqual(flagsOn(f, '2025-01-31'), ['blocks']);
});

test('rolling rule: the newest day is checked against the trailing median only', () => {
  const rows = days('2026-09-01', 37, (i) => (i === 36 ? { likers: 400, posters: 250, followers: 120, blockers: 25, posts: 1200, likes: 7000, follows: 600, blocks: 120 } : {}));
  const f = jazco.flagActivity(rows);
  assert.deepEqual(flagsOn(f, '2026-10-07'), ALL);
  const ok = jazco.flagActivity(days('2026-09-01', 37, (i) => (i === 36 ? { likers: 800 } : {})));
  assert.deepEqual(flagsOn(ok, '2026-10-07'), []);
});

test('blocks floor flags zero runs of any length', () => {
  const f = jazco.flagActivity(days('2025-09-01', 120, (i) => (i >= 18 && i < 110 ? { blocks: i % 3, blockers: i % 2 } : {})));
  assert.deepEqual(flagsOn(f, '2025-09-19'), ['blockers', 'blocks']);
  assert.deepEqual(flagsOn(f, '2025-11-30'), ['blockers', 'blocks']);
  assert.deepEqual(flagsOn(f, '2025-09-18'), []);
  assert.deepEqual(flagsOn(f, '2025-12-20'), []);
});

test('computeDau = max of the unflagged actor counts; null when likers or posters is flagged', () => {
  assert.equal(jazco.computeDau({ ...row('2025-01-01'), flags: [] }), 1000);
  assert.equal(jazco.computeDau({ ...row('2025-01-01', { followers: 5000 }), flags: [] }), 5000);
  assert.equal(jazco.computeDau({ ...row('2025-01-01', { followers: 5000 }), flags: ['followers'] }), 1000);
  assert.equal(jazco.computeDau({ ...row('2025-01-01'), flags: ['likers', 'likes'] }), null);
  assert.equal(jazco.computeDau({ ...row('2025-01-01'), flags: ['posters'] }), null);
  assert.equal(jazco.computeDau({ ...row('2023-02-28'), flags: [] }), null);
  assert.equal(jazco.computeDau({ ...row('2025-01-01', { likers: null }), flags: [] }), null);
});

test('known-outage table is well formed and matches the values the API returns today', () => {
  for (const o of [...jazco.KNOWN_OUTAGES, ...jazco.VERIFIED_DIPS]) {
    assert.match(o.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(o.to >= o.from);
    assert.ok(o.metrics.length && o.metrics.every((m) => ALL.includes(m)));
    assert.ok(o.note.length > 10);
  }
  const { rows } = jazco.normalizeStats(loadJazcoStats(), { today: '2026-10-08' });
  for (const o of jazco.KNOWN_OUTAGES) {
    assert.ok(o.metrics.includes(o.key) && Number.isSafeInteger(o.seenMax), o.from);
    const inWindow = rows.filter((r) => r.date >= o.from && r.date <= o.to);
    assert.ok(inWindow.length, o.from);
    const max = Math.max(...inWindow.map((r) => r[o.key]));
    assert.ok(Math.abs(max - o.seenMax) <= o.seenMax * 0.01 + 1, `${o.from}: seenMax ${o.seenMax} is the confirmed raw value (API now: ${max}; Jaz's counts jitter slightly between calls)`);
  }
});

test('a known outage that Jaz later repairs is no longer hidden', () => {
  const { rows } = jazco.normalizeStats(loadJazcoStats(), { today: '2026-10-08' });
  const repaired = rows.map((r) => (r.date === '2026-04-14' ? { ...r, likers: 1050000, posters: 590000, followers: 300000, blockers: 55000, posts: 3400000, likes: 18000000, follows: 2000000, blocks: 180000 } : r));
  const f = jazco.flagActivity(repaired);
  assert.deepEqual(flagsOn(f, '2026-04-14'), []);
  assert.equal(jazco.computeDau(f.find((r) => r.date === '2026-04-14')), 1050000);
  assert.deepEqual(flagsOn(f, '2026-04-13'), ALL, 'the unrepaired day of the same entry stays flagged');

  const half = rows.map((r) => (r.date === '2026-04-14' ? { ...r, posters: 590000, likers: 1050000 } : r));
  const g = jazco.flagActivity(half);
  assert.deepEqual(flagsOn(g, '2026-04-14'), ['followers', 'blockers', 'posts', 'likes', 'follows', 'blocks'], 'a partial repair: the rolling rule and blocks floor still catch the broken metrics');
  assert.equal(jazco.computeDau(g.find((r) => r.date === '2026-04-14')), 1050000);

  const small = rows.map((r) => (r.date === '2024-09-07' ? { ...r, posters: r.posters + 1000 } : r));
  assert.deepEqual(flagsOn(jazco.flagActivity(small), '2024-09-07'), ALL, 'a late revision within 5% is not a repair');
});
