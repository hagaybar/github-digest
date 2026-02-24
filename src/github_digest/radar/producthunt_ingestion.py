"""producthunt_ingestion.py — Fetch products from Product Hunt RSS and store as RadarItems.

Uses the Product Hunt public RSS feed (https://www.producthunt.com/feed) — no
authentication required.  Extracts GitHub repo links from product URLs and
descriptions; enriches with GitHub star data using the same pipeline as
HN/Reddit/DEV.to ingestion.
"""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
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

PRODUCTHUNT_FEED_URL = "https://www.producthunt.com/feed"

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


def fetch_producthunt_feed() -> list[dict]:
    """Fetch and parse the Product Hunt RSS feed.

    Returns a list of item dicts with keys: title, link, description, pub_date.
    """
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(
                PRODUCTHUNT_FEED_URL,
                headers={"User-Agent": _USER_AGENT},
            )
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
    except Exception as e:
        logger.warning("Failed to fetch Product Hunt feed: %s", e)
        return []

    items = []
    # RSS structure: <rss><channel><item>...</item></channel></rss>
    channel = root.find("channel")
    if channel is None:
        logger.warning("Product Hunt feed has no <channel> element")
        return []

    for item_el in channel.findall("item"):
        title = (item_el.findtext("title") or "").strip()
        link = (item_el.findtext("link") or "").strip()
        description = (item_el.findtext("description") or "").strip()
        pub_date = (item_el.findtext("pubDate") or "").strip()

        if not title or not link:
            continue

        items.append({
            "title": title,
            "link": link,
            "description": description,
            "pub_date": pub_date,
        })

    logger.info("Fetched %d items from Product Hunt feed", len(items))
    return items


def feed_item_to_radar_item_data(item: dict) -> dict | None:
    """Convert a Product Hunt RSS item dict to a RadarItem data dict.

    GitHub repo extraction strategy:
    1. Try the <link> URL directly (in case it is a GitHub repo URL).
    2. Fall back to searching description text for a GitHub link.

    Returns None if the item has no usable title or URL.
    """
    link = item.get("link", "").strip()
    title = item.get("title", "").strip()
    if not link or not title:
        return None

    item_id = make_item_id("producthunt", link)

    # Try link first, then description
    github_full_name = extract_github_repo_from_url(link)
    if github_full_name is None:
        description = item.get("description") or ""
        github_full_name = extract_github_repo_from_text(description)

    published_at = None
    pub_date_str = item.get("pub_date", "")
    if pub_date_str:
        try:
            published_at = parsedate_to_datetime(pub_date_str).replace(tzinfo=UTC)
        except Exception as exc:
            logger.debug("Could not parse pubDate '%s': %s", pub_date_str, exc)

    description = item.get("description") or ""
    signals: dict = {
        "ph_tagline": description[:200],
    }

    return {
        "id": item_id,
        "source": "producthunt",
        "source_id": item_id,
        "url": link,
        "title": title,
        "published_at": published_at,
        "collected_at": datetime.now(UTC),
        "github_full_name": github_full_name,
        "signals_json": signals,
    }


def ingest_producthunt(
    db_path: Path,
    github_token: str | None = None,
) -> dict:
    """Main entry point for Product Hunt ingestion.  Returns ingestion stats.

    Fetches items from the Product Hunt RSS feed, normalises them into
    RadarItems, then enriches GitHub-linked items with live star/fork data.
    """
    engine = get_engine(db_path)

    ingested = 0
    github_linked = 0

    feed_items = fetch_producthunt_feed()

    with Session(engine) as session:
        for item in feed_items:
            try:
                item_data = feed_item_to_radar_item_data(item)
                if not item_data:
                    continue
                upsert_radar_item(session, item_data)
                ingested += 1
                if item_data.get("github_full_name"):
                    github_linked += 1
            except Exception as e:
                logger.warning(
                    "Failed to process Product Hunt item '%s': %s",
                    item.get("link"),
                    e,
                )
        session.commit()

    logger.info(
        "Ingested %d Product Hunt items (%d GitHub-linked)",
        ingested,
        github_linked,
    )

    enriched = enrich_github_signals(db_path, github_token=github_token)

    return {
        "ingested": ingested,
        "github_linked": github_linked,
        "github_enriched": enriched,
    }
