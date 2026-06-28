# tools/personas/src/personas/face.py
from __future__ import annotations
from pathlib import Path
import httpx

FACE_URL = "https://thispersondoesnotexist.com/"


def fetch_face(save_path: Path) -> Path:
    """Fetch an AI-generated face and save to save_path. Returns save_path."""
    save_path = Path(save_path)
    save_path.parent.mkdir(parents=True, exist_ok=True)
    resp = httpx.get(FACE_URL, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    save_path.write_bytes(resp.content)
    return save_path
