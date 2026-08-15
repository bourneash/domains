from productfeed import store
from conftest import make_candidate, make_decision


def test_add_and_get(conn):
    cid = store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0EXAMPLE1",
        tags=["novelty"], candidate=make_candidate(), decision=make_decision(),
    )
    row = store.get_candidate(conn, cid)
    assert row["status"] == "queued"
    assert row["tags"] == ["novelty"]
    assert row["candidate"]["asin"] == "B0EXAMPLE1"


def test_claim_next_matches_tag_and_origin(conn):
    cid = store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0EXAMPLE1",
        tags=["novelty"], candidate=make_candidate(), decision=make_decision(),
    )
    claimed = store.claim_next(
        conn, tags_any=["novelty", "decor"], site_origin_allow=["weirdgirlstore.com"], claimed_by="weirdgirlstore.com"
    )
    assert claimed["id"] == cid
    assert claimed["status"] == "claimed"
    assert claimed["claimed_by"] == "weirdgirlstore.com"

    row = store.get_candidate(conn, cid)
    assert row["status"] == "claimed"


def test_claim_next_respects_site_origin_allow(conn):
    store.add_candidate(
        conn, site_origin="some-other-site.com", asin="B0EXAMPLE2",
        tags=["novelty"], candidate=make_candidate(asin="B0EXAMPLE2"), decision=make_decision(),
    )
    claimed = store.claim_next(
        conn, tags_any=["novelty"], site_origin_allow=["weirdgirlstore.com"], claimed_by="weirdgirlstore.com"
    )
    assert claimed is None  # tag matches but origin isn't in the allow-list


def test_claim_next_no_match_returns_none(conn):
    store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0EXAMPLE1",
        tags=["masonic"], candidate=make_candidate(), decision=make_decision(),
    )
    claimed = store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="weirdgirlstore.com")
    assert claimed is None


def test_claim_next_is_oldest_first(conn):
    first = store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0FIRST",
        tags=["novelty"], candidate=make_candidate(asin="B0FIRST"), decision=make_decision(),
    )
    store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0SECOND",
        tags=["novelty"], candidate=make_candidate(asin="B0SECOND"), decision=make_decision(),
    )
    claimed = store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="weirdgirlstore.com")
    assert claimed["id"] == first


def test_claim_next_wont_double_claim(conn):
    store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0ONLY",
        tags=["novelty"], candidate=make_candidate(), decision=make_decision(),
    )
    first = store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="a")
    second = store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="b")
    assert first is not None
    assert second is None


def test_mark_published(conn):
    cid = store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0EXAMPLE1",
        tags=["novelty"], candidate=make_candidate(), decision=make_decision(),
    )
    store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="weirdgirlstore.com")
    assert store.mark_status(conn, cid, "published")
    row = store.get_candidate(conn, cid)
    assert row["status"] == "published"
    assert row["published_at"] is not None


def test_release_clears_claim(conn):
    cid = store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0EXAMPLE1",
        tags=["novelty"], candidate=make_candidate(), decision=make_decision(),
    )
    store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="weirdgirlstore.com")
    assert store.mark_status(conn, cid, "queued")
    row = store.get_candidate(conn, cid)
    assert row["status"] == "queued"
    assert row["claimed_by"] is None


def test_active_depth_counts_queued_and_claimed_but_not_published(conn):
    a = store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0A",
        tags=["novelty"], candidate=make_candidate(asin="B0A"), decision=make_decision(),
    )
    store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0B",
        tags=["novelty"], candidate=make_candidate(asin="B0B"), decision=make_decision(),
    )
    # a -> claimed -> published; b stays queued.
    store.claim_next(conn, tags_any=["novelty"], site_origin_allow=None, claimed_by="x")
    store.mark_status(conn, a, "published")
    assert store.active_depth(conn, tags_any=["novelty"]) == 1  # only b (queued)


def test_stats_groups_by_site_and_status(conn):
    store.add_candidate(
        conn, site_origin="weirdgirlstore.com", asin="B0A",
        tags=["novelty"], candidate=make_candidate(asin="B0A"), decision=make_decision(),
    )
    s = store.stats(conn)
    assert s["weirdgirlstore.com"]["queued"] == 1


def test_verified_product_uses_canonical_dp_url_and_merges_tags(conn):
    product, created = store.upsert_product(
        conn,
        asin="B0EXAMPLE1",
        title="Real Product",
        tags=["weird", "decor"],
        price="$12.99",
        rating=4.7,
        review_count=321,
    )
    assert created is True
    assert product["amazon_url"] == "https://www.amazon.com/dp/B0EXAMPLE1"

    product, created = store.upsert_product(
        conn,
        asin="B0EXAMPLE1",
        title="Real Product — refreshed",
        tags=["novelty"],
    )
    assert created is False
    assert product["tags"] == ["decor", "novelty", "weird"]
    assert product["price"] == "$12.99"


def test_sites_choose_same_product_independently(conn):
    store.upsert_product(
        conn, asin="B0EXAMPLE1", title="Shared Product", tags=["weird", "decor"]
    )
    girl = store.claim_product_for_review(
        conn, site="weirdgirlstore.com", tags_any=["decor"]
    )
    stuff = store.claim_product_for_review(
        conn, site="weirdassstuff.com", tags_any=["weird"]
    )
    assert girl["asin"] == stuff["asin"] == "B0EXAMPLE1"
    assert girl["status"] == stuff["status"] == "reviewing"

    store.set_site_product_status(
        conn,
        site="weirdgirlstore.com",
        asin="B0EXAMPLE1",
        status="queued",
        decision=make_decision(),
    )
    store.set_site_product_status(
        conn,
        site="weirdassstuff.com",
        asin="B0EXAMPLE1",
        status="rejected",
        reason="not weird enough",
    )
    assert store.get_site_product(
        conn, site="weirdgirlstore.com", asin="B0EXAMPLE1"
    )["status"] == "queued"
    assert store.get_site_product(
        conn, site="weirdassstuff.com", asin="B0EXAMPLE1"
    )["status"] == "rejected"


def test_site_queue_publish_and_release(conn):
    store.upsert_product(conn, asin="B0EXAMPLE1", title="Product", tags=["weird"])
    store.claim_product_for_review(conn, site="example.com", tags_any=["weird"])
    store.set_site_product_status(
        conn,
        site="example.com",
        asin="B0EXAMPLE1",
        status="queued",
        decision=make_decision(),
    )
    claimed = store.claim_queued_product_for_publish(conn, site="example.com")
    assert claimed["status"] == "publishing"
    assert claimed["amazon_url"] == "https://www.amazon.com/dp/B0EXAMPLE1"
    store.set_site_product_status(
        conn, site="example.com", asin="B0EXAMPLE1", status="queued"
    )
    assert store.list_site_queue(conn, site="example.com")[0]["status"] == "queued"


def test_inventory_depth_is_per_site(conn):
    store.upsert_product(conn, asin="B0EXAMPLE1", title="One", tags=["weird"])
    store.upsert_product(conn, asin="B0EXAMPLE2", title="Two", tags=["weird"])
    store.claim_product_for_review(conn, site="a.com", tags_any=["weird"])
    depth_a = store.inventory_depth(conn, site="a.com", tags_any=["weird"])
    depth_b = store.inventory_depth(conn, site="b.com", tags_any=["weird"])
    assert depth_a["available"] == 1
    assert depth_a["reviewing"] == 1
    assert depth_b["available"] == 2
