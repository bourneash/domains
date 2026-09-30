"""Regression checks for the SEO analyst turn-budget contract."""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def _explicit_seo_blocks(text: str):
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == "seo-analyst)" or '[[ "$ROLE" == "seo-analyst" ]]' in line:
            block = []
            for candidate in lines[index : index + 24]:
                if block and (candidate.strip() == ";;" or candidate.strip() == "else"):
                    break
                block.append(candidate)
            yield "\n".join(block)


def test_seo_role_contract_and_launcher_caps_are_consistent():
    role_files = sorted((ROOT / "sites").glob("*/ops/roles/seo-analyst.md"))
    assert role_files, "no installed SEO analyst roles found"

    for role_file in role_files:
        role_text = role_file.read_text(encoding="utf-8")
        assert role_text.strip(), role_file
        launcher = role_file.parents[2] / "ops" / "scripts" / "run-role.sh"
        assert launcher.exists(), launcher
        launcher_text = launcher.read_text(encoding="utf-8")

        # Explicit SEO branches must reserve the contract's commit turn. Other
        # roles in the same launcher may legitimately use a 15-turn cap.
        for block in _explicit_seo_blocks(launcher_text):
            caps = [int(value) for value in re.findall(r"--max-turns(?:=|\s+)(\d+)", block)]
            assert caps and min(caps) >= 20, f"{launcher}: SEO branch cap is {caps}"

        # Generic dispatchers use a shared default. Reject a low hard-coded
        # default even when there is no named SEO branch to inspect.
        if not list(_explicit_seo_blocks(launcher_text)):
            defaults = [int(value) for value in re.findall(r"MAX_TURNS(?:=|:-)(\d+)", launcher_text)]
            assert (defaults and max(defaults) >= 20) or "claude-tracked.sh" in launcher_text, (
                f"{launcher}: no safe generic turn default or shared wrapper"
            )


def test_canonical_seo_archetype_declares_budget_and_checkpoint():
    meta = (ROOT / "tools/cron-roles/archetypes/seo-analyst/meta.yml").read_text(encoding="utf-8")
    template = (ROOT / "tools/cron-roles/archetypes/seo-analyst/role.md.tmpl").read_text(encoding="utf-8")
    assert re.search(r"^max_turns:\s*20\b", meta, re.MULTILINE)
    assert "Turn-budget checkpoint" in template
    assert "turn 12" in template
    assert "turn 18" in template
