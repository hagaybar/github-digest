from __future__ import annotations

import hashlib

from github_digest.radar.schemas import (
    Analysis,
    BuildIdea,
    DailyPickMeta,
    GithubRepo,
    ItemV1,
    Pairing,
    Scores,
    Signals,
    Tags,
    make_item_id,
)


class TestMakeItemId:
    def test_deterministic(self):
        assert make_item_id("hackernews", "42") == make_item_id("hackernews", "42")

    def test_different_ids(self):
        assert make_item_id("hackernews", "42") != make_item_id("hackernews", "43")

    def test_sha1_format(self):
        result = make_item_id("github", "user/repo")
        assert len(result) == 40
        int(result, 16)  # Should not raise

    def test_source_prefix_matters(self):
        assert make_item_id("hackernews", "100") != make_item_id("github", "100")

    def test_known_hash_value(self):
        expected = hashlib.sha1(b"hackernews:42").hexdigest()
        assert make_item_id("hackernews", "42") == expected

    def test_repo_full_name_source_id(self):
        result = make_item_id("github", "torvalds/linux")
        assert len(result) == 40
        assert all(c in "0123456789abcdef" for c in result)


class TestGithubRepo:
    def test_minimal_construction(self):
        repo = GithubRepo(full_name="owner/repo")
        assert repo.full_name == "owner/repo"
        assert repo.stars is None
        assert repo.forks is None

    def test_full_construction(self):
        repo = GithubRepo(
            full_name="owner/repo",
            html_url="https://github.com/owner/repo",
            description="A test repo",
            language="Python",
            stars=1000,
            forks=50,
            open_issues=5,
            pushed_at="2026-02-01T00:00:00Z",
            created_at="2025-01-01T00:00:00Z",
        )
        assert repo.stars == 1000
        assert repo.language == "Python"


class TestSignals:
    def test_all_fields_optional(self):
        s = Signals()
        assert s.hn_points is None
        assert s.github_stars_total is None
        assert s.github_velocity is None

    def test_set_hn_fields(self):
        s = Signals(hn_points=150, hn_comments=45, hn_rank=3)
        assert s.hn_points == 150
        assert s.hn_comments == 45
        assert s.hn_rank == 3

    def test_set_github_fields(self):
        s = Signals(github_stars_total=500, github_stars_7d=20, github_velocity=2.5)
        assert s.github_stars_total == 500
        assert s.github_velocity == 2.5


class TestAnalysis:
    def test_defaults(self):
        a = Analysis()
        assert a.unlock is None
        assert a.why_cool == []
        assert a.build_ideas == []
        assert a.confidence == 0.0

    def test_full_analysis(self):
        a = Analysis(
            unlock="Enables fast data processing",
            novelty="First to combine X and Y",
            why_cool=["Fast", "Easy", "Open source"],
            best_start="README: Quickstart",
            build_ideas=[
                BuildIdea(size="small", idea="Build a demo"),
                BuildIdea(size="medium", idea="Build a service"),
                BuildIdea(size="spicy", idea="Build a platform"),
            ],
            confidence=0.85,
        )
        assert a.confidence == 0.85
        assert len(a.build_ideas) == 3

    def test_confidence_default_zero(self):
        a = Analysis(unlock="test")
        assert a.confidence == 0.0


class TestBuildIdea:
    def test_minimal_fields(self):
        idea = BuildIdea(size="small", idea="Build a CLI tool")
        assert idea.size == "small"
        assert idea.idea == "Build a CLI tool"
        assert idea.steps == []
        assert idea.prerequisites == []

    def test_with_steps_and_prereqs(self):
        idea = BuildIdea(
            size="medium",
            idea="Build a web service",
            steps=["Clone repo", "Run docker compose up"],
            prerequisites=["Docker", "Python 3.11+"],
        )
        assert len(idea.steps) == 2
        assert len(idea.prerequisites) == 2

    def test_sizes_are_accepted(self):
        for size in ("small", "medium", "spicy"):
            idea = BuildIdea(size=size, idea="test")
            assert idea.size == size


class TestItemV1:
    def test_minimal_construction(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
        )
        assert item.id == "abc123"
        assert item.source == "hackernews"
        assert item.analysis is None
        assert item.signals is None
        assert item.github_repo is None

    def test_with_github_repo(self):
        item = ItemV1(
            id="abc123",
            source="github",
            source_id="owner/repo",
            url="https://github.com/owner/repo",
            title="My Repo",
            collected_at="2026-02-21T00:00:00Z",
            github_repo=GithubRepo(full_name="owner/repo", stars=100),
        )
        assert item.github_repo is not None
        assert item.github_repo.stars == 100

    def test_with_analysis(self):
        analysis = Analysis(
            unlock="This enables fast data processing",
            novelty="First to combine X and Y",
            why_cool=["Fast", "Easy to use"],
            best_start="README: Quickstart",
            build_ideas=[
                BuildIdea(size="small", idea="Build a demo"),
                BuildIdea(size="medium", idea="Build a service"),
                BuildIdea(size="spicy", idea="Build a platform"),
            ],
            confidence=0.85,
        )
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
            analysis=analysis,
        )
        assert item.analysis.confidence == 0.85
        assert len(item.analysis.build_ideas) == 3

    def test_with_signals(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
            signals=Signals(hn_points=200, hn_comments=55),
        )
        assert item.signals.hn_points == 200

    def test_with_tags(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
            tags=Tags(domains=["devtools", "agents"], languages=["Python"], maturity="beta"),
        )
        assert "devtools" in item.tags.domains
        assert item.tags.maturity == "beta"

    def test_with_scores(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
            scores=Scores(final_score=0.75, score_version="v1"),
        )
        assert item.scores.final_score == 0.75
        assert item.scores.score_version == "v1"

    def test_with_daily_pick(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
            daily_pick=DailyPickMeta(picked_for_date="2026-02-21", picked_rank=1),
        )
        assert item.daily_pick.picked_rank == 1

    def test_with_pairing(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
            pairing=Pairing(
                paired_with_ids=["def456"],
                pairing_rationale="Combine crawler + DB to build a data pipeline",
            ),
        )
        assert "def456" in item.pairing.paired_with_ids

    def test_published_at_optional(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
        )
        assert item.published_at is None

    def test_model_serializes_to_dict(self):
        item = ItemV1(
            id="abc123",
            source="hackernews",
            source_id="42",
            url="https://example.com",
            title="Test",
            collected_at="2026-02-21T00:00:00Z",
        )
        d = item.model_dump()
        assert d["id"] == "abc123"
        assert d["source"] == "hackernews"
        assert d["analysis"] is None
