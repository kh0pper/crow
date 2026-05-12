"""Bulk-index ~/spring-2026/insd-5941/drafts/*.md into project_docs.

Run on the host where the KB MCP venv + the .md files both live (crow).
Idempotent: rerunning skips drafts whose content_hash already matches.
"""
import asyncio
import hashlib
import os
import re
import sys
from pathlib import Path

BUNDLE = Path.home() / "crow" / "bundles" / "knowledge-base-mcp"
sys.path.insert(0, str(BUNDLE))

# Match the running MCP's env so we write to the same Chroma
os.environ.setdefault("KB_MCP_CHROMA_PATH",
    str(Path.home() / ".crow" / "data" / "knowledge-base-mcp" / "chroma"))
os.environ.setdefault("KB_MCP_DB_PATH",
    str(Path.home() / ".crow" / "data" / "knowledge-base-mcp" / "kb.db"))
os.environ.setdefault("EMBED_HOST",      "http://100.118.41.122:8004")
os.environ.setdefault("EMBED_API_STYLE", "openai")
os.environ.setdefault("EMBED_MODEL",     "qwen3-embedding-0.6b")

from src.db.vectors import VectorStore  # noqa: E402
from src.tools import drafts_register   # noqa: E402

DRAFTS_DIR = Path.home() / "spring-2026" / "insd-5941" / "drafts"
PROJECT_ID = "6"  # Texas School Finance Capstone


def infer_document_type(filename: str, path_parts: tuple) -> str:
    """Heuristic mapping of filename → document_type."""
    name = filename.lower()
    parts = tuple(p.lower() for p in path_parts)

    if any("hearing" in p for p in parts) or "leave-behind" in name or "testimony" in name:
        return "testimony"
    if "ag-complaint" in name or any("ag-complaint" in p for p in parts):
        return "correspondence"
    if "lrn-application" in name or "policy-brief" in name or "policy_brief" in name:
        return "policy-brief"
    if "op-ed" in name or "oped" in name:
        return "op-ed"
    if "outline" in name:
        return "outline"
    if "lit-review" in name or "literature-review" in name or "literature_review" in name:
        return "literature-review"
    if "reply" in name or "followup" in name or "follow-up" in name or "email" in name:
        return "correspondence"
    if "memo" in name:
        return "memo"
    return "draft"


HEADING_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def derive_title(filename: str, body: str) -> str:
    """Use first H1 if present, else filename stem with dashes→spaces."""
    m = HEADING_RE.search(body[:4000])  # only first chunk
    if m:
        title = m.group(1).strip().rstrip(":").rstrip(".")
        if 4 <= len(title) <= 200:
            return title
    stem = Path(filename).stem
    return re.sub(r"[-_]+", " ", stem).strip()


def derive_tags(filename: str, path_parts: tuple) -> list:
    """Hand-rolled tag inference from filename + subdir."""
    tags = []
    name = filename.lower()
    parts = tuple(p.lower() for p in path_parts)

    # District tags
    for district in ("austin", "cleveland", "dallas", "houston", "kipp",
                     "iltexas", "harmony", "idea-public", "idea"):
        if district in name or any(district in p for p in parts):
            tags.append(district + "-isd" if not district.endswith("-public") and district != "iltexas" else district)
    # Topic tags
    for kw in ("pir", "bond-election", "absenteeism", "charter",
               "arc-regression", "tea", "rda", "school-finance",
               "fast-act", "fast", "house-bill", "senate-bill"):
        if kw in name:
            tags.append(kw)
    # Subdir tags (use directory names directly)
    for p in path_parts:
        if p and p not in ("drafts",) and not p.startswith("."):
            tags.append(p)
    # Dedup while preserving order
    seen = set()
    out = []
    for t in tags:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


async def main():
    if not DRAFTS_DIR.is_dir():
        print(f"ERROR: {DRAFTS_DIR} not found", file=sys.stderr)
        sys.exit(1)

    md_files = sorted(
        p for p in DRAFTS_DIR.rglob("*.md")
        if ".deck-venv" not in p.parts
    )
    print(f"Found {len(md_files)} markdown files under {DRAFTS_DIR}")

    vs = VectorStore(persist_directory=os.environ["KB_MCP_CHROMA_PATH"])

    # Get current state (for skip-on-unchanged)
    existing = await drafts_register.list_drafts_indexed(vs)
    by_id = {d["draft_id"]: d for d in existing["drafts"]}
    print(f"Already indexed: {len(by_id)} drafts")

    stats = {"new": 0, "updated": 0, "unchanged": 0, "errors": 0,
             "chunks": 0, "skipped_empty": 0}

    for i, mdpath in enumerate(md_files, 1):
        rel = mdpath.relative_to(DRAFTS_DIR)
        # path_parts for tag/type inference (relative to drafts root)
        path_parts = rel.parent.parts

        # Compute content_hash to compare to indexed state
        try:
            raw = mdpath.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            print(f"  [{i:3d}/{len(md_files)}] SKIP non-utf8: {rel}")
            stats["errors"] += 1
            continue
        if not raw.strip():
            stats["skipped_empty"] += 1
            continue

        body = drafts_register._strip_frontmatter(raw)
        if not body.strip():
            stats["skipped_empty"] += 1
            continue

        content_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
        draft_id = drafts_register._draft_id_for_path(str(mdpath))

        prior = by_id.get(draft_id)
        if prior and prior.get("content_hash") == content_hash:
            stats["unchanged"] += 1
            continue

        title = derive_title(mdpath.name, body)
        doc_type = infer_document_type(mdpath.name, path_parts)
        tags = derive_tags(mdpath.name, path_parts)

        result = await drafts_register.register_draft(
            vs,
            title=title,
            local_path=str(mdpath),
            document_type=doc_type,
            project_id=PROJECT_ID,
            tags=tags,
        )

        if not result.get("success"):
            print(f"  [{i:3d}/{len(md_files)}] ERROR {rel}: {result.get('error')}")
            stats["errors"] += 1
            continue

        # If prior had fewer chunks now, leftover IDs at higher indices remain.
        # Purge them by deleting any chunks with chunk_index >= new count.
        if prior:
            stats["updated"] += 1
        else:
            stats["new"] += 1
        stats["chunks"] += result["chunks_indexed"]
        print(f"  [{i:3d}/{len(md_files)}] {'UPD' if prior else 'NEW'} "
              f"({result['chunks_indexed']} chunks, {result['word_count']} words) "
              f"[{doc_type}] {title[:60]}")

    print("\n=== SUMMARY ===")
    for k, v in stats.items():
        print(f"  {k:>16}: {v}")

    # Final state
    final = await drafts_register.list_drafts_indexed(vs)
    print(f"  total indexed drafts: {final['count']}")


if __name__ == "__main__":
    asyncio.run(main())
