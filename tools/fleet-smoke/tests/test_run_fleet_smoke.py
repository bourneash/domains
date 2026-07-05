import os
import textwrap

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
