#!/usr/bin/env python3
"""
Daily pipeline orchestrator for Builder Radar.
Runs the full pipeline: ingest_github, ingest_hn, rank_daily, analyze_daily, pair_daily.

Usage:
    python3 run_daily_pipeline.py [--date YYYY-MM-DD] [--enable-llm]
"""
from __future__ import annotations

import argparse
import logging
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
    parser.add_argument("--enable-llm", action="store_true", default=False, dest="enable_llm",
                        help="Enable LLM analysis via Ollama")
    parser.add_argument("--skip-github", action="store_true", default=False, dest="skip_github",
                        help="Skip GitHub ingestion step")
    parser.add_argument("--skip-hn", action="store_true", default=False, dest="skip_hn",
                        help="Skip HN ingestion step")
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

    # Step 3: Rank daily
    logger.info("=== Step 3: Rank daily (date=%s) ===", date_str)
    try:
        from github_digest.radar.ranking import rank_candidates
        result = rank_candidates(db_path, config_path, date_str=date_str)
        logger.info("Ranking: %s", result)
    except Exception as e:
        logger.error("Ranking failed: %s", e)
        errors.append(f"ranking: {e}")

    # Step 4: Analyze daily
    logger.info("=== Step 4: Analyze daily (LLM=%s) ===", args.enable_llm)
    try:
        from github_digest.radar.card_generator import analyze_daily_picks
        result = analyze_daily_picks(db_path, config_path, date_str=date_str, enable_llm=args.enable_llm)
        logger.info("Analysis: %s", result)
    except Exception as e:
        logger.error("Analysis failed: %s", e)
        errors.append(f"analysis: {e}")

    # Step 5: Pair daily
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
