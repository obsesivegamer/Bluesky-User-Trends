'use strict';
// Our own count of accounts on Bluesky-operated PDS hosts (scripts/count-accounts.js).
// Jaz's counter only ever adds accounts; a full listRepos pass also sees deactivated,
// taken-down and deleted accounts, so day-over-day change here is net growth. Pure functions.

const BSKY_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.host\.bsky\.network$/;
const STATUSES = ['active', 'deactivated', 'takendown', 'suspended', 'deleted', 'other'];
const SCHEMA = 1;

function emptyTally() {
  return Object.fromEntries(['repos', ...STATUSES].map((k) => [k, 0]));
}

// One listRepos page -> per-status counts. `active` absent on old PDS versions means active.
function tallyRepos(repos, into = emptyTally()) {
  for (const r of repos) {
    into.repos++;
    if (r.active !== false) into.active++;
    else if (STATUSES.includes(r.status) && r.status !== 'active') into[r.status]++;
    else into.other++;
  }
  return into;
}

function addTallies(a, b) {
  const out = emptyTally();
  for (const k of Object.keys(out)) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

// Hosts to scan: Bluesky-operated hosts the relay lists as active, plus any host a previous
// complete run counted (so a relay hiccup can't silently shrink the total).
function selectHosts(relayHosts, previousHosts = []) {
  const set = new Set(previousHosts.filter((h) => BSKY_HOST.test(h)));
  for (const h of relayHosts) {
    if (BSKY_HOST.test(h.hostname) && h.status !== 'banned' && h.status !== 'offline') set.add(h.hostname);
  }
  return [...set].sort();
}

// A run is comparable day to day only if every host finished.
function summariseRun({ startedAt, finishedAt, hostResults }) {
  const failed = hostResults.filter((h) => h.error).map((h) => h.host);
  const totals = hostResults.filter((h) => !h.error).reduce((acc, h) => addTallies(acc, h.tally), emptyTally());
  return {
    date: finishedAt.slice(0, 10),
    started_at: startedAt,
    finished_at: finishedAt,
    complete: failed.length === 0,
    hosts: hostResults.length,
    hosts_failed: failed,
    ...totals,
  };
}

// One row per UTC date; a later complete run replaces an earlier or incomplete one, never the reverse.
function mergeRuns(rows, run) {
  const out = rows.filter((r) => r.date !== run.date);
  const prev = rows.find((r) => r.date === run.date);
  out.push(prev && prev.complete && !run.complete ? prev : run);
  out.sort((a, b) => a.date.localeCompare(b.date));
  // Only the newest complete row keeps its host list (it seeds the next run's host set).
  const keep = out.filter((r) => r.complete).at(-1);
  return out.map((r) => (r === keep || !('host_list' in r) ? r : (({ host_list, ...rest }) => rest)(r)));
}

// Net change between consecutive complete rows, normalised to 24h because runs drift in time.
function netDaily(rows) {
  const complete = rows.filter((r) => r.complete);
  const out = [];
  for (let i = 1; i < complete.length; i++) {
    const a = complete[i - 1];
    const b = complete[i];
    const hours = (Date.parse(b.finished_at) - Date.parse(a.finished_at)) / 3600e3;
    if (!(hours > 0) || hours > 72) continue;
    out.push({ date: b.date, net_active: Math.round(((b.active - a.active) * 24) / hours) });
  }
  return out;
}

function serialize(rows) {
  const body = rows.map((r) => '  ' + JSON.stringify(r)).join(',\n');
  return `{"schema":${SCHEMA},"source":"com.atproto.sync.listRepos on Bluesky-operated PDS hosts","rows":[\n${body}\n]}\n`;
}

function parse(text) {
  const d = JSON.parse(text);
  if (d.schema !== SCHEMA || !Array.isArray(d.rows)) throw new Error('accounts file: unexpected schema');
  return d.rows;
}

module.exports = { BSKY_HOST, STATUSES, emptyTally, tallyRepos, addTallies, selectHosts, summariseRun, mergeRuns, netDaily, serialize, parse };
