from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from github_digest.config import Settings
from github_digest.db.database import create_tables, get_engine
from github_digest.db.models import Repo, RepoSearch, RepoStatsDaily, RepoSummary
from github_digest.services import board
from github_digest.services.fetcher import (
    SavedSearch,
    fetch_once,
    upsert_repo,
    upsert_repo_search,
    upsert_repo_stats_daily,
)
from github_digest.services.summarizer import _validate_summary_payload, summarize_repos


def _fake_repo_item(repo_id: int, stars: int = 100) -> dict:
    return {
        "id": repo_id,
        "full_name": f"org/repo-{repo_id}",
        "html_url": f"https://github.com/org/repo-{repo_id}",
        "description": "demo",
        "language": "Python",
        "topics": ["llm", "rag"],
        "stargazers_count": stars,
        "forks_count": 1,
        "open_issues_count": 0,
        "pushed_at": "2026-02-19T00:00:00Z",
        "created_at": "2026-02-01T00:00:00Z",
        "updated_at": "2026-02-19T00:00:00Z",
    }


def test_first_seen_at_preserved(tmp_path: Path) -> None:
    engine = get_engine(tmp_path / "test.db")
    create_tables(engine)
    now1 = datetime(2026, 2, 20, tzinfo=timezone.utc)
    now2 = now1 + timedelta(days=1)

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(1, stars=10), now1)
        session.commit()
        first_seen = repo.first_seen_at

        repo2 = upsert_repo(session, _fake_repo_item(1, stars=20), now2)
        session.commit()
        assert repo2.first_seen_at == first_seen


def test_daily_stats_upsert_no_duplicates(tmp_path: Path) -> None:
    engine = get_engine(tmp_path / "test.db")
    create_tables(engine)
    now = datetime(2026, 2, 20, tzinfo=timezone.utc)

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(2, stars=10), now)
        upsert_repo_stats_daily(session, repo, now)
        upsert_repo_stats_daily(session, repo, now)
        session.commit()

        rows = session.execute(select(RepoStatsDaily)).scalars().all()
        assert len(rows) == 1


def test_rising_delta_with_missing_intermediate(tmp_path: Path) -> None:
    engine = get_engine(tmp_path / "test.db")
    create_tables(engine)
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(3, stars=200), now)
        search = RepoSearch(repo_id=repo.id, query_name="llm", last_seen_at=now)
        session.add(search)

        baseline_date = (now.date() - timedelta(days=8)).isoformat()
        session.add(
            RepoStatsDaily(repo_id=repo.id, date=baseline_date, stars=150, forks=1, open_issues=0)
        )
        session.add(
            RepoStatsDaily(repo_id=repo.id, date=today, stars=200, forks=1, open_issues=0)
        )
        session.commit()

        saved = SavedSearch(name="llm", query="topic:llm")
        items = board._board_rising(session, saved, window_days=7, limit=5, stars_min=50, stars_max=20000)
        assert items
        assert items[0].delta == 50


def test_summary_validation_rejects_bad_tags() -> None:
    payload = {
        "summary": "short summary",
        "why_interesting": "One sentence.",
        "tags": "not-json",
    }
    with pytest.raises(ValueError):
        _validate_summary_payload(payload)


def test_summarize_daily_cap(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path, max_summaries_per_day=1)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        repo1 = upsert_repo(session, _fake_repo_item(4, stars=100), now)
        repo2 = upsert_repo(session, _fake_repo_item(5, stars=120), now)
        upsert_repo_search(session, repo1, "llm", now)
        upsert_repo_search(session, repo2, "llm", now)
        upsert_repo_stats_daily(session, repo1, now)
        upsert_repo_stats_daily(session, repo2, now)
        session.commit()

    result = summarize_repos(settings_obj)
    assert result["summarized"] == 1


def test_default_caps_enforced(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        for i in range(40):
            repo = upsert_repo(session, _fake_repo_item(100 + i, stars=100 + i), now)
            upsert_repo_search(session, repo, "llm", now)
            upsert_repo_stats_daily(session, repo, now)
        session.commit()

    result = summarize_repos(settings_obj)
    assert result["summarized"] == 30


def test_eligibility_today_board_only(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)

    with Session(engine) as session:
        repo_today = upsert_repo(session, _fake_repo_item(20, stars=100), now)
        repo_yesterday = upsert_repo(session, _fake_repo_item(21, stars=100), now)
        upsert_repo_search(session, repo_today, "llm", now)
        upsert_repo_search(session, repo_yesterday, "llm", yesterday)
        upsert_repo_stats_daily(session, repo_today, now)
        upsert_repo_stats_daily(session, repo_yesterday, now)
        session.commit()

    def model_fn(_repo: Repo) -> dict:
        return {
            "summary": "Summary. Second sentence. Third sentence.",
            "why_interesting": "One sentence.",
            "tags": json.dumps(["llm", "python", "demo"]),
            "model": "stub",
            "source": "metadata",
        }

    result = summarize_repos(settings_obj, limit=10, max_per_day=10, model_fn=model_fn)
    assert result["summarized"] == 1

def test_summarize_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(6, stars=100), now)
        repo_id = repo.id
        upsert_repo_search(session, repo, "llm", now)
        upsert_repo_stats_daily(session, repo, now)
        summary = RepoSummary(
            repo_id=repo.id,
            summary="Initial summary",
            why_interesting="One sentence.",
            tags=json.dumps(["llm", "python", "demo"]),
            source="metadata",
            updated_at=now,
        )
        session.add(summary)
        session.commit()

    result = summarize_repos(settings_obj)
    assert result["summarized"] == 0

    with Session(engine) as session:
        summary = session.scalar(select(RepoSummary).where(RepoSummary.repo_id == repo_id))
        assert summary is not None
        assert summary.summary == "Initial summary"


def test_force_overrides_idempotency(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(8, stars=100), now)
        upsert_repo_search(session, repo, "llm", now)
        upsert_repo_stats_daily(session, repo, now)
        summary = RepoSummary(
            repo_id=repo.id,
            summary="Initial summary",
            why_interesting="One sentence.",
            tags=json.dumps(["llm", "python", "demo"]),
            source="metadata",
            updated_at=now,
        )
        session.add(summary)
        session.commit()

    def model_fn(_repo: Repo) -> dict:
        return {
            "summary": "Updated summary. Second sentence. Third sentence.",
            "why_interesting": "One sentence.",
            "tags": json.dumps(["llm", "python", "updated"]),
            "model": "stub",
            "source": "metadata",
        }

    result = summarize_repos(settings_obj, force=True, limit=1, max_per_day=2, model_fn=model_fn)
    assert result["summarized"] == 1


def test_dry_run_no_writes(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(9, stars=100), now)
        upsert_repo_search(session, repo, "llm", now)
        upsert_repo_stats_daily(session, repo, now)
        session.commit()

    called = {"count": 0}

    def model_fn(_repo: Repo) -> dict:
        called["count"] += 1
        return {
            "summary": "Summary. Second sentence. Third sentence.",
            "why_interesting": "One sentence.",
            "tags": json.dumps(["llm", "python", "demo"]),
            "model": "stub",
            "source": "metadata",
        }

    result = summarize_repos(settings_obj, dry_run=True, model_fn=model_fn)
    assert result["status"] == "dry-run"
    assert called["count"] == 0

    with Session(engine) as session:
        summaries = session.execute(select(RepoSummary)).scalars().all()
        assert summaries == []


def test_invalid_model_output_rejected(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)
    engine = get_engine(db_path)
    create_tables(engine)
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        repo = upsert_repo(session, _fake_repo_item(10, stars=100), now)
        upsert_repo_search(session, repo, "llm", now)
        upsert_repo_stats_daily(session, repo, now)
        session.commit()

    def bad_model_fn(_repo: Repo) -> dict:
        return {
            "summary": "Summary.",
            "why_interesting": "One sentence.",
            "tags": "not-json",
            "model": "stub",
            "source": "metadata",
        }

    result = summarize_repos(settings_obj, limit=1, max_per_day=1, model_fn=bad_model_fn)
    assert result["summarized"] == 0


def test_e2e_fetch_summarize_board(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "test.db"
    searches_path = tmp_path / "searches.json"
    searches_path.write_text(json.dumps([{"name": "llm", "query": "topic:llm"}]))

    settings_obj = Settings(db_path=db_path, saved_searches_path=searches_path)

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def search_repositories(self, query: str, per_page: int = 10):
            return {"items": [_fake_repo_item(7, stars=150)]}

    monkeypatch.setattr("github_digest.services.fetcher.GitHubClient", FakeClient)

    fetch_once(settings_obj)
    def model_fn(_repo: Repo) -> dict:
        return {
            "summary": "Summary. Second sentence. Third sentence.",
            "why_interesting": "One sentence.",
            "tags": json.dumps(["llm", "python", "demo"]),
            "model": "stub",
            "source": "metadata",
        }

    summarize_repos(settings_obj, model_fn=model_fn, limit=5, max_per_day=5)

    engine = get_engine(db_path)
    create_tables(engine)
    with Session(engine) as session:
        searches = [SavedSearch(name="llm", query="topic:llm")]
        board_data = board.get_board_today(
            session,
            searches,
            mode="new",
            window_days=7,
            limit=5,
            stars_min=50,
            stars_max=20000,
        )
        repos = board_data.get("llm", [])
        assert repos
        assert repos[0]["summary"]
