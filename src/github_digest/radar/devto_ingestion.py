"""devto_ingestion.py — Fetch articles from DEV.to and store as RadarItems.

Uses the DEV.to public API (https://dev.to/api/articles) — no authentication
required.  Targets builder-focused tags; extracts GitHub repo links from
canonical URLs and article descriptions; enriches with GitHub star data using
the same pipeline as HN/Reddit ingestion.
"""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from github_digest.db.database import get_engine
from github_digest.radar.hn_ingestion import (
    enrich_github_signals,
    extract_github_repo_from_url,
    make_item_id,
    upsert_radar_item,
)

logger = logging.getLogger(__name__)

# Tags to ingest — builder/open-source focused DEV.to communities
DEFAULT_TAGS = ["showdev", "opensource", "buildinpublic"]

DEVTO_ARTICLES_URL = "https://dev.to/api/articles"

_USER_AGENT = "github-digest/0.1"

# Regex to find the first github.com/{owner}/{repo} link in free text
_GITHUB_REPO_RE = re.compile(
    r"https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"
)


def extract_github_repo_from_text(text: str | None) -> str | None:
    """Search *text* for the first github.com/{owner}/{repo} link.

    Returns 'owner/repo' string, or None if not found.
    Reuses extract_github_repo_from_url for validation so subdirectory paths
    (e.g. github.com/owner/repo/blob/main/...) are excluded.
    """
    if not text:
        return None
    match = _GITHUB_REPO_RE.search(text)
    if not match:
        return None
    candidate = f"https://github.com/{match.group(1)}"
    return extract_github_repo_from_url(candidate)


def fetch_devto_articles(tag: str, per_page: int = 30) -> list[dict]:
    """Fetch up to *per_page* recent articles from DEV.to for a given *tag*.

    Returns a list of raw article dicts from the API response.
    """
    params = {
        "tag": tag,
        "per_page": per_page,
        "sort_by": "published_at",
        "sort_direction": "desc",
    }
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(
                DEVTO_ARTICLES_URL,
                params=params,
                headers={"User-Agent": _USER_AGENT},
            )
            resp.raise_for_status()
            articles = resp.json()
            if not isinstance(articles, list):
                logger.warning("Unexpected DEV.to response type for tag '%s': %s", tag, type(articles))
                return []
            logger.info("Fetched %d articles from DEV.to tag '%s'", len(articles), tag)
            return articles
    except Exception as e:
        logger.warning("Failed to fetch DEV.to articles for tag '%s': %s", tag, e)
        return []


def article_to_radar_item_data(article: dict) -> dict | None:
    """Convert a DEV.to article dict to a RadarItem data dict.

    GitHub repo extraction strategy:
    1. Try canonical_url (direct GitHub repo URL).
    2. Fall back to searching description text for a GitHub link.

    Returns None if the article has no usable title or URL.
    """
    article_url = article.get("url")
    title = (article.get("title") or "").strip()
    if not article_url or not title:
        return None

    item_id = make_item_id("devto", str(article["id"]))

    # Prefer canonical_url as it may point directly to a GitHub repo
    canonical_url = article.get("canonical_url") or ""
    github_full_name = extract_github_repo_from_url(canonical_url)

    # Fall back to searching the description
    if github_full_name is None:
        description = article.get("description") or ""
        github_full_name = extract_github_repo_from_text(description)

    # Lazy fallback: fetch article body to find GitHub links
    if not github_full_name:
        body = fetch_devto_article_body(article["id"])
        if body:
            match = _GITHUB_REPO_RE.search(body)
            if match:
                candidate = match.group(1).rstrip("/")
                # Validate it's a real owner/repo (not a path like owner/repo/blob/...)
                parts = candidate.split("/")
                if len(parts) == 2:
                    github_full_name = candidate

    published_at = None
    published_str = article.get("published_at")
    if published_str:
        try:
            # DEV.to returns ISO 8601 strings, e.g. "2026-02-24T10:30:00Z"
            published_at = datetime.fromisoformat(
                published_str.replace("Z", "+00:00")
            ).replace(tzinfo=UTC)
        except (ValueError, TypeError) as exc:
            logger.debug("Could not parse published_at '%s': %s", published_str, exc)

    signals: dict = {
        "devto_reactions": article.get("public_reactions_count"),
        "devto_comments": article.get("comments_count"),
        "tags": article.get("tag_list") or [],
    }

    return {
        "id": item_id,
        "source": "devto",
        "source_id": str(article["id"]),
        "url": article_url,
        "title": title,
        "published_at": published_at,
        "collected_at": datetime.now(UTC),
        "github_full_name": github_full_name,
        "signals_json": signals,
    }


def fetch_devto_article_body(article_id: int) -> str:
    """Fetch the full body_markdown for a single DEV.to article."""
    url = f"https://dev.to/api/articles/{article_id}"
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": _USER_AGENT})
            resp.raise_for_status()
            return resp.json().get("body_markdown", "") or ""
    except Exception as e:
        logger.warning("Failed to fetch article body for id=%d: %s", article_id, e)
        return ""


def ingest_devto(
    db_path: Path,
    tags: list[str] | None = None,
    per_tag: int = 30,
    github_token: str | None = None,
) -> dict:
    """Main entry point for DEV.to ingestion.  Returns ingestion stats.

    Fetches recent articles for each tag, normalises them into RadarItems,
    then enriches GitHub-linked items with live star/fork data.
    """
    if tags is None:
        tags = DEFAULT_TAGS

    engine = get_engine(db_path)

    ingested = 0
    github_linked = 0

    with Session(engine) as session:
        for tag in tags:
            articles = fetch_devto_articles(tag, per_page=per_tag)
            for article in articles:
                try:
                    item_data = article_to_radar_item_data(article)
                    if not item_data:
                        continue
                    upsert_radar_item(session, item_data)
                    ingested += 1
                    if item_data.get("github_full_name"):
                        github_linked += 1
                except Exception as e:
                    logger.warning(
                        "Failed to process DEV.to article %s: %s",
                        article.get("id"),
                        e,
                    )
        session.commit()

    logger.info(
        "Ingested %d DEV.to articles from %d tags (%d GitHub-linked)",
        ingested,
        len(tags),
        github_linked,
    )

    enriched = enrich_github_signals(db_path, github_token=github_token)

    return {
        "ingested": ingested,
        "tags": tags,
        "github_linked": github_linked,
        "github_enriched": enriched,
    }
