#!/usr/bin/env python3
"""
Daily pipeline orchestrator for Builder Radar.
Runs the full pipeline: ingest_github, ingest_hn, ingest_devto, rank_daily, analyze_daily, pair_daily.

Usage:
    python3 run_daily_pipeline.py [--date YYYY-MM-DD] [--skip-github] [--skip-hn] [--skip-devto] [--skip-llm]
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("builder-radar-pipeline")


def main() -> int:
    parser = argparse.ArgumentParser(description="Builder Radar daily pipeline")
    parser.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    parser.add_argument("--skip-github", action="store_true", default=False, dest="skip_github",
                        help="Skip GitHub ingestion step")
    parser.add_argument("--skip-hn", action="store_true", default=False, dest="skip_hn",
                        help="Skip HN ingestion step")
    parser.add_argument("--skip-devto", action="store_true", default=False, dest="skip_devto",
                        help="Skip DEV.to ingestion step")
    parser.add_argument("--skip-llm", action="store_true", default=False, dest="skip_llm",
                        help="Skip launching the background LLM analysis worker")
    args = parser.parse_args()

    date_str = args.date or datetime.now(UTC).strftime("%Y-%m-%d")
    project_root = Path(__file__).parent
    config_path = project_root / "config" / "radar_config.yaml"

    # Import settings
    sys.path.insert(0, str(project_root / "src"))
    from github_digest.config import settings
    from github_digest.db.database import create_tables, get_engine

    db_path = settings.db_path
    engine = get_engine(db_path)
    create_tables(engine)

    errors = []

    # Step 1: Ingest GitHub
    if not args.skip_github:
        logger.info("=== Step 1: Ingest GitHub ===")
        try:
            from github_digest.services.fetcher import fetch_once
            result = fetch_once(settings)
            logger.info("GitHub ingestion: %s", result)
        except Exception as e:
            logger.error("GitHub ingestion failed: %s", e)
            errors.append(f"github: {e}")
    else:
        logger.info("=== Step 1: Skipping GitHub ingestion ===")

    # Step 2: Ingest HN
    if not args.skip_hn:
        logger.info("=== Step 2: Ingest Hacker News ===")
        try:
            from github_digest.radar.hn_ingestion import ingest_hn
            result = ingest_hn(db_path, limit=100)
            logger.info("HN ingestion: %s", result)
        except Exception as e:
            logger.error("HN ingestion failed: %s", e)
            errors.append(f"hn: {e}")
    else:
        logger.info("=== Step 2: Skipping HN ingestion ===")

    # Step 2b: Ingest DEV.to
    # DEV.to ingestion: replaces Reddit (Reddit 403-blocks server IPs)
    if not args.skip_devto:
        logger.info("=== Step 2b: Ingest DEV.to ===")
        try:
            from github_digest.radar.devto_ingestion import ingest_devto
            result = ingest_devto(db_path)
            logger.info("DEV.to ingestion: %s", result)
        except Exception as e:
            logger.error("DEV.to ingestion failed: %s", e)
            errors.append(f"devto: {e}")
    else:
        logger.info("=== Step 2b: Skipping DEV.to ingestion ===")

    # Step 3: Rank daily
    logger.info("=== Step 3: Rank daily (date=%s) ===", date_str)
    try:
        from github_digest.radar.ranking import rank_candidates
        result = rank_candidates(db_path, config_path, date_str=date_str)
        logger.info("Ranking: %s", result)
    except Exception as e:
        logger.error("Ranking failed: %s", e)
        errors.append(f"ranking: {e}")

    # Step 4: Populate analysis queue (fast, no LLM)
    logger.info("=== Step 4: Populate analysis queue ===")
    try:
        from github_digest.radar.card_generator import populate_analysis_queue
        result = populate_analysis_queue(db_path, config_path, date_str=date_str)
        logger.info("Analysis queue: %s", result)
    except Exception as e:
        logger.error("Analysis queue population failed: %s", e)
        errors.append(f"analyze-queue: {e}")

    # Step 4b: Launch background LLM analysis worker (detached)
    if not args.skip_llm:
        logger.info("=== Step 4b: Launching LLM analysis worker (background) ===")
        try:
            cmd = shutil.which("github-digest") or "github-digest"
            os.makedirs("logs", exist_ok=True)
            log_path = f"logs/analyze-worker-{date_str}.log"
            with open(log_path, "w") as log_file:
                proc = subprocess.Popen(
                    [cmd, "analyze-worker", "--date", date_str],
                    start_new_session=True,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                )
            logger.info(
                "LLM analysis running in background (pid=%d) — check /api/analyze/status",
                proc.pid,
            )
            logger.info("Worker log: %s", log_path)
        except Exception as e:
            logger.error("Failed to start analyze-worker: %s", e)
            errors.append(f"analyze-worker-start: {e}")
    else:
        logger.info("=== Step 4b: Skipping LLM analysis worker (--skip-llm) ===")

    # Step 5: Pair daily (runs immediately; worker will re-run with better analysis when done)
    logger.info("=== Step 5: Pair daily ===")
    try:
        from github_digest.radar.pairing import pair_daily
        result = pair_daily(db_path, date_str=date_str)
        logger.info("Pairing: %s", result)
    except Exception as e:
        logger.error("Pairing failed: %s", e)
        errors.append(f"pairing: {e}")

    # Summary
    if errors:
        logger.warning("Pipeline completed with %d errors: %s", len(errors), errors)
        return 1
    else:
        logger.info("Pipeline completed successfully for %s", date_str)
        return 0


if __name__ == "__main__":
    sys.exit(main())
