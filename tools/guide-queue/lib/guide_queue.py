"""tools/guide-queue/lib/guide_queue.py — shared file-kanban queue for the
fleet's guide-writing pipeline: idea -> drafted -> ready -> released -> rejected.

One directory tree per site, at `ops/guide-queue/<status>/<id>.md`. Mirrors
tools/fleet-dashboard/server/tasks.js's frontmatter-markdown shape on purpose
(YAML frontmatter + markdown body, flat filenames, per-status subdirs) so the
dashboard's existing task-board code and mental model extend cleanly to guides
instead of inventing a second convention.

A `drafted`/`ready` item's body IS the future guide's markdown body — the
frontmatter carries both queue-only fields (queue_id, queue_status, source,
brief, notes, hero_image, card_image) and the real guide frontmatter fields
(title, description, category, ...). guide_publisher.strip_queue_fields()
removes the queue-only keys when copying an item into the site's live content
collection at publish time.

Mounted read-only into site worker containers via the same
`.monorepo-tools` bind that already exposes tools/task-budget etc (see
docker-compose.yml). No third-party deps beyond PyYAML (already required by
several other fleet tools mounted the same way).
"""
from __future__ import annotations

import datetime
import re
from pathlib import Path
from typing import Any

import yaml

STATUSES = ["ideas", "drafted", "ready", "released", "rejected"]

# Queue-only frontmatter keys — never copied into the live site content file.
QUEUE_FIELDS = [
    "queue_id",
    "queue_status",
    "source",
    "created",
    "brief",
    "notes",
    "hero_image",
    "hero_alt",
    "card_image",
]

# Preferred key order when serializing (queue fields first, then guide fields).
_FIELD_ORDER = QUEUE_FIELDS + [
    "title",
    "description",
    "category",
    "updated",
    "published",
    "author",
    "featuredProducts",
    "faq",
    "schemaType",
    "steps",
]

_FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", re.S)


class GuideQueueError(RuntimeError):
    pass


def queue_dir(site_root: Path) -> Path:
    return Path(site_root) / "ops" / "guide-queue"


def _status_dir(site_root: Path, status: str) -> Path:
    if status not in STATUSES:
        raise GuideQueueError(f"bad status: {status!r}")
    return queue_dir(site_root) / status


def parse_item(text: str) -> tuple[dict, str]:
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError as e:
        # 2026-08-31: this used to swallow the error and return {} — a
        # writer role that emits a frontmatter value with an unescaped quote
        # (e.g. `lede: "Search bait" is not...`, a plain scalar starting
        # with a quoted phrase) produced invalid YAML, and every field
        # silently vanished instead of failing loudly. Worse, a downstream
        # metadata-restore step would then treat the empty {} as the item's
        # real current state and discard every already-correct field
        # (tags, relatedCategory, hero_image, ...) it didn't own — silent
        # data loss, not just a validation gap. Raise instead: every caller
        # (cli.py, guide_writer_meta.py) already has a clear error path for
        # this and a broken file staying visibly broken is much safer than
        # one that quietly reads back empty.
        raise GuideQueueError(f"invalid YAML frontmatter: {e}") from e
    if not isinstance(meta, dict):
        raise GuideQueueError("frontmatter did not parse to a mapping")
    return meta, m.group(2)


def serialize_item(meta: dict, body: str) -> str:
    clean = {k: v for k, v in meta.items() if v not in (None, "", [])}
    ordered: dict[str, Any] = {}
    for k in _FIELD_ORDER:
        if k in clean:
            ordered[k] = clean.pop(k)
    ordered.update(clean)  # any unexpected keys survive, appended at the end
    fm = yaml.safe_dump(
        ordered, sort_keys=False, allow_unicode=True, default_flow_style=False, width=100
    ).strip()
    body_clean = (body or "").strip("\n")
    tail = f"\n{body_clean}\n" if body_clean else "\n"
    return f"---\n{fm}\n---\n{tail}"


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:60] or "guide"


def _read(fp: Path) -> tuple[dict, str]:
    return parse_item(fp.read_text(encoding="utf-8"))


def list_status(site_root: Path, status: str) -> list[dict]:
    d = _status_dir(site_root, status)
    items = []
    if d.is_dir():
        for f in sorted(d.glob("*.md")):
            # A single corrupt file (unparseable frontmatter) must not sink
            # the whole scan — `oldest()` backs the writer's "is anything
            # pending?" gate, and one broken drafted item would otherwise
            # block every other idea/site from ever being picked up. Surface
            # it as a flagged, meta-less item instead so callers that care
            # (get_item on that exact file, or a human scanning the list)
            # still see it broke, without wedging everything behind it.
            try:
                meta, body = _read(f)
            except GuideQueueError as e:
                items.append(
                    {
                        "file": f.name,
                        "status": status,
                        "meta": {},
                        "excerpt": "",
                        "parse_error": str(e),
                    }
                )
                continue
            items.append(
                {
                    "file": f.name,
                    "status": status,
                    "meta": meta,
                    "excerpt": re.sub(r"\s+", " ", body).strip()[:200],
                }
            )
    return items


def list_all(site_root: Path) -> dict[str, list[dict]]:
    return {s: list_status(site_root, s) for s in STATUSES}


def get_item(site_root: Path, status: str, filename: str) -> dict:
    fp = _status_dir(site_root, status) / filename
    if not fp.is_file():
        raise GuideQueueError(f"not found: {status}/{filename}")
    meta, body = _read(fp)
    return {"file": filename, "status": status, "meta": meta, "body": body}


def add_idea(
    site_root: Path,
    title: str,
    brief: str,
    category: str,
    source: str = "human",
) -> str:
    """Append a new idea to ideas/. Returns the created filename."""
    qid = slugify(title)
    meta = {
        "queue_id": qid,
        "queue_status": "idea",
        "source": source,
        "created": datetime.date.today().isoformat(),
        "brief": brief,
        "title": title,
        "category": category,
    }
    d = _status_dir(site_root, "ideas")
    d.mkdir(parents=True, exist_ok=True)
    name, n = f"{qid}.md", 2
    while (d / name).exists():
        name = f"{qid}-{n}.md"
        n += 1
    (d / name).write_text(serialize_item(meta, ""), encoding="utf-8")
    return name


def write_item(site_root: Path, status: str, filename: str, meta: dict, body: str) -> None:
    """Overwrite an item's frontmatter + body in place (used by the writer role
    after it fills in the drafted guide content)."""
    fp = _status_dir(site_root, status) / filename
    if not fp.is_file():
        raise GuideQueueError(f"not found: {status}/{filename}")
    fp.write_text(serialize_item(meta, body), encoding="utf-8")


def move_item(site_root: Path, from_status: str, filename: str, to_status: str) -> str:
    src = _status_dir(site_root, from_status) / filename
    if not src.is_file():
        raise GuideQueueError(f"not found: {from_status}/{filename}")
    dst_dir = _status_dir(site_root, to_status)
    dst_dir.mkdir(parents=True, exist_ok=True)
    name, n = filename, 2
    dst = dst_dir / name
    while dst.exists():
        name = filename.replace(".md", f"-{n}.md")
        dst = dst_dir / name
        n += 1
    # Update queue_status in the frontmatter to match its new home so the two
    # never drift (directory is the source of truth for the dashboard's list
    # views; the field matters for anything reading a single file in isolation,
    # e.g. the publisher after a move).
    meta, body = _read(src)
    meta["queue_status"] = {
        "ideas": "idea",
        "drafted": "drafted",
        "ready": "ready",
        "released": "released",
        "rejected": "rejected",
    }.get(to_status, to_status)
    src.write_text(serialize_item(meta, body), encoding="utf-8")
    src.rename(dst)
    return name


def oldest(site_root: Path, status: str) -> dict | None:
    """The oldest item in a status column by `created` date (falls back to
    filename order for items missing that field).

    Corrupt frontmatter is surfaced by ``list_status`` for the dashboard, but
    it is not a publishable candidate.  Do not let a flagged item become the
    queue head and make the publisher fail before it can reach valid items
    behind it.
    """
    items = [it for it in list_status(site_root, status) if not it.get("parse_error")]
    items.sort(key=lambda it: (it["meta"].get("created") or "", it["file"]))
    return items[0] if items else None


def strip_queue_fields(meta: dict) -> dict:
    """Drop queue-only keys, leaving pure guide frontmatter for the live
    content collection. `hero_image`/`card_image` are handled separately by
    the publisher (renamed to the collection's `image`/`cardImage` fields
    after the files are copied into site/public/)."""
    return {k: v for k, v in meta.items() if k not in QUEUE_FIELDS}


def existing_titles(site_root: Path) -> set[str]:
    """Every title already in the pipeline (any status) — for the idea-seeder
    to avoid proposing a duplicate."""
    titles = set()
    for status in STATUSES:
        for it in list_status(site_root, status):
            t = it["meta"].get("title")
            if t:
                titles.add(str(t).strip().lower())
    return titles
