from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def _column_exists(engine: Engine, table: str, column: str) -> bool:
    with engine.begin() as conn:
        result = conn.execute(text(f"PRAGMA table_info({table})"))
    return any(row[1] == column for row in result.fetchall())


def _table_exists(engine: Engine, table: str) -> bool:
    with engine.begin() as conn:
        result = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name=:name"),
            {"name": table},
        )
        return result.first() is not None


def migrate(engine: Engine) -> None:
    # Repos: ensure first_seen_at exists
    if _table_exists(engine, "repos") and not _column_exists(engine, "repos", "first_seen_at"):
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE repos ADD COLUMN first_seen_at TEXT"))

    # Repo summaries: add Phase 2 columns if missing
    if _table_exists(engine, "repo_summaries"):
        for col in [
            ("why_interesting", "TEXT"),
            ("tags", "TEXT"),
            ("source", "TEXT"),
            ("updated_at", "TEXT"),
            ("latest_release_tag", "TEXT"),
            ("latest_release_summary", "TEXT"),
        ]:
            if not _column_exists(engine, "repo_summaries", col[0]):
                with engine.begin() as conn:
                    conn.execute(text(f"ALTER TABLE repo_summaries ADD COLUMN {col[0]} {col[1]}"))
        with engine.begin() as conn:
            conn.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_summaries_repo_id ON repo_summaries(repo_id)")
            )
    else:
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS repo_summaries (
                      repo_id INTEGER PRIMARY KEY,
                      summary TEXT NOT NULL,
                      why_interesting TEXT NOT NULL,
                      tags TEXT NOT NULL,
                      model TEXT,
                      source TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      FOREIGN KEY (repo_id) REFERENCES repos(id)
                    )
                    """
                )
            )

    # Daily stats table
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS repo_stats_daily (
                  repo_id INTEGER NOT NULL,
                  date TEXT NOT NULL,
                  stars INTEGER NOT NULL,
                  forks INTEGER,
                  open_issues INTEGER,
                  PRIMARY KEY (repo_id, date),
                  FOREIGN KEY (repo_id) REFERENCES repos(id)
                )
                """
            )
        )
