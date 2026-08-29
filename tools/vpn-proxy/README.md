# tools/vpn-proxy

PIA VPN HTTP proxies for fleet scrapers: fixed US and EU exits plus a global exit that changes PIA regions every 15 minutes.

**Security properties (all on by default):**
- Kill switch — iptables blocks all non-VPN egress; container can't leak plaintext
- DNS-over-TLS — Cloudflare DoT resolver, no DNS leaks
- Localhost-only bind — proxy ports only reachable on `127.0.0.1`
- `restart: unless-stopped` — survives host reboots and VPN drops
- `vpn-random` keeps its container and proxy listener while only the VPN tunnel is reconnected

## Setup

**1. Add creds to the shared `.env`:**

```bash
# /home/jesse/projects/domains/.env — append these:
VPN_PIA_USERNAME=p1234567      # your PIA account ID (format: p + digits)
VPN_PIA_PASSWORD=...           # your PIA password
VPN_REGION_US=US East          # optional, this is the default
VPN_REGION_EU=Netherlands      # optional, this is the default
VPN_RANDOM_ROTATION_SECONDS=900 # optional, 15 minutes; minimum 60
VPN_RANDOM_CONTROL_API_KEY=...  # required; generate with: openssl rand -hex 32
```

See `.env.example` for region name options.

**2. Verify `/dev/net/tun` exists on the host:**

```bash
ls -la /dev/net/tun   # should exist on any modern Linux host
```

**3. Start:**

```bash
cd tools/vpn-proxy
docker compose --env-file ../../.env up -d
```

**4. Check health:**

```bash
./check-health.sh
```

Expected output shows `healthy` + a non-home IP for each node.

## Proxy Addresses

| Node | HTTP Proxy | gluetun API |
|------|-----------|-------------|
| US exit | `http://127.0.0.1:8181` | `http://127.0.0.1:9281` |
| EU exit | `http://127.0.0.1:8182` | `http://127.0.0.1:9282` |
| Random global exit | `http://127.0.0.1:8183` | `http://127.0.0.1:9283` |

## Using in Scrapers

**Python `requests`:**
```python
proxies = {"http": "http://127.0.0.1:8181", "https": "http://127.0.0.1:8181"}
resp = requests.get("https://example.com", proxies=proxies)
```

**Python `httpx`:**
```python
client = httpx.Client(proxies="http://127.0.0.1:8181")
```

**Playwright:**
```python
browser = playwright.chromium.launch(proxy={"server": "http://127.0.0.1:8181"})
```

**Environment variable (shell / Docker):**
```bash
HTTP_PROXY=http://127.0.0.1:8181 HTTPS_PROXY=http://127.0.0.1:8181 python scraper.py
```

**curl:**
```bash
curl -x http://127.0.0.1:8181 https://api.ipify.org
```

## Wiring a Site's Scraper Container

Add the proxy address as an env var in the site's `docker-compose.yml`:

```yaml
services:
  scraper:
    environment:
      HTTP_PROXY: http://host.docker.internal:8181
      HTTPS_PROXY: http://host.docker.internal:8181
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

`host.docker.internal` resolves to the host from inside a container. The VPN proxy is bound on the host's loopback so this is required (not `127.0.0.1` which would be the container's own loopback).

## Operations

```bash
# Logs
docker compose --env-file ../../.env logs -f vpn-us
docker compose --env-file ../../.env logs -f vpn-eu
docker compose --env-file ../../.env logs -f vpn-random-rotator

# Force reconnect to a new VPN server
docker compose --env-file ../../.env restart vpn-us

# Change region without rebuild (edit .env then):
docker compose --env-file ../../.env up -d vpn-us

# Manual IP check via API
curl http://127.0.0.1:9281/v1/publicip/ip
curl http://127.0.0.1:9282/v1/publicip/ip
curl http://127.0.0.1:9283/v1/publicip/ip
```

### Random-region rotation

`vpn-random` intentionally has no `SERVER_REGIONS` or `SERVER_COUNTRIES` filter, so Gluetun selects from the full PIA server list. Every 15 minutes, `vpn-random-rotator` uses Gluetun's control API to stop and start only the tunnel. The proxy endpoint and container remain present, but existing connections can still fail during the VPN handoff; callers should use bounded retries with backoff. The Gluetun kill switch stays enabled throughout, so traffic fails closed rather than falling back to the host connection.

## Upgrading to WireGuard (faster)

WireGuard requires generating a key pair first:

```bash
# Inside a one-shot gluetun container or using wg-tools:
wg genkey | tee privatekey | wg pubkey > publickey
cat privatekey
```

Then in `.env`:
```
VPN_TYPE=wireguard
WIREGUARD_PRIVATE_KEY=<your_private_key>
```

gluetun handles WireGuard PIA server negotiation automatically.
