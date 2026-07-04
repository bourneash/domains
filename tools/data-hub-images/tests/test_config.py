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
