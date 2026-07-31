# AI usage index

Audited 2026-07-22. Scope: the shared `tools/` projects, every project under
`sites/`, and the role/configuration code at repository root. Generated output,
article prose, caches, logs, vendored packages, virtual environments, and lockfiles
were excluded unless they affected a running model selection.

## How to read this index

- **Remote / Anthropic CLI** means the feature launches `claude -p`. Authentication
  is supplied to Claude Code by the worker environment; this is not a direct
  Anthropic SDK call in the audited code.
- **Claude CLI default (normally Sonnet)** means no `--model` is passed. It is not a
  reproducible model pin and can change with the installed CLI/account default.
- `sonnet` and `haiku` are Claude CLI aliases, also not immutable model IDs.
- **Local** means inference is served on this host through Ollama or vLLM. The
  OpenAI Python package in those rows is only an OpenAI-compatible client; OpenAI
  is not the inference provider.
- **Enabled** means the cron wiring is live and no matching `ops/.<role>-disabled`
  kill switch was found. Conditional roles can still make zero model calls on a
  healthy/no-work tick.

## Provider and model summary

| Provider/runtime | Models found | Where it is used |
|---|---|---|
| Anthropic via Claude Code CLI | `claude-sonnet-4-6`; `claude-haiku-4-5-20251001`; aliases `sonnet`, `haiku`; unpinned CLI default | Scheduled editorial, planning, SEO, engineering/repair, affiliate resolution, persona creation, deployment roles, and audits |
| Ollama (local HTTP / OpenAI-compatible API) | `llama3.1:8b`; `glm-4.7-flash:latest`; `qwen2.5:32b` | Local news drafting and grounding judges; Broadway Showgirls content and real-person gate |
| vLLM (local OpenAI-compatible API) | `hugging-quants/Meta-Llama-3.1-8B-Instruct-AWQ-INT4` | Sinderella briefs, news selection, readings, Signal copy, and affiliate selection |
| Google GenAI API | `imagen-4.0-generate-001`; `gemini-2.5-flash-image`, then `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` fallbacks | UltraRough batch image generation |
| IOPaint / local PyTorch model | `lama` by default; optional `ldm`, `zits`, `mat`, `fcf`, `manga`, `cv2`, etc. | Interactive image inpainting/removal tool |

No production calls to the OpenAI-hosted API, Azure OpenAI, Bedrock, Vertex AI,
Groq, Mistral-hosted APIs, or Hugging Face-hosted inference were found.

## Shared tools and standalone AI features

| Project / feature | Provider | Model | Status | Basic function | Primary source |
|---|---|---|---|---|---|
| Fleet cron-role archetypes | Anthropic CLI | Usually `claude-sonnet-4-6`; engineer/watchdog select it only after deterministic checks | Templates, not services themselves | Reusable specs and runners for planners, writers, SEO analysts, affiliate editors, engineers, and incident repair | [`tools/cron-roles/`](tools/cron-roles/) |
| AI inventory scanner | None | None | Utility + Fleet Dashboard data source | Dispatch-aware scanner that follows dedicated role scripts, resolves provider/model configuration, detects conditional and deterministic paths, and supplies the dashboard's AI Inventory view. | [`tools/ai-inventory/audit-ai.py`](tools/ai-inventory/audit-ai.py) |
| Affiliate audit resolution agent | Anthropic CLI | `claude-sonnet-4-6` by default; configurable in YAML | On demand after deterministic audit flags a product | Searches for and verifies an Amazon replacement, edits the catalog, builds, commits, and queues deployment; turn-capped per product | [`tools/affiliate-audit/resolve.py`](tools/affiliate-audit/resolve.py) |
| Persona generator | Anthropic CLI | `claude-haiku-4-5-20251001` | On demand | Generates fictional staff identity data (name, DOB, bio, employment history) as JSON | [`tools/personas/src/personas/generator.py`](tools/personas/src/personas/generator.py) |
| Domain Developer | Anthropic CLI / Claude Code | User-selected by Claude Code; not pinned in this project | Interactive service | Runs a per-site Claude development environment with CLI and web terminal, isolated to that site's mount | [`tools/domain-developer/`](tools/domain-developer/) |
| Lama Cleaner / IOPaint | Local model | `lama` default; CLI-selectable alternatives | On demand | GPU-assisted image inpainting and object removal over a selected image directory | [`tools/lama-cleaner/lama-cleaner`](tools/lama-cleaner/lama-cleaner) |

The remaining shared tools (`data-hub`, `data-hub-images`, social tooling,
dashboards, stats collectors, deploy testers, trackers, notification tools, and
VPN proxy) use deterministic code and external data/platform APIs, not generative
AI. `data-hub-images` is an asset search/ranking broker, not an image generator.

## Site-specific non-role AI features

| Site / function | Provider | Model | Status | Basic function | Primary source |
|---|---|---|---|---|---|
| `0daynews.com` voice rubric scorer | Anthropic CLI | `claude-haiku-4-5-20251001` | Called by editorial workflow | Scores article voice against a rubric with one cheap, tool-free model turn | [`voice_auditor.py`](sites/0daynews.com/ops/scripts/voice_auditor.py) |
| `americastrikes.com` local news draft | Ollama | Runtime config is `llama3.1:8b`; runner comments mention GLM, so config is authoritative | **Disabled** (`.news-writer-local-disabled`) | Selects a scraped-source cluster, requests strict JSON, builds Markdown/frontmatter, then sends the draft through grounding gates | [`local_news_writer.py`](sites/americastrikes.com/ops/llm/local_news_writer.py) |
| `americastrikes.com` source-grounding judge | Ollama | `LOCAL_LLM_AUDIT_MODEL`, else `LOCAL_LLM_MODEL`; fallback `glm-4.7-flash:latest` | Part of disabled local writer | Advisory semantic fact checker layered behind a deterministic hard gate; can hard-block only when explicitly enabled | [`source_auditor.py`](sites/americastrikes.com/ops/llm/source_auditor.py) |
| `saveusfarms.com` local news draft | Ollama | Runtime config overrides code fallback to `llama3.1:8b` | **Disabled** (`.news-writer-local-disabled`) | Produces source-constrained agriculture/news articles and validates them before publication | [`local_news_writer.py`](sites/saveusfarms.com/ops/llm/local_news_writer.py) |
| `saveusfarms.com` source-grounding judge | Ollama | Effective `llama3.1:8b` unless `LOCAL_LLM_AUDIT_MODEL` is set; code fallback `glm-4.7-flash:latest` | Part of disabled local writer | Checks names and numeric claims against supplied sources; deterministic check is the primary hard block | [`source_auditor.py`](sites/saveusfarms.com/ops/llm/source_auditor.py) |
| `broadwayshowgirls.com` persona content client | Anthropic CLI in current compose; Ollama optional | Current `BSG_LLM_BACKEND=claude-sonnet` → CLI alias `sonnet`; local alternative `qwen2.5:32b` | Enabled | Generates persona-voiced fictional entertainment articles for Carmen, Priya, and Imani; backend can be flipped without changing downstream gates | [`client.py`](sites/broadwayshowgirls.com/ops/llm/client.py) |
| `broadwayshowgirls.com` real-person gate | Ollama | `qwen2.5:32b` by default (`BSG_AUDIT_MODEL` override) | Enabled with writer pipeline | LLM judge that rejects accidental references to real people in fictional content | [`realperson_gate.py`](sites/broadwayshowgirls.com/ops/llm/roles/realperson_gate.py) |
| `sinderella.org` local inference server | vLLM | `hugging-quants/Meta-Llama-3.1-8B-Instruct-AWQ-INT4` | Enabled; watchdog supervised | Hosts an OpenAI-compatible local endpoint for the site's deterministic Python content pipelines | [`ops/llm/docker-compose.yml`](sites/sinderella.org/ops/llm/docker-compose.yml) |
| `sinderella.org` story selection | vLLM local | Same Llama 3.1 8B AWQ model | Enabled | Chooses top stories from fetched candidates for the daily brief | [`brief_builder.py`](sites/sinderella.org/ops/llm/roles/brief_builder.py) |
| `sinderella.org` energy synthesis | vLLM local | Same Llama 3.1 8B AWQ model | Enabled | Synthesizes collected astronomical, weather, market, news, and other signals into a daily energy section | [`brief_builder.py`](sites/sinderella.org/ops/llm/roles/brief_builder.py) |
| `sinderella.org` reading generator | vLLM local | Same Llama 3.1 8B AWQ model | Enabled | Generates persona-voiced daily horoscope readings from the brief and scored signals | [`reading_generator.py`](sites/sinderella.org/ops/llm/roles/reading_generator.py) |
| `sinderella.org` Signal writer | vLLM local | Same Llama 3.1 8B AWQ model | Enabled | Writes the multi-sign daily “Signal” and chooses a relevant affiliate item, followed by structural/voice validation | [`signal_writer.py`](sites/sinderella.org/ops/llm/roles/signal_writer.py) |
| `sinderella.org` fine-tuning/evaluation scripts | Local training stack | Base `unsloth/Meta-Llama-3.1-8B-Instruct` | Experimental / task on hold | Prepares and evaluates a persona-specific fine-tune; not the model currently served in production | [`ops/llm/finetune/`](sites/sinderella.org/ops/llm/finetune/) |
| `ultrarough.com` batch image generator, Imagen mode | Google GenAI | `imagen-4.0-generate-001` | On demand | Generates one image per prompt with a shared visual primer and writes image/metadata sidecars | [`image-gen.py`](sites/ultrarough.com/ops/scripts/image-gen.py) |
| `ultrarough.com` batch image generator, chat mode | Google GenAI | `gemini-2.5-flash-image`; fallback preview models listed above | On demand | Uses a stateful Gemini image chat so a primer and sequential prompts share context | [`image-gen.py`](sites/ultrarough.com/ops/scripts/image-gen.py) |

## Scheduled AI service inventory

This table is one row per operational AI role family/site combination. Repeated
site names in one cell have the same implementation and effective model. Pure
scrapers, fetchers, deploy scripts, notification jobs, health checks, and social
posting CLIs are omitted because they make no model call.

| Sites | Service/function | Provider | Effective model | Status / trigger | Basic function |
|---|---|---|---|---|---|
| `0daynews.com` | planner | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Reviews goals, metrics, and backlog; creates/prioritizes work |
| `0daynews.com` | news-writer | Anthropic CLI | CLI default (unpinned) | Enabled, hourly | Researches and publishes cybersecurity news through an atomic article/image workflow |
| `0daynews.com` | page-designer | Anthropic CLI | CLI default (unpinned) | Enabled, hourly | Improves site/page presentation from its role brief |
| `0daynews.com` | image-backfill | Anthropic CLI | CLI default (unpinned) | Enabled, hourly | Finds and attaches suitable images to content missing imagery |
| `0daynews.com` | social-media | Anthropic CLI | `claude-haiku-4-5-20251001` | **Disabled** | Drafts/queues social copy |
| `0daynews.com` | seo-analyst | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Reviews search/traffic data and files SEO improvements |
| `aliencouncil.com` | planner | Anthropic CLI | CLI default (unpinned) | **Disabled** | Portfolio/site planning and backlog creation |
| `aliencouncil.com` | content-writer | Anthropic CLI | CLI default (unpinned) | Enabled, 3× weekly | Writes and publishes persona-aligned site content |
| `aliencouncil.com` | seo-analyst | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Search performance review and SEO tasking |
| `aliencouncil.com` | affiliate-ops | Anthropic CLI | CLI default (unpinned) | **Disabled** | Monthly affiliate catalog/operations work |
| `amputeenews.com` | content-writer | Anthropic CLI | `claude-sonnet-4-6` | Enabled, every 3h | Writes source-backed amputee/limb-difference news & guides in persona voice from the data-hub cache |
| `amputeenews.com` | planner | Anthropic CLI | `claude-sonnet-4-6` | Enabled, weekly (Mon) | Portfolio/site planning and backlog work |
| `amputeenews.com` | seo-analyst | Anthropic CLI | `claude-sonnet-4-6` | Enabled, weekly (Wed) | Reviews consented analytics/GSC and proposes content gaps |
| `amputeenews.com` | affiliate-editor | Anthropic CLI | `claude-sonnet-4-6` | Enabled, weekly (Wed); inactive until real Associates tag supplied | Audits active commercial links once the affiliate program is live |
| `americastrikes.com` | breaking-news | Anthropic CLI | Inherits CLI default in its gated runner | Enabled, conditional twice/hour | Checks threshold/dedup first, then invokes a writer only for a qualifying story |
| `americastrikes.com` | update/news writer | Anthropic CLI | Alias `sonnet` | Enabled, 10× daily | Runs the newsroom update pipeline: research, source-grounded writing, commit, and publish queue |
| `americastrikes.com` | weekly-editorial | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Performs weekly editorial review/long-form planning and work |
| `americastrikes.com` | planner | Anthropic CLI | CLI default (unpinned) | **Disabled** | Planning and task prioritization |
| `americastrikes.com` | seo-analyst | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Reviews GSC/analytics and improves search performance |
| `americastrikes.com` | affiliate-editor | Anthropic CLI | `claude-sonnet-4-6` | Enabled, weekly | Audits `/go/` affiliate destinations and files/fixes catalog issues without deploying directly |
| `broadwayshowgirls.com` | write-carmen, write-priya, write-imani | Anthropic CLI currently; Ollama optional | Alias `sonnet`; optional `qwen2.5:32b` | Enabled, 2× weekly per persona | Generates individual fictional-persona articles through shared validation gates |
| `broadwayshowgirls.com` | write-trio | Anthropic CLI | CLI default in outer role path | Enabled, weekly | Creates the three-person collaboration feature |
| `reviewtattoo.com` | content-writer | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Writes tattoo editorial content |
| `saveusfarms.com` | update/news writer | Anthropic CLI | Alias `haiku` | Enabled, 3× daily | Produces source-grounded farm/agriculture news updates |
| `saveusfarms.com` | planner | Anthropic CLI | No active call | **Disabled** | Planning and backlog prioritization |
| `saveusfarms.com` | seo-analyst | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Reviews search performance and creates SEO work |
| `saveusfarms.com` | affiliate-editor | Anthropic CLI | `claude-sonnet-4-6` | Enabled, weekly | Audits affiliate redirects/products |
| `shoptopless.com` | monthly-update | Anthropic CLI | CLI default (unpinned) | **Disabled** | Monthly content/catalog refresh |
| `shoptopless.com` | affiliate-editor | Anthropic CLI | `claude-sonnet-4-6` | Enabled, weekly | Large batched affiliate-link audit |
| `sinderella.org` | brief-builder | vLLM local | Llama 3.1 8B AWQ INT4 | Enabled, daily | Builds signal brief and uses local synthesis/selection functions |
| `sinderella.org` | reading-generator | vLLM local | Llama 3.1 8B AWQ INT4 | Enabled, daily | Generates daily sign readings |
| `sinderella.org` | signal-writer | vLLM local | Llama 3.1 8B AWQ INT4 | Enabled, twice daily | Generates the daily Signal content package |
| `sinderella.org` | voice-auditor | Anthropic CLI | `claude-sonnet-4-6` | Enabled, twice daily | Reviews generated content against the Sinderella persona and voice rules |
| `ultrarough.com` | planner | Anthropic CLI | CLI default (unpinned) | **Disabled** | Planning/backlog work |
| `ultrarough.com` | seo-analyst | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Search analysis and SEO task generation |
| `ultrarough.com` | content | Anthropic CLI | `claude-haiku-4-5-20251001` in role-specific branch | **Disabled** | Creates site content |
| `ultrarough.com` | affiliate-editor | Anthropic CLI | `claude-sonnet-4-6` | Enabled; differently named `.affiliate-disabled` switch also exists | Audits affiliate links; note kill-switch naming drift |
| `weapontester.com` | planner | Anthropic CLI | CLI default / role says `claude-sonnet-4-6` | **Disabled** | Planning and task prioritization |
| `weapontester.com` | seo-analyst | Anthropic CLI | CLI default / role says `claude-sonnet-4-6` | Enabled, weekly | Search performance analysis |
| `weapontester.com` | content-writer | Anthropic CLI | CLI default / role says `claude-sonnet-4-6` | **Disabled** | Creates product/editorial content |
| `xxxtea.com` | planner | Anthropic CLI | CLI default (unpinned) | **Disabled** | Planning and backlog work |
| `xxxtea.com` | seo-analyst | Anthropic CLI | CLI default (unpinned) | Enabled, weekly | Search analysis and SEO work |
| `xxxtea.com` | content-writer | Anthropic CLI | CLI default (unpinned) | **Disabled** | Writes tea/editorial content |
| `aliencouncil.com`, `0daynews.com`, `reviewtattoo.com`, `saveusfarms.com`, `shoptopless.com`, `sinderella.org`, `ultrarough.com`, `weapontester.com`, `xxxtea.com` | watchdog repair | Anthropic CLI | `claude-sonnet-4-6` by default; `WATCHDOG_MODEL` override | Enabled, incident-only | Deterministic health/incident scan first; launches a repair agent only for an eligible open incident |
| `0daynews.com`, `0xroulette.com`, `3boobs.com`, `aliencouncil.com`, `americastrikes.com`, `broadwayshowgirls.com`, `deeppenetrations.com`, `rc-9.com`, `reviewtattoo.com`, `saveusfarms.com`, `shoptopless.com`, `sinderella.org`, `totaljerks.com`, `ultrarough.com`, `weapontester.com`, `wetpages.com`, `xxxtea.com` | engineer repair/work pass | Anthropic CLI | `claude-sonnet-4-6` | Enabled except **Sinderella disabled**; work-only | Runs deterministic render/git/Cloudflare/task checks with zero tokens when healthy; invokes Claude to repair or implement queued work |
| `aliencouncil.com`, `americastrikes.com`, `broadwayshowgirls.com`, `deeppenetrations.com`, `reviewtattoo.com`, `saveusfarms.com`, `shoptopless.com`, `sinderella.org`, `ultrarough.com`, `weapontester.com`, `wetpages.com`, `xxxtea.com` | affiliate-editor | Anthropic CLI | `claude-sonnet-4-6` | Enabled weekly | Audits cloaked product links and associated affiliate content; avoids direct deployment |
| `0xroulette.com`, `3boobs.com`, `broadwayshowgirls.com`, `deeppenetrations.com`, `rc-9.com`, `reviewtattoo.com`, `shoptopless.com`, `sinderella.org`, `totaljerks.com`, `ultrarough.com`, `weapontester.com`, `wetpages.com`, `xxxtea.com` | deployer role | Anthropic CLI | `claude-haiku-4-5-20251001` | Enabled, only when deploy sentinel exists | Agent-directed build/push/smoke deployment. Other sites have replaced this with zero-AI `deploy.sh` and are intentionally not included |

## Configuration and audit risks

| Finding | Impact |
|---|---|
| Many generic roles use an empty model flag or no flag | The actual model follows the Claude CLI/account default, so cost, behavior, and reproducibility can drift without a code change. |
| Aliases `sonnet` and `haiku` are used in production | These are provider aliases, not immutable model versions. |
| Broadway Showgirls comments/defaults say local Ollama, but compose sets `BSG_LLM_BACKEND: claude-sonnet` | The effective production writer is remote Claude; `qwen2.5:32b` remains the configured local alternative and judge. |
| America Strikes local-writer comments mention GLM while compose sets `llama3.1:8b` | Documentation and runtime selection disagree; environment/compose wins. |
| Save Us Farms code falls back to GLM while compose sets `llama3.1:8b` | The deployed model differs from the source-level default. |
| UltraRough has `.affiliate-disabled`, while the scheduled role is named `affiliate-editor` | The standard inventory/status check does not associate this switch with the role; clarify whether it is intended to disable the live audit. |
| Deployer implementations vary by site | The inventory follows `run-role.sh` dispatch: direct `deploy.sh` paths are reported as no-AI, while agent-directed deployers retain their configured Claude model. |
| Sinderella has two AI layers | Its content generation is local vLLM, but the scheduled `voice-auditor` and generic maintenance roles use remote Claude. Provider reporting should preserve this distinction. |
| `fishhooklabs.com` has cron entries for `run-worker.sh update/deployer`, but no such runner exists under `ops/scripts/` | This is stale or incomplete wiring, not a currently operable AI service, so it is excluded from the live-service table. |

## Confirmed non-AI lookalikes

- RSS/news/data ingestion, image search, scoring, social posting, Slack notices,
  analytics, deploy health, and Cloudflare/GitHub tooling are ordinary API or
  deterministic workflows.
- `scrape`, `fetch-data`, image checks, vLLM watchdogs, engineer health sweeps,
  and several deployers make no model call unless a separate conditional repair
  branch is explicitly listed above.
- Mentions of AI/LLMs inside published articles, research notes, task archives,
  role documentation, and social queues are content, not application features.
