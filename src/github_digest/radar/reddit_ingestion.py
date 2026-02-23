"""reddit_ingestion.py — Fetch posts from curated subreddits and store as RadarItems.

Uses Reddit's unauthenticated public JSON API (no credentials required).
Targets builder-focused subreddits; extracts GitHub links; enriches with
GitHub star data using the same pipeline as HN ingestion.
"""
from __future__ import annotations

import logging
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

# Subreddits to ingest — ordered by relevance to "builder discovers cool tools"
DEFAULT_SUBREDDITS = [
    "SideProject",          # builders sharing what they built, lots of GitHub links
    "coolgithubprojects",   # GitHub projects explicitly
    "MachineLearning",      # AI/ML tools and papers with code
]

REDDIT_JSON_URL = "https://www.reddit.com/r/{subreddit}/{sort}.json"

# Reddit requires a descriptive User-Agent to avoid 429s on unauthenticated requests
_USER_AGENT = "github-digest/0.1 (open source digest tool)"


def fetch_reddit_posts(
    subreddit: str,
    limit: int = 25,
    sort: str = "new",
) -> list[dict]:
    """Fetch up to *limit* posts from a subreddit using the public JSON API.

    Only link posts (not self-text posts) are returned, since we need a URL
    to extract a GitHub repo from.
    """
    url = REDDIT_JSON_URL.format(subreddit=subreddit, sort=sort)
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(
                url,
                params={"limit": limit, "raw_json": 1},
                headers={"User-Agent": _USER_AGENT},
            )
            resp.raise_for_status()
            children = resp.json().get("data", {}).get("children", [])
            posts = [
                c["data"]
                for c in children
                if c.get("kind") == "t3" and c.get("data")
                and not c["data"].get("is_self")   # link posts only
                and not c["data"].get("removed_by_category")
            ]
            logger.info("Fetched %d link posts from r/%s", len(posts), subreddit)
            return posts
    except Exception as e:
        logger.warning("Failed to fetch r/%s: %s", subreddit, e)
        return []


def post_to_radar_item_data(post: dict, subreddit: str) -> dict | None:
    """Convert a Reddit post dict to a RadarItem data dict.

    Returns None if the post has no usable URL or title.
    """
    url = post.get("url")
    title = post.get("title", "").strip()
    if not url or not title:
        return None

    item_id = make_item_id("reddit", post["id"])
    github_full_name = extract_github_repo_from_url(url)
    published_at = None
    created = post.get("created_utc")
    if created:
        published_at = datetime.utcfromtimestamp(float(created)).replace(tzinfo=UTC)

    signals: dict = {
        "reddit_score": post.get("score"),
        "reddit_comments": post.get("num_comments"),
        "subreddit": subreddit,
    }

    return {
        "id": item_id,
        "source": "reddit",
        "source_id": post["id"],
        "url": url,
        "title": title,
        "published_at": published_at,
        "collected_at": datetime.now(UTC),
        "github_full_name": github_full_name,
        "signals_json": signals,
    }


def ingest_reddit(
    db_path: Path,
    subreddits: list[str] | None = None,
    limit_per_sub: int = 25,
    github_token: str | None = None,
) -> dict:
    """Main entry point for Reddit ingestion. Returns ingestion stats.

    Fetches link posts from each subreddit, normalises them into RadarItems,
    then enriches GitHub-linked items with live star/fork data.
    """
    if subreddits is None:
        subreddits = DEFAULT_SUBREDDITS

    engine = get_engine(db_path)

    ingested = 0
    github_linked = 0

    with Session(engine) as session:
        for sub in subreddits:
            posts = fetch_reddit_posts(sub, limit=limit_per_sub, sort="new")
            for post in posts:
                try:
                    item_data = post_to_radar_item_data(post, sub)
                    if not item_data:
                        continue
                    upsert_radar_item(session, item_data)
                    ingested += 1
                    if item_data.get("github_full_name"):
                        github_linked += 1
                except Exception as e:
                    logger.warning("Failed to process Reddit post %s: %s", post.get("id"), e)
        session.commit()

    logger.info(
        "Ingested %d Reddit posts from %d subreddits (%d GitHub-linked)",
        ingested, len(subreddits), github_linked,
    )

    enriched = enrich_github_signals(db_path, github_token=github_token)

    return {
        "ingested": ingested,
        "subreddits": subreddits,
        "github_linked": github_linked,
        "github_enriched": enriched,
    }
