from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from github_digest.config import settings

logger = logging.getLogger(__name__)


@dataclass
class GitHubClient:
    token: str | None = None
    user_agent: str = settings.user_agent
    throttle_seconds: float = settings.throttle_seconds
    timeout_seconds: float = 10.0
    base_url: str = "https://api.github.com"
    client: httpx.Client | None = None

    def __post_init__(self) -> None:
        if self.client is None:
            self.client = httpx.Client(timeout=self.timeout_seconds)

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": self.user_agent,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def build_search_params(self, query: str, per_page: int) -> dict[str, Any]:
        return {
            "q": query,
            "sort": "stars",
            "order": "desc",
            "per_page": per_page,
            "page": 1,
        }

    def search_repositories(self, query: str, per_page: int = 10) -> dict[str, Any]:
        url = f"{self.base_url}/search/repositories"
        params = self.build_search_params(query, per_page)
        return self._request_json("GET", url, params=params)

    def get_repo(self, full_name: str) -> dict[str, Any]:
        """Fetch repository metadata (stars, forks, description, language)."""
        url = f"{self.base_url}/repos/{full_name}"
        return self._request_json("GET", url)

    def _request_json(self, method: str, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        retries = 3
        backoff = 1.0
        for attempt in range(1, retries + 1):
            try:
                response = self.client.request(method, url, headers=self._headers(), params=params)
                self._log_rate_limit(response)
                response.raise_for_status()
                if self.throttle_seconds > 0:
                    time.sleep(self.throttle_seconds)
                return response.json()
            except httpx.HTTPError as exc:
                if attempt == retries:
                    raise
                logger.warning("GitHub request failed (attempt %s/%s): %s", attempt, retries, exc)
                time.sleep(backoff)
                backoff *= 2
        return {}

    @staticmethod
    def _log_rate_limit(response: httpx.Response) -> None:
        remaining = response.headers.get("x-ratelimit-remaining")
        reset = response.headers.get("x-ratelimit-reset")
        if remaining is not None:
            logger.info("GitHub rate limit remaining: %s", remaining)
        if reset is not None:
            logger.info("GitHub rate limit reset: %s", reset)
