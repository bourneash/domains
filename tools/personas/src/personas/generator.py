from __future__ import annotations
import json
import re
import subprocess
from datetime import date
from personas.store import Persona, make_handle

MODEL = "claude-haiku-4-5-20251001"


def generate_persona(role: str, site: str, domain: str) -> Persona:
    """
    Call Claude CLI to generate a fictional persona for the given role/site.
    Returns a Persona dataclass with fields filled from Claude.
    email and avatar_path are left blank for downstream providers to fill.
    """
    prompt = f"""Generate a fictional professional persona for a {role} at a website called {site}.

Requirements:
- American name, realistic for the role
- Age between 25 and 45 (DOB between 1981-01-01 and 2001-06-28)
- 1-2 sentence bio appropriate for {role} at {site}
- 2 prior employment entries (company + role + year range), then current role implied

Return ONLY valid JSON with these exact keys:
{{
  "name": "First Last",
  "dob": "YYYY-MM-DD",
  "bio": "One to two sentences.",
  "employment_history": [
    {{"company": "Company Name", "role": "Job Title", "years": "YYYY-YYYY"}},
    {{"company": "Company Name", "role": "Job Title", "years": "YYYY-present"}}
  ]
}}"""

    result = subprocess.run(
        ["claude", "-p", prompt, "--model", MODEL],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude -p failed (exit {result.returncode}): {result.stderr[:300]}")

    raw = result.stdout.strip()
    fence_match = re.search(r'```(?:json)?\s*(.+?)\s*```', raw, re.DOTALL)
    clean = fence_match.group(1) if fence_match else raw.strip()
    try:
        data = json.loads(clean)
    except json.JSONDecodeError as e:
        raise ValueError(f"Generator returned non-JSON: {e}\nRaw: {raw[:300]}") from e

    name = data["name"]
    return Persona(
        name=name,
        handle=make_handle(name),
        role=role,
        email="",
        dob=data["dob"],
        bio=data["bio"],
        employment_history=data["employment_history"],
        avatar_path=None,
        platforms={},
        created=date.today().isoformat(),
    )
