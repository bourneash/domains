#!/usr/bin/env python3
"""audit-ai.py — fleet AI-usage inventory.

Scans every domain under sites/ and reports, ONE ROW PER SERVICE, what AI it uses:
where (domain), the service (cron role), local vs remote, the model, and enabled/disabled.

How it resolves each field (best-effort, from the actual configs — no guessing):
  - services : roles invoked in ops/docker/crontab* via `run-worker.sh <role>` / `run-role.sh <role>`
  - status   : DISABLED if ops/.<role>-disabled kill-switch file exists, else enabled
  - model    : run-role.sh `<role>) ... MODEL="x"` case; else content-backend env in
               docker-compose.yml (BSG_LLM_BACKEND / WRITER_MODEL / LOCAL_LLM_MODEL);
               else inferred from the dispatched script (claude -p vs Ollama vs neither)
  - policy   : Local (Ollama model) | Remote (claude -p subscription) | no-AI (no model call)

Usage:
    python3 tools/ai-inventory/audit-ai.py            # markdown table to stdout
    python3 tools/ai-inventory/audit-ai.py --json     # JSON rows
Run from the domains repo root (or anywhere; paths are resolved from this file).
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # .../domains
SITES = ROOT / "sites"

OLLAMA_HINT = re.compile(r"qwen|llama|glm|mistral|devstral|gemma|phi|ollama|11434|LOCAL_LLM|BSG_LLM_MODEL", re.I)
CLAUDE_HINT = re.compile(r"claude\s+-p|--model|claude-code|WRITER_MODEL|ANTHROPIC", re.I)
NOAI_ROLE = re.compile(r"^(scrape|smoke-tester|smoke|fetch-data|update-board|deploy(er)?-verify)$", re.I)
ROLE_IN_CRON = re.compile(r"run-(?:worker|role)\.sh\s+([a-z][a-z0-9-]+)")
CASE_MODEL = lambda role: re.compile(rf'^\s*{re.escape(role)}\)\s*[^\n]*MODEL="([^"]*)"', re.M)
BASH_ROLE = lambda role: re.compile(rf'ROLE"?\s*==\s*"{re.escape(role)}"')


def read(p: Path) -> str:
    try: return p.read_text(encoding="utf-8", errors="ignore")
    except OSError: return ""


def site_roles(site: Path) -> list[str]:
    roles: list[str] = []
    for ct in sorted(site.glob("ops/docker/crontab*")):
        for line in read(ct).splitlines():
            if line.lstrip().startswith("#"):
                continue
            m = ROLE_IN_CRON.search(line)
            if m and m.group(1) not in roles:
                roles.append(m.group(1))
    return roles


def resolve(site: Path, role: str) -> dict:
    rr = read(site / "ops/scripts/run-role.sh")
    compose = read(site / "docker-compose.yml")
    disabled = (site / f"ops/.{role}-disabled").exists()

    model, policy, note = None, None, ""

    # 1) explicit MODEL in run-role.sh case
    mm = CASE_MODEL(role).search(rr)
    if mm is not None:
        raw = mm.group(1).strip()
        raw = re.sub(r"\$\{[A-Za-z_]+:-([^}]+)\}", r"\1", raw)   # ${MODEL:-x} -> x
        model = raw or "default(sonnet)"
        policy = "Remote"
    # 2) content backends (bash-driven content roles)
    elif role in ("write-carmen", "write-priya", "write-imani", "write-coauthor"):
        b = re.search(r'BSG_LLM_BACKEND:\s*"([^"]+)"', compose)
        be = (b.group(1) if b else "local")
        if be.startswith("claude"):
            model, policy = "Claude " + be.split("-", 1)[-1].capitalize(), "Remote"
        else:
            mo = re.search(r'BSG_LLM_MODEL:\s*"([^"]+)"', compose)
            model, policy = (mo.group(1) if mo else "qwen2.5:32b"), "Local"
    elif role in ("update",):
        wm = re.search(r'WRITER_MODEL:\s*"([^"]+)"', compose)
        model, policy = ("Claude " + (wm.group(1).capitalize() if wm else "default")), "Remote"
        note = "news-writer (claude -p)"
    elif role == "news-writer-local":
        lm = re.search(r'LOCAL_LLM_MODEL:\s*"([^"]+)"', compose)
        model, policy = (lm.group(1) if lm else "llama3.1:8b"), "Local"
    # 3) NO-AI roles by name
    elif NOAI_ROLE.match(role):
        model, policy, note = "—", "no-AI", "scripted / no model call"
    # 4) otherwise: only a role-SPECIFIC script can mark it Local. Do NOT scan the shared
    #    run-role.sh (it mentions LOCAL_LLM from other roles and would false-positive). Roles
    #    with no dedicated ollama script go through run-role.sh's generic `claude -p` path.
    else:
        spec = read(site / "ops/scripts" / f"run-{role}.sh")
        if spec and OLLAMA_HINT.search(spec) and not CLAUDE_HINT.search(spec):
            model, policy, note = "ollama", "Local", "review model"
        else:
            model, policy, note = "default(sonnet)", "Remote", "claude -p (verify if pinned)"

    return {"model": model, "policy": policy, "status": "DISABLED" if disabled else "enabled", "note": note}


def collect() -> list[dict]:
    rows: list[dict] = []
    for site in sorted(SITES.iterdir()):
        if not (site / "ops/scripts/run-worker.sh").exists() and not (site / "ops/scripts/run-role.sh").exists():
            continue
        for role in site_roles(site):
            r = resolve(site, role)
            rows.append({"domain": site.name, "service": role, **r})
    return rows


def main():
    rows = collect()
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=2)); return
    print("| ID | Domain | Service | Local/Remote | Model | Status |")
    print("|----|--------|---------|--------------|-------|--------|")
    for i, r in enumerate(rows, 1):
        note = f" <br>_{r['note']}_" if r["note"] else ""
        print(f"| {i} | {r['domain']} | {r['service']} | {r['policy']} | {r['model']}{note} | "
              f"{'**DISABLED**' if r['status']=='DISABLED' else 'enabled'} |")
    dis = sum(1 for r in rows if r["status"] == "DISABLED")
    print(f"\n_{len(rows)} services across "
          f"{len({r['domain'] for r in rows})} domains — {dis} disabled, {len(rows)-dis} enabled._")


if __name__ == "__main__":
    main()
