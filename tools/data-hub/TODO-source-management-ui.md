# TODO — Add / Remove Sources via the Web UI (deferred)

**Status:** deferred (larger lift than the per-source enable/disable toggle).
**Requested:** 2026-06-29 by Jesse. **Owner:** data-hub.

## Goal

From the Fleet Dashboard → Data Hub tab, **create a new source** (RSS feed or
dataset), **edit** its tags/policy/exit, and **remove** a source — without
hand-editing `registry/sources.yaml` and rebuilding the image.

## Why this is more than the existing toggle

The per-source **enable/disable** toggle (shipped) only flips a boolean, so it
works as a tiny DB override (`source_overrides`) overlaid on the registry at
collect time. **Add/remove/edit changes the source SET itself**, and the source
registry is **baked into the Docker image** (`COPY registry/ registry/` in the
Dockerfile) and is a **git-tracked file**. So a UI that mutates sources has to
solve persistence + provenance, which the toggle did not.

## The core design decision (resolve first)

Two viable approaches — pick one in design before building:

### Option A — DB-backed dynamic sources (overlay, no rebuild)
- New `sources_custom` table in the mounted SQLite (id, type, url, dataset_key,
  fetcher, params JSON, tags JSON, policy, exit, enabled, created_at).
- The collector + API load **registry sources ∪ custom sources** (custom wins on
  id collision), exactly like `source_overrides` is overlaid today.
- UI POSTs create/edit/delete → writes the table → effective on the next cycle,
  **no rebuild**.
- **Pros:** instant, matches the override pattern already in place, survives
  rebuilds (mounted volume). **Cons:** the registry YAML is no longer the full
  source of truth — two places to look; custom sources aren't in git history.

### Option B — Edit the YAML on disk + rebuild
- UI writes `registry/sources.yaml` (the dashboard already has the repo
  bind-mounted) and triggers `docker compose up -d --build` for the hub.
- **Pros:** single source of truth, git-trackable (could even auto-commit).
  **Cons:** a UI action triggers a ~60s rebuild + container recreate; risk of
  YAML corruption; the dashboard would need privileged compose/build access to
  the data-hub project (it already has the docker socket for other tools).

**Recommendation:** Option A for the live UX, optionally with a "promote to
registry" export so custom sources can be folded back into the YAML during a
normal edit/commit. Mirror how `source_overrides` already overlays the registry.

## Work breakdown (when picked up)

**Hub (tools/data-hub):**
1. `store.py` — `sources_custom` table + `add_source` / `update_source` /
   `delete_source` / `get_custom_sources`.
2. Source loading — a single helper that returns registry ∪ custom (custom wins),
   used by both the collector (`__main__` collect) and `api.create_app`.
3. `api.py` — `POST /sources` (create), `PUT /sources/{id}` (edit),
   `DELETE /sources/{id}` (remove, custom-only — refuse to delete a registry
   source; disable it instead). Validate: unique id, valid `type`/`policy`/`exit`,
   reachable URL probe optional. Reuse the redaction/validation already present.
4. Tests: CRUD round-trip; registry-source delete is refused; collision rules;
   a custom source actually gets fetched on the next cycle.

**Dashboard (tools/fleet-dashboard):**
5. `server/datahub.js` — `createSource` / `updateSource` / `deleteSource`
   passthroughs; `server.js` routes under `/api/datahub/sources`.
6. `app.js` — an "Add source" form + per-row Edit/Delete in the Source Freshness
   panel (registry rows show Disable only; custom rows show Edit/Delete). Keep
   `esc()` on every field. Playwright-verify CRUD.

**Docs:** update `tools/data-hub/README.md` + the `data-hub-dev` skill (the
registry∪custom load path, and "registry sources are deletable only via disable").

## Guardrails / gotchas

- **Never let the UI delete a registry-declared source** — only disable it (the
  toggle already does this). Delete applies to custom sources only.
- Validate `fetcher` against `datasets.FETCHERS` for dataset sources; a bad
  fetcher must 400, not crash a cycle.
- A new `policy: direct` source bypasses the VPN — require an explicit confirm in
  the UI and keep that allowlist deliberate (the all-VPN invariant).
- Keep the same fail-closed + egress/pull logging for custom sources.

## Estimate

~1 day: roughly the size of the enable/disable + pull-ledger features combined
(two store tables' worth of CRUD + validation + a dashboard form). Not hard, just
broader than a toggle — hence deferred.
