from __future__ import annotations

import pytest

from github_digest.radar.reddit_ingestion import (
    DEFAULT_SUBREDDITS,
    fetch_reddit_posts,
    post_to_radar_item_data,
)


class TestDefaultSubreddits:
    def test_default_subreddits_list(self):
        assert "SideProject" in DEFAULT_SUBREDDITS
        assert "coolgithubprojects" in DEFAULT_SUBREDDITS
        assert isinstance(DEFAULT_SUBREDDITS, list)
        assert len(DEFAULT_SUBREDDITS) >= 2


class TestPostToRadarItemData:
    def _make_post(self, **overrides) -> dict:
        base = {
            "id": "abc123",
            "title": "Cool open-source project",
            "url": "https://github.com/owner/repo",
            "score": 42,
            "num_comments": 10,
            "created_utc": 1700000000.0,
            "is_self": False,
        }
        base.update(overrides)
        return base

    def test_basic_conversion(self):
        post = self._make_post()
        result = post_to_radar_item_data(post, "SideProject")
        assert result is not None
        assert result["source"] == "reddit"
        assert result["source_id"] == "abc123"
        assert result["url"] == "https://github.com/owner/repo"
        assert result["title"] == "Cool open-source project"

    def test_github_full_name_extracted(self):
        post = self._make_post(url="https://github.com/myorg/myrepo")
        result = post_to_radar_item_data(post, "SideProject")
        assert result is not None
        assert result["github_full_name"] == "myorg/myrepo"

    def test_non_github_url_has_no_full_name(self):
        post = self._make_post(url="https://example.com/my-project")
        result = post_to_radar_item_data(post, "SideProject")
        assert result is not None
        assert result["github_full_name"] is None

    def test_signals_include_reddit_score(self):
        post = self._make_post(score=99, num_comments=7)
        result = post_to_radar_item_data(post, "coolgithubprojects")
        assert result is not None
        assert result["signals_json"]["reddit_score"] == 99
        assert result["signals_json"]["reddit_comments"] == 7
        assert result["signals_json"]["subreddit"] == "coolgithubprojects"

    def test_published_at_parsed_from_created_utc(self):
        post = self._make_post(created_utc=1700000000.0)
        result = post_to_radar_item_data(post, "SideProject")
        assert result is not None
        assert result["published_at"] is not None

    def test_missing_url_returns_none(self):
        post = self._make_post(url=None)
        result = post_to_radar_item_data(post, "SideProject")
        assert result is None

    def test_missing_title_returns_none(self):
        post = self._make_post(title="")
        result = post_to_radar_item_data(post, "SideProject")
        assert result is None

    def test_item_id_deterministic(self):
        post = self._make_post()
        r1 = post_to_radar_item_data(post, "SideProject")
        r2 = post_to_radar_item_data(post, "SideProject")
        assert r1 is not None and r2 is not None
        assert r1["id"] == r2["id"]

    def test_item_id_differs_by_post_id(self):
        p1 = self._make_post(id="aaa")
        p2 = self._make_post(id="bbb")
        r1 = post_to_radar_item_data(p1, "SideProject")
        r2 = post_to_radar_item_data(p2, "SideProject")
        assert r1 is not None and r2 is not None
        assert r1["id"] != r2["id"]

    def test_github_subpath_not_extracted(self):
        post = self._make_post(url="https://github.com/owner/repo/issues/42")
        result = post_to_radar_item_data(post, "SideProject")
        assert result is not None
        assert result["github_full_name"] is None
