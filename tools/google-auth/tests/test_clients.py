from google_auth_fleet import clients


def test_scopes_are_readonly_where_possible():
    assert clients.SCOPES["ga4_data"] == [
        "https://www.googleapis.com/auth/analytics.readonly"
    ]
    assert clients.SCOPES["search_console"] == [
        "https://www.googleapis.com/auth/webmasters.readonly"
    ]


def test_site_verification_scope_is_write_capable():
    # Verification necessarily mutates ownership state, so it cannot be readonly.
    assert clients.SCOPES["site_verification"] == [
        "https://www.googleapis.com/auth/siteverification"
    ]


def test_search_console_builds_client(monkeypatch):
    captured = {}

    def fake_load(path=None, *, scopes=None):
        captured["scopes"] = scopes
        return object()

    def fake_build(name, version, credentials=None, cache_discovery=False):
        captured["service"] = (name, version)
        return "CLIENT"

    monkeypatch.setattr(clients.creds, "load_service_account", fake_load)
    monkeypatch.setattr(clients, "build", fake_build)

    assert clients.search_console() == "CLIENT"
    assert captured["service"] == ("searchconsole", "v1")
    assert captured["scopes"] == clients.SCOPES["search_console"]
