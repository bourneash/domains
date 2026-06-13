"""FastAPI app — matrix, drill-down, edit, collectors."""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from site_tracker import registry, store, tasks as task_loader
from site_tracker.fact_keys import FACTS, families, keys_for_family
from site_tracker.app import git_ops
from site_tracker.cli import COLLECTORS

log = logging.getLogger(__name__)

_HERE = Path(__file__).parent
_TEMPLATES = Jinja2Templates(directory=str(_HERE / "templates"))
_STATIC = _HERE / "static"


def build_app(*, sites_yml: Path, db_path: Path) -> FastAPI:
    app = FastAPI()
    app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")
    app.state.sites_yml = sites_yml
    app.state.db_path = db_path

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def matrix(request: Request):
        reg = registry.load(app.state.sites_yml)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            rows = []
            for site_name, site_cfg in reg.sites.items():
                facts = store.get_site_facts(conn, site_name)
                row = {"site": site_name, "cells": {}}
                applies = set(site_cfg.get("applies_to", []))
                for fam in families():
                    if fam not in applies:
                        row["cells"][fam] = {"state": "n_a", "summary": "—"}
                        continue
                    if fam == "manual":
                        man = site_cfg.get("manual", {}) or {}
                        if man:
                            row["cells"][fam] = {"state": "green", "summary": f"{len(man)}"}
                        else:
                            row["cells"][fam] = {"state": "yellow", "summary": "?"}
                        continue
                    states = [facts.get(k, {}).get("state", "unknown") for k in keys_for_family(fam)]
                    summary_state = _rollup(states)
                    row["cells"][fam] = {"state": summary_state, "summary": _short(summary_state)}
                rows.append(row)
        finally:
            conn.close()
        return _TEMPLATES.TemplateResponse(
            request,
            "matrix.html",
            {"rows": rows, "families": families()},
        )

    @app.get("/site/{site}", response_class=HTMLResponse)
    def site_detail(request: Request, site: str):
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            site_cfg = reg.sites[site]
            applies = set(site_cfg.get("applies_to", []))
            facts = store.get_site_facts(conn, site)
            rows = []
            for key, spec in FACTS.items():
                if spec.family not in applies:
                    continue
                f = facts.get(key, {})
                rows.append({
                    "key": key,
                    "describe": spec.describe,
                    "family": spec.family,
                    "value": f.get("value"),
                    "source": f.get("source") or spec.source,
                    "state": f.get("state", "unknown"),
                    "verified_at": f.get("verified_at"),
                    "age_hours": f.get("age_hours"),
                })
            manual_rows = []
            if "manual" in applies:
                # registry.load() normalizes manual values to {value, set_at} dicts,
                # so we can always do v["value"] / v["set_at"].
                for k, v in (site_cfg.get("manual") or {}).items():
                    manual_rows.append({"key": k, "value": v["value"], "set_at": v["set_at"]})
        finally:
            conn.close()
        return _TEMPLATES.TemplateResponse(
            request,
            "site_detail.html",
            {"site": site, "rows": rows, "manual_rows": manual_rows},
        )

    @app.get("/site/{site}/edit/{key}", response_class=HTMLResponse)
    def edit_form(request: Request, site: str, key: str):
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        current = ""
        if key.startswith("manual."):
            sub = key[len("manual."):]
            # registry.load() normalizes manual values to {value, set_at} dicts.
            man = reg.sites[site].get("manual", {}) or {}
            v = man.get(sub)
            if v is not None:
                current = v.get("value") or ""
        return _TEMPLATES.TemplateResponse(
            request,
            "fragments/edit_form.html",
            {"site": site, "key": key, "current": current},
        )

    @app.post("/site/{site}/edit/{key}", response_class=HTMLResponse)
    async def edit_submit(request: Request, site: str, key: str):
        form = dict(await request.form())
        new_value = (form.get("value") or "").strip()
        custom_key = (form.get("key") or "").strip()
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        if key == "manual.new":
            if not custom_key:
                raise HTTPException(status_code=400, detail="missing 'key' in form")
            sub = custom_key
        elif key.startswith("manual."):
            sub = key[len("manual."):]
        else:
            raise HTTPException(status_code=400, detail="only manual.* keys are editable")
        registry.set_manual_fact(reg, app.state.sites_yml, site, sub, new_value)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            store.upsert_fact(
                conn, site=site, key=f"manual.{sub}",
                value=new_value, source="manual", state="green", ttl_hours=None,
            )
        finally:
            conn.close()
        # NB: sites.yml + DB are already mutated above. If the git commit
        # below fails, state is inconsistent (file updated, no commit) —
        # the operator must commit manually to recover. Acceptable for a
        # local single-user tool.
        cfg = reg.config
        if cfg.get("auto_commit", True):
            try:
                git_root = getattr(app.state, "git_root", None) or Path(cfg.get("domains_root", "/work"))
                git_ops.commit_paths(
                    git_root,
                    [app.state.sites_yml],
                    f"site-tracker: {site} manual.{sub} = {new_value}",
                    push=cfg.get("auto_push", False),
                )
            except (subprocess.CalledProcessError, FileNotFoundError):
                log.exception("git commit failed")
                raise HTTPException(status_code=500, detail="commit failed")
        return _TEMPLATES.TemplateResponse(
            request,
            "fragments/cell.html",
            {"site": site, "key": f"manual.{sub}",
             "value": new_value, "state": "green"},
        )

    @app.get("/tasks", response_class=HTMLResponse)
    def tasks_page(
        request: Request,
        site: list[str] = Query(default=[]),
        stage: list[str] = Query(default=[]),
        task_type: list[str] = Query(default=[]),
        role: list[str] = Query(default=[]),
        priority: list[str] = Query(default=[]),
        blocked: str = "",
        view: str = "tree",
    ):
        import datetime
        from collections import defaultdict
        reg = registry.load(app.state.sites_yml)
        domains_root = Path(reg.config.get("domains_root", "/work"))
        all_tasks = task_loader.load_all(domains_root, reg.sites)
        scanned_at = datetime.datetime.now().strftime("%H:%M:%S")

        # Build filter option lists before filtering
        all_sites = sorted({t.site for t in all_tasks})
        all_types = sorted({t.task_type for t in all_tasks if t.task_type})
        all_roles = sorted({t.assigned_role for t in all_tasks if t.assigned_role})

        # Apply filters (all multi-select: empty list = no filter = show all)
        filtered = all_tasks
        if site:
            filtered = [t for t in filtered if t.site in site]
        if stage:
            filtered = [t for t in filtered if t.stage in stage]
        if task_type:
            filtered = [t for t in filtered if t.task_type in task_type]
        if role:
            filtered = [t for t in filtered if t.assigned_role in role]
        if priority:
            filtered = [t for t in filtered if str(t.priority) in priority]
        if blocked == "yes":
            filtered = [t for t in filtered if t.is_blocked]
        elif blocked == "no":
            filtered = [t for t in filtered if not t.is_blocked]

        counts = {
            "total": len(filtered),
            "in_progress": sum(1 for t in filtered if t.stage == "in-progress"),
            "not_started": sum(1 for t in filtered if t.stage == "backlog"),
        }

        # Group by site for tree view (preserves priority/stage sort within each group)
        site_groups: dict[str, list] = defaultdict(list)
        for t in filtered:
            site_groups[t.site].append(t)
        grouped = sorted(site_groups.items(), key=lambda x: -len(x[1]))

        has_filters = bool(site or stage or task_type or role or priority or blocked)

        return _TEMPLATES.TemplateResponse(
            request,
            "tasks.html",
            {
                "tasks": filtered,
                "grouped": grouped,
                "counts": counts,
                "all_sites": all_sites,
                "all_types": all_types,
                "all_roles": all_roles,
                "view": view if view in ("tree", "table") else "tree",
                "has_filters": has_filters,
                "scanned_at": scanned_at,
                "filters": {
                    "site": site,
                    "stage": stage,
                    "task_type": task_type,
                    "role": role,
                    "priority": priority,
                    "blocked": blocked,
                },
            },
        )

    @app.get("/collectors", response_class=HTMLResponse)
    def collectors_page(request: Request):
        return _TEMPLATES.TemplateResponse(
            request,
            "collectors.html",
            {"collectors": list(COLLECTORS.keys())},
        )

    @app.post("/collectors/{name}/run", response_class=HTMLResponse)
    def collectors_run(name: str):
        if name not in COLLECTORS:
            raise HTTPException(status_code=404, detail="unknown collector")
        reg = registry.load(app.state.sites_yml)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            COLLECTORS[name].run(reg, conn)
        finally:
            conn.close()
        return HTMLResponse(f'<div class="cell green">{name} done</div>')

    return app


def _rollup(states: list[str]) -> str:
    order = ["red", "stale", "yellow", "unknown", "green", "n_a"]
    if not states:
        return "unknown"
    for s in order:
        if s in states:
            return s
    return "unknown"


def _short(state: str) -> str:
    return {"green": "✓", "yellow": "?", "red": "✗",
            "stale": "·", "unknown": "?", "n_a": "—"}.get(state, "?")


# Module-level singleton used when uvicorn imports `app`.
def _default_paths() -> tuple[Path, Path]:
    sy = Path(os.environ.get("SITE_TRACKER_SITES_YML", "/work/tools/site-tracker/sites.yml"))
    db = Path(os.environ.get("SITE_TRACKER_DB", "/work/tools/site-tracker/data/facts.db"))
    return sy, db


sites_yml, db_path = _default_paths()
app = build_app(sites_yml=sites_yml, db_path=db_path)
