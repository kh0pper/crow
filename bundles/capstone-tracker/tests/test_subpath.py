"""The bundle must work when the gateway serves it under /proxy/capstone-tracker/.

The gateway strips the prefix before forwarding, so the app only learns it
from FastAPI's root_path. Every URL the app hands a browser (redirects, HTML
attributes, URLs built in JS) must therefore be a PATH that carries the
prefix: never a bare root path (escapes the proxy and 404s at the gateway)
and never an absolute self URL (the proxy rewrites Host, so it would point
at the loopback backend).
"""

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

PREFIX = "/proxy/capstone-tracker"
SRC = Path(__file__).resolve().parent.parent / "src"

URL_ATTRS = {"href", "src", "action", "hx-get", "hx-post", "hx-put", "hx-delete", "hx-patch"}
EXTERNAL_OK = ("https://unpkg.com/", "https://cdn.jsdelivr.net/", "https://cdnjs.cloudflare.com/")


class _UrlAttrs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in URL_ATTRS:
                self.found.append((tag, name, value or ""))


def _bad_urls(html: str) -> list:
    parser = _UrlAttrs()
    parser.feed(html)
    bad = []
    for tag, name, value in parser.found:
        if value == "" or value.startswith("#"):
            continue
        if value == PREFIX or value.startswith(PREFIX + "/"):
            continue
        if value.startswith(EXTERNAL_OK):
            continue
        bad.append(f"<{tag} {name}={value!r}>")
    return bad


@pytest.fixture(scope="session")
def seeded(app):
    from fastapi.testclient import TestClient

    client = TestClient(app)
    whiteboard = client.post("/api/notes", json={"title": "wb", "note_type": "whiteboard"})
    text = client.post("/api/notes", json={"title": "tx", "note_type": "text", "content": "hi"})
    assert whiteboard.status_code == 200 and text.status_code == 200
    pir = client.post("/pir", json={
        "pir_number": "T-1", "label": "test", "recipient": "agency",
        "filed_date": "2026-01-02", "response_due": "2026-01-20",
        "note_id": whiteboard.json()["id"],  # renders the per-row note link
    })
    assert pir.status_code == 200, pir.text
    from src.models.database import PIRRequest, get_sync_engine
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    with Session(get_sync_engine()) as s:
        pir_id = s.execute(select(PIRRequest.id)).scalars().first()
    return {"pir_id": pir_id, "wb": whiteboard.json()["id"], "tx": text.json()["id"]}


# ── Redirect ────────────────────────────────────────────────────────────────
def test_root_redirect_keeps_prefix(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == PREFIX + "/pir"


def test_root_redirect_without_prefix_when_root_path_empty(app, client, monkeypatch):
    monkeypatch.setattr(app, "root_path", "")
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "/pir"


def test_prefixed_request_path_still_routes(client):
    assert client.get(PREFIX + "/health").status_code == 200


# ── Rendered pages ──────────────────────────────────────────────────────────
PAGES = [
    "/pir", "/pir/add", "/pir/{pir_id}/edit", "/notes", "/notes/{wb}", "/notes/{tx}",
    "/advocacy", "/ereader", "/ereader/textbook/tb-one", "/ereader/textbook/tb-one/1",
    "/ereader/document/doc-one", "/ereader/document/doc-one/1", "/ereader/source/src1",
]


@pytest.mark.parametrize("page", PAGES)
def test_page_urls_carry_prefix(client, seeded, page):
    r = client.get(page.format(**seeded))
    assert r.status_code == 200, r.text[:300]
    body = r.text
    assert "127.0.0.1" not in body
    assert "testserver" not in body, "absolute self URL (request.url_for) leaked into HTML"
    assert "http://" not in body.replace("http://www.w3.org/", "")
    assert _bad_urls(body) == []


def test_base_exposes_prefix_to_js(client):
    assert f'window.BASE_URL = "{PREFIX}"' in client.get("/pir").text


def test_health_link_is_named_route(app):
    assert app.url_path_for("health") == "/health"


# ── Source scan: URLs built in JavaScript ───────────────────────────────────
ROOT_LITERAL = re.compile(
    r"""(?P<q>["'`])/(?:api|ereader|notes|pir|advocacy|static|health|internal|research)\b"""
)
# A literal is fine when the prefix is prepended right before it.
PREFIXED = re.compile(r"""BASE_URL\s*(?:\|\|\s*["']{2}\s*\))?\s*\+\s*\(?\s*$""")


def _scan_files():
    yield from sorted((SRC / "static" / "js").glob("*.js"))
    yield from sorted((SRC / "templates").rglob("*.html"))


def test_no_unprefixed_root_literals_in_js_or_templates():
    offenders = []
    for path in _scan_files():
        text = path.read_text(encoding="utf-8")
        for m in ROOT_LITERAL.finditer(text):
            line_start = text.rfind("\n", 0, m.start()) + 1
            line = text[line_start:text.find("\n", m.end())]
            if "request.url.path" in line:  # nav "active" checks compare, not link
                continue
            if text[max(0, m.start() - 11):m.start()] == "startsWith(":  # a test, not a URL
                continue
            if PREFIXED.search(text[max(0, m.start() - 80):m.start()]):
                continue
            lineno = text.count("\n", 0, m.start()) + 1
            offenders.append(f"{path.relative_to(SRC)}:{lineno}: {line.strip()}")
    assert offenders == []


def test_no_absolute_url_for_in_templates():
    hits = [str(p.relative_to(SRC)) for p in (SRC / "templates").rglob("*.html")
            if "request.url_for(" in p.read_text(encoding="utf-8")]
    assert hits == []


def test_service_emitted_static_urls_are_prefixed_client_side():
    # Stored/service URLs stay root-relative (cached data, canvas JSON); the
    # client prefixes them at use. Guard the known sinks.
    editor = (SRC / "static" / "js" / "note-editor.js").read_text(encoding="utf-8")
    calls = re.findall(r"fabric\.Image\.fromURL\(\s*([^,]+),", editor)
    assert calls and all(c.strip().startswith("assetUrl(") for c in calls), calls
    ereader_html = (SRC / "templates" / "ereader.html").read_text(encoding="utf-8")
    assert "card.href = mat.href" not in ereader_html
    reader_js = (SRC / "static" / "js" / "ereader.js").read_text(encoding="utf-8")
    assert "sw.js" not in reader_js  # registered a file the bundle never shipped


def test_root_path_slash_means_host_root(monkeypatch):
    """ROOT_PATH="/" must not turn the redirect into a protocol-relative //pir."""
    import importlib
    import src.server as srv
    monkeypatch.setenv("ROOT_PATH", "/")
    try:
        assert importlib.reload(srv).app.root_path == ""
    finally:
        monkeypatch.delenv("ROOT_PATH")
        importlib.reload(srv)
