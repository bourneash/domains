"""Regression contracts for the engineer Cloudflare credential guard."""

import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
CHECK_TEMPLATE = ROOT / "archetypes/engineer/scripts/engineer-check.sh.tmpl"
RUN_TEMPLATE = ROOT / "archetypes/engineer/scripts/run-engineer.sh.tmpl"
SALTWATER_CHECK = (
    Path(__file__).parents[3]
    / "sites/saltwaternews.com/ops/scripts/engineer-check.sh"
)
SALTWATER_RUN = (
    Path(__file__).parents[3]
    / "sites/saltwaternews.com/ops/scripts/run-engineer.sh"
)


class EngineerCloudflareHardeningTest(unittest.TestCase):
    def test_check_classifies_api_failures(self):
        for path in (CHECK_TEMPLATE, SALTWATER_CHECK):
            source = path.read_text()
            for status in ("forbidden", "rate_limited", "error", "api_error"):
                self.assertIn(
                    f"CF_API_STATUS={status}",
                    source,
                    f"{path} must classify {status}",
                )
            self.assertIn("CF_API_STATUS=$CF_API_STATUS", source)
            self.assertIn('"success"[[:space:]]*:[[:space:]]*true', source)

    def test_wrapper_only_suppresses_documented_cloudflare_scope_ask(self):
        for path in (RUN_TEMPLATE, SALTWATER_RUN):
            source = path.read_text()
            self.assertIn('CF_API_STATUS" == "forbidden"', source)
            self.assertIn("Workers Scripts:Read", source)
            self.assertIn("CF API token|Cloudflare API token|Cloudflare", source)
            self.assertIn('ESCALATE="none"', source)

    def test_wrapper_preserves_explicit_api_status_in_prompt_or_status(self):
        for path in (RUN_TEMPLATE, SALTWATER_RUN):
            source = path.read_text()
            self.assertIn("CF_API_STATUS", source)
            self.assertTrue(
                "api_status=${CF_API_STATUS}" in source
                or "CF API status: ${CF_API_STATUS}" in source
            )

    def test_queued_task_budget_and_constraints_are_honored(self):
        for path in (RUN_TEMPLATE, SALTWATER_RUN):
            source = path.read_text()
            self.assertIn("estimated_turns", source)
            self.assertIn("TASK_TURNS", source)
            self.assertIn("DEFAULT_MAX_TURNS", source)
            self.assertIn("Task-specific constraints", source)


if __name__ == "__main__":
    unittest.main()
