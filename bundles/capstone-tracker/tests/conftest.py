"""Shared pytest setup for the capstone-tracker bundle.

Points every data path at a throwaway temp dir BEFORE `src` is imported
(the DB and e-reader paths are read at import time), seeds a tiny knowledge
base + research DB so the e-reader pages render, and hands tests a
TestClient that never runs the lifespan (which demands production envs).

Run inside the bundle image (fastapi, sqlalchemy, ... are not on the host):
    docker run --rm -v <bundle>:/w -w /w -e HOME=/tmp <image> \
        sh -c "pip install --user pytest && python -m pytest -p no:cacheprovider tests"
"""

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

BUNDLE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BUNDLE_DIR))
sys.dont_write_bytecode = True

_TMP = Path(tempfile.mkdtemp(prefix="capstone-test-"))
os.environ["CAPSTONE_DB_PATH"] = str(_TMP / "capstone.db")
os.environ["EREADER_KB_DB"] = str(_TMP / "kb.db")
os.environ["EREADER_RES_DB"] = str(_TMP / "research.db")
os.environ["EREADER_CACHE"] = str(_TMP / "cache")
os.environ.pop("ROOT_PATH", None)  # exercise the shipped default prefix

PARA = "This is a paragraph of reading text that is long enough to count. " * 3


def _seed_external_dbs() -> None:
    kb = sqlite3.connect(os.environ["EREADER_KB_DB"])
    kb.executescript(
        """
        CREATE TABLE kb_textbooks (id TEXT PRIMARY KEY, title TEXT, short_title TEXT,
                                   course_slug TEXT, total_pages INTEGER);
        CREATE TABLE kb_chapters (id TEXT PRIMARY KEY, textbook_id TEXT,
                                  chapter_number INTEGER, title TEXT, content TEXT);
        CREATE TABLE kb_research_documents (id TEXT PRIMARY KEY, title TEXT, short_title TEXT,
                                            document_type TEXT, authors TEXT,
                                            publication_year INTEGER, project_id TEXT);
        CREATE TABLE kb_document_sections (id TEXT PRIMARY KEY, document_id TEXT,
                                           section_number INTEGER, title TEXT, content TEXT);
        """
    )
    kb.execute("INSERT INTO kb_textbooks VALUES ('tb1','A Textbook','tb-one','c1',10)")
    kb.execute("INSERT INTO kb_chapters VALUES ('ch1','tb1',1,'Chapter One',?)", (PARA,))
    kb.execute("INSERT INTO kb_research_documents VALUES ('d1','A Document','doc-one','report',"
               "'[\"Author\"]',2024,NULL)")
    kb.execute("INSERT INTO kb_document_sections VALUES ('s1','d1',1,'Section One',?)", (PARA,))
    kb.commit()
    kb.close()

    res = sqlite3.connect(os.environ["EREADER_RES_DB"])
    res.execute(
        "CREATE TABLE research_sources (source_id TEXT PRIMARY KEY, title TEXT, authors TEXT, "
        "publication_year INTEGER, status TEXT, full_text_path TEXT, updated_at TEXT)"
    )
    res.execute("INSERT INTO research_sources VALUES ('src1','A Source','[]',2023,'read',NULL,"
                "'2026-01-01')")
    res.commit()
    res.close()
    cache = Path(os.environ["EREADER_CACHE"])
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "src1.txt").write_text(PARA, encoding="utf-8")


_seed_external_dbs()


@pytest.fixture(scope="session")
def app():
    from src.models.database import Base, get_sync_engine
    from src.server import app as fastapi_app

    Base.metadata.create_all(get_sync_engine())
    return fastapi_app


@pytest.fixture()
def client(app):
    from fastapi.testclient import TestClient

    # No `with` block: the lifespan's required-env check is for production.
    return TestClient(app)
