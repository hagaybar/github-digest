from pathlib import Path

from sqlalchemy.orm import Session

from github_digest.db.database import create_tables, get_engine
from github_digest.db.models import Repo


def test_db_insert_repo(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    engine = get_engine(db_path)
    create_tables(engine)

    with Session(engine) as session:
        repo = Repo(
            github_id=123,
            full_name="example/repo",
            html_url="https://github.com/example/repo",
            description="demo",
            language="Python",
            topics_json=["demo"],
            stars=1,
            forks=0,
            open_issues=0,
        )
        session.add(repo)
        session.commit()

        loaded = session.query(Repo).filter_by(github_id=123).one()
        assert loaded.full_name == "example/repo"
