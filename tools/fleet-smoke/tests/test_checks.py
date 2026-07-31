import json

from lib.checks import resolve_apex_ip, run_http_check, run_checks


def test_resolve_apex_ip_parses_doh_response():
    fake_body = json.dumps({"Answer": [{"data": "203.0.113.10"}]})

    def fake_http_get(url, headers=None):
        assert "example.com" in url
        return fake_body

    ip = resolve_apex_ip("example.com", http_get=fake_http_get)

    assert ip == "203.0.113.10"


def test_run_http_check_pass():
    check = {"path": "/", "expect": 200, "label": "Homepage"}

    def fake_run_curl(apex, ip, path):
        assert apex == "example.com"
        assert ip == "203.0.113.10"
        assert path == "/"
        return "200"

    result = run_http_check("example.com", "203.0.113.10", check, run_curl=fake_run_curl)

    assert result == {
        "label": "Homepage",
        "path": "/",
        "expect": 200,
        "actual": "200",
        "ok": True,
    }


def test_run_http_check_fail():
    check = {"path": "/go/x", "expect": 302, "label": "Affiliate redirect"}

    def fake_run_curl(apex, ip, path):
        return "503"

    result = run_http_check(
        "example.com", "203.0.113.10", check,
        run_curl=fake_run_curl, retry_delays=(),
    )

    assert result["ok"] is False
    assert result["actual"] == "503"


def test_run_http_check_retries_with_backoff_until_pass():
    check = {"path": "/guide", "expect": 200, "label": "Guide"}
    statuses = iter(["000", "503", "200"])
    calls = []
    sleeps = []

    def fake_run_curl(apex, ip, path):
        calls.append((apex, ip, path))
        return next(statuses)

    result = run_http_check(
        "example.com", "203.0.113.10", check,
        run_curl=fake_run_curl, sleep=sleeps.append,
    )

    assert result["ok"] is True
    assert result["actual"] == "200"
    assert len(calls) == 3
    assert sleeps == [10, 20]


def test_run_http_check_stops_after_all_retries_fail():
    check = {"path": "/missing", "expect": 200}
    calls = []
    sleeps = []

    def fake_run_curl(apex, ip, path):
        calls.append(path)
        return "000"

    result = run_http_check(
        "example.com", "203.0.113.10", check,
        run_curl=fake_run_curl, sleep=sleeps.append,
    )

    assert result["ok"] is False
    assert result["actual"] == "000"
    assert calls == ["/missing"] * 4
    assert sleeps == [10, 20, 30]


def test_run_checks_resolves_once_and_runs_every_check():
    config = {
        "apex": "example.com",
        "dns_over_https": True,
        "checks": [
            {"path": "/", "expect": 200, "label": "Homepage"},
            {"path": "/go/x", "expect": 302, "label": "Redirect"},
        ],
    }
    resolve_calls = []
    curl_calls = []

    def fake_http_get(url, headers=None):
        resolve_calls.append(url)
        return json.dumps({"Answer": [{"data": "203.0.113.10"}]})

    def fake_run_curl(apex, ip, path):
        curl_calls.append(path)
        return "200" if path == "/" else "302"

    results = run_checks(config, run_curl=fake_run_curl, http_get=fake_http_get)

    assert len(resolve_calls) == 1  # resolved once, reused for every check
    assert curl_calls == ["/", "/go/x"]
    assert [r["ok"] for r in results] == [True, True]


def test_run_checks_skips_dns_lookup_when_disabled():
    config = {
        "apex": "127.0.0.1",
        "dns_over_https": False,
        "checks": [{"path": "/", "expect": 200, "label": "Homepage"}],
    }

    def fake_run_curl(apex, ip, path):
        assert ip == "127.0.0.1"  # apex used directly, no DoH call
        return "200"

    def fake_http_get(url, headers=None):
        raise AssertionError("should not be called when dns_over_https is False")

    results = run_checks(config, run_curl=fake_run_curl, http_get=fake_http_get)

    assert results[0]["ok"] is True
