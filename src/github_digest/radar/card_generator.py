from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy import text
from sqlalchemy.engine import Engine
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


def analyze_item_with_ollama_timeout(
    item_row: dict,
    ollama_base_url: str,
    model: str,
    timeout_seconds: int = 300,
) -> dict | None:
    """Call Ollama with configurable timeout.

    Raises RuntimeError on Ollama connection failure.
    Returns dict on success, None if response cannot be parsed.
    """
    context = build_item_context(item_row)
    prompt = make_analysis_prompt(context)
    payload = {"model": model, "prompt": prompt, "stream": False}

    try:
        with httpx.Client(timeout=timeout_seconds) as client:
            resp = client.post(f"{ollama_base_url}/api/generate", json=payload)
            resp.raise_for_status()
            response_text = resp.json().get("response", "")
    except httpx.ConnectError as e:
        raise RuntimeError(f"Ollama connection failed at {ollama_base_url}: {e}") from e
    except Exception as e:
        logger.error("Ollama API error for item %s: %s", item_row.get("id"), e)
        return None

    result = parse_analysis_response(response_text)
    if result is not None:
        return result

    # Retry once with fix prompt (shorter timeout)
    fix_prompt = (
        f"Fix the following JSON to be valid and return ONLY the fixed JSON:\n{response_text}"
    )
    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(
                f"{ollama_base_url}/api/generate",
                json={"model": model, "prompt": fix_prompt, "stream": False},
            )
            resp.raise_for_status()
            fixed_text = resp.json().get("response", "")
            result = parse_analysis_response(fixed_text)
            if result:
                return result
    except httpx.ConnectError as e:
        raise RuntimeError(f"Ollama connection failed at {ollama_base_url}: {e}") from e
    except Exception as e:
        logger.error("Ollama retry error for item %s: %s", item_row.get("id"), e)

    logger.error("Failed to parse LLM analysis for item %s after retry", item_row.get("id"))
    return None


def analyze_item_with_ollama(
    item_row: dict,
    ollama_base_url: str,
    model: str,
) -> dict | None:
    """Legacy wrapper: call Ollama with 180s timeout, return None on any error."""
    try:
        return analyze_item_with_ollama_timeout(item_row, ollama_base_url, model, timeout_seconds=180)
    except RuntimeError as e:
        logger.error("Ollama connection error for item %s: %s", item_row.get("id"), e)
        return None


def _mark_completed(engine: Engine, analysis_id: int, analysis_data: dict) -> None:
    """Write analysis result and mark row as completed."""
    with engine.begin() as conn:
        conn.execute(
            text("""
                UPDATE radar_item_analysis
                SET status='completed', analysis_json=:analysis_json, error_message=NULL
                WHERE id=:id
            """),
            {"id": analysis_id, "analysis_json": json.dumps(analysis_data)},
        )


def _mark_failed(engine: Engine, analysis_id: int, error_message: str) -> None:
    """Mark row as failed with error message."""
    with engine.begin() as conn:
        conn.execute(
            text("""
                UPDATE radar_item_analysis
                SET status='failed', error_message=:error_message
                WHERE id=:id
            """),
            {"id": analysis_id, "error_message": error_message},
        )


def populate_analysis_queue(
    db_path: Path,
    config_path: Path,
    date_str: str | None = None,
) -> dict:
    """Fast queue population: create pending rows for daily picks, no LLM calls.

    Uses INSERT OR IGNORE so existing rows (any status) are not disturbed.
    Returns immediately — no Ollama calls.
    """
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    config = load_radar_config(config_path)
    top_k = config.get("ranking", {}).get("top_k_for_llm", 30)

    engine = get_engine(db_path)
    now = datetime.now(UTC).isoformat()

    with engine.begin() as conn:
        result = conn.execute(
            text("""
                INSERT OR IGNORE INTO radar_item_analysis
                    (item_id, analysis_version, status, attempts, created_at)
                SELECT dp.item_id, 'v1', 'pending', 0, :now
                FROM daily_picks dp
                WHERE dp.date = :date
                ORDER BY dp.rank ASC
                LIMIT :top_k
            """),
            {"date": date_str, "now": now, "top_k": top_k},
        )
        queued = result.rowcount

    logger.info("Queued %d new items for analysis on %s", queued, date_str)
    return {"queued": queued, "date": date_str}


def run_analyze_worker(
    db_path: Path,
    config_path: Path,
    date_str: str | None = None,
    watch: bool = False,
) -> dict:
    """Background worker: picks up pending analysis items one-by-one and calls Ollama.

    - Resets stale processing locks on startup.
    - Claims items atomically (UPDATE + rowcount check) to allow double-start safety.
    - Logs per-item progress.
    - When all items are terminal, calls pair_daily() in-process, then exits.
    - With watch=True, keeps polling for new items instead of exiting.
    """
    import time

    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    config = load_radar_config(config_path)
    llm_cfg = config.get("llm", {})
    worker_cfg = config.get("worker", {})

    ollama_base_url = llm_cfg.get("ollama_base_url", "http://localhost:11434")
    model = llm_cfg.get("model", "llama3.2")
    max_attempts = worker_cfg.get("max_attempts", 3)
    timeout_seconds = worker_cfg.get("timeout_seconds", 300)
    stale_timeout_minutes = worker_cfg.get("stale_timeout_minutes", 10)

    engine = get_engine(db_path)
    processed = 0

    def reset_stale_locks() -> int:
        cutoff = (datetime.now(UTC) - timedelta(minutes=stale_timeout_minutes)).isoformat()
        with engine.begin() as conn:
            result = conn.execute(
                text("""
                    UPDATE radar_item_analysis
                    SET status='pending'
                    WHERE status='processing' AND started_at < :cutoff
                """),
                {"cutoff": cutoff},
            )
            count = result.rowcount
        if count > 0:
            logger.info("Reset %d stale processing locks", count)
        return count

    def get_total_count() -> int:
        with engine.begin() as conn:
            return conn.execute(
                text("""
                    SELECT COUNT(*) FROM radar_item_analysis ria
                    JOIN daily_picks dp ON dp.item_id = ria.item_id AND dp.date = :date
                """),
                {"date": date_str},
            ).scalar() or 0

    reset_stale_locks()
    total_count = get_total_count()
    logger.info("Starting worker for %s: %d items in queue", date_str, total_count)

    # Heartbeat helper (imported lazily to avoid circular import)
    _own_pid = os.getpid() if hasattr(__import__("os"), "getpid") else 0
    def _write_hb(current_title: str) -> None:
        try:
            from github_digest.services.orchestrator import write_heartbeat
            write_heartbeat(date_str, _own_pid, processed, total_count, current_title)
        except Exception:
            pass  # heartbeat is best-effort

    while True:
        reset_stale_locks()
        now = datetime.now(UTC).isoformat()
        analysis_id = None

        # Find and claim one pending/failed item atomically
        with engine.begin() as conn:
            candidate = conn.execute(
                text("""
                    SELECT ria.id FROM radar_item_analysis ria
                    JOIN daily_picks dp ON dp.item_id = ria.item_id AND dp.date = :date
                    WHERE ria.status IN ('pending', 'failed') AND ria.attempts < :max_attempts
                    ORDER BY ria.id ASC LIMIT 1
                """),
                {"date": date_str, "max_attempts": max_attempts},
            ).fetchone()

            if candidate:
                result = conn.execute(
                    text("""
                        UPDATE radar_item_analysis
                        SET status='processing', started_at=:now, attempts=attempts+1
                        WHERE id=:id AND status IN ('pending', 'failed') AND attempts < :max_attempts
                    """),
                    {"id": candidate[0], "now": now, "max_attempts": max_attempts},
                )
                if result.rowcount == 1:
                    analysis_id = candidate[0]

        if analysis_id is None:
            if watch:
                logger.info("No items to process. Watching for new items (30s)...")
                time.sleep(30)
                continue
            break

        # Fetch full item data for the claimed row
        with engine.begin() as conn:
            row = conn.execute(
                text("""
                    SELECT ria.id, ria.item_id, ria.attempts,
                           ri.title, ri.url, ri.source, ri.github_full_name,
                           ri.signals_json, ri.tags_json
                    FROM radar_item_analysis ria
                    JOIN radar_items ri ON ria.item_id = ri.id
                    WHERE ria.id = :id
                """),
                {"id": analysis_id},
            ).fetchone()

        if not row:
            logger.warning("Could not fetch claimed row id=%d", analysis_id)
            continue

        title = row[3]
        attempts_num = row[2]
        processed += 1
        logger.info("[%d/%d] ⏳ Analyzing %r (attempt %d)...", processed, total_count, title, attempts_num)
        _write_hb(title)  # heartbeat: item claimed, about to call Ollama
        t0 = datetime.now(UTC)

        item_row = {
            "id": row[1],
            "title": row[3],
            "url": row[4],
            "source": row[5],
            "github_full_name": row[6],
            "signals_json": row[7],
            "tags_json": row[8],
        }

        try:
            analysis = analyze_item_with_ollama_timeout(
                item_row, ollama_base_url, model, timeout_seconds
            )
            elapsed = (datetime.now(UTC) - t0).total_seconds()
            if analysis:
                _mark_completed(engine, analysis_id, analysis)
                logger.info("[%d/%d] ✓ Done (%.0fs)", processed, total_count, elapsed)
                _write_hb(f"✓ {title}")  # heartbeat: item done
            else:
                _mark_failed(engine, analysis_id, "Failed to parse LLM response after retry")
                logger.warning("[%d/%d] ✗ Parse failed (%.0fs)", processed, total_count, elapsed)
                _write_hb(f"✗ {title}")
        except RuntimeError as e:
            elapsed = (datetime.now(UTC) - t0).total_seconds()
            _mark_failed(engine, analysis_id, str(e))
            logger.error("[%d/%d] ✗ Error (%.0fs): %s", processed, total_count, elapsed, e)
            _write_hb(f"✗ {title}")

    # After loop: check if all items are terminal
    with engine.begin() as conn:
        non_terminal = conn.execute(
            text("""
                SELECT COUNT(*) FROM radar_item_analysis ria
                JOIN daily_picks dp ON dp.item_id = ria.item_id AND dp.date = :date
                WHERE ria.status IN ('pending', 'processing')
            """),
            {"date": date_str},
        ).scalar() or 0

    if non_terminal == 0 and not watch:
        logger.info("All items processed for %s. Running pair_daily...", date_str)
        try:
            from github_digest.radar.pairing import pair_daily
            pair_result = pair_daily(db_path, date_str=date_str)
            logger.info("Pairing result: %s", pair_result)
        except Exception as e:
            logger.error("pair_daily failed after worker completion: %s", e)
    elif non_terminal > 0:
        logger.info(
            "Worker done. %d items still non-terminal (another worker may be running).",
            non_terminal,
        )

    return {"processed": processed, "date": date_str}


def analyze_daily_picks(
    db_path: Path,
    config_path: Path,
    date_str: str | None = None,
    enable_llm: bool = False,
) -> dict:
    """Deprecated: use populate_analysis_queue() + analyze-worker instead.

    Now simply calls populate_analysis_queue() to create pending rows.
    The enable_llm parameter is ignored.
    """
    logger.warning(
        "analyze_daily_picks() is deprecated; use populate_analysis_queue() + analyze-worker"
    )
    return populate_analysis_queue(db_path, config_path, date_str=date_str)
