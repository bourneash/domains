import sys

import uvicorn

from . import store
from .api import create_app
from .collector import run_cycle
from .config import Settings, load_sources, load_topics


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    settings = Settings.from_env()

    if cmd == "collect":
        import os
        registry_dir = os.environ.get(
            "DATAHUB_IMAGES_REGISTRY_DIR",
            os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "registry")),
        )
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
        sources = load_sources(os.path.join(registry_dir, "sources.yaml"))
        topics = load_topics(os.path.join(registry_dir, "topics.yaml"))
        overrides = store.get_source_overrides(conn)
        for s in sources:
            if s.id in overrides:
                s.enabled = overrides[s.id]
        summary = run_cycle(settings, conn, sources, topics, _now_iso())
        print(f"[datahub-images] cycle: {summary}")
    elif cmd == "serve":
        app = create_app(settings)
        uvicorn.run(app, host=settings.api_host, port=settings.api_port)
    elif cmd == "replay":
        print("replay: implemented in Phase 3", file=sys.stderr)
        sys.exit(2)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
