from __future__ import annotations
import json
import os
import anthropic

MODEL = "claude-haiku-4-5-20251001"


def generate_persona(domain: str, role: str, existing_names: list[str]) -> dict:
    """
    Call Claude to generate a fictional persona for the given domain/role.
    Returns dict with: name, dob, bio, employment_history
    """
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    avoid = f"Do NOT use any of these names: {', '.join(existing_names)}." if existing_names else ""

    prompt = f"""Generate a fictional professional persona for a {role} at a website called {domain}.

{avoid}

Requirements:
- American name, realistic for the role
- Age between 28 and 48 (DOB between 1978 and 1998)
- 1-2 sentence bio appropriate for {role} at {domain}
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

    response = client.messages.create(
        model=MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())
