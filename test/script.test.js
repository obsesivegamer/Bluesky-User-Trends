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
  const order = ['chart.js@4.5.1/dist/chart.umd.min.js', 'hammerjs@2.0.8/hammer.min.js', 'chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js', 'src="lib/format.js', 'src="data/bluesky-data.js?v=', 'src="script.js?v='];
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
  buttons.filter((m) => /\b(time-btn|vel-mode-btn|rat-mode-btn|series-toggle|wave-chip)\b/.test(m[1]))
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
