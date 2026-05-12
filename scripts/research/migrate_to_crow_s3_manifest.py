#!/usr/bin/env python3
"""
migrate_to_crow_s3_manifest.py
==============================

Reads `mc ls --json --recursive crow/capstone-research` and emits a jsonl
manifest that maps each s3 key back to its local source path, with sha256 +
bytes + content_type + uploaded_at. fsync per row so partial runs recover.

Idempotent: skips rows whose s3_key + size already appear in the existing
manifest (keeps stored sha256 unless user passes --recompute).
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

CAPSTONE_ROOT = Path(
    os.environ.get("CAPSTONE_ROOT", os.path.expanduser("~/spring-2026"))
)
MANIFEST = Path(os.environ.get(
    "S3_MANIFEST_PATH",
    str(Path.home() / "crow" / "scripts" / "research" / "manifests" / "s3_manifest.jsonl"),
))
BUCKET = os.environ.get("CAPSTONE_BUCKET", "crow/capstone-research")

# prefix → local root mapping
PREFIX_TO_LOCAL = {
    "pirs/": CAPSTONE_ROOT / "pir-responses",
    "sources/": CAPSTONE_ROOT / "insd-5941" / "sources",
    "cache/": Path(os.path.expanduser("~/.research-mcp/cache")),
    "geo/": CAPSTONE_ROOT / "canvas-companion" / "data",
}


def mc_ls_recursive(bucket: str) -> list[dict]:
    """mc ls --json returns one JSON object per line."""
    result = subprocess.run(
        ["mc", "ls", "--json", "--recursive", bucket],
        capture_output=True, text=True, check=True,
    )
    out = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def resolve_local(s3_key: str) -> Path | None:
    """Map an s3 key (e.g. 'pirs/Aldine-ISD/foo.pdf') back to local path."""
    for prefix, local_root in PREFIX_TO_LOCAL.items():
        if s3_key.startswith(prefix):
            rel = s3_key[len(prefix):]
            return local_root / rel
    return None


def load_existing_manifest() -> dict[str, dict]:
    if not MANIFEST.exists():
        return {}
    by_key = {}
    with MANIFEST.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                by_key[rec["s3_key"]] = rec
            except (ValueError, KeyError):
                continue
    return by_key


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    recompute = "--recompute" in sys.argv
    existing = load_existing_manifest()
    mc_entries = mc_ls_recursive(BUCKET)

    new_rows: list[dict] = []
    for entry in mc_entries:
        s3_key = entry.get("key", "").lstrip("/")
        size = entry.get("size", 0)
        if not s3_key or s3_key.endswith("/"):
            continue
        existing_rec = existing.get(s3_key)
        if not recompute and existing_rec and existing_rec.get("bytes") == size:
            new_rows.append(existing_rec)
            continue

        local = resolve_local(s3_key)
        if local is None or not local.exists():
            print(f"WARN: no local match for s3 key {s3_key}", file=sys.stderr)
            continue

        sha = sha256_of(local)
        content_type, _ = mimetypes.guess_type(str(local))
        new_rows.append({
            "s3_key": s3_key,
            "local_path": str(local),
            "bytes": size,
            "sha256": sha,
            "content_type": content_type or "application/octet-stream",
            "uploaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })

    # Atomic write with fsync
    tmp = MANIFEST.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for rec in new_rows:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
    tmp.replace(MANIFEST)

    print(f"wrote {len(new_rows)} rows to {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
