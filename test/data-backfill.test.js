'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const backfill = require('../scripts/backfill-users.js');
const users = require('../lib/users.js');
const { ms, feedOf } = require('./fixtures/data-helpers.js');

const wikitext = (entries) =>
  '== Summary ==\n```python\ndata_array = [\n    # The following portion is from Kleppmann et al.\n' +
  entries.map((e) => `    "${e}",`).join('\n') +
  '\n    # Continuing data gathered by jaz.bsky.social.\n]\n```';
const commonsApi = (text) => ({ query: { pages: { 1: { revisions: [{ slots: { main: { '*': text } } }] } } } });
const manyEntries = () => {
  const out = [];
  for (let d = '2022-11-17'; d <= '2024-07-01'; d = users.addDays(d, 1)) out.push(`${d}, ${out.length + 5}`);
  return out;
};

test('parseCommons reads the data_array list out of the file-page wikitext', () => {
  const points = backfill.parseCommons(commonsApi(wikitext(manyEntries())));
  assert.equal(points[0].date, '2022-11-17');
  assert.equal(points[0].users, 5);
  assert.equal(points.at(-1).date, '2024-07-01');
  assert.throws(() => backfill.parseCommons(commonsApi('no data here')), /data_array not found/);
  assert.throws(() => backfill.parseCommons(commonsApi(wikitext(['2022-11-17, 5']))), /only 1 points/);
  assert.throws(() => backfill.parseCommons({}), /no wikitext/);
});

test('commonsSamples: end-of-day values at the next midnight, interpolated windows left out', () => {
  const samples = backfill.commonsSamples(backfill.parseCommons(commonsApi(wikitext(manyEntries()))));
  assert.deepEqual(samples[0], { t: ms('2022-11-18T00:00:00Z'), src: 'commons', users: 5 });
  const dates = new Set(samples.map((s) => new Date(s.t - 864e5).toISOString().slice(0, 10)));
  for (const d of ['2024-02-04', '2024-02-07', '2024-06-23', '2024-06-28']) assert.ok(!dates.has(d), d);
  for (const d of ['2024-02-03', '2024-02-08', '2024-06-22', '2024-06-29', '2024-07-01']) assert.ok(dates.has(d), d);
});

test('decodeWaybackBody handles gzip-in-body captures, plain JSON, old schemas and empty bodies', () => {
  const body = { total_users: 6115164, updated_at: '2024-08-07T10:07:33.123456789Z', daily_data: [] };
  const plain = Buffer.from(JSON.stringify(body));
  assert.deepEqual(backfill.decodeWaybackBody(plain), { updated_at: body.updated_at, total_users: 6115164 });
  assert.deepEqual(backfill.decodeWaybackBody(zlib.gzipSync(plain)), { updated_at: body.updated_at, total_users: 6115164 });
  assert.deepEqual(backfill.decodeWaybackBody(Buffer.from('{"total_authors":31522,"updated_at":"2023-05-08T19:48:16Z"}')), { updated_at: '2023-05-08T19:48:16Z', total_users: null });
  assert.equal(backfill.decodeWaybackBody(Buffer.from('  ')), null);
  assert.throws(() => backfill.decodeWaybackBody(Buffer.from('<html>Temporarily Offline</html>')));
});

test('parseBotPost and parseElavalCsv', () => {
  const item = feedOf([['2026-10-08T04:00:04.005Z', 46899489]]).feed[0];
  assert.deepEqual(backfill.parseBotPost(item), ['2026-10-08T04:00:04.005Z', 46899489]);
  assert.equal(backfill.parseBotPost({ ...item, reason: {} }), null);
  assert.equal(backfill.parseBotPost(feedOf([['2026-10-08T04:00:04Z', 1]], { actor: 'did:plc:x' }).feed[0]), null);
  const rows = backfill.parseElavalCsv('timestamp,users\n2024-11-22 01:17:51,21284400\nbad,line\n2024-11-22 01:30:58,21287962\n');
  assert.deepEqual(rows, [
    { t: ms('2024-11-22T01:17:51Z'), src: 'elaval', users: 21284400 },
    { t: ms('2024-11-22T01:30:58Z'), src: 'elaval', users: 21287962 },
  ]);
  assert.equal(backfill.KREKENY_TIME, 'T03:00:00Z');
});

test('offline backfill from a seeded cache keeps existing samples and writes a clean, thinned file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-backfill-'));
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(path.join(seed, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'wb', 'snaps'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'hourlybot'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'krekeny'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'wiki', 'file.json'), JSON.stringify(commonsApi(wikitext(manyEntries()))));
  fs.writeFileSync(path.join(seed, 'wb', 'snaps', '20240807100841.json'), JSON.stringify({ total_users: 6115164, updated_at: '2024-08-07T10:07:33Z' }));
  fs.writeFileSync(path.join(seed, 'wb', 'snaps', '20230508194954.json'), JSON.stringify({ total_authors: 31522, updated_at: '2023-05-08T19:48:16Z' }));
  const bot = [];
  for (let h = 0; h < 72; h++) bot.push([new Date(ms('2024-11-17T01:00:00Z') + h * 3600e3).toISOString(), 18_180_053 + h * 30_000]);
  for (let h = 72; h < 82; h++) bot.push([new Date(ms('2024-11-17T01:00:00Z') + h * 3600e3).toISOString(), 18_180_053 + 71 * 30_000]);
  bot.push([new Date(ms('2024-11-17T01:00:00Z') + 82 * 3600e3).toISOString(), 18_180_053 + 82 * 30_000]);
  fs.writeFileSync(path.join(seed, 'hourlybot', 'rows.json'), JSON.stringify(bot.reverse()));
  fs.writeFileSync(path.join(seed, 'krekeny', 'stats.json'), JSON.stringify([{ date: '2024-11-18', total_users: 19_000_000 }, { date: 'junk' }]));
  const out = path.join(dir, 'users-samples.json');
  fs.writeFileSync(out, users.serializeSamplesFile([{ t: ms('2024-11-19T03:47:00Z'), src: 'jazco', users: 19_800_000 }]));

  const logs = [];
  const res = await backfill.main(['--seed-from', seed, '--offline', '--cache', path.join(dir, 'cache'), '--out', out], (...a) => logs.push(a.join(' ')));
  const saved = users.parseSamplesFile(fs.readFileSync(out, 'utf8'));
  const count = (src) => saved.filter((s) => s.src === src).length;
  assert.equal(count('commons'), 593 - 10);
  assert.equal(count('wayback'), 1, 'the old-schema capture has no total_users');
  assert.equal(count('krekeny'), 1);
  assert.equal(count('jazco'), 1, 'existing samples are kept');
  assert.ok(count('bot') <= 2 * 5, 'bot thinned to first/last per day');
  assert.equal(res.dropped.filter((d) => d.reason === 'plateau').length, 10);
  assert.ok(logs.some((l) => /plateau/.test(l)));
  assert.ok(fs.existsSync(path.join(dir, 'cache', 'wayback', 'snaps', '20240807100841.json')));
  // a second offline run is a no-op
  const before = fs.readFileSync(out, 'utf8');
  await backfill.main(['--offline', '--cache', path.join(dir, 'cache'), '--out', out], () => {});
  assert.equal(fs.readFileSync(out, 'utf8'), before);
});

test('summarizeDrops groups consecutive readings of one plateau', () => {
  const d = (iso, users) => ({ t: ms(iso), src: 'bot', users, reason: 'plateau' });
  assert.deepEqual(backfill.summarizeDrops([d('2026-02-24T01:00:00Z', 7), d('2026-02-24T02:00:00Z', 7), d('2026-06-01T00:00:00Z', 9)]), [
    '2026-02-24T01:00Z..2026-02-24T02:00Z plateau 7 (2 readings)',
    '2026-06-01T00:00Z..2026-06-01T00:00Z plateau 9 (1 readings)',
  ]);
});
