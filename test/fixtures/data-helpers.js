'use strict';
// Shared builders for the data-pipeline tests (not a test file itself).
const fs = require('fs');
const path = require('path');

const H = 3600e3;
const D = 86400e3;
const ms = (iso) => Date.parse(iso);

// The real /stats response captured 2026-10-08T03:47Z, expanded back to the API's shape.
function loadJazcoStats() {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-jazco-stats.json'), 'utf8'));
  const { rows, columns, note, ...top } = f;
  return { ...top, daily_data: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))) };
}

// Hourly readings growing at `perHour` from `start` for `hours` hours.
function hourly(src, startIso, hours, base, perHour) {
  const t0 = ms(startIso);
  return Array.from({ length: hours }, (_, i) => ({ t: t0 + i * H, src, users: base + Math.round(i * perHour) }));
}

// A minimal but complete sample set: Commons daily values up to 2024-07-01, a few Wayback
// captures in the 2024 gap, then hourly bot readings from 2024-11-17 to `botEndIso`.
function syntheticSamples({ botEndIso = '2026-10-08T03:00:00Z', botPerHour = 700 } = {}) {
  const out = [];
  let users = 5;
  for (let t = ms('2022-11-18T00:00:00Z'); t <= ms('2024-07-02T00:00:00Z'); t += D) {
    const date = new Date(t - D).toISOString().slice(0, 10);
    if ((date >= '2024-02-04' && date <= '2024-02-07') || (date >= '2024-06-23' && date <= '2024-06-28')) continue;
    users += 10000;
    out.push({ t, src: 'commons', users });
  }
  out.push({ t: ms('2024-02-06T17:00:00Z'), src: 'wayback', users: 3_000_000 });
  out.push({ t: ms('2024-09-01T12:00:00Z'), src: 'wayback', users: 7_000_000 });
  out.push({ t: ms('2024-11-15T07:00:00Z'), src: 'wayback', users: 16_000_000 });
  const hours = Math.floor((ms(botEndIso) - ms('2024-11-17T01:00:00Z')) / H) + 1;
  out.push(...hourly('bot', '2024-11-17T01:00:00Z', hours, 18_000_000, botPerHour));
  return out;
}

function feedOf(readings, { actor = 'did:plc:5he4nkza7eqhmirg3azchqy6' } = {}) {
  return {
    feed: readings.map(([createdAt, n]) => ({
      post: {
        author: { did: actor, handle: 'hourlybskyusers.bsky.social' },
        record: { $type: 'app.bsky.feed.post', createdAt, text: `Total Bluesky users: ${n.toLocaleString('en-US')}` },
      },
    })),
  };
}

function plcSamples(fromIso, toIso, { perHour = 1000, stepHours = 3, burst = null } = {}) {
  const out = [];
  for (let t = ms(fromIso); t < ms(toIso); t += stepHours * H) {
    const rate = burst && t >= ms(burst.from) && t < ms(burst.to) ? perHour * burst.factor : perHour;
    const span = (1000 / rate) * H;
    out.push({
      after: new Date(t).toISOString(),
      first: new Date(t).toISOString(),
      last: new Date(t + span).toISOString(),
      ops: 1000,
      genesis_all: 1000,
      genesis_bsky: 1000,
    });
  }
  return out;
}

module.exports = { H, D, ms, loadJazcoStats, hourly, syntheticSamples, feedOf, plcSamples };
