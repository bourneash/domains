import os
import textwrap

from lib.config import discover_configs, load_config


def test_discover_configs_finds_only_sites_with_smoke_yaml(tmp_path):
    sites_dir = tmp_path / "sites"
    (sites_dir / "has-config.com" / "ops").mkdir(parents=True)
    (sites_dir / "has-config.com" / "ops" / "smoke.yaml").write_text("apex: has-config.com\nchecks: []\n")
    (sites_dir / "no-config.com" / "ops").mkdir(parents=True)

    found = discover_configs(str(sites_dir))

    assert len(found) == 1
    site_dir, config_path = found[0]
    assert site_dir.endswith("has-config.com")
    assert config_path.endswith("smoke.yaml")


def test_load_config_fills_defaults(tmp_path):
    config_path = tmp_path / "smoke.yaml"
    config_path.write_text(textwrap.dedent("""\
        apex: example.com
        checks:
          - path: /
            expect: 200
            label: Homepage
    """))

    config = load_config(str(config_path))

    assert config["enabled"] is True
    assert config["dns_over_https"] is True
    assert config["slack"] == {"enabled": True}
    assert config["checks"] == [{"path": "/", "expect": 200, "label": "Homepage"}]


def test_load_config_respects_explicit_values(tmp_path):
    config_path = tmp_path / "smoke.yaml"
    config_path.write_text(textwrap.dedent("""\
        apex: example.com
        enabled: false
        dns_over_https: false
        slack:
          enabled: false
        checks: []
    """))

    config = load_config(str(config_path))

    assert config["enabled"] is False
    assert config["dns_over_https"] is False
    assert config["slack"] == {"enabled": False}
