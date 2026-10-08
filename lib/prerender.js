'use strict';
// Server-side pre-render of index.html and sitemap.xml (see docs/ARCHITECTURE.md, "Pre-render contract").
// Pure string transforms: crawlers get the same numbers script.js paints after load.

const fmt = require('./format.js');

const SITE_URL = 'https://obsesivegamer.github.io/Bluesky-User-Trends/';
const CSV_URL = SITE_URL + 'data/bluesky-daily.csv';
const REPO_URL = 'https://github.com/obsesivegamer/Bluesky-User-Trends';
// Sources, credits and the terms each part of the dataset carries (CC BY 4.0 for the Commons history).
const DATA_TERMS_URL = REPO_URL + '/blob/main/data/README.md';
const DAY_MS = 86400000;

const INLINE_KEYS = [
  'last-day', 'generated', 'activity-day',
  'users-total', 'users-total-compact', 'users-at',
  'velocity-7d', 'velocity-last',
  'dau', 'posters', 'poster-ratio', 'dau-share',
  'index-posts', 'index-likes', 'index-follows',
  'dau-peak', 'dau-peak-date', 'posters-peak', 'posters-peak-date',
  'velocity-peak', 'velocity-peak-date',
];
const BLOCK_KEYS = ['milestones', 'ticker'];
const JSONLD_KEY = 'jsonld';
const STAMP_KEY = 'data-stamp';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function usable(row, key) {
  return Boolean(row) && isNum(row[key]) && !(Array.isArray(row.flags) && row.flags.includes(key));
}

function addDays(isoDate, n) {
  return new Date(Date.parse(isoDate + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

function indexByDate(days) {
  const map = new Map();
  for (const row of days) map.set(row.date, row);
  return map;
}

function latestUsableWhere(days, pred) {
  for (let i = days.length - 1; i >= 0; i--) {
    if (pred(days[i])) return days[i];
  }
  return null;
}

function latestUsable(days, ...keys) {
  return latestUsableWhere(days, (r) => keys.every((k) => usable(r, k)));
}

// Mean of the usable values in the 7 calendar days ending at endDate (null if there are none).
function mean7(byDate, endDate, key) {
  if (!endDate) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const row = byDate.get(addDays(endDate, -i));
    if (usable(row, key)) {
      sum += row[key];
      n++;
    }
  }
  return n ? sum / n : null;
}

function peak(days, key) {
  let best = null;
  for (const row of days) {
    if (usable(row, key) && (best === null || row[key] > best[key])) best = row;
  }
  return best;
}

function signedPerDay(n) {
  return isNum(n) ? fmt.formatSigned(n) + '/day' : '—';
}

function computePrerenderValues(data) {
  const days = Array.isArray(data && data.days) ? data.days : [];
  const snap = (data && data.snapshot) || {};
  const byDate = indexByDate(days);
  const last = days.length ? days[days.length - 1] : null;
  const lastDate = (data && data.last_complete_day) || (last && last.date);

  // DAU, posters, poster ratio and DAU share all describe one day (the latest with a usable DAU),
  // so a sentence that puts them next to `activity-day` is true even when the newest day is an outage.
  const dauRow = latestUsable(days, 'dau');
  const postersRow = dauRow || latestUsable(days, 'posters');
  const activityRow = dauRow || postersRow;
  const ratioRow = latestUsableWhere(days, (r) => usable(r, 'posters') && usable(r, 'dau') && r.dau > 0);
  const shareRow = latestUsableWhere(days, (r) => usable(r, 'dau') && usable(r, 'users') && r.users > 0);
  const dauPeak = peak(days, 'dau');
  const postersPeak = peak(days, 'posters');
  const velocityPeak = peak(days, 'new_users');
  const velocityPeakEst = Boolean(velocityPeak) && (velocityPeak.new_users_est === true || velocityPeak.users_est === true ||
    Boolean(byDate.get(addDays(velocityPeak.date, -1)) && byDate.get(addDays(velocityPeak.date, -1)).users_est === true));

  return {
    'last-day': fmt.formatDay(lastDate),
    'generated': fmt.formatUtcStamp(data && data.generated_at),
    'activity-day': fmt.formatDay(activityRow && activityRow.date),
    'users-total': fmt.formatInteger(snap.total_users),
    'users-total-compact': fmt.formatCompact(snap.total_users),
    'users-at': fmt.formatUtcStamp(snap.updated_at),
    'velocity-7d': signedPerDay(mean7(byDate, last && last.date, 'new_users')),
    'velocity-last': fmt.formatSigned(last ? last.new_users : null),
    'dau': fmt.formatCompact(dauRow && dauRow.dau),
    'posters': fmt.formatCompact(postersRow && postersRow.posters),
    'poster-ratio': ratioRow ? fmt.formatPct((100 * ratioRow.posters) / ratioRow.dau, 1) : '—',
    'dau-share': shareRow ? fmt.formatPct((100 * shareRow.dau) / shareRow.users, 2) : '—',
    'index-posts': fmt.formatCompact(snap.total_posts),
    'index-likes': fmt.formatCompact(snap.total_likes),
    'index-follows': fmt.formatCompact(snap.total_follows),
    'dau-peak': fmt.formatCompact(dauPeak && dauPeak.dau),
    'dau-peak-date': fmt.formatDay(dauPeak && dauPeak.date),
    'posters-peak': fmt.formatCompact(postersPeak && postersPeak.posters),
    'posters-peak-date': fmt.formatDay(postersPeak && postersPeak.date),
    'velocity-peak': fmt.formatSigned(velocityPeak && velocityPeak.new_users),
    'velocity-peak-date': fmt.formatDay(velocityPeak && velocityPeak.date) + (velocityPeakEst ? ' (est.)' : ''),
  };
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// The ticker and milestone rows are painted by script.js after load; rendering them with its own
// exported builders keeps the static HTML byte-for-byte what the page would paint.
let uiModule;
function loadUi() {
  if (uiModule === undefined) {
    try {
      const ui = require('../script.js');
      const needed = ['buildSeries', 'computeTickerItems', 'buildTickerHTML', 'buildMilestoneRowsHTML'];
      uiModule = needed.every((fn) => typeof ui[fn] === 'function') ? ui : null;
    } catch {
      uiModule = null;
    }
  }
  return uiModule;
}

function renderBlocks(data, ui = loadUi()) {
  if (!ui || !data || !Array.isArray(data.days) || !data.days.length) return {};
  const series = ui.buildSeries(data.days);
  return {
    ticker: ui.buildTickerHTML(ui.computeTickerItems(data, series)).split('\n'),
    milestones: ui.buildMilestoneRowsHTML(data, series).split('\n'),
  };
}

const DEFAULT_FAQ = [
  {
    question: 'How many users does Bluesky have?',
    answer: (v) => `Jaz's Bluesky index counts ${v['users-total']} accounts on Bluesky-operated PDS hosts (as of ${v['users-at']}). Accounts on self-hosted and third-party PDS hosts are not included, and accounts deleted after they were first counted are not subtracted.`,
  },
  {
    question: 'How many people use Bluesky every day?',
    answer: (v) => `On ${v['activity-day']}, at least ${v['dau']} accounts liked, posted, followed or blocked something, and ${v['posters']} accounts posted. This is a lower bound: Jaz's index counts likes, posts, follows and blocks only, so people who only read or repost are not counted.`,
  },
  {
    question: 'How fast is Bluesky growing?',
    answer: (v) => `User velocity (new accounts per UTC day, as counted by Jaz) averaged ${v['velocity-7d']} over the last 7 days. The largest day is ${v['velocity-peak']} on ${v['velocity-peak-date']}.`,
  },
];

function buildJsonLd(data, options = {}) {
  const v = computePrerenderValues(data);
  const days = Array.isArray(data && data.days) ? data.days : [];
  const firstDate = days.length ? days[0].date : '2022-11-17';
  const lastDate = (data && data.last_complete_day) || (days.length ? days[days.length - 1].date : '');
  const modified = (data && data.generated_at) || lastDate;
  const faq = Array.isArray(options.faq) && options.faq.length
    ? options.faq
    : DEFAULT_FAQ.map((f) => ({ question: f.question, answer: f.answer(v) }));

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        '@id': SITE_URL + '#app',
        name: 'Bluesky Network Pulse',
        alternateName: 'Bluesky User Trends',
        url: SITE_URL,
        description: 'Terminal-style dashboard for Bluesky: total users, user velocity (new accounts per day), daily active users and daily posters, updated twice a day from public data.',
        applicationCategory: 'ReferenceApplication',
        operatingSystem: 'Any',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        about: { '@type': 'Thing', name: 'Bluesky', sameAs: 'https://bsky.app/' },
        dateModified: modified,
      },
      {
        '@type': 'FAQPage',
        '@id': SITE_URL + '#faq',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      },
      {
        '@type': 'Dataset',
        '@id': SITE_URL + '#dataset',
        name: 'Bluesky daily users, user velocity, daily active users and posters',
        description: `Daily Bluesky time series from ${firstDate} to ${lastDate}: accounts counted on Bluesky-operated PDS hosts at the end of each UTC day (accounts deleted after they were first counted are not subtracted), new accounts per day (user velocity), daily active accounts (lower bound: distinct accounts that liked, posted, followed or blocked) and daily posters, plus daily post, like, follow and block counts, with per-day estimate and data-quality flags.`,
        url: SITE_URL,
        keywords: ['Bluesky', 'Bluesky users', 'Bluesky daily active users', 'Bluesky user growth', 'AT Protocol', 'social media statistics'],
        creator: { '@type': 'Person', name: 'obsesivegamer', url: 'https://github.com/obsesivegamer' },
        isAccessibleForFree: true,
        isBasedOn: [
          'https://bsky.jazco.dev/stats',
          'https://commons.wikimedia.org/wiki/File:Bluesky_Registered_Users.svg',
          'https://bsky.app/profile/hourlybskyusers.bsky.social',
        ],
        creditText: "Activity and user counts from Jaz's Bluesky index (bsky.jazco.dev); 2022-2024 user history from Wikimedia Commons \"Bluesky Registered Users.svg\" by VintageNebula, with data gathered by Jaz and Martin Kleppmann et al., CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), resampled to UTC day boundaries, re-interpolated and merged with other sources.",
        license: DATA_TERMS_URL,
        temporalCoverage: `${firstDate}/${lastDate}`,
        dateModified: modified,
        variableMeasured: ['Total users', 'New users per day', 'Daily active users (lower bound)', 'Daily posters', 'Posts', 'Likes', 'Follows', 'Blocks'],
        distribution: [{ '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: CSV_URL }],
      },
    ],
  };
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', times: '×', rarr: '→', larr: '←',
  asymp: '≈', ge: '≥', le: '≤', plusmn: '±', minus: '−', deg: '°', copy: '©', bull: '•', thinsp: ' ',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e.toLowerCase()) ? NAMED_ENTITIES[e.toLowerCase()] : m;
  });
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|\/p|\/li|\/div|\/h\d)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ').trim();
}

// Visible FAQ (<details class="faq-…"> with a <summary>) → [{question, answer}], so JSON-LD mirrors the page.
function extractFaq(html) {
  const out = [];
  const re = /<details\b([^>]*)>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cls = /\bclass\s*=\s*(["'])([^"']*)\1/i.exec(m[1]);
    if (!cls || !/\bfaq/i.test(cls[2])) continue;
    const sum = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(m[2]);
    if (!sum) continue;
    const questionHtml = sum[1].replace(/<(\w+)\b[^>]*(?:aria-hidden\s*=\s*["']true["']|class\s*=\s*["'][^"']*\bfaq-arrow\b[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi, '');
    const question = htmlToText(questionHtml);
    const answer = htmlToText(m[2].slice(sum.index + sum[0].length));
    if (question && answer) out.push({ question, answer });
  }
  return out;
}

function jsonForScript(obj, indent) {
  const json = JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
  return '\n' + json.split('\n').map((line) => indent + '  ' + line).join('\n') + '\n' + indent;
}

function lineIndent(html, index) {
  const lineStart = html.lastIndexOf('\n', index - 1) + 1;
  const m = /^[ \t]*/.exec(html.slice(lineStart, index));
  return m ? m[0] : '';
}

function compactStamp(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 16).replace(/\D/g, '');
}

const START_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const PRERENDER_ATTR_RE = /(?:^|\s)data-prerender\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function replaceInline(html, values, found, invalid, unknown) {
  let out = '';
  let cursor = 0;
  START_TAG_RE.lastIndex = 0;
  let m;
  while ((m = START_TAG_RE.exec(html))) {
    const attr = PRERENDER_ATTR_RE.exec(m[2] || '');
    if (!attr) continue;
    const key = attr[1] ?? attr[2] ?? attr[3];
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      unknown.add(key);
      continue;
    }
    const contentStart = m.index + m[0].length;
    const lt = html.indexOf('<', contentStart);
    const closeRe = new RegExp('^</' + m[1] + '\\s*>', 'i');
    if (lt === -1 || !closeRe.test(html.slice(lt, lt + m[1].length + 16))) {
      invalid.add(key);
      continue;
    }
    out += html.slice(cursor, contentStart) + escapeHtml(values[key]);
    cursor = lt;
    START_TAG_RE.lastIndex = lt;
    found.add(key);
  }
  return out + html.slice(cursor);
}

function replaceBlock(html, key, lines) {
  const re = new RegExp(`(<!--\\s*prerender:${key}\\s*-->)([\\s\\S]*?)(<!--\\s*/prerender:${key}\\s*-->)`, 'g');
  let hit = false;
  const result = html.replace(re, (all, open, _inner, close, offset) => {
    hit = true;
    const indent = lineIndent(html, offset);
    const body = lines.length ? '\n' + lines.map((l) => indent + l).join('\n') + '\n' + indent : '';
    return open + body + close;
  });
  return { html: result, hit };
}

function prerenderIndex(html, data, options = {}) {
  const values = computePrerenderValues(data);
  const found = new Set();
  const invalid = new Set();
  const unknown = new Set();

  let out = replaceInline(String(html), values, found, invalid, unknown);

  const blocks = renderBlocks(data, 'ui' in options ? options.ui : loadUi());
  for (const key of BLOCK_KEYS) {
    if (!blocks[key]) continue;
    const r = replaceBlock(out, key, blocks[key]);
    out = r.html;
    if (r.hit) found.add(key);
  }

  const stamp = compactStamp(data && data.generated_at);
  if (stamp) {
    const stampRe = /(<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?data\/bluesky-data\.js\?v=)[^"'#&]*/gi;
    out = out.replace(stampRe, (_all, prefix) => {
      found.add(STAMP_KEY);
      return prefix + stamp;
    });
  }

  const ldRe = /(<script\b[^>]*\bid\s*=\s*["']jsonld["'][^>]*>)([\s\S]*?)(<\/script\s*>)/i;
  const ld = ldRe.exec(out);
  if (ld) {
    const faq = extractFaq(out);
    const json = jsonForScript(buildJsonLd(data, { faq }), lineIndent(out, ld.index));
    out = out.slice(0, ld.index) + ld[1] + json + ld[3] + out.slice(ld.index + ld[0].length);
    found.add(JSONLD_KEY);
  }

  const all = [...INLINE_KEYS, ...BLOCK_KEYS, STAMP_KEY, JSONLD_KEY];
  return {
    html: out,
    replaced: all.filter((k) => found.has(k)),
    missing: all.filter((k) => !found.has(k)),
    invalid: [...invalid],
    unknown: [...unknown],
  };
}

function updateSitemap(xml, data) {
  const day = data && data.last_complete_day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return xml;
  if (/<lastmod>[^<]*<\/lastmod>/.test(xml)) return xml.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${day}</lastmod>`);
  return xml.replace(/([ \t]*)(<loc>[^<]*<\/loc>)/g, (_all, indent, loc) => `${indent}${loc}\n${indent}<lastmod>${day}</lastmod>`);
}

function parseDataFile(src) {
  const m = /window\.BLUESKY_DATA\s*=\s*/.exec(src);
  if (!m) throw new Error('data file does not assign window.BLUESKY_DATA');
  return JSON.parse(src.slice(m.index + m[0].length).trim().replace(/;$/, ''));
}

function main(argv) {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  const opts = { data: 'data/bluesky-data.js', index: 'index.html', sitemap: 'sitemap.xml', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--data' || a === '--index' || a === '--sitemap') opts[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node lib/prerender.js [--data FILE] [--index FILE] [--sitemap FILE] [--dry-run]');
      return 0;
    } else {
      console.error(`Unknown argument: ${a}`);
      return 2;
    }
  }
  const resolve = (p) => path.resolve(root, p);
  for (const key of ['data', 'index']) {
    if (!fs.existsSync(resolve(opts[key]))) {
      console.error(`${key} file not found: ${resolve(opts[key])}`);
      return 2;
    }
  }
  const data = parseDataFile(fs.readFileSync(resolve(opts.data), 'utf8'));
  const html = fs.readFileSync(resolve(opts.index), 'utf8');
  const result = prerenderIndex(html, data);
  console.log(`replaced: ${result.replaced.join(', ') || '(none)'}`);
  if (result.missing.length) console.warn(`missing: ${result.missing.join(', ')}`);
  if (result.invalid.length) console.warn(`invalid (element has child nodes): ${result.invalid.join(', ')}`);
  if (result.unknown.length) console.warn(`unknown keys left untouched: ${result.unknown.join(', ')}`);
  const sitemapPath = resolve(opts.sitemap);
  const sitemap = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : null;
  if (!opts.dryRun) {
    if (result.html !== html) fs.writeFileSync(resolve(opts.index), result.html);
    if (sitemap !== null) {
      const next = updateSitemap(sitemap, data);
      if (next !== sitemap) fs.writeFileSync(sitemapPath, next);
    }
  }
  console.log(opts.dryRun ? 'dry run: nothing written' : `wrote ${opts.index}${sitemap !== null ? ` and ${opts.sitemap}` : ''}`);
  return result.missing.length || result.invalid.length ? 1 : 0;
}

module.exports = {
  SITE_URL,
  CSV_URL,
  DATA_TERMS_URL,
  INLINE_KEYS,
  BLOCK_KEYS,
  computePrerenderValues,
  prerenderIndex,
  buildJsonLd,
  updateSitemap,
  extractFaq,
  renderBlocks,
  parseDataFile,
  escapeHtml,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
