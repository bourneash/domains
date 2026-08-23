# domain-developer

Sandboxed per-site dev containers for the domains portfolio. Each site gets its own Docker container with claude, node, git, wrangler, and the rest of the toolchain pre-installed, with **only that site's directory** bind-mounted at `/work`. Host filesystem stays protected when running `claude --dangerously-skip-permissions`.

## Architecture

Two layers, both containerized:

- **Management plane** — `dd-panel` runs inside its own Docker container, listening on `127.0.0.1:7777`. It talks to the host Docker daemon via the mounted socket and spawns **sibling** worker containers. Not a host process; lifecycle is fully managed by `bin/dd-up` / `bin/dd-down`.
- **Workers** — one `dd-<site>` container per site, spun up on demand by the panel (or by the CLI). Each runs ttyd → bash + claude with only that site's directory mounted at `/work`. Workers are **cattle, not pets** — see below.

## Quickstart

```bash
# Bring up the panel (builds images on first run)
tools/domain-developer/bin/dd-up
# → http://127.0.0.1:7777

# Or use the CLI to drop into one site's container directly
tools/domain-developer/bin/domain-developer americastrikes.com

# Tear down the panel (leaves worker containers running)
tools/domain-developer/bin/dd-down

# Tear down everything
tools/domain-developer/bin/dd-down --purge
```

Inside the container shell:

```bash
yolo                  # claude --dangerously-skip-permissions
sane                  # claude (normal, with approvals)
npm run build         # site tooling works normally
```

## What's mounted (Option A — per-site claude state)

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `sites/<name>/` | **same host path** | rw | site code; same-path so claude's project-ID encoding matches host |
| `dd-claude-<name>` (volume) | `/home/dev/.claude` | rw | per-site claude state; entrypoint seeds it from `.claude.json` on first boot |
| `~/.claude.json` | `/host-claude-json-ro` | **ro** | source for one-time copy at startup; never read after that |
| `~/.claude/plugins/`, `commands/`, `hooks/` | `/home/dev/.claude/{plugins,commands,hooks}` | **ro** | shared skills/commands/hooks — use, can't edit |
| `~/.claude/.credentials.json` | `/home/dev/.claude/.credentials.json` | **ro** | OAuth auth shared with host |
| `~/.claude/projects/-home-jesse-projects-domains-sites-<name>/` | same host path | **rw** | per-site memory + transcripts; traverse up to host |
| `~/.ssh/` | `/home/dev/.ssh` | **ro** | git push via existing keys |
| `domains/.env` | `<site-dir>/.env.shared` | **ro** | shared CF + affiliate creds (only if file exists) |
| `dd-home-<name>` (volume) | `/home/dev/persist` | rw | per-site general scratch |

**Not mounted:** other sites' code, other sites' claude state, the rest of `$HOME`, root filesystem, host bin paths. The whole `~/.claude` directory is **not** RW-mounted into workers — that was the source of the 2026-05-28 truncation incident. The fix: each worker has its OWN `.claude` volume (writable), with only the read-only bits bind-mounted from host.

## What's installed in the image

bash, zsh, curl, wget, git, gh, jq, yq, ripgrep, fd, fzf, vim, nano, python3, pipx, node 22 + npm + pnpm, build-essential, wrangler, `@anthropic-ai/claude-code`, ttyd.

## Web panel

The panel container (`dd-panel`) serves the UI on `127.0.0.1:7777`. It:

- Lists every directory under `sites/`
- Shows container status (running / exited / absent)
- One-click [open terminal] launches the worker and opens a new tab to its ttyd (port `7800+N`, allocated per site)
- Stop / remove buttons for housekeeping

Per-site port assignments persist in `tools/domain-developer/state.json` (file-mounted into the panel container).

### Lifecycle scripts

| Script | Purpose |
|---|---|
| `bin/dd-up`               | Build (if needed) + start the panel. Idempotent. |
| `bin/dd-down`             | Stop the panel. Leaves worker containers alone. |
| `bin/dd-down --all`       | Also stop every `dd-<site>` worker. |
| `bin/dd-down --purge`     | Stop AND remove every worker (named volumes kept). |
| `bin/dd-recreate <site>`  | Destroy + rebuild one worker from the current image. State preserved. |
| `bin/dd-doctor [site]`    | Verify the durability + cattle invariants. Exit non-zero on any violation. |
| `bin/dd-build`            | Rebuild the worker base image (`domain-developer:latest`). |
| `bin/domain-developer <site>` | Direct CLI shell (works without the panel). |

### Workers are cattle, not pets

A `dd-<site>` worker container is **disposable and never resurrected**. Concretely:

- **No restart policy.** Workers are created with `--restart no`. They previously
  used `--restart unless-stopped`, which meant every worker ever started came back
  after any daemon or host restart, whether or not anyone wanted it.
- **Not-running means destroyed.** Both entry points (`bin/domain-developer` and the
  panel's `startContainer`) destroy any container that isn't currently *running* and
  create a fresh one, rather than `docker start`ing it back to life. This is the
  load-bearing part: a stopped container object pins the image it was created from
  forever, so a `dd-build` landing while a worker sat stopped would silently never
  reach it.
- **Stop means destroy.** The panel's Shut down button and `domain-developer --stop`
  both remove the container. There is no "parked worker" state to accumulate in.
- **Bounded lifetime.** `tools/scripts/reap-idle-dd-workers.sh` (fleet-cron job 9)
  destroys workers idle past 4h, workers running a stale image while idle past 15min,
  and dead container objects past a 1h `docker logs` postmortem window.
- **Verified, not assumed.** `bin/dd-doctor`'s CATTLE checks assert all of the above
  on every live container, so a regression shows up as a failing gate rather than as
  the next incident.

This is safe **only** because of the durability redesign (`REDESIGN.md`): every byte
of durable state — site code, Claude config, transcripts, scratch — lives on host
bind mounts, never in the container. Destroying a worker loses nothing and a rebuild
takes about a second end-to-end (measured: 0.6s for `docker run`, ttyd serving HTTP
200 within another 0.5s). If you ever move state back into the container or into a
named volume, this whole model becomes unsafe.

The one pet the model can still produce is a **long-running active session started
before the last `dd-build`**. That is never auto-killed — someone may be mid-thought
— but it is never silent either: the panel shows a `⚠ stale image` badge, `dd-doctor`
fails on it, and the reaper posts to Slack. Fix it with `bin/dd-recreate <site>`.

`dd-panel` itself deliberately keeps `--restart unless-stopped`. It is the control
plane, not a worker: it is compose-managed, rebuilt from source on every `dd-up`, and
holds no per-site state. `dd-doctor` excludes it. Do not "fix" it.

### Why the panel itself is containerized

The panel container mounts `/var/run/docker.sock` and shells out to the `docker` CLI to spawn sibling workers. Two pieces had to line up:

1. **Same-path sites mount.** `sites/` is bind-mounted at the same absolute path inside the panel as on the host (e.g. `/home/jesse/projects/domains/sites`), so `fs.readdir` works inside AND the path strings the panel passes to `docker run -v` resolve correctly when the daemon (on host) reads them.
2. **Host paths via env, not `os.homedir()`.** `DD_HOST_HOME` and `DD_HOST_DOMAINS_ROOT` are injected by compose. The panel uses them to build `-v ~/.claude:...` and `-v sites/<name>:/work` flags — never its own filesystem view.

## CLI usage

```bash
domain-developer <site>                # shell in container
domain-developer <site> claude         # run command and exit
domain-developer --list                # list sites
domain-developer --stop <site>
domain-developer --rm   <site>         # remove container (site dir untouched)
```

## Threat model

**Protected:** the rest of `$HOME`, `~/.ssh` keys (mounted read-only), other site directories, system files, host packages, host network state outside docker bridge.

**Not protected:**
- The mounted site directory — claude can `rm -rf /work` and delete the working copy. Git history + remote saves you.
- The bourneash/* GitHub repo for that site — claude has push access via the SSH key mount.
- Cloudflare deploys for that site — if creds are in the shared `.env`, claude can deploy.
- Outbound network — egress is unrestricted (claude needs npm + git + CF).

If a site needs harder isolation (e.g. testing untrusted code), drop the SSH and `.env.shared` mounts at run time.

## Files

```
tools/domain-developer/
├── bin/
│   ├── dd-up             # build (if needed) + start the panel container
│   ├── dd-down           # stop the panel; flags: --all, --purge
│   ├── dd-build          # rebuild the worker base image
│   └── domain-developer  # CLI: shell into one site's worker container
├── docker/
│   ├── Dockerfile        # worker image: ubuntu + node + claude + ttyd + ...
│   ├── panel.Dockerfile  # panel image: alpine + node + docker-cli
│   ├── entrypoint.sh     # worker entrypoint: starts ttyd → bash
│   └── bashrc            # in-container shell setup
├── docker-compose.yml    # panel service definition
├── server/
│   ├── package.json
│   ├── server.js         # Express + Docker orchestration
│   └── public/index.html # site picker UI
└── state.json            # per-site port assignments (created by dd-up)
```
