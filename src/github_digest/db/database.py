from __future__ import annotations

from pathlib import Path
from typing import Iterable

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from github_digest.config import settings
from github_digest.db.migrations import migrate
from github_digest.db.models import Base


def build_sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path}"


def get_engine(db_path: Path | None = None):
    path = db_path or settings.db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(build_sqlite_url(path), future=True)


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=get_engine())


def create_tables(engine=None) -> None:
    engine = engine or get_engine()
    Base.metadata.create_all(bind=engine)
    migrate(engine)


def get_session() -> Iterable[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
