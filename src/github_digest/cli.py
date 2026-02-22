from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import uvicorn
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from github_digest.config import settings
from github_digest.db.database import create_tables, get_engine
from github_digest.db.models import Repo, Run
from github_digest.services.fetcher import fetch_once
from github_digest.services.llm_summarizer import make_llm_model_fn
from github_digest.services.summarizer import summarize_repos


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)


def cmd_fetch() -> None:
    result = fetch_once(settings)
    logger.info("Fetch result: %s", result)


def cmd_summarize(args: argparse.Namespace) -> None:
    if args.log_level:
        logging.getLogger().setLevel(args.log_level.upper())
    result = summarize_repos(
        settings,
        limit=args.limit,
        max_per_day=args.max_per_day,
        days=args.days,
        today_only=args.today_only,
        stale_days=args.stale_days,
        force=args.force,
        dry_run=args.dry_run,
    )
    logger.info("Summarize result: %s", result)


def cmd_summarize_llm(args: argparse.Namespace) -> None:
    llm_fn = make_llm_model_fn(
        github_token=settings.github_token,
        ollama_model=args.model,
        ollama_base_url=args.ollama_url,
    )
    result = summarize_repos(
        settings,
        limit=args.limit,
        force=args.force,
        dry_run=args.dry_run,
        model_fn=llm_fn,
        today_only=False,
    )
    print(json.dumps(result, indent=2))


def cmd_serve() -> None:
    uvicorn.run("github_digest.api.app:app", host="0.0.0.0", port=8000, reload=False)


def cmd_health() -> None:
    engine = get_engine(settings.db_path)
    create_tables(engine)
    with Session(engine) as session:
        repo_count = session.scalar(select(func.count()).select_from(Repo))
        last_fetch = session.scalar(
            select(Run).where(Run.run_type == "fetch").order_by(desc(Run.finished_at)).limit(1)
        )
        last_fetch_time = last_fetch.finished_at if last_fetch else None
        print("status=ok")
        print(f"repo_count={repo_count or 0}")
        print(f"last_fetch={last_fetch_time.isoformat() if last_fetch_time else None}")


def cmd_ingest_hn(args: argparse.Namespace) -> None:
    """Ingest Hacker News stories into DB."""
    from github_digest.radar.hn_ingestion import ingest_hn
    result = ingest_hn(settings.db_path, limit=100)
    logger.info("HN ingestion result: %s", result)


def cmd_rank_daily(args: argparse.Namespace) -> None:
    """Score and rank items, write daily picks."""
    from github_digest.radar.ranking import rank_candidates
    config_path = Path("config/radar_config.yaml")
    result = rank_candidates(settings.db_path, config_path, date_str=getattr(args, 'date', None))
    logger.info("Ranking result: %s", result)


def cmd_analyze_daily(args: argparse.Namespace) -> None:
    """Generate LLM analysis for daily picks."""
    from github_digest.radar.card_generator import analyze_daily_picks
    config_path = Path("config/radar_config.yaml")
    enable_llm = getattr(args, 'enable_llm', False)
    result = analyze_daily_picks(settings.db_path, config_path, date_str=getattr(args, 'date', None), enable_llm=enable_llm)
    logger.info("Analysis result: %s", result)


def cmd_pair_daily(args: argparse.Namespace) -> None:
    """Generate pairings for the day."""
    from github_digest.radar.pairing import pair_daily
    result = pair_daily(settings.db_path, date_str=getattr(args, 'date', None))
    logger.info("Pairing result: %s", result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="github-digest")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("fetch", help="Fetch GitHub repos once")
    summarize = sub.add_parser("summarize", help="Summarize repos safely")
    summarize.add_argument(
        "--dry-run",
        action="store_true",
        help="No DB writes; show planned repo count and names (default: False)",
    )
    summarize.add_argument(
        "--limit",
        type=int,
        default=30,
        help="Cap this summarize run (default: 30)",
    )
    summarize.add_argument(
        "--max-per-day",
        type=int,
        default=30,
        help="Hard daily cap (default: 30)",
    )
    summarize.add_argument(
        "--days",
        type=int,
        default=7,
        help="Eligibility window in days (default: 7)",
    )
    summarize.add_argument(
        "--today-only",
        action="store_true",
        default=True,
        help="Restrict to today board only (default: True)",
    )
    summarize.add_argument(
        "--stale-days",
        type=int,
        default=14,
        help="Treat summaries older than N days as stale (default: 14)",
    )
    summarize.add_argument(
        "--force",
        action="store_true",
        help="Ignore idempotency checks (still capped)",
    )
    summarize.add_argument(
        "--log-level",
        type=str,
        default=None,
        help="Logging level (e.g., INFO, DEBUG)",
    )
    summarize_llm = sub.add_parser("summarize-llm", help="Summarize repos using a local Ollama LLM and README content")
    summarize_llm.add_argument(
        "--limit",
        type=int,
        default=15,
        help="Cap this summarize-llm run (default: 15)",
    )
    summarize_llm.add_argument(
        "--model",
        type=str,
        default="llama3.2",
        help="Ollama model name (default: llama3.2)",
    )
    summarize_llm.add_argument(
        "--ollama-url",
        type=str,
        default="http://localhost:11434",
        help="Ollama base URL (default: http://localhost:11434)",
    )
    summarize_llm.add_argument(
        "--force",
        action="store_true",
        help="Ignore idempotency checks (still capped)",
    )
    summarize_llm.add_argument(
        "--dry-run",
        action="store_true",
        help="No DB writes; show planned repo count and names",
    )
    sub.add_parser("serve", help="Run API server")
    sub.add_parser("health", help="Print health info")

    # ingest-hn
    p_ingest_hn = sub.add_parser("ingest-hn", help="Ingest Hacker News stories")
    p_ingest_hn.set_defaults(func=cmd_ingest_hn)

    # rank-daily
    p_rank = sub.add_parser("rank-daily", help="Score and rank items, write daily picks")
    p_rank.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_rank.set_defaults(func=cmd_rank_daily)

    # analyze-daily
    p_analyze = sub.add_parser("analyze-daily", help="Generate LLM analysis for daily picks")
    p_analyze.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_analyze.add_argument("--enable-llm", action="store_true", default=False, dest="enable_llm", help="Enable LLM analysis via Ollama")
    p_analyze.set_defaults(func=cmd_analyze_daily)

    # pair-daily
    p_pair = sub.add_parser("pair-daily", help="Generate pairings for the day")
    p_pair.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_pair.set_defaults(func=cmd_pair_daily)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "fetch":
        cmd_fetch()
    elif args.command == "summarize":
        cmd_summarize(args)
    elif args.command == "summarize-llm":
        cmd_summarize_llm(args)
    elif args.command == "serve":
        cmd_serve()
    elif args.command == "health":
        cmd_health()
    elif args.command == "ingest-hn":
        cmd_ingest_hn(args)
    elif args.command == "rank-daily":
        cmd_rank_daily(args)
    elif args.command == "analyze-daily":
        cmd_analyze_daily(args)
    elif args.command == "pair-daily":
        cmd_pair_daily(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
