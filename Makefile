PYTHON ?= python3.11

.PHONY: dev run fetch test lint format

dev:
	uvicorn github_digest.api.app:app --reload --port 8000

run:
	uvicorn github_digest.api.app:app --host 0.0.0.0 --port 8000

fetch:
	github-digest fetch

test:
	pytest

lint:
	ruff check .

format:
	ruff format .
