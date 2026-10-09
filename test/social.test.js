'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const s = require('../lib/social.js');
const { main } = require('../scripts/build-social.js');
const { buildSocialFixture } = require('./fixtures/social-fixture.js');

const ms = (iso) => Date.parse(iso);
const H = 3600e3;
const D = 86400e3;

const profile = (did, over = {}) => ({
  did,
  handle: `${did.slice(8)}.example.com`,
  displayName: `Name ${did.slice(8)}`,
  avatar: `https://cdn.bsky.app/img/avatar/plain/${did}/x@jpeg`,
  followersCount: 50000,
  followsCount: 10,
  postsCount: 99,
  createdAt: '2023-05-01T00:00:00.000Z',
  labels: [],
  ...over,
});

// ---------- day selection and sums ----------

test('selectDays: newest complete day wins, even when a newer partial day exists', () => {
  const sel = s.selectDays([
    { date: '2026-10-07', complete: true },
    { date: '2026-10-08', complete: true },
    { date: '2026-10-09', complete: false },
  ]);
  assert.equal(sel.day, '2026-10-08');
  assert.equal(sel.complete, true);
  assert.deepEqual(sel.week, ['2026-10-07', '2026-10-08']);
  assert.equal(sel.firstDay, '2026-10-07');
});

test('selectDays: with no complete day it falls back to the newest and says it is partial', () => {
  const sel = s.selectDays([{ date: '2026-10-08', complete: false }, { date: '2026-10-09', complete: false }]);
  assert.equal(sel.day, '2026-10-09');
  assert.equal(sel.complete, false);
  assert.deepEqual(sel.week, ['2026-10-08', '2026-10-09']);
});

test('selectDays: the 7d window is the 7 dates ending at day, partial files included, older ones excluded', () => {
  const days = ['09-30', '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07'].map((d, i) => ({ date: `2026-${d}`, complete: i !== 3 }));
  const sel = s.selectDays(days);
  assert.equal(sel.day, '2026-10-07');
  assert.deepEqual(sel.week, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  assert.equal(sel.firstDay, '2026-09-30');
});

test('selectDays: no files -> null; junk dates ignored', () => {
  assert.equal(s.selectDays([]), null);
  assert.equal(s.selectDays([{ date: 'nope', complete: true }]), null);
});

test('sumLists adds counts per key across days; rankEntries is stable', () => {
  const m = s.sumLists([[['a', 5], ['b', 2]], [['b', 4], ['c', 6]]]);
  assert.deepEqual([...m], [['a', 5], ['b', 6], ['c', 6]]);
  assert.deepEqual(s.rankEntries(m), [['b', 6], ['c', 6], ['a', 5]]);
});

// ---------- eligibility ----------

test('isEligibleProfile: followers threshold is 10,000 inclusive', () => {
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { followersCount: 10000 })), true);
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { followersCount: 9999 })), false);
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { followersCount: undefined })), false);
});

test('isEligibleProfile: any label starting with ! excludes, string or object form', () => {
  for (const labels of [['!no-unauthenticated'], [{ val: '!hide' }], [{ val: '!takedown' }], [{ val: '!warn' }], [{ val: 'ok' }, { val: '!no-unauthenticated', src: 'did:plc:me' }]]) {
    assert.equal(s.isEligibleProfile(profile('did:plc:a', { labels })), false, JSON.stringify(labels));
  }
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { labels: [{ val: 'porn' }, { val: 'spam' }] })), true);
});

test('label values are normalised (trim, case, controls, fullwidth) before every guardrail check', () => {
  for (const v of [' !hide', '\n!hide', '\u200b!hide', '！hide', '\t!NO-unauthenticated ', '!Takedown']) {
    assert.equal(s.hasBangLabel([v]), true, JSON.stringify(v));
    assert.equal(s.hasBangLabel([{ val: v }]), true, JSON.stringify(v));
    assert.equal(s.isEligibleProfile(profile('did:plc:a', { labels: [{ val: v }] })), false, JSON.stringify(v));
  }
  for (const v of ['Porn', ' porn', '\u200bporn', 'Graphic-Media ', 'GORE', 'ｓｅｘｕａｌ']) {
    assert.equal(s.hasAdultLabel([{ val: v }]), true, JSON.stringify(v));
  }
  assert.deepEqual(s.labelVals([' Spam ', { val: 'SPAM' }, '', '\u200b', null, 5]), ['spam']);
  assert.equal(s.hasBangLabel(['not!a-bang']), false);
});

test('isEligibleProfile: unresolved profile, handle.invalid and malformed handles are out', () => {
  assert.equal(s.isEligibleProfile(undefined), false);
  assert.equal(s.isEligibleProfile(null), false);
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { handle: 'handle.invalid' })), false);
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { handle: 'x"><b>.example' })), false);
  assert.equal(s.isEligibleProfile(profile('did:plc:a', { handle: undefined })), false);
});

// ---------- pool ----------

test('mergePool keeps cached fields and moves last_seen forward only', () => {
  const merged = s.mergePool(
    { 'did:plc:a': { last_seen: '2026-10-05', handle: 'a.example', pds: 'https://p' }, 'did:plc:b': { last_seen: '2026-10-09' } },
    new Map([['did:plc:a', '2026-10-08'], ['did:plc:b', '2026-10-01'], ['did:plc:c', '2026-10-08']]),
  );
  assert.deepEqual(merged['did:plc:a'], { last_seen: '2026-10-08', handle: 'a.example', pds: 'https://p' });
  assert.equal(merged['did:plc:b'].last_seen, '2026-10-09');
  assert.deepEqual(merged['did:plc:c'], { last_seen: '2026-10-08' });
});

test('prunePool drops DIDs unseen for 60 days under 10K followers, keeps big or recent ones', () => {
  const now = ms('2026-10-09T00:00:00Z');
  const pool = s.prunePool({
    'did:plc:oldsmall': { last_seen: '2026-07-01', followers: 500 },
    'did:plc:oldunknown': { last_seen: '2026-07-01' },
    'did:plc:oldbig': { last_seen: '2026-07-01', followers: 10000 },
    'did:plc:newsmall': { last_seen: '2026-10-01', followers: 500 },
    'did:plc:edge': { last_seen: '2026-08-10', followers: 5 },
  }, now);
  assert.deepEqual(Object.keys(pool).sort(), ['did:plc:edge', 'did:plc:newsmall', 'did:plc:oldbig']);
});

test('prunePool caps the pool, trimming known-small and oldest-seen accounts first', () => {
  const now = ms('2026-10-09T00:00:00Z');
  const accounts = {
    'did:plc:big': { last_seen: '2026-09-20', followers: 90000 },
    'did:plc:newunknown': { last_seen: '2026-10-08' },
    'did:plc:newsmall': { last_seen: '2026-10-09', followers: 10 },
    'did:plc:oldsmall': { last_seen: '2026-09-01', followers: 10 },
  };
  assert.deepEqual(Object.keys(s.prunePool(accounts, now, 2)), ['did:plc:newunknown', 'did:plc:big']);
  assert.equal(Object.keys(s.prunePool(accounts, now, 10)).length, 4);
});

// ---------- boards ----------

test('topEligible skips ineligible DIDs and caps at n', () => {
  const ranked = [['a', 9], ['x', 8], ['b', 7], ['c', 6], ['d', 5]];
  assert.deepEqual(s.topEligible(ranked, new Set(['a', 'b', 'c', 'd']), 3), [{ did: 'a', value: 9 }, { did: 'b', value: 7 }, { did: 'c', value: 6 }]);
});

test('controversialRows: needs 100 blocks, ratio is blocks/follows, accounts with no follows are skipped', () => {
  const blocks = new Map([['a', 100], ['b', 99], ['c', 400], ['d', 250], ['gone', 900]]);
  const follows = new Map([['a', 40], ['b', 1], ['c', 100], ['d', 0]]);
  const rows = s.controversialRows(blocks, follows, new Set(['a', 'b', 'c', 'd']));
  assert.deepEqual(rows, [
    { did: 'c', value: 4, blocks: 400, follows: 100 },
    { did: 'a', value: 2.5, blocks: 100, follows: 40 },
  ], 'd has 0 follows (ratio undefined) and is not given a made-up value of blocks / 1');
  assert.equal(s.controversialRows(new Map([['a', 100]]), new Map([['a', 3]]), new Set(['a']))[0].value, 33.33);
  assert.equal(s.controversialRows(blocks, follows, new Set(['a', 'b', 'c', 'd']), 1).length, 1);
});

test('followsWithBounds: a full-length list is cut at its smallest count; a short list is complete', () => {
  const full = [['a', 9], ['b', 7], ['c', 5]];
  const short = [['a', 4]];
  const { sums, bound } = s.followsWithBounds([full, short], 3);
  assert.deepEqual([...sums], [['a', 13], ['b', 7], ['c', 5]]);
  assert.equal(bound('a'), 0);
  assert.equal(bound('zed'), 5, 'missing from the cut list: at most the cut; the short list adds nothing');
  assert.equal(bound('b'), 0);
  const twoCut = s.followsWithBounds([full, [['x', 8], ['y', 3], ['z', 3]]], 3);
  assert.equal(twoCut.bound('zed'), 8);
  assert.equal(twoCut.bound('a'), 3, 'listed on day one only: day two adds its cut');
});

test('controversialRows: an account below the follow cut gets a follows ceiling, a lower-bound ratio and a flag', () => {
  const blocks = new Map([['a', 244], ['b', 300], ['c', 100]]);
  const follows = new Map([['b', 100], ['c', 50]]);
  const bound = (did) => (did === 'a' ? 29 : did === 'c' ? 20 : 0);
  const rows = s.controversialRows(blocks, follows, new Set(['a', 'b', 'c']), 25, 100, bound);
  assert.deepEqual(rows, [
    { did: 'a', value: 8.41, blocks: 244, follows: 29, follows_below_cut: true },
    { did: 'b', value: 3, blocks: 300, follows: 100 },
    { did: 'c', value: 1.42, blocks: 100, follows: 70, follows_below_cut: true },
  ]);
  assert.ok(!('follows_below_cut' in rows[1]), 'exact rows carry no flag');
});

test('controversialRows: a below-cut lower bound rounds down and never exceeds the true ratio', () => {
  const blocks = new Map([['a', 200], ['b', 244], ['c', 100]]);
  const bound = (did) => ({ a: 3, b: 29, c: 30 }[did]);
  const rows = s.controversialRows(blocks, new Map(), new Set(['a', 'b', 'c']), 25, 100, bound);
  assert.deepEqual(rows.map((r) => [r.did, r.value]), [['a', 66.66], ['b', 8.41], ['c', 3.33]]);
  for (const r of rows) assert.ok(r.value <= r.blocks / r.follows, `${r.did}: ${r.value} > ${r.blocks / r.follows}`);
  assert.equal(s.controversialRows(new Map([['a', 200]]), new Map([['a', 3]]), new Set(['a']), 25, 100, () => 0)[0].value, 66.67, 'an exact ratio still rounds to nearest');
});

test('controversialRows: ratios that collapse to the same cent keep their real order, then blocks, then did', () => {
  const blocks = new Map([['x', 333], ['y', 100], ['z', 200]]);
  const follows = new Map([['x', 100], ['y', 30], ['z', 60]]);
  const rows = s.controversialRows(blocks, follows, new Set(['x', 'y', 'z']));
  assert.deepEqual(rows.map((r) => [r.did, r.value]), [['z', 3.33], ['y', 3.33], ['x', 3.33]], 'x is exactly 3.33; y and z are 3.3333, so they rank above it even though all round to 3.33; y and z tie, more blocks first');
  const mixed = s.controversialRows(new Map([['p', 100], ['q', 334]]), new Map([['p', 30], ['q', 100]]), new Set(['p', 'q']));
  assert.deepEqual(mixed.map((r) => r.did), ['q', 'p']);
});

// ---------- follower snapshots ----------

const snap = (at, followers) => ({ at, followers });

test('addSnapshot keeps the first snapshot of a UTC date and the newest 35', () => {
  let h = s.addSnapshot(null, ms('2026-10-08T03:00:00Z'), { a: 1 });
  h = s.addSnapshot(h, ms('2026-10-08T15:00:00Z'), { a: 2 });
  h = s.addSnapshot(h, ms('2026-10-09T03:00:00Z'), { a: 3 });
  assert.deepEqual(h.snapshots.map((x) => [x.at, x.followers.a]), [['2026-10-08T03:00:00.000Z', 1], ['2026-10-09T03:00:00.000Z', 3]]);
  const start = ms('2026-10-10T03:00:00Z');
  for (let i = 0; i < 40; i++) h = s.addSnapshot(h, start + i * D, { a: i });
  assert.equal(h.snapshots.length, 35);
  assert.equal(h.snapshots[h.snapshots.length - 1].at, new Date(start + 39 * D).toISOString());
});

test('pickBaseline: 24h needs a snapshot at least 20h old and not older than 36h', () => {
  const now = ms('2026-10-09T03:00:00Z');
  const b = s.BASELINES['24h'];
  const snaps = [snap('2026-10-09T02:00:00Z', {}), snap('2026-10-07T03:00:00Z', {})];
  assert.equal(s.pickBaseline(snaps, now, b.target, b.min, b.max), null);
  const withYesterday = [...snaps, snap('2026-10-08T03:30:00Z', { ok: 1 })];
  assert.deepEqual(s.pickBaseline(withYesterday, now, b.target, b.min, b.max).followers, { ok: 1 });
  assert.equal(s.pickBaseline([snap('2026-10-08T08:00:00Z', {})], now, b.target, b.min, b.max), null, '20h minus a bit is too young');
});

test('pickBaseline: 7d picks the snapshot closest to 7 days back within 6-8 days', () => {
  const now = ms('2026-10-09T03:00:00Z');
  const b = s.BASELINES['7d'];
  const snaps = [snap('2026-10-01T03:00:00Z', { eight: 1 }), snap('2026-10-02T03:00:00Z', { seven: 1 }), snap('2026-10-03T03:00:00Z', { six: 1 }), snap('2026-10-05T03:00:00Z', { four: 1 })];
  assert.deepEqual(s.pickBaseline(snaps, now, b.target, b.min, b.max).followers, { seven: 1 });
  assert.equal(s.pickBaseline([snap('2026-10-05T03:00:00Z', {})], now, b.target, b.min, b.max), null);
});

test('moverBoards: net change vs baseline, gains and losses split, new and unchanged accounts skipped', () => {
  const baseline = snap('2026-10-08T03:00:00Z', { a: 1000, b: 5000, c: 200, d: 777 });
  const current = new Map([['a', 1500], ['b', 4000], ['c', 200], ['d', 700], ['new', 99999], ['e', 3]]);
  const { gainers, losers } = s.moverBoards(current, baseline);
  assert.deepEqual(gainers, [{ did: 'a', value: 500 }]);
  assert.deepEqual(losers, [{ did: 'b', value: -1000 }, { did: 'd', value: -77 }]);
  assert.deepEqual(s.moverBoards(current, null), { gainers: [], losers: [] });
  const many = new Map(Array.from({ length: 40 }, (_, i) => [`x${String(i).padStart(2, '0')}`, 1000 + i]));
  const base = snap('t', Object.fromEntries([...many.keys()].map((k) => [k, 0])));
  assert.equal(s.moverBoards(many, base).gainers.length, 25);
  assert.equal(s.moverBoards(many, base).gainers[0].value, 1039);
});

// ---------- top posts ----------

const DAY = '2026-10-08';
const post = (author, rkey, over = {}) => ({
  uri: `at://${author}/app.bsky.feed.post/${rkey}`,
  author: { did: author, handle: 'x.example.com', labels: [] },
  record: { text: 'hello', createdAt: '2026-10-08T12:00:00.000Z' },
  indexedAt: '2026-10-08T12:00:01.000Z',
  likeCount: 100,
  repostCount: 10,
  quoteCount: 2,
  replyCount: 3,
  labels: [],
  ...over,
});

test('selectTopPosts: ranks by likes, builds url, truncates, and only keeps posts created on the day', () => {
  const profiles = new Map([['did:plc:a', profile('did:plc:a', { handle: 'alice.example.com' })], ['did:plc:b', profile('did:plc:b')]]);
  const long = 'é'.repeat(400);
  const posts = [
    post('did:plc:a', '3aaa', { likeCount: 50 }),
    post('did:plc:b', '3bbb', { likeCount: 90, record: { text: long, createdAt: '2026-10-08T23:59:59.999Z' } }),
    post('did:plc:a', '3old', { likeCount: 5000, record: { text: 'older', createdAt: '2026-10-07T23:59:59.999Z' } }),
    post('did:plc:a', '3next', { likeCount: 5000, record: { text: 'newer', createdAt: '2026-10-09T00:00:00.000Z' } }),
    post('did:plc:a', '3aaa', { likeCount: 50 }),
  ];
  const out = s.selectTopPosts(posts, profiles, DAY);
  assert.deepEqual(out.map((p) => p.uri.split('/').pop()), ['3bbb', '3aaa']);
  assert.equal(out[1].url, 'https://bsky.app/profile/alice.example.com/post/3aaa');
  assert.equal(Array.from(out[0].text).length, 280);
  assert.ok(out[0].text.endsWith('…'));
  assert.deepEqual([out[1].likes, out[1].reposts, out[1].quotes, out[1].replies], [50, 10, 2, 3]);
  assert.equal(out[1].created_at, '2026-10-08T12:00:00.000Z');
});

test('selectTopPosts: author must be eligible (followers, ! label, unresolved, handle.invalid)', () => {
  const profiles = new Map([
    ['did:plc:ok', profile('did:plc:ok')],
    ['did:plc:small', profile('did:plc:small', { followersCount: 9999 })],
    ['did:plc:optout', profile('did:plc:optout', { labels: [{ val: '!no-unauthenticated' }] })],
    ['did:plc:invalid', profile('did:plc:invalid', { handle: 'handle.invalid' })],
  ]);
  const posts = ['ok', 'small', 'optout', 'invalid', 'unresolved'].map((n) => post(`did:plc:${n}`, `3${n}`));
  assert.deepEqual(s.selectTopPosts(posts, profiles, DAY).map((p) => p.author), ['did:plc:ok']);
});

test('selectTopPosts: ! and adult labels on the post or the author skip it, other labels do not', () => {
  const profiles = new Map([
    ['did:plc:ok', profile('did:plc:ok')],
    ['did:plc:adultauthor', profile('did:plc:adultauthor', { labels: [{ val: 'porn' }] })],
    ['did:plc:viewlabel', profile('did:plc:viewlabel')],
  ]);
  const posts = [
    post('did:plc:ok', '3clean'),
    ...['porn', 'sexual', 'nudity', 'graphic-media', 'gore', '!warn', '!hide'].map((v) => post('did:plc:ok', `3${v.replace('!', 'x')}`, { labels: [{ val: v }] })),
    post('did:plc:ok', '3selflabel', { record: { text: 'hi', createdAt: '2026-10-08T01:00:00Z', labels: { values: [{ val: 'porn' }] } } }),
    post('did:plc:adultauthor', '3byadult'),
    post('did:plc:viewlabel', '3authorlabel', { author: { did: 'did:plc:viewlabel', handle: 'v.example.com', labels: [{ val: 'sexual' }] } }),
    post('did:plc:ok', '3spam', { labels: [{ val: 'spam' }] }),
  ];
  const out = s.selectTopPosts(posts, profiles, DAY);
  assert.deepEqual(out.map((p) => p.uri.split('/').pop()).sort(), ['3clean', '3spam']);
  assert.deepEqual(out.find((p) => p.uri.endsWith('3spam')).labels, ['spam']);
});

test('selectTopPosts: backdated posts, uri/author mismatch, missing text or likes are dropped', () => {
  const profiles = new Map([['did:plc:a', profile('did:plc:a')]]);
  const posts = [
    post('did:plc:a', '3backdated', { indexedAt: '2026-09-01T00:00:00Z' }),
    post('did:plc:a', '3mismatch', { author: { did: 'did:plc:other', handle: 'o.example.com' } }),
    post('did:plc:a', '3nolikes', { likeCount: undefined }),
    post('did:plc:a', '3late', { indexedAt: '2026-10-09T08:00:00Z' }),
    { uri: 'not-a-uri', author: { did: 'did:plc:a' }, record: { createdAt: '2026-10-08T05:00:00Z', text: 'x' } },
    null,
  ];
  assert.deepEqual(s.selectTopPosts(posts, profiles, DAY).map((p) => p.uri.split('/').pop()), ['3late']);
});

test('selectTopPosts: image and quote posts with no text stay and rank by likes, with their embed kind', () => {
  const profiles = new Map([['did:plc:a', profile('did:plc:a')]]);
  const posts = [
    post('did:plc:a', '3text', { likeCount: 100 }),
    post('did:plc:a', '3image', { likeCount: 14018, record: { text: '', createdAt: '2026-10-08T05:00:00Z' }, embed: { $type: 'app.bsky.embed.images#view', images: [] } }),
    post('did:plc:a', '3blank', { likeCount: 9000, record: { text: '   ', createdAt: '2026-10-08T05:00:00Z' }, embed: { $type: 'app.bsky.embed.record#view' } }),
    post('did:plc:a', '3both', { likeCount: 500, record: { createdAt: '2026-10-08T05:00:00Z' }, embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: { $type: 'app.bsky.embed.video#view' } } }),
  ];
  const out = s.selectTopPosts(posts, profiles, DAY);
  assert.deepEqual(out.map((p) => p.uri.split('/').pop()), ['3image', '3blank', '3both', '3text']);
  assert.deepEqual(out.map((p) => p.text), ['', '', '', 'hello']);
  assert.deepEqual(out.map((p) => p.embed), ['image', 'quote', 'video', undefined]);
  assert.deepEqual(s.validateSocial({ ...validPayload(), top_posts: [{ ...validPayload().top_posts[0], text: '', embed: 'image' }] }), []);
  assert.ok(s.validateSocial({ ...validPayload(), top_posts: [{ ...validPayload().top_posts[0], embed: '<img>' }] }).some((m) => /embed must be/.test(m)));
});

test('selectTopPosts: label case and padding on the post or author do not slip a ! or adult label through', () => {
  const profiles = new Map([['did:plc:a', profile('did:plc:a')], ['did:plc:b', profile('did:plc:b', { labels: [{ val: ' PORN' }] })]]);
  const posts = [
    post('did:plc:a', '3ok'),
    post('did:plc:a', '3caps', { labels: [{ val: 'Porn' }] }),
    post('did:plc:a', '3pad', { labels: [{ val: ' !hide' }] }),
    post('did:plc:a', '3self', { record: { text: 'x', createdAt: '2026-10-08T05:00:00Z', labels: { values: [{ val: 'GORE' }] } } }),
    post('did:plc:b', '3author'),
  ];
  assert.deepEqual(s.selectTopPosts(posts, profiles, DAY).map((p) => p.uri.split('/').pop()), ['3ok']);
});

test('didWebUrl follows the did:web method: host, port, path segments', () => {
  assert.equal(s.didWebUrl('did:web:example.com'), 'https://example.com/.well-known/did.json');
  assert.equal(s.didWebUrl('did:web:example.com:users:alice'), 'https://example.com/users/alice/did.json');
  assert.equal(s.didWebUrl('did:web:example.com%3A3000'), 'https://example.com:3000/.well-known/did.json');
  assert.equal(s.didWebUrl('did:web:example.com%3A3000:u'), 'https://example.com:3000/u/did.json');
  for (const bad of ['did:web:', 'did:web:localhost', 'did:web:example.com::x', 'did:web:example.com:..:x', 'did:web:exa mple.com', 'did:web:example.com:a%2Fb', 'did:plc:abc', null, 5]) {
    assert.equal(s.didWebUrl(bad), null, String(bad));
  }
});

test('selectTopPosts: returns at most 25', () => {
  const profiles = new Map([['did:plc:a', profile('did:plc:a')]]);
  const posts = Array.from({ length: 40 }, (_, i) => post('did:plc:a', `3p${i}`, { likeCount: i }));
  const out = s.selectTopPosts(posts, profiles, DAY);
  assert.equal(out.length, 25);
  assert.equal(out[0].likes, 39);
});

// ---------- posts this month ----------

const NOW = ms('2026-10-09T12:00:00Z');
const own = (did, createdAt, over = {}) => ({ post: { author: { did }, record: { createdAt }, indexedAt: createdAt, ...over } });
const repost = (by, did, createdAt, repostedAt) => ({ post: { author: { did }, record: { createdAt }, indexedAt: createdAt }, reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { did: by }, indexedAt: repostedAt } });

test('monthStartMs is the first of the UTC month', () => {
  assert.equal(new Date(s.monthStartMs(ms('2026-10-31T23:59:59Z'))).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(new Date(s.monthStartMs(ms('2026-01-01T00:00:00Z'))).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('scanFeedPage counts own posts and replies, ignores reposts and others, stops at the month boundary', () => {
  const me = 'did:plc:me';
  const scan = s.newFeedScan(me, NOW);
  const done = s.scanFeedPage(scan, [
    own(me, '2026-10-09T10:00:00Z'),
    repost(me, 'did:plc:other', '2026-09-01T00:00:00Z', '2026-10-09T09:00:00Z'),
    own('did:plc:other', '2026-10-09T08:00:00Z'),
    own(me, '2026-10-02T08:00:00Z', { record: { createdAt: '2026-10-02T08:00:00Z', reply: { parent: {} } } }),
    own(me, '2026-09-30T23:59:59Z'),
    own(me, '2026-09-30T20:00:00Z'),
  ], true);
  assert.equal(done, true);
  assert.deepEqual(s.scanResult(scan), { posts_this_month: 2, posts_this_month_capped: false, last_posted: '2026-10-09T10:00:00.000Z' });
});

test('scanFeedPage: last_posted skips reposts even when they are newest; null when there are no own posts', () => {
  const me = 'did:plc:me';
  const scan = s.newFeedScan(me, NOW);
  s.scanFeedPage(scan, [repost(me, 'did:plc:o', '2026-10-01T00:00:00Z', '2026-10-09T11:00:00Z'), own(me, '2026-10-09T01:00:00Z')], false);
  assert.equal(s.scanResult(scan).last_posted, '2026-10-09T01:00:00.000Z');
  const empty = s.newFeedScan(me, NOW);
  s.scanFeedPage(empty, [repost(me, 'did:plc:o', '2026-10-01T00:00:00Z', '2026-10-09T11:00:00Z')], false);
  assert.deepEqual(s.scanResult(empty), { posts_this_month: 0, posts_this_month_capped: false, last_posted: null });
});

test('scanFeedPage: an inactive account still gets last_posted from before the month, scanning past old reposts', () => {
  const me = 'did:plc:me';
  const scan = s.newFeedScan(me, NOW);
  assert.equal(s.scanFeedPage(scan, [repost(me, 'did:plc:o', '2025-01-01T00:00:00Z', '2026-08-01T00:00:00Z')], true), false);
  assert.equal(s.scanFeedPage(scan, [own(me, '2026-07-04T00:00:00Z'), own(me, '2026-06-04T00:00:00Z')], true), true);
  assert.deepEqual(s.scanResult(scan), { posts_this_month: 0, posts_this_month_capped: false, last_posted: '2026-07-04T00:00:00.000Z' });

  const never = s.newFeedScan(me, NOW);
  const oldRepost = [repost(me, 'did:plc:o', '2025-01-01T00:00:00Z', '2026-08-01T00:00:00Z')];
  for (let i = 0; i < s.MAX_TOTAL_FEED_PAGES; i++) s.scanFeedPage(never, oldRepost, true);
  assert.equal(never.done, true);
  assert.deepEqual(s.scanResult(never), { posts_this_month: 0, posts_this_month_capped: false, last_posted: null }, 'month is exhausted, so the count is exact even when the page cap ends the scan');
});

test('scanFeedPage: a backdated post does not end the scan early, and future-dated posts are ignored', () => {
  const me = 'did:plc:me';
  const scan = s.newFeedScan(me, NOW);
  s.scanFeedPage(scan, [
    own(me, '2026-09-01T00:00:00Z', { indexedAt: '2026-10-08T00:00:00Z' }),
    own(me, '2027-01-01T00:00:00Z', { indexedAt: '2026-10-08T00:00:00Z' }),
    own(me, '2026-10-05T00:00:00Z'),
  ], false);
  assert.equal(scan.count, 1);
  assert.equal(scan.lastPosted, ms('2026-10-05T00:00:00Z'));
});

test('scanFeedPage: pages of reposts neither stop the scan nor set capped; only the total-page cap does', () => {
  const me = 'did:plc:me';
  const reposts = Array.from({ length: 100 }, (_, i) => repost(me, 'did:plc:o', '2026-09-01T00:00:00Z', `2026-10-09T05:${String(i % 60).padStart(2, '0')}:00Z`));
  const scan = s.newFeedScan(me, NOW);
  for (let i = 0; i < 12; i++) assert.equal(s.scanFeedPage(scan, reposts, true), false, `page ${i + 1} of reposts must not end the scan`);
  assert.equal(scan.capped, false);
  assert.equal(scan.ownPages, 0);
  assert.equal(s.scanFeedPage(scan, [own(me, '2026-10-08T10:00:00Z'), own(me, '2026-10-07T10:00:00Z')], true), false);
  assert.equal(scan.count, 2, 'own posts after a long run of reposts are still counted');
  const rest = s.newFeedScan(me, NOW);
  rest.pages = 0;
  let pages = 0;
  while (!s.scanFeedPage(rest, reposts, true)) pages++;
  assert.equal(pages + 1, s.MAX_TOTAL_FEED_PAGES);
  assert.equal(rest.capped, true, 'the total cap stopped it before the month boundary');
  const mixed = s.newFeedScan(me, NOW);
  const halfAndHalf = [...reposts.slice(0, 90), ...Array.from({ length: 10 }, () => own(me, '2026-10-05T00:00:00Z'))];
  let n = 0;
  while (!s.scanFeedPage(mixed, halfAndHalf, true)) n++;
  assert.equal(n + 1, s.MAX_FEED_PAGES, 'pages that hold own posts use the own-post cap');
  assert.equal(mixed.capped, true);
  assert.equal(mixed.count, 100);
});

test('scanFeedPage: caps after 10 pages when the month is not exhausted, and not when the feed ends on page 10', () => {
  const me = 'did:plc:me';
  const page = Array.from({ length: 100 }, (_, i) => own(me, `2026-10-05T00:${String(i % 60).padStart(2, '0')}:00Z`));
  const scan = s.newFeedScan(me, NOW);
  let pages = 0;
  while (!s.scanFeedPage(scan, page, true)) pages++;
  assert.equal(pages + 1, 10);
  assert.deepEqual(s.scanResult(scan), { posts_this_month: 1000, posts_this_month_capped: true, last_posted: '2026-10-05T00:59:00.000Z' });

  const exact = s.newFeedScan(me, NOW);
  for (let i = 0; i < 10; i++) s.scanFeedPage(exact, page, i < 9);
  assert.equal(exact.capped, false);
  assert.equal(exact.count, 1000);

  const bounded = s.newFeedScan(me, NOW);
  for (let i = 0; i < 9; i++) s.scanFeedPage(bounded, page, true);
  assert.equal(s.scanFeedPage(bounded, [...page.slice(0, 3), own(me, '2026-09-20T00:00:00Z')], true), true);
  assert.equal(bounded.capped, false);
});

// ---------- accounts, constellation ----------

test('toAccount maps a profile, keeping cached created_at/pds as fallback', () => {
  const a = s.toAccount(profile('did:plc:a', { createdAt: undefined, labels: [{ val: 'porn' }, 'x'] }), { created_at: '2022-01-01T00:00:00Z', pds: 'https://p.example' });
  assert.equal(a.created_at, '2022-01-01T00:00:00Z');
  assert.equal(a.pds, 'https://p.example');
  assert.deepEqual(a.labels, ['porn', 'x']);
  assert.equal(a.followers, 50000);
  assert.equal(a.posts_this_month, null);
});

test('pdsFromDidDoc finds the atproto PDS service', () => {
  assert.equal(s.pdsFromDidDoc({ service: [{ id: '#atproto_labeler', serviceEndpoint: 'https://l' }, { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] }), 'https://pds.example');
  assert.equal(s.pdsFromDidDoc({ service: [] }), null);
  assert.equal(s.pdsFromDidDoc(null), null);
  assert.equal(s.pdsFromDidDoc({ service: [{ id: '#atproto_pds', serviceEndpoint: 'javascript:alert(1)' }] }), null);
});

test('blocksAllDue: uncached first, then oldest, skipping fresh ones, within the budget', () => {
  const now = ms('2026-10-09T12:00:00Z');
  const pool = {
    fresh: { blocks_all: { total: 1, at: '2026-10-09T01:00:00Z' } },
    stale: { blocks_all: { total: 1, at: '2026-10-08T01:00:00Z' } },
    staler: { blocks_all: { total: 1, at: '2026-10-01T01:00:00Z' } },
  };
  assert.deepEqual(s.blocksAllDue(['fresh', 'stale', 'staler', 'none'], pool, now, 10), ['none', 'staler', 'stale']);
  assert.deepEqual(s.blocksAllDue(['fresh', 'stale', 'staler', 'none'], pool, now, 2), ['none', 'staler']);
});

// ---------- validation ----------

test('validateSocial accepts the UI fixture (fixtures hold ineligible rows only in boards, so strip them first)', () => {
  const f = buildSocialFixture();
  const bad = new Set(f.ineligibleDids);
  for (const k of Object.keys(f.boards)) f.boards[k] = f.boards[k].filter((r) => !bad.has(r.did));
  f.top_posts = f.top_posts.filter((p) => !bad.has(p.author) && !p.labels && !f.hostilePosts.includes(p.uri));
  for (const d of bad) delete f.accounts[d];
  f.boards.followed = f.boards.followed.slice(0, 25);
  for (const k of Object.keys(f.boards)) f.boards[k] = f.boards[k].slice(0, 25);
  f.top_posts = f.top_posts.slice(0, 25);
  const used = new Set([...Object.values(f.boards).flat().map((r) => r.did), ...f.top_posts.map((p) => p.author)]);
  for (const d of Object.keys(f.accounts)) if (!used.has(d)) delete f.accounts[d];
  for (const k of ['controversial_24h', 'controversial_7d']) f.boards[k] = f.boards[k].filter((r) => r.blocks >= 100);
  for (const p of f.top_posts) p.created_at = `${f.day}T12:00:00.000Z`;
  const { ineligibleDids, hostilePosts, ...payload } = f;
  assert.deepEqual(s.validateSocial(payload), []);
});

function validPayload() {
  const acc = (h) => ({ handle: h, display_name: 'N', avatar: 'https://x/y', followers: 20000, follows: 1, posts: 2, posts_this_month: 3, posts_this_month_capped: false, last_posted: '2026-10-08T01:00:00.000Z', created_at: '2023-01-01T00:00:00.000Z', pds: 'https://pds.example', labels: [] });
  const boards = {};
  for (const k of s.BOARD_KEYS) boards[k] = [];
  boards.followed = [{ did: 'did:plc:a', value: 20000 }, { did: 'did:plc:b', value: 15000 }];
  boards.losers_24h = [{ did: 'did:plc:a', value: -50 }, { did: 'did:plc:b', value: -10 }];
  boards.gainers_24h = [{ did: 'did:plc:b', value: 50 }, { did: 'did:plc:a', value: 10 }];
  boards.controversial_24h = [{ did: 'did:plc:a', value: 2, blocks: 200, follows: 100 }];
  return {
    schema: 1,
    generated_at: '2026-10-09T03:00:00.000Z',
    day: '2026-10-08',
    coverage: { days_7d: 2, complete_24h: true, first_day: '2026-10-07' },
    guardrails: { min_followers: 10000, excluded_labels: "any label starting with '!'", adult_labels: s.ADULT_LABELS },
    accounts: { 'did:plc:a': acc('a.example.com'), 'did:plc:b': acc('b.example.com') },
    boards,
    top_posts: [{ uri: 'at://did:plc:a/app.bsky.feed.post/3abc', url: 'https://bsky.app/profile/a.example.com/post/3abc', author: 'did:plc:a', text: 'hi', created_at: '2026-10-08T05:00:00.000Z', likes: 9, reposts: 1, quotes: 0, replies: 2 }],
    totals: { follows_24h: 10, blocks_24h: 5 },
  };
}

test('validateSocial: a well-formed payload has no problems', () => {
  assert.deepEqual(s.validateSocial(validPayload()), []);
});

test('validateSocial catches the structural and guardrail failures', () => {
  const cases = [
    ['missing board', (p) => { delete p.boards.blocked_7d; }, /blocked_7d must be an array/],
    ['board did without account', (p) => { p.boards.followed.push({ did: 'did:plc:ghost', value: 1 }); }, /ghost.*missing from accounts/],
    ['named account under 10K', (p) => { p.accounts['did:plc:b'].followers = 9999; }, /did:plc:b is under 10000/],
    ['named account with ! label', (p) => { p.accounts['did:plc:a'].labels = ['!no-unauthenticated']; }, /'!' label/],
    ['handle.invalid', (p) => { p.accounts['did:plc:a'].handle = 'handle.invalid'; }, /unusable handle/],
    ['unreferenced account', (p) => { p.accounts['did:plc:c'] = { ...p.accounts['did:plc:a'], handle: 'c.example.com' }; }, /not referenced/],
    ['unsorted board', (p) => { p.boards.followed.reverse(); }, /followed is not sorted/],
    ['unsorted losers', (p) => { p.boards.losers_24h.reverse(); }, /losers_24h is not sorted/],
    ['gainer with a loss', (p) => { p.boards.gainers_24h[0].value = -1; }, /not a gain/],
    ['duplicate row', (p) => { p.boards.followed[1].did = 'did:plc:a'; }, /twice/],
    ['over 25 rows', (p) => { p.boards.followed = Array.from({ length: 26 }, () => ({ did: 'did:plc:a', value: 1 })); }, /more than 25/],
    ['controversial under 100 blocks', (p) => { p.boards.controversial_24h[0].blocks = 99; }, /blocks >= 100/],
    ['post on the wrong day', (p) => { p.top_posts[0].created_at = '2026-10-07T23:59:59.000Z'; }, /not created on 2026-10-08/],
    ['post text too long', (p) => { p.top_posts[0].text = 'x'.repeat(281); }, /over 280/],
    ['post with adult label', (p) => { p.top_posts[0].labels = [{ val: 'gore' }]; }, /forbidden label/],
    ['post by adult-labelled author', (p) => { p.accounts['did:plc:a'].labels = ['porn']; }, /forbidden label/],
    ['post url mismatch', (p) => { p.top_posts[0].url = 'https://bsky.app/profile/other/post/3abc'; }, /url is wrong/],
    ['post author without account', (p) => { p.top_posts[0].author = 'did:plc:zzz'; p.top_posts[0].uri = 'at://did:plc:zzz/app.bsky.feed.post/3abc'; }, /zzz.*missing from accounts/],
    ['wrong schema', (p) => { p.schema = 2; }, /schema must be 1/],
    ['bad coverage', (p) => { p.coverage.days_7d = 8; }, /days_7d/],
    ['guardrail weakened', (p) => { p.guardrails.min_followers = 100; }, /min_followers/],
    ['bad follows_below_cut', (p) => { p.boards.controversial_24h[0].follows_below_cut = false; }, /follows_below_cut must be true/],
    ['non-numeric value', (p) => { p.boards.followed[0].value = 'lots'; }, /value is not a number/],
  ];
  for (const [name, mutate, re] of cases) {
    const p = validPayload();
    mutate(p);
    const problems = s.validateSocial(p);
    assert.ok(problems.some((m) => re.test(m)), `${name}: got ${JSON.stringify(problems)}`);
  }
});

test('renderScript wraps the payload as a classic script that sets window.BLUESKY_SOCIAL', () => {
  const text = s.renderScript(validPayload());
  assert.ok(text.startsWith('// generated by scripts/build-social.js — do not edit\nwindow.BLUESKY_SOCIAL = {'));
  const ctx = { window: {} };
  vm.runInNewContext(text, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.window.BLUESKY_SOCIAL)), validPayload());
});

// ---------- end to end with a mocked network ----------

const NOW_ISO = '2026-10-10T04:00:00Z';
const BIG = {
  alice: 'did:plc:alice',
  bob: 'did:plc:bob',
  carol: 'did:plc:carol',
  dave: 'did:plc:dave',
  erin: 'did:plc:erin',
  frank: 'did:plc:frank',
  gina: 'did:plc:gina',
  hank: 'did:plc:hank',
  ivy: 'did:plc:ivy',
  ghost: 'did:plc:ghost',
};

function makeProfiles() {
  const p = (name, over) => profile(BIG[name], { handle: `${name}.example.com`, ...over });
  return {
    [BIG.alice]: p('alice', { followersCount: 500000 }),
    [BIG.bob]: p('bob', { followersCount: 20000 }),
    [BIG.carol]: p('carol', { followersCount: 5000 }),
    [BIG.dave]: p('dave', { followersCount: 80000, labels: [{ val: '!no-unauthenticated' }] }),
    [BIG.erin]: p('erin', { followersCount: 30000, handle: 'handle.invalid' }),
    [BIG.gina]: p('gina', { followersCount: 12000, labels: [{ val: 'porn' }] }),
    [BIG.hank]: p('hank', { followersCount: 15000, createdAt: undefined }),
    [BIG.ivy]: p('ivy', { followersCount: 100000 }),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function dayFile(date, complete, over = {}) {
  return {
    schema: 1,
    date,
    window: { start: `${date}T00:00:00Z`, end: `${date}T23:59:59Z`, covered_seconds: complete ? 86400 : 40000, gaps: [] },
    complete,
    totals: { follows: 1000, blocks: 500, likes_sampled: 10, reposts_sampled: 1, sample_seconds: 60 },
    follows_top: [],
    blocks_top: [],
    post_candidates: [],
    ...over,
  };
}

const postUri = (name, rkey) => `at://${BIG[name]}/app.bsky.feed.post/${rkey}`;

function makeNetwork({ failProfiles = false, failConstellation = false, extraProfiles = {}, failProfilesFirst = 0, failProfilesFor = null, failPostsFor = null, flakyConstellation = false, docs = {}, extraPosts = {} } = {}) {
  const profiles = { ...makeProfiles(), ...extraProfiles };
  let profileRequests = 0;
  const flaked = new Set();
  const live = (name, rkey, over = {}) => post(BIG[name], rkey, { record: { text: 'hello', createdAt: '2026-10-09T10:00:00.000Z' }, indexedAt: '2026-10-09T10:00:01.000Z', ...over });
  const posts = {
    ...extraPosts,
    [postUri('alice', '3alicegood')]: live('alice', '3alicegood', { likeCount: 900 }),
    [postUri('alice', '3aliceold')]: live('alice', '3aliceold', { likeCount: 9000, record: { text: 'old', createdAt: '2026-10-08T23:00:00.000Z' }, indexedAt: '2026-10-08T23:00:01.000Z' }),
    [postUri('bob', '3bobgore')]: live('bob', '3bobgore', { likeCount: 800, labels: [{ val: 'gore' }] }),
    [postUri('gina', '3ginaporn')]: live('gina', '3ginaporn', { likeCount: 700 }),
    [postUri('dave', '3davehidden')]: live('dave', '3davehidden', { likeCount: 600 }),
    [postUri('carol', '3carolsmall')]: live('carol', '3carolsmall', { likeCount: 550 }),
    [postUri('hank', '3hankok')]: live('hank', '3hankok', { likeCount: 500 }),
    [postUri('ivy', '3ivytop')]: live('ivy', '3ivytop', { likeCount: 1500, record: { text: 'z'.repeat(500), createdAt: '2026-10-09T20:00:00.000Z' }, indexedAt: '2026-10-09T20:00:02.000Z' }),
  };
  const calls = [];
  const feedItems = (did) => {
    if (did === BIG.bob) return { items: Array.from({ length: 100 }, (_, i) => own(did, `2026-10-05T00:${String(i % 60).padStart(2, '0')}:00Z`)), cursor: 'more' };
    if (did === BIG.alice) return { items: [own(did, '2026-10-09T10:00:00Z'), own(did, '2026-10-02T10:00:00Z'), repost(did, BIG.bob, '2026-09-01T00:00:00Z', '2026-10-03T00:00:00Z'), own(did, '2026-09-29T10:00:00Z')], cursor: 'more' };
    return { items: [own(did, '2026-10-09T09:00:00Z')], cursor: '' };
  };
  const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
  const fail = (status) => ({ ok: false, status, headers: new Map(), json: async () => ({}) });
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('app.bsky.actor.getProfiles')) {
      if (failProfiles || profileRequests++ < failProfilesFirst) return fail(500);
      if (failProfilesFor && u.searchParams.getAll('actors').includes(failProfilesFor)) return fail(500);
      return json({ profiles: u.searchParams.getAll('actors').map((a) => profiles[a]).filter(Boolean) });
    }
    if (u.pathname.endsWith('app.bsky.feed.getPosts')) {
      if (failPostsFor && u.searchParams.getAll('uris').includes(failPostsFor)) return fail(500);
    }
    if (u.pathname.endsWith('app.bsky.feed.getPosts')) return json({ posts: u.searchParams.getAll('uris').map((x) => posts[x]).filter(Boolean) });
    if (u.pathname.endsWith('app.bsky.feed.getAuthorFeed')) {
      const { items, cursor } = feedItems(u.searchParams.get('actor'));
      return json({ feed: items, cursor });
    }
    if (u.host === 'constellation.microcosm.blue') {
      if (failConstellation) return fail(503);
      if (flakyConstellation) {
        const t = u.searchParams.get('target');
        if (!flaked.has(t)) { flaked.add(t); return fail(500); }
      }
      return json({ total: 1000 + u.searchParams.get('target').length * 10 + (u.searchParams.get('target') === BIG.bob ? 5000 : 0) });
    }
    if (u.host === 'plc.directory') {
      const did = u.pathname.slice(1).replace('/log/audit', '');
      if (u.pathname.endsWith('/log/audit')) return json([{ createdAt: '2022-02-02T00:00:00.000Z' }]);
      return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: `https://pds-${did.slice(8)}.example.org` }] });
    }
    const doc = docs[u.host + u.pathname];
    if (doc) return json(doc);
    return fail(404);
  };
  return { fetchImpl, calls, profiles };
}

function setupDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-test-'));
  const days = path.join(dir, 'social', 'days');
  const f1 = dayFile('2026-10-08', true, {
    follows_top: [[BIG.alice, 300], [BIG.dave, 200], [BIG.bob, 40]],
    blocks_top: [[BIG.carol, 900], [BIG.bob, 120], [BIG.alice, 50]],
  });
  const f2 = dayFile('2026-10-09', true, {
    totals: { follows: 2600, blocks: 540, likes_sampled: 10, reposts_sampled: 1, sample_seconds: 60 },
    follows_top: [[BIG.ivy, 500], [BIG.alice, 400], [BIG.dave, 100], [BIG.erin, 90], [BIG.gina, 80], [BIG.hank, 70], [BIG.bob, 10]],
    blocks_top: [[BIG.dave, 700], [BIG.bob, 300], [BIG.erin, 250], [BIG.alice, 200], [BIG.carol, 150], [BIG.gina, 99], [BIG.ghost, 600], [BIG.hank, 120]],
  });
  f2.post_candidates = [
    [postUri('alice', '3alicegood'), 10, 1], [postUri('alice', '3aliceold'), 9, 1], [postUri('bob', '3bobgore'), 8, 1], [postUri('gina', '3ginaporn'), 7, 1],
    [postUri('dave', '3davehidden'), 6, 1], [postUri('carol', '3carolsmall'), 5, 1], [postUri('hank', '3hankok'), 4, 1], [postUri('ivy', '3ivytop'), 3, 1],
  ];
  writeJson(path.join(days, '2026-10-08.json'), f1);
  writeJson(path.join(days, '2026-10-09.json'), f2);
  if (extra.history) writeJson(path.join(dir, 'social', 'followers-history.json'), extra.history);
  if (extra.pool) writeJson(path.join(dir, 'social', 'pool.json'), extra.pool);
  return dir;
}

const run = (dir, net, env = {}) => main({
  env: { DATA_DIR: dir, NOW: NOW_ISO, ...env },
  fetchImpl: net.fetchImpl,
  sleep: async () => {},
  log: () => {},
  intervals: {},
});

function readSocial(dir) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'social.js'), 'utf8'), ctx);
  return JSON.parse(JSON.stringify(ctx.window.BLUESKY_SOCIAL));
}

test('end to end: boards, guardrails, posts, metadata and files from mocked network', async () => {
  const history = {
    schema: 1,
    snapshots: [
      { at: '2026-10-03T03:00:00.000Z', followers: { [BIG.alice]: 490000, [BIG.bob]: 25000, [BIG.hank]: 15000 } },
      { at: '2026-10-09T03:30:00.000Z', followers: { [BIG.alice]: 499000, [BIG.bob]: 21000, [BIG.hank]: 15000 } },
    ],
  };
  const dir = setupDir({ history });
  const net = makeNetwork();
  const { summary } = await run(dir, net);
  const out = readSocial(dir);

  assert.deepEqual(s.validateSocial(out), []);
  assert.equal(out.schema, 1);
  assert.equal(out.day, '2026-10-09');
  assert.deepEqual(out.coverage, { days_7d: 2, complete_24h: true, first_day: '2026-10-08' });
  assert.deepEqual(out.totals, { follows_24h: 2600, blocks_24h: 540 });
  assert.equal(out.generated_at, '2026-10-10T04:00:00.000Z');

  const dids = (k) => out.boards[k].map((r) => r.did);
  const names = (k) => dids(k).map((d) => out.accounts[d].handle.split('.')[0]);
  assert.deepEqual(names('blocked_24h'), ['bob', 'alice', 'hank', 'gina']);
  assert.deepEqual(names('blocked_7d'), ['bob', 'alice', 'hank', 'gina']);
  assert.deepEqual(out.boards.blocked_7d.map((r) => r.value), [420, 250, 120, 99]);
  assert.deepEqual(names('growing_24h'), ['ivy', 'alice', 'gina', 'hank', 'bob']);
  assert.deepEqual(out.boards.growing_7d.map((r) => r.value), [700, 500, 80, 70, 50]);
  assert.deepEqual(names('followed'), ['alice', 'ivy', 'bob', 'hank', 'gina']);
  assert.deepEqual(names('gainers_24h'), ['alice']);
  assert.deepEqual(out.boards.gainers_24h, [{ did: BIG.alice, value: 1000 }]);
  assert.deepEqual(out.boards.losers_24h, [{ did: BIG.bob, value: -1000 }]);
  assert.deepEqual(out.boards.gainers_7d, [{ did: BIG.alice, value: 10000 }]);
  assert.deepEqual(out.boards.losers_7d, [{ did: BIG.bob, value: -5000 }]);
  assert.deepEqual(out.boards.controversial_24h, [
    { did: BIG.bob, value: 30, blocks: 300, follows: 10 },
    { did: BIG.alice, value: 0.5, blocks: 200, follows: 400 },
    { did: BIG.hank, value: 1.71, blocks: 120, follows: 70 },
  ].sort((a, b) => b.value - a.value));
  assert.deepEqual(out.boards.controversial_7d.map((r) => [r.did, r.blocks, r.follows]), [[BIG.bob, 420, 50], [BIG.hank, 120, 70], [BIG.alice, 250, 700]]);
  assert.equal(out.boards.blocked_all[0].did, BIG.bob);
  assert.equal(out.boards.blocked_all.length, 5);

  for (const key of Object.keys(out.boards)) {
    for (const r of out.boards[key]) {
      assert.ok(![BIG.carol, BIG.dave, BIG.erin, BIG.ghost].includes(r.did), `${key} names an ineligible account`);
    }
  }
  assert.ok(!Object.keys(out.accounts).some((d) => [BIG.carol, BIG.dave, BIG.erin, BIG.ghost].includes(d)));

  assert.deepEqual(out.top_posts.map((p) => p.uri.split('/').pop()), ['3ivytop', '3alicegood', '3hankok']);
  assert.equal(Array.from(out.top_posts[0].text).length, 280);
  assert.equal(out.top_posts[0].url, 'https://bsky.app/profile/ivy.example.com/post/3ivytop');
  assert.ok(out.accounts[BIG.ivy], 'post-only author gets an account');

  const alice = out.accounts[BIG.alice];
  assert.equal(alice.posts_this_month, 2, 'two own posts in October; the repost is ignored and the scan stops at the September item');
  assert.equal(alice.posts_this_month_capped, false);
  assert.equal(alice.last_posted, '2026-10-09T10:00:00.000Z');
  assert.equal(alice.pds, 'https://pds-alice.example.org');
  assert.equal(out.accounts[BIG.bob].posts_this_month, 1000);
  assert.equal(out.accounts[BIG.bob].posts_this_month_capped, true);
  assert.equal(out.accounts[BIG.hank].created_at, '2022-02-02T00:00:00.000Z', 'missing createdAt falls back to the PLC audit log');
  assert.deepEqual(out.accounts[BIG.gina].labels, ['porn']);

  const pool = JSON.parse(fs.readFileSync(path.join(dir, 'social', 'pool.json'), 'utf8'));
  assert.equal(pool.schema, 1);
  assert.ok(pool.accounts[BIG.carol], 'ineligible accounts stay in the pool');
  assert.equal(pool.accounts[BIG.carol].followers, 5000);
  assert.equal(pool.accounts[BIG.alice].pds, 'https://pds-alice.example.org');
  assert.equal(pool.accounts[BIG.bob].blocks_all.at, '2026-10-10T04:00:00.000Z');
  assert.equal(pool.accounts[BIG.alice].last_seen, '2026-10-09');

  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'social', 'followers-history.json'), 'utf8'));
  assert.equal(hist.snapshots.length, 3);
  assert.equal(hist.snapshots[2].at, '2026-10-10T04:00:00.000Z');
  assert.equal(hist.snapshots[2].followers[BIG.alice], 500000);
  assert.equal(hist.snapshots[2].followers[BIG.carol], undefined, 'only 10K+ accounts are snapshotted');
  assert.equal(hist.snapshots[2].followers[BIG.dave], 80000);

  assert.ok(summary.requests['public.api.bsky.app'] > 0);
  assert.ok(!net.calls.some((u) => u.includes('constellation') && u.includes(BIG.carol)), 'no Constellation calls for ineligible accounts');
  fs.rmSync(dir, { recursive: true });
});

test('end to end: first run has no snapshots, so movers are empty; a rerun within a day reuses fresh Constellation counts', async () => {
  const dir = setupDir();
  const net = makeNetwork();
  await run(dir, net);
  const first = readSocial(dir);
  for (const k of ['gainers_24h', 'losers_24h', 'gainers_7d', 'losers_7d']) assert.deepEqual(first.boards[k], []);
  const constellationCalls = net.calls.filter((u) => u.includes('constellation')).length;
  assert.ok(constellationCalls > 0);

  const net2 = makeNetwork();
  await run(dir, net2, { NOW: '2026-10-10T09:00:00Z' });
  assert.equal(net2.calls.filter((u) => u.includes('constellation')).length, 0, 'counts younger than 20h are not refetched');
  assert.equal(net2.calls.filter((u) => u.includes('plc.directory') && !u.includes('audit')).length, 0, 'PDS hosts come from the pool cache');
  const second = readSocial(dir);
  assert.deepEqual(second.boards.blocked_all, first.boards.blocked_all);
  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'social', 'followers-history.json'), 'utf8'));
  assert.equal(hist.snapshots.length, 1, 'one snapshot per UTC date');
  fs.rmSync(dir, { recursive: true });
});

test('end to end: only partial days -> newest day, complete_24h false', async () => {
  const dir = setupDir();
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'social', 'days', '2026-10-09.json'), 'utf8'));
  f.complete = false;
  writeJson(path.join(dir, 'social', 'days', '2026-10-09.json'), f);
  const g = JSON.parse(fs.readFileSync(path.join(dir, 'social', 'days', '2026-10-08.json'), 'utf8'));
  g.complete = false;
  writeJson(path.join(dir, 'social', 'days', '2026-10-08.json'), g);
  await run(dir, makeNetwork());
  const out = readSocial(dir);
  assert.equal(out.day, '2026-10-09');
  assert.equal(out.coverage.complete_24h, false);
  assert.equal(out.coverage.days_7d, 2);
  fs.rmSync(dir, { recursive: true });
});

test('end to end: essential AppView failure exits with an error and writes nothing', async () => {
  const dir = setupDir();
  await assert.rejects(run(dir, makeNetwork({ failProfiles: true })), /profile batches failed/);
  assert.equal(fs.existsSync(path.join(dir, 'social.js')), false);
  assert.equal(fs.existsSync(path.join(dir, 'social', 'pool.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'social', 'followers-history.json')), false);
  fs.rmSync(dir, { recursive: true });
});

test('end to end: Constellation outage is not fatal; blocked_all is just empty', async () => {
  const dir = setupDir();
  await run(dir, makeNetwork({ failConstellation: true }));
  const out = readSocial(dir);
  assert.deepEqual(out.boards.blocked_all, []);
  assert.ok(out.boards.followed.length > 0);
  fs.rmSync(dir, { recursive: true });
});

test('end to end: no day files is an error and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-test-'));
  await assert.rejects(run(dir, makeNetwork()), /no day files/);
  assert.equal(fs.existsSync(path.join(dir, 'social.js')), false);
  fs.rmSync(dir, { recursive: true });
});

test('end to end: accounts missing from a full-length follows list get a ceiling, not 0 follows', async () => {
  const dir = setupDir();
  const days = path.join(dir, 'social', 'days');
  const f2 = JSON.parse(fs.readFileSync(path.join(days, '2026-10-09.json'), 'utf8'));
  const keep = f2.follows_top.filter(([did]) => did !== BIG.bob && did !== BIG.hank);
  const filler = Array.from({ length: s.FOLLOWS_TOP_SIZE - keep.length }, (_, i) => [`did:plc:filler${i}`, 5]);
  f2.follows_top = [...keep, ...filler];
  writeJson(path.join(days, '2026-10-09.json'), f2);
  await run(dir, makeNetwork());
  const out = readSocial(dir);
  assert.deepEqual(s.validateSocial(out), []);
  const row = (key, who) => out.boards[key].find((r) => r.did === BIG[who]);
  assert.deepEqual(row('controversial_24h', 'bob'), { did: BIG.bob, value: 60, blocks: 300, follows: 5, follows_below_cut: true });
  assert.deepEqual(row('controversial_24h', 'hank'), { did: BIG.hank, value: 24, blocks: 120, follows: 5, follows_below_cut: true });
  assert.deepEqual(row('controversial_24h', 'alice'), { did: BIG.alice, value: 0.5, blocks: 200, follows: 400 });
  assert.deepEqual(out.boards.controversial_24h.map((r) => r.did), [BIG.bob, BIG.hank, BIG.alice]);
  assert.deepEqual(row('controversial_7d', 'bob'), { did: BIG.bob, value: 9.33, blocks: 420, follows: 45, follows_below_cut: true }, '40 listed on the short day + the 5 cut on the full one');
  assert.equal(row('controversial_7d', 'alice').follows_below_cut, undefined, 'listed on both days: exact');
  fs.rmSync(dir, { recursive: true });
});

const manyProfiles = (n, prefix = 'filler') => Object.fromEntries(Array.from({ length: n }, (_, i) => {
  const did = `did:plc:${prefix}${i}`;
  return [did, profile(did, { handle: `${prefix}${i}.example.com`, followersCount: 20000 + i })];
}));

test('end to end: one failed profile batch among many is retried alone, and still failing aborts the build', async () => {
  const fillers = manyProfiles(260);
  const withFillers = () => {
    const dir = setupDir();
    const file = path.join(dir, 'social', 'days', '2026-10-09.json');
    const f2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    f2.follows_top.push(...Object.keys(fillers).map((did, i) => [did, 1 + (i % 7)]));
    writeJson(file, f2);
    return dir;
  };

  const dir = withFillers();
  const net = makeNetwork({ extraProfiles: fillers, failProfilesFor: BIG.alice });
  await assert.rejects(run(dir, net), /profile batches failed after a retry/, '1 of 11 batches is under the old 10% tolerance and must still abort');
  assert.equal(fs.existsSync(path.join(dir, 'social.js')), false);
  assert.equal(fs.existsSync(path.join(dir, 'social', 'pool.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'social', 'followers-history.json')), false);
  const profileCalls = net.calls.filter((u) => u.includes('getProfiles') && u.includes(encodeURIComponent(BIG.alice))).length;
  assert.equal(profileCalls, 8, 'four client attempts, then four more in the single retry of that batch');
  fs.rmSync(dir, { recursive: true });

  const dir2 = withFillers();
  await run(dir2, makeNetwork({ extraProfiles: fillers, failProfilesFirst: 4 }));
  const out = readSocial(dir2);
  assert.deepEqual(s.validateSocial(out), []);
  assert.ok(out.boards.blocked_24h.length > 0, 'a batch that fails once and then recovers loses nothing');
  fs.rmSync(dir2, { recursive: true });
});

test('end to end: a failed getPosts batch aborts the build, and all 1000 candidates are requested', async () => {
  const extraPosts = {};
  const candidates = Array.from({ length: 990 }, (_, i) => [`at://did:plc:nobody${i}/app.bsky.feed.post/3x${i}`, 1, 0]);
  const setup = () => {
    const dir = setupDir();
    const file = path.join(dir, 'social', 'days', '2026-10-09.json');
    const f2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    f2.post_candidates.push(...candidates);
    writeJson(file, f2);
    return dir;
  };
  const dir = setup();
  const net = makeNetwork({ extraPosts, failPostsFor: postUri('alice', '3alicegood') });
  await assert.rejects(run(dir, net), /getPosts batches failed after a retry/);
  assert.equal(fs.existsSync(path.join(dir, 'social.js')), false);
  fs.rmSync(dir, { recursive: true });

  const dir2 = setup();
  const net2 = makeNetwork({ extraPosts });
  await run(dir2, net2);
  const requested = new Set(net2.calls.filter((u) => u.includes('getPosts')).flatMap((u) => new URL(u).searchParams.getAll('uris')));
  assert.equal(requested.size, 998, 'the 8 real candidates and all 990 extra ones, none cut at 600');
  fs.rmSync(dir2, { recursive: true });
});

test('end to end: a high-like post with empty text (image) is published and ranks first', async () => {
  const dir = setupDir();
  const imageUri = postUri('hank', '3hankimage');
  const net = makeNetwork({
    extraPosts: {
      [imageUri]: post(BIG.hank, '3hankimage', { likeCount: 14018, record: { text: '', createdAt: '2026-10-09T11:00:00.000Z' }, indexedAt: '2026-10-09T11:00:01.000Z', embed: { $type: 'app.bsky.embed.images#view', images: [] } }),
    },
  });
  const file = path.join(dir, 'social', 'days', '2026-10-09.json');
  const f2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  f2.post_candidates.push([imageUri, 1, 0]);
  writeJson(file, f2);
  await run(dir, net);
  const out = readSocial(dir);
  assert.deepEqual(s.validateSocial(out), []);
  assert.equal(out.top_posts[0].uri, imageUri);
  assert.equal(out.top_posts[0].text, '');
  assert.equal(out.top_posts[0].embed, 'image');
  fs.rmSync(dir, { recursive: true });
});

test('end to end: posts-this-month scan reads past pages of reposts instead of capping', async () => {
  const dir = setupDir();
  const net = makeNetwork();
  const base = net.fetchImpl;
  const sleepy = { fetchImpl: async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('app.bsky.feed.getAuthorFeed') && u.searchParams.get('actor') === BIG.hank) {
      const page = Number(u.searchParams.get('cursor') || 0);
      const items = page < 12
        ? Array.from({ length: 100 }, (_, i) => repost(BIG.hank, BIG.bob, '2026-09-01T00:00:00Z', `2026-10-09T05:${String(i % 60).padStart(2, '0')}:00Z`))
        : [own(BIG.hank, '2026-10-08T10:00:00Z'), own(BIG.hank, '2026-09-10T10:00:00Z')];
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ feed: items, cursor: page < 12 ? String(page + 1) : '' }) };
    }
    return base(url);
  } };
  await run(dir, sleepy);
  const hank = readSocial(dir).accounts[BIG.hank];
  assert.equal(hank.posts_this_month, 1);
  assert.equal(hank.posts_this_month_capped, false);
  assert.equal(hank.last_posted, '2026-10-08T10:00:00.000Z');
  fs.rmSync(dir, { recursive: true });
});

test('end to end: Constellation attempts, retries included, stay within the 400 budget', async () => {
  const fillers = manyProfiles(300);
  const dir = setupDir();
  const file = path.join(dir, 'social', 'days', '2026-10-09.json');
  const f2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  f2.blocks_top.push(...Object.keys(fillers).slice(0, 200).map((did, i) => [did, 150 + i]));
  f2.follows_top.push(...Object.keys(fillers).slice(200).map((did, i) => [did, 1 + (i % 5)]));
  writeJson(file, f2);
  const net = makeNetwork({ extraProfiles: fillers, flakyConstellation: true });
  const { summary } = await run(dir, net);
  const calls = net.calls.filter((u) => u.includes('constellation')).length;
  assert.ok(calls > 300, `the budget should be used up, got ${calls}`);
  assert.ok(calls <= 400, `got ${calls} Constellation requests`);
  assert.equal(summary.requests['constellation.microcosm.blue'], calls);
  fs.rmSync(dir, { recursive: true });
});

test('end to end: did:web accounts are resolved at the did:web method URL', async () => {
  const web = 'did:web:example.com:users:alice';
  const extraProfiles = { [web]: profile(web, { handle: 'webalice.example.com', followersCount: 70000 }) };
  const dir = setupDir();
  const file = path.join(dir, 'social', 'days', '2026-10-09.json');
  const f2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  f2.blocks_top.push([web, 5000]);
  writeJson(file, f2);
  const net = makeNetwork({ extraProfiles, docs: { 'example.com/users/alice/did.json': { service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.web.example' }] } } });
  await run(dir, net);
  assert.ok(net.calls.includes('https://example.com/users/alice/did.json'), net.calls.filter((u) => u.includes('example.com/')).join(' '));
  assert.equal(readSocial(dir).accounts[web].pds, 'https://pds.web.example');
  fs.rmSync(dir, { recursive: true });
});
