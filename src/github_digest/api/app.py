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
    repo_count = db.scalar(select(func.count()).select_from(Repo))
    last_fetch = db.scalar(
        select(func.max(Run.finished_at)).where(Run.run_type == "fetch", Run.status == "finished")
    )
    return {
        "status": "ok",
        "repo_count": repo_count or 0,
        "last_fetch": last_fetch.isoformat() if last_fetch else None,
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
    rows = db.execute(
        text("""
            SELECT ri.id, ri.source, ri.url, ri.title, ri.github_full_name,
                   ri.signals_json, ri.scores_json, ria.analysis_json,
                   dp.rank
            FROM daily_picks dp
            JOIN radar_items ri ON dp.item_id = ri.id
            LEFT JOIN radar_item_analysis ria ON ria.item_id = ri.id AND ria.analysis_version = 'v1'
            WHERE dp.date = :date
            ORDER BY dp.rank ASC
        """),
        {"date": date_str},
    ).fetchall()

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

        items.append({
            "id": row[0],
            "source": row[1],
            "url": row[2],
            "title": row[3],
            "github_full_name": row[4],
            "signals": signals,
            "analysis": analysis,
            "rank": row[8],
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


@app.get("/api/today")
def api_today(
    date: str | None = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    from datetime import datetime, timezone
    date_str = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = _get_today_items(db, date_str)
    return {"date": date_str, "items": items}


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
