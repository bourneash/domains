# tools/social-poster/src/social_poster/adapters/base.py
from __future__ import annotations
from abc import ABC, abstractmethod
from social_poster.content_loader import Article


class AbstractAdapter(ABC):
    name: str

    @abstractmethod
    def post(self, article: Article, creds: dict) -> str:
        """Post article to platform. Returns post URL or ID string."""
