#!/usr/bin/env python3
"""Dispatch-aware fleet AI-usage inventory.

The cron entry identifies a role, but not necessarily the program that performs
it.  This scanner follows the common run-role.sh dispatch conventions before it
classifies a role.  That distinction matters: engineers and watchdogs only call
Claude conditionally, local writers call Ollama, and several deployer roles now
dispatch to deterministic deploy.sh scripts with no model call at all.

Usage:
    python3 tools/ai-inventory/audit-ai.py
    python3 tools/ai-inventory/audit-ai.py --json
    python3 tools/ai-inventory/audit-ai.py --root /path/to/domains --json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2]
ROLE_IN_CRON = re.compile(r"run-(?:worker|role)\.sh\s+([a-z][a-z0-9-]+)")
WATCHDOG_IN_CRON = re.compile(r"(?:^|[ /])run-watchdog\.sh(?:\s|$)")
DEPLOYER_IN_CRON = re.compile(r"(?:^|[ /])run-deployer\.sh(?:\s|$)")
# `claude-tracked.sh` is the canonical production invocation.  Keep accepting
# the raw CLI spelling so this inventory also flags legacy/unmigrated scripts.
CLAUDE_CALL = re.compile(r"(?:\bclaude\s+-p\b|CLAUDE_TRACKED)")
LOCAL_CALL = re.compile(r"(?:ollama|11434|LOCAL_LLM|BSG_LLM|chat\.completions|SINDERELLA_LLM|vllm)", re.I)
MODEL_LITERAL = re.compile(r'^\s*(?:export\s+)?(?:MODEL|WRITER_MODEL|SCORER_MODEL)="([^"$]+)"', re.M)
MODEL_DEFAULT = re.compile(r'(?:MODEL|WRITER_MODEL)="\$\{[A-Z0-9_]+:-([^}]+)\}"')
CASE_MODEL = lambda role: re.compile(
    rf'^\s*{re.escape(role)}\)[^\n]*?MODEL="([^"]*)"', re.M
)

PURPOSES = {
    "planner": "Reviews goals and metrics, then prioritizes or creates backlog work.",
    "seo-analyst": "Reviews search/traffic data and creates SEO improvements.",
    "content-writer": "Researches, writes, validates, and queues site content.",
    "news-writer": "Researches and publishes source-grounded news content.",
    "news-writer-local": "Drafts source-grounded news with a local model and grounding gates.",
    "breaking-news": "Checks story thresholds and invokes a writer only for qualifying news.",
    "weekly-editorial": "Performs weekly editorial review and long-form planning/work.",
    "affiliate-editor": "Audits affiliate redirects/products and files or applies fixes.",
    "affiliate-ops": "Performs affiliate catalog and operational maintenance.",
    "engineer": "Runs deterministic health checks, invoking AI only for repair or queued work.",
    "watchdog": "Runs deterministic incident checks, invoking AI only for eligible repairs.",
    "deployer": "Builds, pushes, and smoke-tests a deployment.",
    "page-designer": "Improves site and page presentation from the role brief.",
    "image-backfill": "Finds and attaches suitable imagery to content missing images.",
    "social-media": "Drafts or queues social-media copy.",
    "social-poster": "Publishes queued social content through deterministic platform clients.",
    "monthly-update": "Performs a monthly content or catalog refresh.",
    "brief-builder": "Builds the daily signal brief and synthesizes selected inputs.",
    "reading-generator": "Generates daily persona-voiced horoscope readings.",
    "signal-writer": "Generates the daily multi-sign Signal content package.",
    "voice-auditor": "Reviews generated content against the site's voice rules.",
    "scrape": "Collects source data without generative AI.",
}
DETERMINISTIC_ROLES = {"scrape", "social-poster", "fetch-data", "smoke", "smoke-tester", "update-board"}


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def yaml_env(text: str, name: str) -> str | None:
    match = re.search(rf'^\s*{re.escape(name)}:\s*["\']?([^"\'\s#]+)', text, re.M)
    return match.group(1) if match else None


def site_roles(site: Path) -> list[str]:
    roles: list[str] = []
    for crontab in sorted(site.glob("ops/docker/crontab*")):
        for raw in read(crontab).splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            match = ROLE_IN_CRON.search(line)
            role = match.group(1) if match else (
                "watchdog" if WATCHDOG_IN_CRON.search(line) else
                "deployer" if DEPLOYER_IN_CRON.search(line) else None
            )
            if role and role not in roles:
                roles.append(role)
    return roles


def disabled_flag(site: Path, role: str) -> str | None:
    exact = site / "ops" / f".{role}-disabled"
    if exact.exists():
        return exact.name
    # Known historical naming drift. Report the actual flag so the dashboard
    # makes the ambiguity visible instead of silently calling the role enabled.
    aliases = {"affiliate-editor": [".affiliate-disabled"]}
    for name in aliases.get(role, []):
        if (site / "ops" / name).exists():
            return name
    return None


def model_from_text(text: str, role: str | None = None) -> str | None:
    if role:
        match = CASE_MODEL(role).search(text)
        if match:
            raw = match.group(1).strip()
            if raw:
                default = re.fullmatch(r"\$\{[A-Z0-9_]+:-([^}]+)\}", raw)
                return default.group(1) if default else raw
            return "Claude CLI default (unpinned)"
    match = MODEL_LITERAL.search(text) or MODEL_DEFAULT.search(text)
    return match.group(1).strip() if match else None


def result(provider: str, model: str, dispatch: str, source: Path,
           note: str = "", conditional: bool = False) -> dict:
    policy = "Local" if provider in {"Ollama", "vLLM", "IOPaint"} else (
        "Remote" if provider != "None" else "no-AI"
    )
    return {
        "provider": provider, "model": model, "policy": policy,
        "dispatch": dispatch, "source": str(source), "conditional": conditional,
        "note": note,
    }


def resolve(site: Path, role: str) -> dict:
    scripts = site / "ops" / "scripts"
    run_role_path = scripts / "run-role.sh"
    run_role = read(run_role_path)
    compose = read(site / "docker-compose.yml")

    if role in DETERMINISTIC_ROLES:
        return result("None", "—", "deterministic role", run_role_path,
                      "The scheduled path contains no generative model call.")

    # Dedicated dispatchers take precedence over generic run-role model cases.
    dedicated = scripts / f"run-{role}.sh"
    dedicated_text = read(dedicated)
    if role == "watchdog":
        repair = scripts / "watchdog.sh"
        repair_text = read(repair)
        if CLAUDE_CALL.search(repair_text):
            model = model_from_text(repair_text) or "claude-sonnet-4-6"
            return result("Anthropic / Claude Code CLI", model, repair.name, repair,
                          "Zero-token healthy tick; model is invoked only for an eligible incident.", True)
        return result("None", "—", dedicated.name, dedicated,
                      "No reachable watchdog repair-model call found.")
    if role == "engineer" and dedicated_text:
        model = model_from_text(dedicated_text) or "Claude CLI default (unpinned)"
        return result("Anthropic / Claude Code CLI", model, dedicated.name, dedicated,
                      "Zero-token healthy tick; model is invoked only when work is found.", True)

    if role == "news-writer-local" and dedicated_text:
        model = yaml_env(compose, "LOCAL_LLM_MODEL") or model_from_text(dedicated_text) or "glm-4.7-flash:latest"
        return result("Ollama", model, dedicated.name, dedicated)

    if role == "update" and dedicated_text and CLAUDE_CALL.search(dedicated_text):
        model = yaml_env(compose, "WRITER_MODEL") or model_from_text(dedicated_text) or "Claude CLI default (unpinned)"
        return result("Anthropic / Claude Code CLI", model, dedicated.name, dedicated,
                      "Creative-writing pass inside a mostly deterministic pipeline.", True)

    if role == "breaking-news" and dedicated_text:
        model = model_from_text(dedicated_text) or "Claude CLI default (unpinned)"
        return result("Anthropic / Claude Code CLI", model, dedicated.name, dedicated,
                      "Threshold and dedup gates run before the model.", True)

    # Broadway persona writers use a shared client selected by compose config.
    if role in {"write-carmen", "write-priya", "write-imani"}:
        backend = yaml_env(compose, "BSG_LLM_BACKEND") or "local"
        if backend.startswith("claude"):
            model = backend.removeprefix("claude-")
            return result("Anthropic / Claude Code CLI", model, "ops/llm/client.py",
                          site / "ops/llm/client.py")
        model = yaml_env(compose, "BSG_LLM_MODEL") or "qwen2.5:32b"
        return result("Ollama", model, "ops/llm/client.py", site / "ops/llm/client.py")

    # Sinderella's Python content roles dispatch to its local vLLM client.
    if role in {"brief-builder", "reading-generator", "signal-writer", "tea-writer"}:
        client = site / "ops/llm/client.py"
        text = read(client)
        match = re.search(r'^DEFAULT_MODEL\s*=\s*["\']([^"\']+)', text, re.M)
        model = match.group(1) if match else "local model (unresolved)"
        return result("vLLM", model, "Python local-LLM module", client)

    # Explicit run-role dispatch to deploy.sh is deterministic. This check must
    # precede the run-role case MODEL entry because some migrated scripts retain
    # a now-unreachable deployer model assignment.
    if role == "deployer" and re.search(
        r'if\s+\[\[\s+"\$ROLE"\s+==\s+"deployer"[\s\S]{0,700}?bash\s+"?\$REPO_ROOT/ops/scripts/deploy\.sh',
        run_role,
    ):
        return result("None", "—", "deploy.sh", scripts / "deploy.sh",
                      "Deterministic build/push/smoke dispatch.")
    if role == "deployer" and dedicated_text and not CLAUDE_CALL.search(dedicated_text):
        return result("None", "—", dedicated.name, dedicated,
                      "Cron-direct deterministic deploy/build/smoke runner.")

    # A dedicated script with a model call is authoritative for other roles.
    if dedicated_text and CLAUDE_CALL.search(dedicated_text):
        model = model_from_text(dedicated_text) or "Claude CLI default (unpinned)"
        conditional = role == "watchdog"
        return result("Anthropic / Claude Code CLI", model, dedicated.name, dedicated,
                      "Model is incident-gated." if conditional else "", conditional)
    if dedicated_text and LOCAL_CALL.search(dedicated_text) and not CLAUDE_CALL.search(dedicated_text):
        model = yaml_env(compose, "LOCAL_LLM_MODEL") or "local model (unresolved)"
        return result("Ollama", model, dedicated.name, dedicated)

    # Generic role path. Only classify it as remote when run-role actually has
    # a Claude call; missing runners and deterministic roles remain visible.
    if CLAUDE_CALL.search(run_role):
        model = model_from_text(run_role, role) or "Claude CLI default (unpinned)"
        return result("Anthropic / Claude Code CLI", model, "run-role.sh", run_role_path)

    return result("None", "—", "unresolved", run_role_path,
                  "No reachable model call found; runner may be missing or deterministic.")


def collect(root: Path = DEFAULT_ROOT) -> list[dict]:
    rows: list[dict] = []
    sites = root / "sites"
    if not sites.is_dir():
        return rows
    for site in sorted(p for p in sites.iterdir() if p.is_dir()):
        for role in site_roles(site):
            resolved = resolve(site, role)
            flag = disabled_flag(site, role)
            rows.append({
                "domain": site.name,
                "service": role,
                "purpose": PURPOSES.get(role, f"Executes the {role} role brief."),
                "status": "DISABLED" if flag else "enabled",
                "disabled_flag": flag,
                **resolved,
            })
    return rows


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args(argv)
    rows = collect(args.root.resolve())
    if args.json:
        print(json.dumps(rows, indent=2))
        return
    print("| ID | Domain | Service | Provider | Local/Remote | Model | Status | Function |")
    print("|---:|---|---|---|---|---|---|---|")
    for index, row in enumerate(rows, 1):
        note = f" — {row['note']}" if row["note"] else ""
        status = "**DISABLED**" if row["status"] == "DISABLED" else "enabled"
        print(f"| {index} | {row['domain']} | {row['service']} | {row['provider']} | "
              f"{row['policy']} | {row['model']} | {status} | {row['purpose']}{note} |")
    ai = sum(row["provider"] != "None" for row in rows)
    print(f"\n_{len(rows)} scheduled services; {ai} AI-backed and {len(rows) - ai} deterministic/unresolved._")


if __name__ == "__main__":
    main()
