"""FastAPI app — matrix, drill-down, edit, collectors."""
from __future__ import annotations

import logging
import os
import subprocess
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from site_tracker import registry, store
from site_tracker.fact_keys import FACTS, families, keys_for_family
from site_tracker.app import git_ops
from site_tracker.cli import COLLECTORS

log = logging.getLogger(__name__)

_HERE = Path(__file__).parent
_TEMPLATES = Jinja2Templates(directory=str(_HERE / "templates"))
_STATIC = _HERE / "static"

# Debounce window for POST /collectors/{name}/run — prevents a burst of
# clicks (or an automated caller) from hammering paid upstream APIs
# (CF, GitHub, Amazon) with duplicate collector runs.
COLLECTOR_DEBOUNCE_SECONDS = 30


class EditError(Exception):
    """Raised by the blocking edit/delete/bulk-edit/collector-run helpers
    below and translated to an HTTPException with a clear, actionable
    message by the async route handler that calls them."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _git_root_for(app_state, cfg: dict) -> Path:
    return getattr(app_state, "git_root", None) or Path(cfg.get("domains_root", "/work"))


def _commit_with_retry(git_root: Path, paths: list[Path], message: str, *, push: bool, context: str) -> None:
    """Try the commit once, retry once on failure, then raise a diagnostic
    EditError. By this point sites.yml has already been written to disk —
    the pre-write is_clean() check means the tree was clean beforehand, so
    a failure here means the working copy is now the ONLY place the edit
    exists until the operator resolves it manually."""
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            git_ops.commit_paths(git_root, paths, message, push=push)
            return
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            last_exc = e
            log.warning("git commit attempt %d failed for %s: %s", attempt + 1, context, e)
    log.exception("git commit failed after retry for %s", context)
    raise EditError(
        500,
        f"{context} — sites.yml was written to disk successfully, but the git "
        f"commit failed twice: {last_exc}. The working tree in {git_root} is now "
        f"dirty. Run `git status` / `git diff -- {paths[0]}` there and either "
        "commit the change by hand or `git checkout -- <path>` to discard it "
        "before making further edits here.",
    )


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

    @app.get("/site/{site}/history", response_class=HTMLResponse)
    def site_history(request: Request, site: str):
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            rows = store.get_audit_for_site(conn, site)
        finally:
            conn.close()
        return _TEMPLATES.TemplateResponse(
            request,
            "site_history.html",
            {"site": site, "rows": rows},
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

    def _resolve_manual_key(key: str, custom_key: str) -> str:
        if key == "manual.new":
            if not custom_key:
                raise EditError(400, "missing 'key' in form")
            return custom_key
        if key.startswith("manual."):
            return key[len("manual."):]
        raise EditError(400, "only manual.* keys are editable")

    def _do_edit_submit(site: str, key: str, new_value: str, custom_key: str) -> dict:
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise EditError(404, "site not found")
        sub = _resolve_manual_key(key, custom_key)

        cfg = reg.config
        git_root = _git_root_for(app.state, cfg)
        auto_commit = cfg.get("auto_commit", True)
        if auto_commit and not git_ops.is_clean(git_root, [app.state.sites_yml]):
            raise EditError(
                409,
                f"sites.yml already has uncommitted changes in {git_root} — "
                "refusing to write on top of a dirty tree (this would make a "
                "failed commit unrecoverable). Run `git status` / `git diff -- "
                f"{app.state.sites_yml}` there, commit or discard the existing "
                "diff, then retry this edit.",
            )

        try:
            registry.set_manual_fact(reg, app.state.sites_yml, site, sub, new_value)
        except registry.InvalidManualValue as e:
            raise EditError(400, str(e))

        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            store.upsert_fact(
                conn, site=site, key=f"manual.{sub}",
                value=new_value, source="manual", state="green", ttl_hours=None,
            )
        finally:
            conn.close()

        if auto_commit:
            _commit_with_retry(
                git_root, [app.state.sites_yml],
                f"site-tracker: {site} manual.{sub} = {new_value}",
                push=cfg.get("auto_push", False),
                context=f"edit {site}/manual.{sub}",
            )
        return {"site": site, "key": f"manual.{sub}", "value": new_value, "state": "green"}

    @app.post("/site/{site}/edit/{key}", response_class=HTMLResponse)
    async def edit_submit(request: Request, site: str, key: str):
        form = dict(await request.form())
        new_value = (form.get("value") or "").strip()
        custom_key = (form.get("key") or "").strip()
        try:
            result = await run_in_threadpool(_do_edit_submit, site, key, new_value, custom_key)
        except EditError as e:
            raise HTTPException(status_code=e.status_code, detail=e.detail)
        return _TEMPLATES.TemplateResponse(request, "fragments/cell.html", result)

    def _do_edit_delete(site: str, key: str) -> None:
        if not key.startswith("manual."):
            raise EditError(400, "only manual.* keys can be deleted")
        sub = key[len("manual."):]
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise EditError(404, "site not found")

        cfg = reg.config
        git_root = _git_root_for(app.state, cfg)
        auto_commit = cfg.get("auto_commit", True)
        if auto_commit and not git_ops.is_clean(git_root, [app.state.sites_yml]):
            raise EditError(
                409,
                f"sites.yml already has uncommitted changes in {git_root} — "
                "refusing to delete on top of a dirty tree. Resolve the "
                "existing diff first, then retry.",
            )

        registry.delete_manual_fact(reg, app.state.sites_yml, site, sub)

        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            store.delete_fact(conn, site=site, key=f"manual.{sub}", source="manual")
        finally:
            conn.close()

        if auto_commit:
            _commit_with_retry(
                git_root, [app.state.sites_yml],
                f"site-tracker: {site} manual.{sub} deleted",
                push=cfg.get("auto_push", False),
                context=f"delete {site}/manual.{sub}",
            )

    @app.delete("/site/{site}/edit/{key}", response_class=HTMLResponse)
    async def edit_delete(site: str, key: str):
        try:
            await run_in_threadpool(_do_edit_delete, site, key)
        except EditError as e:
            raise HTTPException(status_code=e.status_code, detail=e.detail)
        # Empty body + hx-swap="outerHTML" on the target row removes it.
        return HTMLResponse("")

    @app.get("/bulk-edit", response_class=HTMLResponse)
    def bulk_edit_form(request: Request):
        reg = registry.load(app.state.sites_yml)
        sites = sorted(reg.sites.keys())
        return _TEMPLATES.TemplateResponse(
            request, "bulk_edit.html", {"sites": sites, "result": None},
        )

    def _do_bulk_edit(key: str, new_value: str, sites: list[str]) -> dict:
        if not key:
            raise EditError(400, "missing fact key")
        if not sites:
            raise EditError(400, "no sites selected")
        reg = registry.load(app.state.sites_yml)
        unknown = [s for s in sites if s not in reg.sites]
        if unknown:
            raise EditError(400, f"unknown site(s): {', '.join(unknown)}")

        cfg = reg.config
        git_root = _git_root_for(app.state, cfg)
        auto_commit = cfg.get("auto_commit", True)
        if auto_commit and not git_ops.is_clean(git_root, [app.state.sites_yml]):
            raise EditError(
                409,
                f"sites.yml already has uncommitted changes in {git_root} — "
                "refusing to write on top of a dirty tree. Resolve the "
                "existing diff first, then retry the bulk edit.",
            )

        try:
            registry.set_manual_facts_bulk(
                reg, app.state.sites_yml, [(s, key, new_value) for s in sites],
            )
        except registry.InvalidManualValue as e:
            raise EditError(400, str(e))

        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            for s in sites:
                store.upsert_fact(
                    conn, site=s, key=f"manual.{key}",
                    value=new_value, source="manual", state="green", ttl_hours=None,
                )
        finally:
            conn.close()

        if auto_commit:
            message = (
                f"bulk: set manual.{key}={new_value} for {len(sites)} sites\n\n"
                + "\n".join(sites)
            )
            _commit_with_retry(
                git_root, [app.state.sites_yml], message,
                push=cfg.get("auto_push", False),
                context=f"bulk-edit manual.{key} ({len(sites)} sites)",
            )
        return {"key": key, "value": new_value, "sites": sites, "all_sites": sorted(reg.sites.keys())}

    @app.post("/bulk-edit", response_class=HTMLResponse)
    async def bulk_edit_submit(request: Request):
        form = await request.form()
        key = (form.get("key") or "").strip()
        new_value = (form.get("value") or "").strip()
        sites = [s for s in form.getlist("sites")]
        try:
            result = await run_in_threadpool(_do_bulk_edit, key, new_value, sites)
        except EditError as e:
            raise HTTPException(status_code=e.status_code, detail=e.detail)
        return _TEMPLATES.TemplateResponse(
            request, "bulk_edit.html",
            {"sites": result.pop("all_sites"), "result": result},
        )

    @app.get("/collectors", response_class=HTMLResponse)
    def collectors_page(request: Request):
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            runs = store.all_collector_runs(conn)
        finally:
            conn.close()
        return _TEMPLATES.TemplateResponse(
            request,
            "collectors.html",
            {"collectors": list(COLLECTORS.keys()), "runs": runs},
        )

    def _do_collector_run(name: str) -> None:
        reg = registry.load(app.state.sites_yml)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            store.start_collector_run(conn, name)
            try:
                COLLECTORS[name].run(reg, conn)
            except Exception as e:
                store.finish_collector_run(conn, name, ok=False, error=str(e))
                raise
            store.finish_collector_run(conn, name, ok=True, error=None)
        finally:
            conn.close()

    @app.post("/collectors/{name}/run", response_class=HTMLResponse)
    async def collectors_run(name: str):
        if name not in COLLECTORS:
            raise HTTPException(status_code=404, detail="unknown collector")

        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            last = store.get_collector_run(conn, name)
        finally:
            conn.close()

        if last is not None:
            if last["status"] == "running":
                raise HTTPException(
                    status_code=429,
                    detail=f"{name} is already running (started {last['started_at']})",
                )
            started_at = _parse_iso(last["started_at"])
            if started_at is not None:
                age = (_utcnow() - started_at).total_seconds()
                if age < COLLECTOR_DEBOUNCE_SECONDS:
                    wait = COLLECTOR_DEBOUNCE_SECONDS - age
                    raise HTTPException(
                        status_code=429,
                        detail=(
                            f"{name} was run {age:.0f}s ago — wait {wait:.0f}s "
                            "before re-running (debounced to avoid hammering "
                            "the upstream API)"
                        ),
                    )

        try:
            await run_in_threadpool(_do_collector_run, name)
        except Exception as e:
            log.exception("collector %s failed", name)
            return HTMLResponse(f'<div class="cell red">{name} failed: {e}</div>', status_code=500)
        return HTMLResponse(f'<div class="cell green">{name} done</div>')

    return app


def _utcnow():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)


def _parse_iso(ts: str | None):
    if not ts:
        return None
    from datetime import datetime
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


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
