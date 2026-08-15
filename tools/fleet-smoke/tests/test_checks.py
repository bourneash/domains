import json

from lib.checks import (
    resolve_apex_ip,
    run_http_check,
    run_checks,
    run_module_graph_check,
)


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


# --- module_graph: catches the "Importing a module script failed" class of
# bug that a plain http_status 200 on an SPA route can never see (the shell
# HTML always 200s; it's the chunk it references that can be missing). ---

ENTRY_HTML = '<script type="module" crossorigin src="/assets/index-AAA.js"></script>'


def _asset_graph(bodies):
    """bodies: {path: body}. Returns (fake_run_curl, fake_fetch_body) where
    any path not in `bodies` 404s."""
    def fake_run_curl(apex, ip, path):
        return "200" if path in bodies else "404"

    def fake_fetch_body(apex, ip, path):
        return bodies.get(path, "")

    return fake_run_curl, fake_fetch_body


def test_module_graph_passes_when_entry_has_no_dynamic_imports():
    check = {"path": "/", "label": "Homepage"}
    run_curl, fetch_body = _asset_graph({
        "/": ENTRY_HTML,
        "/assets/index-AAA.js": "console.log('no lazy imports here')",
    })

    result = run_module_graph_check("example.com", "203.0.113.10", check,
                                     run_curl=run_curl, fetch_body=fetch_body)

    assert result["ok"] is True
    assert "1 module chunk(s) resolve" in result["actual"]


def test_module_graph_walks_transitive_dynamic_imports():
    check = {"path": "/play", "label": "Simulator"}
    run_curl, fetch_body = _asset_graph({
        "/play": ENTRY_HTML,
        "/assets/index-AAA.js": 'const Game = () => import("./App-BBB.js");',
        "/assets/App-BBB.js": 'const IDE = () => import("./EngineerIDE-CCC.js");',
        "/assets/EngineerIDE-CCC.js": "console.log('leaf chunk')",
    })

    result = run_module_graph_check("example.com", "203.0.113.10", check,
                                     run_curl=run_curl, fetch_body=fetch_body)

    assert result["ok"] is True
    assert "3 module chunk(s) resolve" in result["actual"]


def test_module_graph_fails_on_missing_lazy_chunk():
    # Exactly the reported incident: index.html's entry chunk is fine, but
    # the lazily-imported App chunk it points at 404s (stale deploy).
    check = {"path": "/play", "label": "Simulator"}
    run_curl, fetch_body = _asset_graph({
        "/play": ENTRY_HTML,
        "/assets/index-AAA.js": 'const Game = () => import("./App-stale.js");',
    })

    result = run_module_graph_check("example.com", "203.0.113.10", check,
                                     run_curl=run_curl, fetch_body=fetch_body)

    assert result["ok"] is False
    assert "App-stale.js (404)" in result["actual"]


def test_module_graph_fails_when_entry_page_itself_errors():
    check = {"path": "/play", "label": "Simulator"}

    def fake_run_curl(apex, ip, path):
        return "503"

    result = run_module_graph_check("example.com", "203.0.113.10", check,
                                     run_curl=fake_run_curl)

    assert result["ok"] is False
    assert "503" in result["actual"]


def test_module_graph_fails_when_no_module_script_in_html():
    check = {"path": "/play", "label": "Simulator"}
    run_curl, fetch_body = _asset_graph({"/play": "<html><body>no script tag</body></html>"})

    result = run_module_graph_check("example.com", "203.0.113.10", check,
                                     run_curl=run_curl, fetch_body=fetch_body)

    assert result["ok"] is False
    assert "no <script" in result["actual"]


def test_run_checks_dispatches_module_graph_type():
    config = {
        "apex": "example.com",
        "dns_over_https": False,
        "checks": [{"path": "/play", "type": "module_graph", "label": "Simulator"}],
    }
    run_curl, fetch_body = _asset_graph({
        "/play": ENTRY_HTML,
        "/assets/index-AAA.js": "console.log('leaf')",
    })

    results = run_checks(config, run_curl=run_curl, fetch_body=fetch_body)

    assert results[0]["ok"] is True
