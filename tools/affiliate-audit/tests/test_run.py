import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402

CFG = {
    "checks": {
        "prime_required": True,
        "min_rating": 4.0,
        "oos_grace_runs": 2,
        "dead_grace_runs": 1,
        "broken_redirect_grace_runs": 1,
        "no_prime_grace_runs": 2,
        "low_rating_grace_runs": 2,
        "inconclusive_grace_runs": 3,
    },
    "pacing": {"min_delay_s": 0, "max_delay_s": 0},
    "resolution": {"max_search_attempts": 3, "max_agent_turns": 20, "model": "claude-sonnet-4-6"},
    "slack": {"channel_env": "SLACK_CHANNEL_TOTALJERKS", "channel_default": None},
}

PRODUCTS = [
    {"id": "healthy-one", "name": "Healthy", "brand": "B", "category": "hard-jerks",
     "price": "$1", "asin": "B001", "searchQuery": "healthy", "blurb": "fine",
     "campaignOnly": False},
    {"id": "dead-one", "name": "Dead", "brand": "B", "category": "hard-jerks",
     "price": "$1", "asin": "B002", "searchQuery": "dead", "blurb": "gone",
     "campaignOnly": False},
]


def test_run_once_resolves_actionable_and_skips_healthy():
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state") as mock_save_state, \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.notify_summary") as mock_notify:
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_resolve.assert_called_once()
    resolved_product = mock_resolve.call_args.args[0]
    assert resolved_product["id"] == "dead-one"
    mock_save_state.assert_called_once()
    mock_notify.assert_called_once()


def test_run_once_dry_run_never_resolves():
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product") as mock_resolve, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=True, today="2026-07-15")

    mock_resolve.assert_not_called()


def test_run_once_recheck_confirms_flagged_verdict_stays_flagged():
    fake_page = object()
    first_pass = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    # recheck confirms dead-one is still broken
    recheck_evidence = {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                         "rating": None, "redirect_ok": True}

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: first_pass[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=recheck_evidence) as mock_recheck, \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    # recheck only called for the flagged product, not the healthy one
    mock_recheck.assert_called_once()
    assert mock_recheck.call_args.args[0]["id"] == "dead-one"
    # resolution still fires, using the recheck-confirmed verdict
    mock_resolve.assert_called_once()


def test_run_once_recheck_clears_false_positive():
    fake_page = object()
    first_pass = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "currently unavailable", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    # recheck comes back healthy -- first pass was a session artifact
    recheck_evidence = {"go_url": "y", "body": "buy now. " * 25, "prime": True, "rating": 4.9, "redirect_ok": True}

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: first_pass[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=recheck_evidence) as mock_recheck, \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_recheck.assert_called_once()
    # cleared by the recheck -- never sent to resolution
    mock_resolve.assert_not_called()


def test_notify_summary_all_clear_uses_check_emoji():
    with mock.patch("run.subprocess.run") as mock_run:
        run.notify_summary(Path("/tmp/site"), "totaljerks.com", CFG, {"healthy": 5, "flagged": 0, "resolving": 0}, [])
    text = mock_run.call_args.args[0][-2]
    color = mock_run.call_args.args[0][-1]
    assert text.startswith("✅")
    assert color == run.COLOR_CLEAR


def test_notify_summary_dead_verdict_uses_critical_emoji_and_bullets():
    flagged = [{"id": "widget", "verdict": "dead", "go_url": "https://x/go/widget/", "task_path": "ops/tasks/backlog/x.md"}]
    with mock.patch("run.subprocess.run") as mock_run:
        run.notify_summary(Path("/tmp/site"), "totaljerks.com", CFG, {"healthy": 4, "flagged": 1, "resolving": 1}, flagged)
    text = mock_run.call_args.args[0][-2]
    color = mock_run.call_args.args[0][-1]
    assert text.startswith("\U0001f6a8")
    assert "https://x/go/widget/" in text
    assert "ops/tasks/backlog/x.md" in text
    assert color == run.COLOR_CRITICAL


def test_notify_summary_non_dead_flag_uses_warning_emoji():
    flagged = [{"id": "widget", "verdict": "inconclusive", "go_url": "https://x/go/widget/"}]
    with mock.patch("run.subprocess.run") as mock_run:
        run.notify_summary(Path("/tmp/site"), "totaljerks.com", CFG, {"healthy": 4, "flagged": 1, "resolving": 1}, flagged)
    text = mock_run.call_args.args[0][-2]
    color = mock_run.call_args.args[0][-1]
    assert text.startswith("⚠️")
    assert color == run.COLOR_WARN


def test_run_once_files_fallback_when_resolution_agent_fails():
    """Regression test for the totaljerks pilot's first real run: 5 of 6
    resolution agents hit max_agent_turns and exited non-zero, and nothing
    downstream ever noticed -- no task, no commit, no Slack line. A failed
    agent must trigger the deterministic fallback filer."""
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=evidence_by_id["dead-one"]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run._commit_and_push") as mock_commit, \
         mock.patch("run.resolve.resolve_product", return_value=1) as mock_resolve, \
         mock.patch("run.resolve.file_fallback_unresolved", return_value=Path("/tmp/site/ops/tasks/backlog/x.md")) as mock_fallback, \
         mock.patch("run.notify_summary") as mock_notify:
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_resolve.assert_called_once()
    mock_fallback.assert_called_once()
    assert mock_fallback.call_args.args[0]["id"] == "dead-one"
    mock_commit.assert_called_once()
    flagged_items = mock_notify.call_args.args[4]
    assert flagged_items[0]["task_path"]


def test_run_once_no_fallback_when_resolution_agent_succeeds():
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=evidence_by_id["dead-one"]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run._commit_and_push"), \
         mock.patch("run.resolve.resolve_product", return_value=0) as mock_resolve, \
         mock.patch("run.resolve.file_fallback_unresolved") as mock_fallback, \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_resolve.assert_called_once()
    mock_fallback.assert_not_called()


def test_run_once_escalates_persistent_inconclusive_without_llm():
    """3rd consecutive inconclusive (500/anti-bot) must be filed as a task
    deterministically -- resolve_product (the LLM path) must NOT be called,
    since there's no replacement decision to make for an unconfirmed issue."""
    fake_page = object()
    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8,
                         "redirect_ok": True, "status": 200, "asin": "B001"},
        "dead-one": {"go_url": "y", "body": "Internal Server Error", "prime": None,
                     "rating": None, "redirect_ok": True, "status": 500, "asin": "B002"},
    }
    existing_state = {"dead-one": {"issue": "inconclusive", "consecutive_runs": 2,
                                    "first_seen": "2026-07-01", "last_checked": "2026-07-08"}}

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(mock.Mock(), fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.recheck_product", return_value=evidence_by_id["dead-one"]), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value=existing_state), \
         mock.patch("run.state.save_state"), \
         mock.patch("run._commit_and_push") as mock_commit, \
         mock.patch("run.resolve.resolve_product") as mock_resolve, \
         mock.patch("run.resolve.file_persistent_inconclusive", return_value=Path("/tmp/site/ops/tasks/backlog/x.md")) as mock_file, \
         mock.patch("run.notify_summary") as mock_notify:
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    mock_resolve.assert_not_called()
    mock_file.assert_called_once()
    assert mock_file.call_args.args[0]["id"] == "dead-one"
    mock_commit.assert_called_once()
    flagged_items = mock_notify.call_args.args[4]
    assert flagged_items[0]["task_path"]


def test_run_once_closes_main_context_before_any_recheck():
    """Regression test for the Playwright Sync API concurrent-session crash:
    the main sweep's browser context must be closed before recheck_product
    (which opens its own separate Playwright session) is ever called."""
    fake_page = object()
    fake_ctx = mock.Mock()
    call_order = []

    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now. " * 25, "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    recheck_evidence = {"go_url": "y", "body": "Sorry! We couldn't find that page", "prime": None,
                         "rating": None, "redirect_ok": True}

    def record_close():
        call_order.append("ctx.close")

    def record_recheck(product, base, pacing):
        call_order.append("recheck_product")
        return recheck_evidence

    fake_ctx.close.side_effect = record_close

    with mock.patch("run.discover_products", return_value=PRODUCTS), \
         mock.patch("run.checker.launch_browser", return_value=(fake_ctx, fake_page)), \
         mock.patch("run.checker.check_product", side_effect=lambda page, base, product, pacing: evidence_by_id[product["id"]]), \
         mock.patch("run.checker.recheck_product", side_effect=record_recheck), \
         mock.patch("run.checker.pace"), \
         mock.patch("run.state.load_state", return_value={}), \
         mock.patch("run.state.save_state"), \
         mock.patch("run.resolve.resolve_product", return_value=0), \
         mock.patch("run.notify_summary"):
        run.run_once(Path("/tmp/site"), "totaljerks.com", CFG, dry_run=False, today="2026-07-15")

    assert call_order == ["ctx.close", "recheck_product"], (
        f"main context must close before any recheck_product call, got order: {call_order}"
    )
