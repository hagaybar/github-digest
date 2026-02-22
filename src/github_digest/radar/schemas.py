from __future__ import annotations

import hashlib

from pydantic import BaseModel


class GithubRepo(BaseModel):
    full_name: str
    html_url: str | None = None
    description: str | None = None
    language: str | None = None
    stars: int | None = None
    forks: int | None = None
    open_issues: int | None = None
    pushed_at: str | None = None
    created_at: str | None = None


class Content(BaseModel):
    summary_source_text: str | None = None
    readme_excerpt: str | None = None
    tags_detected: list[str] = []


class Signals(BaseModel):
    github_stars_total: int | None = None
    github_stars_7d: int | None = None
    github_velocity: float | None = None
    hn_points: int | None = None
    hn_comments: int | None = None
    hn_rank: int | None = None
    reddit_score: int | None = None  # vNext
    rss_mentions: int | None = None  # vNext


class Tags(BaseModel):
    domains: list[str] = []
    languages: list[str] = []
    maturity: str = "unknown"  # experimental|beta|stable|unknown
    composable: str = "unknown"  # low|medium|high|unknown


class BuildIdea(BaseModel):
    size: str  # small|medium|spicy
    idea: str
    steps: list[str] = []
    prerequisites: list[str] = []


class Analysis(BaseModel):
    unlock: str | None = None
    novelty: str | None = None
    why_cool: list[str] = []
    best_start: str | None = None
    build_ideas: list[BuildIdea] = []
    confidence: float = 0.0


class Scores(BaseModel):
    cool_score: float = 0.0
    buildability_score: float = 0.0
    momentum_score: float = 0.0
    final_score: float = 0.0
    score_version: str = "v1"


class DailyPickMeta(BaseModel):
    picked_for_date: str | None = None
    picked_rank: int | None = None


class Pairing(BaseModel):
    paired_with_ids: list[str] = []
    pairing_rationale: str | None = None


class ItemV1(BaseModel):
    id: str
    source: str  # github|hackernews|reddit|rss|other
    source_id: str
    url: str
    title: str
    published_at: str | None = None
    collected_at: str
    github_repo: GithubRepo | None = None
    content: Content | None = None
    signals: Signals | None = None
    tags: Tags | None = None
    analysis: Analysis | None = None
    scores: Scores | None = None
    daily_pick: DailyPickMeta | None = None
    pairing: Pairing | None = None


def make_item_id(source: str, source_id: str) -> str:
    """Create deterministic SHA1 id from source + source_id."""
    return hashlib.sha1(f"{source}:{source_id}".encode()).hexdigest()
