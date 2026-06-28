# tools/social-poster/src/social_poster/adapters/__init__.py
from .x import XAdapter
from .bluesky import BlueskyAdapter
from .reddit import RedditAdapter
from .pinterest import PinterestAdapter
from .tiktok import TikTokAdapter
from .linkedin import LinkedInAdapter

ALL_ADAPTERS = {
    a.name: a()
    for a in [XAdapter, BlueskyAdapter, RedditAdapter, PinterestAdapter, TikTokAdapter, LinkedInAdapter]
}
