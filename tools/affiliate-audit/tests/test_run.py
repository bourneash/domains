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
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
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
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
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
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
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
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
        "dead-one": {"go_url": "y", "body": "currently unavailable", "prime": None,
                     "rating": None, "redirect_ok": True},
    }
    # recheck comes back healthy -- first pass was a session artifact
    recheck_evidence = {"go_url": "y", "body": "buy now", "prime": True, "rating": 4.9, "redirect_ok": True}

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


def test_run_once_closes_main_context_before_any_recheck():
    """Regression test for the Playwright Sync API concurrent-session crash:
    the main sweep's browser context must be closed before recheck_product
    (which opens its own separate Playwright session) is ever called."""
    fake_page = object()
    fake_ctx = mock.Mock()
    call_order = []

    evidence_by_id = {
        "healthy-one": {"go_url": "x", "body": "buy now", "prime": True, "rating": 4.8, "redirect_ok": True},
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
