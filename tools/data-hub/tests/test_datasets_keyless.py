import json
from pathlib import Path
import datahub.datasets as ds
from datahub.datasets import usgs, noaa_alerts, noaa_swpc, noaa_tides, launchlib
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


def test_registry_has_keyless_fetchers():
    for name in ("usgs", "noaa-alerts", "noaa-swpc", "noaa-tides", "launchlib"):
        assert name in ds.FETCHERS
