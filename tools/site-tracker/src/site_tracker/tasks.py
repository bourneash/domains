"""Cross-fleet task aggregator.

Reads ops/tasks/{backlog,in-progress}/*.md from every site that has an ops/tasks/
directory.  Returns a flat list of Task dicts sorted by (priority ASC, created ASC).
Files without valid YAML frontmatter are skipped silently.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

STAGES = ("in-progress", "backlog")
PRIORITY_LABEL = {1: "P1", 2: "P2", 3: "P3", 4: "P4", 5: "P5"}
PRIORITY_CSS = {1: "red", 2: "yellow", 3: "green", 4: "unknown", 5: "n_a"}


@dataclass
class Task:
    site: str
    stage: str                       # "backlog" or "in-progress"
    filename: str
    title: str
    priority: int = 3
    task_type: str = ""
    assigned_role: str = ""
    estimated_turns: int | None = None
    created: str = ""
    blocked_on: str = ""
    raw: dict = field(default_factory=dict)

    @property
    def priority_label(self) -> str:
        return PRIORITY_LABEL.get(self.priority, f"P{self.priority}")

    @property
    def priority_css(self) -> str:
        return PRIORITY_CSS.get(self.priority, "unknown")

    @property
    def is_blocked(self) -> bool:
        return bool(self.blocked_on)


def _parse_frontmatter(text: str) -> dict[str, Any] | None:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None
    try:
        data = yaml.safe_load(m.group(1))
        return data if isinstance(data, dict) else None
    except yaml.YAMLError:
        return None


def _load_task(path: Path, site: str, stage: str) -> Task | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fm = _parse_frontmatter(text)
    if not fm or not fm.get("title"):
        return None
    return Task(
        site=site,
        stage=stage,
        filename=path.name,
        title=str(fm.get("title", "")).strip(),
        priority=int(fm.get("priority", 3)),
        task_type=str(fm.get("type", "")),
        assigned_role=str(fm.get("assigned_role", "")),
        estimated_turns=fm.get("estimated_turns"),
        created=str(fm.get("created", "")),
        blocked_on=str(fm.get("blocked_on", "") or ""),
        raw=fm,
    )


def load_all(domains_root: Path, sites: dict) -> list[Task]:
    """Return all open tasks (backlog + in-progress) across every site."""
    tasks: list[Task] = []
    for site_name in sites:
        tasks_root = domains_root / "sites" / site_name / "ops" / "tasks"
        if not tasks_root.is_dir():
            continue
        for stage in STAGES:
            stage_dir = tasks_root / stage
            if not stage_dir.is_dir():
                continue
            for md in sorted(stage_dir.glob("*.md")):
                t = _load_task(md, site_name, stage)
                if t:
                    tasks.append(t)

    # Sort: in-progress first, then backlog; within each group sort by priority then created.
    def _key(t: Task):
        stage_order = 0 if t.stage == "in-progress" else 1
        return (stage_order, t.priority, t.created or "9999")

    tasks.sort(key=_key)
    return tasks
