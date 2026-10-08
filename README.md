# Bluesky User Trends

**Live: https://obsesivegamer.github.io/Bluesky-User-Trends/**

Bluesky Network Pulse is a Bloomberg-terminal-style dashboard for Bluesky. It shows how many accounts
Bluesky has, how fast that number grows each day (**user velocity**), how many accounts are active each
day (**daily active users**, a lower bound) and how many of them post (**daily posters**). The daily
history goes back to November 2022 for users and March 2023 for activity. It covers everything on
[Jaz's stats page](https://bsky.jazco.dev/stats) plus the history and derived metrics that page doesn't
keep.

It's a static site: plain HTML, CSS and JavaScript, no build step, no tracking. A GitHub Action refreshes
the data twice a day and commits it.

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
  the 2024 gaps between known counts.
- **Charts:** [Chart.js](https://www.chartjs.org/) 4.5.1, [chartjs-plugin-zoom](https://github.com/chartjs/chartjs-plugin-zoom)
  2.0.1 and [Hammer.js](https://hammerjs.github.io/) 2.0.8. Fonts: IBM Plex Sans and JetBrains Mono.

The code is MIT licensed (see [LICENSE](LICENSE)). The data in `data/` is derived from the sources above
and stays under their terms; the values from Wikimedia Commons are CC BY 4.0, so credit the people listed
above if you reuse them. [data/README.md](data/README.md) lists which columns come from where, what was
changed and the license notices.

## How it works

```
GitHub Action (03:17 and 15:17 UTC)
  npm test → node updateData.js → commit data/, index.html, sitemap.xml → GitHub Pages
Browser
  index.html (numbers already filled in) → lib/format.js → data/bluesky-data.js → script.js
```

Jaz's API only allows its own site to read it from a browser, so the archive is built by the Action
and committed. The updater also writes the latest numbers, milestones, ticker and structured data into
`index.html`, so search engines and readers without JavaScript see current values, and the page paints
the same strings after it loads. Besides the files in this repo, the browser loads Chart.js, Hammer.js
and the zoom plugin from jsDelivr, fonts from Google Fonts, and the newest hourly user count from
public.api.bsky.app (if that fails the page stays in **ARCHIVE** mode). Each of those hosts sees the
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
`keyboard`, `live`, `all`. `--url` points any of them at another copy of the site, `--headed` shows the
browser and `--json FILE` saves the results. The Bluesky feed is always intercepted, so `live` can force
the LIVE, ARCHIVE, failure and timeout states. If Playwright's own Chromium build is missing, the harness
uses the installed Google Chrome. Screenshots land in `artifacts/verify/`.

## Deploy your own copy

1. Fork the repo.
2. **Settings → Pages**: deploy from the `main` branch, `/ (root)`.
3. Open the **Actions** tab and enable workflows (a fork starts with them, and their schedules,
   disabled). Then run **Update Bluesky Data** once; after that it runs on its schedule. The workflow
   asks for `contents: write` so it can commit; if your account or organisation limits the token to
   read-only, allow write access under **Settings → Actions → General → Workflow permissions**.
4. Change the site and repository URLs: `SITE_URL`, `REPO_URL` and the `creator` in `lib/prerender.js`,
   `SITE_URL` in `script.js`, every `obsesivegamer` URL in `index.html` (canonical, Open Graph,
   Twitter, footer, the CSV "sources and terms" link), `robots.txt`, `sitemap.xml`, and `homepage` and
   `repository` in `package.json`. Change the contact URL in the User-Agent of `updateData.js`,
   `scripts/backfill-users.js` and `scripts/sample-plc-rates.js`. The tests and
   `scripts/verify-dashboard.py` read these values from the code, so they need no edits.
   `og-image.png` has the URL drawn into it; replace the image or leave it.
5. Search engines don't read a `robots.txt` that sits under a project path such as
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
