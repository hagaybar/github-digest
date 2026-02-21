from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import desc, func, inspect, select
from sqlalchemy.orm import Session

from github_digest.config import settings
from github_digest.db.database import create_tables, get_engine
from github_digest.db.models import Repo, RepoSearch, RepoStatsDaily, RepoSummary, Run
from github_digest.services.board import eligible_repo_ids_for_summaries
from github_digest.services.fetcher import load_saved_searches

logger = logging.getLogger(__name__)

ModelFn = Callable[[Repo], dict[str, Any]]


@dataclass
class RateLimitError(Exception):
    retry_after: float | None = None


def _today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _coerce_dt(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _summary_is_fresh(summary: RepoSummary, repo: Repo, stale_days: int) -> bool:
    updated_at = _coerce_dt(summary.updated_at)
    if updated_at is None:
        return False
    max_age = timedelta(days=stale_days)
    if datetime.now(timezone.utc) - updated_at > max_age:
        return False
    pushed_at = _coerce_dt(repo.pushed_at) if repo.pushed_at else None
    if pushed_at and pushed_at > updated_at:
        return False
    return True


def _stars_changed_significantly(
    session: Session, repo_id: int, since: datetime, threshold: int
) -> bool:
    target_date = since.date().isoformat()
    baseline = session.scalar(
        select(RepoStatsDaily.stars)
        .where(RepoStatsDaily.repo_id == repo_id, RepoStatsDaily.date <= target_date)
        .order_by(desc(RepoStatsDaily.date))
        .limit(1)
    )
    today = session.scalar(
        select(RepoStatsDaily.stars)
        .where(RepoStatsDaily.repo_id == repo_id, RepoStatsDaily.date == _today_str())
        .limit(1)
    )
    if baseline is None or today is None:
        return False
    return (today - baseline) >= threshold


def _validate_summary_payload(payload: dict[str, Any]) -> None:
    summary = payload.get("summary", "")
    why = payload.get("why_interesting", "")
    tags = payload.get("tags")

    if not summary or len(summary) > 600:
        raise ValueError("summary invalid")
    if summary.count(".") not in (2, 3):
        raise ValueError("summary sentence count invalid")
    if not why or why.count(".") != 1:
        raise ValueError("why_interesting invalid")

    try:
        tag_list = json.loads(tags)
    except json.JSONDecodeError as exc:
        raise ValueError("tags invalid json") from exc

    if not isinstance(tag_list, list) or not (3 <= len(tag_list) <= 6):
        raise ValueError("tags size invalid")
    if any(not isinstance(t, str) or not t.strip() for t in tag_list):
        raise ValueError("tags content invalid")


def _generate_summary(repo: Repo) -> dict[str, Any]:
    topics = repo.topics_json or []
    tag_list = [t.replace("-", " ") for t in topics[:4]]
    if repo.language:
        tag_list.append(repo.language)
    tag_list = tag_list[:6]
    while len(tag_list) < 3:
        tag_list.append("github")

    summary = (
        f"{repo.full_name} is a {repo.language or 'software'} project focused on {', '.join(tag_list[:2])}. "
        f"It has {repo.stars} stars and appears active with recent activity." 
        f"Use it to explore {', '.join(tag_list[1:3])}."
    )
    why = "It is showing recent traction and fits today’s discovery themes."
    payload = {
        "summary": summary.strip(),
        "why_interesting": why.strip(),
        "tags": json.dumps(tag_list[:6]),
        "model": "stub-metadata-v1",
        "source": "metadata",
    }
    _validate_summary_payload(payload)
    return payload


def _call_model_with_retry(
    repo: Repo,
    model_fn: ModelFn,
    max_retries: int,
    base_backoff: float,
) -> dict[str, Any]:
    for attempt in range(1, max_retries + 1):
        try:
            payload = model_fn(repo)
            _validate_summary_payload(payload)
            return payload
        except RateLimitError as exc:
            if attempt == max_retries:
                raise
            delay = exc.retry_after if exc.retry_after is not None else base_backoff * (2 ** (attempt - 1))
            time.sleep(delay)
        except ValueError:
            raise
        except Exception as exc:
            if attempt == max_retries:
                raise
            logger.warning("Summarizer model error (attempt %s/%s): %s", attempt, max_retries, exc)
            time.sleep(base_backoff * (2 ** (attempt - 1)))
    raise RuntimeError("unreachable")


def summarize_repos(
    settings_obj=settings,
    *,
    limit: int | None = None,
    max_per_day: int | None = None,
    days: int = 7,
    today_only: bool = True,
    stale_days: int | None = None,
    force: bool = False,
    dry_run: bool = False,
    model_fn: ModelFn | None = None,
    max_retries: int = 3,
    base_backoff: float = 1.0,
) -> dict[str, Any]:
    engine = get_engine(settings_obj.db_path)
    if not dry_run:
        create_tables(engine)

    searches = load_saved_searches(settings_obj.saved_searches_path)
    if not searches:
        return {"status": "no-searches"}

    now = datetime.now(timezone.utc)
    run_limit = 30 if limit is None else limit
    per_day_cap = settings_obj.max_summaries_per_day if max_per_day is None else max_per_day
    stale_days = settings_obj.summary_stale_days if stale_days is None else stale_days
    run = Run(run_type="summarize", status="started", started_at=now)
    summarized = 0

    with Session(engine) as session:
        if not dry_run:
            session.add(run)
            session.commit()

        try:
            eligible_ids = eligible_repo_ids_for_summaries(
                session,
                searches,
                max_rising=settings_obj.rising_top_k,
                window_days=days,
                stars_min=settings_obj.stars_min,
                stars_max=settings_obj.stars_max,
                today_only=today_only,
            )
            if not eligible_ids:
                if not dry_run:
                    run.status = "finished"
                    run.finished_at = datetime.now(timezone.utc)
                    run.detail = "eligible=0"
                    session.add(run)
                    session.commit()
                return {"status": "finished", "summarized": 0}

            inspector = inspect(session.bind)
            if inspector.has_table("repo_summaries"):
                cols = {col["name"] for col in inspector.get_columns("repo_summaries")}
                if "updated_at" in cols:
                    already_today = session.scalar(
                        select(func.count())
                        .select_from(RepoSummary)
                        .where(func.date(RepoSummary.updated_at) == _today_str())
                    )
                else:
                    already_today = 0
            else:
                already_today = 0
            remaining_daily = max(0, per_day_cap - (already_today or 0))
            remaining = min(run_limit, remaining_daily)

            if dry_run:
                repo_rows = (
                    session.execute(select(Repo).where(Repo.id.in_(eligible_ids)).order_by(desc(Repo.stars)))
                    .scalars()
                    .all()
                )
                names = [repo.full_name for repo in repo_rows[:remaining]]
                return {"status": "dry-run", "eligible": len(eligible_ids), "planned": len(names), "names": names}

            repo_rows = (
                session.execute(select(Repo).where(Repo.id.in_(eligible_ids)).order_by(desc(Repo.stars)))
                .scalars()
                .all()
            )
            for repo in repo_rows:
                if remaining <= 0:
                    break
                summary = session.scalar(select(RepoSummary).where(RepoSummary.repo_id == repo.id))
                if summary and not force and _summary_is_fresh(summary, repo, stale_days):
                    updated_at = _coerce_dt(summary.updated_at)
                    if updated_at and not _stars_changed_significantly(
                        session, repo.id, updated_at, settings_obj.summary_star_change_threshold
                    ):
                        continue
                try:
                    payload = _call_model_with_retry(
                        repo,
                        model_fn or _generate_summary,
                        max_retries=max_retries,
                        base_backoff=base_backoff,
                    )
                except ValueError as exc:
                    logger.warning("Invalid summary payload for %s: %s", repo.full_name, exc)
                    continue
                except RateLimitError as exc:
                    logger.warning("Rate limit for %s: %s", repo.full_name, exc)
                    continue
                if summary is None:
                    summary = RepoSummary(repo_id=repo.id)
                summary.summary = payload["summary"]
                summary.why_interesting = payload["why_interesting"]
                summary.tags = payload["tags"]
                summary.model = payload["model"]
                summary.source = payload["source"]
                summary.updated_at = datetime.now(timezone.utc)
                if "latest_release_tag" in payload:
                    summary.latest_release_tag = payload["latest_release_tag"]
                if "latest_release_summary" in payload:
                    summary.latest_release_summary = payload["latest_release_summary"]
                session.add(summary)
                session.commit()
                summarized += 1
                remaining -= 1

            run.status = "finished"
            run.finished_at = datetime.now(timezone.utc)
            run.detail = f"summarized={summarized}"
            session.add(run)
            session.commit()
            return {"status": "finished", "summarized": summarized}
        except Exception as exc:
            if not dry_run:
                session.rollback()
                run.status = "failed"
                run.finished_at = datetime.now(timezone.utc)
                run.detail = str(exc)
                session.add(run)
                session.commit()
            raise
