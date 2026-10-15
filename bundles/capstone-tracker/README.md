# capstone-tracker

FastAPI bundle extracted from canvas-companion. Carries PIR / notes / advocacy subsystems into the crow ecosystem with a bundle-owned SQLite at `/data/capstone.db` (= `~/.crow/data/capstone-tracker/capstone.db` on host).

E-reader subsystem (reading_progress, ereader_pins, ereader_material_tags, TTS, PDF reflow) deferred to Phase 4a.5.

## Deploy
1. Construct `~/.crow/env/capstone-tracker.env` via the heredoc in plan § 4.0.4.
2. `docker compose build && docker compose up -d` from this directory.
3. Append entry to `~/.crow/installed.json` and restart `crow-gateway`.
4. Run the operator's sync scripts (kept in the private engineering notes) to populate `/data/capstone.db`.

## Endpoints
- `/health` — healthcheck
- `/internal/run-pir-audit` — POST trigger, called by scheduler.js cron
- `/internal/run-pir-email-monitor` — POST trigger
- `/pir`, `/notes`, `/advocacy` — HTML routes (mounted under `/proxy/capstone-tracker/` via gateway)
- `/api/notes/*`, `/api/pir/*` — JSON routes

See the parent plan in the private engineering notes (§ 4) for full context.

## Subpath serving
The gateway serves the bundle at `/proxy/capstone-tracker/` and strips that prefix before forwarding, so the app learns it only from FastAPI's `root_path` (env `ROOT_PATH`, default `/proxy/capstone-tracker`; set `ROOT_PATH=` to serve at the host root). Every URL handed to a browser must be a path carrying that prefix:
- templates: the path-only `url_for(...)` Jinja global (never `request.url_for`, which returns an absolute URL with the backend's host);
- JavaScript: `window.BASE_URL + "/..."`;
- stored root-relative URLs (`/static/...` uploads, e-reader hrefs) are prefixed client-side when used.

## Dependencies
`constraints.txt` pins every installed version (captured from the running image); the Dockerfile installs with `uv pip install --system -c constraints.txt .`. Change a pin deliberately, never by rebuilding.

## Tests
Run inside the bundle image (the host has no fastapi/torch), with no ports or data mounts:

    docker run --rm -v "$PWD":/w -w /w -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 <bundle image> \
      sh -c "pip install -q --user pytest && python -m pytest -p no:cacheprovider tests"
