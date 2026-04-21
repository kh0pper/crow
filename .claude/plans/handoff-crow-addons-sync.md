# Hand-off: Crow Add-ons Sync (Phases 3-7)

## What was done (this session, 2026-04-10)

Three commits on `main`, **not yet pushed to GitHub**:

| Commit | Phase | Summary |
|--------|-------|---------|
| `709dfa7` | Phase 0 | Safety cleanup: git rm FFFF + HA skill, sanitize PII, update .gitignore |
| `51c3165` | Phase 1 | Extract SDXL into standalone GPU extension (`bundles/sdxl/`) |
| `8af8cec` | Phase 2 | Add AI Companion bundle (17 files) |

## What remains (Phases 3-7)

Read the full plan with detailed file manifests at:
**`/home/kh0pp/.claude/plans/async-whistling-shamir.md`**

### Phase 3: Sync crow-addons registry
- Update `~/crow-addons/registry.json` — add 11 missing entries (10 existing + sdxl), replace `openclaw` with `crowclaw`, delete `~/crow-addons/openclaw/` directory
- Local registry (`registry/add-ons.json`) has 26 entries; crow-addons registry has 15

### Phase 4: Add 18 missing bundle directories to crow-addons
- For each bundle: copy `manifest.json` → rename to `crow-addon.json`, copy implementation files
- **High scrutiny** (review individually): `browser/` (FFFF removed, scripts/ empty), `crowclaw/` (personal content split — see plan for exact file lists)
- **Batch 1** (Docker-only): coturn, localai, minio, romm, tailscale
- **Batch 2** (MCP server): data-dashboard, iptv, kodi, media, songbook
- **Batch 3** (MCP+Docker): jellyfin, knowledge-base, nominatim, plex, tax, trilium
- Exclude `node_modules/` from all bundles (add `.gitignore` to crow-addons root)
- Push crow-addons to GitHub after all batches

### Phase 5: Create Live2D models repo on Gitea
- Create private `kh0pp/crow-live2d-models` repo
- Init `/mnt/ollama-models/live2d-models/`, commit 30 Eikanya model dirs (1.1GB), push

### Phase 6: Push private components to Gitea
- FFFF: `bundles/browser/scripts/ffff/` + `skills/ffff-filing.md` (removed from GitHub in Phase 0)
- CrowClaw personal: `CLAUDE.md`, `scripts/import-existing.js`, `scripts/*.py`, `skills/home-assistant/`

### Phase 7: Fix GitHub Pages docs deployment
- Update `.github/workflows/deploy-docs.yml`: add `branches: [main]` filter, change `node-version: 20` → `22`
- Confirm Pages source branch should be `main` (currently set to `claude/ai-project-research-platform-1Qbvh`)
- Last failed deploy was from tag `android-v1.1.0` (not in allowed branches)

### Phase 8: Fix SQLite database locking (affects all users)
- crow.db is in `delete` journal mode (not WAL) — a single writer blocks ALL readers
- `busy_timeout` is only 5000ms in `servers/db.js`
- Orphaned gateway processes accumulate (found 4 gateways + 14 MCP servers in this session)
- Fix: switch to WAL mode, increase busy_timeout, add graceful shutdown + PID file to gateway
- See full plan for investigation checklist and file list

## Critical rules
- **Human review checkpoint before every commit** — show staged files + `git diff --cached`, wait for approval
- **PII scan**: `git diff --cached -U0 | grep -iE '\+.*\b(kevin|sarah|dayane|grackle|kh0pp|/mnt/ollama)'` before every commit
- **Never push without explicit approval**
- `manifest.json` (crow repo) → `crow-addon.json` (crow-addons repo) — same schema, different filename
- CrowClaw `config/`, `workspace/`, `~/` directories are in `.gitignore` — never commit these

## Quick start for next session
```
cd ~/crow
cat ~/.claude/plans/async-whistling-shamir.md  # Full plan with file manifests
git log --oneline -5                            # Verify 3 unpushed commits
git log origin/main..HEAD --oneline             # See what needs pushing
```
