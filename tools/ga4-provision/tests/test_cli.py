from ga4_provision import cli


def test_measurement_ids_scraped_from_site_sources(tmp_path):
    site = tmp_path / "example.com" / "site" / "src" / "lib"
    site.mkdir(parents=True)
    (site / "analytics.ts").write_text("export const GA_ID = 'G-ABC12345';")
    result = cli.measurement_ids_from_sites(tmp_path)
    assert result["example.com"] == "G-ABC12345"


def test_placeholder_measurement_ids_are_ignored(tmp_path):
    site = tmp_path / "example.com" / "site" / "src" / "lib"
    site.mkdir(parents=True)
    (site / "analytics.ts").write_text("export const GA_ID = 'G-PLACEHOLDER';")
    assert cli.measurement_ids_from_sites(tmp_path) == {}


def test_dry_run_makes_no_grants(monkeypatch, tmp_path, capsys):
    from ga4_provision.discover import Property

    monkeypatch.setattr(cli.oauth, "user_credentials", lambda: object())
    monkeypatch.setattr(cli, "build", lambda *a, **kw: object())
    monkeypatch.setattr(cli.discover, "discover_properties",
                        lambda c: [Property("123", "example.com", "396394354")])
    monkeypatch.setattr(cli.grant, "service_account_email", lambda: "sa@x.iam.gserviceaccount.com")

    def boom(*a, **kw):
        raise AssertionError("dry run must not grant")

    monkeypatch.setattr(cli.grant, "grant_viewer", boom)
    registry_path = tmp_path / "registry" / "out.yaml"
    monkeypatch.setattr(cli.registry, "REGISTRY_PATH", registry_path)
    fake_sites = tmp_path / "sites"
    fake_sites.mkdir()
    monkeypatch.setattr(cli, "SITES_DIR", fake_sites)

    assert cli.main(["--dry-run"]) == 0
    assert "dry-run" in capsys.readouterr().out.lower()
    assert not registry_path.exists()


def test_discover_properties_failure_returns_clean_error(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(cli.oauth, "user_credentials", lambda: object())
    monkeypatch.setattr(cli, "build", lambda *a, **kw: object())

    def boom(client):
        raise ValueError("malformed API response: missing 'properties' key")

    monkeypatch.setattr(cli.discover, "discover_properties", boom)
    fake_sites = tmp_path / "sites"
    fake_sites.mkdir()
    monkeypatch.setattr(cli, "SITES_DIR", fake_sites)

    assert cli.main([]) == 1
    err = capsys.readouterr().err.lower()
    assert "discovery failed" in err


def test_duplicate_display_name_grants_only_the_winning_property(monkeypatch, tmp_path, capsys):
    from ga4_provision.discover import Property

    monkeypatch.setattr(cli.oauth, "user_credentials", lambda: object())
    monkeypatch.setattr(cli, "build", lambda *a, **kw: object())
    monkeypatch.setattr(
        cli.discover, "discover_properties",
        lambda c: [
            Property("543877193", "0daynews.com", "396394354"),
            Property("544645637", "0daynews.com", "396394354"),
        ],
    )
    monkeypatch.setattr(cli.grant, "service_account_email", lambda: "sa@x.iam.gserviceaccount.com")

    granted = []

    def fake_grant(client, property_id, sa_email):
        granted.append(property_id)
        return "granted"

    monkeypatch.setattr(cli.grant, "grant_viewer", fake_grant)
    registry_path = tmp_path / "registry" / "out.yaml"
    monkeypatch.setattr(cli.registry, "REGISTRY_PATH", registry_path)
    fake_sites = tmp_path / "sites"
    fake_sites.mkdir()
    monkeypatch.setattr(cli, "SITES_DIR", fake_sites)

    assert cli.main([]) == 0
    assert granted == ["544645637"]
    out = capsys.readouterr().out.lower()
    assert "1 duplicate property skipped" in out


def test_measurement_id_found_outside_the_legacy_glob_paths(tmp_path):
    """rodhat.com wires GA4 in site/src/data/site-config.ts — the old three
    hardcoded globs missed it and reported the site as having no GA4 at all."""
    data = tmp_path / "rodhat.com" / "site" / "src" / "data"
    data.mkdir(parents=True)
    (data / "site-config.ts").write_text("  ga4MeasurementId: 'G-GXHMCZ25QC',")
    assert cli.measurement_ids_from_sites(tmp_path) == {"rodhat.com": "G-GXHMCZ25QC"}


def test_site_without_a_src_tree_is_skipped(tmp_path):
    (tmp_path / "parked.com").mkdir()
    assert cli.measurement_ids_from_sites(tmp_path) == {}
