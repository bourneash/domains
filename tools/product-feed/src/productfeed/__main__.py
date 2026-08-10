"""CLI entrypoint: python -m productfeed serve"""
import sys

import uvicorn

from .api import create_app
from .config import Settings


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] != "serve":
        print("usage: python -m productfeed serve", file=sys.stderr)
        return 2

    settings = Settings.from_env()
    app = create_app(settings)
    uvicorn.run(app, host=settings.host, port=settings.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
