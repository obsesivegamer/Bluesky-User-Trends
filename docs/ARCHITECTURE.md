# Architecture

Bluesky Network Pulse is a static page on GitHub Pages. Nothing runs on a server: a scheduled GitHub
Action fetches the public data, rebuilds one committed data file, pre-renders the latest numbers into
`index.html`, and commits. The browser reads the committed file. The only request the browser makes to
a third party for data is an optional, best-effort read of the newest hourly user count from the
public Bluesky AppView.

Two more scheduled Actions feed the page: `count-accounts.yml` (own account count, including third-party
PDS hosts for the decentralization meter) and `collect-social.yml` (Jetstream replay → leaderboards and
top posts). Each commits its own files; the browser reads them like the main archive.

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

### Social data (leaderboards and top posts)

```
          GitHub Action "Collect Bluesky Social Data"  (cron 0 3,9 * * *  +  manual)
          ──────────────────────────────────────────────────────────────────────────
 Jetstream replay ──► node scripts/collect-social.js          (lib/jetstream.js)
   wss://jetstream{1,2}.us-{east,west}.bsky.network/subscribe?cursor=…
   follow+block creates, all day  → counts per subject DID        ┐
   like+repost creates, 24×150 s  → counts per post URI (sample)  ├─► .state/social/days/YYYY-MM-DD.json   (contract A)
                                                                  ┘   + YYYY-MM-DD.partial.json while the day is incomplete
 day files ──┐
 AppView   ──┼─► node scripts/build-social.js                (lib/social.js)
 Constellation ┤    pool of candidate DIDs → getProfiles → guardrails → boards,
 PLC directory ┘    follower snapshot → gainers/losers, getPosts → top posts
                      ├─► data/social.js                          (contract B, window.BLUESKY_SOCIAL)
                      ├─► .state/social/pool.json                 (account pool + caches)
                      └─► .state/social/followers-history.json    (daily follower snapshots)
                    npm test → git add data/social.js → commit → push
                    (the builder reads only the day files, never the .partial.json sidecars)

 .state/ is git-ignored and carried between runs by actions/cache as .state-cache/state.tar.enc, encrypted
 with the STATE_KEY secret (decrypt after restoring, before collecting; encrypt, then save, after the build). PRIVACY: the day files, pool and snapshots name accounts under 10K followers
 by DID; the page names only eligible ones, so only the filtered data/social.js goes into the public repo.

 Browser ── data/social.js (optional, no cache-bust; missing or invalid → "Collecting") → script.js → LDR, PST
            data/bluesky-data.js own_count.rows[].third_party                          → script.js → DEC
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
| `lib/accounts.js` | Pure helpers for the own account count: tally statuses, choose hosts, merge runs, net change, plus the third-party pass's hostname and IP checks and its summary (alias dedupe). |
| `scripts/count-accounts.js` | Daily `listRepos` count of every account on Bluesky-operated hosts → `data/accounts-daily.json`. A second pass counts third-party PDS hosts (guarded DNS, 25-minute budget) and attaches `third_party` to the row (see "Third-party count"). |
| `lib/jetstream.js` | Pure logic for the Jetstream collector: window choice within replay retention, coverage/gap accounting, follow/block and like/repost tallies, host failover (cursor rewind and commit dedupe), day-file building, merging (`foldPiece` with the partial sidecar) and pruning. No I/O. |
| `scripts/collect-social.js` | Replays Jetstream for one UTC day (or the part of it still missing) and writes `.state/social/days/<date>.json` (and, while the day is incomplete, `<date>.partial.json`). Retries, fails over, and always exits. |
| `lib/social.js` | Pure logic for the boards: day selection, account pool, guardrail eligibility (label normalization), ranking, controversial bounds, follower-snapshot deltas, top-post filtering, posts-this-month scan, validation of the published payload. No I/O. |
| `scripts/build-social.js` | Builds `data/social.js`, `.state/social/pool.json` and `.state/social/followers-history.json` from the day files, the AppView, Constellation and the PLC directory. Writes nothing if validation fails or any profile or post batch fails; with no day files it warns, keeps the existing `data/social.js` and exits 0. Env: `DATA_DIR`, `STATE_DIR`. |
| `scripts/backfill-users.js` | One-time, re-runnable builder of `data/users-samples.json` from all historical sources (cache in `.cache/`, gitignored). |
| `scripts/sample-plc-rates.js` | Samples Bluesky-hosted DID creation rates from plc.directory for 2024-07 → 2024-11. |
| `scripts/verify-dashboard.py` | Playwright end-to-end harness (see "Verification"). |
| `data/bluesky-data.js` | The archive the page loads (generated, one row per line). |
| `data/bluesky-daily.csv` | The same rows as CSV; the downloadable dataset. |
| `data/accounts-daily.json` | Own account count, one row per UTC day (active, deactivated, taken down, …). |
| `.state/social/days/` | Jetstream day files (contract A), one per UTC day, newest 35 kept, plus a `<date>.partial.json` sidecar for each day that is not yet complete. Written by the collector. **Not in git** (gitignored, kept in the Actions cache): they name small accounts by DID. |
| `.state/social/pool.json` | Not in git. The account pool: DIDs seen near the top of the day files, with cached handle, followers, PDS host, creation date and all-time block count. Pruned after 60 days unseen under 10K followers, capped at 6,000. |
| `.state/social/followers-history.json` | Not in git. One follower snapshot per UTC date (accounts with 10K+ followers), newest 35. The baseline for gainers and losers. |
| `data/social.js` | The published social payload (contract B): `window.BLUESKY_SOCIAL`. Generated; the page loads it optionally. |
| `data/users-samples.json` | Committed provenance: the user-count readings the series is built from. |
| `data/sources/plc-rate-samples.json` | Committed PLC creation-rate samples used to shape 2024 gaps. |
| `data/README.md` | Sources, credits, changes made and license notices for the data. |
| `.github/workflows/count-accounts.yml` | 02:37 UTC own account count (Bluesky-operated and third-party hosts) → commit `data/accounts-daily.json`. |
| `.github/workflows/collect-social.yml` | 03:00 and 09:00 UTC: restore `.state/` from the Actions cache → collect → build → save the cache → tests → commit `data/social.js` only (same rebase-and-push retry as the update). Own concurrency group `collect-social`. |
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
| `own_count` | `null`, or our own listRepos count: `{source, rows:[{date, finished_at, complete, repos, active, deactivated, takendown, suspended, deleted, other, third_party?}], net:[{date, net_active}]}`. `third_party` is described under "Third-party count". |
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

## Data contract: `.state/social/days/YYYY-MM-DD.json` (contract A)

One file per UTC day (in `STATE_DIR/days/`, default `.state/social/days/`; never committed), written by
`scripts/collect-social.js`, read by `scripts/build-social.js`. Several runs
over different parts of a day merge into the same file (overlapping coverage, or a like/repost window
sampled twice, is refused, never double counted).

```json
{"schema":1,"date":"2026-10-08",
 "window":{"start":"2026-10-08T00:00:00Z","end":"2026-10-09T00:00:00Z","covered_seconds":86400,"gaps":[["…","…"]]},
 "complete":true,
 "totals":{"follows":2600000,"blocks":540000,"likes_sampled":830000,"reposts_sampled":90000,"sample_seconds":3600},
 "follows_top":[["did:plc:…",1234]],
 "blocks_top":[["did:plc:…",987]],
 "post_candidates":[["at://did/app.bsky.feed.post/rkey",12,3]],
 "sample_windows":[["2026-10-08T00:30:00Z","2026-10-08T00:32:30Z"]],
 "errors":{"follows":0,"blocks":0,"posts":0}}
```

| Field | Meaning |
|---|---|
| `window` | `start`/`end` of the part of the day this file covers, `covered_seconds` = window minus `gaps` (a silence of more than 2 minutes between events counts as a gap) |
| `complete` | `covered_seconds ≥ 99%` of 86,400 |
| `totals.follows`, `totals.blocks` | Create events counted over the covered time (all subjects, not just the top lists) |
| `totals.likes_sampled`, `reposts_sampled`, `sample_seconds` | What the sampled like/repost windows saw, and how many seconds they really covered |
| `follows_top`, `blocks_top` | `[subject DID, count]`, up to 3,000 each, descending (ties by DID). Gross: delete events carry no subject. |
| `post_candidates` | `[post URI, likes in sample, reposts in sample]`, up to 1,000, ranked by likes. Only a candidate list; the exact counts come from the AppView at build time. |
| `sample_windows` | `[start, end]` of each like/repost window already counted (24 of 150 s a day, scaled to the length of the piece collected). A later run skips candidate windows that overlap one, and merging refuses overlaps. A window that did not run to its end, or that had a silence (a gap) inside it, contributes nothing and is not listed, so its slot is sampled again: `collect-social.js` also takes the day's missing slots of the full 24-window schedule when follows and blocks are already fully covered (samples only, no follow/block replay). Day files written before this field existed are treated as the fixed schedule their `sample_seconds` imply. |
| `errors` | `{follows, blocks, posts}`: the most a true count can exceed what the file's list shows, from the cuts of the long lists in the sidecar. Written on every fold and **kept after the sidecar is deleted**. The builder adds `errors.follows` to a listed account's follows and to the cut of an unlisted one to bound the controversial ratio. Absent in files written before this field: unknown (not 0), and a file whose errors are unknown is folded without claiming any, so it stays unknown. |

Events are bucketed by Jetstream `time_us` (when the network saw them), UTC. The newest 35 files are kept.

### Partial sidecar: `.state/social/days/YYYY-MM-DD.partial.json`

Merging two pieces of a day by summing their top-3,000 lists can reorder accounts near the cut: an account
just under the cut in one piece loses its count. So while a day is incomplete (`complete: false`), the
collector also writes a sidecar with longer lists, and cuts the day file's lists from the merged long ones
(`foldPiece` in `lib/jetstream.js`):

```json
{"schema":1,"date":"2026-10-08","covered_seconds":43200,"totals":{"…":0},
 "follows":{"list":[["did:plc:…",12]],"error":3},
 "blocks":{"list":[["did:plc:…",9]],"error":1},
 "posts":{"list":[["at://…",12,3]],"error":2}}
```

- `follows` and `blocks` keep the top 12,000 subjects and `posts` the top 6,000 candidates. Measured
  2026-10-09, one half day has roughly 600k distinct followed accounts, far too many to keep; 12,000 /
  12,000 / 6,000 keeps the file near a megabyte.
- Stored counts are lower bounds. `error` is the most any subject's true count can exceed its stored count:
  it grows by the largest dropped count every time a list is cut. The day file only lists the top 3,000,
  so this matters only for accounts within `error` of that cut. The day file copies the error as `errors`
  (the error before the latest cut, which is what its own counts can be short by).
- It is kept in the Actions cache, encrypted (never in git: it names small accounts) because the 03:00 and 09:00
  runs are separate checkouts, and deleted as soon as the day becomes complete (and pruned with its day
  file, or when no day file remains).
- It is trusted only if it describes exactly the day file on disk (same date, `covered_seconds` and
  `totals`); otherwise the next run falls back to the day file's own lists, with `error` set to the count
  at their cut plus the `errors` the day file already carries.
- `scripts/build-social.js` never reads it.

## Data contract: `data/social.js` (contract B)

A classic script, like the main archive:

```js
// generated by scripts/build-social.js — do not edit
window.BLUESKY_SOCIAL = {"schema":1, ...};
```

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `generated_at` | ISO time of the build |
| `day` | The UTC day the 24h boards and top posts describe: the newest complete day file, else the newest partial one |
| `coverage` | `{days_7d, complete_24h, first_day}`: how many day files the 7d window sums (1 to 7, the files dated within the 7 days ending at `day`), whether `day` is complete, and the oldest day file on disk |
| `guardrails` | `{min_followers: 10000, excluded_labels, adult_labels}`, stated on the page |
| `accounts` | Map DID → `{handle, display_name, avatar, followers, follows, posts, posts_this_month, posts_this_month_capped, last_posted, created_at, pds, labels}`. Holds exactly the DIDs referenced by a board or a post. `posts_this_month` (own posts this UTC month, replies included, reposts excluded) is `null` if the feed scan failed, `posts_this_month_capped` is true when the scan stopped, with the month boundary still ahead, after 10 pages of 100 feed items that held own posts or 30 pages in all (so `posts_this_month` is then a lower bound), `last_posted`/`created_at`/`pds` can be `null`, `labels` is the list of label values on the profile, in normalized form (see "Guardrails"). |
| `boards` | Twelve arrays of at most 25 rows each, eligible accounts only, ranked: `blocked_24h`, `blocked_7d`, `blocked_all`, `growing_24h`, `growing_7d`, `followed`, `gainers_24h`, `losers_24h`, `gainers_7d`, `losers_7d`, `controversial_24h`, `controversial_7d`. A row is `{did, value}`. Empty when the data does not exist yet (gainers and losers need a baseline snapshot). |
| `boards.controversial_*` rows | `{did, value, blocks, follows, follows_below_cut?}`. `value` = blocks ÷ follows, 2 decimals; only accounts with 100+ blocks in the window, and accounts with no follows at all are skipped (the ratio is undefined). `follows_below_cut: true` (omitted otherwise) means the stored follow count may be short: the account was missing from a day's top-3,000 follow list, or that day's `errors.follows` is above 0. `follows` is then an upper bound: per day, a listed account's stored count plus `errors.follows`, an unlisted account's cut (the smallest count of a full-length list; 0 for a list shorter than 3,000) plus `errors.follows`. `value` is a lower bound, rounded **down** so it never shows above the bound. A day file without `errors` (written before they were recorded) has an unknown bound, so an account in a window that includes one is left off. Rows rank by `value`, then by the unrounded ratio. |
| `top_posts` | At most 25, by `likes` descending: `{uri, url, author, text, created_at, likes, reposts, quotes, replies, embed?, labels?}`. `text` is at most 280 characters and is `""` when the post has none; `embed` (`image`, `video`, `quote` or `link`, from the AppView embed view; a quote with media reports the media) appears only when the post has one, and the page shows `[image]`, `[video]`, `[quote]` or `[link]` for a post with no text; `labels` (normalized post label values, record self-labels included) appears only when the post has any (never `!` or adult ones: those posts are dropped). The page shows the top 10. |
| `totals` | `{follows_24h, blocks_24h}`: all follows and blocks counted on `day` |

Board semantics: `blocked_*` and `growing_*` are gross counts of blocks and follows received (the 7d sums
the day files in `coverage.days_7d`); `blocked_all` is Constellation's total (recorded since early 2025,
partial); `followed` is `followersCount`; `gainers_*`/`losers_*` are the net change of `followersCount`
since a baseline snapshot (`24h`: one taken 20 to 36 hours earlier, closest to 24 h; `7d`: 6 to 8 days
earlier, closest to 7 d), only accounts present in that snapshot.

### Guardrails

An account may appear in `accounts` only if `followers ≥ 10000`, its handle is valid (not `*.invalid`), and
it has no label value starting with `!`. Label values are compared in one canonical form (`normalizeLabel`,
mirrored in `script.js`): Unicode NFKC (a fullwidth `！` becomes `!`), control and zero-width characters
dropped, trimmed, lowercase; so `' !HIDE'` and `'Porn'` still match. A top post also needs: author
eligible, no `!` or adult label (`porn`, `sexual`, `nudity`, `graphic-media`, `gore`) on the post, its
record's self-labels or the author, a `createdAt` inside `day`, and a first-indexed time no earlier than one
hour before `day` (a backdated post keeps its old `indexedAt`). `validateSocial` in `lib/social.js`
re-checks all of this, plus shape, ordering, duplicates, `embed` and `follows_below_cut` values and that
every referenced DID has an account; the builder throws before writing anything if it finds a problem.
`script.js` applies the same rules again when rendering. Avatars are enforced in the page only: it loads an
`avatar` URL only if it is `https://cdn.bsky.app/…` without credentials or a port, and otherwise draws a
blank placeholder.

Privacy follows from the same rule: the page names only eligible accounts, so nothing that lists others may
sit in the public repository. The day files (top 3,000 follows and blocks per day by DID), their 12,000-long
sidecars, `pool.json` (handles of everyone near a board) and `followers-history.json` therefore live in the
git-ignored `.state/` and in the encrypted Actions cache, never in a commit. Only `data/social.js`, which the builder
has already filtered and validated, is committed.

### Build details (`scripts/build-social.js`)

- Candidate pool: the top 500 accounts of the follow and block lists of each day file in the 7d window, the
  top 500 of the 7d sums, and every account with 100+ blocks in a window; merged into `pool.json`, then
  pruned.
- `getProfiles` (25 per call) resolves the pool. The HTTP client paces requests per host (AppView about
  8 a second, Constellation about 2, PLC about 16), retries 429, 5xx and network errors with backoff
  (honouring `ratelimit-reset` / `retry-after`) and gives up at once on other 4xx. A profile or `getPosts`
  batch that still fails is retried once after a pause; if any batch fails again the build throws and
  writes nothing, because a hole in the candidates could name the wrong leader. Failures of the per-account
  metadata calls (PDS host, creation date, author feed) are not fatal: those fields are `null` and the
  build warns.
- Followers are snapshotted once per UTC date (the first run of the day wins, so a rerun never moves the
  baseline) for every resolved account with 10K+ followers.
- All-time blocks: Constellation `links/count` for the top 150 eligible accounts by 7d blocks and the top 100
  by followers, each refreshed at most every 20 hours. The budget of 400 requests per run counts HTTP
  attempts, retries included (a retry is only allowed while budget is left), and the loop stops after 5
  failures in a row (cached values are kept).
- Top posts: `getPosts` on all 1,000 candidates of the day file (25 per call); posts not created on `day`
  are dropped, the profiles of authors outside the pool are fetched, then the guardrails above apply.
- Displayed accounts get their PDS host from the DID document (cached in `pool.json`; `did:web` from its
  own document URL), their creation date from the profile or the PLC audit log, and posts-this-month /
  last-posted from `getAuthorFeed` (`filter=posts_with_replies`, 100 per page). The scan counts the
  account's own posts (replies included, reposts excluded, the definition of Bluesky's own `postsCount`) of
  the current UTC month and stops at the first item that entered the feed before the month began (once an
  own post has been seen, for `last_posted`). Reposts never use up the page cap: the count is capped only
  after 10 pages that held own posts, or 30 pages in all, with the month boundary still ahead.

### `.state/social/pool.json` and `.state/social/followers-history.json`

```json
{"schema":1,"updated_at":"ISO","accounts":{"did:plc:…":{"last_seen":"2026-10-08","handle":"…","followers":123456,
  "created_at":"ISO","pds":"https://…","blocks_all":{"total":11079,"at":"ISO"}}}}

{"schema":1,"snapshots":[{"at":"ISO","followers":{"did:plc:…":123456}}]}
```

Both are caches and state, not published API, and like the day files they stay out of git (the pool holds
handles of everyone who came near a board): the pool lets the next build skip PLC and Constellation calls,
and the snapshots are the only record of past follower counts, so losing `followers-history.json` restarts
gainers and losers from nothing.

## Third-party count (`third_party` on `own_count.rows`)

`scripts/count-accounts.js` runs a second pass beside the Bluesky one: every host the relay lists as
`active` or `idle` that is not Bluesky-operated is paged through `listRepos` and tallied. The result is
added to that day's row of `data/accounts-daily.json` and passed through `lib/build.js` into
`own_count.rows[].third_party`:

```json
"third_party":{"hosts":240,"hosts_ok":236,"hosts_failed":4,"repos":210000,"active":190000,"bridgy_active":150000,"hosts_capped":1}
```

| Field | Meaning |
|---|---|
| `hosts` | Hosts attempted, aliases included |
| `hosts_ok`, `hosts_failed` | Hosts that finished, and hosts that failed or ran out of time (`hosts_ok + hosts_failed = hosts`). A failed host contributes nothing. |
| `repos`, `active` | Accounts and active accounts across the hosts that finished. Several hostnames that list an identical set of accounts (a hash of the DID set) count once. |
| `bridgy_active` | Active accounts on `atproto.brid.gy` (Bridgy Fed, bridged from other networks) |
| `hosts_capped` | Optional: the number of finished hosts that hit the per-host limit of 1,000,000 active accounts and were counted only up to it. Omitted when none did. |

`lib/build.js` (`validateDataset`) validates `third_party` on every `own_count` row (non-negative integers, `hosts_ok +
hosts_failed = hosts`, `bridgy_active ≤ active ≤ repos`, `hosts_capped ≤ hosts_ok`), so a malformed value
fails the data update instead of reaching the page.

`complete` on the row keeps meaning "every Bluesky-operated host finished"; third-party failures never make
a row incomplete or fail the job (only `ONLY_THIRD_PARTY=1`, whose whole job is the third-party count,
exits non-zero if it fails). How the pass runs:

- It starts beside the Bluesky pass, in its own pool (24 hosts at a time, `THIRD_PARTY_CONCURRENCY`). Relay
  discovery, DNS, retry sleeps and requests all live inside one 25-minute budget (`THIRD_PARTY_BUDGET_MIN`)
  that aborts everything in flight; hosts not reached count as failed.
- Hostnames come from the network, so only plain public DNS names are fetched (no IP literals, ports,
  paths or local-only suffixes). Every connection resolves through a guarded lookup that refuses any
  non-public address and hands back exactly the addresses it checked, so a name that rebinds to a private
  address after a check is refused at connect time (an SSRF guard). Redirects are not followed, responses
  are capped at 8 MiB, a host gets 20 s per request, 3 attempts and at most 2,000 pages.
- Only well-formed, not-yet-seen DIDs are counted. A host adds at most 1,000,000 active accounts (so one
  untrusted host cannot inflate the published total) and is then reported in `hosts_capped`.
- Aliases are detected by a SHA-256 of each finished host's full DID set; a host whose set equals an
  earlier one adds nothing (`atproto.brid.gy` sorts first, so it is always the one that is kept).
- The Bluesky row is written to disk as soon as the Bluesky pass ends, and the third-party count is
  attached in a second atomic write; a failed third-party pass leaves the row without `third_party`. A
  good same-day `third_party` survives a replacement run that has none, and a fresh one survives an
  incomplete rerun (`mergeRuns`).
- `SKIP_THIRD_PARTY=1` skips the pass; `ONLY_THIRD_PARTY=1` runs only the pass and attaches it to the newest row.

The page's decentralization meter uses the newest `complete` row that has `third_party`:
`third_party.active ÷ (active + third_party.active)`, with Bridgy split out of the third-party part; if
`hosts_failed > 0` or `hosts_capped > 0` it says the share is a lower bound.

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
- `collect-social.yml` runs at 03:00 and 09:00 UTC: `scripts/collect-social.js` → `scripts/build-social.js`
  → `npm test` → commit `data/social.js` (job timeout 120 minutes, above the 60 + 25 minute step budgets
  plus setup, tests and push). The raw state (`.state/`: day files, sidecars, pool, snapshots) is restored
  with `actions/cache/restore` (path `.state-cache`, key `social-state-enc-<run id>`, restore-keys
  `social-state-enc-`) before collecting and saved with `actions/cache/save` right after the build
  (`if: !cancelled()`), so a failed test or push still keeps the collected pieces. It is a cache, not git,
  for privacy: the files name accounts below the 10K line by DID and the repository is public. A cache is
  not private by itself, since a pull request from a fork can restore the base repository's caches and
  print them, so the cache path holds only `.state-cache/state.tar.enc`: a tar of `.state` encrypted with
  the `STATE_KEY` repository secret (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`; forks do not
  receive secrets). The plaintext tar is built in `RUNNER_TEMP` and removed, never in the cache path. The
  first step fails the job when `STATE_KEY` is empty (a fork), so nothing is collected or saved. After the
  restore a decrypt step untars the archive; if decryption fails (rotated key, corrupt entry) it warns
  and the run starts with an empty state, which the builder tolerates by keeping the published
  `data/social.js`. The save step is skipped when the key check failed.
  GitHub evicts a cache entry not used for 7 days; the daily runs keep it warm, and losing it only
  shortens the 7d and gainers and losers history (an empty state makes the builder warn, keep the existing
  `data/social.js` and exit 0). The first run on an empty cache starts from scratch. The 03:00 run collects
  yesterday in full: Jetstream keeps about 36 hours of replay, so the start of yesterday is ~27 hours back
  and there are ~9 hours of slack (`lib/jetstream.js` keeps a 2-hour margin). The 09:00 run is a free retry,
  since the collector only fills time the day file does not cover. The workflow has its own concurrency group
  (`collect-social`): GitHub keeps one pending run per group, so sharing `update-data` would let the 03:17
  update replace a collection queued behind a long 02:37 count. It commits only `data/social.js`,
  which the other workflows never touch, so concurrent pushes rebase cleanly. The commit runs only
  when the tests passed. The collect and build steps use `continue-on-error`: a failure of either still lets
  the cache save, the tests and the commit run (partial day files are saved piece by piece), and a final step then fails the
  job so the problem is visible. The commit follows the same rebase-and-push retry as the update.
- Collector connection policy (`replay` in `scripts/collect-social.js`, `lib/jetstream.js`): one connection
  for the follow/block pass and one at a time for the like/repost windows. A connection that delivers
  nothing for 30 s, errors or closes is retried on the same instance with the same cursor after a backoff
  (1 s doubling to 30 s). After 3 fruitless attempts in a row on one instance it moves to the next of
  `jetstream2.us-east`, `jetstream1.us-east`, `jetstream2.us-west`, `jetstream1.us-west`. Instances stamp
  `time_us` on their own clocks, so the follow/block cursor is rewound by 10 s and commits already counted
  are dropped by key (`did|collection|rkey|rev`, remembered for 60 s of event time); a like/repost window
  restarts from its own start instead. Any connection that delivers an event resets the counters; 12
  fruitless connections in a row make the collector give up on that window. The rest of the window is then
  recorded as a gap in the day file (a sample window that did not run to its end, or that had a silence
  inside it, is dropped and sampled again by a later run), and the process still ends with exit 0 (it exits explicitly, since a socket stuck
  closing would otherwise keep the Action alive; non-zero only on a real error such as an unreadable
  file). The run stays green and the next run fills the gap while the data is still in Jetstream's
  retention (at 09:00 the start of yesterday is 33 h back, inside the 34 h the collector allows).
- The builder exits non-zero and writes nothing if a profile or `getPosts` batch still fails after its retry,
  or validation fails; the previous `data/social.js` stays (as it does when there are no day files at all).
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
  network (the updater takes `DATA_DIR`, `INDEX_FILE`, `SITEMAP_FILE`, `NOW` and an injectable `fetch`; the social scripts take `DATA_DIR` and `STATE_DIR`, which the tests point at temp directories).
- `scripts/verify-dashboard.py` drives the real page in Chromium: `doctor`, `smoke`, `ranges`, `compare`,
  `toggles`, `waves`, `exports`, `guide`, `keyboard`, `live`, `social`, `all`. It serves the repo on a free port
  (or uses `--url`), intercepts the Bluesky feed so `live` can force LIVE, ARCHIVE, failure, garbage and
  timeout states, and compares the painted numbers with `computePrerenderValues`. Screenshots go to
  `artifacts/verify/` (gitignored).
- The `social` subcommand drives the LDR, PST and DEC panels with the fictional payload from
  `test/fixtures/social-fixture.js` (served in place of `data/social.js`): every board, window and
  direction against an independent re-derivation of the eligible, ranked handles from the raw payload;
  keyboard use of the pills; guide and FAQ text; a hostile variant (script tags, bidi characters, bad
  handles, over-long post text) that must render as inert text; a missing and an empty `data/social.js`
  (panels show "Collecting", the rest of the page works); and DEC with a patched `third_party`
  (share, segments, legend, failed-host caveat) and without one. The `lib/jetstream.js` and `lib/social.js`
  logic is covered by `test/jetstream.test.js` and `test/social.test.js`.
