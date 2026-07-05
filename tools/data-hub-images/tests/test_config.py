import os
from datahub_images.config import Settings, load_sources, load_topics

def test_settings_defaults(monkeypatch):
    monkeypatch.delenv("DATAHUB_IMAGES_PROXY_US", raising=False)
    s = Settings.from_env()
    assert s.proxy_us.endswith(":8888") or s.proxy_us.endswith(":8181")
    assert s.reuse_global_days == 30
    assert s.reuse_same_site_days == 14
    assert s.api_port == 4770

def test_load_registry(tmp_path):
    (tmp_path / "sources.yaml").write_text(
        "- id: wikimedia\n  kind: wikimedia\n  policy: vpn\n  exit: any\n  enabled: true\n")
    (tmp_path / "topics.yaml").write_text(
        "- id: iran\n  queries: ['Iran Persian Gulf']\n  target_depth: 8\n")
    srcs = load_sources(str(tmp_path / "sources.yaml"))
    tops = load_topics(str(tmp_path / "topics.yaml"))
    assert srcs[0].id == "wikimedia" and srcs[0].policy == "vpn"
    assert tops[0].id == "iran" and tops[0].target_depth == 8


def test_settings_from_env_on_demand_defaults(monkeypatch):
    for var in (
        "DATAHUB_IMAGES_ON_DEMAND_TIMEOUT_S",
        "DATAHUB_IMAGES_ON_DEMAND_PER_SOURCE_LIMIT",
    ):
        monkeypatch.delenv(var, raising=False)
    st = Settings.from_env()
    assert st.on_demand_timeout_s == 25.0
    assert st.on_demand_per_source_limit == 4


def test_settings_from_env_on_demand_overrides(monkeypatch):
    monkeypatch.setenv("DATAHUB_IMAGES_ON_DEMAND_TIMEOUT_S", "9.5")
    monkeypatch.setenv("DATAHUB_IMAGES_ON_DEMAND_PER_SOURCE_LIMIT", "2")
    st = Settings.from_env()
    assert st.on_demand_timeout_s == 9.5
    assert st.on_demand_per_source_limit == 2


def test_settings_constructible_without_on_demand_kwargs(tmp_path):
    # Existing call sites across the test suite construct Settings(...)
    # without on_demand_* — they must keep working via defaults.
    st = Settings(
        db_path=str(tmp_path / "t.db"), blob_dir=str(tmp_path / "b"),
        proxy_us="", proxy_eu="", home_ips=set(), pool_ttl_days=45,
        retention_days=14, reuse_global_days=30, reuse_same_site_days=14,
        api_host="0.0.0.0", api_port=4770,
    )
    assert st.on_demand_timeout_s == 25.0
    assert st.on_demand_per_source_limit == 4
