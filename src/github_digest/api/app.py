from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from github_digest.config import settings
from github_digest.db.database import create_tables, get_engine, get_session
from github_digest.db.models import DailyPairing, DailyPick, RadarItem, RadarItemAnalysis, Repo, Run
from github_digest.services.board import get_board_for_query, get_board_today
from github_digest.services.fetcher import load_saved_searches

logger = logging.getLogger(__name__)

app = FastAPI(title="GitHub Digest")

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "web" / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.on_event("startup")
def on_startup() -> None:
    engine = get_engine(settings.db_path)
    create_tables(engine)


@app.get("/health")
def health(db: Session = Depends(get_session)) -> dict[str, Any]:
    from datetime import datetime, timezone
    import httpx as _httpx

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Legacy fields (always present)
    repo_count = db.scalar(select(func.count()).select_from(Repo))
    last_fetch = db.scalar(
        select(func.max(Run.finished_at)).where(Run.run_type == "fetch", Run.status == "finished")
    )

    # DB table counts
    try:
        radar_items_count = db.scalar(
            text("SELECT COUNT(*) FROM radar_items")
        ) or 0
        daily_picks_today = db.scalar(
            text("SELECT COUNT(*) FROM daily_picks WHERE date = :d"),
            {"d": today},
        ) or 0
        analysis_count = db.scalar(
            text("SELECT COUNT(*) FROM radar_item_analysis WHERE status IN ('pending','processing','completed','failed')")
        ) or 0
        db_info = {
            "connected": True,
            "tables": {
                "radar_items": radar_items_count,
                "daily_picks_today": daily_picks_today,
                "radar_item_analysis": analysis_count,
            },
        }
    except Exception as e:
        db_info = {"connected": False, "error": str(e)}

    # Ollama health (non-blocking, 2s timeout)
    ollama_info: dict[str, Any] = {"reachable": False, "model_available": False, "model": "llama3.2"}
    try:
        from github_digest.radar.ranking import load_radar_config
        _cfg = load_radar_config(Path(__file__).resolve().parents[3] / "config" / "radar_config.yaml")
        ollama_model = _cfg.get("llm", {}).get("model", "llama3.2")
        ollama_url = _cfg.get("llm", {}).get("ollama_base_url", "http://localhost:11434")
        ollama_info["model"] = ollama_model
        resp = _httpx.get(f"{ollama_url}/api/tags", timeout=2)
        if resp.status_code == 200:
            ollama_info["reachable"] = True
            tags = resp.json()
            available = [m.get("name", "").split(":")[0] for m in tags.get("models", [])]
            ollama_info["model_available"] = ollama_model in available or any(
                m.startswith(ollama_model) for m in available
            )
    except Exception:
        pass

    overall = "ok"
    if not db_info.get("connected", True):
        overall = "error"
    elif not ollama_info["reachable"]:
        overall = "degraded"

    return {
        "status": overall,
        "repo_count": repo_count or 0,
        "last_fetch": last_fetch.isoformat() if last_fetch else None,
        "db": db_info,
        "ollama": ollama_info,
    }


@app.get("/board/today")
def board_today(
    mode: str = "new",
    window_days: int | None = None,
    limit: int = 10,
    stars_min: int | None = None,
    stars_max: int | None = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    searches = load_saved_searches(settings.saved_searches_path)
    if not searches:
        return {"date": "today", "board": {}}
    if window_days is None:
        if mode == "rising":
            window_days = settings.rising_window_days
        elif mode == "updated":
            window_days = settings.updated_window_days
        else:
            window_days = settings.new_window_days
    board = get_board_today(
        db,
        searches,
        mode=mode,
        window_days=window_days,
        limit=limit,
        stars_min=stars_min or settings.stars_min,
        stars_max=stars_max or settings.stars_max,
    )
    return {"date": "today", "mode": mode, "window_days": window_days, "board": board}


@app.get("/board/query/{name}")
def board_query(
    name: str,
    mode: str = "new",
    window_days: int | None = None,
    limit: int = 10,
    stars_min: int | None = None,
    stars_max: int | None = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    searches = load_saved_searches(settings.saved_searches_path)
    search = next((s for s in searches if s.name == name), None)
    if search is None:
        return {"query": name, "results": []}
    if window_days is None:
        if mode == "rising":
            window_days = settings.rising_window_days
        elif mode == "updated":
            window_days = settings.updated_window_days
        else:
            window_days = settings.new_window_days
    board = get_board_for_query(
        db,
        search,
        mode=mode,
        window_days=window_days,
        limit=limit,
        stars_min=stars_min or settings.stars_min,
        stars_max=stars_max or settings.stars_max,
    )
    return {"query": name, "mode": mode, "window_days": window_days, "results": board}


@app.get("/feed.xml")
def atom_feed(db: Session = Depends(get_session)) -> Response:
    searches = load_saved_searches(settings.saved_searches_path)
    if not searches:
        board: dict[str, list] = {}
    else:
        board = get_board_today(
            db,
            searches,
            mode="new",
            window_days=settings.new_window_days,
            limit=5,
            stars_min=settings.stars_min,
            stars_max=settings.stars_max,
        )

    updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    feed_el = ET.Element("feed", xmlns="http://www.w3.org/2005/Atom")
    ET.SubElement(feed_el, "title").text = "GitHub Digest"
    ET.SubElement(feed_el, "id").text = "tag:github-digest:feed"
    ET.SubElement(feed_el, "updated").text = updated

    seen: set[str] = set()
    for label, repos in board.items():
        for repo in repos:
            full_name = repo["full_name"]
            if full_name in seen:
                continue
            seen.add(full_name)
            entry = ET.SubElement(feed_el, "entry")
            ET.SubElement(entry, "title").text = f"{full_name} [{label}]"
            ET.SubElement(entry, "id").text = f"tag:github-digest:{full_name}"
            link = ET.SubElement(entry, "link")
            link.set("href", repo["html_url"])
            link.set("rel", "alternate")
            pushed = repo.get("pushed_at") or updated
            ET.SubElement(entry, "updated").text = pushed if "T" in pushed else f"{pushed}T00:00:00Z"
            parts = []
            if repo.get("summary"):
                parts.append(repo["summary"])
            if repo.get("why_interesting"):
                parts.append(repo["why_interesting"])
            if repo.get("latest_release_tag"):
                parts.append(f"Latest: {repo['latest_release_tag']}")
            stars = repo.get("stars", 0)
            forks = repo.get("forks", 0)
            parts.append(f"⭐ {stars:,} · 🍴 {forks:,} · {repo.get('language') or 'n/a'}")
            ET.SubElement(entry, "summary").text = " | ".join(parts)

    xml_str = '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(feed_el, encoding="unicode")
    return Response(content=xml_str, media_type="application/atom+xml; charset=utf-8")


def _get_today_items(db: Session, date_str: str) -> list[dict]:
    """Query daily picks with their analysis for a given date."""
    _PICKS_QUERY = """
            SELECT ri.id, ri.source, ri.url, ri.title, ri.github_full_name,
                   ri.signals_json, ri.scores_json, ria.analysis_json,
                   dp.rank
            FROM daily_picks dp
            JOIN radar_items ri ON dp.item_id = ri.id
            LEFT JOIN radar_item_analysis ria ON ria.item_id = ri.id AND ria.analysis_version = 'v1'
            WHERE dp.date = :date
            ORDER BY dp.rank ASC
        """
    rows = db.execute(text(_PICKS_QUERY), {"date": date_str}).fetchall()

    # Fallback to most recent date with picks when today has none
    is_fallback = False
    actual_date = date_str
    if not rows:
        fallback_date = db.scalar(
            text("SELECT MAX(date) FROM daily_picks WHERE date < :d"),
            {"d": date_str},
        )
        if fallback_date:
            actual_date = str(fallback_date)
            rows = db.execute(text(_PICKS_QUERY), {"date": actual_date}).fetchall()
            is_fallback = True

    import json
    items = []
    for row in rows:
        signals = row[5]
        if isinstance(signals, str):
            try:
                signals = json.loads(signals)
            except Exception:
                signals = {}
        signals = signals or {}

        analysis = row[7]
        if isinstance(analysis, str):
            try:
                analysis = json.loads(analysis)
            except Exception:
                analysis = None

        scores = row[6]
        if isinstance(scores, str):
            try:
                scores = json.loads(scores)
            except Exception:
                scores = {}
        scores = scores or {}

        items.append({
            "id": row[0],
            "source": row[1],
            "url": row[2],
            "title": row[3],
            "github_full_name": row[4],
            "signals": signals,
            "analysis": analysis,
            "rank": row[8],
            "score": scores.get("final_score", 0.0),
            "is_fallback": is_fallback,
            "actual_date": actual_date,
        })
    return items


def _get_build_pairings(db: Session, date_str: str) -> list[dict]:
    """Query daily pairings with item data for a given date."""
    import json
    rows = db.execute(
        text("""
            SELECT dp.rank, dp.rationale,
                   a.id, a.source, a.url, a.title, a.github_full_name, a.signals_json,
                   b.id, b.source, b.url, b.title, b.github_full_name, b.signals_json,
                   ana.analysis_json, anb.analysis_json
            FROM daily_pairings dp
            JOIN radar_items a ON dp.item_id_a = a.id
            JOIN radar_items b ON dp.item_id_b = b.id
            LEFT JOIN radar_item_analysis ana ON ana.item_id = a.id AND ana.analysis_version = 'v1'
            LEFT JOIN radar_item_analysis anb ON anb.item_id = b.id AND anb.analysis_version = 'v1'
            WHERE dp.date = :date
            ORDER BY dp.rank ASC
        """),
        {"date": date_str},
    ).fetchall()

    pairings = []
    for row in rows:
        def parse_json(val):
            if isinstance(val, str):
                try:
                    return json.loads(val)
                except Exception:
                    return None
            return val

        pairings.append({
            "rank": row[0],
            "rationale": row[1],
            "item_a": {
                "id": row[2], "source": row[3], "url": row[4],
                "title": row[5], "github_full_name": row[6],
                "signals": parse_json(row[7]) or {},
                "analysis": parse_json(row[14]),
            },
            "item_b": {
                "id": row[8], "source": row[9], "url": row[10],
                "title": row[11], "github_full_name": row[12],
                "signals": parse_json(row[13]) or {},
                "analysis": parse_json(row[15]),
            },
        })
    return pairings


@app.get("/api/analyze/status")
def api_analyze_status(
    date: str | None = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    from datetime import datetime, timezone
    date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    rows = db.execute(
        text("""
            SELECT dp.rank, ri.id AS item_id, ri.title,
                   COALESCE(ria.status, 'not_queued') AS status,
                   COALESCE(ria.attempts, 0) AS attempts,
                   ria.error_message
            FROM daily_picks dp
            JOIN radar_items ri ON dp.item_id = ri.id
            LEFT JOIN radar_item_analysis ria
                   ON ria.item_id = ri.id AND ria.analysis_version = 'v1'
            WHERE dp.date = :date
            ORDER BY dp.rank ASC
        """),
        {"date": date_str},
    ).fetchall()

    items = [
        {
            "rank": row[0],
            "id": row[1],
            "title": row[2],
            "status": row[3],
            "attempts": row[4],
            "error_message": row[5],
        }
        for row in rows
    ]

    total = len(items)
    completed = sum(1 for it in items if it["status"] == "completed")
    pending = sum(1 for it in items if it["status"] == "pending")
    processing = sum(1 for it in items if it["status"] == "processing")
    failed = sum(1 for it in items if it["status"] == "failed")
    not_queued = sum(1 for it in items if it["status"] == "not_queued")

    done = total > 0 and (pending + processing + not_queued) == 0

    return {
        "date": date_str,
        "total": total,
        "completed": completed,
        "pending": pending,
        "processing": processing,
        "failed": failed,
        "done": done,
        "items": items,
    }


@app.get("/api/today")
def api_today(
    date: str | None = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    from datetime import datetime, timezone
    date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = _get_today_items(db, date_str)
    row = db.execute(
        text("SELECT MAX(created_at) FROM daily_picks WHERE date = :date"),
        {"date": date_str},
    ).scalar()
    updated_at = str(row) if row else None
    return {
        "date": date_str,
        "updated_at": updated_at,
        "items": items,
        "is_fallback": any(i.get("is_fallback") for i in items),
        "actual_date": items[0]["actual_date"] if items else date_str,
    }


@app.get("/api/build")
def api_build(
    date: str | None = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    from datetime import datetime, timezone
    date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pairings = _get_build_pairings(db, date_str)
    return {"date": date_str, "pairings": pairings}


@app.get("/today", response_class=HTMLResponse)
def today_page(request: Request, date: str | None = None, db: Session = Depends(get_session)) -> HTMLResponse:
    from datetime import datetime, timezone
    date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = _get_today_items(db, date_str)
    return templates.TemplateResponse("today.html", {"request": request, "items": items, "date": date_str})


@app.get("/build", response_class=HTMLResponse)
def build_page(request: Request, date: str | None = None, db: Session = Depends(get_session)) -> HTMLResponse:
    from datetime import datetime, timezone
    date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pairings = _get_build_pairings(db, date_str)
    return templates.TemplateResponse("build.html", {"request": request, "pairings": pairings, "date": date_str})


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})
