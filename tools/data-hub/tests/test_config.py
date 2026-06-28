import textwrap
from datahub.config import load_sources, load_subscriptions, Settings


def test_load_sources_parses_multi_tag_and_defaults(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(textwrap.dedent("""
        sources:
          - id: reuters-world
            type: rss
            url: https://example.com/reuters.rss
            tags: [news, world, defense]
          - id: fred-gdp
            type: dataset
            dataset_key: gdp
            fetcher: fred
            params: {series_id: GDPC1}
            tags: [economy, dataset]
            policy: vpn
            exit: us
    """))
    sources = load_sources(str(p))
    assert len(sources) == 2
    reuters = sources[0]
    assert reuters.id == "reuters-world"
    assert reuters.type == "rss"
    assert reuters.tags == ["news", "world", "defense"]
    assert reuters.policy == "vpn"   # default
    assert reuters.exit == "any"     # default
    fred = sources[1]
    assert fred.fetcher == "fred"
    assert fred.params["series_id"] == "GDPC1"
    assert fred.exit == "us"


def test_load_subscriptions_builds_items_query(tmp_path):
    p = tmp_path / "subs.yaml"
    p.write_text(textwrap.dedent("""
        subscriptions:
          americastrikes.com:
            items:
              tags_any: [defense, iran, markets]
              limit: 200
              window_hours: 48
            datasets: []
          sinderella.org:
            items:
              tags_any: [space, science]
              window_hours: 24
            datasets: [ephemeris, fred-gdp]
    """))
    subs = load_subscriptions(str(p))
    assert set(subs) == {"americastrikes.com", "sinderella.org"}
    a = subs["americastrikes.com"]
    assert a.items.tags_any == ["defense", "iran", "markets"]
    assert a.items.limit == 200
    s = subs["sinderella.org"]
    assert s.items.window_hours == 24
    assert s.datasets == ["ephemeris", "fred-gdp"]


def test_settings_from_env_defaults(monkeypatch):
    monkeypatch.delenv("DATAHUB_HOME_IPS", raising=False)
    monkeypatch.setenv("DATAHUB_DB_PATH", "/tmp/x.db")
    s = Settings.from_env()
    assert s.db_path == "/tmp/x.db"
    assert "24.55.143.75" in s.home_ips
    assert "158.173.25.169" in s.home_ips
    assert s.proxy_us.endswith(":8181")
    assert s.control_eu.endswith(":9282")
