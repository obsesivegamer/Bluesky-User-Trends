# Bluesky User Trends

**Live: https://obsesivegamer.github.io/Bluesky-User-Trends/**

Bluesky Network Pulse is a Bloomberg-terminal-style dashboard for Bluesky. It shows how many accounts
Bluesky has, how fast that number grows each day (**user velocity**), how many accounts are active each
day (**daily active users**, a lower bound) and how many of them post (**daily posters**). The daily
history goes back to November 2022 for users and March 2023 for activity. It covers everything on
[Jaz's stats page](https://bsky.jazco.dev/stats) plus the history and derived metrics that page doesn't
keep.

It also has daily leaderboards for accounts with 10K+ followers (most blocked, fastest growing, most
followed, gainers and losers, most controversial), the most-liked posts of the day and a decentralization
meter.

It's a static site: plain HTML, CSS and JavaScript, no build step, no tracking. GitHub Actions refresh
the data and commit it: the main data twice a day, the social data twice a day (see below).

## What's on the page

- **Ticker tape** with the latest users, velocity, DAU, posters, posts, likes, follows and blocks, each
  with the week-over-week change of its 7-day average (pause button; static when reduced motion is on).
- **KPI cards**: total users (with a live hourly count when the browser can get one), user velocity,
  daily active users, daily posters and poster ratio, each with a trend for the selected range and a
  sparkline.
- **Index totals**: posts, likes and follows recorded in Jaz's index since 2023-03-01.
- **Charts** (Ctrl + scroll or pinch to zoom, drag to pan, arrow keys step through days on a focused
  chart, PNG and CSV export of the visible window):
  - `USR` user velocity: new accounts per day with a 7-day average, or daily growth %. Estimated days are
    drawn differently. Chips jump to the big migration waves.
  - `DAU` daily active users and posters, with outages shown as gaps.
  - `ACT` firehose actors: likers, posters, followers, blockers (each series can be toggled).
  - `REC` daily records: likes, posts, follows, blocks.
  - `RAT` ratios: poster ratio, DAU share, posts per poster, likes per liker.
  - `TOT` total users.
- **Command bar**: ranges `1W 1M 3M 6M YTD 1Y 2Y ALL` (default 1Y), 7-day moving average, log scale and
  a prior-period comparison (the same number of calendar days just before the range, drawn as a dashed
  line). Keys: `1`–`8` ranges, `M` average, `L` log, `C` compare, `?` guide. The state is kept in the
  URL, e.g. `#r=1Y&ma=1&log=0&cmp=0`, so a view can be shared.
- **Leaderboards `LDR`**: top 25 accounts for each board, with followers, posts, posts this month, last
  post, account age and PDS host. **Top posts `PST`**: the most-liked posts of the newest complete UTC
  day, or the newest partial day until one exists. **Decentralization `DEC`**: the share of active
  accounts on servers Bluesky does not run. See "Leaderboards and social data" below.
- **Data table** of the last 30 days in the range, a link to the full CSV, milestones, FAQ, definitions,
  sources and a guide dialog that explains every control.

## Metric definitions

- **Total users**: Jaz's `total_users`, accounts on Bluesky-operated PDS hosts counted with
  `com.atproto.sync.listRepos`. The counter adds each account that is active when it first lists it and
  never subtracts later deletions or deactivations, so it is closer to cumulative sign-ups than to
  active accounts. Accounts on self-hosted or third-party PDS hosts are not included. It matches
  Bluesky's own year-end figures (25.94M at the start of 2025, 41.41M at the end). Each day's value is
  the count at the **end** of that UTC day: from July 2024 the count at 00:00 UTC the next day, read or
  interpolated from timestamped readings; before that, Wikimedia Commons once-a-day readings, which have
  no documented time of day and are treated as end of day.
- **Active accounts (own count)**: our own daily count of every account on the same Bluesky-operated
  hosts (`scripts/count-accounts.js`, run by `.github/workflows/count-accounts.yml` at 02:37 UTC). It
  pages through `com.atproto.sync.listRepos` on every host (about 48k requests over ~90 hosts, well under
  each host's 3,000-per-5-minutes limit) and counts accounts by status. Deactivated, taken-down and deleted
  accounts are left out, so it runs well below the headline total (2026-10-08: 41.72M active vs 46.91M —
  3.24M taken down, mostly spam; 0.47M deactivated; ~1.5M deleted and no longer listed), and its day-to-day change is
  **net** growth. It does not depend on Jaz. History starts on 2026-10-08; rows live in
  `data/accounts-daily.json`. The headline stays on Jaz's count because it matches Bluesky's announced
  figures.
- **User velocity**: new accounts per UTC day as counted by Jaz, `users[d] − users[d−1]`, shown with a
  7-day average. Because deletions are never subtracted, it measures sign-ups rather than net growth.
  Growth % is `new_users / users[d−1]`. "Velocity growth" is the change in the 7-day average velocity,
  for example against the prior week or prior period.
- **Daily active users (DAU, lower bound)**: distinct accounts that created at least one like, post,
  follow or block that UTC day, as seen on the public firehose by Jaz's indexer. Computed as the largest
  of the four per-action distinct counts, so it is a lower bound: Jaz's index counts likes, posts,
  follows and blocks only, so people who only read or repost are not counted. For scale, Similarweb estimated about 3M mobile DAU in July 2026 (TechCrunch,
  2026-08-11). Bots and bridged accounts are not excluded. The counts are statistical estimates (about
  ±1%), recent days can still rise slightly, and today's partial day is never shown.
- **Daily posters**: distinct accounts that published at least one post (replies and quotes included)
  that UTC day.
- **Ratios**: poster ratio = posters / DAU; DAU share = DAU / total users; posts per poster; likes per
  liker.
- **Index totals**: total posts, likes and follows are sums of Jaz's daily counts since 2023-03-01, not
  network-wide all-time totals.

### Gaps, outages and estimates

- Known collection outages are flagged per metric and drawn as gaps; they are left out of averages,
  changes, peaks, comparisons and ratios: 2024-08-31 → 2024-09-07, 2024-09-10, 2024-10-23 (likes),
  2025-04-22, 2025-05-20 (likes), 2026-04-13 → 15. Block data is missing 2025-09-19 → 2025-12-19.
  Partial days were confirmed against Kuba Suder's independent firehose counts
  ([blue.mackuba.eu/stats](https://blue.mackuba.eu/stats)); the table in `lib/jazco.js` records the
  broken value of each, and stops flagging a day if Jaz later repairs it.
- Activity counts before 2023-05-01 are reconstructed by Jaz's indexer and undercounted; blockers are
  flagged on most of those days.
- Daily user counts are **estimated** (interpolated, or shaped by PLC directory creation rates) where no
  reading exists within 3 hours of midnight UTC. Mainly: July → mid-November 2024, when the archives are
  sparse; the jazco counter outages in March 2025 (rows 2025-03-14 → 24) and April 2026 (2026-04-13 →
  24); the stale counter of late February 2026 (2026-02-23 → 27); plus some days in late 2022 and early
  2023 (gaps in the Commons series) and short stretches (1–6 days) where the hourly feed has gaps. Every such row has
  `users_est: true` and its source in `users_src`, and the page draws it hatched or dashed. Because a row
  holds the count at the *end* of its day, a counter outage that starts at midnight shows up on the row
  dated the day before.

## Leaderboards and social data

These panels use a different pipeline from the charts above: the public Jetstream replay, the Bluesky
AppView, Constellation and the PLC directory, collected by `.github/workflows/collect-social.yml`.

### What each board means

- **Most blocked** (`24H`, `7D`): blocks an account **received** in the window, counted from the
  `app.bsky.graph.block` create events on Jetstream. `ALL` is the all-time count from Constellation, which
  has only **recorded since early 2025** and was backfilled partly for older records, so it is a floor,
  not the true total.
- **Fastest growing** (`24H`, `7D`): follows received in the window (`app.bsky.graph.follow` creates).
- **Most followed**: all-time follower count from the AppView (`followersCount`, exact at build time).
- **Gainers and losers** (`24H`, `7D`): the **net** change in AppView `followersCount` between two of our
  daily snapshots, so unfollows are included.
- **Most controversial** (`24H`, `7D`): blocks received ÷ follows received in the window, for accounts with
  at least 100 blocks in the window. Accounts that received no follows are skipped (the ratio is
  undefined). Each day file lists only the top 3,000 accounts by follows, and its counts can be short by
  the day's recorded error (see "Known limits"). The follows used are therefore a ceiling: a listed
  account gets its stored count plus the error, an account missing from the list gets that day's cut
  value (the smallest count in the list) plus the error. Whenever the ceiling is above the stored count
  the ratio is a lower bound, rounded down and shown as "≥ ratio" with "≤ N follows". A day file written
  before errors were recorded has an unknown ceiling, so a window that includes one shows no ratios.
- **Top posts of the day**: posts created on the newest complete UTC day, or the newest partial day until
  one exists, ranked by exact `likeCount` (AppView `getPosts`). Candidates come from sampled like and repost windows of the Jetstream (24 windows
  of 150 s a day; the 1,000 most-liked posts of the samples are looked up), so a post that was never in a
  sampled window can be missed. The data file holds up to 25 posts and the page shows the top 10. A post
  with no text shows `[image]`, `[video]`, `[quote]` or `[link]` instead, according to its embed.

**Gross vs net.** Jetstream delete events carry no subject, so an unfollow or unblock cannot be tied back
to the account it affected. Blocks and follows received are therefore **gross**: they never go down. Only
the gainers and losers boards are net.

Every listed account shows avatar, display name, handle (linked to `bsky.app`), followers, total posts,
posts this month (UTC calendar month), last post, account age (`createdAt`) and PDS host. Hosts are read
from the account's DID document at plc.directory (`did:web` from its own DID document URL) and cached.
**Posts this month** counts the account's own posts, replies included and reposts excluded (the same
definition as the post total on its profile), read from its author feed (`posts_with_replies`, newest
first) back to the start of the month. Reposts never use up the page cap: counting stops after 10 pages
of 100 items that held own posts (30 pages in all) with the month boundary still ahead, and the count is
then shown with a `+` as a lower bound. **Last post** is the newest own post found.

### Guardrails

Enforced in `scripts/build-social.js` and `lib/social.js`, and checked again in the page:

- An account is named only if it has **at least 10,000 followers**, a resolving profile with a valid handle,
  and **no label whose value starts with `!`** (that covers the `!no-unauthenticated` opt-out, `!hide`,
  `!takedown` and `!warn`). Label values are normalized before they are compared (Unicode NFKC, so a
  fullwidth `！hide` becomes `!hide`; control and zero-width characters dropped; trimmed; lowercase), so a
  padded or recased label cannot slip past. Ineligible accounts still count toward the totals but are
  never listed.
- Top posts need an eligible author and no `!` label on the post, its record or the author. Posts or
  authors with an adult or graphic label (`porn`, `sexual`, `nudity`, `graphic-media`, `gore`, compared
  after the same normalization) are skipped. Post text is shortened to 280 characters.
- Avatars are shown only from `https://cdn.bsky.app` (the page checks the URL, with no credentials or
  port); anything else shows a blank placeholder.
- The build refuses to write `data/social.js` if any listed account or post breaks these rules, and the
  page applies the rules again when it renders.
- **Privacy: the raw state is never committed.** The Jetstream day files (the top 3,000 accounts by
  follows and blocks per day, by DID), the 12,000-long sidecars, the account pool (handles of everyone
  who came near a board) and the follower history include accounts far below the 10K line, so they would
  defeat the guardrail in a public repo. They live in `.state/social/` (git-ignored; `STATE_DIR`
  overrides it) and travel between runs in the GitHub Actions cache, as a tar encrypted with the
  `STATE_KEY` repository secret (`openssl enc -aes-256-cbc -pbkdf2`). The encryption matters: a pull
  request from a fork can read the caches of the base repository, and forks do not receive secrets. Only `data/social.js`, already filtered to eligible accounts and validated, is committed.

### Sources

- [Jetstream](https://github.com/bluesky-social/jetstream), the public JSON firehose that Bluesky runs. The
  collector replays history (about 36 hours are kept) from `jetstream1/2.us-east/us-west.bsky.network`
  and buckets events by the time the network saw them (UTC). A dropped connection is retried on the same
  instance; after three fruitless tries it fails over to the next one (rewinding the cursor 10 seconds
  and dropping commits it already counted).
- Bluesky AppView (`public.api.bsky.app`): profiles, post counts, like counts, labels, author feeds.
- [Constellation](https://constellation.microcosm.blue) by [microcosm.blue](https://microcosm.blue): all-time
  block counts per account, at most 400 requests per build (retries count). It has indexed since
  2025-01-28, with older records only partly backfilled.
- PLC directory ([plc.directory](https://plc.directory)): each account's PDS host and, when the AppView
  lacks it, its creation date.

### Schedule

`collect-social.yml` runs at **03:00 and 09:00 UTC**. The 03:00 run collects yesterday in full, which
Jetstream's roughly 36-hour replay allows with hours to spare; the 09:00 run is a free retry, because the
collector only fills time the day file does not cover yet. After each collection the same job rebuilds
`data/social.js`, runs the tests and commits `data/social.js`, the only file it commits. The raw state
(`.state/`) is restored from the Actions cache before collecting and saved to it right after the build,
as `.state-cache/state.tar.enc`, encrypted with the `STATE_KEY` secret, under a new key per run
(`social-state-enc-<run id>`, restored by prefix). The job fails up front when `STATE_KEY` is empty, and
a state that cannot be decrypted (a rotated key) is dropped with a warning and the run starts empty. GitHub evicts a cache that has not
been used for 7 days; the daily runs keep it warm, and losing it only shortens the 7-day and gainers and
losers history (the builder starts again from the next day files; with no day files at all it warns, keeps
the existing `data/social.js` and exits 0 rather than publish an empty board). The job has its own
concurrency group (`collect-social`), so the other workflows can't delay or replace it; it commits only
a file they never touch. If collection or the build fails, whatever was collected is still saved to the
cache and the run is marked failed.

The collector never hangs a run. It retries a dropped connection on the same instance with backoff, then
fails over to the next of the four instances (10 s cursor rewind, repeated commits dropped), and gives up
after 12 failed connections in a row; the rest of that window is recorded as a gap in the day file, and
the next run fills it while Jetstream still has the data. It always ends the process: exit 0 even after
giving up, exit 1 only on a real error such as an unreadable file. While a day is incomplete, a
`<date>.partial.json` file next to its day file keeps longer top lists (top 12,000 follows, 12,000 blocks
and 6,000 posts, with error bounds) so a later run can merge into them without losing accounts that sit
near the day file's cut of 3,000. It is kept in the Actions cache because each Action run is a fresh
checkout, and deleted as soon as the day is complete; the day file keeps the error bounds (`errors`).

### First run and warm-up

- The 24-hour boards use the newest **complete** day (at least 99% of its seconds covered). Until the
  first one exists the page uses the newest partial day and says so.
- **Gainers and losers** need two snapshots: the 24-hour board needs one taken 20 to 36 hours earlier,
  the 7-day board one taken 6 to 8 days earlier. Until then they stay empty.
- The **7-day** blocks, growth and controversial boards sum the day files available, so they cover fewer
  than 7 days for the first week (the file records how many in `coverage.days_7d`).
- The first run with an empty Actions cache starts with no history at all: one day file, no follower
  snapshots, no pool. The boards fill in as the days accumulate, as above.
- Day files older than the newest 35 are deleted, with their partial sidecars. Jetstream cannot replay
  more than about 36 hours, so a day that was missed cannot be recovered later.

### Decentralization meter

The share of **active accounts that live on hosts Bluesky does not run**:

`non-Bluesky active ÷ (active on Bluesky-operated hosts + active on non-Bluesky hosts)`

It comes from our own `listRepos` count (`scripts/count-accounts.js`). A second pass in that script counts
every other PDS host the relay lists as active or idle, beside the Bluesky pass and inside a 25-minute
budget. **Bridgy Fed** (`atproto.brid.gy`) accounts are bridged from other networks, so they are split out
from independent PDS hosts. Hostnames that list exactly the same set of accounts (compared by a hash of
the DID set) are counted once. Each row of `data/accounts-daily.json` records the result as
`third_party`; the page uses the newest complete row that has one. Hosts that did not answer in time are
missing from the count, and a host with more than 1,000,000 active accounts is counted only up to that
cap (`hosts_capped`), so when any host failed (`hosts_failed` above 0) or was capped the share is a
**lower bound**. Failed third-party hosts never make the Bluesky row incomplete. Host names come from the
network, so the pass only fetches plain public DNS names, resolves them through a lookup that refuses
private and local addresses on every connection (a name that later points inside our network is
refused), and follows no redirects. The Bluesky row is saved before the third-party result is attached.

## Data sources and credits

- **Activity and user counts:** [Jaz's Bluesky index](https://bsky.jazco.dev/stats) by
  [@jaz.bsky.social](https://bsky.app/profile/jaz.bsky.social), code at
  [jazware/bsky-experiments](https://github.com/jazware/bsky-experiments). Read twice a day from
  `bsky-search.jazco.io/stats`, with a User-Agent that links back here.
- **User history 2022-11 → 2024-07:** Wikimedia Commons
  ["Bluesky Registered Users.svg"](https://commons.wikimedia.org/wiki/File:Bluesky_Registered_Users.svg)
  by VintageNebula, with data gathered by Jaz and Martin Kleppmann et al.
  ([arXiv:2402.03239](https://arxiv.org/abs/2402.03239)), licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changed here: values assigned to UTC day
  boundaries, the series' own interpolated dates re-interpolated, and merged with the sources below.
- **Hourly user counts:** [@hourlybskyusers.bsky.social](https://bsky.app/profile/hourlybskyusers.bsky.social)
  by [@jordan.weatherby.io](https://bsky.app/profile/jordan.weatherby.io), read through the public
  Bluesky AppView.
- **Wayback Machine** captures of Jaz's stats API.
- **Gap fills:** [Krekeny/bluesky-stats](https://github.com/Krekeny/bluesky-stats) (MIT License,
  Copyright (c) 2025 Krekeny) and [elaval/bskyusers](https://github.com/elaval/bskyusers).
- **PLC directory** ([plc.directory](https://plc.directory)) account-creation rates, used only to shape
  the 2024 gaps between known counts, and account PDS hosts for the leaderboards.
- **Leaderboards:** Bluesky's [Jetstream](https://github.com/bluesky-social/jetstream) and AppView, and
  [Constellation](https://constellation.microcosm.blue) by [microcosm.blue](https://microcosm.blue) for
  all-time block counts.
- **Charts:** [Chart.js](https://www.chartjs.org/) 4.5.1, [chartjs-plugin-zoom](https://github.com/chartjs/chartjs-plugin-zoom)
  2.0.1 and [Hammer.js](https://hammerjs.github.io/) 2.0.8. Fonts: IBM Plex Sans and JetBrains Mono.

The code is MIT licensed (see [LICENSE](LICENSE)). The data in `data/` is derived from the sources above
and stays under their terms; the values from Wikimedia Commons are CC BY 4.0, so credit the people listed
above if you reuse them. [data/README.md](data/README.md) lists which columns come from where, what was
changed and the license notices.

## How it works

```
GitHub Action (03:17 and 15:17 UTC)
  node updateData.js → npm test → commit data/, index.html, sitemap.xml → GitHub Pages
GitHub Action (02:37 UTC)
  node scripts/count-accounts.js → commit data/accounts-daily.json
GitHub Action (03:00 and 09:00 UTC)
  node scripts/collect-social.js → node scripts/build-social.js → npm test → commit data/social.js (state in the Actions cache)
Browser
  index.html (numbers already filled in) → lib/format.js → data/bluesky-data.js, data/social.js → script.js
```

Jaz's API only allows its own site to read it from a browser, so the archive is built by the Action
and committed. The updater also writes the latest numbers, milestones, ticker and structured data into
`index.html`, so search engines and readers without JavaScript see current values, and the page paints
the same strings after it loads. Besides the files in this repo, the browser loads Chart.js, Hammer.js
and the zoom plugin from jsDelivr, fonts from Google Fonts, and the newest hourly user count from
public.api.bsky.app (if that fails the page stays in **ARCHIVE** mode) and, for the leaderboards,
profile pictures from cdn.bsky.app. `data/social.js` is optional: if
it is missing or invalid, the leaderboard panels show their "collecting" state and the rest of the page
works. Each of those hosts sees the
visitor's IP address; there are no analytics or cookies.

Details, the data file format and the pre-render contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it locally

You need Node 22 or newer for the scripts and tests, and any static file server for the page.

```bash
git clone https://github.com/obsesivegamer/Bluesky-User-Trends.git
cd Bluesky-User-Trends
npm run serve          # python3 -m http.server 8000 → http://localhost:8000
```

Opening `index.html` straight from disk also works.

### Test

```bash
npm test               # node:test, every test/*.test.js; no network, never touches the real files
```

### Update the data

```bash
npm run update         # node updateData.js: fetch, rebuild data/, pre-render index.html and sitemap.xml
npm run prerender      # re-render index.html and sitemap.xml from the committed data only (no network)
```

### Collect the social data

```bash
node scripts/collect-social.js     # yesterday (UTC), minus what .state/social/days/<date>.json already covers
node scripts/build-social.js       # data/social.js, .state/social/pool.json, .state/social/followers-history.json
node scripts/count-accounts.js     # own account count + third-party hosts → data/accounts-daily.json (~8 to 35 min)
```

`collect-social.js` takes `--date YYYY-MM-DD`, `--from`/`--to` (ISO times within that day), `--samples N`,
`--sample-seconds S` and `--force` (ignore the existing day file). A full day takes at least about 12
minutes to replay and can only reach back about 36 hours. `collect-social.js` also reads `JETSTREAM_HOSTS`
(comma list of instances). `build-social.js` calls the live AppView, Constellation and PLC directory and
takes several minutes; it fails, writing nothing, if any profile or post batch still fails after a retry.
`DATA_DIR` (default `data/`) is where `social.js` goes, `STATE_DIR` (default `.state/social`, git-ignored)
holds the raw state; point both somewhere else for a trial run. `count-accounts.js` also reads
`SKIP_THIRD_PARTY=1` (Bluesky hosts only) and `ONLY_THIRD_PARTY=1` (only the third-party pass, merged into
the newest row), plus `THIRD_PARTY_BUDGET_MIN` (default 25). All three send a User-Agent that links back
here.

### Rebuild the user history

```bash
npm run backfill       # node scripts/backfill-users.js → data/users-samples.json (cache in .cache/)
node scripts/sample-plc-rates.js   # resumable; refreshes data/sources/plc-rate-samples.json
```

The full users series can be rebuilt from the two committed files alone. Neither script touches the
page data: run `npm run update` afterwards to rebuild `data/` and re-render `index.html` from them.

### End-to-end check in a browser

`scripts/verify-dashboard.py` drives the page in Chromium with Playwright. Use any Python that has
Playwright; a virtual environment avoids the "externally managed environment" error of Homebrew and
recent Debian/Ubuntu Pythons (`.venv/` is gitignored):

```bash
python3 -m venv .venv && .venv/bin/pip install playwright && .venv/bin/python -m playwright install chromium
.venv/bin/python scripts/verify-dashboard.py all        # serves the repo on a free port
.venv/bin/python scripts/verify-dashboard.py smoke --url https://obsesivegamer.github.io/Bluesky-User-Trends/
```

Subcommands: `doctor`, `smoke`, `ranges`, `compare`, `toggles`, `waves`, `exports`, `guide`,
`keyboard`, `live`, `social`, `all`. `--url` points any of them at another copy of the site, `--headed` shows the
browser and `--json FILE` saves the results. The Bluesky feed is always intercepted, so `live` can force
the LIVE, ARCHIVE, failure and timeout states. If Playwright's own Chromium build is missing, the harness
uses the installed Google Chrome. Screenshots land in `artifacts/verify/`.

## Deploy your own copy

1. Fork the repo.
2. **Settings → Pages**: deploy from the `main` branch, `/ (root)`.
3. Open the **Actions** tab and enable workflows (a fork starts with them, and their schedules,
   disabled). Then run **Update Bluesky Data** once; after that it runs on its schedule. Run **Count
   Bluesky Accounts** (the decentralization meter needs it) and **Collect Bluesky Social Data** (the
   leaderboards) once too; the leaderboards fill in over the first days (see "First run and warm-up"). The workflow
   asks for `contents: write` so it can commit; if your account or organisation limits the token to
   read-only, allow write access under **Settings → Actions → General → Workflow permissions**.
4. **Settings → Secrets and variables → Actions → New repository secret**: add `STATE_KEY`, a random
   string (for example `openssl rand -base64 48`). **Collect Bluesky Social Data** encrypts its cached state
   with it and fails before collecting if it is missing. Keep the value; losing or changing it only costs
   the stored history.
5. Change the site and repository URLs: `SITE_URL`, `REPO_URL` and the `creator` in `lib/prerender.js`,
   `SITE_URL` in `script.js`, every `obsesivegamer` URL in `index.html` (canonical, Open Graph,
   Twitter, footer, the CSV "sources and terms" link), `robots.txt`, `sitemap.xml`, and `homepage` and
   `repository` in `package.json`. Change the contact URL in the User-Agent of `updateData.js`,
   `scripts/backfill-users.js` and `scripts/sample-plc-rates.js`. The tests and
   `scripts/verify-dashboard.py` read these values from the code, so they need no edits.
   `og-image.png` has the URL drawn into it; replace the image or leave it.
6. Search engines don't read a `robots.txt` that sits under a project path such as
   `/Bluesky-User-Trends/robots.txt` (only `/robots.txt` at the host root counts), so its `Sitemap:`
   line is informational. Submit `sitemap.xml` in Google Search Console or Bing Webmaster Tools if you
   want it crawled from the sitemap.

## Known limitations

- DAU is a lower bound: readers and repost-only accounts are not counted, and it is the largest of the
  four per-action counts rather than a true union of them (Jaz's API doesn't publish one).
- Total users never goes down: Jaz's counter does not subtract deleted or deactivated accounts, so it
  overstates how many accounts exist today and velocity counts sign-ups, not net growth.
- Total users counts Bluesky-hosted PDS accounts only. Accounts on other PDS hosts are missing, so the
  number is a little below "everyone on the AT Protocol network".
- User counts are estimated on some days (see above). Velocity on those days is an estimate too.
- Jaz's activity counts are approximate (about ±1%), recent days can still change slightly, and outage
  days are gaps rather than corrected values.
- Everything depends on Jaz's index and a few hobby archives. If they stop, the page keeps the archive
  but stops growing.
- GitHub can delay scheduled Actions, so a refresh can land later than 03:17 or 15:17 UTC.
- Blocks and follows received on the leaderboards are gross: Jetstream deletes carry no subject, so
  unblocks and unfollows are not subtracted. Only gainers and losers are net.
- All-time blocks come from Constellation, which has recorded since early 2025 and was backfilled only in
  part, so they are a floor.
- Each day file keeps the top 3,000 accounts per list. While a day is incomplete the partial sidecar keeps
  12,000, so merging runs rarely loses anything, but an account within the sidecar's error bound of the cut
  can still be undercounted (and more so if the sidecar is lost). The day file keeps that error bound
  (`errors`) after the sidecar is gone, and the controversial ratio uses it: the follows are a ceiling
  (stored count or cut, plus the error), so the ratio is only a lower bound (`follows_below_cut`) whenever
  that ceiling is above what was stored. Day files from before the error was recorded are treated as
  unknown, which keeps their accounts off the controversial boards instead of guessing.
- The raw social state lives in the GitHub Actions cache, encrypted with the `STATE_KEY` secret (rotating
  the key discards the history, once). GitHub evicts a cache unused for 7 days; losing it
  shortens the 7-day and gainers and losers history and nothing else, and an empty state never overwrites a
  published `data/social.js`.
- Top posts are chosen from sampled like and repost windows, so a post that got its likes between samples
  can be missed. Their like counts are exact.
- Jetstream replays about 36 hours. A day that was not collected in that time stays missing, and the 24-hour
  boards fall back to the newest partial day until a complete one exists.
- Posts this month counts own posts (replies included, reposts excluded) and stops after 10 pages of 100
  that held own posts, about 1,000 own posts, or 30 pages in all; the count is then a lower bound, shown
  with a `+`. Accounts whose handle does not resolve, under 10K followers, or that carry a `!` label are
  never named.
- The decentralization meter counts only third-party hosts the relay lists and that answered in time, and
  a host is counted only up to 1,000,000 active accounts, so it is a lower bound when any failed or was
  capped, and it counts accounts that are active on their host, not people.
