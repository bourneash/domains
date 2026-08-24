FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml .
COPY src/ src/
RUN pip install --no-cache-dir -e .

COPY registry/ registry/

RUN mkdir -p /data

EXPOSE 4761

# ── run as uid 1000, never root ─────────────────────────────────────────────
# Fleet rule: nothing in this fleet runs as root unless it provably must, and
# nothing here does. uid 1000 matches the host user that owns the repos and the
# backup binds, so files this service writes stay readable/repairable without
# sudo — which is not available passwordless on this host.
#
# /data holds the live SQLite database and is a named volume. Docker only
# applies image-time ownership to a volume when the volume is EMPTY, so an
# existing root-owned volume must be chown'd once, out of band, at rollout —
# see the deploy note in the fleet-images README. Getting this wrong shows up
# as "attempt to write a readonly database", not as a startup crash.
RUN useradd -u 1000 -m -d /home/productfeed productfeed \
    && chown -R productfeed:productfeed /app /data
USER productfeed

CMD ["python", "-m", "productfeed", "serve"]
