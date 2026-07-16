"""
FastAPI entry point for the capstone-tracker bundle.

Mounts:
    /static       — JS/CSS/images served from src/static/
    /pir, /notes, /advocacy + their /api/* siblings — Phase 4a v1 routes
    /internal/run-pir-audit  — POST, scheduler trigger (plan § 4.0.2 + 4.6)
    /internal/run-pir-email-monitor — POST, scheduler trigger
    /health       — GET, healthcheck for docker-compose

Subpath proxy: the crow gateway mounts the bundle at /proxy/capstone-tracker/.
Templates use Jinja's request.url_for() and JS reads window.BASE_URL injected
into base.html via the `root_path` set on the FastAPI app (see plan § 4.0.7).
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)


# ── REQUIRED_ENVS fail-fast (plan § 4.0.8 item 5 + WARNING #6) ───────────
REQUIRED_ENVS = [
    "ZAI_API_KEY",
    "SMTP_PASSWORD",
    "SMTP_USERNAME",
    "EMAIL_FROM",
    "EMAIL_TO",
    "OCR_VISION_URL",
    "OCR_VISION_MODEL",
    "CAPSTONE_TRACKER_INTERNAL_URL",
]


def _check_required_envs() -> None:
    missing = [k for k in REQUIRED_ENVS if not os.environ.get(k)]
    if missing:
        raise RuntimeError(
            f"capstone-tracker missing required env vars: {missing}. "
            "Check ~/.crow/env/capstone-tracker.env on the host."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    _check_required_envs()
    logger.info("capstone-tracker startup: env validated, DB path=%s",
                os.environ.get("CAPSTONE_DB_PATH", "/data/capstone.db"))
    yield
    logger.info("capstone-tracker shutdown")


# Root-path autodetect: when crow-gateway proxies us at /proxy/capstone-tracker/,
# it forwards the rewritten path WITHOUT that prefix (extension-proxy.js
# strips it before forwarding to localhost:8090). Setting root_path here lets
# request.url_for() emit absolute URLs that include the proxy prefix so
# subpath-proxied browsers land on the right URL. Override via env if the
# bundle is ever direct-mode mounted.
app = FastAPI(
    title="Capstone Tracker",
    version="1.0.0",
    lifespan=lifespan,
    root_path=os.environ.get("ROOT_PATH", "/proxy/capstone-tracker"),
)

# ── Static files ──────────────────────────────────────────────────────────
SRC_DIR = Path(__file__).parent
STATIC_DIR = SRC_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── Routes ────────────────────────────────────────────────────────────────
from src.routes import pir as pir_routes
from src.routes import notes as notes_routes
from src.routes import advocacy as advocacy_routes
from src.routes import ereader as ereader_routes

app.include_router(pir_routes.router)
app.include_router(notes_routes.router)
app.include_router(advocacy_routes.router)
app.include_router(ereader_routes.router)


# ── Health ────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Internal scheduler triggers (called by crow-gateway scheduler.js) ────
@app.post("/internal/run-pir-audit")
async def run_pir_audit(background: BackgroundTasks):
    """Kicked off by scheduler.js cron; runs the PIR audit digest in the background."""
    from src.tasks.pir_tasks import pir_audit_digest
    background.add_task(pir_audit_digest)
    return JSONResponse({"status": "queued"})


@app.post("/internal/run-pir-email-monitor")
async def run_pir_email_monitor(background: BackgroundTasks):
    """Kicked off by scheduler.js cron; scans Gmail for unread PIR-related emails."""
    from src.tasks.pir_tasks import pir_email_monitor
    background.add_task(pir_email_monitor)
    return JSONResponse({"status": "queued"})


# ── Root → /pir (bundle landing page) ─────────────────────────────────────
from fastapi.responses import RedirectResponse


@app.get("/")
async def index():
    return RedirectResponse(url=app.url_path_for("pir_index"))
