# Crow Overhaul — Prioritized Findings Report

**Date:** 2026-06-10
**Phase:** 1 of the top-to-bottom overhaul (charter: `~/.claude/plans/great-i-would-now-eventual-quiche.md`; rubric: [`2026-06-10-crow-vision-and-principles.md`](./2026-06-10-crow-vision-and-principles.md))
**Method:** 9 parallel read-only audit agents across 6 dimensions + an adversarial verification pass by the lead against the live tree (commit `10e8702`). Security work was code-level defensive analysis under the rules of engagement — no live exploitation was needed; upfront snapshot taken (both `crow.db`s + all crow MinIO buckets → `~/crow-overhaul-backups/2026-06-10/`).
**Verification legend:** ✅ = lead-verified against live tree · ⚠️ = agent-reported, spot-verify at fix time · Refuted claims are in Appendix B (they are NOT findings).

---

## Executive summary

The system is **architecturally sound and security-strong at the boundary** (the funnel invariant, OAuth/DCR, dashboard auth, SSO tickets, and peer gates all survived adversarial review with only minor findings). The real debt matches the operator's own assessment: **sprawl** (duplicated helpers, 4 error shapes, 6 auth patterns, 56 .bak files, dual project tables, a legacy bot engine), **fragile seams** (partial-failure paths without rollback, sync conflict handling that can silently drop edits — against the "user data is absolute" principle), **token waste** (~12–20% per-session savings available), and a **day-1 path that still assumes a terminal** (6 competing install guides, no celebration moment, no non-technical health view). Docs are in good shape post-F7 (EN accurate; ES mirror only 14.5% complete).

**~45 verified findings, ranked into 5 waves.** Wave 1 = 7 small, low-risk, high-leverage items.

---

## WAVE 1 — Highest leverage, lowest risk (all S effort, low risk)

### W1-1 · SEC · Funnel prefix match is not segment-anchored ✅
- **Problem:** `PUBLIC_FUNNEL_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))` lets `/blogX` pass the funnel gate for prefix `/blog`. Not currently exploitable (no such routes exist), but this is the sacrosanct boundary — it must be exact.
- **Evidence:** `servers/gateway/funnel.js:40`.
- **Severity:** medium (defense-in-depth on a critical invariant) · **Effort:** S · **Risk:** low
- **Fix:** segment-boundary check (`p` ends in `/` or next char is `/`). Add a `/blogX`-style case to `tests/auth-network.test.js`.
- **Verify:** `node --test tests/auth-network.test.js`.

### W1-2 · SEC · Path-validation trio: panel IDs, bot skill names, skill resolver ✅
- **Problem:** three loading paths accept unvalidated names: (a) third-party panel IDs from `~/.crow/panels.json` flow into `join(panelsDir, id + ".js")` → `import()` (`dashboard/panel-registry.js:55,72`); (b) bot `skills` arrays are stored unvalidated from the request body (`panels/bot-builder.js:698`); (c) `skill_resolver.mjs:42` joins the name into skill dirs with no traversal rejection. All require local/operator-level access already, so severity is medium (defense-in-depth), but the model validator **already exists** — `normalizeSkillName()` in `scripts/pi-bots/skill_proposals.mjs:34-54`.
- **Fix:** reuse `normalizeSkillName` for (b)+(c); add `/^[a-z0-9_-]{1,64}$/` + resolved-path containment for (a).
- **Severity:** medium · **Effort:** S · **Risk:** low
- **Verify:** unit test: traversal names rejected, valid names load.

### W1-3 · SEC · Auth hygiene: dead timing-unsafe fn + unguarded `ensureColumn` ✅
- **Problem:** `verifyAuthToken()` (`instance-registry.js:41`) is dead code with a non-timing-safe compare — delete or fix; `ensureColumn()` (`servers/db.js:135`) interpolates table/column into SQL with no identifier allowlist (currently uncalled; guard it before someone calls it).
- **Severity:** low · **Effort:** S · **Risk:** low
- **Verify:** grep confirms no callers broke; identifier-validation unit test.

### W1-4 · UNI · Housekeeping sweep: .bak files, merged branches, stale doc claims ✅
- **Problem:** 56 `*.bak`/`*.PRE-*.bak` snapshot files (24+ in `servers/orchestrator/`, `registry/add-ons.json.bak`, `gateway/proxy.js.bak`...); **all 8 local feature branches verified fully merged** (0 unmerged commits each — prune); ~26 remote branches merged too (only `origin/f13` (1), `f14` (2), `f15` (3) hold unmerged fediverse commits — operator decision); project `CLAUDE.md` claims `servers/gateway/__tests__/` exists (it doesn't); router "7 tools" header vs `index.js:738` "8 tools / 58+" log drift.
- **Fix:** delete .baks + add `*.bak` to `.gitignore`; prune merged branches local+remote; fix CLAUDE.md test claim; align router counts.
- **Severity:** medium (trust/coherence) · **Effort:** S · **Risk:** none
- **Verify:** `find . -name '*.bak' | wc -l` = 0; `git branch` clean; grep checks.

### W1-5 · EFF · Token quick wins: context caching + batched access-tracking ✅
- **Problem:** (a) the condensed crow.md/context is regenerated (5 DB queries) independently in 4 code paths per handshake/turn (`servers/memory/crow-context.js:74-141`, `servers/shared/instructions.js`, `ai/system-prompt.js`); (b) memory search/recall fires one `UPDATE memories SET accessed_at...` **per returned row** (`servers/memory/server.js:271-273, 380-382`) — N+1 on every recall.
- **Fix:** 60s-TTL cache keyed `(deviceId, projectId)`, invalidated on context mutation; batch the access-tracking into one `UPDATE ... WHERE id IN (...)`.
- **Impact:** est. 750–1,500 tokens/session + ~10× fewer queries per recall · **Effort:** S · **Risk:** low
- **Verify:** timing + query-count before/after; recall output unchanged.

### W1-6 · REL · Crash-proofing: unguarded JSON.parse + storage upload orphan ✅
- **Problem:** (a) `JSON.parse` without try/catch on DB/file blobs in ~5 hot paths (`gateway/auth.js:25`, `gateway/proxy.js:327,372`, `orchestrator/providers.js:79`, `memory/server.js:~1406`) — one corrupted blob crashes the request handler; (b) storage upload writes MinIO **then** the DB row (`servers/storage/server.js:165-172`) — a DB failure leaves an untracked orphan object (quota leak, undeletable from UI).
- **Fix:** guarded parse helper with logged fallback; for upload, insert a `pending` row first (or delete the object on insert failure).
- **Severity:** medium-high (stability + data hygiene) · **Effort:** S · **Risk:** low
- **Verify:** corrupt-blob unit test returns error not crash; kill-DB-mid-upload leaves no orphan.

### W1-7 · DOC · Docs quick fixes ✅
- **Problem:** `docs/skills/index.md` is out of sync — lists `crow-dream.md` which **does not exist** on disk, misses `crow-identity.md` + `crow-crosspost.md` (45 files vs index); `getting-started/cloud-deploy.md` (Render) has no legacy banner while the index recommends Oracle; 1 hardcoded-base broken link; `developers/index.md` describes an unbuilt "Developer Environment"/`npm run package-addon` in present tense.
- **Fix:** `npm run sync-skills` (+ CI guard `git diff --exit-code` after sync); legacy banner on cloud-deploy; fix link; conditional language for unbuilt features.
- **Severity:** medium (public accuracy) · **Effort:** S · **Risk:** none
- **Verify:** `cd docs && npm run build` clean (currently passes in 5.5s; 24 cosmetic `env`-highlight warnings).

---

## WAVE 2 — Unification core (the leading dimension)

### W2-1 · UNI · One error shape + one auth pattern + rate-limiting across the route layer ⚠️
- **Problem:** 27 route files use **4 error-response shapes** and **6 distinct auth patterns**; `rate_limit_buckets` table exists but no route uses it; validation is per-route copy-paste.
- **Evidence:** `servers/gateway/routes/*` (survey in audit); `scripts/init-db.js` (`rate_limit_buckets`).
- **Fix:** small middleware set — `normalizeError()`, auth-middleware factories (`requireDashboardAuth/requireBearer/requireOAuth/requirePeerAuth/allowPublic`), `rateLimit(opts)`; migrate routes incrementally.
- **Severity:** high (coherence, security consistency) · **Effort:** M · **Risk:** medium — `/security-review` + full test run required.

### W2-2 · UNI · Shared HTTP client ⚠️
- **Problem:** 50+ files hand-roll `fetch`/`http.request` with inconsistent timeouts (some none — a stalled upstream hangs a turn), retries, and auth-header construction (18 ad-hoc builder sites).
- **Fix:** `servers/shared/http-client.js` (timeout, retry, logging) + `auth-headers.js`; migrate AI adapters and federation first.
- **Severity:** high (day-2 reliability) · **Effort:** M · **Risk:** medium.

### W2-3 · UNI · Config sanity: env registry, defaults, .env.example ⚠️
- **Problem:** ~171 distinct `process.env.*` names, no registry, defaults scattered and inconsistent, `.env.example` overwhelming (276 lines, no guidance), naming sprawl (`CROW_*`/`COMPANION_*`/`MPA_*`/bare).
- **Fix:** `docs/developers/configuration.md` registry + a `defaults.js` + a curated `.env.example` (do NOT rename vars in this wave — alias/rename is high-risk, defer).
- **Severity:** high (onboarding + ops) · **Effort:** M · **Risk:** low.

### W2-4 · UNI · Retire-or-fence the legacy bot layer (CrowClaw) ⚠️
- **Problem:** two bot systems coexist (CrowClaw/OpenClaw wrapper vs Bot Builder): legacy routes (`routes/bot-chat.js`), tables (`crowclaw_bot_messages`), panels, and 3 "(Legacy)" doc pages. Vision says coherence; operator says nothing is sacred.
- **Fix:** instrument usage first; if unused → remove routes/panel wiring, archive docs, plan table drop (data preserved per the absolute); if used → one fenced entry point + clear deprecation.
- **Severity:** high (the flagship sprawl item) · **Effort:** M-L · **Risk:** medium.

### W2-5 · UNI · Finish the project-spaces migration ⚠️
- **Problem:** dual-write `research_projects` ↔ `project_spaces` via forward triggers (`init-db.js:351-411`); 12+ code sites still write the legacy table; trigger has a partial-mirror failure mode and a slug-generation mismatch (SQL trigger keeps accents; JS slugify strips them → fleet desync potential).
- **Fix (staged):** first fix the slug mismatch + trigger robustness; then migrate writers to `project_spaces`; only then retire triggers. Schema changes stay additive (fleet rule).
- **Severity:** high (data-coherence seam) · **Effort:** L · **Risk:** high — its own spec + plan-review.

---

## WAVE 3 — Onboarding & UX (the north-star wave)

### W3-1 · ONB · One canonical "start here" path ⚠️
6 competing install guides, no decision tree; README + getting-started reference ~280 terminal commands. Fix: a single guided entry (quiz-style "pick your situation") + per-path pages; non-technical path leads.
**Effort:** M · **Risk:** low.

### W3-2 · ONB · Install/setup hardening with self-verification ⚠️
`crow-install.sh` can fail half-way with no recovery guidance; `setup.js` is a black box (no summary of what it created, cryptic failures). Fix: post-install self-check ("✓ gateway up ✓ DB ✓ token created"), resumable steps, plain-language failures. **Effort:** M · **Risk:** low.

### W3-3 · ONB · First-success moment + non-technical health view ⚠️
Nothing celebrates a working setup or shows "everything is OK" without SSH. Fix: completion screen with first-magic suggestions; a health card (gateway/bots/storage/backups) on the dashboard home — the layered-disclosure flagship. **Effort:** M · **Risk:** low.

### W3-4 · UX · Error UX to layered-disclosure standard ⚠️
50+ silent catches; `alert()` dialogs with raw errors + hardcoded EN (`blog.js`, extensions); raw JSON shown to users (orchestrator panel). Fix: one toast/notice component (plain language + optional details layer + retry), sweep worst offenders. **Effort:** M · **Risk:** low.

### W3-5 · UX · i18n holdouts + a11y baseline ✅(adoption count)
6/18 panels never import i18n — including the three biggest (bot-builder, bot-board, orchestrator); ~361 hardcoded colors bypass tokens in 13 panels; ~15 aria attrs across all panels, no focus-visible, border contrast below WCAG AA. Fix: wire i18n into holdouts, token sweep, focus/aria pass on wizards first. **Effort:** M · **Risk:** low.

### W3-6 · UX · IA / terminology coherence ⚠️
"Bot Board"+"Bot Builder" buried under Tools; legacy "Bot Management" labels linger; bots-vs-agents naming inconsistent with the spine (README says agents). Fix: nav regroup around the spine (Agents / Connections / Apps / System) + one term everywhere. **Effort:** S-M · **Risk:** low.

---

## WAVE 4 — Deep structural & data-integrity (each gets its own spec + adversarial plan review)

### W4-1 · REL · Sync conflict handling can silently drop user edits ⚠️ **[flagged: violates "user data is absolute"]**
Last-write-wins by Lamport ts: a stale replica arriving via a third peer is skipped *silently* (logged to `sync_conflicts`, never surfaced); plus the Lamport counter increment is non-atomic (duplicate timestamps possible: `sharing/instance-sync.js:163-173`) and the partial-sync checkpoint is written only after the loop (`:480-495` — crash → re-apply/duplicates). Fix: atomic counter, per-entry checkpointing, and **surface conflicts to the operator** (notification + recovery UI). **Effort:** L · **Risk:** high.

### W4-2 · REL · Transactional seams: bot deploy, deletes, SIGTERM ⚠️
Bot deploy marks `deployed` even if systemd enable failed; delete drops the DB row before archive confirms; `gracefulShutdown` doesn't await in-flight writes. Fix: staged status writes (`deploy_failed`), archive-before-delete, in-flight request draining with timeout. **Effort:** M · **Risk:** medium.

### W4-3 · UNI · Split the giants ⚠️
`sharing/server.js` 3,196 LOC; orchestrator `presets.js` 2,849; gateway `index.js` ~1,524; panels `bot-builder` 1,718 / `bot-board` 1,625 / `extensions` 1,614. Mechanical extraction along audit-mapped seams, one module per PR, behavior-frozen. **Effort:** L · **Risk:** medium.

### W4-4 · REL · Resource-exhaustion set ⚠️
Hypercore feed Maps grow unbounded (2 FDs/peer, no eviction); scheduler interval can double on restart; SSE connections uncapped; FTS5 accepts unbounded `full_text`. **Effort:** M · **Risk:** medium.

### W4-5 · EFF · Memory-recall payload shaping ⚠️
Recall returns full memory content untruncated (est. 750–1,250 tokens/session). Snippet mode + `include_full` opt-in — needs care: recall quality is product-critical, so A/B against real sessions before default-flip. **Effort:** M · **Risk:** medium (UX).

---

## WAVE 5 — Docs depth & ES parity (operator-paced)

- **W5-1 · DOC ·** EN docs improvement set: orchestrator user guide, router-mode/context guide, home-server security section, MinIO quickstart, arch↔guide cross-links, MCP-path table, naming-alias note (15 findings, ~5.5h total; per-page verdicts in Appendix A).
- **W5-2 · DOC ·** ES parity program: 22/~150 pages translated (14.5%); what exists is current + F7-aligned; 4 cross-locale link leaks. Staged translation (getting-started → guide core → platforms), AI-drafted + operator-reviewed. **Effort:** L (operator decides pace/scope).
- **W5-3 · DOC ·** Hygiene: real droplet IP `<droplet-ip>` sits in `docs/superpowers/plans/2026-06-10-f7-*.md` — `superpowers/**` is in `srcExclude` so it does NOT ship, but redact anyway (it's in the public git repo).

---

## Security audit & edge cases — summary

**Boundary verdict: STRONG.** Verified solid under adversarial review: 3-layer funnel enforcement (header set by tailscaled, mounted before routes), OAuth 2.1 + PKCE with hashed tokens and proper expiry, scrypt + `timingSafeEqual` password auth with persistent lockout, double-submit CSRF, TOTP 2FA, hashed-at-rest local MCP token (timing-safe), single-use domain-separated SSO tickets, default-deny peer exposure gate with audit trail, strict `isAllowedNetwork`. Findings above (W1-1..3, W2-1) are hardening, not breaches. The known 500-vs-401 OAuth quirk folds into W2-1's error normalization.

**Edge-case hunt** produced the Wave-4 reliability set; the two CRITICAL-rated items are W4-1 (silent sync data loss — the only finding that touches the vision's one absolute) and the storage orphan (pulled forward into W1-6).

**ROE compliance:** read-only code analysis; no live exploitation, no state mutation, no outbound sends; upfront snapshots taken before the audit began. Repro sketches are documented per finding for fix-time verification on the disposable instance.

---

## Cross-references to existing specs/plans

This report **supersedes** none of the 18 shipped F-series specs; it builds on them: F6a design system is the vehicle for W3-4/5; F6b/F6c wizards are the base for W3-1..3; F7 spine is the docs yardstick (Appendix A confirms EN coherence). `docs/plans/remaining-roadmap.md` items (Marketplace Phase B, MagicDNS, relays) are **out of scope** for the overhaul — they're new features, not overhaul findings; revisit after Wave 3.

---

## Appendix A — Docs per-page verdicts (EN)

All ~60 EN pages audited: **substantially accurate** post-F7. Verdicts: OK everywhere except — `getting-started/cloud-deploy.md` STALE (W1-7), `docs/skills/index.md` DRIFT (W1-7), `developers/index.md` MINOR-DRIFT (aspirational present tense, W1-7), `architecture/crowclaw.md` + `guide/bot-management.md` LEGACY (correctly banner'd; future tied to W2-4), `platforms/openclaw.md` missing a legacy banner (W5-1). Full table in the audit transcript; spot-check any page at fix time.

## Appendix B — Claims refuted during adversarial verification (NOT findings)

1. "Missing indexes on `memories.instance_id`/`project_id`, `research_notes.source_id`, `blog_posts.slug`" — **refuted**: all exist (`init-db.js:1018-1019`, `:453`; `blog_posts.slug` is `UNIQUE` = implicit index).
2. "bot-builder.js calls `t()` 71× without importing i18n" — **refuted**: grep-substring artifact; the real finding is the panel doesn't use i18n at all (W3-5).
3. "`ensureColumn` SQL injection is CRITICAL" — **downgraded**: function has zero callers; guarded as hygiene (W1-3).
4. "Panel path traversal is HIGH" — **downgraded to medium**: requires `~/.crow` write access (already operator-trust); fixed as defense-in-depth (W1-2).
5. Agent skill-counts disagreed (41/43/45) — **settled**: 45 files on disk, index lists a ghost (`crow-dream`) and misses two (W1-7).

---

## Proposed execution order & checkpoint

1. **Wave 1** (7 items, all S/low-risk): single branch `overhaul/wave-1`, subagent-driven with both review gates, `/security-review` on W1-1/2/3, full test suite + `auth-network` test. No planned downtime (gateway restarts only, batched).
2. **Wave 2** per-item branches; W2-5 (project migration) gets its own spec + adversarial plan review before any code.
3. **Waves 3–5** sequenced after Wave 2 lands; W4-1 elevated into Wave 3 if any real conflict-drop is observed in the wild.

**CHECKPOINT: awaiting operator go** (or re-rank instructions) before any prod-affecting work.
