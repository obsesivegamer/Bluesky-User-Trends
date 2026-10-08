#!/usr/bin/env python3
"""End-to-end checks for the Bluesky Network Pulse dashboard (Playwright, Chromium).

Run with any Python that has Playwright installed (on the maintainer's Mac that is
~/Documents/amber-archive/.venv/bin/python), for example:

    python3 -m pip install playwright && python3 -m playwright install chromium
    python3 scripts/verify-dashboard.py all

Without --url the repo root is served on a free 127.0.0.1 port. With --url every subcommand
drives that page instead (e.g. the GitHub Pages site). Screenshots go to artifacts/verify/.
The Bluesky author feed used for the live user count is always intercepted (see `live`), so
results don't depend on the real feed. Chart.js and fonts still load from their CDNs.
"""

from __future__ import annotations

import argparse
import base64
import csv
import functools
import http.server
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:  # doctor can still report this
    sync_playwright = None
    PlaywrightError = Exception

REPO_ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = REPO_ROOT / "artifacts" / "verify"
# The published URL, read from lib/prerender.js so a fork only changes it there.
_SITE = re.search(r"""const SITE_URL = '([^']+)'""", (REPO_ROOT / "lib" / "prerender.js").read_text(encoding="utf-8"))
SITE_URL = _SITE.group(1) if _SITE else "https://obsesivegamer.github.io/Bluesky-User-Trends/"
FEED_GLOB = "**/xrpc/app.bsky.feed.getAuthorFeed*"
RANGES = ["1W", "1M", "3M", "6M", "YTD", "1Y", "2Y", "ALL"]
DEFAULT_RANGE = "1Y"
CSV_HEADER = "date,users,users_estimated,users_source,new_users,dau,posters,likers,followers,blockers,posts,likes,follows,blocks,flags"
PINNED_LIBS = [
    "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js",
    "https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js",
    "https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js",
]

# Selector candidates, most specific first. The first one that matches a visible element wins.
SEL = {
    "range": ['.time-btn[data-range="{r}"]', '[data-range="{r}"]', 'button:text-is("{r}")'],
    "ma": ["#toggle-ma-btn", '[data-toggle="ma"]', 'button:has-text("7D MA")'],
    "log": ["#toggle-log-btn", '[data-toggle="log"]', 'button:text-is("LOG")'],
    "compare": ["#toggle-compare-btn", '[data-toggle="compare"]', 'button:has-text("COMPARE")'],
    "guide_open": ["#open-guide-btn", '[data-action="guide"]', 'button:has-text("GUIDE")'],
    "guide_dialog": ["#guide-dialog", "dialog"],
    "guide_close": ["[data-close-guide]", "#close-guide-btn", 'button[aria-label*="lose"]'],
    "status": ["#data-status", "#status-indicator", "[data-status]"],
    "wave_chip": [".wave-chip[data-wave]", "[data-wave]"],
    "wave_reset": ["#reset-wave-btn", '[data-action="reset-wave"]'],
    "ticker_item": ["#ticker-items .tick", "#ticker-items > li", ".ticker-item"],
    "milestones_rows": ["#milestones-body tr", ".insights-data-table tbody tr"],
    "csv_link": ['a[href$="data/bluesky-daily.csv"]', 'a[href*="bluesky-daily.csv"]'],
    "export_csv": ['.export-csv-btn[data-chart="{chart}"]', '[data-export="csv"][data-chart="{chart}"]'],
    "export_png": ['.export-png-btn[data-chart="{chart}"]', '[data-export="png"][data-chart="{chart}"]'],
}

# Chart roles -> canvas id patterns (matched against id, aria-label and the panel's text).
CHART_HINTS = {
    "USR": [r"^velocityChart$", r"velocity", r"new[-_ ]?users"],
    "DAU": [r"^dauChart$", r"^dau", r"daily[-_ ]?active"],
    "ACT": [r"^actChart$", r"^act", r"actors?"],
    "REC": [r"^recChart$", r"^rec", r"records?"],
    "RAT": [r"^ratChart$", r"^rat", r"ratios?"],
    "TOT": [r"^totChart$", r"^tot", r"total[-_ ]?users"],
}

CHART_INVENTORY_JS = """() => {
  if (!window.Chart) return [];
  return Object.values(Chart.instances).map(ch => {
    const c = ch.canvas;
    const panel = c.closest('section, article, .panel, .chart-panel, .chart-card') || c.parentElement;
    const head = panel ? (panel.querySelector('h2, h3, .panel-title, .chart-title, .fn-key') || {}).textContent || '' : '';
    const ds = ch.data.datasets.map((d, i) => {
      const vals = (d.data || []).map(p => (p && typeof p === 'object') ? p.y : p);
      return {
        label: d.label || '', n: vals.length,
        nonNull: vals.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).length,
        dash: d.borderDash || [], type: d.type || ch.config.type, visible: ch.isDatasetVisible(i),
      };
    });
    const labels = ch.data.labels || [];
    const firstData = (ch.data.datasets[0] || {}).data || [];
    const xOf = p => (p && typeof p === 'object' && 'x' in p) ? p.x : null;
    const toDay = v => v === null || v === undefined ? null :
      (typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : String(v).slice(0, 10));
    const xs = labels.length ? labels : firstData.map(xOf);
    const yScale = ch.options.scales && (ch.options.scales.y || Object.values(ch.options.scales).find(s => s.axis === 'y'));
    const box = c.getBoundingClientRect();
    return {
      id: c.id || '', aria: c.getAttribute('aria-label') || '', head: head.trim().slice(0, 120),
      w: Math.round(box.width), h: Math.round(box.height),
      points: xs.length, first: toDay(xs[0]), last: toDay(xs[xs.length - 1]),
      yType: yScale ? (yScale.type || 'linear') : null, datasets: ds,
    };
  });
}"""


class Results:
    def __init__(self):
        self.rows: list[tuple[str, str, str, str]] = []

    def check(self, suite: str, name: str, ok: bool, detail: str = "") -> bool:
        status = "PASS" if ok else "FAIL"
        self.rows.append((suite, status, name, detail))
        print(f"  [{status}] {name}" + (f" -- {detail}" if detail else ""), flush=True)
        return ok

    def warn(self, suite: str, name: str, detail: str = ""):
        self.rows.append((suite, "WARN", name, detail))
        print(f"  [WARN] {name}" + (f" -- {detail}" if detail else ""), flush=True)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.rows if r[1] == "FAIL")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server:
    def __init__(self, root: Path, port: int):
        self.root, self.port, self.httpd = root, port, None

    def __enter__(self):
        handler = functools.partial(QuietHandler, directory=str(self.root))
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def feed_body(value: int, created_at: datetime) -> str:
    def post(v, ts, i):
        return {"post": {
            "uri": f"at://did:plc:5he4nkza7eqhmirg3azchqy6/app.bsky.feed.post/mock{i}",
            "cid": f"mockcid{i}",
            "author": {"did": "did:plc:5he4nkza7eqhmirg3azchqy6", "handle": "hourlybskyusers.bsky.social"},
            "record": {"$type": "app.bsky.feed.post", "createdAt": iso(ts), "text": f"Total Bluesky users: {v:,}"},
            "indexedAt": iso(ts + timedelta(seconds=1)), "labels": [],
        }}
    items = [post(value - 600 * i, created_at - timedelta(hours=i), i) for i in range(5)]
    return json.dumps({"feed": items, "cursor": "mock"})


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_int(text: str) -> int | None:
    m = re.search(r"-?[\d,]{4,}", text or "")
    return int(m.group(0).replace(",", "")) if m else None


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def squash(text: str) -> str:
    """Whitespace-free form, for comparing innerText (tabs, no spaces between inline spans) with HTML text."""
    return re.sub(r"\s+", "", text or "")


class Dashboard:
    """Owns the server (unless --url), the browser and the expected pre-render values."""

    def __init__(self, args):
        self.args = args
        self.tmp = Path(tempfile.mkdtemp(prefix="verify-dashboard-"))
        self.server = None
        self.pw = self.browser = None

    def __enter__(self):
        if self.args.url:
            self.base = self.args.url if self.args.url.endswith(("/", ".html")) else self.args.url + "/"
        else:
            self.server = Server(REPO_ROOT, self.args.port).__enter__()
            self.base = f"http://127.0.0.1:{self.server.port}/"
        self.pw = sync_playwright().start()
        self.browser = launch_browser(self.pw, self.args)
        self.static_html = self._fetch_text(self.base)
        self.data_url = self._data_url(self.static_html)
        data_path = self.tmp / "bluesky-data.js"
        data_path.write_text(self._fetch_text(self.data_url), encoding="utf-8")
        self.expected = node_expectations(data_path)
        self.data = self.expected["data"]
        return self

    def __exit__(self, *exc):
        if self.browser:
            self.browser.close()
        if self.pw:
            self.pw.stop()
        if self.server:
            self.server.__exit__(*exc)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fetch_text(self, url: str) -> str:
        req = self.pw.request.new_context()
        try:
            resp = req.get(url)
            if not resp.ok:
                raise RuntimeError(f"GET {url} -> HTTP {resp.status}")
            return resp.text()
        finally:
            req.dispose()

    def _data_url(self, html: str) -> str:
        m = re.search(r"""<script[^>]+src=["']((?:\./)?data/bluesky-data\.js[^"']*)["']""", html)
        if not m:
            raise RuntimeError("index.html does not load data/bluesky-data.js")
        return urllib.parse.urljoin(self.base, m.group(1))

    def url(self, hash_: str = "") -> str:
        base = self.base.split("#")[0]
        return base + (("#" + hash_.lstrip("#")) if hash_ else "")

    def new_page(self, feed: str = "stale", width: int = 1440, height: int = 900, reduced_motion: str = "no-preference"):
        ctx = self.browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True,
                                       reduced_motion=reduced_motion, color_scheme="dark")
        page = ctx.new_page()
        page.console_errors = []
        page.on("console", lambda m: m.type == "error" and page.console_errors.append(m.text))
        page.on("pageerror", lambda e: page.console_errors.append(f"pageerror: {e}"))
        page.on("response", lambda r: r.status >= 400 and page.console_errors.append(f"HTTP {r.status} {r.url}"))
        page.feed_requests = []
        snap = self.data.get("snapshot", {})
        snap_users = int(snap.get("total_users") or 0)
        snap_at = datetime.fromisoformat(re.sub(r"(\.\d{6})\d*", r"\1", snap.get("updated_at", "2000-01-01T00:00:00Z")).replace("Z", "+00:00"))
        page.live_value = snap_users + 12345
        # Newer than the snapshot even right after an update run, or the page rightly ignores it.
        page.live_at = max(datetime.now(timezone.utc) - timedelta(minutes=3), snap_at + timedelta(seconds=30))
        page.pending_routes = []

        def handle(route):
            page.feed_requests.append(route.request.url)
            if feed == "stale":
                route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"},
                              body=feed_body(snap_users - 5000, snap_at - timedelta(hours=6)))
            elif feed == "fresh":
                route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"},
                              body=feed_body(page.live_value, page.live_at))
            elif feed == "fail":
                route.abort("failed")
            elif feed == "garbage":
                route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"},
                              body='{"feed":[{"post":{"record":{"text":"hello","createdAt":"nope"}}}]}')
            elif feed == "hang":
                page.pending_routes.append(route)  # never answered: the page's own timeout has to give up
            else:
                route.continue_()

        page.route(FEED_GLOB, handle)
        return page

    @staticmethod
    def close(page):
        for route in getattr(page, "pending_routes", []):
            try:
                route.abort()
            except PlaywrightError:
                pass
        page.context.close()

    def open(self, page, hash_: str = ""):
        page.goto(self.url(hash_), wait_until="load")
        page.wait_for_function("() => window.Chart && Object.keys(Chart.instances).length >= 6", timeout=20000)
        page.wait_for_timeout(400)

    def charts(self, page) -> list[dict]:
        return page.evaluate(CHART_INVENTORY_JS)

    def chart(self, page, role: str) -> dict | None:
        inv = [c for c in self.charts(page) if c["w"] >= 200]
        for pat in CHART_HINTS[role]:
            for c in inv:
                if re.search(pat, c["id"], re.I):
                    return c
        for pat in CHART_HINTS[role]:
            for c in inv:
                if re.search(pat, c["aria"] + " " + c["head"], re.I):
                    return c
        return None

    def first(self, page, key: str, **fmt):
        for sel in SEL[key]:
            loc = page.locator(sel.format(**fmt))
            try:
                n = loc.count()
            except PlaywrightError:
                continue
            for i in range(n):
                if loc.nth(i).is_visible():
                    return loc.nth(i)
        return None

    def shot(self, page, name: str, full_page: bool = False):
        out = Path(self.args.out) if self.args.out else ARTIFACTS
        out.mkdir(parents=True, exist_ok=True)
        path = out / f"{name}.png"
        page.screenshot(path=str(path), full_page=full_page)
        print(f"  screenshot: {path.relative_to(REPO_ROOT) if path.is_relative_to(REPO_ROOT) else path}")
        return path

    def hash_state(self, page) -> dict:
        h = page.evaluate("() => location.hash").lstrip("#")
        return dict(urllib.parse.parse_qsl(h))

    def range_bounds(self, r: str) -> tuple[int, int]:
        last = date.fromisoformat(self.data["last_complete_day"])
        first = date.fromisoformat(self.data["days"][0]["date"])
        total = (last - first).days + 1

        def months_back(n):
            y, m = divmod(last.year * 12 + last.month - 1 - n, 12)
            d = min(last.day, [31, 29 if y % 4 == 0 and (y % 100 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m])
            return (last - date(y, m + 1, d)).days

        if r == "1W":
            return 7, 8
        fixed = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365, "2Y": 730}
        if r in ("1M", "3M", "6M"):
            n = months_back({"1M": 1, "3M": 3, "6M": 6}[r])
            return min(n, fixed[r]), max(n, fixed[r]) + 1
        if r == "YTD":
            n = (last - date(last.year, 1, 1)).days + 1
            return n - 1, n + 1
        if r in ("1Y", "2Y"):
            n = months_back(12 * int(r[0]))
            return min(n, fixed[r]), max(n, fixed[r]) + 1
        return total - 2, total


def launch_browser(pw, args):
    """Playwright's bundled Chromium, or the installed Google Chrome when that build is missing."""
    errors = []
    for opts in ({}, {"channel": "chrome"}):
        try:
            browser = pw.chromium.launch(headless=not args.headed, slow_mo=args.slow_mo, **opts)
            browser.label = "system Chrome (channel=chrome)" if opts else "bundled Chromium"
            return browser
        except PlaywrightError as e:
            errors.append(str(e).splitlines()[0])
    raise RuntimeError("Could not launch Chromium: " + " | ".join(errors) + ". Run: python -m playwright install chromium")


def node_expectations(data_path: Path) -> dict:
    script = r"""
const fs = require('fs');
const pre = require(process.argv[1]);
const data = pre.parseDataFile(fs.readFileSync(process.argv[2], 'utf8'));
const ent = { '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&(#39|quot|lt|gt|amp);/g, (m) => ent[m]).replace(/\s+/g, ' ').trim();
process.stdout.write(JSON.stringify({
  values: pre.computePrerenderValues(data),
  ticker: (pre.renderBlocks(data).ticker || []).map(strip),
  milestones: (pre.renderBlocks(data).milestones || []).map(strip),
  data: { last_complete_day: data.last_complete_day, generated_at: data.generated_at, snapshot: data.snapshot,
          live_source: data.live_source, days: data.days.map((d) => ({ date: d.date, new_users: d.new_users, dau: d.dau })) },
}));
"""
    out = subprocess.run(["node", "-e", script, str(REPO_ROOT / "lib" / "prerender.js"), str(data_path)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def static_prerender_texts(html: str) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for m in re.finditer(r"""<([a-zA-Z][\w-]*)\b[^>]*\bdata-prerender\s*=\s*["']?([\w-]+)["']?[^>]*>([^<]*)</\1\s*>""", html):
        found.setdefault(m.group(2), []).append(norm(m.group(3)))
    return found


def wait_for_values(page, expected: dict, keys: list[str], timeout: int = 8000) -> None:
    try:
        page.wait_for_function(
            """([exp, keys]) => keys.every(k => [...document.querySelectorAll(`[data-prerender="${k}"]`)]
                 .every(el => el.textContent.replace(/\\s+/g, ' ').trim() === exp[k]))""",
            arg=[expected, keys], timeout=timeout)
    except PlaywrightError:
        pass  # the caller reports the mismatches


def dom_prerender_texts(page) -> dict[str, list[str]]:
    return page.evaluate("""() => {
      const out = {};
      for (const el of document.querySelectorAll('[data-prerender]')) {
        (out[el.dataset.prerender] ||= []).push(el.textContent.replace(/\\s+/g, ' ').trim());
      }
      return out;
    }""")


# ---------------------------------------------------------------- subcommands

def cmd_doctor(args, res: Results):
    s = "doctor"
    print("== doctor")
    files = ["index.html", "style.css", "script.js", "favicon.svg", "lib/format.js", "lib/prerender.js",
             "data/bluesky-data.js", "data/bluesky-daily.csv", "sitemap.xml", "robots.txt", "README.md", "LICENSE"]
    for f in files:
        p = REPO_ROOT / f
        res.check(s, f"file {f}", p.exists() and p.stat().st_size > 0, f"{p.stat().st_size:,} bytes" if p.exists() else "missing")

    node = shutil.which("node")
    if res.check(s, "node on PATH", bool(node), node or "install Node >= 22"):
        ver = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
        major = int(re.sub(r"\D", "", ver.split(".")[0]) or 0)
        res.check(s, "node >= 22", major >= 22, ver)
        t = subprocess.run(["npm", "test", "--silent"], cwd=REPO_ROOT, capture_output=True, text=True)
        summary = " ".join(l.strip("ℹ ").strip() for l in t.stdout.splitlines() if re.match(r"^ℹ (tests|pass|fail) ", l))
        res.check(s, "npm test", t.returncode == 0, summary or t.stderr[-300:])
        pr = subprocess.run(["node", "lib/prerender.js", "--dry-run"], cwd=REPO_ROOT, capture_output=True, text=True)
        res.check(s, "pre-render contract (every key present in index.html)", pr.returncode == 0,
                  norm(pr.stderr or pr.stdout)[:400])

    index = REPO_ROOT / "index.html"
    if index.exists():
        html = index.read_text(encoding="utf-8")
        for lib in PINNED_LIBS:
            res.check(s, f"pinned {lib.split('/npm/')[1].split('/')[0]}", lib in html)
        res.check(s, "data script has ?v= cache-bust", bool(re.search(r"data/bluesky-data\.js\?v=", html)))
        head = html.split("</head>")[0]
        res.check(s, "no <a> inside <head>", not re.search(r"<a\b", head, re.I))
        abs_path = re.search(r"""(?:src|href)=["']/(?!/)[^"']*""", html)
        res.check(s, "relative asset URLs only", not abs_path,
                  f"{abs_path.group(0)}: absolute paths break the /Bluesky-User-Trends/ subpath" if abs_path else "")
        site = SITE_URL
        images = {m.group(1) for m in re.finditer(r"""<meta[^>]+(?:property|name)=["'](?:og|twitter):image["'][^>]*content=["']([^"']+)["']""", head)}
        for url in sorted(images):
            local = url.replace(site, "", 1) if url.startswith(site) else None
            exists = local is None or (REPO_ROOT / local).exists()
            res.check(s, f"social image exists: {url.rsplit('/', 1)[-1]}", exists,
                      url if exists else "referenced by og:image/twitter:image but missing from the repo")
        for wf in ("update-data.yml", "test.yml"):
            res.check(s, f"workflow .github/workflows/{wf}", (REPO_ROOT / ".github" / "workflows" / wf).exists())
        for bad, why in (("googletagmanager", "analytics"), ("google-site-verification", "Search Console token"),
                         ('rel="me"', "rel=me"), ("playcraft", "ads")):
            res.check(s, f"no {why}", bad not in html)

    if sync_playwright is None:
        res.check(s, "playwright importable", False, f"{sys.executable} has no playwright; pip install playwright")
        return
    res.check(s, "playwright importable", True, sys.executable)
    try:
        with sync_playwright() as pw:
            b = launch_browser(pw, args)
            res.check(s, "Chromium launches", True, f"{b.label} {b.version}")
            b.close()
    except Exception as e:  # noqa: BLE001
        res.check(s, "Chromium launches", False, str(e)[:300])


def cmd_smoke(args, res: Results, dash: Dashboard):
    s = "smoke"
    print("== smoke")
    exp = dash.expected["values"]
    page = dash.new_page(feed="stale", reduced_motion="reduce")
    dash.open(page)
    wait_for_values(page, exp, list(exp))

    default_btn = dash.first(page, "range", r=DEFAULT_RANGE)
    res.check(s, "default range is 1Y", bool(default_btn) and default_btn.get_attribute("aria-pressed") == "true")

    dom = dom_prerender_texts(page)
    missing = [k for k in exp if k not in dom]
    res.check(s, "every pre-render key is on the page", not missing, f"missing: {missing}" if missing else f"{len(dom)} keys")
    mismatch = {k: (v, exp[k]) for k, vals in dom.items() if k in exp for v in vals if v != exp[k]}
    res.check(s, "JS paints the same strings as the pre-render (default view)", not mismatch,
              "; ".join(f"{k}: page={a!r} expected={b!r}" for k, (a, b) in mismatch.items())[:600])
    empty = [k for k in ("users-total", "velocity-7d", "dau", "posters", "poster-ratio") if not dom.get(k) or not dom[k][0] or dom[k][0] == "—"]
    res.check(s, "KPI values are non-empty", not empty, f"empty: {empty}" if empty else "")

    static = static_prerender_texts(dash.static_html)
    stale = {k: (v, exp[k]) for k, vals in static.items() if k in exp for v in vals if v != exp[k]}
    msg = "; ".join(f"{k}: html={a!r} data={b!r}" for k, (a, b) in list(stale.items())[:6])
    res.check(s, "served index.html is pre-rendered with the served data (no flip after load)", not stale,
              msg + ("" if dash.args.url else " (run: node lib/prerender.js)") if stale else "")

    ticker = []
    for sel in SEL["ticker_item"]:
        if page.locator(sel).count():
            ticker = [squash(t) for t in page.locator(sel).all_text_contents()]
            break
    want = [squash(t) for t in dash.expected["ticker"]]
    ok = len(ticker) >= len(want) and ticker[:len(want)] == want
    res.check(s, "ticker items match the pre-rendered ticker", ok, "" if ok else f"page={ticker[:8]} expected={want}")

    rows = []
    for sel in SEL["milestones_rows"]:
        if page.locator(sel).count():
            rows = [squash(t) for t in page.locator(sel).all_text_contents()]
            break
    want_rows = [squash(r) for r in dash.expected["milestones"]]
    res.check(s, "milestones table matches the pre-render", rows == want_rows,
              "" if rows == want_rows else f"page={rows[:2]}… expected={want_rows[:2]}…")

    head = page.evaluate("""(staticHtml) => {
        const faqOf = (root) => [...root.querySelectorAll('details[class*="faq"]')].map(d => {
          const sum = d.querySelector('summary');
          const q = sum ? [...sum.childNodes].filter(n => !(n.nodeType === 1 && (n.getAttribute('aria-hidden') === 'true' || n.classList.contains('faq-arrow')))).map(n => n.textContent).join(' ') : '';
          return [q, [...d.childNodes].filter(n => n !== sum).map(n => n.textContent).join(' ')];
        });
        return {
          jsonldInHead: !!document.querySelector('head script#jsonld'),
          ogInHead: document.querySelectorAll('head meta[property^="og:"]').length,
          strays: [...document.querySelectorAll('body meta, body link[rel="stylesheet"], body title')].map(e => e.outerHTML.slice(0, 80)),
          canonical: (document.querySelector('head link[rel="canonical"]') || {}).href || '',
          faq: faqOf(new DOMParser().parseFromString(staticHtml, 'text/html')),
          liveFaq: faqOf(document),
          liveLd: (document.querySelector('script#jsonld') || {}).textContent || '',
        };
      }""", dash.static_html)
    res.check(s, "head parsed intact (JSON-LD and og: tags in <head>, nothing pushed into <body>)",
              head["jsonldInHead"] and head["ogInHead"] > 0 and not head["strays"], json.dumps(head["strays"])[:300])
    res.check(s, "canonical URL", head["canonical"] == SITE_URL, head["canonical"])
    m = re.search(r"""<script[^>]*id=["']jsonld["'][^>]*>([\s\S]*?)</script>""", dash.static_html)
    try:
        ld = json.loads(m.group(1)) if m else None
    except json.JSONDecodeError as e:
        ld = None
        res.check(s, "JSON-LD parses", False, str(e))
    if ld is not None:
        graph = {n.get("@type"): n for n in ld.get("@graph", [])}
        res.check(s, "JSON-LD has WebApplication, FAQPage and Dataset", {"WebApplication", "FAQPage", "Dataset"} <= set(graph), str(list(graph)))
        ds = graph.get("Dataset", {})
        res.check(s, "JSON-LD Dataset covers the data", ds.get("temporalCoverage", "").endswith("/" + dash.data["last_complete_day"]),
                  ds.get("temporalCoverage", ""))
        ld_faq = [(squash(q.get("name")), squash(q.get("acceptedAnswer", {}).get("text"))) for q in graph.get("FAQPage", {}).get("mainEntity", [])]
        page_faq = [(squash(q), squash(a)) for q, a in head["faq"]]
        res.check(s, "JSON-LD FAQ matches the visible FAQ in the served HTML", bool(page_faq) and ld_faq == page_faq,
                  f"{len(ld_faq)} JSON-LD vs {len(page_faq)} visible" + ("" if ld_faq == page_faq else f"; first diff: {next(((a, b) for a, b in zip(ld_faq, page_faq) if a != b), None)}"[:400]))
        try:
            live_graph = {n.get("@type"): n for n in json.loads(head["liveLd"]).get("@graph", [])}
        except json.JSONDecodeError:
            live_graph = {}
        live_ld = [(squash(q.get("name")), squash(q.get("acceptedAnswer", {}).get("text"))) for q in live_graph.get("FAQPage", {}).get("mainEntity", [])]
        live_faq = [(squash(q), squash(a)) for q, a in head["liveFaq"]]
        res.check(s, "JSON-LD FAQ matches the visible FAQ after script.js paints", bool(live_faq) and live_ld == live_faq,
                  f"{len(live_ld)} JSON-LD vs {len(live_faq)} visible" + ("" if live_ld == live_faq else f"; first diff: {next(((a, b) for a, b in zip(live_ld, live_faq) if a != b), None)}"[:400]))
    elif not m:
        res.check(s, "JSON-LD script#jsonld present", False)

    inv = dash.charts(page)
    big = [c for c in inv if c["w"] >= 200]
    res.check(s, "at least 6 main charts", len(big) >= 6, ", ".join(f"{c['id'] or '?'}({c['points']})" for c in inv))
    empty_charts = [c["id"] or c["head"] for c in inv if not any(d["nonNull"] > 0 for d in c["datasets"])]
    res.check(s, "every Chart.js chart has data", not empty_charts, f"empty: {empty_charts}" if empty_charts else f"{len(inv)} charts")
    orphan = page.evaluate("""() => [...document.querySelectorAll('canvas')].filter(c => {
        if (c.offsetParent === null) return false;
        if (window.Chart && Chart.getChart(c)) return false;
        const ctx = c.getContext('2d'); if (!ctx || !c.width || !c.height) return true;
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < px.length; i += 4) if (px[i]) return false;
        return true;
      }).map(c => c.id || c.className || 'canvas')""")
    res.check(s, "no blank canvases", not orphan, f"blank: {orphan}" if orphan else "")
    for c in big:
        res.check(s, f"chart {c['id'] or c['head'][:30]} has an aria-label", bool(c["aria"]), c["aria"][:80])

    a11y = page.evaluate("""() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const loud = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (/\\p{Extended_Pictographic}/u.test(n.textContent) && !n.parentElement.closest('[aria-hidden="true"], script, style')) {
            loud.push(n.textContent.trim().slice(0, 40));
          }
        }
        const track = document.querySelector('.ticker-track');
        const unpressed = [...document.querySelectorAll('.time-btn, #toggle-ma-btn, #toggle-log-btn, #toggle-compare-btn, .wave-chip, .series-toggle, .vel-mode-btn, .rat-mode-btn')]
          .filter(b => !['true', 'false'].includes(b.getAttribute('aria-pressed'))).map(b => b.textContent.trim());
        return { loud, tickerAnim: track ? getComputedStyle(track).animationName : 'none', unpressed };
      }""")
    res.check(s, "emoji are hidden from screen readers (aria-hidden)", not a11y["loud"], json.dumps(a11y["loud"][:5], ensure_ascii=False))
    res.check(s, "ticker is static under prefers-reduced-motion", a11y["tickerAnim"] == "none", a11y["tickerAnim"])
    res.check(s, "toggle buttons expose aria-pressed", not a11y["unpressed"], json.dumps(a11y["unpressed"][:5]))

    status = dash.first(page, "status")
    st = norm(status.inner_text()) if status else ""
    res.check(s, "status shows ARCHIVE when the feed has nothing newer", "ARCHIVE" in st.upper(), st or "status element not found")
    res.check(s, "page requested the live feed once", len(page.feed_requests) >= 1, f"{len(page.feed_requests)} request(s)")
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:600])
    dash.shot(page, "smoke-desktop")
    dash.shot(page, "smoke-desktop-full", full_page=True)
    dash.close(page)

    mobile = dash.new_page(feed="stale", width=375, height=812)
    dash.open(mobile)
    sw = mobile.evaluate("() => ({doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth})")
    wide = mobile.evaluate("""() => [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1;
      }).slice(0, 5).map(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''}`)""")
    res.check(s, "no horizontal scroll at 375px", max(sw["doc"], sw["body"]) <= sw["vw"] + 1,
              f"scrollWidth={sw} overflowing={wide}" if max(sw["doc"], sw["body"]) > sw["vw"] + 1 else f"scrollWidth={sw['doc']}")
    res.check(s, "no console errors at 375px", not mobile.console_errors, " | ".join(mobile.console_errors)[:400])
    dash.shot(mobile, "smoke-mobile-375")
    dash.shot(mobile, "smoke-mobile-375-full", full_page=True)
    dash.close(mobile)


def cmd_ranges(args, res: Results, dash: Dashboard):
    s = "ranges"
    print("== ranges")
    page = dash.new_page()
    dash.open(page)
    last = dash.data["last_complete_day"]
    for r in RANGES:
        btn = dash.first(page, "range", r=r)
        if not res.check(s, f"{r} button exists", btn is not None):
            continue
        btn.click()
        page.wait_for_timeout(350)
        pressed = [x for x in RANGES if (b := dash.first(page, "range", r=x)) and b.get_attribute("aria-pressed") == "true"]
        res.check(s, f"{r}: only {r} is aria-pressed", pressed == [r], f"pressed={pressed}")
        res.check(s, f"{r}: URL hash r={r}", dash.hash_state(page).get("r") == r, page.evaluate("() => location.hash"))
        usr = dash.chart(page, "USR")
        if not res.check(s, f"{r}: USR chart found", usr is not None):
            continue
        lo, hi = dash.range_bounds(r)
        res.check(s, f"{r}: USR chart shows {lo}-{hi} days", lo <= usr["points"] <= hi,
                  f"{usr['points']} points {usr['first']} → {usr['last']}")
        res.check(s, f"{r}: window ends on the last complete day", usr["last"] == last, f"last={usr['last']} expected {last}")
        dau = dash.chart(page, "DAU")
        if dau and r != "ALL":
            res.check(s, f"{r}: DAU chart has the same window", dau["first"] == usr["first"] and dau["last"] == usr["last"],
                      f"DAU {dau['first']}→{dau['last']} USR {usr['first']}→{usr['last']}")
        if r == "YTD":
            year = int(last[:4])
            res.check(s, "YTD starts on Jan 1 (or its Dec 31 baseline)", usr["first"] in (f"{year}-01-01", f"{year - 1}-12-31"), usr["first"])
        if r == "ALL":
            res.check(s, "ALL starts at the first day of data", usr["first"] == dash.data["days"][0]["date"], usr["first"])
    dash.shot(page, "ranges-all")

    page.goto(dash.url("r=3M&ma=0&log=0&cmp=0"))
    page.reload(wait_until="load")
    page.wait_for_function("() => window.Chart && Object.keys(Chart.instances).length >= 6", timeout=20000)
    page.wait_for_timeout(400)
    b3 = dash.first(page, "range", r="3M")
    res.check(s, "hash #r=3M restores the range on load", bool(b3) and b3.get_attribute("aria-pressed") == "true")
    if usr := dash.chart(page, "USR"):
        lo, hi = dash.range_bounds("3M")
        res.check(s, "restored 3M window size", lo <= usr["points"] <= hi, str(usr["points"]))
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_compare(args, res: Results, dash: Dashboard):
    s = "compare"
    print("== compare")
    page = dash.new_page()
    dash.open(page)
    btn = dash.first(page, "compare")
    if not res.check(s, "COMPARE button exists", btn is not None):
        dash.close(page)
        return
    res.check(s, "COMPARE starts off", btn.get_attribute("aria-pressed") == "false", btn.get_attribute("aria-pressed") or "")
    before = {c["id"]: len(c["datasets"]) for c in dash.charts(page)}
    btn.click()
    page.wait_for_timeout(500)
    res.check(s, "COMPARE aria-pressed=true", btn.get_attribute("aria-pressed") == "true")
    res.check(s, "URL hash cmp=1", dash.hash_state(page).get("cmp") == "1", page.evaluate("() => location.hash"))
    usr = dash.chart(page, "USR")
    prior = [d for d in (usr or {}).get("datasets", []) if d["dash"] and re.search(r"prior|prev|compare", d["label"], re.I)]
    res.check(s, "USR chart gains a dashed prior-period overlay", bool(prior), json.dumps((usr or {}).get("datasets", []))[:400])
    if prior and usr:
        main = max((d for d in usr["datasets"] if not d["dash"]), key=lambda d: d["n"], default=None)
        res.check(s, "prior period has the same length as the selected window (calendar based)",
                  main is not None and prior[0]["n"] == main["n"], f"prior n={prior[0]['n']} current n={main and main['n']}")
        res.check(s, "prior period has data", prior[0]["nonNull"] > 0, f"{prior[0]['nonNull']} non-null")
    after = {c["id"]: len(c["datasets"]) for c in dash.charts(page)}
    grown = [k for k in after if after[k] > before.get(k, 0)]
    res.check(s, "overlay added to the main charts", len(grown) >= 2, f"charts with more datasets: {grown}")
    cards_text = page.evaluate("() => [...document.querySelectorAll('[class*=comparison], [id*=comparison], [id*=compare], .card-compare')].map(e => e.innerText).join(' | ')")
    res.check(s, "cards show a prior-period comparison line", bool(re.search(r"prev|prior|vs", cards_text, re.I)), norm(cards_text)[:200])
    dash.shot(page, "compare-1y")

    for r in ("1M", "ALL"):
        b = dash.first(page, "range", r=r)
        if b:
            b.click()
            page.wait_for_timeout(400)
            usr = dash.chart(page, "USR")
            prior = [d for d in (usr or {}).get("datasets", []) if d["dash"] and re.search(r"prior|prev|compare", d["label"], re.I)]
            if r == "ALL":
                cmp_on = btn.get_attribute("aria-pressed") == "true"
                res.check(s, "ALL: compare is switched off or explained (no fake prior period)",
                          not prior or not cmp_on, f"compare pressed={cmp_on}, overlay datasets={len(prior)}")
            else:
                res.check(s, f"{r}: overlay follows the range", bool(prior) and prior[0]["n"] >= 28, f"{prior[0]['n'] if prior else 0} points")
    b1y = dash.first(page, "range", r="1Y")
    if b1y:
        b1y.click()
        page.wait_for_timeout(300)
    if btn.get_attribute("aria-pressed") == "true":
        btn.click()
        page.wait_for_timeout(400)
    usr = dash.chart(page, "USR")
    left = [d for d in (usr or {}).get("datasets", []) if d["dash"] and re.search(r"prior|prev|compare", d["label"], re.I) and d["visible"]]
    res.check(s, "turning COMPARE off removes the overlay", not left, f"{len(left)} overlay dataset(s) still visible")
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_toggles(args, res: Results, dash: Dashboard):
    s = "toggles"
    print("== toggles")
    page = dash.new_page()
    dash.open(page)

    def ma_visible():
        out = {}
        for c in dash.charts(page):
            out[c["id"]] = sum(1 for d in c["datasets"] if d["visible"] and re.search(r"\bMA\b|7D|average|avg", d["label"], re.I))
        return out

    ma = dash.first(page, "ma")
    if res.check(s, "7D MA button exists", ma is not None):
        state0 = ma.get_attribute("aria-pressed")
        res.check(s, "7D MA has aria-pressed", state0 in ("true", "false"), str(state0))
        v0 = ma_visible()
        ma.click()
        page.wait_for_timeout(400)
        v1 = ma_visible()
        res.check(s, "7D MA toggles aria-pressed", ma.get_attribute("aria-pressed") != state0)
        res.check(s, "7D MA changes the MA lines", v0 != v1, f"before={v0} after={v1}")
        res.check(s, "URL hash ma follows", dash.hash_state(page).get("ma") == ("1" if ma.get_attribute("aria-pressed") == "true" else "0"),
                  page.evaluate("() => location.hash"))
        ma.click()
        page.wait_for_timeout(300)
        res.check(s, "7D MA toggles back", ma_visible() == v0)

    log = dash.first(page, "log")
    if res.check(s, "LOG button exists", log is not None):
        y0 = {c["id"]: c["yType"] for c in dash.charts(page)}
        log.click()
        page.wait_for_timeout(400)
        y1 = {c["id"]: c["yType"] for c in dash.charts(page)}
        switched = [k for k in y1 if y1[k] == "logarithmic" and y0.get(k) != "logarithmic"]
        res.check(s, "LOG aria-pressed=true", log.get_attribute("aria-pressed") == "true")
        res.check(s, "LOG switches supporting charts to a log axis", len(switched) >= 2, f"switched: {switched}")
        res.check(s, "URL hash log=1", dash.hash_state(page).get("log") == "1")
        dash.shot(page, "toggles-log")
        log.click()
        page.wait_for_timeout(300)
        y2 = {c["id"]: c["yType"] for c in dash.charts(page)}
        res.check(s, "LOG off restores linear axes", y2 == y0, f"{y2}")
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_waves(args, res: Results, dash: Dashboard):
    s = "waves"
    print("== waves")
    page = dash.new_page()
    dash.open(page)
    chips = None
    for sel in SEL["wave_chip"]:
        if page.locator(sel).count():
            chips = page.locator(sel)
            break
    if not res.check(s, "migration-wave chips exist", chips is not None and chips.count() >= 4, f"{chips.count() if chips else 0} chips"):
        dash.close(page)
        return
    texts = [norm(t) for t in chips.all_inner_texts()]
    res.check(s, "chip values computed from data (contain numbers)", all(re.search(r"\d", t) for t in texts), " | ".join(texts))
    before = dash.chart(page, "USR")
    feb = next((i for i, t in enumerate(texts) if re.search(r"feb|open", t, re.I)), 0)
    chip = chips.nth(feb)
    wave_id = chip.get_attribute("data-wave")
    chip.click()
    page.wait_for_timeout(500)
    usr = dash.chart(page, "USR")
    pressed = [chips.nth(i).get_attribute("aria-pressed") for i in range(chips.count())]
    res.check(s, "chip marks itself active (and only itself)", pressed.count("true") == 1 and pressed[feb] == "true", str(pressed))
    res.check(s, "USR chart filtered to the wave window", bool(usr) and 5 <= usr["points"] <= 150,
              f"{usr and usr['points']} points {usr and usr['first']}→{usr and usr['last']}")
    res.check(s, "Feb 2024 chip covers 2024-02-06 (open registration)", bool(usr) and usr["first"] <= "2024-02-06" <= usr["last"],
              f"{usr and usr['first']}→{usr and usr['last']}")
    others = [c for c in ("DAU", "ACT", "REC", "RAT", "TOT") if (o := dash.chart(page, c)) and not (o["first"] == usr["first"] and o["last"] == usr["last"])]
    res.check(s, "every chart follows the wave window", bool(usr) and not others, f"not following: {others}")
    res.check(s, "URL hash records the wave", dash.hash_state(page).get("r") == wave_id, page.evaluate("() => location.hash"))
    reset = dash.first(page, "wave_reset")
    res.check(s, "reset (✕) visible while a wave is active", reset is not None)
    dash.shot(page, "waves-active")

    last_chip = chips.nth(chips.count() - 1)
    last_chip.click()
    page.wait_for_timeout(500)
    u2 = dash.chart(page, "USR")
    res.check(s, "another chip switches the window", bool(u2 and usr) and u2["first"] != usr["first"], f"{u2 and u2['first']}→{u2 and u2['last']}")
    last_chip.click()
    page.wait_for_timeout(500)
    u3 = dash.chart(page, "USR")
    res.check(s, "clicking the active chip again restores the previous range", bool(u3 and before) and u3["points"] == before["points"],
              f"{u3 and u3['points']} vs {before and before['points']}")
    res.check(s, "reset hidden when no wave is active", dash.first(page, "wave_reset") is None)

    chip.click()
    page.wait_for_timeout(400)
    reset = dash.first(page, "wave_reset")
    if res.check(s, "reset (✕) visible again", reset is not None):
        reset.click()
        page.wait_for_timeout(400)
        after = dash.chart(page, "USR")
        res.check(s, "reset restores the previous range", bool(after and before) and after["points"] == before["points"],
                  f"{after and after['points']} vs {before and before['points']}")
        res.check(s, "reset hides the ✕", dash.first(page, "wave_reset") is None)
        b1y = dash.first(page, "range", r=DEFAULT_RANGE)
        res.check(s, "range button state restored after reset", bool(b1y) and b1y.get_attribute("aria-pressed") == "true")
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_exports(args, res: Results, dash: Dashboard):
    s = "exports"
    print("== exports")
    page = dash.new_page()
    dash.open(page)
    usr = dash.chart(page, "USR")
    chart_key = "velocity"
    csv_btn = dash.first(page, "export_csv", chart=chart_key)
    if res.check(s, "USR panel has a CSV export button", csv_btn is not None):
        with page.expect_download() as dl:
            csv_btn.click()
        d = dl.value
        text = Path(d.path()).read_text(encoding="utf-8")
        rows = list(csv.reader(io.StringIO(text)))
        res.check(s, "CSV download has a header row", bool(rows) and "date" in rows[0][0].lower(), f"{d.suggested_filename}: {rows[0] if rows else ''}")
        body = [r for r in rows[1:] if r]
        lo, hi = dash.range_bounds(DEFAULT_RANGE)
        res.check(s, "CSV covers the visible 1Y range", lo <= len(body) <= hi, f"{len(body)} rows {body[0][0] if body else ''}→{body[-1][0] if body else ''}")
        dates = [r[0] for r in body]
        res.check(s, "CSV dates ascending and ISO", dates == sorted(dates) and all(re.match(r"\d{4}-\d{2}-\d{2}$", x) for x in dates))
        res.check(s, "CSV ends on the last complete day", bool(dates) and dates[-1] == dash.data["last_complete_day"], dates[-1] if dates else "")
        res.check(s, "CSV filename names the chart and range", bool(re.search(r"\d{4}-\d{2}-\d{2}.*\.csv$", d.suggested_filename)), d.suggested_filename)
        res.check(s, "USR chart was found for the export", usr is not None)
    png_btn = dash.first(page, "export_png", chart=chart_key)
    if res.check(s, "USR panel has a PNG export button", png_btn is not None):
        with page.expect_download() as dl:
            png_btn.click()
        d = dl.value
        raw = Path(d.path()).read_bytes()
        res.check(s, "PNG signature", raw[:8] == b"\x89PNG\r\n\x1a\n", d.suggested_filename)
        px = page.evaluate("""async (b64) => {
            const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
            const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
            const w = img.width, h = img.height;
            return {w, h, corners: [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)], bg: at(w - 4, 20)};
        }""", base64.b64encode(raw).decode())
        res.check(s, "PNG is opaque with a dark background (not transparent)",
                  all(c[3] == 255 for c in px["corners"]) and px["bg"][3] == 255 and sum(px["bg"][:3]) < 200, json.dumps(px))
    link = dash.first(page, "csv_link")
    if res.check(s, "page links data/bluesky-daily.csv", link is not None):
        href = urllib.parse.urljoin(page.url, link.get_attribute("href"))
        r = page.request.get(href)
        first_line = r.text().splitlines()[0] if r.ok else ""
        res.check(s, "full dataset CSV is served with the documented header", r.ok and first_line == CSV_HEADER, f"HTTP {r.status} {first_line[:120]}")
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_guide(args, res: Results, dash: Dashboard):
    s = "guide"
    print("== guide")
    page = dash.new_page()
    dash.open(page)
    dialog = page.locator(SEL["guide_dialog"][0]) if page.locator(SEL["guide_dialog"][0]).count() else page.locator("dialog").first
    res.check(s, "guide closed on load", not dialog.is_visible())
    btn = dash.first(page, "guide_open")
    if not res.check(s, "GUIDE button exists", btn is not None):
        dash.close(page)
        return
    btn.click()
    page.wait_for_timeout(300)
    res.check(s, "GUIDE opens the dialog", dialog.is_visible() and dialog.evaluate("d => d.open === true"))
    text = norm(dialog.inner_text())
    for needle, why in ((r"lower bound", "DAU lower-bound definition"), (r"compare|prior", "compare explanation"),
                        (r"moving average|7D", "MA explanation"), (r"log", "log scale explanation"),
                        (r"jaz", "data source"), (r"outage|gap", "outage handling")):
        res.check(s, f"guide covers {why}", bool(re.search(needle, text, re.I)))
    dash.shot(page, "guide-open")
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)
    res.check(s, "Escape closes the guide", not dialog.is_visible())
    btn.click()
    page.wait_for_timeout(250)
    close = None
    for sel in SEL["guide_close"]:
        loc = dialog.locator(sel)
        if loc.count() and loc.first.is_visible():
            close = loc.first
            break
    if res.check(s, "guide has a close button", close is not None):
        close.click()
        page.wait_for_timeout(250)
        res.check(s, "close button closes the guide", not dialog.is_visible())
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_keyboard(args, res: Results, dash: Dashboard):
    s = "keyboard"
    print("== keyboard")
    page = dash.new_page()
    dash.open(page)
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    for i, r in enumerate(RANGES, start=1):
        page.keyboard.press(str(i))
        page.wait_for_timeout(250)
        b = dash.first(page, "range", r=r)
        res.check(s, f"key {i} selects {r}", bool(b) and b.get_attribute("aria-pressed") == "true")
    for key, name in (("m", "ma"), ("l", "log"), ("c", "compare")):
        b = dash.first(page, name)
        if not b:
            res.check(s, f"key {key.upper()} toggles {name}", False, "button not found")
            continue
        before = b.get_attribute("aria-pressed")
        page.keyboard.press(key)
        page.wait_for_timeout(300)
        res.check(s, f"key {key.upper()} toggles {name}", b.get_attribute("aria-pressed") != before,
                  f"{before} -> {b.get_attribute('aria-pressed')}")
        page.keyboard.press(key)
        page.wait_for_timeout(300)
    page.keyboard.press("?")
    page.wait_for_timeout(300)
    dialog = page.locator(SEL["guide_dialog"][0]) if page.locator(SEL["guide_dialog"][0]).count() else page.locator("dialog").first
    res.check(s, "? opens the guide", dialog.is_visible())
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    page.keyboard.press("Tab")
    ring = page.evaluate("""() => { const el = document.activeElement; if (!el || el === document.body) return null;
        const cs = getComputedStyle(el); return {tag: el.tagName, outline: cs.outlineStyle, shadow: cs.boxShadow}; }""")
    res.check(s, "keyboard focus is visible", bool(ring) and (ring["outline"] != "none" or ring["shadow"] != "none"), json.dumps(ring))
    res.check(s, "no console errors", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.close(page)


def cmd_live(args, res: Results, dash: Dashboard):
    s = "live"
    print("== live")
    exp = dash.expected["values"]

    def users_text(page):
        loc = page.locator('[data-prerender="users-total"]')
        return norm(loc.first.inner_text()) if loc.count() else ""

    page = dash.new_page(feed="fresh", reduced_motion="reduce")
    dash.open(page)
    try:
        page.wait_for_function("""() => { const el = document.querySelector('#data-status, #status-indicator, [data-status]');
            return el && /LIVE/i.test(el.textContent); }""", timeout=8000)
    except PlaywrightError:
        pass
    status = dash.first(page, "status")
    st = norm(status.inner_text()) if status else ""
    res.check(s, "fresh feed post -> status LIVE", "LIVE" in st.upper(), st or "status element not found")
    res.check(s, "feed requested with the live_source actor", any(dash.data["live_source"]["actor"] in urllib.parse.unquote(u) for u in page.feed_requests),
              page.feed_requests[0][:160] if page.feed_requests else "no request")
    page.wait_for_timeout(1500)
    shown = parse_int(users_text(page))
    pace = max(0.0, sum(d["new_users"] or 0 for d in dash.data["days"][-7:]) / 7) / 86400

    def live_ceiling(p):
        elapsed = p.evaluate("() => Date.now()") / 1000 - p.live_at.timestamp()
        return p.live_value + pace * min(max(elapsed, 0), 3 * 3600) + 1

    ceiling = live_ceiling(page)
    res.check(s, "TOTAL USERS shows the live value (or an EST tick above it)", shown is not None and page.live_value <= shown <= ceiling,
              f"shown={shown} live={page.live_value} ceiling={int(ceiling)}")
    card_text = page.evaluate("""() => { const el = document.querySelector('[data-prerender="users-total"]');
        const card = el && (el.closest('article, .metric-card, .card, section') || el.parentElement); return card ? card.innerText : ''; }""")
    res.check(s, "TOTAL USERS card is marked LIVE/EST", bool(re.search(r"\bLIVE\b|\bEST\b", card_text)), norm(card_text)[:160])
    tick_users = page.evaluate("""() => { const el = document.querySelector('#ticker-items [data-tick="users"], .ticker-item[data-key="users"]');
        return el ? el.textContent : ''; }""")
    tick_val = parse_int(tick_users)
    res.check(s, "ticker USERS shows the live value", tick_val is not None and page.live_value <= tick_val <= ceiling,
              f"ticker={norm(tick_users)!r} live={page.live_value}")
    res.check(s, "no console errors (live)", not page.console_errors, " | ".join(page.console_errors)[:400])
    dash.shot(page, "live-on")
    dash.close(page)

    page = dash.new_page(feed="fresh", reduced_motion="reduce")
    page.clock.install()
    dash.open(page)
    page.wait_for_timeout(1000)
    n0 = len(page.feed_requests)
    page.clock.fast_forward("10:30")
    page.wait_for_timeout(1500)
    n1 = len(page.feed_requests)
    res.check(s, "live count refreshes every 10 minutes while visible", n0 >= 1 and n1 > n0, f"requests: {n0} at load, {n1} after +10:30")
    shown = parse_int(users_text(page))
    ceiling = live_ceiling(page)
    res.check(s, "EST tick never runs ahead of last live value + 7D pace × elapsed", shown is not None and page.live_value <= shown <= ceiling,
              f"shown={shown} live={page.live_value} ceiling={int(ceiling)} after a simulated 10.5 min")
    dash.close(page)

    for mode, wait_ms in (("fail", 1500), ("garbage", 1500), ("stale", 1500), ("hang", 7000)):
        p = dash.new_page(feed=mode, reduced_motion="reduce")
        dash.open(p)
        p.wait_for_timeout(wait_ms)
        st_el = dash.first(p, "status")
        st = norm(st_el.inner_text()) if st_el else ""
        res.check(s, f"{mode} feed -> status ARCHIVE", "ARCHIVE" in st.upper() and "LIVE" not in st.upper(), st)
        res.check(s, f"{mode} feed -> TOTAL USERS stays at the archived value", users_text(p) == exp["users-total"],
                  f"{users_text(p)!r} vs {exp['users-total']!r}")
        errs = [e for e in p.console_errors if not (mode == "fail" and "Failed to load resource" in e)]
        res.check(s, f"{mode} feed -> fails silently (no uncaught errors)", not errs, " | ".join(errs)[:300])
        if mode == "fail":
            dash.shot(p, "live-fail-archive")
        dash.close(p)


SUITES = {
    "smoke": cmd_smoke, "ranges": cmd_ranges, "compare": cmd_compare, "toggles": cmd_toggles, "waves": cmd_waves,
    "exports": cmd_exports, "guide": cmd_guide, "keyboard": cmd_keyboard, "live": cmd_live,
}


def run_suite(name, args, res: Results, dash: Dashboard):
    try:
        SUITES[name](args, res, dash)
    except Exception as e:  # noqa: BLE001 - one broken suite must not hide the others
        res.check(name, "suite ran to completion", False, f"{type(e).__name__}: {str(e).splitlines()[0][:300]}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ["doctor", *SUITES, "all"]:
        p = sub.add_parser(name)
        p.add_argument("--url", help="drive this URL instead of serving the repo (e.g. https://obsesivegamer.github.io/Bluesky-User-Trends/)")
        p.add_argument("--port", type=int, default=0, help="local server port (default: a free port)")
        p.add_argument("--out", help=f"screenshot directory (default: {ARTIFACTS.relative_to(REPO_ROOT)})")
        p.add_argument("--headed", action="store_true", help="show the browser")
        p.add_argument("--slow-mo", type=int, default=0, help="ms delay between browser actions")
        p.add_argument("--json", help="also write the results to this JSON file")
    args = parser.parse_args(argv)

    res = Results()
    if args.command in ("doctor", "all"):
        cmd_doctor(args, res)
    names = list(SUITES) if args.command == "all" else ([] if args.command == "doctor" else [args.command])
    if names:
        if sync_playwright is None:
            print(f"Playwright is not installed for {sys.executable}. Use a Python that has it, e.g.\n"
                  "  python3 -m pip install playwright && python3 -m playwright install chromium", file=sys.stderr)
            return 2
        try:
            with Dashboard(args) as dash:
                print(f"target: {dash.base}  data: {dash.data_url}")
                for name in names:
                    run_suite(name, args, res, dash)
        except (RuntimeError, PlaywrightError, subprocess.CalledProcessError) as e:
            res.check(args.command, "dashboard reachable", False, str(e).splitlines()[0][:300])

    counts = {k: sum(1 for r in res.rows if r[1] == k) for k in ("PASS", "FAIL", "WARN")}
    print(f"\n{counts['PASS']} passed, {counts['FAIL']} failed, {counts['WARN']} warnings")
    for suite, status, name, detail in res.rows:
        if status == "FAIL":
            print(f"  FAIL {suite}: {name}" + (f" -- {detail}" if detail else ""))
    if args.json:
        Path(args.json).write_text(json.dumps([dict(zip(("suite", "status", "check", "detail"), r)) for r in res.rows], indent=2))
    return 1 if res.failed else 0


if __name__ == "__main__":
    sys.exit(main())
