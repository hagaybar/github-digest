from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from github_digest.config import settings
from github_digest.db.database import create_tables, get_engine, get_session
from github_digest.db.models import Repo, Run
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


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})
