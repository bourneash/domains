---
name: domain-ops-wiring
description: Add or audit fleet operations for a domain under /home/jesse/projects/domains, including data-hub sources and subscriptions, Docker cron and worker roles, Slack notifications, deploy gates, health checks, watchdogs, and analytics handoff. Use when a user asks to make a site operational, automate content, add monitoring, wire Slack, add collectors, or connect a new site to fleet operations.
---

# Domain operations wiring

Inspect the deployment model, `ops/`, package scripts, data-hub subscription, and secret conventions before changing anything. Preserve local work and never commit credentials.

Add reputable, niche-appropriate data-hub sources with controlled tags and a bare-host subscription. Keep a local scraper config as desk intent/fallback. Make writer prompts explicit about source thresholds, safety, voice, and handoffs; writers must no-op when no source clears the bar.

Run cheap direct jobs (pulls, probes, deployer/watchdog gates) in cron and expensive editorial work in one-shot workers with logs and locks. Deployment must have a production audit/build gate and must not claim success before the authoritative deploy result. Health checks must include core, current-content, policy, RSS, and sitemap paths. Bound retries and offer a kill switch.

Use the shared Slack bot and channel convention `domain-<host-with-dashes>`. A human must create the channel and invite `@domain_ops` before delivery can be proven. GA4 property creation/grants and GSC DNS verification are authorized external steps; use fleet tooling and do not hand-edit generated analytics registry data. Validate shell syntax, config parsing, build/audit, live cron, health probes, data-hub response, and—only with approval—a test Slack post.
