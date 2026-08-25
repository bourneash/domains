#!/usr/bin/env python3
"""fleet-backup — offsite snapshots of the fleet's unreproducible state.

WHY
Git covers the code. Nothing covered the state: cf-stats' JSONL is the only
historical Cloudflare record on Earth, site-tracker's facts are hand-entered,
Gatus' uptime history is the input to any future SLO, and the dashboard's
action log is the only record of which agent pushed or restarted what. A host
loss took all of it. `tools/credential-vault-backup` covers only Vaultwarden.

DESIGN
* **Secrets can never be in an archive.** The `never` list is asserted against
  every file as it is added, not merely used as a filter — an offsite copy of
  the fleet's credentials is worse than having no backup at all, so the run
  aborts rather than skipping a match.
* **Incremental where it matters.** cf-stats grows ~5 MB/day and never
  rewrites old files; re-uploading 197 MB nightly is waste. Those groups ship
  only files modified since the last successful run.
* **Verified, not assumed.** Every upload is read back (size + checksum)
  before the run is recorded as successful. A backup nobody has restored is a
  hypothesis — `--drill` restores the newest archive of each group into a temp
  dir and checks it unpacks.
* **Restore never overwrites in place** by default; it stages to a directory
  you name and leaves the reconciliation to a human.

USAGE
    backup.py --dry-run
    backup.py                       # snapshot + upload + verify + prune
    backup.py --list
    backup.py --drill               # prove the newest archives restore
    backup.py --restore <group> --into /tmp/restore
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
STATE_FILE = TOOL_DIR / "state.json"


class SecretInArchive(RuntimeError):
    """A path matching the `never` list was about to be archived."""


def load_manifest() -> dict:
    return yaml.safe_load((TOOL_DIR / "manifest.yaml").read_text())


def load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            v = v.strip()
            # Shell-style quoting: `. .env` strips these, a naive parser does
            # not, and boto3 then rejects a perfectly good endpoint URL.
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            os.environ.setdefault(k.strip(), v)


def client():
    import boto3
    from botocore.config import Config
    missing = [k for k in ("CF_S3_API_ENDPOINT", "CF_ACCESS_KEY_ID", "CF_SECRET_ACCESS_KEY")
               if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"missing R2 credentials in .env: {', '.join(missing)}")
    return boto3.client(
        "s3",
        endpoint_url=os.environ["CF_S3_API_ENDPOINT"],
        aws_access_key_id=os.environ["CF_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["CF_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            pass
    return {"groups": {}}


def assert_no_secret(rel: str, never: list[str]) -> None:
    parts = Path(rel).parts
    for pattern in never:
        pp = Path(pattern).parts
        if pattern in rel or (len(pp) == 1 and pattern in parts):
            raise SecretInArchive(
                f"refusing to archive {rel!r}: matches never-backup rule {pattern!r}")


def collect(paths: list[str], since: float | None, never: list[str]) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    for p in paths:
        src = ROOT / p
        if not src.exists():
            continue
        files = [src] if src.is_file() else [f for f in src.rglob("*") if f.is_file()]
        for f in files:
            rel = str(f.relative_to(ROOT))
            assert_no_secret(rel, never)
            if since is not None and f.stat().st_mtime <= since:
                continue
            out.append((f, rel))
    return out


def _spool() -> tempfile.NamedTemporaryFile:
    return tempfile.NamedTemporaryFile(prefix="fleet-backup-", suffix=".tar.gz")


def _digest_of(fh) -> tuple[str, int]:
    """sha256 + byte length of an open file, read in chunks."""
    h = hashlib.sha256()
    fh.seek(0)
    n = 0
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        h.update(chunk)
        n += len(chunk)
    fh.seek(0)
    return h.hexdigest(), n


def archive_volume(name: str, exclude: list[str] | None = None):
    """Tar a named Docker volume via a throwaway container, streamed to disk.

    data-hub and data-hub-images keep their SQLite databases in named volumes,
    not on a host path. A filesystem-only backup silently skips exactly the two
    databases the fleet's analytics run on, and reports success while doing it.

    Streamed, never buffered: data-hub-images' volume is 1.8 GB, and an
    in-memory tarball of it took this process to 3.8 GB RSS on a host running
    200+ containers. Memory here is O(chunk), not O(volume).
    """
    import subprocess
    args = ["docker", "run", "--rm", "-v", f"{name}:/src:ro", "alpine:3.20.6",
            "tar", "-czf", "-", "-C", "/src"]
    for pattern in (exclude or []):
        args += ["--exclude", f"./{pattern}"]
    args.append(".")

    spool = _spool()
    proc = subprocess.Popen(args, stdout=spool, stderr=subprocess.PIPE)
    _, err = proc.communicate(timeout=1800)
    if proc.returncode != 0:
        spool.close()
        raise RuntimeError(f"docker tar of volume {name} failed: "
                           f"{err.decode(errors='replace')[:200]}")
    digest, size = _digest_of(spool)
    with tarfile.open(fileobj=spool, mode="r:gz") as tar:
        count = sum(1 for m in tar.getmembers() if m.isfile())
    spool.seek(0)
    return spool, digest, size, count


def make_archive(files: list[tuple[Path, str]]):
    """Build the archive on disk, not in RAM — see archive_volume for why."""
    spool = _spool()
    with tarfile.open(fileobj=spool, mode="w:gz") as tar:
        for path, rel in files:
            tar.add(path, arcname=rel)
    digest, size = _digest_of(spool)
    return spool, digest, size


def run_backup(args, manifest) -> int:
    never = manifest["never"]
    dest = manifest["destination"]
    state = load_state()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    s3 = None if args.dry_run else client()
    if s3 is not None:
        ensure_bucket(s3, dest["bucket"])

    rc = 0
    for name, spec in manifest["groups"].items():
        if spec.get("volume"):
            if args.dry_run:
                ex = spec.get("volume_exclude") or []
                note = f" (excluding {', '.join(ex)})" if ex else ""
                print(f"{name:22s} would archive docker volume {spec['volume']}{note}")
                continue
            spool, digest, size, count = archive_volume(
                spec["volume"], spec.get("volume_exclude"))
            key = f"{dest['prefix']}/{name}/{stamp}.tar.gz"
            with spool:
                s3.upload_fileobj(spool, dest["bucket"], key, ExtraArgs={
                    "Metadata": {"sha256": digest, "files": str(count)}})
            if not verified(s3, dest["bucket"], key, size, digest):
                print(f"{name:22s} VERIFY FAILED — not recording this run", file=sys.stderr)
                rc = 1
                continue
            state["groups"][name] = {"last_key": key, "sha256": digest, "files": count,
                                     "bytes": size, "at": stamp}
            print(f"{name:22s} {count:5d} files, {size/1_048_576:7.2f} MB, verified (volume)")
            continue

        since = None
        if spec.get("incremental"):
            since = state["groups"].get(name, {}).get("last_mtime")
        try:
            files = collect(spec["paths"], since, never)
        except SecretInArchive as e:
            print(f"ABORT {name}: {e}", file=sys.stderr)
            return 1
        if not files:
            print(f"{name:22s} nothing new")
            continue

        spool, digest, size = make_archive(files)
        key = f"{dest['prefix']}/{name}/{stamp}.tar.gz"
        newest = max(f.stat().st_mtime for f, _ in files)
        size_mb = size / 1_048_576
        if args.dry_run:
            spool.close()
            print(f"{name:22s} would upload {len(files):5d} files, {size_mb:7.2f} MB -> {key}")
            continue

        with spool:
            s3.upload_fileobj(spool, dest["bucket"], key, ExtraArgs={
                "Metadata": {"sha256": digest, "files": str(len(files))}})
        if not verified(s3, dest["bucket"], key, size, digest):
            print(f"{name:22s} VERIFY FAILED — not recording this run", file=sys.stderr)
            rc = 1
            continue

        state["groups"][name] = {"last_key": key, "last_mtime": newest,
                                 "sha256": digest, "files": len(files),
                                 "bytes": size, "at": stamp}
        print(f"{name:22s} {len(files):5d} files, {size_mb:7.2f} MB, verified")

    if not args.dry_run:
        STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")
        prune(client(), manifest)
    return rc


def verified(s3, bucket: str, key: str, size: int, digest: str) -> bool:
    """Read the object back. A run is only recorded once this passes, so a
    failed verify simply re-sends next time rather than silently losing data."""
    head = s3.head_object(Bucket=bucket, Key=key)
    return head["ContentLength"] == size and head["Metadata"].get("sha256") == digest


def ensure_bucket(s3, bucket: str) -> None:
    from botocore.exceptions import ClientError
    try:
        s3.head_bucket(Bucket=bucket)
    except ClientError:
        s3.create_bucket(Bucket=bucket)
        print(f"created bucket {bucket}")


def prune(s3, manifest) -> None:
    dest, days = manifest["destination"], manifest["retention_days"]
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    removed = 0
    token = None
    while True:
        kw = {"Bucket": dest["bucket"], "Prefix": dest["prefix"]}
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        for obj in page.get("Contents", []):
            if obj["LastModified"] < cutoff:
                s3.delete_object(Bucket=dest["bucket"], Key=obj["Key"])
                removed += 1
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
    if removed:
        print(f"pruned {removed} archive(s) older than {days}d")


def cmd_list(manifest) -> int:
    s3, dest = client(), manifest["destination"]
    page = s3.list_objects_v2(Bucket=dest["bucket"], Prefix=dest["prefix"])
    rows = sorted(page.get("Contents", []), key=lambda o: o["Key"])
    if not rows:
        print("no archives yet")
        return 0
    for o in rows:
        print(f"{o['LastModified']:%Y-%m-%d %H:%M}  {o['Size']/1_048_576:8.2f} MB  {o['Key']}")
    print(f"\n{len(rows)} archive(s), "
          f"{sum(o['Size'] for o in rows)/1_048_576:.1f} MB total")
    return 0


def newest_keys(s3, manifest) -> dict[str, str]:
    dest = manifest["destination"]
    page = s3.list_objects_v2(Bucket=dest["bucket"], Prefix=dest["prefix"])
    latest: dict[str, str] = {}
    for o in page.get("Contents", []):
        group = o["Key"].split("/")[1]
        if group not in latest or o["Key"] > latest[group]:
            latest[group] = o["Key"]
    return latest


def cmd_drill(manifest) -> int:
    """Restore every group's newest archive into a temp dir and unpack it.

    A backup nobody has restored is a hypothesis, not a backup.
    """
    s3 = client()
    latest = newest_keys(s3, manifest)
    if not latest:
        print("no archives to drill", file=sys.stderr)
        return 1
    rc = 0
    with tempfile.TemporaryDirectory(prefix="fleet-backup-drill-") as tmp:
        for group, key in sorted(latest.items()):
            body = s3.get_object(Bucket=manifest["destination"]["bucket"], Key=key)["Body"].read()
            try:
                with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
                    # Count FILE members only. A `tar -C /src .` of a docker
                    # volume also carries the "./" directory entry, and
                    # comparing against every member reported a perfectly good
                    # archive as a MISMATCH.
                    expected = sum(1 for m in tar.getmembers() if m.isfile())
                    tar.extractall(Path(tmp) / group)
                on_disk = sum(1 for p in (Path(tmp) / group).rglob("*") if p.is_file())
                ok = on_disk == expected
                print(f"{group:22s} {expected:5d} files, {on_disk} restored "
                      f"{'OK' if ok else 'MISMATCH'}")
                rc |= 0 if ok else 1
            except Exception as e:  # noqa: BLE001 — any failure is a failed drill
                print(f"{group:22s} DRILL FAILED: {type(e).__name__}: {e}", file=sys.stderr)
                rc = 1
    return rc


def cmd_restore(args, manifest) -> int:
    s3 = client()
    latest = newest_keys(s3, manifest)
    key = latest.get(args.restore)
    if not key:
        print(f"no archive for group {args.restore!r}. Known: {', '.join(sorted(latest))}",
              file=sys.stderr)
        return 1
    into = Path(args.into)
    # Never restore over the live tree by default — reconciling is a human call.
    if into.resolve() == ROOT.resolve():
        print("refusing to restore over the live repo; pass --into <staging dir>",
              file=sys.stderr)
        return 1
    into.mkdir(parents=True, exist_ok=True)
    body = s3.get_object(Bucket=manifest["destination"]["bucket"], Key=key)["Body"].read()
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
        tar.extractall(into)
    print(f"restored {key} -> {into}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--drill", action="store_true")
    ap.add_argument("--restore", metavar="GROUP")
    ap.add_argument("--into", default="")
    args = ap.parse_args()

    load_env()
    manifest = load_manifest()
    if args.list:
        return cmd_list(manifest)
    if args.drill:
        return cmd_drill(manifest)
    if args.restore:
        if not args.into:
            ap.error("--restore needs --into <dir>")
        return cmd_restore(args, manifest)
    return run_backup(args, manifest)


if __name__ == "__main__":
    sys.exit(main())
