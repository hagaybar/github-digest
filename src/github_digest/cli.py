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
    result = ingest_hn(settings.db_path, limit=100, github_token=settings.github_token)
    logger.info("HN ingestion result: %s", result)


def cmd_ingest_reddit(args: argparse.Namespace) -> None:
    """Ingest Reddit posts from curated builder subreddits into DB."""
    import sys
    print("WARNING: Reddit ingestion is 403-blocked. Consider using 'ingest-devto' instead.", file=sys.stderr)
    from github_digest.radar.reddit_ingestion import DEFAULT_SUBREDDITS, ingest_reddit
    subreddits = getattr(args, "subreddits", None) or DEFAULT_SUBREDDITS
    result = ingest_reddit(
        settings.db_path,
        subreddits=subreddits,
        limit_per_sub=25,
        github_token=settings.github_token,
    )
    logger.info("Reddit ingestion result: %s", result)
    print(json.dumps(result))


def cmd_ingest_devto(args: argparse.Namespace) -> None:
    """Ingest DEV.to articles into DB."""
    from github_digest.radar.devto_ingestion import ingest_devto
    tags_raw = getattr(args, "tags", None)
    tags_list = [t.strip() for t in tags_raw.split(",")] if tags_raw else None
    result = ingest_devto(db_path=settings.db_path, tags=tags_list, github_token=settings.github_token)
    print(f"Ingested {result['ingested']} DEV.to articles ({result['github_linked']} GitHub-linked)")


def cmd_ingest_producthunt(args: argparse.Namespace) -> None:
    """Ingest Product Hunt RSS feed into DB."""
    from github_digest.radar.producthunt_ingestion import ingest_producthunt
    result = ingest_producthunt(db_path=settings.db_path, github_token=settings.github_token)
    print(f"Ingested {result['ingested']} Product Hunt items ({result['github_linked']} GitHub-linked)")


def cmd_ingest_github_trending(args: argparse.Namespace) -> None:
    """Ingest GitHub Trending repos (daily + weekly) into DB."""
    from github_digest.radar.github_trending_ingestion import ingest_github_trending
    result = ingest_github_trending(
        db_path=settings.db_path,
        github_token=settings.github_token,
    )
    print(
        f"Ingested {result['ingested']} GitHub Trending repos "
        f"(daily={result['daily']}, weekly={result['weekly']}, "
        f"github_enriched={result['github_enriched']})"
    )
    print(json.dumps(result))


def cmd_rank_daily(args: argparse.Namespace) -> None:
    """Score and rank items, write daily picks."""
    from github_digest.radar.ranking import rank_candidates
    config_path = Path("config/radar_config.yaml")
    result = rank_candidates(settings.db_path, config_path, date_str=getattr(args, 'date', None))
    logger.info("Ranking result: %s", result)


def cmd_rank_refresh(args: argparse.Namespace) -> None:
    """Re-score 48h candidates and refresh daily picks if better items found."""
    from github_digest.radar.ranking import rank_refresh
    config_path = Path("config/radar_config.yaml")
    result = rank_refresh(settings.db_path, config_path, date_str=getattr(args, 'date', None))
    logger.info("Rank refresh result: %s", result)


def cmd_analyze_daily(args: argparse.Namespace) -> None:
    """Populate the analysis queue for daily picks (fast, no LLM calls)."""
    from github_digest.radar.card_generator import populate_analysis_queue
    config_path = Path("config/radar_config.yaml")
    result = populate_analysis_queue(settings.db_path, config_path, date_str=getattr(args, 'date', None))
    print(json.dumps(result))


def cmd_analyze_worker(args: argparse.Namespace) -> None:
    """Background worker: process pending analysis items via Ollama."""
    from github_digest.radar.card_generator import run_analyze_worker
    config_path = Path("config/radar_config.yaml")
    result = run_analyze_worker(
        settings.db_path,
        config_path,
        date_str=getattr(args, 'date', None),
        watch=getattr(args, 'watch', False),
    )
    logger.info("Worker result: %s", result)


def cmd_pair_daily(args: argparse.Namespace) -> None:
    """Generate pairings for the day."""
    from github_digest.radar.pairing import pair_daily
    result = pair_daily(settings.db_path, date_str=getattr(args, 'date', None))
    logger.info("Pairing result: %s", result)


def cmd_orchestrate_daily(args: argparse.Namespace) -> None:
    """Run the full daily pipeline with prerequisites check and flock."""
    from github_digest.services.orchestrator import run_orchestrate_daily
    result = run_orchestrate_daily(
        date_str=getattr(args, 'date', None),
        dry_run=getattr(args, 'dry_run', False),
        skip_github=getattr(args, 'skip_github', False),
        skip_hn=getattr(args, 'skip_hn', False),
        skip_reddit=getattr(args, 'skip_reddit', False),
        skip_analyze=getattr(args, 'skip_analyze', False),
        skip_pair=getattr(args, 'skip_pair', False),
    )
    print(json.dumps(result, indent=2))
    if not result.get("dry_run") and not result.get("skipped") and not result.get("success"):
        raise SystemExit(1)


def cmd_orchestrate_status(args: argparse.Namespace) -> None:
    """Print current orchestration state: API, Ollama, worker, analyze queue."""
    from github_digest.services.orchestrator import get_orchestrate_status
    result = get_orchestrate_status(date_str=getattr(args, 'date', None))
    print(json.dumps(result, indent=2))


def cmd_watchdog(args: argparse.Namespace) -> None:
    """Watchdog: check API, Ollama, worker heartbeat. Restart stuck worker."""
    from github_digest.services.orchestrator import run_watchdog
    result = run_watchdog(
        date_str=getattr(args, 'date', None),
        stuck_minutes=getattr(args, 'stuck_minutes', 20),
    )
    print(json.dumps(result, indent=2))
    if not result.get("healthy"):
        # Exit 0 when the worker was successfully relaunched — that is a recovery, not a failure
        relaunched = result.get("worker_relaunched", {})
        if isinstance(relaunched, dict) and relaunched.get("restarted"):
            return
        raise SystemExit(1)


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

    # ingest-reddit
    p_ingest_reddit = sub.add_parser("ingest-reddit", help="Ingest Reddit posts from builder subreddits")
    p_ingest_reddit.add_argument(
        "--subreddits", nargs="+", default=None,
        help="Subreddits to fetch (default: SideProject coolgithubprojects MachineLearning)",
    )
    p_ingest_reddit.set_defaults(func=cmd_ingest_reddit)

    # ingest-devto
    p_ingest_devto = sub.add_parser("ingest-devto", help="Ingest DEV.to articles")
    p_ingest_devto.add_argument(
        "--tags", default=None,
        help="Comma-separated list of DEV.to tags to fetch (default: None, uses module defaults)",
    )
    p_ingest_devto.set_defaults(func=cmd_ingest_devto)

    # ingest-producthunt
    p_ingest_producthunt = sub.add_parser("ingest-producthunt", help="Ingest Product Hunt RSS feed")
    p_ingest_producthunt.set_defaults(func=cmd_ingest_producthunt)

    # ingest-github-trending
    p_ingest_trending = sub.add_parser(
        "ingest-github-trending",
        help="Ingest GitHub Trending repos (daily + weekly)",
    )
    p_ingest_trending.set_defaults(func=cmd_ingest_github_trending)

    # rank-daily
    p_rank = sub.add_parser("rank-daily", help="Score and rank items, write daily picks")
    p_rank.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_rank.set_defaults(func=cmd_rank_daily)

    # rank-refresh
    p_rank_refresh = sub.add_parser(
        "rank-refresh",
        help="Intra-day re-score candidates and replace picks that score significantly higher",
    )
    p_rank_refresh.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_rank_refresh.set_defaults(func=cmd_rank_refresh)

    # analyze-daily
    p_analyze = sub.add_parser("analyze-daily", help="Populate analysis queue for daily picks (fast, no LLM)")
    p_analyze.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_analyze.set_defaults(func=cmd_analyze_daily)

    # analyze-worker
    p_worker = sub.add_parser("analyze-worker", help="Process pending analysis items via Ollama (background worker)")
    p_worker.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_worker.add_argument("--watch", action="store_true", default=False, help="Keep running after queue is empty, polling for new items")
    p_worker.set_defaults(func=cmd_analyze_worker)

    # pair-daily
    p_pair = sub.add_parser("pair-daily", help="Generate pairings for the day")
    p_pair.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_pair.set_defaults(func=cmd_pair_daily)

    # orchestrate-daily
    p_orch = sub.add_parser("orchestrate-daily", help="Run full daily pipeline (prerequisites + flock + all steps)")
    p_orch.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_orch.add_argument("--dry-run", action="store_true", default=False, dest="dry_run",
                        help="Print steps that would run without executing")
    p_orch.add_argument("--skip-github", action="store_true", default=False, dest="skip_github")
    p_orch.add_argument("--skip-hn", action="store_true", default=False, dest="skip_hn")
    p_orch.add_argument("--skip-reddit", action="store_true", default=False, dest="skip_reddit")
    p_orch.add_argument("--skip-analyze", action="store_true", default=False, dest="skip_analyze",
                        help="Skip launching analyze-worker")
    p_orch.add_argument("--skip-pair", action="store_true", default=False, dest="skip_pair")
    p_orch.set_defaults(func=cmd_orchestrate_daily)

    # orchestrate-status
    p_status = sub.add_parser("orchestrate-status", help="Show current pipeline state (API, Ollama, worker, queue)")
    p_status.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_status.set_defaults(func=cmd_orchestrate_status)

    # watchdog
    p_watchdog = sub.add_parser("watchdog", help="Check API/Ollama health and restart stuck worker")
    p_watchdog.add_argument("--date", default=None, help="Date YYYY-MM-DD (default: today)")
    p_watchdog.add_argument("--stuck-minutes", type=int, default=20, dest="stuck_minutes",
                            help="Minutes without heartbeat before declaring worker stuck (default: 20)")
    p_watchdog.set_defaults(func=cmd_watchdog)

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
    elif args.command == "ingest-reddit":
        cmd_ingest_reddit(args)
    elif args.command == "ingest-devto":
        cmd_ingest_devto(args)
    elif args.command == "ingest-producthunt":
        cmd_ingest_producthunt(args)
    elif args.command == "ingest-github-trending":
        cmd_ingest_github_trending(args)
    elif args.command == "rank-daily":
        cmd_rank_daily(args)
    elif args.command == "rank-refresh":
        cmd_rank_refresh(args)
    elif args.command == "analyze-daily":
        cmd_analyze_daily(args)
    elif args.command == "analyze-worker":
        cmd_analyze_worker(args)
    elif args.command == "pair-daily":
        cmd_pair_daily(args)
    elif args.command == "orchestrate-daily":
        cmd_orchestrate_daily(args)
    elif args.command == "orchestrate-status":
        cmd_orchestrate_status(args)
    elif args.command == "watchdog":
        cmd_watchdog(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
