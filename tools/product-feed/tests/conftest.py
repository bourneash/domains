import pytest

from productfeed import store
from productfeed.config import Subscription


@pytest.fixture
def conn():
    c = store.connect(":memory:")
    store.init_schema(c)
    return c


@pytest.fixture
def subscriptions():
    return {
        "weirdgirlstore.com": Subscription(
            site="weirdgirlstore.com",
            tags_any=["occult", "novelty", "decor", "wearable", "collectibles"],
            site_origin_allow=["weirdgirlstore.com"],
            max_queue_depth=12,
        ),
    }


def make_candidate(asin="B0EXAMPLE1", **overrides):
    c = {
        "asin": asin,
        "title": "Test Widget",
        "price": "$9.99",
        "rating_raw": "4.5 out of 5 stars",
        "review_text": "(100)",
        "image_source_url": "https://example.com/img.jpg",
        "search_query": "test widget",
    }
    c.update(overrides)
    return c


def make_decision(**overrides):
    d = {
        "fits": True,
        "category": "novelty",
        "slug": "test-widget",
        "name": "Test Widget",
        "tagline": "A widget.",
        "classification": "Plastic — novelty variant.",
        "verdict": "Fine.",
        "body": "Paragraph one.\n\nParagraph two.",
        "faq": [],
        "searchQuery": "test widget",
        "imageAlt": "Test widget",
    }
    d.update(overrides)
    return d
