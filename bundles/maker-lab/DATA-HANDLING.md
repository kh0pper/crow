# Maker Lab — Data Handling

This document tells you exactly what data Maker Lab stores, where it lives, who can access it, how long it sticks around, and how to get rid of it. It has two halves: a plain-language summary for parents and teachers, and a legal-reference section for school administrators reviewing deployment.

Maker Lab is a Crow bundle. Nothing in this document is a cloud service — everything runs on the Crow host you installed it on.

---

## Part 1 — Plain-language summary (for parents and teachers)

### What we store

When you create a learner profile:

- **Name** (first name or nickname)
- **Age** (used to pick the tutor persona: kid / tween / adult)
- **Avatar** (Live2D character id — just a reference, e.g. `mao_pro`)
- **Consent timestamp** (when you checked the consent box)

When a learner uses the kiosk:

- **Progress events** — "started lesson X", "completed lesson Y". Timestamped.
- **Artifacts** — any Blockly workspaces the kid saves. These live in Crow's storage.
- **Session records** — when a session started and ended, how many hints were used. No conversation content unless transcripts are turned on.

Optionally (opt-in, per learner):

- **Conversation transcripts** — the kid↔tutor chat text. **Off by default.** You turn this on in the learner's Settings page ("Record conversation transcripts for this learner").

### What we never store

- Email addresses, phone numbers, home addresses
- Photos or video of the kid
- Browser fingerprints tied to the kid's identity (kiosk device fingerprints are tied to the kiosk *device*, not the learner)
- Third-party analytics or telemetry. Nothing phones home.
- Contents of mic input (mic is off by default; even when on, audio is not recorded)

### Where it lives

Everything is in your Crow's local SQLite database (`~/.crow/data/crow.db`) and Crow's local storage bucket. It does not leave your host.

### How long it sticks around

- Profile data, progress events, artifacts: **forever**, until you delete the learner profile.
- Sessions: keeps the record; the session token itself is revoked on session end.
- Transcripts: **default 30 days**, configurable per learner (0 = purge on session end). A background sweep runs hourly.
- Redemption codes: expire in 10 minutes and are one-shot.

### Who can see it

- The **admin** (whoever has the Crow's Nest password) can see everything via the Maker Lab panel: list learners, read transcripts, export, delete.
- The **kid on the kiosk** can't see other learners' data. The session token scopes all read paths.
- **No one else.** There is no "share this learner's progress" feature. Peer-sharing tools (`crow_share`, `crow_send_message`) refuse to run while any Maker Lab session is active.

### How to get a copy of the data (data-subject access)

From the admin AI chat or the MCP tool:

> `maker_export_learner(learner_id)` → returns a JSON bundle with everything: profile, sessions, transcripts (if enabled), progress memories, artifact references.

### How to delete the data (right to be forgotten)

> `maker_delete_learner(learner_id, confirm: "DELETE", reason: "...")`

This cascades across every table: `maker_sessions`, `maker_transcripts`, `maker_bound_devices`, `maker_learner_settings`, `memories WHERE project_id = <learner>`, and `research_projects`. The panel has a two-step confirm (Tier 1).

### If you stop using Maker Lab

Uninstall the bundle from the Extensions page. The DB tables stay; run `maker_delete_learner` for each learner first, or drop the tables manually (`DROP TABLE maker_sessions; ...`). The Crow DB is yours — we don't do anything irreversible on uninstall.

---

## Part 2 — Legal reference (for school administrators)

Maker Lab is self-hosted. **Self-hosting does not exempt a US school from COPPA or an EU school from GDPR-K.** The consent process is the school's (or the family's) responsibility. What Maker Lab provides is the infrastructure to support that process: an audit trail, an export path, and a right-to-be-forgotten path.

### Fields stored (exhaustive)

| Table | Field | Notes |
|---|---|---|
| `research_projects` (type='learner_profile') | id, name, description, created_at, updated_at | Crow's shared project table; learner profiles are isolated from the generic Projects panel and `crow_recall_by_context` defaults (see the Phase 1 audit patches). |
| `maker_learner_settings` | learner_id, age, avatar, transcripts_enabled, transcripts_retention_days, idle_lock_default_min, auto_resume_min, voice_input_enabled, consent_captured_at, updated_at | Per-learner settings + consent timestamp. |
| `maker_sessions` | token, learner_id, is_guest, guest_age_band, batch_id, started_at, expires_at, revoked_at, state, idle_lock_min, idle_locked_at, last_activity_at, kiosk_device_id, hints_used, transcripts_enabled_snapshot | Session records. Token is opaque (24-byte random). |
| `maker_redemption_codes` | code, session_token, expires_at, used_at, claimed_by_fingerprint, created_at | One-shot handoff codes; 10-min TTL. `claimed_by_fingerprint` is a SHA-256 of `UA + Accept-Language + per-device localStorage salt`. |
| `maker_bound_devices` | fingerprint, learner_id, label, bound_at, last_seen_at | Solo-mode LAN-bound device registry. Empty unless the admin opts in to LAN exposure. |
| `maker_batches` | batch_id, label, created_by_admin, created_at, revoked_at, revoke_reason | Classroom batch metadata. |
| `maker_transcripts` | id, learner_id, session_token, turn_no, role ('kid'/'tutor'/'system'), content, created_at | Only written when `transcripts_enabled_snapshot = 1` on the session. |
| `memories` (source='maker-lab') | content, context, tags, source, importance, category, created_at, updated_at, accessed_at, access_count, project_id | Progress events. Tagged with `source='maker-lab'` so generic memory recall (`crow_recall_by_context`) excludes them by default. |

### Security posture

- **Kiosk auth**: per-session HttpOnly, SameSite=Strict, `__Host-`-prefixed cookie signed with HMAC-SHA256. Device fingerprint verified on every `/kiosk/*` request; a stolen cookie on a different device fails the fingerprint check.
- **Redemption**: atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING`. Exactly one racing redemption wins; all others get HTTP 410.
- **Cookie secret**: persists at `~/.crow/maker-lab.cookie.secret`. Rotating it invalidates all kiosks (force re-bind).
- **No URL-carried tokens**: URLs carry a short redemption code, never the session token. Browser history, projector mirrors, DHCP logs don't leak credentials.
- **LLM output filter**: every `maker_hint` return passes a Flesch-Kincaid grade cap (kid-tutor only), a kid-safe blocklist, and a per-persona word budget before reaching TTS. Prompt-only safety is not adequate for 5-year-olds.
- **Peer-sharing lockdown**: `crow_share`, `crow_generate_invite`, `crow_send_message` refuse to run while any Maker Lab session is active.

### COPPA (US)

- Operators covered by COPPA must obtain verifiable parental consent before collecting personal information from children under 13.
- Maker Lab's consent checkbox is a timestamped audit record — it is **not** a substitute for the school's own verifiable-parental-consent process. The checkbox text reads: *"I am the parent/guardian of this child, or I am the child's teacher operating under the school's consent process."*
- Data-subject access: `maker_export_learner`. Deletion: `maker_delete_learner`.
- Data minimization: only name, age, avatar, consent timestamp, and (if enabled) transcripts + progress. No PII beyond those fields is collected from the child.
- No third-party data sharing. No advertising. No analytics.

### GDPR-K (EU, children under 16; member-state minimums vary)

- Maker Lab provides the technical means to support Articles 15 (access), 17 (erasure), and 20 (portability): `maker_export_learner` returns a JSON bundle.
- Lawful basis is **not** inferred from the checkbox; the deploying institution must establish it (typically consent or legitimate interest backed by DPIA).
- Retention defaults: transcripts 30 days, everything else indefinite until deletion — configurable per learner. Schools with stricter retention requirements should set `transcripts_retention_days` to match their policy.
- No data transfers. Everything stays on the Crow host.

### Incident response

- If a learner profile is accidentally exposed (e.g. a leaked database backup), the admin should:
  1. Rotate `~/.crow/maker-lab.cookie.secret` — invalidates every active kiosk.
  2. Rotate any API keys in Crow's AI Profiles.
  3. Export and delete the affected learners per the institution's breach-notification policy.
- No automated breach notification. The self-hosted posture means the school is the controller for both purposes and incident reporting.

### Deploying in a school

Recommended checklist before first classroom use:

1. Run Maker Lab on a school-managed host (not a teacher's personal device).
2. Confirm the school's VPC/LAN doesn't expose the Crow host's `/kiosk/*` routes to the internet.
3. Decide whether transcripts are on or off per learner, and document it in the school's records policy.
4. Decide a retention period that matches the school's records retention policy; set `transcripts_retention_days` accordingly.
5. Complete the school's standard parental consent process (COPPA in the US, GDPR-K / member-state analogue in the EU) **before** using the consent checkbox in the panel.
6. Name a data-protection point of contact (teacher, IT admin, or DPO in EU) and document how requests (export / delete) are handled.

Questions, corrections, and legal review welcome. This document reflects the bundle's behavior as of the most recent Phase 2.2 commit; behavior can be verified by reading the SQL in `bundles/maker-lab/server/init-tables.js` and the route code in `bundles/maker-lab/panel/routes.js`.
