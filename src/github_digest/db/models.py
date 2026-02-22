from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, PrimaryKeyConstraint, String, Text, UniqueConstraint, func
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


# ---------------------------------------------------------------------------
# Builder Radar models
# ---------------------------------------------------------------------------


class HNStoryRaw(Base):
    __tablename__ = "hn_story_raw"

    hn_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comments: Mapped[int | None] = mapped_column(Integer, nullable=True)
    time: Mapped[int] = mapped_column(Integer)
    raw_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class RadarItem(Base):
    __tablename__ = "radar_items"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    source: Mapped[str] = mapped_column(String(50))
    source_id: Mapped[str] = mapped_column(String(255))
    url: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    github_full_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    signals_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    tags_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    scores_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    __table_args__ = (
        UniqueConstraint("source", "source_id", name="uq_radar_items_source_source_id"),
    )

    analyses: Mapped[list[RadarItemAnalysis]] = relationship("RadarItemAnalysis", back_populates="item")


class RadarItemAnalysis(Base):
    __tablename__ = "radar_item_analysis"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    item_id: Mapped[str] = mapped_column(String(40), ForeignKey("radar_items.id"), index=True)
    analysis_version: Mapped[str] = mapped_column(String(20), default="v1")
    analysis_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Queue tracking columns
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[str | None] = mapped_column(String(50), nullable=True)

    __table_args__ = (
        UniqueConstraint("item_id", "analysis_version", name="uq_analysis_item_version"),
    )

    item: Mapped[RadarItem] = relationship("RadarItem", back_populates="analyses")


class DailyPick(Base):
    __tablename__ = "daily_picks"

    date: Mapped[str] = mapped_column(String(10))
    rank: Mapped[int] = mapped_column(Integer)
    item_id: Mapped[str] = mapped_column(String(40), ForeignKey("radar_items.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (PrimaryKeyConstraint("date", "rank"),)


class DailyPairing(Base):
    __tablename__ = "daily_pairings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    rank: Mapped[int] = mapped_column(Integer)
    item_id_a: Mapped[str] = mapped_column(String(40), ForeignKey("radar_items.id"))
    item_id_b: Mapped[str] = mapped_column(String(40), ForeignKey("radar_items.id"))
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
