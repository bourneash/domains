# domain-developer durability redesign

Status: **COMPLETE — all 6 steps shipped + verified on branch `dd-durability`** (2026-05-30). Scope approved by Jesse: **full redesign**. All three live containers (reviewtattoo.com, americastrikes.com, shoptopless.com) migrated; `dd-doctor` = 15/15. Marker-survives-recreate and tmux-persists-across-disconnect both proven. Legacy `dd-claude-*`/`dd-home-*` volumes left intact as backup (reclaim with `docker volume rm` once you're satisfied).

## Progress
- [x] **1. Writable creds + settings** — entrypoint copies `.credentials.json` (first-boot) + `settings.json` (every boot) in writable from `/host-claude-ro/`; both entry points stage them RO instead of binding RO at destination.
- [x] **2. State on host binds** — `STATE_ROOT=tools/domain-developer/state/<site>/{claude,persist}` replaces the `dd-claude-*`/`dd-home-*` named volumes in both entry points; compose mounts the state dir RW into the panel; entrypoint `sudo chown`s the mountpoints; `state/.gitignore` keeps creds/transcripts out of git.
- [x] **3. tmux sessions** — `tmux` added to image; entrypoint writes `~/.tmux.conf` and runs `ttyd … tmux new-session -A -s dd`; banner moved to bashrc. Survives ttyd reconnects/browser close/ttyd restart. (A full *container* restart still ends the tmux server — but state is on host binds and the transcript is on disk, so `claude --resume` continues it.)
- [x] **4. Graceful shutdown** — `--stop-timeout 30` on both entry points.
- [x] **5. Tooling** — `bin/dd-doctor` (verifier/gate), `bin/dd-recreate` (state-preserving recreate via panel API or CLI), `bin/dd-migrate-state` (copy-only, no-clobber, leaves volumes as backup).
- [x] **6. Rollout** — image rebuilt (tmux 3.4), panel recreated (state bind RW), migrated+recreated reviewtattoo.com (idle) → 5/5, proved marker survives recreate + tmux server persists across client disconnect, then migrated americastrikes.com + shoptopless.com (both idle, confirmed via `dd-dev status`). Final: `dd-doctor` 15/15.

### Rollout commands (step 6)
```
cd tools/domain-developer
bin/dd-build            # rebuild image: tmux + new entrypoint (creds/chown/tmux)
bin/dd-up               # recreate panel: new compose state mount + server.js
# idle site first:
bin/dd-migrate-state reviewtattoo.com
bin/dd-recreate       reviewtattoo.com
bin/dd-doctor         reviewtattoo.com   # expect: all checks pass
# then the live ones (quiesce any active session first):
bin/dd-migrate-state americastrikes.com && bin/dd-recreate americastrikes.com && bin/dd-doctor americastrikes.com
bin/dd-migrate-state shoptopless.com   && bin/dd-recreate shoptopless.com   && bin/dd-doctor shoptopless.com
# once all green and verified, reclaim the old volumes:
#   docker volume rm dd-claude-<site> dd-home-<site>
```

## Why (root causes, confirmed against live containers 2026-05-30)

### RC1 — periodic permission/auth failures = OAuth creds mounted read-only
`docker inspect dd-americastrikes.com` confirms:
```
bind /home/jesse/.claude/.credentials.json -> /home/dev/.claude/.credentials.json  RW=false
bind /home/jesse/.claude/settings.json     -> /home/dev/.claude/settings.json      RW=false
```
Claude Code rewrites `.credentials.json` on every OAuth token refresh (hours cadence). A RO bind
makes the write fail → auth breaks on a timer = the "periodic" symptom.
Source: `server/server.js:213-219` (claudeShares marks them shared) + `:254-258` (pushed `:ro`);
same list in `bin/domain-developer:68-70`.
Secondary: OAuth refresh tokens may be single-use — host + N containers all refreshing from one
shared token can invalidate each other. Per-site writable copy is step 1; revisit if rotation bites.

### RC2 — data loss on "bouncing" = durable state in the wrong tier + no graceful REPL shutdown
Site code is safe (`-v hostSiteDir:hostSiteDir` host bind). Transcripts/memory safe
(`~/.claude/projects/<id>` host bind). But:
- **`.claude` state** (`.claude.json`, todos, auth, statsig) lives in **named volume `dd-claude-<site>`**
- **`/home/dev/persist`** lives in **named volume `dd-home-<site>`**
- **Anything Claude writes outside the site dir** lives in the **container writable layer**

Named volumes survive `docker rm` but NOT `docker volume prune` / `compose down -v`, and are
invisible/forgettable. Writable layer dies on every recreate — and recreates have been frequent
(Shift+Enter, renderer, redraw, enhance.js all needed image rebuilds). 18 such volumes exist today.
Plus `claude` runs as a grandchild of ttyd (`tini → ttyd → bash -l → claude`, `entrypoint.sh:89`),
so `docker stop`/restart kills it with no flush → live session lost.

## Verdict
Docker is the right tool; same-host-path bind trick is necessary and correct. Not a wrong-architecture
problem — specific lifecycle/mount bugs. Governing principle of the fix:
**all stateful data on host bind mounts; nothing important in named volumes or the writable layer;
the session survives the container bouncing.**

## Build order (safety-first; do NOT disturb running containers until step 6)

1. **Writable creds + settings (RC1).** Stop RO-binding files Claude rewrites. Mount host
   `.credentials.json` + `settings.json` at a staging path (e.g. `/host-claude-ro/`) and have the
   entrypoint copy them into `/home/dev/.claude/` writable on boot (mirror the existing `.claude.json`
   `/host-claude-json-ro` copy-in at `entrypoint.sh:29-32`). Keep plugins/commands/hooks/skills RO
   (Claude doesn't write those). Edit: `server/server.js` claudeShares + bind loop;
   `bin/domain-developer` share loop; `docker/entrypoint.sh` copy-in block.

2. **State on host binds (RC2).** Replace named volumes with host dirs:
   - `dd-claude-<site>`  → `tools/domain-developer/state/<site>/claude`  : `/home/dev/.claude`
   - `dd-home-<site>`    → `tools/domain-developer/state/<site>/persist` : `/home/dev/persist`
   Pre-create dirs owned 1000:1000 before `docker run`. Panel runs in a container, so add a RW bind of
   the state dir into `docker-compose.yml` (panel) at the same host path. Both entry points + compose.
   Keep the existing `~/.claude/projects/<id>` host bind (nested bind under `.claude` is fine).

3. **tmux-backed sessions (RC2).** Add tmux to the image. Entrypoint runs ttyd with
   `tmux new-session -A -s dd` (attach-or-create) instead of bare `bash -l`. ttyd death / browser
   close / container restart → reattach, session intact. Update `Dockerfile` + `entrypoint.sh:89`.

4. **Graceful shutdown.** Add `--stop-timeout 30` (or `--time` on stop) so `docker stop` gives the
   session time; tini already PID1 forwards signals. With tmux + on-disk transcript a hard kill is
   survivable. Both entry points.

5. **Tooling.** 
   - `bin/dd-doctor [site]` — verifier/spec: creds+settings writable, `.claude`+persist are host binds
     (not volumes), state dir owned 1000:1000, tmux present, image pinned. Run after every change.
   - `bin/dd-recreate <site>` — stop+rm container, keep host state, run fresh. Safe by construction
     once state is on host binds. Replaces the scary manual Remove→Start cycle.
   - `bin/dd-migrate-state [site]` — one-time, COPY-ONLY (never move/delete): for each
     `dd-claude-<site>`/`dd-home-<site>` volume, run a throwaway container mounting both the volume and
     the new host dir, `cp -a` volume→host. Idempotent. Leaves volumes in place as backup until Jesse
     confirms. 

6. **Rollout.** Pin image tag (stop using rebuild-churn to force recreation). Migrate one IDLE site
   first (e.g. aliencouncil.com / reviewtattoo.com — not running now), `dd-recreate`, `dd-doctor`,
   verify auth + a test write survives recreate. THEN migrate the two live sites
   (`americastrikes.com`, `shoptopless.com`) carefully — quiesce any active session first.

## Notes / gotchas
- Host UID is 1000 (jesse). Image bakes HOST_UID via `dd-build` (`id -u`). Keep aligned.
- Host-path bridge (`entrypoint.sh:14-19`) symlinks `${HOST_HOME}/.claude → /home/dev/.claude`; still
  needed for plugin marketplace absolute paths. Unaffected by moving `.claude` to a host bind.
- `dd-down --purge` already keeps volumes (good). After migration, volumes can be pruned once verified.
- Do all of this on a branch off `main` (currently on main with the in-flight Shift+Enter/redraw diff
  uncommitted — fold or commit that first).
