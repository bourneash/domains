import os
import sys
import uvicorn
from .config import Settings, load_sources
from . import store
from .collector import run_cycle
from .api import create_app


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    settings = Settings.from_env()
    if cmd == "collect":
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
        sources = load_sources(f"{settings.registry_dir}/sources.yaml")
        # Apply runtime enabled/disabled overrides (set via the UI / API) on top
        # of the registry's declared default, so a toggle takes effect next cycle
        # with no rebuild.
        overrides = store.get_source_overrides(conn)
        for s in sources:
            if s.id in overrides:
                s.enabled = overrides[s.id]
        summary = run_cycle(conn, sources, settings)
        print(f"[datahub] cycle: {summary}")
    elif cmd == "serve":
        app = create_app(settings)
        uvicorn.run(app, host=os.environ.get("DATAHUB_HOST", "127.0.0.1"), port=int(os.environ.get("DATAHUB_PORT", "4760")))
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
