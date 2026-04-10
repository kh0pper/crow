#!/usr/bin/env python3
"""
SDXL + SVD Background Generation Service for Crow Companion.

Serves the current background (image or video) at static URLs and generates
new ones on demand. SDXL Turbo for stills, SVD img2vid-xt for animation.
The two models are mutually exclusive in VRAM; the service swaps between them.

Endpoints:
  GET  /                  → Current background image (no-store, ETag)
  GET  /video             → Current animated background video (mp4, no-store)
  POST /generate          → Generate new still background from prompt (SDXL Turbo)
  POST /generate-video    → Animate current background image (SVD img2vid-xt)
  GET  /gallery           → List all generated backgrounds (images + videos)
  GET  /gallery/{name}    → Serve a specific background
  POST /set/{name}        → Set a gallery item as current
  POST /unload            → Unload all models from VRAM
  GET  /health            → Health check
"""

import asyncio
import gc
import hashlib
import os
import shutil
import time
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Crow Background Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["ETag", "X-Generated-At"],
)

# Directories
BACKGROUNDS_DIR = Path(os.environ.get("SDXL_BACKGROUNDS_DIR", "/app/backgrounds"))
CURRENT_IMAGE = BACKGROUNDS_DIR / "current.jpg"
CURRENT_VIDEO = BACKGROUNDS_DIR / "current.mp4"
GALLERY_DIR = BACKGROUNDS_DIR / "gallery"
MODEL_CACHE = Path(os.environ.get("SDXL_MODEL_CACHE", "/app/models"))

# Model state - only one can be loaded at a time
_sdxl_pipeline = None
_svd_pipeline = None
_loading = None  # "sdxl" | "svd" | None


def _unload_all():
    """Unload all models from VRAM."""
    global _sdxl_pipeline, _svd_pipeline
    import torch

    if _sdxl_pipeline is not None:
        print("Unloading SDXL Turbo...")
        del _sdxl_pipeline
        _sdxl_pipeline = None

    if _svd_pipeline is not None:
        print("Unloading SVD...")
        del _svd_pipeline
        _svd_pipeline = None

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
    print(f"VRAM after unload: {torch.cuda.memory_allocated() / 1024**2:.0f}MB")


def get_sdxl():
    """Load SDXL Turbo, unloading SVD first if needed."""
    global _sdxl_pipeline, _loading
    if _sdxl_pipeline is not None:
        return _sdxl_pipeline
    if _loading:
        raise HTTPException(503, f"Currently loading {_loading}, retry in a moment")

    _loading = "sdxl"
    try:
        import torch
        from diffusers import AutoPipelineForText2Image

        # Unload SVD if loaded
        if _svd_pipeline is not None:
            _unload_all()

        print("Loading SDXL Turbo pipeline...")
        _sdxl_pipeline = AutoPipelineForText2Image.from_pretrained(
            "stabilityai/sdxl-turbo",
            torch_dtype=torch.float16,
            variant="fp16",
            cache_dir=str(MODEL_CACHE),
        )
        _sdxl_pipeline = _sdxl_pipeline.to("cuda")
        _sdxl_pipeline.enable_attention_slicing()
        print("SDXL Turbo loaded.")
        return _sdxl_pipeline
    except Exception as e:
        raise HTTPException(500, f"Failed to load SDXL: {e}")
    finally:
        _loading = None


def get_svd():
    """Load SVD img2vid-xt, unloading SDXL first if needed."""
    global _svd_pipeline, _loading
    if _svd_pipeline is not None:
        return _svd_pipeline
    if _loading:
        raise HTTPException(503, f"Currently loading {_loading}, retry in a moment")

    _loading = "svd"
    try:
        import torch
        from diffusers import StableVideoDiffusionPipeline

        # Unload SDXL if loaded
        if _sdxl_pipeline is not None:
            _unload_all()

        print("Loading SVD img2vid-xt pipeline...")
        _svd_pipeline = StableVideoDiffusionPipeline.from_pretrained(
            "stabilityai/stable-video-diffusion-img2vid-xt",
            torch_dtype=torch.float16,
            variant="fp16",
            cache_dir=str(MODEL_CACHE),
        )
        # Use CPU offloading to fit alongside llama-server (~4.4GB)
        _svd_pipeline.enable_model_cpu_offload()
        print("SVD img2vid-xt loaded with CPU offloading.")
        return _svd_pipeline
    except Exception as e:
        raise HTTPException(500, f"Failed to load SVD: {e}")
    finally:
        _loading = None


def compute_etag(filepath: Path) -> str:
    """Compute ETag from file content hash."""
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return f'"{h.hexdigest()}"'


def frames_to_mp4(frames, output_path, fps=7):
    """Encode a list of PIL images to an MP4 file using ffmpeg."""
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        # Save frames as numbered PNGs
        for i, frame in enumerate(frames):
            frame.save(os.path.join(tmpdir, f"{i:04d}.png"))

        # Encode with ffmpeg (H.264, yuv420p for broad compatibility)
        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-i", os.path.join(tmpdir, "%04d.png"),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-crf", "23",
            "-preset", "fast",
            "-movflags", "+faststart",
            str(output_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[-500:]}")


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = "blurry, low quality, distorted, text, watermark"
    width: int = 1024
    height: int = 576
    steps: int = 4
    guidance_scale: float = 0.0
    save_to_gallery: bool = True


class AnimateRequest(BaseModel):
    num_frames: int = 25
    fps: int = 7
    decode_chunk_size: int = 8
    motion_bucket_id: int = 127
    noise_aug_strength: float = 0.02
    save_to_gallery: bool = True


@app.on_event("startup")
async def startup():
    BACKGROUNDS_DIR.mkdir(parents=True, exist_ok=True)
    GALLERY_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_CACHE.mkdir(parents=True, exist_ok=True)


@app.head("/")
@app.get("/")
async def serve_current_background():
    """Serve the current background image with cache-busting headers."""
    if not CURRENT_IMAGE.exists():
        raise HTTPException(404, "No background generated yet")

    etag = compute_etag(CURRENT_IMAGE)
    return FileResponse(
        CURRENT_IMAGE,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store, must-revalidate",
            "ETag": etag,
            "X-Generated-At": str(os.path.getmtime(CURRENT_IMAGE)),
        },
    )


@app.head("/video")
@app.get("/video")
async def serve_current_video():
    """Serve the current animated background video."""
    if not CURRENT_VIDEO.exists():
        raise HTTPException(404, "No animated background generated yet")

    etag = compute_etag(CURRENT_VIDEO)
    return FileResponse(
        CURRENT_VIDEO,
        media_type="video/mp4",
        headers={
            "Cache-Control": "no-store, must-revalidate",
            "ETag": etag,
            "X-Generated-At": str(os.path.getmtime(CURRENT_VIDEO)),
        },
    )


def _generate_sync(prompt, negative_prompt, width, height, steps, guidance_scale, save_to_gallery):
    """Run SDXL generation synchronously (called in thread pool)."""
    import torch

    pipe = get_sdxl()

    start = time.time()
    with torch.no_grad():
        result = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
        )
    elapsed = time.time() - start

    image = result.images[0]
    image.save(CURRENT_IMAGE, "JPEG", quality=92)

    gallery_name = None
    if save_to_gallery:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        slug = prompt[:60].lower().replace(" ", "-").replace("/", "-")
        slug = "".join(c for c in slug if c.isalnum() or c == "-")
        gallery_name = f"{timestamp}_{slug}.jpg"
        image.save(GALLERY_DIR / gallery_name, "JPEG", quality=92)

    return {
        "status": "ok",
        "type": "image",
        "prompt": prompt,
        "width": width,
        "height": height,
        "steps": steps,
        "elapsed_seconds": round(elapsed, 2),
        "gallery_name": gallery_name,
        "url": "/?t=" + str(int(time.time())),
    }


@app.post("/generate")
async def generate_background(req: GenerateRequest):
    """Generate a new background image via SDXL Turbo."""
    width = max(256, min(req.width, 1536))
    height = max(256, min(req.height, 1536))
    width = (width // 8) * 8
    height = (height // 8) * 8

    result = await asyncio.to_thread(
        _generate_sync, req.prompt, req.negative_prompt,
        width, height, req.steps, req.guidance_scale, req.save_to_gallery,
    )
    return JSONResponse(result)


def _generate_video_sync(num_frames, fps, decode_chunk_size, motion_bucket_id, noise_aug_strength, save_to_gallery):
    """Run SVD generation synchronously (called in thread pool)."""
    import torch
    from PIL import Image

    image = Image.open(CURRENT_IMAGE).convert("RGB")
    image = image.resize((1024, 576), Image.LANCZOS)

    pipe = get_svd()

    start = time.time()
    with torch.no_grad():
        result = pipe(
            image,
            num_frames=num_frames,
            decode_chunk_size=decode_chunk_size,
            motion_bucket_id=motion_bucket_id,
            noise_aug_strength=noise_aug_strength,
        )
    frames = result.frames[0]
    gen_elapsed = time.time() - start

    encode_start = time.time()
    frames_to_mp4(frames, CURRENT_VIDEO, fps=fps)
    encode_elapsed = time.time() - encode_start

    total_elapsed = time.time() - start

    gallery_name = None
    if save_to_gallery:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        gallery_name = f"{timestamp}_animated.mp4"
        shutil.copy2(CURRENT_VIDEO, GALLERY_DIR / gallery_name)

    return {
        "status": "ok",
        "type": "video",
        "num_frames": len(frames),
        "fps": fps,
        "duration_seconds": round(len(frames) / fps, 1),
        "generation_seconds": round(gen_elapsed, 2),
        "encoding_seconds": round(encode_elapsed, 2),
        "total_seconds": round(total_elapsed, 2),
        "gallery_name": gallery_name,
        "video_url": "/video?t=" + str(int(time.time())),
    }


@app.post("/generate-video")
async def generate_video(req: AnimateRequest):
    """Animate the current background image using SVD img2vid-xt."""
    if not CURRENT_IMAGE.exists():
        raise HTTPException(400, "No background image to animate. Generate one first with /generate.")

    result = await asyncio.to_thread(
        _generate_video_sync, req.num_frames, req.fps,
        req.decode_chunk_size, req.motion_bucket_id,
        req.noise_aug_strength, req.save_to_gallery,
    )
    return JSONResponse(result)


@app.post("/unload")
async def unload_models():
    """Unload all models from VRAM to free memory."""
    await asyncio.to_thread(_unload_all)
    return JSONResponse({"status": "ok", "message": "All models unloaded"})


@app.get("/gallery")
async def list_gallery():
    """List all generated backgrounds in the gallery."""
    files = sorted(
        list(GALLERY_DIR.glob("*.jpg")) + list(GALLERY_DIR.glob("*.mp4")),
        key=lambda f: f.stat().st_ctime,
        reverse=True,
    )
    return JSONResponse({
        "backgrounds": [
            {
                "name": f.name,
                "type": "video" if f.suffix == ".mp4" else "image",
                "size_kb": round(f.stat().st_size / 1024, 1),
                "created": datetime.fromtimestamp(f.stat().st_ctime).isoformat(),
                "url": f"/gallery/{f.name}",
            }
            for f in files
        ]
    })


@app.get("/gallery/{name}")
async def serve_gallery_item(name: str):
    """Serve a specific gallery item."""
    safe_name = Path(name).name
    filepath = GALLERY_DIR / safe_name
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(404, "Item not found")
    media_type = "video/mp4" if filepath.suffix == ".mp4" else "image/jpeg"
    return FileResponse(filepath, media_type=media_type)


@app.post("/set/{name}")
async def set_gallery_as_current(name: str):
    """Set a gallery item as the current background."""
    safe_name = Path(name).name
    filepath = GALLERY_DIR / safe_name
    if not filepath.exists():
        raise HTTPException(404, "Gallery item not found")

    if filepath.suffix == ".mp4":
        shutil.copy2(filepath, CURRENT_VIDEO)
        result_url = "/video?t=" + str(int(time.time()))
        bg_type = "video"
    else:
        shutil.copy2(filepath, CURRENT_IMAGE)
        result_url = "/?t=" + str(int(time.time()))
        bg_type = "image"

    return JSONResponse({
        "status": "ok",
        "type": bg_type,
        "set_from": safe_name,
        "url": result_url,
    })


@app.get("/health")
async def health():
    """Health check — lightweight, no torch import."""
    active_model = None
    if _sdxl_pipeline is not None:
        active_model = "sdxl"
    elif _svd_pipeline is not None:
        active_model = "svd"

    return JSONResponse({
        "status": "ok",
        "active_model": active_model,
        "loading": _loading,
        "current_image": CURRENT_IMAGE.exists(),
        "current_video": CURRENT_VIDEO.exists(),
        "gallery_count": len(list(GALLERY_DIR.glob("*.jpg")) + list(GALLERY_DIR.glob("*.mp4"))),
    })


if __name__ == "__main__":
    port = int(os.environ.get("SDXL_PORT", "3005"))
    host = os.environ.get("SDXL_HOST", "0.0.0.0")
    print(f"Starting Background Service on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
