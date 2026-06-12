# SecurityScanner — Portable, In-Project, Checked-In Install (Design)

**Date:** 2026-06-12
**Status:** Approved design, pre-implementation
**Author:** Jesse + Claude (brainstorming session)

---

## 1. Problem & Goal

The security dashboard (engine: `security_v2`, FastAPI/Python + Dockerized scanners) is
currently installed into the `domains` project via the `vsec` CLI, but the install lives at
`~/.vsec/installs/sec-c04d85` — **outside** the project and **not checked in**. Jesse wants
the opposite: a **portable, self-contained, reusable** scanner that is **installed into and
checked into the consuming project**, can be dropped into *unrelated* projects, runs on
dynamic ports, packages its own scanners, and can be **updated from a central core** while
**retaining each install's data and setup**.

### Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Engine** | Keep **v2 (Python)** now; keep packaging engine-agnostic so a future Rust engine can drop in without redoing distribution. | `security_v2` already scans + distributes. Rust `security_v3` is paused at ~30% and `PAUSED.md` concluded Rust does **not** itself solve distribution. Fastest path to the real goal. |
| **Product name** | **SecurityScanner** (CLI: `secscan`; prefix: `secscan-<project>-*`). | Literal, project-agnostic. Drops the vestigial "Vitae" branding (`v` in `vsec` = Vitae, the project it was born in). |
| **Checked-in scope** | **Config + manifest only.** | No binaries/secrets/DB in git. Engine materialized locally from a pinned release on install/upgrade. |
| **Containment** | **Fully in-project.** No `~/.vsec`, no global host state. Runtime lives in a gitignored dir inside the project. | "Each installation stands on its own, self-contained." |
| **Folder naming** | Visible `SecurityScanner/` for config; hidden `SecurityScanner/.runtime/` for generated/secret runtime. | Checked-in config is human-edited → must be visible. Runtime is generated/secret → dot-hidden + gitignored. |
| **Placement** | **Repo root**, not under `tools/`. | Structurally dodges the recursive-tar trap (see §3). |

### Out of scope (YAGNI for this pass)

- Reviving the Rust `security_v3` engine.
- Checking image tarballs into git (git-lfs air-gap mode).
- Relocating the core repo to `/mnt/encrypted/projects/` (optional, location-independent — can do later for free).
- Any new scanner types beyond what `security_v2` already ships.

---

## 2. Layout in a Consuming Project

```
<project>/                          # e.g. domains/
  SecurityScanner/                  # CHECKED IN — visible, human-edited
    secscan.toml                    #   instance name, engine version pin, port mode=auto
    projects/                       #   one file per scan target — SOURCE OF TRUTH
      3boobs.com.yaml               #     scope: sites/3boobs.com
      aliencouncil.com.yaml
      ...                           #     (one per sites/* domain)
      tools.yaml                    #     scope: tools/
    schedules.yaml                  #   per-project scan cadence
    manifest/
      install-manifest.json         #   pinned release version + image SHAs
    .env.example                    #   documents required runtime env (no secrets)
    README.md                       #   how to install/upgrade/sync in this project
    .runtime/                       # GITIGNORED — generated + secret, dot-hidden
      .env                          #   secrets (generated): DB/redis/jwt creds, ports
      images/                       #   pulled scanner image tarballs
      data/                         #   BIND-MOUNTED volumes: postgres/, redis/, sonarqube/
      temp-scans/                   #   scanner scratch space
      compose.override.yml          #   generated: prefix + port + bind-mount overlay
  .gitignore                        #   adds: SecurityScanner/.runtime/
```

**The checked-in `SecurityScanner/` is the source of truth.** `secscan` reconciles the running
engine *from* it (see §4). Deleting `SecurityScanner/` removes the entire install — nothing in
`~`, nothing in global Docker volumes.

### What is checked in vs. gitignored

- **Checked in:** `secscan.toml`, `projects/*.yaml`, `schedules.yaml`, `manifest/`, `.env.example`, `README.md`.
- **Gitignored (`SecurityScanner/.runtime/`):** `.env`, `images/`, `data/`, `temp-scans/`, `compose.override.yml`.

---

## 3. Why Repo-Root Placement Solves Recursive-Tar (the D.4 problem)

`vsec` commit `5cd80d8` (D.4) **deliberately moved installs out of the project tree** because
SonarQube-class scanners recursively tar their own scan root — if the install lives inside a
scanned directory, the scanner tars its own (growing) output and explodes. Excludes alone were
not trusted enough, which is *why* they moved out entirely.

**This design keeps the install in-project but makes recursive-tar structurally impossible:**

1. **Every scan scope is a subtree, never the repo root.** Each `projects/*.yaml` scopes to a
   specific subdirectory (`sites/<domain>`, `tools/`). We **never define a "scan the whole repo"
   project.**
2. `SecurityScanner/` sits at the **repo root**, which is *outside* every scan subtree
   (`sites/*`, `tools/`). So the scanner's own files/runtime are never inside any scan scope.
3. **Belt-and-suspenders:** `SecurityScanner/.runtime/` is gitignored *and* added to each
   scanner's exclude list.

If a future need arises to scan the whole repo, that project must explicitly exclude
`SecurityScanner/` — documented as a hard rule in the generated config.

---

## 4. CLI Surface (`secscan`)

`secscan` is the rebranded `vsec` (Bash). Existing subcommands largely carry over; the install
**layout** changes to the in-project model. Net-new subcommands marked **[new]**.

| Subcommand | Purpose |
|------------|---------|
| `secscan init [<project-dir>]` **[new]** | Scaffold the checked-in `SecurityScanner/` skeleton (`secscan.toml`, `.env.example`, `.gitignore` line, empty `projects/`). |
| `secscan install [<project-dir>]` | Materialize runtime under `SecurityScanner/.runtime/`: load image tarballs, generate `.env` (creds + free ports), write `compose.override.yml` (prefix + bind-mounts), start stack, run migrations, then `sync`. |
| `secscan sync` **[new]** | Read `projects/*.yaml` + `schedules.yaml` and **idempotently reconcile** Projects, tool-targets, and schedules into the running engine. Checked-in config is authoritative; drift is corrected. |
| `secscan scan [<project>]` | Trigger a scan for one/all configured projects. |
| `secscan upgrade [<version>]` | Pull a newer release from core, load new images, run migrations, **preserve** `.env` + `data/` + checked-in config. |
| `secscan status` / `list` | Show install + scan state. |
| `secscan verify` | Verify manifest SHAs + health. |
| `secscan uninstall` | Stop + remove containers and `SecurityScanner/.runtime/`. |
| `secscan build <version>` / `release <version>` | (Core repo only) build versioned image tarballs + manifest; publish a release. |

### Port allocation
`port mode=auto` in `secscan.toml` → `install` finds free host ports and records them in
`.runtime/.env`. Multiple installs on one host never collide (per-instance prefix + dynamic ports).

### Namespacing
Container/volume/network names are prefixed `secscan-<project>-*` (e.g. `secscan-domains-api`),
derived from the project dir name, so concurrent installs on one host stay isolated. (Replaces
the hardcoded `vitae-v2-*` names that caused cross-install corruption.)

---

## 5. `projects/*.yaml` and `schedules.yaml` (config schema)

**`projects/<name>.yaml`** — one scan target:
```yaml
name: 3boobs.com
scope: sites/3boobs.com        # path relative to repo root; never "." (repo root)
languages: [astro, typescript, javascript]   # auto-detected, overridable
scanners: [semgrep, gitleaks, sonarqube]      # subset enabled for this target
excludes:
  - node_modules
  - dist
```

**`schedules.yaml`** — cadence per project:
```yaml
defaults:
  cadence: weekly
projects:
  tools: { cadence: daily }
  3boobs.com: { cadence: weekly }
```

`secscan sync` reconciles these into the engine (create/update/delete Projects + tool-targets +
schedules) so the git-tracked files are the single source of truth.

---

## 6. Update-From-Core

- **Core** = the `security_v2` repo (engine + `secscan` CLI). `secscan build`/`release` produce
  versioned image tarballs + `install-manifest.json`. Releases written under the **core repo's
  own** `dist/releases/<version>/` (gitignored) — no `~/.vsec`, no global host state anywhere.
- **Consuming project** pins a version in `secscan.toml` + `manifest/`. `secscan upgrade [version]`
  pulls the newer release, loads new images, applies DB migrations, and **preserves** `.env`,
  `data/` volumes, and the checked-in `SecurityScanner/` config.
- This satisfies "roll out features + bugfixes centrally; installs retain data/setup."
- **Optional/free:** relocate the canonical core clone to `/mnt/encrypted/projects/security_v2`.
  The upgrade mechanism is location-independent (git + built tarballs), so this is a no-cost move
  whenever Jesse wants it.

---

## 7. Claude Skill: `securityscanner-install`

Supersedes `skill-security_v2-install`. Autonomous installer that:

1. Detects the consuming project root and its structure.
2. For `domains`: enumerates `sites/*` → one `projects/<domain>.yaml` each; adds `tools.yaml`
   scoped to `tools/`. (Generic projects: detect top-level code areas, propose project files.)
3. Sets default schedules (`tools` daily, sites weekly — overridable).
4. Runs `secscan init` → `install` → `sync`.
5. Validates: containers healthy on dynamic ports, dashboard reachable, a smoke scan fires and
   returns findings.
6. Adds `SecurityScanner/.runtime/` to `.gitignore` and leaves `SecurityScanner/` staged for commit.

The skill is **engine-agnostic** at the CLI boundary (`secscan ...`), so a future Rust engine
needs no skill change.

---

## 8. Operational Caveats (to handle in the plan)

- **Bind-mount ownership.** Scanner containers run as assorted UIDs (current `temp-scans/` is
  owned by `dnsmasq:1500`). Bind-mounting `data/`/`temp-scans/` into the project can create
  root/other-owned files that are hard to delete. **Plan must pin container UIDs / set mount
  ownership** so `SecurityScanner/.runtime/` never leaves un-deletable files in the repo.
- **Existing install migration.** The current `sec-c04d85` install at `~/.vsec/installs/` is
  **not production** — it will be replaced by a clean in-project install. (Optionally write a
  `secscan migrate-from-vsec` that lifts its config; cheaper to just re-`init` + `sync`.)
- **Rename surface.** `vsec` → `secscan`, `vitae-v2-*` → `secscan-<project>-*`, container/volume/
  network/env-var references, the `.vsec` pointer file (removed — the install *is*
  `SecurityScanner/`), and the existing skill. Existing `tests/vsec/` must be updated/renamed.

---

## 9. Validation Plan

1. **Clean install into `domains/`** with the new layout; replace `sec-c04d85`.
   - Verify: `SecurityScanner/` checked in (config only); `.runtime/` gitignored; dynamic ports;
     all `sites/*` + `tools` projects present; smoke scan returns findings; no recursive-tar.
2. **Install into one unrelated project** (e.g. `wootTracker` or `worldmonitor`) via the skill to
   prove portability end-to-end — two isolated installs coexisting on one host.
3. **Upgrade round-trip:** bump a release in core → `secscan upgrade` in `domains/` → confirm new
   images load and existing scan data/config survive.

---

## 10. Build Sequence (high level; detailed plan follows)

1. Rebrand core: `vsec` → `secscan`, strip Vitae names, parameterize prefix. Update `tests/vsec/`.
2. Implement in-project layout in `install` (config in `SecurityScanner/`, runtime in
   `.runtime/`, bind-mounts, generated `compose.override.yml`, UID pinning).
3. Implement `init` + `sync` (config-as-source-of-truth reconciliation).
4. Rewrite the install skill as `securityscanner-install`.
5. Validate in `domains/` (clean install).
6. Validate portability in a second project + upgrade round-trip.
