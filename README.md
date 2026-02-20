# GitHub Digest

A small service that periodically fetches GitHub repositories for saved search queries, stores them in SQLite, and serves a minimal web UI + JSON API focused on discovery (new, rising, updated).

## Quickstart

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
```

Create a saved searches file:

```json
[
  {"name": "llm", "query": "topic:llm language:python", "limit": 10},
  {"name": "rag", "query": "topic:retrieval-augmented-generation", "limit": 10},
  {"name": "information-retrieval", "query": "topic:information-retrieval", "limit": 10},
  {"name": "data-engineering", "query": "topic:data-engineering", "limit": 10},
  {"name": "acdemic-libraries", "query": "topic:academic-libraries", "limit": 10}
]
```

Run a fetch, then start the API:

```bash
github-digest fetch
github-digest summarize
make dev
```

Open `http://localhost:8000/`.

## Environment

Set `GITHUB_TOKEN` for higher rate limits (optional):

```bash
export GITHUB_TOKEN=your_token
```

Config is loaded from `.env` if present. Default saved searches file is `config/saved_searches.json`.

Optional saved search fields (backward compatible):

- `label`: display label
- `mode_defaults`: `{ "window_days": 7, "stars_min": 50, "stars_max": 20000 }`
- `exclude_known`: `["owner/repo"]`

## Commands

- `make dev` - run the API with reload
- `make run` - run the API without reload
- `make fetch` - run one fetch
- `github-digest summarize` - create summaries for eligible repos
- `make test` - run tests
- `make lint` - run ruff lint
- `make format` - run ruff format

## Operator Notes (Safe Defaults)

Start with a dry run:

```bash
github-digest summarize --dry-run
```

Then run a small capped summarize:

```bash
github-digest summarize --limit 10 --max-per-day 30
```

## Endpoints

- `GET /health` - last fetch time + repo count
- `GET /board/today` - discovery board (mode: `new|rising|updated`, timeframe via `window_days`)
- `GET /board/query/{name}` - top repos for a specific query
- `GET /` - minimal HTML board
