from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx
from sqlalchemy.orm import Session

from github_digest.db.database import get_engine
from github_digest.db.models import HNStoryRaw

logger = logging.getLogger(__name__)

HN_TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json"
HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item/{}.json"

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source"
}


def extract_github_repo_from_url(url: str | None) -> str | None:
    """Extract 'owner/repo' from a GitHub URL, or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        if parsed.netloc not in ("github.com", "www.github.com"):
            return None
        # Path should be /owner/repo or /owner/repo/ or /owner/repo.git
        path = parsed.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        parts = [p for p in path.split("/") if p]
        if len(parts) != 2:  # Must be exactly owner/repo, no subdirectories
            return None
        return f"{parts[0]}/{parts[1]}"
    except Exception:
        return None


def normalize_url(url: str) -> str:
    """Strip tracking params, lowercase scheme+host."""
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        filtered = {k: v for k, v in params.items() if k.lower() not in TRACKING_PARAMS}
        # Rebuild query string
        new_query = urlencode({k: v[0] for k, v in filtered.items()}, doseq=False)
        normalized = urlunparse((
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path,
            parsed.params,
            new_query,
            "",  # no fragment
        ))
        return normalized
    except Exception:
        return url


def make_item_id(source: str, source_id: str) -> str:
    return hashlib.sha1(f"{source}:{source_id}".encode()).hexdigest()


def fetch_hn_top_stories(limit: int = 100) -> list[dict]:
    """Fetch top HN stories. Returns list of raw story dicts."""
    stories = []
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        resp = client.get(HN_TOP_STORIES_URL)
        resp.raise_for_status()
        story_ids = resp.json()[:limit]
        logger.info("Fetching %d HN stories", len(story_ids))
        for sid in story_ids:
            try:
                r = client.get(HN_ITEM_URL.format(sid))
                r.raise_for_status()
                data = r.json()
                if data and not data.get("deleted") and not data.get("dead"):
                    stories.append(data)
            except Exception as e:
                logger.debug("Failed to fetch HN story %s: %s", sid, e)
    logger.info("Fetched %d valid HN stories", len(stories))
    return stories


def upsert_hn_story_raw(session: Session, story_dict: dict) -> HNStoryRaw:
    """Upsert HNStoryRaw record. Returns the record."""
    hn_id = str(story_dict["id"])
    existing = session.get(HNStoryRaw, hn_id)
    now = datetime.now(UTC)
    if existing:
        existing.score = story_dict.get("score")
        existing.comments = story_dict.get("descendants")
        existing.collected_at = now
        existing.raw_json = story_dict
        return existing
    record = HNStoryRaw(
        hn_id=hn_id,
        title=story_dict.get("title", ""),
        url=story_dict.get("url"),
        by=story_dict.get("by"),
        score=story_dict.get("score"),
        comments=story_dict.get("descendants"),
        time=story_dict.get("time"),
        raw_json=story_dict,
        collected_at=now,
    )
    session.add(record)
    return record


def story_to_radar_item_data(story: HNStoryRaw) -> dict | None:
    """Convert HNStoryRaw to a RadarItem dict. Returns None if no title."""
    if not story.title:
        return None
    item_id = make_item_id("hackernews", story.hn_id)
    url = story.url or f"https://news.ycombinator.com/item?id={story.hn_id}"
    published_at = None
    if story.time:
        published_at = datetime.utcfromtimestamp(story.time).replace(tzinfo=UTC)
    github_full_name = extract_github_repo_from_url(story.url)
    signals = {
        "hn_points": story.score,
        "hn_comments": story.comments,
    }
    return {
        "id": item_id,
        "source": "hackernews",
        "source_id": story.hn_id,
        "url": url,
        "title": story.title,
        "published_at": published_at,
        "collected_at": datetime.now(UTC),
        "github_full_name": github_full_name,
        "signals_json": signals,
    }


def upsert_radar_item(session: Session, item_data: dict) -> None:
    """Upsert a RadarItem. On conflict, update signals and github_full_name."""
    from sqlalchemy import text
    # Use SQLite INSERT OR IGNORE + UPDATE pattern
    session.execute(
        text("""
            INSERT OR IGNORE INTO radar_items
              (id, source, source_id, url, title,
               published_at, collected_at, github_full_name, signals_json)
            VALUES
              (:id, :source, :source_id, :url, :title,
               :published_at, :collected_at, :github_full_name, :signals_json)
        """),
        {
            "id": item_data["id"],
            "source": item_data["source"],
            "source_id": item_data["source_id"],
            "url": item_data["url"],
            "title": item_data["title"],
            "published_at": (
                item_data["published_at"].isoformat() if item_data["published_at"] else None
            ),
            "collected_at": item_data["collected_at"].isoformat(),
            "github_full_name": item_data.get("github_full_name"),
            "signals_json": __import__("json").dumps(item_data.get("signals_json", {})),
        }
    )
    # Update signals (merge latest HN data)
    session.execute(
        text("""
            UPDATE radar_items SET
              signals_json = :signals_json,
              github_full_name = COALESCE(:github_full_name, github_full_name),
              collected_at = :collected_at
            WHERE id = :id
        """),
        {
            "id": item_data["id"],
            "signals_json": __import__("json").dumps(item_data.get("signals_json", {})),
            "github_full_name": item_data.get("github_full_name"),
            "collected_at": item_data["collected_at"].isoformat(),
        }
    )


def ingest_hn(db_path: Path, limit: int = 100) -> dict:
    """Main entry point for HN ingestion. Returns ingestion stats."""
    from sqlalchemy.orm import Session

    engine = get_engine(db_path)
    stories = fetch_hn_top_stories(limit=limit)

    ingested = 0
    github_linked = 0

    with Session(engine) as session:
        for story_dict in stories:
            try:
                story = upsert_hn_story_raw(session, story_dict)
                session.flush()
                item_data = story_to_radar_item_data(story)
                if item_data:
                    upsert_radar_item(session, item_data)
                    ingested += 1
                    if item_data.get("github_full_name"):
                        github_linked += 1
            except Exception as e:
                logger.warning("Failed to process HN story %s: %s", story_dict.get("id"), e)
        session.commit()

    logger.info("Ingested %d HN stories, %d linked to GitHub repos", ingested, github_linked)
    return {"ingested": ingested, "github_linked": github_linked}
