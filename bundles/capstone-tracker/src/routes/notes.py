"""
Notes app routes - note-taking with stylus support, OCR, and KB integration.
"""

import hashlib
import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

# ereader_tts deferred to Phase 4a.5 — voices stripped, /tts/prepare route removed below
from src.models.database import (
    Note,
    NoteBlock,
    NoteFolder,
    NoteTag,
    get_sync_engine,
    note_tags,
    utc_now,
)
from src.templates_config import templates

logger = logging.getLogger(__name__)
router = APIRouter()

UPLOAD_DIR = Path(__file__).parent.parent / "static" / "uploads" / "notes"


# --- Pydantic Schemas ---

class FolderCreate(BaseModel):
    name: str
    parent_id: int | None = None
    course_slug: str | None = None

class FolderUpdate(BaseModel):
    name: str | None = None
    parent_id: int | None = None
    course_slug: str | None = None
    sort_order: int | None = None

class NoteCreate(BaseModel):
    folder_id: int | None = None
    title: str = "Untitled Note"
    note_type: str = "whiteboard"  # "whiteboard" or "text"
    content: str | None = None      # markdown content (text notes only)
    tags: list[str] | None = None   # tag names to apply

class NoteUpdate(BaseModel):
    title: str | None = None
    folder_id: int | None = None
    sort_order: int | None = None

class BlockCreate(BaseModel):
    block_type: str  # "ink", "text", "image"
    sort_order: int | None = None
    content: dict | None = None

class BlockUpdate(BaseModel):
    content: dict | None = None
    sort_order: int | None = None

class BlockReorder(BaseModel):
    block_ids: list[int]  # Ordered list of block IDs

class TagAdd(BaseModel):
    name: str


# --- Helpers ---

def _folder_to_dict(folder, note_count=0):
    return {
        "id": folder.id,
        "name": folder.name,
        "parent_id": folder.parent_id,
        "course_slug": folder.course_slug,
        "sort_order": folder.sort_order,
        "note_count": note_count,
        "created_at": folder.created_at.isoformat() if folder.created_at else None,
        "updated_at": folder.updated_at.isoformat() if folder.updated_at else None,
    }

def _note_to_dict(note, include_blocks=False):
    # Derive note_type from first block's block_type
    note_type = "whiteboard"
    if note.blocks:
        first_type = note.blocks[0].block_type
        if first_type == "text":
            note_type = "text"
    d = {
        "id": note.id,
        "folder_id": note.folder_id,
        "title": note.title,
        "note_type": note_type,
        "sort_order": note.sort_order,
        "ocr_text": note.ocr_text,
        "kb_indexed_at": note.kb_indexed_at.isoformat() if note.kb_indexed_at else None,
        "tags": [t.name for t in note.tags] if note.tags else [],
        "created_at": note.created_at.isoformat() if note.created_at else None,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
    }
    if include_blocks:
        d["blocks"] = [_block_to_dict(b) for b in note.blocks]
    return d

def _block_to_dict(block):
    return {
        "id": block.id,
        "note_id": block.note_id,
        "block_type": block.block_type,
        "sort_order": block.sort_order,
        "content": block.content,
        "created_at": block.created_at.isoformat() if block.created_at else None,
        "updated_at": block.updated_at.isoformat() if block.updated_at else None,
    }


def _get_or_create_tag(session: Session, name: str) -> NoteTag:
    """Get an existing tag or create a new one. Returns the NoteTag instance."""
    normalized = name.strip().lower()
    tag = session.execute(
        select(NoteTag).where(NoteTag.name == normalized)
    ).scalar_one_or_none()
    if not tag:
        tag = NoteTag(name=normalized)
        session.add(tag)
        session.flush()
    return tag


# --- Page Routes ---

@router.get("/notes", response_class=HTMLResponse, name="notes_index")
async def notes_browser(request: Request):
    """Notes browser page."""
    engine = get_sync_engine()
    with Session(engine) as session:
        folders = session.execute(
            select(NoteFolder).order_by(NoteFolder.sort_order, NoteFolder.name)
        ).scalars().all()
        tags = session.execute(
            select(NoteTag).order_by(NoteTag.name)
        ).scalars().all()

    return templates.TemplateResponse(
        request, "notes.html", {"folders": folders, "tags": tags},
    )


@router.get("/notes/{note_id}", response_class=HTMLResponse, name="note_view")
async def note_editor(request: Request, note_id: int):
    """Note editor page - dispatches to whiteboard or text editor."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note)
            .options(selectinload(Note.blocks), selectinload(Note.tags))
            .where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        note_data = _note_to_dict(note, include_blocks=True)

    template = "note_text_editor.html" if note_data.get("note_type") == "text" else "note_editor.html"
    context = {"note": note_data}
    return templates.TemplateResponse(request, template, context)


# --- Folder API ---

@router.get("/api/notes/folders", name="get_api_notes_folders")
async def list_folders():
    """List all folders as a flat list (client builds tree from parent_id)."""
    engine = get_sync_engine()
    with Session(engine) as session:
        folders = session.execute(
            select(NoteFolder).order_by(NoteFolder.sort_order, NoteFolder.name)
        ).scalars().all()
        counts = dict(
            session.execute(
                select(Note.folder_id, func.count(Note.id))
                .group_by(Note.folder_id)
            ).all()
        )
        result = [_folder_to_dict(f, note_count=counts.get(f.id, 0)) for f in folders]
    return result


@router.post("/api/notes/folders", name="post_api_notes_folders")
async def create_folder(req: FolderCreate):
    """Create a new folder."""
    engine = get_sync_engine()
    with Session(engine) as session:
        folder = NoteFolder(
            name=req.name,
            parent_id=req.parent_id,
            course_slug=req.course_slug,
        )
        session.add(folder)
        session.commit()
        session.refresh(folder)
        return _folder_to_dict(folder)


@router.patch("/api/notes/folders/{folder_id}", name="patch_api_notes_folders_by_folder_id")
async def update_folder(folder_id: int, req: FolderUpdate):
    """Update a folder."""
    engine = get_sync_engine()
    with Session(engine) as session:
        folder = session.execute(
            select(NoteFolder).where(NoteFolder.id == folder_id)
        ).scalar_one_or_none()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        if req.name is not None:
            folder.name = req.name
        if req.parent_id is not None:
            folder.parent_id = req.parent_id
        if req.course_slug is not None:
            folder.course_slug = req.course_slug
        if req.sort_order is not None:
            folder.sort_order = req.sort_order
        folder.updated_at = utc_now()
        session.commit()
        session.refresh(folder)
        return _folder_to_dict(folder)


@router.delete("/api/notes/folders/{folder_id}", name="delete_api_notes_folders_by_folder_id")
async def delete_folder(folder_id: int):
    """Delete a folder and all its notes."""
    engine = get_sync_engine()
    with Session(engine) as session:
        folder = session.execute(
            select(NoteFolder).where(NoteFolder.id == folder_id)
        ).scalar_one_or_none()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        session.delete(folder)
        session.commit()
    return {"status": "deleted"}


# --- Notes API ---

@router.get("/api/notes/folder/{folder_id}", name="get_api_notes_folder_by_folder_id")
async def list_notes_in_folder(folder_id: int):
    """List notes in a folder."""
    engine = get_sync_engine()
    with Session(engine) as session:
        notes = session.execute(
            select(Note)
            .options(selectinload(Note.tags), selectinload(Note.blocks))
            .where(Note.folder_id == folder_id)
            .order_by(Note.sort_order, Note.updated_at.desc())
        ).scalars().all()
        return [_note_to_dict(n) for n in notes]


@router.get("/api/notes/unfiled", name="get_api_notes_unfiled")
async def list_unfiled_notes():
    """List notes not in any folder."""
    engine = get_sync_engine()
    with Session(engine) as session:
        notes = session.execute(
            select(Note)
            .options(selectinload(Note.tags), selectinload(Note.blocks))
            .where(Note.folder_id.is_(None))
            .order_by(Note.sort_order, Note.updated_at.desc())
        ).scalars().all()
        return [_note_to_dict(n) for n in notes]


@router.post("/api/notes", name="post_api_notes")
async def create_note(req: NoteCreate):
    """Create a new note with a whiteboard or text block.

    Optional fields:
    - content: markdown string (only applied when note_type="text")
    - tags: list of tag names to apply (auto-lowercased, deduplicated)
    """
    engine = get_sync_engine()
    with Session(engine) as session:
        note = Note(
            folder_id=req.folder_id,
            title=req.title,
        )
        session.add(note)
        session.flush()
        if req.note_type == "text":
            markdown = req.content or ""
            block = NoteBlock(
                note_id=note.id,
                block_type="text",
                sort_order=0,
                content={"markdown": markdown, "html": ""},
            )
        else:
            block = NoteBlock(
                note_id=note.id,
                block_type="whiteboard",
                sort_order=0,
                content={"objects": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
            )
        session.add(block)
        session.flush()
        # Apply tags if provided
        if req.tags:
            seen = set()
            for tag_name in req.tags:
                normalized = tag_name.strip().lower()
                if normalized and normalized not in seen:
                    seen.add(normalized)
                    tag = _get_or_create_tag(session, normalized)
                    if tag not in note.tags:
                        note.tags.append(tag)
        session.commit()
        session.refresh(note)
        # Re-query with relationships loaded
        note = session.execute(
            select(Note)
            .options(selectinload(Note.blocks), selectinload(Note.tags))
            .where(Note.id == note.id)
        ).scalar_one()
        return _note_to_dict(note, include_blocks=True)


@router.get("/api/notes/{note_id}", name="get_api_notes_by_note_id")
async def get_note(note_id: int):
    """Get a note with all blocks."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note)
            .options(selectinload(Note.blocks), selectinload(Note.tags))
            .where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        return _note_to_dict(note, include_blocks=True)


@router.patch("/api/notes/{note_id}", name="patch_api_notes_by_note_id")
async def update_note(note_id: int, req: NoteUpdate):
    """Update note metadata."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note).options(selectinload(Note.tags)).where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        if req.title is not None:
            note.title = req.title
        if req.folder_id is not None:
            note.folder_id = req.folder_id
        if req.sort_order is not None:
            note.sort_order = req.sort_order
        note.updated_at = utc_now()
        session.commit()
        session.refresh(note)
        return _note_to_dict(note)


@router.delete("/api/notes/{note_id}", name="delete_api_notes_by_note_id")
async def delete_note(note_id: int):
    """Delete a note and all its blocks."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note).where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        session.delete(note)
        session.commit()
    return {"status": "deleted"}


# --- Block API ---

@router.post("/api/notes/{note_id}/blocks", name="post_api_notes_by_note_id_blocks")
async def add_block(note_id: int, req: BlockCreate):
    """Add a new block to a note."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note).where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        if req.sort_order is None:
            max_order = session.execute(
                select(func.max(NoteBlock.sort_order)).where(NoteBlock.note_id == note_id)
            ).scalar() or -1
            sort_order = max_order + 1
        else:
            sort_order = req.sort_order
        default_content = {
            "ink": {"strokes": [], "width": 800, "height": 400},
            "text": {"html": ""},
            "image": {"filename": "", "width": 0, "height": 0, "alt": ""},
        }
        block = NoteBlock(
            note_id=note_id,
            block_type=req.block_type,
            sort_order=sort_order,
            content=req.content or default_content.get(req.block_type, {}),
        )
        session.add(block)
        note.updated_at = utc_now()
        session.commit()
        session.refresh(block)
        return _block_to_dict(block)


@router.patch("/api/notes/blocks/{block_id}", name="patch_api_notes_blocks_by_block_id")
async def update_block(block_id: int, req: BlockUpdate):
    """Update a block's content or sort order."""
    engine = get_sync_engine()
    with Session(engine) as session:
        block = session.execute(
            select(NoteBlock).where(NoteBlock.id == block_id)
        ).scalar_one_or_none()
        if not block:
            raise HTTPException(status_code=404, detail="Block not found")
        if req.content is not None:
            block.content = req.content
        if req.sort_order is not None:
            block.sort_order = req.sort_order
        block.updated_at = utc_now()
        note = session.execute(
            select(Note).where(Note.id == block.note_id)
        ).scalar_one_or_none()
        if note:
            note.updated_at = utc_now()
        session.commit()
        session.refresh(block)
        return _block_to_dict(block)


@router.delete("/api/notes/blocks/{block_id}", name="delete_api_notes_blocks_by_block_id")
async def delete_block(block_id: int):
    """Delete a block."""
    engine = get_sync_engine()
    with Session(engine) as session:
        block = session.execute(
            select(NoteBlock).where(NoteBlock.id == block_id)
        ).scalar_one_or_none()
        if not block:
            raise HTTPException(status_code=404, detail="Block not found")
        session.delete(block)
        session.commit()
    return {"status": "deleted"}


@router.post("/api/notes/blocks/reorder", name="post_api_notes_blocks_reorder")
async def reorder_blocks(req: BlockReorder):
    """Reorder blocks by providing ordered list of block IDs."""
    engine = get_sync_engine()
    with Session(engine) as session:
        for i, block_id in enumerate(req.block_ids):
            block = session.execute(
                select(NoteBlock).where(NoteBlock.id == block_id)
            ).scalar_one_or_none()
            if block:
                block.sort_order = i
        session.commit()
    return {"status": "reordered"}


# --- Tags API ---

@router.post("/api/notes/{note_id}/tags", name="post_api_notes_by_note_id_tags")
async def add_tag(note_id: int, req: TagAdd):
    """Add a tag to a note. Creates the tag if it doesn't exist."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note).options(selectinload(Note.tags)).where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        tag = _get_or_create_tag(session, req.name)
        if tag not in note.tags:
            note.tags.append(tag)
        session.commit()
        return {"tags": [t.name for t in note.tags]}


@router.delete("/api/notes/{note_id}/tags/{tag_name}", name="delete_api_notes_by_note_id_tags_by_tag_name")
async def remove_tag(note_id: int, tag_name: str):
    """Remove a tag from a note."""
    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note).options(selectinload(Note.tags)).where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        tag = session.execute(
            select(NoteTag).where(NoteTag.name == tag_name.strip().lower())
        ).scalar_one_or_none()
        if tag and tag in note.tags:
            note.tags.remove(tag)
        session.commit()
        return {"tags": [t.name for t in note.tags]}


# --- Search API ---

@router.get("/api/notes/search", name="get_api_notes_search")
async def search_notes(q: str):
    """Search notes by title, tags, and OCR text."""
    engine = get_sync_engine()
    with Session(engine) as session:
        pattern = f"%{q}%"
        notes = session.execute(
            select(Note)
            .options(selectinload(Note.tags), selectinload(Note.blocks))
            .where(
                (Note.title.ilike(pattern)) | (Note.ocr_text.ilike(pattern))
            )
            .order_by(Note.updated_at.desc())
            .limit(50)
        ).scalars().all()
        tag_notes = session.execute(
            select(Note)
            .options(selectinload(Note.tags), selectinload(Note.blocks))
            .join(note_tags)
            .join(NoteTag)
            .where(NoteTag.name.ilike(pattern))
            .order_by(Note.updated_at.desc())
            .limit(50)
        ).scalars().all()
        seen = set()
        result = []
        for n in list(notes) + list(tag_notes):
            if n.id not in seen:
                seen.add(n.id)
                result.append(_note_to_dict(n))
        return result


# --- OCR & KB Indexing ---

@router.post("/api/notes/{note_id}/ocr", name="post_api_notes_by_note_id_ocr")
async def ocr_and_index(note_id: int):
    """Run OCR on all blocks and index to Knowledge Base."""
    from src.services.notes_ocr import ocr_note, ocr_whiteboard

    engine = get_sync_engine()
    with Session(engine) as session:
        note = session.execute(
            select(Note)
            .options(selectinload(Note.blocks), selectinload(Note.tags))
            .where(Note.id == note_id)
        ).scalar_one_or_none()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")

        # Check for whiteboard or ink block with objects (whiteboard format)
        blocks_data = [_block_to_dict(b) for b in note.blocks]
        wb_block = next((b for b in blocks_data if b["block_type"] == "whiteboard"), None)
        if not wb_block:
            # Ink blocks saved by the whiteboard editor use "objects" key
            wb_block = next(
                (b for b in blocks_data
                 if b["block_type"] == "ink"
                 and isinstance(b.get("content"), dict)
                 and "objects" in (b.get("content") or {})),
                None,
            )
        if wb_block:
            ocr_text = ocr_whiteboard(wb_block["content"] or {})
        else:
            ocr_text = ocr_note(blocks_data)

        # Update note
        note.ocr_text = ocr_text
        note.kb_indexed_at = utc_now()
        session.commit()

        # Try to index to KB (best effort)
        try:
            import sqlite3
            kb_path = Path.home() / ".knowledge-base" / "kb.db"
            if kb_path.exists():
                folder_name = ""
                if note.folder_id:
                    folder = session.execute(
                        select(NoteFolder).where(NoteFolder.id == note.folder_id)
                    ).scalar_one_or_none()
                    folder_name = folder.name if folder else ""

                tags_str = ", ".join(t.name for t in note.tags)
                kb_conn = sqlite3.connect(str(kb_path))
                note_key = f"note:{note.id}"
                note_value = json.dumps({
                    "title": note.title,
                    "folder": folder_name,
                    "tags": tags_str,
                    "text": ocr_text,
                })
                # Check if entry exists by key
                existing = kb_conn.execute(
                    "SELECT id FROM kb_memories WHERE key = ?", (note_key,)
                ).fetchone()
                if existing:
                    kb_conn.execute(
                        "UPDATE kb_memories SET value = ?, created_at = datetime('now') WHERE key = ?",
                        (note_value, note_key),
                    )
                else:
                    import uuid as _uuid
                    kb_conn.execute(
                        """INSERT INTO kb_memories (id, key, value, scope, created_at)
                           VALUES (?, ?, ?, 'notes', datetime('now'))""",
                        (str(_uuid.uuid4()), note_key, note_value),
                    )
                kb_conn.commit()
                kb_conn.close()
                logger.info(f"Indexed note {note.id} to KB")
        except Exception as e:
            logger.warning(f"Failed to index note to KB: {e}")

    return {
        "status": "indexed",
        "ocr_text_length": len(ocr_text),
        "ocr_text_preview": ocr_text[:200] if ocr_text else "",
    }


# --- Image Upload ---

# The uploads dir is served statically, so the extension must come from an
# allowlist and the bytes must actually be an image — otherwise an uploaded
# .html/.svg becomes stored XSS on this origin.
ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
IMAGE_MAGIC = {
    b"\x89PNG\r\n\x1a\n": ".png",
    b"\xff\xd8\xff": ".jpg",
    b"GIF87a": ".gif",
    b"GIF89a": ".gif",
}


def _sniff_image_ext(content: bytes) -> str | None:
    for magic, ext in IMAGE_MAGIC.items():
        if content.startswith(magic):
            return ext
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    return None


@router.post("/api/notes/upload", name="post_api_notes_upload")
async def upload_image(file: UploadFile = File(...)):
    """Upload an image for use in a note."""
    import uuid
    content = await file.read()
    sniffed = _sniff_image_ext(content)
    claimed = Path(file.filename or "").suffix.lower()
    if sniffed is None or (claimed and claimed not in ALLOWED_IMAGE_EXTS):
        raise HTTPException(status_code=400, detail="Only PNG, JPEG, GIF, or WebP images are accepted")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    # Extension comes from the sniffed bytes, never from the client filename.
    filename = f"img_{uuid.uuid4().hex[:12]}{sniffed}"
    filepath = UPLOAD_DIR / filename
    filepath.write_bytes(content)
    return {
        "filename": filename,
        "url": f"/static/uploads/notes/{filename}",
    }


# --- Beacon Save (for sendBeacon on tab close) ---

class BeaconSave(BaseModel):
    content: dict
    block_id: int

@router.post("/api/notes/{note_id}/beacon-save", name="post_api_notes_by_note_id_beacon_save")
async def beacon_save(note_id: int, req: BeaconSave):
    """Save whiteboard content via sendBeacon (fires on tab close)."""
    engine = get_sync_engine()
    with Session(engine) as session:
        block = session.execute(
            select(NoteBlock).where(
                NoteBlock.id == req.block_id,
                NoteBlock.note_id == note_id,
            )
        ).scalar_one_or_none()
        if not block:
            raise HTTPException(status_code=404, detail="Block not found")
        block.content = req.content
        block.updated_at = utc_now()
        note = session.execute(
            select(Note).where(Note.id == note_id)
        ).scalar_one_or_none()
        if note:
            note.updated_at = utc_now()
        session.commit()
    return {"status": "saved"}


# --- TTS Prepare ---

def strip_markdown_to_text(md: str) -> str:
    """Strip markdown formatting to plain text for TTS consumption."""
    text = md
    # Remove fenced code blocks
    text = re.sub(r'```[\s\S]*?```', '', text)
    # Remove inline code
    text = re.sub(r'`[^`]+`', '', text)
    # Remove images
    text = re.sub(r'!\[([^\]]*)\]\([^)]+\)', '', text)
    # Convert links to just their text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # Remove heading markers
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    # Remove bold/italic markers
    text = re.sub(r'\*{1,3}([^*]+)\*{1,3}', r'\1', text)
    text = re.sub(r'_{1,3}([^_]+)_{1,3}', r'\1', text)
    # Remove blockquote markers
    text = re.sub(r'^>\s*', '', text, flags=re.MULTILINE)
    # Remove list markers (unordered and ordered)
    text = re.sub(r'^[\s]*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[\s]*\d+\.\s+', '', text, flags=re.MULTILINE)
    # Remove horizontal rules
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    # Remove HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    # Clean up extra whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


