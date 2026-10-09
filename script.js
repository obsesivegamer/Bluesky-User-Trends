(function (root) {
  'use strict';

  const Fmt = (root && root.BskyFormat) || (typeof require === 'function' ? require('./lib/format.js') : null);
  const { formatInteger, formatCompact, formatSigned, formatPct, formatSignedPct, formatDay, formatUtcStamp } = Fmt || {};

  const DAY_MS = 86400000;
  const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const ACTIVITY_KEYS = ['likers', 'posters', 'followers', 'blockers', 'posts', 'likes', 'follows', 'blocks'];
  const RANGES = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', 'ALL'];
  const VELOCITY_MODES = ['new', 'pct'];
  const RATIO_MODES = ['poster_ratio', 'dau_share', 'posts_per_poster', 'likes_per_liker'];
  const RATIO_HASH = { poster_ratio: 'pr', dau_share: 'ds', posts_per_poster: 'pp', likes_per_liker: 'll' };
  const DEFAULT_STATE = Object.freeze({ range: '1Y', ma: true, log: false, cmp: false, vm: 'new', rm: 'poster_ratio' });
  const SITE_URL = 'https://obsesivegamer.github.io/Bluesky-User-Trends/';

  const RANGE_LABELS = {
    '1W': 'Past Week', '1M': 'Past Month', '3M': 'Past 3 Months', '6M': 'Past 6 Months',
    'YTD': 'Year to Date', '1Y': 'Past Year', '2Y': 'Past 2 Years', 'ALL': 'All Time'
  };
  const RANGE_TREND_TAGS = { '1W': 'WoW', '1M': 'MoM', '3M': '3M', '6M': '6M', 'YTD': 'YTD', '1Y': 'YoY', '2Y': '2Y', 'ALL': 'ALL' };

  const WAVES = [
    {
      id: 'W24FEB', title: 'Feb 2024', name: 'Open registration', start: '2024-02-01', end: '2024-02-29',
      note: 'Bluesky dropped invite codes and opened public sign-ups on Feb 6, 2024.'
    },
    {
      id: 'W24BRA', title: 'Aug–Sep 2024', name: 'Brazil X ban', start: '2024-08-24', end: '2024-09-21',
      note: 'Brazil’s Supreme Court ordered X suspended on Aug 30, 2024, and Brazilian users moved to Bluesky.'
    },
    {
      id: 'W24OCT', title: 'Oct 2024', name: 'X block-policy change', start: '2024-10-10', end: '2024-10-31',
      note: 'X said on Oct 16, 2024 that blocked accounts would still be able to see public posts.'
    },
    {
      id: 'W24NOV', title: 'Nov 2024', name: 'Post-election exodus', start: '2024-11-05', end: '2024-12-15',
      note: 'After the Nov 5, 2024 US election a wave of users left X; Bluesky set its activity records on Nov 18–19.'
    }
  ];

  const MILESTONES = [
    { date: '2023-03-01', context: 'Activity data begins (first day in Jaz’s daily index)' },
    { date: '2023-05-01', context: 'Post data collection starts; earlier activity is reconstructed and undercounted' },
    { date: '2024-02-06', context: 'Bluesky opens public sign-ups (no invite code needed)', highlight: true },
    { date: '2024-08-30', context: 'Brazil suspends X; a migration wave reaches Bluesky', highlight: true },
    { date: '2024-11-18', context: 'Post-election peak: record daily active accounts', highlight: true },
    { date: '2025-01-01', context: 'First day of 2025 (Bluesky reported 25.94M users at the start of the year)' },
    { date: '2026-01-01', context: 'First day of 2026 (Bluesky reported 41.41M users at the end of 2025)' }
  ];

  const SOURCE_LABELS = {
    commons: 'Wikimedia Commons series',
    wayback: 'Wayback capture of Jaz’s counter',
    bot: '@hourlybskyusers post',
    elaval: 'elaval hourly archive',
    krekeny: 'Krekeny daily archive',
    jazco: 'Jaz’s live counter',
    'plc-shaped': 'PLC-shaped interpolation',
    interp: 'linear interpolation',
    missing: 'no data'
  };

  const METRIC_LABELS = {
    users: 'Total users', new_users: 'New accounts', growth_pct: 'Growth', dau: 'DAU (lower bound)',
    likers: 'Likers', posters: 'Posters', followers: 'Followers', blockers: 'Blockers',
    posts: 'Posts', likes: 'Likes', follows: 'Follows', blocks: 'Blocks',
    poster_ratio: 'Poster ratio', dau_share: 'DAU share', posts_per_poster: 'Posts per poster', likes_per_liker: 'Likes per liker'
  };

  // ---------------------------------------------------------------------------
  // Pure helpers (exported for node:test)
  // ---------------------------------------------------------------------------

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  function isoToDayNum(iso) {
    const m = ISO_DAY.exec(iso || '');
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : NaN;
  }

  function dayNumToIso(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    return dayNumToIso(isoToDayNum(iso) + n);
  }

  function addMonths(iso, n) {
    const m = ISO_DAY.exec(iso);
    const day = Number(m[3]);
    let month = Number(m[2]) - 1 + n;
    const year = Number(m[1]) + Math.floor(month / 12);
    month = ((month % 12) + 12) % 12;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return dayNumToIso(Date.UTC(year, month, Math.min(day, daysInMonth)) / DAY_MS);
  }

  function daysBetween(a, b) {
    return isoToDayNum(b) - isoToDayNum(a);
  }

  const parseArchiveDate = (value) => {
    const m = ISO_DAY.exec(value);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(value);
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function mean(values) {
    let sum = 0;
    let count = 0;
    for (const v of values) {
      if (v != null && Number.isFinite(v)) { sum += v; count += 1; }
    }
    return count ? sum / count : null;
  }

  function lastIndexWhere(arr, pred) {
    for (let i = arr.length - 1; i >= 0; i -= 1) if (pred(arr[i], i)) return i;
    return -1;
  }

  function argMax(values) {
    let best = -1;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] != null && (best < 0 || values[i] > values[best])) best = i;
    }
    return best;
  }

  function pctChange(from, to) {
    if (from == null || to == null || from === 0) return null;
    return ((to - from) / Math.abs(from)) * 100;
  }

  function isFlagged(row, key) {
    return Array.isArray(row && row.flags) && row.flags.includes(key);
  }

  function metricValue(row, key) {
    if (!row) return null;
    if (ACTIVITY_KEYS.includes(key) && isFlagged(row, key)) return null;
    return num(row[key]);
  }

  function emptyRow(date) {
    const row = { date, users: null, users_est: true, users_src: 'missing', new_users: null, new_users_est: true, dau: null, flags: ACTIVITY_KEYS.slice(), missing: true };
    ACTIVITY_KEYS.forEach((k) => { row[k] = null; });
    return row;
  }

  // Sorts by date, drops malformed rows, and inserts placeholder rows for any missing
  // calendar day so every index step is exactly one UTC day.
  function normalizeDays(days) {
    const byDate = new Map();
    for (const row of days || []) {
      if (row && ISO_DAY.test(row.date)) byDate.set(row.date, row);
    }
    const dates = [...byDate.keys()].sort();
    if (!dates.length) return [];
    const out = [];
    const end = isoToDayNum(dates[dates.length - 1]);
    for (let n = isoToDayNum(dates[0]); n <= end; n += 1) {
      const iso = dayNumToIso(n);
      out.push(byDate.get(iso) || emptyRow(iso));
    }
    return out;
  }

  function ratioSeries(a, b, scale) {
    return a.map((v, i) => (v != null && b[i] != null && b[i] > 0 ? (v / b[i]) * scale : null));
  }

  function buildSeries(rawDays) {
    const rows = normalizeDays(rawDays);
    const s = { rows, dates: rows.map((r) => r.date), length: rows.length };
    s.users = rows.map((r) => num(r.users));
    s.usersEst = rows.map((r) => r.users_est === true || r.missing === true);
    s.usersSrc = rows.map((r) => (typeof r.users_src === 'string' ? r.users_src : ''));
    s.new_users = rows.map((r, i) => {
      if (i === 0 || r.missing || rows[i - 1].missing) return null;
      const v = num(r.new_users);
      if (v != null) return v;
      return s.users[i] != null && s.users[i - 1] != null ? s.users[i] - s.users[i - 1] : null;
    });
    s.newEst = rows.map((r, i) => r.new_users_est === true || s.usersEst[i] || (i > 0 && s.usersEst[i - 1]));
    s.growth_pct = s.new_users.map((v, i) => (v != null && i > 0 && s.users[i - 1] > 0 ? (v / s.users[i - 1]) * 100 : null));
    ACTIVITY_KEYS.forEach((k) => { s[k] = rows.map((r) => metricValue(r, k)); });
    s.dau = rows.map((r) => (isFlagged(r, 'likers') || isFlagged(r, 'posters') ? null : num(r.dau)));
    s.flags = rows.map((r) => (Array.isArray(r.flags) ? r.flags.slice() : []));
    s.missing = rows.map((r) => r.missing === true);
    s.poster_ratio = ratioSeries(s.posters, s.dau, 100);
    s.dau_share = ratioSeries(s.dau, s.users, 100);
    s.posts_per_poster = ratioSeries(s.posts, s.posters, 1);
    s.likes_per_liker = ratioSeries(s.likes, s.likers, 1);
    return s;
  }

  function seriesIndexOf(series, iso) {
    if (!series.length) return -1;
    const i = isoToDayNum(iso) - isoToDayNum(series.dates[0]);
    return i >= 0 && i < series.length ? i : -1;
  }

  // Trailing calendar-day moving average over a contiguous daily array. Missing values are
  // skipped; a point is emitted only once a full window exists and at least `minValid`
  // of its days have data, so outage days never drag the average toward zero.
  function movingAverage(values, window = 7, minValid = Math.min(window, 4)) {
    const out = new Array(values.length).fill(null);
    for (let i = window - 1; i < values.length; i += 1) {
      let sum = 0;
      let count = 0;
      for (let j = i - window + 1; j <= i; j += 1) {
        const v = values[j];
        if (v != null && Number.isFinite(v)) { sum += v; count += 1; }
      }
      if (count >= minValid) out[i] = sum / count;
    }
    return out;
  }

  function dailyDeltas(values) {
    return values.map((v, i) => (i > 0 && v != null && values[i - 1] != null ? v - values[i - 1] : null));
  }

  function rowsHaveDates(rows) {
    return rows.length > 0 && rows.every((r) => r && ISO_DAY.test(r.date));
  }

  function calculateMovingAverage(rows, key, window = 7) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    if (!rowsHaveDates(rows)) return movingAverage(rows.map((r) => metricValue(r, key)), window);
    const norm = normalizeDays(rows);
    const ma = movingAverage(norm.map((r) => metricValue(r, key)), window);
    const first = isoToDayNum(norm[0].date);
    return rows.map((r) => ma[isoToDayNum(r.date) - first]);
  }

  function calculateDailyDeltas(rows, key) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    if (!rowsHaveDates(rows)) return dailyDeltas(rows.map((r) => metricValue(r, key)));
    const byDate = new Map(rows.map((r) => [r.date, r]));
    return rows.map((r) => {
      const prev = byDate.get(addDays(r.date, -1));
      const a = metricValue(prev, key);
      const b = metricValue(r, key);
      return a != null && b != null ? b - a : null;
    });
  }

  function calculateGrowthVelocity(rows, key = 'users') {
    const valid = (rows || []).filter((r) => metricValue(r, key) != null && ISO_DAY.test(r.date));
    if (valid.length < 2) return { diff: 0, days: 1, ratePerDay: 0, formatted: '0 / day' };
    const first = valid[0];
    const last = valid[valid.length - 1];
    const diff = metricValue(last, key) - metricValue(first, key);
    const days = Math.max(1, daysBetween(first.date, last.date));
    const ratePerDay = Math.round(diff / days);
    return { diff, days, ratePerDay, formatted: `${formatSigned(ratePerDay)} / day` };
  }

  function calculateRatio(numerator, denominator, digits = 2) {
    if (numerator == null || denominator == null || !(denominator > 0) || numerator < 0) return '—';
    return formatPct((numerator / denominator) * 100, digits);
  }

  function generateSparklineSVG(values, width = 120, height = 28) {
    if (!Array.isArray(values) || values.length < 2) return '';
    const valid = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (valid.length < 2) return '';
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = max - min || 1;
    const pad = 2;
    const step = (width - pad * 2) / (values.length - 1);
    let path = '';
    let pen = false;
    values.forEach((v, i) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) { pen = false; return; }
      const x = (pad + i * step).toFixed(1);
      const y = (height - pad - ((v - min) / range) * (height - pad * 2)).toFixed(1);
      path += `${path ? ' ' : ''}${pen ? 'L' : 'M'} ${x},${y}`;
      pen = true;
    });
    return path;
  }

  function downsample(values, maxPoints = 120) {
    if (values.length <= maxPoints) return values.slice();
    const out = [];
    const step = values.length / maxPoints;
    for (let i = 0; i < maxPoints; i += 1) {
      const a = Math.floor(i * step);
      const b = Math.max(a + 1, Math.floor((i + 1) * step));
      out.push(mean(values.slice(a, b)));
    }
    return out;
  }

  function findWave(id) {
    return WAVES.find((w) => w.id === id) || null;
  }

  function isValidRange(range) {
    return RANGES.includes(range) || Boolean(findWave(range));
  }

  // Ranges are anchored on the latest complete day and include their baseline day, so
  // 1W spans 8 points and its MA change is week-over-week. YTD's baseline is Dec 31 of
  // the previous year (the year's opening value); a wave's is the day before it starts, so
  // the cards' net change and the wave chip measure the same thing.
  function getRangeBounds(range, firstDate, lastDate) {
    if (!firstDate || !lastDate) return null;
    const wave = findWave(range);
    if (wave) {
      const base = addDays(wave.start, -1);
      const start = base > firstDate ? base : firstDate;
      const end = wave.end < lastDate ? wave.end : lastDate;
      return start <= end ? { start, end } : null;
    }
    let start;
    switch (range) {
      case '1W': start = addDays(lastDate, -7); break;
      case '1M': start = addMonths(lastDate, -1); break;
      case '3M': start = addMonths(lastDate, -3); break;
      case '6M': start = addMonths(lastDate, -6); break;
      case 'YTD': start = `${Number(lastDate.slice(0, 4)) - 1}-12-31`; break;
      case 'ALL': start = firstDate; break;
      default: {
        const m = /^(\d+)Y$/.exec(range || '');
        start = m ? addMonths(lastDate, -12 * Number(m[1])) : firstDate;
      }
    }
    if (start < firstDate) start = firstDate;
    return { start, end: lastDate };
  }

  // Prior period = an equal number of calendar days ending on the current window's
  // baseline day. Point i of the prior window is aligned with point i of the current one.
  function getPriorBounds(range, firstDate, lastDate) {
    if (range === 'ALL') return null;
    const cur = getRangeBounds(range, firstDate, lastDate);
    if (!cur) return null;
    const span = daysBetween(cur.start, cur.end);
    if (span < 1) return null;
    const end = cur.start;
    if (end <= firstDate) return null;
    const start = addDays(end, -span);
    return { start, end, span, truncated: start < firstDate };
  }

  function filterDataByRange(range, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const bounds = getRangeBounds(range, rows[0].date, rows[rows.length - 1].date);
    if (!bounds) return [];
    return rows.filter((r) => r.date >= bounds.start && r.date <= bounds.end);
  }

  function calculatePeriodComparison(range, rows) {
    if (!Array.isArray(rows) || rows.length === 0 || !rowsHaveDates(rows)) return null;
    const first = rows[0].date;
    const last = rows[rows.length - 1].date;
    const prior = getPriorBounds(range, first, last);
    if (!prior) return null;
    const current = getRangeBounds(range, first, last);
    const raw = rows.filter((r) => r.date >= prior.start && r.date <= prior.end);
    if (raw.length < 2) return null;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const dates = [];
    for (let n = isoToDayNum(current.start); n <= isoToDayNum(current.end); n += 1) {
      const p = dayNumToIso(n - prior.span);
      dates.push(p >= first ? p : null);
    }
    const valuesFor = (key) => dates.map((d) => (d ? metricValue(byDate.get(d), key) : null));
    return { start: prior.start, end: prior.end, span: prior.span, truncated: prior.truncated, current, dates, raw, valuesFor };
  }

  function getRangeLabel(range) {
    const wave = findWave(range);
    if (wave) return `${wave.title} ${wave.name} (${formatDay(wave.start)} – ${formatDay(wave.end)})`;
    if (/^\d+Y$/.test(range) && !RANGE_LABELS[range]) {
      const years = Number(range.slice(0, -1));
      return years === 1 ? 'Past Year' : `Past ${years} Years`;
    }
    return RANGE_LABELS[range] || 'All Time';
  }

  function getTrendTag(range) {
    return findWave(range) ? 'WINDOW' : (RANGE_TREND_TAGS[range] || range);
  }

  function parseHashState(hash) {
    const out = { ...DEFAULT_STATE };
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const r = (params.get('r') || '').toUpperCase();
    if (isValidRange(r)) out.range = r;
    [['ma', 'ma'], ['log', 'log'], ['cmp', 'cmp']].forEach(([param, key]) => {
      const v = params.get(param);
      if (v === '1' || v === '0') out[key] = v === '1';
    });
    const vm = params.get('vm');
    if (VELOCITY_MODES.includes(vm)) out.vm = vm;
    const rm = Object.keys(RATIO_HASH).find((k) => RATIO_HASH[k] === params.get('rm'));
    if (rm) out.rm = rm;
    if (out.range === 'ALL') out.cmp = false;
    return out;
  }

  function serializeHashState(st) {
    const parts = [`r=${st.range}`, `ma=${st.ma ? 1 : 0}`, `log=${st.log ? 1 : 0}`, `cmp=${st.cmp ? 1 : 0}`];
    if (st.vm && st.vm !== DEFAULT_STATE.vm) parts.push(`vm=${st.vm}`);
    if (st.rm && st.rm !== DEFAULT_STATE.rm) parts.push(`rm=${RATIO_HASH[st.rm]}`);
    return `#${parts.join('&')}`;
  }

  function csvCell(v) {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
    let s;
    if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
    else if (Array.isArray(v)) s = v.join('|');
    else s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function buildCSV(columns, rows) {
    const lines = [columns.map((c) => csvCell(c.header)).join(',')];
    rows.forEach((r) => { lines.push(columns.map((c) => csvCell(c.value(r))).join(',')); });
    return `${lines.join('\n')}\n`;
  }

  function buildChartCSV(rows, keys) {
    const columns = [{ header: 'date', value: (r) => r.date }].concat(
      keys.map((k) => ({ header: k, value: (r) => (k === 'flags' ? r.flags || [] : metricValue(r, k)) }))
    );
    return buildCSV(columns, rows);
  }

  function resetChartZoom(chartId, instances) {
    const map = instances || (root && root.BskyTerminal ? root.BskyTerminal.charts : {});
    const chart = map ? map[chartId] : null;
    if (chart && typeof chart.resetZoom === 'function') chart.resetZoom();
  }

  function wowChange(ma, idx) {
    if (idx < 7) return null;
    return pctChange(ma[idx - 7], ma[idx]);
  }

  function computePrerenderValues(data) {
    const s = buildSeries(data.days);
    const snap = data.snapshot || {};
    const last = s.length - 1;
    const v = {};
    v['last-day'] = formatDay(data.last_complete_day || (last >= 0 ? s.dates[last] : null));
    v.generated = formatUtcStamp(data.generated_at);
    v['users-total'] = formatInteger(snap.total_users);
    v['users-total-compact'] = formatCompact(snap.total_users);
    v['users-at'] = formatUtcStamp(snap.updated_at);
    const vel7 = mean(s.new_users.slice(-7));
    v['velocity-7d'] = `${formatSigned(vel7)}/day`;
    v['velocity-last'] = formatSigned(last >= 0 ? s.new_users[last] : null);
    // DAU, posters, poster ratio and DAU share describe one day: the latest with a usable DAU.
    const iDau = lastIndexWhere(s.dau, (x) => x != null);
    v.dau = formatCompact(iDau >= 0 ? s.dau[iDau] : null);
    const iPost = iDau >= 0 ? iDau : lastIndexWhere(s.posters, (x) => x != null);
    v['activity-day'] = iPost >= 0 ? formatDay(s.dates[iPost]) : '—';
    v.posters = formatCompact(iPost >= 0 ? s.posters[iPost] : null);
    const iRatio = lastIndexWhere(s.poster_ratio, (x) => x != null);
    v['poster-ratio'] = formatPct(iRatio >= 0 ? s.poster_ratio[iRatio] : null, 1);
    v['dau-share'] = formatPct(iDau >= 0 && s.users[iDau] > 0 ? (100 * s.dau[iDau]) / s.users[iDau] : null, 2);
    v['index-posts'] = formatCompact(num(snap.total_posts));
    v['index-likes'] = formatCompact(num(snap.total_likes));
    v['index-follows'] = formatCompact(num(snap.total_follows));
    const pDau = argMax(s.dau);
    v['dau-peak'] = formatCompact(pDau >= 0 ? s.dau[pDau] : null);
    v['dau-peak-date'] = pDau >= 0 ? formatDay(s.dates[pDau]) : '—';
    const pPost = argMax(s.posters);
    v['posters-peak'] = formatCompact(pPost >= 0 ? s.posters[pPost] : null);
    v['posters-peak-date'] = pPost >= 0 ? formatDay(s.dates[pPost]) : '—';
    const pVel = argMax(s.new_users);
    v['velocity-peak'] = formatSigned(pVel >= 0 ? s.new_users[pVel] : null);
    v['velocity-peak-date'] = pVel >= 0 ? `${formatDay(s.dates[pVel])}${s.newEst[pVel] ? ' (est.)' : ''}` : '—';
    return v;
  }

  function computeTickerItems(data, series) {
    const s = series || buildSeries(data.days);
    const pre = computePrerenderValues(data);
    const item = (key, sym, value, metric) => {
      const ma = movingAverage(s[metric]);
      const idx = lastIndexWhere(ma, (x) => x != null);
      return { key, sym, value, chg: idx >= 0 ? wowChange(ma, idx) : null };
    };
    const latest = (key) => {
      const i = lastIndexWhere(s[key], (x) => x != null);
      return formatCompact(i >= 0 ? s[key][i] : null);
    };
    return [
      item('users', 'USERS', pre['users-total'], 'users'),
      item('velocity', 'VEL/DAY 7D', pre['velocity-7d'], 'new_users'),
      item('dau', 'DAU', pre.dau, 'dau'),
      item('posters', 'POSTERS', pre.posters, 'posters'),
      item('posts', 'POSTS', latest('posts'), 'posts'),
      item('likes', 'LIKES', latest('likes'), 'likes'),
      item('follows', 'FOLLOWS', latest('follows'), 'follows'),
      item('blocks', 'BLOCKS', latest('blocks'), 'blocks')
    ];
  }

  function trendClass(x) {
    if (x == null) return 'flat';
    if (x > 0) return 'up';
    if (x < 0) return 'down';
    return 'flat';
  }

  // A change of 1,000% or more reads better as a multiple (×12.3, ×4,432), e.g. ALL-range trends
  // that start from the first few accounts in 2022.
  function formatChange(pct, digits = 2) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
    if (pct < 1000) return formatSignedPct(pct, digits);
    const m = 1 + pct / 100;
    return `×${m >= 100 ? formatInteger(m) : m.toFixed(1)}`;
  }

  function trendArrow(x) {
    if (x == null || x === 0) return '■';
    return x > 0 ? '▲' : '▼';
  }

  function buildTickerHTML(items) {
    return items.map((it) => {
      const cls = trendClass(it.chg);
      return `<li class="tick" data-tick="${escapeHtml(it.key)}"><span class="tick-sym">${escapeHtml(it.sym)}</span>`
        + `<span class="tick-val">${escapeHtml(it.value)}</span>`
        + `<span class="tick-chg ${cls}"><span aria-hidden="true">${trendArrow(it.chg)}</span> ${escapeHtml(formatSignedPct(it.chg))}</span></li>`;
    }).join('\n');
  }

  function buildMilestoneRows(data, series) {
    const s = series || buildSeries(data.days);
    const ma = movingAverage(s.new_users);
    const lastDate = s.dates[s.length - 1];
    const rows = MILESTONES.filter((m) => m.date <= lastDate).map((m) => ({ ...m, current: false }));
    rows.push({ date: lastDate, context: 'Latest complete UTC day', current: true });
    return rows.map((m) => {
      const i = seriesIndexOf(s, m.date);
      const usersEst = i >= 0 && s.users[i] != null && s.usersEst[i];
      const velocityEst = i >= 0 && ma[i] != null && s.newEst.slice(Math.max(0, i - 6), i + 1).some(Boolean);
      return {
        date: m.date,
        dateLabel: formatDay(m.date),
        users: `${usersEst ? '~' : ''}${formatInteger(i >= 0 ? s.users[i] : null)}`,
        usersEst,
        velocity: `${velocityEst ? '~' : ''}${formatSigned(i >= 0 ? ma[i] : null)}`,
        velocityEst,
        dau: formatCompact(i >= 0 ? s.dau[i] : null),
        posters: formatCompact(i >= 0 ? s.posters[i] : null),
        context: m.context,
        highlight: Boolean(m.highlight),
        current: m.current
      };
    });
  }

  function buildMilestoneRowsHTML(data, series) {
    return buildMilestoneRows(data, series).map((r) => {
      const cls = r.current ? ' class="current-row"' : (r.highlight ? ' class="highlight-row"' : '');
      const est = (on, what) => (on ? ` est" title="Estimated: ${what}` : '');
      return `<tr${cls}><td><strong>${escapeHtml(r.dateLabel)}</strong></td>`
        + `<td class="num${est(r.usersEst, 'no reading near the end of this UTC day; interpolated')}">${escapeHtml(r.users)}</td>`
        + `<td class="num${est(r.velocityEst, 'the 7-day window includes estimated user counts')}">${escapeHtml(r.velocity)}</td>`
        + `<td class="num">${escapeHtml(r.dau)}</td><td class="num">${escapeHtml(r.posters)}</td>`
        + `<td>${escapeHtml(r.context)}</td></tr>`;
    }).join('\n');
  }

  function computeWaveStats(wave, series) {
    const a = seriesIndexOf(series, wave.start);
    const b = seriesIndexOf(series, wave.end);
    if (a < 0 || b < 0) return null;
    const base = a > 0 ? series.users[a - 1] : null;
    const net = base != null && series.users[b] != null ? series.users[b] - base : null;
    let peak = -1;
    for (let i = a; i <= b; i += 1) if (series.new_users[i] != null && (peak < 0 || series.new_users[i] > series.new_users[peak])) peak = i;
    let dauPeak = -1;
    for (let i = a; i <= b; i += 1) if (series.dau[i] != null && (dauPeak < 0 || series.dau[i] > series.dau[dauPeak])) dauPeak = i;
    return {
      net,
      peakDate: peak >= 0 ? series.dates[peak] : null,
      peakValue: peak >= 0 ? series.new_users[peak] : null,
      peakEst: peak >= 0 ? series.newEst[peak] : false,
      dauPeakDate: dauPeak >= 0 ? series.dates[dauPeak] : null,
      dauPeakValue: dauPeak >= 0 ? series.dau[dauPeak] : null
    };
  }

  function parseLiveFeed(json, pattern) {
    if (!json || !Array.isArray(json.feed) || typeof pattern !== 'string') return null;
    let re;
    try { re = new RegExp(pattern); } catch (e) { return null; }
    let best = null;
    for (const item of json.feed) {
      const rec = item && item.post && item.post.record;
      if (!rec || typeof rec.text !== 'string') continue;
      const m = re.exec(rec.text);
      if (!m || !m[1]) continue;
      const count = Number(m[1].replace(/,/g, ''));
      const at = Date.parse(rec.createdAt);
      if (!Number.isSafeInteger(count) || count <= 0 || Number.isNaN(at)) continue;
      if (!best || at > best.at) best = { count, at };
    }
    return best;
  }

  function acceptLiveReading(reading, snapshot, nowMs) {
    if (!reading || !snapshot) return false;
    const snapAt = Date.parse(snapshot.updated_at);
    const snapUsers = num(snapshot.total_users);
    if (Number.isNaN(snapAt) || snapUsers == null) return false;
    if (!(reading.at > snapAt)) return false;
    if (reading.at > nowMs + 10 * 60 * 1000) return false;
    return reading.count >= snapUsers * 0.995 && reading.count <= snapUsers * 1.25;
  }

  // Never extrapolates past `maxElapsedMs` after the live reading, so a sleeping tab or a
  // silent bot can't run the estimate away from the last real observation.
  function estimateLiveTotal(reading, pacePerDay, nowMs, maxElapsedMs = 3 * 3600 * 1000) {
    if (!reading) return null;
    const pace = pacePerDay != null && pacePerDay > 0 ? pacePerDay : 0;
    const elapsed = Math.min(Math.max(0, nowMs - reading.at), maxElapsedMs);
    return Math.floor(reading.count + (pace * elapsed) / DAY_MS);
  }

  function buildLiveUrl(source, limit = 5) {
    return `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(source.actor)}&limit=${limit}&filter=posts_no_replies`;
  }

  // Rewrites the FAQPage answers of a JSON-LD object from the visible FAQ ([{question, answer}]).
  // Returns true when the object changed.
  function syncFaqJsonLd(ld, faq) {
    if (!ld || !Array.isArray(faq) || !faq.length) return false;
    const graph = Array.isArray(ld['@graph']) ? ld['@graph'] : [ld];
    const node = graph.find((n) => n && n['@type'] === 'FAQPage');
    if (!node) return false;
    const next = faq.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } }));
    if (JSON.stringify(node.mainEntity) === JSON.stringify(next)) return false;
    node.mainEntity = next;
    return true;
  }

  function formatAxisCompact(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    const a = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    const trim = (x) => String(Number(x.toFixed(2)));
    if (a >= 1e9) return `${sign}${trim(a / 1e9)}B`;
    if (a >= 1e6) return `${sign}${trim(a / 1e6)}M`;
    if (a >= 1e3) return `${sign}${trim(a / 1e3)}K`;
    return `${sign}${trim(a)}`;
  }

  const TICK_LEVELS = [
    { kind: 'week', test: (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1 },
    { kind: 'semimonth', test: (d) => d.endsWith('-01') || d.endsWith('-15') },
    { kind: 'month', test: (d) => d.endsWith('-01') },
    { kind: 'quarter', test: (d) => /-(01|04|07|10)-01$/.test(d) },
    { kind: 'half', test: (d) => /-(01|07)-01$/.test(d) },
    { kind: 'year', test: (d) => d.endsWith('-01-01') }
  ];

  // Picks x-axis ticks on calendar boundaries (days, Mondays, month starts, quarters,
  // years) so labels never repeat, using the finest level that fits `maxLabels`.
  function pickDateTicks(dates, lo, hi, maxLabels) {
    const n = hi - lo + 1;
    const max = Math.max(2, maxLabels);
    if (n <= 0) return { kind: 'day', indices: [] };
    const step = Math.ceil(n / max);
    if (step < 7) {
      const indices = [];
      for (let i = hi; i >= lo; i -= step) indices.unshift(i);
      return { kind: 'day', indices };
    }
    for (const level of TICK_LEVELS) {
      const indices = [];
      for (let i = lo; i <= hi; i += 1) if (level.test(dates[i])) indices.push(i);
      if (indices.length <= max && (indices.length >= 2 || level.kind === 'year')) return { kind: level.kind, indices };
    }
    const years = [];
    for (let i = lo; i <= hi; i += 1) if (dates[i].endsWith('-01-01')) years.push(i);
    const k = Math.ceil(years.length / max);
    return { kind: 'year', indices: years.filter((_, j) => j % k === 0) };
  }

  function formatDateTick(iso, kind) {
    const m = ISO_DAY.exec(iso || '');
    if (!m) return '';
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
    if (kind === 'year') return m[1];
    if (kind === 'month' || kind === 'quarter' || kind === 'half') return `${mon} ’${m[1].slice(2)}`;
    return `${mon} ${Number(m[3])}`;
  }

  // Round, evenly spaced values in [min, max]: 1-2-2.5-5 steps, at most maxTicks of them.
  function linearTicks(min, max, maxTicks = 5) {
    if (!(max > min)) return [];
    const raw = (max - min) / Math.max(1, maxTicks - 1);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw * (1 - 1e-9));
    const out = [];
    for (let k = Math.ceil(min / step - 1e-9); k * step <= max * (1 + 1e-12); k += 1) out.push(Number((k * step).toPrecision(12)));
    return out;
  }

  // Log-axis ticks on a 1-2-5 ladder; falls back to every integer mantissa when the data
  // spans less than about half a decade. Below a 3x span a log axis is nearly linear, and the
  // ladder would crowd a few labels at one end, so it gets evenly spaced round values instead.
  function logTicks(min, max, maxTicks = 7) {
    if (!(min > 0) || !(max > min)) return [];
    if (max / min < 3) return linearTicks(min, max, Math.min(maxTicks, 5));
    const lo = Math.floor(Math.log10(min));
    const hi = Math.ceil(Math.log10(max));
    const pick = (mantissas) => {
      const out = [];
      for (let e = lo; e <= hi; e += 1) mantissas.forEach((m) => { const v = m * 10 ** e; if (v >= min * 0.999 && v <= max * 1.001) out.push(Number(v.toPrecision(12))); });
      return out;
    };
    for (const set of [[1], [1, 3], [1, 2, 5], [1, 2, 3, 5, 7], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      const t = pick(set);
      if (t.length >= 3 && t.length <= maxTicks) return t;
      if (t.length > maxTicks) {
        const k = Math.ceil(t.length / maxTicks);
        return t.filter((_, i) => i % k === 0);
      }
    }
    const fine = pick([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    if (fine.length >= 2) return fine;
    const spread = [min, Math.sqrt(min * max), max].map((v) => Number(v.toPrecision(2))).filter((v) => v >= min * 0.999 && v <= max * 1.001);
    return [...new Set(spread)];
  }

  // Our own listRepos count, aligned to the users series. A run that finishes early in a UTC day
  // (the 02:37 cron) measures the end of the previous day, the same instant `users` describes.
  function ownCountSeries(dates, ownCount) {
    const out = dates.map(() => null);
    if (!ownCount || !Array.isArray(ownCount.rows)) return out;
    const idx = new Map(dates.map((d, i) => [d, i]));
    for (const r of ownCount.rows) {
      const t = Date.parse(r.finished_at);
      if (!r.complete || !Number.isFinite(t) || !Number.isSafeInteger(r.active)) continue;
      const i = idx.get(new Date(t - 12 * 3600e3).toISOString().slice(0, 10));
      if (i !== undefined) out[i] = r.active;
    }
    return out;
  }

  function latestOwnCount(ownCount) {
    const rows = ownCount && Array.isArray(ownCount.rows) ? ownCount.rows.filter((r) => r.complete) : [];
    if (!rows.length) return null;
    const r = rows[rows.length - 1];
    const net = ownCount.net && ownCount.net.length ? ownCount.net[ownCount.net.length - 1] : null;
    return { ...r, inactive: r.repos - r.active, net: net && net.date === r.date ? net.net_active : null };
  }

  function niceLogTick(value) {
    if (!(value > 0)) return false;
    const mantissa = value / 10 ** Math.floor(Math.log10(value) + 1e-9);
    return [1, 2, 5].some((m) => Math.abs(mantissa - m) < 1e-6);
  }

  // ---------------------------------------------------------------------------
  // Social boards (data/social.js, written by scripts/build-social.js). Everything here treats the
  // file as untrusted: guardrails are re-applied and every string is cleaned before it can render.
  // ---------------------------------------------------------------------------

  const SOCIAL_MIN_FOLLOWERS = 10000;
  const SOCIAL_ADULT_LABELS = ['porn', 'sexual', 'nudity', 'graphic-media', 'gore'];
  const SOCIAL_TOP = 25;
  const SOCIAL_TOP_POSTS = 10;
  const SOCIAL_POST_CHARS = 280;
  const SOCIAL_MIN_CONTROVERSIAL_BLOCKS = 100;
  const SOCIAL_EMBED_KINDS = ['image', 'video', 'quote', 'link'];
  const SOCIAL_NAME_CHARS = 64;
  const SOCIAL_HANDLE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  const SOCIAL_BOARDS = [
    { id: 'blocked', label: 'MOST BLOCKED', windows: ['24h', '7d', 'all'] },
    { id: 'growing', label: 'FASTEST GROWING', windows: ['24h', '7d'] },
    { id: 'followed', label: 'MOST FOLLOWED', windows: [] },
    { id: 'movers', label: 'GAINERS·LOSERS', windows: ['24h', '7d'], dirs: true },
    { id: 'controversial', label: 'CONTROVERSIAL', windows: ['24h', '7d'] }
  ];
  const SOCIAL_WINDOW_LABELS = { '24h': '24 hours', '7d': '7 days', all: 'all time' };
  const SOCIAL_EMPTY = 'Collecting — first data after the next daily run.';
  const SOCIAL_GUARDRAIL = 'Only accounts with at least 10,000 followers and no opt-out or moderation labels are named. Everyone else still counts toward the totals but is never listed.';

  // Controls (C0 except tab/newline), bidi overrides/isolates and zero-width marks are dropped; length is capped.
  function cleanText(value, max, keepNewlines) {
    if (typeof value !== 'string') return '';
    let t = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '');
    t = keepNewlines ? t.replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ');
    t = t.trim();
    const chars = Array.from(t);
    return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : t;
  }

  // Same canonical form as lib/social.js: NFKC (fullwidth '！' becomes '!'), controls and zero-width marks
  // dropped, trimmed, lowercase, so a padded or recased '!hide' or 'Porn' cannot slip past the checks below.
  function normalizeLabel(v) {
    return v.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().toLowerCase();
  }

  function labelVals(labels) {
    if (!Array.isArray(labels)) return [];
    return labels.map((l) => normalizeLabel(typeof l === 'string' ? l : l && typeof l.val === 'string' ? l.val : '')).filter(Boolean);
  }

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function socialMinFollowers(guardrails) {
    const m = guardrails && num(guardrails.min_followers);
    return Math.max(SOCIAL_MIN_FOLLOWERS, m || 0);
  }

  function isEligibleAccount(acc, guardrails) {
    if (!acc || typeof acc !== 'object') return false;
    if (typeof acc.handle !== 'string' || !SOCIAL_HANDLE.test(acc.handle) || /\.invalid$/i.test(acc.handle)) return false;
    const followers = num(acc.followers);
    if (followers == null || followers < socialMinFollowers(guardrails)) return false;
    return !labelVals(acc.labels).some((v) => v.startsWith('!'));
  }

  function socialAdultLabels(guardrails) {
    const extra = guardrails && Array.isArray(guardrails.adult_labels) ? guardrails.adult_labels.filter((v) => typeof v === 'string').map(normalizeLabel).filter(Boolean) : [];
    return new Set([...SOCIAL_ADULT_LABELS, ...extra]);
  }

  function normalizeSocial(raw) {
    if (!raw || typeof raw !== 'object' || raw.schema !== 1) return null;
    if (!raw.accounts || typeof raw.accounts !== 'object' || !raw.boards || typeof raw.boards !== 'object') return null;
    return raw;
  }

  // Avatars come from Bluesky's image CDN only (the page footer says so); anything else shows the placeholder.
  function safeAvatarUrl(url) {
    if (typeof url !== 'string' || url.length > 2048) return null;
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname === 'cdn.bsky.app' && !u.username && !u.password && !u.port ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  const profileUrl = (handle) => `https://bsky.app/profile/${encodeURIComponent(handle)}`;

  const SOCIAL_POST_URI = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~-]{1,64})$/;

  // Link to a post on bsky.app. When authorDid is given the uri must belong to that account, so the handle in
  // the link and the post it points at can never disagree.
  function postUrl(handle, uri, authorDid) {
    const m = SOCIAL_POST_URI.exec(typeof uri === 'string' ? uri : '');
    if (!m || (authorDid !== undefined && m[1] !== authorDid)) return null;
    return `${profileUrl(handle)}/post/${m[2]}`;
  }

  function resolveBoard(board, win, dir) {
    const def = SOCIAL_BOARDS.find((b) => b.id === board) || SOCIAL_BOARDS[0];
    const w = def.windows.includes(win) ? win : (def.windows[0] || null);
    const d = def.dirs ? (dir === 'loss' ? 'loss' : 'gain') : null;
    let key;
    if (def.id === 'followed') key = 'followed';
    else if (def.id === 'movers') key = `${d === 'loss' ? 'losers' : 'gainers'}_${w}`;
    else key = `${def.id}_${w}`;
    return { id: def.id, label: def.label, windows: def.windows, dirs: Boolean(def.dirs), win: w, dir: d, key };
  }

  // Eligible rows of one board, best first, at most SOCIAL_TOP. Ineligible or unresolvable accounts are dropped.
  function socialBoardRows(social, key) {
    const list = social && social.boards && Array.isArray(social.boards[key]) ? social.boards[key] : [];
    const accounts = (social && social.accounts) || {};
    const seen = new Set();
    const out = [];
    for (const r of list) {
      if (!r || typeof r.did !== 'string' || seen.has(r.did) || !hasOwn(accounts, r.did)) continue;
      const value = num(r.value);
      const account = accounts[r.did];
      if (value == null || !isEligibleAccount(account, social.guardrails)) continue;
      const blocks = num(r.blocks);
      const follows = num(r.follows);
      if (/^controversial_/.test(key) && !(blocks != null && blocks >= SOCIAL_MIN_CONTROVERSIAL_BLOCKS && follows != null && follows >= 0)) continue;
      seen.add(r.did);
      out.push({ did: r.did, value, blocks, follows, belowCut: r.follows_below_cut === true, account });
    }
    const ascending = /^losers_/.test(key);
    out.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value));
    return out.slice(0, SOCIAL_TOP);
  }

  function relativeTime(iso, nowMs) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return '—';
    const sec = Math.round((nowMs - t) / 1000);
    if (sec < -300) return '—';
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  function accountAge(iso, nowMs) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t) || !Number.isFinite(nowMs) || t > nowMs) return '—';
    const days = Math.floor((nowMs - t) / DAY_MS);
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    const years = Math.floor(days / 365);
    const months = Math.min(11, Math.floor((days - years * 365) / 30));
    return months ? `${years}y ${months}mo` : `${years}y`;
  }

  // PDS service URL -> { host, kind }; kind is 'bsky' (Bluesky-operated), 'bridgy' (Bridgy Fed) or 'third'.
  function pdsInfo(pds) {
    let host = null;
    try {
      const u = new URL(String(pds));
      if (u.protocol === 'https:' || u.protocol === 'http:') host = u.hostname.toLowerCase();
    } catch (e) {
      host = null;
    }
    if (!host) return null;
    let kind = 'third';
    if (host === 'atproto.brid.gy') kind = 'bridgy';
    else if (host === 'bsky.network' || host.endsWith('.bsky.network') || host === 'bsky.social') kind = 'bsky';
    return { host, kind };
  }

  const PDS_TAGS = { bsky: 'BSKY', bridgy: 'BRIDGY', third: '3RD PARTY' };

  // A lower bound must never display above itself, so it is floored to one decimal, not rounded.
  function floorTenth(v) {
    return Math.floor(Math.floor(v * 100 + 1e-7) / 10) / 10;
  }

  function formatBoardMetric(res, entry) {
    const v = entry.value;
    if (res.id === 'controversial') {
      // belowCut: the account missed a day's follow list, so `follows` is a ceiling and the ratio a floor.
      const fol = entry.belowCut ? `≤${formatInteger(entry.follows)}` : formatInteger(entry.follows);
      const sub = entry.blocks != null && entry.follows != null ? `${formatInteger(entry.blocks)} blk / ${fol} fol` : '';
      return { text: entry.belowCut ? `≥${floorTenth(v).toFixed(1)}×` : `${v.toFixed(2)}×`, sub, tone: '' };
    }
    if (res.id === 'movers') return { text: formatSigned(v, false), sub: '', tone: v < 0 ? 'down' : v > 0 ? 'up' : '' };
    return { text: formatInteger(v), sub: '', tone: '' };
  }

  const SOCIAL_METRIC_HEADS = {
    blocked: 'BLOCKS', growing: 'NEW FOLLOWS', followed: 'FOLLOWERS', movers: 'NET FOLLOWERS', controversial: 'BLOCKS ÷ FOLLOWS'
  };

  function socialMetricHead(res) {
    const base = SOCIAL_METRIC_HEADS[res.id];
    return res.windows.length ? `${base} ${res.win === 'all' ? 'ALL' : res.win.toUpperCase()}` : base;
  }

  // One display row, with raw (unescaped) strings; buildLeaderboardRowsHTML escapes them.
  function socialRowModel(res, entry, rank, nowMs) {
    const a = entry.account;
    const metric = formatBoardMetric(res, entry);
    const pds = pdsInfo(a.pds);
    const month = num(a.posts_this_month);
    const lastPosted = typeof a.last_posted === 'string' && Number.isFinite(Date.parse(a.last_posted)) ? a.last_posted : null;
    const created = typeof a.created_at === 'string' && Number.isFinite(Date.parse(a.created_at)) ? a.created_at : null;
    return {
      rank,
      handle: a.handle,
      name: cleanText(a.display_name, SOCIAL_NAME_CHARS) || a.handle,
      url: profileUrl(a.handle),
      avatar: safeAvatarUrl(a.avatar),
      metric: metric.text, metricSub: metric.sub, tone: metric.tone,
      followers: formatInteger(num(a.followers)),
      posts: formatInteger(num(a.posts)),
      month: month == null ? '—' : `${formatInteger(month)}${a.posts_this_month_capped ? '+' : ''}`,
      monthTitle: a.posts_this_month_capped
        ? `At least ${formatInteger(month)}: counting stopped before reaching the start of the month, so the real number is higher. Own posts including replies, excluding reposts.`
        : 'Own posts this calendar month (UTC), including replies, excluding reposts',
      last: lastPosted ? relativeTime(lastPosted, nowMs) : '—',
      lastTitle: lastPosted ? formatUtcStamp(lastPosted) : 'No post found',
      age: created ? accountAge(created, nowMs) : '—',
      ageTitle: created ? `Created ${formatUtcStamp(created)}` : '',
      pdsHost: pds ? pds.host : '—',
      pdsKind: pds ? pds.kind : '',
      pdsTag: pds ? PDS_TAGS[pds.kind] : ''
    };
  }

  function avatarHTML(url, size) {
    const safe = safeAvatarUrl(url);
    return safe
      ? `<img class="avatar" src="${escapeHtml(safe)}" width="${size}" height="${size}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">`
      : '<span class="avatar avatar-blank" aria-hidden="true"></span>';
  }

  function buildLeaderboardRowsHTML(models) {
    return models.map((m) => {
      const pds = m.pdsKind
        ? `<span class="pds-host" title="${escapeHtml(m.pdsHost)}">${escapeHtml(m.pdsHost)}</span> <span class="pds-tag pds-${m.pdsKind}">${m.pdsTag}</span>`
        : '<span class="pds-host">—</span>';
      return `<tr data-handle="${escapeHtml(m.handle)}">`
        + `<td class="col-rank">${m.rank}</td>`
        + `<td class="col-acct"><a class="acct" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${avatarHTML(m.avatar, 24)}`
        + `<span class="acct-text"><span class="acct-name">${escapeHtml(m.name)}</span><span class="acct-handle">@${escapeHtml(m.handle)}</span>`
        + `<span class="acct-meta">${escapeHtml(m.followers)} followers</span></span></a></td>`
        + `<td class="col-metric ${m.tone}"><span class="metric-main">${escapeHtml(m.metric)}</span>${m.metricSub ? `<span class="metric-sub">${escapeHtml(m.metricSub)}</span>` : ''}</td>`
        + `<td class="col-opt">${escapeHtml(m.followers)}</td>`
        + `<td class="col-opt">${escapeHtml(m.posts)}</td>`
        + `<td class="col-opt" title="${escapeHtml(m.monthTitle)}">${escapeHtml(m.month)}</td>`
        + `<td class="col-opt" title="${escapeHtml(m.lastTitle)}">${escapeHtml(m.last)}</td>`
        + `<td class="col-opt col-xl" title="${escapeHtml(m.ageTitle)}">${escapeHtml(m.age)}</td>`
        + `<td class="col-opt col-xl col-pds">${pds}</td>`
        + '</tr>';
    }).join('\n');
  }

  function boardCaveats(res, social) {
    const w = res.win === '24h' ? '24 hours' : res.win === '7d' ? '7 days' : '';
    const out = [];
    if (res.id === 'blocked' && res.win === 'all') {
      out.push('All-time blocks are recorded since early 2025 (Constellation index). Older blocks are only partly indexed, so true totals are higher.');
    } else if (res.id === 'blocked') {
      out.push(`Blocks received in the last ${w}, counted from the Jetstream firehose. Gross counts: unblocks are not subtracted.`);
    } else if (res.id === 'growing') {
      out.push(`Follows received in the last ${w}, counted from the Jetstream firehose. Gross counts: unfollows are not subtracted.`);
    } else if (res.id === 'followed') {
      out.push('Followers per the Bluesky AppView at the last daily run (exact).');
    } else if (res.id === 'movers') {
      out.push(`Net change in followers over ${w}, from daily snapshots (exact, unfollows included). Needs two snapshots that far apart.`);
    } else if (res.id === 'controversial') {
      out.push(`Blocks received ÷ follows received in the last ${w}, for accounts with at least 100 blocks in the window. Both are gross Jetstream counts. A ratio shown as ≥ means the account fell below the follow list cutoff on at least one day, so its follows are only known to be at most the number shown.`);
    }
    const cov = social && social.coverage;
    if (cov && (res.win === '24h' || res.win === '7d') && (res.id === 'blocked' || res.id === 'growing' || res.id === 'controversial')) {
      if (res.win === '24h' && cov.complete_24h === false) out.push('The latest day was only partly collected, so 24h counts are low.');
      const d7 = num(cov.days_7d);
      if (res.win === '7d' && d7 != null && d7 < 7) out.push(`Only ${d7} of the last 7 days were collected so far, so 7d counts are low.`);
    }
    return out;
  }

  function socialTopPosts(social) {
    const list = social && Array.isArray(social.top_posts) ? social.top_posts : [];
    const accounts = (social && social.accounts) || {};
    const adult = socialAdultLabels(social && social.guardrails);
    const seen = new Set();
    const out = [];
    const day = social && social.day;
    const dayStart = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
    for (const p of list) {
      if (!p || typeof p !== 'object' || typeof p.author !== 'string' || !hasOwn(accounts, p.author) || seen.has(p.uri)) continue;
      const account = accounts[p.author];
      if (!isEligibleAccount(account, social.guardrails)) continue;
      const labels = [...labelVals(p.labels), ...labelVals(account.labels)];
      if (labels.some((v) => v.startsWith('!') || adult.has(v))) continue;
      const url = postUrl(account.handle, p.uri, p.author);
      const likes = num(p.likes);
      if (!url || likes == null) continue;
      const created = typeof p.created_at === 'string' ? Date.parse(p.created_at) : NaN;
      if (Number.isFinite(dayStart) && !(created >= dayStart && created < dayStart + DAY_MS)) continue;
      const text = cleanText(p.text, SOCIAL_POST_CHARS, true);
      seen.add(p.uri);
      out.push({
        uri: p.uri, url, text, account, likes,
        embed: SOCIAL_EMBED_KINDS.includes(p.embed) ? p.embed : null,
        reposts: num(p.reposts), quotes: num(p.quotes), replies: num(p.replies),
        created_at: Number.isFinite(created) ? p.created_at : null
      });
    }
    out.sort((a, b) => b.likes - a.likes);
    return out.slice(0, SOCIAL_TOP_POSTS);
  }

  const PST_PARTIAL = 'The latest day was only partly collected, so posts from the hours not collected may be missing.';

  function postsCaveats(social) {
    return social && social.coverage && social.coverage.complete_24h === false ? [PST_PARTIAL] : [];
  }

  function postsSubtitle(social) {
    const day = postsCaveats(social).length ? 'latest' : 'latest complete';
    return `The 10 most-liked posts created on the ${day} UTC day, by accounts with 10K+ followers. Like counts are exact; candidates come from a sample of the like and repost stream, so a post can be missed. Posts with no text show [image], [video], [quote] or [link].`;
  }

  function buildPostCardsHTML(posts, nowMs) {
    const count = (v) => (v == null ? '—' : formatCompact(v));
    return posts.map((p, i) => {
      const a = p.account;
      const name = cleanText(a.display_name, SOCIAL_NAME_CHARS) || a.handle;
      const when = p.created_at ? relativeTime(p.created_at, nowMs) : '—';
      const whenTitle = p.created_at ? formatUtcStamp(p.created_at) : '';
      return '<li class="post-card">'
        + '<div class="post-head">'
        + `<span class="post-rank">${String(i + 1).padStart(2, '0')}</span>`
        + `<a class="acct" href="${escapeHtml(profileUrl(a.handle))}" target="_blank" rel="noopener">${avatarHTML(a.avatar, 24)}`
        + `<span class="acct-text"><span class="acct-name">${escapeHtml(name)}</span><span class="acct-handle">@${escapeHtml(a.handle)}</span></span></a>`
        + `<a class="post-time" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(whenTitle)}">${escapeHtml(when)}</a>`
        + '</div>'
        + (p.text
          ? `<p class="post-text">${escapeHtml(p.text)}</p>`
          : `<p class="post-text post-text-empty">${escapeHtml(`[${p.embed || 'no text'}]`)}</p>`)
        + '<div class="post-stats">'
        + `<span class="stat-likes"><b>${formatCompact(p.likes)}</b> likes</span>`
        + `<span><b>${count(p.reposts)}</b> reposts</span>`
        + `<span><b>${count(p.quotes)}</b> quotes</span>`
        + `<span><b>${count(p.replies)}</b> replies</span>`
        + `<a class="post-open" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">OPEN <span aria-hidden="true">↗</span></a>`
        + '</div></li>';
    }).join('\n');
  }

  // Share of active accounts on non-Bluesky hosts, from the newest complete own-count row that has third_party.
  function decentralizationModel(ownCount) {
    const rows = ownCount && Array.isArray(ownCount.rows) ? ownCount.rows : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i];
      if (!r || !r.complete || !r.third_party || typeof r.third_party !== 'object') continue;
      const tp = r.third_party;
      const bsky = num(r.active);
      const third = num(tp.active);
      if (bsky == null || third == null || bsky < 0 || third < 0 || bsky + third <= 0) continue;
      const bridgy = Math.min(Math.max(num(tp.bridgy_active) || 0, 0), third);
      const independent = third - bridgy;
      const total = bsky + third;
      const failed = Math.max(num(tp.hosts_failed) || 0, 0);
      const capped = Math.max(num(tp.hosts_capped) || 0, 0);
      return {
        date: r.date, finishedAt: r.finished_at, bsky, independent, bridgy, third, total,
        share: third / total,
        parts: { bsky: bsky / total, independent: independent / total, bridgy: bridgy / total },
        hosts: num(tp.hosts), hostsOk: num(tp.hosts_ok), hostsFailed: failed, hostsCapped: capped, partial: failed > 0 || capped > 0
      };
    }
    return null;
  }

  function formatShare(x) {
    return formatPct(x * 100, x > 0 && x < 0.01 ? 2 : 1);
  }

  function buildDecentralizationHTML(m) {
    const seg = (cls, frac) => (frac > 0 ? `<span class="seg ${cls}" style="width:${(frac * 100).toFixed(4)}%"></span>` : '');
    const item = (cls, name, count, frac, note) => `<li><span class="swatch ${cls}" aria-hidden="true"></span><span class="dec-name">${name}${note ? ` <span class="dec-note">${note}</span>` : ''}</span>`
      + `<span class="dec-num">${formatInteger(count)}</span><span class="dec-pct">${formatShare(frac)}</span></li>`;
    const label = `Active accounts by host: Bluesky-hosted ${formatShare(m.parts.bsky)}, independent PDS ${formatShare(m.parts.independent)}, Bridgy Fed ${formatShare(m.parts.bridgy)}`;
    const notes = [];
    if (m.hosts != null) notes.push(`${m.hostsOk != null ? `${formatInteger(m.hostsOk)} of ${formatInteger(m.hosts)}` : formatInteger(m.hosts)} non-Bluesky hosts answered`);
    if (m.hostsFailed > 0) notes.push(m.hosts != null ? `${formatInteger(m.hostsFailed)} failed and add nothing` : `${formatInteger(m.hostsFailed)} non-Bluesky hosts failed and add nothing`);
    if (m.hostsCapped > 0) notes.push(`${formatInteger(m.hostsCapped)} ${m.hostsCapped === 1 ? 'host was' : 'hosts were'} counted only up to the per-host limit`);
    const hosts = `${notes.join('; ')}${m.partial ? `${notes.length ? ', ' : ''}so the share is a lower bound` : ''}`;
    return '<div class="dec-hero">'
      + `<span class="dec-big tabular-stat">${formatShare(m.share)}</span>`
      + '<span class="dec-big-label">of active accounts are on non-Bluesky PDS hosts</span>'
      + `<span class="dec-sub">${formatShare(m.parts.independent)} on independent PDS hosts, excluding Bridgy Fed</span>`
      + '</div>'
      + '<div class="dec-detail">'
      + `<div class="dec-bar" role="img" aria-label="${escapeHtml(label)}">${seg('seg-bsky', m.parts.bsky)}${seg('seg-indep', m.parts.independent)}${seg('seg-bridgy', m.parts.bridgy)}</div>`
      + '<ul class="dec-legend">'
      + item('seg-bsky', 'Bluesky-hosted', m.bsky, m.parts.bsky, '')
      + item('seg-indep', 'Independent PDS', m.independent, m.parts.independent, 'self-hosted &amp; community servers')
      + item('seg-bridgy', 'Bridgy Fed', m.bridgy, m.parts.bridgy, 'bridged accounts')
      + '</ul>'
      + `<p class="dec-foot">${m.total ? `${formatInteger(m.total)} active accounts counted` : ''}${m.date ? ` on ${formatDay(m.date)}` : ''}${hosts ? ` · ${hosts}` : ''}</p>`
      + '</div>';
  }

  const pure = {
    ACTIVITY_KEYS, RANGES, WAVES, MILESTONES, DEFAULT_STATE, RATIO_MODES, VELOCITY_MODES,
    isoToDayNum, dayNumToIso, addDays, addMonths, daysBetween, parseArchiveDate, escapeHtml,
    mean, pctChange, metricValue, normalizeDays, buildSeries, seriesIndexOf, movingAverage, dailyDeltas,
    calculateMovingAverage, calculateDailyDeltas, calculateGrowthVelocity, calculateRatio,
    generateSparklineSVG, downsample, findWave, isValidRange, getRangeBounds, getPriorBounds,
    filterDataByRange, calculatePeriodComparison, getRangeLabel, getTrendTag, parseHashState,
    serializeHashState, csvCell, buildCSV, buildChartCSV, resetChartZoom, computePrerenderValues,
    computeTickerItems, buildTickerHTML, buildMilestoneRows, buildMilestoneRowsHTML, computeWaveStats, formatChange,
    parseLiveFeed, acceptLiveReading, estimateLiveTotal, buildLiveUrl, syncFaqJsonLd, niceLogTick, trendClass,
    formatAxisCompact, pickDateTicks, formatDateTick, logTicks, linearTicks, ownCountSeries, latestOwnCount,
    SOCIAL_BOARDS, SOCIAL_MIN_FOLLOWERS, SOCIAL_EMPTY, SOCIAL_GUARDRAIL, cleanText, isEligibleAccount, normalizeSocial,
    normalizeLabel, floorTenth, safeAvatarUrl, profileUrl, postUrl, resolveBoard, socialBoardRows, relativeTime, accountAge, pdsInfo, formatBoardMetric,
    socialMetricHead, socialRowModel, buildLeaderboardRowsHTML, boardCaveats, postsCaveats, postsSubtitle, socialTopPosts, buildPostCardsHTML,
    decentralizationModel, buildDecentralizationHTML, formatShare
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = pure;
    return;
  }

  // ---------------------------------------------------------------------------
  // Browser layer
  // ---------------------------------------------------------------------------

  const doc = root.document;
  const $ = (sel, ctx) => (ctx || doc).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || doc).querySelectorAll(sel));
  const reducedMotion = () => Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const app = {
    data: null,
    s: null,
    pre: null,
    state: { ...DEFAULT_STATE },
    lastStdRange: DEFAULT_STATE.range,
    act: { likers: true, posters: true, followers: true, blockers: true },
    rec: { likes: true, posts: true, follows: true, blocks: true },
    charts: {},
    colors: {},
    maCache: {},
    view: null,
    hover: { index: null, source: null },
    live: { reading: null, status: 'archive', timer: null, tick: null, lastFetch: 0 }
  };

  function ma(key) {
    if (!app.maCache[key]) app.maCache[key] = movingAverage(app.s[key]);
    return app.maCache[key];
  }

  function cssVar(name, fallback) {
    const v = root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function readColors() {
    app.colors = {
      users: cssVar('--series-users', '#FFB000'),
      velocity: cssVar('--series-velocity', '#FFB000'),
      ma: cssVar('--series-ma', '#F0F4F8'),
      dau: cssVar('--series-dau', '#0D97FF'),
      likers: cssVar('--series-likers', '#17A8A9'),
      posters: cssVar('--series-posters', '#D00ACA'),
      followers: cssVar('--series-followers', '#9F73FF'),
      blockers: cssVar('--series-blockers', '#E86904'),
      prior: cssVar('--series-prior', '#D97706'),
      gain: cssVar('--color-gain', '#00D26A'),
      loss: cssVar('--color-loss', '#F83F55'),
      grid: cssVar('--chart-grid', 'rgba(255,255,255,0.06)'),
      text: cssVar('--text-secondary', '#9BA3AF'),
      muted: cssVar('--text-muted', '#838D9C'),
      primary: cssVar('--text-primary', '#F0F4F8'),
      surface: cssVar('--bg-surface', '#0F131A'),
      canvas: cssVar('--bg-canvas', '#080A0E'),
      band: cssVar('--chart-outage-band', 'rgba(248, 63, 85, 0.09)'),
      ink: cssVar('--text-inverse', '#080A0E')
    };
    app.colors.likes = app.colors.likers;
    app.colors.posts = app.colors.posters;
    app.colors.follows = app.colors.followers;
    app.colors.blocks = app.colors.blockers;
    app.colors.poster_ratio = app.colors.posters;
    app.colors.posts_per_poster = app.colors.posters;
    app.colors.dau_share = app.colors.dau;
    app.colors.likes_per_liker = app.colors.likers;
  }

  // ---------------- view model ----------------

  function computeView() {
    const s = app.s;
    const first = s.dates[0];
    const last = s.dates[s.length - 1];
    let bounds = getRangeBounds(app.state.range, first, last);
    if (!bounds) {
      app.state.range = DEFAULT_STATE.range;
      bounds = getRangeBounds(app.state.range, first, last);
    }
    const startIdx = seriesIndexOf(s, bounds.start);
    const endIdx = seriesIndexOf(s, bounds.end);
    const prior = app.state.cmp ? getPriorBounds(app.state.range, first, last) : null;
    app.view = { bounds, startIdx, endIdx, length: endIdx - startIdx + 1, prior, wave: findWave(app.state.range) };
    return app.view;
  }

  function slice(arr) {
    return arr.slice(app.view.startIdx, app.view.endIdx + 1);
  }

  function priorSlice(arr) {
    const v = app.view;
    if (!v.prior) return null;
    const out = [];
    for (let i = v.startIdx; i <= v.endIdx; i += 1) {
      const j = i - v.prior.span;
      out.push(j >= 0 ? arr[j] : null);
    }
    return out;
  }

  function firstValidIn(arr, a, b) {
    for (let i = a; i <= b; i += 1) if (arr[i] != null) return i;
    return -1;
  }

  function lastValidIn(arr, a, b) {
    for (let i = b; i >= a; i -= 1) if (arr[i] != null) return i;
    return -1;
  }

  function maTrend(key, a, b, mode) {
    const series = ma(key);
    const i = firstValidIn(series, a, b);
    const j = lastValidIn(series, a, b);
    if (i < 0 || j < 0 || i === j) return null;
    const value = mode === 'pp' ? series[j] - series[i] : pctChange(series[i], series[j]);
    return { value, from: series[i], to: series[j], fromDate: app.s.dates[i], toDate: app.s.dates[j] };
  }

  function windowMean(key, a, b) {
    return mean(app.s[key].slice(Math.max(0, a), b + 1));
  }

  // ---------------- prerender + static blocks ----------------

  function paintPrerender() {
    $$('[data-prerender]').forEach((el) => {
      const key = el.getAttribute('data-prerender');
      if (Object.prototype.hasOwnProperty.call(app.pre, key) && el.childElementCount === 0) setText(el, app.pre[key]);
    });
  }

  // Same text rules as extractFaq() in lib/prerender.js: block ends and <br> become spaces,
  // aria-hidden decorations are dropped from the question.
  function faqText(nodes, skipDecor) {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.data; return; }
      if (n.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(n.tagName)) return;
      if (skipDecor && (n.getAttribute('aria-hidden') === 'true' || n.classList.contains('faq-arrow'))) return;
      if (n.tagName === 'BR') { out += ' '; return; }
      n.childNodes.forEach(walk);
      if (/^(P|LI|DIV|H[1-6])$/.test(n.tagName)) out += ' ';
    };
    nodes.forEach(walk);
    return out.replace(/\s+/g, ' ').trim();
  }

  // The JSON-LD is written by the pre-render, but the visible FAQ numbers are repainted here
  // from the data file. When index.html and the data file come from different builds (a data
  // rebuild without a pre-render, or a cached page), mirror the painted FAQ back into it.
  function syncJsonLd() {
    const el = $('#jsonld');
    if (!el) return;
    let ld;
    try { ld = JSON.parse(el.textContent); } catch (e) { return; }
    const faq = $$('details[class*="faq"]').map((d) => {
      const sum = $('summary', d);
      if (!sum) return null;
      return {
        question: faqText([...sum.childNodes], true),
        answer: faqText([...d.childNodes].filter((n) => n !== sum), false)
      };
    }).filter((f) => f && f.question && f.answer);
    if (syncFaqJsonLd(ld, faq)) el.textContent = JSON.stringify(ld, null, 2);
  }

  function renderTicker() {
    const list = $('#ticker-items');
    if (!list) return;
    const html = buildTickerHTML(computeTickerItems(app.data, app.s));
    if (list.innerHTML.trim() !== html.trim()) list.innerHTML = html;
    const clone = $('#ticker-clone');
    if (clone) clone.innerHTML = html;
  }

  function renderMilestones() {
    const body = $('#milestones-body');
    if (!body) return;
    const html = buildMilestoneRowsHTML(app.data, app.s);
    const norm = (x) => x.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
    const current = body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
    if (norm(current) !== norm(html)) body.innerHTML = html;
  }

  function renderWaveChips() {
    WAVES.forEach((w) => {
      const chip = $(`.wave-chip[data-wave="${w.id}"]`);
      if (!chip) return;
      const st = computeWaveStats(w, app.s);
      const val = $('.chip-val', chip);
      if (st && st.net != null) {
        setText(val, formatSigned(st.net));
        const peak = st.peakDate ? ` Peak day ${formatSigned(st.peakValue)} on ${formatDay(st.peakDate)}${st.peakEst ? ' (estimated)' : ''}.` : '';
        chip.title = `${w.title} · ${w.name}: ${formatSigned(st.net)} new accounts, ${formatDay(w.start)} – ${formatDay(w.end)}.${peak} ${w.note}`;
        chip.setAttribute('aria-label', `${w.title} ${w.name}: ${formatSigned(st.net, false)} new accounts. Filter all charts to this window.`);
      } else {
        setText(val, '—');
      }
    });
  }

  // ---------------- KPI cards ----------------

  function trendBadge(el, value, unit, tag, title) {
    if (!el) return;
    const cls = trendClass(value);
    el.className = `trend ${cls}`;
    const text = value == null ? '—' : (unit === 'pp'
      ? `${value < 0 ? '-' : '+'}${Math.abs(value).toFixed(2)}pp`
      : formatChange(value));
    el.innerHTML = `<span aria-hidden="true">${trendArrow(value)}</span> ${escapeHtml(text)} <span class="trend-tag">${escapeHtml(tag)}</span>`;
    if (title) el.title = title;
  }

  function setSpark(id, values) {
    const path = $(`#${id} path`);
    if (path) path.setAttribute('d', generateSparklineSVG(downsample(values, 120)));
  }

  // `since`: the first date the metric has data. A prior period that starts earlier covers fewer
  // days than the current one, so it is labelled PARTIAL.
  function priorLine(el, text, value, unit, title, since) {
    if (!el) return;
    el.hidden = !app.state.cmp;
    if (!app.state.cmp) return;
    if (!app.view.prior) {
      el.className = 'comparison prior-line';
      el.textContent = app.state.range === 'ALL' ? 'Prior period unavailable for ALL' : 'Prior period unavailable (no earlier data)';
      el.removeAttribute('title');
      return;
    }
    const partial = app.view.prior.start < (since || app.s.dates[0]);
    el.className = `comparison prior-line ${value == null ? '' : (value >= 0 ? 'comp-up' : 'comp-down')}`;
    const delta = value == null ? '' : ` ${trendArrow(value)} ${unit === 'pp' ? `${value < 0 ? '-' : '+'}${Math.abs(value).toFixed(2)}pp` : formatChange(value, 1)}`;
    el.textContent = `${text}${partial ? ' (PARTIAL)' : ''}${delta}`;
    if (title) el.title = partial ? `${title}. The prior period starts before this data begins (${formatDay(since || app.s.dates[0])}), so it covers fewer days.` : title;
  }

  function updateCards() {
    const s = app.s;
    const v = app.view;
    const a = v.startIdx;
    const b = v.endIdx;
    const tag = getTrendTag(app.state.range);
    const rangeTxt = `${formatDay(v.bounds.start)} → ${formatDay(v.bounds.end)}`;
    const pr = v.prior;
    const pa = pr ? Math.max(0, a - pr.span) : 0;
    const pb = pr ? a : 0;
    const priorTxt = pr ? `${formatDay(pr.start)} → ${formatDay(pr.end)}` : '';
    const trendTitle = (t, fmt, label) => (t ? `${label} 7-day average ${fmt(t.from)} on ${formatDay(t.fromDate)} → ${fmt(t.to)} on ${formatDay(t.toDate)}` : 'Not enough data in this range');

    const tu = maTrend('users', a, b);
    trendBadge($('#kpi-users-trend'), tu ? tu.value : null, '%', tag, trendTitle(tu, formatInteger, 'Total users,'));
    const netNow = s.users[b] != null && s.users[a] != null ? s.users[b] - s.users[a] : null;
    const days = Math.max(1, b - a);
    const usersComp = $('#kpi-users-comp');
    setText(usersComp, netNow == null ? '—' : `${formatSigned(netNow)} in range · ${formatSigned(netNow / days)}/day avg`);
    if (usersComp) usersComp.title = `Change in total users, ${rangeTxt}`;
    const own = latestOwnCount(app.data && app.data.own_count);
    const ownEl = $('#kpi-users-own');
    if (ownEl) {
      ownEl.hidden = !own;
      if (own) {
        setText(ownEl, `OWN COUNT ${formatCompact(own.active)}\u00a0active · ${formatCompact(own.inactive)}\u00a0inactive${own.net == null ? '' : ` · net\u00a0${formatSigned(own.net)}/day`}`);
        ownEl.title = `Our own count of every account on Bluesky-operated servers (${formatUtcStamp(own.finished_at)}): ${formatInteger(own.active)} active, ${formatInteger(own.deactivated)} deactivated, ${formatInteger(own.takendown)} taken down, ${formatInteger(own.repos - own.active - own.deactivated - own.takendown)} other. Unlike Jaz's counter, it drops accounts that leave, so day-to-day change is net growth.`;
      }
    }
    const netPrior = pr && s.users[pb] != null && s.users[pa] != null && pa < pb ? s.users[pb] - s.users[pa] : null;
    priorLine($('#kpi-users-prior'), `PRIOR ${formatSigned(netPrior)}`, pctChange(netPrior, netNow), '%', `Prior period ${priorTxt}: ${formatSigned(netPrior, false)} new accounts`);
    setSpark('spark-users', slice(s.users));

    const tv = maTrend('new_users', a, b);
    trendBadge($('#kpi-velocity-trend'), tv ? tv.value : null, '%', tag, trendTitle(tv, (x) => `${formatSigned(x)}/day`, 'User velocity,'));
    const velNow = windowMean('new_users', a + 1, b);
    const velPrior = pr ? windowMean('new_users', pa + 1, pb) : null;
    priorLine($('#kpi-velocity-prior'), `PRIOR AVG ${formatSigned(velPrior)}/day`, pctChange(velPrior, velNow), '%', `Average new accounts per day: ${formatSigned(velNow)} (${rangeTxt}) vs ${formatSigned(velPrior)} (${priorTxt})`);
    setSpark('spark-velocity', slice(ma('new_users')));

    const activitySince = app.data.activity_start || '2023-03-01';
    [['dau', 'DAU (lower bound),'], ['posters', 'Daily posters,']].forEach(([key, label]) => {
      const t = maTrend(key, a, b);
      trendBadge($(`#kpi-${key}-trend`), t ? t.value : null, '%', tag, trendTitle(t, formatCompact, label));
      const now = windowMean(key, a + 1, b);
      const prev = pr ? windowMean(key, pa + 1, pb) : null;
      priorLine($(`#kpi-${key}-prior`), `PRIOR AVG ${formatCompact(prev)}`, pctChange(prev, now), '%', `Average per day: ${formatCompact(now)} (${rangeTxt}) vs ${formatCompact(prev)} (${priorTxt})`, activitySince);
      setSpark(`spark-${key}`, slice(ma(key)));
    });

    const tr = maTrend('poster_ratio', a, b, 'pp');
    trendBadge($('#kpi-ratio-trend'), tr ? tr.value : null, 'pp', tag, trendTitle(tr, (x) => formatPct(x, 1), 'Poster ratio,'));
    const rNow = windowMean('poster_ratio', a + 1, b);
    const rPrev = pr ? windowMean('poster_ratio', pa + 1, pb) : null;
    priorLine($('#kpi-ratio-prior'), `PRIOR AVG ${formatPct(rPrev, 1)}`, rNow != null && rPrev != null ? rNow - rPrev : null, 'pp', `Average poster ratio: ${formatPct(rNow, 1)} (${rangeTxt}) vs ${formatPct(rPrev, 1)} (${priorTxt})`, activitySince);
    setSpark('spark-ratio', slice(ma('poster_ratio')));
  }

  // ---------------- count-up + live value ----------------

  function animateNumber(el, from, to, duration) {
    if (!el) return;
    if (el._raf) root.cancelAnimationFrame(el._raf);
    if (reducedMotion() || from === to || from == null) { setText(el, formatInteger(to)); return; }
    const t0 = root.performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = p === 1 ? 1 : 1 - 2 ** (-10 * p);
      setText(el, formatInteger(Math.round(from + (to - from) * eased)));
      if (p < 1) el._raf = root.requestAnimationFrame(step);
      else el._raf = null;
    };
    el._raf = root.requestAnimationFrame(step);
  }

  function setStatus(mode, detail) {
    const wrap = $('#status-indicator');
    const label = $('#data-status');
    if (!wrap || !label) return;
    wrap.classList.remove('live', 'archive', 'error');
    wrap.classList.add(mode);
    setText(label, mode === 'live' ? 'LIVE' : (mode === 'error' ? 'DATA ERROR' : 'ARCHIVE'));
    wrap.title = detail || '';
    const sr = $('#status-detail');
    if (sr) setText(sr, detail || '');
  }

  function velocityPace() {
    return mean(app.s.new_users.slice(-7));
  }

  function paintLiveTotal(animate) {
    const reading = app.live.reading;
    const el = $('#kpi-users-value');
    if (!reading || !el) return;
    const now = Date.now();
    const est = estimateLiveTotal(reading, velocityPace(), now);
    const shown = Math.max(est, reading.count);
    const isEst = shown > reading.count;
    const prevShown = Number((el.textContent || '').replace(/[^\d]/g, '')) || null;
    if (animate) animateNumber(el, prevShown, shown, 900);
    else setText(el, formatInteger(shown));
    const estChip = $('#kpi-users-est');
    if (estChip) estChip.hidden = !isEst;
    const tickVal = $$('.tick[data-tick="users"] .tick-val');
    tickVal.forEach((t) => setText(t, formatInteger(shown)));
    const stamp = new Date(reading.at).toISOString().slice(11, 16);
    const note = $('#kpi-users-note');
    if (note) {
      setText(note, isEst
        ? `LIVE ${formatInteger(reading.count)} @ ${stamp} UTC + 7D PACE`
        : `LIVE @ ${stamp} UTC · @hourlybskyusers`);
      note.hidden = false;
    }
    el.title = isEst
      ? `Estimate: last live reading ${formatInteger(reading.count)} at ${stamp} UTC plus the 7-day average pace (${formatSigned(velocityPace())}/day). Never extrapolated more than 3 hours.`
      : `Live reading from @hourlybskyusers.bsky.social at ${stamp} UTC (relays Jaz’s counter).`;
  }

  async function fetchLive() {
    const src = app.data && app.data.live_source;
    if (!src || src.type !== 'bsky-author-feed' || !src.actor || typeof root.fetch !== 'function') return;
    if (doc.visibilityState === 'hidden') return;
    app.live.lastFetch = Date.now();
    const ctrl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    const timer = root.setTimeout(() => { if (ctrl) ctrl.abort(); }, 5000);
    try {
      const res = await root.fetch(buildLiveUrl(src, 5), { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const reading = parseLiveFeed(json, src.pattern);
      if (!acceptLiveReading(reading, app.data.snapshot, Date.now())) return;
      const first = !app.live.reading;
      if (app.live.reading && reading.at <= app.live.reading.at) return;
      app.live.reading = reading;
      app.live.status = 'live';
      setStatus('live', `Live user count ${formatInteger(reading.count)} at ${new Date(reading.at).toISOString().slice(0, 16).replace('T', ' ')} UTC from @hourlybskyusers.bsky.social`);
      const chip = $('#kpi-users-chip');
      if (chip) { setText(chip, 'LIVE'); chip.className = 'metric-chip chip-live'; }
      paintLiveTotal(first);
      if (!app.live.tick) app.live.tick = root.setInterval(() => paintLiveTotal(false), reducedMotion() ? 5000 : 1000);
    } catch (e) {
      // Archive mode stays on silently; the archived snapshot is still correct.
    } finally {
      root.clearTimeout(timer);
    }
  }

  function startLive() {
    fetchLive();
    app.live.timer = root.setInterval(fetchLive, 10 * 60 * 1000);
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible' && Date.now() - app.live.lastFetch > 10 * 60 * 1000) fetchLive();
    });
  }

  // ---------------- clock ----------------

  function startClock() {
    const utcEl = $('#clock-utc');
    const localEl = $('#clock-local');
    const dateEl = $('#clock-date');
    let tz = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
      tz = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
    } catch (e) { tz = ''; }
    const pad = (n) => String(n).padStart(2, '0');
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const tickClock = () => {
      const d = new Date();
      setText(utcEl, `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
      setText(localEl, `${pad(d.getHours())}:${pad(d.getMinutes())}${tz ? ` ${tz}` : ''}`);
      setText(dateEl, `${days[d.getUTCDay()]} ${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
    };
    tickClock();
    root.setInterval(tickClock, 1000);
  }

  // ---------------- charts ----------------

  const CHART_IDS = { velocity: 'velocityChart', dau: 'dauChart', act: 'actChart', rec: 'recChart', rat: 'ratChart', tot: 'totChart' };
  const CHART_NAMES = { velocity: 'user-velocity', dau: 'daily-active-users-posters', act: 'firehose-actors', rec: 'daily-records', rat: 'ratios', tot: 'total-users' };
  const CHART_TITLES = {
    velocity: 'USR · User velocity', dau: 'DAU · Daily active users & posters', act: 'ACT · Firehose actors',
    rec: 'REC · Daily records', rat: 'RAT · Ratios', tot: 'TOT · Total users'
  };
  const LOG_CHARTS = ['velocity', 'dau', 'act', 'rec', 'tot'];

  function ratioFormatter(key) {
    if (key === 'poster_ratio') return (x) => formatPct(x, 1);
    if (key === 'dau_share') return (x) => formatPct(x, 2);
    return (x) => (x == null ? '—' : x.toFixed(2));
  }

  function hatchPattern(color, alpha) {
    const c = doc.createElement('canvas');
    c.width = 6;
    c.height = 6;
    const ctx = c.getContext('2d');
    ctx.fillStyle = hexToRgba(color, alpha * 0.45);
    ctx.fillRect(0, 0, 6, 6);
    ctx.strokeStyle = hexToRgba(color, Math.min(1, alpha * 1.6));
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(-1, 7); ctx.lineTo(7, -1);
    ctx.moveTo(-1, 1); ctx.lineTo(1, -1);
    ctx.moveTo(5, 7); ctx.lineTo(7, 5);
    ctx.stroke();
    return ctx.createPattern(c, 'repeat');
  }

  function areaGradient(color, alphaTop) {
    const cache = {};
    return (context) => {
      const { chart } = context;
      const area = chart.chartArea;
      if (!area) return 'transparent';
      const key = `${area.top}|${area.bottom}`;
      if (!cache[key]) {
        const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, hexToRgba(color, alphaTop));
        g.addColorStop(1, hexToRgba(color, 0));
        cache[key] = g;
      }
      return cache[key];
    };
  }

  function lineDataset(label, data, color, extra) {
    return Object.assign({
      type: 'line', label, data, borderColor: color, backgroundColor: color, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: app.colors.surface,
      pointHoverBackgroundColor: color, tension: 0, spanGaps: false, fill: false
    }, extra || {});
  }

  function rawLine(key, label, color, opts) {
    const o = opts || {};
    const smooth = app.state.ma;
    return lineDataset(label, slice(app.s[key]), smooth ? hexToRgba(color, 0.4) : color, {
      borderWidth: smooth ? 1.25 : 2,
      pointHoverRadius: smooth ? 0 : 4,
      metaKey: key,
      role: 'raw',
      tag: !smooth && o.tag !== false,
      fill: o.fill ? 'origin' : false,
      backgroundColor: o.fill ? areaGradient(color, 0.1) : color,
      order: 3
    });
  }

  function maLine(key, label, color, opts) {
    const o = opts || {};
    return lineDataset(`${label} 7D avg`, slice(ma(key)), color, {
      borderWidth: 2, metaKey: key, role: 'ma', tag: o.tag !== false, order: 2
    });
  }

  function priorLines(keys, labelFor) {
    if (!app.view.prior) return [];
    return keys.map((key) => lineDataset(`Prior period · ${labelFor(key)}`, priorSlice(app.state.ma ? ma(key) : app.s[key]), app.colors.prior, {
      borderWidth: 1.5, borderDash: [5, 4], metaKey: key, role: 'prior', order: 1, pointHoverRadius: 3
    }));
  }

  function seriesSet(keys, labels, extra) {
    const out = [];
    keys.forEach((k, i) => {
      out.push(rawLine(k, labels[i], app.colors[k], extra && extra[k]));
      if (app.state.ma) out.push(maLine(k, labels[i], app.colors[k]));
    });
    return out;
  }

  function buildDatasets(key) {
    const st = app.state;
    const s = app.s;
    if (key === 'velocity') {
      const metric = st.vm === 'pct' ? 'growth_pct' : 'new_users';
      const values = slice(s[metric]);
      const est = slice(s.newEst);
      const c = app.colors.velocity;
      const pos = hexToRgba(c, 0.78);
      const neg = hexToRgba(app.colors.loss, 0.85);
      if (!app.patterns) app.patterns = { pos: hatchPattern(c, 0.55), neg: hatchPattern(app.colors.loss, 0.6) };
      const bg = values.map((v, i) => {
        const negative = v != null && v < 0;
        if (est[i]) return negative ? app.patterns.neg : app.patterns.pos;
        return negative ? neg : pos;
      });
      const wide = app.view.length <= 120;
      const sets = [{
        type: 'bar', label: st.vm === 'pct' ? 'Growth % per day' : 'New accounts per day', data: values,
        backgroundColor: bg, hoverBackgroundColor: values.map((v) => (v != null && v < 0 ? app.colors.loss : c)),
        borderRadius: wide ? { topLeft: 2, topRight: 2 } : 0, borderSkipped: 'start', maxBarThickness: 24,
        barPercentage: wide ? 0.82 : 1, categoryPercentage: 1, metaKey: metric, role: 'raw', order: 3, grouped: false
      }];
      if (st.ma) sets.push(lineDataset('7D avg', slice(ma(metric)), app.colors.ma, { borderWidth: 2, metaKey: metric, role: 'ma', tag: true, order: 1 }));
      if (app.view.prior) {
        sets.push(lineDataset(`Prior period · ${st.ma ? '7D avg' : 'daily'}`, priorSlice(st.ma ? ma(metric) : s[metric]), app.colors.prior, {
          borderWidth: 1.5, borderDash: [5, 4], metaKey: metric, role: 'prior', order: 0, pointHoverRadius: 3
        }));
      }
      return sets;
    }
    if (key === 'dau') {
      return seriesSet(['dau', 'posters'], ['DAU', 'Posters'], { dau: { fill: zeroBased('dau') } })
        .concat(priorLines(['dau', 'posters'], (k) => (k === 'dau' ? 'DAU' : 'Posters')));
    }
    if (key === 'act') {
      const keys = ['likers', 'posters', 'followers', 'blockers'].filter((k) => app.act[k]);
      return seriesSet(keys, keys.map((k) => METRIC_LABELS[k])).concat(priorLines(keys, (k) => METRIC_LABELS[k]));
    }
    if (key === 'rec') {
      const keys = ['likes', 'posts', 'follows', 'blocks'].filter((k) => app.rec[k]);
      return seriesSet(keys, keys.map((k) => METRIC_LABELS[k])).concat(priorLines(keys, (k) => METRIC_LABELS[k]));
    }
    if (key === 'rat') {
      const k = st.rm;
      return seriesSet([k], [METRIC_LABELS[k]]).concat(priorLines([k], (x) => METRIC_LABELS[x]));
    }
    if (key === 'tot') {
      const c = app.colors.users;
      const est = slice(s.usersEst);
      const sets = [lineDataset('Total users', slice(s.users), c, {
        metaKey: 'users', role: 'raw', tag: true,
        segment: { borderDash: (ctx) => (est[ctx.p0DataIndex] || est[ctx.p1DataIndex] ? [4, 3] : undefined) },
        order: 2
      })];
      const own = slice(s.ownActive || []);
      if (own.some((v) => v != null)) {
        sets.push(lineDataset('Active accounts (own count)', own, app.colors.gain, {
          metaKey: 'ownActive', role: 'raw', spanGaps: true, pointRadius: 3, pointBackgroundColor: app.colors.gain, order: 1
        }));
      }
      if (app.view.prior) {
        sets.push(lineDataset('Prior period · Total users', priorSlice(s.users), app.colors.prior, {
          borderWidth: 1.5, borderDash: [5, 4], metaKey: 'users', role: 'prior', order: 1, pointHoverRadius: 3
        }));
      }
      return sets;
    }
    return [];
  }

  function bandKeysFor(key) {
    if (key === 'dau') return ['likers', 'posters'];
    if (key === 'act') return ['likers', 'posters', 'followers', 'blockers'].filter((k) => app.act[k]);
    if (key === 'rec') return ['likes', 'posts', 'follows', 'blocks'].filter((k) => app.rec[k]);
    if (key === 'rat') {
      return {
        poster_ratio: ['likers', 'posters'], dau_share: ['likers', 'posters'],
        posts_per_poster: ['posts', 'posters'], likes_per_liker: ['likes', 'likers']
      }[app.state.rm];
    }
    return [];
  }

  function outageFlagsAt(key, gi) {
    const keys = bandKeysFor(key);
    if (!keys.length || gi < 0) return [];
    if (app.s.missing[gi]) return keys.slice();
    const flags = app.s.flags[gi];
    return keys.filter((k) => flags.includes(k));
  }

  function xAfterBuildTicks(scale) {
    const labels = scale.chart.data.labels || [];
    if (!labels.length) return;
    const lo = Math.max(0, Math.ceil(scale.min));
    const hi = Math.min(labels.length - 1, Math.floor(scale.max));
    const width = (scale.chart.chartArea && scale.chart.chartArea.width) || scale.chart.width - 80;
    const picked = pickDateTicks(labels, lo, hi, Math.floor(width / 58));
    scale.$tickKind = picked.kind;
    scale.ticks = picked.indices.map((i) => ({ value: i }));
  }

  function xTickFormatter() {
    return function (value) {
      return formatDateTick(this.getLabelForValue(value), this.$tickKind);
    };
  }

  function yTickFormatter(chartKey) {
    return function (value) {
      if (chartKey === 'velocity') {
        if (app.state.vm === 'pct') return value === 0 ? '0%' : `${value > 0 ? '+' : ''}${Number(value.toPrecision(3))}%`;
        return value === 0 ? '0' : `${value > 0 ? '+' : ''}${formatAxisCompact(value)}`;
      }
      if (chartKey === 'rat') {
        if (app.state.rm === 'poster_ratio' || app.state.rm === 'dau_share') return `${Number(value.toPrecision(3))}%`;
        return Number(value.toPrecision(3)).toString();
      }
      return formatAxisCompact(value);
    };
  }

  function wantsLog(key) {
    return app.state.log && LOG_CHARTS.includes(key);
  }

  // Bars always start at zero; line panels do too on long ranges (magnitude), but float on
  // short ones so a week of DAU isn't a flat line.
  function zeroBased(key) {
    if (wantsLog(key)) return false;
    if (key === 'velocity') return true;
    return ['dau', 'act', 'rec'].includes(key) && app.view && app.view.length > 100;
  }

  function applyScales(chart, key) {
    const y = chart.options.scales.y;
    const log = wantsLog(key);
    y.type = log ? 'logarithmic' : 'linear';
    y.beginAtZero = zeroBased(key);
    // With zeros in view (early 2022) Chart.js drops a log axis one decade below the smallest
    // value, which would label "+0.1" accounts a day. Whole accounts start at 1.
    if (key === 'velocity') {
      const tiny = log && app.state.vm === 'new' && slice(app.s.new_users).some((v) => v != null && v < 10);
      y.min = tiny ? 1 : undefined;
    }
  }

  // Shared crosshair: hovering any panel draws the same date's hairline on every panel.
  const crosshairPlugin = {
    id: 'bskyCrosshair',
    afterEvent(chart, args) {
      const e = args.event;
      if (e.type === 'mouseout') {
        if (app.hover.source === chart) { app.hover.index = null; app.hover.source = null; redrawOthers(chart); }
        return;
      }
      if (e.type !== 'mousemove') return;
      const area = chart.chartArea;
      if (!area || e.x < area.left || e.x > area.right || e.y < area.top || e.y > area.bottom) {
        if (app.hover.source === chart && app.hover.index != null) { app.hover.index = null; redrawOthers(chart); }
        return;
      }
      const idx = Math.round(chart.scales.x.getValueForPixel(e.x));
      if (idx !== app.hover.index || app.hover.source !== chart) {
        app.hover.index = idx;
        app.hover.source = chart;
        redrawOthers(chart);
      }
    },
    afterDatasetsDraw(chart) {
      if (app.exporting) return;
      const idx = app.hover.index;
      const active = chart.tooltip && chart.tooltip.getActiveElements().length ? chart.tooltip.getActiveElements()[0].index : null;
      const at = active != null ? active : idx;
      if (at == null) return;
      const x = chart.scales.x;
      if (at < x.min || at > x.max) return;
      const px = x.getPixelForValue(at);
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = hexToRgba(app.colors.primary, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, area.top);
      ctx.lineTo(Math.round(px) + 0.5, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  // Only charts on screen follow the hairline: redrawing all six on every mouse move is a long
  // task on ALL. A chart that scrolls into view is redrawn, so it never shows a stale hairline.
  const onScreen = new Set();
  function watchVisibility(chart) {
    if (typeof root.IntersectionObserver !== 'function') { onScreen.add(chart); return; }
    if (!app.visibility) {
      app.visibility = new root.IntersectionObserver((entries) => entries.forEach((en) => {
        const c = Object.values(app.charts).find((x) => x.canvas === en.target);
        if (!c) return;
        if (en.isIntersecting) { onScreen.add(c); c.draw(); } else onScreen.delete(c);
      }));
    }
    app.visibility.observe(chart.canvas);
  }

  let redrawQueued = false;
  function redrawOthers(source) {
    if (redrawQueued) return;
    redrawQueued = true;
    root.requestAnimationFrame(() => {
      redrawQueued = false;
      Object.values(app.charts).forEach((c) => { if (c !== source && onScreen.has(c)) c.draw(); });
    });
  }

  // Outage columns: full-height wash when every plotted series is missing that day, a
  // fainter wash plus a baseline strip when only some of them are (e.g. blocks only).
  const outageBandPlugin = {
    id: 'bskyOutageBands',
    beforeDatasetsDraw(chart) {
      const key = chart.$bskyKey;
      if (!key || !app.view) return;
      const total = bandKeysFor(key).length;
      if (!total) return;
      const x = chart.scales.x;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      const half = x.width / Math.max(1, (x.max - x.min + 1)) / 2;
      ctx.save();
      for (let i = Math.max(0, Math.floor(x.min)); i <= Math.min(app.view.length - 1, Math.ceil(x.max)); i += 1) {
        const n = outageFlagsAt(key, app.view.startIdx + i).length;
        if (!n) continue;
        const px = x.getPixelForValue(i);
        const left = Math.max(area.left, px - half);
        const w = Math.max(1, Math.min(area.right, px + half) - left);
        if (n >= total) {
          ctx.fillStyle = app.colors.band;
          ctx.fillRect(left, area.top, w, area.bottom - area.top);
        } else {
          ctx.fillStyle = hexToRgba(app.colors.loss, 0.035);
          ctx.fillRect(left, area.top, w, area.bottom - area.top);
          ctx.fillStyle = hexToRgba(app.colors.loss, 0.55);
          ctx.fillRect(left, area.bottom - 3, w, 3);
        }
      }
      ctx.restore();
    }
  };

  function luminance(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!m) return 0;
    const ch = [m[1], m[2], m[3]].map((h) => {
      const c = parseInt(h, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  // Bloomberg-style last-value tags in the right gutter, nudged apart with leader lines.
  const lastValueTagPlugin = {
    id: 'bskyLastValueTags',
    afterDatasetsDraw(chart) {
      const key = chart.$bskyKey;
      if (!key) return;
      const area = chart.chartArea;
      const x = chart.scales.x;
      const y = chart.scales.y;
      const ctx = chart.ctx;
      const tags = [];
      chart.data.datasets.forEach((ds, di) => {
        if (!ds.tag || !chart.isDatasetVisible(di)) return;
        const hi = Math.min(ds.data.length - 1, Math.floor(x.max));
        let i = hi;
        while (i >= Math.ceil(x.min) && ds.data[i] == null) i -= 1;
        if (i < Math.ceil(x.min) || ds.data[i] == null) return;
        const v = ds.data[i];
        if (y.type === 'logarithmic' && !(v > 0)) return;
        const py = y.getPixelForValue(v);
        if (py < area.top - 1 || py > area.bottom + 1) return;
        const color = ds.metaKey && app.colors[ds.metaKey] && ds.role !== 'ma' ? app.colors[ds.metaKey]
          : (typeof ds.borderColor === 'string' && ds.borderColor.startsWith('#') ? ds.borderColor : app.colors.ma);
        tags.push({ py, y: py, text: tagText(key, ds, v), color });
      });
      if (!tags.length) return;
      tags.sort((a, b) => a.py - b.py);
      const h = 15;
      for (let k = 1; k < tags.length; k += 1) if (tags[k].y - tags[k - 1].y < h + 1) tags[k].y = tags[k - 1].y + h + 1;
      const overflow = tags[tags.length - 1].y + h / 2 - (area.bottom + 6);
      if (overflow > 0) tags.forEach((t) => { t.y -= overflow; });
      ctx.save();
      ctx.font = `600 10px ${cssVar('--font-mono', 'monospace')}`;
      ctx.textBaseline = 'middle';
      tags.forEach((t) => {
        const w = ctx.measureText(t.text).width + 8;
        const left = area.right + 4;
        if (Math.abs(t.y - t.py) > 1) {
          ctx.strokeStyle = hexToRgba(t.color, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(area.right, t.py);
          ctx.lineTo(left, t.y);
          ctx.stroke();
        }
        ctx.fillStyle = t.color;
        ctx.fillRect(left, t.y - h / 2, w, h);
        ctx.fillStyle = luminance(t.color) > 0.18 ? app.colors.ink : '#FFFFFF';
        ctx.fillText(t.text, left + 4, t.y + 0.5);
      });
      ctx.restore();
    }
  };

  function tagText(chartKey, ds, v) {
    if (chartKey === 'velocity') return app.state.vm === 'pct' ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}%` : formatSigned(v);
    if (chartKey === 'rat') return ratioFormatter(app.state.rm)(v);
    return formatCompact(v);
  }

  // Selective direct label: the extreme bar in view.
  const peakLabelPlugin = {
    id: 'bskyPeakLabel',
    afterDatasetsDraw(chart) {
      if (chart.$bskyKey !== 'velocity') return;
      const ds = chart.data.datasets[0];
      const meta = chart.getDatasetMeta(0);
      if (!ds || !meta || !meta.data.length) return;
      const x = chart.scales.x;
      let best = -1;
      for (let i = Math.max(0, Math.ceil(x.min)); i <= Math.min(ds.data.length - 1, Math.floor(x.max)); i += 1) {
        if (ds.data[i] != null && (best < 0 || ds.data[i] > ds.data[best])) best = i;
      }
      if (best < 0 || !(ds.data[best] > 0)) return;
      const bar = meta.data[best];
      if (!bar) return;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      const gi = app.view.startIdx + best;
      const val = app.state.vm === 'pct' ? `+${ds.data[best].toFixed(3)}%` : formatSigned(ds.data[best]);
      const est = app.s.newEst[gi] ? ' (est.)' : '';
      ctx.save();
      ctx.font = `600 10px ${cssVar('--font-mono', 'monospace')}`;
      // Right of the bar, else left of it; on narrow charts drop the date, then the word PEAK.
      let text = '';
      let w = 0;
      let left = null;
      for (const t of [`PEAK ${val} · ${formatDay(app.s.dates[gi])}${est}`, `PEAK ${val}${est}`, `${val}${est}`]) {
        text = t;
        w = ctx.measureText(t).width;
        if (bar.x + 6 + w <= area.right - 2) { left = bar.x + 6; break; }
        if (bar.x - 6 - w >= area.left + 2) { left = bar.x - 6 - w; break; }
      }
      if (left == null) left = Math.max(area.left + 2, Math.min(area.right - 2 - w, bar.x - w / 2));
      const ty = bar.y - 10 > area.top + 7 ? bar.y - 10 : Math.max(area.top + 8, bar.y + 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hexToRgba(app.colors.surface, 0.85);
      ctx.fillRect(left - 3, ty - 7, w + 6, 14);
      ctx.fillStyle = app.colors.primary;
      ctx.fillText(text, left, ty);
      ctx.restore();
    }
  };

  function hudRowsFor(chartKey, idx) {
    const s = app.s;
    const gi = app.view.startIdx + idx;
    const rows = [];
    const notes = [];
    const fmtDelta = (val, prev, f) => (val != null && prev != null ? `Δ ${f(val - prev)}` : '');
    const signedCompact = (d) => formatSigned(d);
    if (chartKey === 'velocity') {
      const metric = app.state.vm === 'pct' ? 'growth_pct' : 'new_users';
      const v = s[metric][gi];
      const m = ma(metric)[gi];
      if (metric === 'new_users') {
        rows.push({ color: app.colors.velocity, label: 'New accounts', value: formatSigned(v, false), sub: fmtDelta(v, s.new_users[gi - 1], signedCompact) });
        rows.push({ color: app.colors.ma, line: true, label: '7D avg', value: m == null ? '—' : `${formatSigned(m)}/day` });
        rows.push({ label: 'Growth', value: s.growth_pct[gi] == null ? '—' : `${s.growth_pct[gi] >= 0 ? '+' : ''}${s.growth_pct[gi].toFixed(3)}%` });
      } else {
        rows.push({ color: app.colors.velocity, label: 'Growth', value: v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`, sub: s.new_users[gi] == null ? '' : `${formatSigned(s.new_users[gi])} accts` });
        rows.push({ color: app.colors.ma, line: true, label: '7D avg', value: m == null ? '—' : `${m >= 0 ? '+' : ''}${m.toFixed(3)}%` });
      }
      rows.push({ label: 'Total users', value: formatInteger(s.users[gi]) });
      if (app.view.prior) {
        const pj = gi - app.view.prior.span;
        const pv = pj >= 0 ? (app.state.ma ? ma(metric)[pj] : s[metric][pj]) : null;
        rows.push({ color: app.colors.prior, dash: true, label: `Prior · ${pj >= 0 ? formatDay(s.dates[pj]) : '—'}`, value: pv == null ? '—' : (metric === 'growth_pct' ? `${pv.toFixed(3)}%` : formatSigned(pv)) });
      }
      if (s.newEst[gi]) notes.push(`≈ Estimated (${SOURCE_LABELS[s.usersSrc[gi]] || s.usersSrc[gi] || 'interpolated'})`);
      if (s.new_users[gi] == null && gi > 0) notes.push('No value for this day');
      return { rows, notes };
    }
    if (chartKey === 'tot') {
      rows.push({ color: app.colors.users, line: true, label: 'Total users', value: formatInteger(s.users[gi]), sub: s.new_users[gi] == null ? '' : `Δ ${formatSigned(s.new_users[gi])}` });
      if (s.ownActive && s.ownActive[gi] != null) rows.push({ color: app.colors.gain, line: true, label: 'Active (own count)', value: formatInteger(s.ownActive[gi]) });
      if (app.view.prior) {
        const pj = gi - app.view.prior.span;
        rows.push({ color: app.colors.prior, dash: true, label: `Prior · ${pj >= 0 ? formatDay(s.dates[pj]) : '—'}`, value: pj >= 0 ? formatInteger(s.users[pj]) : '—' });
      }
      if (s.usersEst[gi]) notes.push(`≈ Estimated (${SOURCE_LABELS[s.usersSrc[gi]] || s.usersSrc[gi] || 'interpolated'})`);
      else if (s.usersSrc[gi]) notes.push(`Source: ${SOURCE_LABELS[s.usersSrc[gi]] || s.usersSrc[gi]}`);
      return { rows, notes };
    }
    const keys = chartKey === 'dau' ? ['dau', 'posters']
      : chartKey === 'act' ? ['likers', 'posters', 'followers', 'blockers'].filter((k) => app.act[k])
        : chartKey === 'rec' ? ['likes', 'posts', 'follows', 'blocks'].filter((k) => app.rec[k])
          : [app.state.rm];
    const fmt = chartKey === 'rat' ? ratioFormatter(app.state.rm) : formatCompact;
    const fmtD = chartKey === 'rat'
      ? (d) => (app.state.rm === 'poster_ratio' || app.state.rm === 'dau_share' ? `${d >= 0 ? '+' : ''}${d.toFixed(2)}pp` : `${d >= 0 ? '+' : ''}${d.toFixed(2)}`)
      : signedCompact;
    keys.forEach((k) => {
      const v = s[k][gi];
      const m = ma(k)[gi];
      const sub = [fmtDelta(v, s[k][gi - 1], fmtD), m == null ? '' : `7D ${fmt(m)}`].filter(Boolean).join(' · ');
      rows.push({ color: app.colors[k], line: true, label: METRIC_LABELS[k], value: v == null ? 'gap' : fmt(v), sub });
    });
    if (app.view.prior) {
      const pj = gi - app.view.prior.span;
      keys.forEach((k) => {
        const pv = pj >= 0 ? (app.state.ma ? ma(k)[pj] : s[k][pj]) : null;
        rows.push({ color: app.colors.prior, dash: true, label: `Prior ${METRIC_LABELS[k]}`, value: pv == null ? '—' : fmt(pv) });
      });
      if (pj >= 0) notes.push(`Prior period date: ${formatDay(s.dates[pj])}`);
    }
    const flagged = outageFlagsAt(chartKey, gi);
    if (flagged.length) notes.push(`⚠ Collection outage (${flagged.join(', ')}): treated as missing`);
    if (chartKey === 'dau' && gi >= 0 && s.dates[gi] < (app.data.collection_start || '2023-05-01')) notes.push('Before May 1, 2023: reconstructed, undercounted');
    return { rows, notes };
  }

  function externalTooltip(chartKey) {
    return (context) => {
      const { chart, tooltip } = context;
      const container = chart.canvas.parentNode;
      let el = container.querySelector('.hud');
      if (!el) {
        el = doc.createElement('div');
        el.className = 'hud';
        el.setAttribute('aria-hidden', 'true');
        container.appendChild(el);
      }
      if (!tooltip || tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length) {
        el.classList.remove('visible');
        return;
      }
      const idx = tooltip.dataPoints[0].dataIndex;
      const gi = app.view.startIdx + idx;
      const { rows, notes } = hudRowsFor(chartKey, idx);
      el.textContent = '';
      const title = doc.createElement('div');
      title.className = 'hud-title';
      const dt = app.s.dates[gi];
      title.textContent = dt ? `${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(`${dt}T00:00:00Z`).getUTCDay()]} ${formatDay(dt)}` : '';
      el.appendChild(title);
      rows.forEach((r) => {
        const row = doc.createElement('div');
        row.className = 'hud-row';
        const keyEl = doc.createElement('span');
        keyEl.className = `hud-key${r.dash ? ' dash' : ''}${r.color ? '' : ' none'}`;
        if (r.color) keyEl.style.setProperty('--key', r.color);
        const label = doc.createElement('span');
        label.className = 'hud-label';
        label.textContent = r.label;
        const value = doc.createElement('span');
        value.className = 'hud-value';
        value.textContent = r.value;
        row.append(keyEl, label, value);
        if (r.sub) {
          const sub = doc.createElement('span');
          sub.className = 'hud-sub';
          sub.textContent = r.sub;
          row.appendChild(sub);
        }
        el.appendChild(row);
      });
      notes.forEach((n) => {
        const note = doc.createElement('div');
        note.className = 'hud-note';
        note.textContent = n;
        el.appendChild(note);
      });
      el.classList.add('visible');
      const cw = container.clientWidth;
      const w = el.offsetWidth;
      const caret = tooltip.caretX;
      let left = caret + 14;
      if (left + w > cw - 4) left = caret - w - 14;
      if (left < 4) left = Math.max(4, Math.min(cw - w - 4, caret - w / 2));
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(chart.chartArea.top + 4)}px)`;
    };
  }

  function chartOptions(key) {
    const c = app.colors;
    const mono = cssVar('--font-mono', 'monospace');
    const zoomEnabled = true;
    const rightPad = key === 'velocity' && app.state.vm === 'pct' ? 70 : 62;
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 350 },
      normalized: true,
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      layout: { padding: { top: key === 'velocity' ? 16 : 8, right: rightPad, left: 2, bottom: 0 } },
      events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'],
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
          external: externalTooltip(key),
          filter: (item) => item.dataset.role !== 'ma' || key === 'velocity'
        },
        zoom: {
          limits: { x: { min: 'original', max: 'original', minRange: 4 } },
          pan: { enabled: zoomEnabled, mode: 'x', threshold: 6 },
          zoom: {
            wheel: { enabled: zoomEnabled, speed: 0.12, modifierKey: 'ctrl' },
            pinch: { enabled: zoomEnabled },
            mode: 'x',
            onZoomComplete: ({ chart }) => onZoomChange(key, chart)
          }
        }
      },
      scales: {
        x: {
          type: 'category',
          offset: key === 'velocity',
          grid: { display: false },
          border: { color: c.grid },
          ticks: {
            color: c.text, autoSkip: false, maxRotation: 0, minRotation: 0,
            font: { family: mono, size: 10.5 }, callback: xTickFormatter(key)
          },
          afterBuildTicks: xAfterBuildTicks
        },
        y: {
          type: 'linear',
          position: 'left',
          grid: { color: c.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: c.text, padding: 6, maxTicksLimit: 6, font: { family: mono, size: 10.5 }, callback: yTickFormatter(key) },
          afterBuildTicks: (scale) => {
            if (scale.type !== 'logarithmic') return;
            const t = logTicks(scale.min, scale.max, Math.max(3, Math.floor(scale.height / 40) || 6));
            if (t.length) scale.ticks = t.map((value) => ({ value, major: false }));
          }
        }
      }
    };
  }

  function onZoomChange(key, chart) {
    const btn = $(`.reset-zoom-btn[data-chart="${key}"]`);
    if (btn) btn.classList.toggle('zoomed', typeof chart.isZoomedOrPanned === 'function' && chart.isZoomedOrPanned());
  }

  function createCharts() {
    if (typeof root.Chart !== 'function') {
      $$('.chart-container').forEach((el) => {
        el.classList.add('chart-unavailable');
        const msg = doc.createElement('p');
        msg.className = 'chart-error';
        msg.textContent = 'Chart library failed to load. The numbers above and the data table below are still current.';
        el.appendChild(msg);
      });
      return;
    }
    const Chart = root.Chart;
    Chart.defaults.color = app.colors.text;
    Chart.defaults.font.family = cssVar('--font-mono', 'monospace');
    Chart.defaults.font.size = 11;
    Object.keys(CHART_IDS).forEach((key) => {
      const canvas = doc.getElementById(CHART_IDS[key]);
      if (!canvas) return;
      computeView();
      const chart = new Chart(canvas.getContext('2d'), {
        type: key === 'velocity' ? 'bar' : 'line',
        data: { labels: slice(app.s.dates), datasets: buildDatasets(key) },
        options: chartOptions(key),
        plugins: [outageBandPlugin, crosshairPlugin, lastValueTagPlugin, peakLabelPlugin]
      });
      chart.$bskyKey = key;
      applyScales(chart, key);
      chart.update('none');
      app.charts[key] = chart;
      watchVisibility(chart);
      wireChartKeyboard(canvas, key);
    });
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => Object.values(app.charts).forEach((c) => c.update('none')));
  }

  // Animating every point of six charts blocks the main thread for 0.3–1.2 s on ALL, so only
  // short ranges animate.
  const ANIMATE_MAX_POINTS = 200;

  function updateCharts(rangeChanged) {
    const animate = rangeChanged && !reducedMotion() && app.view.length <= ANIMATE_MAX_POINTS;
    Object.entries(app.charts).forEach(([key, chart]) => {
      if (rangeChanged && typeof chart.resetZoom === 'function') {
        chart.resetZoom('none');
        onZoomChange(key, chart);
      }
      chart.data.labels = slice(app.s.dates);
      chart.data.datasets = buildDatasets(key);
      chart.options.layout.padding.right = key === 'velocity' && app.state.vm === 'pct' ? 70 : 62;
      applyScales(chart, key);
      chart.update(animate ? undefined : 'none');
      describeChart(key);
    });
  }

  function describeChart(key) {
    const canvas = doc.getElementById(CHART_IDS[key]);
    if (!canvas) return;
    const v = app.view;
    const s = app.s;
    const span = `${formatDay(v.bounds.start)} to ${formatDay(v.bounds.end)}`;
    let summary = '';
    const lastOf = (k) => { const i = lastValidIn(s[k], v.startIdx, v.endIdx); return i >= 0 ? s[k][i] : null; };
    const maOf = (k) => { const arr = ma(k); const i = lastValidIn(arr, v.startIdx, v.endIdx); return i >= 0 ? arr[i] : null; };
    if (key === 'velocity') summary = `User velocity, ${span}: latest 7-day average ${formatSigned(maOf('new_users'))} accounts per day.`;
    if (key === 'dau') summary = `Daily active users and posters, ${span}: latest DAU ${formatCompact(lastOf('dau'))}, posters ${formatCompact(lastOf('posters'))}.`;
    if (key === 'act') summary = `Firehose actors per day, ${span}: likers ${formatCompact(lastOf('likers'))}, posters ${formatCompact(lastOf('posters'))}, followers ${formatCompact(lastOf('followers'))}, blockers ${formatCompact(lastOf('blockers'))}.`;
    if (key === 'rec') summary = `Daily records, ${span}: likes ${formatCompact(lastOf('likes'))}, posts ${formatCompact(lastOf('posts'))}, follows ${formatCompact(lastOf('follows'))}, blocks ${formatCompact(lastOf('blocks'))}.`;
    if (key === 'rat') summary = `${METRIC_LABELS[app.state.rm]}, ${span}: latest ${ratioFormatter(app.state.rm)(lastOf(app.state.rm))}.`;
    if (key === 'tot') summary = `Total users, ${span}: ${formatInteger(lastOf('users'))} at the end of the range.`;
    canvas.setAttribute('aria-label', `${summary} Arrow keys step through days. Daily values are in the data table below.`);
  }

  function wireChartKeyboard(canvas, key) {
    canvas.addEventListener('keydown', (e) => {
      const chart = app.charts[key];
      if (!chart) return;
      const x = chart.scales.x;
      const lo = Math.max(0, Math.ceil(x.min));
      const hi = Math.min(app.view.length - 1, Math.floor(x.max));
      const active = chart.tooltip.getActiveElements();
      let idx = active.length ? active[0].index : hi;
      if (e.key === 'ArrowLeft') idx = Math.max(lo, idx - 1);
      else if (e.key === 'ArrowRight') idx = Math.min(hi, idx + 1);
      else if (e.key === 'Home') idx = lo;
      else if (e.key === 'End') idx = hi;
      else return;
      e.preventDefault();
      showIndex(chart, idx);
    });
    canvas.addEventListener('focus', () => {
      const chart = app.charts[key];
      if (chart) showIndex(chart, Math.min(app.view.length - 1, Math.floor(chart.scales.x.max)));
    });
    canvas.addEventListener('blur', () => {
      const chart = app.charts[key];
      if (chart) { chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.setActiveElements([]); chart.update('none'); }
    });
  }

  function showIndex(chart, idx) {
    const els = chart.data.datasets
      .map((ds, di) => ({ datasetIndex: di, index: idx }))
      .filter(({ datasetIndex }) => chart.isDatasetVisible(datasetIndex) && chart.getDatasetMeta(datasetIndex).data[idx]);
    if (!els.length) return;
    const pt = chart.getDatasetMeta(els[0].datasetIndex).data[idx];
    chart.setActiveElements(els);
    chart.tooltip.setActiveElements(els, { x: pt.x, y: pt.y });
    chart.update('none');
    announceIndex(chart.$bskyKey, idx);
  }

  // The HUD is aria-hidden (it follows the pointer), so keyboard stepping is read out from a
  // polite live region instead, debounced so holding an arrow key doesn't queue every day.
  let announceTimer = null;
  function announceIndex(key, idx) {
    const live = $('#chart-live');
    if (!live || !key) return;
    root.clearTimeout(announceTimer);
    announceTimer = root.setTimeout(() => {
      const { rows, notes } = hudRowsFor(key, idx);
      const parts = rows.map((r) => `${r.label} ${r.value}${r.sub ? ` (${r.sub.replace(/Δ/g, 'change')})` : ''}`);
      const extra = notes.map((n) => n.replace(/^[≈⚠]\s*/, ''));
      setText(live, `${formatDay(app.s.dates[app.view.startIdx + idx])}: ${parts.join(', ')}.${extra.length ? ` ${extra.join('. ')}.` : ''}`);
    }, 150);
  }

  // ---------------- exports ----------------

  function visibleRange(key) {
    const chart = app.charts[key];
    let lo = 0;
    let hi = app.view.length - 1;
    if (chart && chart.scales && chart.scales.x) {
      lo = Math.max(0, Math.ceil(chart.scales.x.min));
      hi = Math.min(app.view.length - 1, Math.floor(chart.scales.x.max));
    }
    return { a: app.view.startIdx + lo, b: app.view.startIdx + hi };
  }

  function chartColumns(key) {
    const s = app.s;
    const col = (header, arr) => ({ header, value: (i) => arr[i] });
    const flagsCol = { header: 'flags', value: (i) => s.flags[i] };
    if (key === 'velocity') {
      return [col('date', s.dates), col('users', s.users), col('new_users', s.new_users), col('new_users_7d_avg', ma('new_users')),
        col('growth_pct', s.growth_pct), col('growth_pct_7d_avg', ma('growth_pct')), col('estimated', s.newEst.map((x) => (x ? 1 : 0))), col('users_source', s.usersSrc)];
    }
    if (key === 'dau') return [col('date', s.dates), col('dau', s.dau), col('dau_7d_avg', ma('dau')), col('posters', s.posters), col('posters_7d_avg', ma('posters')), flagsCol];
    if (key === 'act') return [col('date', s.dates), col('likers', s.likers), col('posters', s.posters), col('followers', s.followers), col('blockers', s.blockers), flagsCol];
    if (key === 'rec') return [col('date', s.dates), col('likes', s.likes), col('posts', s.posts), col('follows', s.follows), col('blocks', s.blocks), flagsCol];
    if (key === 'rat') return [col('date', s.dates), col('poster_ratio_pct', s.poster_ratio), col('dau_share_pct', s.dau_share), col('posts_per_poster', s.posts_per_poster), col('likes_per_liker', s.likes_per_liker), flagsCol];
    return [col('date', s.dates), col('users', s.users), col('users_estimated', s.usersEst.map((x) => (x ? 1 : 0))), col('users_source', s.usersSrc)];
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    doc.body.appendChild(a);
    a.click();
    a.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportCSV(key) {
    const { a, b } = visibleRange(key);
    const idx = [];
    for (let i = a; i <= b; i += 1) idx.push(i);
    const csv = buildCSV(chartColumns(key), idx);
    download(`bluesky-${CHART_NAMES[key]}-${app.s.dates[a]}_${app.s.dates[b]}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  }

  // One line under the PNG title so an exported image explains itself: series colours, mode,
  // scale, smoothing, estimate marks and the prior period.
  function exportLegend(key) {
    const st = app.state;
    const c = app.colors;
    const items = [];
    const series = (keys) => keys.forEach((k) => items.push({ color: c[k], text: METRIC_LABELS[k] }));
    if (key === 'velocity') {
      items.push({ color: c.velocity, text: st.vm === 'pct' ? 'Growth % per day' : 'New accounts per day' });
      if (st.ma) items.push({ color: c.ma, text: 'line = 7D avg' });
      items.push({ text: 'hatched = estimated' });
    } else if (key === 'tot') {
      items.push({ color: c.users, text: 'Total users' }, { text: 'dashed = estimated' });
      if (app.s.ownActive && app.s.ownActive.some((v) => v != null)) items.push({ color: c.gain, text: 'Active accounts (own count)' });
    } else {
      if (key === 'dau') series(['dau', 'posters']);
      if (key === 'act') series(['likers', 'posters', 'followers', 'blockers'].filter((k) => app.act[k]));
      if (key === 'rec') series(['likes', 'posts', 'follows', 'blocks'].filter((k) => app.rec[k]));
      if (key === 'rat') series([st.rm]);
      if (st.ma) items.push({ text: 'faint = daily, solid = 7D avg' });
    }
    if (key !== 'rat') items.push({ text: wantsLog(key) ? 'LOG scale' : 'linear scale' });
    const pr = app.view.prior;
    if (pr) {
      items.push({ color: c.prior, text: `dashed = prior period ${formatDay(pr.truncated ? app.s.dates[0] : pr.start)} → ${formatDay(pr.end)}${pr.truncated ? ' (partial)' : ''}` });
    }
    return items;
  }

  function exportPNG(key) {
    const chart = app.charts[key];
    if (!chart) return;
    const src = chart.canvas;
    const ratio = src.width / src.clientWidth || 1;
    const px = (n) => Math.round(n * ratio);
    const mono = cssVar('--font-mono', 'monospace');
    const small = `500 ${px(10)}px ${mono}`;
    // Lay the legend out first (wrapping at the canvas width) so the header fits it.
    const measure = doc.createElement('canvas').getContext('2d');
    measure.font = small;
    const lines = [[]];
    let lx = px(12);
    exportLegend(key).forEach((it) => {
      const w = (it.color ? px(12) : 0) + measure.measureText(it.text).width;
      if (lx + w > src.width - px(12) && lines[lines.length - 1].length) { lines.push([]); lx = px(12); }
      lines[lines.length - 1].push(it);
      lx += w + px(14);
    });
    const head = px(34 + 16 * lines.length);
    const foot = px(24);
    const out = doc.createElement('canvas');
    out.width = src.width;
    out.height = src.height + head + foot;
    const ctx = out.getContext('2d');
    ctx.fillStyle = app.colors.surface;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = app.colors.users;
    ctx.fillRect(0, 0, out.width, Math.max(1, px(2)));
    ctx.font = `700 ${px(13)}px ${mono}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = app.colors.primary;
    const { a, b } = visibleRange(key);
    ctx.fillText(`${CHART_TITLES[key]}  ·  ${formatDay(app.s.dates[a])} → ${formatDay(app.s.dates[b])}`, px(12), px(17));
    ctx.font = small;
    lines.forEach((line, li) => {
      let x = px(12);
      const y = px(38 + 16 * li);
      line.forEach((it) => {
        if (it.color) {
          ctx.fillStyle = it.color;
          ctx.fillRect(x, y - px(4), px(8), px(8));
          x += px(12);
        }
        ctx.fillStyle = app.colors.text;
        ctx.fillText(it.text, x, y);
        x += ctx.measureText(it.text).width + px(14);
      });
    });
    // Copy a clean frame: no shared hairline from a chart the pointer is resting on.
    app.exporting = true;
    try {
      chart.draw();
      ctx.drawImage(src, 0, head);
    } finally {
      app.exporting = false;
      chart.draw();
    }
    ctx.font = small;
    ctx.fillStyle = app.colors.muted;
    ctx.fillText(`Bluesky Network Pulse · ${SITE_URL.replace(/^https:\/\//, '')} · data: Jaz’s Bluesky index (bsky.jazco.dev)`, px(12), out.height - foot / 2);
    const name = `bluesky-${CHART_NAMES[key]}-${app.s.dates[a]}_${app.s.dates[b]}.png`;
    if (out.toBlob) out.toBlob((blob) => { if (blob) download(name, blob); }, 'image/png');
    else {
      const link = doc.createElement('a');
      link.href = out.toDataURL('image/png');
      link.download = name;
      link.click();
    }
  }

  // ---------------- data table ----------------

  function renderTable() {
    const body = $('#data-table-body');
    if (!body) return;
    const s = app.s;
    const v = app.view;
    const from = Math.max(v.startIdx, v.endIdx - 29);
    const frag = doc.createDocumentFragment();
    for (let i = v.endIdx; i >= from; i -= 1) {
      const tr = doc.createElement('tr');
      const cell = (text, cls, title) => {
        const td = doc.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        if (title) td.title = title;
        tr.appendChild(td);
      };
      const th = doc.createElement('th');
      th.scope = 'row';
      th.textContent = formatDay(s.dates[i]);
      tr.appendChild(th);
      const est = s.usersEst[i];
      cell(s.users[i] == null ? '—' : `${est ? '~' : ''}${formatInteger(s.users[i])}`, `num${est ? ' est' : ''}`, est ? `Estimated (${SOURCE_LABELS[s.usersSrc[i]] || s.usersSrc[i]})` : '');
      const nEst = s.newEst[i];
      cell(s.new_users[i] == null ? '—' : `${nEst ? '~' : ''}${formatSigned(s.new_users[i], false)}`, `num ${trendClass(s.new_users[i])}${nEst ? ' est' : ''}`, nEst ? 'Estimated' : '');
      ['dau', 'posters', 'posts', 'likes'].forEach((k) => {
        const flagged = k !== 'dau' ? s.flags[i].includes(k) : (s.flags[i].includes('likers') || s.flags[i].includes('posters'));
        const val = s[k][i];
        cell(val == null ? (flagged ? 'outage' : '—') : formatInteger(val), `num${flagged ? ' flagged' : ''}`, flagged ? 'Collection outage: treated as missing' : '');
      });
      frag.appendChild(tr);
    }
    body.textContent = '';
    body.appendChild(frag);
    setText($('#table-range-label'), `${formatDay(s.dates[from])} → ${formatDay(s.dates[v.endIdx])}`);
  }

  // ---------------- guide (generated from the live range list) ----------------

  function renderGuideRanges() {
    const body = $('#guide-ranges-body');
    if (!body) return;
    const s = app.s;
    const first = s.dates[0];
    const last = s.dates[s.length - 1];
    body.textContent = '';
    RANGES.forEach((r, i) => {
      const cur = getRangeBounds(r, first, last);
      const prior = getPriorBounds(r, first, last);
      const tr = doc.createElement('tr');
      const td = (content) => { const el = doc.createElement('td'); if (content instanceof Node) el.appendChild(content); else el.textContent = content; tr.appendChild(el); };
      const chip = doc.createElement('span');
      chip.className = `range-chip${prior ? '' : ' disabled'}`;
      chip.textContent = r;
      const kbd = doc.createElement('kbd');
      kbd.textContent = String(i + 1);
      const wrap = doc.createElement('span');
      wrap.className = 'range-cell';
      wrap.append(chip, ' ', kbd);
      td(wrap);
      td(`${formatDay(cur.start)} → ${formatDay(cur.end)} (${daysBetween(cur.start, cur.end)} days)`);
      td(prior ? `${formatDay(prior.truncated ? first : prior.start)} → ${formatDay(prior.end)}${prior.truncated ? ' (partial: the data starts here)' : ''}` : 'Unavailable: no earlier data');
      body.appendChild(tr);
    });
  }

  // ---------------- state + controls ----------------

  function syncControls() {
    const st = app.state;
    $$('.time-btn[data-range]').forEach((b) => {
      const on = b.dataset.range === st.range;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const maBtn = $('#toggle-ma-btn');
    if (maBtn) { maBtn.classList.toggle('active', st.ma); maBtn.setAttribute('aria-pressed', String(st.ma)); }
    const logBtn = $('#toggle-log-btn');
    if (logBtn) { logBtn.classList.toggle('active', st.log); logBtn.setAttribute('aria-pressed', String(st.log)); }
    const cmpBtn = $('#toggle-compare-btn');
    if (cmpBtn) {
      const unavailable = st.range === 'ALL';
      cmpBtn.classList.toggle('active', st.cmp);
      cmpBtn.setAttribute('aria-pressed', String(st.cmp));
      cmpBtn.classList.toggle('range-unsupported', unavailable);
      cmpBtn.title = unavailable
        ? 'Compare needs an earlier window: pressing it switches ALL to 1Y (C)'
        : 'Overlay the prior period: the same number of days immediately before this range (C)';
    }
    $$('.vel-mode-btn').forEach((b) => {
      const on = b.dataset.mode === st.vm;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $$('.rat-mode-btn').forEach((b) => {
      const on = b.dataset.mode === st.rm;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $$('.series-toggle').forEach((b) => {
      const group = b.dataset.group === 'act' ? app.act : app.rec;
      const on = Boolean(group[b.dataset.series]);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $$('.wave-chip').forEach((c) => {
      const on = c.dataset.wave === st.range;
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', String(on));
    });
    const reset = $('#reset-wave-btn');
    if (reset) reset.hidden = !app.view.wave;
    $$('.log-capable').forEach((el) => {
      el.classList.toggle('log-on', st.log);
      setText(el, st.log ? 'LOG' : 'LIN');
      el.title = st.log ? 'Logarithmic y-axis (press L for linear)' : 'Linear y-axis (press L for logarithmic)';
    });
    $$('.chart-comparison-legend').forEach((el) => { el.hidden = !app.view.prior; });
    $$('.ma-legend').forEach((el) => { el.hidden = !st.ma; });

    const v = app.view;
    setText($('#selected-range-label'), getRangeLabel(st.range));
    setText($('#selected-range-dates'), `${formatDay(v.bounds.start)} → ${formatDay(v.bounds.end)} · ${v.length} pts`);
    const velHeading = $('#velocity-chart-subtitle');
    if (velHeading) {
      setText(velHeading, v.wave
        ? `${v.wave.title} · ${v.wave.name}: ${v.wave.note}`
        : (st.vm === 'pct'
          ? 'New accounts as a share of the previous day’s total. Hatched bars are estimated days.'
          : 'New accounts per UTC day, as counted by Jaz. Hatched bars are estimated days.'));
    }
    const ratSub = $('#rat-chart-subtitle');
    if (ratSub) {
      setText(ratSub, {
        poster_ratio: 'Posters ÷ DAU: share of active accounts that posted',
        dau_share: 'DAU ÷ total users: share of accounts active that day',
        posts_per_poster: 'Posts ÷ posters: posts per posting account',
        likes_per_liker: 'Likes ÷ likers: likes per liking account'
      }[st.rm]);
    }
    const priorRange = $('#prior-range-dates');
    if (priorRange) {
      priorRange.hidden = !v.prior;
      if (v.prior) {
        setText(priorRange, v.prior.truncated
          ? `PRIOR ${formatDay(app.s.dates[0])} → ${formatDay(v.prior.end)} (PARTIAL)`
          : `PRIOR ${formatDay(v.prior.start)} → ${formatDay(v.prior.end)}`);
        priorRange.title = v.prior.truncated
          ? `The prior period would start on ${formatDay(v.prior.start)}, before the data begins, so it covers fewer days than the current range.`
          : '';
      }
    }
  }

  function writeHash() {
    const hash = serializeHashState(app.state);
    if (root.location.hash !== hash) {
      try { root.history.replaceState(null, '', hash); } catch (e) { root.location.hash = hash; }
    }
  }

  function applyState(opts) {
    const o = opts || {};
    if (app.state.range === 'ALL') app.state.cmp = false;
    if (!findWave(app.state.range)) app.lastStdRange = app.state.range;
    const prevBounds = app.view ? `${app.view.bounds.start}|${app.view.bounds.end}` : '';
    computeView();
    const rangeChanged = prevBounds !== `${app.view.bounds.start}|${app.view.bounds.end}`;
    syncControls();
    updateCards();
    updateCharts(rangeChanged);
    renderTable();
    if (o.writeHash) writeHash();
  }

  function setRange(range, opts) {
    if (!isValidRange(range)) return;
    app.state.range = range;
    applyState({ writeHash: true, ...(opts || {}) });
  }

  function toggleCompare() {
    if (app.state.range === 'ALL') {
      app.state.range = '1Y';
      app.state.cmp = true;
    } else {
      app.state.cmp = !app.state.cmp;
    }
    applyState({ writeHash: true });
  }

  function openGuide() {
    const dlg = $('#guide-dialog');
    if (!dlg) return;
    renderGuideRanges();
    if (dlg.open) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeGuide() {
    const dlg = $('#guide-dialog');
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function wireControls() {
    $$('.time-btn[data-range]').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.range)));
    const maBtn = $('#toggle-ma-btn');
    if (maBtn) maBtn.addEventListener('click', () => { app.state.ma = !app.state.ma; applyState({ writeHash: true }); });
    const logBtn = $('#toggle-log-btn');
    if (logBtn) logBtn.addEventListener('click', () => { app.state.log = !app.state.log; applyState({ writeHash: true }); });
    const cmpBtn = $('#toggle-compare-btn');
    if (cmpBtn) cmpBtn.addEventListener('click', toggleCompare);
    $$('.vel-mode-btn').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.mode === app.state.vm) return;
      app.state.vm = b.dataset.mode;
      applyState({ writeHash: true });
    }));
    $$('.rat-mode-btn').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.mode === app.state.rm) return;
      app.state.rm = b.dataset.mode;
      applyState({ writeHash: true });
    }));
    $$('.series-toggle').forEach((b) => b.addEventListener('click', () => {
      const group = b.dataset.group === 'act' ? app.act : app.rec;
      const k = b.dataset.series;
      const onCount = Object.values(group).filter(Boolean).length;
      if (group[k] && onCount === 1) return;
      group[k] = !group[k];
      applyState();
    }));
    $$('.wave-chip').forEach((c) => c.addEventListener('click', () => {
      if (app.state.range === c.dataset.wave) setRange(app.lastStdRange || DEFAULT_STATE.range);
      else {
        setRange(c.dataset.wave);
        const sec = $('#section-velocity-chart');
        if (sec && sec.getBoundingClientRect().top < 0) sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
    }));
    const reset = $('#reset-wave-btn');
    if (reset) reset.addEventListener('click', () => setRange(app.lastStdRange || DEFAULT_STATE.range));
    $$('.reset-zoom-btn').forEach((b) => b.addEventListener('click', () => {
      const chart = app.charts[b.dataset.chart];
      if (chart && chart.resetZoom) { chart.resetZoom(); onZoomChange(b.dataset.chart, chart); }
    }));
    $$('.export-png-btn').forEach((b) => b.addEventListener('click', () => exportPNG(b.dataset.chart)));
    $$('.export-csv-btn').forEach((b) => b.addEventListener('click', () => exportCSV(b.dataset.chart)));
    const openBtn = $('#open-guide-btn');
    if (openBtn) openBtn.addEventListener('click', openGuide);
    $$('.open-guide-link').forEach((b) => b.addEventListener('click', openGuide));
    const dlg = $('#guide-dialog');
    if (dlg) {
      dlg.addEventListener('click', (e) => { if (e.target === dlg) closeGuide(); });
      $$('[data-close-guide]', dlg).forEach((b) => b.addEventListener('click', closeGuide));
    }
    const pause = $('#ticker-pause');
    if (pause) {
      pause.addEventListener('click', () => {
        const tape = $('#ticker');
        const paused = tape.classList.toggle('paused');
        pause.setAttribute('aria-pressed', String(paused));
        pause.classList.toggle('is-paused', paused);
      });
    }
    const refresh = $('#refresh-data-btn');
    if (refresh) refresh.addEventListener('click', () => { refresh.disabled = true; root.location.reload(); });

    doc.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const dlgOpen = dlg && dlg.open;
      if (e.key === '?') { e.preventDefault(); if (dlgOpen) closeGuide(); else openGuide(); return; }
      if (dlgOpen) return;
      if (/^[1-8]$/.test(e.key)) { e.preventDefault(); setRange(RANGES[Number(e.key) - 1]); return; }
      const k = e.key.toLowerCase();
      if (k === 'm') { e.preventDefault(); app.state.ma = !app.state.ma; applyState({ writeHash: true }); }
      else if (k === 'l') { e.preventDefault(); app.state.log = !app.state.log; applyState({ writeHash: true }); }
      else if (k === 'c') { e.preventDefault(); toggleCompare(); }
    });

    root.addEventListener('hashchange', () => {
      const next = parseHashState(root.location.hash);
      const cur = app.state;
      if (['range', 'ma', 'log', 'cmp', 'vm', 'rm'].every((k) => next[k] === cur[k])) return;
      app.state = { ...next };
      applyState();
    });
  }

  // ---------------- social boards (LDR, PST, DEC) ----------------

  const social = { data: null, board: SOCIAL_BOARDS[0].id, win: '24h', dir: 'gain' };

  function socialMessage(el, text) {
    if (!el) return;
    el.hidden = !text;
    setText(el, text || '');
  }

  function renderLeaderboard() {
    const section = $('#section-ldr');
    if (!section) return;
    const res = resolveBoard(social.board, social.win, social.dir);
    const nowMs = Date.now();
    $$('.ldr-mode-btn').forEach((b) => {
      const on = b.dataset.board === res.id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const winPill = $('#ldr-win-pill');
    if (winPill) {
      winPill.hidden = !res.windows.length;
      $$('.ldr-win-btn', winPill).forEach((b) => {
        b.hidden = !res.windows.includes(b.dataset.win);
        const on = b.dataset.win === res.win;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    const dirPill = $('#ldr-dir-pill');
    if (dirPill) {
      dirPill.hidden = !res.dirs;
      $$('.ldr-dir-btn', dirPill).forEach((b) => {
        const on = b.dataset.dir === res.dir;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    const rows = social.data ? socialBoardRows(social.data, res.key) : [];
    const models = rows.map((entry, i) => socialRowModel(res, entry, i + 1, nowMs));
    const body = $('#ldr-body');
    if (body) body.innerHTML = buildLeaderboardRowsHTML(models);
    const wrap = $('#ldr-table-wrap');
    if (wrap) wrap.hidden = !models.length;
    setText($('#ldr-metric-head'), socialMetricHead(res));
    const moverKeys = ['gainers_24h', 'losers_24h', 'gainers_7d', 'losers_7d'];
    const noSnapshots = res.id === 'movers' && social.data && !moverKeys.some((k) => Array.isArray(social.data.boards[k]) && social.data.boards[k].length);
    const hint = noSnapshots ? ' Gainers and losers need two daily snapshots.' : '';
    socialMessage($('#ldr-empty'), models.length ? '' : `${SOCIAL_EMPTY}${hint}`);
    const caveats = $('#ldr-caveats');
    if (caveats) {
      caveats.textContent = '';
      boardCaveats(res, social.data).forEach((line) => {
        const li = doc.createElement('li');
        li.textContent = line;
        caveats.appendChild(li);
      });
    }
    const asOf = social.data ? `${formatDay(social.data.day)} · built ${formatUtcStamp(social.data.generated_at)}` : 'NO DATA YET';
    setText($('#ldr-asof'), social.data && typeof social.data.day === 'string' ? `DAY ${social.data.day}` : 'NO DATA');
    const asOfEl = $('#ldr-asof');
    if (asOfEl) asOfEl.title = asOf;
    const winLabel = res.win ? `, ${SOCIAL_WINDOW_LABELS[res.win]}` : '';
    const dirLabel = res.dir === 'loss' ? ', losers' : res.dir === 'gain' ? ', gainers' : '';
    setText($('#ldr-live'), `${res.label.toLowerCase()}${winLabel}${dirLabel}: ${models.length} accounts`);
  }

  function renderPosts() {
    const list = $('#pst-list');
    if (!list) return;
    const posts = social.data ? socialTopPosts(social.data) : [];
    list.innerHTML = buildPostCardsHTML(posts, Date.now());
    list.hidden = !posts.length;
    socialMessage($('#pst-empty'), posts.length ? '' : SOCIAL_EMPTY);
    setText($('#pst-subtitle'), postsSubtitle(social.data));
    const notes = $('#pst-caveats');
    if (notes) {
      notes.textContent = '';
      postsCaveats(social.data).forEach((line) => {
        const li = doc.createElement('li');
        li.textContent = line;
        notes.appendChild(li);
      });
      notes.hidden = !notes.children.length;
    }
    setText($('#pst-asof'), social.data && typeof social.data.day === 'string' ? `UTC DAY ${social.data.day}` : 'NO DATA');
  }

  function renderDecentralization() {
    const box = $('#dec-body');
    if (!box) return;
    const model = decentralizationModel(app.data && app.data.own_count);
    box.hidden = !model;
    box.innerHTML = model ? buildDecentralizationHTML(model) : '';
    socialMessage($('#dec-empty'), model ? '' : SOCIAL_EMPTY);
    setText($('#dec-asof'), model ? `AS OF ${model.date}` : 'NO DATA');
  }

  function wireSocial() {
    $$('.ldr-mode-btn').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.board === social.board) return;
      social.board = b.dataset.board;
      renderLeaderboard();
    }));
    $$('.ldr-win-btn').forEach((b) => b.addEventListener('click', () => {
      social.win = b.dataset.win;
      renderLeaderboard();
    }));
    $$('.ldr-dir-btn').forEach((b) => b.addEventListener('click', () => {
      social.dir = b.dataset.dir;
      renderLeaderboard();
    }));
    ['#ldr-body', '#pst-list'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.classList.add('avatar-broken'); }, true);
    });
  }

  function initSocial() {
    try {
      social.data = normalizeSocial(root.BLUESKY_SOCIAL);
      renderLeaderboard();
      renderPosts();
      renderDecentralization();
      wireSocial();
    } catch (err) {
      if (root.console) root.console.error('Social boards failed to render.', err);
    }
  }

  function showFatal(message) {
    setStatus('error', message);
    const banner = $('#data-error');
    if (banner) {
      banner.hidden = false;
      setText($('.data-error-msg', banner), message);
    }
  }

  function init() {
    try {
      if (!Fmt) throw new Error('lib/format.js failed to load.');
      const data = root.BLUESKY_DATA;
      if (!data || !Array.isArray(data.days) || data.days.length < 2) throw new Error('data/bluesky-data.js failed to load or is empty.');
      app.data = data;
      app.s = buildSeries(data.days);
      app.s.ownActive = ownCountSeries(app.s.dates, data.own_count);
      app.pre = computePrerenderValues(data);
      app.state = parseHashState(root.location.hash);
      readColors();
      paintPrerender();
      syncJsonLd();
      renderTicker();
      renderMilestones();
      renderWaveChips();
      setStatus('archive', `Archived snapshot from ${formatUtcStamp(data.snapshot && data.snapshot.updated_at)}; daily data through ${formatDay(data.last_complete_day)}.`);
      startClock();
      computeView();
      createCharts();
      wireControls();
      applyState();
      initSocial();
      const usersEl = $('#kpi-users-value');
      const total = num(data.snapshot && data.snapshot.total_users);
      const lastVel = app.s.new_users[app.s.length - 1];
      if (usersEl && total != null && !app.live.reading) animateNumber(usersEl, total - Math.max(0, Math.round(lastVel || 0)), total, 1400);
      root.setTimeout(() => { doc.documentElement.dataset.ready = 'true'; }, reducedMotion() ? 0 : 1500);
      startLive();
    } catch (err) {
      if (root.console) root.console.error('Bluesky terminal failed to initialise.', err);
      showFatal(err && err.message ? err.message : 'Unknown error');
      doc.documentElement.dataset.ready = 'error';
    }
  }

  root.BskyTerminal = Object.assign({}, pure, { app, charts: app.charts, setRange, applyState });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
