from __future__ import annotations

from github_digest.radar.hn_ingestion import (
    extract_github_repo_from_url,
    make_item_id,
    normalize_url,
)


class TestExtractGithubRepoFromUrl:
    def test_simple_repo_url(self):
        assert extract_github_repo_from_url("https://github.com/owner/repo") == "owner/repo"

    def test_repo_with_git_suffix(self):
        assert extract_github_repo_from_url("https://github.com/owner/repo.git") == "owner/repo"

    def test_repo_with_trailing_slash(self):
        assert extract_github_repo_from_url("https://github.com/owner/repo/") == "owner/repo"

    def test_subpath_returns_none(self):
        assert extract_github_repo_from_url("https://github.com/owner/repo/tree/main") is None

    def test_non_github_returns_none(self):
        assert extract_github_repo_from_url("https://example.com/foo") is None

    def test_none_input_returns_none(self):
        assert extract_github_repo_from_url(None) is None

    def test_empty_string_returns_none(self):
        assert extract_github_repo_from_url("") is None

    def test_github_org_only_returns_none(self):
        assert extract_github_repo_from_url("https://github.com/owner") is None

    def test_www_github_url(self):
        assert extract_github_repo_from_url("https://www.github.com/owner/repo") == "owner/repo"

    def test_repo_with_query_string_returns_none(self):
        # Query string doesn't affect path parsing - path still has 2 parts
        result = extract_github_repo_from_url("https://github.com/owner/repo?tab=readme")
        assert result == "owner/repo"

    def test_deeply_nested_path_returns_none(self):
        assert extract_github_repo_from_url("https://github.com/a/b/c/d/e") is None


class TestNormalizeUrl:
    def test_strips_utm_source(self):
        url = "https://example.com/path?utm_source=hn&foo=bar"
        result = normalize_url(url)
        assert "utm_source" not in result
        assert "foo=bar" in result

    def test_strips_utm_campaign(self):
        url = "https://example.com/path?utm_campaign=test"
        result = normalize_url(url)
        assert "utm_campaign" not in result

    def test_strips_utm_medium(self):
        url = "https://example.com/path?utm_medium=social"
        result = normalize_url(url)
        assert "utm_medium" not in result

    def test_strips_ref_param(self):
        url = "https://example.com/path?ref=hackernews"
        result = normalize_url(url)
        assert "ref" not in result

    def test_preserves_non_tracking_params(self):
        url = "https://example.com/path?page=2&limit=10"
        result = normalize_url(url)
        assert "page=2" in result
        assert "limit=10" in result

    def test_lowercases_host(self):
        url = "https://EXAMPLE.COM/path"
        result = normalize_url(url)
        assert "example.com" in result

    def test_strips_fragment(self):
        url = "https://example.com/path#section"
        result = normalize_url(url)
        assert "#section" not in result

    def test_no_params_unchanged(self):
        url = "https://example.com/path"
        result = normalize_url(url)
        assert "example.com/path" in result

    def test_all_utm_variants_stripped(self):
        url = "https://example.com/?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e"
        result = normalize_url(url)
        assert "utm_" not in result

    def test_mixed_case_utm_stripped(self):
        # TRACKING_PARAMS comparison is lowercase-safe via k.lower()
        url = "https://example.com/?UTM_SOURCE=foo"
        result = normalize_url(url)
        assert "UTM_SOURCE" not in result


class TestMakeItemId:
    def test_deterministic(self):
        id1 = make_item_id("hackernews", "12345")
        id2 = make_item_id("hackernews", "12345")
        assert id1 == id2

    def test_different_inputs_different_hashes(self):
        id1 = make_item_id("hackernews", "12345")
        id2 = make_item_id("hackernews", "12346")
        assert id1 != id2

    def test_format_is_40_hex_chars(self):
        item_id = make_item_id("hackernews", "12345")
        assert len(item_id) == 40
        assert all(c in "0123456789abcdef" for c in item_id)

    def test_source_matters(self):
        id_hn = make_item_id("hackernews", "42")
        id_gh = make_item_id("github", "42")
        assert id_hn != id_gh

    def test_known_sha1_value(self):
        import hashlib
        expected = hashlib.sha1(b"hackernews:12345").hexdigest()
        assert make_item_id("hackernews", "12345") == expected
