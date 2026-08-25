# fleet-site-worker — the ONE role-runner image for every site in the fleet.
#
# Replaces 26 per-site ops/docker/Dockerfile.worker files that had drifted into
# 23 distinct variants. Unlike the cron images, this drift was SUBSTANTIVE:
# five different bases spanning two libc implementations
# (node:22-alpine, node:22-slim, node:22-bookworm-slim, python:3.12-slim).
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY DEBIAN, NOT ALPINE — the single most important line in this file
#
# @cloudflare/workerd needs glibc: it calls fcntl64 and _dl_find_object, which
# Alpine's musl (even with libc6-compat) does not provide. The @astrojs/
# cloudflare adapter spawns workerd to prerender static routes, so ANY build
# gate or deploy path that runs `astro build` simply cannot work on Alpine.
#
# This was not theoretical. broadwayshowgirls.com deadlocked its engineer build
# gate on exactly this and had to be moved to bookworm-slim; a bot had
# meanwhile "fixed" it by gutting the build gate, which hid the real fault for
# weeks. newmomshop.com independently discovered the same thing and pinned a
# worker-runtime contract literally named "2026-07-31-glibc". At the time of
# consolidation ELEVEN sites were still on Alpine while running wrangler in
# ops, ten of them with scheduled deployers — the same trap, unsprung.
#
# Standardising here retires that entire bug class in one change. Do not move
# this image to Alpine to save space. The space is not worth it.
# ─────────────────────────────────────────────────────────────────────────────
# Base pinned by DIGEST — see the cron Dockerfile's note for the reasoning and
# the bump procedure. NODE_MAJOR is gone deliberately: a build ARG cannot be
# combined with a digest without the two silently disagreeing (the digest wins,
# so the ARG would become a lie). The node major is part of the pin now.
#   node major: 22   base: bookworm (Debian 12, glibc 2.36)
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# ── system packages: the UNION of what all 26 sites installed ───────────────
# FONTS ARE LOAD-BEARING, not cosmetic. The editorial-card generators render
# headlines through @resvg/resvg-js, which calls loadSystemFonts(). On a base
# with no fonts resvg renders every <text> element as nothing and silently
# emits blank cards — a failure that looks like a content bug, not a build bug.
# fontconfig + fc-cache is what lets resvg find them; chromium needs them too.
#
# imagemagick: 4 sites (0daynews, saveusfarms, weirdassstuff, weirdgirlstore).
# libvips-dev: sharp. libnss3/libfreetype6/libharfbuzz0b: headless chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      chromium \
      curl \
      fontconfig \
      fonts-dejavu \
      fonts-freefont-ttf \
      fonts-liberation \
      git \
      imagemagick \
      libfreetype6 \
      libharfbuzz0b \
      libnss3 \
      libvips-dev \
      openssh-client \
      python3 \
      python3-pip \
      python3-venv \
      tzdata \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# ── node tooling ────────────────────────────────────────────────────────────
# claude-code is PINNED. A floating tag means a cold rebuild after a prune can
# silently change the agent runtime under every role on every site at once.
# 25 of 26 sites already pinned this exact version; the 26th floated.
#
# playwright-core (JS driver only) drives the SYSTEM chromium installed above
# for the engineer's true-render health check — PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# keeps it from pulling its own ~300MB browser bundle.
#
# @bitwarden/cli is how tools/social-lib's vault_store.py reads platform
# credentials out of Vaultwarden for the social-poster role.
ARG CLAUDE_CODE_VERSION=2.1.140
ARG PLAYWRIGHT_CORE_VERSION=1.49.1
ARG BITWARDEN_CLI_VERSION=2026.6.0
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@bitwarden/cli@${BITWARDEN_CLI_VERSION}" \
    && mkdir -p /opt/engineer-tools \
    && cd /opt/engineer-tools \
    && npm init -y >/dev/null 2>&1 \
    && npm install --ignore-scripts "playwright-core@${PLAYWRIGHT_CORE_VERSION}" \
    && npm cache clean --force

# ── python deps: union across the fleet ─────────────────────────────────────
#   pyyaml   tools/guide-queue frontmatter + ops/tracked.yaml reads
#   Pillow   generate-guide-images.py crop/convert (media-gen returns PNG)
#   httpx    4 sites' data fetchers
#   openai / feedparser / requests / ephem / pytest*
#            broadwayshowgirls' ops/requirements.txt and sinderella's
#            ops/llm/requirements.txt (local-LLM writer paths). Folding their
#            union in here is what lets those two sites drop their bespoke
#            images instead of becoming permanent exceptions.
#   idna>=3.10  transitive floor pin carried over from sinderella
#               (GHSA-65pc-fj4g-8rjx)
#   cloakbrowser  3 sites' entrypoint-worker.sh calls `cloakbrowser install`
#               unconditionally before dispatching to run-role.sh. It was baked
#               into their bespoke worker images; dropping it here turned every
#               product-scout / product-publisher run into an exit-127 at the
#               entrypoint. The Chromium payload still lives in the per-site
#               cloakbrowser_cache volume — only the CLI belongs in the image.
#
# Installed BOTH system-wide and into a venv: some ops scripts invoke the
# system python3, others expect an interpreter under a venv path. Providing
# both costs a few tens of MB once and removes a class of per-site divergence.
# --break-system-packages: bookworm's pip refuses a global install otherwise
# (PEP 668), and there is nothing worth protecting in a throwaway one-shot
# container.
ENV FLEET_VENV=/opt/fleet-venv
RUN pip3 install --break-system-packages --no-cache-dir \
      pyyaml Pillow httpx openai feedparser requests ephem \
      pytest pytest-mock "idna>=3.10" cloakbrowser \
    && python3 -m venv "$FLEET_VENV" \
    && "$FLEET_VENV/bin/pip" install --no-cache-dir --upgrade pip \
    && "$FLEET_VENV/bin/pip" install --no-cache-dir \
      pyyaml Pillow httpx openai feedparser requests ephem \
      pytest pytest-mock "idna>=3.10" cloakbrowser

# ── Playwright browsers: cached PER SITE, not baked ─────────────────────────
# Two different Playwright consumers exist in this fleet:
#   1. ops/scripts/engineer-render-check.mjs drives the SYSTEM chromium above
#      through playwright-core + CHROMIUM_PATH. Needs no bundle.
#   2. Five sites depend on `@playwright/test`, and TWO of them
#      (sinderella.org, saveusfarms.com) gate their DEPLOY on
#      `npm run test:smoke:prod`. @playwright/test will not drive an arbitrary
#      system binary — it launches one pinned browser REVISION and hard-fails
#      if that exact build is absent.
#
# The first version of this image shipped without any bundle and broke
# sinderella's deploy gate on a 30-minute cadence. The obvious fix — bake the
# bundles for the pinned versions — was tried and is WRONG, because those pins
# are caret ranges. Measured across the five sites on the same day:
#     pinned ^1.59.1 -> resolved 1.62.1, 1.61.0, 1.61.1
#     pinned ^1.60.0 -> resolved 1.60.0
# Four different revisions, and every `npm ci` against a refreshed lock can
# move them again. A baked revision is correct until the next lockfile update
# and then fails exactly as hard as having none.
#
# PLAYWRIGHT_BROWSERS_PATH=0 tells Playwright to install browsers INSIDE
# node_modules — which for these sites is already a persistent named volume.
# So the browser is cached per site, survives the one-shot container, matches
# whatever version that site actually resolved, and self-heals on a bump. The
# shared entrypoint installs it on demand (see worker/entrypoint.sh).
#
# Same principle as the crontab: do not bake something that varies per site.
ENV PLAYWRIGHT_BROWSERS_PATH=0

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CORE_ENTRY=/opt/engineer-tools/node_modules/playwright-core/index.js
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# REQUIRED for the @astrojs/cloudflare prerenderer: it starts a vite preview
# server on "localhost" and then fetches it. Without ipv4first the server binds
# ::1 while fetch resolves 127.0.0.1 -> ECONNREFUSED, and the build gate fails
# with an error that looks nothing like a DNS problem.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV HOME=/home/ops
ENV TZ=America/New_York

# ── runtime user ────────────────────────────────────────────────────────────
# uid 1000 matches the host (jesse). Two independent reasons this is not
# optional: claude-code refuses --dangerously-skip-permissions as root, and a
# root-owned write into the bind-mounted repo corrupts .git/objects in a way
# that needs sudo to undo (already done to four sites).
RUN userdel -r node 2>/dev/null || true; \
    groupadd -g 1000 ops \
    && useradd -u 1000 -g ops -m -d /home/ops -s /bin/bash ops \
    && mkdir -p /home/ops/.ssh /home/ops/.claude/skills /home/ops/.claude/projects \
    && ssh-keyscan -t rsa,ecdsa,ed25519 github.com 2>/dev/null >> /home/ops/.ssh/known_hosts \
    && chown -R ops:ops /home/ops /opt/engineer-tools \
    && mkdir -p /work/site/node_modules \
    && chown -R ops:ops /work

# ── strip setuid/setgid escalation primitives ───────────────────────────────
# The base image ships 14 setuid/setgid binaries (su, mount, umount, chsh,
# chfn, gpasswd, newgrp, passwd, ssh-keysign, unix_chkpwd, dbus helper …).
# NOT ONE of them is used by any role: workers run as uid 1000, never switch
# user, never mount anything, and authenticate to git by SSH key rather than
# host-based auth.
#
# Left in place they are a standing local-privilege-escalation toolkit inside a
# container that executes model-authored code against the internet. Clearing
# the bits (rather than deleting the files) removes the escalation primitive
# while leaving the binaries callable for their ordinary unprivileged uses, so
# nothing that legitimately shells out breaks.
#
# fleet-image-smoke asserts this stays at zero.
RUN find / -xdev -perm /6000 -type f -exec chmod -s {} + 2>/dev/null || true

COPY --chmod=0755 entrypoint.sh /usr/local/bin/fleet-worker-entrypoint.sh

ARG FLEET_IMAGE_VERSION=dev
LABEL org.domains.fleet.image="fleet-site-worker" \
      org.domains.fleet.version="${FLEET_IMAGE_VERSION}"
ENV FLEET_IMAGE_VERSION=${FLEET_IMAGE_VERSION}

USER ops
WORKDIR /work

# A dispatcher, not a hardcoded path — the fleet had three different worker
# entrypoint conventions and this absorbs all of them without per-site builds.
ENTRYPOINT ["/usr/local/bin/fleet-worker-entrypoint.sh"]
