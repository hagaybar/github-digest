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

    # ---------------------------------------------------------------------------
    # Builder Radar tables
    # ---------------------------------------------------------------------------

    # hn_story_raw
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS hn_story_raw (
                  hn_id TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  url TEXT,
                  by TEXT,
                  score INTEGER,
                  comments INTEGER,
                  time INTEGER NOT NULL,
                  raw_json TEXT,
                  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        )

    # radar_items
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS radar_items (
                  id TEXT PRIMARY KEY,
                  source TEXT NOT NULL,
                  source_id TEXT NOT NULL,
                  url TEXT NOT NULL,
                  title TEXT NOT NULL,
                  published_at TEXT,
                  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
                  github_full_name TEXT,
                  signals_json TEXT,
                  tags_json TEXT,
                  scores_json TEXT
                )
                """
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_radar_items_source_source_id "
                "ON radar_items(source, source_id)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_radar_items_github_full_name "
                "ON radar_items(github_full_name)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_radar_items_url "
                "ON radar_items(url)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_radar_items_published_at "
                "ON radar_items(published_at)"
            )
        )

    # radar_item_analysis
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS radar_item_analysis (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  item_id TEXT NOT NULL,
                  analysis_version TEXT NOT NULL DEFAULT 'v1',
                  analysis_json TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  FOREIGN KEY (item_id) REFERENCES radar_items(id)
                )
                """
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_item_version "
                "ON radar_item_analysis(item_id, analysis_version)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_radar_item_analysis_item_id "
                "ON radar_item_analysis(item_id)"
            )
        )

    # daily_picks
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS daily_picks (
                  date TEXT NOT NULL,
                  rank INTEGER NOT NULL,
                  item_id TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  PRIMARY KEY (date, rank),
                  FOREIGN KEY (item_id) REFERENCES radar_items(id)
                )
                """
            )
        )

    # daily_pairings
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS daily_pairings (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  date TEXT NOT NULL,
                  rank INTEGER NOT NULL,
                  item_id_a TEXT NOT NULL,
                  item_id_b TEXT NOT NULL,
                  rationale TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  FOREIGN KEY (item_id_a) REFERENCES radar_items(id),
                  FOREIGN KEY (item_id_b) REFERENCES radar_items(id)
                )
                """
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_daily_pairings_date "
                "ON daily_pairings(date)"
            )
        )

    # radar_item_analysis: add queue tracking columns
    if _table_exists(engine, "radar_item_analysis"):
        for col, col_type, default in [
            ("status", "TEXT", "'pending'"),
            ("attempts", "INTEGER", "0"),
            ("error_message", "TEXT", None),
            ("started_at", "TEXT", None),
        ]:
            if not _column_exists(engine, "radar_item_analysis", col):
                if default is not None:
                    with engine.begin() as conn:
                        conn.execute(text(
                            f"ALTER TABLE radar_item_analysis ADD COLUMN {col} {col_type} NOT NULL DEFAULT {default}"
                        ))
                else:
                    with engine.begin() as conn:
                        conn.execute(text(
                            f"ALTER TABLE radar_item_analysis ADD COLUMN {col} {col_type}"
                        ))
        # Backfill existing rows (idempotent: only affects rows still at default 'pending')
        with engine.begin() as conn:
            conn.execute(text(
                "UPDATE radar_item_analysis SET status='completed' "
                "WHERE analysis_json IS NOT NULL AND status='pending'"
            ))
            conn.execute(text(
                "UPDATE radar_item_analysis SET status='failed' "
                "WHERE analysis_json IS NULL AND status='pending'"
            ))
