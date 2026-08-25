"""Regression: provisioning dispatch must follow capability, not a declared flag.

`_style = "new"` lives on BasePlatform, and PlatformProvisioner (the OLD-style
base) inherits from it — so every old-style provisioner used to inherit
_style="new", get routed to the new-style path, and die constructing `cls()`
without the required `brand` argument. Caught standing up stinkyleftfoot.com
2026-08-25, where it broke Bluesky provisioning outright.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from social_setup.cli import ALL_PLATFORMS


def test_every_platform_routes_to_a_path_it_implements():
    for name, cls in ALL_PLATFORMS.items():
        has_provision = hasattr(cls, "provision")
        has_signup = hasattr(cls, "signup")
        assert has_provision or has_signup, (
            f"{name}: implements neither provision() nor signup() — unroutable"
        )
        assert not (has_provision and has_signup), (
            f"{name}: implements both provision() and signup() — dispatch is ambiguous"
        )


def test_old_style_provisioners_are_not_flagged_new():
    """The specific inheritance leak that broke Bluesky."""
    for name, cls in ALL_PLATFORMS.items():
        if hasattr(cls, "signup"):
            assert not hasattr(cls, "provision"), (
                f"{name}: old-style provisioner would be routed to the new-style "
                f"path and constructed without `brand`"
            )
