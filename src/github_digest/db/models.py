from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON


class Base(DeclarativeBase):
    pass


class Repo(Base):
    __tablename__ = "repos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    github_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), index=True)
    html_url: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    language: Mapped[str | None] = mapped_column(String(100), nullable=True)
    topics_json: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    stars: Mapped[int] = mapped_column(Integer, default=0)
    forks: Mapped[int] = mapped_column(Integer, default=0)
    open_issues: Mapped[int] = mapped_column(Integer, default=0)
    pushed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    searches: Mapped[list[RepoSearch]] = relationship("RepoSearch", back_populates="repo")
    summaries: Mapped[list[RepoSummary]] = relationship("RepoSummary", back_populates="repo")
    stats_daily: Mapped[list[RepoStatsDaily]] = relationship("RepoStatsDaily", back_populates="repo")


class RepoSearch(Base):
    __tablename__ = "repo_searches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    repo_id: Mapped[int] = mapped_column(ForeignKey("repos.id"))
    query_name: Mapped[str] = mapped_column(String(200), index=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    repo: Mapped[Repo] = relationship("Repo", back_populates="searches")


class RepoSummary(Base):
    __tablename__ = "repo_summaries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    repo_id: Mapped[int] = mapped_column(ForeignKey("repos.id"), index=True)
    summary: Mapped[str] = mapped_column(Text)
    why_interesting: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    source: Mapped[str | None] = mapped_column(String(100), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    latest_release_tag: Mapped[str | None] = mapped_column(String(100), nullable=True)
    latest_release_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    repo: Mapped[Repo] = relationship("Repo", back_populates="summaries")


class RepoStatsDaily(Base):
    __tablename__ = "repo_stats_daily"

    repo_id: Mapped[int] = mapped_column(ForeignKey("repos.id"), primary_key=True)
    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    stars: Mapped[int] = mapped_column(Integer)
    forks: Mapped[int | None] = mapped_column(Integer, nullable=True)
    open_issues: Mapped[int | None] = mapped_column(Integer, nullable=True)

    repo: Mapped[Repo] = relationship("Repo", back_populates="stats_daily")


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_type: Mapped[str] = mapped_column(String(50), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="started")
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
