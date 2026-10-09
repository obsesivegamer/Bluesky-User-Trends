'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dns = require('dns');
const A = require('../lib/accounts.js');
const C = require('../scripts/count-accounts.js');

const did = (n) => `did:plc:${String(n).padStart(8, '0')}`;
const repos = (from, count, extra = {}) => Array.from({ length: count }, (_, i) => ({ did: did(from + i), ...extra }));
const farDeadline = () => ({ at: Date.now() + 60e3, signal: new AbortController().signal });
// getPage stub: replies from a list and records the requested paths.
function pager(pages) {
  const calls = [];
  const fn = async (host, p) => { calls.push(p); const r = pages[calls.length - 1]; if (!r) throw new Error('unexpected extra request'); return r; };
  fn.calls = calls;
  return fn;
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'count-accounts-'));
const completeRow = (extra = {}) => ({ date: '2026-10-09', started_at: '2026-10-09T02:00:00Z', finished_at: '2026-10-09T02:10:00Z', complete: true, hosts: 1, hosts_failed: [], repos: 10, active: 9, deactivated: 1, takendown: 0, suspended: 0, deleted: 0, other: 0, host_list: ['h.us-east.host.bsky.network'], ...extra });
const TP = { hosts: 3, hosts_ok: 2, hosts_failed: 1, repos: 380, active: 350, bridgy_active: 300 };

test('per-host loop: a terminal cursor of "" ends a one-page host with one fetch (no double count)', async () => {
  const getPage = pager([{ repos: repos(1, 2), cursor: '' }]);
  const r = await C.countThirdPartyHost('pds.example.com', farDeadline(), getPage);
  assert.equal(r.error, undefined);
  assert.equal(getPage.calls.length, 1);
  assert.deepEqual([r.tally.repos, r.tally.active], [2, 2]);
});

test('per-host loop: a final page with cursor "" keeps the whole multi-page host (no restart, no failure)', async () => {
  const getPage = pager([{ repos: repos(1, 1000), cursor: 'c1' }, { repos: repos(1001, 1), cursor: '' }]);
  const r = await C.countThirdPartyHost('pds.example.com', farDeadline(), getPage);
  assert.equal(r.error, undefined);
  assert.equal(getPage.calls.length, 2);
  assert.match(getPage.calls[1], /cursor=c1/);
  assert.equal(r.tally.repos, 1001);
});

test('per-host loop: a missing or null cursor also ends the host; a repeated cursor stops it', async () => {
  for (const last of [{}, { cursor: null }]) {
    const getPage = pager([{ repos: repos(1, 2), ...last }]);
    assert.equal((await C.countThirdPartyHost('pds.example.com', farDeadline(), getPage)).tally.repos, 2);
    assert.equal(getPage.calls.length, 1);
  }
  const stuck = pager([{ repos: repos(1, 2), cursor: 'x' }, { repos: repos(3, 2), cursor: 'x' }, { repos: repos(5, 2), cursor: 'y' }]);
  const r = await C.countThirdPartyHost('pds.example.com', farDeadline(), stuck);
  assert.equal(stuck.calls.length, 2);
  assert.equal(r.tally.repos, 4);
});

test('per-host loop ignores missing, malformed and duplicate DIDs', async () => {
  const getPage = pager([{ repos: [{}, null, { did: 5 }, { did: 'nope' }, { did: did(1) }, { did: did(1) }, { did: did(2), active: false, status: 'deactivated' }, { did: `did:plc:${'x'.repeat(600)}` }] }]);
  const r = await C.countThirdPartyHost('pds.example.com', farDeadline(), getPage);
  assert.deepEqual([r.tally.repos, r.tally.active, r.tally.deactivated], [2, 1, 1]);
});

test('per-host loop caps one host at TP_MAX_ACTIVE active accounts and says so', async () => {
  let page = 0;
  const getPage = async () => { const from = page * 1000; page++; return { repos: repos(from, 1000), cursor: `c${page}` }; };
  const r = await C.countThirdPartyHost('big.example.com', farDeadline(), getPage);
  assert.equal(r.error, undefined);
  assert.equal(r.capped, true);
  assert.equal(r.tally.active, C.TP_MAX_ACTIVE);
  assert.equal(page, C.TP_MAX_ACTIVE / 1000, 'stops fetching once capped');
});

test('per-host loop: failures report the error and contribute nothing; fingerprint hashes the full DID set regardless of order', async () => {
  const bad = await C.countThirdPartyHost('x.example.com', farDeadline(), async () => ({ nope: 1 }));
  assert.equal(bad.error, 'unexpected response');
  assert.equal(bad.tally.repos, 0);
  const fp = async (list) => (await C.countThirdPartyHost('x.example.com', farDeadline(), pager([{ repos: list }]))).fingerprint;
  const a = await fp([{ did: did(1) }, { did: did(5) }, { did: did(9) }]);
  assert.equal(a, await fp([{ did: did(9) }, { did: did(1) }, { did: did(5) }]));
  assert.notEqual(a, await fp([{ did: did(1) }, { did: did(6) }, { did: did(9) }]), 'same endpoints and size, different middle');
  assert.equal(await fp([]), '');
});

test('listHosts: a terminal "" or repeated cursor ends the list; endless distinct cursors throw at the page limit', async () => {
  let n = 0;
  const hostPage = (cursor) => async () => ({ hosts: [{ hostname: `h${n++}.example.com` }], cursor });
  assert.equal((await C.listHosts(hostPage(''))).length, 1);
  n = 0;
  assert.equal((await C.listHosts(hostPage('stuck'))).length, 2, 'second page repeats the cursor, so it stops there');
  let k = 0;
  await assert.rejects(C.listHosts(async () => ({ hosts: [{ hostname: 'a.example.com' }], cursor: `c${k++}` }), 5), /more than 5 listHosts pages/);
  await assert.rejects(C.listHosts(async () => ({ nope: 1 })), /unexpected/);
});

test('positive(): invalid, zero, fractional or empty env falls back to the default', () => {
  for (const raw of [undefined, '', '0', '-3', 'abc', '2.5', 'NaN', 'Infinity']) assert.equal(C.positive(raw, 24), 24, String(raw));
  assert.equal(C.positive('7', 24), 7);
  assert.equal(C.positive('0.5', 25, false), 25);
  assert.equal(C.positive('1.5', 25, false), 1.5);
});

test('abortableSleep resolves after the delay and rejects as soon as the signal aborts', async () => {
  const ctl = new AbortController();
  await C.abortableSleep(5, ctl.signal);
  const started = Date.now();
  const p = C.abortableSleep(30e3, ctl.signal);
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, /time budget exhausted/);
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(C.abortableSleep(10, ctl.signal), /time budget exhausted/);
});

const v4 = (address) => ({ address, family: 4 });
const callLookup = (lookup, opts = {}) => new Promise((resolve) => lookup('a.example.com', opts, (err, a, f) => resolve({ err, a, f })));

test('guardedLookup refuses non-public answers on every lookup and hands back exactly the checked addresses', async () => {
  const answers = [[v4('1.1.1.1')], [v4('127.0.0.1')], [v4('1.1.1.1'), v4('169.254.169.254')], []];
  let calls = 0;
  const lookup = C.guardedLookup((host, opts, cb) => cb(null, answers[calls++]));
  assert.deepEqual((await callLookup(lookup, { all: true })).a, [v4('1.1.1.1')], 'public answer, array form');
  assert.equal((await callLookup(lookup)).err.code, 'ENONPUBLIC', 'rebound to loopback on the second lookup');
  assert.equal((await callLookup(lookup)).err.code, 'ENONPUBLIC', 'one private address among public ones');
  assert.equal((await callLookup(lookup)).err.code, 'ENONPUBLIC', 'no addresses');
  assert.equal(calls, 4, 'resolves again every time');
  const single = await callLookup(C.guardedLookup((h, o, cb) => cb(null, [v4('8.8.8.8')])));
  assert.deepEqual([single.a, single.f], ['8.8.8.8', 4], 'single-address form');
  const failing = await callLookup(C.guardedLookup((h, o, cb) => cb(new Error('ENOTFOUND x'))));
  assert.match(failing.err.message, /ENOTFOUND/);
});

async function withServer(handler, fn) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn({ port: server.address().port, hits }); } finally { server.closeAllConnections(); server.close(); }
}
const plainLookup = (host, opts, cb) => dns.lookup('127.0.0.1', opts, cb);

test('tpGet connects through the guarded lookup: a private answer never reaches the server', async () => {
  await withServer((req, res) => res.end('{}'), async ({ port, hits }) => {
    const g = C.guardedLookup((h, o, cb) => cb(null, [v4('127.0.0.1')]));
    await assert.rejects(C.getJsonBounded('rebind.example.net', '/x', farDeadline(), { transport: http, port, lookup: g }), /non-public/);
    assert.equal(hits.length, 0);
  });
});

test('tpGet returns JSON, does not follow redirects, and refuses oversized bodies', async () => {
  await withServer((req, res) => {
    if (req.url === '/ok') res.end('{"repos":[]}');
    else if (req.url === '/redir') { res.writeHead(302, { Location: '/ok' }); res.end(); }
    else { res.write(Buffer.alloc(9 * 1024 * 1024)); res.end(); }
  }, async ({ port, hits }) => {
    const io = { transport: http, port, lookup: plainLookup };
    assert.deepEqual(await C.getJsonBounded('pds.example.com', '/ok', farDeadline(), io), { repos: [] });
    await assert.rejects(C.getJsonBounded('pds.example.com', '/redir', farDeadline(), io), /HTTP 302/);
    assert.equal(hits.filter((u) => u === '/ok').length, 1, 'redirect target was never requested');
    await assert.rejects(C.getJsonBounded('pds.example.com', '/big', farDeadline(), io), /too large/);
  });
});

test('a DNS lookup that never answers is cut off by the deadline', async () => {
  const deadline = C.makeDeadline(150);
  const started = Date.now();
  await assert.rejects(C.getJsonBounded('hang.example.com', '/x', deadline, { lookup: () => {} }), /time budget exhausted/);
  deadline.clear();
  assert.ok(Date.now() - started < 3000);
});

test('a 429 retry sleep is cut off by the deadline', async () => {
  await withServer((req, res) => { res.writeHead(429, { 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300) }); res.end(); }, async ({ port }) => {
    const deadline = C.makeDeadline(200);
    const started = Date.now();
    await assert.rejects(C.getJsonBounded('pds.example.com', '/x', deadline, { transport: http, port, lookup: plainLookup }), /time budget exhausted/);
    deadline.clear();
    assert.ok(Date.now() - started < 3000);
  });
});

test('a deadline already past stops the pass without any request', async () => {
  let called = 0;
  const gone = { at: 0, signal: new AbortController().signal, now: () => 5 };
  await assert.rejects(C.getJsonBounded('pds.example.com', '/x', gone, { lookup: () => { called++; } }), /time budget exhausted/);
  assert.equal(called, 0);
  const s = await C.countThirdParty(['a.example.com', 'b.example.com'], gone, { concurrency: 2, countOne: async () => { called++; } });
  assert.deepEqual([s.hosts, s.hosts_failed, called], [2, 2, 0]);
});

test('thirdPartyPass normalises the host list, uses at least one worker, and returns null instead of throwing', async () => {
  const seen = [];
  const countOne = async (host) => { seen.push(host); return { host, tally: { ...A.emptyTally(), repos: 3, active: 3 }, fingerprint: host }; };
  const env = { THIRD_PARTY_HOSTS: 'Blacksky.App,pds.example.net.,localhost,127.0.0.1' };
  const s = await C.thirdPartyPass({ env, concurrency: C.positive('0', 24), countOne });
  assert.deepEqual(seen.sort(), ['blacksky.app', 'pds.example.net']);
  assert.deepEqual([s.hosts, s.hosts_ok, s.active], [2, 2, 6]);
  assert.equal(await C.thirdPartyPass({ env: {}, getRelayPage: async () => { throw new Error('relay down'); } }), null);
  const stuck = await C.thirdPartyPass({ env: {}, getRelayPage: async () => ({ hosts: [null, { hostname: 'ok.example.com', status: 'active' }], cursor: 'same' }), countOne });
  assert.equal(stuck.hosts, 1, 'null host entries and a stuck cursor do not fail the pass');
});

test('main writes the Bluesky row before the third-party pass settles, then attaches third_party in a second write', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'accounts-daily.json');
  let release;
  const thirdParty = () => new Promise((r) => { release = r; });
  const countOne = async (host) => ({ host, tally: { ...A.emptyTally(), repos: 10, active: 9, deactivated: 1 } });
  const done = C.main({ file, env: { HOSTS: 'h.us-east.host.bsky.network' }, countOne, thirdParty });
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  const mid = A.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(mid.length, 1);
  assert.equal(mid[0].active, 9);
  assert.equal(mid[0].complete, true);
  assert.equal('third_party' in mid[0], false, 'Bluesky count is on disk while the third-party pass is still running');
  release(TP);
  await done;
  const end = A.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(end[0].third_party, TP);
  assert.equal(end[0].active, 9);
  assert.deepEqual(fs.readdirSync(dir), ['accounts-daily.json'], 'no temp file left behind');
});

test('main: a failed third-party pass still leaves the Bluesky row; a same-day rerun keeps the earlier third_party', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'accounts-daily.json');
  fs.writeFileSync(file, A.serialize([completeRow({ third_party: TP })]));
  const countOne = async (host) => ({ host, tally: { ...A.emptyTally(), repos: 20, active: 18, deactivated: 2 } });
  await C.main({ file, env: { HOSTS: 'h.us-east.host.bsky.network' }, countOne, thirdParty: async () => null });
  const [r] = A.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(r.active, 18);
  assert.deepEqual(r.third_party, TP);
  const fresh = { ...TP, active: 7 };
  const failing = async (host) => ({ host, tally: A.emptyTally(), error: 'HTTP 500' });
  await C.main({ file, env: { HOSTS: 'h.us-east.host.bsky.network' }, countOne: failing, thirdParty: async () => fresh });
  process.exitCode = 0; // the incomplete rerun sets it on purpose
  const [kept] = A.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.active, 18, 'incomplete rerun keeps the old Bluesky numbers');
  assert.deepEqual(kept.third_party, fresh, 'but takes the new third-party count');
});

test('main with ONLY_THIRD_PARTY attaches to the newest row and leaves the Bluesky numbers alone; a failed pass writes nothing', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'accounts-daily.json');
  fs.writeFileSync(file, A.serialize([completeRow()]));
  const before = fs.readFileSync(file, 'utf8');
  await C.main({ file, env: { ONLY_THIRD_PARTY: '1' }, thirdParty: async () => null });
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await C.main({ file, env: { ONLY_THIRD_PARTY: '1' }, thirdParty: async () => TP });
  const [r] = A.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([r.active, r.third_party], [9, TP]);
});
