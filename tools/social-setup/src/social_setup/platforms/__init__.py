from .x import XProvisioner
from .instagram import InstagramProvisioner
from .facebook import FacebookProvisioner
from .reddit import RedditProvisioner
from .tiktok import TikTokProvisioner
from .bluesky import BlueskyProvisioner
from .pinterest import PinterestProvisioner

ALL_PLATFORMS = {
    "x": XProvisioner,
    "instagram": InstagramProvisioner,
    "facebook": FacebookProvisioner,
    "reddit": RedditProvisioner,
    "tiktok": TikTokProvisioner,
    "bluesky": BlueskyProvisioner,
    "pinterest": PinterestProvisioner,
}
