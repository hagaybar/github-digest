from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from github_digest.db.database import get_engine
from github_digest.radar.ranking import load_radar_config

logger = logging.getLogger(__name__)


def build_item_context(item_row: dict) -> str:
    """Build a text context bundle from an item dict for LLM input."""
    parts = []
    parts.append(f"Title: {item_row.get('title', 'Unknown')}")
    parts.append(f"URL: {item_row.get('url', '')}")

    if item_row.get("github_full_name"):
        parts.append(f"GitHub repo: {item_row['github_full_name']}")

    signals = item_row.get("signals_json") or {}
    if isinstance(signals, str):
        try:
            signals = json.loads(signals)
        except Exception:
            signals = {}

    signal_parts = []
    if signals.get("hn_points"):
        signal_parts.append(f"HN points: {signals['hn_points']}")
    if signals.get("hn_comments"):
        signal_parts.append(f"HN comments: {signals['hn_comments']}")
    if signals.get("github_stars_total"):
        signal_parts.append(f"GitHub stars: {signals['github_stars_total']}")
    if signal_parts:
        parts.append("Signals: " + ", ".join(signal_parts))

    tags = item_row.get("tags_json") or {}
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except Exception:
            tags = {}
    if isinstance(tags, dict) and tags:
        if tags.get("domains"):
            parts.append(f"Domains: {', '.join(tags['domains'])}")
        if tags.get("languages"):
            parts.append(f"Languages: {', '.join(tags['languages'])}")

    return "\n".join(parts)[:500]  # Cap at 500 chars


_IDEA_TEMPLATE = (
    '{{"size": "{sz}", "idea": "<project idea>",'
    ' "steps": ["<step1>", "<step2>"], "prerequisites": ["<prereq>"]}}'
)
_ANALYSIS_PROMPT_TEMPLATE = """\
You are a senior developer and technical curator helping builders discover useful tools.

Analyze this tool/project and provide a structured JSON response.

---
{context}
---

Rules:
- No marketing fluff. Be concrete and honest.
- best_start must be a real pointer (README section name, file path, or demo URL).
  If unknown, use "README: Quickstart".
- build_ideas must be exactly 3 items with sizes: one "small", one "medium", one "spicy".
- Be specific and actionable.

Respond ONLY with valid JSON (no markdown code blocks, no explanation):
{{
  "unlock": "<1 sentence: what does this unlock for a builder>",
  "novelty": "<1 sentence: what is genuinely novel about this>",
  "why_cool": ["<bullet 1>", "<bullet 2>", "<bullet 3>"],
  "best_start": "<file path / README section / demo URL>",
  "build_ideas": [
    {small},
    {medium},
    {spicy}
  ],
  "confidence": 0.8
}}"""


def make_analysis_prompt(context: str) -> str:
    """Build the structured analysis prompt for the LLM."""
    return _ANALYSIS_PROMPT_TEMPLATE.format(
        context=context,
        small=_IDEA_TEMPLATE.format(sz="small"),
        medium=_IDEA_TEMPLATE.format(sz="medium"),
        spicy=_IDEA_TEMPLATE.format(sz="spicy"),
    )


def parse_analysis_response(response_text: str) -> dict | None:
    """Parse and validate LLM JSON response. Returns dict or None."""
    text_clean = response_text.strip()
    # Strip markdown code blocks
    text_clean = re.sub(r'^```(?:json)?\s*', '', text_clean, flags=re.MULTILINE)
    text_clean = re.sub(r'\s*```$', '', text_clean, flags=re.MULTILINE)
    text_clean = text_clean.strip()

    try:
        data = json.loads(text_clean)
    except json.JSONDecodeError:
        # Try to extract JSON object
        match = re.search(r'\{.*\}', text_clean, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
            except Exception:
                return None
        else:
            return None

    # Validate required fields
    required = {"unlock", "novelty", "why_cool", "best_start", "build_ideas", "confidence"}
    if not all(k in data for k in required):
        return None

    # Validate build_ideas
    build_ideas = data.get("build_ideas", [])
    if not isinstance(build_ideas, list) or len(build_ideas) != 3:
        return None
    for idea in build_ideas:
        if not isinstance(idea, dict) or "size" not in idea or "idea" not in idea:
            return None

    return data


def analyze_item_with_ollama(
    item_row: dict,
    ollama_base_url: str,
    model: str,
) -> dict | None:
    """Call Ollama to get structured analysis for an item."""
    context = build_item_context(item_row)
    prompt = make_analysis_prompt(context)

    payload = {"model": model, "prompt": prompt, "stream": False}

    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(f"{ollama_base_url}/api/generate", json=payload)
            resp.raise_for_status()
            response_text = resp.json().get("response", "")
    except Exception as e:
        logger.error("Ollama API error for item %s: %s", item_row.get("id"), e)
        return None

    result = parse_analysis_response(response_text)
    if result is not None:
        return result

    # Retry once with fix prompt
    fix_prompt = (
        f"Fix the following JSON to be valid and return ONLY the fixed JSON:\n{response_text}"
    )
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                f"{ollama_base_url}/api/generate",
                json={"model": model, "prompt": fix_prompt, "stream": False},
            )
            resp.raise_for_status()
            fixed_text = resp.json().get("response", "")
            result = parse_analysis_response(fixed_text)
            if result:
                return result
    except Exception as e:
        logger.error("Ollama retry error for item %s: %s", item_row.get("id"), e)

    logger.error("Failed to parse LLM analysis for item %s after retry", item_row.get("id"))
    return None


def analyze_daily_picks(
    db_path: Path,
    config_path: Path,
    date_str: str | None = None,
    enable_llm: bool = False,
) -> dict:
    """Generate LLM analysis for daily pick items. Returns stats dict."""
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    config = load_radar_config(config_path)
    top_k = config.get("ranking", {}).get("top_k_for_llm", 30)
    llm_cfg = config.get("llm", {})
    ollama_base_url = llm_cfg.get("ollama_base_url", "http://localhost:11434")
    model = llm_cfg.get("model", "llama3.2")

    engine = get_engine(db_path)
    analyzed = 0
    total = 0

    with Session(engine) as session:
        # Get top_k items for the date (from daily_picks, ranked)
        rows = session.execute(
            text("""
                SELECT ri.id, ri.source, ri.source_id, ri.url, ri.title,
                       ri.github_full_name, ri.signals_json, ri.tags_json
                FROM daily_picks dp
                JOIN radar_items ri ON dp.item_id = ri.id
                WHERE dp.date = :date
                ORDER BY dp.rank ASC
                LIMIT :top_k
            """),
            {"date": date_str, "top_k": top_k},
        ).fetchall()

        total = len(rows)
        logger.info("Analyzing %d items for %s (LLM enabled: %s)", total, date_str, enable_llm)

        for row in rows:
            item_id = row[0]

            # Skip if already analyzed
            existing = session.execute(
                text(
                    "SELECT id FROM radar_item_analysis"
                    " WHERE item_id = :id AND analysis_version = 'v1'"
                ),
                {"id": item_id},
            ).first()
            if existing:
                analyzed += 1
                continue

            item_row = {
                "id": row[0], "source": row[1], "source_id": row[2],
                "url": row[3], "title": row[4],
                "github_full_name": row[5],
                "signals_json": row[6],
                "tags_json": row[7],
            }

            if enable_llm:
                analysis_data = analyze_item_with_ollama(item_row, ollama_base_url, model)
            else:
                analysis_data = None

            # Upsert analysis record
            session.execute(
                text("""
                    INSERT OR IGNORE INTO radar_item_analysis
                      (item_id, analysis_version, analysis_json, created_at)
                    VALUES (:item_id, 'v1', :analysis_json, :created_at)
                """),
                {
                    "item_id": item_id,
                    "analysis_version": "v1",
                    "analysis_json": json.dumps(analysis_data) if analysis_data else None,
                    "created_at": datetime.now(UTC).isoformat(),
                },
            )

            if analysis_data:
                analyzed += 1

        session.commit()

    logger.info("Analyzed %d/%d items for %s", analyzed, total, date_str)
    return {"analyzed": analyzed, "total": total, "date": date_str, "llm_enabled": enable_llm}
