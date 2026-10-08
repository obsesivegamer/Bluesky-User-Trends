'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const update = require('../updateData.js');
const users = require('../lib/users.js');
const build = require('../lib/build.js');
const fmt = require('../lib/format.js');
const { H, ms, loadJazcoStats, syntheticSamples, feedOf, plcSamples } = require('./fixtures/data-helpers.js');

const ROOT = path.join(__dirname, '..');
const NOW = '2026-10-08T03:50:00Z';
const BOT_END = '2026-10-07T20:00:00Z';
const BOT_RATE = 700;
const baseSamples = syntheticSamples({ botEndIso: BOT_END, botPerHour: BOT_RATE });
const botValueAt = (iso) => 18_000_000 + Math.round(((ms(iso) - ms('2024-11-17T01:00:00Z')) / H) * BOT_RATE);

function jazcoBody({ updatedAt = '2026-10-08T03:47:33.401020879Z', mutate } = {}) {
  const raw = loadJazcoStats();
  raw.updated_at = updatedAt;
  raw.total_users = botValueAt('2026-10-08T03:47:33Z');
  return mutate ? mutate(raw) : raw;
}

function botFeed() {
  const readings = [];
  for (let t = ms('2026-10-08T03:00:04Z'); t >= ms('2026-10-07T21:00:04Z'); t -= H) {
    readings.push([new Date(t).toISOString(), botValueAt(new Date(t - 4000).toISOString())]);
  }
  return feedOf(readings);
}

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const key = url.startsWith(update.JAZCO_URL) ? 'jazco' : url.startsWith('https://public.api.bsky.app/') ? 'bot' : 'other';
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const r = typeof route === 'function' ? route(calls.length) : route;
    if (r instanceof Error) throw r;
    return { ok: r.status === undefined || r.status < 400, status: r.status ?? 200, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function setup({ withArchive = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-update-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'sources'), { recursive: true });
  const samples = users.thinSamples(users.cleanSamples(baseSamples).kept);
  fs.writeFileSync(path.join(dataDir, 'users-samples.json'), users.serializeSamplesFile(samples));
  fs.writeFileSync(
    path.join(dataDir, 'sources', 'plc-rate-samples.json'),
    JSON.stringify({ samples: plcSamples('2024-07-01T00:00:00Z', '2024-11-18T06:00:00Z', { perHour: 1500 }) }),
  );
  const indexFile = path.join(dir, 'index.html');
  const sitemapFile = path.join(dir, 'sitemap.xml');
  fs.writeFileSync(indexFile, '<!doctype html><title>t</title><p><span data-prerender="users-total">0</span> <span data-prerender="last-day">x</span></p>\n');
  fs.writeFileSync(sitemapFile, '<?xml version="1.0"?><urlset><url><loc>x</loc><lastmod>2000-01-01</lastmod></url></urlset>\n');
  const env = { DATA_DIR: dataDir, INDEX_FILE: indexFile, SITEMAP_FILE: sitemapFile, NOW };
  return { dir, dataDir, indexFile, sitemapFile, env };
}

const quietLog = () => {
  const lines = { log: [], warn: [] };
  return { lines, log: (...a) => lines.log.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')) };
};
const noSleep = async () => {};
const snapshotDir = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
};
const realFiles = ['data/bluesky-data.js', 'data/bluesky-daily.csv', 'data/users-samples.json', 'index.html', 'sitemap.xml'].map((f) => path.join(ROOT, f));
const realState = () => realFiles.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null));

test('end to end: builds the dataset, CSV and samples from mocked feeds in a temp dir', async () => {
  const before = realState();
  const { dataDir, env } = setup();
  const fetchImpl = mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } });
  const log = quietLog();
  const summary = await update.main({ env, fetchImpl, log, sleep: noSleep, prerender: null });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].opts.headers['User-Agent'], update.UA);
  assert.match(update.UA, /^Bluesky-User-Trends \(\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\)$/, 'names a contact URL');
  assert.match(fetchImpl.calls[1].url, /actor=did:plc:5he4nkza7eqhmirg3azchqy6&limit=100&filter=posts_no_replies/);

  const data = build.parseDataJs(fs.readFileSync(path.join(dataDir, 'bluesky-data.js'), 'utf8'));
  assert.ok(build.validateDataset(data));
  assert.equal(data.generated_at, '2026-10-08T03:50:00.000Z');
  assert.equal(data.last_complete_day, '2026-10-07');
  assert.equal(data.days[0].date, '2022-11-17');
  assert.equal(data.days.length, 1421);
  assert.equal(data.snapshot.total_users, botValueAt('2026-10-08T03:47:33Z'));
  const last = data.days.at(-1);
  assert.equal(last.users_src, 'bot', 'the new feed readings observe the last boundary');
  assert.equal(last.users_est, false);
  assert.ok(Math.abs(last.users - botValueAt('2026-10-08T00:00:00Z')) <= 2);
  assert.ok(Math.abs(last.new_users - 24 * BOT_RATE) <= 2);
  assert.equal(last.dau, 988944);
  assert.equal(last.posters, 576400);
  assert.deepEqual(data.days.find((d) => d.date === '2024-09-03').flags, ['likers', 'posters', 'followers', 'blockers', 'posts', 'likes', 'follows', 'blocks']);
  assert.equal(data.days.find((d) => d.date === '2024-09-03').dau, null);

  const csv = fs.readFileSync(path.join(dataDir, 'bluesky-daily.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(csv.length, 1422);
  assert.ok(csv.at(-1).startsWith(`2026-10-07,${last.users},false,bot,${last.new_users},988944,576400,`));

  const samples = users.parseSamplesFile(fs.readFileSync(path.join(dataDir, 'users-samples.json'), 'utf8'));
  assert.ok(samples.some((s) => s.src === 'jazco' && s.t === ms('2026-10-08T03:47:33Z')));
  assert.ok(samples.some((s) => s.src === 'bot' && s.t === ms('2026-10-08T03:00:04Z')));
  assert.ok(summary.samples_added >= 2);
  assert.deepEqual(realState(), before, 'real repository files untouched');
});

test('a second run with the same inputs changes nothing', async () => {
  const { dir, env } = setup();
  const run = () => update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null });
  await run();
  const first = snapshotDir(dir);
  await run();
  assert.deepEqual(snapshotDir(dir), first);
});

test('jazco failure: retries, exits with an error and writes nothing', async () => {
  const { dir, env } = setup();
  const before = snapshotDir(dir);
  const fetchImpl = mockFetch({ jazco: { status: 503, body: {} }, bot: { body: botFeed() } });
  const sleeps = [];
  await assert.rejects(update.main({ env, fetchImpl, log: quietLog(), sleep: async (n) => sleeps.push(n), prerender: null }), /jazco \/stats unavailable: HTTP 503/);
  assert.equal(fetchImpl.calls.filter((c) => c.url === update.JAZCO_URL).length, 3);
  assert.equal(sleeps.length, 2);
  assert.deepEqual(snapshotDir(dir), before);
});

test('jazco with no usable rows (only today/future) fails and writes nothing', async () => {
  const { dir, env } = setup();
  const before = snapshotDir(dir);
  const body = jazcoBody({ mutate: (r) => ({ ...r, daily_data: r.daily_data.filter((d) => d.date >= '2026-10-08') }) });
  await assert.rejects(update.main({ env, fetchImpl: mockFetch({ jazco: { body }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null }), /no usable daily rows/);
  await assert.rejects(update.main({ env, fetchImpl: mockFetch({ jazco: { body: { oops: true } }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null }), /daily_data/);
  assert.deepEqual(snapshotDir(dir), before);
});

test('bot feed failure is a warning; a stale jazco total is not saved as a reading', async () => {
  const { dataDir, env } = setup();
  const log = quietLog();
  const fetchImpl = mockFetch({ jazco: { body: jazcoBody({ updatedAt: '2026-10-07T22:00:00Z' }) }, bot: new Error('socket hang up') });
  const summary = await update.main({ env, fetchImpl, log, sleep: noSleep, prerender: null });
  assert.ok(log.lines.warn.some((l) => /bot feed unavailable \(socket hang up\)/.test(l)));
  assert.ok(log.lines.warn.some((l) => /over 2h old/.test(l)));
  assert.equal(summary.jazco_reading, false);
  assert.equal(summary.bot_readings, 0);
  const data = build.parseDataJs(fs.readFileSync(path.join(dataDir, 'bluesky-data.js'), 'utf8'));
  const last = data.days.at(-1);
  assert.equal(last.date, '2026-10-07');
  assert.equal(last.users_est, true, 'no reading after the last boundary: extrapolated and marked');
  const samples = users.parseSamplesFile(fs.readFileSync(path.join(dataDir, 'users-samples.json'), 'utf8'));
  assert.ok(!samples.some((s) => s.src === 'jazco'));
});

const readData = (dataDir) => build.parseDataJs(fs.readFileSync(path.join(dataDir, 'bluesky-data.js'), 'utf8'));
const hourlyFeed = (fromIso, toIso, valueAt) => {
  const readings = [];
  for (let t = ms(toIso); t >= ms(fromIso); t -= H) readings.push([new Date(t).toISOString(), valueAt(t)]);
  return feedOf(readings);
};

test('a jazco response without an index total keeps the published one, so the page never shows a dash', async () => {
  const pre = require('../lib/prerender.js');
  const { dataDir, env } = setup();
  await update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null });
  const before = readData(dataDir).snapshot;
  const later = { ...env, NOW: '2026-10-08T15:20:00Z' };
  const body = jazcoBody({
    updatedAt: '2026-10-08T15:17:00Z',
    mutate: (r) => {
      const { total_posts, ...rest } = r;
      return { ...rest, total_users: botValueAt('2026-10-08T15:17:00Z'), total_likes: 'n/a', total_follows: r.total_follows + 5 };
    },
  });
  const log = quietLog();
  await update.main({ env: later, fetchImpl: mockFetch({ jazco: { body }, bot: { body: botFeed() } }), log, sleep: noSleep, prerender: null });
  const snap = readData(dataDir).snapshot;
  assert.equal(snap.total_users, botValueAt('2026-10-08T15:17:00Z'), 'the fresh headline is used');
  assert.equal(snap.total_posts, before.total_posts, 'missing field: previous value kept');
  assert.equal(snap.total_likes, before.total_likes, 'invalid field: previous value kept');
  assert.equal(snap.total_follows, before.total_follows + 5);
  assert.ok(log.lines.warn.some((l) => /total_posts missing or invalid/.test(l)));
  const v = pre.computePrerenderValues(readData(dataDir));
  for (const key of pre.INLINE_KEYS) assert.notEqual(v[key], '—', key);
});

test('a stale or frozen jazco total never moves the headline backwards', async () => {
  const { dataDir, env } = setup();
  const t1 = '2026-10-08T16:27:05.419979086Z';
  await update.main({ env: { ...env, NOW: '2026-10-08T16:30:00Z' }, fetchImpl: mockFetch({ jazco: { body: jazcoBody({ updatedAt: t1, mutate: (r) => ({ ...r, total_users: botValueAt('2026-10-08T16:27:05Z') }) }) }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null });
  assert.equal(readData(dataDir).snapshot.updated_at, t1);

  // Jaz's cache is 15h old (older than what is published) and the bot is down: keep the published headline.
  const next = { ...env, NOW: '2026-10-09T03:17:00Z' };
  const stale = jazcoBody({ updatedAt: '2026-10-08T12:00:00Z', mutate: (r) => ({ ...r, total_users: botValueAt('2026-10-08T12:00:00Z'), total_posts: r.total_posts - 1000 }) });
  const log = quietLog();
  const summary = await update.main({ env: next, fetchImpl: mockFetch({ jazco: { body: stale }, bot: new Error('down') }), log, sleep: noSleep, prerender: null });
  const snap = readData(dataDir).snapshot;
  assert.equal(snap.updated_at, t1);
  assert.equal(snap.total_users, botValueAt('2026-10-08T16:27:05Z'));
  assert.equal(snap.total_posts, loadJazcoStats().total_posts, 'index totals from an older cache do not replace newer ones');
  assert.equal(summary.jazco_reading, false);
  assert.ok(log.lines.warn.some((l) => /not used; headline is/.test(l)));

  // Same stale cache, but the bot has newer readings: the newest one is the headline.
  await update.main({ env: next, fetchImpl: mockFetch({ jazco: { body: stale }, bot: { body: hourlyFeed('2026-10-08T17:00:04Z', '2026-10-09T03:00:04Z', (t) => botValueAt(new Date(t - 4000).toISOString())) } }), log: quietLog(), sleep: noSleep, prerender: null });
  const snap2 = readData(dataDir).snapshot;
  assert.equal(snap2.updated_at, '2026-10-09T03:00:04.000Z');
  assert.equal(snap2.total_users, botValueAt('2026-10-09T03:00:00Z'));
  assert.match(snap2.source, /hourlybskyusers/);
});

test('a frozen counter: the plateau is dropped and the headline is the last moving reading, not the frozen tail', async () => {
  const { dataDir, env } = setup();
  await update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null });
  const frozenAt = ms('2026-10-08T20:00:04Z');
  const frozen = botValueAt('2026-10-08T20:00:00Z');
  const valueAt = (t) => (t >= frozenAt ? frozen : botValueAt(new Date(t - 4000).toISOString()));
  const now = { ...env, NOW: '2026-10-09T03:17:00Z' };
  const body = jazcoBody({ updatedAt: '2026-10-09T03:15:00Z', mutate: (r) => ({ ...r, total_users: frozen }) });
  const summary = await update.main({ env: now, fetchImpl: mockFetch({ jazco: { body }, bot: { body: hourlyFeed('2026-10-08T04:00:04Z', '2026-10-09T03:00:04Z', valueAt) } }), log: quietLog(), sleep: noSleep, prerender: null });
  const snap = readData(dataDir).snapshot;
  assert.equal(summary.jazco_reading, false, 'the frozen jazco total was dropped with the plateau');
  assert.equal(snap.updated_at, '2026-10-08T20:00:04.000Z', 'as of the last time the counter moved');
  assert.equal(snap.total_users, frozen);
});

test('archive rows survive when the API stops returning old dates; the API wins elsewhere', async () => {
  const { dataDir, env } = setup();
  await update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null });
  const trimmed = jazcoBody({
    mutate: (r) => ({
      ...r,
      daily_data: r.daily_data
        .filter((d) => d.date >= '2025-01-01')
        .map((d) => (d.date === '2026-10-06' ? { ...d, num_posters: 580000 } : d)),
    }),
  });
  await update.main({ env, fetchImpl: mockFetch({ jazco: { body: trimmed }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null });
  const data = build.parseDataJs(fs.readFileSync(path.join(dataDir, 'bluesky-data.js'), 'utf8'));
  const day = (d) => data.days.find((r) => r.date === d);
  const fixture = Object.fromEntries(loadJazcoStats().daily_data.map((d) => [d.date, d]));
  assert.equal(day('2023-03-01').posters, fixture['2023-03-01'].num_posters, 'kept from the archive');
  assert.equal(day('2024-09-02').posters, fixture['2024-09-02'].num_posters);
  assert.deepEqual(day('2024-09-02').flags.length, 8, 'flags recomputed on the merged history');
  assert.equal(day('2024-11-19').posters, 1479882);
  assert.equal(day('2026-10-06').posters, 580000, 'API value replaces the archived one');
});

test('pre-render hook: writes index.html and sitemap.xml through the injected module', async () => {
  const { indexFile, sitemapFile, env } = setup();
  const seen = [];
  const prerender = {
    prerenderIndex: (html, data) => {
      seen.push(data.last_complete_day);
      return { html: html.replace('>0<', `>${fmt.formatInteger(data.snapshot.total_users)}<`), replaced: ['users-total'], missing: ['dau'] };
    },
    updateSitemap: (xml, data) => xml.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${data.last_complete_day}</lastmod>`),
  };
  const log = quietLog();
  await update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log, sleep: noSleep, prerender });
  assert.deepEqual(seen, ['2026-10-07']);
  assert.match(fs.readFileSync(indexFile, 'utf8'), new RegExp(`>${fmt.formatInteger(botValueAt('2026-10-08T03:47:33Z'))}<`));
  assert.match(fs.readFileSync(sitemapFile, 'utf8'), /<lastmod>2026-10-07<\/lastmod>/);
  assert.ok(log.lines.warn.some((l) => /no marker for: dau/.test(l)));
});

test('a failing pre-render aborts the run before anything is written', async () => {
  const { dir, env } = setup();
  const before = snapshotDir(dir);
  const prerender = { prerenderIndex: () => { throw new Error('bad template'); }, updateSitemap: (x) => x };
  await assert.rejects(update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender }), /bad template/);
  assert.deepEqual(snapshotDir(dir), before);
});

test('the real lib/prerender.js works with the pipeline output', { skip: !fs.existsSync(path.join(ROOT, 'lib', 'prerender.js')) }, async () => {
  const { indexFile, sitemapFile, env } = setup();
  const prerender = require('../lib/prerender.js');
  await update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender });
  const html = fs.readFileSync(indexFile, 'utf8');
  assert.match(html, new RegExp(`data-prerender="users-total">${fmt.formatInteger(botValueAt('2026-10-08T03:47:33Z'))}<`));
  assert.match(html, /data-prerender="last-day">Oct 7, 2026</);
  assert.match(fs.readFileSync(sitemapFile, 'utf8'), /<lastmod>2026-10-07<\/lastmod>/);
});

test('missing samples file is a clear error', async () => {
  const { dataDir, env } = setup();
  fs.rmSync(path.join(dataDir, 'users-samples.json'));
  await assert.rejects(update.main({ env, fetchImpl: mockFetch({ jazco: { body: jazcoBody() }, bot: { body: botFeed() } }), log: quietLog(), sleep: noSleep, prerender: null }), /npm run backfill/);
});

test('botSamples ignores reposts, other authors, unparsable and future posts', () => {
  const now = ms(NOW);
  const feed = feedOf([['2026-10-08T03:00:04Z', 46_898_907], ['2026-10-08T05:00:00Z', 1]]);
  feed.feed.push({ ...feedOf([['2026-10-08T02:00:00Z', 5]]).feed[0], reason: { $type: 'app.bsky.feed.defs#reasonRepost' } });
  feed.feed.push(feedOf([['2026-10-08T02:00:00Z', 6]], { actor: 'did:plc:someoneelse' }).feed[0]);
  feed.feed.push({ post: { author: { did: 'did:plc:5he4nkza7eqhmirg3azchqy6' }, record: { createdAt: '2026-10-08T01:00:00Z', text: 'hello' } } });
  assert.deepEqual(update.botSamples(feed, now), [{ t: ms('2026-10-08T03:00:04Z'), src: 'bot', users: 46_898_907 }]);
  assert.deepEqual(update.botSamples(null, now), []);
});

test('jazcoSample only accepts a fresh updated_at', () => {
  const now = ms(NOW);
  const snap = (updated_at) => ({ total_users: 5, updated_at });
  assert.deepEqual(update.jazcoSample(snap('2026-10-08T02:00:00Z'), now), { t: ms('2026-10-08T02:00:00Z'), src: 'jazco', users: 5 });
  assert.equal(update.jazcoSample(snap('2026-10-08T01:40:00Z'), now), null);
  assert.equal(update.jazcoSample(snap('2026-10-08T05:00:00Z'), now), null);
  assert.equal(update.jazcoSample(null, now), null);
});
