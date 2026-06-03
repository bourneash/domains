FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/New_York
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Core dev tooling. Kept in one apt layer for cache friendliness.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash zsh \
      ca-certificates curl wget gnupg lsb-release \
      git openssh-client \
      jq less man-db \
      ripgrep fd-find fzf \
      vim nano \
      tmux \
      python3 python3-pip python3-venv pipx \
      build-essential \
      tzdata locales sudo \
      tini \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Node 22 LTS via NodeSource. Bundled npm 10.x is fine; skip self-upgrade
# (npm@latest install on bundled npm has a known MODULE_NOT_FOUND bug).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# yq (mikefarah, Go binary)
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" \
      -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# ttyd — web terminal binary
RUN ARCH=$(uname -m) \
    && case "$ARCH" in \
         x86_64)  TTYD_ARCH=x86_64 ;; \
         aarch64) TTYD_ARCH=aarch64 ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}" \
      -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# Shift+Enter = newline in the web terminal. ttyd's bundled xterm sends bare
# CR for both Enter and Shift+Enter, so Claude Code's TUI submits instead of
# inserting a line. We capture ttyd's OWN served index.html here (so it always
# matches this exact ttyd build) and inject a small script at the top of <head>
# that rewrites Shift+Enter → ESC+CR on the input websocket. The entrypoint
# then serves this augmented page via `ttyd -I`. See ttyd-shift-enter.js.
COPY ttyd-enhance.js /opt/ttyd/enhance.js
RUN set -eu; \
    ttyd -p 7682 -i 127.0.0.1 true & TTYD_PID="$!"; \
    for i in $(seq 1 50); do \
      curl -sf http://127.0.0.1:7682/ -o /opt/ttyd/index.html && break; \
      sleep 0.2; \
    done; \
    kill "${TTYD_PID}" 2>/dev/null || true; \
    test -s /opt/ttyd/index.html; \
    node -e 'const fs=require("fs"); \
      const html=fs.readFileSync("/opt/ttyd/index.html","utf8"); \
      const js=fs.readFileSync("/opt/ttyd/enhance.js","utf8"); \
      if(!html.includes("<head>")) throw new Error("ttyd index has no <head>"); \
      const out=html.replace("<head>","<head><script>"+js+"</scr"+"ipt>"); \
      if(out===html) throw new Error("injection no-op"); \
      fs.writeFileSync("/opt/ttyd/index.html",out);'; \
    grep -q "NEWLINE_FRAME" /opt/ttyd/index.html; \
    grep -q "dd-redraw" /opt/ttyd/index.html

# Claude Code + Wrangler globally
RUN npm install -g @anthropic-ai/claude-code wrangler

# The global npm prefix (/usr) is root-owned, but containers run as the
# unprivileged `dev` user — so claude's in-place auto-update can't write there
# ("no write permission to npm prefix"). The image owns the claude version;
# bump it by rebuilding with `bin/dd-build`, not by self-update.
ENV DISABLE_AUTOUPDATER=1

# Put the per-user native-install dir on PATH so claude doesn't nag
# ("Native installation exists but ~/.local/bin is not in your PATH") if a
# native claude ever lands there. Applies to exec, ttyd, and login shells.
ENV PATH="/home/dev/.local/bin:${PATH}"

# Match host UID/GID (1000:1000 on Jesse's machine). Override via build args if needed.
ARG HOST_UID=1000
ARG HOST_GID=1000

# ubuntu:24.04 ships a default user 'ubuntu' at UID 1000 — repurpose it as 'dev'.
RUN if id -u ubuntu >/dev/null 2>&1; then \
        usermod -l dev ubuntu && \
        groupmod -n dev ubuntu && \
        usermod -d /home/dev -m dev || true; \
    else \
        groupadd -g ${HOST_GID} dev && \
        useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash dev; \
    fi \
    && mkdir -p /work /home/dev/.claude/projects /home/dev/persist \
    && chown -R dev:dev /home/dev /work \
    && echo "dev ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/dev

USER dev
WORKDIR /work

COPY --chown=dev:dev bashrc /home/dev/.bashrc
COPY --chmod=0755 entrypoint.sh /usr/local/bin/dd-entrypoint
COPY --chmod=0755 dd-dev /usr/local/bin/dd-dev

EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dd-entrypoint"]
