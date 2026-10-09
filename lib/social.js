'use strict';
// Pure logic for the social boards (scripts/build-social.js): day selection and sums, the account
// pool, guardrail eligibility, board ranking, follower-snapshot deltas, top-post filtering, month
// counting, and validation of the published payload. No I/O, no clock, no network.

const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;

const MIN_FOLLOWERS = 10000;
const ADULT_LABELS = ['porn', 'sexual', 'nudity', 'graphic-media', 'gore'];
const BOARD_SIZE = 25;
const POST_CHARS = 280;
const MIN_CONTROVERSIAL_BLOCKS = 100;
const POOL_PER_LIST = 500;
const POOL_CAP = 6000;
const POOL_MAX_AGE_DAYS = 60;
const HISTORY_DAYS = 35;
const MAX_FEED_PAGES = 10;
const MAX_TOTAL_FEED_PAGES = 30;
const BLOCKS_ALL_REFRESH_MS = 20 * HOUR_MS;

const BOARD_KEYS = [
  'blocked_24h', 'blocked_7d', 'blocked_all',
  'growing_24h', 'growing_7d',
  'followed',
  'gainers_24h', 'losers_24h', 'gainers_7d', 'losers_7d',
  'controversial_24h', 'controversial_7d',
];

const HANDLE_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POST_URI_RE = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~-]{1,64})$/;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date) => Date.parse(date + 'T00:00:00Z');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- days ----------

// days: [{date, complete}]. `day` is the newest complete day, else the newest of any. The 7d window is
// the day files dated within the 7 days ending at `day`, complete or not.
function selectDays(days) {
  const sorted = days.filter((d) => d && DATE_RE.test(d.date)).sort((a, b) => cmp(a.date, b.date));
  if (!sorted.length) return null;
  const complete = sorted.filter((d) => d.complete);
  const day = complete.length ? complete[complete.length - 1] : sorted[sorted.length - 1];
  const from = isoDate(dateMs(day.date) - 6 * DAY_MS);
  const week = sorted.filter((d) => d.date >= from && d.date <= day.date).map((d) => d.date);
  return { day: day.date, complete: Boolean(day.complete), week, firstDay: sorted[0].date };
}

// lists: arrays of [key, count]; returns Map key -> summed count.
function sumLists(lists) {
  const m = new Map();
  for (const list of lists) for (const [k, v] of list) m.set(k, (m.get(k) || 0) + v);
  return m;
}

// entries: Map or [[key, value]]. Highest first, ties by key so output is stable.
function rankEntries(entries) {
  return [...entries].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
}

// ---------- eligibility ----------

// Label values are compared in one canonical form: compatibility-normalized (fullwidth '！' becomes '!'),
// control and zero-width characters dropped, trimmed, lowercase. A padded or recased '!hide' or 'Porn' still matches.
const LABEL_STRIP = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const normalizeLabel = (v) => v.normalize('NFKC').replace(LABEL_STRIP, '').trim().toLowerCase();

function labelVals(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  for (const l of labels) {
    const raw = typeof l === 'string' ? l : l && typeof l.val === 'string' ? l.val : '';
    const v = normalizeLabel(raw);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const hasBangLabel = (labels) => labelVals(labels).some((v) => v.startsWith('!'));
const hasAdultLabel = (labels) => labelVals(labels).some((v) => ADULT_LABELS.includes(v));

function validHandle(handle) {
  return typeof handle === 'string' && HANDLE_RE.test(handle) && !/\.invalid$/i.test(handle);
}

// Raw AppView profile (profileViewDetailed) -> may it be named on a board?
function isEligibleProfile(p) {
  if (!p || typeof p !== 'object' || typeof p.did !== 'string') return false;
  if (!validHandle(p.handle)) return false;
  if (!(Number.isFinite(p.followersCount) && p.followersCount >= MIN_FOLLOWERS)) return false;
  return !hasBangLabel(p.labels);
}

// ---------- pool ----------

// prev: pool accounts object {did: entry}; seen: Map did -> newest date it appeared. Entries are
// {last_seen, handle?, created_at?, pds?, followers?, blocks_all?: {total, at}}.
function mergePool(prev, seen) {
  const out = {};
  for (const [did, e] of Object.entries(prev || {})) out[did] = { ...e };
  for (const [did, date] of seen) {
    const e = out[did] || (out[did] = {});
    if (!e.last_seen || date > e.last_seen) e.last_seen = date;
  }
  return out;
}

// Drops DIDs unseen for 60 days that are under 10K followers (or never resolved), then caps the pool.
// Small recently seen accounts go first when trimming; known 10K+ accounts are kept longest.
function prunePool(accounts, nowMs, cap = POOL_CAP) {
  const cutoff = isoDate(nowMs - POOL_MAX_AGE_DAYS * DAY_MS);
  const kept = Object.entries(accounts).filter(([, e]) => !((e.last_seen || '') < cutoff && !(e.followers >= MIN_FOLLOWERS)));
  const tier = (e) => (Number.isFinite(e.followers) && e.followers < MIN_FOLLOWERS ? 0 : 1);
  kept.sort((a, b) => tier(b[1]) - tier(a[1]) || cmp(b[1].last_seen || '', a[1].last_seen || '') || (b[1].followers || 0) - (a[1].followers || 0) || cmp(a[0], b[0]));
  return Object.fromEntries(kept.slice(0, cap));
}

// ---------- boards ----------

// ranked: [[did, value]] best first; eligible: Set of dids. First `n` eligible rows.
function topEligible(ranked, eligible, n = BOARD_SIZE) {
  const out = [];
  for (const [did, value] of ranked) {
    if (!eligible.has(did)) continue;
    out.push({ did, value });
    if (out.length >= n) break;
  }
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;

// Day files keep the top 3000 follow counts (TOP_ACCOUNTS in lib/jetstream.js). A full-length list was cut
// at its smallest count; a shorter one is complete, so an account missing from it really had no follows.
const FOLLOWS_TOP_SIZE = 3000;

// lists: the follows_top lists of the days in the window; errors: per day, the most a true follow count can
// exceed what that day's file shows (the day file's `errors.follows`; null or non-finite when the file does
// not record it, which means unknown). Returns {sums, bound}: sums is Map did -> summed count over the days
// the account is listed (as sumLists); bound(did) is how much more than its sum the account can really have
// received. Per day: a listed account's stored count can be short by `error`; an unlisted one had at most
// the day's cut (the smallest count of a full-length list, 0 for a complete short list) plus `error`.
// A day with unknown error makes the bound Infinity. It is a ceiling, not an estimate: an account tied with
// the cut can be the one that was dropped.
function followsWithBounds(lists, topSize = FOLLOWS_TOP_SIZE, errors = lists.map(() => 0)) {
  const days = lists.map((list, i) => ({
    listed: new Set(list.map(([did]) => did)),
    cut: list.length >= topSize ? Math.min(...list.map(([, n]) => n)) : 0,
    error: Number.isFinite(errors[i]) && errors[i] >= 0 ? errors[i] : Infinity,
  }));
  return {
    sums: sumLists(lists),
    bound: (did) => days.reduce((acc, d) => acc + (d.listed.has(did) ? d.error : d.cut + d.error), 0),
  };
}

// Contract B controversial rows: {did, value, blocks, follows, follows_below_cut?}. value = blocks / follows,
// rounded to 2 places. When follows_below_cut is true the stored follow count may be short (the account was
// missing from a day's follow list, or a day's counts carry an error), so `follows` is the ceiling (known
// counts + the bound from followsWithBounds) and
// `value` is a lower bound on the true ratio, so it is rounded DOWN (never above the bound); the UI shows
// "≥value×" and "≤follows fol". The flag is omitted when follows is exact. Rows rank by value, then by the
// unrounded ratio, so two ratios that collapse to the same cent keep their real order.
//
// blocks / follows: Maps did -> count in the window. Accounts under minBlocks are skipped, and so are
// accounts with no follows at all (the ratio is undefined) or whose follow ceiling is unknown (infinite).
// bound(did): optional, from followsWithBounds; without it a DID missing from `follows` has 0 follows and
// is skipped.
function controversialRows(blocks, follows, eligible, n = BOARD_SIZE, minBlocks = MIN_CONTROVERSIAL_BLOCKS, bound = null) {
  const rows = [];
  for (const [did, b] of blocks) {
    if (b < minBlocks || !eligible.has(did)) continue;
    const extra = bound ? bound(did) : 0;
    if (!Number.isFinite(extra)) continue;
    const f = (follows.get(did) || 0) + extra;
    if (!(f > 0)) continue;
    const row = { did, value: extra > 0 ? Math.floor((b * 100) / f) / 100 : round2(b / f), blocks: b, follows: f };
    if (extra > 0) row.follows_below_cut = true;
    rows.push({ row, ratio: b / f });
  }
  rows.sort((x, y) => y.row.value - x.row.value || y.ratio - x.ratio || y.row.blocks - x.row.blocks || cmp(x.row.did, y.row.did));
  return rows.slice(0, n).map((r) => r.row);
}

// ---------- follower snapshots ----------

// history: {snapshots: [{at, followers: {did: n}}]} oldest first. Keeps one snapshot per UTC date (the
// first of the day, so a rerun never moves the baseline) and the newest 35 dates.
function addSnapshot(history, atMs, followers) {
  const snaps = (history && Array.isArray(history.snapshots) ? history.snapshots : []).filter((s) => s && Number.isFinite(Date.parse(s.at)));
  const date = isoDate(atMs);
  if (!snaps.some((s) => s.at.slice(0, 10) === date)) snaps.push({ at: new Date(atMs).toISOString(), followers });
  snaps.sort((a, b) => cmp(a.at, b.at));
  return { schema: 1, snapshots: snaps.slice(-HISTORY_DAYS) };
}

// The snapshot whose age is closest to targetMs within [minMs, maxMs], or null.
function pickBaseline(snapshots, nowMs, targetMs, minMs, maxMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const s of snapshots || []) {
    const age = nowMs - Date.parse(s.at);
    if (!(age >= minMs && age <= maxMs)) continue;
    const diff = Math.abs(age - targetMs);
    if (diff < bestDiff) { best = s; bestDiff = diff; }
  }
  return best;
}

const BASELINES = {
  '24h': { target: 24 * HOUR_MS, min: 20 * HOUR_MS, max: 36 * HOUR_MS },
  '7d': { target: 7 * DAY_MS, min: 6 * DAY_MS, max: 8 * DAY_MS },
};

// current: Map did -> followersCount (eligible accounts only). Returns {gainers, losers} (top n each).
function moverBoards(current, baseline, n = BOARD_SIZE) {
  const rows = [];
  if (baseline) {
    for (const [did, now] of current) {
      const before = baseline.followers[did];
      if (!Number.isFinite(before)) continue;
      rows.push({ did, value: now - before });
    }
  }
  const gainers = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value || cmp(a.did, b.did)).slice(0, n);
  const losers = rows.filter((r) => r.value < 0).sort((a, b) => a.value - b.value || cmp(a.did, b.did)).slice(0, n);
  return { gainers, losers };
}

// ---------- top posts ----------

function truncate(text, max = POST_CHARS) {
  const chars = Array.from(typeof text === 'string' ? text : '');
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
}

// AppView embed view -> 'image' | 'video' | 'quote' | 'link' | null. The UI shows it as a placeholder
// ("[image]") for posts with no text.
const EMBED_KINDS = ['image', 'video', 'quote', 'link'];
function embedKind(embed) {
  const t = embed && typeof embed.$type === 'string' ? embed.$type.replace(/#.*$/, '') : '';
  if (t === 'app.bsky.embed.images') return 'image';
  if (t === 'app.bsky.embed.video') return 'video';
  if (t === 'app.bsky.embed.external') return 'link';
  if (t === 'app.bsky.embed.record') return 'quote';
  if (t === 'app.bsky.embed.recordWithMedia') return embedKind(embed.media) || 'quote';
  return null;
}

function recordLabelVals(record) {
  const v = record && record.labels && Array.isArray(record.labels.values) ? record.labels.values : [];
  return labelVals(v);
}

function postLabelVals(post) {
  return [...labelVals(post.labels), ...recordLabelVals(post.record)];
}

// postViews: AppView postView objects; profiles: Map did -> raw profile (getProfiles). Keeps posts whose
// record was created on `day` (UTC) and first indexed no earlier than an hour before it (a backdated
// old post keeps its old indexedAt), from eligible authors, without '!' or adult labels on post or author.
function selectTopPosts(postViews, profiles, day, n = BOARD_SIZE) {
  const start = dateMs(day);
  const end = start + DAY_MS;
  const out = [];
  const seen = new Set();
  for (const post of postViews || []) {
    if (!post || typeof post.uri !== 'string' || seen.has(post.uri)) continue;
    const m = POST_URI_RE.exec(post.uri);
    const created = Date.parse(post.record && post.record.createdAt);
    if (!m || !(created >= start && created < end)) continue;
    const indexed = Date.parse(post.indexedAt);
    if (Number.isFinite(indexed) && indexed < start - HOUR_MS) continue;
    const authorDid = post.author && post.author.did;
    if (authorDid !== m[1]) continue;
    const profile = profiles.get(authorDid);
    if (!isEligibleProfile(profile)) continue;
    const labels = postLabelVals(post);
    const authorLabels = [...labelVals(profile.labels), ...labelVals(post.author.labels)];
    if ([...labels, ...authorLabels].some((v) => v.startsWith('!') || ADULT_LABELS.includes(v))) continue;
    if (!Number.isFinite(post.likeCount)) continue;
    const text = truncate(post.record.text);
    seen.add(post.uri);
    const item = {
      uri: post.uri,
      url: `https://bsky.app/profile/${profile.handle}/post/${m[2]}`,
      author: authorDid,
      text: text.trim() ? text : '',
      created_at: new Date(created).toISOString(),
      likes: post.likeCount,
      reposts: post.repostCount || 0,
      quotes: post.quoteCount || 0,
      replies: post.replyCount || 0,
    };
    const embed = embedKind(post.embed);
    if (embed) item.embed = embed;
    if (labels.length) item.labels = labels;
    out.push(item);
  }
  out.sort((a, b) => b.likes - a.likes || cmp(a.uri, b.uri));
  return out.slice(0, n);
}

// ---------- posts this month ----------

const monthStartMs = (nowMs) => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

function newFeedScan(did, nowMs) {
  return { did, monthStart: monthStartMs(nowMs), nowMs, count: 0, lastPosted: null, pages: 0, ownPages: 0, done: false, capped: false, pastMonth: false };
}

// Feeds one getAuthorFeed page (filter=posts_with_replies, newest first) into the scan. Counts the account's
// own posts, replies included, reposts excluded (author.did matches, no repost reason), the same definition as
// Bluesky's own postsCount. Scanning stops at the first item (post or repost) that entered the feed before
// the month began, but not before one own post has been seen (for last_posted). Reposts never use up the
// own-post page cap, so a feed that is mostly reposts is still read to the month boundary; the count is
// capped only when maxOwnPages pages that held own posts, or maxPages pages in all, were read with the
// month boundary still ahead.
function scanFeedPage(scan, items, hasMore, maxOwnPages = MAX_FEED_PAGES, maxPages = MAX_TOTAL_FEED_PAGES) {
  scan.pages++;
  let ownOnPage = false;
  for (const item of items || []) {
    const post = item && item.post;
    if (!post) continue;
    if (!item.reason && post.author && post.author.did === scan.did) {
      ownOnPage = true;
      const created = Date.parse(post.record && post.record.createdAt);
      if (Number.isFinite(created) && created <= scan.nowMs + 5 * 60e3) {
        if (scan.lastPosted == null || created > scan.lastPosted) scan.lastPosted = created;
        if (created >= scan.monthStart) scan.count++;
      }
    }
    const sortAt = Date.parse(item.reason ? item.reason.indexedAt : post.indexedAt);
    if (Number.isFinite(sortAt) && sortAt < scan.monthStart) {
      scan.pastMonth = true;
      if (scan.lastPosted != null) { scan.done = true; break; }
    }
  }
  if (ownOnPage) scan.ownPages++;
  if (!hasMore) scan.done = true;
  if (!scan.done && (scan.ownPages >= maxOwnPages || scan.pages >= maxPages)) { scan.done = true; scan.capped = !scan.pastMonth; }
  return scan.done;
}

function scanResult(scan) {
  return {
    posts_this_month: scan.count,
    posts_this_month_capped: scan.capped,
    last_posted: scan.lastPosted == null ? null : new Date(scan.lastPosted).toISOString(),
  };
}

// ---------- accounts ----------

// Raw profile -> contract B account, keeping cached created_at/pds when the profile lacks them.
function toAccount(profile, cache = {}) {
  return {
    handle: profile.handle,
    display_name: typeof profile.displayName === 'string' ? profile.displayName : '',
    avatar: typeof profile.avatar === 'string' ? profile.avatar : '',
    followers: profile.followersCount,
    follows: profile.followsCount || 0,
    posts: profile.postsCount || 0,
    posts_this_month: null,
    posts_this_month_capped: false,
    last_posted: null,
    created_at: profile.createdAt || cache.created_at || null,
    pds: cache.pds || null,
    labels: labelVals(profile.labels),
  };
}

// did:web -> the URL of its DID document, per the did:web method (null if the DID is malformed): colons after
// the host become path segments, '%3A' is a port colon, and a bare host uses /.well-known/did.json.
function didWebUrl(did) {
  if (typeof did !== 'string' || !did.startsWith('did:web:')) return null;
  try {
    const parts = did.slice(8).split(':').map(decodeURIComponent);
    const host = parts[0];
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host) || !host.includes('.')) return null;
    const segs = parts.slice(1);
    if (segs.some((x) => !x || /[/?#\\\s]/.test(x) || x === '.' || x === '..')) return null;
    return `https://${host}/${segs.length ? segs.map(encodeURIComponent).join('/') + '/did.json' : '.well-known/did.json'}`;
  } catch (e) {
    return null;
  }
}

// DID document -> PDS service endpoint (or null).
function pdsFromDidDoc(doc) {
  const svc = doc && Array.isArray(doc.service) ? doc.service.find((s) => s && (s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')) : null;
  const url = svc && svc.serviceEndpoint;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

// ---------- all-time blocks (Constellation) ----------

// Which candidate DIDs to query this run: uncached first, then oldest, only those due, at most `budget`.
function blocksAllDue(dids, poolAccounts, nowMs, budget) {
  const due = [];
  for (const did of dids) {
    const c = poolAccounts[did] && poolAccounts[did].blocks_all;
    const at = c ? Date.parse(c.at) : NaN;
    if (!Number.isFinite(at)) due.push([did, -Infinity]);
    else if (nowMs - at >= BLOCKS_ALL_REFRESH_MS) due.push([did, at]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, budget).map(([did]) => did);
}

// ---------- validation ----------

const isInt = (x) => Number.isInteger(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Returns a list of problems (empty = valid). Checks shape, ordering, that every board and post DID has an
// account, and that every named account passes the guardrails.
function validateSocial(s) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!s || typeof s !== 'object') return ['payload is not an object'];
  if (s.schema !== 1) err('schema must be 1');
  if (!Number.isFinite(Date.parse(s.generated_at))) err('generated_at is not a date');
  if (!DATE_RE.test(s.day || '')) err('day is not YYYY-MM-DD');
  const cov = s.coverage || {};
  if (!isInt(cov.days_7d) || cov.days_7d < 1 || cov.days_7d > 7) err('coverage.days_7d must be 1..7');
  if (typeof cov.complete_24h !== 'boolean') err('coverage.complete_24h must be boolean');
  if (!DATE_RE.test(cov.first_day || '')) err('coverage.first_day is not YYYY-MM-DD');
  const g = s.guardrails || {};
  if (g.min_followers !== MIN_FOLLOWERS) err('guardrails.min_followers must be 10000');
  if (!Array.isArray(g.adult_labels) || ADULT_LABELS.some((l) => !g.adult_labels.includes(l))) err('guardrails.adult_labels incomplete');
  if (!s.totals || !isNum(s.totals.follows_24h) || !isNum(s.totals.blocks_24h)) err('totals must have numeric follows_24h and blocks_24h');

  const accounts = s.accounts && typeof s.accounts === 'object' ? s.accounts : null;
  if (!accounts) return [...errors, 'accounts missing'];
  const referenced = new Set();

  const boards = s.boards && typeof s.boards === 'object' ? s.boards : null;
  if (!boards) return [...errors, 'boards missing'];
  for (const key of BOARD_KEYS) {
    const rows = boards[key];
    if (!Array.isArray(rows)) { err(`boards.${key} must be an array`); continue; }
    if (rows.length > BOARD_SIZE) err(`boards.${key} has more than ${BOARD_SIZE} rows`);
    const seen = new Set();
    let prev = null;
    for (const r of rows) {
      if (!r || typeof r.did !== 'string') { err(`boards.${key} row without did`); continue; }
      if (seen.has(r.did)) err(`boards.${key} lists ${r.did} twice`);
      seen.add(r.did);
      referenced.add(r.did);
      if (!isNum(r.value)) err(`boards.${key} ${r.did} value is not a number`);
      else {
        if (prev != null && (key.startsWith('losers_') ? r.value < prev : r.value > prev)) err(`boards.${key} is not sorted`);
        prev = r.value;
        if (key.startsWith('gainers_') && r.value <= 0) err(`boards.${key} ${r.did} is not a gain`);
        if (key.startsWith('losers_') && r.value >= 0) err(`boards.${key} ${r.did} is not a loss`);
      }
      if (key.startsWith('controversial_')) {
        if (!isNum(r.blocks) || r.blocks < MIN_CONTROVERSIAL_BLOCKS || !isNum(r.follows)) err(`boards.${key} ${r.did} needs blocks >= ${MIN_CONTROVERSIAL_BLOCKS} and follows`);
        if (r.follows_below_cut !== undefined && r.follows_below_cut !== true) err(`boards.${key} ${r.did} follows_below_cut must be true when present`);
      }
    }
  }

  const posts = Array.isArray(s.top_posts) ? s.top_posts : null;
  if (!posts) err('top_posts must be an array');
  else {
    if (posts.length > BOARD_SIZE) err(`top_posts has more than ${BOARD_SIZE} posts`);
    const dayStart = DATE_RE.test(s.day || '') ? dateMs(s.day) : NaN;
    let prev = null;
    for (const p of posts) {
      const m = p && typeof p.uri === 'string' ? POST_URI_RE.exec(p.uri) : null;
      if (!m) { err('top_posts entry with a bad uri'); continue; }
      referenced.add(p.author);
      const a = accounts[p.author];
      if (p.author !== m[1]) err(`post ${p.uri} author does not match its uri`);
      if (a && p.url !== `https://bsky.app/profile/${a.handle}/post/${m[2]}`) err(`post ${p.uri} url is wrong`);
      if (typeof p.text !== 'string' || Array.from(p.text).length > POST_CHARS) err(`post ${p.uri} text is missing or over ${POST_CHARS} chars`);
      const created = Date.parse(p.created_at);
      if (!(created >= dayStart && created < dayStart + DAY_MS)) err(`post ${p.uri} was not created on ${s.day}`);
      if (!isNum(p.likes)) err(`post ${p.uri} likes is not a number`);
      else { if (prev != null && p.likes > prev) err('top_posts is not sorted by likes'); prev = p.likes; }
      for (const k of ['reposts', 'quotes', 'replies']) if (!isNum(p[k])) err(`post ${p.uri} ${k} is not a number`);
      if (p.embed !== undefined && !EMBED_KINDS.includes(p.embed)) err(`post ${p.uri} embed must be one of ${EMBED_KINDS.join(', ')}`);
      const labels = [...labelVals(p.labels), ...labelVals(a && a.labels)];
      if (labels.some((v) => v.startsWith('!') || ADULT_LABELS.includes(v))) err(`post ${p.uri} carries a forbidden label`);
    }
  }

  for (const did of referenced) if (!Object.prototype.hasOwnProperty.call(accounts, did)) err(`${did} is referenced but missing from accounts`);
  for (const [did, a] of Object.entries(accounts)) {
    if (!referenced.has(did)) err(`${did} is in accounts but not referenced`);
    if (!a || typeof a !== 'object') { err(`${did} account is not an object`); continue; }
    if (!validHandle(a.handle)) err(`${did} has an unusable handle`);
    if (!(isNum(a.followers) && a.followers >= MIN_FOLLOWERS)) err(`${did} is under ${MIN_FOLLOWERS} followers`);
    if (hasBangLabel(a.labels)) err(`${did} carries a '!' label`);
    for (const k of ['follows', 'posts']) if (!isNum(a[k])) err(`${did} ${k} is not a number`);
    for (const k of ['display_name', 'avatar']) if (typeof a[k] !== 'string') err(`${did} ${k} is not a string`);
    if (a.posts_this_month !== null && !isNum(a.posts_this_month)) err(`${did} posts_this_month is not a number or null`);
    if (typeof a.posts_this_month_capped !== 'boolean') err(`${did} posts_this_month_capped is not boolean`);
    for (const k of ['last_posted', 'created_at']) if (a[k] !== null && !Number.isFinite(Date.parse(a[k]))) err(`${did} ${k} is not a date or null`);
    if (a.pds !== null && !/^https?:\/\//.test(a.pds || '')) err(`${did} pds is not a URL or null`);
  }
  return errors;
}

function renderScript(social) {
  return `// generated by scripts/build-social.js — do not edit\nwindow.BLUESKY_SOCIAL = ${JSON.stringify(social)};\n`;
}

module.exports = {
  DAY_MS,
  MIN_FOLLOWERS,
  ADULT_LABELS,
  BOARD_SIZE,
  BOARD_KEYS,
  POST_CHARS,
  POOL_PER_LIST,
  POOL_CAP,
  MIN_CONTROVERSIAL_BLOCKS,
  MAX_FEED_PAGES,
  MAX_TOTAL_FEED_PAGES,
  BASELINES,
  selectDays,
  sumLists,
  rankEntries,
  labelVals,
  hasBangLabel,
  hasAdultLabel,
  normalizeLabel,
  validHandle,
  isEligibleProfile,
  mergePool,
  prunePool,
  topEligible,
  controversialRows,
  followsWithBounds,
  FOLLOWS_TOP_SIZE,
  addSnapshot,
  pickBaseline,
  moverBoards,
  truncate,
  selectTopPosts,
  embedKind,
  EMBED_KINDS,
  didWebUrl,
  monthStartMs,
  newFeedScan,
  scanFeedPage,
  scanResult,
  toAccount,
  pdsFromDidDoc,
  blocksAllDue,
  validateSocial,
  renderScript,
};
