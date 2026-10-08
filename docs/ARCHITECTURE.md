# Architecture

Bluesky Network Pulse is a static page on GitHub Pages. Nothing runs on a server: a scheduled GitHub
Action fetches the public data, rebuilds one committed data file, pre-renders the latest numbers into
`index.html`, and commits. The browser reads the committed file. The only request the browser makes to
a third party for data is an optional, best-effort read of the newest hourly user count from the
public Bluesky AppView.

## Data flow

```
                        GitHub Action "Update Bluesky Data"  (cron 17 3,15 * * *  +  manual)
                        ─────────────────────────────────────────────────────────────────────
 bsky-search.jazco.io/stats ──┐
   total_users snapshot +     │
   daily_data (per UTC day)   ├─► node updateData.js
 public.api.bsky.app          │     1. lib/jazco.js   normalise daily_data, drop today/future rows,
   getAuthorFeed (hourly bot) ┘                       flag outages per metric, compute dau
                                    2. append fresh samples → data/users-samples.json
                                    3. lib/users.js   samples → end-of-day users series
                                       (+ data/sources/plc-rate-samples.json to shape 2024 gaps)
                                    4. lib/build.js   contiguous rows, merge with the archive,
                                       write data/bluesky-data.js + data/bluesky-daily.csv
                                    5. lib/prerender.js  numbers → index.html, lastmod → sitemap.xml
                                  npm test  (gate: checks the code and the rebuilt data; a failure
                                             commits nothing)
                                  git add data index.html sitemap.xml → commit (if changed) → push
                                                         │
                                                         ▼
                                               GitHub Pages (main, /)
                                                         │
 Browser ── index.html (already shows current numbers: pre-rendered for crawlers and no-JS readers)
            ├─ Chart.js 4.5.1 + hammerjs 2.0.8 + chartjs-plugin-zoom 2.0.1 (jsDelivr, pinned)
            ├─ lib/format.js            shared number/date formatting (same code as the pre-render)
            ├─ data/bluesky-data.js?v=  window.BLUESKY_DATA (cache-busted by generated_at)
            └─ script.js                charts, KPIs, ticker, ranges, compare, exports
                 └─ optional live count: public.api.bsky.app getAuthorFeed (CORS *), 5 s timeout,
                    on load and every 10 min while visible; any failure → stays "ARCHIVE"
```

jazco's `/stats` sends CORS headers only for `bsky.jazco.dev` and localhost, so a GitHub Pages page cannot
read it directly. That is why the archive is built server-side and committed.

## File map

| Path | Role |
|---|---|
| `index.html` | The page: head/SEO, JSON-LD, header, ticker, command bar, KPI cards, charts, table, milestones, FAQ, guide dialog. Holds the pre-render markers below. |
| `style.css` | Design system (Bloomberg amber on obsidian; dark-only by design). |
| `script.js` | All browser logic. Pure helpers are exported for Node (`module.exports` guard) and tested in `test/script.test.js`. |
| `favicon.svg` | Icon. |
| `lib/format.js` | Number and date formatters, loaded by the browser (`window.BskyFormat`) and required by Node. Both sides format through it, so the pre-rendered text and the painted text are identical. |
| `lib/prerender.js` | Pure pre-render: `computePrerenderValues`, `prerenderIndex`, `buildJsonLd`, `updateSitemap`. Also a CLI (`npm run prerender`). |
| `lib/jazco.js` | Normalises jazco `/stats`, flags outages, computes `dau`. |
| `lib/users.js` | Turns timestamped user-count samples into the end-of-day users series. |
| `lib/build.js` | Assembles rows, merges with the existing archive, serialises the JS and CSV files. |
| `updateData.js` | The updater the Action runs. |
| `lib/accounts.js` | Pure helpers for the own account count: tally statuses, choose hosts, merge runs, net change. |
| `scripts/count-accounts.js` | Daily `listRepos` count of every account on Bluesky-operated hosts → `data/accounts-daily.json`. |
| `scripts/backfill-users.js` | One-time, re-runnable builder of `data/users-samples.json` from all historical sources (cache in `.cache/`, gitignored). |
| `scripts/sample-plc-rates.js` | Samples Bluesky-hosted DID creation rates from plc.directory for 2024-07 → 2024-11. |
| `scripts/verify-dashboard.py` | Playwright end-to-end harness (see "Verification"). |
| `data/bluesky-data.js` | The archive the page loads (generated, one row per line). |
| `data/bluesky-daily.csv` | The same rows as CSV; the downloadable dataset. |
| `data/accounts-daily.json` | Own account count, one row per UTC day (active, deactivated, taken down, …). |
| `data/users-samples.json` | Committed provenance: the user-count readings the series is built from. |
| `data/sources/plc-rate-samples.json` | Committed PLC creation-rate samples used to shape 2024 gaps. |
| `data/README.md` | Sources, credits, changes made and license notices for the data. |
| `.github/workflows/update-data.yml` | Scheduled data update (update → tests → commit → push with one rebase retry). |
| `.github/dependabot.yml` | Monthly updates of the SHA-pinned GitHub Actions. |
| `.github/workflows/test.yml` | `npm test` on Node 22 and 24 for every push and pull request, plus a pre-render contract check. |
| `robots.txt`, `sitemap.xml` | `sitemap.xml` `<lastmod>` follows the last complete day. Crawlers only read `/robots.txt` at the host root, so this project-path copy is informational: submit `sitemap.xml` in Search Console or Bing Webmaster Tools. |

## Data contract: `data/bluesky-data.js`

A classic script (no modules) so the page also works from `file://`:

```js
// generated by updateData.js — do not edit
window.BLUESKY_DATA = {"schema":1, ..., "days":[
{"date":"2022-11-17", ...},
...
]};
```

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `generated_at` | ISO time the updater ran |
| `last_complete_day` | Date of the last row (yesterday in UTC at build time) |
| `snapshot` | The headline user count: `total_users`, `updated_at`, `total_posts`, `total_likes`, `total_follows`, `source`. `total_users`/`updated_at` are the newest reading that survived cleaning (normally jazco's live total; a stale or frozen jazco total is not used) or, if none is newer, the snapshot already published, so it never goes back in time. The three totals are sums of jazco's index since 2023-03-01, not network-wide all-time totals; each falls back to the published value when jazco omits it or its cache is older. |
| `live_source` | Where the browser may read a fresher user count: the `hourlybskyusers.bsky.social` bot's author feed and the regex for its post text. |
| `activity_start` | `2023-03-01`, the first jazco daily row |
| `collection_start` | `2023-05-01`; jazco's activity counts before this are reconstructed and undercounted |
| `own_count` | `null`, or our own listRepos count: `{source, rows:[{date, finished_at, complete, repos, active, deactivated, takendown, suspended, deleted, other}], net:[{date, net_active}]}` |
| `days` | Ascending, one row per UTC calendar day, contiguous, from `2022-11-17` to `last_complete_day` |

Every row has every key:

| Key | Meaning |
|---|---|
| `date` | UTC day, `YYYY-MM-DD` |
| `users` | Accounts at the **end** of that UTC day (value at `date + 1` 00:00Z). Never null. |
| `users_est` | `true` when no reading was within ±3 h of that boundary (interpolated or PLC-shaped) |
| `users_src` | `commons`, `wayback`, `bot`, `elaval`, `krekeny`, `jazco`, `plc-shaped` or `interp` |
| `new_users` | `users[d] − users[d−1]`: user velocity. Null on the first row. Jaz's counter never subtracts deleted accounts, so this is new sign-ups, not net growth (0 negative rows so far). |
| `new_users_est` | `users_est[d] || users_est[d−1]` |
| `likers`, `posters`, `followers`, `blockers` | Distinct accounts that liked / posted / followed / blocked that day (jazco). Null before `activity_start`. |
| `posts`, `likes`, `follows`, `blocks` | Record counts that day (jazco) |
| `dau` | Daily active users, lower bound: max of the non-flagged `likers`, `posters`, `followers`, `blockers`. Null when `likers` or `posters` is flagged. |
| `flags` | Metric keys whose value is unreliable that day. **Consumers treat a flagged metric as missing**: a gap in charts, and excluded from moving averages, deltas, peaks, comparisons and ratios. |

## Pre-render contract

Goal: crawlers and no-JS readers see current numbers, and `script.js` later paints the **same strings**
in its default view (range 1Y), so nothing flips after load. All values come from `lib/format.js`.

### Inline values

Any element `<tag … data-prerender="KEY" …>TEXT</tag>` whose content is text only (no child elements).
`prerenderIndex` replaces TEXT. A key may appear any number of times. Elements that contain child
elements are left alone and reported as `invalid`; unknown keys are left alone and reported as `unknown`.

| KEY | Value |
|---|---|
| `last-day` | `formatDay(last_complete_day)`, e.g. `Oct 7, 2026` |
| `generated` | `formatUtcStamp(generated_at)`, e.g. `2026-10-08 03:17 UTC` |
| `activity-day` | `formatDay` of the day `dau`, `posters`, `poster-ratio` and `dau-share` describe (the latest day with a usable `dau`); use it, not `last-day`, in sentences about them |
| `users-total` | `formatInteger(snapshot.total_users)` |
| `users-total-compact` | `formatCompact(snapshot.total_users)` |
| `users-at` | `formatUtcStamp(snapshot.updated_at)`: when the headline count was read |
| `velocity-7d` | `formatSigned(mean of new_users over the last 7 calendar days) + "/day"`, e.g. `+16.0K/day` (days without a value are skipped) |
| `velocity-last` | `formatSigned(new_users of the last day)` |
| `dau` | `formatCompact(dau)` of the latest day with a usable `dau` |
| `posters` | `formatCompact(posters)` on `activity-day` (falls back to the latest unflagged `posters` if no day has a usable `dau`) |
| `poster-ratio` | `formatPct(100 × posters / dau, 1)` for the latest day where both are usable |
| `dau-share` | `formatPct(100 × dau / users, 2)` for the latest day with a usable `dau` |
| `index-posts`, `index-likes`, `index-follows` | `formatCompact(snapshot.total_*)` |
| `dau-peak`, `dau-peak-date` | All-time high usable `dau` (compact) and `formatDay` of its date (earliest date on ties) |
| `posters-peak`, `posters-peak-date` | Same for `posters` |
| `velocity-peak`, `velocity-peak-date` | Highest `new_users` (signed compact) and its date, with ` (est.)` appended when that day's velocity is estimated |

"Usable" means a finite number whose key is not in that row's `flags`.

### Blocks

`<!-- prerender:KEY -->…<!-- /prerender:KEY -->`: the inner HTML is replaced; the markers stay, and the
new lines take the indentation of the opening marker.

Both blocks are rendered with the builders `script.js` exports (`buildSeries`, `computeTickerItems` +
`buildTickerHTML`, `buildMilestoneRowsHTML`), the same functions the page calls after load, so the static
markup is exactly what the browser would paint. If `script.js` cannot be loaded in Node, the blocks are
left untouched and reported as `missing`.

- `milestones`: the `<tr>` rows of the milestones table. Columns: Date · Total users · New/day (7D avg) ·
  DAU · Posters · Context. Rows: 2023-03-01 activity data begins, 2023-05-01 collection start,
  2024-02-06 open registration, 2024-08-30 Brazil X ban wave, 2024-11-18 post-election peak, 2025-01-01,
  2026-01-01 (milestone rows marked `highlight-row` where notable), and the latest day (`current-row`).
- `ticker`: one `<li class="tick">` per metric (USERS, VEL/DAY 7D, DAU, POSTERS, POSTS, LIKES, FOLLOWS,
  BLOCKS) with the latest value and the week-over-week change of the 7-day average.

### JSON-LD

`<script type="application/ld+json" id="jsonld">` gets `buildJsonLd(data)`: a `@graph` with a
`WebApplication`, a `FAQPage` and a `Dataset` (`temporalCoverage` first day/last day, `dateModified`,
`distribution.contentUrl` = `https://obsesivegamer.github.io/Bluesky-User-Trends/data/bluesky-daily.csv`).
The FAQ entries are read from the page's own visible FAQ (`<details class="faq-…">` with a `<summary>`)
**after** the inline values are filled in, so the structured data always matches what readers see.
`<` is escaped as `\u003c` so the JSON can never close its script element.

The visible FAQ numbers are `data-prerender` spans, which `script.js` repaints from the data file after
load. If `index.html` and the data file come from different builds (a data rebuild without a pre-render,
or a cached page next to a newer data file), the static JSON-LD would disagree with the painted text, so
`script.js` copies the painted FAQ back into the JSON-LD (`syncFaqJsonLd`). Crawlers that don't run
JavaScript see the static pair; crawlers that do see the painted pair; both always match.

### Cache-bust and sitemap

- `<script src="data/bluesky-data.js?v=STAMP">`: STAMP becomes `generated_at` as `YYYYMMDDHHmm`.
- `sitemap.xml` `<lastmod>` becomes `last_complete_day` (`updateSitemap`).

### API

```js
const { prerenderIndex, computePrerenderValues, buildJsonLd, updateSitemap } = require('./lib/prerender.js');
prerenderIndex(html, data)   // → { html, replaced: [...keys], missing: [...keys], invalid: [...], unknown: [...] }
computePrerenderValues(data) // → { 'last-day': 'Oct 7, 2026', … }
buildJsonLd(data)            // → JSON-LD object
updateSitemap(xml, data)     // → xml
```

All are pure and idempotent: running them twice gives the same output, and they never throw on missing
keys (the result lists them). `missing` covers every inline key plus `milestones`, `ticker`, `data-stamp`
and `jsonld`.

The CLI re-renders from the committed data without fetching anything:

```bash
node lib/prerender.js            # writes index.html and sitemap.xml
node lib/prerender.js --dry-run  # report only; exit 1 if a key is missing or invalid
node lib/prerender.js --data other.js --index /tmp/index.html --sitemap /tmp/sitemap.xml
```

## Schedule and failure handling

- `count-accounts.yml` runs at 02:37 UTC: `scripts/count-accounts.js` lists every account on each
  Bluesky-operated host (hosts from the relay's `listHosts`, plus the previous complete run's host list),
  one request in flight per host, backing off when `RateLimit-Remaining` runs low. It appends a row to
  `data/accounts-daily.json`; a run where any host failed is saved with `complete: false`, kept out of net
  growth, and fails the job. It shares the `update-data` concurrency group, and the 03:17 update publishes
  the row as `own_count` in `data/bluesky-data.js` (`{source, rows, net}`; `net` is the change between
  consecutive complete runs scaled to 24h).
- The Action runs at 03:17 and 15:17 UTC. jazco's previous UTC day is about 99.9% final by 02:30 UTC; the
  second run adds user-count samples and picks up late revisions. GitHub may start scheduled runs late.
- The checkout is the branch head (`ref: ${{ github.ref }}`), not the triggering commit, so a run that
  waited behind another starts from that run's data commit.
- `updateData.js` exits non-zero and writes nothing if jazco fails or returns no usable rows. A failed bot
  feed is only a warning.
- `npm test` runs after the update, on the code and the freshly built data. A failing test stops the run
  before the commit, and because the update runs first, a bad committed file can never block the next run
  from replacing it.
- Known outages (`KNOWN_OUTAGES` in `lib/jazco.js`) record the broken value each was confirmed on; a day
  Jaz later repairs (a value more than 5% higher) is no longer flagged.
- The commit step does nothing if no file changed. Otherwise it commits, rebases onto the remote branch
  and pushes, retrying once. A conflicting concurrent change fails the run instead of overwriting; the
  next run rebuilds everything from scratch.
- `concurrency: update-data` (no cancel) keeps two runs from racing each other.

## Verification

- `npm test` runs every `test/*.test.js` file with `node:test`. The tests never touch the real files or
  network (the updater takes `DATA_DIR`, `INDEX_FILE`, `SITEMAP_FILE`, `NOW` and an injectable `fetch`).
- `scripts/verify-dashboard.py` drives the real page in Chromium: `doctor`, `smoke`, `ranges`, `compare`,
  `toggles`, `waves`, `exports`, `guide`, `keyboard`, `live`, `all`. It serves the repo on a free port
  (or uses `--url`), intercepts the Bluesky feed so `live` can force LIVE, ARCHIVE, failure, garbage and
  timeout states, and compares the painted numbers with `computePrerenderValues`. Screenshots go to
  `artifacts/verify/` (gitignored).
