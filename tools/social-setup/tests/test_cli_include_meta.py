"""Tests for --include-meta CLI flag and linkedin in default platform order."""

from click.testing import CliRunner

from social_setup.cli import PLATFORM_ORDER, main


def test_linkedin_in_platform_order():
    assert "linkedin" in PLATFORM_ORDER


def test_linkedin_before_facebook():
    assert PLATFORM_ORDER.index("linkedin") < PLATFORM_ORDER.index("facebook")


def test_include_meta_flag_appears_in_help():
    runner = CliRunner()
    result = runner.invoke(main, ["provision", "--help"])
    assert result.exit_code == 0
    assert "--include-meta" in result.output


def test_provision_help_contains_meta_description():
    runner = CliRunner()
    result = runner.invoke(main, ["provision", "--help"])
    assert "Facebook" in result.output or "meta" in result.output.lower()
