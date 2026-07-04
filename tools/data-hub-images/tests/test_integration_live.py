"""Live integration test — hits real Wikimedia through the VPN proxy.

Opt-in only: excluded by default via the `live` marker (see pyproject.toml
markers config). Run explicitly with:

    pytest -m live tests/test_integration_live.py -v

Requires the vpn-proxy stack running (tools/vpn-proxy) with US/EU exits
reachable at the proxy URLs below (defaults assume the host-published
loopback ports from vpn-proxy's docker-compose.yml).
"""
import os

import pytest


@pytest.mark.live
def test_live_wikimedia_through_vpn(tmp_path):
    from datahub_images import collector, store
    from datahub_images.config import Settings, Source, Topic

    st = Settings(
        db_path=str(tmp_path / "t.db"),
        blob_dir=str(tmp_path / "b"),
        proxy_us=os.environ.get("DATAHUB_IMAGES_PROXY_US", "http://127.0.0.1:8181"),
        proxy_eu=os.environ.get("DATAHUB_IMAGES_PROXY_EU", "http://127.0.0.1:8182"),
        home_ips=set((os.environ.get("DATAHUB_IMAGES_HOME_IPS", "") or "x").split(",")),
        pool_ttl_days=45,
        retention_days=14,
        reuse_global_days=30,
        reuse_same_site_days=14,
        api_host="0.0.0.0",
        api_port=4770,
    )
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    out = collector.run_cycle(
        st,
        conn,
        [Source(id="wikimedia", kind="wikimedia")],
        [Topic(id="iran", queries=["Strait of Hormuz"], target_depth=2, tags=["iran"])],
        "2026-07-04T00:00:00Z",
    )
    assert out["fetched"] >= 1
