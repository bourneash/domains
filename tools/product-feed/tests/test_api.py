from fastapi.testclient import TestClient

from productfeed import store
from productfeed.api import create_app
from conftest import make_candidate, make_decision


def client(conn, subscriptions):
    app = create_app(conn=conn, subscriptions=subscriptions)
    return TestClient(app)


def test_health(conn, subscriptions):
    c = client(conn, subscriptions)
    r = c.get("/health")
    assert r.status_code == 200
    assert "weirdgirlstore.com" in r.json()["subscriptions"]


def test_post_candidate_then_claim(conn, subscriptions):
    c = client(conn, subscriptions)
    r = c.post("/candidates", json={
        "site_origin": "weirdgirlstore.com",
        "tags": ["novelty"],
        "candidate": make_candidate(),
        "decision": make_decision(),
    })
    assert r.status_code == 201
    candidate_id = r.json()["id"]

    r = c.get("/subscriptions/weirdgirlstore.com/next")
    assert r.status_code == 200
    item = r.json()["item"]
    assert item["id"] == candidate_id
    assert item["status"] == "claimed"

    # a second pull finds nothing — already claimed.
    r = c.get("/subscriptions/weirdgirlstore.com/next")
    assert r.json()["item"] is None


def test_post_candidate_missing_fields_422(conn, subscriptions):
    c = client(conn, subscriptions)
    r = c.post("/candidates", json={"site_origin": "weirdgirlstore.com"})
    assert r.status_code == 422


def test_unknown_subscription_404(conn, subscriptions):
    c = client(conn, subscriptions)
    r = c.get("/subscriptions/no-such-site.com/next")
    assert r.status_code == 404


def test_publish_and_release_flow(conn, subscriptions):
    c = client(conn, subscriptions)
    cid = c.post("/candidates", json={
        "site_origin": "weirdgirlstore.com",
        "tags": ["decor"],
        "candidate": make_candidate(),
        "decision": make_decision(),
    }).json()["id"]
    c.get("/subscriptions/weirdgirlstore.com/next")

    r = c.post(f"/candidates/{cid}/release")
    assert r.status_code == 200
    assert r.json()["status"] == "queued"

    # claimable again after release
    r = c.get("/subscriptions/weirdgirlstore.com/next")
    assert r.json()["item"]["id"] == cid

    r = c.post(f"/candidates/{cid}/published")
    assert r.status_code == 200
    assert store.get_candidate(conn, cid)["status"] == "published"


def test_depth_endpoint(conn, subscriptions):
    c = client(conn, subscriptions)
    c.post("/candidates", json={
        "site_origin": "weirdgirlstore.com",
        "tags": ["wearable"],
        "candidate": make_candidate(),
        "decision": make_decision(),
    })
    r = c.get("/subscriptions/weirdgirlstore.com/depth")
    assert r.json() == {"site": "weirdgirlstore.com", "depth": 1, "max_queue_depth": 12}


def test_stats_endpoint(conn, subscriptions):
    c = client(conn, subscriptions)
    c.post("/candidates", json={
        "site_origin": "weirdgirlstore.com",
        "tags": ["collectibles"],
        "candidate": make_candidate(),
        "decision": make_decision(),
    })
    r = c.get("/stats")
    assert r.json()["weirdgirlstore.com"]["queued"] == 1
