"""
OCR pipeline for handwritten notes.

Uses TrOCR (local) with Claude Vision fallback for handwriting recognition.
Renders ink strokes to images, runs OCR, returns extracted text.
"""

import base64
import io
import logging
import re

from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

# TrOCR model (lazy loaded)
_trocr_processor = None
_trocr_model = None
TROCR_CONFIDENCE_THRESHOLD = 0.6


def _load_trocr():
    """Lazy-load TrOCR model. Returns (processor, model) or (None, None) if unavailable."""
    global _trocr_processor, _trocr_model
    if _trocr_processor is not None:
        return _trocr_processor, _trocr_model
    try:
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel

        logger.info("Loading TrOCR model (this may take a moment)...")
        _trocr_processor = TrOCRProcessor.from_pretrained(
            "microsoft/trocr-base-handwritten"
        )
        _trocr_model = VisionEncoderDecoderModel.from_pretrained(
            "microsoft/trocr-base-handwritten"
        )
        logger.info("TrOCR model loaded successfully")
        return _trocr_processor, _trocr_model
    except ImportError:
        logger.warning("transformers/torch not installed — TrOCR unavailable")
        return None, None
    except Exception as e:
        logger.error(f"Failed to load TrOCR: {e}")
        return None, None


def render_strokes_to_image(content: dict, bg_color="white") -> Image.Image:
    """Render ink block strokes to a PIL Image.

    Auto-detects bounding box of all strokes and normalizes coordinates
    so strokes are always visible regardless of canvas pan position.
    """
    strokes = content.get("strokes", [])
    if not strokes:
        return Image.new("RGB", (100, 100), bg_color)

    # Collect all points to find bounding box
    all_x, all_y = [], []
    for stroke in strokes:
        for pt in stroke.get("points", []):
            all_x.append(pt[0])
            all_y.append(pt[1])

    if not all_x:
        return Image.new("RGB", (100, 100), bg_color)

    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    padding = 20

    # Size image to fit content, capped at reasonable dimensions
    width = min(4000, max(200, int(max_x - min_x + padding * 2)))
    height = min(4000, max(200, int(max_y - min_y + padding * 2)))

    # Offset to shift all coordinates into positive space
    offset_x = -min_x + padding
    offset_y = -min_y + padding

    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)

    for stroke in strokes:
        points = stroke.get("points", [])
        color = stroke.get("color", "#000000")
        size = stroke.get("size", 3)
        if len(points) < 2:
            continue
        coords = [(p[0] + offset_x, p[1] + offset_y) for p in points]
        draw.line(coords, fill=color, width=max(1, int(size)))

    return img


def ocr_with_trocr(image: Image.Image) -> tuple[str, float]:
    """Run TrOCR on an image. Returns (text, confidence)."""
    processor, model = _load_trocr()
    if processor is None:
        return "", 0.0

    import torch
    import torch.nn.functional as F

    pixel_values = processor(images=image, return_tensors="pt").pixel_values
    with torch.no_grad():
        outputs = model.generate(
            pixel_values,
            max_length=512,
            output_scores=True,
            return_dict_in_generate=True,
        )
    text = processor.batch_decode(outputs.sequences, skip_special_tokens=True)[0]

    if outputs.scores:
        probs = [F.softmax(score, dim=-1).max().item() for score in outputs.scores]
        confidence = sum(probs) / len(probs) if probs else 0.0
    else:
        confidence = 0.5

    return text.strip(), confidence


def ocr_with_vision(image: Image.Image) -> str:
    """Use OpenAI-compatible vision endpoint (local Qwen by default) to transcribe handwriting.

    Endpoint + model + key come from env (see plan § 4.0.5):
        OCR_VISION_URL    e.g. http://<your-llm-host>:<port>/v1
        OCR_VISION_MODEL  e.g. qwen3.6-35b-a3b
        OCR_VISION_API_KEY e.g. "none" (llama-server accepts any value)
    """
    try:
        import httpx
        import os

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        img_base64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        payload = {
            "model": os.environ["OCR_VISION_MODEL"],
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{img_base64}",
                            },
                        },
                        {
                            "type": "text",
                            "text": "Transcribe the handwriting in this image accurately. "
                            "Return only the transcribed text, nothing else. "
                            "If the image is blank or contains no text, return an empty string.",
                        },
                    ],
                }
            ],
            "max_tokens": 2000,
            "temperature": 0.1,
        }

        base_url = os.environ["OCR_VISION_URL"].rstrip("/")
        api_key = os.environ.get("OCR_VISION_API_KEY", "none")

        response = httpx.post(
            f"{base_url}/chat/completions",
            json=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(60.0, read=120.0),
        )
        response.raise_for_status()
        data = response.json()
        text = data["choices"][0]["message"]["content"]
        return text.strip()
    except Exception as e:
        logger.error(f"Vision OCR failed: {e}")
        return ""


def ocr_ink_block(content: dict) -> str:
    """Run OCR on an ink block. TrOCR first, Claude Vision fallback."""
    if not content.get("strokes"):
        return ""

    image = render_strokes_to_image(content)

    text, confidence = ocr_with_trocr(image)
    logger.info(f"TrOCR result: confidence={confidence:.2f}, text='{text[:50]}...'")

    if confidence >= TROCR_CONFIDENCE_THRESHOLD and text:
        return text

    logger.info("TrOCR confidence low, falling back to Claude Vision")
    claude_text = ocr_with_vision(image)
    return claude_text if claude_text else text


def ocr_note(blocks: list[dict]) -> str:
    """Run OCR on all blocks in a note and return combined text."""
    parts = []
    for block in blocks:
        if block["block_type"] == "ink":
            text = ocr_ink_block(block["content"] or {})
            if text:
                parts.append(text)
        elif block["block_type"] == "text":
            html = (block["content"] or {}).get("html", "")
            plain = re.sub(r"<[^>]+>", " ", html).strip()
            plain = re.sub(r"\s+", " ", plain)
            if plain:
                parts.append(plain)
        elif block["block_type"] == "image":
            alt = (block["content"] or {}).get("alt", "")
            if alt:
                parts.append(f"[Image: {alt}]")
    return "\n\n".join(parts)


def ocr_whiteboard(content: dict) -> str:
    """Run OCR on a whiteboard block. Extracts typed text and OCRs strokes."""
    parts = []
    objects = content.get("objects", [])

    # Extract typed text from text objects
    for obj in objects:
        if obj.get("type") == "text":
            text = obj.get("text", "").strip()
            if text:
                parts.append(text)

    # Collect stroke objects and render to image for OCR
    strokes = [obj for obj in objects if obj.get("type") == "stroke"]
    if strokes:
        # Build a synthetic ink block content — render_strokes_to_image
        # auto-detects bounds from the stroke coordinates
        stroke_content = {"strokes": strokes}
        text = ocr_ink_block(stroke_content)
        if text:
            parts.append(text)

    return "\n\n".join(parts)
