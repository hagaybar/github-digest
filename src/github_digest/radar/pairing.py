from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

from github_digest.db.database import get_engine

logger = logging.getLogger(__name__)


# Complementary tag pairs: (tag_a, tag_b, project_hint)
COMPLEMENTARY_PAIRS = [
    ("crawler", "db", "data collection pipeline"),
    ("crawler", "index", "search index builder"),
    ("agents", "devtools", "agent development toolkit"),
    ("agents", "eval", "agent evaluation harness"),
    ("agents", "ui", "agent interface builder"),
    ("model", "ui", "AI-powered app"),
    ("model", "api", "AI API wrapper"),
    ("infra", "agents", "self-hosted AI system"),
    ("data", "web", "data visualization app"),
    ("data", "api", "data API service"),
    ("security", "devtools", "security toolchain"),
    ("cli", "web", "CLI + web dashboard"),
    ("llm", "data", "LLM data pipeline"),
    ("llm", "eval", "LLM evaluation suite"),
    ("search", "ui", "search interface"),
]


def get_item_keywords(item_dict: dict) -> list[str]:
    """Extract keyword tags from item's title and tags_json."""
    keywords = []

    # From tags_json
    tags = item_dict.get("tags_json") or {}
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except Exception:
            tags = {}
    if isinstance(tags, dict):
        keywords.extend([d.lower() for d in tags.get("domains", [])])
        keywords.extend([lang.lower() for lang in tags.get("languages", [])])

    # From title keywords
    title = item_dict.get("title", "").lower()
    title_words = [w.strip(".,!?()[]{}") for w in title.split() if len(w) > 3]
    keywords.extend(title_words)

    return list(set(keywords))


def items_are_complementary(item_a: dict, item_b: dict) -> tuple[bool, str]:
    """Check if two items are complementary. Returns (is_complementary, rationale)."""
    # Same GitHub repo = not complementary
    gfn_a = item_a.get("github_full_name")
    gfn_b = item_b.get("github_full_name")
    if gfn_a and gfn_b and gfn_a == gfn_b:
        return False, ""

    tags_a = set(get_item_keywords(item_a))
    tags_b = set(get_item_keywords(item_b))

    # Check too similar: >3 shared tags and both have similar structure
    shared = tags_a & tags_b
    if len(shared) > 3:
        return False, ""

    # Check complementary pairs
    for tag_a, tag_b, hint in COMPLEMENTARY_PAIRS:
        has_a_in_a = any(tag_a in kw for kw in tags_a)
        has_b_in_b = any(tag_b in kw for kw in tags_b)
        has_a_in_b = any(tag_a in kw for kw in tags_b)
        has_b_in_a = any(tag_b in kw for kw in tags_a)

        if has_a_in_a and has_b_in_b:
            title_a = item_a.get("title", "")[:40]
            title_b = item_b.get("title", "")[:40]
            rationale = f"Combine {title_a} ({tag_a}) + {title_b} ({tag_b}) to build a {hint}"
            return True, rationale
        elif has_a_in_b and has_b_in_a:
            title_a = item_a.get("title", "")[:40]
            title_b = item_b.get("title", "")[:40]
            rationale = f"Combine {title_b} ({tag_a}) + {title_a} ({tag_b}) to build a {hint}"
            return True, rationale

    # Fallback: HN item + GitHub item pairing (cross-signal)
    if item_a.get("source") != item_b.get("source") and (
        item_a.get("github_full_name") or item_b.get("github_full_name")
    ):
        title_a = item_a.get("title", "")[:30]
        title_b = item_b.get("title", "")[:30]
        rationale = f"Cross-pollinate: {title_a} idea + {title_b} implementation"
        return True, rationale

    return False, ""


def generate_pairings(items: list[dict]) -> list[dict]:
    """Generate complementary pairings from a list of item dicts."""
    pairings = []

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            is_comp, rationale = items_are_complementary(items[i], items[j])
            if is_comp:
                pairings.append({
                    "item_id_a": items[i]["id"],
                    "item_id_b": items[j]["id"],
                    "rationale": rationale,
                })

    # Sort by rationale length (longer = more specific)
    pairings.sort(key=lambda x: len(x["rationale"]), reverse=True)

    return pairings[:15]  # Top 15 pairings


def pair_daily(db_path: Path, date_str: str | None = None) -> dict:
    """Generate and persist daily pairings. Returns stats dict."""
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    engine = get_engine(db_path)

    with Session(engine) as session:
        # Get daily pick items
        rows = session.execute(
            text("""
                SELECT ri.id, ri.source, ri.source_id, ri.url, ri.title,
                       ri.github_full_name, ri.signals_json, ri.tags_json
                FROM daily_picks dp
                JOIN radar_items ri ON dp.item_id = ri.id
                WHERE dp.date = :date
                ORDER BY dp.rank ASC
            """),
            {"date": date_str},
        ).fetchall()

        if not rows:
            logger.warning("No daily picks found for %s", date_str)
            return {"pairings": 0, "date": date_str}

        items = [
            {
                "id": row[0], "source": row[1], "source_id": row[2],
                "url": row[3], "title": row[4],
                "github_full_name": row[5],
                "signals_json": row[6],
                "tags_json": row[7],
            }
            for row in rows
        ]

        pairings = generate_pairings(items)

        # Delete existing pairings for date, then insert
        session.execute(text("DELETE FROM daily_pairings WHERE date = :date"), {"date": date_str})

        for rank, pairing in enumerate(pairings, start=1):
            session.execute(
                text("""
                    INSERT INTO daily_pairings
                      (date, rank, item_id_a, item_id_b, rationale, created_at)
                    VALUES (:date, :rank, :item_id_a, :item_id_b, :rationale, :created_at)
                """),
                {
                    "date": date_str,
                    "rank": rank,
                    "item_id_a": pairing["item_id_a"],
                    "item_id_b": pairing["item_id_b"],
                    "rationale": pairing["rationale"],
                    "created_at": datetime.now(UTC).isoformat(),
                },
            )

        session.commit()

    logger.info("Generated %d pairings for %s", len(pairings), date_str)
    return {"pairings": len(pairings), "date": date_str}
