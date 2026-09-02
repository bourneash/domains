#!/usr/bin/env python3
"""Host-side Cloudflare read broker: site containers hold no CF credential.

    broker.py                       # serve (default 127.0.0.1:4788)
    broker.py --check               # config sanity, no listen

Site cron containers used to hold a Cloudflare API token so `deploy.sh` could
verify a Workers build. tools/cf-tokens narrowed that to one zone each, but
Cloudflare's `Workers Scripts Write` exists only at account scope, so any site's
token can still deploy any of the 57 workers. The only way to close that is for
the container to hold no Cloudflare credential at all.

Measured across every site's ops/scripts before designing this: all direct
Cloudflare API calls from containers are READS (`curl -s`, no write verbs) —
worker/service status, the builds list, and build logs. Only six sites run
`wrangler deploy` in-container; every other site deploys by pushing to git and
letting Cloudflare Workers Builds do it. So the credential in ~24 containers is
buying nothing but four GETs, and a read-only broker removes it outright.

Two rules do the actual security work here:

  1. **The site is derived from the caller's token, never from the request.**
     There is no `?site=` to tamper with. A container cannot phrase a question
     about another site, so it cannot get an answer about one.
  2. **The upstream path is built here, from an allowlisted template.** Nothing
     the caller sends is interpolated into the Cloudflare URL, so the broker
     cannot be turned into an open proxy for the account-scoped token it holds.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _default_root() -> Path:
    # Evaluated lazily: in the container broker.py lives at /app/broker.py, so
    # the repo-relative guess has no parents[2] and computing it eagerly as a
    # dict default crashed at import before CF_BROKER_ROOT was ever consulted.
    here = Path(__file__).resolve()
    return here.parents[2] if len(here.parents) > 2 else here.parent


ROOT = Path(os.environ.get("CF_BROKER_ROOT") or _default_root())

API = "https://api.cloudflare.com/client/v4"
BROKER_KEY = "CF_BROKER_TOKEN"
# Written by issue-tokens.py. Deliberately a token->site map and NOTHING else:
# the alternative was mounting env-broker's rendered/ directory, which would
# hand this process every site's Slack and Cloudflare credentials to answer
# four GETs. It already holds the account token; that is no reason to widen it.
TOKEN_MAP = Path(os.environ.get("CF_BROKER_TOKEN_MAP",
                                Path(__file__).resolve().parent / "tokens.json"))
HOST = os.environ.get("CF_BROKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("CF_BROKER_PORT", "4788"))
TIMEOUT = 15

BUILD_ID = re.compile(r"^[0-9a-f-]{8,64}$")


def load_registry() -> dict:
    import yaml
    return (yaml.safe_load((ROOT / "registry" / "fleet.yaml").read_text()) or {}).get("sites") or {}


class Fleet:
    """Token -> site, and the per-site facts needed to build upstream URLs.

    Loaded once at start and refreshable, so rotating a site's broker token or
    adding a site does not require a redeploy of every consumer.
    """

    def __init__(self):
        self.by_token: dict[str, str] = {}
        self.worker: dict[str, str] = {}
        self.account = ""
        self.cf_token = ""
        self.reload()

    def reload(self) -> None:
        # From the environment, so the container gets these via env-broker's
        # rendered tool-cf-broker.env like every other tool — no vault client
        # and no shared .env inside this process.
        self.account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        # The ACCOUNT-scoped token, held here deliberately: it is precisely the
        # thing the site containers no longer have. It never leaves this process.
        self.cf_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        reg = load_registry()
        self.worker = {d: (v or {}).get("worker", "") for d, v in reg.items()}

        try:
            self.by_token = {t: s for t, s in
                             json.loads(TOKEN_MAP.read_text()).items() if t and s}
        except (OSError, ValueError) as exc:
            # Fail closed and LOUD. An empty map would 401 every site and read
            # exactly like a fleet-wide Cloudflare outage.
            print(f"cf-broker: cannot read {TOKEN_MAP}: {exc}", file=sys.stderr)
            self.by_token = {}

    def site_for(self, token: str) -> str | None:
        return self.by_token.get(token) if token else None


# Allowlisted reads. `{worker}` and `{account}` are filled from server-side
# state; `{build}` is the only caller-supplied value and is pattern-checked and
# then authorization-checked against that site's own builds before use.
ROUTES = {
    "/v1/worker":  "/accounts/{account}/workers/services/{worker}",
    "/v1/script":  "/accounts/{account}/workers/scripts/{worker}",
}
SERVICE = "/accounts/{account}/workers/services/{worker}"
# Cloudflare keys builds by the worker's SCRIPT TAG, not its name. The broker
# resolves that itself rather than letting the caller pass one: a caller-supplied
# tag is a caller-chosen worker, which is exactly the cross-site read this
# service exists to prevent.
BUILDS = "/accounts/{account}/builds/workers/{tag}/builds?per_page=10"
BUILD_LOGS = "/accounts/{account}/builds/builds/{build}/logs"


def cf_get(path: str, token: str) -> tuple[int, bytes]:
    req = urllib.request.Request(f"{API}{path}",
                                 headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as fh:
            return fh.status, fh.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:                      # network/DNS/timeout
        return 502, json.dumps({"success": False,
                                "errors": [{"message": str(exc)}]}).encode()


class Handler(BaseHTTPRequestHandler):
    fleet: Fleet = None            # set by serve()
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # One line per request, site-labelled, never the token.
        sys.stderr.write("cf-broker %s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype="application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code: int, msg: str) -> None:
        self._send(code, json.dumps({"success": False, "error": msg}).encode())

    def _token(self) -> str:
        auth = self.headers.get("Authorization", "")
        return auth[7:].strip() if auth.startswith("Bearer ") else ""

    def do_GET(self):                                    # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/healthz":
            return self._send(200, b'{"ok":true}')

        site = self.fleet.site_for(self._token())
        if not site:
            # Deliberately identical for an absent, unknown or revoked token:
            # a caller learns nothing about which tokens exist.
            return self._err(401, "unauthorized")

        worker = self.fleet.worker.get(site)
        if not worker:
            return self._err(404, f"no worker registered for {site}")

        fill = {"account": self.fleet.account, "worker": worker}

        if path in ROUTES:
            code, body = cf_get(ROUTES[path].format(**fill), self.fleet.cf_token)
            self.log_message('%s %s -> %s', site, path, code)
            return self._send(code, body)

        if path == "/v1/builds":
            tag = self._script_tag(fill)
            if not tag:
                return self._err(502, "could not resolve this worker's script tag")
            code, body = cf_get(BUILDS.format(tag=tag, **fill), self.fleet.cf_token)
            self.log_message('%s /v1/builds -> %s', site, code)
            return self._send(code, body)

        if path.startswith("/v1/builds/") and path.endswith("/logs"):
            build = path[len("/v1/builds/"):-len("/logs")]
            if not BUILD_ID.match(build):
                return self._err(400, "malformed build id")
            # Authorization, not just validation: a build id is guessable
            # enough that "it looks like an id" is not a reason to hand over
            # another site's build logs.
            if not self._owns_build(fill, build):
                return self._err(403, "not this site's build")
            code, body = cf_get(BUILD_LOGS.format(build=build, **fill),
                                self.fleet.cf_token)
            self.log_message('%s logs/%s -> %s', site, build[:8], code)
            return self._send(code, body)

        return self._err(404, "no such route")

    def _script_tag(self, fill: dict) -> str | None:
        code, body = cf_get(SERVICE.format(**fill), self.fleet.cf_token)
        if code != 200:
            return None
        try:
            d = json.loads(body)
            return d["result"]["default_environment"]["script"]["tag"]
        except (ValueError, KeyError, TypeError):
            return None

    def _owns_build(self, fill: dict, build: str) -> bool:
        tag = self._script_tag(fill)
        if not tag:
            return False                          # fail closed
        code, body = cf_get(BUILDS.format(tag=tag, **fill), self.fleet.cf_token)
        if code != 200:
            return False                          # fail closed
        try:
            builds = json.loads(body).get("result") or []
        except ValueError:
            return False
        return any(str(b.get("build_uuid") or b.get("id")) == build for b in builds)


def serve(host: str, port: int) -> int:
    Handler.fleet = Fleet()
    if not Handler.fleet.cf_token:
        sys.exit("cf-broker: no CLOUDFLARE_API_TOKEN — refusing to start "
                 "(every request would 502 and look like a Cloudflare outage)")
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"cf-broker listening on {host}:{port} — "
          f"{len(Handler.fleet.by_token)} site tokens loaded", flush=True)
    srv.serve_forever()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        f = Fleet()
        print(f"account:      {f.account or 'MISSING'}")
        print(f"cf token:     {'present' if f.cf_token else 'MISSING'}")
        print(f"site tokens:  {len(f.by_token)}")
        print(f"workers known:{sum(1 for w in f.worker.values() if w)}")
        return 0 if (f.account and f.cf_token) else 1

    return serve(args.host, args.port)


if __name__ == "__main__":
    sys.exit(main())
