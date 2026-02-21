from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any, Callable

import httpx

from github_digest.db.models import Repo

logger = logging.getLogger(__name__)


def fetch_latest_release(full_name: str, github_token: str | None = None) -> dict | None:
    """Fetch the latest release for a repo. Returns tag, date, and truncated body, or None."""
    url = f"https://api.github.com/repos/{full_name}/releases/latest"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "github-digest/0.1"}
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.get(url, headers=headers)
        if response.status_code in (404, 400):
            return None
        response.raise_for_status()
        data = response.json()
        tag = data.get("tag_name") or ""
        published_at = (data.get("published_at") or "")[:10]  # YYYY-MM-DD
        body = (data.get("body") or "").strip()
        # Strip HTML tags and markdown noise, collapse to plain single-line text
        body = re.sub(r"<[^>]+>", "", body)
        body = re.sub(r"#{1,6}\s+", "", body)
        body = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", body)
        body = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", body)
        body = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", body)
        body = re.sub(r"[\r\n]+", " ", body)
        body = re.sub(r"[ \t]+", " ", body)
        body = body.strip()
        # Truncate body to first 200 chars at a sentence/line boundary
        if len(body) > 200:
            cut = body[:200]
            for sep in (".\n", ". ", "\n", " "):
                idx = cut.rfind(sep)
                if idx > 80:
                    body = cut[: idx + 1].strip()
                    break
            else:
                body = cut.rstrip() + "…"
        return {"tag": tag, "published_at": published_at, "body": body} if tag else None
    except Exception as exc:
        logger.debug("fetch_latest_release error for %s: %s", full_name, exc)
        return None


def fetch_readme(full_name: str, github_token: str | None = None) -> str:
    """Fetch the README for a GitHub repo and return the first 4000 chars."""
    url = f"https://api.github.com/repos/{full_name}/readme"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "github-digest/0.1",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(url, headers=headers)
        if response.status_code == 404:
            return ""
        response.raise_for_status()
        data = response.json()
        content_b64 = data.get("content", "")
        # Base64 content may contain newlines; strip them before decoding
        decoded = base64.b64decode(content_b64.replace("\n", "")).decode("utf-8", errors="replace")
        return decoded[:2000]
    except Exception as exc:
        logger.debug("fetch_readme error for %s: %s", full_name, exc)
        return ""


def build_llm_prompt(repo: Repo, readme_content: str) -> str:
    """Build a prompt for the LLM to summarize a repository."""
    topics = repo.topics_json or []
    topics_str = ", ".join(topics) if topics else "none"
    description = repo.description or "No description provided."
    language = repo.language or "unknown"
    stars = repo.stars

    readme_section = readme_content.strip() if readme_content.strip() else "No README available."

    prompt = f"""Summarize this GitHub repo as JSON. Output ONLY the JSON object below, nothing else.

Repo: {repo.full_name} | Language: {language} | Stars: {stars}
Description: {description}
Topics: {topics_str}
README (truncated): {readme_section[:1500]}

Output this exact JSON structure (no markdown, no extra text):
{{"summary": "SENTENCE_1. SENTENCE_2.", "why_interesting": "SENTENCE.", "tags": ["tag1", "tag2", "tag3"]}}

Rules:
- summary: write EXACTLY 2 sentences (no more, no less) describing what the project is and does.
- why_interesting: write EXACTLY 1 sentence on why developers would care about this.
- tags: 3 to 6 lowercase single-word or hyphenated topic/tech keywords.
- End each sentence with a period.
- Output ONLY the JSON object, no explanations."""

    return prompt


def call_ollama(
    prompt: str,
    model: str = "llama3.2",
    base_url: str = "http://localhost:11434",
) -> dict[str, Any]:
    """Call the Ollama API and return parsed JSON from the response."""
    url = f"{base_url}/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "keep_alive": 0,          # unload model from memory immediately after inference
        "options": {
            "num_ctx": 1024,      # smaller context window = less RAM
            "num_predict": 200,   # cap output tokens to keep responses short
        },
    }

    with httpx.Client(timeout=300.0) as client:
        response = client.post(url, json=payload)
    response.raise_for_status()

    data = response.json()
    generated_text: str = data.get("response", "")

    # Attempt 1: find first { and last } and parse
    first_brace = generated_text.find("{")
    last_brace = generated_text.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidate = generated_text[first_brace : last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # Attempt 2: strip markdown code fences and try again
    stripped = generated_text
    for fence in ("```json", "```"):
        stripped = stripped.replace(fence, "")
    first_brace = stripped.find("{")
    last_brace = stripped.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidate = stripped[first_brace : last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not extract valid JSON from Ollama response: {generated_text[:200]!r}")


def make_llm_model_fn(
    github_token: str | None = None,
    ollama_model: str = "llama3.2",
    ollama_base_url: str = "http://localhost:11434",
) -> Callable[[Repo], dict[str, Any]]:
    """Return a model_fn(repo) -> dict suitable for use with summarize_repos."""

    def model_fn(repo: Repo) -> dict[str, Any]:
        readme_content = fetch_readme(repo.full_name, github_token)
        release = fetch_latest_release(repo.full_name, github_token)
        prompt = build_llm_prompt(repo, readme_content)
        payload = call_ollama(prompt, model=ollama_model, base_url=ollama_base_url)

        # Ensure tags is a list at this point
        tags = payload.get("tags", [])
        if not isinstance(tags, list):
            tags = []

        # Supplement with repo data if fewer than 3 tags
        if len(tags) < 3:
            extra: list[str] = []
            topics = repo.topics_json or []
            for t in topics:
                if t.lower() not in [x.lower() for x in tags]:
                    extra.append(t.lower())
            if repo.language and repo.language.lower() not in [x.lower() for x in tags + extra]:
                extra.append(repo.language.lower())
            tags = tags + extra
            # If still fewer than 3, pad with generic labels
            fallbacks = ["github", "open-source", "software"]
            for fb in fallbacks:
                if len(tags) >= 3:
                    break
                if fb not in tags:
                    tags.append(fb)

        # Post-process summary: clamp to exactly 2 sentences
        summary = payload.get("summary", "")
        sentences = [s.strip() for s in summary.replace("!",".",).replace("?",".").split(".") if s.strip()]
        if len(sentences) >= 2:
            summary = sentences[0] + ". " + sentences[1] + "."
        elif len(sentences) == 1:
            summary = sentences[0] + ". It is actively maintained on GitHub."
        payload["summary"] = summary[:580]

        # Post-process why_interesting: clamp to exactly 1 sentence
        why = payload.get("why_interesting", "")
        why_sentences = [s.strip() for s in why.replace("!",".",).replace("?",".").split(".") if s.strip()]
        if why_sentences:
            why = why_sentences[0] + "."
        payload["why_interesting"] = why

        payload["model"] = ollama_model
        payload["source"] = "readme-llm"
        payload["tags"] = json.dumps(tags[:6])
        if release:
            payload["latest_release_tag"] = release["tag"]
            body = release.get("body", "")
            payload["latest_release_summary"] = f"{release['published_at']}: {body}" if body else release["published_at"]
        else:
            payload["latest_release_tag"] = None
            payload["latest_release_summary"] = None

        return payload

    return model_fn
