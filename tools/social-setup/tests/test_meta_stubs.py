import pytest
from social_setup.exceptions import PlatformDeferred
from social_setup.platforms.facebook import FacebookPlatform
from social_setup.platforms.instagram import InstagramPlatform


def test_facebook_raises_deferred():
    p = FacebookPlatform()
    with pytest.raises(PlatformDeferred, match="--include-meta"):
        p.provision("example.com", brand=None, browser=None)


def test_instagram_raises_deferred():
    p = InstagramPlatform()
    with pytest.raises(PlatformDeferred, match="--include-meta"):
        p.provision("example.com", brand=None, browser=None)
