// Number and date formatting shared by the browser (window.BskyFormat) and Node (require).
// The updater pre-renders numbers into index.html with these same functions, so the static
// HTML matches what script.js paints after load.
(function (root) {
  const LOCALE = 'en-US';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

  function formatInteger(n) {
    return isNum(n) ? Math.round(n).toLocaleString(LOCALE) : '—';
  }

  // <1K: integer · <1M: 1 decimal K · <1B: 2 decimals M · else 3 decimals B (jazco's B precision).
  function formatCompact(n) {
    if (!isNum(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a < 1e3) return sign + Math.round(a).toLocaleString(LOCALE);
    if (a < 1e6) return sign + (a / 1e3).toFixed(1) + 'K';
    if (a < 1e9) return sign + (a / 1e6).toFixed(2) + 'M';
    return sign + (a / 1e9).toFixed(3) + 'B';
  }

  function formatSigned(n, compact = true) {
    if (!isNum(n)) return '—';
    const body = compact ? formatCompact(Math.abs(n)) : formatInteger(Math.abs(n));
    return (n < 0 ? '-' : '+') + body;
  }

  function formatPct(x, digits = 2) {
    return isNum(x) ? x.toFixed(digits) + '%' : '—';
  }

  function formatSignedPct(x, digits = 2) {
    if (!isNum(x)) return '—';
    return (x < 0 ? '-' : '+') + Math.abs(x).toFixed(digits) + '%';
  }

  // 'YYYY-MM-DD' -> 'Oct 7, 2026' without going through local-time Date parsing.
  function formatDay(isoDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || '');
    if (!m) return '—';
    return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  }

  // ISO timestamp -> '2026-10-08 03:17 UTC'.
  function formatUtcStamp(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '—';
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  const api = { formatInteger, formatCompact, formatSigned, formatPct, formatSignedPct, formatDay, formatUtcStamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BskyFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
