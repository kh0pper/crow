#!/usr/bin/env python3
"""
Phase 8.5 render-application-pdfs — deterministic Python script run by systemd
timer. Picks up bot_conversations rows at current_step='finalized' that have no
pdf_rendered_at marker, fetches the Google Doc, splits resume + cover letter,
renders both via typst, uploads to the same Drive folder, and stamps the
payload.

Designed to use the same OAuth credentials as ~/spring-2026/google-workspace-mcp
(its .venv is the script's interpreter so all google-api-python-client imports
resolve).

Idempotent — re-runs are no-ops on already-rendered rows.

Run manually with:
    /home/kh0pp/spring-2026/google-workspace-mcp/.venv/bin/python3 \
        /home/kh0pp/crow/scripts/bots/render-application-pdfs.py
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Reuse the existing google-workspace-mcp Python package (installed editable
# under its .venv) for OAuth + Drive + Docs helpers. The pyproject.toml maps
# packages = ["src"], so the actual import root is "src".
sys.path.insert(
    0, "/home/kh0pp/spring-2026/google-workspace-mcp"
)

from src.auth import get_drive_service  # noqa: E402
from googleapiclient.http import MediaFileUpload  # noqa: E402

LOG = logging.getLogger("render-application-pdfs")

DB_PATH = os.environ.get("CROW_DB_PATH", "/home/kh0pp/.crow-mpa/data/crow.db")
TYPST_BIN = os.environ.get("TYPST_BIN", "/home/kh0pp/bin/typst")
TEMPLATE_DIR = Path(
    os.environ.get("JOBSEARCH_TEMPLATE_DIR", "/home/kh0pp/crow/templates/job-search")
)
RESUME_TPL = TEMPLATE_DIR / "resume.typ"
COVER_TPL = TEMPLATE_DIR / "cover-letter.typ"

DEFAULT_NAME = "Kevin Hopper"
RESUME_CONTACT = (
    "Houston, TX | (972) 754-6406 | kevin.hopper1@gmail.com | "
    "linkedin.com/in/kevinmhopper"
)
COVER_CONTACT = "Houston, TX | (972) 754-6406 | kevin.hopper1@gmail.com"

# Split marker between resume and cover letter as emitted by the drafter prompt.
# Drafter writes:
#   <resume markdown>
#   \n\n---\n\n
#   # Cover Letter
#   ...
SPLIT_RE = re.compile(r"\n-{3,}\s*\n+# *Cover Letter\s*\n", re.IGNORECASE)


def _query_pending(conn: sqlite3.Connection) -> list[dict]:
    """Pick up conversations finalized but not yet rendered to PDF."""
    rows = conn.execute(
        """
        SELECT id, payload
        FROM bot_conversations
        WHERE bot_id = 'job-search'
          AND status = 'applied'
          AND current_step = 'finalized'
          AND google_doc_id IS NOT NULL
        ORDER BY updated_at ASC
        LIMIT 10
        """
    ).fetchall()
    out = []
    for row in rows:
        try:
            payload = json.loads(row[1]) if row[1] else {}
        except json.JSONDecodeError:
            payload = {}
        if payload.get("pdf_rendered_at"):
            continue
        out.append({"id": row[0], "payload": payload})
    return out


def _fetch_doc_markdown(doc_id: str) -> str:
    """Read the Google Doc and return its content as markdown."""
    # We use the same helper module the gws-mcp tool uses to convert the
    # API's structured Doc representation into markdown. That keeps the
    # split logic stable across changes to the upstream Doc format.
    from src.docs import _get_doc_structure  # noqa: PLC0415
    from src.docs_formatting import docs_structure_to_markdown  # noqa: PLC0415

    doc = _get_doc_structure(doc_id)
    body = doc.get("body", {})
    lists_info = doc.get("lists", {})
    title = doc.get("title", "")
    return docs_structure_to_markdown(body, title, lists_info)


def _split_resume_cover(body: str) -> tuple[str, str]:
    parts = SPLIT_RE.split(body, maxsplit=1)
    if len(parts) != 2:
        raise ValueError(
            "Could not find resume/cover-letter split marker "
            "'\\n---\\n# Cover Letter' in doc body"
        )
    resume_md, cover_md = parts

    # Resume header strip: the drafter emits
    #     # Kevin Hopper\n\n<contact line>\n\n## ...
    # but my templates render the name + contact from --input fields, so we
    # strip both (plus any padding) before the body goes to cmarker.
    lines = resume_md.split("\n")
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    # Skip any blank lines after the H1.
    while lines and not lines[0].strip():
        lines = lines[1:]
    # The very first non-blank, non-heading line is the contact line.
    if lines and not lines[0].startswith("#"):
        lines = lines[1:]
    # Skip any blank lines after the contact line.
    while lines and not lines[0].strip():
        lines = lines[1:]
    resume_body = "\n".join(lines)

    # Strip standalone "---" lines from both halves — cmarker renders them as
    # horizontal rules, and combined with our H2 show rule that already draws
    # a rule under each section header, they double up visually. The drafter
    # spec uses ---/# Cover Letter ONLY to separate the two halves (already
    # consumed above by SPLIT_RE), so any remaining "---" rows are redundant.
    def strip_rules(text: str) -> str:
        out = []
        for ln in text.split("\n"):
            stripped = ln.strip()
            if stripped and len(stripped) >= 3 and all(c == "-" for c in stripped):
                continue  # standalone horizontal-rule line
            out.append(ln)
        return "\n".join(out)

    return strip_rules(resume_body), strip_rules(cover_md.strip())


def _render_pdf(template_path: Path, body_md: str, contact: str, out_path: Path) -> None:
    # Typst requires every input file (template + body + any reads) to live
    # under the --root directory. We copy the template into the temp dir
    # alongside the body so the root is self-contained, then point typst at
    # the local copy.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        body_file = tmp_root / "body.md"
        body_file.write_text(body_md, encoding="utf-8")
        local_tpl = tmp_root / template_path.name
        local_tpl.write_bytes(template_path.read_bytes())
        cmd = [
            TYPST_BIN,
            "compile",
            "--root", str(tmp_root),
            "--input", f"name={DEFAULT_NAME}",
            "--input", f"contact={contact}",
            "--input", "body-path=/body.md",
            str(local_tpl),
            str(out_path),
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"typst compile failed ({result.returncode}):\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )


def _drive_upload(folder_id: str, local_path: Path, name: str) -> dict:
    drive = get_drive_service()
    media = MediaFileUpload(str(local_path), mimetype="application/pdf")
    metadata = {"name": name, "parents": [folder_id]}
    created = drive.files().create(
        body=metadata,
        media_body=media,
        fields="id, name, webViewLink, parents",
    ).execute()
    return created


def _patch_conversation(
    conn: sqlite3.Connection, conv_id: str, payload: dict
) -> None:
    new_payload = json.dumps(payload)
    conn.execute(
        """
        UPDATE bot_conversations
        SET payload = ?, updated_at = datetime('now')
        WHERE id = ?
        """,
        (new_payload, conv_id),
    )
    conn.commit()


def _process_one(conn: sqlite3.Connection, row: dict) -> None:
    conv_id = row["id"]
    payload = row["payload"]
    doc_id = (
        # bot_conversations.google_doc_id column overrides payload, but the
        # payload also keeps a copy in some upserts. Try the canonical column
        # first then fall back to payload.
        conn.execute(
            "SELECT google_doc_id FROM bot_conversations WHERE id = ?",
            (conv_id,),
        ).fetchone()[0]
    )
    if not doc_id:
        LOG.warning("conv=%s has no google_doc_id, skipping", conv_id)
        return
    employer = payload.get("employer", "Application")
    title = payload.get("title", "")
    safe_employer = re.sub(r"[^A-Za-z0-9_.-]+", "_", employer).strip("_") or "Employer"
    safe_title = re.sub(r"[^A-Za-z0-9_.-]+", "_", title).strip("_") or "Role"
    folder_id = payload.get("drive_folder_id") or "1UeKCUpaslWfUqne3CihizwTf4s0THmjX"

    LOG.info("rendering conv=%s doc=%s employer=%s", conv_id, doc_id, employer)

    body_md = _fetch_doc_markdown(doc_id)
    resume_md, cover_md = _split_resume_cover(body_md)

    with tempfile.TemporaryDirectory() as tmp:
        resume_pdf = Path(tmp) / f"{safe_employer}-{safe_title}-resume.pdf"
        cover_pdf = Path(tmp) / f"{safe_employer}-{safe_title}-cover-letter.pdf"

        _render_pdf(RESUME_TPL, resume_md, RESUME_CONTACT, resume_pdf)
        _render_pdf(COVER_TPL, cover_md, COVER_CONTACT, cover_pdf)

        resume_meta = _drive_upload(folder_id, resume_pdf, resume_pdf.name)
        cover_meta = _drive_upload(folder_id, cover_pdf, cover_pdf.name)

    payload["pdf_resume_drive_id"] = resume_meta["id"]
    payload["pdf_resume_view_link"] = resume_meta.get("webViewLink")
    payload["pdf_cover_drive_id"] = cover_meta["id"]
    payload["pdf_cover_view_link"] = cover_meta.get("webViewLink")
    payload["pdf_rendered_at"] = datetime.now(timezone.utc).isoformat()

    _patch_conversation(conn, conv_id, payload)
    LOG.info(
        "rendered+uploaded conv=%s resume=%s cover=%s",
        conv_id, resume_meta["id"], cover_meta["id"],
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="[render-application-pdfs] %(message)s",
    )
    if not RESUME_TPL.exists() or not COVER_TPL.exists():
        LOG.error("templates missing under %s", TEMPLATE_DIR)
        return 1
    if not Path(TYPST_BIN).exists():
        LOG.error("typst binary not found at %s", TYPST_BIN)
        return 1

    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        pending = _query_pending(conn)
        if not pending:
            LOG.info("no rows pending render")
            return 0
        LOG.info("found %d row(s) pending render", len(pending))
        failures = 0
        for row in pending:
            try:
                _process_one(conn, row)
            except Exception as err:  # noqa: BLE001
                failures += 1
                LOG.exception("conv=%s render failed: %s", row["id"], err)
        return 0 if failures == 0 else 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
