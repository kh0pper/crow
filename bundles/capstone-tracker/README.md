# capstone-tracker

FastAPI bundle extracted from canvas-companion. Carries PIR / notes / advocacy subsystems into the crow ecosystem with a bundle-owned SQLite at `/data/capstone.db` (= `~/.crow/data/capstone-tracker/capstone.db` on host).

E-reader subsystem (reading_progress, ereader_pins, ereader_material_tags, TTS, PDF reflow) deferred to Phase 4a.5.

## Deploy
1. Construct `~/.crow/env/capstone-tracker.env` via the heredoc in plan § 4.0.4.
2. `docker compose build && docker compose up -d` from this directory.
3. Append entry to `~/.crow/installed.json` and restart `crow-gateway`.
4. Run sync scripts from `~/crow/scripts/research/` to populate `/data/capstone.db`.

## Endpoints
- `/health` — healthcheck
- `/internal/run-pir-audit` — POST trigger, called by scheduler.js cron
- `/internal/run-pir-email-monitor` — POST trigger
- `/pir`, `/notes`, `/advocacy` — HTML routes (mounted under `/proxy/capstone-tracker/` via gateway)
- `/api/notes/*`, `/api/pir/*` — JSON routes

See parent plan `~/.claude/plans/ok-i-think-we-rosy-blossom.md` § 4 for full context.
