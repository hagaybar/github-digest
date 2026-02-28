from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import and_, desc, func, inspect, select
from sqlalchemy.orm import Session

from github_digest.config import settings
from github_digest.db.models import Repo, RepoSearch, RepoStatsDaily, RepoSummary
from github_digest.services.fetcher import SavedSearch


@dataclass
class BoardItem:
    repo: Repo
    search: RepoSearch
    delta: int | None = None
    summary: RepoSummary | None = None
    star_history: list[dict[str, Any]] = field(default_factory=list)


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _today_filter() -> str:
    return _today_utc().isoformat()


def _exclude_known_filter(exclude_known: Iterable[str] | None) -> list[str]:
    if not exclude_known:
        return []
    return [name.lower() for name in exclude_known]


def _repo_to_dict(item: BoardItem) -> dict[str, Any]:
    repo = item.repo
    summary = item.summary
    return {
        "full_name": repo.full_name,
        "html_url": repo.html_url,
        "description": repo.description,
        "language": repo.language,
        "topics": repo.topics_json or [],
        "stars": repo.stars,
        "forks": repo.forks,
        "open_issues": repo.open_issues,
        "pushed_at": repo.pushed_at.isoformat() if repo.pushed_at else None,
        "last_seen_at": item.search.last_seen_at.isoformat(),
        "delta": item.delta,
        "summary": summary.summary if summary else None,
        "why_interesting": summary.why_interesting if summary else None,
        "tags": json.loads(summary.tags) if summary and summary.tags else [],
        "latest_release_tag": summary.latest_release_tag if summary else None,
        "latest_release_summary": summary.latest_release_summary if summary else None,
        "star_history": item.star_history,
    }


def get_board_today(
    session: Session,
    searches: list[SavedSearch],
    mode: str,
    window_days: int,
    limit: int,
    stars_min: int,
    stars_max: int,
    include_summary: bool = True,
) -> dict[str, list[dict[str, Any]]]:
    board: dict[str, list[dict[str, Any]]] = {}
    seen_names: dict[str, set[str]] = {}
    for search in searches:
        label = search.label or search.name
        items = get_board_for_query(
            session,
            search,
            mode,
            window_days,
            limit,
            stars_min,
            stars_max,
            include_summary=include_summary,
        )
        if label not in board:
            board[label] = []
            seen_names[label] = set()
        for item in items:
            if item["full_name"] not in seen_names[label]:
                board[label].append(item)
                seen_names[label].add(item["full_name"])
    return board


def get_board_for_query(
    session: Session,
    search: SavedSearch,
    mode: str,
    window_days: int,
    limit: int,
    stars_min: int,
    stars_max: int,
    include_summary: bool = True,
) -> list[dict[str, Any]]:
    mode_defaults = search.mode_defaults or {}
    effective_window = int(mode_defaults.get("window_days", window_days))
    effective_min = int(mode_defaults.get("stars_min", stars_min))
    effective_max = int(mode_defaults.get("stars_max", stars_max))
    if mode == "rising":
        items = _board_rising(
            session,
            search,
            effective_window,
            limit,
            effective_min,
            effective_max,
            include_summary=include_summary,
        )
    elif mode == "updated":
        items = _board_updated(
            session,
            search,
            effective_window,
            limit,
            effective_min,
            effective_max,
            include_summary=include_summary,
        )
    else:
        new_cap = int(mode_defaults.get("new_stars_max", settings.new_stars_max))
        items = _board_new(session, search, effective_window, limit, stars_max=new_cap, include_summary=include_summary)

    # Batch-load last 8 days of star history for all repos in this result
    if items:
        repo_ids = [item.repo.id for item in items]
        history_cutoff = (_today_utc() - timedelta(days=8)).isoformat()
        stats_rows = (
            session.execute(
                select(RepoStatsDaily)
                .where(RepoStatsDaily.repo_id.in_(repo_ids))
                .where(RepoStatsDaily.date >= history_cutoff)
                .order_by(RepoStatsDaily.date)
            )
            .scalars()
            .all()
        )
        history_map: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for stat in stats_rows:
            history_map[stat.repo_id].append({"date": stat.date, "stars": stat.stars})
        for item in items:
            item.star_history = history_map.get(item.repo.id, [])

    return [_repo_to_dict(item) for item in items]


def _board_new(
    session: Session,
    search: SavedSearch,
    window_days: int,
    limit: int,
    stars_max: int = 500000,
    include_summary: bool = True,
) -> list[BoardItem]:
    # Anchor first_seen_at cutoff to the most recent discovery, not wall-clock "now".
    # This ensures short windows (e.g. 24h) always show something even when the fetcher
    # hasn't discovered truly new repos recently — "24h" means "from the latest fetch batch".
    max_first_seen = session.execute(select(func.max(Repo.first_seen_at))).scalar()
    if max_first_seen is None:
        max_first_seen = datetime.now(timezone.utc)
    elif max_first_seen.tzinfo is None:
        max_first_seen = max_first_seen.replace(tzinfo=timezone.utc)

    cutoff_last_seen = datetime.now(timezone.utc) - timedelta(days=window_days)
    cutoff_first_seen = max_first_seen - timedelta(days=window_days)
    exclude_known = _exclude_known_filter(search.exclude_known)

    if include_summary:
        stmt = (
            select(Repo, RepoSearch, RepoSummary)
            .join(RepoSearch, RepoSearch.repo_id == Repo.id)
            .outerjoin(RepoSummary, RepoSummary.repo_id == Repo.id)
        )
    else:
        stmt = (
            select(Repo, RepoSearch)
            .join(RepoSearch, RepoSearch.repo_id == Repo.id)
        )
    stmt = (
        stmt
        .where(RepoSearch.query_name == search.name)
        .where(RepoSearch.last_seen_at >= cutoff_last_seen)
        .where(Repo.first_seen_at >= cutoff_first_seen)
        .where(Repo.stars <= stars_max)
        .order_by(desc(Repo.first_seen_at), desc(Repo.stars))
        .limit(limit)
    )
    results = session.execute(stmt).all()
    if include_summary:
        items = [
            BoardItem(repo=repo, search=search_row, summary=summary_row)
            for repo, search_row, summary_row in results
        ]
    else:
        items = [BoardItem(repo=repo, search=search_row) for repo, search_row in results]
    if exclude_known:
        items = [item for item in items if item.repo.full_name.lower() not in exclude_known]
    return items


def _board_updated(
    session: Session,
    search: SavedSearch,
    window_days: int,
    limit: int,
    stars_min: int,
    stars_max: int,
    include_summary: bool = True,
) -> list[BoardItem]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    exclude_known = _exclude_known_filter(search.exclude_known)

    if include_summary:
        stmt = (
            select(Repo, RepoSearch, RepoSummary)
            .join(RepoSearch, RepoSearch.repo_id == Repo.id)
            .outerjoin(RepoSummary, RepoSummary.repo_id == Repo.id)
        )
    else:
        stmt = (
            select(Repo, RepoSearch)
            .join(RepoSearch, RepoSearch.repo_id == Repo.id)
        )
    stmt = (
        stmt
        .where(RepoSearch.query_name == search.name)
        .where(RepoSearch.last_seen_at >= cutoff)
        .where(Repo.pushed_at >= cutoff)
        .where(Repo.stars.between(stars_min, stars_max))
        .order_by(desc(Repo.pushed_at), desc(Repo.stars))
        .limit(limit)
    )
    results = session.execute(stmt).all()
    if include_summary:
        items = [
            BoardItem(repo=repo, search=search_row, summary=summary_row)
            for repo, search_row, summary_row in results
        ]
    else:
        items = [BoardItem(repo=repo, search=search_row) for repo, search_row in results]
    if exclude_known:
        items = [item for item in items if item.repo.full_name.lower() not in exclude_known]
    return items


def _board_rising(
    session: Session,
    search: SavedSearch,
    window_days: int,
    limit: int,
    stars_min: int,
    stars_max: int,
    include_summary: bool = True,
) -> list[BoardItem]:
    if not inspect(session.bind).has_table("repo_stats_daily"):
        return []
    today = _today_filter()
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    target_date = (_today_utc() - timedelta(days=window_days)).isoformat()
    exclude_known = _exclude_known_filter(search.exclude_known)

    stats_today = RepoStatsDaily.__table__.alias("stats_today")
    stats_baseline = RepoStatsDaily.__table__.alias("stats_baseline")

    baseline_date = (
        select(RepoStatsDaily.repo_id, func.max(RepoStatsDaily.date).label("date"))
        .where(RepoStatsDaily.date <= target_date)
        .group_by(RepoStatsDaily.repo_id)
        .subquery()
    )

    if include_summary:
        stmt = (
            select(
                Repo,
                RepoSearch,
                RepoSummary,
                (stats_today.c.stars - stats_baseline.c.stars).label("delta"),
            )
            .join(RepoSearch, RepoSearch.repo_id == Repo.id)
            .outerjoin(RepoSummary, RepoSummary.repo_id == Repo.id)
        )
    else:
        stmt = (
            select(
                Repo,
                RepoSearch,
                (stats_today.c.stars - stats_baseline.c.stars).label("delta"),
            )
            .join(RepoSearch, RepoSearch.repo_id == Repo.id)
        )
    stmt = (
        stmt
        .join(stats_today, and_(stats_today.c.repo_id == Repo.id, stats_today.c.date == today))
        .join(baseline_date, baseline_date.c.repo_id == Repo.id)
        .join(
            stats_baseline,
            and_(
                stats_baseline.c.repo_id == Repo.id,
                stats_baseline.c.date == baseline_date.c.date,
            ),
        )
        .where(RepoSearch.query_name == search.name)
        .where(RepoSearch.last_seen_at >= cutoff)
        .where(stats_today.c.stars.between(stars_min, stars_max))
        .order_by(desc("delta"), desc(stats_today.c.stars))
        .limit(limit)
    )
    results = session.execute(stmt).all()
    if include_summary:
        items = [
            BoardItem(repo=repo, search=search_row, delta=delta, summary=summary_row)
            for repo, search_row, summary_row, delta in results
        ]
    else:
        items = [BoardItem(repo=repo, search=search_row, delta=delta) for repo, search_row, delta in results]
    if exclude_known:
        items = [item for item in items if item.repo.full_name.lower() not in exclude_known]
    return items


def eligible_repo_ids_for_summaries(
    session: Session,
    searches: list[SavedSearch],
    max_rising: int,
    window_days: int,
    stars_min: int,
    stars_max: int,
    today_only: bool = True,
) -> set[int]:
    repo_ids: set[int] = set()
    for search in searches:
        new_items = _board_new(session, search, window_days, limit=100, stars_max=stars_max, include_summary=False)
        rising_items = _board_rising(
            session,
            search,
            window_days,
            limit=max_rising,
            stars_min=stars_min,
            stars_max=stars_max,
            include_summary=False,
        )
        for item in new_items:
            repo_ids.add(item.repo.id)
        for item in rising_items:
            repo_ids.add(item.repo.id)
    return repo_ids
