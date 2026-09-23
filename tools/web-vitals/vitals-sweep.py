#!/usr/bin/env python3
"""vitals-sweep.py — fleet-wide Core Web Vitals + accessibility sweep. Zero AI.

Why this exists
---------------
No Lighthouse or axe run existed anywhere in the fleet. For a portfolio
monetized on organic traffic that is a direct revenue gap: LCP and CLS are
ranking inputs, and an accessibility regression is both a legal exposure and a
straightforward loss of readers. Both are cheap to measure and impossible to
notice by eye.

Lab, not field
--------------
This runs Lighthouse locally against a headless Chrome — lab data. The
alternative, Google's CrUX field API, reports what real users actually
experienced, which is strictly better information *when it exists*. It does
not exist for most of this fleet: CrUX only publishes a URL or origin once it
clears a traffic threshold, and the majority of these 30 sites are nowhere
near it. A check that silently returns "no data" for twenty sites is not a
check. Lab data is available for every site on day one, is comparable
run-to-run because the environment is fixed, and catches a regression the day
it ships rather than 28 days later when the field window catches up.

The tradeoff is real and worth stating: lab numbers are not user numbers.
Treat a score here as "did this get worse than it was", not as "this is what
visitors experience".

Budgets
-------
A score with no threshold is a number nobody acts on. Each metric carries a
budget (Google's own "good" thresholds where they have one); a site under
budget is reported as a regression against its own previous run, not against
an absolute — a site that has always been at 0.72 performance is a known
state, and a site that fell from 0.95 to 0.72 last week is news.

Usage
-----
    python3 tools/web-vitals/vitals-sweep.py                 # table, all live sites
    python3 tools/web-vitals/vitals-sweep.py --json
    python3 tools/web-vitals/vitals-sweep.py --site xxxtea.com
    python3 tools/web-vitals/vitals-sweep.py --desktop       # desktop instead of the mobile default
    python3 tools/web-vitals/vitals-sweep.py --fail-on-regression
    python3 tools/web-vitals/vitals-sweep.py --budget-fail   # exit 1 on any budget breach

Every run writes a factor-specific report (latest-mobile.json or
latest-desktop.json) and appends reports/history.jsonl. latest.json remains a
backward-compatible alias for the mobile report.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
REPORTS = TOOL_DIR / "reports"
REGISTRY = ROOT / "registry" / "fleet.yaml"

# Google's "good" thresholds, plus the two category scores. A site at or better
# than every one of these is genuinely fine; these are not aspirational.
BUDGETS = {
    "performance": (">=", 0.90),
    "accessibility": (">=", 0.90),
    "lcp_ms": ("<=", 2500),
    "cls": ("<=", 0.10),
    "tbt_ms": ("<=", 200),
}

# How far a metric may move before it counts as a regression rather than noise.
# Lighthouse is not deterministic; without a band, every run reports movement.
NOISE = {"performance": 0.05, "accessibility": 0.03, "lcp_ms": 500, "cls": 0.03, "tbt_ms": 150}


def log(msg: str) -> None:
    print(f"[vitals-sweep] {msg}", file=sys.stderr, flush=True)


def load_site_sets(only: list[str] | None) -> tuple[list[str], set[str]]:
    """Live domains from the canonical registry. Narrow reader, no PyYAML
    dependency — same rationale as tools/link-rot/link-sweep.py."""
    if not REGISTRY.exists():
        log(f"no registry at {REGISTRY}")
        return [], set()
    sites: list[str] = []
    gated: set[str] = set()
    current: str | None = None
    access_gated = False
    in_sites = False
    for raw in REGISTRY.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw.startswith("sites:"):
            in_sites = True
            continue
        if not in_sites:
            continue
        if raw.startswith("  ") and not raw.startswith("    ") and raw.rstrip().endswith(":"):
            current = raw.strip().rstrip(":")
            access_gated = False
            continue
        if current and raw.strip() == "access_gated: true":
            access_gated = True
            if current in sites:
                sites.remove(current)
                gated.add(current)
                log(f"skipping {current}: access-gated private preview")
            continue
        if current and raw.strip() == "status: live":
            if access_gated:
                gated.add(current)
                log(f"skipping {current}: access-gated private preview")
            else:
                sites.append(current)
    if only:
        want = set(only)
        missing = want - set(sites) - gated
        if missing:
            log(f"not live in the registry, skipping: {', '.join(sorted(missing))}")
        sites = [s for s in sites if s in want]
    if only:
        gated = gated & set(only)
    return sorted(sites), gated


def load_live_sites(only: list[str] | None) -> list[str]:
    """Compatibility wrapper returning only measurable live domains."""
    sites, _gated = load_site_sets(only)
    return sites


def probe_access_gate(domain: str, timeout: int = 15) -> tuple[str, str]:
    """Classify the public homepage without credentials."""
    request = Request(
        f"https://{domain}",
        headers={"User-Agent": "fleet-web-vitals-gate-probe/1.0"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read(200_000).decode("utf-8", "replace").lower()
    except Exception as exc:  # noqa: BLE001 — probe must not abort the sweep
        return "unverified", f"gate probe failed: {type(exc).__name__}"
    is_gate = (
        "private preview" in body
        and (
            'type="password"' in body
            or "type='password'" in body
            or 'name="password"' in body
        )
    )
    return ("gated", "private-preview access page") if is_gate else ("open", "live page is not access-gated")


def chrome_path() -> str | None:
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/snap/bin/chromium"):
        if Path(c).exists():
            return c
    return shutil.which("google-chrome") or shutil.which("chromium")


def start_chrome(
    chrome: str, profile_dir: Path,
) -> tuple[subprocess.Popen | None, int | None, str | None]:
    """Start the selected browser without chrome-launcher's shell discovery."""
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        proc = subprocess.Popen(
            [
                chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={profile_dir}",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as exc:
        return None, None, f"could not start Chrome directly: {exc}"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            detail = (proc.stderr.read() or b"").decode("utf-8", "replace").strip()
            return None, None, detail or f"Chrome exited with status {proc.returncode}"
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return proc, port, None
        except OSError:
            time.sleep(0.1)
    stop_chrome(proc)
    return None, None, "Chrome did not open its debugging port within 10s"


def stop_chrome(proc: subprocess.Popen | None) -> None:
    """Stop Chrome and descendants; Chrome forks renderer processes."""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            proc.kill()
        proc.wait(timeout=2)


def run_lighthouse(url: str, *, mobile: bool, timeout: int) -> tuple[dict | None, str | None]:
    node_bin = os.environ.get("FLEET_NODE_BIN", "/home/jesse/.nvm/versions/node/v23.7.0/bin")
    env = dict(os.environ)
    env["PATH"] = f"{node_bin}:{env.get('PATH', '')}"
    chrome = chrome_path()
    if not chrome:
        return None, "no Chrome/Chromium found (set CHROME_PATH)"
    env["CHROME_PATH"] = chrome

    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "lh.json"
        lighthouse_cmd = os.environ.get("FLEET_LIGHTHOUSE_CMD")
        cmd = [
            *( [lighthouse_cmd] if lighthouse_cmd else [str(TOOL_DIR / "node_modules/.bin/lighthouse")] ),
            url,
            "--only-categories=performance,accessibility",
            "--output=json", f"--output-path={out}",
            # --no-sandbox: this runs unprivileged on a shared host box, not
            # against untrusted input we care to isolate.
            "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
            "--quiet",
        ]
        if not mobile:
            cmd += ["--preset=desktop"]
        last_error = None
        # Chrome startup is occasionally transient (stale profile/process,
        # launcher race, or a short-lived host resource issue). Retry once so
        # one launch blip does not page the site owner as a site outage.
        for attempt in range(2):
            chrome_proc, port, chrome_error = start_chrome(chrome, Path(td) / f"chrome-profile-{attempt}")
            if chrome_error:
                last_error = f"Chrome launch failed: {chrome_error}"
                if attempt == 0:
                    time.sleep(2)
                continue
            try:
                proc = subprocess.run(
                    [*cmd, f"--port={port}"], cwd=TOOL_DIR, env=env, timeout=timeout,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                )
            except subprocess.TimeoutExpired:
                stop_chrome(chrome_proc)
                return None, f"lighthouse timed out after {timeout}s"
            try:
                if out.exists():
                    try:
                        return json.loads(out.read_text(encoding="utf-8")), None
                    except Exception as e:  # noqa: BLE001
                        last_error = f"unreadable report: {e}"
                else:
                    lines = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
                    # Keep both the high-level runtime error and the final
                    # stack line; the latter alone is not actionable in Slack.
                    useful = [line.strip() for line in lines if line.strip()]
                    if useful:
                        diagnosis = next(
                            (line for line in useful if "Runtime error" in line or "Error:" in line),
                            useful[0],
                        )
                        last_error = " | ".join(dict.fromkeys([diagnosis, *useful[-2:]]))
                    else:
                        last_error = f"lighthouse exit {proc.returncode}"
            finally:
                stop_chrome(chrome_proc)
            if attempt == 0:
                time.sleep(2)
        return None, last_error


def extract(report: dict) -> dict:
    cats = report.get("categories", {})
    audits = report.get("audits", {})

    def num(key):
        a = audits.get(key) or {}
        v = a.get("numericValue")
        return round(v, 4) if isinstance(v, (int, float)) else None

    def score(cat):
        s = (cats.get(cat) or {}).get("score")
        return round(s, 3) if isinstance(s, (int, float)) else None

    # Every failing accessibility audit, by id. This is the actionable half:
    # "a11y 0.87" tells you nothing, "image-alt, color-contrast" tells you what
    # to fix.
    a11y_failures = []
    for ref in (cats.get("accessibility") or {}).get("auditRefs", []):
        a = audits.get(ref.get("id")) or {}
        if a.get("score") == 0 and a.get("scoreDisplayMode") not in ("notApplicable", "manual", "informative"):
            a11y_failures.append(a.get("id"))

    return {
        "performance": score("performance"),
        "accessibility": score("accessibility"),
        "lcp_ms": num("largest-contentful-paint"),
        "cls": num("cumulative-layout-shift"),
        "tbt_ms": num("total-blocking-time"),
        "a11y_failures": sorted(f for f in a11y_failures if f),
    }


def breaches(m: dict) -> list[str]:
    out = []
    for key, (op, limit) in BUDGETS.items():
        v = m.get(key)
        if v is None:
            continue
        if (op == ">=" and v < limit) or (op == "<=" and v > limit):
            out.append(key)
    return out


def regressions(now: dict, was: dict | None) -> list[str]:
    """Metrics that moved the wrong way by more than the noise band."""
    if not was:
        return []
    out = []
    for key, (op, _limit) in BUDGETS.items():
        a, b = now.get(key), was.get(key)
        if a is None or b is None:
            continue
        band = NOISE[key]
        if op == ">=" and a < b - band:      # score dropped
            out.append(key)
        elif op == "<=" and a > b + band:    # timing/shift got worse
            out.append(key)
    return out


def report_path(form_factor: str) -> Path:
    return REPORTS / f"latest-{form_factor}.json"


def load_previous(form_factor: str) -> dict:
    """Previous metrics, but ONLY from a run of the same form factor.

    Mobile is CPU-throttled; its LCP and TBT are far worse than desktop's for
    the same page. Comparing across form factors would report the entire fleet
    as regressed the first time the default changed (it did change, 2026-09-01,
    desktop -> mobile) and would then report it all "recovered" if anyone ran
    --desktop once. A comparison between two different measurements is not a
    trend, so decline to make one.
    """
    # Keep mobile and desktop baselines independent.  A weekly desktop run
    # must never become the comparison point for the daily mobile run.
    p = report_path(form_factor)
    if not p.exists():
        # Backward compatibility with the original single-baseline report.
        p = REPORTS / "latest.json"
    if not p.exists():
        return {}
    try:
        prev = json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    if prev.get("form_factor") != form_factor:
        return {}
    return {
        s["site"]: s["metrics"]
        for s in prev.get("sites", [])
        if not s.get("error") and isinstance(s.get("metrics"), dict)
    }


def write_reports(payload: dict, *, partial: bool) -> None:
    """Write reports/latest.json, MERGING when this was a partial run.

    A `--site`-limited run measures two sites. Writing its payload wholesale
    would replace the fleet baseline with those two rows and silently discard
    every other site's last-known values — so the next full run would see no
    history and report nothing as regressed. (This is not hypothetical: it
    happened the first time the tool was exercised with --site.) A partial run
    therefore updates the rows it actually measured and leaves the rest alone.
    """
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = payload
    factor_path = report_path(payload["form_factor"])
    if partial:
        old_path = factor_path
        if not old_path.exists():
            old_path = REPORTS / "latest.json"
        if old_path.exists():
            try:
                old = json.loads(old_path.read_text(encoding="utf-8"))
                # Never merge rows measured on a different form factor: the
                # file carries ONE form_factor label, and mixing would make it
                # a lie about half its own rows.
                if old.get("form_factor") != payload.get("form_factor"):
                    old = {"sites": []}
                merged = {s["site"]: s for s in old.get("sites", [])}
                for s in payload["sites"]:
                    merged[s["site"]] = s
                out = dict(payload)
                out["sites"] = [merged[k] for k in sorted(merged)]
                out["partial_run_sites"] = sorted(s["site"] for s in payload["sites"])
            except Exception:  # noqa: BLE001 — a corrupt baseline must not lose this run
                out = payload
    tmp = factor_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out, indent=2), encoding="utf-8")
    tmp.replace(factor_path)  # atomic: never a half-written report
    # latest.json remains the compatibility/default view and intentionally
    # follows mobile, the primary ranking form factor. Desktop runs get their
    # own file without displacing the mobile baseline consumed by the UI.
    if payload["form_factor"] == "mobile" or not (REPORTS / "latest.json").exists():
        latest_tmp = REPORTS / "latest.json.tmp"
        latest_tmp.write_text(json.dumps(out, indent=2), encoding="utf-8")
        latest_tmp.replace(REPORTS / "latest.json")
    # history records what THIS run measured — never the merged view, or a
    # partial run would append stale rows for sites it never touched.
    with (REPORTS / "history.jsonl").open("a", encoding="utf-8") as fh:
        for s in payload["sites"]:
            if s.get("error") or not s.get("metrics"):
                continue
            m = s["metrics"]
            fh.write(json.dumps({
                "at": payload["at"], "site": s["site"], "form_factor": payload["form_factor"],
                "performance": m["performance"], "accessibility": m["accessibility"],
                "lcp_ms": m["lcp_ms"], "cls": m["cls"], "tbt_ms": m["tbt_ms"],
            }) + "\n")


def fmt(v, kind):
    if v is None:
        return "-"
    if kind == "score":
        return f"{v:.2f}"
    if kind == "ms":
        return f"{int(v)}"
    return f"{v:.3f}"


def table(payload: dict) -> None:
    print(f"{'site':<26} {'perf':>5} {'a11y':>5} {'LCP':>7} {'CLS':>6} {'TBT':>6}  flags")
    print("-" * 84)
    for s in payload["sites"]:
        if s.get("status") == "skipped":
            print(
                f"{s['site']:<26} {'-':>5} {'-':>5} {'-':>7} {'-':>6} {'-':>6}  "
                f"SKIPPED: {s.get('reason', 'policy')}"
            )
            continue
        if s.get("error"):
            print(f"{s['site']:<26} {'-':>5} {'-':>5} {'-':>7} {'-':>6} {'-':>6}  {s['error']}")
            continue
        m = s["metrics"]
        flags = []
        if s["regressions"]:
            flags.append("REGRESSED: " + ",".join(s["regressions"]))
        if s["budget_breaches"]:
            flags.append("over budget: " + ",".join(s["budget_breaches"]))
        if m["a11y_failures"]:
            flags.append(f"a11y: {','.join(m['a11y_failures'][:3])}")
        if s.get("warnings"):
            flags.append("warning: " + "; ".join(s["warnings"]))
        print(
            f"{s['site']:<26} {fmt(m['performance'],'score'):>5} {fmt(m['accessibility'],'score'):>5} "
            f"{fmt(m['lcp_ms'],'ms'):>7} {fmt(m['cls'],'n'):>6} {fmt(m['tbt_ms'],'ms'):>6}  {' · '.join(flags)}"
        )
    t = payload["totals"]
    print("-" * 84)
    print(
        f"{t['sites']} sites ({payload['form_factor']}) · {t['errors']} unmeasurable · "
        f"{t.get('skipped', 0)} skipped · {t.get('warnings', 0)} warnings · "
        f"{t['regressed']} regressed · {t['over_budget']} over budget · {t['a11y_failing']} with a11y failures"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append", help="limit to this domain (repeatable)")
    # Mobile is the default because it is the number that affects revenue:
    # Google ranks on mobile field data, and mobile is CPU-throttled so its
    # LCP/TBT are materially worse than desktop's. Desktop is the flattering
    # measurement, not the useful one. Same ~20min runtime either way.
    ap.add_argument("--desktop", action="store_true", help="measure desktop instead of mobile")
    ap.add_argument("--timeout", type=int, default=180, help="seconds per site (default 180)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--fail-on-regression", action="store_true", help="exit 1 if any metric regressed")
    ap.add_argument("--budget-fail", action="store_true", help="exit 1 on any budget breach")
    ap.add_argument("--no-write", action="store_true", help="do not touch reports/")
    args = ap.parse_args()

    sites, gated = load_site_sets(args.site)
    results = []
    warnings_by_site: dict[str, list[str]] = {}
    for d in sorted(gated):
        state, detail = probe_access_gate(d)
        if state == "open":
            warning = "registry access_gated=true but live page is open"
            log(f"WARNING {d}: {warning}")
            warnings_by_site[d] = [warning]
            sites.append(d)
        elif state == "unverified":
            warning = f"could not verify access gate ({detail})"
            log(f"WARNING {d}: {warning}")
            results.append({
                "site": d,
                "status": "skipped",
                "error": None,
                "reason": "access_gated",
                "warnings": [warning],
            })
        else:
            results.append({
                "site": d,
                "status": "skipped",
                "error": None,
                "reason": "access_gated",
                "warnings": [],
            })
    sites = sorted(set(sites))
    if sites and not chrome_path():
        log("no Chrome/Chromium found — set CHROME_PATH")
        return 2

    form_factor = "desktop" if args.desktop else "mobile"
    previous = load_previous(form_factor)
    # Deliberately serial. Lighthouse's numbers are only comparable when the
    # machine is not otherwise busy; running 8 headless Chromes in parallel
    # would make the sweep fast and the data worthless.
    for d in sites:
        log(f"measuring {d} …")
        report, err = run_lighthouse(f"https://{d}", mobile=not args.desktop, timeout=args.timeout)
        if err:
            results.append({"site": d, "status": "error", "error": err, "warnings": []})
            continue
        m = extract(report)
        results.append({
            "site": d,
            "status": "measured",
            "error": None,
            "metrics": m,
            "budget_breaches": breaches(m),
            "regressions": regressions(m, previous.get(d)),
            "warnings": warnings_by_site.get(d, []),
        })

    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "form_factor": form_factor,
        "budgets": {k: {"op": op, "limit": lim} for k, (op, lim) in BUDGETS.items()},
        "totals": {
            "sites": len(results),
            "errors": sum(1 for s in results if s.get("error")),
            "skipped": sum(1 for s in results if s.get("status") == "skipped"),
            "warnings": sum(1 for s in results if s.get("warnings")),
            "regressed": sum(1 for s in results if s.get("regressions")),
            "over_budget": sum(1 for s in results if s.get("budget_breaches")),
            "a11y_failing": sum(1 for s in results if s.get("metrics") and s["metrics"]["a11y_failures"]),
        },
        "sites": results,
    }

    if not args.no_write:
        write_reports(payload, partial=bool(args.site))
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        table(payload)

    if args.fail_on_regression and payload["totals"]["regressed"]:
        return 1
    if args.budget_fail and payload["totals"]["over_budget"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
