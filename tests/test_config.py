from pathlib import Path

from github_digest.config import Settings


def test_config_loads_defaults(tmp_path: Path) -> None:
    settings = Settings(db_path=tmp_path / "test.db")
    assert settings.db_path.name == "test.db"
    assert settings.fetch_limit_per_query > 0
