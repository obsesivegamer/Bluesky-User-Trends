'use strict';
// Turns timestamped total-user readings from several archives into one end-of-day series.
// Pure functions only: no I/O, no clock. See docs/ARCHITECTURE.md for the data flow.

const HOUR_MS = 3600e3;
const DAY_MS = 86400e3;

const SERIES_START = '2022-11-17';
// Wikimedia Commons "Bluesky Registered Users.svg" is daily through this date and the only
// source before it. Its own disclaimer says these two windows are linear interpolation, so
// they are not used as observations and other archives (Wayback) fill them instead.
const COMMONS_LAST_DATE = '2024-07-01';
const COMMONS_INTERPOLATED = [['2024-02-04', '2024-02-07'], ['2024-06-23', '2024-06-28']];

// All of these relay jazco's total_users. Earlier entries win when several observe a boundary.
const SOURCE_PRIORITY = ['bot', 'elaval', 'wayback', 'jazco', 'krekeny'];
const LIVE_SOURCES = new Set(SOURCE_PRIORITY);
const ALL_SOURCES = new Set([...SOURCE_PRIORITY, 'commons']);
// Hourly-ish sources: only the readings next to each day boundary are worth keeping.
const DENSE_SOURCES = new Set(['bot', 'elaval', 'jazco']);

const OBSERVED_WITHIN_MS = 3 * HOUR_MS;
const PLATEAU_MS = 6 * HOUR_MS;
const MAX_DROP = 0.01;
const DROP_LOOKBACK_MS = 14 * DAY_MS;
const PLC_MIN_GAP_MS = 6 * HOUR_MS;
const EXTRAPOLATE_BASE_MS = 24 * HOUR_MS;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date) => Date.parse(date + 'T00:00:00Z');
const addDays = (date, n) => isoDate(dateMs(date) + n * DAY_MS);
// A row's users value is the count at the end of its UTC day, i.e. at the next midnight.
const boundaryMs = (date) => dateMs(date) + DAY_MS;

function inWindows(date, windows) {
  return windows.some(([from, to]) => date >= from && date <= to);
}

function toIsoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

// Readings are stored as [isoTimestamp, source, users]; in memory they are {t, src, users}.
function normalizeSample(raw) {
  const [ts, src, users] = Array.isArray(raw) ? raw : [raw.ts ?? raw.t, raw.src, raw.users];
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t) || !ALL_SOURCES.has(src) || !Number.isSafeInteger(users) || users <= 0) return null;
  return { t: Math.floor(t / 1000) * 1000, src, users };
}

function encodeSample(s) {
  return [toIsoSeconds(s.t), s.src, s.users];
}

const priorityOf = (src) => {
  const i = SOURCE_PRIORITY.indexOf(src);
  return i === -1 ? SOURCE_PRIORITY.length : i;
};

function compareSamples(a, b) {
  return a.t - b.t || priorityOf(a.src) - priorityOf(b.src) || a.users - b.users;
}

function dedupeSamples(samples) {
  const seen = new Map();
  for (const raw of samples) {
    const s = normalizeSample(raw);
    if (!s) continue;
    const key = `${s.src}|${s.t}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()].sort(compareSamples);
}

// Maximal groups of consecutive (time-ordered) readings with the same value.
function valueRuns(live) {
  const runs = [];
  let i = 0;
  while (i < live.length) {
    let j = i;
    while (j + 1 < live.length && live[j + 1].users === live[i].users) j++;
    runs.push({ from: i, to: j });
    i = j + 1;
  }
  return runs;
}

// A run is a stale plateau when the counter showed the same value for more than 6h while the
// series kept growing around it (e.g. 42,722,227 for 105h in Feb 2026). "Held" lasts until the
// next different reading. The first reading of the run is kept: it is when the counter stopped.
function isPlateau(live, run) {
  if (run.to === run.from) return false;
  const first = live[run.from];
  const next = live[run.to + 1];
  const prev = live[run.from - 1];
  const held = (next ? next.t : live[run.to].t) - first.t;
  if (held <= PLATEAU_MS) return false;
  return next ? next.users > first.users : Boolean(prev && prev.users < first.users);
}

// Drops impossible readings: more than 1% below an earlier kept reading (from the previous
// 14 days, so one bad high reading cannot poison the rest), then stale plateaus.
// Commons values come from a different pipeline (end-of-day exports) and are never dropped.
// Idempotent, so re-running it on its own (thinned) output changes nothing.
function cleanSamples(samples) {
  const sorted = dedupeSamples(samples);
  const commons = sorted.filter((s) => s.src === 'commons');
  const dropped = [];

  const afterDrops = [];
  const window = [];
  for (const s of sorted) {
    if (!LIVE_SOURCES.has(s.src)) continue;
    while (window.length && window[0].t < s.t - DROP_LOOKBACK_MS) window.shift();
    if (window.length && s.users < window[0].users * (1 - MAX_DROP)) {
      dropped.push({ ...s, reason: 'drop' });
      continue;
    }
    afterDrops.push(s);
    while (window.length && window[window.length - 1].users <= s.users) window.pop();
    window.push(s);
  }

  const kept = [];
  for (const run of valueRuns(afterDrops)) {
    const plateau = isPlateau(afterDrops, run);
    for (let k = run.from; k <= run.to; k++) {
      if (plateau && k > run.from) dropped.push({ ...afterDrops[k], reason: 'plateau' });
      else kept.push(afterDrops[k]);
    }
  }
  return { kept: [...commons, ...kept].sort(compareSamples), dropped: dropped.sort(compareSamples) };
}

// Keeps, per dense source and UTC date, the first and last reading (the ones that bracket the
// day boundaries), plus what plateau detection needs to reach the same verdict again: when a
// run of equal values keeps two or more readings, also its first reading and the next different one.
function thinSamples(samples) {
  const sorted = dedupeSamples(samples);
  const keep = new Set();
  const firstLast = new Map();
  for (const s of sorted) {
    if (!DENSE_SOURCES.has(s.src)) {
      keep.add(s);
      continue;
    }
    const key = `${s.src}|${isoDate(s.t)}`;
    const slot = firstLast.get(key);
    if (!slot) firstLast.set(key, { first: s, last: s });
    else slot.last = s;
  }
  for (const { first, last } of firstLast.values()) {
    keep.add(first);
    keep.add(last);
  }
  const live = sorted.filter((s) => LIVE_SOURCES.has(s.src));
  for (const run of valueRuns(live)) {
    let keptInRun = 0;
    for (let k = run.from; k <= run.to; k++) if (keep.has(live[k])) keptInRun++;
    if (keptInRun < 2) continue;
    keep.add(live[run.from]);
    if (run.to + 1 < live.length) keep.add(live[run.to + 1]);
  }
  return sorted.filter((s) => keep.has(s));
}

// Cumulative curve of Bluesky-hosted did:plc creations, from sparse 1,000-operation pages of
// plc.directory/export. Each page gives a rate (creations / page duration) at its midpoint; the
// rate is linear between midpoints and the curve is its integral. Used only as a shape: values
// are always rescaled to two known user counts.
function buildPlcCurve(plcSamples) {
  const pts = [];
  const seen = new Set();
  for (const s of plcSamples || []) {
    const first = Date.parse(s.first);
    const last = Date.parse(s.last);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last - first < 1000) continue;
    if (!Number.isFinite(s.genesis_bsky) || s.genesis_bsky < 0 || seen.has(first)) continue;
    seen.add(first);
    pts.push({ first, last, m: (first + last) / 2, r: s.genesis_bsky / (last - first) });
  }
  pts.sort((a, b) => a.m - b.m);
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + ((pts[i - 1].r + pts[i].r) / 2) * (pts[i].m - pts[i - 1].m));
  }
  const start = pts[0].first;
  const end = pts[pts.length - 1].last;

  function at(t) {
    if (t <= pts[0].m) return -pts[0].r * (pts[0].m - t);
    const n = pts.length - 1;
    if (t >= pts[n].m) return cum[n] + pts[n].r * (t - pts[n].m);
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].m <= t) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const dt = t - a.m;
    return cum[lo] + a.r * dt + ((b.r - a.r) * dt * dt) / (2 * (b.m - a.m));
  }
  return { start, end, points: pts.length, at, covers: (a, b) => a >= start && b <= end };
}

// Index of the last element with t <= x, or -1.
function lastAtOrBefore(arr, x) {
  let lo = 0;
  let hi = arr.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= x) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function firstAtOrAfter(arr, x) {
  const i = lastAtOrBefore(arr, x);
  if (i >= 0 && arr[i].t === x) {
    let k = i;
    while (k > 0 && arr[k - 1].t === x) k--;
    return k;
  }
  return i + 1 < arr.length ? i + 1 : -1;
}

function clampRound(v, a, b) {
  return Math.round(Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b)));
}

function linear(lo, hi, t) {
  if (hi.t === lo.t) return lo.users;
  return clampRound(lo.users + ((hi.users - lo.users) * (t - lo.t)) / (hi.t - lo.t), lo.users, hi.users);
}

function makePool(samples) {
  const bySource = new Map();
  for (const s of samples) {
    if (!bySource.has(s.src)) bySource.set(s.src, []);
    bySource.get(s.src).push(s);
  }
  return { all: samples, bySource };
}

// The reading nearest a boundary on one side; ties at the same instant go to the higher-priority source.
function bracket(arr, B) {
  const i = lastAtOrBefore(arr, B);
  const j = firstAtOrAfter(arr, B);
  return { lo: i >= 0 ? arr[i] : null, hi: j >= 0 ? arr[j] : null };
}

function resolveBoundary(pool, B, plc) {
  for (const src of [...SOURCE_PRIORITY, 'commons']) {
    const arr = pool.bySource.get(src);
    if (!arr) continue;
    const { lo, hi } = bracket(arr, B);
    if (lo && hi && B - lo.t <= OBSERVED_WITHIN_MS && hi.t - B <= OBSERVED_WITHIN_MS) {
      return { users: linear(lo, hi, B), users_est: false, users_src: src };
    }
  }
  const { lo, hi } = bracket(pool.all, B);
  if (lo && hi) {
    if (B - lo.t <= OBSERVED_WITHIN_MS && hi.t - B <= OBSERVED_WITHIN_MS) {
      const nearest = B - lo.t <= hi.t - B ? lo : hi;
      return { users: linear(lo, hi, B), users_est: false, users_src: nearest.src };
    }
    if (plc && hi.t - lo.t > PLC_MIN_GAP_MS && plc.covers(lo.t, hi.t)) {
      const c0 = plc.at(lo.t);
      const c1 = plc.at(hi.t);
      if (c1 > c0) {
        const f = (plc.at(B) - c0) / (c1 - c0);
        return { users: clampRound(lo.users + (hi.users - lo.users) * f, lo.users, hi.users), users_est: true, users_src: 'plc-shaped' };
      }
    }
    return { users: linear(lo, hi, B), users_est: true, users_src: 'interp' };
  }
  if (lo) {
    // Nothing after the boundary yet (latest day, all feeds late): carry the recent pace forward.
    const base = pool.all[lastAtOrBefore(pool.all, lo.t - EXTRAPOLATE_BASE_MS)];
    const rate = base && lo.t > base.t ? Math.max(0, (lo.users - base.users) / (lo.t - base.t)) : 0;
    return { users: Math.round(lo.users + rate * (B - lo.t)), users_est: true, users_src: 'interp' };
  }
  return null;
}

// samples: [{t|ts, src, users}] or [[ts, src, users]] (already cleaned).
// Returns one row per UTC date from SERIES_START to endDate:
// {date, users, users_est, users_src} where users is the count at the end of that date.
function buildUsersSeries(samples, { endDate, plcSamples = null, startDate = SERIES_START } = {}) {
  if (!endDate) throw new Error('buildUsersSeries: endDate is required');
  const all = dedupeSamples(samples).filter(
    (s) => s.src !== 'commons' || !inWindows(isoDate(s.t - DAY_MS), COMMONS_INTERPOLATED),
  );
  const commonsPool = makePool(all.filter((s) => s.src === 'commons'));
  const fullPool = makePool(all);
  const plc = plcSamples ? buildPlcCurve(plcSamples) : null;
  const rows = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const commonsEra = date <= COMMONS_LAST_DATE && !inWindows(date, COMMONS_INTERPOLATED);
    const res = resolveBoundary(commonsEra ? commonsPool : fullPool, boundaryMs(date), plc);
    if (!res) throw new Error(`no user-count reading on or before ${date}`);
    rows.push({ date, ...res });
  }
  return rows;
}

// Contiguous [from, to] date ranges where pred(row) holds, e.g. for reporting estimated stretches.
function dateRanges(rows, pred) {
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (!pred(row)) continue;
    if (last && addDays(last.to, 1) === row.date) last.to = row.date;
    else out.push({ from: row.date, to: row.date });
  }
  return out;
}

const SAMPLES_FILE_META = {
  schema: 1,
  description:
    "Timestamped readings of Bluesky's total user count, the provenance of the daily users series " +
    '(lib/users.js rebuilds it from this file plus data/sources/plc-rate-samples.json). ' +
    'Each sample is [UTC timestamp, source, users]. Stale plateaus and impossible drops are removed; ' +
    'hourly sources keep only the first and last reading of each UTC day.',
  sources: {
    commons:
      'Wikimedia Commons "Bluesky Registered Users.svg" data_array (CC BY 4.0: VintageNebula; Martin Kleppmann et al., arXiv:2402.03239; Jaz). ' +
      'End-of-day value for the previous UTC date, stored at the following 00:00Z. Its interpolated dates (2024-02-04..07, 2024-06-23..28) are left out.',
    wayback: 'Wayback Machine captures of https://bsky-search.jazco.io/stats, timestamped by the response\'s updated_at.',
    bot: '@hourlybskyusers.bsky.social (by @jordan.weatherby.io) posts "Total Bluesky users: N" hourly; timestamped by post createdAt.',
    elaval: 'github.com/elaval/bskyusers bsky_users_history.csv (hourly, 2024-11-22..2026-04-13).',
    krekeny: 'github.com/Krekeny/bluesky-stats docs/data/stats.json (MIT; daily, no time of day stored, so timestamped at its usual run time).',
    jazco: 'https://bsky-search.jazco.io/stats total_users read by updateData.js, timestamped by updated_at.',
  },
};

function serializeSamplesFile(samples) {
  const head = JSON.stringify(SAMPLES_FILE_META, null, 2).slice(0, -2);
  const lines = dedupeSamples(samples).map((s) => JSON.stringify(encodeSample(s)));
  return head + ',\n  "samples": [\n' + lines.join(',\n') + '\n  ]\n}\n';
}

function parseSamplesFile(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.samples)) throw new Error('users-samples: missing samples array');
  return parsed.samples.map((raw, i) => {
    const s = normalizeSample(raw);
    if (!s) throw new Error(`users-samples: invalid sample #${i}: ${JSON.stringify(raw)}`);
    return s;
  });
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  SERIES_START,
  COMMONS_LAST_DATE,
  COMMONS_INTERPOLATED,
  SOURCE_PRIORITY,
  DENSE_SOURCES,
  OBSERVED_WITHIN_MS,
  PLATEAU_MS,
  PLC_MIN_GAP_MS,
  addDays,
  boundaryMs,
  toIsoSeconds,
  normalizeSample,
  encodeSample,
  dedupeSamples,
  cleanSamples,
  thinSamples,
  buildPlcCurve,
  buildUsersSeries,
  dateRanges,
  serializeSamplesFile,
  parseSamplesFile,
};
