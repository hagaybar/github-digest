from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from github_digest.config import Settings, settings
from github_digest.db.database import create_tables, get_engine
from github_digest.db.models import Repo, RepoSearch, RepoStatsDaily, Run
from github_digest.services.github_client import GitHubClient

logger = logging.getLogger(__name__)


@dataclass
class SavedSearch:
    name: str
    query: str
    limit: int | None = None
    label: str | None = None
    mode_defaults: dict[str, Any] | None = None
    exclude_known: list[str] | None = None


def load_saved_searches(path: Path) -> list[SavedSearch]:
    if not path.exists():
        logger.warning("Saved searches file not found: %s", path)
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    searches: list[SavedSearch] = []
    for entry in data:
        searches.append(
            SavedSearch(
                name=entry["name"],
                query=entry["query"],
                limit=entry.get("limit"),
                label=entry.get("label"),
                mode_defaults=entry.get("mode_defaults"),
                exclude_known=entry.get("exclude_known"),
            )
        )
    return searches


def _coerce_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def upsert_repo(session: Session, item: dict[str, Any], now: datetime) -> Repo:
    repo = session.scalar(select(Repo).where(Repo.github_id == item["id"]))
    if repo is None:
        repo = Repo(
            github_id=item["id"],
            full_name=item["full_name"],
            html_url=item["html_url"],
            description=item.get("description"),
            language=item.get("language"),
            topics_json=item.get("topics"),
            stars=item.get("stargazers_count", 0),
            forks=item.get("forks_count", 0),
            open_issues=item.get("open_issues_count", 0),
            pushed_at=_coerce_datetime(item.get("pushed_at")),
            created_at=_coerce_datetime(item.get("created_at")),
            updated_at=_coerce_datetime(item.get("updated_at")),
            first_seen_at=now,
            last_seen_at=now,
        )
        session.add(repo)
        session.flush()
        return repo

    repo.full_name = item["full_name"]
    repo.html_url = item["html_url"]
    repo.description = item.get("description")
    repo.language = item.get("language")
    repo.topics_json = item.get("topics")
    repo.stars = item.get("stargazers_count", 0)
    repo.forks = item.get("forks_count", 0)
    repo.open_issues = item.get("open_issues_count", 0)
    repo.pushed_at = _coerce_datetime(item.get("pushed_at"))
    repo.created_at = _coerce_datetime(item.get("created_at"))
    repo.updated_at = _coerce_datetime(item.get("updated_at"))
    repo.last_seen_at = now
    session.add(repo)
    session.flush()
    return repo


def upsert_repo_search(session: Session, repo: Repo, query_name: str, now: datetime) -> None:
    search = session.scalar(
        select(RepoSearch).where(
            RepoSearch.repo_id == repo.id,
            RepoSearch.query_name == query_name,
        )
    )
    if search is None:
        session.add(RepoSearch(repo_id=repo.id, query_name=query_name, last_seen_at=now))
    else:
        search.last_seen_at = now
        session.add(search)


def upsert_repo_stats_daily(session: Session, repo: Repo, now: datetime) -> None:
    date_str = now.date().isoformat()
    stmt = insert(RepoStatsDaily).values(
        repo_id=repo.id,
        date=date_str,
        stars=repo.stars,
        forks=repo.forks,
        open_issues=repo.open_issues,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["repo_id", "date"],
        set_={
            "stars": repo.stars,
            "forks": repo.forks,
            "open_issues": repo.open_issues,
        },
    )
    session.execute(stmt)


def fetch_once(settings_obj: Settings | None = None) -> dict[str, Any]:
    settings_obj = settings_obj or settings
    engine = get_engine(settings_obj.db_path)
    create_tables(engine)

    client = GitHubClient(
        token=settings_obj.github_token,
        user_agent=settings_obj.user_agent,
        throttle_seconds=settings_obj.throttle_seconds,
    )

    searches = load_saved_searches(settings_obj.saved_searches_path)
    if not searches:
        return {"status": "no-searches"}

    now = datetime.now(timezone.utc)
    run = Run(run_type="fetch", status="started", started_at=now)

    total_processed = 0
    with Session(engine) as session:
        session.add(run)
        session.commit()

        try:
            for search in searches:
                if total_processed >= settings_obj.fetch_limit_per_run:
                    break
                limit = search.limit or settings_obj.fetch_limit_per_query
                limit = min(limit, settings_obj.fetch_limit_per_query)
                remaining = settings_obj.fetch_limit_per_run - total_processed
                per_page = min(limit, remaining)
                logger.info("Fetching search '%s'", search.name)
                response = client.search_repositories(search.query, per_page=per_page)
                items: Iterable[dict[str, Any]] = response.get("items", [])
                for item in items:
                    repo = upsert_repo(session, item, now)
                    upsert_repo_search(session, repo, search.name, now)
                    upsert_repo_stats_daily(session, repo, now)
                    total_processed += 1
                    if total_processed >= settings_obj.fetch_limit_per_run:
                        break
                session.commit()

            run.status = "finished"
            run.finished_at = datetime.now(timezone.utc)
            run.detail = f"processed={total_processed}"
            session.add(run)
            session.commit()
            return {"status": "finished", "processed": total_processed}
        except Exception as exc:
            session.rollback()
            run.status = "failed"
            run.finished_at = datetime.now(timezone.utc)
            run.detail = str(exc)
            session.add(run)
            session.commit()
            raise
