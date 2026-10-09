#!/usr/bin/env node
// Counts every account on Bluesky-operated PDS hosts with com.atproto.sync.listRepos and appends
// one row to data/accounts-daily.json. Run daily by .github/workflows/count-accounts.yml.
// ~48k pages (1,000 repos each) spread over ~90 hosts, one request in flight per host; each host
// allows 3,000 requests per 5 minutes, and we back off when its RateLimit-Remaining runs low.
//
// A second pass counts accounts on third-party PDS hosts (everything the relay lists as active or idle
// that Bluesky does not run) for the decentralization meter. It runs beside the Bluesky pass in its own
// pool. Its whole life, including relay discovery, DNS, retry sleeps and requests, sits inside one time
// budget that aborts everything in flight, and every connection resolves through a lookup that refuses
// non-public addresses (so a name that rebinds to a private address after a check cannot be reached).
// The Bluesky row is written to disk before the third-party result is awaited, and the third-party
// count is attached in a second atomic write; its failures never make the row incomplete or lose it.
//
// Env: DATA_DIR (default ./data), CONCURRENCY (hosts in parallel, default 12), HOSTS (comma list,
// skips relay discovery — for testing), THIRD_PARTY_CONCURRENCY (default 24), THIRD_PARTY_BUDGET_MIN
// (default 25), THIRD_PARTY_HOSTS (comma list, skips relay discovery for the third-party pass),
// ONLY_THIRD_PARTY=1 (run just the third-party pass and merge it into the newest row), SKIP_THIRD_PARTY=1.
// A non-integer or sub-1 number in a numeric variable falls back to its default.

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32'; // DNS lookups share this pool with 36 concurrent fetches

const fs = require('fs');
const crypto = require('crypto');
const dnsCb = require('dns');
const https = require('https');
const path = require('path');
const accounts = require('../lib/accounts.js');

const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const RELAY_HOST = 'relay1.us-east.bsky.network';
const RELAY = `https://${RELAY_HOST}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts-daily.json');

function positive(raw, fallback, integer = true) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 1 && (!integer || Number.isInteger(n)) ? n : fallback;
}

const CONCURRENCY = positive(process.env.CONCURRENCY, 12);
const ATTEMPTS = 6;
const TP_CONCURRENCY = positive(process.env.THIRD_PARTY_CONCURRENCY, 24);
const TP_BUDGET_MS = positive(process.env.THIRD_PARTY_BUDGET_MIN, 25, false) * 60e3;
const TP_TIMEOUT_MS = 20e3;
const TP_ATTEMPTS = 3;
const TP_MAX_PAGES = 2000;
const TP_MAX_BYTES = 8 * 1024 * 1024;
const TP_MAX_ACTIVE = 1_000_000; // one untrusted host can add at most this many accounts to the published total
const HOST_PAGE_LIMIT = 50; // listHosts pages (about 2,200 hosts today, 1,000 per page)
const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,512}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sleep that ends early, rejecting, when the signal aborts.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('time budget exhausted'));
    const onAbort = () => { clearTimeout(t); reject(new Error('time budget exhausted')); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function getJson(url) {
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await sleep(Math.min(60e3, 2000 * 2 ** i));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60e3) });
      if (res.status === 429) {
        const reset = Number(res.headers.get('ratelimit-reset'));
        await sleep(reset ? Math.max(1000, reset * 1000 - Date.now()) : 30e3);
        lastErr = new Error('HTTP 429');
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remaining = Number(res.headers.get('ratelimit-remaining'));
      const reset = Number(res.headers.get('ratelimit-reset'));
      if (Number.isFinite(remaining) && remaining < 50 && reset) await sleep(Math.max(0, reset * 1000 - Date.now()));
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Pages com.atproto.sync.listHosts. `getPage(pathAndQuery)` returns parsed JSON. An empty, missing or
// repeated cursor ends the list; more than `maxPages` pages is an error rather than an endless loop.
async function listHosts(getPage, maxPages = HOST_PAGE_LIMIT) {
  const hosts = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`more than ${maxPages} listHosts pages`);
    const d = await getPage(`/xrpc/com.atproto.sync.listHosts?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!d || !Array.isArray(d.hosts)) throw new Error('unexpected listHosts response');
    hosts.push(...d.hosts);
    if (!d.hosts.length || typeof d.cursor !== 'string' || !d.cursor || seen.has(d.cursor)) break;
    seen.add(d.cursor);
    cursor = d.cursor;
  }
  return hosts;
}

const relayHosts = () => listHosts((p) => getJson(RELAY + p));

async function countHost(host) {
  const tally = accounts.emptyTally();
  let cursor;
  try {
    do {
      const d = await getJson(`https://${host}/xrpc/com.atproto.sync.listRepos?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      accounts.tallyRepos(d.repos || [], tally);
      cursor = d.repos && d.repos.length ? d.cursor : null;
    } while (cursor);
    return { host, tally };
  } catch (err) {
    return { host, tally, error: err.message };
  }
}

const expired = (deadline) => (deadline.now ? deadline.now() : Date.now()) >= deadline.at;

function makeDeadline(budgetMs, now = Date.now) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  return { at: now() + budgetMs, signal: ctl.signal, now, clear: () => clearTimeout(timer) };
}

// dns.lookup replacement for the connection itself: resolve, refuse if any address is non-public, and
// hand back exactly the addresses that were checked. Runs for every new connection, so a name that
// answers differently on a later lookup (DNS rebinding) is refused at connect time.
function guardedLookup(resolve = dnsCb.lookup) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    resolve(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length || addrs.some((a) => accounts.isPrivateIp(a.address))) {
        return cb(Object.assign(new Error('resolves to a non-public address'), { code: 'ENONPUBLIC' }));
      }
      return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

const GUARDED = guardedLookup();

// One GET over node:https to a host named by the network: guarded DNS, no redirects followed (a 3xx is
// returned as a status), response size capped, and the request, DNS and body all end when the signal aborts.
// `io` lets tests swap transport, port, lookup and timeout.
function tpGet(host, pathQuery, deadline, io = {}) {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.any([AbortSignal.timeout(io.timeoutMs || TP_TIMEOUT_MS), deadline.signal]);
    const req = (io.transport || https).request({
      hostname: host, port: io.port, path: pathQuery, method: 'GET', agent: false, signal,
      ALPNProtocols: ['http/1.1'], // without ALPN some WAF-fronted hosts answer 403 (fetch sends it)
      lookup: io.lookup || GUARDED,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > TP_MAX_BYTES) { reject(Object.assign(new Error('response too large'), { fatal: true })); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
      res.on('close', () => reject(new Error('connection closed')));
    });
    req.on('error', reject);
    req.end();
  });
}

async function getJsonBounded(host, pathQuery, deadline, io = {}) {
  let lastErr;
  for (let i = 0; i < TP_ATTEMPTS; i++) {
    if (expired(deadline)) throw new Error('time budget exhausted');
    try {
      if (i) await abortableSleep(1000 * 2 ** i, deadline.signal);
      const res = await tpGet(host, pathQuery, deadline, io);
      if (res.status === 429) {
        await abortableSleep(Math.min(10e3, Math.max(1000, Number(res.headers['ratelimit-reset']) * 1000 - Date.now() || 5000)), deadline.signal);
        throw new Error('HTTP 429');
      }
      if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: res.status >= 300 && res.status < 400 });
      return JSON.parse(res.body.toString('utf8'));
    } catch (err) {
      if (deadline.signal.aborted || expired(deadline)) throw new Error('time budget exhausted');
      if (err.code === 'ENONPUBLIC' || err.fatal) throw err; // retrying cannot help
      lastErr = err;
    }
  }
  throw lastErr;
}

// Pages one third-party host's listRepos. Only well-formed, not-yet-seen DIDs count, one host adds at most
// TP_MAX_ACTIVE active accounts (`capped`), and `fingerprint` hashes the full DID set so aliases can be told apart.
async function countThirdPartyHost(host, deadline, getPage = getJsonBounded) {
  const tally = accounts.emptyTally();
  const dids = new Set();
  const cursors = new Set();
  let capped = false;
  try {
    let cursor;
    for (let page = 0; !capped; page++) {
      if (page >= TP_MAX_PAGES) throw new Error(`more than ${TP_MAX_PAGES} pages`);
      const d = await getPage(host, `/xrpc/com.atproto.sync.listRepos?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, deadline);
      if (!d || !Array.isArray(d.repos)) throw new Error('unexpected response');
      for (const r of d.repos) {
        const did = r && r.did;
        if (typeof did !== 'string' || !DID_RE.test(did) || dids.has(did)) continue;
        dids.add(did);
        accounts.tallyRepos([r], tally);
        if (tally.active >= TP_MAX_ACTIVE) { capped = true; break; }
      }
      if (!d.repos.length || typeof d.cursor !== 'string' || !d.cursor || cursors.has(d.cursor)) break;
      cursors.add(d.cursor);
      cursor = d.cursor;
    }
    const fingerprint = dids.size ? crypto.createHash('sha256').update([...dids].sort().join('\n')).digest('hex') : '';
    return { host, tally, fingerprint, ...(capped ? { capped } : {}) };
  } catch (err) {
    return { host, tally: accounts.emptyTally(), error: err.message || String(err) };
  }
}

async function countThirdParty(hosts, deadline, { concurrency = TP_CONCURRENCY, countOne = countThirdPartyHost } = {}) {
  console.log(`third-party pass: ${hosts.length} hosts, ${concurrency} at a time, ${Math.round((deadline.at - (deadline.now || Date.now)()) / 6e3) / 10} min budget`);
  const queue = [...hosts];
  const results = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const host = queue.shift();
      const r = expired(deadline) ? { host, tally: accounts.emptyTally(), error: 'time budget exhausted' } : await countOne(host, deadline);
      results.push(r);
      if (r.capped) console.log(`${r.host}: CAPPED at ${r.tally.active} active accounts`);
      if (r.error ? results.length % 100 === 0 : r.tally.repos > 10000) console.log(`${r.host}: ${r.error ? `FAILED (${r.error})` : `${r.tally.active} active / ${r.tally.repos} repos`}`);
    }
  }));
  const summary = accounts.summariseThirdParty(results);
  const reasons = {};
  for (const r of results.filter((x) => x.error)) {
    const reason = r.error.replace(/(ENOTFOUND|EAI_AGAIN) .*/, '$1').replace(/[0-9]+/g, 'N').slice(0, 40);
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  console.log('third-party failures by reason:', JSON.stringify(reasons));
  console.log(`third-party: ${summary.hosts_ok}/${summary.hosts} hosts ok, ${summary.hosts_failed} failed, ${summary.active} active of ${summary.repos} repos, bridgy ${summary.bridgy_active}`);
  return summary;
}

// The whole pass, relay discovery included, lives inside one deadline. Returns null on any failure.
async function thirdPartyPass({ env = process.env, budgetMs = TP_BUDGET_MS, concurrency = TP_CONCURRENCY, getRelayPage, countOne } = {}) {
  const started = Date.now();
  const deadline = makeDeadline(budgetMs);
  try {
    const hosts = env.THIRD_PARTY_HOSTS
      ? env.THIRD_PARTY_HOSTS.split(',').map(accounts.normalizeHostname)
      : accounts.selectThirdPartyHosts(await listHosts(getRelayPage || ((p) => getJsonBounded(RELAY_HOST, p, deadline))));
    const summary = await countThirdParty(hosts.filter(accounts.isSafeHostname), deadline, { concurrency, ...(countOne ? { countOne } : {}) });
    console.log(`third-party pass took ${Math.round((Date.now() - started) / 1000)}s`);
    return summary;
  } catch (err) {
    console.error(`third-party pass failed: ${err.message}`);
    return null;
  } finally {
    deadline.clear();
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function main({ file = FILE, env = process.env, relay = relayHosts, countOne = countHost, thirdParty: thirdPartyFn = thirdPartyPass } = {}) {
  const rows = fs.existsSync(file) ? accounts.parse(fs.readFileSync(file, 'utf8')) : [];
  if (env.ONLY_THIRD_PARTY) {
    const tp = await thirdPartyFn();
    if (!tp) { process.exitCode = 1; return; }
    writeAtomic(file, accounts.serialize(accounts.attachThirdParty(rows, tp)));
    return;
  }
  const lastComplete = rows.filter((r) => r.complete).at(-1);
  const hosts = env.HOSTS
    ? env.HOSTS.split(',')
    : accounts.selectHosts(await relay(), lastComplete ? lastComplete.host_list || [] : []);
  console.log(`counting ${hosts.length} hosts, ${CONCURRENCY} at a time`);

  const startedAt = new Date().toISOString();
  const thirdParty = env.SKIP_THIRD_PARTY ? Promise.resolve(null) : thirdPartyFn();
  const queue = [...hosts];
  const results = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const r = await countOne(queue.shift());
      results.push(r);
      console.log(`${r.host}: ${r.error ? `FAILED (${r.error})` : `${r.tally.active} active / ${r.tally.repos} repos`}`);
    }
  }));
  const run = { ...accounts.summariseRun({ startedAt, finishedAt: new Date().toISOString(), hostResults: results }), host_list: hosts };

  // Save the Bluesky count first: nothing the third-party pass does may lose it.
  writeAtomic(file, accounts.serialize(accounts.mergeRuns(rows, run)));
  console.log(`${run.complete ? 'complete' : `INCOMPLETE (${run.hosts_failed.join(', ')})`}: ${run.active} active of ${run.repos} repos`);
  if (!run.complete) process.exitCode = 1;

  const tp = await thirdParty;
  if (tp) writeAtomic(file, accounts.serialize(accounts.mergeRuns(rows, { ...run, third_party: tp })));
}

module.exports = { main, listHosts, countThirdPartyHost, countThirdParty, thirdPartyPass, getJsonBounded, tpGet, guardedLookup, abortableSleep, makeDeadline, positive, TP_MAX_ACTIVE };

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
