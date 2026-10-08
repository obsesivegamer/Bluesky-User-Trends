'use strict';
// Normalises Jaz's bsky-search.jazco.io/stats response and flags unreliable activity values.
// Pure functions only: no I/O, no clock.

const ACTIVITY_START = '2023-03-01';
const COLLECTION_START = '2023-05-01';

const ACTOR_METRICS = ['likers', 'posters', 'followers', 'blockers'];
const RECORD_METRICS = ['posts', 'likes', 'follows', 'blocks'];
const METRICS = [...ACTOR_METRICS, ...RECORD_METRICS];
const RECORD_OF = { likers: 'likes', posters: 'posts', followers: 'follows', blockers: 'blocks' };
const ACTOR_OF = Object.fromEntries(Object.entries(RECORD_OF).map(([a, r]) => [r, a]));
const BLOCK_METRICS = ['blockers', 'blocks'];

// Collection problems confirmed against Kuba Suder's independent firehose stats
// (blue.mackuba.eu/stats) and Jaz's repair notes. Values are kept raw but flagged.
// `key`/`seenMax`: the largest value of `key` in the window when the outage was confirmed. An entry
// holds only while the API still returns that (up to REPAIR_TOLERANCE more): Jaz rewrites history
// (the April 2026 repair), and a repaired day must not stay hidden. The rolling rule below still
// flags a "repair" that is still a collapse.
const KNOWN_OUTAGES = [
  { from: '2024-08-31', to: '2024-08-31', metrics: METRICS, key: 'posters', seenMax: 530985, note: 'partial day as the Brazil X-ban surge began (530,985 posters vs 808,668 at mackuba)' },
  { from: '2024-09-01', to: '2024-09-06', metrics: METRICS, key: 'posters', seenMax: 246040, note: 'collection outage during the Brazil surge (77–1,427 posters a day vs 913K–995K at mackuba)' },
  { from: '2024-09-07', to: '2024-09-07', metrics: METRICS, key: 'posters', seenMax: 713601, note: 'partial day after the outage (713,601 posters vs 816,680 at mackuba; 3.35M posts vs 4.30M)' },
  { from: '2024-09-10', to: '2024-09-10', metrics: METRICS, key: 'posters', seenMax: 741747, note: 'partial day (741,747 posters vs 845,631 at mackuba; 3.54M posts vs 4.60M)' },
  { from: '2024-10-23', to: '2024-10-23', metrics: ['likers', 'likes'], key: 'likers', seenMax: 431787, note: 'likes only: 431,787 likers vs about 1M either side' },
  { from: '2025-04-22', to: '2025-04-22', metrics: METRICS, key: 'posters', seenMax: 384292, note: 'partial day (384,292 posters vs 816,279 at mackuba)' },
  { from: '2025-05-20', to: '2025-05-20', metrics: ['likers', 'likes'], key: 'likers', seenMax: 4, note: 'likes pipeline broken: 4 likers, 55 likes' },
  { from: '2025-09-19', to: '2025-12-19', metrics: BLOCK_METRICS, key: 'blocks', seenMax: 4, note: 'blocks not collected (0–4 a day)' },
  { from: '2026-04-13', to: '2026-04-14', metrics: METRICS, key: 'posters', seenMax: 199216, note: "indexer offline; 04-14 is a 'real hole' past Jetstream's replay buffer per Jaz's repair script" },
  { from: '2026-04-15', to: '2026-04-15', metrics: METRICS, key: 'posters', seenMax: 575109, note: 'partial day as the indexer came back (575,109 posters vs 616,066 at mackuba; 3.14M posts vs 3.58M)' },
];
const REPAIR_TOLERANCE = 1.05;

// Dips the rolling rule would flag but an independent indexer saw too: real firehose activity,
// not a jazco collection problem. mackuba's posters and posts match jazco within 0.7% here.
const VERIFIED_DIPS = [
  { from: '2024-10-10', to: '2024-10-16', metrics: METRICS, note: 'firehose-wide lull before the Oct 17 X block-policy wave; mackuba agrees' },
];

const WINDOW_DAYS = 14;
const MIN_REFERENCE_DAYS = 5;
const DIP_RATIO = 0.5;
const RECORD_COLLAPSE_RATIO = 0.1;
const BLOCKS_FLOOR = 10;

const DAY_MS = 86400e3;
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d) => typeof d === 'string' && DATE_RE.test(d) && addDays(d, 0) === d;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

function todayUtc(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// raw: parsed /stats JSON. today: 'YYYY-MM-DD' (UTC) — that day and anything later is dropped
// (today is partial; future-dated rows come from client clocks running ahead).
function normalizeStats(raw, { today }) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.daily_data)) {
    throw new Error('jazco /stats: missing daily_data array');
  }
  const counts = { input: raw.daily_data.length, today: 0, future: 0, beforeStart: 0, invalid: 0, duplicate: 0 };
  const byDate = new Map();
  for (const r of raw.daily_data) {
    if (!r || !validDate(r.date)) {
      counts.invalid++;
      continue;
    }
    if (r.date === today) {
      counts.today++;
      continue;
    }
    if (r.date > today) {
      counts.future++;
      continue;
    }
    if (r.date < ACTIVITY_START) {
      counts.beforeStart++;
      continue;
    }
    const row = { date: r.date };
    let ok = true;
    for (const m of METRICS) {
      const v = r['num_' + m];
      if (!isCount(v)) ok = false;
      row[m] = v;
    }
    if (!ok) {
      counts.invalid++;
      continue;
    }
    if (byDate.has(r.date)) {
      counts.duplicate++;
      continue;
    }
    byDate.set(r.date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { snapshot: normalizeSnapshot(raw), rows, counts };
}

function normalizeSnapshot(raw) {
  const ts = Date.parse(raw.updated_at);
  if (!Number.isSafeInteger(raw.total_users) || raw.total_users <= 0 || !Number.isFinite(ts)) return null;
  const pick = (v) => (isCount(v) ? v : null);
  return {
    total_users: raw.total_users,
    updated_at: raw.updated_at,
    total_posts: pick(raw.total_posts),
    total_likes: pick(raw.total_likes),
    total_follows: pick(raw.total_follows),
    source: 'bsky-search.jazco.io/stats',
  };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function knownOutage(row, metric) {
  return KNOWN_OUTAGES.some((o) => row.date >= o.from && row.date <= o.to && o.metrics.includes(metric) &&
    !(isCount(row[o.key]) && row[o.key] > o.seenMax * REPAIR_TOLERANCE));
}

// rows: ascending [{date, likers, ...}] (gaps allowed). Returns new rows with `flags` (metric
// keys whose value is unreliable that day). Rules, in order:
//   1. KNOWN_OUTAGES table, while the API still returns the broken value it was confirmed on.
//   2. Blocks floor: blocks/blockers at or below 10 a day cannot be real after launch (the
//      Sep–Dec 2025 gap shows 0–4; early 2023 reports a constant 3 blockers).
//   3. Rolling dip rule for the distinct-actor series (stable day to day): value below 50% of the
//      centred ±14-day median AND below 50% of both one-sided 14-day medians. The one-sided test
//      keeps genuine step changes (waves) from being flagged; at the newest edge only the
//      trailing median exists, which catches a partial latest day.
//   4. Record series are bursty (mass follows / mass blocks): the same test at 50% applies only
//      when their actor series was flagged that day (an outage drops both); otherwise they are
//      flagged only when they collapse below 10% of both one-sided medians.
// Rules 3–4 skip VERIFIED_DIPS. Reference medians ignore values already flagged by rules 1–2.
function flagActivity(rows) {
  const out = rows.map((r) => ({ ...r, flags: [] }));
  if (!out.length) return out;
  const index = new Map(out.map((r, i) => [r.date, i]));
  const hard = new Map(METRICS.map((m) => [m, new Set()]));
  for (const r of out) {
    for (const m of METRICS) {
      if (r[m] === null || r[m] === undefined) continue;
      if (knownOutage(r, m)) hard.get(m).add(r.date);
      if (BLOCK_METRICS.includes(m) && r[m] <= BLOCKS_FLOOR) hard.get(m).add(r.date);
    }
  }

  const reference = (m, date, from, to) => {
    const vals = [];
    for (let k = from; k <= to; k++) {
      const d = addDays(date, k);
      const i = index.get(d);
      if (i === undefined || k === 0) continue;
      const v = out[i][m];
      if (v === null || v === undefined || hard.get(m).has(d)) continue;
      vals.push(v);
    }
    return vals;
  };

  // True when v sits below `ratio` of both one-sided medians (and half the centred one).
  const dips = (m, r, ratio) => {
    const v = r[m];
    const before = reference(m, r.date, -WINDOW_DAYS, -1);
    const after = reference(m, r.date, 1, WINDOW_DAYS);
    const mb = before.length >= MIN_REFERENCE_DAYS ? median(before) : null;
    const ma = after.length >= MIN_REFERENCE_DAYS ? median(after) : null;
    if (mb === null && ma === null) return false;
    const below = (ref) => ref === null || v < ratio * ref;
    return v < DIP_RATIO * median([...before, v, ...after]) && below(mb) && below(ma);
  };
  const usable = (m, r) => r[m] !== null && r[m] !== undefined && !hard.get(m).has(r.date);

  const soft = new Map(METRICS.map((m) => [m, new Set()]));
  for (const r of out) {
    if (VERIFIED_DIPS.some((w) => r.date >= w.from && r.date <= w.to)) continue;
    for (const m of ACTOR_METRICS) {
      if (usable(m, r) && dips(m, r, DIP_RATIO)) soft.get(m).add(r.date);
    }
    for (const m of RECORD_METRICS) {
      if (!usable(m, r)) continue;
      const ratio = soft.get(ACTOR_OF[m]).has(r.date) ? DIP_RATIO : RECORD_COLLAPSE_RATIO;
      if (dips(m, r, ratio)) soft.get(m).add(r.date);
    }
  }

  for (const r of out) {
    r.flags = METRICS.filter((m) => r[m] !== null && r[m] !== undefined && (hard.get(m).has(r.date) || soft.get(m).has(r.date)));
  }
  return out;
}

// Daily active users, lower bound: the largest of the per-action distinct-account counts. A
// union is impossible to rebuild from these counts, but the max is a valid floor for it.
function computeDau(row) {
  if (!row || row.date < ACTIVITY_START) return null;
  const flags = row.flags || [];
  if (flags.includes('likers') || flags.includes('posters')) return null;
  if (!isCount(row.likers) || !isCount(row.posters)) return null;
  let best = null;
  for (const m of ACTOR_METRICS) {
    if (flags.includes(m) || !isCount(row[m])) continue;
    best = best === null ? row[m] : Math.max(best, row[m]);
  }
  return best;
}

module.exports = {
  ACTIVITY_START,
  COLLECTION_START,
  METRICS,
  ACTOR_METRICS,
  RECORD_METRICS,
  RECORD_OF,
  ACTOR_OF,
  KNOWN_OUTAGES,
  VERIFIED_DIPS,
  todayUtc,
  normalizeStats,
  normalizeSnapshot,
  flagActivity,
  computeDau,
  median,
};
