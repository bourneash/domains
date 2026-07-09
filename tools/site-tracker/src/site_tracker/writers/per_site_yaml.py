"""Per-site facts.yaml writer.

Each call to write_fact() does a read-modify-write of one site's facts.yaml.
The file is YAML with a top-level {last_updated, facts: {<key>: {...}}} shape.

facts.yaml is a *shared* file: the top block is hand-authored (site metadata,
niche, affiliate config, and the comments explaining them) while the `facts:`
block is machine-appended by ops roles. Round-tripping through ruamel keeps
the human's comments and key order intact — a plain yaml.safe_dump() rewrite
silently strips every comment in the file on the first role tick.

The site's path is computed from the SITE_TRACKER_DOMAINS_ROOT env var,
defaulting to /work (matches the Docker bind mount). For tests / local dev,
override the env var or pass domains_root explicitly.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

log = logging.getLogger(__name__)


def _yaml() -> YAML:
    y = YAML()  # round-trip mode: preserves comments, quotes and key order
    y.preserve_quotes = True
    y.width = 4096  # don't reflow long values into folded scalars
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _domains_root(override: Path | None = None) -> Path:
    if override is not None:
        return override
    return Path(os.environ.get("SITE_TRACKER_DOMAINS_ROOT", "/work"))


def _site_facts_path(site_name: str, domains_root: Path | None = None) -> Path:
    return _domains_root(domains_root) / "sites" / site_name / "ops" / "facts.yaml"


def _load(path: Path, yaml: YAML) -> Any:
    if not path.exists():
        return {"last_updated": None, "facts": {}}
    text = path.read_text()
    try:
        data = yaml.load(text)
    except YAMLError as e:
        # Never silently discard a human's file. Park the original beside it so
        # the hand-authored block is recoverable, then start clean.
        backup = path.with_suffix(".yaml.corrupt")
        backup.write_text(text)
        log.warning(
            "facts.yaml at %s malformed; original preserved at %s, rewriting from scratch: %s",
            path, backup, e,
        )
        return {"last_updated": None, "facts": {}}
    if data is None:
        return {"last_updated": None, "facts": {}}
    if "facts" not in data:
        data["facts"] = {}
    return data


def write_fact(
    site_name: str,
    key: str,
    *,
    value: Any,
    source: str,
    state: str,
    ttl_hours: int | None,
    domains_root: Path | None = None,
) -> None:
    """Read-modify-write one fact into the site's facts.yaml.

    Comments and key order in the hand-authored portion of the file are
    preserved. Silently no-ops (with a warning log) if the site's ops/
    directory doesn't exist — the site simply isn't tracked yet at the
    per-site level.
    """
    path = _site_facts_path(site_name, domains_root)
    if not path.parent.exists():
        log.warning("ops dir missing for %s; skipping per-site write to %s", site_name, path)
        return

    yaml = _yaml()
    data = _load(path, yaml)
    ts = _now_iso()
    data["facts"][key] = {
        "value": value,
        "state": state,
        "source": source,
        "verified_at": ts,
        "ttl_hours": ttl_hours,
    }
    data["last_updated"] = ts

    tmp = path.with_suffix(".yaml.tmp")
    with tmp.open("w") as fh:
        yaml.dump(data, fh)
    tmp.replace(path)  # atomic: a crashed role never leaves a truncated facts.yaml
