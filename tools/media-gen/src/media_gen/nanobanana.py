"""Nano Banana backend — CloakBrowser + Gemini web UI, via the existing
domains-media-generator-nanobanana skill's generate.py.

This does NOT reimplement the browser-automation flow (that script isn't
built to be imported as a clean function — see its own module docstring and
the investigation that preceded this tool). It drives the proven, working
script exactly the way every site in this repo already does: write a
one-line prompts.txt into a throwaway theme dir, invoke generate.py as a
subprocess, dewatermark the result, read the bytes back.

Two hard constraints, both non-negotiable, both inherited from the skill:

1. **Opens a real, visible browser window on the host.** This is not a
   background/headless job. Whatever process starts uvicorn needs a live
   X display, exactly like running the skill by hand.
2. **The CloakBrowser profile is a single, fleet-wide serialization point**
   (`/tmp/cloak-driver/profile/`) — every other skill that logs into Google
   (SEO, GA4, social) shares it too. Only one generation may run at a time,
   full stop. `_LOCK` enforces that at the process level for requests that
   come through this service; it does nothing to protect against someone
   manually running the skill at the same moment, so avoid doing both.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import uuid
from filelock import FileLock, Timeout
from pathlib import Path

from . import config

_LOCK = FileLock(str(config.NANOBANANA_LOCK_PATH))


class NanoBananaError(RuntimeError):
    pass


def available() -> bool:
    """Best-effort check: does the skill + its python env exist on this host?"""
    script = config.NANOBANANA_SKILL_DIR / "scripts" / "generate.py"
    return script.exists() and config.NANOBANANA_PYTHON_CWD.exists()


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s[:60] or "gen").strip("-")


def generate(prompt: str, aspect_ratio: str = "3:2", lock_wait_s: float = 5.0) -> tuple[bytes, dict]:
    """Generate one image via the real Gemini web UI. Returns (bytes, meta).

    Raises NanoBananaError on any failure, including "another generation is
    already running" (checked fast via lock_wait_s rather than queueing
    silently for the full NANOBANANA_TIMEOUT_S — callers should surface that
    as a 429 and let the client retry, not hang the request indefinitely).
    """
    if not available():
        raise NanoBananaError(
            "nanobanana skill not found on this host — expected "
            f"{config.NANOBANANA_SKILL_DIR}/scripts/generate.py and "
            f"{config.NANOBANANA_PYTHON_CWD}"
        )

    try:
        _LOCK.acquire(timeout=lock_wait_s)
    except Timeout:
        raise NanoBananaError(
            "another Nano Banana generation is already running fleet-wide "
            "(CloakBrowser's shared profile only allows one at a time) — retry shortly"
        )

    theme_dir = Path(tempfile.mkdtemp(prefix="media-gen-nanobanana-"))
    try:
        slug = f"media-gen-{_slugify(prompt)}-{uuid.uuid4().hex[:8]}"
        (theme_dir / "prompts.txt").write_text(f"1. [{slug}] {prompt} --ar {aspect_ratio}\n")

        script = config.NANOBANANA_SKILL_DIR / "scripts" / "generate.py"
        proc = subprocess.run(
            ["python3", str(script), str(theme_dir), "--no-primer",
             "--gen-timeout", str(int(config.NANOBANANA_TIMEOUT_S))],
            cwd=str(config.NANOBANANA_PYTHON_CWD),
            capture_output=True, text=True, timeout=config.NANOBANANA_TIMEOUT_S + 30,
        )
        raw_dir = theme_dir / "nano_banana_out"
        raw_path = raw_dir / f"{slug}.png"
        if proc.returncode != 0 or not raw_path.exists():
            raise NanoBananaError(
                f"generation failed (exit {proc.returncode}): "
                f"{proc.stdout[-800:]}\n{proc.stderr[-800:]}"
            )

        dewatermark = config.NANOBANANA_SKILL_DIR / "scripts" / "dewatermark.py"
        clean_dir = theme_dir / "clean"
        dw = subprocess.run(
            ["python3", str(dewatermark), str(raw_dir), "--out", str(clean_dir)],
            capture_output=True, text=True, timeout=120,
        )
        clean_path = clean_dir / f"{slug}.png"
        final_path = clean_path if dw.returncode == 0 and clean_path.exists() else raw_path

        image_bytes = final_path.read_bytes()
        meta = {
            "backend": "nanobanana",
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "dewatermarked": final_path == clean_path,
            "credit": {
                "source": "Media Gen (Nano Banana / Gemini)",
                "photographer": "AI-generated — no human photographer",
                "license": "Generated via Google Gemini — see Google's generated-content terms",
                "url": "",
            },
        }
        return image_bytes, meta
    finally:
        shutil.rmtree(theme_dir, ignore_errors=True)
        _LOCK.release()
