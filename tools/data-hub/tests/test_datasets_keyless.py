import json
from pathlib import Path
import datahub.datasets as ds
from datahub.datasets import usgs, noaa_alerts, noaa_swpc, noaa_tides, launchlib, cisa_kev
from datahub.config import Source, Settings

FX = Path(__file__).parent / "fixtures"
S = Settings(db_path=":memory:", home_ips=set(), proxy_us="", proxy_eu="",
             control_us="", control_eu="", registry_dir="/x")


def _patch(monkeypatch, payload):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: payload)


def test_usgs_maps_features_to_records(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "usgs_quakes.json").read_text()))
    src = Source(id="usgs", type="dataset", fetcher="usgs", dataset_key="quakes", tags=["nature"])
    recs = usgs.fetch(src, proxy=None, settings=S)
    assert len(recs) == 2
    assert recs[0]["payload"]["mag"] == 6.2
    assert recs[0]["observed_at"].startswith("2026-")  # epoch-ms converted to ISO


def test_noaa_alerts_maps_sent_time(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "noaa_alerts.json").read_text()))
    src = Source(id="al", type="dataset", fetcher="noaa-alerts", dataset_key="alerts", tags=["weather"])
    recs = noaa_alerts.fetch(src, proxy=None, settings=S)
    assert recs[0]["payload"]["severity"] == "Extreme"
    assert recs[0]["observed_at"].startswith("2026-06-28T14:00")


def test_noaa_swpc_takes_latest_row(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "swpc_kindex.json").read_text()))
    src = Source(id="kp", type="dataset", fetcher="noaa-swpc", dataset_key="kindex",
                 tags=["space"], params={"url": "https://services.swpc.noaa.gov/x.json"})
    recs = noaa_swpc.fetch(src, proxy=None, settings=S)
    assert len(recs) == 1
    assert recs[0]["payload"]["Kp"] == "5"        # latest row, header-mapped
    assert recs[0]["observed_at"].startswith("2026-06-28")


def test_noaa_tides_maps_predictions(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "noaa_tides.json").read_text()))
    src = Source(id="td", type="dataset", fetcher="noaa-tides", dataset_key="tides", tags=["nature"])
    recs = noaa_tides.fetch(src, proxy=None, settings=S)
    assert len(recs) == 2
    assert recs[0]["payload"]["v"] == "4.812"


def test_launchlib_maps_launches(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "launchlib.json").read_text()))
    src = Source(id="ll", type="dataset", fetcher="launchlib", dataset_key="launches", tags=["space"])
    recs = launchlib.fetch(src, proxy=None, settings=S)
    assert recs[0]["payload"]["provider"] == "SpaceX"
    assert recs[0]["observed_at"] == "2026-06-29T03:21:00Z"


def test_cisa_kev_maps_vulnerabilities(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "cisa_kev.json").read_text()))
    src = Source(id="cisa-kev", type="dataset", fetcher="cisa-kev", dataset_key="cisa-kev",
                 tags=["vuln", "cve", "exploit", "breach", "patch", "dataset"])
    recs = cisa_kev.fetch(src, proxy=None, settings=S)
    assert len(recs) == 2
    assert recs[0]["payload"]["cve_id"] == "CVE-2026-30001"
    assert recs[0]["payload"]["vendor_project"] == "Ivanti"
    assert recs[0]["observed_at"].startswith("2026-07-05T00:00:00")  # dateAdded date, not fetch time
    assert recs[1]["payload"]["known_ransomware_use"] == "Known"


def test_cisa_kev_same_day_entries_get_distinct_observed_at(monkeypatch):
    # Regression test: dateAdded is date-only, and CISA often adds several
    # CVEs on the same day. observed_at must stay unique per CVE so they
    # don't collide on the store's UNIQUE(source_id, dataset_key, observed_at)
    # constraint and silently vanish (only the first of the batch used to
    # survive INSERT OR IGNORE).
    _patch(monkeypatch, {"vulnerabilities": [
        {"cveID": "CVE-2026-00001", "dateAdded": "2026-07-01", "vendorProject": "A", "product": "A",
         "vulnerabilityName": "n1"},
        {"cveID": "CVE-2026-00002", "dateAdded": "2026-07-01", "vendorProject": "B", "product": "B",
         "vulnerabilityName": "n2"},
        {"cveID": "CVE-2026-00003", "dateAdded": "2026-07-01", "vendorProject": "C", "product": "C",
         "vulnerabilityName": "n3"},
    ]})
    src = Source(id="cisa-kev", type="dataset", fetcher="cisa-kev", dataset_key="cisa-kev", tags=[])
    recs = cisa_kev.fetch(src, proxy=None, settings=S)
    observed_ats = [r["observed_at"] for r in recs]
    assert len(set(observed_ats)) == 3  # all distinct despite identical dateAdded
    for oa in observed_ats:
        assert oa.startswith("2026-07-01")  # still the correct calendar day

    # Stable across repeated fetches of the same catalog (so re-polling
    # correctly dedupes instead of re-inserting every entry every cycle).
    recs2 = cisa_kev.fetch(src, proxy=None, settings=S)
    assert [r["observed_at"] for r in recs2] == observed_ats


def test_registry_has_keyless_fetchers():
    for name in ("usgs", "noaa-alerts", "noaa-swpc", "noaa-tides", "launchlib", "cisa-kev"):
        assert name in ds.FETCHERS
