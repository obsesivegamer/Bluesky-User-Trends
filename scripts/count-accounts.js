#!/usr/bin/env node
// Counts every account on Bluesky-operated PDS hosts with com.atproto.sync.listRepos and appends
// one row to data/accounts-daily.json. Run daily by .github/workflows/count-accounts.yml.
// ~48k pages (1,000 repos each) spread over ~90 hosts, one request in flight per host; each host
// allows 3,000 requests per 5 minutes, and we back off when its RateLimit-Remaining runs low.
//
// Env: DATA_DIR (default ./data), CONCURRENCY (hosts in parallel, default 12), HOSTS (comma list,
// skips relay discovery — for testing).

const fs = require('fs');
const path = require('path');
const accounts = require('../lib/accounts.js');

const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const RELAY = 'https://relay1.us-east.bsky.network';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts-daily.json');
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const ATTEMPTS = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function relayHosts() {
  const hosts = [];
  let cursor;
  do {
    const d = await getJson(`${RELAY}/xrpc/com.atproto.sync.listHosts?limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
    hosts.push(...d.hosts);
    cursor = d.hosts.length ? d.cursor : null;
  } while (cursor);
  return hosts;
}

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

async function main() {
  const rows = fs.existsSync(FILE) ? accounts.parse(fs.readFileSync(FILE, 'utf8')) : [];
  const lastComplete = rows.filter((r) => r.complete).at(-1);
  const hosts = process.env.HOSTS
    ? process.env.HOSTS.split(',')
    : accounts.selectHosts(await relayHosts(), lastComplete ? lastComplete.host_list || [] : []);
  console.log(`counting ${hosts.length} hosts, ${CONCURRENCY} at a time`);

  const startedAt = new Date().toISOString();
  const queue = [...hosts];
  const results = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const r = await countHost(queue.shift());
      results.push(r);
      console.log(`${r.host}: ${r.error ? `FAILED (${r.error})` : `${r.tally.active} active / ${r.tally.repos} repos`}`);
    }
  }));
  const run = { ...accounts.summariseRun({ startedAt, finishedAt: new Date().toISOString(), hostResults: results }), host_list: hosts };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, accounts.serialize(accounts.mergeRuns(rows, run)));
  console.log(`${run.complete ? 'complete' : `INCOMPLETE (${run.hosts_failed.join(', ')})`}: ${run.active} active of ${run.repos} repos`);
  if (!run.complete) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
