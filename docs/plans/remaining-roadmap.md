# Crow Platform — Remaining Roadmap

> Last updated: 2026-03-13
> Full plan: `~/.claude/plans/recursive-imagining-eclipse.md`

## What's Done

### Sidequest: Brand Identity & Launcher (Complete)
- [x] Task 0: Brand identity, color scheme, visual warmth
- [x] Task 1: Inline SVG logos + manifest updates
- [x] Task 2: Crow's Nest launcher tiles (health panel)
- [x] Task 3: Extensions page visual refresh
- [x] Task 4: Podcast manager panel
- [x] Task 5: Documentation updates for sidequest
- [x] Final code review, merge, deploy

### Phase 1: Documentation & Safety (Complete)
- [x] 1A: OpenClaw P2P emphasis — already thorough in `docs/platforms/openclaw.md`
- [x] 1A: MCP connector cross-platform — documented in `docs/platforms/claude-code.md`
- [x] 1A: Blog setup guide — `docs/guide/blog.md` has full public access section
- [x] 1A: Storage MIME types — blocklist documented, docx/pptx/xlsx listed
- [x] 1B: Safety confirmations — all three skills updated (storage, sharing, social)
- [x] 1C: Skills copyright audit — clean, no issues found

### Phase 2F: Crow's Nest Rename (Complete)
- [x] Route renamed `/dashboard/health` → `/dashboard/nest`
- [x] Panel id/name updated
- [x] Docs rename sweep across 19 files
- [x] `docs/guide/crows-nest.md` is the canonical guide

### Phase 3: Backup & Data Reliability (Complete)
- [x] `scripts/backup.sh` — SQL dump + binary copy
- [x] `scripts/restore.sh` — restore from backup
- [x] `skills/backup.md` — AI-driven backup workflow
- [x] `skills/session-summary.md` — quick session wrap-up
- [x] `skills/reflection.md` — friction analysis

### Infrastructure
- [x] Black-swan (Oracle Cloud) — Caddy reverse proxy on port 80, `/blog*` only exposed
- [x] Caddy auto-HTTPS works when a domain is pointed (tested with Let's Encrypt TLS-ALPN-01)
- [x] DNS for `crow.maestro.press` → maestro.press droplet (reserved for managed hosting)
- [x] Blog panel has live blog link + RSS/Atom shortcuts
- [x] Settings panel has connection URLs section
- [x] Podcast panel uses `CROW_GATEWAY_URL` for public RSS feed

---

## What Remains

### Phase 1A: Documentation Gaps (Complete)
- [x] **Project management docs** — Landing page prominently features project management, data backends, typed projects
- [x] **Self-hosted bundles inventory** — All 7 add-ons in crow-addons registry
- [x] **Deployment tiers doc** — `docs/guide/deployment-tiers.md` with resource requirements per tier

### Phase 2: User Experience & Customization (Medium Effort)

#### 2A: Per-Device Customization
- [ ] **Per-device crow.md** — Add `device_id` column to `crow_context` table (or separate `device_context` table). `generateInstructions()` merges base + device-specific context. Requires `ALTER TABLE` logic in `init-db.js`
- [ ] **Lay user crow.md guide** — `docs/guide/customization.md` exists but may need expanding with examples like "Crow, update my context to prefer Spanish responses"

#### 2B: Crow's Nest as Primary Entry Point (Complete)
- [x] **Enabled by default** — Gateway mounts Crow's Nest unconditionally, password required on first visit
- [x] **Memory browser panel** — Browse, search (FTS5), paginate, edit, delete all working

#### 2C: Zero-Config Network Access
- [ ] **Tailscale MagicDNS** — During `crow-install.sh`, detect Tailscale and offer to set hostname to `crow`. Gateway detects and displays `http://crow/` URL on setup page. Handle hostname collisions
- [ ] **Mobile app auto-discovery** — Future: app defaults to `http://crow/`, prompts for Tailscale VPN
- [ ] **Tailscale Funnel for blog only** — One-click "Publish blog to web" in Settings. Expose only `/blog/*` publicly. Note: Funnel is for personal/hobby only — monetized content needs Caddy + custom domain (already documented)

#### 2D: Resource Awareness (Partially Done)
- [ ] **Storage quota warnings** — Dashboard shows quota usage bar, warnings at 80%/95%
- [ ] **Memory entry count** — Show memory stats in Crow's Nest, warn on constrained devices
- [x] **Deployment tier docs** — `docs/guide/deployment-tiers.md` complete with resource tables and recommendations

#### 2E: Skill Protection
- [ ] **User skills directory** — `~/.crow/skills/` takes precedence over repo `skills/`. Superpowers routing checks user dir first. Already partially referenced in CLAUDE.md
- [ ] **Marketplace-installed skills** — Go to `~/.crow/skills/` automatically

### Phase 4: Platform Expansion (Medium-High Effort)

#### 4A: Bring Your Own AI Provider
- [ ] **BYOAI design spec** — Define provider adapter interface (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` env vars). Defer implementation until a feature needs it

#### 4B: CLI Platform Integrations
- [ ] **Gemini CLI docs** — `docs/platforms/gemini-cli.md` with MCP setup instructions
- [ ] **Qwen Coder CLI docs** — `docs/platforms/qwen-cli.md`
- [ ] **CLI-to-Crow-Chat bridge** — Explore unified Crow Chat powered by preferred LLM

#### 4C: Cron Job Service
- [ ] **Scheduled tasks** — `crow_create_schedule` tool, `schedules` DB table, `skills/scheduling.md` (already exists). Needs actual cron execution via gateway

#### 4D: Podcasting Enhancements
- [ ] **iTunes-compatible RSS** — Extend podcast RSS with full iTunes tags for directory submission
- [ ] **Audio file hosting** — Integration with storage server for episode audio

### Phase 5: Social & Community (High Effort)

#### 5A: Blog Discovery
- [ ] **Central registry** at `registry.crow.maestro.press` — opt-in blog directory with tags, RSS aggregation
- [ ] **P2P discovery** — Blogs announce via Nostr events or Hyperswarm topics

#### 5B: Contact Discovery
- [ ] **Find friends** — Privacy-preserving contact discovery by email hash
- [ ] **SSO exploration** — OIDC provider for Crow network

#### 5C: Relay Improvements
- [ ] **Default relay** at `relay.crow.maestro.press` — store-and-forward for users without always-on peers
- [ ] **Relay discovery** — Find public relays

#### 5D-5E: OpenClaw Bridge & Social Campaign
- [ ] **Crow→OpenClaw bridge** — Send messages to Discord/chat platforms via sharing infrastructure
- [ ] **Social media campaign** — Auto-post blog entries via OpenClaw bots

### Phase 6: Monetization & Apps (High Effort, Long-term)

- [ ] **6A: Stripe add-on** — Payment processing for blog monetization, subscriptions
- [ ] **6B: App Studio** — Sandboxed app creation via AI conversation, Claude.ai artifact publishing
- [ ] **6C: Mobile client** — React Native/PWA connecting to Crow gateway via Tailscale
- [ ] **6D: Tiered hosting** — Free/Standard($15)/Pro($30) tiers with TOS

### Phase 7: Academic & Data (Specialized)

- [ ] **Gov data MCP servers** — Template + texas-gov-data, fed-gov-data, california-gov-data as Crow add-ons
- [ ] **Academic skills bundle** — Tutoring skill, Canvas LMS integration, Zotero, research workflows
- [ ] **R&D Foundation** — Organizational/legal structure for open-source governance

### Phase 8: Lab & Testing

- [ ] **Multi-device sharing tests** — grackle↔colibri (local), grackle↔black-swan (cloud)
- [ ] **Victoria's machine** — Set up Oracle Cloud instance for testing multi-user

### Crow Marketplace (Multi-phase)

#### Phase A: Foundation (Complete)
- [x] **Create `kh0pper/crow-addons` GitHub repo** — Done, 7 add-ons in registry.json
- [x] **Populate add-ons** — All 7 add-ons have manifests (ollama, nextcloud, immich, obsidian, home-assistant, podcast, minio)
- [x] **Fix Extensions panel** — Points to `registry.json`, fetches successfully

#### Phase B: Install from UI
- [ ] **One-click install/uninstall** from Crow's Nest — resource checks, Docker image pull, container management
- [ ] **Service tiles** — Status, quick actions (start/stop/restart/open/remove)
- [ ] **Docker execution layer** — `execFile` with job queue, partial failure handling
- [ ] **Env var config UI** — Edit API keys and ports without touching .env files

#### Phase C: Community Stores
- [ ] **Community store template** — GitHub template repo for third-party add-on stores
- [ ] **Security model** — Compose file validation, network isolation, warning banners

#### Phase D: Beyond Docker
- [ ] **MCP server add-ons** — Install via `npx`/`uvx`, register in `.mcp.json`
- [ ] **Skill marketplace** — Browse and install community skills
- [ ] **Panel marketplace** — Third-party dashboard panels

---

## Recommended Next Actions

Pick from these based on available time:

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| 1 | **Phase 4B** — Gemini/Qwen CLI docs | 1 session | Medium — platform reach |
| 2 | **Phase 8** — Sharing tests on lab machines | 1-2 sessions | High — validates P2P |
| 3 | **Marketplace B** — One-click install from UI | 2-3 sessions | Very high — core UX |

## Key Architectural Decisions (Settled)

- **maestro.press** = managed hosting + relay services only. Not for test instances
- **Black-swan** = self-hosting test bed on Oracle Cloud. Uses bare IP for testing
- **Self-hosting users** bring their own domain → Caddy → auto-HTTPS
- **Tailscale Funnel** = personal/hobby only. Monetized content needs Caddy + custom domain
- **Crow stays as MCP tool provider** — no agent runtime/loop
- **Sharing transport** is reusable for new content types (blog, apps, podcasts)
