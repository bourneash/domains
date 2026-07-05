import os
import textwrap

import run_fleet_smoke
from run_fleet_smoke import check_one_site, main


def _write_config(tmp_path, site, body):
    ops_dir = tmp_path / "sites" / site / "ops"
    ops_dir.mkdir(parents=True)
    (ops_dir / "smoke.yaml").write_text(textwrap.dedent(body))
    return str(tmp_path / "sites" / site), str(ops_dir / "smoke.yaml")


def test_check_one_site_skips_when_disabled(tmp_path, capsys):
    site_dir, config_path = _write_config(tmp_path, "off.com", """\
        apex: off.com
        enabled: false
        checks: []
    """)

    ok = check_one_site(site_dir, config_path, str(tmp_path / "state"), slack_token="")

    assert ok is True
    assert "disabled" in capsys.readouterr().out


def test_check_one_site_posts_slack_when_enabled(tmp_path):
    site_dir, config_path = _write_config(tmp_path, "xxxtea.com", """\
        apex: xxxtea.com
        slack:
          enabled: true
          channel_env: SLACK_CHANNEL_TEST
        checks:
          - path: /
            expect: 200
            label: Homepage
    """)
    os.environ["SLACK_CHANNEL_TEST"] = "domain-xxxtea-com"
    posted = []

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    def fake_post(channel, text, color, token, post_fn=None):
        posted.append((channel, color))
        return True

    ok = check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="xoxb-fake", run_checks_fn=fake_run_checks, post_fn=fake_post,
    )

    assert ok is True
    assert posted == [("domain-xxxtea-com", "good")]


def test_check_one_site_respects_slack_bit_flip(tmp_path):
    site_dir, config_path = _write_config(tmp_path, "quiet.com", """\
        apex: quiet.com
        slack:
          enabled: false
        checks:
          - path: /
            expect: 200
            label: Homepage
    """)
    posted = []

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    def fake_post(channel, text, color, token, post_fn=None):
        posted.append(channel)
        return True

    check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="xoxb-fake", run_checks_fn=fake_run_checks, post_fn=fake_post,
    )

    assert posted == []


def test_check_one_site_returns_false_on_failing_check(tmp_path):
    site_dir, config_path = _write_config(tmp_path, "broken.com", """\
        apex: broken.com
        slack:
          enabled: false
        checks:
          - path: /
            expect: 200
            label: Homepage
    """)

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "Homepage", "path": "/", "expect": 200, "actual": "500", "ok": False}]

    ok = check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="", run_checks_fn=fake_run_checks,
    )

    assert ok is False


def test_main_reports_no_sites_found(tmp_path, capsys):
    exit_code = main(["--sites-dir", str(tmp_path / "empty"), "--state-dir", str(tmp_path / "state")])
    assert exit_code == 0
    assert "nothing to do" in capsys.readouterr().out


def test_check_one_site_returns_false_on_exception(tmp_path):
    """Exception in run_checks_fn causes failure, not silent success."""
    site_dir, config_path = _write_config(tmp_path, "error.com", """\
        apex: error.com
        slack:
          enabled: false
        checks: []
    """)

    def failing_check_fn(config, run_curl=None, http_get=None):
        raise RuntimeError("check execution failed")

    ok = check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="", run_checks_fn=failing_check_fn,
    )

    assert ok is False


def test_main_exit_code_reflects_any_site_failure(tmp_path, monkeypatch):
    """main() returns exit code 1 if any site's checks fail."""
    site_dir_1, config_path_1 = _write_config(tmp_path, "good.com", """\
        apex: good.com
        slack:
          enabled: false
        checks: []
    """)

    site_dir_2, config_path_2 = _write_config(tmp_path, "bad.com", """\
        apex: bad.com
        slack:
          enabled: false
        checks: []
    """)

    checked_sites = []

    def fake_run_checks(config, run_curl=None, http_get=None):
        apex = config.get("apex")
        checked_sites.append(apex)
        if apex == "bad.com":
            return [{"label": "test", "path": "/", "expect": 200, "actual": "500", "ok": False}]
        else:
            return [{"label": "test", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    # Monkeypatch the default parameter of check_one_site by replacing __defaults__
    original_defaults = run_fleet_smoke.check_one_site.__defaults__
    new_defaults = (fake_run_checks,) + original_defaults[1:]
    monkeypatch.setattr(run_fleet_smoke.check_one_site, '__defaults__', new_defaults)

    exit_code = main([
        "--sites-dir", str(tmp_path / "sites"),
        "--state-dir", str(tmp_path / "state"),
        "--stagger-seconds", "0",
    ])

    assert exit_code == 1
    assert "good.com" in checked_sites
    assert "bad.com" in checked_sites


def test_main_only_runs_specified_site(tmp_path, monkeypatch):
    """--only flag filters to exactly one site."""
    site_dir_1, config_path_1 = _write_config(tmp_path, "site1.com", """\
        apex: site1.com
        slack:
          enabled: false
        checks: []
    """)

    site_dir_2, config_path_2 = _write_config(tmp_path, "site2.com", """\
        apex: site2.com
        slack:
          enabled: false
        checks: []
    """)

    checked_sites = []

    def fake_run_checks(config, run_curl=None, http_get=None):
        checked_sites.append(config.get("apex"))
        return [{"label": "test", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    # Monkeypatch the default parameter of check_one_site by replacing __defaults__
    original_defaults = run_fleet_smoke.check_one_site.__defaults__
    new_defaults = (fake_run_checks,) + original_defaults[1:]
    monkeypatch.setattr(run_fleet_smoke.check_one_site, '__defaults__', new_defaults)

    exit_code = main([
        "--sites-dir", str(tmp_path / "sites"),
        "--state-dir", str(tmp_path / "state"),
        "--stagger-seconds", "0",
        "--only", "site1.com",
    ])

    assert exit_code == 0
    assert checked_sites == ["site1.com"]


def test_stagger_seconds_env_var_sets_default(tmp_path, monkeypatch):
    """FLEET_SMOKE_STAGGER_SECONDS env var sets the default --stagger-seconds."""
    site_dir_1, config_path_1 = _write_config(tmp_path, "site1.com", """\
        apex: site1.com
        slack:
          enabled: false
        checks: []
    """)

    site_dir_2, config_path_2 = _write_config(tmp_path, "site2.com", """\
        apex: site2.com
        slack:
          enabled: false
        checks: []
    """)

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "test", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    sleep_calls = []

    def fake_sleep(duration):
        sleep_calls.append(duration)

    # Monkeypatch the default parameter of check_one_site by replacing __defaults__
    original_defaults = run_fleet_smoke.check_one_site.__defaults__
    new_defaults = (fake_run_checks,) + original_defaults[1:]
    monkeypatch.setattr(run_fleet_smoke.check_one_site, '__defaults__', new_defaults)

    monkeypatch.setattr(run_fleet_smoke.time, "sleep", fake_sleep)
    monkeypatch.setenv("FLEET_SMOKE_STAGGER_SECONDS", "5")

    exit_code = main([
        "--sites-dir", str(tmp_path / "sites"),
        "--state-dir", str(tmp_path / "state"),
    ])

    assert exit_code == 0
    assert sleep_calls == [5]
