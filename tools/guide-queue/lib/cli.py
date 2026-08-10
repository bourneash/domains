#!/usr/bin/env python3
"""CLI wrapper over guide_queue.py for the bash-driven role scripts (which
can't cleanly import a python module inline). Every subcommand prints JSON to
stdout and exits nonzero with a message on stderr on error, so a bash
`set -e` caller composes with it normally.

Usage:
    cli.py oldest <site_root> <status>            -> item JSON or "null"
  cli.py list <site_root> [status]               -> {status: [items]} or [items]
  cli.py get <site_root> <status> <file>         -> item JSON (incl. body)
  cli.py move <site_root> <from> <file> <to>     -> {"file": "<new-name>"}
  cli.py add-idea <site_root> <title> <brief> <category> [source] -> {"file": ...}
  cli.py write <site_root> <status> <file> <meta_json_path> <body_path>
  cli.py strip-queue-fields <meta_json_path>     -> stripped meta JSON
  cli.py existing-titles <site_root>             -> ["title", ...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import guide_queue as gq  # noqa: E402


def _out(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = argv[1]
    args = argv[2:]
    try:
        if cmd == "oldest":
            site_root, status = args
            _out(gq.oldest(Path(site_root), status))
        elif cmd == "list":
            site_root = args[0]
            if len(args) > 1:
                _out(gq.list_status(Path(site_root), args[1]))
            else:
                _out(gq.list_all(Path(site_root)))
        elif cmd == "get":
            site_root, status, file = args
            _out(gq.get_item(Path(site_root), status, file))
        elif cmd == "move":
            site_root, frm, file, to = args
            _out({"file": gq.move_item(Path(site_root), frm, file, to)})
        elif cmd == "add-idea":
            site_root, title, brief, category = args[:4]
            source = args[4] if len(args) > 4 else "human"
            _out({"file": gq.add_idea(Path(site_root), title, brief, category, source)})
        elif cmd == "write":
            site_root, status, file, meta_path, body_path = args
            meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
            body = Path(body_path).read_text(encoding="utf-8")
            gq.write_item(Path(site_root), status, file, meta, body)
            _out({"ok": True})
        elif cmd == "strip-queue-fields":
            (meta_path,) = args
            meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
            _out(gq.strip_queue_fields(meta))
        elif cmd == "existing-titles":
            (site_root,) = args
            _out(sorted(gq.existing_titles(Path(site_root))))
        else:
            print(f"unknown subcommand: {cmd}", file=sys.stderr)
            return 2
    except gq.GuideQueueError as e:
        print(f"guide-queue error: {e}", file=sys.stderr)
        return 1
    except (ValueError, TypeError) as e:
        print(f"bad arguments for {cmd}: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
