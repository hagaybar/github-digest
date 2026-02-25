"""
orchestrator.py — Production orchestrator for the Builder Radar daily pipeline.

Provides:
  run_orchestrate_daily()  — prerequisites check, flock, pipeline steps, worker PID guard
  get_orchestrate_status() — live status: API, Ollama, worker, analyze queue
  check_worker_running()   — read PID file, os.kill(pid,0) liveness check
  check_worker_stuck()     — read heartbeat file, detect stall
  restart_stuck_worker()   — kill stale worker, reset DB locks, relaunch

ENV VAR OVERRIDES:
  GITHUB_DIGEST_HOME      — project root (changes cwd for subprocess calls)
  GITHUB_DIGEST_MODEL     — LLM model name (overrides config)
  GITHUB_DIGEST_LOG_DIR   — log directory for worker output
  GITHUB_DIGEST_DB_PATH   — DB path override for status queries
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants / defaults
# ---------------------------------------------------------------------------

LOCK_FILE = "/tmp/github-digest-orchestrate.lock"
_WORKER_PID_TEMPLATE = "/tmp/github-digest-worker-{date}.pid"
_WORKER_HB_TEMPLATE = "/tmp/github-digest-worker-{date}.heartbeat"
OLLAMA_BASE_URL = "http://localhost:11434"
API_BASE_URL = "http://localhost:8000"


def _pid_file(date_str: str) -> str:
    return _WORKER_PID_TEMPLATE.format(date=date_str)


def _hb_file(date_str: str) -> str:
    return _WORKER_HB_TEMPLATE.format(date=date_str)


# ---------------------------------------------------------------------------
# Worker PID / heartbeat helpers
# ---------------------------------------------------------------------------

def check_worker_running(date_str: str) -> tuple[bool, int | None]:
    """Return (is_alive, pid). Cleans up stale pid file."""
    pid_path = _pid_file(date_str)
    if not os.path.exists(pid_path):
        return False, None
    try:
        pid = int(Path(pid_path).read_text().strip())
        os.kill(pid, 0)  # raises OSError if not alive
        return True, pid
    except (ValueError, OSError):
        try:
            os.remove(pid_path)
        except OSError:
            pass
        return False, None


def check_worker_stuck(date_str: str, stuck_minutes: int = 20) -> tuple[str, dict | None]:
    """
    Return ('ok'|'stuck'|'no_heartbeat'|'no_worker', data).
    'ok'           — heartbeat recent, worker progressing
    'stuck'        — heartbeat stale (> stuck_minutes)
    'no_heartbeat' — pid file exists but no heartbeat yet
    'no_worker'    — no pid file at all
    """
    alive, pid = check_worker_running(date_str)
    if not alive:
        return "no_worker", None

    hb_path = _hb_file(date_str)
    if not os.path.exists(hb_path):
        return "no_heartbeat", {"pid": pid}

    try:
        hb = json.loads(Path(hb_path).read_text())
        last_update = datetime.fromisoformat(hb.get("last_update", "1970-01-01T00:00:00+00:00"))
        # Make timezone-aware if naive
        if last_update.tzinfo is None:
            last_update = last_update.replace(tzinfo=UTC)
        age = datetime.now(UTC) - last_update
        if age > timedelta(minutes=stuck_minutes):
            return "stuck", hb
        return "ok", hb
    except Exception as e:
        logger.warning("Could not parse heartbeat file: %s", e)
        return "no_heartbeat", {"pid": pid}


def write_heartbeat(date_str: str, pid: int, processed: int, total: int, current_item: str) -> None:
    """Write/update the worker heartbeat file."""
    hb = {
        "pid": pid,
        "date": date_str,
        "processed": processed,
        "total": total,
        "current_item": current_item,
        "last_update": datetime.now(UTC).isoformat(),
    }
    try:
        Path(_hb_file(date_str)).write_text(json.dumps(hb))
    except OSError as e:
        logger.warning("Could not write heartbeat: %s", e)


def restart_stuck_worker(
    date_str: str,
    db_path: Path,
    config_path: Path,
    log_dir: Path,
) -> dict:
    """Kill stale worker, reset DB processing locks, relaunch worker."""
    pid_path = _pid_file(date_str)
    hb_path = _hb_file(date_str)

    # Kill the stale process
    if os.path.exists(pid_path):
        try:
            pid = int(Path(pid_path).read_text().strip())
            os.kill(pid, 15)  # SIGTERM
            logger.info("Sent SIGTERM to stuck worker pid=%d", pid)
        except (ValueError, OSError) as e:
            logger.warning("Could not kill stuck worker: %s", e)
        try:
            os.remove(pid_path)
        except OSError:
            pass

    if os.path.exists(hb_path):
        try:
            os.remove(hb_path)
        except OSError:
            pass

    # Reset processing locks in DB
    try:
        from sqlalchemy import text
        from github_digest.db.database import get_engine
        engine = get_engine(db_path)
        with engine.begin() as conn:
            result = conn.execute(
                text("UPDATE radar_item_analysis SET status='pending' WHERE status='processing'")
            )
            logger.info("Reset %d stale processing locks in DB", result.rowcount)
    except Exception as e:
        logger.error("Failed to reset DB locks: %s", e)

    # Relaunch
    new_pid = _launch_worker(date_str, log_dir)
    return {"restarted": True, "new_pid": new_pid, "date": date_str}


# ---------------------------------------------------------------------------
# Prerequisites check
# ---------------------------------------------------------------------------

def check_prerequisites(
    config_path: Path,
    db_path: Path,
    model_override: str | None = None,
) -> dict[str, Any]:
    """
    Check all prerequisites before running the pipeline.
    Returns dict with per-check results and overall 'ok' flag.
    """
    results: dict[str, Any] = {}

    # DB writable
    db_dir = db_path.parent
    results["db_dir_writable"] = db_dir.exists() and os.access(db_dir, os.W_OK)

    # Config files
    results["radar_config_exists"] = config_path.exists()
    saved_searches = config_path.parent / "saved_searches.json"
    results["saved_searches_exists"] = saved_searches.exists()

    # Ollama reachable
    ollama_ok = False
    model_available = False
    model_name = model_override or os.environ.get("GITHUB_DIGEST_MODEL", "llama3.2")

    # Load model from config if not overridden
    if not model_override and not os.environ.get("GITHUB_DIGEST_MODEL"):
        try:
            import yaml  # type: ignore[import]
            with open(config_path) as f:
                cfg = yaml.safe_load(f)
            model_name = cfg.get("llm", {}).get("model", "llama3.2")
        except Exception:
            pass

    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        if resp.status_code == 200:
            ollama_ok = True
            tags = resp.json()
            available_models = [m.get("name", "").split(":")[0] for m in tags.get("models", [])]
            model_available = model_name in available_models or any(
                m.startswith(model_name) for m in available_models
            )
    except Exception as e:
        results["ollama_error"] = str(e)

    results["ollama_reachable"] = ollama_ok
    results["model_name"] = model_name
    results["model_available"] = model_available

    # Overall
    results["ok"] = (
        results["db_dir_writable"]
        and results["radar_config_exists"]
        and results["saved_searches_exists"]
        and results["ollama_reachable"]
        and results["model_available"]
    )
    return results


# ---------------------------------------------------------------------------
# Worker launch helper
# ---------------------------------------------------------------------------

def _find_cmd() -> str:
    """Find the github-digest binary."""
    # Check same venv as the running Python first (most reliable)
    venv_bin = Path(sys.executable).parent / "github-digest"
    if venv_bin.exists():
        return str(venv_bin)
    # Then try PATH
    cmd = shutil.which("github-digest")
    if cmd:
        return cmd
    raise RuntimeError(
        f"github-digest binary not found. Checked {venv_bin} and PATH. "
        "Ensure the package is installed: pip install -e ."
    )


def _launch_worker(date_str: str, log_dir: Path) -> int:
    """Spawn analyze-worker as detached subprocess. Returns PID."""
    cmd = _find_cmd()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"analyze-worker-{date_str}.log"
    with open(log_path, "a") as lf:
        proc = subprocess.Popen(
            [cmd, "analyze-worker", "--date", date_str],
            start_new_session=True,
            stdout=lf,
            stderr=subprocess.STDOUT,
        )
    pid = proc.pid
    Path(_pid_file(date_str)).write_text(str(pid))
    logger.info("Launched analyze-worker pid=%d log=%s", pid, log_path)
    return pid


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def run_orchestrate_daily(
    date_str: str | None = None,
    dry_run: bool = False,
    skip_github: bool = False,
    skip_hn: bool = False,
    skip_reddit: bool = False,
    skip_analyze: bool = False,
    skip_pair: bool = False,
) -> dict[str, Any]:
    """
    Run the full daily pipeline with:
    - prerequisites check
    - flock (non-blocking, exits gracefully if already running)
    - worker single-instance guard
    - ordered pipeline steps
    """
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    # ENV VAR OVERRIDES
    home = Path(os.environ.get("GITHUB_DIGEST_HOME", "."))
    log_dir = Path(os.environ.get("GITHUB_DIGEST_LOG_DIR", str(home / "logs")))
    config_path = home / "config" / "radar_config.yaml"

    from github_digest.config import settings as _settings
    db_path_env = os.environ.get("GITHUB_DIGEST_DB_PATH")
    db_path = Path(db_path_env) if db_path_env else _settings.db_path

    # Ensure DB dir exists
    db_path.parent.mkdir(parents=True, exist_ok=True)

    results: dict[str, Any] = {"date": date_str, "dry_run": dry_run, "steps": {}}

    # --- Prerequisites check ---
    logger.info("Checking prerequisites...")
    prereqs = check_prerequisites(config_path, db_path)
    results["prerequisites"] = prereqs

    if dry_run:
        logger.info("[dry-run] Prerequisites: %s", prereqs)
        steps = []
        if not skip_github:
            steps.append("fetch (GitHub repos)")
        if not skip_hn:
            steps.append("ingest-hn")
        if not skip_reddit:
            steps.append("ingest-reddit")
        steps.extend([
            f"rank-daily --date {date_str}",
            f"analyze-daily --date {date_str}  (queue populate)",
        ])
        if not skip_analyze:
            steps.append(f"analyze-worker --date {date_str}  (background)")
        if not skip_pair:
            steps.append(f"pair-daily --date {date_str}")
        logger.info("[dry-run] Would run: %s", steps)
        results["would_run"] = steps
        return results

    if not prereqs["ok"]:
        failed = [k for k, v in prereqs.items() if k != "ok" and v is False]
        logger.error("Prerequisites failed: %s", failed)
        results["error"] = f"Prerequisites failed: {failed}"
        return results

    # --- Flock (non-blocking) ---
    lock_fd = open(LOCK_FILE, "w")  # noqa: SIM115
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        logger.info("Orchestration already running (lock held). Exiting gracefully.")
        results["skipped"] = "already_running"
        lock_fd.close()
        return results

    cmd = _find_cmd()

    def run_step(name: str, step_args: list[str]) -> dict:
        logger.info("=== Step: %s ===", name)
        try:
            proc = subprocess.run(
                [cmd] + step_args,
                capture_output=False,
                timeout=600,
            )
            ok = proc.returncode == 0
            logger.info("Step %s: %s (rc=%d)", name, "OK" if ok else "FAILED", proc.returncode)
            return {"ok": ok, "rc": proc.returncode}
        except subprocess.TimeoutExpired:
            logger.error("Step %s timed out", name)
            return {"ok": False, "error": "timeout"}
        except Exception as e:
            logger.error("Step %s error: %s", name, e)
            return {"ok": False, "error": str(e)}

    try:
        # Step 1: GitHub fetch
        if not skip_github:
            results["steps"]["fetch"] = run_step("fetch", ["fetch"])

        # Step 2: Ingest HN
        if not skip_hn:
            results["steps"]["ingest_hn"] = run_step("ingest-hn", ["ingest-hn"])

        # Step 2b: Ingest Reddit
        if not skip_reddit:
            results["steps"]["ingest_reddit"] = run_step("ingest-reddit", ["ingest-reddit"])

        # Step 3: Rank daily
        results["steps"]["rank_daily"] = run_step("rank-daily", ["rank-daily", "--date", date_str])

        # Step 4: Populate analysis queue (fast)
        results["steps"]["analyze_daily"] = run_step("analyze-daily", ["analyze-daily", "--date", date_str])

        # Step 4b: Launch analyze-worker (unless skip or already running)
        if not skip_analyze:
            already_running, existing_pid = check_worker_running(date_str)
            if already_running:
                logger.info("Worker already running for %s (pid=%d), skipping launch", date_str, existing_pid)
                results["steps"]["analyze_worker"] = {"ok": True, "skipped": "already_running", "pid": existing_pid}
            else:
                new_pid = _launch_worker(date_str, log_dir)
                results["steps"]["analyze_worker"] = {"ok": True, "launched": True, "pid": new_pid}
        else:
            results["steps"]["analyze_worker"] = {"ok": True, "skipped": "skip_analyze_flag"}

        # Step 5: Pair daily
        if not skip_pair:
            results["steps"]["pair_daily"] = run_step("pair-daily", ["pair-daily", "--date", date_str])

    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()

    all_ok = all(s.get("ok", False) for s in results["steps"].values())
    results["success"] = all_ok
    logger.info("Orchestration complete for %s: %s", date_str, "OK" if all_ok else "PARTIAL FAILURES")
    return results


# ---------------------------------------------------------------------------
# Status command
# ---------------------------------------------------------------------------

def get_orchestrate_status(date_str: str | None = None) -> dict[str, Any]:
    """Print current state: API health, Ollama health, worker status, analyze queue."""
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    status: dict[str, Any] = {"date": date_str, "checked_at": datetime.now(UTC).isoformat()}

    # API health
    try:
        resp = httpx.get(f"{API_BASE_URL}/health", timeout=3)
        status["api"] = {"reachable": True, "status_code": resp.status_code, "data": resp.json()}
    except Exception as e:
        status["api"] = {"reachable": False, "error": str(e)}

    # Ollama health
    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        status["ollama"] = {"reachable": True, "status_code": resp.status_code}
    except Exception as e:
        status["ollama"] = {"reachable": False, "error": str(e)}

    # Worker PID / heartbeat
    alive, pid = check_worker_running(date_str)
    status["worker"] = {"alive": alive, "pid": pid, "date": date_str}
    if alive:
        stuck_state, hb_data = check_worker_stuck(date_str)
        status["worker"]["stuck_state"] = stuck_state
        status["worker"]["heartbeat"] = hb_data

    # Analyze queue from DB (best-effort)
    try:
        from github_digest.config import settings as _settings
        db_path_env = os.environ.get("GITHUB_DIGEST_DB_PATH")
        db_path = Path(db_path_env) if db_path_env else _settings.db_path
        from sqlalchemy import text
        from github_digest.db.database import get_engine
        engine = get_engine(db_path)
        with engine.begin() as conn:
            rows = conn.execute(
                text("""
                    SELECT COALESCE(ria.status,'not_queued') as status, COUNT(*) as cnt
                    FROM daily_picks dp
                    JOIN radar_items ri ON dp.item_id = ri.id
                    LEFT JOIN radar_item_analysis ria ON ria.item_id = ri.id AND ria.analysis_version='v1'
                    WHERE dp.date = :date
                    GROUP BY ria.status
                """),
                {"date": date_str},
            ).fetchall()
        queue: dict[str, int] = {}
        for row in rows:
            queue[row[0] or "not_queued"] = row[1]
        status["analyze_queue"] = queue
        status["analyze_queue"]["total"] = sum(queue.values())
    except Exception as e:
        status["analyze_queue"] = {"error": str(e)}

    return status


# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------

def run_watchdog(date_str: str | None = None, stuck_minutes: int = 20) -> dict[str, Any]:
    """
    Health-check watchdog. Called by systemd timer every 10 minutes.
    Checks: API health, Ollama health, worker heartbeat.
    Restarts stuck worker if detected.
    Returns result dict; exits with code 1 if any check fails.
    """
    if date_str is None:
        date_str = datetime.now(UTC).strftime("%Y-%m-%d")

    from github_digest.config import settings as _settings
    db_path_env = os.environ.get("GITHUB_DIGEST_DB_PATH")
    db_path = Path(db_path_env) if db_path_env else _settings.db_path
    config_path = Path(os.environ.get("GITHUB_DIGEST_HOME", ".")) / "config" / "radar_config.yaml"
    log_dir = Path(os.environ.get("GITHUB_DIGEST_LOG_DIR", "logs"))

    result: dict[str, Any] = {"date": date_str, "checked_at": datetime.now(UTC).isoformat(), "healthy": True}

    # Check API
    try:
        resp = httpx.get(f"{API_BASE_URL}/health", timeout=3)
        result["api_ok"] = resp.status_code == 200
    except Exception as e:
        result["api_ok"] = False
        result["api_error"] = str(e)

    # Check Ollama
    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        result["ollama_ok"] = resp.status_code == 200
    except Exception as e:
        result["ollama_ok"] = False
        result["ollama_error"] = str(e)
        result["healthy"] = False

    # Check worker heartbeat
    stuck_state, hb_data = check_worker_stuck(date_str, stuck_minutes=stuck_minutes)
    result["worker_state"] = stuck_state
    result["worker_heartbeat"] = hb_data

    if stuck_state == "stuck":
        logger.warning("Worker appears stuck (no heartbeat for >%d min). Restarting.", stuck_minutes)
        restart_result = restart_stuck_worker(date_str, db_path, config_path, log_dir)
        result["worker_restarted"] = restart_result
        result["healthy"] = False

    elif stuck_state == "no_worker":
        # No worker running — check if there are pending/processing items for today
        pending_count = 0
        try:
            from sqlalchemy import text
            from github_digest.db.database import get_engine
            engine = get_engine(db_path)
            with engine.begin() as conn:
                row = conn.execute(
                    text("""
                        SELECT COUNT(*) FROM radar_item_analysis ria
                        JOIN daily_picks dp ON dp.item_id = ria.item_id
                        WHERE dp.date = :date
                          AND ria.status IN ('pending', 'processing')
                    """),
                    {"date": date_str},
                ).fetchone()
                pending_count = row[0] if row else 0
        except Exception as e:
            logger.warning("Could not query pending analysis items: %s", e)

        if pending_count > 0:
            logger.warning(
                "Worker not running but %d pending items found. Relaunching worker.",
                pending_count,
            )
            restart_result = restart_stuck_worker(date_str, db_path, config_path, log_dir)
            result["worker_relaunched"] = restart_result
            result["healthy"] = False

    if not result.get("api_ok"):
        result["healthy"] = False

    status_word = "OK" if result["healthy"] else "DEGRADED"
    logger.info("Watchdog check %s: API=%s Ollama=%s Worker=%s",
                status_word,
                result.get("api_ok"), result.get("ollama_ok"), stuck_state)
    return result
