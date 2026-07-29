import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import resolve  # noqa: E402

PRODUCT = {
    "id": "widget",
    "name": "Widget",
    "brand": "WidgetCo",
    "category": "hard-jerks",
    "price": "$9.99",
    "asin": "B00WIDGET1",
    "searchQuery": "widget jerkbait",
    "blurb": "The widget you need.",
    "campaignOnly": False,
}
EVIDENCE = {"go_url": "https://totaljerks.com/go/widget/", "body": "currently unavailable"}
RESOLUTION_CFG = {"max_search_attempts": 3, "max_agent_turns": 20, "model": "claude-sonnet-4-6"}


def test_build_prompt_includes_budget_and_product_facts():
    prompt = resolve.build_prompt(
        PRODUCT, EVIDENCE, "oos", RESOLUTION_CFG, Path("/tmp/site"), "totaljerks.com"
    )
    assert "widget" in prompt
    assert "hard-jerks" in prompt
    assert "3 search attempt" in prompt
    assert "oos" in prompt
    assert ".deploy-needed" in prompt
    assert "notify-slack.sh" in prompt


def test_resolve_product_invokes_claude_with_turn_cap():
    with mock.patch("resolve.subprocess.run") as mock_run:
        mock_run.return_value = mock.Mock(returncode=0, stdout="done", stderr="")
        code = resolve.resolve_product(
            PRODUCT, EVIDENCE, "oos", RESOLUTION_CFG, Path("/tmp/site"), "totaljerks.com",
            log_path=Path("/tmp/resolve-test.log"),
        )
    assert code == 0
    args = mock_run.call_args.args[0]
    assert args[0] == "claude"
    assert "--max-turns" in args
    assert "20" in args
    assert "--model" in args
    assert "claude-sonnet-4-6" in args
    # Without this, headless -p mode has no TTY to approve Bash/tool calls
    # under the worker's acceptEdits-only default permission mode -- every
    # other role in this fleet passes it (run-role.sh's generic dispatch)
    # for exactly this reason. Its absence here is the likely root cause of
    # the totaljerks pilot's first real run: 5 of 6 resolution agents burned
    # their full turn budget without completing anything durable.
    assert "--dangerously-skip-permissions" in args


def test_file_fallback_unresolved_writes_task_when_missing():
    site_dir = Path(tempfile.mkdtemp())
    task_path = resolve.file_fallback_unresolved(PRODUCT, EVIDENCE, "oos", site_dir, "2026-07-29")
    assert task_path == site_dir / "ops" / "tasks" / "backlog" / "2026-07-29-affiliate-issue-widget.md"
    assert task_path.exists()
    text = task_path.read_text()
    assert "widget" in text
    assert "oos" in text
    assert "type: content" in text


def test_file_fallback_unresolved_is_idempotent():
    """If the killed agent already managed to write its own task file (just
    didn't commit it), the fallback must leave that content alone rather
    than clobbering it with a generic version."""
    site_dir = Path(tempfile.mkdtemp())
    task_path = site_dir / "ops" / "tasks" / "backlog" / "2026-07-29-affiliate-issue-widget.md"
    task_path.parent.mkdir(parents=True)
    task_path.write_text("agent's own version\n")

    result = resolve.file_fallback_unresolved(PRODUCT, EVIDENCE, "oos", site_dir, "2026-07-29")

    assert result == task_path
    assert task_path.read_text() == "agent's own version\n"
