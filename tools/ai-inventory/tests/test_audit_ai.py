import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "audit-ai.py"
SPEC = importlib.util.spec_from_file_location("audit_ai", MODULE_PATH)
audit_ai = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit_ai)


class ClassifierTests(unittest.TestCase):
    def site(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        site = Path(tmp.name) / "sites" / "example.com"
        (site / "ops/scripts").mkdir(parents=True)
        (site / "ops/docker").mkdir(parents=True)
        return site

    def test_engineer_follows_dedicated_script_and_pin(self):
        site = self.site()
        (site / "ops/scripts/run-role.sh").write_text('claude -p "$PROMPT"\n')
        (site / "ops/scripts/run-engineer.sh").write_text(
            'MODEL="claude-sonnet-4-6"\nclaude -p "$PROMPT" --model "$MODEL"\n')
        row = audit_ai.resolve(site, "engineer")
        self.assertEqual(row["model"], "claude-sonnet-4-6")
        self.assertTrue(row["conditional"])

    def test_deployer_dispatch_to_bash_beats_stale_model_case(self):
        site = self.site()
        (site / "ops/scripts/run-role.sh").write_text('''
if [[ "$ROLE" == "deployer" ]]; then
  bash "$REPO_ROOT/ops/scripts/deploy.sh"
  exit 0
fi
case "$ROLE" in
  deployer) MODEL="claude-haiku-4-5-20251001" ;;
esac
claude -p "$PROMPT" --model "$MODEL"
''')
        row = audit_ai.resolve(site, "deployer")
        self.assertEqual(row["provider"], "None")
        self.assertEqual(row["dispatch"], "deploy.sh")

    def test_local_writer_uses_compose_model(self):
        site = self.site()
        (site / "docker-compose.yml").write_text('      LOCAL_LLM_MODEL: "llama3.1:8b"\n')
        (site / "ops/scripts/run-news-writer-local.sh").write_text('curl localhost:11434/api/chat\n')
        row = audit_ai.resolve(site, "news-writer-local")
        self.assertEqual((row["provider"], row["model"]), ("Ollama", "llama3.1:8b"))

    def test_broadway_backend_reports_effective_remote_alias(self):
        site = self.site()
        (site / "docker-compose.yml").write_text('      BSG_LLM_BACKEND: "claude-sonnet"\n')
        row = audit_ai.resolve(site, "write-carmen")
        self.assertEqual((row["provider"], row["model"]), ("Anthropic / Claude Code CLI", "sonnet"))

    def test_legacy_disabled_alias_is_visible(self):
        site = self.site()
        (site / "ops/.affiliate-disabled").write_text('')
        self.assertEqual(audit_ai.disabled_flag(site, "affiliate-editor"), ".affiliate-disabled")

    def test_direct_watchdog_cron_is_discovered_and_uses_repair_script(self):
        site = self.site()
        (site / "ops/docker/crontab.docker").write_text('2,17,32,47 * * * * bash ops/scripts/run-watchdog.sh\n')
        (site / "ops/scripts/run-watchdog.sh").write_text('docker compose run watchdog\n')
        (site / "ops/scripts/watchdog.sh").write_text(
            'MODEL="${WATCHDOG_MODEL:-claude-sonnet-4-6}"\nclaude -p "$PROMPT" --model "$MODEL"\n')
        self.assertEqual(audit_ai.site_roles(site), ["watchdog"])
        row = audit_ai.resolve(site, "watchdog")
        self.assertEqual(row["model"], "claude-sonnet-4-6")
        self.assertTrue(row["conditional"])


if __name__ == "__main__":
    unittest.main()
