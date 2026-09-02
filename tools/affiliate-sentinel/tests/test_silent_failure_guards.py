"""Regression tests for the three ways this tool reported success while dead.

All three were live simultaneously: the nightly sweep crashed on `import httpx`
for every site across at least three days, logged `rc=0` for each, and alerted
nobody. These tests exist so none of the three can come back quietly.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent


def _run(script: str, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(TOOL / script), *args],
        capture_output=True, text=True, timeout=120,
        env={**os.environ, **(env or {})},
    )


class TestInterpreterResolution:
    """Failure 1: `python3` meant different interpreters to cron and to a shell."""

    def test_resolves_under_crons_stripped_path(self):
        # cron sets no PATH, so /usr/bin/python3 wins — the interpreter that
        # never had httpx. The resolver must not care.
        r = subprocess.run(
            ["bash", str(TOOL / "bin" / "ensure-venv")],
            capture_output=True, text=True, timeout=60,
            env={"PATH": "/usr/bin:/bin"},
        )
        assert r.returncode == 0, f"resolver failed under cron PATH: {r.stderr}"
        assert Path(r.stdout.strip()).exists()

    def test_resolved_interpreter_can_import_deps(self):
        r = _run("bin/ensure-venv")
        assert r.returncode == 0
        py = r.stdout.strip()
        check = subprocess.run([py, "-c", "import httpx"], capture_output=True, timeout=60)
        assert check.returncode == 0, "resolver returned a python that cannot import httpx"

    def test_fails_loudly_when_nothing_usable(self, tmp_path):
        # A resolver that silently falls back to a broken interpreter is the
        # original bug. Point it at a copy with no .venv and no python on PATH:
        # it must exit non-zero and name the fix, never print a bad interpreter.
        fake = tmp_path / "affiliate-sentinel"
        (fake / "bin").mkdir(parents=True)
        (fake / "bin" / "ensure-venv").write_bytes((TOOL / "bin" / "ensure-venv").read_bytes())
        # PATH keeps /bin so `bash` resolves, but no python3 lives there.
        # Realistic hostile case: cron's own PATH (coreutils present, pyenv
        # absent) against a tool dir with no .venv — i.e. exactly the state the
        # fleet was in, where /usr/bin/python3 exists but cannot import httpx.
        r = subprocess.run(
            ["/bin/bash", str(fake / "bin" / "ensure-venv")],
            capture_output=True, text=True, timeout=60,
            env={"PATH": "/usr/bin:/bin"},
        )
        assert r.returncode != 0, f"must fail, got stdout={r.stdout!r}"
        assert "FATAL" in r.stderr
        assert "setup-venv" in r.stderr, "error must name the fix"
        assert r.stdout.strip() == "", "must not print an unusable interpreter"

    def test_resolver_survives_a_stripped_path(self, tmp_path):
        # It must be able to report a broken PATH without depending on binaries
        # that a broken PATH removes (dirname, cat). Builtins only.
        fake = tmp_path / "affiliate-sentinel"
        (fake / "bin").mkdir(parents=True)
        (fake / "bin" / "ensure-venv").write_bytes((TOOL / "bin" / "ensure-venv").read_bytes())
        empty = tmp_path / "empty"
        empty.mkdir()
        r = subprocess.run(
            ["/bin/bash", str(fake / "bin" / "ensure-venv")],
            capture_output=True, text=True, timeout=60, env={"PATH": str(empty)},
        )
        assert r.returncode != 0
        assert "FATAL" in r.stderr, f"lost its own error message: {r.stderr!r}"
        assert "command not found" not in r.stderr


class TestExitCodeCapture:
    """Failure 2: `echo \"[$(date)] (rc=$?)\"` logged date's status, not the job's."""

    def test_command_substitution_clobbers_dollar_question(self):
        # The bug itself, pinned. If this ever stops being true the guard below
        # is unnecessary — but it is true in every POSIX shell.
        r = subprocess.run(
            ["bash", "-c", 'false; echo "[$(date -Iseconds)] rc=$?"'],
            capture_output=True, text=True, timeout=30,
        )
        assert "rc=0" in r.stdout, "the masking bug should reproduce"

    def test_run_fleet_captures_rc_before_anything_else(self):
        src = (TOOL / "run-fleet.sh").read_text()
        assert "\n    rc=$?\n" in src, "rc must be captured on its own line"
        assert "(rc=$rc)" in src, "the log line must use the captured variable"
        # No EXECUTABLE line may read a live $? alongside a command
        # substitution. Comments are exempt — one documents the bug on purpose.
        offenders = [
            ln for ln in src.splitlines()
            if not ln.lstrip().startswith("#") and "$?" in ln and "$(" in ln
        ]
        assert not offenders, f"live $? beside a command substitution: {offenders}"

    def test_run_fleet_aggregates_and_alerts(self):
        src = (TOOL / "run-fleet.sh").read_text()
        assert "INFRA_FAILURES" in src
        assert "alert_fleet" in src
        assert "checked 0 sites" in src, "an all-skipped sweep must alert too"


class TestZeroProductGuard:
    """Failure 3: a registry that parsed to nothing reported '0 cloaks OK'."""

    def test_sentinel_refuses_to_report_green_on_empty_parse(self):
        src = (TOOL / "sentinel.py").read_text()
        assert "parsed to ZERO products" in src
        # Must exit 3 (infrastructure), which run-fleet.sh escalates.
        idx = src.index("parsed to ZERO products")
        assert "return 3" in src[idx : idx + 1500], "empty parse must exit 3, not 0"

    def test_per_site_runner_propagates_infrastructure_failures(self):
        src = (TOOL / "run-affiliate-sentinel.sh").read_text()
        assert "exit 3" in src, "infra failures must not be flattened to 0"
        assert 'exec "$PYTHON"' in src, "must use the resolved interpreter"
        assert "exec python3" not in src, "ambient python3 is the original bug"


class TestTransientNotPermanent:
    """403 is TRANSIENT here — same creds succeeded at 06:17 and failed at 18:26
    the same day — so it must be retried, not recorded as a verdict."""

    def test_403_retried_like_429(self):
        src = (TOOL / "amz.py").read_text()
        assert 'in (429, 403)' in src, "403 must be retried, not treated as final"


class TestApiOutageIsNotAPass:
    """Failure 4: every ASIN check returning 403 still posted a green ✅.

    PA-API answered `403 Your account does not currently meet the eligibility
    requirements` for every call, fleet-wide. The tool reported "0/16 ASINs
    live, 23 cloaks OK" with a checkmark — which reads as "checked, all fine"
    rather than "checked nothing".
    """

    def test_all_errors_sets_api_error(self):
        src = (TOOL / "sentinel.py").read_text()
        assert "len(errored) == len(health)" in src, "must detect a total API failure"
        idx = src.index("len(errored) == len(health)")
        window = src[idx : idx + 700]
        assert "api_error =" in window, "a total failure must set api_error"
        assert "health = {}" in window, "must not report health it never obtained"

    def test_api_error_routes_away_from_the_clean_verdict(self):
        src = (TOOL / "sentinel.py").read_text()
        # The clean/✅ branch must be unreachable while api_error is set.
        assert "or api_error or" in src, "api_error must gate the clean verdict"

    def test_warning_names_the_count_and_the_reason(self):
        src = (TOOL / "sentinel.py").read_text()
        assert "ASIN(s) UNCHECKED" in src, "must say what went unchecked"
        assert "{api_error}" in src, "must surface the API's own message"

    def test_api_error_note_carries_the_message_not_just_a_status(self):
        src = (TOOL / "amz.py").read_text()
        assert 'f"API error {status}: {detail}"' in src, (
            "a bare status code cannot distinguish an eligibility revocation "
            "from a bad key"
        )
