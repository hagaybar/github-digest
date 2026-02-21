from __future__ import annotations

from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    db_path: Path = Field(default=Path("data/github_digest.db"))
    github_token: Optional[str] = Field(default=None, validation_alias="GITHUB_TOKEN")
    saved_searches_path: Path = Field(default=Path("config/saved_searches.json"))
    fetch_limit_per_query: int = 10
    fetch_limit_per_run: int = 50
    throttle_seconds: float = 1.0
    user_agent: str = "github-digest/0.1"
    stars_min: int = 50
    stars_max: int = 500000
    new_window_days: int = 7
    rising_window_days: int = 7
    updated_window_days: int = 30
    rising_top_k: int = 20
    max_summaries_per_day: int = 30
    summary_stale_days: int = 14
    summary_star_change_threshold: int = 500


settings = Settings()
