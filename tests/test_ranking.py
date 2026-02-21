from __future__ import annotations

from github_digest.db.models import RadarItem
from github_digest.radar.ranking import (
    compute_buildability_score,
    compute_cool_score,
    compute_momentum_score,
    deduplicate_items,
    get_signals,
    score_item,
)


def make_radar_item(
    item_id="test_id",
    source="hackernews",
    source_id="12345",
    url="https://example.com",
    title="Test Item",
    github_full_name=None,
    signals_json=None,
    tags_json=None,
):
    """Helper to create RadarItem-like objects for testing."""
    item = RadarItem(
        id=item_id,
        source=source,
        source_id=source_id,
        url=url,
        title=title,
        github_full_name=github_full_name,
        signals_json=signals_json or {},
        tags_json=tags_json,
        scores_json=None,
    )
    return item


class TestGetSignals:
    def test_dict_signals_returned_directly(self):
        item = make_radar_item(signals_json={"hn_points": 100})
        assert get_signals(item) == {"hn_points": 100}

    def test_string_signals_parsed(self):
        import json
        item = make_radar_item()
        item.signals_json = json.dumps({"hn_points": 50})
        assert get_signals(item) == {"hn_points": 50}

    def test_none_signals_returns_empty(self):
        item = make_radar_item()
        item.signals_json = None
        assert get_signals(item) == {}

    def test_invalid_string_returns_empty(self):
        item = make_radar_item()
        item.signals_json = "not valid json"
        assert get_signals(item) == {}


class TestComputeMomentumScore:
    def test_zero_points_returns_zero(self):
        item = make_radar_item(signals_json={"hn_points": 0})
        assert compute_momentum_score(item) == 0.0

    def test_high_points_returns_positive(self):
        item = make_radar_item(signals_json={"hn_points": 500})
        score = compute_momentum_score(item)
        assert score > 0
        assert score <= 1.0

    def test_with_velocity_adds_to_score(self):
        item_no_vel = make_radar_item(signals_json={"hn_points": 100})
        item_with_vel = make_radar_item(signals_json={"hn_points": 100, "github_velocity": 50})
        assert compute_momentum_score(item_with_vel) > compute_momentum_score(item_no_vel)

    def test_score_clamped_to_1(self):
        item = make_radar_item(signals_json={"hn_points": 10000, "github_velocity": 1000})
        assert compute_momentum_score(item) <= 1.0

    def test_score_non_negative(self):
        item = make_radar_item(signals_json={"hn_points": -10})
        assert compute_momentum_score(item) >= 0.0

    def test_log_scale_used_for_hn_points(self):
        # 1000 points should yield log(1000)/log(1000) = 1.0 from HN portion alone
        item = make_radar_item(signals_json={"hn_points": 1000})
        score = compute_momentum_score(item)
        # With 1000 points: log(1000)/log(1000) = 1.0, velocity=0, final=min(1.0,1.0)=1.0
        assert abs(score - 1.0) < 0.001

    def test_empty_signals_returns_zero(self):
        item = make_radar_item(signals_json={})
        assert compute_momentum_score(item) == 0.0


class TestComputeCoolScore:
    def test_baseline_score_is_0_5(self):
        item = make_radar_item(tags_json=None)
        assert compute_cool_score(item) == 0.5

    def test_tags_with_domains_adds_bonus(self):
        item = make_radar_item(tags_json={"domains": ["devtools"], "languages": []})
        assert compute_cool_score(item) > 0.5

    def test_tags_with_languages_adds_bonus(self):
        item = make_radar_item(tags_json={"domains": [], "languages": ["Python"]})
        assert compute_cool_score(item) > 0.5

    def test_empty_tags_dict_no_bonus(self):
        item = make_radar_item(tags_json={"domains": [], "languages": []})
        assert compute_cool_score(item) == 0.5

    def test_score_clamped_to_1(self):
        item = make_radar_item(tags_json={"domains": ["a", "b", "c"], "languages": ["Python"]})
        assert compute_cool_score(item) <= 1.0


class TestComputeBuildabilityScore:
    def test_github_item_higher_than_non_github(self):
        github_item = make_radar_item(github_full_name="owner/repo", signals_json={"hn_points": 0})
        non_github_item = make_radar_item(github_full_name=None, signals_json={"hn_points": 0})
        assert (
            compute_buildability_score(github_item) > compute_buildability_score(non_github_item)
        )

    def test_long_title_bonus(self):
        short_title = make_radar_item(item_id="a", github_full_name="o/r", title="Short")
        long_title = make_radar_item(
            item_id="b",
            github_full_name="o/r",
            title="A very long descriptive title that exceeds twenty chars",
        )
        assert compute_buildability_score(long_title) > compute_buildability_score(short_title)

    def test_high_stars_adds_bonus(self):
        no_stars = make_radar_item(
            item_id="a", github_full_name="o/r", signals_json={"github_stars_total": 0}
        )
        with_stars = make_radar_item(
            item_id="b", github_full_name="o/r", signals_json={"github_stars_total": 500}
        )
        assert compute_buildability_score(with_stars) > compute_buildability_score(no_stars)

    def test_high_hn_points_adds_bonus(self):
        no_pts = make_radar_item(item_id="a", github_full_name=None, signals_json={"hn_points": 0})
        with_pts = make_radar_item(item_id="b", github_full_name=None, signals_json={"hn_points": 50})
        assert compute_buildability_score(with_pts) > compute_buildability_score(no_pts)

    def test_score_clamped_to_1(self):
        item = make_radar_item(
            github_full_name="owner/repo",
            title="An extremely descriptive title that is very long",
            signals_json={"github_stars_total": 10000, "hn_points": 1000},
        )
        assert compute_buildability_score(item) <= 1.0

    def test_score_non_negative(self):
        item = make_radar_item(signals_json={})
        assert compute_buildability_score(item) >= 0.0


class TestDeduplicateItems:
    def test_same_github_full_name_deduplicated(self):
        item1 = make_radar_item(item_id="id1", source="github", source_id="r1", github_full_name="owner/repo", signals_json={"hn_points": 100})
        item2 = make_radar_item(item_id="id2", source="hackernews", source_id="hn1", github_full_name="owner/repo", signals_json={"hn_points": 250})
        result = deduplicate_items([item1, item2])
        assert len(result) == 1

    def test_different_github_repos_kept(self):
        item1 = make_radar_item(
            item_id="id1", source="github", source_id="r1",
            url="https://github.com/owner/repo1",
            github_full_name="owner/repo1",
        )
        item2 = make_radar_item(
            item_id="id2", source="github", source_id="r2",
            url="https://github.com/owner/repo2",
            github_full_name="owner/repo2",
        )
        result = deduplicate_items([item1, item2])
        assert len(result) == 2

    def test_merge_keeps_max_hn_points(self):
        item1 = make_radar_item(item_id="id1", github_full_name="owner/repo", signals_json={"hn_points": 100})
        item2 = make_radar_item(item_id="id2", github_full_name="owner/repo", signals_json={"hn_points": 250})
        result = deduplicate_items([item1, item2])
        signals = get_signals(result[0])
        assert signals.get("hn_points") == 250

    def test_same_url_deduplicated(self):
        item1 = make_radar_item(item_id="id1", source="hn", source_id="1", url="https://example.com/tool")
        item2 = make_radar_item(item_id="id2", source="rss", source_id="2", url="https://example.com/tool")
        result = deduplicate_items([item1, item2])
        assert len(result) == 1

    def test_tracking_params_normalized_for_dedup(self):
        item1 = make_radar_item(item_id="id1", source="hn", source_id="1", url="https://example.com/tool?ref=hn")
        item2 = make_radar_item(item_id="id2", source="rss", source_id="2", url="https://example.com/tool?utm_source=twitter")
        result = deduplicate_items([item1, item2])
        assert len(result) == 1

    def test_empty_list(self):
        assert deduplicate_items([]) == []

    def test_single_item(self):
        item = make_radar_item()
        result = deduplicate_items([item])
        assert len(result) == 1

    def test_github_full_name_propagated_when_merged(self):
        item_no_gh = make_radar_item(
            item_id="id1", source="hn", source_id="1",
            github_full_name=None, url="https://github.com/owner/repo",
            signals_json={"hn_points": 200},
        )
        item_with_gh = make_radar_item(
            item_id="id2", source="github", source_id="2",
            github_full_name="owner/repo", url="https://github.com/owner/repo",
            signals_json={"hn_points": 50},
        )
        result = deduplicate_items([item_no_gh, item_with_gh])
        assert len(result) == 1
        # The first item was kept; the second merged into it, propagating github_full_name
        assert result[0].github_full_name == "owner/repo"

    def test_same_source_and_source_id_deduplicated(self):
        item1 = make_radar_item(item_id="id1", source="hn", source_id="99", url="https://a.com")
        item2 = make_radar_item(item_id="id2", source="hn", source_id="99", url="https://b.com")
        result = deduplicate_items([item1, item2])
        assert len(result) == 1


class TestScoreItem:
    def test_returns_all_score_fields(self):
        item = make_radar_item(signals_json={"hn_points": 100})
        weights = {"momentum": 0.5, "cool": 0.3, "buildability": 0.2}
        scores = score_item(item, weights)
        assert "momentum_score" in scores
        assert "cool_score" in scores
        assert "buildability_score" in scores
        assert "final_score" in scores
        assert scores["score_version"] == "v1"

    def test_final_score_is_weighted_sum(self):
        item = make_radar_item(signals_json={"hn_points": 0})
        weights = {"momentum": 0.5, "cool": 0.3, "buildability": 0.2}
        scores = score_item(item, weights)
        expected_final = 0.5 * scores["momentum_score"] + 0.3 * scores["cool_score"] + 0.2 * scores["buildability_score"]
        assert abs(scores["final_score"] - round(expected_final, 4)) < 0.001

    def test_default_weights_used_when_missing(self):
        item = make_radar_item(signals_json={"hn_points": 100})
        # score_item should handle missing keys gracefully with defaults
        scores = score_item(item, {})
        assert "final_score" in scores
        assert scores["final_score"] >= 0.0

    def test_score_version_is_v1(self):
        item = make_radar_item(signals_json={})
        scores = score_item(item, {"momentum": 0.5, "cool": 0.3, "buildability": 0.2})
        assert scores["score_version"] == "v1"

    def test_scores_are_rounded_to_4_decimal_places(self):
        item = make_radar_item(signals_json={"hn_points": 123})
        weights = {"momentum": 0.5, "cool": 0.3, "buildability": 0.2}
        scores = score_item(item, weights)
        for field in ("momentum_score", "cool_score", "buildability_score", "final_score"):
            val = scores[field]
            assert val == round(val, 4), f"{field} not rounded to 4 decimal places"

    def test_high_hn_points_increases_final_score(self):
        low_item = make_radar_item(item_id="a", signals_json={"hn_points": 10})
        high_item = make_radar_item(item_id="b", signals_json={"hn_points": 800})
        weights = {"momentum": 0.5, "cool": 0.3, "buildability": 0.2}
        assert score_item(high_item, weights)["final_score"] > score_item(low_item, weights)["final_score"]
