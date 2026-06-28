import json
from pathlib import Path
import pytest
import datahub.datasets as ds
from datahub.datasets import fred, eia, nass, DatasetUnavailable
from datahub.config import Source, Settings

FX = Path(__file__).parent / "fixtures"


def _settings(**keys):
    base = dict(db_path=":memory:", home_ips=set(), proxy_us="", proxy_eu="",
                control_us="", control_eu="", registry_dir="/x")
    base.update(keys)
    return Settings(**base)


def test_fred_skips_without_key():
    src = Source(id="fred", type="dataset", fetcher="fred", dataset_key="gdp",
                 params={"series_id": "GDPC1"}, tags=["economy"])
    with pytest.raises(DatasetUnavailable) as e:
        fred.fetch(src, proxy=None, settings=_settings(fred_key=""))
    assert e.value.reason == "no-api-key"


def test_fred_maps_latest_observation(monkeypatch):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: json.loads((FX / "fred_obs.json").read_text()))
    src = Source(id="fred", type="dataset", fetcher="fred", dataset_key="gdp",
                 params={"series_id": "GDPC1"}, tags=["economy"])
    recs = fred.fetch(src, proxy=None, settings=_settings(fred_key="abc"))
    assert recs[0]["payload"]["value"] == "23120.5"
    assert recs[0]["observed_at"].startswith("2026-04-01")


def test_eia_skips_without_key():
    src = Source(id="eia", type="dataset", fetcher="eia", dataset_key="diesel",
                 params={"path": "petroleum/pri/gnd/data/"}, tags=["economy"])
    with pytest.raises(DatasetUnavailable):
        eia.fetch(src, proxy=None, settings=_settings(eia_key=""))


def test_eia_maps_rows(monkeypatch):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: json.loads((FX / "eia_diesel.json").read_text()))
    src = Source(id="eia", type="dataset", fetcher="eia", dataset_key="diesel",
                 params={"path": "petroleum/pri/gnd/data/"}, tags=["economy"])
    recs = eia.fetch(src, proxy=None, settings=_settings(eia_key="abc"))
    assert recs[0]["payload"]["value"] == 3.812
    assert recs[0]["observed_at"].startswith("2026-06-22")


def test_nass_skips_without_key():
    src = Source(id="nass", type="dataset", fetcher="nass", dataset_key="corn", tags=["agriculture"])
    with pytest.raises(DatasetUnavailable):
        nass.fetch(src, proxy=None, settings=_settings(nass_key=""))


def test_nass_maps_year_to_observed_at(monkeypatch):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: json.loads((FX / "nass_corn.json").read_text()))
    src = Source(id="nass", type="dataset", fetcher="nass", dataset_key="corn",
                 params={"commodity_desc": "CORN"}, tags=["agriculture"])
    recs = nass.fetch(src, proxy=None, settings=_settings(nass_key="abc"))
    assert recs[0]["payload"]["Value"] == "15.1"
    assert recs[0]["observed_at"] == "2025-01-01T00:00:00+00:00"
