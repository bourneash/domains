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
    python3 tools/web-vitals/vitals-sweep.py --mobile        # mobile emulation (default: desktop)
    python3 tools/web-vitals/vitals-sweep.py --fail-on-regression
    python3 tools/web-vitals/vitals-sweep.py --budget-fail   # exit 1 on any budget breach

Every run writes reports/latest.json and appends reports/history.jsonl.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
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


def load_live_sites(only: list[str] | None) -> list[str]:
    """Live domains from the canonical registry. Narrow reader, no PyYAML
    dependency — same rationale as tools/link-rot/link-sweep.py."""
    if not REGISTRY.exists():
        log(f"no registry at {REGISTRY}")
        return []
    sites: list[str] = []
    current: str | None = None
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
            continue
        if current and raw.strip() == "status: live":
            sites.append(current)
    if only:
        want = set(only)
        missing = want - set(sites)
        if missing:
            log(f"not live in the registry, skipping: {', '.join(sorted(missing))}")
        sites = [s for s in sites if s in want]
    return sorted(sites)


def chrome_path() -> str | None:
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/snap/bin/chromium"):
        if Path(c).exists():
            return c
    return shutil.which("google-chrome") or shutil.which("chromium")


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
        cmd = [
            "npx", "lighthouse", url,
            "--only-categories=performance,accessibility",
            "--output=json", f"--output-path={out}",
            # --no-sandbox: this runs unprivileged on a shared host box, not
            # against untrusted input we care to isolate.
            "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
            "--quiet",
        ]
        if not mobile:
            cmd += ["--preset=desktop"]
        try:
            proc = subprocess.run(
                cmd, cwd=TOOL_DIR, env=env, timeout=timeout,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
        except subprocess.TimeoutExpired:
            return None, f"lighthouse timed out after {timeout}s"
        if not out.exists():
            err = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            return None, (err[-1] if err else f"lighthouse exit {proc.returncode}")
        try:
            return json.loads(out.read_text(encoding="utf-8")), None
        except Exception as e:  # noqa: BLE001
            return None, f"unreadable report: {e}"


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


def load_previous() -> dict:
    p = REPORTS / "latest.json"
    if not p.exists():
        return {}
    try:
        prev = json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return {s["site"]: s.get("metrics") for s in prev.get("sites", []) if not s.get("error")}


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
    if partial:
        old_path = REPORTS / "latest.json"
        if old_path.exists():
            try:
                old = json.loads(old_path.read_text(encoding="utf-8"))
                merged = {s["site"]: s for s in old.get("sites", [])}
                for s in payload["sites"]:
                    merged[s["site"]] = s
                out = dict(payload)
                out["sites"] = [merged[k] for k in sorted(merged)]
                out["partial_run_sites"] = sorted(s["site"] for s in payload["sites"])
            except Exception:  # noqa: BLE001 — a corrupt baseline must not lose this run
                out = payload
    tmp = REPORTS / "latest.json.tmp"
    tmp.write_text(json.dumps(out, indent=2), encoding="utf-8")
    tmp.replace(REPORTS / "latest.json")  # atomic: never a half-written report
    # history records what THIS run measured — never the merged view, or a
    # partial run would append stale rows for sites it never touched.
    with (REPORTS / "history.jsonl").open("a", encoding="utf-8") as fh:
        for s in payload["sites"]:
            if s.get("error"):
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
        print(
            f"{s['site']:<26} {fmt(m['performance'],'score'):>5} {fmt(m['accessibility'],'score'):>5} "
            f"{fmt(m['lcp_ms'],'ms'):>7} {fmt(m['cls'],'n'):>6} {fmt(m['tbt_ms'],'ms'):>6}  {' · '.join(flags)}"
        )
    t = payload["totals"]
    print("-" * 84)
    print(
        f"{t['sites']} sites ({payload['form_factor']}) · {t['errors']} unmeasurable · "
        f"{t['regressed']} regressed · {t['over_budget']} over budget · {t['a11y_failing']} with a11y failures"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append", help="limit to this domain (repeatable)")
    ap.add_argument("--mobile", action="store_true", help="mobile emulation (default: desktop)")
    ap.add_argument("--timeout", type=int, default=180, help="seconds per site (default 180)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--fail-on-regression", action="store_true", help="exit 1 if any metric regressed")
    ap.add_argument("--budget-fail", action="store_true", help="exit 1 on any budget breach")
    ap.add_argument("--no-write", action="store_true", help="do not touch reports/")
    args = ap.parse_args()

    sites = load_live_sites(args.site)
    if not sites:
        log("no live sites to sweep")
        return 0
    if not chrome_path():
        log("no Chrome/Chromium found — set CHROME_PATH")
        return 2

    previous = load_previous()
    results = []
    # Deliberately serial. Lighthouse's numbers are only comparable when the
    # machine is not otherwise busy; running 8 headless Chromes in parallel
    # would make the sweep fast and the data worthless.
    for d in sites:
        log(f"measuring {d} …")
        report, err = run_lighthouse(f"https://{d}", mobile=args.mobile, timeout=args.timeout)
        if err:
            results.append({"site": d, "error": err})
            continue
        m = extract(report)
        results.append({
            "site": d,
            "error": None,
            "metrics": m,
            "budget_breaches": breaches(m),
            "regressions": regressions(m, previous.get(d)),
        })

    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "form_factor": "mobile" if args.mobile else "desktop",
        "budgets": {k: {"op": op, "limit": lim} for k, (op, lim) in BUDGETS.items()},
        "totals": {
            "sites": len(results),
            "errors": sum(1 for s in results if s.get("error")),
            "regressed": sum(1 for s in results if s.get("regressions")),
            "over_budget": sum(1 for s in results if s.get("budget_breaches")),
            "a11y_failing": sum(1 for s in results if not s.get("error") and s["metrics"]["a11y_failures"]),
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
