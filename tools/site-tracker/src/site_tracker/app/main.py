"""FastAPI app — matrix, drill-down, edit, collectors."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from site_tracker import registry, store
from site_tracker.fact_keys import FACTS, families, keys_for_family
from site_tracker.app import git_ops

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
