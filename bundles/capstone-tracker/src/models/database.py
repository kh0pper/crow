"""
SQLite database setup for capstone-tracker bundle.

Extracted from canvas-companion. Carries only the 7 tables in Phase 4a v1:
note_tags_list, note_folders, notes, note_blocks, note_tags (assoc),
pir_requests, advocacy_communications.

E-reader tables (reading_progress, ereader_pins, ereader_material_tags)
deferred to Phase 4a.5.

DB path: /data/capstone.db (host-mounted from ~/.crow/data/capstone-tracker/).
"""

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator
from zoneinfo import ZoneInfo

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Table,
    Text,
    create_engine,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, relationship


def utc_now():
    return datetime.now(timezone.utc)


def local_now():
    return datetime.now(ZoneInfo("America/Chicago"))


DB_PATH = os.environ.get("CAPSTONE_DB_PATH", "/data/capstone.db")


class Base(DeclarativeBase):
    pass


# ── Note tags association ────────────────────────────────────────────────
note_tags = Table(
    "note_tags",
    Base.metadata,
    Column("note_id", Integer, ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("note_tags_list.id", ondelete="CASCADE"), primary_key=True),
)


class NoteFolder(Base):
    __tablename__ = "note_folders"

    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    parent_id = Column(Integer, ForeignKey("note_folders.id"), nullable=True)
    course_slug = Column(String(50), nullable=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    children = relationship("NoteFolder", backref="parent", remote_side="NoteFolder.id",
                            lazy="selectin")
    notes = relationship("Note", back_populates="folder", cascade="all, delete-orphan")


class NoteTag(Base):
    __tablename__ = "note_tags_list"

    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False, unique=True)


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True)
    folder_id = Column(Integer, ForeignKey("note_folders.id"), nullable=True)
    title = Column(String(500), nullable=False, default="Untitled Note")
    sort_order = Column(Integer, default=0)
    ocr_text = Column(Text, nullable=True)
    kb_indexed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    folder = relationship("NoteFolder", back_populates="notes")
    blocks = relationship("NoteBlock", back_populates="note", cascade="all, delete-orphan",
                          order_by="NoteBlock.sort_order")
    tags = relationship("NoteTag", secondary=note_tags, backref="notes", lazy="selectin")


class NoteBlock(Base):
    __tablename__ = "note_blocks"

    id = Column(Integer, primary_key=True)
    note_id = Column(Integer, ForeignKey("notes.id"), nullable=False)
    block_type = Column(String(20), nullable=False)
    sort_order = Column(Integer, default=0)
    content = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    note = relationship("Note", back_populates="blocks")


class PIRRequest(Base):
    """Tracks Public Information Requests for capstone research.

    NOTE: research_project_id is a plain INTEGER. The cross-bundle reference
    to research_projects (crow.db) is application-layer; declaring it as a
    FOREIGN KEY here would create false-positive orphan rows during
    PRAGMA foreign_key_check (research_projects does not exist in
    capstone.db).
    """
    __tablename__ = "pir_requests"

    id = Column(Integer, primary_key=True)
    pir_number = Column(String(10), nullable=False, unique=True)
    label = Column(String(200), nullable=False)
    recipient = Column(String(200), nullable=False)
    recipient_email = Column(String(200), nullable=True)
    tea_id = Column(String(10), nullable=True)
    reference_number = Column(String(100), nullable=True)
    sq1 = Column(Boolean, default=False)
    sq2 = Column(Boolean, default=False)
    sq3 = Column(Boolean, default=False)
    sq4 = Column(Boolean, default=False)
    priority = Column(String(10), default="MEDIUM")
    status = Column(String(30), default="pending", index=True)
    filed_date = Column(DateTime, nullable=False)
    response_due = Column(DateTime, nullable=False, index=True)
    received_date = Column(DateTime, nullable=True)
    note_id = Column(Integer, ForeignKey("notes.id", ondelete="SET NULL"), nullable=True)
    description = Column(Text, nullable=True)
    status_notes = Column(Text, nullable=True)
    action_needed = Column(Text, nullable=True)
    next_followup_date = Column(DateTime, nullable=True)
    s3_prefix = Column(String(200), nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class CapstonePIRFile(Base):
    """Per-file linkage from MinIO objects under capstone-research/pirs/* to PIRs.

    Authoritative audit trail (Phase 4a.5): use pir_request_id (FK) to identify
    which PIR a file answers. pir_requests.s3_prefix is a convenience view; the
    file-level row here is the system of record.
    """
    __tablename__ = "capstone_pir_files"

    id = Column(Integer, primary_key=True)
    pir_request_id = Column(Integer, ForeignKey("pir_requests.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(Integer, nullable=False, default=6)
    district = Column(String(200), nullable=False)
    district_slug = Column(String(100), nullable=False, index=True)
    pir_number = Column(String(50), nullable=True)
    file_name = Column(String(500), nullable=False)
    title = Column(Text, nullable=False)
    minio_key = Column(Text, nullable=False, unique=True)
    minio_bucket = Column(String(100), nullable=False, default="capstone-research")
    collection = Column(String(50), nullable=False, default="pir")
    content_type = Column(String(100), nullable=True)
    size_bytes = Column(Integer, nullable=True)
    sha256 = Column(String(64), nullable=True, index=True)
    received_date = Column(String(30), nullable=True)
    review_status = Column(String(20), nullable=False, default="pending")
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class AdvocacyComm(Base):
    __tablename__ = "advocacy_communications"

    id = Column(Integer, primary_key=True)
    comm_type = Column(String(30), nullable=False, index=True)
    direction = Column(String(10), nullable=False, default="outbound")
    contact_name = Column(String(200), nullable=False)
    contact_org = Column(String(200), nullable=True, index=True)
    contact_email = Column(String(200), nullable=True)
    channel = Column(String(30), nullable=False, default="email")
    thread_id = Column(String(100), nullable=True, index=True)
    subject = Column(String(500), nullable=True)
    sender_account = Column(String(100), nullable=True)
    ask = Column(Text, nullable=True)
    response_summary = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="drafted", index=True)
    priority = Column(Integer, default=3)
    phase = Column(String(20), nullable=True, index=True)
    sub_question = Column(String(20), nullable=True)
    mpa_task_id = Column(Integer, nullable=True)
    note_id = Column(Integer, ForeignKey("notes.id", ondelete="SET NULL"), nullable=True)
    sent_date = Column(DateTime, nullable=True, index=True)
    next_followup_date = Column(DateTime, nullable=True)
    description = Column(Text, nullable=True)
    status_notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


# ── E-Reader tables (Phase 4a.5) ──────────────────────────────────────────
class ReadingProgress(Base):
    """Per-content reading position. content_type ∈ {textbook, document, source}."""
    __tablename__ = "reading_progress"

    id = Column(Integer, primary_key=True)
    content_type = Column(String(20), nullable=False, index=True)
    content_key = Column(String(100), nullable=False, index=True)
    chapter_or_section = Column(Integer, nullable=True)
    paragraph = Column(Integer, nullable=False)
    total_paragraphs = Column(Integer, nullable=True)
    last_read_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class EReaderPin(Base):
    """Pinned-to-top materials for the e-reader library."""
    __tablename__ = "ereader_pins"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id = Column(Integer, primary_key=True)
    material_type = Column(String(20), nullable=False)
    material_key = Column(String(100), nullable=False)
    sort_order = Column(Integer, default=0)
    pinned_at = Column(DateTime, default=utc_now)


class EReaderMaterialTag(Base):
    """Per-material tags. tag_id FKs note_tags_list (the shared tag dictionary)."""
    __tablename__ = "ereader_material_tags"

    id = Column(Integer, primary_key=True)
    material_type = Column(String(20), nullable=False, index=True)
    material_key = Column(String(100), nullable=False)
    tag_id = Column(Integer, ForeignKey("note_tags_list.id", ondelete="CASCADE"),
                    nullable=False, index=True)


# ── Engine + session helpers ──────────────────────────────────────────────
def get_sync_engine():
    return create_engine(f"sqlite:///{DB_PATH}", echo=False)


def get_async_engine():
    return create_async_engine(f"sqlite+aiosqlite:///{DB_PATH}", echo=False)


_async_session_maker = None


def get_session_maker():
    global _async_session_maker
    if _async_session_maker is None:
        engine = get_async_engine()
        _async_session_maker = async_sessionmaker(engine, expire_on_commit=False)
    return _async_session_maker


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    session_maker = get_session_maker()
    async with session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
