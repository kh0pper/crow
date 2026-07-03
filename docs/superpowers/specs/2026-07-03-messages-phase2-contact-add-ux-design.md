# Messages Phase 2 — contact-add UX (C1–C4, "no more copy-paste gymnastics") — design spec

> **Status: DESIGN (approved by operator 2026-07-03).** Next: writing-plans →
> execution plan per PR in `docs/superpowers/plans/` (R8+R7-plan format) →
> 2-round adversarial review → subagent-driven execution → final review → PR →
> deploy. This is **Phase 2** of the Crow Messages usability arc.
> Master plan: `docs/superpowers/plans/2026-07-01-crow-messages-usability-arc.md`.
> Flow map: `.superpowers/messages-plan/contact-flow-map.md`.

## Why

The arc's original trigger: mutually adding contacts between Kevin's crow and
his wife's fresh MacBook install was "a kind of painful process" — generate an
opaque code, copy it out through another app, paste it into a collapsed tray on
the other side, with a timing-fragile completion step that half-fails if the
inviter is offline (L6's origin — Phase 1 made the *consequences* recoverable;
Phase 2 fixes the *experience*). Per locked decision **D3**: build all three of
share link, QR code, short code. The bar is "stupidly simple" for a
non-technical user (beachhead: public-education admin).

## Scope (locked with operator 2026-07-03)

| # | Decision |
|---|---|
| P1 | **C1 landing = static page + code-in-fragment.** The invite link/QR points to a public **static** page on the project docs site (`https://maestro.press/software/crow/invite#<code>`), NOT any gateway. Zero new gateway surface — the network-exposure invariant is untouched. `CROW_INVITE_PAGE_URL` env overrides the base for self-hosters. |
| P2 | **C2 KDF = Node built-in `crypto.scrypt`** with memory-hard parameters (argon2id-class per the master-plan guardrail). No new dependency, no native build step on user installs. |
| P3 | **Packaging = 3 sequential PRs**: PR1 = C1+C3 (links/QR + one surface, no new crypto); PR2 = C2 (short codes — the crypto component, isolated for its dedicated adversarial review); PR3 = C4 (robust completion + trust UI, the only schema bump). |
| P4 | **No in-app camera QR scanner in Phase 2.** A phone-camera scan opens the static page (copy → paste path). An in-app scanner needs a QR-decode library; logged as a follow-up. |
| P5 | Standard link/QR invites keep the existing **24h expiry** (displayed in the UI); C2 short codes expire in **minutes** (~10) per the locked guardrail. |

## Current state (verified live @ main `356924a9`)

- Invite code: `crowId.base64url({ed25519Pub, secp256k1Pub, crowId, expires}).hmac`,
  24h expiry, generated in `generateInviteCode` (`servers/sharing/identity.js:287`),
  parsed/validated in `parseInviteCode` (`identity.js:309`). **No server-side
  single-use ledger; no URL/QR form; no relay hints.**
- Bot-invite QR precedent: `bot-builder/editor.js:427-450` builds an absolute
  `/dashboard/messages?bot_invite=<code>` URL + `qrcode` data-URL (dep already in
  `package.json:76`). Its own comment: owner-devices-only, NOT a cross-user path.
- The Messages panel **already parses a deep-link param** and renders a
  pre-filled accept card (`panels/messages/html.js:35-44` for `bot_invite`) —
  the person-invite deep-link follows this exact pattern.
- Person invite UI today: collapsed tray in Messages only
  (`panels/messages/html.js:223-244` generate + accept textareas; handlers at
  `panels/messages/api-handlers.js:101/121`). The Contacts panel cannot add
  peers at all — it has manual/vCard/bot add plus R4's `add_by_id` repair form
  (`panels/contacts/html.js:115-124`, `api-handlers.js:98`).
- Safety number: `computeSafetyNumber` (`identity.js:102`) — SHA-256 over both
  ed25519 pubkeys sorted, formatted 8 groups of 5 digits. Computed, **shown
  nowhere**; no `verified` column on `contacts`.
- `invite_accepted` (sent at `servers/sharing/tools/contacts.js:132`) is
  **fire-and-forget**: R5's `shouldEnqueue` (`servers/sharing/retry-queue.js:46-58`)
  deliberately excludes `crow_social` and `invite_accepted` from the retry
  queue. An offline inviter still produces the half-state; R4 made it
  *repairable* (message-requests + add-by-id + promote-on-`invite_accepted`),
  not *impossible*.
- Docs site: VitePress under `docs/`, deployed by `.github/workflows/deploy-docs.yml`
  to GitHub Pages at base `/software/crow/` → public URL
  `https://maestro.press/software/crow/`.
- `SCHEMA_GENERATION = 3` (`servers/shared/schema-version.js:13`).
- Kiosk mode blocks invite generate/accept (`tools/contacts.js:44` and accept
  path) — all new surfaces must keep these guards.
- Relay fleet: 4 relays; the self-hosted `wss://nostr.crow.maestro.press`
  **allowlists kind:4 only** (all Crow traffic is kind:4).

---

## PR1 — C1 + C3: invite links + QR + one surface

### 1. Invite URL builder (shared)

New pure helper (e.g. `servers/sharing/invite-url.js`):
`buildInviteUrl(code)` → `${base}#${encodeURIComponent(code)}` where `base` =
`CROW_INVITE_PAGE_URL` env if set, else the product default
`https://maestro.press/software/crow/invite`. `parseInviteFragment(url)` is the
inverse (client-side JS uses the same convention). The code rides the URL
**fragment** — it never reaches any server, including the docs host.

### 2. Static invite page (docs site)

New `docs/public/invite/index.html` — a self-contained verbatim static file
(VitePress copies `docs/public/` to the site root untouched, so it serves at
`https://maestro.press/software/crow/invite/`; a markdown page can't carry
plain inline `<script>` — VitePress treats those as Vue SFC blocks). Bilingual
EN/ES in one page (JS toggle), inline CSS, zero external resources:
- Reads `location.hash`; if a code is present, shows it in a monospace block
  with a **Copy** button and two paths:
  - "Have Crow? Open your dashboard → Messages → Accept invite → paste."
    Optional pure-client nicety: an "enter your Crow address" input that builds
    `https://<their-gateway>/dashboard/messages?invite=#<code>` **locally in
    JS** (no network call) and links there.
  - "New to Crow?" → install/docs links.
- If no fragment: a short explainer of Crow invites.
- Honest copy (master-plan requirement): the messenger that carried the link
  can see the code; the 24h expiry and single-acceptance do the real work;
  verify the safety number after connecting (names C4's backstop).
- No analytics, no query params, nothing logged.

### 3. Generator-side share block

Where an invite is generated (shared component, §5), the result renders as a
share block modeled on the bot-invite one:
- Full invite URL in a click-to-select textarea + **Copy link** button.
- QR of the URL (`qrcode` → data URL, same pattern as `editor.js:441-444`).
- The raw code as a collapsible fallback ("paste directly if the link won't
  open").
- Expiry shown ("expires in 24 h").
- `crow_generate_invite` (`tools/contacts.js:38`) returns the URL alongside the
  raw code (additive text change; existing consumers unaffected).

### 4. Recipient-side deep link

Messages panel accepts `?invite=<code>`: pre-fills a person-invite accept card
(same mechanism as `bot_invite` at `html.js:35-44`; parsing in the panel's
data-loading step, validation via `parseInviteCode` for a friendly preview —
"Connect with `crow:xyz…`?" — before the user confirms). CSRF and kiosk guards
as on the existing accept form.

### 5. One shared component (C3)

Extract the generate/accept UI into one module (e.g.
`panels/shared/peer-invite-ui.js` following the existing panel-shared-code
convention) rendered by BOTH:
- **Messages** — keeps its current entry point (tray → the shared component).
- **Contacts** — new "Add a peer" section (the natural home; sits beside the
  existing manual-add and R4 `add_by_id` forms), same actions routed through
  the contacts api-handlers to the same underlying tools.
Both render the share block (§3) after generate and the paste/accept form +
deep-link pre-fill after `?invite=`. Kiosk guards preserved in both panels.
EN+ES i18n for every new string.

---

## PR2 — C2: short codes without a rendezvous server

**Threat model first** (this component gets the hardest adversarial review):
the rendezvous event sits on PUBLIC relays and the code-derived key is also the
event's signing key. An attacker who cracks the code within the expiry window
can (a) decrypt the payload (privacy leak: inviter's pubkeys) and (b) publish a
competing event under the same derived key and MITM the pairing. Every
guardrail below exists to make that infeasible; C4's safety number is the named
backstop.

### 1. Code format

8 characters of Crockford base32 (I/L/O/U excluded) from `crypto.randomBytes`
→ **40 bits of entropy**, displayed grouped `K7Q4-M2X9` (hyphen cosmetic,
stripped + uppercased on entry; ambiguous glyphs normalized per Crockford).

### 2. Key derivation (both sides, identical)

`crypto.scrypt(normalizedCode, fixedContextSalt, 32, { N: 2**17, r: 8, p: 1, maxmem: 256*1024*1024 })`
(async form — a ~0.1-1 s derivation must not block the gateway event loop)
→ 32-byte seed → secp256k1 keypair. `fixedContextSalt` is a product-constant
domain-separation string (e.g. `"crow-shortcode-invite-v1"`) — no per-invite
salt is possible (the code is the only shared secret), which is exactly why the
entropy floor and memory-hardness matter: ~128 MB + ~0.1-1 s per guess makes
online brute-force against a 40-bit space within a 10-minute window absurd, and
relays additionally rate-limit (`messages_per_sec=8` on ours).

### 3. Rendezvous event

Inviter publishes a **kind:4 self-DM**: authored by the code-derived key,
`#p`-tagged to the code-derived pubkey, content = NIP-44 encryption (to the
code-derived key itself) of `{ inviteCode, expires }` where `inviteCode` is a
**full standard invite code** (so everything downstream of rendezvous is the
existing, already-reviewed accept path) and `expires` is the rendezvous's OWN
~10-minute deadline — distinct from, and much shorter than, the inner code's
24h field; the acceptor enforces the shorter one. kind:4 deliberately: the maestro relay's allowlist carries it, so all 4
relays serve rendezvous. `created_at` now; the event is inherently replaceable
by anyone holding the key — accepted risk, covered by the threat model above.

### 4. Expiry + single-use

- **Expiry ~10 minutes**, enforced twice: an `expires` field inside the
  encrypted payload (acceptor rejects stale) AND the inviter tracks the
  outstanding short-code invite in memory/DB and stops honoring it after
  expiry.
- **Inviter-side single-use**: the standard invite minted for the short-code
  flow carries an additive `inviteId` nonce in its payload (backward
  compatible — absent field = today's behavior), and the acceptor's
  `invite_accepted` echoes it. The inviter's ledger records the outstanding
  short-code invite by `inviteId`; the FIRST authenticated `invite_accepted`
  echoing it consumes the row; any later `invite_accepted` with a consumed
  `inviteId` is rejected — no promote, no ack, logged. This binds the inner
  24h code to the ledger too: extracted and replayed later, it hits the same
  consumed `inviteId`. (Deliberately stronger than the standard link path,
  which stays P5/24h.)

### 5. UX

In the shared component (PR1 §5): "Use a short code instead" →
- Inviter: big grouped code + countdown ("expires in 10:00"), regenerate
  button.
- Acceptor: one input ("enter the 8-character code"), normalization applied,
  then the flow is invisible — derive, fetch (author-filter on the 4 relays),
  decrypt, and hand off to the standard accept path with the same preview/
  confirm card as PR1 §4.
- UI copy names the backstop: "After connecting, compare safety numbers to
  verify" (links to C4's surface once PR3 lands).

---

## PR3 — C4: robust completion + trust UI

### 1. Idempotent, repairable accept

`crow_accept_invite` (and the panel paths) route contact creation through R4's
`upsertFullContact` (`servers/sharing/contact-promote.js`): re-accepting an
invite for an existing/partial contact merges/promotes instead of erroring.
Accept becomes safely re-runnable — the repair action IS the normal action.

### 2. Handshake completion that survives an offline inviter

Today `invite_accepted` is one fire-and-forget DM (excluded from R5 retry by
`shouldEnqueue`). PR3 adds a **handshake ack**: the inviter, on processing an
authenticated `invite_accepted` (existing promote path from R4), sends a
`crow_social`/`handshake_complete` control ack; the acceptor retries
`invite_accepted` on the R5 backoff schedule until acked or expired (~60h,
same `CROW_NOSTR_RETRY_MAX_AGE_SEC` policy). Implementation reuses the
`message_retry_queue` machinery with an explicit carve-in for this one control
type (the general `crow_social` exclusion stays). Both directions are
idempotent: duplicate `invite_accepted` hits the R4 promote path (no-op),
duplicate acks just clear an already-cleared row. Result: the L6 half-state can
no longer be *created* by an offline inviter — Phase 1 made it repairable,
PR3 makes it not happen.

### 3. Trust UI (safety number + verified)

- New `verified` INTEGER DEFAULT 0 column on `contacts` →
  **SCHEMA_GENERATION 3→4** (the only schema bump in Phase 2; boot gate
  auto-applies on plain restart, validated 3× live in Phase 1).
- Contact detail view (Contacts panel) shows the safety number (8×5 digits,
  from `computeSafetyNumber`) with plain-words copy ("compare this number with
  your contact over a channel you trust — a call, in person") and a "Mark as
  verified" toggle.
- Verified badge (✓) on contact rows and the Messages conversation header.
- A key change for an existing crow_id (seen via R4 merge paths) resets
  `verified` to 0 — never silently keep a verified badge across a key change.
- EN+ES.

---

## Error handling

- Static page: no fragment → explainer; malformed/expired code → friendly
  message client-side (the page can decode the payload's `expires` without any
  key — it's base64url — but MUST NOT render pubkey details; just validity).
- Deep link `?invite=`: invalid/expired → the existing invite-error banner
  pattern (`html.js:149-151`), never a crash; code value never echoed into
  logs.
- Short code: wrong/expired code → "code not found or expired — ask for a new
  one" after the relay fetch window (bounded, ~5 s); relay outage → same
  message + the R7 nest signal already covers 0-relay states.
- All new POST actions: CSRF (`csrfInput`) + kiosk guards, matching existing
  panel conventions.

## Testing

- **Unit (per PR):** URL build/parse round-trip + env override; static-page
  fragment JS (jsdom-free string test of the builder; the page's JS is
  mirrored by a tested helper); scrypt derivation vectors (fixed code → fixed
  pubkey); Crockford normalization; single-use consume/reject; expiry
  rejection both sides; idempotent accept (fresh/partial/full/re-accept);
  handshake ack round-trip + retry carve-in (shouldEnqueue table extended);
  `verified` migration + reset-on-key-change; XSS-safety of every new render
  (escapeHtml/textContent, as R2 established).
- **E2E (Gitea harness, crow↔black-swan):** short-code pairing end-to-end over
  live relays; offline-inviter handshake completion (deadman-guarded stop of
  the DUT per harness safety rules); PR1 deep-link accept smoke.
- Full suite green (982 baseline) per PR; isolated gateway boot clean.

## Non-goals / follow-ups

- In-app camera QR scanner (P4) — follow-up with a QR-decode lib decision.
- LAN auto-discovery (declined in D3).
- Relay hints in the invite payload (from the master plan's R5 notes) — worth
  folding into the invite format when a format change is next needed; not
  required now (all product installs share the 4 defaults).
- Single-use ledger for standard 24h link invites (short codes get one; links
  keep today's semantics per P5).
- Phase 3 (contacts-follow-user) consumes C3's single surface unchanged.

## Standing constraints

Fix-the-product (works on a fresh single-click install — the static page is
product infrastructure, env-overridable); network-exposure invariant untouched
(no new gateway routes; the static page is the docs site); commit with
positional paths; check-runs before merge; never attribute Claude; bump
SCHEMA_GENERATION for the PR3 column; docs-deploy flake is known-cosmetic.
