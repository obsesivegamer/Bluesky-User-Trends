'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const pre = require('../lib/prerender.js');
const ui = require('../script.js');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_HTML = fs.readFileSync(path.join(__dirname, 'fixtures/prerender-index.html'), 'utf8');
const FIXTURE_SITEMAP = fs.readFileSync(path.join(__dirname, 'fixtures/prerender-sitemap.xml'), 'utf8');
const ACTIVITY_KEYS = ['likers', 'posters', 'followers', 'blockers', 'posts', 'likes', 'follows', 'blocks'];

function isoDay(start, offset) {
  return new Date(Date.parse(start + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

function row(date, fields) {
  const r = { date, users: 0, users_est: false, users_src: 'bot', new_users: null, new_users_est: false, dau: null, flags: [] };
  for (const k of ACTIVITY_KEYS) r[k] = null;
  return Object.assign(r, fields);
}

// 30 days, 2026-09-01..2026-09-30, with hand-checkable values (see expectations below).
function makeData() {
  const days = [];
  let users = 1000000;
  for (let i = 0; i < 30; i++) {
    const date = isoDay('2026-09-01', i);
    const newUsers = i === 0 ? null : i === 9 ? 50000 : 10000 + 100 * i;
    if (newUsers !== null) users += newUsers;
    const likers = 500000 + 1000 * i;
    const posters = 300000 + 500 * i;
    days.push(row(date, {
      users, new_users: newUsers,
      likers, posters, followers: 100000, blockers: 20000,
      posts: 2000000 + i, likes: 15000000, follows: 1500000, blocks: 250000,
      dau: likers,
    }));
  }
  days[12].dau = 800000;
  days[12].likers = 800000;
  days[20].posters = 2000000;
  days[20].flags = ['posters'];
  days[20].dau = null;
  days[29].flags = ['posters'];
  days[29].dau = null;
  return {
    schema: 1,
    generated_at: '2026-10-01T03:17:42.123Z',
    last_complete_day: '2026-09-30',
    snapshot: { total_users: users + 5000, updated_at: '2026-10-01T03:10:00Z', total_posts: 3286036562, total_likes: 18190891741, total_follows: 3928005731, source: 'bsky-search.jazco.io/stats' },
    live_source: { type: 'bsky-author-feed', actor: 'did:plc:5he4nkza7eqhmirg3azchqy6', pattern: 'Total Bluesky users: ([\\d,]+)' },
    activity_start: '2023-03-01',
    collection_start: '2023-05-01',
    days,
  };
}

// Long synthetic history covering every milestone date (2022-11-17 .. 2026-01-10).
function makeLongData() {
  const days = [];
  let users = 5;
  const n = Math.round((Date.parse('2026-01-10') - Date.parse('2022-11-17')) / 86400000) + 1;
  for (let i = 0; i < n; i++) {
    const date = isoDay('2022-11-17', i);
    const nu = i === 0 ? null : 1000 + (i % 7);
    if (nu !== null) users += nu;
    const active = date >= '2023-03-01';
    days.push(row(date, {
      users, new_users: nu, users_est: date < '2023-06-01', users_src: date < '2023-06-01' ? 'interp' : 'commons',
      likers: active ? 5000 + i : null, posters: active ? 3000 + i : null, dau: active ? 5000 + i : null,
    }));
  }
  const last = days[days.length - 1];
  return { schema: 1, generated_at: '2026-01-11T04:00:00Z', last_complete_day: last.date, snapshot: { total_users: last.users, total_posts: 1, total_likes: 2, total_follows: 3 }, days };
}

test('computePrerenderValues: every key, formatted with lib/format.js', () => {
  const v = pre.computePrerenderValues(makeData());
  assert.deepEqual(Object.keys(v).sort(), [...pre.INLINE_KEYS].sort());
  const lastUsers = makeData().days.at(-1).users;
  assert.equal(v['last-day'], 'Sep 30, 2026');
  assert.equal(v['generated'], '2026-10-01 03:17 UTC');
  assert.equal(v['users-total'], (lastUsers + 5000).toLocaleString('en-US'));
  assert.equal(v['users-total-compact'], ((lastUsers + 5000) / 1e6).toFixed(2) + 'M');
  // mean(new_users of 2026-09-24..30) = 10000 + 100*mean(23..29) = 12,600
  assert.equal(v['velocity-7d'], '+12.6K/day');
  assert.equal(v['velocity-last'], '+12.9K');
  assert.equal(v['users-at'], '2026-10-01 03:10 UTC', 'the headline says when it was read, not when the page was built');
  // last day has posters flagged and dau null -> previous day for both, and the sentence date follows
  assert.equal(v['dau'], '528.0K');
  assert.equal(v['posters'], '314.0K');
  assert.equal(v['activity-day'], 'Sep 29, 2026');
  assert.equal(v['poster-ratio'], (100 * 314000 / 528000).toFixed(1) + '%');
  const d28 = makeData().days[28];
  assert.equal(v['dau-share'], (100 * 528000 / d28.users).toFixed(2) + '%');
  assert.equal(v['index-posts'], '3.286B');
  assert.equal(v['index-likes'], '18.191B');
  assert.equal(v['index-follows'], '3.928B');
  assert.equal(v['dau-peak'], '800.0K');
  assert.equal(v['dau-peak-date'], 'Sep 13, 2026');
  // the flagged 2,000,000 posters on 2026-09-21 must not win the peak
  assert.equal(v['posters-peak'], '314.0K');
  assert.equal(v['posters-peak-date'], 'Sep 29, 2026');
  assert.equal(v['velocity-peak'], '+50.0K');
  assert.equal(v['velocity-peak-date'], 'Sep 10, 2026');
});

test('computePrerenderValues: DAU, posters and ratios always describe the same, named day', () => {
  // A likes-only outage on the newest day: posters is usable but DAU is not. Every value placed next
  // to activity-day must come from that one day, or a sentence would mix two dates.
  const data = makeData();
  data.days[29].flags = ['likers', 'likes'];
  data.days[29].dau = null;
  const v = pre.computePrerenderValues(data);
  const d28 = data.days[28];
  assert.equal(v['activity-day'], 'Sep 29, 2026');
  assert.equal(v['dau'], '528.0K');
  assert.equal(v['posters'], '314.0K', 'posters of the DAU day, not the newer posters-only day');
  assert.equal(v['poster-ratio'], (100 * d28.posters / d28.dau).toFixed(1) + '%');
  assert.equal(v['dau-share'], (100 * d28.dau / d28.users).toFixed(2) + '%');
  assert.deepEqual(v, ui.computePrerenderValues(data), 'same strings as the page paints');
});

test('computePrerenderValues: an estimated record day is marked as estimated', () => {
  const data = makeData();
  data.days[9].users_est = true;
  data.days[9].new_users_est = true;
  data.days[10].new_users_est = true;
  assert.equal(pre.computePrerenderValues(data)['velocity-peak-date'], 'Sep 10, 2026 (est.)');
  data.days[9].users_est = false;
  data.days[9].new_users_est = false;
  data.days[8].users_est = true;
  assert.equal(pre.computePrerenderValues(data)['velocity-peak-date'], 'Sep 10, 2026 (est.)', 'the previous day is an estimate too');
  assert.deepEqual(pre.computePrerenderValues(data), ui.computePrerenderValues(data));
  const real = pre.parseDataFile(fs.readFileSync(path.join(ROOT, 'data/bluesky-data.js'), 'utf8'));
  const peak = real.days.reduce((best, r) => (r.new_users != null && (!best || r.new_users > best.new_users) ? r : best), null);
  assert.equal(pre.computePrerenderValues(real)['velocity-peak-date'].endsWith('(est.)'), peak.new_users_est);
});

test('computePrerenderValues: 7-day velocity averages the values present in the last 7 calendar days', () => {
  const data = makeData();
  data.days[27].new_users = null; // 2026-09-28
  // remaining 6 of 23..29 -> 10000 + 100 * mean(23,24,25,26,28,29) = 12,583.3
  assert.equal(pre.computePrerenderValues(data)['velocity-7d'], '+12.6K/day');
  const neg = makeData();
  for (const r of neg.days.slice(-7)) r.new_users = -1500;
  const v = pre.computePrerenderValues(neg);
  assert.equal(v['velocity-7d'], '-1.5K/day');
  assert.equal(v['velocity-last'], '-1.5K');
  const none = makeData();
  for (const r of none.days.slice(-7)) r.new_users = null;
  assert.equal(pre.computePrerenderValues(none)['velocity-7d'], '—');
});

test('computePrerenderValues: same strings as script.js paints (parity with the UI)', () => {
  const real = pre.parseDataFile(fs.readFileSync(path.join(ROOT, 'data/bluesky-data.js'), 'utf8'));
  for (const [name, data] of [['committed data', real], ['synthetic', makeData()], ['long synthetic', makeLongData()]]) {
    assert.deepEqual(pre.computePrerenderValues(data), ui.computePrerenderValues(data), name);
  }
});

test('computePrerenderValues: tolerates empty or partial data', () => {
  const v = pre.computePrerenderValues({});
  for (const key of pre.INLINE_KEYS) assert.equal(typeof v[key], 'string', key);
  assert.equal(v['dau'], '—');
  assert.equal(v['velocity-7d'], '—');
  const r = pre.prerenderIndex(FIXTURE_HTML, {});
  assert.ok(r.html.includes('data-prerender="dau">—<'));
});

test('prerenderIndex: replaces every inline occurrence and reports keys', () => {
  const data = makeData();
  const v = pre.computePrerenderValues(data);
  const r = pre.prerenderIndex(FIXTURE_HTML, data);
  for (const key of pre.INLINE_KEYS) assert.ok(r.replaced.includes(key), `replaced ${key}`);
  for (const key of ['milestones', 'ticker', 'data-stamp', 'jsonld']) assert.ok(r.replaced.includes(key), `replaced ${key}`);
  assert.ok(r.html.includes('<li class="tick" data-tick="dau">'), 'real UI ticker markup');
  assert.deepEqual(r.missing, []);
  assert.ok(r.html.includes(`<time data-prerender="last-day">${v['last-day']}</time>`));
  assert.ok(r.html.includes(`<span class="value" id="val-users" data-prerender="users-total">${v['users-total']}</span>`));
  assert.ok(r.html.includes(`<span data-prerender='users-total-compact'>${v['users-total-compact']}</span>`));
  assert.ok(r.html.includes(`<span data-prerender=velocity-last>${v['velocity-last']}</span>`));
  assert.ok(r.html.includes(`<span class="value" data-prerender="velocity-7d" id="val-velocity">${v['velocity-7d']}</span>`));
  assert.ok(r.html.includes(`<strong data-prerender="users-total">${v['users-total']}</strong>`), 'repeated key inside FAQ');
  assert.equal(r.html.split(`data-prerender="dau">${v['dau']}<`).length - 1, 2, 'both valid dau elements');
});

test('prerenderIndex: leaves elements with children and unknown keys untouched', () => {
  const r = pre.prerenderIndex(FIXTURE_HTML, makeData());
  assert.ok(r.html.includes('<span data-prerender="dau"><b>has a child</b></span>'));
  assert.deepEqual(r.invalid, ['dau']);
  assert.ok(r.html.includes('<span data-prerender="not-a-key">kept</span>'));
  assert.deepEqual(r.unknown, ['not-a-key']);
});

test('prerenderIndex: reports missing keys instead of throwing', () => {
  const r = pre.prerenderIndex('<p><span data-prerender="dau">x</span></p>', makeData());
  assert.deepEqual(r.replaced, ['dau']);
  assert.ok(r.missing.includes('users-total'));
  assert.ok(r.missing.includes('milestones'));
  assert.ok(r.missing.includes('jsonld'));
  assert.ok(r.missing.includes('data-stamp'));
  assert.equal(r.html, '<p><span data-prerender="dau">528.0K</span></p>');
});

test('prerenderIndex: is idempotent and pure', () => {
  const data = makeData();
  const before = JSON.stringify(data);
  const once = pre.prerenderIndex(FIXTURE_HTML, data).html;
  const twice = pre.prerenderIndex(once, data).html;
  assert.equal(twice, once);
  assert.equal(JSON.stringify(data), before, 'data not mutated');
  const changed = makeData();
  changed.snapshot.total_users = 123456789;
  const again = pre.prerenderIndex(once, changed).html;
  assert.ok(again.includes('data-prerender="users-total">123,456,789<'));
  assert.ok(!again.includes(pre.computePrerenderValues(data)['users-total']));
});

test('prerenderIndex: rewrites the data cache-bust stamp only on the data script', () => {
  const r = pre.prerenderIndex(FIXTURE_HTML, makeData());
  assert.ok(r.html.includes('<script src="data/bluesky-data.js?v=202610010317"></script>'));
  assert.ok(r.html.includes('<script src="script.js?v=1"></script>'));
  const dotted = pre.prerenderIndex("<script defer src='./data/bluesky-data.js?v=1'></script>", makeData());
  assert.equal(dotted.html, "<script defer src='./data/bluesky-data.js?v=202610010317'></script>");
});

const FAKE_UI = {
  buildSeries: (days) => ({ n: days.length }),
  computeTickerItems: (data, series) => [`n=${series.n}`, `last=${data.last_complete_day}`],
  buildTickerHTML: (items) => items.map((i) => `<li class="tick">${i}</li>`).join('\n'),
  buildMilestoneRowsHTML: (data, series) => `<tr><td>${series.n}</td></tr>\n<tr class="current-row"><td>${data.last_complete_day}</td></tr>`,
};

test('prerenderIndex: blocks come from the UI builders, keep their markers and indentation', () => {
  const r = pre.prerenderIndex(FIXTURE_HTML, makeData(), { ui: FAKE_UI });
  assert.ok(r.html.includes('      <!-- prerender:milestones -->\n      <tr><td>30</td></tr>\n      <tr class="current-row"><td>2026-09-30</td></tr>\n      <!-- /prerender:milestones -->'));
  assert.ok(r.html.includes('      <!-- prerender:ticker -->\n      <li class="tick">n=30</li>\n      <li class="tick">last=2026-09-30</li>\n      <!-- /prerender:ticker -->'));
  assert.ok(!r.html.includes('STALE') && !r.html.includes('<td>stale</td>'));
  assert.equal(pre.prerenderIndex(r.html, makeData(), { ui: FAKE_UI }).html, r.html, 'idempotent');
});

test('prerenderIndex: without UI builders the blocks are left alone and reported missing', () => {
  const r = pre.prerenderIndex(FIXTURE_HTML, makeData(), { ui: null });
  assert.ok(r.html.includes('<span class="ticker-item">STALE</span>'));
  assert.ok(r.html.includes('<tr><td>stale</td></tr>'));
  assert.ok(r.missing.includes('ticker') && r.missing.includes('milestones'));
  assert.ok(r.replaced.includes('jsonld'));
});

test('renderBlocks: uses script.js, so the static blocks equal what the page paints', () => {
  const data = pre.parseDataFile(fs.readFileSync(path.join(ROOT, 'data/bluesky-data.js'), 'utf8'));
  const blocks = pre.renderBlocks(data);
  assert.deepEqual(blocks.ticker, ui.buildTickerHTML(ui.computeTickerItems(data)).split('\n'));
  assert.deepEqual(blocks.milestones, ui.buildMilestoneRowsHTML(data).split('\n'));
  assert.equal(blocks.ticker.length, 8);
  assert.equal(blocks.milestones.length, 8);
  assert.match(blocks.milestones.at(-1), /^<tr class="current-row">/);
  assert.deepEqual(pre.renderBlocks({ days: [] }), {});
});

test('buildJsonLd: WebApplication + FAQPage + Dataset with CSV distribution', () => {
  const ld = pre.buildJsonLd(makeData());
  assert.equal(ld['@context'], 'https://schema.org');
  const types = ld['@graph'].map((n) => n['@type']);
  assert.deepEqual(types, ['WebApplication', 'FAQPage', 'Dataset']);
  const ds = ld['@graph'][2];
  assert.equal(ds.temporalCoverage, '2026-09-01/2026-09-30');
  assert.equal(ds.dateModified, '2026-10-01T03:17:42.123Z');
  assert.equal(ds.distribution[0].contentUrl, pre.CSV_URL);
  assert.equal(pre.CSV_URL, pre.SITE_URL + 'data/bluesky-daily.csv');
  assert.equal(ds.distribution[0].encodingFormat, 'text/csv');
  assert.ok(ds.description.length >= 50 && ds.description.length <= 5000);
  const faq = ld['@graph'][1].mainEntity;
  assert.ok(faq.length >= 3);
  for (const q of faq) {
    assert.equal(q['@type'], 'Question');
    assert.ok(q.name && q.acceptedAnswer.text);
    assert.ok(!q.acceptedAnswer.text.includes('undefined'));
  }
  assert.equal(pre.buildJsonLd(makeLongData())['@graph'][2].temporalCoverage, '2022-11-17/2026-01-10');
});

test('prerenderIndex: JSON-LD FAQ mirrors the visible FAQ text after pre-render', () => {
  const data = makeData();
  const v = pre.computePrerenderValues(data);
  const r = pre.prerenderIndex(FIXTURE_HTML, data);
  const ld = JSON.parse(/<script type="application\/ld\+json" id="jsonld">([\s\S]*?)<\/script>/.exec(r.html)[1]);
  const faq = ld['@graph'][1].mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
  assert.deepEqual(faq, [
    ['How many users does Bluesky have?', `Jaz's index counts ${v['users-total']} accounts as of ${v['last-day']} & growing.`],
    ['How many people use Bluesky daily?', `At least ${v['dau']} accounts were active, and ${v['posters']} posted.`],
  ]);
  assert.deepEqual(pre.extractFaq(r.html).map((f) => [f.question, f.answer]), faq);
});

test('prerenderIndex: JSON-LD cannot break out of its script element', () => {
  const html = '<script type="application/ld+json" id="jsonld"></script>' +
    '<details class="faq-item"><summary>Q &lt;/script&gt;?</summary><p>A &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p></details>';
  const r = pre.prerenderIndex(html, makeData());
  const body = /id="jsonld">([\s\S]*?)<\/script>/.exec(r.html)[1];
  assert.ok(!body.includes('<'));
  const ld = JSON.parse(body);
  assert.equal(ld['@graph'][1].mainEntity[0].acceptedAnswer.text, 'A </script><script>alert(1)</script>');
  assert.equal(r.html.match(/<\/script>/g).length, 1);
});

test('updateSitemap: sets lastmod to last_complete_day, idempotent, inserts when absent', () => {
  const data = makeData();
  const out = pre.updateSitemap(FIXTURE_SITEMAP, data);
  assert.ok(out.includes('<lastmod>2026-09-30</lastmod>'));
  assert.ok(!out.includes('2020-01-01'));
  assert.equal(pre.updateSitemap(out, data), out);
  const bare = '<urlset>\n  <url>\n    <loc>https://example.test/</loc>\n  </url>\n</urlset>\n';
  assert.equal(pre.updateSitemap(bare, data), '<urlset>\n  <url>\n    <loc>https://example.test/</loc>\n    <lastmod>2026-09-30</lastmod>\n  </url>\n</urlset>\n');
  assert.equal(pre.updateSitemap(FIXTURE_SITEMAP, {}), FIXTURE_SITEMAP);
});

test('repo sitemap.xml and robots.txt point at the Pages URL', () => {
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes(`<loc>${pre.SITE_URL}</loc>`));
  assert.match(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  assert.ok(robots.includes(`Sitemap: ${pre.SITE_URL}sitemap.xml`));
});

test('parseDataFile: reads the committed data file without executing it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'data/bluesky-data.js'), 'utf8');
  const data = pre.parseDataFile(src);
  assert.equal(data.schema, 1);
  assert.equal(data.days.at(-1).date, data.last_complete_day);
  assert.throws(() => pre.parseDataFile('var x = 1;'), /BLUESKY_DATA/);
});

test('committed data: every pre-rendered value is available', () => {
  const data = pre.parseDataFile(fs.readFileSync(path.join(ROOT, 'data/bluesky-data.js'), 'utf8'));
  const v = pre.computePrerenderValues(data);
  for (const key of pre.INLINE_KEYS) assert.notEqual(v[key], '—', key);
  assert.match(v['velocity-7d'], /^[+-][\d.]+[KM]?\/day$/);
  assert.match(v['poster-ratio'], /^\d+\.\d%$/);
  assert.match(v['dau-share'], /^\d+\.\d{2}%$/);
});

test('CLI: --dry-run writes nothing; a real run updates index and sitemap copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-'));
  try {
    const dataFile = path.join(dir, 'data.js');
    fs.writeFileSync(dataFile, '// generated\nwindow.BLUESKY_DATA = ' + JSON.stringify(makeLongData()) + ';\n');
    const index = path.join(dir, 'index.html');
    const sitemap = path.join(dir, 'sitemap.xml');
    fs.writeFileSync(index, FIXTURE_HTML);
    fs.writeFileSync(sitemap, FIXTURE_SITEMAP);
    const cli = path.join(ROOT, 'lib/prerender.js');
    const args = [cli, '--data', dataFile, '--index', index, '--sitemap', sitemap];
    const dry = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 1, 'fixture has an invalid element -> exit 1');
    assert.match(dry.stderr, /invalid \(element has child nodes\): dau/);
    assert.equal(fs.readFileSync(index, 'utf8'), FIXTURE_HTML);
    assert.equal(fs.readFileSync(sitemap, 'utf8'), FIXTURE_SITEMAP);
    spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.ok(fs.readFileSync(index, 'utf8').includes('?v=202601110400'));
    assert.ok(fs.readFileSync(sitemap, 'utf8').includes('<lastmod>2026-01-10</lastmod>'));
    fs.writeFileSync(index, FIXTURE_HTML.replace('<span data-prerender="dau"><b>has a child</b></span>', ''));
    const ok = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(ok, /replaced: last-day/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
