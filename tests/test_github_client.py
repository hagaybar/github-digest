import httpx

from github_digest.services.github_client import GitHubClient


def test_github_client_builds_expected_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/search/repositories"
        assert request.url.params["q"] == "topic:llm"
        assert request.url.params["per_page"] == "5"
        return httpx.Response(200, json={"items": []})

    transport = httpx.MockTransport(handler)
    client = GitHubClient(client=httpx.Client(transport=transport))

    response = client.search_repositories("topic:llm", per_page=5)
    assert response["items"] == []
