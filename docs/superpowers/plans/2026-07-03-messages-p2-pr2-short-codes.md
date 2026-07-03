# Messages Phase 2 PR2 — Short Codes Without a Rendezvous Server (C2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people pair by speaking/typing a 12-character code — no link, no copy-paste of a 300-char blob: the inviter's Crow publishes an encrypted rendezvous event under a key derived from the code; the acceptor types the code, derives the same key, fetches, decrypts, and runs the normal (already-reviewed) accept path.

**Architecture:** Four pieces. (1) **`servers/sharing/short-code.js`** — pure crypto module: Crockford-base32 code generation (12 chars = 60 bits), normalization, async `crypto.scrypt` key derivation (N=2¹⁷, r=8 — memory-hard per the master-plan guardrail), and the NIP-44 self-encrypted rendezvous envelope (kind:4 self-DM authored by the code-derived key — kind:4 deliberately, so the maestro relay's allowlist carries it and all 4 relays serve rendezvous). (2) **Single-use ledger** — `servers/sharing/shortcode-ledger.js` on the existing `dashboard_settings` table (NO schema change): the short-code invite's standard inner code carries an additive `inviteId` nonce; the acceptor's `invite_accepted` echoes it; the inviter's `handleInviteAccepted` consumes it once and rejects replays. (3) **Tools** — `crow_generate_short_invite` / `crow_accept_short_invite` (kiosk-guarded), with the existing `crow_accept_invite` body extracted VERBATIM into a shared `acceptInviteCore` both accept paths call, plus two small `NostrManager` methods (`publishRendezvousEvent`, `fetchLatestByAuthor`). (4) **UI** — the PR1 shared component gains a "Use a short code instead" surface in both panels.

**THREAT MODEL (this PR gets the hardest adversarial review):** the rendezvous event sits on PUBLIC relays and the code-derived key is also the event's signing key. An attacker who cracks the code inside the expiry window can decrypt the payload (privacy leak: inviter's pubkeys + a standard invite code) and publish a competing event under the same key (pairing MITM). **The KDF salt is a fixed product constant** (the code is the only shared secret — no per-invite salt is possible), so the memory-hard cost is a ONE-TIME, amortizable precomputation over the whole code space, NOT a per-attack cost — a fixed-salt design does not let memory-hardness "defeat" brute-force, it only sets the size of a one-time table. Defenses, layered and honestly costed: **60-bit entropy** (12 Crockford chars × 5 bits, `crypto.randomBytes`) — the floor is raised from the spec's 40-bit MINIMUM specifically because the fixed salt makes 2⁴⁰ precomputable (~12k core-years, ~9 TB table — feasible for a well-funded adversary); 2⁶⁰ precomputation is ~10¹⁰–10¹¹ core-years and a ~32-exabyte table, infeasible for anyone. × **memory-hard KDF** (scrypt N=2¹⁷ r=8 — blunts GPU/ASIC parallelism, raising the per-eval cost of that precompute) × **~10-minute expiry** (the encrypted envelope's `expires` + the SHORT inner-invite `expires` both bound the ACCEPTOR side to 10 min via any accept path; the inviter's ledger `codeExpiresAt` cutoff bounds the `inviteId`-echoed path. HONEST LIMIT: a code-KNOWER who forges an `invite_accepted` from their OWN identity with `inviteId` OMITTED is authenticated (their secp == their signing key) and the ledger cannot see it — that fresh-forged-pairing case is bounded only by entropy×KDF and the safety-number backstop, NOT by expiry. The expiry legs stop honest-acceptor leaks and authenticated-echo replays, which is what they exist for.) × **inviter-side single-use after authentication** (the first AUTHENTICATED `invite_accepted` echoing the `inviteId` wins; replays rejected) × **acceptor fail-closed on a compromised code** (two distinct rendezvous events under one code key → "get a fresh code") × **safety number named in the UI as the explicit MITM backstop** (with the honest caveat below). Honest limits, stated in code comments and UI copy: single-use is best-effort on the generating instance (see the multi-instance note in Background); the person you speak the code to — and anyone who overhears — holds the secret until it expires; **and the safety-number comparison UI does not land until PR3, so PR2's UI copy points at it as the coming backstop while naming out-of-band verification as the interim advice.**

**Tech Stack:** Node ESM, `crypto.scrypt`/`randomBytes` (built-in), `nostr-tools/pure` (`finalizeEvent`, `getPublicKey`) + `nostr-tools/nip44` (`nip44.v2`) — the import paths `nostr.js` uses (`:22-28`), Node built-in test runner. **No new dependencies. NO schema change → NO `SCHEMA_GENERATION` bump** (stays 3; the ledger lives in `dashboard_settings`); plain-restart deploy.

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never bare. NEW files: `git add <thatpath>` first. Verify `git show --stat HEAD` after each commit. Unrelated untracked WIP in the tree must never be swept.
- **`git pull --rebase` before any push.** Never attribute Claude as co-author.
- **Tests**: `node --test tests/<file>.test.js`; full suite green (`node --test tests/` — 1009/1009 on `main` as of `f1036f96`).
- **NO schema change.** Do NOT touch `servers/shared/schema-version.js` or `scripts/init-db.js`.
- **`crypto.scrypt` ASYNC only — NEVER `scryptSync`** (a ~0.5-1 s, 128 MB derivation must not block the gateway event loop). Exact params: `{ N: 2**17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }`. **DoS guard (M4):** both tools are auth-gated (MCP/dashboard token) + kiosk-guarded, but a 128 MB derivation per call is a memory-amplification vector — `short-code.js` serialises derivations behind a module-level single-flight lock (a `let _chain = Promise.resolve(); deriveShortCodeKeys` awaits and extends `_chain`) so concurrent calls run one-at-a-time rather than N×128 MB at once. Test asserts two concurrent `deriveShortCodeKeys` calls still resolve correctly.
- **The short code and the inner invite code must NEVER be logged** — every `console.*` on these paths logs fixed strings only.
- **Kiosk guards** on BOTH new tools (`isKioskActive`/`kioskBlockedResponse`, same pattern as `crow_generate_invite` at `tools/contacts.js:44`).
- **VERBATIM-MOVE discipline** for the `acceptInviteCore` extraction (the R8 standard): the moved body must be verified identical (normalized diff) except the declared, minimal parameterization; `crow_accept_invite`'s observable behavior must not change.
- **Honest failure**: 0-relay rendezvous publish = tool `isError` (the R2 discipline); fetch-miss/expired = friendly `isError`, never a silent no-op.
- **Never throw on the receive path**: the `handleInviteAccepted` gate addition must be throw-proof (ledger errors → fail OPEN to today's behavior, log a fixed string).
- **i18n**: every new user-visible string in `servers/gateway/dashboard/shared/i18n.js`, BOTH `en` and `es`. XSS: `escapeHtml` every interpolation.
- Branch: `feat/messages-p2-short-codes` (base = this plan's commit on `main`). Spec: `docs/superpowers/specs/2026-07-03-messages-phase2-contact-add-ux-design.md` §PR2.

---

## Background — the exact code being changed (verified @ `main` f1036f96)

**Key/event plumbing (`servers/sharing/nostr.js`).** Imports `finalizeEvent`, `getPublicKey` from `nostr-tools/pure` (`:22-25`) and `nip44` from `nostr-tools/nip44` (`:28`) — use those SAME paths in the new module. `sendMessage` (`:139-…`) shows the canonical kind:4 build: `getConversationKey(this.identity.secp256k1Priv, recipientPubkey)` → `nip44.v2.encrypt` → `finalizeEvent({ kind: 4, created_at, tags: [["p", recipientPubkey]], content }, priv)` → publish loop `for (const [url, relay] of this.relays) { if (await safeRelayPublish(relay, event)) published.push(url); }` with `await this.connectRelays()` first when `this.relays.size === 0`. 66-hex compressed pubkeys are x-only-normalized by stripping the 02/03 prefix (`:146-150`). `identity.secp256k1Priv` is a 32-byte `Buffer` (`identity.js:180`) — a scrypt-output `Buffer` is the same shape. **There is NO one-shot fetch helper** — `fetchLatestByAuthor` is new (this plan, Task 3).

**Accept path (`servers/sharing/tools/contacts.js`).** `registerContactsTools` destructures `{ db, identity, syncManager, peerManager, nostrManager }` from ctx (`:33` region). `crow_accept_invite` (`:72-175`): kiosk guard → `extractInviteCode` → `parseInviteCode` → already-contact early-return → INSERT contact → `syncManager.initContact` → `peerManager.joinContact` → `nostrManager.subscribeToContact` → `computeSafetyNumber` → best-effort `invite_accepted` DM whose payload is `{ type, crowId, ed25519Pub, secp256k1Pub }` (`:135-147`) → success text. Imports already include `z`, kiosk helpers, `identity.js` fns, `upsertFullContact`, `invite-url.js` (`:8-12`); `randomUUID` is NOT yet imported.

**Invite code format (`servers/sharing/identity.js`).** `generateInviteCode(identity)` (`:287`) builds payload `{ ed25519Pub, secp256k1Pub, crowId, expires }`; `parseInviteCode` (`:309`) validates crowId-consistency + expiry + fingerprint and returns `{ crowId, ed25519Pubkey, secp256k1Pubkey }`. Both get additive `inviteId` support (Task 2).

**Inviter-side handler (`servers/sharing/boot.js`).** `handleInviteAccepted(db, managers, payload, senderPubkey)` (`:134`) — R4's authenticated promote path (gates on `normalizePubkey(payload.secp256k1Pub) === normalizePubkey(senderPubkey)`); called from the receive ladder at `:371`. The single-use gate inserts at the TOP of this function, BEFORE any promote work.

**Ledger storage precedent (`servers/sharing/contact-promote.js:13-60`).** The R4 cursor reads/writes `dashboard_settings` from the sharing layer with raw `db.execute` + `INSERT … ON CONFLICT(key) DO UPDATE`. **Multi-instance note (verified via `shouldSyncRow`/`SYNC_ALLOWLIST`, `instance-sync.js:151-152`):** `dashboard_settings` rows sync ONLY for allowlisted keys — the ledger key `sharing:shortcode_invites` is NOT in `SYNC_ALLOWLIST`, so it stays instance-local. Because the fleet shares one Nostr identity, an `invite_accepted` may land on a SIBLING instance whose ledger has never seen the `inviteId`; policy: **unknown inviteId → proceed as a normal invite** (fail-open). This is safe: replaying a captured `invite_accepted` is idempotent re-promotion of the same already-authenticated contact (R4 gate), and the single-use property is a best-effort *extra* layer on the generating instance — entropy × KDF × expiry carry the real MITM defense. Document this in the module docstring.

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
- `generateShortCode(): string` — 12 Crockford chars (no I/L/O/U), from `randomBytes(8)` with the low 4 bits dropped (60 bits = 12×5-bit symbols, zero bias).
- `formatShortCode(code): string` — `"K7Q4-M2X9-3FHT"` display grouping (4s).
- `normalizeShortCode(input): string` — uppercase, strip `[-\s]`, map `I→1 L→1 O→0`; returns `""` unless the result is exactly 12 chars of the alphabet.
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

const C1 = "K7Q4M2X93FHT"; // 12 Crockford chars
const C2 = "K7Q4M2X93FHW"; // differs in the last symbol

test("generateShortCode: 12 chars of the Crockford alphabet, no I/L/O/U", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateShortCode();
    assert.equal(c.length, 12);
    for (const ch of c) assert.ok(ALPHABET.includes(ch), `bad char ${ch}`);
  }
});

test("formatShortCode groups in 4s", () => {
  assert.equal(formatShortCode(C1), "K7Q4-M2X9-3FHT");
});

test("normalizeShortCode: case, separators, confusables", () => {
  assert.equal(normalizeShortCode(" k7q4-m2x9-3fht "), "K7Q4M2X93FHT");
  assert.equal(normalizeShortCode("k7q4 m2x9 3fht"), "K7Q4M2X93FHT");
  assert.equal(normalizeShortCode("il0o23456789"), "11002345678" + "9", "I/L→1, O→0");
  assert.equal(normalizeShortCode("K7Q4M2X93FHU"), "", "U is not in the alphabet");
  assert.equal(normalizeShortCode("K7Q4M2X93FH"), "", "too short (11)");
  assert.equal(normalizeShortCode("K7Q4M2X93FHTT"), "", "too long (13)");
  assert.equal(normalizeShortCode(null), "");
});

test("deriveShortCodeKeys: deterministic, normalization-invariant, x-only pub", async () => {
  const a = await deriveShortCodeKeys(C1, T);
  const b = await deriveShortCodeKeys(" k7q4-m2x9-3fht ", T);
  assert.equal(a.pub, b.pub, "same code (post-normalization) → same key");
  assert.equal(a.pub.length, 64, "x-only hex pubkey");
  assert.ok(Buffer.isBuffer(a.priv) && a.priv.length === 32);
  const c = await deriveShortCodeKeys(C2, T);
  assert.notEqual(a.pub, c.pub, "different code → different key");
});

test("deriveShortCodeKeys rejects invalid codes", async () => {
  await assert.rejects(() => deriveShortCodeKeys("nope", T), /invalid short code/);
});

test("rendezvous envelope round-trips and binds to the code key", async () => {
  const keys = await deriveShortCodeKeys(C1, T);
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
  const keys = await deriveShortCodeKeys(C1, T);
  const wrong = await deriveShortCodeKeys(C2, T);
  const event = buildRendezvousEvent(keys, { inviteCode: "x", expires: Date.now() + 1000 });
  assert.throws(() => parseRendezvousEvent(event, wrong));
});

test("expired envelope is rejected", async () => {
  const keys = await deriveShortCodeKeys(C1, T);
  const event = buildRendezvousEvent(keys, { inviteCode: "x", expires: Date.now() - 1 });
  assert.throws(() => parseRendezvousEvent(event, keys), /expired/);
});

test("concurrent derivations resolve correctly (single-flight lock)", async () => {
  const [a, b] = await Promise.all([
    deriveShortCodeKeys(C1, T),
    deriveShortCodeKeys(C2, T),
  ]);
  assert.equal(a.pub.length, 64);
  assert.equal(b.pub.length, 64);
  assert.notEqual(a.pub, b.pub);
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
 * A 12-char Crockford-base32 code (60 bits from crypto.randomBytes) is the
 * ONLY shared secret. Both sides derive a secp256k1 keypair from it via
 * memory-hard scrypt; the inviter publishes a kind:4 self-DM under that key
 * (kind:4 so the self-hosted relay's allowlist carries it) whose NIP-44
 * content wraps a SHORT-EXPIRY invite code. THREAT MODEL: the event is public
 * and the derived key also signs it — a cracked code within the window =
 * pairing MITM. The salt is a FIXED product constant (the code is the only
 * shared input), so the memory-hard cost is a ONE-TIME precomputation over
 * the whole code space, NOT a per-guess cost — 60 bits (not the spec's 40-bit
 * floor) is chosen so that one-time table is infeasible (~10^10 core-years,
 * ~32-exabyte) rather than merely expensive. Layered defenses: 60-bit
 * entropy x memory-hard scrypt x ~10-min expiry (envelope + short inner code
 * + ledger cutoff) x authenticated single-use x acceptor fail-closed on a
 * duplicate-event code x the safety number as the named (PR3) backstop.
 *
 * Pure module: no manager imports, no logging, never logs a code.
 */

import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

const scrypt = promisify(_scrypt);

export const SHORTCODE_EXPIRY_MS = 10 * 60 * 1000; // minutes-scale, per guardrail

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const SALT = "crow-shortcode-invite-v1"; // FIXED product constant — the code is the
  // only shared secret, so no per-invite salt is possible. This makes the KDF cost a
  // ONE-TIME precomputation over the whole code space, which is exactly why CODE_LEN is
  // 12 (60 bits), not the spec's 40-bit floor: a 2^40 table is buildable by a funded
  // adversary; a 2^60 one is not (see the plan's THREAT MODEL header).
const CODE_LEN = 12; // 12 x 5 bits = 60 bits
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** CODE_LEN symbols x 5 bits = 60 bits, drawn bias-free from 8 random bytes (64 bits). */
export function generateShortCode() {
  const bytes = randomBytes(8); // 64 random bits; we consume the top 60
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits >>= 4n; // drop the low 4 bits → exactly 60 bits, no modulo bias (32 | 2^60)
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) {
    code = ALPHABET[Number(bits & 31n)] + code; // low 5 bits → prepend → MSB-first order
    bits >>= 5n;
  }
  return code;
}

/** Display grouping in 4s: K7Q4-M2X9-3FHT. */
export function formatShortCode(code) {
  return code.match(/.{1,4}/g).join("-");
}

/**
 * Uppercase, strip separators, map Crockford confusables (I/L→1, O→0).
 * Returns "" unless the result is EXACTLY 12 alphabet chars (U stays invalid).
 */
export function normalizeShortCode(input) {
  if (typeof input !== "string") return "";
  const up = input.toUpperCase().replace(/[-\s]/g, "")
    .replace(/I/g, "1").replace(/L/g, "1").replace(/O/g, "0");
  if (up.length !== CODE_LEN) return "";
  for (const ch of up) if (!ALPHABET.includes(ch)) return "";
  return up;
}

/**
 * Derive the rendezvous keypair from the code. ASYNC scrypt only — the
 * ~128MB/~1s derivation must never block the event loop. `opts.N` exists
 * FOR TESTS ONLY (full-strength derivation in every production call).
 */
let _derivChain = Promise.resolve(); // M4: single-flight — one 128MB scrypt at a time
export async function deriveShortCodeKeys(code, opts = {}) {
  const norm = normalizeShortCode(code);
  if (!norm) throw new Error("invalid short code");
  const params = { ...SCRYPT_PARAMS, ...(opts.N ? { N: opts.N } : {}) };
  const run = _derivChain.then(async () => {
    const priv = await scrypt(norm, SALT, 32, params);
    return { priv: Buffer.from(priv), pub: getPublicKey(priv) };
  });
  // Chain regardless of this call's outcome so one failure doesn't wedge the queue.
  _derivChain = run.then(() => {}, () => {});
  return run;
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

**Implementer note on `generateShortCode`:** any straight 12×5-bit extraction of the 60 bits is correct — there is no modulo bias because 32 (the alphabet size) evenly divides 2⁶⁰. `randomBytes(8)` gives 64 bits; dropping the low 4 keeps exactly 60. Do NOT use `randomBytes(7.5)` or a modulo of a smaller value.

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
- `generateInviteCode(identity, opts = {})` — when `opts.inviteId` is a string, the payload gains `inviteId`; when `opts.expiresInMs` is a positive number, `expires = Date.now() + opts.expiresInMs` (default stays 24h); otherwise byte-identical behavior to today. `parseInviteCode` returns `inviteId` (string|undefined) alongside the existing fields and enforces `expires` exactly as today (so a short inner code is dead via ANY accept path — including plain `crow_accept_invite` — after its 10-min expiry). This closes C1: the inner code no longer outlives the short-code window.
- Ledger (all take `db`; all THROW-PROOF is the CALLER's job — these may throw on db errors):
  - `recordShortInvite(db, inviteId, codeExpiresAt): Promise<void>` — stores `{ state: "outstanding", codeExpiresAt, recordedAt }`.
  - `consumeShortInvite(db, inviteId): Promise<"consumed"|"replayed"|"unknown"|"expired">` — a stored-but-past-`codeExpiresAt` row returns `"expired"` (inviter stops honoring the code after its 10-min window — C1 fix (b)); outstanding-and-fresh→consumed returns `"consumed"`; already-consumed returns `"replayed"`; missing returns `"unknown"`. Prunes entries older than `LEDGER_TTL_MS` on every call.
  - `LEDGER_TTL_MS = 72 * 60 * 60 * 1000` — **deliberately much longer than the 10-min code expiry**: PR3 will retry `invite_accepted` for up to ~60h (inviter offline), and a legit late echo must still find its ledger row. The 10-min window gates the CODE (envelope `expires`, acceptor-side); the ledger's job is replay discrimination for as long as an echo can legitimately arrive.
- Gate policy in `handleInviteAccepted`, placed **AFTER the existing authentication check** (`normalizePubkey(payload.secp256k1Pub) === normalizePubkey(senderPubkey)`, `boot.js:140`) so only an authenticated sender can consume the token (I2 fix — a code-cracker who forges an unauthenticated `invite_accepted` cannot burn the single-use token; "first AUTHENTICATED wins" per spec §PR2.4). Before any contact-promotion side effects:
  - `payload.inviteId` absent → proceed (normal invite, today's behavior).
  - `"consumed"` → proceed.
  - `"replayed"` → log fixed string `[sharing] short-code invite replay rejected`, RETURN (no promote). **I4 note for the PR3 implementer:** PR3 adds a `handshake_complete` ack the acceptor retries on until received. That ack MUST be emitted for the `"replayed"` verdict too (idempotent, before this RETURN or on a separate path) — otherwise a lost first-ack makes the acceptor retry for ~60h against a row that now only ever returns `"replayed"`. This plan leaves the ack unbuilt (PR3 scope) but the retained 72h TTL exists precisely to keep the row available for that ack.
  - `"expired"` → log fixed string `[sharing] short-code invite expired`, RETURN (no promote — the 10-min window closed; C1(b)).
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

test("a past-codeExpiresAt row returns 'expired', not 'consumed'", async () => {
  const db = makeDb();
  await recordShortInvite(db, "stale", Date.now() - 1000); // codeExpiresAt already past
  assert.equal(await consumeShortInvite(db, "stale"), "expired");
});

// I2 ordering property (finding 9b): the ledger is consumed only AFTER the R4
// auth check, so an UNAUTHENTICATED invite_accepted that carries a valid
// inviteId must NOT burn the token. This is verified at the handleInviteAccepted
// level in tests/invite-accepted-promote.test.js (see Task 2 Step 6): add a case
// there where payload.inviteId is set but normalizePubkey(payload.secp) !=
// normalizePubkey(senderPubkey) — assert the contact is NOT promoted AND (drive
// a real ledger stub) the inviteId row remains 'outstanding' (consume NOT called
// before the auth bail). Keep the ledger-unit cases above for record/consume/
// expire/replay/prune semantics.

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

test("generateInviteCode: additive inviteId + expiresInMs round-trip", async () => {
  // Identity fixture pattern from tests/crow-messages-editor.test.js:18-19 —
  // DATA_DIR is resolved at module load, so set CROW_DATA_DIR then dynamic-import.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-id-"));
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  const id = loadOrCreateIdentity();

  // legacy: no opts → no inviteId, ~24h expiry
  assert.equal(parseInviteCode(generateInviteCode(id)).inviteId, undefined);

  // inviteId echoes through
  assert.equal(parseInviteCode(generateInviteCode(id, { inviteId: "n-1" })).inviteId, "n-1");

  // short expiry: a 10-min inner code is accepted now but its expires is <1h out
  const short = generateInviteCode(id, { inviteId: "n-2", expiresInMs: 10 * 60 * 1000 });
  const parsed = parseInviteCode(short);
  assert.equal(parsed.inviteId, "n-2");
  // The short inner-invite expiry is ~10 min out, not 24h.
  assert.ok(parsed.inviteId === "n-2");
  const ttl = JSON.parse(Buffer.from(short.split(".")[1], "base64url")).expires - Date.now();
  assert.ok(ttl > 8 * 60 * 1000 && ttl <= 10 * 60 * 1000, "inner code expires in ~10 min");
  // parseInviteCode enforces expiry; a 1ms window elapses to already-expired.
  const brief = generateInviteCode(id, { expiresInMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.throws(() => parseInviteCode(brief), /expire/i);
});
```

**Implementer note:** the identity-fixture pattern above (`CROW_DATA_DIR` env → dynamic import → `loadOrCreateIdentity`) mirrors `tests/crow-messages-editor.test.js:18-19`; `DATA_DIR` in `identity.js` is module-level (resolved at load), so the env MUST be set before the dynamic import. Set it once at the top of this test file if other cases also need an identity. Do not attempt to import `deriveIdentity` (not exported).

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
  // C1(b): the inviter stops honoring a short code after its 10-min window,
  // even though the ledger row is retained (72h TTL) for replay discrimination.
  if (typeof entry.codeExpiresAt === "number" && now > entry.codeExpiresAt) {
    await saveLedger(db, ledger);
    return "expired";
  }
  entry.state = "consumed";
  await saveLedger(db, ledger);
  return "consumed";
}
```

- [ ] **Step 4: Additive `inviteId` in `identity.js`**

In `generateInviteCode` (`identity.js:287`), change the signature to `generateInviteCode(identity, opts = {})`. Replace the hardcoded `const expires = Date.now() + 24 * 60 * 60 * 1000;` with a defaulted, overridable window, and add the optional `inviteId`:

```js
  const ttlMs = (typeof opts.expiresInMs === "number" && opts.expiresInMs > 0)
    ? opts.expiresInMs
    : 24 * 60 * 60 * 1000; // default 24h (unchanged for plain invites)
  const expires = Date.now() + ttlMs;
  const payloadObj = {
    ed25519Pub: identity.ed25519Pubkey,
    secp256k1Pub: identity.secp256k1Pubkey,
    crowId: identity.crowId,
    expires,
  };
  if (opts.inviteId) payloadObj.inviteId = String(opts.inviteId);
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
```

(The existing `expires` line and its use in the HMAC/return are replaced by the above; verify nothing else in the function references a now-removed `const expires`.)

In `parseInviteCode` (`:309`), add `inviteId: data.inviteId` to the returned object (undefined when absent — additive, no behavior change for legacy codes).

- [ ] **Step 5: The gate in `boot.js`**

Read `handleInviteAccepted` (`boot.js:134`) and find the existing authentication check — the line that compares `normalizePubkey(payload.secp256k1Pub)` (or the equivalent claimed secp field) against `normalizePubkey(senderPubkey)` and bails on mismatch (R4's forgery gate, ~`boot.js:140`). Place the single-use gate **immediately AFTER that auth check passes**, still before any `upsertFullContact`/promote side effects:

```js
  // P2/C2 single-use gate (runs ONLY after the R4 auth check above, so an
  // unauthenticated forged invite_accepted cannot burn the token — "first
  // AUTHENTICATED wins", spec §PR2.4). A short-code acceptance echoes the
  // inviteId; the first authenticated echo consumes it. Fail OPEN on unknown
  // (instance-local ledger; sibling instances legitimately miss it) and on
  // ledger errors (never let the ledger break honest pairing).
  if (payload && typeof payload.inviteId === "string" && payload.inviteId) {
    try {
      const { consumeShortInvite } = await import("./shortcode-ledger.js");
      const verdict = await consumeShortInvite(db, payload.inviteId);
      if (verdict === "replayed") {
        // I4: PR3's handshake_complete ack must still fire for this verdict
        // (idempotent) — the retained 72h ledger TTL keeps the row available.
        console.warn("[sharing] short-code invite replay rejected");
        return;
      }
      if (verdict === "expired") {
        console.warn("[sharing] short-code invite expired");
        return;
      }
    } catch {
      console.warn("[sharing] short-code ledger check failed — proceeding");
    }
  }
```

**VERIFY before writing:** confirm the auth check is present and that no promote/DB-write side effect runs between it and where you insert this gate. If the current `handleInviteAccepted` structure interleaves auth and promotion such that no clean "after auth, before promote" point exists, STOP and report — do not place the gate before auth.

- [ ] **Step 6: Run the tests**

ADD to `tests/invite-accepted-promote.test.js` a case proving I2's ordering: a payload with a valid `inviteId` BUT a forged secp (`normalizePubkey(payload.secp) != normalizePubkey(senderPubkey)`) must bail at the auth check with NO promote AND without consuming the ledger (inject a ledger stub whose `consumeShortInvite` sets a flag; assert the flag is false — the gate runs only after auth passes). Then run:

Run: `node --test tests/shortcode-ledger.test.js tests/invite-accepted-promote.test.js tests/contact-promote.test.js`
Expected: ALL PASS (the existing R4 cases carry no `inviteId`, so the gate is a no-op for them; the new negative case proves consume-after-auth).

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
- `NostrManager.fetchRendezvousByAuthor(authorHex, timeoutMs = 5000): Promise<{ events: Event[] }>` — `connectRelays()` when empty; on each connected relay, `relay.subscribe([{ kinds: [4], authors: [authorHex], limit: 4 }], { onevent, onclose })` (NOT `limit:1` — I1: a single event could be the attacker's; we must SEE a competing event to fail closed); collect until **every relay has fired `oneose`** (relays send stored events then EOSE; they do NOT close the socket, so `onclose` alone never resolves this) OR the `timeoutMs` cap fires; close all subs (in `finally`); return `{ events }` deduped by `event.id`. **Wire `oneose` explicitly and wait for ALL relays (or the timeout) — NEVER early-resolve on the first relay's EOSE**, or a slightly-later competing publish (the I1 MITM signal) could be missed. Never throws on a single-relay failure (wrap each relay's subscribe in try/catch). `limit:4` bounds relay work while still surfacing a competing publish. Subscribe shape: raw `relay.subscribe([filter], { onevent, oneose })` (mirror `servers/sharing/resilient-subscribe.js:54` for the raw-relay call, but ADD `oneose` — that file wires only `onevent`/`onclose` because it is for long-lived subs; a one-shot query needs `oneose`). NOT `subscribeToContact`, which wraps `makeResilientSub`.
- `acceptInviteCore({ invite_code, display_name })` — module-level async function inside `tools/contacts.js` holding the CURRENT `crow_accept_invite` body VERBATIM (from `const peer = parseInviteCode…` through the success-return), parameterized only by the already-in-closure `db/identity/syncManager/peerManager/nostrManager`. Two declared changes ONLY: (a) the `acceptancePayload` gains `...(peer.inviteId ? { inviteId: peer.inviteId } : {})`; (b) it returns the same `{ content: [...] }` shapes it does today. `crow_accept_invite`'s handler becomes: kiosk guard → `extractInviteCode` → `try { return await acceptInviteCore(...) } catch → isError` (identical observable behavior). **M3 (accepted, documented):** the inherited already-a-contact early-return (`contacts.js:91-95`) returns without sending `invite_accepted`, so in the short-code path re-accepting a KNOWN identity never consumes the inviter's `inviteId` (it stays `outstanding` until the ledger 10-min `codeExpiresAt` cutoff / 72h TTL). Low impact (re-pairing an already-authenticated contact), and the codeExpiresAt cutoff bounds the outstanding window — leave as-is.
- Tool `crow_generate_short_invite` (no params): kiosk guard → `generateShortCode()` → `deriveShortCodeKeys(code)` (FULL-strength — no N override) → `randomUUID()` inviteId → `const expires = Date.now() + SHORTCODE_EXPIRY_MS` → `generateInviteCode(identity, { inviteId, expiresInMs: SHORTCODE_EXPIRY_MS })` (the inner code dies in 10 min via ANY accept path — C1 fix (a); WITHOUT this the inner code silently reverts to the 24h default and the acceptor-side leak window reopens) → `recordShortInvite(db, inviteId, expires)` → `buildRendezvousEvent(keys, { inviteCode, expires: Date.now() + SHORTCODE_EXPIRY_MS })` → `publishRendezvousEvent`; `published.length === 0` → `isError` "could not reach any relay — try again or use an invite link"; success text: the FORMATTED code, the expiry in minutes, "speak or type it — don't post it anywhere public", and the safety-number verification pointer. The raw short code appears ONLY in the tool result (never logged).
- Tool `crow_accept_short_invite` (`{ short_code: z.string().max(24), display_name? }`): kiosk guard → `normalizeShortCode` (empty → friendly `isError` "that doesn't look like a Crow short code") → `deriveShortCodeKeys` → `fetchRendezvousByAuthor(keys.pub)` → let `parsed = events.map(e => tryParse(e, keys)).filter(Boolean)` (each via `parseRendezvousEvent`, wrapped so an expired/tamper event is dropped not thrown). Then:
  - `parsed.length === 0` → `isError` "code not found or expired — ask for a fresh one".
  - **`new Set(parsed.map(p => p.inviteCode)).size > 1` → `isError` "this code may be compromised — ask for a fresh one and verify the safety number after connecting" (I1 FAIL-CLOSED: two DISTINCT rendezvous payloads under one code key means someone else published under the same derived key — a MITM attempt).** Log the fixed string `[sharing] short-code: multiple distinct rendezvous events — refusing`.
  - exactly one distinct payload → `acceptInviteCore({ invite_code: <that>.inviteCode, display_name })`.
  UI copy on success names the safety-number backstop (with the honest "comparison UI arrives in PR3" caveat).

- [ ] **Step 1: Write the failing test**

Create `tests/short-invite-tools.test.js` — stub-driven, no live relays (method-stub pattern from `tests/delivery-receipt-emit.test.js`; in-memory MCP client pattern from existing tool tests — grep `createSharingServer` in tests/ and reuse the lightest existing harness; if tool tests all go through the in-memory server, do that; the essential cases:)

```js
// Essential cases (exact assertion style: adapt to the harness you reuse):
// 1. generate: returns formatted XXXX-XXXX code + records ledger + publishes a
//    kind:4 event authored by a 64-hex key ≠ identity key (stub
//    publishRendezvousEvent to capture the event; assert event.pubkey !=
//    identity secp x-only pub, and assert the DISPLAYED code parses via
//    normalizeShortCode; ALSO parse the rendezvous envelope's inner invite
//    code and assert its `expires` is ~10 min out, not 24h — proves C1 fix (a)
//    is wired (finding 9a)).
// 2. generate with 0-relay publish (stub returns []) → result.isError true.
// 3. accept happy path: stub fetchRendezvousByAuthor to return { events: [<one real event>] } —
//    buildRendezvousEvent(keys, { inviteCode: <real generated invite>,
//    expires: future }); assert a contact row was inserted and the
//    invite_accepted acceptancePayload (capture via stubbed
//    nostrManager.sendMessage) carries inviteId === the generated one.
// 4. accept with garbage code → isError, no derivation attempted (fast).
// 5. accept when fetch returns { events: [] } → isError "not found or expired".
// 6. accept when envelope expired → isError.
// 6b. I1 FAIL-CLOSED: stub fetchRendezvousByAuthor to return { events: [e1, e2] }
//     where e1,e2 are two rendezvous envelopes (same code keys) wrapping
//     DIFFERENT inviteCodes → result.isError true, message mentions compromised;
//     assert NO contact row inserted.
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

- [ ] **Step 3: `nostr.js` methods** — add `publishRendezvousEvent` and `fetchRendezvousByAuthor` as specified in Interfaces, placed near `sendMessage`. Reuse `safeRelayPublish` (already imported) for publish. For the fetch, use the RAW `relay.subscribe([filter], { onevent, onclose })` shape from `servers/sharing/resilient-subscribe.js:54` (NOT `subscribeToContact`, which wraps `makeResilientSub` and is for long-lived subs); resolve when all relays have fired `oneose` (wire `oneose` explicitly — sockets don't close after stored events) or an unref'd `setTimeout(timeoutMs)` fires; `finally` close every sub; dedupe collected events by `event.id`. Never throw on a single-relay error (wrap each relay's subscribe in try/catch).

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
- `renderShortCodeShare({ formattedCode, expiresAt }, lang): string` — the inviter's result block: the code BIG (monospace, letter-spaced), "expires at HH:MM (~10 minutes)" (server-rendered time, no live countdown — keep it dependency-free), the speak-don't-post warning, and the safety-number pointer (`invite.verifyLater`, existing key). **M5 (conscious spec deviation):** spec §PR2.5 mentions a live countdown + regenerate button; both are dropped here for simplicity (static server-rendered expiry time; regenerate = just click generate again). Acceptable — the expiry is enforced server-side regardless of the display.
- `renderShortCodeForms({ lang, csrf = "" }): { generateForm, acceptForm }` — generate: hidden action `generate_short_invite` + button; accept: `<input name="short_code" maxlength="20">` (accepts hyphens/spaces; server normalizes) + hidden action `accept_short_invite` + button.
- Panel actions (both panels, mirroring PR1's generate/accept action shapes exactly):
  - `generate_short_invite` → call `crow_generate_short_invite`; messages: `req._shortCodeResult = text` / `req._inviteError`, return false; contacts: return `{ shortCodeResult: text }` / `{ inviteError }`.
  - `accept_short_invite` → call `crow_accept_short_invite` with `req.body.short_code`; error → same error surfaces as PR1's accept; success → redirect (same as accept_invite).
- Result parsing: `parseShortCodeResult(text): { formattedCode, expiresAt }|null` (in `peer-invite-ui.js`) — extracts the `XXXX-XXXX-XXXX` token (regex `/\b[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}\b/` — THREE groups for the 12-char code; a two-group pattern would truncate the code to 8 chars and make the acceptor's `normalizeShortCode` reject it, breaking the happy path) and computes `expiresAt = Date.now() + 10*60*1000` at render time (display-only).
- New i18n keys (EN+ES, exact copy in the implementing step): `invite.shortCodeTitle`, `invite.shortCodeGenerateBtn`, `invite.shortCodeHint` ("Read it aloud or type it — anyone who hears it can use it until it expires."), `invite.shortCodeExpiry` ("Expires in about 10 minutes"), `invite.shortCodeAcceptPlaceholder` ("Enter the 12-character code…"), `invite.shortCodeAcceptBtn`, `invite.shortCodeToggle` ("Use a short code instead").
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

- Code format 12-char Crockford/60-bit → Task 1 (bias-free 8-byte→top-60-bit extraction; entropy raised above the spec's 40-bit floor to defeat fixed-salt precomputation — operator-decided). KDF scrypt N=2¹⁷ r=8 async + maxmem + single-flight DoS cap → Tasks 1/3 (full-strength in tools; test-only N override documented). Rendezvous kind:4 self-DM under code key → Task 1 (relay-allowlist constraint honored). Expiry ~10 min enforced THREE ways → envelope `expires` (acceptor, Task 1) + SHORT inner-invite `expiresInMs` so the inner code dies on any accept path (Task 2, C1 fix) + ledger `codeExpiresAt` cutoff (inviter, Task 2, C1(b)). Single-use via additive `inviteId` echoed in `invite_accepted`, consumed AFTER the R4 auth check → Task 2 (I2; + fail-open multi-instance honesty + I4 PR3-ack note). Acceptor FAIL-CLOSED on two distinct rendezvous events under one code key → Task 3 (I1). UX: big code + expiry + normalization-forgiving input + safety-number backstop named (with the honest PR3-arrives caveat) → Task 4. Downstream of rendezvous = the existing accept path → Task 3's VERBATIM `acceptInviteCore`. Threat model (incl. the fixed-salt precompute reasoning) documented in module docstring + plan header → Task 1.
- Type consistency: `deriveShortCodeKeys → { priv: Buffer, pub: string }` consumed by `buildRendezvousEvent(keys, …)`/`parseRendezvousEvent(event, keys)`/`fetchLatestByAuthor(keys.pub)` uniformly; ledger verdict strings `"consumed"|"replayed"|"unknown"` matched in the boot.js gate; `inviteId` flows generate→parse→acceptancePayload→handleInviteAccepted with the same field name throughout.
- Placeholder scan: Task 3 Step 1 and Task 4 give assertion-level skeletons rather than full listings — deliberate (they adapt to existing harness patterns the implementer must read first), with every required case enumerated concretely. No TBDs.

## Review

**Round 1 (2026-07-03, adversarial security subagent, opus): REVISE — 1 CRITICAL + 4 IMPORTANT + 6 MINOR, all addressed.**
- **C1 (inner code lived 24h, inviter never enforced the minutes-expiry guardrail — 144× window blowout, direct spec violation):** `generateInviteCode` gains `opts.expiresInMs`; the short flow mints a 10-min inner code (dead via ANY accept path incl. plain `crow_accept_invite`), AND `consumeShortInvite` returns `"expired"` past `codeExpiresAt` so the inviter stops honoring the code. Enforced three ways now.
- **I1 (newest-wins `limit:1` fetch = undetectable pairing MITM):** `fetchRendezvousByAuthor` fetches `limit:4` and the accept tool FAILS CLOSED ("code may be compromised") when ≥2 distinct rendezvous payloads appear under one code key.
- **I2 (consume-before-auth let an unauthenticated forgery burn the token):** the single-use gate now runs AFTER the R4 `senderPubkey` auth check — "first AUTHENTICATED wins" per spec §PR2.4.
- **I3 (fixed-salt precomputation breaks the "memory-hardness defeats brute-force" claim — 2⁴⁰ table ~9 TB, buildable):** code raised to **12 chars / 60 bits** (operator-decided over 8/40 and 10/50); threat-model header + module docstring rewritten with the correct one-time-precompute reasoning (memory-hardness sizes the table, entropy makes it infeasible).
- **I4 (the "replayed → return" gate silently drops the PR3 retries its own 72h TTL exists for):** documented as a hard constraint for the PR3 implementer (emit `handshake_complete` on the `"replayed"` verdict too, idempotent).
- Minors: M1 import paths → `nostr-tools/pure` + `/nip44`; M2 subscribe-shape pointer → `resilient-subscribe.js:54` (`{onevent,onclose}`), not `subscribeToContact`; M3 already-a-contact-skips-consume documented (bounded by codeExpiresAt); M4 scrypt single-flight lock + test; M5 live-countdown/regenerate spec-drift noted as conscious; M6 Task-2 identity fixture pinned to the `crow-messages-editor.test.js` pattern + instance-sync citation corrected.

**Round 2 (2026-07-03, fresh adversarial security subagent, opus): REVISE → all fixed.**
- **[CRITICAL] `parseShortCodeResult` regex was a stale 2-group (8-char) pattern** → truncated the 12-char code to 8, making every UI happy-path pairing impossible. Fixed to the 3-group pattern; UI round-trip test mandated.
- **[IMPORTANT] Task 3 minted the inner invite WITHOUT `expiresInMs`** → silently reverted to the 24h default, un-doing C1(a). Fixed: `generateInviteCode(identity, { inviteId, expiresInMs: SHORTCODE_EXPIRY_MS })`; a test now asserts the minted inner code expires in ~10 min (finding 9a).
- **[IMPORTANT] the `expiresInMs: -1` test was inert** (the `>0` guard clamps it to 24h, so `parseInviteCode` never threw) → replaced with a real 1ms-window elapse.
- **[IMPORTANT] the "expiry enforced THREE ways / inviter stops honoring" claim was overstated** → rewritten honestly: envelope+inner-code bound the ACCEPTOR side; the ledger bounds the `inviteId`-echoed path; a code-knower forging a fresh `invite_accepted` with `inviteId` OMITTED is bounded only by entropy×KDF + the safety number (the acknowledged threat-model backstop). An I2-ordering negative test (finding 9b) proves an unauthenticated `invite_accepted` carrying an inviteId does NOT consume the token.
- Minors: 8→12 propagated to Task-1 interface prose, the module docstring, and the user-facing i18n placeholder ("Enter the 12-character code"); `short-code.js` import → `nostr-tools/pure`; precompute figure corrected to ~10¹⁰–10¹¹ core-years / ~32 EB (conclusion unchanged); `fetchRendezvousByAuthor` wires `oneose` explicitly and waits for ALL relays (or timeout) — never first-EOSE (or a late competing publish could slip past I1).
Round-2 confirmed correct (unchanged): 32-symbol alphabet with no I/L/O/U (60 bits, no collision loss); bias-free bit extraction; C1 HMAC coherence; I2 clean after-auth insertion point (`boot.js:140` auth return, `:141` first side effect); I1 "distinct inviteCode payloads" is the right fail-closed trigger; no PR1 anchor drift at `3a36c256`.

**Both rounds resolved. Plan APPROVED for execution.**

## Execution & Final Security Review (2026-07-03)

Executed via subagent-driven development on `feat/messages-p2-short-codes` (base `91d1fcdf`), fresh sonnet implementer + sonnet reviewer per task:
- Task 1 `83c7b682` — short-code.js (12-char/60-bit Crockford, async scrypt + single-flight, NIP-44 rendezvous). Review SPEC ✅ Approved zero findings; crypto independently verified (32-sym alphabet, bias-free extraction, async-only, lock). 9/9.
- Task 2 `4f8d2302` + fix `fcf7c634` — shortcode-ledger.js + inviteId/expiresInMs + consume-after-auth gate. Review caught a **CRITICAL remote prototype-pollution** (attacker `inviteId` as object key, empirically reproduced) → FIXED (null-proto ledger + `__proto__`/`constructor`/`prototype` reject-set + hasOwnProperty + identity typeof guard + 2 regression tests); controller directly re-verified + reviewer re-review **Approved** (both ⚠️ resolved). Gate-after-auth verified structurally + by I2 negative test. 19/19.
- Task 3 `2695f20a` — acceptInviteCore VERBATIM extract (independently re-diffed: only delta = inviteId spread) + publishRendezvousEvent/fetchRendezvousByAuthor (wait-all-EOSE, never first) + 2 tools + I1 fail-closed. randomUUID inviteId + expiresInMs wired. Review Approved zero crit/imp. 8/8 + 42/42 neighbors.
- Task 4 `9db4814e` — short-code UI both panels (progressive-disclosure `<details>`). 3-group regex test-guarded (round-2 CRITICAL not regressed); i18n "12-character" EN+ES. Review Approved 0/0/0. 16/16 + 82/82 regression.
- Polish `7cebd5ff` — I1 comment clarified (tripwire not flood-proof) per final review.

Controller verification: **full suite 1052/1052**; isolated gateway boot clean (4 relays, both subscribe lines); NO schema change (user_version stays 3).

**FINAL SECURITY REVIEW (opus, 91d1fcdf..9db4814e): READY TO MERGE — Yes. 0 Critical / 0 Important / 3 Minor** (all within the conceded cracked-code threat model: I1 flood-evadable tripwire; consume-before-promote token-strand on promote-throw; ledger load-check-save TOCTOU — none escalate beyond "code already cracked → safety-number backstop"). Independently re-audited: crypto math (60-bit bias-free, async-only memory-hard scrypt, non-wedging lock, NIP-44 MAC carries confidentiality/integrity vs relay+observer); consume strictly after R4 auth + before promote; proto-pollution closed both layers; expiry enforced on EVERY accept path; verbatim acceptInviteCore behavior-preserving; L6/R4/R5 trust boundaries intact; no schema change; log hygiene clean; kiosk on both tools.

PR2 follow-ups (non-blocking, all conceded-threat-model): I1 flood evasion (safety-number backstop covers it); consume-before-promote strand (recoverable via add-by-id); ledger TOCTOU (single-use is best-effort by design). PR3 hard requirement carried: emit `handshake_complete` ack on the ledger `"replayed"` verdict too (idempotent) so a lost first-ack doesn't strand the acceptor's ~60h retry.
