#!/usr/bin/env python3
"""fleet-test — run every first-party tool test suite in tools/, in one pass.

WHY THIS EXISTS
---------------
Before this, ~150 first-party test files across 21 tools were executed only
when a human happened to type `pytest` in the right directory. There is no
root CI, no root `test` script, and no cron line ran them. The tools these
suites cover include the control plane that pushes commits to 48 repos and
restarts containers fleet-wide (`fleet-dashboard`), the collectors the whole
portfolio's history is built on (`cf-stats`, `data-hub`), and the tooling that
spends real money (`amz-stats`, `ai-usage`). A regression there shipped silent.

DESIGN NOTES
------------
* **Roster, not glob.** See suites.yaml — globbing hits vendored third-party
  tests that would be permanently red. `--check-drift` is what keeps the roster
  honest: a tool that grows first-party tests without being listed is reported.
* **Each tool's own interpreter.** Tools that provisioned a `.venv/` are run
  with it; the rest fall back to system python3. This mirrors how they are run
  by hand and by their own containers.
* **`error` is not `fail`.** A suite that cannot even start (deps not
  installed, no runner, timeout) is a different signal from a suite whose
  assertions failed — conflating them trains you to ignore both.
* **Zero AI, no network of its own.** Same contract as the lint sweep.

USAGE
    python3 tools/fleet-test/run_tests.py                 # run all, table out
    python3 tools/fleet-test/run_tests.py --json
    python3 tools/fleet-test/run_tests.py --only fleet-dashboard --only cf-stats
    python3 tools/fleet-test/run_tests.py --check-drift   # roster check only

EXIT CODES
    0  every suite ok (skips allowed)
    1  at least one suite failed or errored
    2  roster drift (unregistered first-party suite) — with --check-drift only
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

TOOL_DIR = Path(__file__).resolve().parent
TOOLS_ROOT = TOOL_DIR.parent
DEFAULT_TIMEOUT = 300

# pytest -q tail: "5 passed, 1 skipped in 0.42s" / "2 failed, 3 passed in 1.1s"
PYTEST_COUNT = re.compile(r"\b(\d+)\s+(passed|failed|error|errors|skipped|xfailed)\b")
# node --test summary. The TAP reporter writes "# pass 12"; node 22+'s default
# `spec` reporter writes "\u2139 pass 12" wrapped in ANSI colour. Accept both,
# after stripping colour — otherwise a fully green 142-test run reports zero
# tests, which looks identical to a suite that never ran.
NODE_COUNT = re.compile(r"^[#\u2139]\s+(pass|fail|skipped)\s+(\d+)\s*$", re.M)
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def load_manifest(path: Path) -> dict:
    with path.open() as fh:
        return yaml.safe_load(fh)


def first_party_test_files(manifest: dict) -> dict[str, list[str]]:
    """Every test file under tools/ that is ours, grouped by tool dir name."""
    markers = manifest.get("vendored_markers") or []
    found: dict[str, list[str]] = {}
    for pattern in ("test_*.py", "*.test.js", "*.test.mjs"):
        for p in TOOLS_ROOT.rglob(pattern):
            rel = str(p.relative_to(TOOLS_ROOT))
            hay = "/" + rel
            if any(m in hay for m in markers):
                continue
            found.setdefault(rel.split("/", 1)[0], []).append(rel)
    return found


def python_for(tool_path: Path) -> str:
    """A tool's own venv wins; otherwise FLEET_TEST_PYTHON, otherwise python3.

    FLEET_TEST_PYTHON matters under cron: the fleet's test toolchain (pytest,
    fastapi, httpx, respx, playwright, PIL, ...) lives in pyenv 3.11.10, but a
    cron PATH of /usr/bin:/bin resolves `python3` to the distro 3.12 that has
    none of it — every suite would report `error` for no real reason.
    """
    venv = tool_path / ".venv" / "bin" / "python"
    if venv.exists():
        return str(venv)
    pinned = os.environ.get("FLEET_TEST_PYTHON")
    if pinned and Path(pinned).exists():
        return pinned
    return shutil.which("python3") or "python3"


def build_cmd(name: str, spec: dict, tool_path: Path) -> tuple[list[str], dict]:
    runner = spec.get("runner")
    env = os.environ.copy()
    # A shared .env in the process environment would let a suite reach real
    # Cloudflare/Amazon/Slack. Tests must never depend on live creds; keep the
    # environment as-inherited and only add what a test runner needs.
    env["NODE_ENV"] = "test"
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    if runner == "pytest":
        src = tool_path / "src"
        parts = [str(src)] if src.is_dir() else []
        parts.append(str(tool_path))
        if env.get("PYTHONPATH"):
            parts.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(parts)
        return [python_for(tool_path), "-m", "pytest", "-q", "--color=no"], env

    if runner == "node-test":
        files = spec.get("files")
        if files:
            return ["node", "--test", *files], env
        pkg = tool_path / "package.json"
        if pkg.exists():
            try:
                if (json.loads(pkg.read_text()).get("scripts") or {}).get("test"):
                    return ["npm", "test", "--silent"], env
            except (json.JSONDecodeError, OSError):
                pass
        return ["node", "--test"], env

    raise ValueError(f"{name}: unknown runner {runner!r}")


def parse_counts(runner: str, out: str) -> dict:
    out = ANSI.sub("", out)
    counts: dict[str, int] = {}
    if runner == "pytest":
        for n, kind in PYTEST_COUNT.findall(out):
            key = "errored" if kind.startswith("error") else kind
            counts[key] = counts.get(key, 0) + int(n)
    else:
        for kind, n in NODE_COUNT.findall(out):
            counts["passed" if kind == "pass" else "failed" if kind == "fail" else "skipped"] = int(n)
    return counts


def classify(runner: str, rc: int, out: str, timed_out: bool) -> tuple[str, str]:
    """-> (status, note). `error` = could not run; `fail` = tests said no."""
    if timed_out:
        return "error", "timed out"
    if rc == 0:
        if runner == "node-test" and not parse_counts(runner, out).get("passed"):
            return "error", "exited 0 but reported no passing tests"
        return "ok", ""
    low = out.lower()
    if runner == "pytest":
        if rc == 5 or "no tests ran" in low:
            return "error", "no tests collected"
        if rc == 4:
            return "error", "pytest usage error"
        if rc in (2, 3):
            return "error", "collection interrupted"
        if "modulenotfounderror" in low or "importerror" in low:
            return "error", "missing dependency — venv not provisioned"
        if "no module named pytest" in low:
            return "error", "pytest not installed for this interpreter"
    else:
        if "cannot find module" in low or "err_module_not_found" in low:
            return "error", "missing dependency — npm install not run"
    return "fail", ""


def tail(out: str, lines: int = 25) -> str:
    kept = [ln for ln in out.splitlines() if ln.strip()]
    return "\n".join(kept[-lines:])


def run_suite(name: str, spec: dict, timeout_default: int) -> dict:
    runner = spec.get("runner")
    dirname = spec.get("dir", name)
    tool_path = TOOLS_ROOT / dirname
    row = {"suite": name, "dir": dirname, "runner": runner}

    if runner == "skip":
        return {**row, "status": "skip", "note": " ".join((spec.get("reason") or "").split())}
    if not tool_path.is_dir():
        return {**row, "status": "error", "note": "tool directory not found"}

    cmd, env = build_cmd(name, spec, tool_path)
    timeout = int(spec.get("timeout", timeout_default))
    started = time.monotonic()
    timed_out = False
    try:
        proc = subprocess.run(
            cmd, cwd=tool_path, env=env, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        rc, out = proc.returncode, proc.stdout
    except subprocess.TimeoutExpired as exc:
        rc, timed_out = -1, True
        out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
    except FileNotFoundError as exc:
        return {**row, "status": "error", "note": f"runner not on PATH: {exc.filename}",
                "duration_s": round(time.monotonic() - started, 1)}

    status, note = classify(runner, rc, out, timed_out)
    return {
        **row,
        "status": status,
        "note": note,
        "exit_code": rc,
        "duration_s": round(time.monotonic() - started, 1),
        "counts": parse_counts(runner, out),
        "cmd": " ".join(cmd),
        "output_tail": "" if status == "ok" else tail(out),
    }


def render_table(report: dict) -> str:
    glyph = {"ok": "PASS", "fail": "FAIL", "error": "ERROR", "skip": "skip"}
    width = max((len(r["suite"]) for r in report["suites"]), default=10)
    lines = []
    for r in report["suites"]:
        c = r.get("counts") or {}
        summary = ", ".join(f"{v} {k}" for k, v in sorted(c.items())) or r.get("note", "")
        if c and r.get("note"):
            summary += f" — {r['note']}"
        dur = f"{r.get('duration_s', 0):>6.1f}s" if r["status"] != "skip" else "       "
        lines.append(f"{glyph[r['status']]:<5} {r['suite']:<{width}} {dur}  {summary}")
    s = report["summary"]
    lines.append("")
    lines.append(
        f"{s['ok']} ok, {s['fail']} failed, {s['error']} errored, {s['skip']} skipped "
        f"of {s['total']} suites in {s['duration_s']}s"
    )
    for d in report.get("drift", []):
        lines.append(f"DRIFT  {d['tool']} has {len(d['files'])} first-party test file(s) "
                     f"and is not in suites.yaml — e.g. {d['files'][0]}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Run every first-party tool test suite.")
    ap.add_argument("--manifest", default=str(TOOL_DIR / "suites.yaml"))
    ap.add_argument("--only", action="append", default=[], metavar="SUITE")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check-drift", action="store_true",
                    help="only verify the roster covers every first-party suite")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ap.add_argument("--no-write", action="store_true", help="do not write reports/")
    args = ap.parse_args()

    manifest = load_manifest(Path(args.manifest))
    suites = manifest["suites"]

    listed = {name for name in suites} | {s.get("dir", n) for n, s in suites.items()}
    drift = [
        {"tool": tool, "files": sorted(files)}
        for tool, files in sorted(first_party_test_files(manifest).items())
        if tool not in listed
    ]

    if args.check_drift:
        if drift:
            for d in drift:
                print(f"DRIFT  {d['tool']}: {len(d['files'])} first-party test file(s) "
                      f"not covered by suites.yaml")
                for f in d["files"][:5]:
                    print(f"         {f}")
            return 2
        print(f"roster ok — {len(suites)} suites registered, no unlisted first-party tests")
        return 0

    selected = {n: s for n, s in suites.items() if not args.only or n in args.only}
    if args.only and not selected:
        print(f"no suite matched {args.only}", file=sys.stderr)
        return 1

    started = time.monotonic()
    rows = [run_suite(n, s, args.timeout) for n, s in selected.items()]
    rows.sort(key=lambda r: ({"fail": 0, "error": 1, "ok": 2, "skip": 3}[r["status"]], r["suite"]))

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "suites": rows,
        "drift": drift,
        "summary": {
            "total": len(rows),
            "ok": sum(r["status"] == "ok" for r in rows),
            "fail": sum(r["status"] == "fail" for r in rows),
            "error": sum(r["status"] == "error" for r in rows),
            "skip": sum(r["status"] == "skip" for r in rows),
            "drift": len(drift),
            "duration_s": round(time.monotonic() - started, 1),
        },
    }

    if not args.no_write:
        out_dir = TOOL_DIR / "reports"
        out_dir.mkdir(exist_ok=True)
        (out_dir / "latest.json").write_text(json.dumps(report, indent=2) + "\n")
        with (out_dir / "history.jsonl").open("a") as fh:
            fh.write(json.dumps({"generated_at": report["generated_at"],
                                 **report["summary"]}) + "\n")

    print(json.dumps(report, indent=2) if args.json else render_table(report))
    return 1 if (report["summary"]["fail"] or report["summary"]["error"]) else 0


if __name__ == "__main__":
    sys.exit(main())
