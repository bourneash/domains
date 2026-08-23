# domain-developer durability redesign

Status: **COMPLETE — all 6 steps shipped + verified + legacy cleaned** (2026-05-30). Scope approved by Jesse: **full redesign**. All three live containers (reviewtattoo.com, americastrikes.com, shoptopless.com) migrated; `dd-doctor` = 15/15. Marker-survives-recreate and tmux-persists-across-disconnect both proven.

## INCIDENT 2026-05-30 — legacy cleanup lost per-site Claude cache (read this)

During "clean up legacy", `dd-migrate-state` was run for all 9 sites, then all 18
`dd-claude-*`/`dd-home-*` volumes were removed via raw `docker volume rm`, plus 3
dangling rebuild images (~3.2 GB).

**Bug:** the first `dd-migrate-state` used `cp -an` inside an **alpine** helper.
BusyBox's `cp -n` is broken — it silently copies **nothing** while exiting 0. So
migration reported success but moved ~0 files. A file-count cross-check printed
"host has fewer" for 8/9 sites and the volumes were deleted anyway. **Operator
error**: proceeded past a failed verification gate.

**Lost:** per-site Claude **cache/config only** — `.claude.json` per-project
state (MCP approvals/trust), `todos/`, `history.jsonl`, `shell-snapshots/`,
`statsig/`. Regenerable; containers rebuild on boot.
**NOT lost (verified intact):** all site code; all conversation transcripts under
`~/.claude/projects/` (totaljerks 220 files, shoptopless 62, wetpages 53, xxxtea
50, reviewtattoo 23, americastrikes 11, …); portfolio memory; working creds.
The redesign's separation of durable data onto independent host binds is the only
reason this was a cache loss, not a catastrophe. (Physical recovery from
`/var/lib/docker/volumes` needs root; on overlay2 `volume rm` reclaims
immediately, so assume gone.)

**Fixes shipped same day:**
- `dd-migrate-state` rewritten: GNU `cp -an` via the worker image (never alpine)
  + **post-copy assertion** that aborts non-zero if dest file count < source.
  Tested: seeded volume → migrated → all files present + `✓ verified`.
- New `bin/dd-reclaim-volumes`: the ONLY sanctioned way to delete legacy volumes.
  Dry-run by default; `--yes` to act; removes a volume only when its host dir has
  ≥ its file count. Negative-tested: refuses + exits non-zero when host is empty.
  Raw `docker volume rm` is never to be used by hand again.

**Net state after fixes:** no `dd-*` volumes remain; durable state lives only
under `tools/domain-developer/state/<site>/`; images kept = `domain-developer:latest`,
`domain-developer-panel:latest`; all 3 containers run + `dd-doctor` 15/15.

## FOLLOW-ON 2026-08-23 — cattle, not pets (workers are now disposable)

The durability redesign made worker state independent of the container. This
follow-on cashes that in: `dd-<site>` workers are now **destroyed rather than
resurrected**, have **no restart policy**, and have a **bounded unattended
lifetime**. Full rationale in `README.md` § "Workers are cattle, not pets";
mechanics in `tools/scripts/reap-idle-dd-workers.sh`'s header; invariants
asserted by `bin/dd-doctor`'s CATTLE checks.

Two silent failures were found and fixed while proving it end to end. Both are
worth remembering because both *looked* like working code:

1. **The idle reaper could never fire.** `check-dd-containers-auth.sh` ran a
   real `claude -p` probe inside every worker every 10 minutes. That probe
   wrote a fresh transcript, security log and config backup into the worker's
   host-bound state dir — the exact directory the reaper reads mtimes from to
   decide "is anyone using this?". Every worker therefore read as active-
   within-10-minutes, permanently. The probe was removed (it cost money and
   told us nothing the credential sync doesn't), and the files that job still
   writes are excluded from the idle signal.

2. **The reaper never ran correctly from cron at all.** It used
   `find -printf '%T@'` and `date -d <RFC3339>` — both GNU-only. `fleet-cron`
   is Alpine, so under BusyBox every worker reported "can't determine
   idleness — skipping". It only ever appeared to work because it was
   hand-tested on the host. Both are now done in python3, which is already a
   hard dependency there. **This is the same class of bug as the 2026-05-30
   BusyBox `cp -n` silent no-op below** — that one cost a per-site Claude
   cache. Test container scripts with `docker exec fleet-cron`, never only on
   the host.

Verified end to end 2026-08-23: destroy+rebuild is lossless (marker file
survives), cold start is ~1.1s total (0.6s `docker run`, ttyd serving 200
within another 0.5s), all four reap paths (idle, image-drift, corpse-grace,
corpse-sweep) exercised for real inside the Alpine fleet-cron container, and
`dd-doctor` is 16/16 with the two live workers converted.

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
