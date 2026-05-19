"""Tests for site_tracker.store."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from site_tracker import store


def test_init_db_creates_tables(db_path: Path):
    store.init_db(db_path)
    conn = sqlite3.connect(db_path)
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert "facts" in tables
    assert "audit" in tables


def test_upsert_fact_inserts_new(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    row = db.execute(
        "SELECT site, key, value, source, state, ttl_hours FROM facts"
    ).fetchone()
    assert row == ("x.com", "http.ga4_present", "true", "http_scrape", "green", 24)


def test_upsert_fact_updates_existing(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=False, source="http_scrape", state="yellow", ttl_hours=24)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    rows = db.execute("SELECT value, state FROM facts WHERE site=? AND key=?",
                      ("x.com", "http.ga4_present")).fetchall()
    assert rows == [("true", "green")]


def test_upsert_fact_appends_audit_on_change(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=False, source="http_scrape", state="yellow", ttl_hours=24)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    audits = db.execute("SELECT old_value, new_value, source FROM audit").fetchall()
    assert audits == [
        (None,     "false", "http_scrape"),
        ("false",  "true",  "http_scrape"),
    ]


def test_upsert_fact_no_audit_when_value_unchanged(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    n = db.execute("SELECT COUNT(*) FROM audit").fetchone()[0]
    assert n == 1   # only the initial insert


def test_get_site_facts_returns_keyed_dict(db):
    store.upsert_fact(db, site="x.com", key="cf.zone_active",
                      value=True, source="cf_api", state="green", ttl_hours=6)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=False, source="http_scrape", state="yellow", ttl_hours=24)
    facts = store.get_site_facts(db, "x.com")
    assert set(facts.keys()) == {"cf.zone_active", "http.ga4_present"}
    assert facts["cf.zone_active"]["value"] is True
    assert facts["cf.zone_active"]["state"] == "green"


def test_stale_state_when_past_ttl(db):
    from freezegun import freeze_time
    with freeze_time("2026-05-19T00:00:00Z"):
        store.upsert_fact(db, site="x.com", key="cf.zone_active",
                          value=True, source="cf_api", state="green", ttl_hours=6)
    with freeze_time("2026-05-19T07:00:00Z"):
        facts = store.get_site_facts(db, "x.com")
    assert facts["cf.zone_active"]["state"] == "stale"
