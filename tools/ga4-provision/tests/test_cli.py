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
    monkeypatch.setattr(cli.registry, "REGISTRY_PATH", tmp_path / "out.yaml")

    assert cli.main(["--dry-run"]) == 0
    assert "dry-run" in capsys.readouterr().out.lower()
