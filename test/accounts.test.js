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

test('isSafeHostname accepts plain public DNS names only', () => {
  for (const ok of ['atproto.brid.gy', 'pds.example-site.com', 'a.b.c.d.example.org']) assert.equal(A.isSafeHostname(ok), true, ok);
  for (const bad of ['localhost', 'foo.localhost', 'printer.local', 'x.internal', '127.0.0.1', '10.0.0.1', '0x7f.0.0.1', 'a.1', 'host:8080', 'host.com/path',
    'user@host.com', 'Host.COM', 'a..b.com', '-a.com', 'a-.com', 'exa mple.com', '[::1]', '', 'x'.repeat(64) + '.com', ('a.'.repeat(130)) + 'com', null, 42]) {
    assert.equal(A.isSafeHostname(bad), false, String(bad));
  }
});

test('isPrivateIp flags loopback, private, link-local, CGNAT, metadata and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(A.isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) assert.equal(A.isPrivateIp(ip), false, ip);
});

test('selectThirdPartyHosts keeps active/idle non-Bluesky hosts, validates names, dedupes and sorts', () => {
  const hosts = A.selectThirdPartyHosts([
    { hostname: 'blacksky.app', status: 'active' },
    { hostname: 'atproto.brid.gy', status: 'idle' },
    { hostname: 'atproto.brid.gy', status: 'active' },
    { hostname: 'offline.example.com', status: 'offline' },
    { hostname: 'banned.example.com', status: 'banned' },
    { hostname: 'amanita.us-east.host.bsky.network', status: 'active' },
    { hostname: 'spaces-alpha.host.bsky.network', status: 'active' },
    { hostname: 'relay.bsky.network', status: 'active' },
    { hostname: 'bsky.network', status: 'active' },
    { hostname: 'localhost', status: 'active' },
    { hostname: '169.254.169.254', status: 'active' },
    { hostname: 'evil.com:8080', status: 'active' },
    { hostname: 'my.pds.example.net', status: 'active' },
  ]);
  assert.deepEqual(hosts, ['atproto.brid.gy', 'blacksky.app', 'my.pds.example.net']);
});

test('summariseThirdParty sums only finished hosts, counts failures, and reports Bridgy', () => {
  const t = (active, repos) => ({ ...A.emptyTally(), active, repos });
  const s = A.summariseThirdParty([
    { host: 'atproto.brid.gy', tally: t(300, 320) },
    { host: 'blacksky.app', tally: t(50, 60) },
    { host: 'slow.example.com', tally: t(999, 999), error: 'time budget exhausted' },
  ]);
  assert.deepEqual(s, { hosts: 3, hosts_ok: 2, hosts_failed: 1, repos: 380, active: 350, bridgy_active: 300 });
  assert.equal(A.summariseThirdParty([{ host: 'atproto.brid.gy', tally: t(1, 1), error: 'HTTP 502' }]).bridgy_active, 0);
  const alias = (name, fingerprint) => ({ host: name, tally: t(40, 45), fingerprint });
  const aliases = A.summariseThirdParty([alias('user.eurosky.social', 'did:a|did:z'), alias('eurosky.social', 'did:a|did:z'), alias('other.example.com', 'did:b|did:y'), alias('empty.example.com', '')]);
  assert.deepEqual([aliases.hosts, aliases.hosts_ok, aliases.repos, aliases.active], [4, 4, 135, 120], 'same first/last DID and counts means one PDS behind several names');
  assert.deepEqual(A.summariseThirdParty([]), { hosts: 0, hosts_ok: 0, hosts_failed: 0, repos: 0, active: 0, bridgy_active: 0 });
});

test('attachThirdParty touches only the newest row; mergeRuns keeps third_party on old rows', () => {
  const tp = { hosts: 1, hosts_ok: 1, hosts_failed: 0, repos: 5, active: 4, bridgy_active: 0 };
  const rows = A.attachThirdParty([row('2026-10-07', 100), row('2026-10-08', 120)], tp);
  assert.equal('third_party' in rows[0], false);
  assert.deepEqual(rows[1].third_party, tp);
  assert.equal(rows[1].active, 120);
  const merged = A.mergeRuns(rows, row('2026-10-09', 130));
  assert.deepEqual(merged[1].third_party, tp);
  assert.throws(() => A.attachThirdParty([], tp), /no accounts row/);
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

test('buildOwnCount passes third_party through when present; validateDataset checks its shape', () => {
  const tp = { hosts: 3, hosts_ok: 2, hosts_failed: 1, repos: 380, active: 350, bridgy_active: 300 };
  const oc = build.buildOwnCount([row('2026-10-07', 5), { ...row('2026-10-08', 6), third_party: tp }]);
  assert.equal('third_party' in oc.rows[0], false);
  assert.deepEqual(oc.rows[1].third_party, tp);
  const data = build.parseDataJs(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'bluesky-data.js'), 'utf8'));
  assert.ok(build.validateDataset({ ...data, own_count: oc }));
  for (const bad of [{ ...tp, active: 1.5 }, { ...tp, hosts_ok: 3 }, { ...tp, bridgy_active: 351 }, { ...tp, repos: 10 }, { hosts: 1 }, null]) {
    const rows = [{ ...oc.rows[1], third_party: bad }];
    assert.throws(() => build.validateDataset({ ...data, own_count: { ...oc, rows } }), /own_count third_party/);
  }
});

test('isPrivateIp parses IPv6 forms: site-local, 6to4, NAT64, IPv4-compatible and non-canonical loopback', () => {
  for (const ip of ['fec0::1', '2002:7f00:1::', '2002:a9fe:a9fe::', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '64:ff9b:1::1', '::127.0.0.1', '::7f00:1',
    '0::1', '0:0:0:0:0:0:0:1', '::ffff:7f00:1', '::ffff:169.254.169.254', '2001:db8::1', '2001::1', 'ff02::1', 'fc00::1', '100::1', 'fe80::1%eth0']) {
    assert.equal(A.isPrivateIp(ip), true, ip);
  }
  for (const ip of ['2606:4700::1111', '2a00:1450:4001::200e', '2002:0808:0808::', '64:ff9b::8.8.8.8']) assert.equal(A.isPrivateIp(ip), false, ip);
});

test('isPrivateIp restricts 192.0.0.0 to the /24 and blocks documentation ranges', () => {
  for (const ip of ['192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1']) assert.equal(A.isPrivateIp(ip), true, ip);
  for (const ip of ['192.0.1.1', '192.0.3.1', '192.1.0.1', '198.51.101.1']) assert.equal(A.isPrivateIp(ip), false, ip);
});

test('selectThirdPartyHosts lowercases, strips a trailing dot, and skips null entries; selectHosts skips them too', () => {
  const relay = [null, undefined, { hostname: 'Blacksky.App', status: 'active' }, { hostname: 'pds.Example.net.', status: 'idle' }, { status: 'active' }, { hostname: 'evil.com.:80', status: 'active' }];
  assert.deepEqual(A.selectThirdPartyHosts(relay), ['blacksky.app', 'pds.example.net']);
  assert.deepEqual(A.selectHosts([null, { hostname: 'amanita.us-east.host.bsky.network', status: 'active' }]), ['amanita.us-east.host.bsky.network']);
});

const tp = (active, repos) => ({ ...A.emptyTally(), active, repos });

test('summariseThirdParty: Bridgy comes from atproto.brid.gy even when an alias sorts first', () => {
  const s = A.summariseThirdParty([
    { host: 'aaa.brid.gy', tally: tp(300, 320), fingerprint: 'setA' },
    { host: 'atproto.brid.gy', tally: tp(300, 320), fingerprint: 'setA' },
  ]);
  assert.deepEqual(s, { hosts: 2, hosts_ok: 2, hosts_failed: 0, repos: 320, active: 300, bridgy_active: 300 });
});

test('summariseThirdParty: different DID sets are never merged; the same set under several names is counted once', () => {
  const h = (name, fp, a = 40, r = 45) => ({ host: name, tally: tp(a, r), fingerprint: fp });
  assert.equal(A.summariseThirdParty([h('a.example.com', 'hash1'), h('b.example.com', 'hash2')]).active, 80, 'same size and endpoints, different middles');
  assert.equal(A.summariseThirdParty([h('a.example.com', 'hash1'), h('b.example.com', 'hash1'), h('c.example.com', 'hash1')]).active, 40);
  assert.equal(A.summariseThirdParty([h('a.example.com', 'hash1'), h('b.example.com', 'hash3', 41, 46)]).active, 81, 'a PDS with one extra repo is a different set');
});

test('summariseThirdParty reports hosts_capped only when a host hit the cap', () => {
  assert.equal('hosts_capped' in A.summariseThirdParty([{ host: 'a.example.com', tally: tp(1, 1), fingerprint: 'x' }]), false);
  assert.equal(A.summariseThirdParty([{ host: 'a.example.com', tally: tp(1, 1), fingerprint: 'x', capped: true }]).hosts_capped, 1);
});

test('mergeRuns carries a same-day third_party forward when a replacement run lacks one', () => {
  const t = { hosts: 1, hosts_ok: 1, hosts_failed: 0, repos: 5, active: 4, bridgy_active: 0 };
  const prev = { ...row('2026-10-09', 100), third_party: t };
  const merged = A.mergeRuns([prev], row('2026-10-09', 130));
  assert.equal(merged[0].active, 130);
  assert.deepEqual(merged[0].third_party, t);
  const fresh = { ...t, active: 9, repos: 9 };
  assert.deepEqual(A.mergeRuns([prev], { ...row('2026-10-09', 130), third_party: fresh })[0].third_party, fresh, 'a new count wins over the carried one');
  assert.equal('third_party' in A.mergeRuns([row('2026-10-09', 100)], row('2026-10-09', 130))[0], false);
  assert.equal('third_party' in A.mergeRuns([prev], row('2026-10-10', 130))[1], false, 'never carried to another day');
});

test('mergeRuns keeps a newly successful third_party when an incomplete rerun keeps the old row', () => {
  const t = { hosts: 1, hosts_ok: 1, hosts_failed: 0, repos: 5, active: 4, bridgy_active: 0 };
  const merged = A.mergeRuns([row('2026-10-09', 100)], { ...row('2026-10-09', 5, false), third_party: t });
  assert.equal(merged[0].active, 100);
  assert.equal(merged[0].complete, true);
  assert.deepEqual(merged[0].third_party, t);
});

test('validateDataset rejects third-party repos or active when no host finished, and a bad hosts_capped', () => {
  const data = build.parseDataJs(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'bluesky-data.js'), 'utf8'));
  const ok = { hosts: 3, hosts_ok: 2, hosts_failed: 1, repos: 380, active: 350, bridgy_active: 300 };
  const check = (t) => build.validateDataset({ ...data, own_count: { source: 's', net: [], rows: [{ date: '2026-10-08', active: 5, third_party: t }] } });
  assert.ok(check({ hosts: 0, hosts_ok: 0, hosts_failed: 0, repos: 0, active: 0, bridgy_active: 0 }));
  assert.ok(check({ ...ok, hosts_capped: 1 }));
  for (const bad of [{ hosts: 2, hosts_ok: 0, hosts_failed: 2, repos: 100, active: 50, bridgy_active: 0 }, { hosts: 0, hosts_ok: 0, hosts_failed: 0, repos: 100, active: 0, bridgy_active: 0 },
    { ...ok, hosts_capped: -1 }, { ...ok, hosts_capped: 3 }, { ...ok, hosts_capped: 1.5 }]) {
    assert.throws(() => check(bad), /own_count third_party/);
  }
});
