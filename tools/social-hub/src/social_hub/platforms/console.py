"""`console` — a real adapter that publishes to a local JSONL file.

This is not a test double. It is a first-class channel a site can enable in
production to exercise the whole pipeline — ingest, AI drafting, approval,
scheduling, publishing, and the site-side post-log mirror — with zero external
API risk. New sites onboard on `console` first, then flip to a live platform
once the copy in the queue reads right.

It also answers "did the scheduler actually fire?" without needing to trust a
remote API, which made it the fastest way to validate the americastrikes and
0daynews wiring end to end.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from social_hub.platforms.base import (
    Adapter,
    Capabilities,
    Mention,
    Outgoing,
    PostRef,
)


def _outbox() -> Path:
    default = Path(__file__).resolve().parents[3] / "data" / "console-outbox.jsonl"
    return Path(os.environ.get("SOCIAL_HUB_CONSOLE_OUTBOX", str(default)))


class ConsoleAdapter(Adapter):
    name = "console"
    caps = Capabilities(publish=True, reply=True, mentions=True, media=True, max_chars=1000)
    required_creds = ()

    def _verify(self) -> dict:
        return {"handle": "console"}

    def _write(self, out: Outgoing, kind: str) -> PostRef:
        path = _outbox()
        path.parent.mkdir(parents=True, exist_ok=True)
        rid = uuid.uuid4().hex[:12]
        record = {
            "id": rid,
            "kind": kind,
            "text": self.fit(out.body, out.link),
            "link": out.link,
            "title": out.title,
            "reply_to": out.reply_to_remote_id,
            "options": out.options,
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        return PostRef(remote_id=rid, url=f"console://post/{rid}")

    def publish(self, out: Outgoing) -> PostRef:
        return self._write(out, "post")

    def reply(self, out: Outgoing) -> PostRef:
        return self._write(out, "reply")

    def fetch_mentions(self, limit: int = 25, since: str | None = None) -> list[Mention]:
        """Reads an optional local inbox file so reply flows can be exercised
        offline: drop JSON lines into SOCIAL_HUB_CONSOLE_INBOX and they show up
        in the hub inbox like real mentions."""
        path = Path(
            os.environ.get(
                "SOCIAL_HUB_CONSOLE_INBOX", str(_outbox().with_name("console-inbox.jsonl"))
            )
        )
        if not path.exists():
            return []
        out: list[Mention] = []
        for line in path.read_text(encoding="utf-8").splitlines()[-limit:]:
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except ValueError:
                continue
            created = item.get("at", "")
            if since and created and created <= since:
                continue
            out.append(
                Mention(
                    remote_id=str(item.get("id") or uuid.uuid4().hex[:12]),
                    text=item.get("text", ""),
                    author=item.get("author", "someone"),
                    author_handle=item.get("handle", "someone"),
                    url=item.get("url", ""),
                    parent_remote_id=str(item.get("id") or ""),
                    created_at=created,
                    kind=item.get("kind", "mention"),
                )
            )
        return out
