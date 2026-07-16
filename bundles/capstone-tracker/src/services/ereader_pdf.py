"""
PDF enrichment for e-reader: image extraction and curated table loading.

RESEARCH_CACHE is the shared full-text cache (read-only on this bundle),
mounted at /data/external/cache. See src/routes/ereader.py for the sync chain.
"""

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

RESEARCH_CACHE = Path(os.environ.get("EREADER_CACHE", "/data/external/cache"))

# Minimum image dimensions to keep (skip decorative elements/logos)
MIN_IMAGE_DIM = 100
# Maximum width before downscaling
MAX_IMAGE_WIDTH = 1200


def extract_images(
    pdf_path: str, source_id: str, static_dir: str
) -> list[dict]:
    """
    Extract images from a PDF using PyMuPDF.

    Filters out small decorative images (<100px). Resizes images wider than
    1200px. Saves to static_dir/images/ereader/{source_id}/.

    Returns list of {"url": "/static/...", "page": N, "width": W, "height": H}.
    """
    try:
        import io

        import fitz
        from PIL import Image
    except ImportError:
        logger.warning("PyMuPDF or Pillow not available for image extraction")
        return []

    out_dir = Path(static_dir) / "images" / "ereader" / source_id
    # Cache: skip if output dir already has files
    if out_dir.exists() and any(out_dir.iterdir()):
        return _load_cached_image_list(out_dir)

    out_dir.mkdir(parents=True, exist_ok=True)

    images = []
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        logger.exception("Failed to open PDF: %s", pdf_path)
        return []

    try:
        for page_num in range(len(doc)):
            page = doc[page_num]
            img_list = page.get_images(full=True)
            for idx, img_info in enumerate(img_list):
                xref = img_info[0]
                try:
                    base_image = doc.extract_image(xref)
                except Exception:
                    continue

                if not base_image or not base_image.get("image"):
                    continue

                width = base_image.get("width", 0)
                height = base_image.get("height", 0)

                # Skip small images (decorative/logos)
                if width < MIN_IMAGE_DIM or height < MIN_IMAGE_DIM:
                    continue

                ext = base_image.get("ext", "png")
                if ext not in ("png", "jpeg", "jpg"):
                    ext = "png"

                img_data = base_image["image"]

                # Skip all-black/all-white images (corrupt extractions)
                try:
                    pil_check = Image.open(io.BytesIO(img_data))
                    extrema = pil_check.convert("L").getextrema()
                    if extrema[1] - extrema[0] < 10:
                        continue
                except Exception:
                    pass

                # Resize if too wide
                if width > MAX_IMAGE_WIDTH:
                    try:
                        pil_img = Image.open(io.BytesIO(img_data))
                        ratio = MAX_IMAGE_WIDTH / width
                        new_size = (MAX_IMAGE_WIDTH, int(height * ratio))
                        pil_img = pil_img.resize(new_size, Image.LANCZOS)
                        buf = io.BytesIO()
                        save_fmt = "JPEG" if ext in ("jpeg", "jpg") else "PNG"
                        pil_img.save(buf, format=save_fmt)
                        img_data = buf.getvalue()
                        width, height = new_size
                    except Exception:
                        pass  # Keep original size

                filename = f"img_{page_num}_{idx}.{ext}"
                filepath = out_dir / filename
                filepath.write_bytes(img_data)

                images.append({
                    "url": f"/static/images/ereader/{source_id}/{filename}",
                    "page": page_num,
                    "width": width,
                    "height": height,
                })
    finally:
        doc.close()

    return images


def _load_cached_image_list(out_dir: Path) -> list[dict]:
    """Rebuild image list from already-extracted files."""
    images = []
    source_id = out_dir.name
    for f in sorted(out_dir.iterdir()):
        if f.suffix.lower() in (".png", ".jpeg", ".jpg"):
            # Parse page number from filename: img_{page}_{idx}.ext
            parts = f.stem.split("_")
            page = int(parts[1]) if len(parts) >= 3 else 0
            images.append({
                "url": f"/static/images/ereader/{source_id}/{f.name}",
                "page": page,
                "width": 0,  # Unknown from cache, but not needed for display
                "height": 0,
            })
    return images


def load_curated_tables(source_id: str) -> list[dict] | None:
    """
    Load curated table markdown from a sidecar JSON file.

    Checks for ~/.research-mcp/cache/{source_id}.tables.json.
    Returns list of {"marker": "TABLE N.", "markdown": "..."} or None.
    """
    tables_path = RESEARCH_CACHE / f"{source_id}.tables.json"
    if not tables_path.exists():
        return None

    try:
        with open(tables_path) as f:
            tables = json.load(f)
        if isinstance(tables, list) and tables:
            return tables
    except (json.JSONDecodeError, OSError):
        logger.exception("Failed to load curated tables: %s", tables_path)

    return None
