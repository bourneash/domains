"""env-broker tests.

This tool decides which credentials each site container receives, so its
allowlist arithmetic is a security control, not a convenience. The invariant
worth a test above all others: `never_grant` wins over everything, including an
explicit per-site `extra_keys`. A typo there would silently hand a site the
fleet's GitHub token.
"""
import importlib.util
import os
import stat
import sys
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / "env_broker.py"
spec = importlib.util.spec_from_file_location("env_broker", MODULE)
eb = importlib.util.module_from_spec(spec)
sys.modules["env_broker"] = eb
spec.loader.exec_module(eb)


POLICY = {
    "defaults": {"keys": ["CLOUDFLARE_API_TOKEN", "SLACK_BOT_TOKEN"]},
    "never_grant": ["GITHUB_TOKEN", "FD_TOKEN"],
    "sites": {
        "extra.com": {"extra_keys": ["PEXELS_API_KEY"]},
        "denied.com": {"deny_keys": ["CLOUDFLARE_API_TOKEN"]},
        "sneaky.com": {"extra_keys": ["GITHUB_TOKEN", "PEXELS_API_KEY"]},
    },
    "vault": {"groups": {"cloudflare": ["CLOUDFLARE_"], "slack": ["SLACK_"]}},
}
SLACK = {"plain.com": "SLACK_CHANNEL_PLAIN", "extra.com": "SLACK_CHANNEL_EXTRA"}


# --- allowlist arithmetic ----------------------------------------------------

def test_defaults_plus_own_slack_channel():
    assert eb.granted_keys("plain.com", POLICY, SLACK) == [
        "CLOUDFLARE_API_TOKEN", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_PLAIN"]


def test_a_site_never_gets_another_sites_slack_channel():
    granted = eb.granted_keys("plain.com", POLICY, SLACK)
    assert "SLACK_CHANNEL_EXTRA" not in granted


def test_extra_keys_are_added():
    assert "PEXELS_API_KEY" in eb.granted_keys("extra.com", POLICY, SLACK)


def test_deny_keys_remove_a_default():
    assert "CLOUDFLARE_API_TOKEN" not in eb.granted_keys("denied.com", POLICY, SLACK)


def test_never_grant_beats_extra_keys():
    """The invariant. An extra_keys typo must not be able to leak a fleet key."""
    granted = eb.granted_keys("sneaky.com", POLICY, SLACK)
    assert "GITHUB_TOKEN" not in granted
    assert "PEXELS_API_KEY" in granted, "the rest of extra_keys still applies"


def test_unknown_site_gets_only_defaults():
    assert eb.granted_keys("never-heard-of-it.com", POLICY, SLACK) == [
        "CLOUDFLARE_API_TOKEN", "SLACK_BOT_TOKEN"]


# --- rendering ---------------------------------------------------------------

def test_render_emits_only_granted_keys():
    body, missing = eb.render("x.com", ["A", "B"], {"A": "1", "B": "2", "C": "3"})
    assert "A=1" in body and "B=2" in body
    assert "C=" not in body
    assert missing == []


def test_render_reports_missing_values_instead_of_emitting_empties():
    body, missing = eb.render("x.com", ["A", "GONE"], {"A": "1"})
    assert missing == ["GONE"]
    assert "GONE" not in body, "a key with no value must be absent, not empty"


def test_render_body_carries_a_do_not_commit_header():
    body, _ = eb.render("x.com", [], {})
    assert "DO NOT COMMIT" in body


def test_rendered_file_is_0400_and_never_world_readable(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    monkeypatch.setattr(eb, "ENV_FILE", tmp_path / "fleet.env")
    eb.ENV_FILE.write_text("CLOUDFLARE_API_TOKEN=t\nSLACK_BOT_TOKEN=s\n"
                           "SLACK_CHANNEL_PLAIN=c\nGITHUB_TOKEN=leak\n")
    monkeypatch.setattr(eb, "consumers", lambda: ["plain.com"])

    args = type("A", (), {"source": "file", "site": None, "stdout": False})()
    assert eb.cmd_render(args, POLICY, SLACK) == 0

    out = eb.RENDER_DIR / "plain.com.env"
    mode = stat.S_IMODE(out.stat().st_mode)
    assert mode == 0o400, f"mode {oct(mode)} — a rendered credential file must be 0400"
    assert "GITHUB_TOKEN" not in out.read_text()


def test_render_leaves_no_temp_file_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    monkeypatch.setattr(eb, "ENV_FILE", tmp_path / "fleet.env")
    eb.ENV_FILE.write_text("CLOUDFLARE_API_TOKEN=t\nSLACK_BOT_TOKEN=s\nSLACK_CHANNEL_PLAIN=c\n")
    monkeypatch.setattr(eb, "consumers", lambda: ["plain.com"])
    args = type("A", (), {"source": "file", "site": None, "stdout": False})()
    eb.cmd_render(args, POLICY, SLACK)
    assert list(eb.RENDER_DIR.glob("*.tmp")) == []


# --- recipients --------------------------------------------------------------

def _site(root: Path, name: str, compose_body: str) -> None:
    d = root / "sites" / name
    d.mkdir(parents=True)
    (d / "docker-compose.yml").write_text(compose_body)


def test_consumers_matches_both_pre_and_post_cutover_mounts(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    _site(tmp_path, "old.com", "    - ${HOME}/projects/domains/.env:/work/.env.shared:ro\n")
    _site(tmp_path, "new.com",
          "    - ${HOME}/projects/domains/tools/env-broker/rendered/new.com.env:/work/.env.shared:ro\n")
    _site(tmp_path, "scaffold.com", "services:\n  web:\n    image: x\n")
    assert eb.consumers() == ["new.com", "old.com"]


def test_scaffolds_with_an_ops_dir_are_not_recipients(tmp_path, monkeypatch):
    """21 of 49 registry entries are unbuilt scaffolds. Credentials for a
    container that does not exist is exactly the exposure being removed."""
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    (tmp_path / "sites" / "parked.com" / "ops").mkdir(parents=True)
    assert eb.consumers() == []


# --- vault grouping ----------------------------------------------------------

@pytest.mark.parametrize("key,group", [
    ("CLOUDFLARE_API_TOKEN", "cloudflare"),
    ("SLACK_CHANNEL_XXXTEA", "slack"),
    ("WHO_KNOWS", "misc"),
])
def test_group_for(key, group):
    assert eb.group_for(key, POLICY["vault"]["groups"]) == group


# --- cutover -----------------------------------------------------------------

FLEET_MOUNT = "      - ${HOME}/projects/domains/.env:/work/.env.shared:ro\n"
SECRETS_MOUNT = "      - /home/jesse/projects/domains/.env:/secrets/.env:ro\n"


def _cutover_args(**kw):
    base = {"site": "a.com", "all": False, "revert": False, "dry_run": False}
    base.update(kw)
    return type("A", (), base)()


def test_cutover_rewrites_every_mount_style(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    eb.RENDER_DIR.mkdir()
    (eb.RENDER_DIR / "a.com.env").write_text("X=1\n")
    _site(tmp_path, "a.com", FLEET_MOUNT + SECRETS_MOUNT)

    assert eb.cmd_cutover(_cutover_args(), POLICY, SLACK) == 0
    body = (tmp_path / "sites" / "a.com" / "docker-compose.yml").read_text()
    assert "domains/.env:" not in body
    assert body.count("env-broker/rendered/a.com.env:") == 2
    # destinations must survive untouched — they differ per service
    assert "/work/.env.shared:ro" in body and "/secrets/.env:ro" in body


def test_cutover_refuses_when_no_render_exists(tmp_path, monkeypatch, capsys):
    """Rewriting first would start the container with no credentials at all."""
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    eb.RENDER_DIR.mkdir()
    _site(tmp_path, "a.com", FLEET_MOUNT)

    assert eb.cmd_cutover(_cutover_args(), POLICY, SLACK) == 1
    assert "domains/.env:" in (tmp_path / "sites" / "a.com" / "docker-compose.yml").read_text()
    assert "refusing" in capsys.readouterr().err


def test_cutover_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    eb.RENDER_DIR.mkdir()
    (eb.RENDER_DIR / "a.com.env").write_text("X=1\n")
    _site(tmp_path, "a.com", FLEET_MOUNT)
    compose = tmp_path / "sites" / "a.com" / "docker-compose.yml"

    eb.cmd_cutover(_cutover_args(), POLICY, SLACK)
    once = compose.read_text()
    eb.cmd_cutover(_cutover_args(), POLICY, SLACK)
    assert compose.read_text() == once


def test_cutover_revert_round_trips(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    eb.RENDER_DIR.mkdir()
    (eb.RENDER_DIR / "a.com.env").write_text("X=1\n")
    _site(tmp_path, "a.com", FLEET_MOUNT + SECRETS_MOUNT)
    compose = tmp_path / "sites" / "a.com" / "docker-compose.yml"
    original = compose.read_text()

    eb.cmd_cutover(_cutover_args(), POLICY, SLACK)
    eb.cmd_cutover(_cutover_args(revert=True), POLICY, SLACK)
    assert compose.read_text() == original


def test_cutover_dry_run_changes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "ROOT", tmp_path)
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    eb.RENDER_DIR.mkdir()
    (eb.RENDER_DIR / "a.com.env").write_text("X=1\n")
    _site(tmp_path, "a.com", FLEET_MOUNT)
    compose = tmp_path / "sites" / "a.com" / "docker-compose.yml"
    before = compose.read_text()

    eb.cmd_cutover(_cutover_args(dry_run=True), POLICY, SLACK)
    assert compose.read_text() == before


# --- env parsing -------------------------------------------------------------

def test_load_env_file_ignores_comments_and_blanks(tmp_path):
    f = tmp_path / ".env"
    f.write_text("# comment\n\nA=1\nnot a key\nB=has=equals\n")
    assert eb.load_env_file(f) == {"A": "1", "B": "has=equals"}


def test_load_env_file_missing_is_empty_not_an_error(tmp_path):
    assert eb.load_env_file(tmp_path / "nope") == {}


# --- tool recipients ---------------------------------------------------------

TOOL_POLICY = {**POLICY, "tools": {"amz-stats": {"keys": ["AMAZON_KEY", "SLACK_BOT_TOKEN"]}}}


def test_tool_keys_are_explicit_not_derived():
    assert eb.tool_keys("amz-stats", TOOL_POLICY) == ["AMAZON_KEY", "SLACK_BOT_TOKEN"]


def test_never_grant_does_not_apply_to_tools():
    """gh-stats legitimately IS the GitHub collector. The list exists so no
    *site* holds a fleet-wide credential, not so nothing may."""
    policy = {**POLICY, "tools": {"gh-stats": {"keys": ["GITHUB_TOKEN"]}}}
    assert eb.tool_keys("gh-stats", policy) == ["GITHUB_TOKEN"]


def test_unlisted_tool_renders_nothing_rather_than_a_default_set():
    assert eb.tool_keys("not-in-policy", TOOL_POLICY) == []


def test_tool_consumers_skips_env_broker_itself(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "TOOLS_ROOT", tmp_path)
    for name in ("amz-stats", "env-broker"):
        d = tmp_path / name
        d.mkdir()
        (d / "docker-compose.yml").write_text(
            "    - ${HOME}/projects/domains/.env:/work/.env.shared:ro\n")
    assert eb.tool_consumers() == ["amz-stats"]


# --- vault_only keys ---------------------------------------------------------
#
# FD_TOKEN gates the Fleet Dashboard, which holds the host's Docker socket and
# can push to all 48 repos. It was moved out of the shared fleet .env (B2), so
# the vault is its ONLY source. Two failure modes matter more than the happy
# path: a `--source file` run must not report it missing, and a vault outage
# must never blank a working credential.

VO_POLICY = {
    "defaults": {"keys": ["SLACK_BOT_TOKEN"]},
    "never_grant": ["FD_TOKEN"],
    "vault_only": ["FD_TOKEN"],
    "sites": {},
    "tools": {"fleet-dashboard": {"keys": ["FD_TOKEN", "FD_AUTH"]}},
    "vault": {"groups": {"dashboard": ["FD_"], "slack": ["SLACK_"]}},
}


def test_never_grant_still_blocks_a_vault_only_key_from_sites():
    # vault_only is about where a value comes from, not who may hold it.
    assert "FD_TOKEN" not in eb.granted_keys("any.com", VO_POLICY, {})


def test_tools_may_hold_a_vault_only_key():
    assert eb.tool_keys("fleet-dashboard", VO_POLICY) == ["FD_AUTH", "FD_TOKEN"]


def test_merge_vault_only_overlays_a_key_absent_from_the_env_file(monkeypatch):
    monkeypatch.setattr(eb, "_vault_read",
                        lambda name: {"FD_TOKEN": "t0k", "FD_AUTH": "1"}
                        if name == "fleet — env-dashboard" else {})
    out = eb.merge_vault_only({"SLACK_BOT_TOKEN": "s"}, VO_POLICY)
    assert out["FD_TOKEN"] == "t0k"
    # Only the vault-only key is overlaid — merge_vault_only is not a backdoor
    # for pulling the rest of a group's fields into a file-sourced render.
    assert "FD_AUTH" not in out


def test_merge_vault_only_reads_only_the_groups_that_cover_a_wanted_key(monkeypatch):
    seen = []
    monkeypatch.setattr(eb, "_vault_read", lambda name: seen.append(name) or {})
    eb.merge_vault_only({}, VO_POLICY)
    assert seen == ["fleet — env-dashboard"]


def test_merge_vault_only_leaves_values_untouched_when_the_vault_is_down(monkeypatch):
    def boom(name):
        raise RuntimeError("bw: vault is locked")
    monkeypatch.setattr(eb, "_vault_read", boom)
    values = {"SLACK_BOT_TOKEN": "s"}
    assert eb.merge_vault_only(values, VO_POLICY) == {"SLACK_BOT_TOKEN": "s"}


def test_merge_vault_only_does_not_reread_a_key_the_source_already_had(monkeypatch):
    monkeypatch.setattr(eb, "_vault_read",
                        lambda name: pytest.fail("should not touch the vault"))
    assert eb.merge_vault_only({"FD_TOKEN": "already"}, VO_POLICY)["FD_TOKEN"] == "already"


def test_render_leaves_the_last_good_file_when_the_vault_is_down(tmp_path, monkeypatch, capsys):
    """A vault outage must not silently replace a live token with nothing.

    The panel would come back up unauthenticated on its next restart, and the
    cause — a `render --all` that printed a warning hours earlier — is exactly
    the kind of thing nobody correlates.
    """
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    monkeypatch.setattr(eb, "ENV_FILE", tmp_path / "fleet.env")
    eb.ENV_FILE.write_text("SLACK_BOT_TOKEN=s\nFD_AUTH=1\n")
    monkeypatch.setattr(eb, "consumers", lambda: [])
    monkeypatch.setattr(eb, "tool_consumers", lambda: ["fleet-dashboard"])
    args = type("A", (), {"source": "file", "site": None, "stdout": False})()

    # A good render first — this is the file that must survive.
    monkeypatch.setattr(eb, "_vault_read", lambda name: {"FD_TOKEN": "live-token"})
    assert eb.cmd_render(args, VO_POLICY, {}) == 0
    out = eb.RENDER_DIR / "tool-fleet-dashboard.env"
    assert "FD_TOKEN=live-token" in out.read_text()

    def down(name):
        raise RuntimeError("bw: vault is locked")
    monkeypatch.setattr(eb, "_vault_read", down)
    assert eb.cmd_render(args, VO_POLICY, {}) == 1
    assert "FD_TOKEN=live-token" in out.read_text(), \
        "the vault-only key was blanked by an outage"
    assert "SKIPPED" in capsys.readouterr().err


# --- rendered-file staleness -------------------------------------------------
#
# `--check` used to verify policy-vs-usage, file existence and mode, but never
# CONTENTS — so a site whose policy was corrected and whose file was never
# re-rendered reported "policy ok" while its container ran without the key.
# That is not hypothetical: arttogogh.com sat in exactly that state on
# 2026-09-01, green in the daily check, with a role that would have failed.

def test_rendered_drift_is_silent_when_the_file_matches(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    (tmp_path / "plain.com.env").write_text("# header\nA=1\nB=2\n")
    assert eb.rendered_drift("plain.com", ["A", "B"], {"A": "1", "B": "2"}) is None


def test_rendered_drift_catches_a_key_the_policy_now_grants(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    (tmp_path / "plain.com.env").write_text("A=1\n")
    msg = eb.rendered_drift("plain.com", ["A", "B"], {"A": "1", "B": "2"})
    assert "missing B" in msg and "role will break" in msg


def test_rendered_drift_catches_a_key_the_policy_no_longer_grants(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    (tmp_path / "plain.com.env").write_text("A=1\nOLD=x\n")
    assert "still holds OLD" in eb.rendered_drift("plain.com", ["A"], {"A": "1"})


def test_rendered_drift_catches_a_rotated_value_without_printing_it(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    (tmp_path / "plain.com.env").write_text("A=old-secret\n")
    msg = eb.rendered_drift("plain.com", ["A"], {"A": "new-secret"})
    assert "stale value for A" in msg
    # The whole point of this tool is that secrets stay in files, not in the
    # daily Slack alert this message ends up inside.
    assert "old-secret" not in msg and "new-secret" not in msg


def test_rendered_drift_reads_the_tool_prefixed_filename(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    (tmp_path / "tool-fleet-dashboard.env").write_text("FD_TOKEN=t\n")
    # Same basename, no prefix — a tool must never be checked against this.
    (tmp_path / "fleet-dashboard.env").write_text("FD_TOKEN=wrong\n")
    assert eb.rendered_drift("fleet-dashboard", ["FD_TOKEN"], {"FD_TOKEN": "t"},
                             is_tool=True) is None
    assert "stale value" in eb.rendered_drift(
        "fleet-dashboard", ["FD_TOKEN"], {"FD_TOKEN": "t"})


def test_rendered_drift_defers_a_missing_file_to_the_cron_existence_check(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    assert eb.rendered_drift("gone.com", ["A"], {"A": "1"}) is None


def test_rendered_drift_ignores_a_value_the_source_does_not_have(tmp_path, monkeypatch):
    # render() omits keys with no value; the check must not then call that a drop.
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path)
    (tmp_path / "plain.com.env").write_text("A=1\n")
    assert eb.rendered_drift("plain.com", ["A", "NOVALUE"], {"A": "1"}) is None


# --- per-site values ---------------------------------------------------------
#
# Cloudflare tokens are per-site (tools/cf-tokens): a site's own credential must
# win over the fleet-wide one, and a site item must never be able to widen what
# that site receives.

PS_POLICY = {
    "defaults": {"keys": ["CLOUDFLARE_API_TOKEN", "SLACK_BOT_TOKEN"]},
    "never_grant": [],
    "per_site_vault": ["CLOUDFLARE_API_TOKEN"],
    "sites": {},
    "tools": {"cf-stats": {"keys": ["CLOUDFLARE_API_TOKEN"]}},
    "vault": {"groups": {"cloudflare": ["CLOUDFLARE_"]}},
}


def test_site_values_keeps_only_the_declared_per_site_keys(monkeypatch):
    monkeypatch.setattr(eb, "_vault_read_sites", lambda: {
        "a.com": {"CLOUDFLARE_API_TOKEN": "scoped", "GITHUB_TOKEN": "sneaky"}})
    # A site item is not a second allowlist — a stray field must not be granted.
    assert eb.site_values(PS_POLICY) == {"a.com": {"CLOUDFLARE_API_TOKEN": "scoped"}}


def test_site_values_ignores_an_empty_value(monkeypatch):
    # An empty field would otherwise shadow the fleet token with "" and the
    # site's deploys would fail authentication rather than fall back.
    monkeypatch.setattr(eb, "_vault_read_sites", lambda: {"a.com": {"CLOUDFLARE_API_TOKEN": ""}})
    assert eb.site_values(PS_POLICY) == {"a.com": {}}


def test_site_values_falls_back_to_fleet_wide_when_the_vault_is_down(monkeypatch, capsys):
    def boom():
        raise RuntimeError("bw: locked")
    monkeypatch.setattr(eb, "_vault_read_sites", boom)
    assert eb.site_values(PS_POLICY) == {}
    assert "falling back" in capsys.readouterr().err


def test_a_sites_own_token_wins_over_the_fleet_one(tmp_path, monkeypatch):
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    monkeypatch.setattr(eb, "ENV_FILE", tmp_path / "fleet.env")
    eb.ENV_FILE.write_text("CLOUDFLARE_API_TOKEN=FLEET\nSLACK_BOT_TOKEN=s\n")
    monkeypatch.setattr(eb, "consumers", lambda: ["a.com", "b.com"])
    monkeypatch.setattr(eb, "tool_consumers", lambda: [])
    monkeypatch.setattr(eb, "_vault_read_sites",
                        lambda: {"a.com": {"CLOUDFLARE_API_TOKEN": "SCOPED-A"}})

    args = type("A", (), {"source": "file", "site": None, "stdout": False})()
    assert eb.cmd_render(args, PS_POLICY, {}) == 0
    assert "CLOUDFLARE_API_TOKEN=SCOPED-A" in (eb.RENDER_DIR / "a.com.env").read_text()
    # b.com has not been migrated yet and must still get a working credential.
    assert "CLOUDFLARE_API_TOKEN=FLEET" in (eb.RENDER_DIR / "b.com.env").read_text()


def test_tools_keep_the_account_scoped_token(tmp_path, monkeypatch):
    # cf-stats and site-tracker aggregate ACROSS the fleet; handing either a
    # single site's zone-scoped token would silently break fleet reporting.
    monkeypatch.setattr(eb, "RENDER_DIR", tmp_path / "rendered")
    monkeypatch.setattr(eb, "ENV_FILE", tmp_path / "fleet.env")
    eb.ENV_FILE.write_text("CLOUDFLARE_API_TOKEN=FLEET\n")
    monkeypatch.setattr(eb, "consumers", lambda: [])
    monkeypatch.setattr(eb, "tool_consumers", lambda: ["cf-stats"])
    monkeypatch.setattr(eb, "_vault_read_sites",
                        lambda: {"cf-stats": {"CLOUDFLARE_API_TOKEN": "WRONG"}})

    args = type("A", (), {"source": "file", "site": None, "stdout": False})()
    assert eb.cmd_render(args, PS_POLICY, {}) == 0
    assert "CLOUDFLARE_API_TOKEN=FLEET" in (eb.RENDER_DIR / "tool-cf-stats.env").read_text()


# --- inline comments ---------------------------------------------------------

def test_inline_comment_is_stripped_the_way_source_would(tmp_path, monkeypatch):
    """CLOUDFLARE_ACCOUNT_ID carried `   # from dash.cloudflare.com right-sidebar`
    into 31 rendered files. Invisible for months because every consumer was
    shell, which strips it. The first non-shell consumer put the comment inside
    a Cloudflare resource name and the API rejected it.
    """
    env = tmp_path / "f.env"
    env.write_text('A=abc   # trailing note\nB=plain\nC="has # inside"\nD=no#space\n')
    got = eb.load_env_file(env)
    assert got == {"A": "abc", "B": "plain", "C": '"has # inside"', "D": "no#space"}
