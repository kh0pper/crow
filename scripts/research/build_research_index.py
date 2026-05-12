#!/usr/bin/env python3
"""build_research_index.py — generate the static /research site for maestro.press

Phase 6.6 of the rosy-blossom plan. Reads research_projects (capstone =
id=6), data_case_studies, blog_posts, research_sources from crow.db and
writes:

    <OUTDIR>/index.html         — table of contents + abstract
    <OUTDIR>/bibliography.html  — APA-formatted bibliography from CSL-JSON
    <OUTDIR>/bibliography.json  — raw CSL-JSON dump of research_sources
    <OUTDIR>/styles.css         — local styling (inherits landing's fonts)

Then `rsync <OUTDIR>/ maestro.press:/var/www/maestro-press-research/` (or
the script does it for you with --deploy).

Idempotent: regenerates from the live DB on every run.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ID = 6  # Texas School Finance Capstone
CROW_DB = Path(os.environ.get(
    "CROW_DB", os.path.expanduser("~/.crow/data/crow.db")
))
BLOG_BASE = os.environ.get("BLOG_BASE", "/blog")
SITE_BASE = os.environ.get("SITE_BASE", "/research")
GENERATED = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


# ---------------------------------------------------------------------------
# Data loaders


def load_project(con):
    row = con.execute(
        "SELECT id, name, description, tags, source_archive_path, "
        "       gitea_archive_url, book_status "
        "FROM research_projects WHERE id=?",
        (PROJECT_ID,),
    ).fetchone()
    if not row:
        raise SystemExit(f"research_projects.id={PROJECT_ID} not found")
    return dict(row)


def load_case_studies(con):
    rows = con.execute(
        """
        SELECT cs.id           AS cs_id,
               cs.title        AS cs_title,
               cs.description  AS cs_description,
               cs.display_order,
               bp.id           AS bp_id,
               bp.slug         AS bp_slug,
               bp.title        AS bp_title,
               bp.excerpt      AS bp_excerpt,
               bp.status       AS bp_status,
               bp.published_at AS bp_published_at
        FROM data_case_studies cs
        LEFT JOIN blog_posts bp ON bp.id = cs.blog_post_id
        WHERE cs.project_id = ?
        ORDER BY cs.display_order, cs.id
        """,
        (PROJECT_ID,),
    ).fetchall()
    return [dict(r) for r in rows]


def load_sources(con):
    rows = con.execute(
        """
        SELECT id, title, authors, publication_date, publisher, doi, url,
               citation_apa, source_type
        FROM research_sources
        WHERE project_id = ?
        ORDER BY
          CASE WHEN publication_date IS NULL OR publication_date = '' THEN 1 ELSE 0 END,
          publication_date DESC,
          title COLLATE NOCASE
        """,
        (PROJECT_ID,),
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Bibliography formatting


def parse_authors(raw) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(a) for a in raw]
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [
                a if isinstance(a, str)
                else " ".join(filter(None, [a.get("family"), a.get("given")]))
                if isinstance(a, dict)
                else str(a)
                for a in parsed
            ]
    except (json.JSONDecodeError, TypeError):
        pass
    return [str(raw)]


def authors_apa(authors: list[str]) -> str:
    if not authors:
        return ""
    if len(authors) == 1:
        return authors[0]
    if len(authors) <= 7:
        return ", ".join(authors[:-1]) + ", & " + authors[-1]
    return ", ".join(authors[:6]) + ", … " + authors[-1]


def _year_from_date(d: str | None) -> str | None:
    if not d:
        return None
    s = str(d).strip()
    return s[:4] if s and s[:4].isdigit() else None


def format_apa(src: dict) -> str:
    """Loose APA-7 style formatting. Prefers stored citation_apa if non-empty."""
    stored = (src.get("citation_apa") or "").strip()
    if stored:
        return stored
    parts = []
    authors = parse_authors(src.get("authors"))
    if authors:
        parts.append(authors_apa(authors) + ".")
    year = _year_from_date(src.get("publication_date"))
    if year:
        parts.append(f"({year}).")
    if src.get("title"):
        parts.append(f"{src['title']}.")
    if src.get("publisher"):
        parts.append(f"{src['publisher']}.")
    if src.get("doi"):
        parts.append(f"https://doi.org/{src['doi']}")
    elif src.get("url"):
        parts.append(src["url"])
    return " ".join(p for p in parts if p).strip()


_CSL_TYPE_MAP = {
    "academic_paper": "article-journal",
    "web_article": "webpage",
    "book": "book",
    "government_doc": "report",
    "document": "report",
    "dataset": "dataset",
    "interview": "interview",
    "video": "motion_picture",
    "podcast": "broadcast",
    "social_media": "post",
    "web_scrape": "webpage",
    "web_search": "webpage",
    "api_data": "dataset",
}


def csl_for(src: dict) -> dict:
    """Return a best-effort CSL-JSON item for export."""
    authors = parse_authors(src.get("authors"))
    item: dict = {
        "id": f"src-{src['id']}",
        "type": _CSL_TYPE_MAP.get(src.get("source_type") or "", "article"),
        "title": src.get("title"),
    }
    if authors:
        item["author"] = [
            {"family": a.split()[-1], "given": " ".join(a.split()[:-1])}
            if " " in a else {"family": a}
            for a in authors
        ]
    year = _year_from_date(src.get("publication_date"))
    if year:
        item["issued"] = {"date-parts": [[int(year)]]}
    if src.get("publisher"):
        item["publisher"] = src["publisher"]
    if src.get("doi"):
        item["DOI"] = src["doi"]
    if src.get("url"):
        item["URL"] = src["url"]
    return item


# ---------------------------------------------------------------------------
# HTML rendering


CSS = """
:root {
  --bg: #0A0E17;
  --text: #F0F0F0;
  --accent: #3B82F6;
  --secondary: #94A3B8;
  --bg-subtle: #111827;
  --border: #1F2937;
  --max-width: 900px;
  --font-heading: 'Space Grotesk', system-ui, -apple-system, sans-serif;
  --font-body: 'Inter', system-ui, -apple-system, sans-serif;
}
@font-face { font-family: 'Space Grotesk'; font-weight: 700; font-display: swap;
  src: url('/fonts/space-grotesk-700.woff2') format('woff2'); }
@font-face { font-family: 'Inter'; font-weight: 400 700; font-display: swap;
  src: url('/fonts/inter-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153; }
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  padding: 0;
}
header.top {
  border-bottom: 1px solid var(--border);
  padding: 1rem 1.5rem;
  font-size: 0.95rem;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
header.top a.brand { color: var(--text); text-decoration: none;
  font-family: var(--font-heading); font-weight: 700; letter-spacing: 0.02em; }
header.top span.section { color: var(--secondary); }
main { max-width: var(--max-width); margin: 2.5rem auto; padding: 0 1.5rem; }
h1, h2, h3 { font-family: var(--font-heading); font-weight: 700;
  letter-spacing: -0.01em; }
h1 { font-size: 2.25rem; line-height: 1.15; margin-bottom: 0.5rem; }
h1 .label { display: block; font-size: 0.85rem; color: var(--accent);
  letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 0.5rem; }
h2 { font-size: 1.5rem; margin-top: 3rem; margin-bottom: 1rem;
  padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.1rem; margin-top: 1.75rem; margin-bottom: 0.5rem;
  color: var(--secondary); text-transform: uppercase; letter-spacing: 0.1em;
  font-size: 0.85rem; }
p { margin-bottom: 1rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.abstract { color: var(--secondary); font-size: 1.05rem; max-width: 65ch;
  margin-bottom: 1.5rem; }
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap;
  margin: 1.5rem 0 3rem; }
.actions a { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px;
  border: 1px solid var(--border); color: var(--text); }
.actions a:hover { border-color: var(--accent); color: var(--accent);
  text-decoration: none; }
.actions a.primary { background: var(--accent); border-color: var(--accent);
  color: white; }
.actions a.primary:hover { opacity: 0.9; color: white; }
ul.chapters { list-style: none; padding: 0; }
ul.chapters li { padding: 0.85rem 0; border-bottom: 1px solid var(--border);
  display: grid; grid-template-columns: 3.5rem 1fr auto; gap: 1rem;
  align-items: baseline; }
ul.chapters li:last-child { border-bottom: none; }
ul.chapters .num { font-family: var(--font-heading); color: var(--secondary);
  font-size: 0.9rem; }
ul.chapters .title { font-weight: 500; }
ul.chapters .title a { color: var(--text); }
ul.chapters .title a:hover { color: var(--accent); text-decoration: none; }
ul.chapters .meta { color: var(--secondary); font-size: 0.85rem; }
.placeholder { color: var(--secondary); font-style: italic; }
footer { max-width: var(--max-width); margin: 4rem auto 2rem; padding: 0 1.5rem;
  color: var(--secondary); font-size: 0.85rem;
  border-top: 1px solid var(--border); padding-top: 1.5rem; }
.bib-list { padding-left: 1.5rem; }
.bib-list li { margin-bottom: 0.75rem; padding-left: 0.25rem;
  text-indent: -1.5rem; line-height: 1.5; }
"""


def render_index(project: dict, case_studies: list[dict],
                 source_count: int) -> str:
    book = {}
    if project.get("book_status"):
        try:
            book = json.loads(project["book_status"])
        except (json.JSONDecodeError, TypeError):
            book = {}

    body_chapters = [
        cs for cs in case_studies
        if cs["cs_title"].startswith("Chapter")
    ]
    appendices = [
        cs for cs in case_studies
        if cs["cs_title"].startswith("Appendix")
    ]
    other = [
        cs for cs in case_studies
        if not (cs["cs_title"].startswith("Chapter")
                or cs["cs_title"].startswith("Appendix"))
    ]

    def chapter_li(cs: dict, idx: str) -> str:
        slug = cs.get("bp_slug")
        title = cs["cs_title"]
        href = f"{BLOG_BASE}/{slug}/" if slug else None
        status = (cs.get("bp_status") or "").lower()
        meta = "published" if status == "published" else status or "in progress"
        title_html = (
            f'<a href="{html.escape(href)}">{html.escape(title)}</a>'
            if href else
            f'<span class="placeholder">{html.escape(title)} (in progress)</span>'
        )
        return (
            f'<li><span class="num">{idx}</span>'
            f'<span class="title">{title_html}</span>'
            f'<span class="meta">{html.escape(meta)}</span></li>'
        )

    abstract = html.escape(project.get("description") or "")
    project_name = html.escape(project.get("name") or "Research project")
    chapters_html = "\n".join(
        chapter_li(cs, str(i + 1))
        for i, cs in enumerate(body_chapters)
    )
    appendices_html = "\n".join(
        chapter_li(cs, chr(ord("A") + i))
        for i, cs in enumerate(appendices)
    )
    other_html = "\n".join(
        chapter_li(cs, "•") for cs in other
    ) if other else ""

    published_count = book.get("published") or sum(
        1 for c in case_studies
        if (c.get("bp_status") or "").lower() == "published"
    )
    total = book.get("total_chapters") or len(case_studies)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{project_name} — Maestro Press Research</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="{abstract}">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="{SITE_BASE}/styles.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">Maestro Press</a>
  <span class="section">/ research</span>
</header>
<main>
  <h1><span class="label">Capstone</span>{project_name}</h1>
  <p class="abstract">{abstract}</p>
  <div class="actions">
    <a class="primary" href="{BLOG_BASE}/chapter-1-introduction/">Read the book →</a>
    <a href="{SITE_BASE}/bibliography.html">Bibliography ({source_count})</a>
    <a href="{BLOG_BASE}/chapter-3-methodology-and-analysis/">Methods</a>
    <a href="{SITE_BASE}/bibliography.json" download>CSL-JSON</a>
  </div>

  <h2>Body chapters</h2>
  <ul class="chapters">
    {chapters_html}
  </ul>

  <h2>Appendices</h2>
  <ul class="chapters">
    {appendices_html}
  </ul>

  {f'<h2>Other</h2><ul class="chapters">{other_html}</ul>' if other_html else ""}

  <h2>About this corpus</h2>
  <p>
    {published_count} of {total} chapters published to
    <a href="{BLOG_BASE}/">maestro.press/blog</a> as of
    {html.escape(book.get("as_of") or GENERATED[:10])}.
    {html.escape(book.get("notes") or "")}
  </p>
  <p>
    The reproducibility scripts live in
    <a href="https://github.com/kh0pper/crow/tree/main/scripts/research"
       rel="noopener">kh0pper/crow on GitHub</a>.
    All source documents, public information request responses, and
    derived datasets are archived in the project's MinIO bucket
    (<code>crow/capstone-research/</code>).
  </p>
</main>
<footer>
  Generated {html.escape(GENERATED)} from crow.db.
  Index regenerates on every chapter publication.
</footer>
</body>
</html>
"""


def render_bibliography(project: dict, sources: list[dict]) -> str:
    items = []
    for src in sources:
        apa = format_apa(src)
        if not apa:
            continue
        url = src.get("url") or src.get("doi")
        if url and not apa.endswith(url):
            apa_html = html.escape(apa)
        else:
            apa_html = html.escape(apa)
        items.append(f"<li>{apa_html}</li>")

    project_name = html.escape(project.get("name") or "Research project")
    body = "\n".join(items) if items else (
        '<li class="placeholder">No sources registered.</li>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bibliography — {project_name}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="{SITE_BASE}/styles.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">Maestro Press</a>
  <span class="section">/ research / bibliography</span>
</header>
<main>
  <h1><span class="label">Bibliography</span>{project_name}</h1>
  <div class="actions">
    <a href="{SITE_BASE}/">← Index</a>
    <a href="{SITE_BASE}/bibliography.json" download>Download CSL-JSON</a>
  </div>
  <ol class="bib-list">
    {body}
  </ol>
</main>
<footer>
  {len(items)} entries · APA-7 formatting (best-effort) · CSL-JSON export available.
  Generated {html.escape(GENERATED)}.
</footer>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Pipeline


def build(outdir: Path) -> dict:
    outdir.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(CROW_DB)
    con.row_factory = sqlite3.Row
    try:
        project = load_project(con)
        case_studies = load_case_studies(con)
        sources = load_sources(con)
    finally:
        con.close()

    (outdir / "index.html").write_text(
        render_index(project, case_studies, len(sources)), encoding="utf-8")
    (outdir / "bibliography.html").write_text(
        render_bibliography(project, sources), encoding="utf-8")
    (outdir / "bibliography.json").write_text(
        json.dumps([csl_for(s) for s in sources], indent=2), encoding="utf-8")
    (outdir / "styles.css").write_text(CSS, encoding="utf-8")

    return {
        "project": project["name"],
        "case_studies": len(case_studies),
        "published": sum(
            1 for c in case_studies
            if (c.get("bp_status") or "").lower() == "published"
        ),
        "sources": len(sources),
        "outdir": str(outdir),
    }


def deploy(outdir: Path, ssh_host: str, remote_path: str) -> None:
    cmd = [
        "rsync", "-av", "--delete",
        f"{outdir}/",
        f"{ssh_host}:{remote_path}/",
    ]
    print(f"  $ {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--outdir",
        default=os.environ.get(
            "RESEARCH_INDEX_OUTDIR",
            str(Path.home() / ".cache" / "maestro-press-research"),
        ),
        help="Where to stage HTML files (default ~/.cache/maestro-press-research)",
    )
    parser.add_argument(
        "--deploy", action="store_true",
        help="rsync the built files to the maestro.press droplet",
    )
    parser.add_argument(
        "--ssh-host", default="maestro.press",
        help="SSH alias for the droplet (default maestro.press)",
    )
    parser.add_argument(
        "--remote-path", default="/var/www/maestro-press-research",
        help="Remote target directory (default /var/www/maestro-press-research)",
    )
    args = parser.parse_args()

    outdir = Path(args.outdir).expanduser().resolve()
    print(f"  building → {outdir}")
    summary = build(outdir)
    for k, v in summary.items():
        print(f"    {k}: {v}")

    if args.deploy:
        print("  deploying →")
        deploy(outdir, args.ssh_host, args.remote_path)
        print("  done.")


if __name__ == "__main__":
    main()
