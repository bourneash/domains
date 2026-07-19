import json
import pytest

from ga4_provision import oauth


def test_scopes_include_analytics_edit():
    # accessBindings.create requires edit, not readonly.
    assert "https://www.googleapis.com/auth/analytics.manage.users" in oauth.USER_SCOPES
    assert "https://www.googleapis.com/auth/analytics.readonly" in oauth.USER_SCOPES


def test_missing_client_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError) as exc:
        oauth.user_credentials(
            client_path=tmp_path / "absent.json", token_path=tmp_path / "token.json"
        )
    assert "absent.json" in str(exc.value)


def test_cached_token_is_reused_without_prompting(tmp_path, monkeypatch):
    token = tmp_path / "token.json"
    token.write_text(json.dumps({"token": "cached"}))

    calls = {"flow": 0}

    class FakeCreds:
        valid = True

    def fake_from_file(path, scopes):
        assert str(path) == str(token)
        return FakeCreds()

    def fake_flow(*a, **kw):
        calls["flow"] += 1
        raise AssertionError("must not prompt when a valid token is cached")

    monkeypatch.setattr(oauth.Credentials, "from_authorized_user_file", staticmethod(fake_from_file))
    monkeypatch.setattr(oauth.InstalledAppFlow, "from_client_secrets_file", staticmethod(fake_flow))

    result = oauth.user_credentials(
        client_path=tmp_path / "client.json", token_path=token
    )
    assert isinstance(result, FakeCreds)
    assert calls["flow"] == 0


def test_expired_token_is_refreshed_without_prompting(tmp_path, monkeypatch):
    token = tmp_path / "token.json"
    token.write_text(json.dumps({"token": "expired", "refresh_token": "rt"}))

    calls = {"flow": 0, "refresh": 0}

    class FakeCreds:
        valid = False
        expired = True
        refresh_token = "rt"

        def refresh(self, request):
            calls["refresh"] += 1
            self.valid = True

        def to_json(self):
            return json.dumps({"token": "refreshed"})

    def fake_from_file(path, scopes):
        assert str(path) == str(token)
        return FakeCreds()

    def fake_flow(*a, **kw):
        calls["flow"] += 1
        raise AssertionError("must not prompt when a refresh token is available")

    monkeypatch.setattr(oauth.Credentials, "from_authorized_user_file", staticmethod(fake_from_file))
    monkeypatch.setattr(oauth.InstalledAppFlow, "from_client_secrets_file", staticmethod(fake_flow))

    result = oauth.user_credentials(
        client_path=tmp_path / "client.json", token_path=token
    )
    assert isinstance(result, FakeCreds)
    assert calls["refresh"] == 1
    assert calls["flow"] == 0
