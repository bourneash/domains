"""Flat-file blob store for generated images: <id>.<ext> + <id>.json sidecar.

Deliberately not a database. data-hub-images needs SQLite because it runs a
deduplicated, searchable pool of thousands of fetched stock photos. This
service generates roughly one image per request on demand — there's nothing
to dedupe against and nothing worth indexing beyond "give me this id back."
A directory scan is fast enough at this volume and every record is a plain
JSON file you can `cat` while debugging.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from . import config


def _ensure_dir() -> Path:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    return config.DATA_DIR


def save(image_bytes: bytes, ext: str, meta: dict[str, Any]) -> str:
    """Write an image + its metadata sidecar. Returns the new id."""
    d = _ensure_dir()
    image_id = uuid.uuid4().hex
    (d / f"{image_id}.{ext}").write_bytes(image_bytes)
    (d / f"{image_id}.json").write_text(json.dumps({"id": image_id, "ext": ext, **meta}, indent=2))
    return image_id


def _find_blob(image_id: str) -> Path | None:
    d = _ensure_dir()
    matches = list(d.glob(f"{image_id}.*"))
    blob = next((p for p in matches if p.suffix != ".json"), None)
    return blob


def load_bytes(image_id: str) -> tuple[bytes, str] | None:
    """Return (bytes, content_type) for image_id, or None if unknown."""
    blob = _find_blob(image_id)
    if blob is None:
        return None
    ext = blob.suffix.lstrip(".")
    content_type = {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
    }.get(ext, "application/octet-stream")
    return blob.read_bytes(), content_type


def load_meta(image_id: str) -> dict[str, Any] | None:
    d = _ensure_dir()
    p = d / f"{image_id}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())
