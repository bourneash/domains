import sys
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
