# GitHub Digest

A discovery-focused web service that periodically fetches GitHub repositories based on saved search queries, stores them in SQLite, and provides a web UI and JSON API with discovery modes (new, rising, updated).

## Tech Stack

- **Python 3.11+**, FastAPI, Uvicorn, SQLAlchemy, SQLite, Pydantic, Jinja2, httpx
- **Frontend**: Vanilla HTML/JS (no build tools)
- **Testing**: pytest, Ruff (lint/format)
- **Deploy**: Docker or systemd on Linux

## Project Structure

```
src/github_digest/
  cli.py          - CLI entrypoint (fetch, summarize, serve, health subcommands)
  config.py       - Pydantic settings (env vars, defaults)
  api/app.py      - FastAPI app and endpoints
  db/
    models.py     - ORM models: Repo, RepoSearch, RepoSummary, RepoStatsDaily, Run
    database.py   - Engine, session factory, table init
    migrations.py - Schema migrations
  services/
    github_client.py  - GitHub Search API wrapper with rate limiting/retry
    fetcher.py        - Fetch loop: calls GitHub, upserts repos, records stats
    board.py          - Discovery board queries (new/rising/updated)
    summarizer.py     - Summary generation pipeline with safety caps
  web/templates/index.html  - Single-page frontend
config/saved_searches.json  - Search definitions (name, query, limit, labels)
deploy/
  docker/Dockerfile
  systemd/        - Service units + install/uninstall scripts
```

## Common Commands

```bash
# Setup
python3 -m venv .venv && source .venv/bin/activate
pip install -e .[dev]

# Development
make dev          # start uvicorn with --reload on :8000
make test         # run pytest
make lint         # ruff check
make format       # ruff format

# CLI
github-digest fetch              # one fetch cycle
github-digest summarize          # generate summaries
github-digest summarize --dry-run --limit 10
github-digest serve              # start API server
github-digest health             # print health status
```

## API Endpoints

- `GET /` — HTML board UI
- `GET /health` — `{"status": "ok", "repo_count": N, "last_fetch": "..."}`
- `GET /board/today?mode=new|rising|updated&window_days=7&limit=10`
- `GET /board/query/{name}?mode=rising&window_days=7`

## Key Patterns

- **Saved searches** in `config/saved_searches.json` drive all fetching
- **Daily stats** (`RepoStatsDaily`) power the "rising" board via star deltas
- **Summarizer** has dry-run, per-run limits (`--limit`), and daily caps (`--max-per-day`) to control costs
- **Migrations** in `db/migrations.py` handle schema evolution without dropping tables

## Environment

```bash
GITHUB_TOKEN=ghp_...   # optional, raises rate limits
# See config.py for full list of configurable env vars
```

## Testing

Tests live in `tests/`. Run with `pytest` or `make test`.
