'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../script.js');

const ROOT = path.join(__dirname, '..');
const ALL_KEYS = ['likers', 'posters', 'followers', 'blockers', 'posts', 'likes', 'follows', 'blocks'];

function day(date, extra = {}) {
  return Object.assign({
    date, users: 100, users_est: false, users_src: 'bot', new_users: 0, new_users_est: false,
    likers: 10, posters: 5, followers: 3, blockers: 1, posts: 20, likes: 50, follows: 6, blocks: 2,
    dau: 10, flags: []
  }, extra);
}

// Contiguous fixture: users grow by `perDay`, activity values vary by index.
function makeDays(start, n, { perDay = 10, base = 1000 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const date = T.addDays(start, i);
    out.push(day(date, {
      users: base + i * perDay,
      new_users: i === 0 ? null : perDay,
      likers: 100 + i, posters: 50 + i, followers: 30, blockers: 5,
      posts: 200 + i, likes: 500 + i, follows: 60, blocks: 8, dau: 100 + i
    }));
  }
  return out;
}

function makeData(days, extra = {}) {
  return Object.assign({
    schema: 1,
    generated_at: '2026-10-08T04:30:00.000Z',
    last_complete_day: days[days.length - 1].date,
    snapshot: { total_users: 46899364, updated_at: '2026-10-08T03:47:33Z', total_posts: 3286036562, total_likes: 18190891741, total_follows: 3928005731, source: 'bsky-search.jazco.io/stats' },
    live_source: { type: 'bsky-author-feed', actor: 'did:plc:5he4nkza7eqhmirg3azchqy6', pattern: 'Total Bluesky users: ([\\d,]+)' },
    activity_start: days[0].date,
    collection_start: days[0].date,
    days
  }, extra);
}

function loadDataFile() {
  const src = fs.readFileSync(path.join(ROOT, 'data', 'bluesky-data.js'), 'utf8');
  const m = /window\.BLUESKY_DATA\s*=\s*/.exec(src);
  return JSON.parse(src.slice(m.index + m[0].length).trim().replace(/;$/, ''));
}

// ---------------------------------------------------------------------------
// Ported from the Mastodon terminal (still applicable)
// ---------------------------------------------------------------------------

test('date-only archive values remain on the same local calendar date', () => {
  const date = T.parseArchiveDate('2026-07-19');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 6);
  assert.equal(date.getDate(), 19);
});

test('moving average is trailing and starts after seven records', () => {
  const data = Array.from({ length: 8 }, (_, i) => ({ date: `2026-07-0${i + 1}`, users: i + 1 }));
  assert.deepEqual(T.calculateMovingAverage(data, 'users'), [null, null, null, null, null, null, 4, 5]);
});

test('moving average retains context outside the visible range', () => {
  const s = T.buildSeries(makeDays('2026-07-01', 14));
  const b = T.getRangeBounds('1W', s.dates[0], s.dates[s.length - 1]);
  const i = T.seriesIndexOf(s, b.start);
  assert.equal(b.start, '2026-07-07');
  assert.equal(T.movingAverage(s.likers)[i], (100 + 101 + 102 + 103 + 104 + 105 + 106) / 7);
});

test('range filtering returns only the selected period', () => {
  const data = [
    { date: '2025-01-01', users: 1 },
    { date: '2026-06-20', users: 2 },
    { date: '2026-07-19', users: 3 }
  ];
  assert.deepEqual(T.filterDataByRange('1M', data), data.slice(1));
});

test('resetChartZoom resets only the requested chart', () => {
  const counts = { velocity: 0, dau: 0, tot: 0 };
  const instances = {
    velocity: { resetZoom: () => { counts.velocity += 1; } },
    dau: { resetZoom: () => { counts.dau += 1; } },
    tot: { resetZoom: () => { counts.tot += 1; } }
  };
  T.resetChartZoom('dau', instances);
  assert.deepEqual(counts, { velocity: 0, dau: 1, tot: 0 });
  T.resetChartZoom('velocity', instances);
  assert.deepEqual(counts, { velocity: 1, dau: 1, tot: 0 });
});

test('resetChartZoom does not throw for unknown chart ID or missing resetZoom', () => {
  assert.doesNotThrow(() => T.resetChartZoom('unknownChart', {}));
  assert.doesNotThrow(() => T.resetChartZoom('tot', { tot: {} }));
  assert.doesNotThrow(() => T.resetChartZoom('tot', { tot: null }));
});

test('calculateRatio computes percentages and handles edge cases', () => {
  assert.equal(T.calculateRatio(650000, 10000000), '6.50%');
  assert.equal(T.calculateRatio(576400, 988944, 1), '58.3%');
  assert.equal(T.calculateRatio(500, 0), '—');
  assert.equal(T.calculateRatio(null, 500), '—');
  assert.equal(T.calculateRatio(500, null), '—');
});

test('calculateGrowthVelocity computes the run rate per calendar day', () => {
  const v = T.calculateGrowthVelocity([{ date: '2026-07-01', users: 10000 }, { date: '2026-07-11', users: 20000 }]);
  assert.equal(v.diff, 10000);
  assert.equal(v.days, 10);
  assert.equal(v.ratePerDay, 1000);
  assert.equal(v.formatted, '+1.0K / day');
  assert.equal(T.calculateGrowthVelocity([{ date: '2026-07-01', users: 1 }]).formatted, '0 / day');
  const posters = T.calculateGrowthVelocity([{ date: '2026-07-01', posters: 5000 }, { date: '2026-07-11', posters: 8000 }], 'posters');
  assert.equal(posters.formatted, '+300 / day');
});

test('calculateDailyDeltas never invents a first-day zero', () => {
  assert.deepEqual(T.calculateDailyDeltas([{ users: 100 }, { users: 150 }, { users: 140 }, { users: 200 }], 'users'), [null, 50, -10, 60]);
  assert.deepEqual(T.calculateDailyDeltas([], 'users'), []);
});

test('generateSparklineSVG produces path strings and breaks at gaps', () => {
  const p = T.generateSparklineSVG([10, 20, 15, 30, 25], 100, 30);
  assert.ok(p.startsWith('M '));
  assert.ok(p.includes(' L '));
  assert.equal(T.generateSparklineSVG([]), '');
  assert.equal(T.generateSparklineSVG([10]), '');
  assert.equal(T.generateSparklineSVG([null, 5, null]), '');
  const gapped = T.generateSparklineSVG([1, 2, null, 3, 4]);
  assert.equal((gapped.match(/M /g) || []).length, 2);
});

test('calculatePeriodComparison returns null for ALL, empty data, or single records', () => {
  const data = [{ date: '2026-07-01', users: 100 }];
  assert.equal(T.calculatePeriodComparison('ALL', makeDays('2026-01-01', 60)), null);
  assert.equal(T.calculatePeriodComparison('1M', []), null);
  assert.equal(T.calculatePeriodComparison('1M', data), null);
  assert.equal(T.calculatePeriodComparison('1M', null), null);
});

test('calculatePeriodComparison produces arrays aligned with the current window', () => {
  const rows = makeDays('2026-08-01', 30);
  const current = T.filterDataByRange('1W', rows);
  const cmp = T.calculatePeriodComparison('1W', rows);
  assert.ok(cmp);
  assert.equal(cmp.dates.length, current.length);
  assert.equal(cmp.valuesFor('users').length, current.length);
  assert.equal(cmp.dates[0], T.addDays(current[0].date, -7));
  assert.equal(cmp.dates[cmp.dates.length - 1], current[0].date);
});

test('calculatePeriodComparison pads nulls when the prior window starts before the data', () => {
  const rows = makeDays('2026-08-01', 10);
  const current = T.filterDataByRange('1W', rows);
  const cmp = T.calculatePeriodComparison('1W', rows);
  assert.ok(cmp);
  assert.equal(cmp.truncated, true);
  const users = cmp.valuesFor('users');
  assert.equal(users.length, current.length);
  const pad = users.findIndex((v) => v != null);
  assert.equal(pad, 5);
  users.slice(0, pad).forEach((v) => assert.equal(v, null));
  assert.equal(cmp.dates[pad], '2026-08-01');
});

test('filterDataByRange filters to migration-wave windows', () => {
  const rows = makeDays('2024-10-25', 60);
  const nov = T.filterDataByRange('W24NOV', rows);
  assert.equal(nov[0].date, '2024-11-04', 'starts at the baseline day, like YTD');
  assert.equal(nov[nov.length - 1].date, '2024-12-15');
  assert.equal(nov.length, 42);
});

test('getRangeLabel describes ranges and waves; comparison works inside a wave', () => {
  assert.equal(T.getRangeLabel('1Y'), 'Past Year');
  assert.equal(T.getRangeLabel('YTD'), 'Year to Date');
  assert.match(T.getRangeLabel('W24NOV'), /Post-election exodus/);
  assert.match(T.getRangeLabel('W24FEB'), /Feb 1, 2024/);
  const rows = makeDays('2024-09-01', 120);
  const cmp = T.calculatePeriodComparison('W24NOV', rows);
  assert.ok(cmp);
  assert.equal(cmp.end, '2024-11-04');
  assert.equal(cmp.span, 41);
});

// ---------------------------------------------------------------------------
// Calendar awareness and flags
// ---------------------------------------------------------------------------

test('normalizeDays sorts, dedupes and fills missing calendar days', () => {
  const rows = [day('2026-01-03'), day('2026-01-01'), day('2026-01-01', { users: 7 }), { date: 'bad' }];
  const norm = T.normalizeDays(rows);
  assert.deepEqual(norm.map((r) => r.date), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.equal(norm[0].users, 7);
  assert.equal(norm[1].missing, true);
  assert.deepEqual(norm[1].flags, ALL_KEYS);
});

test('moving average and deltas are calendar-aware across a missing day', () => {
  const rows = [];
  for (let i = 1; i <= 10; i += 1) if (i !== 5) rows.push({ date: `2026-03-${String(i).padStart(2, '0')}`, users: i * 10 });
  const ma = T.calculateMovingAverage(rows, 'users');
  // 2026-03-07 window = Mar 1..7 with Mar 5 missing: mean of 10,20,30,40,60,70.
  assert.equal(ma[rows.findIndex((r) => r.date === '2026-03-07')], (10 + 20 + 30 + 40 + 60 + 70) / 6);
  // Fewer than 7 calendar days of history: still null even though 6 rows exist.
  assert.equal(ma[rows.findIndex((r) => r.date === '2026-03-06')], null);
  const deltas = T.calculateDailyDeltas(rows, 'users');
  assert.equal(deltas[rows.findIndex((r) => r.date === '2026-03-06')], null);
  assert.equal(deltas[rows.findIndex((r) => r.date === '2026-03-04')], 10);

  const s = T.buildSeries(rows);
  assert.equal(s.length, 10);
  assert.equal(s.users[4], null);
  assert.equal(s.new_users[4], null);
  assert.equal(s.new_users[5], null);
});

test('moving average needs at least four valid days in the window', () => {
  const values = [1, 2, 3, null, null, null, 7, 8];
  const ma = T.movingAverage(values);
  assert.equal(ma[6], (1 + 2 + 3 + 7) / 4);
  assert.equal(T.movingAverage([1, null, null, null, null, 6, 7])[6], null);
});

test('flagged metrics are treated as missing everywhere', () => {
  const days = makeDays('2026-01-01', 10);
  days[5].flags = ['likers', 'likes'];
  days[5].dau = null;
  days[7].flags = ['blocks', 'blockers'];
  days[7].dau = 99999;
  days[8].flags = ['posters'];
  days[8].dau = 77777;
  const s = T.buildSeries(days);
  assert.equal(s.likers[5], null);
  assert.equal(s.likes[5], null);
  assert.equal(s.posters[5], 55);
  assert.equal(s.dau[5], null);
  assert.equal(s.poster_ratio[5], null);
  assert.equal(s.likes_per_liker[5], null);
  assert.equal(s.blocks[7], null);
  assert.equal(s.dau[7], 99999);
  assert.equal(s.dau[8], null, 'DAU is undefined when posters is flagged');
  assert.equal(T.metricValue(days[5], 'likers'), null);
  assert.equal(T.metricValue(days[5], 'posters'), 55);
  const ma = T.movingAverage(s.likers);
  assert.equal(ma[6], (100 + 101 + 102 + 103 + 104 + 106) / 6);
});

test('estimated user days propagate to the next day’s velocity', () => {
  const days = makeDays('2026-01-01', 4);
  days[2].users_est = true;
  const s = T.buildSeries(days);
  assert.deepEqual(s.newEst, [false, false, true, true]);
  assert.equal(s.growth_pct[1], (10 / 1000) * 100);
});

// ---------------------------------------------------------------------------
// Ranges and prior periods
// ---------------------------------------------------------------------------

test('range bounds are anchored on the latest complete day', () => {
  const first = '2022-11-17';
  const last = '2026-10-07';
  assert.deepEqual(T.getRangeBounds('1W', first, last), { start: '2026-09-30', end: last });
  assert.deepEqual(T.getRangeBounds('1M', first, last), { start: '2026-09-07', end: last });
  assert.deepEqual(T.getRangeBounds('3M', first, last), { start: '2026-07-07', end: last });
  assert.deepEqual(T.getRangeBounds('6M', first, last), { start: '2026-04-07', end: last });
  assert.deepEqual(T.getRangeBounds('YTD', first, last), { start: '2025-12-31', end: last });
  assert.deepEqual(T.getRangeBounds('1Y', first, last), { start: '2025-10-07', end: last });
  assert.deepEqual(T.getRangeBounds('2Y', first, last), { start: '2024-10-07', end: last });
  assert.deepEqual(T.getRangeBounds('ALL', first, last), { start: first, end: last });
});

test('range bounds clamp month ends, leap days and the first available day', () => {
  assert.equal(T.getRangeBounds('1M', '2020-01-01', '2026-03-31').start, '2026-02-28');
  assert.equal(T.getRangeBounds('1M', '2020-01-01', '2024-03-31').start, '2024-02-29');
  assert.equal(T.getRangeBounds('1Y', '2020-01-01', '2024-02-29').start, '2023-02-28');
  assert.equal(T.getRangeBounds('6M', '2020-01-01', '2026-08-31').start, '2026-02-28');
  assert.equal(T.getRangeBounds('2Y', '2025-06-01', '2026-10-07').start, '2025-06-01');
  assert.equal(T.getRangeBounds('W24FEB', '2024-02-10', '2026-10-07').start, '2024-02-10');
  assert.equal(T.getRangeBounds('W24NOV', '2022-11-17', '2024-11-20').end, '2024-11-20');
  assert.equal(T.getRangeBounds('W24NOV', '2022-11-17', '2024-10-01'), null);
});

test('YTD keeps its Dec 31 baseline on Jan 1 and 1W spans eight daily points', () => {
  const rows = makeDays('2025-12-01', 32);
  assert.equal(rows[rows.length - 1].date, '2026-01-01');
  const ytd = T.filterDataByRange('YTD', rows);
  assert.deepEqual(ytd.map((r) => r.date), ['2025-12-31', '2026-01-01']);
  const week = T.filterDataByRange('1W', rows);
  assert.equal(week.length, 8);
  assert.equal(week[0].date, '2025-12-25');
});

test('prior period is an equal-length calendar window ending at the range start', () => {
  const first = '2022-11-17';
  const last = '2026-10-07';
  assert.deepEqual(T.getPriorBounds('1Y', first, last), { start: '2024-10-07', end: '2025-10-07', span: 365, truncated: false });
  assert.deepEqual(T.getPriorBounds('1W', first, last), { start: '2026-09-23', end: '2026-09-30', span: 7, truncated: false });
  const ytd = T.getPriorBounds('YTD', first, last);
  assert.equal(ytd.end, '2025-12-31');
  assert.equal(ytd.span, T.daysBetween('2025-12-31', last));
  assert.equal(T.getPriorBounds('ALL', first, last), null);
  assert.equal(T.getPriorBounds('2Y', '2025-06-01', last), null);
  assert.equal(T.getPriorBounds('1Y', '2025-06-01', last).truncated, true);
});

// ---------------------------------------------------------------------------
// Waves, CSV, hash state
// ---------------------------------------------------------------------------

test('wave stats are computed from the data, not hard-coded', () => {
  const s = T.buildSeries(makeDays('2024-10-01', 120, { perDay: 1000, base: 10000000 }));
  const w = T.WAVES.find((x) => x.id === 'W24NOV');
  const st = T.computeWaveStats(w, s);
  assert.equal(st.net, 41 * 1000);
  // The wave view's own window measures the same net change as the chip (the cards use it).
  const b = T.getRangeBounds(w.id, s.dates[0], s.dates[s.length - 1]);
  assert.equal(s.users[T.seriesIndexOf(s, b.end)] - s.users[T.seriesIndexOf(s, b.start)], st.net);
  assert.equal(st.peakValue, 1000);
  assert.equal(st.peakDate, '2024-11-05');
  assert.equal(T.computeWaveStats(T.WAVES[0], s), null);
  T.WAVES.forEach((x) => assert.ok(x.start < x.end && /^W24/.test(x.id)));
});

test('CSV builder escapes cells, joins flags and leaves missing values empty', () => {
  const csv = T.buildCSV([
    { header: 'date', value: (r) => r.date },
    { header: 'note, quoted', value: (r) => r.note },
    { header: 'value', value: (r) => r.value },
    { header: 'flags', value: (r) => r.flags }
  ], [
    { date: '2026-07-18', note: 'say "hi"', value: 1.123456789, flags: ['likers', 'likes'] },
    { date: '2026-07-19', note: 'line\nbreak', value: null, flags: [] }
  ]);
  assert.equal(csv, 'date,"note, quoted",value,flags\n2026-07-18,"say ""hi""",1.123457,likers|likes\n2026-07-19,"line\nbreak",,\n');
});

test('buildChartCSV contains only the supplied rows and blanks flagged values', () => {
  const rows = [day('2026-07-18', { users: 100, likers: 9 }), day('2026-07-19', { users: 110, likers: 7, flags: ['likers'] })];
  assert.equal(T.buildChartCSV(rows, ['users', 'likers', 'flags']), 'date,users,likers,flags\n2026-07-18,100,9,\n2026-07-19,110,,likers\n');
});

test('hash state parses, validates and round-trips', () => {
  assert.deepEqual(T.parseHashState(''), { range: '1Y', ma: true, log: false, cmp: false, vm: 'new', rm: 'poster_ratio' });
  const st = T.parseHashState('#r=3m&ma=0&log=1&cmp=1&vm=pct&rm=ll');
  assert.deepEqual(st, { range: '3M', ma: false, log: true, cmp: true, vm: 'pct', rm: 'likes_per_liker' });
  assert.equal(T.serializeHashState(st), '#r=3M&ma=0&log=1&cmp=1&vm=pct&rm=ll');
  assert.equal(T.serializeHashState(T.DEFAULT_STATE), '#r=1Y&ma=1&log=0&cmp=0');
  assert.deepEqual(T.parseHashState(T.serializeHashState(st)), st);
  const bad = T.parseHashState('#r=5Y&ma=yes&log=2&cmp=1&vm=zzz&rm=<x>');
  assert.deepEqual(bad, { ...T.DEFAULT_STATE, cmp: true });
  assert.equal(T.parseHashState('#r=ALL&cmp=1').cmp, false, 'ALL has no prior period');
  assert.equal(T.parseHashState('#r=w24nov').range, 'W24NOV');
});

// ---------------------------------------------------------------------------
// Pre-render values and blocks
// ---------------------------------------------------------------------------

test('formatChange switches to a multiple for changes of 1,000% or more', () => {
  assert.equal(T.formatChange(12.345), '+12.35%');
  assert.equal(T.formatChange(-50, 1), '-50.0%');
  assert.equal(T.formatChange(999.99), '+999.99%');
  assert.equal(T.formatChange(1000), '×11.0');
  assert.equal(T.formatChange(443164189.19), '×4,431,643');
  assert.equal(T.formatChange(158991.59), '×1,591');
  assert.equal(T.formatChange(null), '—');
});

test('computePrerenderValues follows the spec formulas', () => {
  const days = makeDays('2026-01-01', 20, { perDay: 1000, base: 5000000 });
  days[19].new_users = 4000;
  days[19].posters = 400;
  days[19].flags = ['posters'];
  days[19].dau = null;
  days[10].dau = 5000;
  days[11].posters = 9000;
  days[12].posters = 99999;
  days[12].flags = ['posters'];
  days[12].dau = null;
  const v = T.computePrerenderValues(makeData(days));
  assert.equal(v['last-day'], 'Jan 20, 2026');
  assert.equal(v.generated, '2026-10-08 04:30 UTC');
  assert.equal(v['users-total'], '46,899,364');
  assert.equal(v['users-total-compact'], '46.90M');
  assert.equal(v['velocity-7d'], `+${((6 * 1000 + 4000) / 7 / 1000).toFixed(1)}K/day`);
  assert.equal(v['velocity-last'], '+4.0K');
  assert.equal(v.dau, '118');
  assert.equal(v.posters, '68');
  assert.equal(v['poster-ratio'], `${((68 / 118) * 100).toFixed(1)}%`);
  assert.equal(v['dau-share'], `${((118 / 5018000) * 100).toFixed(2)}%`);
  assert.equal(v['index-posts'], '3.286B');
  assert.equal(v['dau-peak'], '5.0K');
  assert.equal(v['dau-peak-date'], 'Jan 11, 2026');
  assert.equal(v['posters-peak'], '9.0K', 'flagged posters never become the peak');
  assert.equal(v['posters-peak-date'], 'Jan 12, 2026');
  assert.equal(v['velocity-peak'], '+4.0K');
  assert.equal(v['velocity-peak-date'], 'Jan 20, 2026');
  assert.equal(v['activity-day'], 'Jan 19, 2026');
  assert.equal(v['users-at'], '2026-10-08 03:47 UTC');
});

test('script.js and lib/prerender.js agree on every pre-render value', (t) => {
  const prerenderPath = path.join(ROOT, 'lib', 'prerender.js');
  if (!fs.existsSync(prerenderPath)) { t.skip('lib/prerender.js not present'); return; }
  const P = require(prerenderPath);
  const days = makeDays('2025-12-01', 60, { perDay: 900, base: 4000000 });
  days[59].flags = ['posters', 'posts'];
  days[59].dau = null;
  days[40].flags = ALL_KEYS.slice();
  days[40].dau = null;
  days[41].flags = ['likers', 'likes'];
  days[41].dau = null;
  days[20].dau = 999999;
  const fixtures = [makeData(days), loadDataFile()];
  fixtures.forEach((data) => assert.deepEqual(T.computePrerenderValues(data), P.computePrerenderValues(data)));
});

test('index.html carries every pre-render key, block and marker that lib/prerender.js expects', (t) => {
  const prerenderPath = path.join(ROOT, 'lib', 'prerender.js');
  if (!fs.existsSync(prerenderPath)) { t.skip('lib/prerender.js not present'); return; }
  const P = require(prerenderPath);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const result = P.prerenderIndex(html, loadDataFile());
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.unknown, []);
  const faq = P.extractFaq(result.html);
  assert.equal(faq.length, (html.match(/<details class="faq-item/g) || []).length);
  faq.forEach((f) => assert.ok(!/[<>]/.test(f.answer), 'FAQ answers are plain text'));
  const again = P.prerenderIndex(result.html, loadDataFile());
  assert.equal(again.html, result.html, 'pre-render is idempotent on our markup');
});

test('syncFaqJsonLd mirrors the painted FAQ into JSON-LD built from an older pre-render', (t) => {
  const prerenderPath = path.join(ROOT, 'lib', 'prerender.js');
  if (!fs.existsSync(prerenderPath)) { t.skip('lib/prerender.js not present'); return; }
  const P = require(prerenderPath);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const older = makeData(makeDays('2026-08-01', 60, { perDay: 900, base: 4000000 }), { generated_at: '2026-09-29T03:17:00.000Z' });
  const newer = makeData(makeDays('2026-08-01', 61, { perDay: 1200, base: 4000000 }), { generated_at: '2026-09-30T03:17:00.000Z' });
  const stale = P.prerenderIndex(html, older).html;
  const ld = JSON.parse(/<script type="application\/ld\+json" id="jsonld">([\s\S]*?)<\/script>/.exec(stale)[1]);
  const painted = P.extractFaq(P.prerenderIndex(stale, newer).html);
  const faqOf = (obj) => obj['@graph'].find((n) => n['@type'] === 'FAQPage').mainEntity.map((q) => ({ question: q.name, answer: q.acceptedAnswer.text }));
  assert.notDeepEqual(faqOf(ld), painted, 'precondition: the static JSON-LD is out of date');
  const others = JSON.stringify(ld['@graph'].filter((n) => n['@type'] !== 'FAQPage'));
  assert.equal(T.syncFaqJsonLd(ld, painted), true);
  assert.deepEqual(faqOf(ld), painted);
  assert.equal(JSON.stringify(ld['@graph'].filter((n) => n['@type'] !== 'FAQPage')), others, 'other nodes untouched');
  assert.equal(T.syncFaqJsonLd(ld, painted), false, 'no change when already in sync');
  assert.equal(T.syncFaqJsonLd({ '@type': 'Dataset' }, painted), false);
  assert.equal(T.syncFaqJsonLd(ld, []), false);
});

test('ticker items carry latest values and week-over-week change of the 7-day average', () => {
  const days = makeDays('2026-01-01', 30, { perDay: 100, base: 1000000 });
  const data = makeData(days);
  const items = T.computeTickerItems(data);
  assert.deepEqual(items.map((i) => i.key), ['users', 'velocity', 'dau', 'posters', 'posts', 'likes', 'follows', 'blocks']);
  const dau = items.find((i) => i.key === 'dau');
  assert.equal(dau.value, '129');
  const maNow = (123 + 124 + 125 + 126 + 127 + 128 + 129) / 7;
  const maWeekAgo = maNow - 7;
  assert.ok(Math.abs(dau.chg - ((maNow - maWeekAgo) / maWeekAgo) * 100) < 1e-9);
  assert.equal(items.find((i) => i.key === 'follows').chg, 0);
  const html = T.buildTickerHTML(items);
  assert.equal((html.match(/<li class="tick"/g) || []).length, 8);
  assert.match(html, /data-tick="users"><span class="tick-sym">USERS<\/span><span class="tick-val">46,899,364<\/span>/);
  assert.match(html, /tick-chg flat"><span aria-hidden="true">■<\/span> \+0\.00%/);
});

test('milestone rows mark estimated users and 7-day averages with ~', () => {
  const days = makeDays('2023-02-20', 1400, { perDay: 1000, base: 1000 });
  const i = days.findIndex((d) => d.date === '2024-02-06');
  days[i].users_est = true;
  days[i].new_users_est = true;
  days[i + 1].new_users_est = true;
  const rows = T.buildMilestoneRows(makeData(days));
  const feb = rows.find((r) => r.date === '2024-02-06');
  assert.ok(feb.users.startsWith('~') && feb.usersEst);
  assert.ok(feb.velocity.startsWith('~') && feb.velocityEst);
  const may = rows.find((r) => r.date === '2023-05-01');
  assert.ok(!may.users.startsWith('~') && !may.velocity.startsWith('~'));
  assert.match(T.buildMilestoneRowsHTML(makeData(days)), /<td class="num est" title="Estimated: [^"]+">~/);
});

test('milestone rows end with the latest day and escape their content', () => {
  const s = T.buildSeries(makeDays('2023-02-20', 1400, { perDay: 1000, base: 1000 }));
  const data = makeData(s.rows);
  const rows = T.buildMilestoneRows(data);
  assert.deepEqual(rows.map((r) => r.date), T.MILESTONES.map((m) => m.date).concat([s.dates[s.length - 1]]));
  assert.equal(rows[rows.length - 1].current, true);
  assert.equal(rows.find((r) => r.date === '2024-11-18').highlight, true);
  const html = T.buildMilestoneRowsHTML(data);
  assert.equal((html.match(/<tr/g) || []).length, rows.length);
  assert.match(html, /<tr class="current-row">/);
  assert.equal(T.escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

// ---------------------------------------------------------------------------
// Live value
// ---------------------------------------------------------------------------

test('parseLiveFeed takes the newest matching post', () => {
  const feed = {
    feed: [
      { post: { record: { text: 'Total Bluesky users: 46,899,100', createdAt: '2026-10-08T03:00:04Z' } } },
      { post: { record: { text: 'Total Bluesky users: 46,899,489', createdAt: '2026-10-08T04:00:04Z' } } },
      { post: { record: { text: 'Something else', createdAt: '2026-10-08T05:00:00Z' } } },
      { post: { record: { text: 'Total Bluesky users: 12', createdAt: 'not a date' } } },
      { post: {} },
      null
    ]
  };
  assert.deepEqual(T.parseLiveFeed(feed, 'Total Bluesky users: ([\\d,]+)'), { count: 46899489, at: Date.parse('2026-10-08T04:00:04Z') });
  assert.equal(T.parseLiveFeed({ feed: [] }, 'x(\\d+)'), null);
  assert.equal(T.parseLiveFeed(null, 'x'), null);
  assert.equal(T.parseLiveFeed(feed, '(['), null);
});

test('acceptLiveReading only takes plausible readings newer than the snapshot', () => {
  const snap = { total_users: 46899364, updated_at: '2026-10-08T03:47:33.401020879Z' };
  const now = Date.parse('2026-10-08T04:30:00Z');
  assert.equal(T.acceptLiveReading({ count: 46899489, at: Date.parse('2026-10-08T04:00:04Z') }, snap, now), true);
  assert.equal(T.acceptLiveReading({ count: 46899000, at: Date.parse('2026-10-08T03:00:04Z') }, snap, now), false, 'older than snapshot');
  assert.equal(T.acceptLiveReading({ count: 1000, at: Date.parse('2026-10-08T04:00:04Z') }, snap, now), false, 'implausible drop');
  assert.equal(T.acceptLiveReading({ count: 90000000, at: Date.parse('2026-10-08T04:00:04Z') }, snap, now), false, 'implausible jump');
  assert.equal(T.acceptLiveReading({ count: 46899489, at: now + 3600000 }, snap, now), false, 'future reading');
  assert.equal(T.acceptLiveReading(null, snap, now), false);
});

test('estimateLiveTotal ticks at the pace and never past the cap', () => {
  const reading = { count: 1000000, at: 0 };
  assert.equal(T.estimateLiveTotal(reading, 86400, 0), 1000000);
  assert.equal(T.estimateLiveTotal(reading, 86400, 10000), 1000010);
  assert.equal(T.estimateLiveTotal(reading, 86400, 10 * 3600 * 1000), 1000000 + 3 * 3600);
  assert.equal(T.estimateLiveTotal(reading, -500, 10000), 1000000, 'negative pace never ticks down');
  assert.equal(T.estimateLiveTotal(reading, 86400, -5000), 1000000);
  assert.equal(T.buildLiveUrl({ actor: 'did:plc:abc' }), 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did%3Aplc%3Aabc&limit=5&filter=posts_no_replies');
});

// ---------------------------------------------------------------------------
// Axis helpers
// ---------------------------------------------------------------------------

test('axis labels are compact and date ticks never repeat', () => {
  assert.deepEqual([1500000, 500000, 40000000, 2500, 0, -1200, 3286000000].map(T.formatAxisCompact), ['1.5M', '500K', '40M', '2.5K', '0', '-1.2K', '3.29B']);
  assert.equal(T.niceLogTick(20000), true);
  assert.equal(T.niceLogTick(30000), false);
  assert.deepEqual(T.logTicks(4e5, 3.2e6), [5e5, 1e6, 2e6]);
  assert.deepEqual(T.logTicks(13e6, 47e6), [2e7, 3e7, 4e7]);
  [[9000, 1e6], [50, 2e10], [1.1e6, 1.4e6], [13e6, 47e6]].forEach(([lo, hi]) => {
    const t = T.logTicks(lo, hi, 7);
    assert.ok(t.length >= 2 && t.length <= 7, `${lo}-${hi}: ${t}`);
    t.forEach((v) => assert.ok(v >= lo * 0.999 && v <= hi * 1.001));
  });
  assert.deepEqual(T.logTicks(5, 5), []);
  // A narrow span (a week of total users) gets evenly spaced round values, not a crowded ladder.
  assert.deepEqual(T.logTicks(46.66e6, 46.8e6), [46.7e6, 46.75e6, 46.8e6]);
  assert.deepEqual(T.logTicks(15500, 19500), [16000, 17000, 18000, 19000]);
  assert.deepEqual(T.linearTicks(0, 1, 5), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(T.linearTicks(3, 3), []);
  const dates = [];
  for (let i = 0; i < 1500; i += 1) dates.push(T.addDays('2022-11-17', i));
  [[0, 7, 6], [0, 30, 8], [0, 365, 12], [0, 1420, 12], [1000, 1100, 5]].forEach(([lo, hi, max]) => {
    const { kind, indices } = T.pickDateTicks(dates, lo, hi, max);
    const labels = indices.map((i) => T.formatDateTick(dates[i], kind));
    assert.ok(indices.length <= max, `${kind} fits ${max}`);
    assert.ok(indices.length >= 2, `${kind} has at least two ticks`);
    assert.equal(new Set(labels).size, labels.length, `${kind} labels are unique`);
    indices.forEach((i) => assert.ok(i >= lo && i <= hi));
  });
});

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

test('index.html head and script order are safe for crawlers and GitHub Pages', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(!/<a\b/i.test(head), 'no <a> in <head>');
  assert.ok(!/google-site-verification|googletagmanager|gtag\(|rel="me"/i.test(html));
  const order = ['chart.js@4.5.1/dist/chart.umd.min.js', 'hammerjs@2.0.8/hammer.min.js', 'chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js', 'src="lib/format.js', 'src="data/bluesky-data.js?v=', 'src="data/social.js"', 'src="script.js?v='];
  const positions = order.map((s) => html.indexOf(s));
  positions.forEach((p, i) => assert.ok(p > 0, `${order[i]} is loaded`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'scripts load in order');
  const local = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|#|mailto:)/.test(u));
  local.forEach((u) => assert.ok(!u.startsWith('/'), `relative URL: ${u}`));
  assert.equal((html.match(/<script src="https:\/\/cdn\.jsdelivr\.net[^>]+integrity="sha384-/g) || []).length, 3);
});

test('every toggle control exposes its state and every chart has a text alternative', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const buttons = [...html.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>/g)];
  buttons.filter((m) => /\b(time-btn|vel-mode-btn|rat-mode-btn|ldr-btn|series-toggle|wave-chip)\b/.test(m[1]))
    .forEach((m) => assert.match(m[0], /aria-pressed="(true|false)"/, m[0]));
  ['toggle-ma-btn', 'toggle-log-btn', 'toggle-compare-btn'].forEach((id) => assert.match(html, new RegExp(`id="${id}" aria-pressed="(true|false)"`)));
  const canvases = [...html.matchAll(/<canvas\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(canvases.length, 6);
  canvases.forEach((c) => {
    assert.match(c, /role="img"/);
    assert.match(c, /aria-label="[^"]+"/);
    assert.match(c, /tabindex="0"/);
  });
  assert.match(html, /id="data-table-body"/);
  assert.match(html, /<dialog id="guide-dialog"/);
  T.WAVES.forEach((w) => assert.match(html, new RegExp(`data-wave="${w.id}"`)));
  T.RANGES.forEach((r) => assert.match(html, new RegExp(`data-range="${r}"`)));
});

// ---------------------------------------------------------------------------
// Social boards (LDR, PST, DEC)
// ---------------------------------------------------------------------------

const { buildSocialFixture, buildMaliciousFixture, toScript } = require('./fixtures/social-fixture.js');

const SOCIAL_NOW = '2026-10-09T12:00:00Z';
const SOCIAL_NOW_MS = Date.parse(SOCIAL_NOW);
const socialFixture = () => buildSocialFixture({ now: SOCIAL_NOW });

function renderBoard(social, board, win, dir) {
  const res = T.resolveBoard(board, win, dir);
  const entries = T.socialBoardRows(social, res.key);
  return { res, entries, models: entries.map((e, i) => T.socialRowModel(res, e, i + 1, SOCIAL_NOW_MS)) };
}

test('resolveBoard picks the data key and falls back to a valid window', () => {
  assert.equal(T.resolveBoard('blocked', '24h').key, 'blocked_24h');
  assert.equal(T.resolveBoard('blocked', 'all').key, 'blocked_all');
  assert.equal(T.resolveBoard('growing', 'all').key, 'growing_24h', 'ALL is only for blocks');
  assert.equal(T.resolveBoard('followed', '7d').key, 'followed');
  assert.deepEqual(T.resolveBoard('followed', '7d').windows, []);
  assert.equal(T.resolveBoard('movers', '7d', 'loss').key, 'losers_7d');
  assert.equal(T.resolveBoard('movers', '24h', 'bogus').key, 'gainers_24h');
  assert.equal(T.resolveBoard('controversial', '7d').key, 'controversial_7d');
  assert.equal(T.resolveBoard('nope', 'x').key, 'blocked_24h');
  assert.deepEqual(T.SOCIAL_BOARDS.map((b) => b.id), ['blocked', 'growing', 'followed', 'movers', 'controversial']);
});

test('isEligibleAccount enforces followers, labels and a resolvable handle', () => {
  const ok = { handle: 'someone.bsky.social', followers: 10000 };
  assert.equal(T.isEligibleAccount(ok), true);
  assert.equal(T.isEligibleAccount({ ...ok, followers: 9999 }), false);
  assert.equal(T.isEligibleAccount({ ...ok, followers: '50000' }), false);
  assert.equal(T.isEligibleAccount({ ...ok, labels: ['!no-unauthenticated'] }), false);
  assert.equal(T.isEligibleAccount({ ...ok, labels: [{ val: '!hide' }] }), false);
  assert.equal(T.isEligibleAccount({ ...ok, labels: [{ val: 'verified' }] }), true);
  assert.equal(T.isEligibleAccount({ ...ok, handle: 'handle.invalid' }), false);
  assert.equal(T.isEligibleAccount({ ...ok, handle: 'x"><b>.example' }), false);
  assert.equal(T.isEligibleAccount({ ...ok, handle: 'nodots' }), false);
  assert.equal(T.isEligibleAccount(null), false);
  assert.equal(T.isEligibleAccount(ok, { min_followers: 5 }), true, 'a file cannot lower the floor');
  assert.equal(T.isEligibleAccount(ok, { min_followers: 20000 }), false, 'a file may raise it');
});

test('label values are normalised before the guardrail checks (padding, case, controls, fullwidth bang)', () => {
  const ok = { handle: 'someone.bsky.social', followers: 20000 };
  for (const v of [' !hide', '\n!hide', '\u200b!hide', '！hide', '\t!No-Unauthenticated ', '!TAKEDOWN']) {
    assert.equal(T.isEligibleAccount({ ...ok, labels: [v] }), false, JSON.stringify(v));
    assert.equal(T.isEligibleAccount({ ...ok, labels: [{ val: v }] }), false, JSON.stringify(v));
  }
  assert.equal(T.isEligibleAccount({ ...ok, labels: ['not!a-bang', 'Verified'] }), true);
  assert.equal(T.normalizeLabel(' ＰＯＲＮ\u200b '), 'porn');

  const social = socialFixture();
  const author = Object.keys(social.accounts).find((d) => !social.ineligibleDids.includes(d) && social.top_posts.some((p) => p.author === d && !p.labels && !social.hostilePosts.includes(p.uri)));
  const mine = social.top_posts.filter((p) => p.author === author && !p.labels && !social.hostilePosts.includes(p.uri));
  const survives = (s2) => T.socialTopPosts(s2).some((p) => p.uri === mine[0].uri);
  assert.equal(survives(social), true);
  const withPostLabel = (val) => ({ ...social, top_posts: social.top_posts.map((p) => (p.uri === mine[0].uri ? { ...p, labels: [{ val }] } : p)) });
  for (const v of ['Porn', ' porn', '\u200bporn', 'Graphic-Media', 'GORE', ' !hide', '！warn']) assert.equal(survives(withPostLabel(v)), false, JSON.stringify(v));
  for (const v of ['PORN', ' Sexual']) {
    const s2 = { ...social, accounts: { ...social.accounts, [author]: { ...social.accounts[author], labels: [v] } } };
    assert.equal(survives(s2), false, `author label ${JSON.stringify(v)}`);
  }
  const custom = { ...withPostLabel('spam'), guardrails: { ...social.guardrails, adult_labels: [' Spam '] } };
  assert.equal(survives(custom), false, 'extra adult labels from the file are normalised too');
});

test('every board keeps only eligible accounts, ranked, at most 25', () => {
  const social = socialFixture();
  const bad = new Set(social.ineligibleDids);
  const keys = Object.keys(social.boards);
  assert.equal(keys.length, 12);
  for (const key of keys) {
    const rows = T.socialBoardRows(social, key);
    assert.ok(rows.length > 0, key);
    assert.ok(rows.length <= 25, key);
    rows.forEach((r) => assert.ok(!bad.has(r.did), `${key} names an ineligible account`));
    const values = rows.map((r) => r.value);
    const sorted = [...values].sort((a, b) => (key.startsWith('losers') ? a - b : b - a));
    assert.deepEqual(values, sorted, `${key} is ranked`);
    assert.equal(new Set(rows.map((r) => r.did)).size, rows.length, `${key} has no duplicates`);
  }
  const raw = social.boards.blocked_24h.length;
  assert.ok(raw > T.socialBoardRows(social, 'blocked_24h').length || raw >= 25);
});

test('socialBoardRows survives missing, malformed and hostile boards', () => {
  assert.deepEqual(T.socialBoardRows(null, 'blocked_24h'), []);
  assert.deepEqual(T.socialBoardRows({ boards: {}, accounts: {} }, 'blocked_24h'), []);
  const social = {
    guardrails: {},
    accounts: { a: { handle: 'a.example.com', followers: 20000 } },
    boards: { blocked_24h: [null, 5, { did: 'a' }, { did: 'a', value: 'x' }, { did: 'missing', value: 3 }, { did: '__proto__', value: 3 }, { did: 'a', value: 4 }, { did: 'a', value: 9 }] }
  };
  const rows = T.socialBoardRows(social, 'blocked_24h');
  assert.deepEqual(rows.map((r) => [r.did, r.value]), [['a', 4]]);
});

test('relativeTime, accountAge and pdsInfo', () => {
  const at = (sec) => new Date(SOCIAL_NOW_MS - sec * 1000).toISOString();
  assert.equal(T.relativeTime(at(5), SOCIAL_NOW_MS), 'just now');
  assert.equal(T.relativeTime(at(60 * 7), SOCIAL_NOW_MS), '7m ago');
  assert.equal(T.relativeTime(at(3600 * 3 + 20), SOCIAL_NOW_MS), '3h ago');
  assert.equal(T.relativeTime(at(86400 * 2.5), SOCIAL_NOW_MS), '2d ago');
  assert.equal(T.relativeTime(at(86400 * 75), SOCIAL_NOW_MS), '2mo ago');
  assert.equal(T.relativeTime(at(86400 * 800), SOCIAL_NOW_MS), '2y ago');
  assert.equal(T.relativeTime(at(-120), SOCIAL_NOW_MS), 'just now');
  assert.equal(T.relativeTime(at(-86400), SOCIAL_NOW_MS), '—');
  assert.equal(T.relativeTime(null, SOCIAL_NOW_MS), '—');
  assert.equal(T.relativeTime('garbage', SOCIAL_NOW_MS), '—');

  assert.equal(T.accountAge(at(86400 * 12), SOCIAL_NOW_MS), '12d');
  assert.equal(T.accountAge(at(86400 * 100), SOCIAL_NOW_MS), '3mo');
  assert.equal(T.accountAge(at(86400 * 365 * 3), SOCIAL_NOW_MS), '3y');
  assert.equal(T.accountAge(at(86400 * (365 * 2 + 95)), SOCIAL_NOW_MS), '2y 3mo');
  assert.equal(T.accountAge(at(86400 * (365 * 2 + 364)), SOCIAL_NOW_MS), '2y 11mo');
  assert.equal(T.accountAge(undefined, SOCIAL_NOW_MS), '—');

  assert.deepEqual(T.pdsInfo('https://morel.us-east.host.bsky.network'), { host: 'morel.us-east.host.bsky.network', kind: 'bsky' });
  assert.deepEqual(T.pdsInfo('https://Example-PDS.org/xrpc'), { host: 'example-pds.org', kind: 'third' });
  assert.deepEqual(T.pdsInfo('https://atproto.brid.gy'), { host: 'atproto.brid.gy', kind: 'bridgy' });
  assert.deepEqual(T.pdsInfo('https://bsky.network'), { host: 'bsky.network', kind: 'bsky' });
  assert.deepEqual(T.pdsInfo('https://evilbsky.network.example.com'), { host: 'evilbsky.network.example.com', kind: 'third' });
  assert.equal(T.pdsInfo('javascript:alert(1)'), null);
  assert.equal(T.pdsInfo('not a url'), null);
  assert.equal(T.pdsInfo(undefined), null);
});

test('safeAvatarUrl allows only https://cdn.bsky.app, no userinfo, no port', () => {
  assert.equal(T.safeAvatarUrl('https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg'), 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg');
  assert.equal(T.safeAvatarUrl('https://CDN.BSKY.APP/a.jpg'), 'https://cdn.bsky.app/a.jpg');
  for (const bad of [
    'https://user:pass@127.0.0.1/a.png', 'https://[::1]/a.png', 'https://127.0.0.1/a.png', 'https://evil.example/a.svg',
    'https://cdn.bsky.app.evil.example/a.jpg', 'https://evilcdn.bsky.app/a.jpg', 'https://sub.cdn.bsky.app/a.jpg', 'https://bsky.app/a.jpg',
    'https://user:pass@cdn.bsky.app/a.jpg', 'https://user@cdn.bsky.app/a.jpg', 'https://cdn.bsky.app:8443/a.jpg', 'https://cdn.bsky.app@evil.example/a.jpg',
    'http://cdn.bsky.app/a.jpg', 'https://localhost/a.png'
  ]) assert.equal(T.safeAvatarUrl(bad), null, bad);
  const social = socialFixture();
  const id = Object.keys(social.accounts).find((d) => !social.ineligibleDids.includes(d) && social.accounts[d].avatar);
  social.accounts[id].avatar = 'https://user:pass@127.0.0.1/a.png';
  const model = renderBoard(social, 'followed', null).models.find((m) => m.handle === social.accounts[id].handle);
  assert.equal(model.avatar, null);
  assert.ok(T.buildLeaderboardRowsHTML([model]).includes('avatar-blank'));
});

test('safeAvatarUrl only passes https URLs; profile and post links are built from a validated handle', () => {
  assert.equal(T.safeAvatarUrl('https://cdn.bsky.app/img/a.jpg'), 'https://cdn.bsky.app/img/a.jpg');
  assert.equal(T.safeAvatarUrl('http://cdn.bsky.app/a.jpg'), null);
  assert.equal(T.safeAvatarUrl('javascript:alert(1)'), null);
  assert.equal(T.safeAvatarUrl('data:image/png;base64,AAAA'), null);
  assert.equal(T.safeAvatarUrl(''), null);
  assert.equal(T.safeAvatarUrl(42), null);
  assert.ok(!T.safeAvatarUrl('https://cdn.bsky.app/a.jpg" onerror="x').includes('"'));
  assert.equal(T.profileUrl('a.bsky.social'), 'https://bsky.app/profile/a.bsky.social');
  assert.equal(T.postUrl('a.bsky.social', 'at://did:plc:abc123/app.bsky.feed.post/3kabc'), 'https://bsky.app/profile/a.bsky.social/post/3kabc');
  assert.equal(T.postUrl('a.bsky.social', 'at://did:plc:abc123/app.bsky.feed.like/3kabc'), null);
  assert.equal(T.postUrl('a.bsky.social', 'https://evil.example/x'), null);
});

test('row formatting per board: metric, tone, posts this month, last post, PDS', () => {
  const social = socialFixture();
  const blocked = renderBoard(social, 'blocked', '24h');
  const first = blocked.models[0];
  assert.equal(first.rank, 1);
  assert.match(first.metric, /^[\d,]+$/);
  assert.equal(first.tone, '');
  assert.equal(first.url, `https://bsky.app/profile/${first.handle}`);
  assert.match(first.followers, /^[\d,]+$/);

  const gain = renderBoard(social, 'movers', '24h', 'gain').models[0];
  assert.match(gain.metric, /^\+[\d,]+$/);
  assert.equal(gain.tone, 'up');
  const loss = renderBoard(social, 'movers', '24h', 'loss').models[0];
  assert.match(loss.metric, /^-[\d,]+$/);
  assert.equal(loss.tone, 'down');

  const con = renderBoard(social, 'controversial', '7d').models[0];
  assert.match(con.metric, /^\d+\.\d{2}×$/);
  assert.match(con.metricSub, /^[\d,]+ blk \/ [\d,]+ fol$/);

  const all = renderBoard(social, 'followed', null).models;
  const capped = all.find((m) => m.month.endsWith('+'));
  assert.equal(capped.month, '1,000+');
  assert.match(capped.monthTitle, /^At least 1,000: counting stopped before reaching the start of the month, so the real number is higher\. Own posts including replies, excluding reposts\./);
  assert.match(all.find((m) => !m.month.endsWith('+')).monthTitle, /including replies, excluding reposts/);
  const never = all.find((m) => m.last === '—');
  assert.ok(never, 'an account that never posted shows a dash');
  assert.ok(all.some((m) => /^\d+[hm] ago$|^\d+d ago$/.test(m.last)));
  assert.ok(all.every((m) => ['bsky', 'third', 'bridgy'].includes(m.pdsKind)));
  assert.ok(all.some((m) => m.pdsKind === 'third') && all.some((m) => m.pdsKind === 'bridgy') && all.some((m) => m.pdsKind === 'bsky'));
  assert.ok(all.every((m) => !m.pdsHost.includes('/') && !m.pdsHost.includes(':')), 'hostname only');
  assert.equal(T.socialMetricHead(T.resolveBoard('blocked', 'all')), 'BLOCKS ALL');
  assert.equal(T.socialMetricHead(T.resolveBoard('followed')), 'FOLLOWERS');
});

test('leaderboard rows render links, lazy avatars and never name ineligible accounts', () => {
  const social = socialFixture();
  const html = T.buildLeaderboardRowsHTML(renderBoard(social, 'blocked', '24h').models);
  const rows = html.split('\n');
  assert.ok(rows.length >= 20 && rows.length <= 25);
  assert.match(html, /<a class="acct" href="https:\/\/bsky\.app\/profile\/[a-z0-9.-]+" target="_blank" rel="noopener">/);
  assert.match(html, /<img class="avatar" src="https:\/\/cdn\.bsky\.app\/[^"]+" width="24" height="24" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">/);
  assert.ok(html.includes('avatar-blank'), 'an account without an avatar gets a placeholder');
  assert.match(html, /<span class="pds-tag pds-bsky">BSKY<\/span>/);
  assert.match(html, /<span class="pds-tag pds-third">3RD PARTY<\/span>/);
  for (const key of Object.keys(social.boards)) {
    const board = T.socialBoardRows(social, key);
    const out = T.buildLeaderboardRowsHTML(board.map((e, i) => T.socialRowModel(T.resolveBoard('blocked', '24h'), e, i + 1, SOCIAL_NOW_MS)));
    ['Small Fry', 'Private Person', 'Hidden Account', 'Unresolved', 'Adult Author', 'smallfry', 'privateperson', 'hiddenaccount', 'handle.invalid', 'adultauthor']
      .forEach((needle) => assert.ok(!out.includes(needle), `${key} must not render ${needle}`));
  }
});

test('unsafe strings never reach the markup unescaped', () => {
  const evil = buildMaliciousFixture({ now: SOCIAL_NOW });
  const boardHtml = Object.keys(evil.boards).map((key) => {
    const res = T.resolveBoard('blocked', '24h');
    return T.buildLeaderboardRowsHTML(T.socialBoardRows(evil, key).map((e, i) => T.socialRowModel(res, e, i + 1, SOCIAL_NOW_MS)));
  }).join('\n');
  const postHtml = T.buildPostCardsHTML(T.socialTopPosts(evil), SOCIAL_NOW_MS);
  for (const html of [boardHtml, postHtml]) {
    assert.ok(!/<script/i.test(html), 'no script element');
    assert.ok(!/<svg/i.test(html), 'no injected svg');
    assert.ok(!/<img src=x/i.test(html), 'no injected img');
    assert.ok(!/ onerror="window/i.test(html), 'no injected handler');
    assert.ok(!/javascript:/i.test(html), 'no javascript: url');
    assert.ok(!/src="http:/i.test(html), 'no http avatar');
    assert.ok(!/[‮\u0000]/.test(html), 'no bidi override or NUL');
    const tags = [...html.matchAll(/<(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(tags)].filter((t) => !['tr', 'td', 'a', 'img', 'span', 'li', 'div', 'p', 'b'].includes(t)), []);
  }
  assert.ok(boardHtml.includes('&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;Evil Name'));
  assert.ok(boardHtml.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(!boardHtml.includes('x"><b>'), 'a handle that is not a valid handle drops the account');
  assert.ok(!boardHtml.includes('bad</b>'));
  assert.ok(postHtml.includes('&lt;script&gt;window.__pwned=1&lt;/script&gt;'));
  assert.ok(postHtml.includes('&amp; &quot;quotes&quot; &#39;single&#39;'));
});

test('cleanText strips controls and bidi marks and caps length', () => {
  assert.equal(T.cleanText('a‮b\u0000c​d'), 'abcd');
  assert.equal(T.cleanText('  many   spaces\n here '), 'many spaces here');
  assert.equal(T.cleanText('l1\n\n\n\nl2', 280, true), 'l1\n\nl2');
  assert.equal(T.cleanText(Array(400).fill('a').join(''), 280).length, 280);
  assert.ok(T.cleanText(Array(400).fill('a').join(''), 280).endsWith('…'));
  assert.equal(T.cleanText(null, 10), '');
  assert.equal(T.cleanText({}, 10), '');
});

test('top posts: eligible authors only, adult/moderation labels skipped, 10 max, 280 chars, most liked first', () => {
  const social = socialFixture();
  const bad = new Set(social.ineligibleDids);
  const posts = T.socialTopPosts(social);
  assert.equal(posts.length, 10);
  posts.forEach((p) => {
    assert.ok(!bad.has(p.uri.split('/')[2]));
    assert.ok(p.text.length <= 280);
    assert.match(p.url, /^https:\/\/bsky\.app\/profile\/[a-z0-9.-]+\/post\/[A-Za-z0-9]+$/);
  });
  assert.deepEqual(posts.map((p) => p.likes), [...posts.map((p) => p.likes)].sort((a, b) => b - a));
  assert.ok(!posts.some((p) => p.likes >= 52000), 'the high-like posts that break a rule are gone');
  assert.ok(social.hostilePosts.length >= 5 && !posts.some((p) => social.hostilePosts.includes(p.uri)), 'shouted or padded labels, another day and a mismatched uri are all dropped');
  assert.ok(posts.some((p) => p.text === '' && p.embed === 'image') && posts.some((p) => p.text === '' && p.embed === 'quote'), 'text-free posts stay');

  const evil = buildMaliciousFixture({ now: SOCIAL_NOW });
  const long = T.socialTopPosts(evil).find((p) => p.text.startsWith('xxxx'));
  assert.equal(Array.from(long.text).length, 280);

  const adultAuthor = { ...social, accounts: { ...social.accounts } };
  const someone = social.top_posts.find((p) => !bad.has(p.author));
  adultAuthor.accounts[someone.author] = { ...adultAuthor.accounts[someone.author], labels: ['sexual'] };
  assert.ok(!T.socialTopPosts(adultAuthor).some((p) => p.uri === someone.uri));
  assert.deepEqual(T.socialTopPosts(null), []);
  assert.deepEqual(T.socialTopPosts({ top_posts: 'x', accounts: {} }), []);
});

test('top posts must belong to the board day and to the account their link names', () => {
  const social = socialFixture();
  const bad = new Set(social.ineligibleDids);
  const base = social.top_posts.find((p) => !bad.has(p.author) && !p.labels && !social.hostilePosts.includes(p.uri));
  const other = social.top_posts.find((p) => !bad.has(p.author) && p.author !== base.author);
  const only = (p) => T.socialTopPosts({ ...social, top_posts: [p] });
  assert.equal(only(base).length, 1);
  assert.equal(only({ ...base, created_at: '2020-01-01T00:00:00Z' }).length, 0, 'a post from another day is dropped');
  assert.equal(only({ ...base, created_at: `${social.day}T00:00:00Z` }).length, 1);
  const nextDay = new Date(Date.parse(`${social.day}T00:00:00Z`) + 86400e3).toISOString();
  assert.equal(only({ ...base, created_at: nextDay }).length, 0, 'the day ends at the next UTC midnight');
  assert.equal(only({ ...base, created_at: new Date(Date.parse(nextDay) - 1).toISOString() }).length, 1);
  assert.equal(only({ ...base, created_at: null }).length, 0);
  assert.equal(only({ ...base, uri: other.uri }).length, 0, 'the uri names another account than the card would link to');
  assert.equal(T.socialTopPosts({ ...social, day: 'soon', top_posts: [{ ...base, created_at: '2020-01-01T00:00:00Z' }] }).length, 1, 'no usable day, no day check');
  assert.equal(T.postUrl('a.bsky.social', 'at://did:plc:abc/app.bsky.feed.post/3k', 'did:plc:abc'), 'https://bsky.app/profile/a.bsky.social/post/3k');
  assert.equal(T.postUrl('a.bsky.social', 'at://did:plc:abc/app.bsky.feed.post/3k', 'did:plc:other'), null);
});

test('top posts with no text stay, ranked by likes, with an image/quote placeholder; counts must be numbers', () => {
  const social = socialFixture();
  const bad = new Set(social.ineligibleDids);
  const base = social.top_posts.find((p) => !bad.has(p.author) && !p.labels && !social.hostilePosts.includes(p.uri));
  const mk = (n, over) => ({ ...base, uri: base.uri.replace(/[^/]+$/, `3zz${n}`), url: '', ...over });
  const posts = [
    mk(1, { text: '', embed: 'image', likes: 90000 }),
    mk(2, { text: '   \u200b ', embed: 'quote', likes: 80000 }),
    mk(3, { text: '', embed: '<img>', likes: 70000 }),
    mk(4, { text: '', likes: 60000 }),
    mk(5, { text: 'numeric strings are not likes', likes: '15000' }),
    mk(6, { text: 'null likes', likes: null }),
    mk(7, { text: 'odd counts', likes: 5, reposts: '9', quotes: null }),
    ...social.top_posts.filter((p) => !bad.has(p.author) && !p.labels && !social.hostilePosts.includes(p.uri))
  ];
  const out = T.socialTopPosts({ ...social, top_posts: posts });
  assert.deepEqual(out.slice(0, 4).map((p) => p.uri.split('/').pop()), ['3zz1', '3zz2', '3zz3', '3zz4']);
  assert.ok(!out.some((p) => /numeric strings|null likes/.test(p.text)), 'a non-numeric likes value cannot take a slot');
  const html = T.buildPostCardsHTML(out, SOCIAL_NOW_MS);
  assert.match(html, /<p class="post-text post-text-empty">\[image\]<\/p>/);
  assert.match(html, /<p class="post-text post-text-empty">\[quote\]<\/p>/);
  assert.equal((html.match(/\[no text\]/g) || []).length, 2, 'an unknown or hostile embed value falls back to [no text]');
  assert.ok(!html.includes('<img>') && !html.includes('&lt;img&gt;'));
  const odd = T.buildPostCardsHTML(T.socialTopPosts({ ...social, top_posts: [mk(7, { text: 'odd counts', likes: 5, reposts: '9', quotes: null })] }), SOCIAL_NOW_MS);
  assert.match(odd, /<b>—<\/b> reposts/);
  assert.match(odd, /<b>—<\/b> quotes/);
  assert.match(odd, /<b>[\d.]+K?<\/b> replies/);
  assert.match(T.postsSubtitle(social), /\[image\]/);
});

test('post cards show the counts, the time and a link to the post', () => {
  const html = T.buildPostCardsHTML(T.socialTopPosts(socialFixture()), SOCIAL_NOW_MS);
  assert.equal((html.match(/<li class="post-card">/g) || []).length, 10);
  assert.match(html, /<span class="post-rank">01<\/span>/);
  assert.match(html, /<b>[\d.,]+[KM]?<\/b> likes/);
  assert.match(html, /reposts/);
  assert.match(html, /quotes/);
  assert.match(html, /replies/);
  assert.match(html, /<a class="post-time" href="https:\/\/bsky\.app\/profile\/[^"]+\/post\/[^"]+" target="_blank" rel="noopener" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC">\d+[hmd] ago<\/a>/);
});

test('board caveats cover gross counts, the Constellation window, net snapshots and coverage gaps', () => {
  const social = socialFixture();
  const say = (b, w) => T.boardCaveats(T.resolveBoard(b, w), social).join(' ');
  assert.match(say('blocked', '24h'), /gross/i);
  assert.match(say('blocked', '7d'), /Jetstream/);
  assert.match(say('blocked', 'all'), /since early 2025.*Constellation/);
  assert.match(say('growing', '24h'), /gross/i);
  assert.match(say('movers', '24h'), /net.*snapshots/i);
  assert.match(say('controversial', '24h'), /100 blocks/);
  assert.match(say('followed'), /exact/);
  const gappy = { ...social, coverage: { days_7d: 3, complete_24h: false } };
  assert.match(T.boardCaveats(T.resolveBoard('blocked', '24h'), gappy).join(' '), /partly collected/);
  assert.match(T.boardCaveats(T.resolveBoard('blocked', '7d'), gappy).join(' '), /Only 3 of the last 7 days/);
  assert.equal(T.boardCaveats(T.resolveBoard('blocked', '7d'), social).length, 1);
  assert.match(T.SOCIAL_GUARDRAIL, /10,000 followers/);
});

test('controversial rows below the follow-list cut show a floor ratio and a follows ceiling', () => {
  const social = socialFixture();
  const did = social.boards.controversial_24h[0].did;
  social.boards.controversial_24h[0] = { did, value: 8.41, blocks: 244, follows: 29, follows_below_cut: true };
  const res = T.resolveBoard('controversial', '24h');
  const flagged = T.socialBoardRows(social, 'controversial_24h').find((e) => e.did === did);
  assert.equal(flagged.belowCut, true);
  const m = T.socialRowModel(res, flagged, 1, SOCIAL_NOW_MS);
  assert.equal(m.metric, '≥8.4×');
  assert.equal(m.metricSub, '244 blk / ≤29 fol');
  for (const [value, want] of [[9.96, '≥9.9×'], [8.36, '≥8.3×'], [2.25, '≥2.2×'], [1.06, '≥1.0×'], [10, '≥10.0×'], [0.29, '≥0.2×'], [3.3, '≥3.3×'], [5.8, '≥5.8×']]) {
    const m = T.formatBoardMetric(res, { value, blocks: 200, follows: 20, belowCut: true });
    assert.equal(m.text, want, `${value} is a lower bound`);
    assert.ok(Number(m.text.slice(1, -1)) <= value, `${m.text} must not exceed ${value}`);
  }
  assert.equal(T.formatBoardMetric(res, { value: 9.96, blocks: 200, follows: 20, belowCut: false }).text, '9.96×', 'an exact ratio keeps two decimals');
  const exact = renderBoard(social, 'controversial', '7d').models[0];
  assert.match(exact.metric, /^\d+\.\d{2}×$/);
  assert.doesNotMatch(exact.metricSub, /≤/);
  social.boards.controversial_24h[0].follows_below_cut = 'yes';
  assert.equal(T.socialBoardRows(social, 'controversial_24h').find((e) => e.did === did).belowCut, false, 'only a literal true counts');
  assert.match(T.boardCaveats(res, socialFixture()).join(' '), /≥/);
});

test('controversial rows need at least 100 blocks and a non-negative follows count', () => {
  const social = socialFixture();
  const dids = social.boards.controversial_24h.map((r) => r.did);
  social.boards.controversial_24h = [
    { did: dids[0], value: 3, blocks: 1, follows: 1 },
    { did: dids[1], value: 3, blocks: 99, follows: 33 },
    { did: dids[2], value: 3, blocks: 100, follows: 33 },
    { did: dids[3], value: 2, blocks: 200, follows: -1 },
    { did: dids[4], value: 2, blocks: 200 },
    { did: dids[5], value: 1, blocks: 100, follows: 0 },
    { did: dids[6], value: 1, follows: 10 }
  ];
  assert.deepEqual(T.socialBoardRows(social, 'controversial_24h').map((r) => r.did), [dids[2], dids[5]]);
  const blocked = socialFixture();
  blocked.boards.blocked_24h = [{ did: dids[0], value: 3, blocks: 1 }];
  assert.equal(T.socialBoardRows(blocked, 'blocked_24h').length, 1, 'only controversial boards have the 100-block floor');
});

test('top posts panel says "latest UTC day" with a partial-day caveat when the latest day is incomplete', () => {
  const social = socialFixture();
  const full = { ...social, coverage: { days_7d: 7, complete_24h: true } };
  const partial = { ...social, coverage: { days_7d: 7, complete_24h: false } };
  assert.deepEqual(T.postsCaveats(full), []);
  assert.deepEqual(T.postsCaveats(null), []);
  assert.match(T.postsCaveats(partial).join(' '), /^The latest day was only partly collected/);
  assert.match(T.postsSubtitle(full), /latest complete UTC day/);
  assert.match(T.postsSubtitle(partial), /the latest UTC day/);
  assert.doesNotMatch(T.postsSubtitle(partial), /complete/);
});

test('normalizeSocial rejects anything that is not the v1 payload', () => {
  assert.equal(T.normalizeSocial(undefined), null);
  assert.equal(T.normalizeSocial('x'), null);
  assert.equal(T.normalizeSocial({ schema: 2, accounts: {}, boards: {} }), null);
  assert.equal(T.normalizeSocial({ schema: 1, accounts: {} }), null);
  const f = socialFixture();
  assert.equal(T.normalizeSocial(f), f);
  assert.match(toScript(f), /^\/\/ generated by scripts\/build-social\.js — do not edit\nwindow\.BLUESKY_SOCIAL = \{/);
  assert.ok(!toScript(f).includes('ineligibleDids'));
});

test('decentralization model: share, segments, latest complete row with third_party', () => {
  const tp = { hosts: 120, hosts_ok: 118, hosts_failed: 2, repos: 900, active: 1000, bridgy_active: 250 };
  const own = {
    rows: [
      { date: '2026-10-07', complete: true, active: 8000, third_party: { active: 100, bridgy_active: 0 } },
      { date: '2026-10-08', complete: true, active: 9000, third_party: tp },
      { date: '2026-10-09', complete: true, active: 9100 },
      { date: '2026-10-10', complete: false, active: 9200, third_party: { active: 5, bridgy_active: 0 } }
    ]
  };
  const m = T.decentralizationModel(own);
  assert.equal(m.date, '2026-10-08');
  assert.equal(m.share, 1000 / 10000);
  assert.equal(m.bsky, 9000);
  assert.equal(m.bridgy, 250);
  assert.equal(m.independent, 750);
  assert.equal(m.total, 10000);
  assert.equal(m.parts.independent, 750 / 10000);
  assert.ok(Math.abs(m.parts.bsky + m.parts.independent + m.parts.bridgy - 1) < 1e-12);
  assert.equal(m.partial, true);
  assert.equal(T.formatShare(m.share), '10.0%');
  assert.equal(T.formatShare(0.0042), '0.42%');
  assert.equal(T.formatShare(0), '0.0%');

  assert.equal(T.decentralizationModel(null), null);
  assert.equal(T.decentralizationModel({ rows: [] }), null);
  assert.equal(T.decentralizationModel({ rows: [{ complete: true, active: 5 }] }), null, 'no third_party yet');
  assert.equal(T.decentralizationModel({ rows: [{ complete: false, active: 5, third_party: { active: 1 } }] }), null);
  assert.equal(T.decentralizationModel({ rows: [{ complete: true, active: 0, third_party: { active: 0 } }] }), null);
  const clamped = T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 100, third_party: { active: 10, bridgy_active: 99 } }] });
  assert.equal(clamped.bridgy, 10);
  assert.equal(clamped.independent, 0);
});

test('decentralization markup: big percentage, segmented bar and counts', () => {
  const m = T.decentralizationModel({
    rows: [{ date: '2026-10-09', complete: true, active: 41724403, third_party: { hosts: 120, hosts_ok: 120, hosts_failed: 0, active: 1500000, bridgy_active: 200000 } }]
  });
  const html = T.buildDecentralizationHTML(m);
  assert.match(html, /<span class="dec-big tabular-stat">3\.5%<\/span>/);
  assert.match(html, /role="img" aria-label="Active accounts by host: Bluesky-hosted 96\.5%, independent PDS 3\.0%, Bridgy Fed 0\.46%"/);
  assert.ok(html.includes('seg-bsky') && html.includes('seg-indep') && html.includes('seg-bridgy'));
  assert.ok(html.includes('41,724,403') && html.includes('1,300,000') && html.includes('200,000'));
  assert.match(html, /120 of 120 non-Bluesky hosts answered/);
  assert.ok(!/lower bound/.test(html));
  const partial = T.buildDecentralizationHTML(T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 1000, third_party: { hosts: 2126, hosts_ok: 1910, hosts_failed: 216, active: 7, bridgy_active: 2 } }] }));
  assert.match(partial, /1,910 of 2,126 non-Bluesky hosts answered; 216 failed and add nothing, so the share is a lower bound/);
  const noHosts = T.buildDecentralizationHTML(T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 1000, third_party: { active: 100, bridgy_active: 10, hosts_failed: 4 } }] }));
  assert.match(noHosts, /4 non-Bluesky hosts failed and add nothing, so the share is a lower bound/);
  const capped = T.buildDecentralizationHTML(T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 100, third_party: { hosts: 10, hosts_ok: 10, hosts_failed: 0, active: 100, bridgy_active: 0, hosts_capped: 2 } }] }));
  assert.match(capped, /10 of 10 non-Bluesky hosts answered; 2 hosts were counted only up to the per-host limit, so the share is a lower bound/);
  const one = T.buildDecentralizationHTML(T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 100, third_party: { hosts: 3, hosts_ok: 3, hosts_failed: 0, active: 10, bridgy_active: 0, hosts_capped: 1 } }] }));
  assert.match(one, /1 host was counted only up to the per-host limit, so the share is a lower bound/);
  assert.equal(T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 100, third_party: { active: 10, hosts_capped: 2 } }] }).partial, true);
  const none = T.decentralizationModel({ rows: [{ date: 'd', complete: true, active: 100, third_party: { active: 0, bridgy_active: 0, hosts: 1, hosts_ok: 1, hosts_failed: 0 } }] });
  const zero = T.buildDecentralizationHTML(none);
  assert.ok(!zero.includes('class="seg seg-indep"') && !zero.includes('class="seg seg-bridgy"') && zero.includes('class="seg seg-bsky"'));
  assert.match(zero, />0\.0%</);
});

test('index.html has the LDR, PST and DEC panels, accessible pills and the guardrail text', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ['section-ldr', 'section-pst', 'section-dec', 'ldr-body', 'pst-list', 'dec-body', 'ldr-caveats', 'pst-caveats', 'pst-subtitle', 'guide-dialog'].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  ['LDR', 'PST', 'DEC'].forEach((code) => assert.match(html, new RegExp(`<span class="fn-code">${code}</span><span class="fn-go">GO</span>`)));
  T.SOCIAL_BOARDS.forEach((b) => assert.match(html, new RegExp(`data-board="${b.id}" aria-pressed="(true|false)"`)));
  ['24h', '7d', 'all'].forEach((w) => assert.match(html, new RegExp(`data-win="${w}" aria-pressed="(true|false)"`)));
  ['gain', 'loss'].forEach((d) => assert.match(html, new RegExp(`data-dir="${d}" aria-pressed="(true|false)"`)));
  assert.match(html, /Only accounts with at least 10,000 followers and no opt-out or moderation labels are named/);
  assert.match(html, /Jetstream/);
  assert.match(html, /Constellation/);
  assert.match(html, /g-social/);
  assert.match(html, /<script src="data\/social\.js"><\/script>/);
  assert.ok(html.indexOf('data/social.js') < html.indexOf('src="script.js'));
  const faq = [...html.matchAll(/<summary class="faq-question"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.ok(faq.some((q) => /leaderboards/i.test(q)));
});

test('the page code tolerates a missing data/social.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  assert.match(src, /normalizeSocial\(root\.BLUESKY_SOCIAL\)/);
  assert.equal(T.normalizeSocial(undefined), null);
  assert.deepEqual(T.socialBoardRows(T.normalizeSocial(undefined), 'blocked_24h'), []);
  assert.deepEqual(T.socialTopPosts(T.normalizeSocial(undefined)), []);
});
