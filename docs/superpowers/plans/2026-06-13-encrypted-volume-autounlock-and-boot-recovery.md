# Plan: Auto-unlock `/mnt/encrypted` (TPM2) + boot-safe SecurityScanner recovery

**Status:** PAUSED — design captured, NOT implemented. Resume after reboot.
**Created:** 2026-06-13
**Owner decision required before implementing** (boot-critical + DR questions below).

---

## Why this exists (the problem)

The SecurityScanner (`secscan`) install for **wootTracker** lives under `/mnt/encrypted/projects/wootTracker/SecurityScanner/` — i.e. its config, its bind-mounted Postgres data, AND the source code it scans are all on the encrypted volume.

`/mnt/encrypted` is a **password-protected LUKS volume that is NOT auto-mounted at boot** (no `crypttab`/`fstab` entry; unlocked manually). So on a host reboot:

- **domains scanner** (on `/`, the always-on root fs) → auto-recovers fine (`restart: unless-stopped`, docker enabled). ✅
- **woottracker scanner** → **breaks**: Docker starts before `/mnt/encrypted` is mounted, the bind-mount sources don't exist, Docker creates empty dirs under the unmounted mountpoint, and Postgres boots a **blank DB on the root fs** — polluting the mountpoint and diverging from the real data. ❌

Current mitigation (already in place): woottracker containers were `docker stop`ped before the reboot window so `unless-stopped` keeps them **down** on boot (a user-stopped container does not auto-start). After a reboot you unlock `/mnt/encrypted` manually, then `docker start $(docker ps -aq --filter name=secscan-woottracker-)`.

**Goal of this plan:** make woottracker (and optionally other `/mnt/encrypted`-resident services) come back **fully hands-off** after a reboot — *without manually typing the LUKS passphrase*.

> Note: even if the containers started, they couldn't *scan* woottracker's code until `/mnt/encrypted` is mounted — so auto-unlocking the volume is the real requirement, not just container ordering.

---

## Current-state facts (verified 2026-06-13)

- `/mnt/encrypted` = ext4 on mapper **`encrypted_lv`**, which is **LUKS** (`crypto_LUKS`) on top of an LVM striped LV **`vg_ssd-lv_striped`** (across `sda1` + `sdb1`).
  - LUKS device for enrollment/crypttab: **`/dev/mapper/vg_ssd-lv_striped`**, LUKS UUID **`548a55e0-9ac1-4c6c-9db8-ad952555788c`**.
  - Opened mapper name (keep this): **`encrypted_lv`**.
- **Not** in `/etc/crypttab` → fully manual today. Other disks (`disk0..7`) are `luks,noauto`; `dm_crypt-1` is auto.
- Manual unlock helper exists: `/usr/local/bin/unlock_luks_disk.sh` (currently hardcoded to `disk2`, not `encrypted_lv`).
- **TPM2 present** (`/sys/class/tpm/tpm0`) and **`systemd-cryptenroll` available** → hardware-bound auto-unlock is possible. ← this is the good path.
- Docker daemon: `systemctl is-enabled docker` = **enabled** (starts on boot).
- All 16 secscan containers (domains 8 + woottracker 8) are `restart: unless-stopped`.
- `domains` is on `/` (`/dev/mapper/vg0-lv--0`) → unaffected by any of this.

---

## The security tradeoff (read before deciding)

Any "auto-unlock without typing" means the unlock secret must be readable by the machine at boot. You are trading:

- **Today:** encryption protects a powered-off/stolen disk **and** requires a human at boot.
- **After:** protects a powered-off/stolen disk, but a normally-booted machine self-unlocks.

That's usually the right trade for an unattended server — just be clear that's the change.

**Two ways to auto-unlock, ranked:**

1. **TPM2 enrollment (RECOMMENDED — hardware is present).** Seal a key into the TPM, bound to *this machine*. Boot normally → unseals automatically. No password, **no plaintext key on disk**. Remove the disks to another box → they stay locked.
2. **Keyfile in `/etc/crypttab` (the cheap way).** A keyfile on the unencrypted root fs. Works, but the key sits in plaintext on `/` — anyone who images the whole machine gets it. Strictly weaker than TPM. Only worth it if TPM enrollment hits a snag.

Optional TPM hardening: `--tpm2-pcrs=7` binds unseal to Secure Boot state (resists evil-maid boot tampering) but is **brittle** — firmware/boot updates change PCRs and require re-enroll. Recommendation: start **without** PCR binding (robust), add later if desired.

---

## ⚠️ OPEN QUESTIONS — resolve these BEFORE implementing (Jesse's flag)

These are the "what if" / disaster-recovery items to work out first:

1. **Restore on a DIFFERENT machine.** TPM-sealed keys are machine-specific — a new motherboard/TPM **cannot** unseal. Key facts to confirm and design around:
   - TPM enrollment **adds** a keyslot; it does **not** remove the existing passphrase. So the **LUKS passphrase remains the fallback** and is what you'd use to open the volume on different hardware. → Confirm the passphrase keyslot is preserved and known/escrowed.
   - Consider enrolling a **recovery key** too (`systemd-cryptenroll --recovery-key`) and storing it offline.
2. **LUKS header backup.** A corrupt/overwritten LUKS header = permanent data loss even with the right passphrase. Plan a `cryptsetup luksHeaderBackup` stored off-box. (Header backup + passphrase = recoverable anywhere.)
3. **Where do the passphrase / recovery key / header backup live?** (password manager, offline media, escrow). Define this before relying on auto-unlock, so convenience doesn't erase recoverability.
4. **PCR binding: yes or no?** Robustness (no PCRs) vs tamper-resistance (PCR 7). Decide.
5. **Scope:** just woottracker, or a reusable unit pattern for everything on `/mnt/encrypted` that should come up post-boot? (There are many other projects under `/mnt/encrypted/projects/`.)
6. **Failure behavior:** if TPM unseal ever fails (e.g., after firmware update), what should boot do — proceed without the volume (`nofail`) and leave dependent services down, vs. block? (This plan assumes `nofail` + hard-gated service units so a failed unseal causes *nothing to start* rather than corruption.)

---

## Proposed implementation (after the questions above are settled)

### Part 1 — Auto-unlock `encrypted_lv` via TPM2
1. **Enroll TPM keyslot** (run by Jesse so the passphrase isn't in an agent's context; needs current passphrase once):
   ```bash
   sudo systemd-cryptenroll /dev/mapper/vg_ssd-lv_striped --tpm2-device=auto
   # (optional later) add: --tpm2-pcrs=7
   ```
2. **`/etc/crypttab`** — add:
   ```
   encrypted_lv UUID=548a55e0-9ac1-4c6c-9db8-ad952555788c none luks,tpm2-device=auto
   ```
3. **`/etc/fstab`** — add (nofail so a TPM hiccup can't hang boot):
   ```
   /dev/mapper/encrypted_lv /mnt/encrypted ext4 defaults,nofail,x-systemd.device-timeout=30 0 2
   ```

### Part 2 — Start woottracker containers only AFTER the mount
- Set woottracker's 8 containers to **`restart: no`** so Docker never auto-starts them on boot (`docker update --restart=no <containers>` + bake into compose override). Only the unit below starts them.
- Create `/etc/systemd/system/secscan-woottracker.service`:
  ```ini
  [Unit]
  Description=SecurityScanner (secscan) — wootTracker
  Requires=docker.service
  After=docker.service mnt-encrypted.mount
  RequiresMountsFor=/mnt/encrypted        # hard-gate: no mount → unit doesn't run → no blank-DB pollution
  [Service]
  Type=oneshot
  RemainAfterExit=yes
  WorkingDirectory=/mnt/encrypted/projects/wootTracker/SecurityScanner/.runtime
  ExecStart=/usr/bin/docker compose --env-file .env -f docker-compose.yml -f docker-compose.images.yml -f compose.override.yml --profile sonarqube up -d
  ExecStop=/usr/bin/docker compose --env-file .env -f docker-compose.yml -f docker-compose.images.yml -f compose.override.yml stop
  [Install]
  WantedBy=multi-user.target
  ```
  `RequiresMountsFor=/mnt/encrypted` is the safety line: a failed unseal → unit skipped → nothing starts on bad data.
- `sudo systemctl daemon-reload && sudo systemctl enable secscan-woottracker.service`.
- domains is untouched (stays `unless-stopped` on `/`).

### Part 3 — Validate WITHOUT a real reboot before trusting it
1. `sudo systemd-cryptsetup attach test-enc /dev/mapper/vg_ssd-lv_striped '' tpm2-device=auto` → confirm TPM unseal works, then `sudo systemd-cryptsetup detach test-enc`.
2. `systemd-analyze verify secscan-woottracker.service` (+ the generated mount unit) → catch ordering/syntax errors.
3. `sudo systemctl start secscan-woottracker.service` with the volume mounted → confirm it brings the stack up.
4. Only after the above: schedule a real reboot test.

---

## How to resume (post-reboot checklist)

1. Re-read this file. Answer the **Open Questions** section first (DR / restore-elsewhere / header backup / passphrase escrow).
2. Confirm current state still matches "Current-state facts" (UUIDs, TPM present): `lsblk -o NAME,FSTYPE,UUID`, `ls /sys/class/tpm/`.
3. Bring woottracker back if needed (manual, until this is implemented): unlock `/mnt/encrypted`, then `docker start $(docker ps -aq --filter name=secscan-woottracker-)`.
4. Implement Parts 1→3 above, with Jesse running the `systemd-cryptenroll` step.

**Related context:** SecurityScanner / secscan project memory at `~/.claude/projects/-home-jesse-projects-domains/memory/project_securityscanner.md`. Engine branch `SynapticWorkshop/security_v2:feat/secscan-in-project`.
