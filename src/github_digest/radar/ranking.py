from __future__ import annotations

import json
import logging
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml
from sqlalchemy import text
from sqlalchemy.orm import Session

from github_digest.db.database import get_engine
from github_digest.db.models import RadarItem
from github_digest.radar.hn_ingestion import normalize_url

logger = logging.getLogger(__name__)


def load_radar_config(config_path: Path) -> dict:
    """Load and parse radar_config.yaml."""
    with open(config_path) as f:
        return yaml.safe_load(f)


def get_signals(item: RadarItem) -> dict:
    """Safely get signals dict from item."""
    if isinstance(item.signals_json, dict):
        return item.signals_json
    if isinstance(item.signals_json, str):
        try:
            return json.loads(item.signals_json)
        except Exception:
            return {}
    return {}


def deduplicate_items(items: list[RadarItem]) -> list[RadarItem]:
    """
    Deduplicate by:
    1. Same github_full_name (if present)
    2. Same normalized URL
    3. Same source + source_id
    When merging, keep item with highest hn_points, prefer github_full_name.
    """
    seen_github: dict[str, RadarItem] = {}
    seen_url: dict[str, RadarItem] = {}
    seen_source: dict[tuple, RadarItem] = {}
    result: list[RadarItem] = []

    def merge_signals(keep: RadarItem, discard: RadarItem) -> None:
        ks = get_signals(keep)
        ds = get_signals(discard)
        # Max HN points/comments
        if ds.get("hn_points") and (not ks.get("hn_points") or ds["hn_points"] > ks["hn_points"]):
            ks["hn_points"] = ds["hn_points"]
        if ds.get("hn_comments") and (
            not ks.get("hn_comments") or ds["hn_comments"] > ks["hn_comments"]
        ):
            ks["hn_comments"] = ds["hn_comments"]
        # Prefer github_full_name
        if not keep.github_full_name and discard.github_full_name:
            keep.github_full_name = discard.github_full_name
        keep.signals_json = ks

    for item in items:
        merged = False

        # Check by github_full_name
        if item.github_full_name:
            existing = seen_github.get(item.github_full_name)
            if existing:
                merge_signals(existing, item)
                merged = True
            else:
                seen_github[item.github_full_name] = item

        # Check by normalized URL
        if not merged:
            norm_url = normalize_url(item.url)
            existing = seen_url.get(norm_url)
            if existing:
                merge_signals(existing, item)
                merged = True
            else:
                seen_url[norm_url] = item

        # Check by source+source_id
        if not merged:
            key = (item.source, item.source_id)
            existing = seen_source.get(key)
            if existing:
                merge_signals(existing, item)
                merged = True
            else:
                seen_source[key] = item

        if not merged:
            result.append(item)

    return result


def compute_momentum_score(item: RadarItem) -> float:
    """Compute momentum score from HN points and GitHub velocity."""
    signals = get_signals(item)
    momentum = 0.0
    hn_points = signals.get("hn_points") or 0
    if hn_points > 0:
        momentum += math.log(max(1, hn_points)) / math.log(1000)
    velocity = signals.get("github_velocity") or 0
    if velocity > 0:
        momentum += min(1.0, velocity / 100)
    return min(1.0, max(0.0, momentum))


def compute_cool_score(item: RadarItem) -> float:
    """Cool score: 0.5 baseline, +0.1 if has tags, +0.2 if Show HN."""
    score = 0.5
    tags = item.tags_json
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except Exception:
            tags = {}
    if isinstance(tags, dict) and (tags.get("domains") or tags.get("languages")):
        score += 0.1
    signals = get_signals(item)
    if signals.get("is_show_hn"):
        score += 0.2
    return min(1.0, max(0.0, score))


def compute_buildability_score(item: RadarItem) -> float:
    """Compute buildability based on GitHub metadata presence and star count."""
    score = 0.0
    signals = get_signals(item)
    if item.github_full_name:
        score = 0.5
        if item.title and len(item.title) > 20:
            score += 0.1
        stars = signals.get("github_stars_total") or 0
        if stars > 0:
            # Log-scale: 100 stars → ~0.07, 1k → ~0.10, 10k → ~0.14, 50k → ~0.16
            score += 0.2 * min(1.0, math.log(max(1, stars)) / math.log(50000))
    else:
        # Non-GitHub items: partial score based on URL quality
        score = 0.2
    if signals.get("hn_points", 0) and signals["hn_points"] > 10:
        score += 0.1
    return min(1.0, max(0.0, score))


def score_item(item: RadarItem, weights: dict) -> dict:
    """Compute all scores and return scores dict."""
    w_momentum = weights.get("momentum", 0.5)
    w_cool = weights.get("cool", 0.3)
    w_buildability = weights.get("buildability", 0.2)

    momentum = compute_momentum_score(item)
    cool = compute_cool_score(item)
    buildability = compute_buildability_score(item)
    final = w_momentum * momentum + w_cool * cool + w_buildability * buildability

    return {
        "momentum_score": round(momentum, 4),
        "cool_score": round(cool, 4),
        "buildability_score": round(buildability, 4),
        "final_score": round(final, 4),
        "score_version": "v1",
    }


def rank_candidates(
    db_path: Path,
    config_path: Path,
    date_str: str | None = None,
) -> dict:
    """
    Score all recent radar items, select top N for the day.
    Returns ranking stats dict.
    """
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    config = load_radar_config(config_path)
    weights = config.get("scoring", {}).get("weights", {})
    ranking_cfg = config.get("ranking", {})
    top_k = ranking_cfg.get("top_k_for_llm", 30)
    daily_count = ranking_cfg.get("daily_picks_count", 7)
    window_hours = ranking_cfg.get("candidate_window_hours", 48)

    engine = get_engine(db_path)

    with Session(engine) as session:
        # Query recent items
        cutoff = datetime.now(UTC) - timedelta(hours=window_hours)
        rows = session.execute(
            text("""
                SELECT id, source, source_id, url, title, published_at, collected_at,
                       github_full_name, signals_json, tags_json, scores_json
                FROM radar_items
                WHERE collected_at >= :cutoff
            """),
            {"cutoff": cutoff.isoformat()},
        ).fetchall()

        # Build RadarItem-like objects (use namedtuple approach)
        items = []
        for row in rows:
            item = RadarItem(
                id=row[0], source=row[1], source_id=row[2],
                url=row[3], title=row[4],
                published_at=None, collected_at=datetime.now(UTC),
                github_full_name=row[7],
                signals_json=json.loads(row[8]) if isinstance(row[8], str) else row[8],
                tags_json=json.loads(row[9]) if isinstance(row[9], str) and row[9] else None,
                scores_json=None,
            )
            items.append(item)

        logger.info("Found %d candidate items in window", len(items))

        # Deduplicate
        items = deduplicate_items(items)
        logger.info("%d items after deduplication", len(items))

        # Score each item and update DB
        scored = []
        for item in items:
            scores = score_item(item, weights)
            scored.append((item, scores))
            session.execute(
                text("UPDATE radar_items SET scores_json = :scores WHERE id = :id"),
                {"id": item.id, "scores": json.dumps(scores)},
            )

        # Sort by final score
        scored.sort(key=lambda x: x[1]["final_score"], reverse=True)

        top_k_items = scored[:top_k]
        top_7_items = scored[:daily_count]

        # Log top ranked titles
        top_titles = [
            f"{item.title[:40]} ({sc['final_score']:.2f})" for item, sc in top_k_items[:10]
        ]
        logger.info("Top ranked items: %s", top_titles)

        # Upsert daily picks (delete then insert for determinism)
        session.execute(text("DELETE FROM daily_picks WHERE date = :date"), {"date": date_str})
        for rank, (item, _scores) in enumerate(top_7_items, start=1):
            session.execute(
                text("""
                    INSERT INTO daily_picks (date, rank, item_id, created_at)
                    VALUES (:date, :rank, :item_id, :created_at)
                """),
                {
                    "date": date_str,
                    "rank": rank,
                    "item_id": item.id,
                    "created_at": datetime.now(UTC).isoformat(),
                },
            )

        session.commit()

    logger.info(
        "Ranked %d candidates, selected top %d for %s, top 7: %s",
        len(items), top_k, date_str,
        [item.title[:30] for item, _ in top_7_items],
    )

    return {
        "ranked": len(items),
        "top_k": len(top_k_items),
        "daily_picks": len(top_7_items),
        "date": date_str,
    }
