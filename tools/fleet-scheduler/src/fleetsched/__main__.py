"""fleetsched — serve | import | export | healthcheck"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import threading
import urllib.request
from pathlib import Path

from .api import Service, make_server
from .db import DB
from .engine import Config, Engine, make_wrapper
from .importer import compose_cron_env, crontab_path, export_crontab, import_site


def _token() -> str:
    f = os.environ.get("FS_TOKEN_FILE")
    if f:
        return Path(f).read_text().strip()
    return os.environ.get("FS_TOKEN", "").strip()


def _cfg() -> Config:
    data = Path(os.environ.get("FS_DATA", "/data"))
    cwd = os.environ.get("FS_CWD")
    kw = {}
    if cwd:  # single-group instance (fleet tools): all jobs run in one directory
        kw = dict(cwd=Path(cwd), group=os.environ.get("FS_GROUP", "fleet"),
                  wrapper=make_wrapper(os.environ.get("FS_ENV_FILE", ".env")),
                  env_extra=tuple(x for x in os.environ.get("FS_ENV_PASSTHROUGH", "").split(",") if x))
    return Config(root=Path(os.environ.get("FS_ROOT", "/home/jesse/projects/domains")),
                  backup_dir=data / "backup", **kw)


def _db() -> DB:
    return DB(Path(os.environ.get("FS_DATA", "/data")) / "fleet-scheduler.db")


async def _serve(args) -> int:
    cfg = _cfg()
    token = _token()
    if len(token) < 24:
        print("FS_TOKEN / FS_TOKEN_FILE missing or shorter than 24 chars — refusing to start", file=sys.stderr)
        return 2
    db = _db()
    if cfg.group and db.jobs(cfg.group):
        db.set_adopted(cfg.group, True)  # single-group instance: its one group is always live
    engine = Engine(db, cfg)
    engine.start()
    loop = asyncio.get_running_loop()
    svc = Service(engine, loop, cfg.sites_dir, Path(os.environ.get("FS_DATA", "/data")) / "adopted")
    server = make_server(svc, token, args.host, args.port)
    threading.Thread(target=server.serve_forever, name="api", daemon=True).start()
    logging.info("fleetsched up: %d jobs, adopted=%s, api=%s:%d", len(engine.jobs),
                 sorted(engine.adopted), args.host, args.port)

    hb = Path(os.environ.get("FS_DATA", "/data")) / "heartbeat"
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    def beat():
        try:
            hb.touch()
        except OSError:
            pass

    runner = asyncio.create_task(engine.run_forever(on_beat=beat))
    await stop.wait()
    logging.info("shutdown requested")
    await engine.shutdown(grace_s=float(os.environ.get("FS_SHUTDOWN_GRACE", "20")))
    runner.cancel()
    server.shutdown()
    db.close()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fleetsched")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default=os.environ.get("FS_HOST", "127.0.0.1"))
    s.add_argument("--port", type=int, default=int(os.environ.get("FS_PORT", "4790")))
    i = sub.add_parser("import", help="import legacy ops/docker/crontab.docker files (idempotent)")
    i.add_argument("sites", nargs="*", help="site dirs; default = every site with a crontab")
    i.add_argument("--update", action="store_true", help="overwrite schedule/command of existing jobs")
    i.add_argument("--crontab", help="import this crontab file as the single --group (fleet-tools instance)")
    i.add_argument("--group", default="fleet")
    e = sub.add_parser("export", help="print a site's jobs as crontab syntax (rollback aid)")
    e.add_argument("site")
    h = sub.add_parser("healthcheck")
    h.add_argument("--port", type=int, default=int(os.environ.get("FS_PORT", "4790")))
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if args.cmd == "healthcheck":
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/healthz", timeout=4) as r:
                return 0 if r.status == 200 else 1
        except Exception:
            return 1
    if args.cmd == "serve":
        return asyncio.run(_serve(args))

    cfg = _cfg()
    db = _db()
    if args.cmd == "export":
        sys.stdout.write(export_crontab(db, args.site))
        return 0
    if args.crontab:
        r = import_site(db, args.group, Path(args.crontab).read_text(), update=args.update, fleet=True)
        print(json.dumps({k: (len(v) if isinstance(v, list) and k != "errors" else v) for k, v in r.items()}))
        db.close()
        return 1 if r["errors"] else 0
    sites = args.sites or sorted(p.parent.parent.parent.name
                                 for p in cfg.sites_dir.glob("*/ops/docker/crontab.docker"))
    rc = 0
    for site in sites:
        f = crontab_path(cfg.sites_dir, site)
        if not f.is_file():
            print(f"{site}: no crontab.docker", file=sys.stderr)
            rc = 1
            continue
        r = import_site(db, site, f.read_text(), update=args.update,
                        compose_env=compose_cron_env(cfg.sites_dir / site))
        print(json.dumps({k: (len(v) if isinstance(v, list) and k != "errors" else v) for k, v in r.items()}))
        rc = rc or (1 if r["errors"] else 0)
    db.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
