"""Shared pytest fixtures for site-tracker tests."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "facts.db"


@pytest.fixture
def db(db_path: Path):
    from site_tracker import store
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        yield conn
    finally:
        conn.close()
