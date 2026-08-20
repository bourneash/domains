FROM python:3.11-slim-bookworm

WORKDIR /app

# Nano Banana's Chromium (CloakBrowser, Playwright-driven) needs a real
# system dependency graph on Debian/Ubuntu — libnss3, libatk, libgtk,
# libasound2, etc. `playwright install-deps` pulls exactly that set;
# installed here (as root, before dropping to uid 1000) rather than
# hand-maintaining an apt list.
#
# iproute2 (`ip`) is NOT optional: api.py's _RestrictToLocalAndDocker
# middleware shells out to `ip -4 -o addr show` at import time to
# enumerate docker0/br-* bridges and allow site cron containers through.
# python:3.11-slim doesn't ship it — the middleware's `except: pass`
# swallows the failure silently, so a missing `ip` doesn't crash the
# service, it just 403s every real caller while /health keeps looking
# fine. Found exactly that way in this container's first e2e test.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates iproute2 && \
    rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
COPY src/ src/

# cloakbrowser + playwright pinned to the exact versions already validated
# on the host (see `pip3 show cloakbrowser` / `pip3 show playwright` there)
# — this backend's whole value is passing bot detection; an unpinned bump
# here is how that quietly breaks.
RUN pip install --no-cache-dir . && \
    pip install --no-cache-dir cloakbrowser==0.3.31 playwright==1.49.1

# System-wide (not per-user) browser cache dir so it's readable after we
# drop to uid 1000 below.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN python -m playwright install --with-deps chromium && \
    chmod -R a+rX /opt/ms-playwright

# uid 1000 matches the host "jesse" account. Required, not cosmetic: the
# nanobanana backend opens a real browser against the host's live X
# session, and XAUTHORITY (bind-mounted at runtime) is mode 0700 owned by
# that uid — root inside the container could not read the auth cookie.
RUN useradd -u 1000 -m -s /bin/bash jesse && \
    mkdir -p /app/data && chown -R jesse:jesse /app
USER jesse

EXPOSE 4780
CMD ["python", "-m", "uvicorn", "media_gen.api:app", "--host", "0.0.0.0", "--port", "4780"]
