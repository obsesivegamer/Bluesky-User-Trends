'use strict';

// Realistic, entirely fictional data/social.js payload (contract B) for the UI tests and the browser harness.
// Everything is derived from `now`, so "last posted 3h ago" stays true whenever the fixture is built.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function did(i) {
  const r = rng(1000 + i);
  let id = '';
  for (let k = 0; k < 24; k += 1) id += ALPHABET[Math.floor(r() * 32)];
  return `did:plc:${id}`;
}

const NAMES = [
  ['Aurora Fields', 'aurorafields.bsky.social'], ['Marcus Hale', 'marcushale.dev'], ['Priya Venkat', 'priyav.bsky.social'],
  ['The Daily Ledger', 'dailyledger.news'], ['Tomasz Kowal', 'tkowal.bsky.social'], ['Nia Okafor', 'nia.okafor.example'],
  ['Pixel Orchard', 'pixelorchard.bsky.social'], ['Dr. Helen Marsh', 'drmarsh.science'], ['Kenji Aoki', 'kenjiaoki.bsky.social'],
  ['Lumen Weekly', 'lumenweekly.bsky.social'], ['Sofia Brandt', 'sofiabrandt.bsky.social'], ['Rowan & Reed', 'rowanreed.studio'],
  ['Mira Castellano', 'miracastellano.bsky.social'], ['Open Atlas', 'openatlas.org'], ['Jules Moreau', 'julesmoreau.bsky.social'],
  ['Hyperlocal Radio', 'hyperlocal.radio'], ['Anders Lind', 'anderslind.bsky.social'], ['Zainab Rahman', 'zainab.bsky.social'],
  ['Gridlock Games', 'gridlockgames.bsky.social'], ['Elena Petrova', 'elenapetrova.bsky.social'], ['Quiet Harbor', 'quietharbor.bsky.social'],
  ['Declan Shaw', 'declanshaw.bsky.social'], ['Ines Duarte', 'inesduarte.bsky.social'], ['Foxglove Press', 'foxglovepress.com'],
  ['Wei Zhang', 'weizhang.bsky.social'], ['Beacon Review', 'beaconreview.bsky.social'], ['Calla Ferreira', 'callaferreira.bsky.social'],
  ['Northwind Labs', 'northwind.dev'], ['Olu Adeyemi', 'oluadeyemi.bsky.social'], ['Saffron & Salt', 'saffronsalt.bsky.social']
];

const PDS = [
  'https://morel.us-east.host.bsky.network', 'https://amanita.us-east.host.bsky.network', 'https://shiitake.us-east.host.bsky.network',
  'https://porcini.us-west.host.bsky.network', 'https://pds.example-community.org', 'https://eurosky.social', 'https://atproto.brid.gy'
];

const TEXTS = [
  'Shipping the new release tonight. Thank you to everyone who filed bugs, tested builds and argued about the changelog.',
  'Reminder that the best time to back up your files was last year. The second best time is right now.',
  'Walked past a bakery at 6am and the whole street smelled like cardamom. Small things.',
  'Thread: what I learned from reading 400 municipal budget documents so you do not have to (1/12)',
  'New photo set from the coast this weekend. Fog rolled in around noon and never really left.',
  'Hot take: a changelog is documentation. Treat it like it.',
  'We are hiring two engineers to work on open protocols. Remote friendly, real salaries, no growth hacks.',
  'The moon was absurdly bright last night. Did anyone else notice?',
  'Spent the afternoon teaching my kid to solder. The smoke detector has opinions.',
  'Correction to this morning\'s post: the figure is 4.2 million, not 42 million. Sorry for the confusion.'
];

function buildSocialFixture({ now = '2026-10-09T12:00:00Z' } = {}) {
  const nowMs = Date.parse(now);
  const iso = (ms) => new Date(ms).toISOString();
  const ago = (hours) => iso(nowMs - hours * 3600e3);
  const day = iso(nowMs - 86400e3).slice(0, 10);
  const r = rng(7);

  const accounts = {};
  const eligible = [];
  NAMES.forEach(([name, handle], i) => {
    const id = did(i);
    const followers = Math.round(12000 + (NAMES.length - i) ** 3 * 1400 + r() * 5000);
    const capped = i % 7 === 3;
    accounts[id] = {
      handle,
      display_name: name,
      avatar: i === 5 ? '' : `https://cdn.bsky.app/img/avatar/plain/${id}/bafkrei${ALPHABET.slice(i % 20, i % 20 + 12)}@jpeg`,
      followers,
      follows: Math.round(150 + r() * 3000),
      posts: Math.round(300 + r() * 60000),
      posts_this_month: capped ? 1000 : Math.round(r() * 400),
      posts_this_month_capped: capped,
      last_posted: i === 9 ? null : ago(0.2 + r() * 70),
      created_at: iso(nowMs - (90 + r() * 1300) * 86400e3),
      pds: PDS[i % 11 === 4 ? 4 : i % 13 === 6 ? 5 : i % 17 === 9 ? 6 : i % 4]
    };
    eligible.push(id);
  });

  // Accounts that must never be named: too few followers, opt-out label, moderation label, unresolved handle, adult-labelled author.
  const bad = {
    small: did(100), optout: did(101), hidden: did(102), invalid: did(103), adult: did(104), padded: did(105), wide: did(106)
  };
  const base = (handle, name, followers) => ({
    handle, display_name: name, avatar: 'https://cdn.bsky.app/img/avatar/plain/x/y@jpeg', followers, follows: 10, posts: 20,
    posts_this_month: 3, posts_this_month_capped: false, last_posted: ago(2), created_at: ago(5000), pds: PDS[0]
  });
  accounts[bad.small] = base('smallfry.bsky.social', 'Small Fry', 9999);
  accounts[bad.optout] = { ...base('privateperson.bsky.social', 'Private Person', 250000), labels: ['!no-unauthenticated'] };
  accounts[bad.hidden] = { ...base('hiddenaccount.bsky.social', 'Hidden Account', 90000), labels: [{ val: '!hide' }] };
  accounts[bad.invalid] = base('handle.invalid', 'Unresolved', 80000);
  accounts[bad.adult] = { ...base('adultauthor.bsky.social', 'Adult Author', 70000), labels: ['porn'] };
  accounts[bad.padded] = { ...base('spacedbang.bsky.social', 'Spaced Bang', 65000), labels: [{ val: ' !HIDE ' }] };
  accounts[bad.wide] = { ...base('widebang.bsky.social', 'Wide Bang', 60000), labels: ['\u200b！no-unauthenticated'] };

  const spread = (list, scale, extra) => {
    const rows = list.map((id, i) => ({ did: id, value: Math.max(1, Math.round(scale / (i + 1) ** 0.8)), ...(extra ? extra(i) : {}) }));
    // ineligible accounts sit near the top, as a careless builder would leave them
    rows.splice(1, 0, { did: bad.optout, value: Math.round(scale * 0.9), ...(extra ? extra(1) : {}) });
    rows.splice(3, 0, { did: bad.small, value: Math.round(scale * 0.7), ...(extra ? extra(3) : {}) });
    rows.splice(6, 0, { did: bad.hidden, value: Math.round(scale * 0.5), ...(extra ? extra(6) : {}) });
    rows.splice(9, 0, { did: bad.invalid, value: Math.round(scale * 0.4), ...(extra ? extra(9) : {}) });
    rows.splice(11, 0, { did: bad.padded, value: Math.round(scale * 0.3), ...(extra ? extra(11) : {}) });
    rows.splice(13, 0, { did: bad.wide, value: Math.round(scale * 0.2), ...(extra ? extra(13) : {}) });
    return rows;
  };
  const top = (n) => eligible.slice(0, n);
  const shuffled = (seed) => {
    const rr = rng(seed);
    const out = [...eligible];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rr() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const ratioRows = (seed) => shuffled(seed).slice(0, 25).map((id, i) => {
    const blocks = Math.round(2000 / (i + 1) ** 0.7) + 100;
    const follows = Math.round(blocks / (4.2 - i * 0.14));
    const row = { did: id, value: Math.round((blocks / follows) * 100) / 100, blocks, follows };
    if (i === 3) row.follows_below_cut = true;
    return row;
  });
  const moveRows = (seed, sign) => {
    const rows = shuffled(seed).slice(0, 25).map((id, i) => ({ did: id, value: sign * Math.round(52000 / (i + 1) ** 0.9) }));
    rows.splice(0, 0, { did: bad.hidden, value: sign * 90000 });
    rows.splice(4, 0, { did: bad.small, value: sign * 30000 });
    return rows;
  };

  const boards = {
    blocked_24h: spread(top(30), 4200),
    blocked_7d: spread(shuffled(11), 21000),
    blocked_all: spread(shuffled(12), 46000),
    growing_24h: spread(shuffled(13), 31000),
    growing_7d: spread(shuffled(14), 150000),
    followed: [...eligible].map((id) => ({ did: id, value: accounts[id].followers })).sort((a, b) => b.value - a.value),
    gainers_24h: moveRows(15, 1),
    losers_24h: moveRows(16, -1),
    gainers_7d: moveRows(17, 1),
    losers_7d: moveRows(18, -1),
    controversial_24h: ratioRows(19),
    controversial_7d: ratioRows(20)
  };
  boards.followed.splice(2, 0, { did: bad.optout, value: 9e7 });

  const post = (i, author, extra) => ({
    uri: `at://${author}/app.bsky.feed.post/3m${ALPHABET.slice(i, i + 11)}`,
    url: '',
    author,
    text: TEXTS[i % TEXTS.length],
    created_at: iso(Date.parse(`${day}T00:00:00Z`) + (23 - i * 1.8) * 3600e3),
    likes: Math.round(48000 / (i + 1) ** 0.85),
    reposts: Math.round(7000 / (i + 1) ** 0.85),
    quotes: Math.round(1900 / (i + 1) ** 0.85),
    replies: Math.round(2600 / (i + 1) ** 0.85),
    ...extra
  });
  const top_posts = [];
  eligible.slice(0, 10).forEach((id, i) => top_posts.push(post(i, id)));
  top_posts.forEach((p) => { p.url = `https://bsky.app/profile/${accounts[p.author].handle}/post/${p.uri.split('/').pop()}`; });
  // skipped by the guardrails: ineligible author, adult label on the post, adult-labelled author
  top_posts.splice(0, 0, post(0, bad.optout, { likes: 99000 }));
  top_posts.splice(2, 0, post(1, eligible[11], { likes: 61000, labels: [{ val: 'graphic-media' }] }));
  top_posts.splice(4, 0, post(2, bad.adult, { likes: 57000 }));
  // text-free posts stay and show a placeholder
  const eligiblePosts = top_posts.filter((p) => !Object.values(bad).includes(p.author) && !p.labels);
  Object.assign(eligiblePosts[3], { text: '', embed: 'image' });
  Object.assign(eligiblePosts[6], { text: '', embed: 'quote' });
  // more ways a careless builder could leak: shouted or padded labels, another day, a uri that names someone else
  const hostile = [
    post(3, eligible[12], { likes: 56000, labels: [{ val: 'PORN' }] }),
    post(4, eligible[13], { likes: 55000, labels: [{ val: ' !Hide' }] }),
    post(5, eligible[14], { likes: 54000, created_at: '2020-01-01T00:00:00.000Z' }),
    post(6, eligible[15], { likes: 53000, uri: `at://${eligible[16]}/app.bsky.feed.post/3mhostilemismatch` }),
    post(7, bad.padded, { likes: 52000 })
  ];
  hostile.forEach((p) => top_posts.splice(1, 0, p));

  return {
    schema: 1,
    generated_at: iso(nowMs - 8 * 3600e3),
    day,
    coverage: { days_7d: 7, complete_24h: true, first_day: iso(nowMs - 8 * 86400e3).slice(0, 10) },
    guardrails: {
      min_followers: 10000,
      excluded_labels: "any label starting with '!'",
      adult_labels: ['porn', 'sexual', 'nudity', 'graphic-media', 'gore']
    },
    accounts,
    boards,
    top_posts,
    totals: { follows_24h: 2600000, blocks_24h: 540000 },
    ineligibleDids: Object.values(bad),
    hostilePosts: hostile.map((p) => p.uri)
  };
}

// The same payload with hostile strings in every field that is rendered.
function buildMaliciousFixture(opts) {
  const f = buildSocialFixture(opts);
  const ids = Object.keys(f.accounts).filter((id) => !f.ineligibleDids.includes(id));
  const [a, b, c, d] = ids;
  f.accounts[a].display_name = '<img src=x onerror="window.__pwned=1">Evil Name';
  f.accounts[a].avatar = 'javascript:window.__pwned=1';
  f.accounts[b].display_name = '"><script>window.__pwned=1</script>';
  f.accounts[b].avatar = 'http://cdn.bsky.app/insecure.jpg';
  f.accounts[c].avatar = 'https://cdn.bsky.app/a.jpg" onerror="window.__pwned=1';
  f.accounts[c].pds = 'https://evil.example"><svg onload=window.__pwned=1>';
  f.accounts[d].display_name = 'Bidi ‮evil‬ name \u0000 with controls';
  f.accounts[d].handle = 'x"><b>bad</b>.example';
  f.accounts[ids[6]].avatar = 'https://user:pass@127.0.0.1/a.png';
  f.accounts[ids[7]].avatar = 'https://evil.example/a.svg';
  const post = f.top_posts.find((p) => p.author === a);
  post.text = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1"> & "quotes" \'single\'';
  const post2 = f.top_posts.find((p) => p.author === b);
  post2.text = 'x'.repeat(600);
  return f;
}

function toScript(social) {
  const { ineligibleDids, hostilePosts, ...payload } = social;
  return `// generated by scripts/build-social.js — do not edit\nwindow.BLUESKY_SOCIAL = ${JSON.stringify(payload)};\n`;
}

module.exports = { buildSocialFixture, buildMaliciousFixture, toScript };

if (require.main === module) {
  const kind = process.argv[2] || 'clean';
  const now = process.argv[3] || undefined;
  const build = kind === 'malicious' ? buildMaliciousFixture : buildSocialFixture;
  const payload = build({ now });
  if (kind === 'partial') payload.coverage.complete_24h = false;
  if (kind === 'gainersonly') payload.boards.losers_24h = [];
  if (kind === 'nomovers') for (const k of ['gainers_24h', 'losers_24h', 'gainers_7d', 'losers_7d']) payload.boards[k] = [];
  process.stdout.write(toScript(payload));
}
