'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const users = require('../lib/users.js');
const { H, D, ms, hourly, plcSamples } = require('./fixtures/data-helpers.js');

const at = (iso, src, n) => ({ t: ms(iso), src, users: n });
const rowOf = (series, date) => series.find((r) => r.date === date);

test('normalizeSample accepts stored arrays and rejects junk', () => {
  assert.deepEqual(users.normalizeSample(['2025-01-01T00:00:01.562Z', 'bot', 10]), { t: ms('2025-01-01T00:00:01Z'), src: 'bot', users: 10 });
  assert.equal(users.normalizeSample(['2025-01-01T00:00:00Z', 'nope', 10]), null);
  assert.equal(users.normalizeSample(['not a date', 'bot', 10]), null);
  assert.equal(users.normalizeSample(['2025-01-01T00:00:00Z', 'bot', -1]), null);
  assert.equal(users.normalizeSample(['2025-01-01T00:00:00Z', 'bot', 1.5]), null);
});

test('dedupeSamples works at the stored (whole-second) precision', () => {
  const fresh = { t: ms('2026-10-08T03:47:33.401Z'), src: 'jazco', users: 9 };
  const stored = users.parseSamplesFile(users.serializeSamplesFile([fresh]));
  assert.deepEqual(users.dedupeSamples([...stored, fresh]), [{ t: ms('2026-10-08T03:47:33Z'), src: 'jazco', users: 9 }]);
});

test('cleanSamples drops a stale plateau but keeps its first reading', () => {
  const before = hourly('bot', '2026-02-23T00:00:00Z', 24, 42_700_000, 900);
  const stuck = hourly('bot', '2026-02-24T00:00:00Z', 105, 42_722_227, 0);
  const after = hourly('bot', '2026-02-28T09:00:00Z', 5, 42_820_446, 900);
  const krekeny = at('2026-02-26T03:00:00Z', 'krekeny', 42_722_227);
  const { kept, dropped } = users.cleanSamples([...before, ...stuck, krekeny, ...after]);
  assert.equal(dropped.length, 105, 'all but the first stuck reading, including the other source');
  assert.ok(dropped.every((d) => d.reason === 'plateau' && d.users === 42_722_227));
  assert.ok(dropped.some((d) => d.src === 'krekeny'));
  assert.equal(kept.filter((s) => s.users === 42_722_227).length, 1);
  assert.equal(kept.find((s) => s.users === 42_722_227).t, ms('2026-02-24T00:00:00Z'));
});

test('cleanSamples: "held" lasts until the next different reading (6h of equal readings held 7h)', () => {
  const s = [
    ...hourly('bot', '2025-12-31T12:00:00Z', 7, 41_400_000, 1000),
    ...hourly('bot', '2025-12-31T19:00:00Z', 7, 41_407_122, 0),
    ...hourly('bot', '2026-01-01T02:00:00Z', 3, 41_412_000, 1000),
  ];
  const { dropped } = users.cleanSamples(s);
  assert.equal(dropped.length, 6);
});

test('cleanSamples keeps short repeats and repeats when the series is not growing', () => {
  const short = [...hourly('bot', '2026-04-01T15:00:00Z', 4, 43_460_000, 1000), ...hourly('bot', '2026-04-01T19:00:00Z', 5, 43_468_943, 0), at('2026-04-02T00:00:00Z', 'bot', 43_470_000)];
  assert.equal(users.cleanSamples(short).dropped.length, 0, 'held 5h is not a plateau');
  const flat = hourly('bot', '2026-01-01T00:00:00Z', 12, 1000, 0);
  assert.equal(users.cleanSamples(flat).dropped.length, 0, 'a flat series has no growing neighbours');
});

test('cleanSamples drops a stale tail (counter frozen right now)', () => {
  const s = [...hourly('bot', '2026-10-07T00:00:00Z', 10, 46_880_000, 700), ...hourly('bot', '2026-10-07T10:00:00Z', 8, 46_890_000, 0)];
  const { dropped, kept } = users.cleanSamples(s);
  assert.equal(dropped.length, 7);
  assert.equal(kept.at(-1).t, ms('2026-10-07T10:00:00Z'));
});

test('cleanSamples drops impossible drops (>1% below an earlier reading), never Commons', () => {
  const s = [
    at('2025-05-01T00:00:00Z', 'bot', 36_000_000),
    at('2025-05-01T01:00:00Z', 'wayback', 35_500_000),
    at('2025-05-01T02:00:00Z', 'bot', 35_990_000),
    at('2025-05-01T03:00:00Z', 'bot', 36_002_000),
    at('2023-06-01T00:00:00Z', 'commons', 100),
    at('2023-06-02T00:00:00Z', 'commons', 90),
  ];
  const { kept, dropped } = users.cleanSamples(s);
  assert.deepEqual(dropped.map((d) => [d.src, d.users, d.reason]), [['wayback', 35_500_000, 'drop']]);
  assert.equal(kept.length, 5);
});

test('cleanSamples: one bad high reading cannot poison more than 14 days', () => {
  const s = [at('2025-05-01T00:00:00Z', 'wayback', 99_000_000), ...hourly('bot', '2025-05-01T01:00:00Z', 24 * 20, 36_000_000, 700)];
  const { dropped } = users.cleanSamples(s);
  assert.ok(dropped.length > 0 && dropped.length <= 14 * 24);
  assert.ok(dropped.every((d) => d.t < ms('2025-05-15T00:00:01Z')));
});

test('thinSamples keeps the readings next to each boundary; clean+thin is idempotent', () => {
  const raw = [
    ...hourly('bot', '2026-02-20T00:00:00Z', 24 * 4, 42_650_000, 900),
    ...hourly('bot', '2026-02-24T00:00:00Z', 105, 42_722_227, 0),
    ...hourly('bot', '2026-02-28T09:00:00Z', 30, 42_820_446, 900),
    // a short repeat across midnight (held 4h): must not turn into a plateau after thinning
    ...hourly('elaval', '2026-02-21T21:30:00Z', 4, 42_700_000, 0),
    at('2026-02-22T01:30:00Z', 'elaval', 42_703_000),
    at('2026-02-22T06:00:00Z', 'elaval', 42_706_000),
    at('2026-02-21T03:00:00Z', 'krekeny', 42_669_000),
    at('2026-02-21T05:00:00Z', 'wayback', 42_671_000),
    at('2026-02-21T09:00:00Z', 'wayback', 42_674_000),
  ];
  const once = users.thinSamples(users.cleanSamples(raw).kept);
  const bot = once.filter((s) => s.src === 'bot');
  const perDate = {};
  for (const s of bot) perDate[new Date(s.t).toISOString().slice(0, 10)] = (perDate[new Date(s.t).toISOString().slice(0, 10)] || 0) + 1;
  assert.ok(Object.values(perDate).every((n) => n <= 2));
  assert.equal(once.filter((s) => s.src === 'wayback').length, 2, 'sparse sources are kept whole');
  const twice = users.thinSamples(users.cleanSamples(once).kept);
  assert.deepEqual(twice, once);
  assert.equal(users.cleanSamples(once).dropped.length, 0);
  // and the series built from the thinned set equals the one from the raw set
  const plain = (list) => users.buildUsersSeries([at('2026-02-19T00:00:00Z', 'commons', 1), ...list], { startDate: '2026-02-20', endDate: '2026-02-28' });
  assert.deepEqual(plain(once), plain(users.cleanSamples(raw).kept));
});

test('buildUsersSeries: boundary readings within ±3h are observed, wider brackets are estimated', () => {
  const samples = [
    at('2025-06-01T23:00:00Z', 'bot', 1000),
    at('2025-06-02T00:30:00Z', 'bot', 1100),
    at('2025-06-02T23:30:00Z', 'bot', 2000),
    at('2025-06-03T05:00:00Z', 'bot', 2550),
  ];
  const s = users.buildUsersSeries(samples, { startDate: '2025-06-01', endDate: '2025-06-02' });
  assert.deepEqual(rowOf(s, '2025-06-01'), { date: '2025-06-01', users: 1067, users_est: false, users_src: 'bot' });
  assert.deepEqual(rowOf(s, '2025-06-02'), { date: '2025-06-02', users: 2050, users_est: true, users_src: 'interp' });
});

test('buildUsersSeries: source priority bot > elaval > wayback > krekeny', () => {
  const samples = [
    at('2025-06-01T23:00:00Z', 'wayback', 1010),
    at('2025-06-02T01:00:00Z', 'wayback', 1210),
    at('2025-06-01T23:30:00Z', 'elaval', 1000),
    at('2025-06-02T00:30:00Z', 'elaval', 1100),
    at('2025-06-02T23:00:00Z', 'wayback', 2000),
    at('2025-06-03T01:00:00Z', 'wayback', 2200),
  ];
  const s = users.buildUsersSeries(samples, { startDate: '2025-06-01', endDate: '2025-06-02' });
  assert.equal(rowOf(s, '2025-06-01').users_src, 'elaval');
  assert.equal(rowOf(s, '2025-06-01').users, 1050);
  assert.equal(rowOf(s, '2025-06-02').users_src, 'wayback');
  assert.equal(rowOf(s, '2025-06-02').users, 2100);
});

test('buildUsersSeries: mixed sources bracketing within 3h are observed, labelled by the nearer one', () => {
  const samples = [at('2025-06-01T22:00:00Z', 'bot', 1000), at('2025-06-02T00:20:00Z', 'krekeny', 1140)];
  const s = users.buildUsersSeries(samples, { startDate: '2025-06-01', endDate: '2025-06-01' });
  assert.deepEqual(rowOf(s, '2025-06-01'), { date: '2025-06-01', users: 1120, users_est: false, users_src: 'krekeny' });
});

test('buildUsersSeries: Commons is the only source up to 2024-07-01 except its interpolated windows', () => {
  const samples = [
    at('2024-01-10T00:00:00Z', 'commons', 3_000_000),
    at('2024-01-11T00:00:00Z', 'commons', 3_010_000),
    at('2024-01-13T00:00:00Z', 'commons', 3_030_000),
    at('2024-01-10T23:59:00Z', 'wayback', 9_999_999), // must be ignored (Commons era)
    at('2024-02-04T00:00:00Z', 'commons', 3_200_000),
    at('2024-02-05T00:00:00Z', 'commons', 3_250_000), // Commons' own interpolation: ignored
    at('2024-02-06T17:00:00Z', 'wayback', 3_300_000),
    at('2024-02-07T23:00:00Z', 'wayback', 4_000_000),
    at('2024-02-08T01:00:00Z', 'wayback', 4_020_000),
    at('2024-02-09T00:00:00Z', 'commons', 4_400_000),
  ];
  const s = users.buildUsersSeries(samples, { startDate: '2024-01-09', endDate: '2024-02-08' });
  assert.deepEqual(rowOf(s, '2024-01-10'), { date: '2024-01-10', users: 3_010_000, users_est: false, users_src: 'commons' });
  assert.deepEqual(rowOf(s, '2024-01-11'), { date: '2024-01-11', users: 3_020_000, users_est: true, users_src: 'interp' });
  assert.equal(rowOf(s, '2024-02-03').users, 3_200_000);
  assert.equal(rowOf(s, '2024-02-04').users_est, true, 'Commons interpolated values are not observations');
  assert.notEqual(rowOf(s, '2024-02-04').users, 3_250_000);
  assert.deepEqual(rowOf(s, '2024-02-07'), { date: '2024-02-07', users: 4_010_000, users_est: false, users_src: 'wayback' });
  assert.deepEqual(rowOf(s, '2024-02-08'), { date: '2024-02-08', users: 4_400_000, users_est: false, users_src: 'commons' });
});

test('buildPlcCurve integrates page rates and covers only the sampled span', () => {
  const curve = users.buildPlcCurve(plcSamples('2024-07-01T00:00:00Z', '2024-07-03T00:00:00Z', { perHour: 1000 }));
  const c = (iso) => curve.at(ms(iso));
  assert.ok(Math.abs(c('2024-07-02T12:00:00Z') - c('2024-07-01T12:00:00Z') - 24000) < 1);
  assert.equal(curve.covers(ms('2024-07-01T01:00:00Z'), ms('2024-07-02T21:00:00Z')), true);
  assert.equal(curve.covers(ms('2024-06-30T01:00:00Z'), ms('2024-07-02T00:00:00Z')), false);
  assert.equal(users.buildPlcCurve([]), null);
});

test('PLC shaping follows the creation curve and never leaves [anchorA, anchorB]', () => {
  const plc = plcSamples('2024-08-01T00:00:00Z', '2024-08-20T00:00:00Z', {
    perHour: 200,
    burst: { from: '2024-08-10T00:00:00Z', to: '2024-08-12T00:00:00Z', factor: 20 },
  });
  const samples = [at('2024-08-02T06:00:00Z', 'wayback', 1_000_000), at('2024-08-18T06:00:00Z', 'wayback', 1_300_000)];
  const s = users.buildUsersSeries(samples, { startDate: '2024-08-02', endDate: '2024-08-17', plcSamples: plc });
  let prev = null;
  for (const r of s) {
    assert.equal(r.users_src, 'plc-shaped');
    assert.equal(r.users_est, true);
    assert.ok(r.users >= 1_000_000 && r.users <= 1_300_000);
    if (prev) assert.ok(r.users >= prev.users, 'monotonic between anchors');
    prev = r;
  }
  const gain = (d) => rowOf(s, d).users - rowOf(s, users.addDays(d, -1)).users;
  assert.ok(gain('2024-08-10') > 10 * gain('2024-08-06'), 'the burst lands on the burst days');
  // Linear interpolation would spread the total evenly instead.
  const lin = users.buildUsersSeries(samples, { startDate: '2024-08-02', endDate: '2024-08-17' });
  assert.ok(lin.every((r) => r.users_src === 'interp'));
});

test('PLC shaping only inside the sampled window, never across an observed boundary', () => {
  const plc = plcSamples('2024-08-01T00:00:00Z', '2024-08-10T00:00:00Z');
  const samples = [
    at('2024-08-02T06:00:00Z', 'wayback', 1_000_000),
    at('2024-08-04T23:00:00Z', 'wayback', 1_050_000),
    at('2024-08-05T01:00:00Z', 'wayback', 1_052_000),
    at('2024-08-12T06:00:00Z', 'wayback', 1_200_000),
  ];
  const s = users.buildUsersSeries(samples, { startDate: '2024-08-02', endDate: '2024-08-11', plcSamples: plc });
  assert.equal(rowOf(s, '2024-08-03').users_src, 'plc-shaped');
  assert.equal(rowOf(s, '2024-08-04').users_src, 'wayback');
  assert.equal(rowOf(s, '2024-08-05').users_src, 'interp', 'the bracket runs past the PLC window');
});

test('junctions between sources do not create velocity spikes', () => {
  // Two relays of the same counter, a few hundred apart, alternating as the observed source.
  const bot = hourly('bot', '2025-06-01T00:00:00Z', 24 * 6, 36_000_000, 700).filter((s) => !(s.t >= ms('2025-06-03T12:00:00Z') && s.t < ms('2025-06-05T12:00:00Z')));
  const elaval = hourly('elaval', '2025-06-01T00:20:00Z', 24 * 6, 36_000_000 + 233 + 300, 700);
  const s = users.buildUsersSeries([...bot, ...elaval], { startDate: '2025-06-01', endDate: '2025-06-05' });
  assert.deepEqual(s.map((r) => r.users_src), ['bot', 'bot', 'elaval', 'elaval', 'bot']);
  for (let i = 1; i < s.length; i++) {
    const v = s[i].users - s[i - 1].users;
    assert.ok(Math.abs(v - 16_800) < 1_000, `velocity ${v} on ${s[i].date}`);
  }
});

test('latest boundary with nothing after it is extrapolated at the recent pace and marked estimated', () => {
  const samples = hourly('bot', '2026-10-05T00:00:00Z', 60, 46_850_000, 700);
  const s = users.buildUsersSeries(samples, { startDate: '2026-10-05', endDate: '2026-10-07' });
  const last = rowOf(s, '2026-10-07');
  assert.equal(last.users_est, true);
  assert.equal(last.users_src, 'interp');
  assert.ok(Math.abs(last.users - (46_850_000 + 72 * 700)) <= 2);
});

test('buildUsersSeries requires an end date and a reading before the first day', () => {
  assert.throws(() => users.buildUsersSeries([]), /endDate/);
  assert.throws(() => users.buildUsersSeries([at('2026-01-01T00:00:00Z', 'bot', 5)], { startDate: '2025-01-01', endDate: '2025-01-01' }), /no user-count reading/);
});

test('samples file round-trips and refuses corrupt rows', () => {
  const s = [at('2022-11-18T00:00:00Z', 'commons', 5), at('2025-01-01T00:00:01.562Z', 'bot', 25_935_732)];
  const text = users.serializeSamplesFile(s);
  assert.match(text, /\n\["2022-11-18T00:00:00Z","commons",5\],\n\["2025-01-01T00:00:01Z","bot",25935732\]\n/);
  assert.deepEqual(users.parseSamplesFile(text), [at('2022-11-18T00:00:00Z', 'commons', 5), at('2025-01-01T00:00:01Z', 'bot', 25_935_732)]);
  assert.throws(() => users.parseSamplesFile(text.replace(',"bot",', ',"bogus",')), /invalid sample/);
});

test('dateRanges groups consecutive dates', () => {
  const rows = ['2024-01-01', '2024-01-02', '2024-01-04'].map((date) => ({ date, x: true }));
  assert.deepEqual(users.dateRanges(rows, (r) => r.x), [{ from: '2024-01-01', to: '2024-01-02' }, { from: '2024-01-04', to: '2024-01-04' }]);
  assert.equal(D, 24 * H);
});
