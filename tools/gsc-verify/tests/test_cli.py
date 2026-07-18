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


def test_dns_timeout_returns_pending_after_writing_record_once(monkeypatch):
    """DNS propagation timeout must report pending:dns-propagation, and only after
    the TXT record was actually written exactly once (proving the record is left
    in place for a resume, not retried or rolled back)."""
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: "zone1")

    upsert_calls = []

    def fake_upsert_txt(c, z, n, v):
        upsert_calls.append((z, n, v))
        return "rec1"

    monkeypatch.setattr(cli.cloudflare, "upsert_txt", fake_upsert_txt)
    monkeypatch.setattr(cli, "wait_for_txt", lambda *a, **kw: False)

    result = cli.verify_domain(None, None, None, "slow.com")
    assert result == "pending:dns-propagation"
    assert upsert_calls == [("zone1", "slow.com", "TOKEN")]


def test_zone_id_exception_returns_failed_not_raise(monkeypatch):
    """A CloudflareError (or any exception) out of zone_id must become a
    'failed:' status string, not propagate. Without the try/except in
    verify_domain around zone_id, this raises and the test fails with an
    unhandled exception instead of a returned string."""
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")

    def boom(c, d):
        raise cli.cloudflare.CloudflareError("rate limited")

    monkeypatch.setattr(cli.cloudflare, "zone_id", boom)
    result = cli.verify_domain(None, None, None, "flaky.com")
    assert result.startswith("failed:")
    assert result != "failed:no-cf-zone"  # must stay distinguishable from a real absent zone


def test_upsert_txt_exception_returns_failed_not_raise(monkeypatch):
    """A CloudflareError out of upsert_txt must become a 'failed:' status
    string, not propagate. Without the try/except around upsert_txt, this
    raises and the test fails with an unhandled exception instead of a
    returned string."""
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: "zone1")

    def boom(c, z, n, v):
        raise cli.cloudflare.CloudflareError("upstream 5xx")

    monkeypatch.setattr(cli.cloudflare, "upsert_txt", boom)
    result = cli.verify_domain(None, None, None, "flaky2.com")
    assert result.startswith("failed:")


def test_main_continues_after_one_domain_raises_unexpectedly(monkeypatch, capsys):
    """If verify_domain raises for one domain (any unexpected exception, not just
    a handled 'failed:' return), main()'s per-domain loop must catch it, record
    that domain as failed, and continue to the rest of the fleet — printing a
    line for every domain. Without the try/except around the verify_domain call
    in main(), the RuntimeError from 'bad.com' propagates out of main() and
    'good.com' is never reached or printed, which this test would catch."""
    monkeypatch.setattr(cli.clients, "site_verification", lambda: object())
    monkeypatch.setattr(cli.clients, "search_console", lambda: object())

    class FakeCfClient:
        def __enter__(self):
            return "cf"

        def __exit__(self, *exc_info):
            return False

    monkeypatch.setattr(cli.cloudflare, "cf_client", lambda: FakeCfClient())

    calls = []

    def fake_verify_domain(sv, sc, cf, domain):
        calls.append(domain)
        if domain == "bad.com":
            raise RuntimeError("boom")
        return "verified"

    monkeypatch.setattr(cli, "verify_domain", fake_verify_domain)

    rc = cli.main(["--domain", "bad.com", "--domain", "good.com"])
    out = capsys.readouterr().out

    assert calls == ["bad.com", "good.com"]  # loop reached both domains
    assert "bad.com" in out and "failed:unexpected-RuntimeError" in out
    assert "good.com" in out and "verified" in out
    assert rc == 1  # one failure recorded, run did not abort


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
