'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/accounts.js');

test('tallyRepos counts active, each inactive status, and treats a missing active flag as active', () => {
  const t = A.tallyRepos([
    { active: true }, {}, { active: false, status: 'deactivated' }, { active: false, status: 'takendown' },
    { active: false, status: 'deleted' }, { active: false, status: 'desynchronized' }, { active: false },
  ]);
  assert.deepEqual(t, { repos: 7, active: 2, deactivated: 1, takendown: 1, suspended: 0, deleted: 1, other: 2 });
});

test('selectHosts keeps Bluesky-operated hosts, drops banned/offline and third-party, keeps previous hosts', () => {
  const hosts = A.selectHosts([
    { hostname: 'amanita.us-east.host.bsky.network', status: 'active' },
    { hostname: 'old.us-west.host.bsky.network', status: 'offline' },
    { hostname: 'blacksky.app', status: 'active' },
    { hostname: 'spaces-alpha.host.bsky.network', status: 'active' },
  ], ['lepista.us-west.host.bsky.network', 'evil.example.com']);
  assert.deepEqual(hosts, ['amanita.us-east.host.bsky.network', 'lepista.us-west.host.bsky.network']);
});

const host = (name, active, extra = {}) => ({ host: name, tally: { ...A.emptyTally(), repos: active + 10, active, deactivated: 10 }, ...extra });

test('summariseRun sums only finished hosts and marks the run incomplete when any host failed', () => {
  const ok = A.summariseRun({ startedAt: '2026-10-08T02:40:00Z', finishedAt: '2026-10-08T02:50:00Z', hostResults: [host('a', 100), host('b', 50)] });
  assert.equal(ok.complete, true);
  assert.equal(ok.active, 150);
  assert.equal(ok.deactivated, 20);
  assert.equal(ok.date, '2026-10-08');
  const bad = A.summariseRun({ startedAt: 'x', finishedAt: '2026-10-08T02:50:00Z', hostResults: [host('a', 100), host('b', 50, { error: 'HTTP 502' })] });
  assert.equal(bad.complete, false);
  assert.deepEqual(bad.hosts_failed, ['b']);
  assert.equal(bad.active, 100);
});

const row = (date, active, complete = true, hour = '02') => ({ date, finished_at: `${date}T${hour}:50:00Z`, complete, active, host_list: ['h'] });

test('mergeRuns: one row per date, an incomplete rerun never replaces a complete row, only the newest complete row keeps its host list', () => {
  let rows = A.mergeRuns([], row('2026-10-07', 100));
  rows = A.mergeRuns(rows, row('2026-10-08', 120));
  rows = A.mergeRuns(rows, row('2026-10-08', 5, false));
  assert.deepEqual(rows.map((r) => [r.date, r.active]), [['2026-10-07', 100], ['2026-10-08', 120]]);
  assert.equal('host_list' in rows[0], false);
  assert.deepEqual(rows[1].host_list, ['h']);
  rows = A.mergeRuns(rows, row('2026-10-09', 7, false));
  assert.equal(rows.at(-1).complete, false);
  assert.deepEqual(rows[1].host_list, ['h'], 'an incomplete newest run does not strip the last complete host list');
  rows = A.mergeRuns(rows, row('2026-10-09', 130));
  assert.equal(rows.at(-1).active, 130);
});

test('netDaily: change between consecutive complete runs, scaled to 24h, skipping incomplete runs and long gaps', () => {
  const rows = [row('2026-10-01', 1000), row('2026-10-02', 1100), row('2026-10-03', 9, false), row('2026-10-04', 1300, true, '14'), row('2026-10-09', 2000)];
  assert.deepEqual(A.netDaily(rows), [{ date: '2026-10-02', net_active: 100 }, { date: '2026-10-04', net_active: 80 }]);
  assert.deepEqual(A.netDaily([row('2026-10-01', 1000), row('2026-10-02', 990)]), [{ date: '2026-10-02', net_active: -10 }], 'net can be negative');
});

test('serialize/parse round-trip and schema check', () => {
  const rows = [row('2026-10-08', 1)];
  assert.deepEqual(A.parse(A.serialize(rows)), rows);
  assert.throws(() => A.parse('{"schema":2,"rows":[]}'), /schema/);
});

const T = require('../script.js');
const build = require('../lib/build.js');

test('ownCountSeries aligns an early-morning run with the previous day and skips incomplete runs', () => {
  const dates = ['2026-10-07', '2026-10-08', '2026-10-09'];
  const oc = { rows: [
    { date: '2026-10-08', finished_at: '2026-10-08T02:50:00Z', complete: true, active: 100 },
    { date: '2026-10-08', finished_at: '2026-10-08T18:09:00Z', complete: true, active: 110 },
    { date: '2026-10-09', finished_at: '2026-10-09T02:50:00Z', complete: false, active: 5 },
  ] };
  assert.deepEqual(T.ownCountSeries(dates, oc), [100, 110, null]);
  assert.deepEqual(T.ownCountSeries(dates, null), [null, null, null]);
});

test('latestOwnCount reports the newest complete run, its inactive accounts and same-day net', () => {
  const rows = [row('2026-10-07', 1000), row('2026-10-08', 1100)].map((r) => ({ ...r, repos: r.active + 50 }));
  const oc = build.buildOwnCount(rows);
  const latest = T.latestOwnCount(oc);
  assert.equal(latest.active, 1100);
  assert.equal(latest.inactive, 50);
  assert.equal(latest.net, 100);
  assert.equal(T.latestOwnCount(build.buildOwnCount(rows.slice(0, 1))).net, null);
  assert.equal(T.latestOwnCount(null), null);
});

test('buildOwnCount keeps only published fields; validateDataset rejects a malformed own_count', () => {
  const oc = build.buildOwnCount([{ ...row('2026-10-08', 5), repos: 9, host_list: ['h'], hosts_failed: [] }]);
  assert.equal('host_list' in oc.rows[0], false);
  assert.equal(build.buildOwnCount([]), null);
  const data = build.parseDataJs(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'bluesky-data.js'), 'utf8'));
  assert.ok(build.validateDataset({ ...data, own_count: oc }));
  assert.throws(() => build.validateDataset({ ...data, own_count: { rows: [{ date: 'x', active: 1.5 }], net: [] } }), /own_count rows/);
});
