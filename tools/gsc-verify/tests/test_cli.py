from gsc_verify import cli


def test_already_verified_domain_is_skipped(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: True)

    def boom(*a, **kw):
        raise AssertionError("must not touch DNS for a verified domain")

    monkeypatch.setattr(cli.cloudflare, "zone_id", boom)
    assert cli.verify_domain(None, None, None, "example.com") == "already-verified"


def test_missing_zone_reports_and_does_not_raise(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: None)
    result = cli.verify_domain(None, None, None, "notincf.com")
    assert result == "failed:no-cf-zone"


def test_dns_timeout_leaves_record_for_resume(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: "zone1")
    monkeypatch.setattr(cli.cloudflare, "upsert_txt", lambda c, z, n, v: "rec1")
    monkeypatch.setattr(cli, "wait_for_txt", lambda *a, **kw: False)

    deleted = []
    monkeypatch.setattr(cli.cloudflare, "find_txt", lambda *a, **kw: deleted.append(1))
    result = cli.verify_domain(None, None, None, "slow.com")
    assert result == "pending:dns-propagation"
    assert deleted == []  # record intentionally retained


def test_happy_path_runs_full_sequence(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: "zone1")
    monkeypatch.setattr(cli.cloudflare, "upsert_txt", lambda c, z, n, v: "rec1")
    monkeypatch.setattr(cli, "wait_for_txt", lambda *a, **kw: True)
    monkeypatch.setattr(cli.verification, "verify", lambda c, d: "verified")
    monkeypatch.setattr(cli.console, "add_site", lambda c, d: "added")
    monkeypatch.setattr(cli.console, "submit_sitemap", lambda c, d: "submitted")
    assert cli.verify_domain(None, None, None, "good.com") == "verified"
