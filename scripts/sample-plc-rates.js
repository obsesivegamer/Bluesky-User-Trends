#!/usr/bin/env node
// Samples the rate of new Bluesky-hosted did:plc accounts from plc.directory/export.
// The user-count archives are sparse between 2024-07 and 2024-11 (Brazil and US-election
// waves); these rates give the shape of growth between known anchor counts. Fetching every
// operation would be ~20k requests, so we read one 1,000-op page every STEP hours instead.
//
// Usage: node scripts/sample-plc-rates.js [out.json]
// Env:   PLC_START, PLC_END (ISO), PLC_STEP_HOURS (default 3). Resumes from an existing out file.

const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'data', 'sources', 'plc-rate-samples.json');
const START = process.env.PLC_START || '2024-07-01T00:00:00.000Z';
const END = process.env.PLC_END || '2024-11-18T06:00:00.000Z';
const STEP_MS = Number(process.env.PLC_STEP_HOURS || 3) * 3600e3;
const UA = 'Bluesky-User-Trends (+https://github.com/obsesivegamer/Bluesky-User-Trends)';
const BSKY_PDS = /^https:\/\/([a-z0-9-]+\.[a-z0-9-]+\.host\.bsky\.network|bsky\.social)\/?$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarisePage(lines, after) {
  const ops = lines.map((l) => JSON.parse(l));
  let genesisAll = 0;
  let genesisBsky = 0;
  for (const { operation: op } of ops) {
    if (op.prev !== null && op.prev !== undefined) continue;
    genesisAll++;
    const endpoint = op.services?.atproto_pds?.endpoint ?? op.service ?? '';
    if (BSKY_PDS.test(endpoint)) genesisBsky++;
  }
  return {
    after,
    first: ops[0]?.createdAt ?? null,
    last: ops.at(-1)?.createdAt ?? null,
    ops: ops.length,
    genesis_all: genesisAll,
    genesis_bsky: genesisBsky,
  };
}

async function fetchPage(after) {
  const url = `https://plc.directory/export?count=1000&after=${encodeURIComponent(after)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return (await res.text()).split('\n').filter(Boolean);
      console.warn(`HTTP ${res.status} for ${after}`);
    } catch (err) {
      console.warn(`fetch failed for ${after}: ${err.message}`);
    }
    await sleep(2000 * 2 ** attempt);
  }
  throw new Error(`giving up on page after=${after}`);
}

async function main() {
  const samples = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).samples : [];
  const nextCursor = (s) => Math.max(Date.parse(s.after) + STEP_MS, s.last ? Date.parse(s.last) : 0);
  let cursor = samples.length ? nextCursor(samples.at(-1)) : Date.parse(START);
  const end = Date.parse(END);
  while (cursor < end) {
    const after = new Date(cursor).toISOString();
    const sample = summarisePage(await fetchPage(after), after);
    samples.push(sample);
    fs.writeFileSync(OUT, JSON.stringify({ source: 'https://plc.directory/export', step_hours: STEP_MS / 3600e3, samples }, null, 0).replace(/},{/g, '},\n{'));
    if (samples.length % 25 === 0) console.log(`${samples.length} samples, at ${after}`);
    cursor = nextCursor(sample);
    await sleep(250);
  }
  console.log(`done: ${samples.length} samples -> ${OUT}`);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { summarisePage, BSKY_PDS };
