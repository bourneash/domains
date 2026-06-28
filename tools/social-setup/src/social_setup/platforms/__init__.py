from .x import XProvisioner
from .instagram import InstagramPlatform
from .facebook import FacebookPlatform
from .reddit import RedditProvisioner
from .tiktok import TikTokProvisioner
from .bluesky import BlueskyProvisioner
from .pinterest import PinterestProvisioner
from .linkedin import LinkedInPlatform

ALL_PLATFORMS = {
    "x": XProvisioner,
    "instagram": InstagramPlatform,
    "facebook": FacebookPlatform,
    "reddit": RedditProvisioner,
    "tiktok": TikTokProvisioner,
    "bluesky": BlueskyProvisioner,
    "pinterest": PinterestProvisioner,
    "linkedin": LinkedInPlatform,
}
