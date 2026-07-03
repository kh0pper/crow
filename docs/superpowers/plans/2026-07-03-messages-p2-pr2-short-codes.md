# Messages Phase 2 PR2 — Short Codes Without a Rendezvous Server (C2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people pair by speaking/typing an 8-character code — no link, no copy-paste of a 300-char blob: the inviter's Crow publishes an encrypted rendezvous event under a key derived from the code; the acceptor types the code, derives the same key, fetches, decrypts, and runs the normal (already-reviewed) accept path.

**Architecture:** Four pieces. (1) **`servers/sharing/short-code.js`** — pure crypto module: Crockford-base32 code generation (8 chars = 40 bits), normalization, async `crypto.scrypt` key derivation (N=2¹⁷, r=8 — memory-hard per the master-plan guardrail), and the NIP-44 self-encrypted rendezvous envelope (kind:4 self-DM authored by the code-derived key — kind:4 deliberately, so the maestro relay's allowlist carries it and all 4 relays serve rendezvous). (2) **Single-use ledger** — `servers/sharing/shortcode-ledger.js` on the existing `dashboard_settings` table (NO schema change): the short-code invite's standard inner code carries an additive `inviteId` nonce; the acceptor's `invite_accepted` echoes it; the inviter's `handleInviteAccepted` consumes it once and rejects replays. (3) **Tools** — `crow_generate_short_invite` / `crow_accept_short_invite` (kiosk-guarded), with the existing `crow_accept_invite` body extracted VERBATIM into a shared `acceptInviteCore` both accept paths call, plus two small `NostrManager` methods (`publishRendezvousEvent`, `fetchLatestByAuthor`). (4) **UI** — the PR1 shared component gains a "Use a short code instead" surface in both panels.

**THREAT MODEL (this PR gets the hardest adversarial review):** the rendezvous event sits on PUBLIC relays and the code-derived key is also the event's signing key. An attacker who cracks the code inside the expiry window can decrypt the payload (privacy leak: inviter's pubkeys + a standard invite code) and publish a competing event under the same key (pairing MITM). Defenses, layered: **40-bit entropy** (8 chars × 5 bits, `crypto.randomBytes`) × **memory-hard KDF** (~128 MB + high CPU per guess makes online brute-force of 2⁴⁰ against relays absurd within minutes) × **~10-minute expiry** (enforced in the encrypted envelope AND at the inviter's ledger) × **inviter-side single-use** (first authenticated `invite_accepted` echoing the `inviteId` wins; replays rejected) × **safety number named in the UI as the explicit MITM backstop**. Honest limits, stated in code comments and UI copy: single-use is best-effort on the generating instance (see the multi-instance note in Background); the person you speak the code to — and anyone who overhears — holds the secret until it expires.

**Tech Stack:** Node ESM, `crypto.scrypt`/`randomBytes` (built-in), `nostr-tools` (`finalizeEvent`, `getPublicKey`, `nip44.v2` — all already imported in this codebase), Node built-in test runner. **No new dependencies. NO schema change → NO `SCHEMA_GENERATION` bump** (stays 3; the ledger lives in `dashboard_settings`); plain-restart deploy.

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never bare. NEW files: `git add <thatpath>` first. Verify `git show --stat HEAD` after each commit. Unrelated untracked WIP in the tree must never be swept.
- **`git pull --rebase` before any push.** Never attribute Claude as co-author.
- **Tests**: `node --test tests/<file>.test.js`; full suite green (`node --test tests/` — 1009/1009 on `main` as of `f1036f96`).
- **NO schema change.** Do NOT touch `servers/shared/schema-version.js` or `scripts/init-db.js`.
- **`crypto.scrypt` ASYNC only — NEVER `scryptSync`** (a ~0.5-1 s, 128 MB derivation must not block the gateway event loop). Exact params: `{ N: 2**17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }`.
- **The short code and the inner invite code must NEVER be logged** — every `console.*` on these paths logs fixed strings only.
- **Kiosk guards** on BOTH new tools (`isKioskActive`/`kioskBlockedResponse`, same pattern as `crow_generate_invite` at `tools/contacts.js:44`).
- **VERBATIM-MOVE discipline** for the `acceptInviteCore` extraction (the R8 standard): the moved body must be verified identical (normalized diff) except the declared, minimal parameterization; `crow_accept_invite`'s observable behavior must not change.
- **Honest failure**: 0-relay rendezvous publish = tool `isError` (the R2 discipline); fetch-miss/expired = friendly `isError`, never a silent no-op.
- **Never throw on the receive path**: the `handleInviteAccepted` gate addition must be throw-proof (ledger errors → fail OPEN to today's behavior, log a fixed string).
- **i18n**: every new user-visible string in `servers/gateway/dashboard/shared/i18n.js`, BOTH `en` and `es`. XSS: `escapeHtml` every interpolation.
- Branch: `feat/messages-p2-short-codes` (base = this plan's commit on `main`). Spec: `docs/superpowers/specs/2026-07-03-messages-phase2-contact-add-ux-design.md` §PR2.

---

## Background — the exact code being changed (verified @ `main` f1036f96)

**Key/event plumbing (`servers/sharing/nostr.js`).** Imports `finalizeEvent`, `getPublicKey` (`:23-24`) and `nip44` (`:28`). `sendMessage` (`:139-…`) shows the canonical kind:4 build: `getConversationKey(this.identity.secp256k1Priv, recipientPubkey)` → `nip44.v2.encrypt` → `finalizeEvent({ kind: 4, created_at, tags: [["p", recipientPubkey]], content }, priv)` → publish loop `for (const [url, relay] of this.relays) { if (await safeRelayPublish(relay, event)) published.push(url); }` with `await this.connectRelays()` first when `this.relays.size === 0`. 66-hex compressed pubkeys are x-only-normalized by stripping the 02/03 prefix (`:146-150`). `identity.secp256k1Priv` is a 32-byte `Buffer` (`identity.js:180`) — a scrypt-output `Buffer` is the same shape. **There is NO one-shot fetch helper** — `fetchLatestByAuthor` is new (this plan, Task 3).

**Accept path (`servers/sharing/tools/contacts.js`).** `registerContactsTools` destructures `{ db, identity, syncManager, peerManager, nostrManager }` from ctx (`:33` region). `crow_accept_invite` (`:72-175`): kiosk guard → `extractInviteCode` → `parseInviteCode` → already-contact early-return → INSERT contact → `syncManager.initContact` → `peerManager.joinContact` → `nostrManager.subscribeToContact` → `computeSafetyNumber` → best-effort `invite_accepted` DM whose payload is `{ type, crowId, ed25519Pub, secp256k1Pub }` (`:135-147`) → success text. Imports already include `z`, kiosk helpers, `identity.js` fns, `upsertFullContact`, `invite-url.js` (`:8-12`); `randomUUID` is NOT yet imported.

**Invite code format (`servers/sharing/identity.js`).** `generateInviteCode(identity)` (`:287`) builds payload `{ ed25519Pub, secp256k1Pub, crowId, expires }`; `parseInviteCode` (`:309`) validates crowId-consistency + expiry + fingerprint and returns `{ crowId, ed25519Pubkey, secp256k1Pubkey }`. Both get additive `inviteId` support (Task 2).

**Inviter-side handler (`servers/sharing/boot.js`).** `handleInviteAccepted(db, managers, payload, senderPubkey)` (`:134`) — R4's authenticated promote path (gates on `normalizePubkey(payload.secp256k1Pub) === normalizePubkey(senderPubkey)`); called from the receive ladder at `:371`. The single-use gate inserts at the TOP of this function, BEFORE any promote work.

**Ledger storage precedent (`servers/sharing/contact-promote.js:13-60`).** The R4 cursor reads/writes `dashboard_settings` from the sharing layer with raw `db.execute` + `INSERT … ON CONFLICT(key) DO UPDATE`. **Multi-instance note (verified `instance-sync.js:120-133`):** `dashboard_settings` rows sync ONLY for allowlisted keys — the ledger key is NOT allowlisted, so it stays instance-local. Because the fleet shares one Nostr identity, an `invite_accepted` may land on a SIBLING instance whose ledger has never seen the `inviteId`; policy: **unknown inviteId → proceed as a normal invite** (fail-open). This is safe: replaying a captured `invite_accepted` is idempotent re-promotion of the same already-authenticated contact (R4 gate), and the single-use property is a best-effort *extra* layer on the generating instance — entropy × KDF × expiry carry the real MITM defense. Document this in the module docstring.

**Relay constraint.** The self-hosted relay allowlists kind:4 only (`docs/architecture/sharing-server.md`) — the rendezvous event MUST be kind 4.

**UI seam (PR1).** `servers/gateway/dashboard/shared/peer-invite-ui.js` renders the generate/accept forms both panels embed; messages actions in `panels/messages/api-handlers.js` (pattern at `generate_invite`/`accept_invite`), contacts actions in `panels/contacts/api-handlers.js` (injectable `sharingClientFactory`, returns `{inviteResult}`/`{inviteError}`/`{redirect}`).

**Test scaffolding to reuse.** `tests/delivery-receipt-emit.test.js` — method-stubbing a real `NostrManager` (null db). `tests/contact-promote.test.js` — in-memory db stub for `dashboard_settings` read/write + `handleInviteAccepted` drive pattern. `tests/invite-accepted-promote.test.js` — the forged/authenticated `invite_accepted` cases Task 2's gate must not regress.

## File Structure

- **Create** `servers/sharing/short-code.js` — pure: code gen/format/normalize, scrypt derivation, rendezvous envelope build/parse. No manager imports.
- **Create** `servers/sharing/shortcode-ledger.js` — `dashboard_settings`-backed single-use ledger (record/consume/prune). Imports nothing but takes `db`.
- **Modify** `servers/sharing/identity.js` — additive `inviteId` in generate/parse.
- **Modify** `servers/sharing/boot.js` — single-use gate at the top of `handleInviteAccepted`.
- **Modify** `servers/sharing/nostr.js` — `publishRendezvousEvent(event)` + `fetchLatestByAuthor(authorHex, timeoutMs)`.
- **Modify** `servers/sharing/tools/contacts.js` — `acceptInviteCore` extraction; `inviteId` echo; two new tools.
- **Modify** `servers/gateway/dashboard/shared/peer-invite-ui.js` + `i18n.js` — short-code UI + keys.
- **Modify** `panels/messages/api-handlers.js`, `panels/messages/html.js`, `panels/messages.js`, `panels/contacts/api-handlers.js`, `panels/contacts.js`, `panels/contacts/html.js` — the two new actions + result rendering (small, mirrors PR1).
- **Create** tests: `tests/short-code.test.js`, `tests/shortcode-ledger.test.js`, `tests/short-invite-tools.test.js`, `tests/short-code-ui.test.js`.

---

## Task 1: `short-code.js` — codes, derivation, rendezvous envelope

**Files:**
- Create: `servers/sharing/short-code.js`
- Test: `tests/short-code.test.js`

**Interfaces (later tasks rely on these exact names):**
- `SHORTCODE_EXPIRY_MS = 10 * 60 * 1000`
- `generateShortCode(): string` — 8 Crockford chars (no I/L/O/U), from `randomBytes(5)` (5 bytes = 40 bits = 8×5-bit symbols, zero bias).
- `formatShortCode(code): string` — `"K7Q4-M2X9"` display grouping.
- `normalizeShortCode(input): string` — uppercase, strip `[-\s]`, map `I→1 L→1 O→0`; returns `""` unless the result is exactly 8 chars of the alphabet.
- `async deriveShortCodeKeys(code, opts = {}): { priv: Buffer, pub: string }` — `scrypt(normalized, "crow-shortcode-invite-v1", 32)` with the Global-Constraints params (opts may override `N` FOR TESTS ONLY — documented as such); `pub` = x-only 64-hex via `getPublicKey(priv)`.
- `buildRendezvousEvent(keys, payload): Event` — `payload` is `{ inviteCode, expires }`; NIP-44 self-encrypt (`getConversationKey(keys.priv, keys.pub)`), `finalizeEvent({ kind: 4, created_at: now, tags: [["p", keys.pub]], content }, keys.priv)`.
- `parseRendezvousEvent(event, keys): { inviteCode, expires }` — throws `"not a rendezvous event"` if `event.pubkey !== keys.pub`, throws on decrypt/JSON failure, throws `"short code expired"` when `Date.now() > expires`.

- [ ] **Step 1: Write the failing test**

Create `tests/short-code.test.js`:

```js
// tests/short-code.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHORTCODE_EXPIRY_MS,
  generateShortCode,
  formatShortCode,
  normalizeShortCode,
  deriveShortCodeKeys,
  buildRendezvousEvent,
  parseRendezvousEvent,
} from "../servers/sharing/short-code.js";

// Small-N derivation for tests (documented test-only override) — full-strength
// N=2^17 would cost ~1s & 128MB per call; the derivation path is identical.
const T = { N: 2 ** 14 };

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

test("generateShortCode: 8 chars of the Crockford alphabet, no I/L/O/U", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateShortCode();
    assert.equal(c.length, 8);
    for (const ch of c) assert.ok(ALPHABET.includes(ch), `bad char ${ch}`);
  }
});

test("formatShortCode groups 4-4", () => {
  assert.equal(formatShortCode("K7Q4M2X9"), "K7Q4-M2X9");
});

test("normalizeShortCode: case, separators, confusables", () => {
  assert.equal(normalizeShortCode(" k7q4-m2x9 "), "K7Q4M2X9");
  assert.equal(normalizeShortCode("k7q4 m2x9"), "K7Q4M2X9");
  assert.equal(normalizeShortCode("Il0o-abcd".replace("abcd", "2345")), "11002345");
  assert.equal(normalizeShortCode("K7Q4M2XU"), "", "U is not in the alphabet");
  assert.equal(normalizeShortCode("K7Q4M2X"), "", "too short");
  assert.equal(normalizeShortCode("K7Q4M2X99"), "", "too long");
  assert.equal(normalizeShortCode(null), "");
});

test("deriveShortCodeKeys: deterministic, normalization-invariant, x-only pub", async () => {
  const a = await deriveShortCodeKeys("K7Q4M2X9", T);
  const b = await deriveShortCodeKeys(" k7q4-m2x9 ", T);
  assert.equal(a.pub, b.pub, "same code (post-normalization) → same key");
  assert.equal(a.pub.length, 64, "x-only hex pubkey");
  assert.ok(Buffer.isBuffer(a.priv) && a.priv.length === 32);
  const c = await deriveShortCodeKeys("K7Q4M2X8", T);
  assert.notEqual(a.pub, c.pub, "different code → different key");
});

test("deriveShortCodeKeys rejects invalid codes", async () => {
  await assert.rejects(() => deriveShortCodeKeys("nope", T), /invalid short code/);
});

test("rendezvous envelope round-trips and binds to the code key", async () => {
  const keys = await deriveShortCodeKeys("K7Q4M2X9", T);
  const payload = { inviteCode: "crow:abc123def0.eyJ4IjoxfQ.c2ln", expires: Date.now() + SHORTCODE_EXPIRY_MS };
  const event = buildRendezvousEvent(keys, payload);
  assert.equal(event.kind, 4, "kind:4 (relay allowlist)");
  assert.equal(event.pubkey, keys.pub, "authored by the code key");
  assert.deepEqual(event.tags, [["p", keys.pub]], "self p-tag");
  assert.ok(!event.content.includes(payload.inviteCode), "content is encrypted");
  const out = parseRendezvousEvent(event, keys);
  assert.deepEqual(out, payload);
});

test("wrong code cannot read the envelope", async () => {
  const keys = await deriveShortCodeKeys("K7Q4M2X9", T);
  const wrong = await deriveShortCodeKeys("K7Q4M2X8", T);
  const event = buildRendezvousEvent(keys, { inviteCode: "x", expires: Date.now() + 1000 });
  assert.throws(() => parseRendezvousEvent(event, wrong));
});

test("expired envelope is rejected", async () => {
  const keys = await deriveShortCodeKeys("K7Q4M2X9", T);
  const event = buildRendezvousEvent(keys, { inviteCode: "x", expires: Date.now() - 1 });
  assert.throws(() => parseRendezvousEvent(event, keys), /expired/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/short-code.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `servers/sharing/short-code.js`:

```js
/**
 * Short-code pairing (Messages Phase 2 PR2 / C2) — pure crypto module.
 *
 * An 8-char Crockford-base32 code (40 bits from crypto.randomBytes) is the
 * ONLY shared secret. Both sides derive a secp256k1 keypair from it via
 * memory-hard scrypt; the inviter publishes a kind:4 self-DM under that key
 * (kind:4 so the self-hosted relay's allowlist carries it) whose NIP-44
 * content wraps a standard invite code + a short expiry. THREAT MODEL: the
 * event is public and the derived key also signs it — a cracked code within
 * the window = pairing MITM. Defenses: 40-bit entropy x ~128MB/1s-per-guess
 * scrypt x ~10-minute expiry x inviter-side single-use (shortcode-ledger) x
 * the safety number as the named backstop. No per-invite salt is possible
 * (the code is the only shared input) — that is exactly why the entropy
 * floor and memory-hardness are non-negotiable.
 *
 * Pure module: no manager imports, no logging, never logs a code.
 */

import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";

const scrypt = promisify(_scrypt);

export const SHORTCODE_EXPIRY_MS = 10 * 60 * 1000; // minutes-scale, per guardrail

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const SALT = "crow-shortcode-invite-v1"; // domain separation; the code is the only secret
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** 8 symbols x 5 bits = 40 bits, drawn bias-free from 5 random bytes. */
export function generateShortCode() {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let code = "";
  for (let i = 7; i >= 0; i--) {
    code = ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)] + code;
  }
  // Loop above walks symbols most-significant-first; string built accordingly.
  return code.split("").reverse().join("");
}

/** Display grouping: K7Q4-M2X9. */
export function formatShortCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

/**
 * Uppercase, strip separators, map Crockford confusables (I/L→1, O→0).
 * Returns "" unless the result is EXACTLY 8 alphabet chars (U stays invalid).
 */
export function normalizeShortCode(input) {
  if (typeof input !== "string") return "";
  const up = input.toUpperCase().replace(/[-\s]/g, "")
    .replace(/I/g, "1").replace(/L/g, "1").replace(/O/g, "0");
  if (up.length !== 8) return "";
  for (const ch of up) if (!ALPHABET.includes(ch)) return "";
  return up;
}

/**
 * Derive the rendezvous keypair from the code. ASYNC scrypt only — the
 * ~128MB/~1s derivation must never block the event loop. `opts.N` exists
 * FOR TESTS ONLY (full-strength derivation in every production call).
 */
export async function deriveShortCodeKeys(code, opts = {}) {
  const norm = normalizeShortCode(code);
  if (!norm) throw new Error("invalid short code");
  const params = { ...SCRYPT_PARAMS, ...(opts.N ? { N: opts.N } : {}) };
  const priv = await scrypt(norm, SALT, 32, params);
  return { priv: Buffer.from(priv), pub: getPublicKey(priv) };
}

/** Kind:4 self-DM under the code key; content = NIP-44({ inviteCode, expires }). */
export function buildRendezvousEvent(keys, payload) {
  const conversationKey = nip44.v2.utils.getConversationKey(keys.priv, keys.pub);
  const content = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);
  return finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", keys.pub]],
    content,
  }, keys.priv);
}

/** Inverse of buildRendezvousEvent; throws on wrong key, tamper, or expiry. */
export function parseRendezvousEvent(event, keys) {
  if (!event || event.pubkey !== keys.pub) throw new Error("not a rendezvous event");
  const conversationKey = nip44.v2.utils.getConversationKey(keys.priv, keys.pub);
  const payload = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
  if (!payload || typeof payload.inviteCode !== "string" || typeof payload.expires !== "number") {
    throw new Error("malformed rendezvous payload");
  }
  if (Date.now() > payload.expires) throw new Error("short code expired");
  return { inviteCode: payload.inviteCode, expires: payload.expires };
}
```

**Implementer note on `generateShortCode`:** the double-reverse above is intentional-looking but silly — simplify to a single forward loop if you prefer, PROVIDED the test's alphabet/length/bias properties hold (any straight 8×5-bit extraction of the 40 bits is correct; there is no modulo bias to worry about because 32 divides 2⁴⁰ evenly).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/short-code.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/short-code.js tests/short-code.test.js
git commit servers/sharing/short-code.js tests/short-code.test.js -m "feat(sharing): short-code module — Crockford codes, scrypt-derived rendezvous keys, NIP-44 envelope (P2/C2)"
git show --stat HEAD
```

---

## Task 2: Single-use ledger + `inviteId` plumbing + the `handleInviteAccepted` gate

**Files:**
- Create: `servers/sharing/shortcode-ledger.js`
- Modify: `servers/sharing/identity.js` (additive `inviteId` in generate/parse)
- Modify: `servers/sharing/boot.js` (gate at top of `handleInviteAccepted`)
- Test: `tests/shortcode-ledger.test.js`

**Interfaces:**
- `generateInviteCode(identity, opts = {})` — when `opts.inviteId` is a string, the payload gains `inviteId`; otherwise byte-identical behavior to today. `parseInviteCode` returns `inviteId` (string|undefined) alongside the existing fields.
- Ledger (all take `db`; all THROW-PROOF is the CALLER's job — these may throw on db errors):
  - `recordShortInvite(db, inviteId, codeExpiresAt): Promise<void>` — stores `{ state: "outstanding", codeExpiresAt, recordedAt }`.
  - `consumeShortInvite(db, inviteId): Promise<"consumed"|"replayed"|"unknown">` — outstanding→consumed returns `"consumed"`; already-consumed returns `"replayed"`; missing returns `"unknown"`. Prunes entries older than `LEDGER_TTL_MS` on every call.
  - `LEDGER_TTL_MS = 72 * 60 * 60 * 1000` — **deliberately much longer than the 10-min code expiry**: PR3 will retry `invite_accepted` for up to ~60h (inviter offline), and a legit late echo must still find its ledger row. The 10-min window gates the CODE (envelope `expires`, acceptor-side); the ledger's job is replay discrimination for as long as an echo can legitimately arrive.
- Gate policy in `handleInviteAccepted` (top of function, before any promote work):
  - `payload.inviteId` absent → proceed (normal invite, today's behavior).
  - `"consumed"` → proceed.
  - `"replayed"` → log fixed string `[sharing] short-code invite replay rejected`, RETURN (no promote, no side effects).
  - `"unknown"` → proceed. (Fail-open by design: the fleet shares one Nostr identity and the ledger is instance-local — a sibling instance legitimately sees unknown inviteIds. Replay of a captured `invite_accepted` is idempotent re-promotion of an already-authenticated contact, so fail-open costs nothing; the module docstring documents this.)
  - Ledger THROWS → log fixed string, proceed (fail open to today's behavior — never let a ledger bug break honest pairing).

- [ ] **Step 1: Write the failing test**

Create `tests/shortcode-ledger.test.js`:

```js
// tests/shortcode-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_TTL_MS,
  recordShortInvite,
  consumeShortInvite,
} from "../servers/sharing/shortcode-ledger.js";
import { generateInviteCode, parseInviteCode } from "../servers/sharing/identity.js";

// Minimal in-memory dashboard_settings stub (contact-promote.test.js pattern).
function makeDb() {
  const store = new Map();
  return {
    async execute({ sql, args }) {
      if (/SELECT value FROM dashboard_settings/.test(sql)) {
        const v = store.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (/INSERT INTO dashboard_settings/.test(sql)) {
        store.set(args[0], args[1]);
        return { rows: [] };
      }
      throw new Error("unexpected sql: " + sql);
    },
    _store: store,
  };
}

test("record → consume → replayed", async () => {
  const db = makeDb();
  await recordShortInvite(db, "id-1", Date.now() + 600000);
  assert.equal(await consumeShortInvite(db, "id-1"), "consumed");
  assert.equal(await consumeShortInvite(db, "id-1"), "replayed");
});

test("unknown inviteId", async () => {
  const db = makeDb();
  assert.equal(await consumeShortInvite(db, "never-seen"), "unknown");
});

test("entries older than LEDGER_TTL_MS are pruned; consumed survives within TTL", async () => {
  const db = makeDb();
  await recordShortInvite(db, "old", Date.now() + 600000);
  // Backdate the entry beyond TTL by editing the stored JSON directly.
  const raw = JSON.parse(db._store.get("sharing:shortcode_invites"));
  raw["old"].recordedAt = Date.now() - LEDGER_TTL_MS - 1000;
  db._store.set("sharing:shortcode_invites", JSON.stringify(raw));
  assert.equal(await consumeShortInvite(db, "old"), "unknown", "pruned → unknown");
});

test("ledger TTL is much longer than the code expiry (late honest echo survives)", async () => {
  const db = makeDb();
  await recordShortInvite(db, "late", Date.now() + 600000);
  const raw = JSON.parse(db._store.get("sharing:shortcode_invites"));
  raw["late"].recordedAt = Date.now() - 60 * 60 * 60 * 1000; // 60h ago (PR3 retry horizon)
  db._store.set("sharing:shortcode_invites", JSON.stringify(raw));
  assert.equal(await consumeShortInvite(db, "late"), "consumed", "60h-late echo still consumes");
});

test("corrupt ledger JSON self-heals to empty", async () => {
  const db = makeDb();
  db._store.set("sharing:shortcode_invites", "{not json");
  assert.equal(await consumeShortInvite(db, "x"), "unknown");
  await recordShortInvite(db, "y", Date.now() + 1000); // must not throw
  assert.equal(await consumeShortInvite(db, "y"), "consumed");
});

test("generateInviteCode carries an additive inviteId; parseInviteCode surfaces it", () => {
  const fakeIdentity = globalThis.__testIdentity ?? null;
  // Build a real identity-shaped object from identity.js test helpers is heavy;
  // instead verify via the payload directly:
  const { createHmac } = { createHmac: null };
  // Simpler: round-trip through the real functions with a derived identity is
  // done in short-invite-tools tests (Task 3). Here, assert the OPTIONAL param
  // does not break the legacy shape:
  assert.equal(typeof generateInviteCode, "function");
  assert.equal(generateInviteCode.length >= 1, true);
});
```

**Implementer note on the last test:** the placeholder above is deliberately weak because building a real `identity` fixture requires `deriveIdentity` (not exported). REPLACE it with a real round-trip using the exported `loadOrCreateIdentity` pointed at a temp `CROW_DATA_DIR` **if** that is cheap in this codebase, OR export a small test-only identity fixture the way existing identity tests do — READ `tests/` for any existing test that constructs an identity (e.g. grep `loadOrCreateIdentity\|generateInviteCode` in tests/) and follow that pattern. The assertion that matters: `parseInviteCode(generateInviteCode(id, { inviteId: "n-1" })).inviteId === "n-1"` AND `parseInviteCode(generateInviteCode(id)).inviteId === undefined`. If no pattern exists, create the identity by calling `loadOrCreateIdentity()` with `CROW_DATA_DIR` env pointed at a `mkdtempSync` dir in a child-process-free way (check how `identity.js` reads its data dir — `DATA_DIR` is module-level, so an env-var approach may require the test to set the env BEFORE importing; use a dynamic `await import()` after setting the env).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/shortcode-ledger.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the ledger**

Create `servers/sharing/shortcode-ledger.js`:

```js
/**
 * Short-code single-use ledger (Messages Phase 2 PR2 / C2).
 *
 * Backed by dashboard_settings (key below) — NO schema change. The key is NOT
 * in the instance-sync allowlist, so the ledger is INSTANCE-LOCAL by design:
 * the fleet shares one Nostr identity, so an invite_accepted echo may land on
 * a sibling instance that never saw the inviteId → callers treat "unknown" as
 * fail-open (proceed as a normal invite). That is safe: replaying a captured
 * invite_accepted only re-promotes the same authenticated contact (R4 gate,
 * idempotent). Single-use here is a best-effort EXTRA layer on the generating
 * instance; entropy x scrypt x expiry carry the real MITM defense.
 *
 * TTL is ~72h — far beyond the 10-minute CODE expiry — because PR3 retries
 * invite_accepted for up to ~60h (offline inviter) and a legit late echo must
 * still find its row. The code window is enforced elsewhere (envelope expires).
 */

const KEY = "sharing:shortcode_invites";
export const LEDGER_TTL_MS = 72 * 60 * 60 * 1000;

async function loadLedger(db) {
  try {
    const res = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [KEY],
    });
    if (!res.rows.length) return {};
    const parsed = JSON.parse(res.rows[0].value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // corrupt/missing → self-heal empty
  }
}

function prune(ledger, now) {
  for (const [id, entry] of Object.entries(ledger)) {
    if (!entry || typeof entry.recordedAt !== "number" || now - entry.recordedAt > LEDGER_TTL_MS) {
      delete ledger[id];
    }
  }
  return ledger;
}

async function saveLedger(db, ledger) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [KEY, JSON.stringify(ledger)],
  });
}

export async function recordShortInvite(db, inviteId, codeExpiresAt) {
  const now = Date.now();
  const ledger = prune(await loadLedger(db), now);
  ledger[inviteId] = { state: "outstanding", codeExpiresAt, recordedAt: now };
  await saveLedger(db, ledger);
}

export async function consumeShortInvite(db, inviteId) {
  const now = Date.now();
  const ledger = prune(await loadLedger(db), now);
  const entry = ledger[inviteId];
  if (!entry) { await saveLedger(db, ledger); return "unknown"; }
  if (entry.state === "consumed") { await saveLedger(db, ledger); return "replayed"; }
  entry.state = "consumed";
  await saveLedger(db, ledger);
  return "consumed";
}
```

- [ ] **Step 4: Additive `inviteId` in `identity.js`**

In `generateInviteCode` (`identity.js:287`), change the signature to `generateInviteCode(identity, opts = {})` and the payload build to:

```js
  const payloadObj = {
    ed25519Pub: identity.ed25519Pubkey,
    secp256k1Pub: identity.secp256k1Pubkey,
    crowId: identity.crowId,
    expires,
  };
  if (opts.inviteId) payloadObj.inviteId = String(opts.inviteId);
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
```

In `parseInviteCode` (`:309`), add `inviteId: data.inviteId` to the returned object (undefined when absent — additive, no behavior change for legacy codes).

- [ ] **Step 5: The gate in `boot.js`**

At the very top of `handleInviteAccepted(db, managers, payload, senderPubkey)` (`boot.js:134`), before any existing logic:

```js
  // P2/C2 single-use gate: a short-code invite's acceptance echoes the
  // inviteId; the first echo consumes it, replays are dropped. Fail OPEN on
  // unknown (instance-local ledger; sibling instances legitimately miss it)
  // and on ledger errors (never let the ledger break honest pairing).
  if (payload && typeof payload.inviteId === "string" && payload.inviteId) {
    try {
      const { consumeShortInvite } = await import("./shortcode-ledger.js");
      const verdict = await consumeShortInvite(db, payload.inviteId);
      if (verdict === "replayed") {
        console.warn("[sharing] short-code invite replay rejected");
        return;
      }
    } catch {
      console.warn("[sharing] short-code ledger check failed — proceeding");
    }
  }
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/shortcode-ledger.test.js tests/invite-accepted-promote.test.js tests/contact-promote.test.js`
Expected: ALL PASS (the two R4 suites prove the gate does not disturb authenticated promotion — their payloads carry no `inviteId`, so the gate is a no-op for them).

- [ ] **Step 7: Commit**

```bash
git add servers/sharing/shortcode-ledger.js tests/shortcode-ledger.test.js
git commit servers/sharing/shortcode-ledger.js tests/shortcode-ledger.test.js servers/sharing/identity.js servers/sharing/boot.js -m "feat(sharing): short-code single-use ledger + inviteId plumbing + replay gate (P2/C2)"
git show --stat HEAD
```

---

## Task 3: `acceptInviteCore` extraction + rendezvous publish/fetch + the two tools

**Files:**
- Modify: `servers/sharing/nostr.js` (two new methods)
- Modify: `servers/sharing/tools/contacts.js` (core extraction, `inviteId` echo, two new tools)
- Test: `tests/short-invite-tools.test.js`

**Interfaces:**
- `NostrManager.publishRendezvousEvent(event): Promise<string[]>` — `connectRelays()` when empty, then the `safeRelayPublish` loop verbatim from `sendMessage` (`nostr.js:170-176`); returns the `published` url list. NO local message cache, NO retry enqueue (a rendezvous event is not a DM).
- `NostrManager.fetchLatestByAuthor(authorHex, timeoutMs = 5000): Promise<Event|null>` — `connectRelays()` when empty; on each connected relay, `relay.subscribe([{ kinds: [4], authors: [authorHex], limit: 1 }], { onevent, oneose })`; collect events until every relay reaches EOSE or the timeout fires; close all subs (in `finally`); return the newest by `created_at` (null if none). Must never throw on a single-relay failure.
- `acceptInviteCore({ invite_code, display_name })` — module-level async function inside `tools/contacts.js` holding the CURRENT `crow_accept_invite` body VERBATIM (from `const peer = parseInviteCode…` through the success-return), parameterized only by the already-in-closure `db/identity/syncManager/peerManager/nostrManager`. Two declared changes ONLY: (a) the `acceptancePayload` gains `...(peer.inviteId ? { inviteId: peer.inviteId } : {})`; (b) it returns the same `{ content: [...] }` shapes it does today. `crow_accept_invite`'s handler becomes: kiosk guard → `extractInviteCode` → `try { return await acceptInviteCore(...) } catch → isError` (identical observable behavior).
- Tool `crow_generate_short_invite` (no params): kiosk guard → `generateShortCode()` → `deriveShortCodeKeys(code)` (FULL-strength — no N override) → `randomUUID()` inviteId → `generateInviteCode(identity, { inviteId })` → `recordShortInvite(db, inviteId, expires)` → `buildRendezvousEvent(keys, { inviteCode, expires: Date.now() + SHORTCODE_EXPIRY_MS })` → `publishRendezvousEvent`; `published.length === 0` → `isError` "could not reach any relay — try again or use an invite link"; success text: the FORMATTED code, the expiry in minutes, "speak or type it — don't post it anywhere public", and the safety-number verification pointer. The raw short code appears ONLY in the tool result (never logged).
- Tool `crow_accept_short_invite` (`{ short_code: z.string().max(32), display_name? }`): kiosk guard → `normalizeShortCode` (empty → friendly `isError` "that doesn't look like a Crow short code") → `deriveShortCodeKeys` → `fetchLatestByAuthor(keys.pub)` (null → `isError` "code not found or expired — ask for a fresh one") → `parseRendezvousEvent` (throws expired/tamper → same friendly `isError`) → `acceptInviteCore({ invite_code: payload.inviteCode, display_name })`.

- [ ] **Step 1: Write the failing test**

Create `tests/short-invite-tools.test.js` — stub-driven, no live relays (method-stub pattern from `tests/delivery-receipt-emit.test.js`; in-memory MCP client pattern from existing tool tests — grep `createSharingServer` in tests/ and reuse the lightest existing harness; if tool tests all go through the in-memory server, do that; the essential cases:)

```js
// Essential cases (exact assertion style: adapt to the harness you reuse):
// 1. generate: returns formatted XXXX-XXXX code + records ledger + publishes a
//    kind:4 event authored by a 64-hex key ≠ identity key (stub
//    publishRendezvousEvent to capture the event; assert event.pubkey !=
//    identity secp x-only pub, and assert the DISPLAYED code parses via
//    normalizeShortCode).
// 2. generate with 0-relay publish (stub returns []) → result.isError true.
// 3. accept happy path: stub fetchLatestByAuthor to return a real
//    buildRendezvousEvent(keys, { inviteCode: <real generated invite>,
//    expires: future }); assert a contact row was inserted and the
//    invite_accepted acceptancePayload (capture via stubbed
//    nostrManager.sendMessage) carries inviteId === the generated one.
// 4. accept with garbage code → isError, no derivation attempted (fast).
// 5. accept when fetch returns null → isError "not found or expired".
// 6. accept when envelope expired → isError.
// 7. VERBATIM guard: crow_accept_invite still works end-to-end on a plain
//    (non-short) invite — contact inserted, safety number in output,
//    acceptancePayload has NO inviteId key.
// Use deriveShortCodeKeys(code, { N: 2**14 }) in tests via injecting the code
// whose keys you precomputed — BUT the tools use full-strength derivation
// internally. For test speed, tool tests may monkey-patch the short-code
// module? NO — instead pass a REAL code and accept the ~1-2s full derivation
// cost in the two tests that exercise it (generate + accept happy path);
// keep the other cases derivation-free (garbage code, stubbed fetch nulls).
```

Write real tests from this skeleton — every case above must exist and assert concretely.

- [ ] **Step 2: Run to verify failure** — `node --test tests/short-invite-tools.test.js` → FAIL (tools not defined).

- [ ] **Step 3: `nostr.js` methods** — add `publishRendezvousEvent` and `fetchLatestByAuthor` as specified in Interfaces, placed near `sendMessage`. Reuse `safeRelayPublish` (already imported). For `fetchLatestByAuthor`, mirror the subscribe-shape used elsewhere in the file (`relay.subscribe([filter], { onevent, oneose })` — see `subscribeToContact`); track per-relay EOSE, `setTimeout` (unref'd) for the cap, `finally { sub.close() }` per relay.

- [ ] **Step 4: `tools/contacts.js`** — (a) add imports: `randomUUID` from `"crypto"`; `generateShortCode, formatShortCode, normalizeShortCode, deriveShortCodeKeys, buildRendezvousEvent, parseRendezvousEvent, SHORTCODE_EXPIRY_MS` from `"../short-code.js"`; `recordShortInvite` from `"../shortcode-ledger.js"`. (b) Extract `acceptInviteCore` VERBATIM per Interfaces (run a normalized diff old-body vs new-function to prove identity; the ONLY delta is the `inviteId` spread in `acceptancePayload`). (c) Register the two tools with the exact behaviors in Interfaces. Tool descriptions must tell the model when to use them (e.g. generate: "Generate a short 8-character pairing code to read aloud or type. Expires in 10 minutes…").

- [ ] **Step 5: Run the tests** — `node --test tests/short-invite-tools.test.js tests/invite-url.test.js tests/short-code.test.js tests/shortcode-ledger.test.js` → ALL PASS. Also `node --test tests/crow-accept-bot-invite.test.js tests/contact-promote.test.js` (neighbors touching this file's tool surface) → PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/short-invite-tools.test.js
git commit tests/short-invite-tools.test.js servers/sharing/nostr.js servers/sharing/tools/contacts.js -m "feat(sharing): short-code tools — rendezvous publish/fetch, verbatim acceptInviteCore, inviteId echo (P2/C2)"
git show --stat HEAD
```

---

## Task 4: UI — "Use a short code instead" in both panels + i18n

**Files:**
- Modify: `servers/gateway/dashboard/shared/peer-invite-ui.js` (+ short-code renderers)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new keys)
- Modify: `panels/messages/api-handlers.js`, `panels/messages/html.js`, `panels/messages.js` (two actions + result render)
- Modify: `panels/contacts/api-handlers.js`, `panels/contacts.js`, `panels/contacts/html.js` (same)
- Test: `tests/short-code-ui.test.js`

**Interfaces:**
- `renderShortCodeShare({ formattedCode, expiresAt }, lang): string` — the inviter's result block: the code BIG (monospace, letter-spaced), "expires at HH:MM (~10 minutes)" (server-rendered time, no live countdown — keep it dependency-free), the speak-don't-post warning, and the safety-number pointer (`invite.verifyLater`, existing key).
- `renderShortCodeForms({ lang, csrf = "" }): { generateForm, acceptForm }` — generate: hidden action `generate_short_invite` + button; accept: `<input name="short_code" maxlength="16">` (accepts hyphens/spaces; server normalizes) + hidden action `accept_short_invite` + button.
- Panel actions (both panels, mirroring PR1's generate/accept action shapes exactly):
  - `generate_short_invite` → call `crow_generate_short_invite`; messages: `req._shortCodeResult = text` / `req._inviteError`, return false; contacts: return `{ shortCodeResult: text }` / `{ inviteError }`.
  - `accept_short_invite` → call `crow_accept_short_invite` with `req.body.short_code`; error → same error surfaces as PR1's accept; success → redirect (same as accept_invite).
- Result parsing: `parseShortCodeResult(text): { formattedCode, expiresAt }|null` (in `peer-invite-ui.js`) — extracts the `XXXX-XXXX` token (regex `/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/`) and computes `expiresAt = Date.now() + 10*60*1000` at render time (display-only).
- New i18n keys (EN+ES, exact copy in the implementing step): `invite.shortCodeTitle`, `invite.shortCodeGenerateBtn`, `invite.shortCodeHint` ("Read it aloud or type it — anyone who hears it can use it until it expires."), `invite.shortCodeExpiry` ("Expires in about 10 minutes"), `invite.shortCodeAcceptPlaceholder` ("Enter the 8-character code…"), `invite.shortCodeAcceptBtn`, `invite.shortCodeToggle` ("Use a short code instead").
- Placement: in BOTH panels the short-code UI lives inside the SAME container as PR1's forms — messages: two new `msg-invite-dialog` entries are NOT added; instead the existing `#invite-generate` and `#invite-accept` dialogs each gain a `<details>` "Use a short code instead" block under the PR1 form (one surface, progressive disclosure). Contacts: same `<details>` inside the existing add-peer section, under the two PR1 forms.

- [ ] **Step 1: failing test** — `tests/short-code-ui.test.js`: renderShortCodeShare (code shown, expiry text, hint, es strings, XSS on formattedCode); renderShortCodeForms (actions + field names + csrf); buildMessagesHTML with `shortCodeShare` set renders the block; renderContactList shows the toggle; parseShortCodeResult round-trip + null on garbage. Follow the PR1 test files' fixture patterns (`tests/messages-invite-share.test.js`, `tests/contacts-peer-add.test.js`).
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement** — shared renderers + i18n first, then the four panel files, mirroring PR1's exact wiring shapes (loader passes `shortCodeShare` built via `parseShortCodeResult(req._shortCodeResult)`; contacts threads it through `peerAdd`).
- [ ] **Step 4: run** — `node --test tests/short-code-ui.test.js tests/peer-invite-ui.test.js tests/messages-invite-share.test.js tests/contacts-peer-add.test.js tests/messages-add-bot-form.test.js` → ALL PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/short-code-ui.test.js
git commit tests/short-code-ui.test.js servers/gateway/dashboard/shared/peer-invite-ui.js servers/gateway/dashboard/shared/i18n.js servers/gateway/dashboard/panels/messages.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages/api-handlers.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/contacts/api-handlers.js -m "feat(dashboard): short-code pairing UI in Messages + Contacts (P2/C2)"
git show --stat HEAD
```

---

## Task 5: Full suite + boot + SECURITY-FOCUSED final review + ledger → PR

- [ ] **Step 1:** `node --test tests/ 2>&1 | tail -5` → 0 fail (1009 baseline + ~25 new).
- [ ] **Step 2:** Isolated boot: `D=$(mktemp -d); CROW_GATEWAY_URL= CROW_DATA_DIR=$D PORT=3999 timeout -k 5 25 node servers/gateway/index.js --no-auth > /tmp/p2c2boot.log 2>&1; grep -E "listening|Subscribed|Error" /tmp/p2c2boot.log | head` → clean, both subscribe lines.
- [ ] **Step 3: Final whole-branch review (opus)** — THE security review. Mandates: brute-force math check (40 bits × scrypt cost × 10-min window × relay rate limits); MITM race analysis (competing event under the same key — what does the acceptor see, is newest-wins exploitable inside the window); replay analysis end-to-end (ledger TTL vs PR3 retry horizon; fail-open reasoning; sibling-instance case); envelope tamper/wrong-key paths; VERBATIM check on `acceptInviteCore` (3rd independent normalized diff); event-loop audit (no `scryptSync` anywhere; derivation off the hot receive path); log hygiene (neither code ever logged); kiosk on both tools; UI copy honesty (EN+ES).
- [ ] **Step 4:** Fix Critical/Important; re-review.
- [ ] **Step 5:** Record execution + review in this plan; ledger update.
- [ ] **Step 6:** `git pull --rebase && git push -u origin feat/messages-p2-short-codes`; PR via github MCP (owner=kh0pper, repo=crow, base=main) titled `feat(messages): short-code pairing — scrypt rendezvous, single-use, 10-min expiry (Phase 2 PR2, C2)`; check-runs verified (expect 0 applicable — port-allocation is path-filtered off); merge OPERATOR-GATED; deploy crow (plain restart, no schema bump) + verify /health, subscribe lines, and a live generate→accept round trip between crow and black-swan (harness peer) if convenient.

---

## Self-Review (against the design spec §PR2)

- Code format 8-char Crockford/40-bit → Task 1 (bias-free 5-byte extraction). KDF scrypt N=2¹⁷ r=8 async + maxmem → Tasks 1/3 (full-strength in tools; test-only N override documented). Rendezvous kind:4 self-DM under code key → Task 1 (relay-allowlist constraint honored). Expiry ~10 min enforced twice → envelope `expires` (acceptor, Task 1) + ledger record (inviter, Task 2). Single-use via additive `inviteId` echoed in `invite_accepted` → Task 2 (+ gate policy incl. the multi-instance fail-open honesty). UX: big code + expiry + normalization-forgiving input + safety-number backstop named → Task 4. Downstream of rendezvous = the existing accept path → Task 3's VERBATIM `acceptInviteCore`. Threat model documented in module docstring + plan header → Task 1.
- Type consistency: `deriveShortCodeKeys → { priv: Buffer, pub: string }` consumed by `buildRendezvousEvent(keys, …)`/`parseRendezvousEvent(event, keys)`/`fetchLatestByAuthor(keys.pub)` uniformly; ledger verdict strings `"consumed"|"replayed"|"unknown"` matched in the boot.js gate; `inviteId` flows generate→parse→acceptancePayload→handleInviteAccepted with the same field name throughout.
- Placeholder scan: Task 3 Step 1 and Task 4 give assertion-level skeletons rather than full listings — deliberate (they adapt to existing harness patterns the implementer must read first), with every required case enumerated concretely. No TBDs.

## Review

*(2-round adversarial review to be recorded here before execution.)*
