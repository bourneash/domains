# Escalation Snippet Variants

Append the appropriate variant to each agent role file. Replace `{{ROLE_NAME}}` with the role's filename (without `.md`).

Choose the variant by scanning the role file's content for keywords (see SKILL.md Step 4 table).

---

## Variant: quality-auditor

For roles containing: `voice`, `audit`, `score`

```markdown
## Escalating engineering issues

If you encounter a problem that is structural or technical — not a voice/quality issue — write a task for the engineer rather than trying to fix it yourself.

**Write to `ops/tasks/backlog/` with `type: engineering` if you find:**
- A content file that fails to build or renders blank on the live site
- A template rendering wrong (e.g., wrong date, missing sign, broken layout)
- A pipeline that failed to produce files it should have (missing brief, no readings generated)
- A URL returning non-200 that should exist

**Do NOT ask the engineer to:**
- Improve voice or tone
- Write or rewrite content
- Run or re-run a voice audit

Use this task format:
```yaml
---
title: "[brief description of the engineering issue]"
priority: 2
type: engineering
created: YYYY-MM-DD
assigned_role: engineer
---
Found during {{ROLE_NAME}} run. [Describe the technical issue, file path, URL, or error observed.]
```
```

---

## Variant: seo-analyst

For roles containing: `seo`, `keyword`, `search`

```markdown
## Escalating engineering issues

If you encounter a technical problem while doing SEO analysis, write a task for the engineer. Do not attempt infrastructure or template fixes yourself.

**Write to `ops/tasks/backlog/` with `type: engineering` if you find:**
- Pages that return non-200 when they should exist (sitemap mismatch, broken canonical)
- Internal links pointing to 404s at the template level (not just one page)
- Sitemap missing entire content collections
- `robots.txt` misconfigured (blocking crawl of key sections)
- Structured data / `<meta>` tags missing at the template level across all pages

**Do NOT ask the engineer to:**
- Do keyword research or write SEO copy
- Create new content pages
- Evaluate or change the content strategy

Use this task format:
```yaml
---
title: "[brief description of the engineering issue]"
priority: 2
type: engineering
created: YYYY-MM-DD
assigned_role: engineer
---
Found during {{ROLE_NAME}} run. [Describe the technical issue, URLs affected, and what the correct behavior should be.]
```
```

---

## Variant: planner

For roles containing: `plan`, `board`, `status`

```markdown
## Escalating engineering issues

If your planning or board review surfaces a technical problem that needs code-level intervention, write an engineer task. Do not request engineering work through task commentary or board notes alone.

**Write to `ops/tasks/backlog/` with `type: engineering` if you identify:**
- A stalled deploy (`.deploy-needed` present but site not updated)
- A cron role that appears to have stopped running (missing expected log entries)
- A health check failure that no other role has picked up
- Infrastructure debt that will block planned content work

**Do NOT ask the engineer to:**
- Prioritize or write content
- Do SEO keyword research
- Evaluate voice or brand decisions

Use this task format:
```yaml
---
title: "[brief description of the engineering issue]"
priority: 2
type: engineering
created: YYYY-MM-DD
assigned_role: engineer
---
Found during {{ROLE_NAME}} review. [Describe the issue, why it blocks planned work, and any relevant context from the board or task backlog.]
```
```

---

## Variant: content-writer

For roles containing: `content`, `writer`, `generator`

```markdown
## Escalating engineering issues

If you encounter a problem that prevents content from building, rendering, or deploying correctly, write an engineer task rather than trying to work around it.

**Write to `ops/tasks/backlog/` with `type: engineering` if you find:**
- A content file you wrote that fails `astro build` (template error, missing frontmatter field)
- A content collection schema that rejects valid content
- A page that exists in `site/src/content/` but doesn't appear on the live site
- A redirect or affiliate link that is structurally broken (not just a bad product URL)

**Do NOT ask the engineer to:**
- Write or improve content
- Handle voice or quality issues
- Do keyword research or SEO analysis

Use this task format:
```yaml
---
title: "[brief description of the engineering issue]"
priority: 2
type: engineering
created: YYYY-MM-DD
assigned_role: engineer
---
Found during {{ROLE_NAME}} run. [Describe the error, the file path, and what you expected vs. what happened.]
```
```

---

## Variant: generic

For any other role type

```markdown
## Escalating engineering issues

If you encounter a technical problem during your run — something that requires code, infrastructure, or build changes — write a task for the engineer rather than attempting the fix yourself.

**Write to `ops/tasks/backlog/` with `type: engineering` if you find:**
- Site pages returning errors or blank content
- Scripts or pipeline components failing
- Build failures or TypeScript errors
- Infrastructure issues (Cloudflare, deploys, DNS)

**Do NOT ask the engineer to:**
- Do your role's core job (content, SEO, voice, planning)
- Handle anything outside the engineering scope listed above

Use this task format:
```yaml
---
title: "[brief description of the engineering issue]"
priority: 2
type: engineering
created: YYYY-MM-DD
assigned_role: engineer
---
Found during {{ROLE_NAME}} run. [Describe the issue and any context that would help the engineer reproduce or locate it.]
```
```
