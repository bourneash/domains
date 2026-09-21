# Executive handoffs

This directory contains the compact, Git-visible handoff records used by the
CEO, CTO, CFO, CRO, and domain managers when they run on different hosts.

Handoffs contain decisions, proposals, summaries, and links/IDs—not provider
transcripts, credentials, raw analytics exports, or runtime queue state. The
control plane writes them atomically. Hosts should commit and push this
directory so the next role can receive the latest context after pulling.
