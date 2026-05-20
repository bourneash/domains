"""Search Console (Google + Bing) collector — v2 stub. Exits cleanly."""
from __future__ import annotations

import logging
import sqlite3

from site_tracker import registry

log = logging.getLogger(__name__)


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    log.info("search_consoles collector is a v2 stub; no facts emitted.")
