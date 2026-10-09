'use strict';
// Our own count of accounts on Bluesky-operated PDS hosts (scripts/count-accounts.js).
// Jaz's counter only ever adds accounts; a full listRepos pass also sees deactivated,
// taken-down and deleted accounts, so day-over-day change here is net growth. Pure functions.

const net = require('net');

const BSKY_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.host\.bsky\.network$/;
const STATUSES = ['active', 'deactivated', 'takendown', 'suspended', 'deleted', 'other'];
const SCHEMA = 1;
const BRIDGY_HOST = 'atproto.brid.gy';
const THIRD_PARTY_STATUSES = ['active', 'idle'];
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'arpa', 'test', 'invalid', 'example', 'onion'];

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
    if (h && BSKY_HOST.test(h.hostname) && h.status !== 'banned' && h.status !== 'offline') set.add(h.hostname);
  }
  return [...set].sort();
}

function isBlueskyHost(hostname) {
  return BSKY_HOST.test(hostname) || hostname === 'bsky.network' || hostname.endsWith('.bsky.network');
}

// Hostnames come from the network, so only plain public DNS names are ever fetched: lowercase labels,
// at least two of them, no ports, paths, userinfo or IP literals, and no local-only suffixes.
function isSafeHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  const tld = labels[labels.length - 1];
  return !/^[0-9]+$/.test(tld) && !/^[0-9x]/.test(tld) && !LOCAL_SUFFIXES.includes(tld);
}

function privateV4(a, b, c) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

// Eight 16-bit groups of a valid IPv6 literal (net.isIP === 6), with `::` expanded and a dotted tail converted.
function v6Groups(ip) {
  let s = ip.split('%')[0].toLowerCase();
  const tail = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) s = `${tail[1]}${((tail[2] << 8) | tail[3]).toString(16)}:${((tail[4] << 8) | tail[5]).toString(16)}`;
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => parseInt(g, 16));
}

// True for an address that is not safe to fetch from. IPv4 is matched by octets; IPv6 is parsed and only
// global unicast (2000::/3) passes, minus documentation/Teredo/discard, and 6to4, NAT64, IPv4-mapped and
// IPv4-compatible forms are judged by the IPv4 address they embed.
function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return privateV4(a, b, c);
  }
  if (kind !== 6) return true;
  const g = v6Groups(ip);
  const embedded = (hi, lo) => privateV4(hi >> 8, hi & 255, lo >> 8);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return embedded(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && embedded(g[6], g[7]));
  if (g[0] === 0x2002) return embedded(g[1], g[2]);
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
  return (g[0] >> 13) !== 1;
}

// Relay hostnames arrive in any case and may carry a trailing dot; normalise before validating.
function normalizeHostname(h) {
  return typeof h === 'string' ? h.toLowerCase().replace(/\.$/, '') : '';
}

// Third-party hosts: everything the relay lists as active or idle that is not Bluesky-operated.
function selectThirdPartyHosts(relayHosts) {
  const set = new Set();
  for (const h of relayHosts) {
    if (!h) continue;
    const name = normalizeHostname(h.hostname);
    if (THIRD_PARTY_STATUSES.includes(h.status) && isSafeHostname(name) && !isBlueskyHost(name)) set.add(name);
  }
  return [...set].sort();
}

// Contract C. Hosts that failed or ran out of budget are counted as failed and contribute nothing,
// so a partial listing never masquerades as a total. They never affect the Bluesky row's `complete`.
// Several hostnames can front one PDS (eurosky.social and its subdomains list identical repos), so a
// finished host whose full set of DIDs (a hash, `fingerprint`) matches an earlier one is an alias and is
// not counted twice. Different sets are never merged, even with the same size or endpoints. Bridgy is
// always read from atproto.brid.gy itself, which sorts first so it survives as the alias's representative.
// `hosts_capped` appears only when a host hit the per-host account cap and was counted only up to it.
function summariseThirdParty(hostResults) {
  const seen = new Set();
  const byName = (a, b) => (b.host === BRIDGY_HOST) - (a.host === BRIDGY_HOST) || a.host.localeCompare(b.host);
  const ok = hostResults.filter((h) => !h.error).sort(byName).filter((h) => {
    if (!h.fingerprint) return true;
    if (seen.has(h.fingerprint)) return false;
    seen.add(h.fingerprint);
    return true;
  });
  const totals = ok.reduce((acc, h) => addTallies(acc, h.tally), emptyTally());
  const bridgy = hostResults.find((h) => h.host === BRIDGY_HOST && !h.error);
  const capped = ok.filter((h) => h.capped).length;
  return {
    hosts: hostResults.length,
    hosts_ok: hostResults.filter((h) => !h.error).length,
    hosts_failed: hostResults.filter((h) => h.error).length,
    repos: totals.repos,
    active: totals.active,
    bridgy_active: bridgy ? bridgy.tally.active : 0,
    ...(capped ? { hosts_capped: capped } : {}),
  };
}

// Adds a third-party count to the newest row without touching its Bluesky totals.
function attachThirdParty(rows, thirdParty) {
  if (!rows.length) throw new Error('no accounts row to attach the third-party count to');
  return rows.map((r, i) => (i === rows.length - 1 ? { ...r, third_party: thirdParty } : r));
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
  let next = prev && prev.complete && !run.complete ? prev : run;
  // A good same-day third-party count survives a replacement run that lacks one, and a fresh one survives an incomplete rerun.
  if (next === prev && run.third_party) next = { ...prev, third_party: run.third_party };
  else if (next === run && !run.third_party && prev && prev.third_party) next = { ...run, third_party: prev.third_party };
  out.push(next);
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

module.exports = { BSKY_HOST, BRIDGY_HOST, isBlueskyHost, isSafeHostname, normalizeHostname, isPrivateIp, selectThirdPartyHosts, summariseThirdParty, attachThirdParty, STATUSES, emptyTally, tallyRepos, addTallies, selectHosts, summariseRun, mergeRuns, netDaily, serialize, parse };
