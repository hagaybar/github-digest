"""github_trending_ingestion.py — Fetch repos from GitHub Trending and store as RadarItems.

Scrapes https://github.com/trending for daily and weekly trending repos using
Python stdlib html.parser (no external HTML libraries required).  Enriches
each item with live star/fork data via the same enrich_github_signals pipeline
used by HN and Reddit ingestion.
"""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from github_digest.db.database import get_engine
from github_digest.radar.hn_ingestion import (
    enrich_github_signals,
    make_item_id,
    upsert_radar_item,
)

logger = logging.getLogger(__name__)

TRENDING_URL = "https://github.com/trending"

# GitHub requires a real browser UA or it redirects / returns a login page
_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"

# Strip commas from star count strings like "1,234"
_COMMA_RE = re.compile(r"[,\s]")


class _TrendingParser(HTMLParser):
    """Minimal HTML parser for GitHub Trending page.

    Extracts per-repo data from <article class="Box-row"> elements.
    Each article contains:
      - <h2><a href="/owner/repo">  — full name
      - <span itemprop="programmingLanguage">  — language (optional)
      - star count in an anchor ending with /stargazers
      - star delta in the last <span class="d-inline-block"> near the bottom
    """

    def __init__(self) -> None:
        super().__init__()
        self._repos: list[dict] = []

        # Per-article state
        self._in_article = False
        self._article_depth = 0

        # h2/a href capture
        self._in_h2 = False
        self._h2_depth = 0
        self._capture_h2_a = False
        self._h2_href: str | None = None

        # language span
        self._in_lang_span = False
        self._lang_text: str | None = None

        # stargazers anchor
        self._in_star_a = False
        self._star_text_parts: list[str] = []

        # stars-today / stars-this-week: last d-inline-block span
        self._in_delta_span = False
        self._delta_depth = 0
        self._delta_text_parts: list[str] = []
        self._last_delta: str | None = None

        # depth tracking
        self._global_depth = 0

    # ------------------------------------------------------------------
    # HTMLParser interface
    # ------------------------------------------------------------------

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._global_depth += 1
        attr = dict(attrs)
        classes = (attr.get("class") or "").split()

        if tag == "article" and "Box-row" in classes:
            self._start_article()
            return

        if not self._in_article:
            return

        self._article_depth += 1

        if tag == "h2" and not self._in_h2:
            self._in_h2 = True
            self._h2_depth = self._global_depth
            return

        if self._in_h2 and tag == "a":
            href = attr.get("href") or ""
            # owner/repo href looks like "/owner/repo" — exactly 2 path segments
            parts = [p for p in href.split("/") if p]
            if len(parts) == 2:
                self._h2_href = "/".join(parts)
                self._capture_h2_a = True
            return

        if tag == "span" and attr.get("itemprop") == "programmingLanguage":
            self._in_lang_span = True
            return

        if tag == "a" and (attr.get("href") or "").endswith("/stargazers"):
            self._in_star_a = True
            self._star_text_parts = []
            return

        if tag == "span" and "d-inline-block" in classes:
            # Track nested depth so we collect all text within this span
            self._in_delta_span = True
            self._delta_depth = self._global_depth
            self._delta_text_parts = []
            return

    def handle_endtag(self, tag: str) -> None:
        if tag == "article" and self._in_article:
            self._end_article()
            self._global_depth -= 1
            return

        if self._in_article:
            self._article_depth -= 1

        if tag == "h2" and self._in_h2 and self._global_depth == self._h2_depth:
            self._in_h2 = False
            self._capture_h2_a = False

        if tag == "a" and self._in_star_a:
            self._in_star_a = False

        if tag == "span" and self._in_lang_span:
            self._in_lang_span = False

        if tag == "span" and self._in_delta_span and self._global_depth == self._delta_depth:
            text = " ".join(self._delta_text_parts).strip()
            if text:
                self._last_delta = text
            self._in_delta_span = False
            self._delta_text_parts = []

        self._global_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._in_article:
            return

        if self._in_lang_span:
            self._lang_text = data.strip() or self._lang_text
            return

        if self._in_star_a:
            self._star_text_parts.append(data)
            return

        if self._in_delta_span:
            self._delta_text_parts.append(data)
            return

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _start_article(self) -> None:
        self._in_article = True
        self._article_depth = 0
        self._in_h2 = False
        self._capture_h2_a = False
        self._h2_href = None
        self._in_lang_span = False
        self._lang_text = None
        self._in_star_a = False
        self._star_text_parts = []
        self._in_delta_span = False
        self._delta_text_parts = []
        self._last_delta = None

    def _end_article(self) -> None:
        self._in_article = False
        full_name = self._h2_href
        if not full_name:
            return

        # Parse star count
        star_raw = _COMMA_RE.sub("", "".join(self._star_text_parts)).strip()
        try:
            stars_total = int(star_raw)
        except (ValueError, TypeError):
            stars_total = 0

        # Parse star delta from the last d-inline-block span text
        delta_text = self._last_delta or ""
        delta = _parse_star_delta(delta_text)

        self._repos.append({
            "github_full_name": full_name,
            "language": self._lang_text,
            "stars_total": stars_total,
            "star_delta": delta,
            "delta_text": delta_text,
        })

    @property
    def repos(self) -> list[dict]:
        return self._repos


def _parse_star_delta(text: str) -> int:
    """Extract integer star count from strings like '1,234 stars today'."""
    # Remove commas and pull the first run of digits
    cleaned = _COMMA_RE.sub("", text)
    match = re.search(r"(\d+)", cleaned)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            pass
    return 0


def fetch_trending_page(since: str) -> list[dict]:
    """Fetch and parse one GitHub Trending page.

    Args:
        since: "daily" or "weekly"

    Returns:
        List of repo dicts with keys: github_full_name, language,
        stars_total, star_delta, delta_text.
    """
    url = f"{TRENDING_URL}?since={since}"
    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": _USER_AGENT})
            resp.raise_for_status()
            html = resp.text
    except Exception as exc:
        logger.warning("Failed to fetch GitHub Trending (%s): %s", since, exc)
        return []

    parser = _TrendingParser()
    try:
        parser.feed(html)
    except Exception as exc:
        logger.warning("Failed to parse GitHub Trending HTML (%s): %s", since, exc)
        return []

    repos = parser.repos
    logger.info("Parsed %d repos from GitHub Trending (%s)", len(repos), since)
    return repos


def trending_repos_to_radar_items(
    daily_repos: list[dict],
    weekly_repos: list[dict],
) -> list[dict]:
    """Merge daily + weekly trending repos into RadarItem data dicts.

    Daily takes precedence over weekly when the same repo appears in both.
    Returns list of item dicts ready for upsert_radar_item().
    """
    # Build combined map: full_name -> (repo_dict, period)
    # Process weekly first so daily overwrites on collision
    combined: dict[str, tuple[dict, str]] = {}
    for repo in weekly_repos:
        combined[repo["github_full_name"]] = (repo, "weekly")
    for repo in daily_repos:
        combined[repo["github_full_name"]] = (repo, "daily")

    now = datetime.now(UTC)
    items: list[dict] = []
    for full_name, (repo, period) in combined.items():
        item_id = make_item_id("github_trending", full_name)
        signals: dict = {
            "github_trending_delta": repo["star_delta"],
            "trending_period": period,
        }
        if repo["stars_total"]:
            signals["github_stars_total"] = repo["stars_total"]
        if repo["language"]:
            signals["github_language"] = repo["language"]

        items.append({
            "id": item_id,
            "source": "github_trending",
            "source_id": full_name,
            "url": f"https://github.com/{full_name}",
            "title": full_name,
            "published_at": None,
            "collected_at": now,
            "github_full_name": full_name,
            "signals_json": signals,
        })

    return items


def ingest_github_trending(
    db_path: Path,
    github_token: str | None = None,
) -> dict:
    """Main entry point for GitHub Trending ingestion.  Returns ingestion stats.

    Fetches daily and weekly trending pages, deduplicates by full_name (daily
    wins), upserts RadarItems, then enriches with live GitHub API data.
    """
    daily_repos = fetch_trending_page("daily")
    weekly_repos = fetch_trending_page("weekly")

    items = trending_repos_to_radar_items(daily_repos, weekly_repos)

    # Count how many came from each period (after dedup)
    daily_names = {r["github_full_name"] for r in daily_repos}
    weekly_names = {r["github_full_name"] for r in weekly_repos}
    only_weekly = weekly_names - daily_names

    n_daily = sum(1 for it in items if it["source_id"] not in only_weekly)
    n_weekly = sum(1 for it in items if it["source_id"] in only_weekly)

    engine = get_engine(db_path)
    ingested = 0
    with Session(engine) as session:
        for item_data in items:
            try:
                upsert_radar_item(session, item_data)
                ingested += 1
            except Exception as exc:
                logger.warning(
                    "Failed to upsert GitHub Trending item %s: %s",
                    item_data.get("source_id"),
                    exc,
                )
        session.commit()

    logger.info(
        "Ingested %d GitHub Trending repos (daily=%d, weekly=%d unique)",
        ingested,
        n_daily,
        n_weekly,
    )

    github_enriched = enrich_github_signals(db_path, github_token=github_token)

    return {
        "ingested": ingested,
        "daily": n_daily,
        "weekly": n_weekly,
        "github_enriched": github_enriched,
    }
