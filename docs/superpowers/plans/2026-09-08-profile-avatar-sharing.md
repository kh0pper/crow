# Profile Avatar to Contacts + the Bird as Picture (Plan B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Crow profile picture that actually reaches contacts: an inline `data:` image (shrunk to 128 px in the Contacts panel), or the active Ramble bird rendered server-side, carried in the pairing handshake both ways and re-sent to every full contact as a `crow_social` `profile` message whenever the profile changes; receivers keep it in their own `peer_*` contact columns, never over a name or picture the user typed; contact names and pictures fall back to the peer's own; Ramble shows a contact's picture on their pin; the contacts guide stops pointing at Settings → Identity.

**Architecture:** Three pure core helpers (`avatar.js` validator, `contact-display.js` name/picture rule, `peer-profile.js` envelope + apply + receiver + broadcast) plus one bird module (`profile-avatar.js`: raw-SQL read of the active bird, guarded load of the bundle's EXISTING `bird-svg.cjs` exports, SVG data URI, refresh hook on the in-process bus). Two additive contacts columns (`peer_display_name`, `peer_avatar`) via `addColumnIfMissing` for fresh installs AND `ensureColumn` at sharing init for existing hosts — no `SCHEMA_GENERATION` bump. The handshake (`invite_accepted` / `handshake_complete`) gains `avatar`; the broad incoming subscription's `crow_social` dispatcher gains a `profile` branch (the per-contact subscription drops every `crow_social`, so that is the only door). The Contacts panel's My profile form becomes a file input + canvas + hidden data-URI field with a picture/bird source. Ramble's `contactsByPubkey` mirrors the display rule and adds `contact_avatar`; the popup shows it via an `<img>` created with `createElement`.

**Tech Stack:** Node 22 ESM, libsql client, `nostr-tools` NIP-44 DMs, Express, plain-script panel clients (no backticks), Node test runner via `scripts/run-suite.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-ramble-names-and-profile-design.md` §0 D4–D7, §1, §4, §5, §6 (Plan-B rows), §7, §8 (Plan B). Plan A's rulings still bind (`docs/superpowers/plans/2026-09-08-ramble-world-name.md` Global Constraints + Review, esp. R1-1).

## Global Constraints

- **Base:** `main` @6e8965f3 (PR #324 merge). Worktree `/home/kh0pp/crow-wt-profile`, branch `feat/profile-avatar-sharing`, `node_modules` symlinked from `~/crow`; never `git checkout` in `~/crow`.
- **Avatar rule (spec §1, §4.1, exact):** `AVATAR_MAX_BYTES = 32768` (characters of the stored string). `AVATAR_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/`. `validateAvatar(v)` → `v` when it is a string of length ≤ cap matching the regex, else `null`. Every ingress (handshake both ways, profile message, sync apply, profile save, local profile read) runs it. Rendered ONLY through `<img src>` (never inline SVG); the client accepts only strings starting with `data:image/`.
- **Columns (spec §4.4):** `contacts.peer_display_name TEXT`, `contacts.peer_avatar TEXT`. `addColumnIfMissing` in `scripts/init-db.js` (fresh installs, manual runs) AND `ensurePeerProfileColumns(db)` (two guarded `ensureColumn`s) in `initSharingRuntime` — the `shared_items.mode` precedent, because init-db re-runs only on a generation bump and this plan makes none. `EXCLUDED_COLUMNS.contacts` unchanged (`["verified","last_seen","id","created_at","origin"]`). The migration dry-run (`scripts/schema-migration-dryrun.sh`) must report exactly `+ contacts.peer_display_name (TEXT)` and `+ contacts.peer_avatar (TEXT)` per DB, `user_version 9 -> 9`, no row-count deltas.
- **Peer vs local (D5, exact):** a peer's name/picture is written ONLY to `peer_display_name` / `peer_avatar`. `display_name` keeps today's handshake behaviour (written only over a placeholder — `null`, `""`, `crow:…`, `req:…` — by `upsertFullContact` / `handleHandshakeComplete`); a profile message never touches `display_name` or `avatar_url`. `applyPeerProfile` semantics: a field that is `undefined` is left alone (the handshake may omit either); a string is sanitized/validated; `null` or a rejected value clears.
- **Display rule (spec §4.5 + the placeholder rule):** `contactName(row, { fallback })` = `display_name` unless it is a placeholder → `peer_display_name` → `fallback` (default `row.crow_id`) → `null`. `contactAvatar(row)` = the first of `avatar_url`, `peer_avatar` that `validateAvatar` accepts, else `null` (a legacy `https:` avatar_url cannot render under the dashboard CSP anyway). Scope of the rule in THIS plan: the Contacts panel (list, profile header, delete interstitial, group members, My profile preview), the Messages conversation list (`getUnifiedList` peer rows), `crow_list_contacts`, and Ramble's `contactsByPubkey` (mirrored inline — a bundle server file cannot import core statically). Other `display_name || crow_id` sites (notification titles, room/bot admin text, share inbox) are out of scope and listed as a follow-up.
- **Envelope (spec §4.3, normalized to the dispatcher's shape):** `{ "type": "crow_social", "version": 1, "subtype": "profile", "payload": { "v": 1, "display_name": <string|null>, "avatar": <data URI|null> } }` — `subscribeToIncoming` hands `payload.payload` to `onSocialMessage(subtype, payload, senderPubkey)`; the spec's flat `{ subtype, v, display_name, avatar }` is that inner payload. `PROFILE_SUBTYPE = "profile"`.
- **Receiver rule:** resolve `senderPubkey` with `findContactByPubkey`; apply ONLY when the row is FULL (`request_status` null/undefined) and unblocked; a stranger, a `req:` pending row and a blocked contact are dropped silently. Never throws (receive path).
- **Broadcast rule:** at most ONE `broadcastProfile` per profile save (the handler compares `getMyProfile` before/after on `display_name`, `avatar_url`, `avatar_source`), plus one per bird refresh that actually changed the stored picture. Recipients: rows with `request_status` null, `is_blocked = 0`, `is_bot` falsy, `origin !== "local-bot"`, `contact_type !== "manual"`, `secp256k1_pubkey` matching `/^[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})?$/` — filtered in JS over `SELECT *` (tolerant of a db missing `is_bot`/`origin`). Each `sendControl` guarded; best effort, no retry queue.
- **Settings:** new global key `profile_avatar_source` ∈ `picture` | `bird` (default `picture`), added to `SYNC_ALLOWLIST` and `PROFILE_SYNC_KEYS` (now four). `profile_avatar_url` keeps its key and now holds a `data:` URI. Writes go through `upsertSetting` + `deleteLocalSetting` (Cluster B D2), reads are global-direct (D6).
- **Bird (spec §5):** core reads the active bird by raw SQL (`ramble_pet.active_egg_id` → `ramble_eggs` hatched row; any error → no bird) and loads the engine from the installed copy `$CROW_HOME/bundles/ramble/server/bird-svg.cjs` (default `~/.crow`) then the repo `bundles/ramble/server/bird-svg.cjs`, using ONLY `rollGenome` and `drawBird` (exports since 0.2.0 — no NEW bundle export, R1-1; `typeof` guarded). Portrait = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` + `drawBird(rollGenome(seed, species), "happy")` + `</svg>` → `data:image/svg+xml;base64,…` (≈ 3–4 KB). Refresh triggers: the in-process bus events `ramble:hatched` (existing, poked by the panel routes and the transport) and `ramble:bird-activated` (new poke in `POST /api/ramble/birds/:id/activate`). A hatch inside the stdio Ramble MCP process does not refresh (no bus across processes) — the next gateway-side hatch/activation/save does; documented in the plan's Q list. No bird / no engine while the source is `bird` → the source falls back to `picture`, the stored picture stays.
- **Panel rules:** Contacts `client.js` inner script: ZERO backticks, ZERO `${`, `textContent` only, no `innerHTML`/`insertAdjacentHTML`/`outerHTML`, a `src` assignment is not a markup sink. `bundles/ramble/panel/static/ramble.js`: ZERO backticks, EXACTLY two engine markup sinks (unchanged), no emoji. Every form input bounded (`avatar` ≤ cap, `avatar_source` enum, `avatar_clear` = `"1"`). Direction C tokens only in ramble.css.
- **i18n:** every new key has `en` and `es`, and `es !== en` (`tests/i18n-global-parity.test.js`).
- **Docs:** paragraph edits only — no new headings in `docs/guide/contacts.md`, `docs/es/guide/contacts.md`, `docs/guide/ramble.md`, `docs/es/guide/ramble.md` (the Ramble pair is heading-parity gated; this plan adds the same gate for the contacts pair).
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`; `node scripts/run-suite.mjs tests/<file>.test.js` in the foreground only; never bare `node --test`; never boot a gateway or MCP server from the worktree without a scratch `CROW_DATA_DIR`. Implementers write `\u` escapes for any invisible character, never raw bytes.
- **Commits:** subject-only, positional paths, `git add` new files first, NO attribution trailers.
- **Bundle bump:** `bundles/ramble/manifest.json` AND `package.json` `0.7.0` → `0.8.0`; `npm run build-registry`.
- **Ship rail:** run the migration dry-run from the branch BEFORE the PR (Task 1 Step 6). PR against `main`; check-runs `suite`/`static-checks`/`audit` green on the head sha via the public API (python poll; GitHub MCP tools for PR/merge). Read `/home/kh0pp/CROW-SCHEDULE.md` before the deploy. Restart `crow-gateway.service`, `crow-r4-gateway.service`, then grackle's `crow-gateway` after `git pull --ff-only origin main` in `~/crow` there (sudo password in `~/.claude/CLAUDE.md`); grackle's journal must show `refreshed ramble 0.7.0 -> 0.8.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered`. Crow primary logs: `sudo grep -a` on `/var/log/crow-inference/gateway.log`. Then `PRAGMA table_info(contacts)` (read-only) on each live db shows `peer_display_name`, `peer_avatar`.

---

## File structure

**Create**
- `servers/sharing/avatar.js` — `AVATAR_MAX_BYTES`, `AVATAR_RE`, `validateAvatar(value)`. Zero-import.
- `servers/sharing/contact-display.js` — `isPlaceholderName(name)` (mirror of contact-promote's), `contactName(row, { fallback })`, `contactAvatar(row)`. Imports only `avatar.js`.
- `servers/sharing/peer-profile.js` — `PROFILE_SUBTYPE`, `ensurePeerProfileColumns(db)`, `readLocalProfile(db)`, `buildProfileMessage({ displayName, avatar })`, `applyPeerProfile(db, contactId, { displayName, avatar })`, `handleProfileMessage(db, payload, senderPubkey)`, `profileRecipients(db)`, `broadcastProfile(db, nostrManager)`.
- `servers/sharing/profile-avatar.js` — `birdEngineCandidates()`, `loadBirdEngine({ candidates, fresh })`, `readActiveBird(db)`, `renderBirdAvatar(bird, engine)`, `renderActiveBirdAvatar(db)`, `refreshBirdAvatar(db, managers)`, `installBirdAvatarHooks(managers, { emitter })`, `__resetBirdAvatarHooksForTest()`.
- Tests: `tests/avatar-validate.test.js`, `tests/contact-display.test.js`, `tests/contacts-peer-columns.test.js`, `tests/peer-profile.test.js`, `tests/contacts-peer-wire.test.js`, `tests/profile-avatar-bird.test.js`, `tests/profile-avatar-form.test.js`, `tests/contacts-peer-display.test.js`.

**Modify**
- `scripts/init-db.js` — the two `addColumnIfMissing` lines after `contacts.verified`.
- `servers/sharing/boot.js` — `ensurePeerProfileColumns` + `installBirdAvatarHooks` in `initSharingRuntime`; `ackHandshake` sends name + avatar; `handleInviteAccepted` / `handleHandshakeComplete` write the peer fields; the `profile` dispatch branch; `readLocalDisplayName` replaced by `readLocalProfile`.
- `servers/sharing/retry-queue.js` — `buildHandshakeComplete(eventIds, displayName, avatar)`.
- `servers/sharing/tools/contacts.js` — `acceptInviteCore` payload gains `avatar`; `crow_list_contacts` uses `contactName`.
- `servers/sharing/instance-sync.js` — `_applyContact` sanitizes `peer_display_name`, validates `peer_avatar`.
- `servers/gateway/dashboard/settings/sync-allowlist.js` — `profile_avatar_source`.
- `servers/gateway/dashboard/panels/contacts/{data-queries,api-handlers,html,client,css}.js`, `servers/gateway/dashboard/panels/contacts.js`, `servers/gateway/dashboard/shared/i18n.js`, `servers/gateway/dashboard/panels/messages/data-queries.js`.
- `bundles/ramble/server/delivery.js` (`contactsByPubkey` → `{ crow_id, name, avatar }`), `bundles/ramble/panel/routes.js` (`contact_avatar`; `ramble:bird-activated` poke), `bundles/ramble/panel/static/ramble.js` (`contactPortrait`), `bundles/ramble/panel/static/ramble.css`, `bundles/ramble/panel/ramble.js` (sheet copy), `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- Docs: `docs/guide/contacts.md`, `docs/es/guide/contacts.md`, `docs/guide/ramble.md`, `docs/es/guide/ramble.md`.
- Tests touched: `handshake-display-name`, `contacts-sync`, `profile-sync-allowlist`, `ramble-delivery`, `ramble-panel`.

---

## Task 1: `validateAvatar`, the display rule, the two contacts columns, the migration dry-run

**Files:**
- Create: `servers/sharing/avatar.js`, `servers/sharing/contact-display.js`, `tests/avatar-validate.test.js`, `tests/contact-display.test.js`, `tests/contacts-peer-columns.test.js`
- Modify: `scripts/init-db.js` (after the `contacts.verified` line, ~1854)

**Interfaces:**
- Produces: `AVATAR_MAX_BYTES = 32768`; `AVATAR_RE`; `validateAvatar(value) → string | null`; `isPlaceholderName(name) → boolean`; `contactName(row, { fallback } = {}) → string | null`; `contactAvatar(row) → string | null`; columns `contacts.peer_display_name TEXT`, `contacts.peer_avatar TEXT` on a fresh init-db.

- [ ] **Step 1: Failing tests**

Create `tests/avatar-validate.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAvatar, AVATAR_MAX_BYTES, AVATAR_RE } from "../servers/sharing/avatar.js";

const PREFIX = "data:image/png;base64,";

test("validateAvatar: typed base64 data URIs under the cap pass unchanged; everything else is null", () => {
  const png = PREFIX + "A".repeat(100);
  assert.equal(validateAvatar(png), png);
  assert.equal(validateAvatar("data:image/jpeg;base64,/9j/4AAQ=="), "data:image/jpeg;base64,/9j/4AAQ==");
  assert.equal(validateAvatar("data:image/webp;base64,UklGRg=="), "data:image/webp;base64,UklGRg==");
  assert.equal(validateAvatar("data:image/svg+xml;base64,PHN2Zz4="), "data:image/svg+xml;base64,PHN2Zz4=");
  assert.equal(validateAvatar("https://example.com/a.png"), null, "a URL is not an avatar");
  assert.equal(validateAvatar("data:image/gif;base64,R0lGOD"), null, "gif is not in the type list");
  assert.equal(validateAvatar("data:text/html;base64,PHNjcmlwdD4="), null, "only image types");
  assert.equal(validateAvatar("data:image/png;base64,<script>"), null, "not base64");
  assert.equal(validateAvatar("data:image/png,rawpng"), null, "the base64 marker is required");
  assert.equal(validateAvatar("DATA:image/png;base64,AAAA"), null, "case-exact scheme");
  assert.equal(validateAvatar(PREFIX + "AAAA\n"), null, "no trailing newline");
  assert.equal(validateAvatar(""), null);
  assert.equal(validateAvatar(null), null);
  assert.equal(validateAvatar(undefined), null);
  assert.equal(validateAvatar(42), null);
  assert.equal(validateAvatar({ toString: () => png }), null, "strings only");
});

test("validateAvatar: the cap is inclusive and counts the whole string", () => {
  const atCap = PREFIX + "A".repeat(AVATAR_MAX_BYTES - PREFIX.length);
  assert.equal(atCap.length, AVATAR_MAX_BYTES);
  assert.equal(validateAvatar(atCap), atCap, "exactly the cap passes");
  assert.equal(validateAvatar(atCap + "A"), null, "one over the cap is rejected");
  assert.equal(AVATAR_MAX_BYTES, 32768);
  assert.ok(AVATAR_RE instanceof RegExp);
  assert.equal(AVATAR_RE.test("data:image/svg+xml;base64,PHN2Zz4="), true);
});
```

Create `tests/contact-display.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { contactName, contactAvatar, isPlaceholderName } from "../servers/sharing/contact-display.js";
import { isPlaceholderName as promoteRule } from "../servers/sharing/contact-promote.js";

const PNG = "data:image/png;base64," + "A".repeat(40);
const JPG = "data:image/jpeg;base64," + "B".repeat(40);

test("contactName: a typed local name wins; a placeholder yields to the peer's name; then the crow id; then null", () => {
  assert.equal(contactName({ display_name: "My Friend", peer_display_name: "Kevin", crow_id: "crow:abc" }), "My Friend");
  assert.equal(contactName({ display_name: "crow:abc", peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin", "the crowId placeholder is not a name");
  assert.equal(contactName({ display_name: "req:ff", peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin");
  assert.equal(contactName({ display_name: "", peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin");
  assert.equal(contactName({ display_name: null, peer_display_name: "Kevin", crow_id: "crow:abc" }), "Kevin");
  assert.equal(contactName({ display_name: null, peer_display_name: null, crow_id: "crow:abc" }), "crow:abc");
  assert.equal(contactName({ display_name: "crow:abc", peer_display_name: "", crow_id: "crow:abc" }), "crow:abc", "an empty peer name is no name");
  assert.equal(contactName({ display_name: "crow:abc", crow_id: "crow:abc" }, { fallback: "crow:abc..." }), "crow:abc...", "the caller's fallback replaces crow_id");
  assert.equal(contactName({ display_name: "Dayane", crow_id: "crow:abc" }, { fallback: "x" }), "Dayane", "a fallback never beats a name");
  assert.equal(contactName({}), null);
  assert.equal(contactName(null), null);
  assert.equal(contactName(undefined, { fallback: "f" }), "f");
});

test("contactAvatar: the first VALID inline picture wins (local, then peer); a URL never renders", () => {
  assert.equal(contactAvatar({ avatar_url: PNG, peer_avatar: JPG }), PNG);
  assert.equal(contactAvatar({ avatar_url: "", peer_avatar: JPG }), JPG);
  assert.equal(contactAvatar({ avatar_url: null, peer_avatar: JPG }), JPG);
  assert.equal(contactAvatar({ avatar_url: "https://example.com/me.png", peer_avatar: JPG }), JPG, "a legacy URL falls through to the peer's picture");
  assert.equal(contactAvatar({ avatar_url: "https://example.com/me.png" }), null);
  assert.equal(contactAvatar({ peer_avatar: "data:image/png;base64," + "A".repeat(40000) }), null, "over the cap is not a picture");
  assert.equal(contactAvatar({}), null);
  assert.equal(contactAvatar(null), null);
});

test("isPlaceholderName mirrors contact-promote's rule exactly", () => {
  for (const v of [null, undefined, "", "req:x", "crow:y", "Kevin", "  ", "Crow:z", "REQ:q", 0, "0"]) {
    assert.equal(isPlaceholderName(v), promoteRule(v), `disagree on ${JSON.stringify(v)}`);
  }
});
```

Create `tests/contacts-peer-columns.test.js`:

```js
/**
 * Spec 2026-09-08 §4.4: the two peer-profile columns are ADDITIVE and land
 * with no SCHEMA_GENERATION bump — init-db adds them for fresh installs (this
 * file), sharing init adds them for existing hosts (tests/peer-profile.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

function runInitDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
}

test("init-db adds contacts.peer_display_name and contacts.peer_avatar (TEXT), idempotently, without a generation bump", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-cols-"));
  try {
    runInitDb(dir);
    const db = createClient({ url: "file:" + join(dir, "crow.db") });
    try {
      await db.execute("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:keep', 'Keep', '', '')");
      const uvBefore = Number((await db.execute("PRAGMA user_version")).rows[0].user_version);
      runInitDb(dir); // a second run must not error, duplicate or drop
      const { rows } = await db.execute("PRAGMA table_info(contacts)");
      for (const c of ["peer_display_name", "peer_avatar"]) {
        const cols = rows.filter((r) => r.name === c);
        assert.equal(cols.length, 1, `${c} present exactly once`);
        assert.equal(String(cols[0].type).toUpperCase(), "TEXT");
        assert.equal(Number(cols[0].notnull), 0, `${c} nullable`);
      }
      assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n), 1, "rows survive a re-run");
      assert.equal(Number((await db.execute("PRAGMA user_version")).rows[0].user_version), uvBefore, "no generation bump for an additive column");
    } finally { try { db.close(); } catch {} }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/avatar-validate.test.js tests/contact-display.test.js tests/contacts-peer-columns.test.js` → FAIL (missing modules / columns).

- [ ] **Step 3: Implement**

Create `servers/sharing/avatar.js`:

```js
/**
 * validateAvatar — bound a profile picture (spec 2026-09-08 §1, §4.1).
 * Zero-import, pure: `unknown` in, `string|null` out.
 *
 * A picture travels as an inline `data:` image: in the pairing handshake, in
 * the `profile` crow_social message, on the instance-sync contacts wire, and
 * it is rendered in the dashboard and the Ramble panel through `<img src>`
 * only (so an SVG cannot run script). The three rules, in order:
 *   1. non-string → null;
 *   2. longer than AVATAR_MAX_BYTES characters (the stored string) → null;
 *   3. must match AVATAR_RE: one of four image types, base64 payload only
 *      (no whitespace, no `<`, no second `data:`), nothing after it.
 * Every ingress runs this; every render trusts nothing else.
 */
export const AVATAR_MAX_BYTES = 32768;
export const AVATAR_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export function validateAvatar(value) {
  if (typeof value !== "string") return null;
  if (value.length > AVATAR_MAX_BYTES) return null;
  return AVATAR_RE.test(value) ? value : null;
}
```

Create `servers/sharing/contact-display.js`:

```js
/**
 * contact-display — the ONE rule for a contact's name and picture on screen
 * (spec 2026-09-08 §4.5, decision D5), used by the Contacts panel, the
 * Messages list, the contacts tool and mirrored inline by the Ramble bundle
 * (bundles/ramble/server/delivery.js — a bundle server file cannot import
 * core statically).
 *
 *   name:    what the user typed (display_name) unless it is a placeholder
 *            (null, "", "crow:…", "req:…" — the same rule as
 *            contact-promote.js's isPlaceholderName, mirrored here so this
 *            module stays import-light) → what the peer told us
 *            (peer_display_name) → the caller's fallback (crow_id by default).
 *   picture: the first INLINE picture validateAvatar accepts, local first —
 *            a legacy https: avatar_url cannot render under the dashboard CSP,
 *            so it falls through to the peer's picture instead of blanking it.
 */
import { validateAvatar } from "./avatar.js";

export function isPlaceholderName(name) {
  return name == null || name === "" || String(name).startsWith("req:") || String(name).startsWith("crow:");
}

export function contactName(row, { fallback } = {}) {
  const r = row || {};
  if (!isPlaceholderName(r.display_name)) return String(r.display_name);
  if (typeof r.peer_display_name === "string" && r.peer_display_name.length > 0) return r.peer_display_name;
  if (fallback !== undefined) return fallback;
  return r.crow_id ? String(r.crow_id) : null;
}

export function contactAvatar(row) {
  const r = row || {};
  return validateAvatar(r.avatar_url) || validateAvatar(r.peer_avatar) || null;
}
```

`scripts/init-db.js` — directly after `await addColumnIfMissing("contacts", "verified", "INTEGER DEFAULT 0");`:

```js
// 2026-09-08 (names+profile design §4.4 / D5): what a PEER told us about
// themselves — their own profile name and inline picture — kept apart from the
// name/picture the user typed (display_name / avatar_url), which win on screen
// and are never overwritten by a peer message. Additive, NO SCHEMA_GENERATION
// bump: existing hosts get these from the runtime guard in
// servers/sharing/peer-profile.js (ensurePeerProfileColumns, called at sharing
// init) — the shared_items.mode precedent.
await addColumnIfMissing("contacts", "peer_display_name", "TEXT");
await addColumnIfMissing("contacts", "peer_avatar", "TEXT");
```

- [ ] **Step 4: Run** the three files → PASS.
- [ ] **Step 5: Commit** — `git add servers/sharing/avatar.js servers/sharing/contact-display.js tests/avatar-validate.test.js tests/contact-display.test.js tests/contacts-peer-columns.test.js && git commit servers/sharing/avatar.js servers/sharing/contact-display.js scripts/init-db.js tests/avatar-validate.test.js tests/contact-display.test.js tests/contacts-peer-columns.test.js -m "sharing: avatar validator, the contact display rule, peer_display_name/peer_avatar columns"`
- [ ] **Step 6 (controller, before the PR): the migration dry-run.** From the worktree, against COPIES (the script always copies):

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
S=/tmp/claude-1000/-home-kh0pp-crow/0ad962bb-ad5e-4bcf-b8ac-fbc86addfcab/scratchpad/dryrun; mkdir -p "$S"
grackle "sqlite3 ~/.crow/data/crow.db '.backup /tmp/grackle-dryrun.db'" && scp grackle:/tmp/grackle-dryrun.db "$S/grackle.db" && grackle "rm -f /tmp/grackle-dryrun.db"
cd /home/kh0pp/crow-wt-profile && scripts/schema-migration-dryrun.sh crow ~/.crow/data/crow.db r4 ~/.crow-r4/data/crow.db grackle "$S/grackle.db"
```

Expected per DB: `init-db exit=0   user_version: 9 -> 9   integrity: ok`; schema objects `(none)`; row-count deltas `(none …)`; columns exactly `+ contacts.peer_display_name (TEXT)` and `+ contacts.peer_avatar (TEXT)`; `✅ DRY-RUN GATE PASSED`. Anything else is a STOP. (`grackle "<cmd>"` runs a remote command; `.backup` makes a consistent copy of grackle's live db; `~/.crow-r4/data/crow.db` is the r4 instance's db on crow.) Paste the three result blocks into the PR body.

---

## Task 2: `peer-profile.js` — envelope, apply, receiver, broadcast; the handshake carries the avatar both ways; the `profile` dispatch

**Files:**
- Create: `servers/sharing/peer-profile.js`, `tests/peer-profile.test.js`
- Modify: `servers/sharing/boot.js`, `servers/sharing/retry-queue.js:46-60`, `servers/sharing/tools/contacts.js` (`acceptInviteCore` ~58-90; the `crow_list_contacts` mapper)
- Test: `tests/handshake-display-name.test.js` (append)

**Interfaces:**
- Consumes: `validateAvatar` (Task 1), `sanitizeDisplayName`, `findContactByPubkey`, `emitContactChange`, `ensureColumn`.
- Produces: `PROFILE_SUBTYPE = "profile"`; `ensurePeerProfileColumns(db) → Promise<void>`; `readLocalProfile(db) → { displayName: string|null, avatar: string|null }`; `buildProfileMessage({ displayName, avatar }) → string` (JSON envelope); `applyPeerProfile(db, contactId, { displayName?, avatar? }) → { changed: boolean, row: object|null }`; `handleProfileMessage(db, payload, senderPubkey) → { applied: boolean, changed?: boolean, contactId?: number, reason?: string }`; `profileRecipients(db) → row[]`; `broadcastProfile(db, nostrManager) → { sent, failed, skipped }`; `buildHandshakeComplete(eventIds, displayName, avatar)`; `handleHandshakeComplete(db, eventIds, senderPubkey, displayName, avatar)`.

- [ ] **Step 1: Failing tests**

Create `tests/peer-profile.test.js`:

```js
/**
 * peer-profile — spec 2026-09-08 §4.2–§4.4: what a contact tells us about
 * themselves lands in peer_display_name / peer_avatar, never over the name or
 * picture the user typed; the `profile` crow_social message is accepted only
 * from a FULL, unblocked contact; the broadcast reaches every full unblocked
 * human contact with a key, once, best effort.
 *
 * Real on-disk init-db schema (handshake-display-name.test.js precedent);
 * managers stubbed, no relays. The dispatch test drives the REAL
 * wireNostrReceive ladder with a capturing subscribeToIncoming
 * (boot-receive-decouple.test.js precedent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import {
  PROFILE_SUBTYPE, ensurePeerProfileColumns, readLocalProfile, buildProfileMessage,
  applyPeerProfile, handleProfileMessage, profileRecipients, broadcastProfile,
} from "../servers/sharing/peer-profile.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { wireNostrReceive } from "../servers/sharing/boot.js";
import { _resetReceiveHealth } from "../servers/sharing/receive-health.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "peer-profile-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PNG = "data:image/png;base64," + "A".repeat(64);
const JPG = "data:image/jpeg;base64," + "B".repeat(64);
const pk = (ch) => "02" + ch.repeat(64);
const xonly = (ch) => ch.repeat(64);

async function seed(db, { crowId, secp, name = crowId, extra = {} }) {
  const cols = ["crow_id", "ed25519_pubkey", "secp256k1_pubkey", "display_name", ...Object.keys(extra)];
  const vals = [crowId, "d".repeat(64), secp, name, ...Object.values(extra)];
  const res = await db.execute({ sql: `INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: vals });
  return Number(res.lastInsertRowid);
}
const rowOf = async (db, id) => (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [id] })).rows[0];

test("buildProfileMessage: the crow_social envelope with subtype profile; sanitized name, validated picture, nulls propagate", () => {
  const env = JSON.parse(buildProfileMessage({ displayName: "  Kevin\u202e ", avatar: PNG }));
  assert.equal(env.type, "crow_social");
  assert.equal(env.version, 1);
  assert.equal(env.subtype, PROFILE_SUBTYPE);
  assert.equal(PROFILE_SUBTYPE, "profile");
  assert.deepEqual(env.payload, { v: 1, display_name: "Kevin", avatar: PNG });
  assert.deepEqual(JSON.parse(buildProfileMessage({})).payload, { v: 1, display_name: null, avatar: null }, "a cleared profile is sent as nulls");
  assert.deepEqual(JSON.parse(buildProfileMessage({ displayName: "crow:x", avatar: "https://x/y.png" })).payload, { v: 1, display_name: null, avatar: null });
});

test("readLocalProfile: sanitized name + validated picture from the GLOBAL rows; a legacy URL avatar is null; unreadable db is nulls", async () => {
  const { db, cleanup } = freshDb();
  try {
    assert.deepEqual(await readLocalProfile(db), { displayName: null, avatar: null });
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', ?, datetime('now')), ('profile_avatar_url', 'https://example.com/me.png', datetime('now'))", args: ["\u202eEvil"] });
    assert.deepEqual(await readLocalProfile(db), { displayName: "Evil", avatar: null });
    await db.execute({ sql: "UPDATE dashboard_settings SET value = ? WHERE key = 'profile_avatar_url'", args: [PNG] });
    assert.deepEqual(await readLocalProfile(db), { displayName: "Evil", avatar: PNG });
    assert.deepEqual(await readLocalProfile({ execute: async () => { throw new Error("boom"); } }), { displayName: null, avatar: null });
    assert.deepEqual(await readLocalProfile(null), { displayName: null, avatar: null });
  } finally { cleanup(); }
});

test("applyPeerProfile: undefined leaves a field alone, a string sets it (sanitized/validated), null clears; display_name/avatar_url are never touched; one emit per real change", async () => {
  const { db, cleanup } = freshDb();
  const emits = [];
  __setEmitSinkForTest({ emitChange: async (table, op, row) => { emits.push({ table, op, crow_id: row.crow_id, peer: row.peer_display_name }); return 1; }, feedsDisabled: false });
  try {
    const id = await seed(db, { crowId: "crow:pal", secp: pk("a"), name: "My Friend", extra: { avatar_url: "https://example.com/local.png" } });
    let r = await applyPeerProfile(db, id, { displayName: "  Kevin  ", avatar: PNG });
    assert.equal(r.changed, true);
    let row = await rowOf(db, id);
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, PNG);
    assert.equal(row.display_name, "My Friend", "the typed name is untouched");
    assert.equal(row.avatar_url, "https://example.com/local.png", "the local picture is untouched");
    r = await applyPeerProfile(db, id, { avatar: JPG });
    assert.equal(r.changed, true);
    row = await rowOf(db, id);
    assert.equal(row.peer_display_name, "Kevin", "undefined = left alone");
    assert.equal(row.peer_avatar, JPG);
    r = await applyPeerProfile(db, id, { displayName: null, avatar: "https://example.com/not-inline.png" });
    row = await rowOf(db, id);
    assert.equal(row.peer_display_name, null, "null clears");
    assert.equal(row.peer_avatar, null, "a rejected picture clears");
    r = await applyPeerProfile(db, id, { displayName: null });
    assert.equal(r.changed, false, "no-op when nothing changes");
    assert.equal((await applyPeerProfile(db, id, {})).changed, false, "nothing given, nothing done");
    assert.equal((await applyPeerProfile(db, 999999, { displayName: "X" })).changed, false, "unknown contact");
    assert.deepEqual(emits.map((e) => [e.table, e.op, e.crow_id]), [["contacts", "update", "crow:pal"], ["contacts", "update", "crow:pal"], ["contacts", "update", "crow:pal"]], "exactly one emit per real change");
    assert.equal(emits[0].peer, "Kevin", "the emitted row carries the peer field");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("handleProfileMessage: accepted from a FULL unblocked contact; dropped from a stranger, a pending request, a blocked contact; never throws", async () => {
  const { db, cleanup } = freshDb();
  __setEmitSinkForTest({ emitChange: async () => 1, feedsDisabled: false });
  try {
    const full = await seed(db, { crowId: "crow:full", secp: pk("1"), name: "crow:full" });
    await seed(db, { crowId: "req:" + xonly("2"), secp: xonly("2"), name: null, extra: { request_status: "pending" } });
    const blocked = await seed(db, { crowId: "crow:blocked", secp: pk("3"), name: "Blocked", extra: { is_blocked: 1 } });
    const payload = { v: 1, display_name: "Kevin", avatar: PNG };

    let r = await handleProfileMessage(db, payload, xonly("1"));
    assert.deepEqual([r.applied, r.changed, r.contactId], [true, true, full]);
    let row = await rowOf(db, full);
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, PNG);
    assert.equal(row.display_name, "crow:full", "the profile message never writes display_name — even over a placeholder");

    r = await handleProfileMessage(db, payload, xonly("9"));
    assert.deepEqual([r.applied, r.reason], [false, "stranger"]);
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n), 3, "a stranger's profile creates no row");

    r = await handleProfileMessage(db, payload, xonly("2"));
    assert.deepEqual([r.applied, r.reason], [false, "not-full"]);

    r = await handleProfileMessage(db, payload, xonly("3"));
    assert.deepEqual([r.applied, r.reason], [false, "blocked"]);
    assert.equal((await rowOf(db, blocked)).peer_display_name, null);

    r = await handleProfileMessage(db, { v: 1, display_name: "Kev" }, xonly("1"));
    row = await rowOf(db, full);
    assert.equal(row.peer_display_name, "Kev");
    assert.equal(row.peer_avatar, PNG, "an absent avatar key leaves the picture alone");

    r = await handleProfileMessage(db, { v: 1, display_name: null, avatar: null }, xonly("1"));
    row = await rowOf(db, full);
    assert.equal(row.peer_display_name, null, "explicit nulls clear (the peer removed their picture)");
    assert.equal(row.peer_avatar, null);

    assert.equal((await handleProfileMessage(db, "junk", xonly("1"))).applied, false);
    assert.equal((await handleProfileMessage(db, [1], xonly("1"))).applied, false);
    assert.equal((await handleProfileMessage(db, payload, null)).applied, false);
    assert.equal((await handleProfileMessage(null, payload, xonly("1"))).applied, false);
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("the profile subtype reaches handleProfileMessage through the REAL receive ladder (wireNostrReceive -> onSocialMessage)", async () => {
  _resetReceiveHealth();
  const { db, cleanup } = freshDb();
  __setEmitSinkForTest({ emitChange: async () => 1, feedsDisabled: false });
  try {
    const full = await seed(db, { crowId: "crow:ladder", secp: pk("4"), name: "crow:ladder" });
    let handlers = null;
    const managers = {
      db,
      identity: { crowId: "crow:me", secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) },
      peerManager: { joinContact: async () => {}, joinInstanceSync: async () => {} },
      syncManager: { initContact: async () => {} },
      instanceSyncManager: { localInstanceId: "inst-test" },
      nostrManager: {
        subscribeToContact: async () => {},
        subscribeToIncoming: async (onInvite, onSocial, onRequest) => { handlers = { onInvite, onSocial, onRequest }; },
      },
    };
    await wireNostrReceive(managers);
    assert.ok(handlers, "the ladder was captured");
    await handlers.onSocial("profile", { v: 1, display_name: "Ladder Kevin", avatar: JPG }, xonly("4"));
    const row = await rowOf(db, full);
    assert.equal(row.peer_display_name, "Ladder Kevin");
    assert.equal(row.peer_avatar, JPG);
    await handlers.onSocial("profile", { v: 1, display_name: "Nope", avatar: JPG }, xonly("5"));
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n), 1, "a stranger on the ladder creates nothing");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

test("profileRecipients + broadcastProfile: every full unblocked human keyed contact, once; failures counted, not thrown; no manager = skipped", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Kevin', datetime('now')), ('profile_avatar_url', ?, datetime('now'))", args: [PNG] });
    await seed(db, { crowId: "crow:full", secp: pk("a"), name: "Full" });
    await seed(db, { crowId: "crow:full2", secp: xonly("b"), name: "Full x-only" });
    await seed(db, { crowId: "crow:blocked", secp: pk("c"), name: "B", extra: { is_blocked: 1 } });
    await seed(db, { crowId: "req:" + xonly("d"), secp: xonly("d"), name: null, extra: { request_status: "pending" } });
    await seed(db, { crowId: "crow:accepted", secp: pk("e"), name: "Acc", extra: { request_status: "accepted" } });
    await seed(db, { crowId: "crow:bot", secp: pk("f"), name: "Bot", extra: { is_bot: 1 } });
    await seed(db, { crowId: "crow:localbot", secp: pk("1"), name: "LB", extra: { origin: "local-bot" } });
    await seed(db, { crowId: "manual:x", secp: "", name: "Manual", extra: { contact_type: "manual" } });
    await seed(db, { crowId: "crow:badkey", secp: "not-hex", name: "Bad" });

    assert.deepEqual((await profileRecipients(db)).map((r) => r.crow_id), ["crow:full", "crow:full2"]);

    const sent = [];
    const nostrManager = { sendControl: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["r"] }; } };
    assert.deepEqual(await broadcastProfile(db, nostrManager), { sent: 2, failed: 0, skipped: 0 });
    assert.deepEqual(sent.map((s) => s.contact.secp256k1_pubkey), [pk("a"), xonly("b")]);
    const env = JSON.parse(sent[0].content);
    assert.equal(env.subtype, "profile");
    assert.deepEqual(env.payload, { v: 1, display_name: "Kevin", avatar: PNG });

    let n = 0;
    const flaky = { sendControl: async () => { if (n++ === 0) throw new Error("relay down"); return { eventId: "e", relays: ["r"] }; } };
    assert.deepEqual(await broadcastProfile(db, flaky), { sent: 1, failed: 1, skipped: 0 }, "a failure is counted and the loop continues");
    assert.deepEqual(await broadcastProfile(db, null), { sent: 0, failed: 0, skipped: 1 });
    assert.deepEqual(await broadcastProfile(db, {}), { sent: 0, failed: 0, skipped: 1 }, "no sendControl = no wire");
  } finally { cleanup(); }
});

test("ensurePeerProfileColumns adds the two columns to a contacts table that lacks them, and is idempotent", async () => {
  const db = createClient({ url: "file::memory:" });
  await db.execute("CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, display_name TEXT)");
  await ensurePeerProfileColumns(db);
  await ensurePeerProfileColumns(db);
  const names = (await db.execute("PRAGMA table_info(contacts)")).rows.map((r) => r.name);
  assert.deepEqual(names.filter((n) => n.startsWith("peer_")), ["peer_display_name", "peer_avatar"]);
  await ensurePeerProfileColumns({ execute: async () => { throw new Error("no such table"); } }); // never throws
});
```

Append to `tests/handshake-display-name.test.js` (its imports already cover `handleInviteAccepted`, `handleHandshakeComplete`, `buildHandshakeComplete`, `HANDSHAKE_COMPLETE_SUBTYPE`, `registerContactsTools`; `freshDb`, `stubMgrs`, `PK`, `PK_XONLY`, `OTHER_PK`, `invitePayload`, `seedContact`, `nameOf`, `acceptWith` are file-scope):

```js
// --- Plan B (2026-09-08 §4.2): the avatar rides the handshake both ways -----

const PNG_AV = "data:image/png;base64," + "Q".repeat(64);
const peerOf = async (db, crowId) => (await db.execute({ sql: "SELECT display_name, peer_display_name, peer_avatar FROM contacts WHERE crow_id = ?", args: [crowId] })).rows[0];
function ackingMgrs(acks) {
  return { ...stubMgrs(), nostrManager: { subscribeToContact: async () => {}, sendControl: async (c, content) => { acks.push(JSON.parse(content)); return { eventId: "a", relays: [] }; } } };
}

test("buildHandshakeComplete(ids, name, avatar): the avatar key appears only for a non-empty string (old-peer wire compat)", () => {
  assert.equal(JSON.parse(buildHandshakeComplete(["e1"], "Kevin", PNG_AV)).payload.avatar, PNG_AV);
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"], "Kevin")).payload));
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"], "Kevin", null)).payload));
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"], "Kevin", "")).payload));
  assert.ok(!("avatar" in JSON.parse(buildHandshakeComplete(["e1"])).payload), "the one-arg form is byte-identical to before");
});

test("invite_accepted with displayName + avatar: peer fields stored; a bad avatar is ignored; the handshake still acks", async () => {
  const { db, cleanup } = freshDb();
  try {
    const acks = [];
    const mgrs = ackingMgrs(acks);
    await handleInviteAccepted(db, mgrs, invitePayload({ displayName: "Dayane", avatar: PNG_AV }), PK, { id: "av-1" });
    let row = await peerOf(db, "crow:realpeer9");
    assert.equal(row.display_name, "Dayane", "a brand-new row still takes the handshake name (today's behaviour)");
    assert.equal(row.peer_display_name, "Dayane");
    assert.equal(row.peer_avatar, PNG_AV);
    assert.equal(acks.length, 1, "acked");

    const p2 = { type: "invite_accepted", crowId: "crow:host2", ed25519Pub: "d".repeat(64), secp256k1Pub: OTHER_PK, displayName: "Two", avatar: "https://example.com/not-inline.png" };
    await handleInviteAccepted(db, mgrs, p2, OTHER_PK, { id: "av-2" });
    row = await peerOf(db, "crow:host2");
    assert.equal(row.peer_display_name, "Two");
    assert.equal(row.peer_avatar, null, "a URL avatar is ignored — never fails the handshake");
    assert.equal(acks.length, 2, "still acked");
  } finally { cleanup(); }
});

test("handleHandshakeComplete stores the inviter's name + avatar in the peer fields; the typed-name rule is unchanged", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db, "crow:inv-typed", PK, "My Friend");
    await handleHandshakeComplete(db, ["evt-1"], PK_XONLY, "Kevin", PNG_AV);
    let row = await peerOf(db, "crow:inv-typed");
    assert.equal(row.display_name, "My Friend", "never overwritten");
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, PNG_AV);

    const placeholder = await seedContact(db, "crow:inv-ph", OTHER_PK, "crow:inv-ph");
    await handleHandshakeComplete(db, ["evt-2"], OTHER_PK.slice(-64), "Kevin");
    assert.equal(await nameOf(db, placeholder), "Kevin", "the placeholder rule still applies");
    row = await peerOf(db, "crow:inv-ph");
    assert.equal(row.peer_display_name, "Kevin");
    assert.equal(row.peer_avatar, null, "no avatar on the wire = left alone");
  } finally { cleanup(); }
});

test("the inviter's ack carries its own avatar when profile_avatar_url holds a valid data URI", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Inviter', datetime('now')), ('profile_avatar_url', ?, datetime('now'))", args: [PNG_AV] });
    const acks = [];
    await handleInviteAccepted(db, ackingMgrs(acks), invitePayload(), PK, { id: "ack-av" });
    assert.equal(acks.length, 1);
    assert.equal(acks[0].subtype, HANDSHAKE_COMPLETE_SUBTYPE);
    assert.equal(acks[0].payload.displayName, "Inviter");
    assert.equal(acks[0].payload.avatar, PNG_AV);
  } finally { cleanup(); }
});

test("crow_accept_invite includes a valid avatar in the acceptance and omits a legacy URL one", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_avatar_url', ?, datetime('now'))", args: [PNG_AV] });
    let payload = await acceptWith({ db, profileName: "Dayane" });
    assert.equal(payload.avatar, PNG_AV);
    assert.equal(payload.displayName, "Dayane");
    await db.execute({ sql: "UPDATE dashboard_settings SET value = 'https://example.com/me.png' WHERE key = 'profile_avatar_url'", args: [] });
    payload = await acceptWith({ db, profileName: null }); // the name row from the first accept is still there
    assert.ok(!("avatar" in payload), "a URL is not an avatar → key omitted");
  } finally { cleanup(); }
});

test("handshake_complete peer fields are dropped for a blocked contact and for a pending request row (R1-C1)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES ('crow:blk', ?, ?, 'Blocked', 1)", args: ["d".repeat(64), PK] });
    await handleHandshakeComplete(db, [], PK_XONLY, "Renamed", PNG_AV);
    let r = await peerOf(db, "crow:blk");
    assert.equal(r.peer_display_name, null, "a blocked contact cannot rename itself");
    assert.equal(r.peer_avatar, null);
    assert.equal(r.display_name, "Blocked");
    const req = "req:" + "e".repeat(64);
    await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, request_status) VALUES (?, ?, ?, NULL, 'pending')", args: [req, "d".repeat(64), OTHER_PK] });
    await handleHandshakeComplete(db, [], OTHER_PK.slice(-64), "Stranger", PNG_AV);
    r = await peerOf(db, req);
    assert.equal(r.peer_avatar, null, "an unpaired request row never stores 32 KB");
    assert.equal(r.peer_display_name, null);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/peer-profile.test.js tests/handshake-display-name.test.js` → the new tests FAIL.

- [ ] **Step 3: Implement**

Create `servers/sharing/peer-profile.js`:

```js
/**
 * Peer profile — what a contact tells us about themselves (spec 2026-09-08
 * §4.2–§4.4, decision D5).
 *
 * Two contact columns, `peer_display_name` and `peer_avatar`, hold the name
 * and inline picture a PEER sent — in the pairing handshake (both directions)
 * and in the `profile` crow_social message that every full contact receives
 * when the profile changes. They are kept apart from `display_name` /
 * `avatar_url`, which the user typed and which always win on screen
 * (servers/sharing/contact-display.js). Nothing here ever writes those two.
 *
 * The receive rule is contact-only: a profile message is applied when its
 * AUTHENTICATED sender resolves to a FULL (request_status NULL), unblocked
 * contact; a stranger's, a pending request's and a blocked contact's are
 * dropped silently. The broadcast is best effort and idempotent — the next
 * change resends everything, so there is no retry queue.
 */
import { ensureColumn } from "../db.js";
import { findContactByPubkey } from "./pubkey-util.js";
import { sanitizeDisplayName } from "./display-name.js";
import { validateAvatar } from "./avatar.js";
import { emitContactChange } from "./contact-sync.js";

export const PROFILE_SUBTYPE = "profile";
const HEX_KEY = /^[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})?$/;

/** Runtime guard for existing hosts (init-db only re-runs on a generation bump — the shared_items.mode precedent). Never throws. */
export async function ensurePeerProfileColumns(db) {
  for (const col of ["peer_display_name", "peer_avatar"]) {
    try { await ensureColumn(db, "contacts", col, "TEXT"); }
    catch (err) { try { console.warn(`[sharing] ensureColumn contacts.${col}:`, err?.message); } catch {} }
  }
  // R1-S3: on an existing host this guard is the ONLY path to the columns
  // (no generation bump), and instance-sync caches the column list once per
  // process — so a swallowed failure here must at least be loud.
  try {
    const { rows } = await db.execute({ sql: "PRAGMA table_info(contacts)", args: [] });
    const have = new Set((rows || []).map((r) => r.name));
    if (!have.has("peer_display_name") || !have.has("peer_avatar")) {
      console.error("[sharing] contacts.peer_* columns MISSING after ensureColumn — peer profiles are disabled for this process; run `npm run init-db`");
    }
  } catch { /* an unreadable schema was already warned about above */ }
}

/**
 * The local user's own profile as it goes on the wire: sanitized name,
 * validated picture; null for each when unset, rejected or unreadable. Reads
 * the GLOBAL rows on purpose (Cluster B D6: profile identity is user-level;
 * per-instance overrides of profile_* keys are intentionally inert).
 */
export async function readLocalProfile(db) {
  const out = { displayName: null, avatar: null };
  try {
    if (!db) return out;
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key IN ('profile_display_name', 'profile_avatar_url')",
      args: [],
    });
    for (const r of rows || []) {
      if (r.key === "profile_display_name") out.displayName = sanitizeDisplayName(r.value);
      else if (r.key === "profile_avatar_url") out.avatar = validateAvatar(r.value);
    }
  } catch { /* unreadable settings: nothing goes on the wire */ }
  return out;
}

/** Pure: the envelope. Nulls are sent as nulls so a cleared name/picture propagates. */
export function buildProfileMessage({ displayName = null, avatar = null } = {}) {
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: PROFILE_SUBTYPE,
    payload: { v: 1, display_name: sanitizeDisplayName(displayName), avatar: validateAvatar(avatar) },
  });
}

/**
 * Write what a peer told us into ITS contact row. `undefined` leaves a field
 * alone (the handshake may omit either); a string is sanitized/validated;
 * null or a rejected value clears. Emits the contacts sync op (full row) when
 * something actually changed, so the user's other instances converge.
 */
export async function applyPeerProfile(db, contactId, fields = {}) {
  if (!db || contactId == null) return { changed: false, row: null };
  const before = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] })).rows[0];
  if (!before) return { changed: false, row: null };
  const next = {
    peer_display_name: fields.displayName === undefined ? (before.peer_display_name ?? null) : sanitizeDisplayName(fields.displayName),
    peer_avatar: fields.avatar === undefined ? (before.peer_avatar ?? null) : validateAvatar(fields.avatar),
  };
  if ((before.peer_display_name ?? null) === next.peer_display_name && (before.peer_avatar ?? null) === next.peer_avatar) {
    return { changed: false, row: before };
  }
  await db.execute({
    sql: "UPDATE contacts SET peer_display_name = ?, peer_avatar = ? WHERE id = ?",
    args: [next.peer_display_name, next.peer_avatar, contactId],
  });
  const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] })).rows[0];
  try { await emitContactChange("update", row); } catch { /* sync is best-effort */ }
  return { changed: true, row };
}

/** The `profile` crow_social receiver. Contact-only; never throws (receive path). */
export async function handleProfileMessage(db, payload, senderPubkey) {
  try {
    if (!db || !senderPubkey || !payload || typeof payload !== "object" || Array.isArray(payload)) return { applied: false, reason: "bad-input" };
    const contact = await findContactByPubkey(db, senderPubkey);
    if (!contact) return { applied: false, reason: "stranger" };
    if (contact.request_status !== null && contact.request_status !== undefined) return { applied: false, reason: "not-full" };
    if (Number(contact.is_blocked) === 1) return { applied: false, reason: "blocked" };
    const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
    const r = await applyPeerProfile(db, contact.id, {
      displayName: has("display_name") ? payload.display_name : undefined,
      avatar: has("avatar") ? payload.avatar : undefined,
    });
    return { applied: true, changed: r.changed, contactId: contact.id };
  } catch (err) {
    try { console.warn("[sharing] profile message failed:", err?.message); } catch {}
    return { applied: false, reason: "error" };
  }
}

/**
 * Who gets a profile message: full, unblocked, human, keyed contacts. Filtered
 * in JS over SELECT * so a db that predates is_bot/origin still answers.
 */
export async function profileRecipients(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE request_status IS NULL AND is_blocked = 0 ORDER BY id", args: [] });
    return (rows || []).filter((r) =>
      !Number(r.is_bot || 0) &&
      r.origin !== "local-bot" &&
      r.contact_type !== "manual" &&
      HEX_KEY.test(String(r.secp256k1_pubkey || "")));
  } catch { return []; }
}

/** One NIP-44 control DM per recipient, best effort. Returns counts. */
export async function broadcastProfile(db, nostrManager) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (!db || !nostrManager || typeof nostrManager.sendControl !== "function") { out.skipped = 1; return out; }
  const content = buildProfileMessage(await readLocalProfile(db));
  for (const c of await profileRecipients(db)) {
    try {
      await nostrManager.sendControl({ id: c.id, secp256k1_pubkey: c.secp256k1_pubkey }, content);
      out.sent++;
    } catch (err) {
      out.failed++;
      try { console.warn(`[sharing] profile to ${c.crow_id} failed:`, err?.message); } catch {}
    }
  }
  return out;
}
```

`servers/sharing/retry-queue.js` — `buildHandshakeComplete` becomes:

```js
export function buildHandshakeComplete(eventIds, displayName, avatar) {
  const ids = (Array.isArray(eventIds) ? eventIds : [])
    .filter((x) => typeof x === "string" && x.length > 0);
  // F-CONTACT-2 (design §D5): the inviter's own display name is additive and
  // optional — include the key ONLY for a non-null string, so an old peer sees
  // exactly today's envelope and a new peer treats a missing field as today.
  // 2026-09-08 §4.2: the inviter's picture rides the same way (the caller
  // passes it already validated; a missing/empty one is simply absent).
  const payload = { event_ids: ids };
  if (typeof displayName === "string" && displayName) payload.displayName = displayName;
  if (typeof avatar === "string" && avatar) payload.avatar = avatar;
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: HANDSHAKE_COMPLETE_SUBTYPE,
    payload,
  });
}
```

`servers/sharing/boot.js`:
1. Imports: add `import { PROFILE_SUBTYPE, handleProfileMessage, applyPeerProfile, readLocalProfile, ensurePeerProfileColumns } from "./peer-profile.js";`. DELETE the `readLocalDisplayName` function and its doc comment (lines 31–49; `ackHandshake` was its only caller). `sanitizeDisplayName` stays imported (still used by `handleInviteAccepted` and `handleHandshakeComplete`).
2. `ackHandshake`: replace the two lines `const selfName = await readLocalDisplayName(db);` / `await nostrManager.sendControl({ secp256k1_pubkey: senderPubkey }, buildHandshakeComplete([event.id], selfName));` with

```js
    // F-CONTACT-2 + 2026-09-08 §4.2: carry the inviter's OWN name and picture
    // so the acceptor shows both. Omitted when unset.
    const self = await readLocalProfile(db);
    await nostrManager.sendControl({ secp256k1_pubkey: senderPubkey }, buildHandshakeComplete([event.id], self.displayName, self.avatar));
```
3. `handleInviteAccepted`: change `await upsertFullContact(db, managers, {` to `const { contactId } = await upsertFullContact(db, managers, {` and directly after that call add

```js
    // 2026-09-08 §4.2 (D5): the acceptor's self-reported name/picture land in
    // the peer fields (display_name above keeps today's placeholder rule).
    // Guarded on its own: a peer-field failure must not stop the ack below.
    try { await applyPeerProfile(db, contactId, { displayName: payload.displayName, avatar: payload.avatar }); }
    catch (err) { try { console.warn("[sharing] invite_accepted peer profile failed:", err?.message); } catch {} }
```
4. `handleHandshakeComplete(db, eventIds, senderPubkey, displayName, avatar)`: after the existing placeholder `if (name && isPlaceholderName(contact.display_name)) { … }` block (still inside the outer try) add

```js
    // 2026-09-08 §4.2 / §7 (Review R1-C1): the peer fields are CONTACT-ONLY —
    // the same gate as the profile message (peer-profile.js). This handler is
    // reached from the broad incoming subscription, so a blocked contact or an
    // unpaired `req:` row could otherwise write 32 KB here with one envelope.
    if ((contact.request_status === null || contact.request_status === undefined) && Number(contact.is_blocked) !== 1) {
      try { await applyPeerProfile(db, contact.id, { displayName, avatar }); }
      catch (err) { try { console.warn("[sharing] handshake_complete peer profile failed:", err?.message); } catch {} }
    }
```
5. The dispatcher in `wireNostrReceive`: the `HANDSHAKE_COMPLETE_SUBTYPE` branch passes `payload.avatar`, and the profile branch follows it:

```js
    } else if (subtype === HANDSHAKE_COMPLETE_SUBTYPE) {
      await handleHandshakeComplete(db, payload.event_ids, senderPubkey, payload.displayName, payload.avatar);
    } else if (subtype === PROFILE_SUBTYPE) {
      // 2026-09-08 §4.3: a contact's profile changed. Contact-only inside;
      // this is the ONLY door — subscribeToContact drops every crow_social.
      await handleProfileMessage(db, payload, senderPubkey);
    } else if (subtype === "room_message" || subtype === "room_join") {
```
6. `initSharingRuntime`: after the `shared_items.mode` ensureColumn block add

```js
  // 2026-09-08 §4.4: the peer-profile contact columns, additive and un-bumped
  // (same runtime-guard shape as shared_items.mode above). Guarded inside.
  await ensurePeerProfileColumns(db);
```

`servers/sharing/tools/contacts.js`:
- Imports: replace `import { sanitizeDisplayName } from "../display-name.js";` with `import { readLocalProfile } from "../peer-profile.js";` and add `import { contactName } from "../contact-display.js";` (`sanitizeDisplayName` has no other use in this file after the edit below — verify with grep before removing).
- In `acceptInviteCore`, replace the whole `let selfName = null; try { … } catch { selfName = null; }` block with `const self = await readLocalProfile(db);` (keep the F-CONTACT-2 comment above it, appending: `// 2026-09-08 §4.2: the picture rides beside the name, validated, omitted when unset.`) and in `acceptancePayload` replace `...(selfName ? { displayName: selfName } : {}),` with

```js
      ...(self.displayName ? { displayName: self.displayName } : {}),
      ...(self.avatar ? { avatar: self.avatar } : {}),
```
- `crow_list_contacts`: the line `` `${c.display_name || c.crow_id} (${c.crow_id})`, `` becomes `` `${contactName(c) || c.crow_id} (${c.crow_id})`, ``.

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/peer-profile.test.js tests/handshake-display-name.test.js tests/handshake-complete.test.js tests/boot-receive-decouple.test.js tests/invite-accepted-promote.test.js tests/short-invite-tools.test.js tests/contacts-peer-add.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add servers/sharing/peer-profile.js tests/peer-profile.test.js && git commit servers/sharing/peer-profile.js servers/sharing/boot.js servers/sharing/retry-queue.js servers/sharing/tools/contacts.js tests/peer-profile.test.js tests/handshake-display-name.test.js -m "sharing: peer profile — the avatar in the handshake both ways, the profile crow_social message, peer_* apply and broadcast"`

---

## Task 3: The sync doors, the settings allowlist, `profile_avatar_source`

**Files:**
- Create: `tests/contacts-peer-wire.test.js`
- Modify: `servers/sharing/instance-sync.js` (`_applyContact`, after the `display_name` sanitize block ~2756), `servers/gateway/dashboard/settings/sync-allowlist.js`, `servers/gateway/dashboard/panels/contacts/data-queries.js` (`getMyProfile`)
- Test: `tests/profile-sync-allowlist.test.js` (edit the pinned list), `tests/contacts-sync.test.js` (unchanged, re-run)

**Interfaces:**
- Consumes: `validateAvatar` (Task 1).
- Produces: `PROFILE_SYNC_KEYS = ["profile_display_name", "profile_avatar_url", "profile_bio", "profile_avatar_source"]`; `isSyncable("profile_avatar_source") === true`; `getMyProfile(db)` gains `avatar_source: "picture" | "bird"` (default `"picture"`); the contacts wire carries `peer_display_name` / `peer_avatar` and the apply door sanitizes/validates them.

- [ ] **Step 1: Failing tests**

Create `tests/contacts-peer-wire.test.js` (harness mirrors `tests/contacts-origin-wire.test.js`):

```js
/**
 * Spec 2026-09-08 §4.4: peer_display_name / peer_avatar ride contact-sync's
 * full-row emits (EXCLUDED_COLUMNS.contacts unchanged) and the apply door
 * copies them — sanitized/validated once, at apply, like display_name (so a
 * redelivery never mismatches the stored row). Both doors, real init-db
 * schema, stub outbound feed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, EXCLUDED_COLUMNS } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-peer-wire-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
});
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0x5a);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-0000000009a1";
const PNG = "data:image/png;base64," + "A".repeat(64);
let seq = 0;

function makeManager() {
  const db = createDbClient(DB_PATH);
  const mgr = new InstanceSyncManager(IDENTITY, db, `peer-wire-${++seq}`);
  mgr.feedsDisabled = false;
  const entries = [];
  mgr.outFeeds = new Map([["peer-1", { append: async (e) => { entries.push(e); } }]]);
  return { mgr, db, entries };
}
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
const secp = (n) => String(n).padStart(64, "0");
const byCrow = async (db, id) => (await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [id] })).rows[0];

test("emit door: peer_display_name / peer_avatar ride the wire (not in EXCLUDED_COLUMNS)", async () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.contacts].sort(), ["created_at", "id", "last_seen", "origin", "verified"], "unchanged");
  const { mgr, entries } = makeManager();
  const ts = await mgr.emitChange("contacts", "update", {
    crow_id: "crow:pw-emit", ed25519_pubkey: "e", secp256k1_pubkey: secp(901), display_name: "Typed",
    peer_display_name: "Kevin", peer_avatar: PNG,
  });
  assert.ok(typeof ts === "number");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].row.peer_display_name, "Kevin");
  assert.equal(entries[0].row.peer_avatar, PNG);
});

test("apply door: insert + update copy the peer fields; a hostile name is sanitized and a URL avatar becomes NULL; the typed fields ride as sent", async () => {
  const { mgr, db } = makeManager();
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    avatar_url: "https://example.com/local.png", peer_display_name: "Kevin", peer_avatar: PNG,
  }, 50));
  let row = await byCrow(db, "crow:pw-ins");
  assert.ok(row, "inserted");
  assert.equal(row.peer_display_name, "Kevin");
  assert.equal(row.peer_avatar, PNG);
  assert.equal(row.display_name, "Typed");
  assert.equal(row.avatar_url, "https://example.com/local.png");

  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    peer_display_name: "crow:impostor", peer_avatar: "https://example.com/not-inline.png",
  }, 51));
  row = await byCrow(db, "crow:pw-ins");
  assert.equal(row.peer_display_name, null, "an identity-string peer name is rejected at apply");
  assert.equal(row.peer_avatar, null, "a URL is not a picture at apply either");

  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-ins", ed25519_pubkey: "e", secp256k1_pubkey: secp(902), display_name: "Typed",
    peer_display_name: "Bad Name\u202e", peer_avatar: "data:image/png;base64," + "A".repeat(40000),
  }, 52));
  row = await byCrow(db, "crow:pw-ins");
  assert.equal(row.peer_display_name, "Bad Name", "bidi override stripped");
  assert.equal(row.peer_avatar, null, "over the cap is NULL");
});

test("apply door: an entry WITHOUT the peer keys (an older sender) leaves the stored peer fields alone", async () => {
  const { mgr, db } = makeManager();
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", {
    crow_id: "crow:pw-old", ed25519_pubkey: "e", secp256k1_pubkey: secp(903), display_name: "T", peer_display_name: "Kevin", peer_avatar: PNG,
  }, 60));
  await mgr._applyEntry(REMOTE_ID, signedEntry("contacts", "update", {
    crow_id: "crow:pw-old", ed25519_pubkey: "e", secp256k1_pubkey: secp(903), display_name: "T2",
  }, 61));
  const row = await byCrow(db, "crow:pw-old");
  assert.equal(row.display_name, "T2");
  assert.equal(row.peer_display_name, "Kevin", "absent key = not on the wire = untouched");
  assert.equal(row.peer_avatar, PNG);
});
```

`tests/profile-sync-allowlist.test.js`: in the first test, the loop list and the `assert.deepEqual(PROFILE_SYNC_KEYS, […])` both become `["profile_display_name", "profile_avatar_url", "profile_bio", "profile_avatar_source"]`.

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/contacts-peer-wire.test.js tests/profile-sync-allowlist.test.js` → 2 FAIL: the apply-door sanitize/validate test (hostile peer values land raw) and the allowlist pin. The emit-door test and the "older sender" test ALREADY PASS here (the columns exist since Task 1 and `_applyContact`'s PRAGMA whitelist copies any live column) — they are regression pins for the wire contract, not gates for Task 3's code (Review R1-S4).

- [ ] **Step 3: Implement**

`servers/sharing/instance-sync.js`: add `import { validateAvatar } from "./avatar.js";` beside the `sanitizeDisplayName` import, and directly after the `if (Object.prototype.hasOwnProperty.call(filtered, "display_name")) { … }` block in `_applyContact`:

```js
    // 2026-09-08 (§4.4 / D5): the peer-reported fields ride the same trusted
    // same-owner wire, but they were REMOTE-controlled at their origin and an
    // older instance may not have validated them. Same idempotent rule as
    // display_name: clean once, here, so a redelivery never mismatches the
    // stored row and spams the conflict log. Only when the key is present.
    if (Object.prototype.hasOwnProperty.call(filtered, "peer_display_name")) {
      filtered.peer_display_name = sanitizeDisplayName(filtered.peer_display_name);
    }
    if (Object.prototype.hasOwnProperty.call(filtered, "peer_avatar")) {
      filtered.peer_avatar = validateAvatar(filtered.peer_avatar);
    }
```

`servers/gateway/dashboard/settings/sync-allowlist.js`: after `profile_bio: "Own profile — bio",` add `profile_avatar_source: "Own profile — picture source (picture, or the Ramble bird)",`; change the `profile_avatar_url` description to `"Own profile — picture (an inline data: image since 2026-09-08)"`. `PROFILE_SYNC_KEYS` becomes `["profile_display_name", "profile_avatar_url", "profile_bio", "profile_avatar_source"]` and its doc comment's first line becomes `The four own-profile keys (explicit list, deliberately NOT a "profile_*"`.

`servers/gateway/dashboard/panels/contacts/data-queries.js` `getMyProfile`: the `keys` array and the SQL `IN (…)` list both gain `'profile_avatar_source'`; after the `try { … } catch {}` (so an unreadable table still yields the default) add

```js
  // 2026-09-08 §4.1: the picture source is an enum with a default; anything
  // else (unset, a synced junk value) reads as `picture`.
  profile.avatar_source = profile.avatar_source === "bird" ? "bird" : "picture";
```

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/contacts-peer-wire.test.js tests/profile-sync-allowlist.test.js tests/contacts-sync.test.js tests/contacts-origin-wire.test.js tests/profile-heal.test.js tests/settings-reemit-v2.test.js tests/profile-save-clears-override.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add tests/contacts-peer-wire.test.js && git commit servers/sharing/instance-sync.js servers/gateway/dashboard/settings/sync-allowlist.js servers/gateway/dashboard/panels/contacts/data-queries.js tests/contacts-peer-wire.test.js tests/profile-sync-allowlist.test.js -m "sync: peer_* contacts fields through both doors; profile_avatar_source joins the profile sync keys"`

---

## Task 4: `profile-avatar.js` — the bird as picture, the refresh hook, the activate poke

**Files:**
- Create: `servers/sharing/profile-avatar.js`, `tests/profile-avatar-bird.test.js`
- Modify: `servers/sharing/boot.js` (`initSharingRuntime`), `bundles/ramble/panel/routes.js` (`POST /api/ramble/birds/:id/activate`)
- Test: `tests/ramble-panel.test.js` (append to the activate test)

**Interfaces:**
- Consumes: `validateAvatar`, `broadcastProfile`, `upsertSetting`/`deleteLocalSetting` (`servers/gateway/dashboard/settings/registry.js`), the bus (`servers/shared/event-bus.js`, an EventEmitter default export).
- Produces: `birdEngineCandidates() → string[]`; `loadBirdEngine({ candidates, fresh }) → { rollGenome, drawBird } | null`; `readActiveBird(db) → { egg_id, species, seed } | null`; `renderBirdAvatar(bird, engine) → string | null`; `renderActiveBirdAvatar(db) → string | null`; `refreshBirdAvatar(db, managers) → { changed, reason, sent? }`; `installBirdAvatarHooks(managers, { emitter }) → boolean`; `__resetBirdAvatarHooksForTest()`; the bus event `ramble:bird-activated { egg_id }`.

- [ ] **Step 1: Failing tests**

Create `tests/profile-avatar-bird.test.js`:

```js
/**
 * Spec 2026-09-08 §5: with profile_avatar_source = bird, the active Ramble
 * bird's portrait (bird-svg.cjs, "happy", 200x200 viewBox) is the profile
 * picture as an SVG data URI, refreshed on the bus events a hatch and an
 * activation emit, broadcast once when it changed, and the source falls back
 * to `picture` when there is no bird. Core reads the Ramble tables by raw
 * SQL and loads ONLY the engine exports that have existed since 0.2.0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import {
  birdEngineCandidates, loadBirdEngine, readActiveBird, renderBirdAvatar, renderActiveBirdAvatar,
  refreshBirdAvatar, installBirdAvatarHooks, __resetBirdAvatarHooksForTest,
} from "../servers/sharing/profile-avatar.js";
import { validateAvatar, AVATAR_MAX_BYTES } from "../servers/sharing/avatar.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";

const REPO_ENGINE = join(import.meta.dirname, "..", "bundles", "ramble", "server", "bird-svg.cjs");

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "bird-avatar-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir; // deleteLocalSetting resolves the local instance id from here
  setSettingsSyncManager(null);
  return {
    db, dir,
    cleanup() {
      try { db.close(); } catch {}
      setSettingsSyncManager(null);
      if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const setting = async (db, key) => (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;
const putSetting = (db, key, value) => db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [key, value] });
async function plantBird(db, { eggId = "b1", species = "crow", seed = 123456 } = {}) {
  await initRambleTables(db);
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES (?, 'hatched', 100, ?, ?, 1, 2) ON CONFLICT(egg_id) DO UPDATE SET species = excluded.species, seed = excluded.seed", args: [eggId, species, seed] });
  await db.execute({ sql: "INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', ?) ON CONFLICT(owner) DO UPDATE SET active_egg_id = excluded.active_egg_id", args: [eggId] });
}
const mgrsWith = (db, sent) => ({ db, nostrManager: { sendControl: async (c, content) => { sent.push({ c, content }); return { eventId: "e", relays: ["r"] }; } } });
const seedContact = (db) => db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', ?, ?)", args: ["d".repeat(64), "02" + "a".repeat(64)] });
const settle = async (db, key, want) => { for (let i = 0; i < 50 && (await setting(db, key)) !== want; i++) await new Promise((r) => setTimeout(r, 20)); };

test("renderBirdAvatar: a deterministic SVG data URI under the cap; species/seed sensitive; junk is null", () => {
  const a = renderBirdAvatar({ species: "crow", seed: 123456 });
  assert.ok(a.startsWith("data:image/svg+xml;base64,"));
  assert.equal(validateAvatar(a), a, "passes the avatar validator");
  assert.ok(a.length < AVATAR_MAX_BYTES / 4, `a bird is small (${a.length} chars)`);
  const svg = Buffer.from(a.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("<ellipse"), "the engine's body");
  assert.equal(renderBirdAvatar({ species: "crow", seed: 123456 }), a, "deterministic");
  assert.notEqual(renderBirdAvatar({ species: "crow", seed: 123457 }), a);
  assert.notEqual(renderBirdAvatar({ species: "raven", seed: 123456 }), a);
  assert.equal(renderBirdAvatar({ species: "dodo", seed: 1 }), null, "an unknown species never throws");
  assert.equal(renderBirdAvatar({ species: "crow", seed: -1 }), null);
  assert.equal(renderBirdAvatar(null), null);
  assert.equal(renderBirdAvatar({ species: "crow", seed: 1 }, null), null, "no engine, no picture");
});

test("loadBirdEngine: installed copy first, then the repo; only rollGenome + drawBird are required; nothing found = null", () => {
  const cands = birdEngineCandidates();
  assert.equal(cands.length, 2);
  assert.ok(cands[0].includes(join("bundles", "ramble", "server", "bird-svg.cjs")));
  assert.equal(cands[1], REPO_ENGINE);
  const engine = loadBirdEngine({ candidates: ["/nonexistent/bird-svg.cjs", REPO_ENGINE], fresh: true });
  assert.equal(typeof engine?.rollGenome, "function");
  assert.equal(typeof engine?.drawBird, "function");
  assert.equal(loadBirdEngine({ candidates: ["/nonexistent/a.cjs", "/nonexistent/b.cjs"], fresh: true }), null);
  assert.ok(loadBirdEngine({ fresh: true }), "the default candidates resolve in the repo");
});

test("readActiveBird: null with no Ramble tables, no pet, an unhatched active egg; the bird otherwise", async () => {
  const bare = createClient({ url: "file::memory:" });
  assert.equal(await readActiveBird(bare), null, "no tables = no bird, no throw");
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  assert.equal(await readActiveBird(db), null, "no pet row");
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1', 'incubating', 1, 1)");
  await db.execute("INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'e1')");
  assert.equal(await readActiveBird(db), null, "an unhatched active egg is not a bird");
  await plantBird(db, { eggId: "b1", species: "magpie", seed: 4242 });
  assert.deepEqual(await readActiveBird(db), { egg_id: "b1", species: "magpie", seed: 4242 });
  assert.equal(await renderActiveBirdAvatar(db), renderBirdAvatar({ species: "magpie", seed: 4242 }));
});

test("refreshBirdAvatar: no-op for source picture; falls back to picture with no bird; renders, stores and broadcasts once for a bird; idempotent", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    const sent = [];
    const managers = mgrsWith(db, sent);
    assert.deepEqual(await refreshBirdAvatar(db, managers), { changed: false, reason: "source-picture" });

    await putSetting(db, "profile_avatar_source", "bird");
    await putSetting(db, "profile_avatar_url", "data:image/png;base64," + "A".repeat(16));
    assert.deepEqual(await refreshBirdAvatar(db, managers), { changed: true, reason: "no-bird" });
    assert.equal(await setting(db, "profile_avatar_source"), "picture", "falls back");
    assert.equal(await setting(db, "profile_avatar_url"), "data:image/png;base64," + "A".repeat(16), "the last stored image stays");
    assert.equal(sent.length, 0, "nothing to say");

    await plantBird(db, { eggId: "b1", species: "crow", seed: 7 });
    await putSetting(db, "profile_avatar_source", "bird");
    let r = await refreshBirdAvatar(db, managers);
    assert.equal(r.changed, true);
    assert.equal(r.reason, "rendered");
    assert.deepEqual(r.sent, { sent: 1, failed: 0, skipped: 0 });
    const uri = renderBirdAvatar({ species: "crow", seed: 7 });
    assert.equal(await setting(db, "profile_avatar_url"), uri);
    assert.equal(JSON.parse(sent[0].content).payload.avatar, uri, "the broadcast carries the bird");

    r = await refreshBirdAvatar(db, managers);
    assert.deepEqual(r, { changed: false, reason: "same" });
    assert.equal(sent.length, 1, "no second broadcast for the same bird");

    await plantBird(db, { eggId: "b2", species: "raven", seed: 9 });
    r = await refreshBirdAvatar(db, managers);
    assert.equal(r.reason, "rendered");
    assert.equal(await setting(db, "profile_avatar_url"), renderBirdAvatar({ species: "raven", seed: 9 }), "a new active bird repaints");
    assert.equal(sent.length, 2);

    assert.equal((await refreshBirdAvatar({ execute: async () => { throw new Error("boom"); } }, managers)).changed, false, "never throws");
  } finally { cleanup(); }
});

test("installBirdAvatarHooks: a hatch or an activation on the bus refreshes; installs once", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await plantBird(db, { eggId: "b1", species: "penguin", seed: 11 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    assert.equal(installBirdAvatarHooks(mgrsWith(db, sent), { emitter }), true);
    assert.equal(installBirdAvatarHooks(mgrsWith(db, sent), { emitter }), false, "second install is a no-op");
    const first = renderBirdAvatar({ species: "penguin", seed: 11 });
    await settle(db, "profile_avatar_url", first);
    assert.equal(await setting(db, "profile_avatar_url"), first, "installing repaints once (a bird that changed while we were down)");
    assert.equal(sent.length, 1);
    await plantBird(db, { eggId: "b2", species: "grackle", seed: 12 });
    emitter.emit("ramble:hatched", { egg_id: "b2", species: "grackle", seed: 12 });
    const second = renderBirdAvatar({ species: "grackle", seed: 12 });
    await settle(db, "profile_avatar_url", second);
    assert.equal(await setting(db, "profile_avatar_url"), second, "a hatch repaints");
    await plantBird(db, { eggId: "b3", species: "magpie", seed: 13 });
    emitter.emit("ramble:bird-activated", { egg_id: "b3" });
    const third = renderBirdAvatar({ species: "magpie", seed: 13 });
    await settle(db, "profile_avatar_url", third);
    assert.equal(await setting(db, "profile_avatar_url"), third, "an activation repaints");
    assert.equal(sent.length, 3, "one broadcast per real change");
    assert.equal(emitter.listenerCount("ramble:hatched"), 1);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});
```

`tests/ramble-panel.test.js` — with the other dynamic imports (AFTER the env writes) add `const { default: bus } = await import("../servers/shared/event-bus.js");`. In the test `"POST /api/ramble/birds/:id/activate 200s a hatched bird, emits the pet, and the pet/flock follow"`, before the `const res = await req(…/activate…)` line add

```js
  const activated = [];
  const onActivated = (p) => activated.push(p);
  bus.on("ramble:bird-activated", onActivated);
```
and after the `assert.deepEqual(await res.json(), { bird: … })` line add

```js
  bus.off("ramble:bird-activated", onActivated);
  assert.deepEqual(activated, [{ egg_id: "panel-bird" }], "activation pokes the bus so core can repaint a bird avatar (spec §5)");
```
(The routes reach the bus through `appImport("servers/shared/event-bus.js")` with `CROW_APP_ROOT = REPO_ROOT`: the same module instance as this import.)

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/profile-avatar-bird.test.js tests/ramble-panel.test.js` → FAIL.

- [ ] **Step 3: Implement**

Create `servers/sharing/profile-avatar.js`:

```js
/**
 * The Ramble bird as the profile picture (spec 2026-09-08 §5, decision D6).
 *
 * Core-side on purpose: the picture is a Crow profile setting and the
 * broadcast needs the ONE live NostrManager. Ramble is reached two ways, both
 * skew-proof: the active bird is read by raw SQL from ramble_pet/ramble_eggs
 * (tables since 0.2.0; any error = no bird), and the drawing engine is the
 * bundle's dependency-free bird-svg.cjs loaded from the INSTALLED copy first
 * (what the gateway runs), then the repo tree — using only `rollGenome` and
 * `drawBird`, exports that have existed since the engine shipped, so an older
 * installed copy still renders (Plan A ruling R1-1: core needs no NEW bundle
 * export). Triggers: the in-process bus events `ramble:hatched` (the panel
 * routes and the transport already poke it) and `ramble:bird-activated` (the
 * activate route). A hatch inside the stdio Ramble MCP process has no bus to
 * this process; the next gateway-side hatch/activation/profile save repaints.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import bus from "../shared/event-bus.js";
import { validateAvatar } from "./avatar.js";
import { upsertSetting, deleteLocalSetting } from "../gateway/dashboard/settings/registry.js";
import { broadcastProfile } from "./peer-profile.js";

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));

/** Same order as servers/gateway/boot/feature-mounts.js: installed copy, then the repo. */
export function birdEngineCandidates() {
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  return [
    join(crowHome, "bundles", "ramble", "server", "bird-svg.cjs"),
    join(__dir, "..", "..", "bundles", "ramble", "server", "bird-svg.cjs"),
  ];
}

let _engine; // undefined = not tried yet; null = unavailable
export function loadBirdEngine({ candidates = birdEngineCandidates(), fresh = false } = {}) {
  if (_engine !== undefined && !fresh) return _engine;
  _engine = null;
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const mod = require(p);
      if (typeof mod?.rollGenome === "function" && typeof mod?.drawBird === "function") { _engine = mod; break; }
    } catch { /* try the next candidate */ }
  }
  return _engine;
}

/** The active, hatched bird, or null (no Ramble tables, no pet, nothing hatched). Never throws. */
export async function readActiveBird(db) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT e.egg_id, e.species, e.seed FROM ramble_pet p
            JOIN ramble_eggs e ON e.egg_id = p.active_egg_id
            WHERE p.owner = 'self' AND e.status = 'hatched' AND e.species IS NOT NULL AND e.seed IS NOT NULL
            LIMIT 1`,
      args: [],
    });
    const r = rows?.[0];
    return r ? { egg_id: r.egg_id, species: String(r.species), seed: Number(r.seed) } : null;
  } catch { return null; }
}

/** Pure: the "happy" portrait as an SVG data URI, validated; null on any engine complaint. */
export function renderBirdAvatar(bird, engine = loadBirdEngine()) {
  if (!bird || !engine) return null;
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + engine.drawBird(engine.rollGenome(bird.seed, bird.species), "happy") + "</svg>";
    return validateAvatar("data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"));
  } catch { return null; }
}

export async function renderActiveBirdAvatar(db) {
  return renderBirdAvatar(await readActiveBird(db));
}

async function readProfilePictureSettings(db) {
  const out = { avatar: null, source: "picture" };
  const { rows } = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key IN ('profile_avatar_url', 'profile_avatar_source')",
    args: [],
  });
  for (const r of rows || []) {
    if (r.key === "profile_avatar_url") out.avatar = typeof r.value === "string" ? r.value : null;
    else if (r.key === "profile_avatar_source" && r.value === "bird") out.source = "bird";
  }
  return out;
}

/**
 * Bird -> picture refresh. Source `picture`: nothing. Source `bird` with no
 * bird (Ramble gone, nothing hatched, no engine): the source falls back to
 * `picture`, the last stored image stays. Otherwise: re-render; if the
 * portrait differs from what is stored, store it and broadcast ONCE.
 * Never throws.
 */
export async function refreshBirdAvatar(db, managers) {
  try {
    const { avatar, source } = await readProfilePictureSettings(db);
    if (source !== "bird") return { changed: false, reason: "source-picture" };
    const uri = await renderActiveBirdAvatar(db);
    if (!uri) {
      await upsertSetting(db, "profile_avatar_source", "picture");
      await deleteLocalSetting(db, "profile_avatar_source");
      return { changed: true, reason: "no-bird" };
    }
    if (uri === avatar) return { changed: false, reason: "same" };
    await upsertSetting(db, "profile_avatar_url", uri);
    await deleteLocalSetting(db, "profile_avatar_url");
    const sent = await broadcastProfile(db, managers?.nostrManager);
    return { changed: true, reason: "rendered", sent };
  } catch (err) {
    try { console.warn("[sharing] bird avatar refresh failed:", err?.message); } catch {}
    return { changed: false, reason: "error" };
  }
}

let _hooksInstalled = false;
/** Once per process: repaint on a hatch or an activation. Idempotent inside, so a hatch that changed nothing is free. */
export function installBirdAvatarHooks(managers, { emitter = bus } = {}) {
  if (_hooksInstalled) return false;
  _hooksInstalled = true;
  const run = () => { refreshBirdAvatar(managers?.db, managers).catch(() => {}); };
  emitter.on("ramble:hatched", run);
  emitter.on("ramble:bird-activated", run);
  // R1-Q2: the bird may have changed while this gateway was down (or in the
  // stdio MCP process, which has no bus to us) — one idempotent repaint at boot.
  run();
  return true;
}
export function __resetBirdAvatarHooksForTest() { _hooksInstalled = false; }
```

`servers/sharing/boot.js`: add `import { installBirdAvatarHooks } from "./profile-avatar.js";` and in `initSharingRuntime`, right after `await ensurePeerProfileColumns(db);`:

```js
  // 2026-09-08 §5: with the bird as profile picture, a hatch or an activation
  // (bus events from the Ramble routes / transport) repaints and re-sends it.
  installBirdAvatarHooks(managers);
```

`bundles/ramble/panel/routes.js` — the activate route becomes:

```js
  router.post("/api/ramble/birds/:id/activate", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const out = await mods.flockMod.activateBird(db, req.params.id, { emit });
    if (!out.ok) return res.status(out.reason === "not-found" ? 404 : 409).json({ error: out.reason });
    // Spec 2026-09-08 §5: core listens (servers/sharing/profile-avatar.js) and
    // repaints the profile picture when the bird is the avatar source.
    poke("ramble:bird-activated", { egg_id: req.params.id });
    res.json({ bird: out.bird });
  }));
```

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/profile-avatar-bird.test.js tests/ramble-panel.test.js tests/boot-receive-decouple.test.js tests/ramble-flock.test.js` → PASS. Also confirm the import graph loads without a cycle error: from the worktree, `CROW_DATA_DIR=$(mktemp -d) node -e "import('./servers/sharing/boot.js').then(() => console.log('ok'))"` prints `ok`.
- [ ] **Step 5: Commit** — `git add servers/sharing/profile-avatar.js tests/profile-avatar-bird.test.js && git commit servers/sharing/profile-avatar.js servers/sharing/boot.js bundles/ramble/panel/routes.js tests/profile-avatar-bird.test.js tests/ramble-panel.test.js -m "sharing: the Ramble bird as profile picture — render, refresh on hatch/activation, broadcast once"`

---

## Task 5: The Contacts panel — My profile picture + bird source, the save handler, display fallbacks, the contacts guide

**Files:**
- Create: `tests/profile-avatar-form.test.js`, `tests/contacts-peer-display.test.js`
- Modify: `servers/gateway/dashboard/panels/contacts/html.js`, `servers/gateway/dashboard/panels/contacts/client.js`, `servers/gateway/dashboard/panels/contacts/css.js`, `servers/gateway/dashboard/panels/contacts/api-handlers.js`, `servers/gateway/dashboard/panels/contacts.js`, `servers/gateway/dashboard/shared/i18n.js`, `servers/gateway/dashboard/panels/messages/data-queries.js`, `docs/guide/contacts.md`, `docs/es/guide/contacts.md`

**Interfaces:**
- Consumes: `contactName`, `contactAvatar`, `validateAvatar`, `AVATAR_MAX_BYTES` (Task 1); `broadcastProfile` (Task 2); `getMyProfile().avatar_source` (Task 3); `renderActiveBirdAvatar`, `readActiveBird`, `loadBirdEngine` (Task 4).
- Produces: `renderMyProfile(profile, lang, { birdAvailable = false } = {})`; form fields `avatar` (hidden data URI, `""` = untouched), `avatar_clear` (`"1"`), `avatar_source` (`picture`|`bird`, rendered only when `birdAvailable`); `handleContactAction` may return `{ status: 400, text }`; client functions `readProfilePicture(input)`, `flattenedJpeg(canvas, size, quality)`, `showProfilePreview(dataUri)`; i18n keys `contacts.fieldPicture`, `contacts.pictureHint`, `contacts.pictureTooBig`, `contacts.pictureUnreadable`, `contacts.removePicture`, `contacts.pictureSource`, `contacts.sourcePicture`, `contacts.sourceBird`, `contacts.peerName`.

- [ ] **Step 1: Failing tests**

Create `tests/profile-avatar-form.test.js`:

```js
/**
 * Spec 2026-09-08 §4.1 (the My profile form + save), §4.6 (the guide).
 * Render assertions on the real html/client/css builders; the save handler on
 * a real init-db schema with the settings sync manager unset and injected
 * managers (a sendControl spy stands in for the Nostr manager).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { renderMyProfile } from "../servers/gateway/dashboard/panels/contacts/html.js";
import { contactsClientJs } from "../servers/gateway/dashboard/panels/contacts/client.js";
import { contactsCss } from "../servers/gateway/dashboard/panels/contacts/css.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { getMyProfile } from "../servers/gateway/dashboard/panels/contacts/data-queries.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { AVATAR_MAX_BYTES } from "../servers/sharing/avatar.js";
import { renderBirdAvatar } from "../servers/sharing/profile-avatar.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const PNG = "data:image/png;base64," + "A".repeat(64);
const REPO = join(import.meta.dirname, "..");

test("renderMyProfile: file input + hidden data field capped by data-max; the bird radios only with a bird; remove-picture only with a picture; a legacy URL never renders", () => {
  const base = renderMyProfile({ display_name: "Kevin", avatar_url: "", bio: "", avatar_source: "picture" }, "en");
  assert.match(base, /<input type="file" id="profilePictureInput"[^>]*data-max="32768"/);
  assert.equal(AVATAR_MAX_BYTES, 32768);
  assert.ok(base.includes('<input type="hidden" name="avatar" id="profileAvatarData" value="">'));
  assert.ok(!base.includes('name="avatar_url"'), "the URL text field is gone from My profile");
  assert.ok(!base.includes('name="avatar_source"'), "no source field without a bird");
  assert.ok(!base.includes('name="avatar_clear"'), "nothing to remove");
  assert.ok(base.includes('data-too-big="' + t("contacts.pictureTooBig", "en") + '"'));
  assert.ok(base.includes('onchange="readProfilePicture(this)"'));

  const withPic = renderMyProfile({ display_name: "Kevin", avatar_url: PNG, bio: "", avatar_source: "picture" }, "en", { birdAvailable: true });
  assert.ok(withPic.includes('<img src="' + PNG + '" alt="">'), "the preview renders the inline picture");
  assert.ok(withPic.includes('name="avatar_clear" value="1"'));
  assert.match(withPic, /name="avatar_source" value="picture" checked/);
  assert.match(withPic, /name="avatar_source" value="bird">/);
  const bird = renderMyProfile({ display_name: "K", avatar_url: PNG, bio: "", avatar_source: "bird" }, "es", { birdAvailable: true });
  assert.match(bird, /name="avatar_source" value="bird" checked/);
  assert.ok(bird.includes(t("contacts.sourceBird", "es")));

  const legacy = renderMyProfile({ display_name: "Kevin", avatar_url: "https://example.com/me.png", bio: "" }, "en");
  assert.ok(!legacy.includes("https://example.com/me.png"), "a URL is not rendered anywhere");
  assert.ok(legacy.includes(">KE<"), "initials instead");
});

test("contacts client script: the picture reader has no backticks, no interpolation, no markup sinks; the css carries the new rules", () => {
  const js = contactsClientJs();
  assert.ok(!js.includes("`"), "zero backticks inside the script");
  assert.ok(!js.includes("${"), "zero template interpolation");
  assert.deepEqual(js.match(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/g) || [], [], "zero markup sinks");
  for (const pin of [
    "function readProfilePicture(input)", "getAttribute('data-max')", "canvas.toDataURL('image/jpeg', 0.82)",
    "canvas.toDataURL('image/png')", "function flattenedJpeg(canvas, size, quality)", "function showProfilePreview(dataUri)",
    "img.src = dataUri", "hidden.value = out", "var size = 128;", "if (data[i] < 255) { transparent = true; break; }",
  ]) assert.ok(js.includes(pin), pin);
  const css = contactsCss();
  for (const sel of [".my-profile-hint", ".my-profile-msg", ".my-profile-source", ".my-profile-check", "#profilePictureInput"]) assert.ok(css.includes(sel), sel);
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "profile-form-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir; // deleteLocalSetting resolves the local instance id from here
  setSettingsSyncManager(null);
  return {
    db,
    cleanup() {
      try { db.close(); } catch {}
      setSettingsSyncManager(null);
      if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const save = (db, body, managers) => handleContactAction({ body: { action: "save_profile", ...body } }, db, { managers });
const seedPal = (db) => db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', ?, ?)", args: ["d".repeat(64), "02" + "a".repeat(64)] });
const spyMgrs = (db, sent) => ({ db, nostrManager: { sendControl: async (c, content) => { sent.push(JSON.parse(content)); return { eventId: "e", relays: ["r"] }; } } });

test("save_profile: a valid data URI is stored globally; junk is a 400; clear empties; an unknown source is a 400; ONE broadcast per changed save, none for an unchanged one", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedPal(db);
    const sent = [];
    const managers = spyMgrs(db, sent);

    let out = await save(db, { display_name: "Kevin", avatar: PNG, bio: "hi" }, managers);
    assert.equal(out.redirect, "/dashboard/contacts?view=profile");
    let p = await getMyProfile(db);
    assert.equal(p.avatar_url, PNG);
    assert.equal(p.avatar_source, "picture");
    assert.equal(sent.length, 1, "one broadcast");
    assert.deepEqual(sent[0].payload, { v: 1, display_name: "Kevin", avatar: PNG });

    out = await save(db, { display_name: "Kevin", avatar: "", bio: "hi" }, managers);
    assert.equal(sent.length, 1, "nothing changed (an empty avatar field means untouched) -> no broadcast");
    assert.equal((await getMyProfile(db)).avatar_url, PNG);

    out = await save(db, { avatar: "https://example.com/me.png" }, managers);
    assert.equal(out.status, 400);
    assert.match(out.text, /data:image/);
    assert.equal((await getMyProfile(db)).avatar_url, PNG, "a rejected save changes nothing");
    out = await save(db, { avatar: "data:image/png;base64," + "A".repeat(40000) }, managers);
    assert.equal(out.status, 400);
    out = await save(db, { avatar_source: "hat" }, managers);
    assert.equal(out.status, 400);
    assert.equal(sent.length, 1);

    out = await save(db, { display_name: "Kevin", avatar_clear: "1" }, managers);
    p = await getMyProfile(db);
    assert.equal(p.avatar_url, "", "cleared");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].payload, { v: 1, display_name: "Kevin", avatar: null }, "a removed picture propagates as null");

    const o = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE 'profile_%'");
    assert.equal(Number(o.rows[0].c), 0, "no stranded overrides (D2)");
    assert.equal((await save(db, { display_name: "Kevin" }, null)).redirect, "/dashboard/contacts?view=profile", "no managers: saves, no broadcast, no throw");
  } finally { cleanup(); }
});

test("the panel handler renders a 400 inside the dashboard layout, not as a bare string (R1-S2)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const { default: panel } = await import("../servers/gateway/dashboard/panels/contacts.js");
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, redirectAfterPost() { throw new Error("unexpected redirect"); } };
    await panel.handler({ method: "POST", body: { action: "save_profile", avatar: "https://example.com/me.png" }, query: {} }, res, {
      db, lang: "en", layout: ({ title, content }) => "<html><title>" + title + "</title>" + content + "</html>",
    });
    assert.equal(res.code, 400);
    assert.ok(res.body.startsWith("<html>"), "wrapped by the layout");
    assert.ok(res.body.includes("data:image/") && res.body.includes('href="/dashboard/contacts?view=profile"'));
  } finally { cleanup(); }
});

test("save_profile with avatar_source=bird renders the active bird into the picture and broadcasts; with no bird the source falls back to picture", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedPal(db);
    const sent = [];
    const managers = spyMgrs(db, sent);
    await save(db, { avatar: PNG }, managers);
    assert.equal(sent.length, 1);

    await save(db, { avatar_source: "bird" }, managers);
    let p = await getMyProfile(db);
    assert.equal(p.avatar_source, "picture", "no bird: silent fallback");
    assert.equal(p.avatar_url, PNG, "the stored picture stays");
    assert.equal(sent.length, 1, "nothing changed, nothing sent");

    await initRambleTables(db);
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'hummingbird', 77, 1, 2)");
    await db.execute("INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'b1')");
    await save(db, { avatar_source: "bird" }, managers);
    p = await getMyProfile(db);
    assert.equal(p.avatar_source, "bird");
    assert.equal(p.avatar_url, renderBirdAvatar({ species: "hummingbird", seed: 77 }));
    assert.equal(sent.length, 2, "one broadcast for the bird");
    assert.equal(sent[1].payload.avatar, p.avatar_url);

    await save(db, { avatar_source: "picture" }, managers);
    p = await getMyProfile(db);
    assert.equal(p.avatar_source, "picture");
    assert.equal(p.avatar_url, renderBirdAvatar({ species: "hummingbird", seed: 77 }), "back to picture keeps the last stored image");
    assert.equal(sent.length, 3, "the source change alone is a change");
  } finally { cleanup(); }
});

test("docs: the contacts guide points at Contacts > My Profile, never Settings > Identity; en/es heading parity", () => {
  const en = readFileSync(join(REPO, "docs/guide/contacts.md"), "utf8");
  const es = readFileSync(join(REPO, "docs/es/guide/contacts.md"), "utf8");
  assert.ok(en.includes("**Contacts** > **My Profile**"));
  assert.ok(!en.includes("**Settings** > **Identity**"));
  assert.ok(es.includes("**Contactos** > **Mi perfil**"));
  assert.ok(!es.includes("**Ajustes** > **Identidad**"));
  assert.ok(en.includes("128 px") && es.includes("128 px"));
  const levels = (s) => s.split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => l.split(" ")[0]);
  assert.deepEqual(levels(es), levels(en), "en/es contacts guides keep the same heading structure");
});
```

Create `tests/contacts-peer-display.test.js`:

```js
/**
 * Spec 2026-09-08 §4.5 (D5): everywhere the Contacts panel and the Messages
 * list show a contact, a typed name/picture wins, a placeholder yields to what
 * the peer sent, and the crow id is the last resort.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { renderContactList, renderContactProfile, renderDeleteConfirm, renderGroupManager } from "../servers/gateway/dashboard/panels/contacts/html.js";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

const PNG = "data:image/png;base64," + "A".repeat(64);
const base = { id: 7, contact_type: "crow", crow_id: "crow:abcd1234", ed25519_pubkey: "b".repeat(64), secp256k1_pubkey: "02" + "c".repeat(64), verified: 0, group_ids: null };
const preview = { messages: 0, sharedItems: 0, groups: 0, projectsOwned: 0, projectMemberships: 0 };

test("a placeholder local name + a peer name/picture: the list, the profile, the delete interstitial and the group roster show the peer's", () => {
  const peer = { ...base, display_name: "crow:abcd1234", peer_display_name: "Kevin", peer_avatar: PNG };
  const list = renderContactList([peer], [], {}, "en", {});
  assert.ok(list.includes('contact-card-name">Kevin'), "card name");
  assert.ok(list.includes('data-name="kevin"'), "client-side search key");
  assert.ok(list.includes('<img src="' + PNG + '"'), "card picture");
  const profile = renderContactProfile(peer, [], [], [], "en", "");
  assert.ok(profile.includes("<h2>Kevin</h2>"));
  assert.ok(profile.includes('<img src="' + PNG + '"'));
  assert.ok(!profile.includes("Their name"), "no separate row when the peer name is what is shown");
  const del = renderDeleteConfirm(peer, preview, "en", "");
  assert.ok(del.includes("<h2>Kevin</h2>"));
  const groups = renderGroupManager([{ id: 1, name: "G", member_count: 1 }], [{ ...peer, group_ids: "1" }], "en");
  assert.ok(groups.includes('title="Kevin"'));
  assert.ok(groups.includes('<img src="' + PNG + '"'));
});

test("a typed local name wins and the peer's own name is shown as a detail row; a typed picture beats the peer's; no peer fields = today", () => {
  const typed = { ...base, display_name: "My Friend", avatar_url: "data:image/jpeg;base64," + "B".repeat(64), peer_display_name: "Kevin", peer_avatar: PNG };
  const profile = renderContactProfile(typed, [], [], [], "en", "");
  assert.ok(profile.includes("<h2>My Friend</h2>"));
  assert.ok(profile.includes("Their name") && profile.includes(">Kevin<"), "the peer's name is visible as a detail");
  assert.ok(profile.includes('<img src="data:image/jpeg;base64,' + "B".repeat(64) + '"'));
  assert.ok(!profile.includes(PNG));
  const plain = renderContactProfile({ ...base, display_name: "crow:abcd1234" }, [], [], [], "en", "");
  assert.ok(plain.includes("<h2>crow:abcd1234</h2>"), "no peer fields: the crow id, as today");
  assert.ok(!plain.includes("<img"));
});

test("the Messages conversation list names a peer contact by the display rule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-display-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  try {
    await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, peer_display_name) VALUES ('crow:peer-named', 'crow:peer-named', ?, ?, 'Kevin'), ('crow:typed-one', 'My Friend', ?, ?, 'Kevin'), ('crow:bare', 'crow:bare', ?, ?, NULL)", args: ["d".repeat(64), "02" + "1".repeat(64), "d".repeat(64), "02" + "2".repeat(64), "d".repeat(64), "02" + "3".repeat(64)] });
    const out = await getUnifiedConversationList(db);
    const items = Array.isArray(out) ? out : out.items;
    const byCrow = (id) => items.find((i) => i.type === "peer" && i.crowId === id);
    assert.equal(byCrow("crow:peer-named")?.displayName, "Kevin");
    assert.equal(byCrow("crow:typed-one")?.displayName, "My Friend");
    assert.equal(byCrow("crow:bare")?.displayName, "crow:bare", "no peer name: the stored placeholder, byte-identical to today");
  } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/profile-avatar-form.test.js tests/contacts-peer-display.test.js tests/i18n-global-parity.test.js` → FAIL.

- [ ] **Step 3: Implement**

`servers/gateway/dashboard/shared/i18n.js` — after `"contacts.profileNotSet": …` add:

```js
  "contacts.fieldPicture": { en: "Picture", es: "Imagen" },
  "contacts.pictureHint": { en: "Shrunk to 128 px in your browser. Contacts receive it when you pair and whenever it changes.", es: "Se reduce a 128 px en tu navegador. Tus contactos la reciben al emparejar y cada vez que cambia." },
  "contacts.pictureTooBig": { en: "That picture is still too large after shrinking. Try a simpler image.", es: "Esa imagen sigue siendo demasiado grande tras reducirla. Prueba con una más sencilla." },
  "contacts.pictureUnreadable": { en: "Could not read that image.", es: "No se pudo leer esa imagen." },
  "contacts.removePicture": { en: "Remove picture", es: "Quitar imagen" },
  "contacts.pictureSource": { en: "Show contacts", es: "Mostrar a los contactos" },
  "contacts.sourcePicture": { en: "My picture", es: "Mi imagen" },
  "contacts.sourceBird": { en: "My Ramble bird", es: "Mi pájaro de Ramble" },
  "contacts.peerName": { en: "Their name", es: "Su nombre" },
```

`servers/gateway/dashboard/panels/contacts/html.js`:
1. Imports: add `import { contactName, contactAvatar } from "../../../../sharing/contact-display.js";` and `import { validateAvatar, AVATAR_MAX_BYTES } from "../../../../sharing/avatar.js";`.
2. `avatarHtml` becomes:

```js
function avatarHtml(contact, size = "small") {
  const cls = size === "large" ? "profile-avatar-large" : "contact-avatar";
  const color = avatarColor(contact.id);
  // 2026-09-08 §4.5: the picture the user set, else the one the peer sent —
  // inline data: images only (contactAvatar validates), always via <img src>.
  const pic = contactAvatar(contact);
  if (pic) {
    return `<div class="${cls}" style="background:${color}"><img src="${escapeHtml(pic)}" alt="" loading="lazy"></div>`;
  }
  const name = contactName(contact) || contact.name || "";
  return `<div class="${cls}" style="background:${color}">${escapeHtml(initials(name))}</div>`;
}
```
3. `renderContactList` card: `data-name="${escapeHtml((contactName(c) || "").toLowerCase())}"` and `<div class="contact-card-name">${escapeHtml(contactName(c) || "Unknown")}${…verified…}</div>`.
4. `renderContactProfile`: the header `<h2>${escapeHtml(contactName(contact) || "Unknown")}</h2>`; in the details block, after the Crow ID push add

```js
  // 2026-09-08 §4.5: when the user typed their own name for this contact, the
  // name the peer chose is still worth a glance.
  if (contact.peer_display_name && contact.peer_display_name !== contactName(contact)) {
    details.push({ label: t("contacts.peerName", lang), value: contact.peer_display_name });
  }
```
5. `renderDeleteConfirm`: `<h2>${escapeHtml(contactName(contact) || "Unknown")}</h2>`.
6. `renderGroupManager`: `title="${escapeHtml(contactName(c) || "")}"`.
7. `renderMyProfile` becomes:

```js
export function renderMyProfile(profile, lang, { birdAvailable = false } = {}) {
  const name = profile.display_name || "";
  // 2026-09-08 §4.1: only an inline picture renders (a legacy URL cannot pass the dashboard CSP).
  const avatar = validateAvatar(profile.avatar_url);
  const source = profile.avatar_source === "bird" ? "bird" : "picture";
  const bio = profile.bio || "";

  const preview = `<div class="my-profile-preview">
    <div class="profile-avatar-large" id="profileAvatarPreview" style="background:var(--crow-accent)">
      ${avatar
        ? `<img src="${escapeHtml(avatar)}" alt="">`
        : `<span style="font-size:1.5rem;font-weight:700">${escapeHtml(initials(name || "Me"))}</span>`}
    </div>
    <div>
      <div style="font-weight:600;font-size:1.1rem;color:var(--crow-text-primary)">${escapeHtml(name || t("contacts.profileNotSet", lang))}</div>
      ${bio ? `<div style="font-size:0.85rem;color:var(--crow-text-secondary);margin-top:0.25rem">${escapeHtml(bio)}</div>` : ""}
    </div>
  </div>`;

  const labelStyle = "display:block;font-size:var(--crow-text-sm);color:var(--crow-text-muted);margin-bottom:var(--crow-space-1);text-transform:uppercase;letter-spacing:0.05em";
  // The browser shrinks the chosen file to a 128 px data: URI into the hidden
  // `avatar` field (client.js readProfilePicture); "" means untouched.
  const pictureField = `<div style="margin-bottom:var(--crow-space-4)">
    <label for="profilePictureInput" style="${labelStyle}">${escapeHtml(t("contacts.fieldPicture", lang))}</label>
    <input type="file" id="profilePictureInput" accept="image/png,image/jpeg,image/webp,image/gif" data-max="${AVATAR_MAX_BYTES}" data-too-big="${escapeHtml(t("contacts.pictureTooBig", lang))}" data-bad-image="${escapeHtml(t("contacts.pictureUnreadable", lang))}" onchange="readProfilePicture(this)">
    <input type="hidden" name="avatar" id="profileAvatarData" value="">
    <p class="my-profile-hint">${escapeHtml(t("contacts.pictureHint", lang))}</p>
    <p class="my-profile-msg" id="profilePictureMsg" role="status"></p>
    ${avatar ? `<label class="my-profile-check"><input type="checkbox" name="avatar_clear" value="1"> ${escapeHtml(t("contacts.removePicture", lang))}</label>` : ""}
  </div>`;

  // Offered only when a bird has hatched AND the engine can draw it (the panel
  // handler decides). The field is OMITTED otherwise, so a save from a Crow
  // without Ramble never flips a bird source chosen on another instance.
  const sourceField = birdAvailable ? `<fieldset class="my-profile-source">
    <legend>${escapeHtml(t("contacts.pictureSource", lang))}</legend>
    <label><input type="radio" name="avatar_source" value="picture"${source === "picture" ? " checked" : ""}> ${escapeHtml(t("contacts.sourcePicture", lang))}</label>
    <label><input type="radio" name="avatar_source" value="bird"${source === "bird" ? " checked" : ""}> ${escapeHtml(t("contacts.sourceBird", lang))}</label>
  </fieldset>` : "";

  const form = `<form method="POST" class="my-profile-form" id="myProfileForm">
    <input type="hidden" name="action" value="save_profile">
    ${formField(t("contacts.profileName", lang), "display_name", { value: name, placeholder: t("contacts.profileNamePlaceholder", lang) })}
    ${pictureField}
    ${sourceField}
    ${formField(t("contacts.profileBio", lang), "bio", { type: "textarea", value: bio, rows: 3, placeholder: t("contacts.profileBioPlaceholder", lang) })}
    <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("common.save", lang)}</button>
  </form>`;

  return preview + form;
}
```

`servers/gateway/dashboard/panels/contacts/client.js` — before the closing `</script>` add (inside the template literal: single quotes only, no backticks, no `${`):

```js
  // === My profile: shrink a chosen picture to a 128 px square data: URI (spec 2026-09-08 §4.1) ===
  // The server caps the stored string (data-max = AVATAR_MAX_BYTES) and re-validates;
  // this is the friendly half. Cover-fit; JPEG 0.82 for an opaque image; PNG when the
  // source has transparency, flattened JPEG fallbacks when that is still too big; a
  // message and an empty field when nothing fits.
  function readProfilePicture(input) {
    var msg = document.getElementById('profilePictureMsg');
    var hidden = document.getElementById('profileAvatarData');
    if (!input.files || !input.files[0] || !hidden) return;
    var max = parseInt(input.getAttribute('data-max'), 10) || 32768;
    var file = input.files[0];
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var size = 128;
      var canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext('2d');
      var s = Math.min(img.naturalWidth, img.naturalHeight);
      var sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      var data = ctx.getImageData(0, 0, size, size).data;
      var transparent = false;
      for (var i = 3; i < data.length; i += 4) { if (data[i] < 255) { transparent = true; break; } }
      var out = transparent ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.82);
      if (out.length > max) out = flattenedJpeg(canvas, size, 0.82);
      if (out.length > max) out = flattenedJpeg(canvas, size, 0.6);
      if (out.length > max) {
        hidden.value = '';
        if (msg) msg.textContent = input.getAttribute('data-too-big') || 'Picture too large';
        return;
      }
      hidden.value = out;
      showProfilePreview(out);
      var pick = document.querySelector('input[name="avatar_source"][value="picture"]');
      if (pick) pick.checked = true;
      var clear = document.querySelector('input[name="avatar_clear"]');
      if (clear) clear.checked = false;
      if (msg) msg.textContent = '';
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      hidden.value = '';
      if (msg) msg.textContent = input.getAttribute('data-bad-image') || 'Could not read that image';
    };
    img.src = url;
  }

  // A transparent source flattened onto white before JPEG (a bare toDataURL paints black).
  function flattenedJpeg(canvas, size, quality) {
    var flat = document.createElement('canvas');
    flat.width = size; flat.height = size;
    var ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', quality);
  }

  // The preview box gets a fresh <img> (a src assignment is not a markup sink).
  function showProfilePreview(dataUri) {
    var box = document.getElementById('profileAvatarPreview');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var img = document.createElement('img');
    img.alt = '';
    img.src = dataUri;
    box.appendChild(img);
  }
```

`servers/gateway/dashboard/panels/contacts/css.js` — after the `.my-profile-preview { … }` rule add:

```css
  .my-profile-hint { font-size: 0.8rem; color: var(--crow-text-muted); margin: 0.35rem 0 0; }
  .my-profile-msg { font-size: 0.8rem; color: var(--crow-error); min-height: 1em; margin: 0.25rem 0 0; }
  .my-profile-check { display: block; font-size: 0.85rem; color: var(--crow-text-secondary); margin-top: 0.5rem; }
  .my-profile-source { display: flex; gap: 1rem; flex-wrap: wrap; border: 1px solid var(--crow-border); border-radius: 8px; padding: 0.5rem 0.75rem; margin: 0 0 var(--crow-space-4); font-size: 0.85rem; color: var(--crow-text-primary); }
  .my-profile-source legend { font-size: var(--crow-text-sm); color: var(--crow-text-muted); text-transform: uppercase; letter-spacing: 0.05em; padding: 0 0.25rem; }
  #profilePictureInput { font-size: 0.85rem; color: var(--crow-text-secondary); }
```

`servers/gateway/dashboard/panels/contacts/api-handlers.js`:
1. Imports: `import { getContacts, getMyProfile } from "./data-queries.js";`; add `import { validateAvatar, AVATAR_MAX_BYTES } from "../../../../sharing/avatar.js";`, `import { broadcastProfile } from "../../../../sharing/peer-profile.js";`, `import { renderActiveBirdAvatar } from "../../../../sharing/profile-avatar.js";`.
2. The `save_profile` branch becomes (the `display_name` and `bio` sub-blocks are unchanged; the old `avatar_url` sub-block is REMOVED — a raw URL must never reach the setting again):

```js
  // --- Own profile ---
  if (action === "save_profile") {
    // F-SETTINGS-1 (Cluster B D2): each save also clears any stranded
    // broken-era local override — during the era when these keys were not
    // sync-allowlisted, upsertSetting silently downgraded profile saves to
    // dashboard_settings_overrides rows that no reader consults. The global
    // row (which readers use and peers sync) must be effective from this save.
    //
    // 2026-09-08 §4.1/§4.3: the picture is an inline data: image (validated,
    // capped), the source is picture|bird, and ONE profile broadcast goes out
    // per save that changed the name, the picture or the source.
    const before = await getMyProfile(db);
    if (req.body.display_name !== undefined) {
      // This value is SENT on every handshake and syncs to all of the user's
      // instances — cap + strip it at write (design §D5). sanitizeDisplayName
      // returns null when nothing survives; store "" rather than the literal
      // "null" so the setting is cleared, not poisoned.
      await upsertSetting(db, "profile_display_name", sanitizeDisplayName(req.body.display_name) ?? "");
      await deleteLocalSetting(db, "profile_display_name");
    }
    if (req.body.avatar_clear === "1") {
      await upsertSetting(db, "profile_avatar_url", "");
      await deleteLocalSetting(db, "profile_avatar_url");
    } else if (typeof req.body.avatar === "string" && req.body.avatar !== "") {
      // "" = the hidden field was never filled = untouched.
      const clean = validateAvatar(req.body.avatar);
      if (!clean) return { status: 400, text: `avatar must be a data:image/(png|jpeg|webp|svg+xml);base64 URI of at most ${AVATAR_MAX_BYTES} characters` };
      await upsertSetting(db, "profile_avatar_url", clean);
      await deleteLocalSetting(db, "profile_avatar_url");
    }
    if (req.body.avatar_source !== undefined) {
      if (req.body.avatar_source !== "picture" && req.body.avatar_source !== "bird") return { status: 400, text: "avatar_source must be picture or bird" };
      let effective = req.body.avatar_source;
      if (effective === "bird") {
        const uri = await renderActiveBirdAvatar(db);
        if (uri) {
          await upsertSetting(db, "profile_avatar_url", uri);
          await deleteLocalSetting(db, "profile_avatar_url");
        } else {
          effective = "picture"; // no bird / no engine: silent fallback, the stored picture stays (spec §5)
        }
      }
      await upsertSetting(db, "profile_avatar_source", effective);
      await deleteLocalSetting(db, "profile_avatar_source");
    }
    if (req.body.bio !== undefined) {
      await upsertSetting(db, "profile_bio", req.body.bio.trim());
      await deleteLocalSetting(db, "profile_bio");
    }
    const after = await getMyProfile(db);
    const changed = ["display_name", "avatar_url", "avatar_source"].some((k) => (before[k] ?? "") !== (after[k] ?? ""));
    if (changed) {
      try { await broadcastProfile(db, managers?.nostrManager); }
      catch (err) { console.warn("[contacts] profile broadcast failed:", err.message); }
    }
    return { redirect: "/dashboard/contacts?view=profile" };
  }
```

`servers/gateway/dashboard/panels/contacts.js`:
- imports: `import { section, escapeHtml } from "../shared/components.js";`
- after `const result = await handleContactAction(req, db);` add (R1-S2: Turbo Drive renders a non-redirect 4xx as page content, so the message must arrive inside the dashboard chrome, never as a bare string):

```js
      if (result?.status) {
        const content = `<div class="contacts-empty"><p>${escapeHtml(result.text)}</p><p><a href="/dashboard/contacts?view=profile" class="btn btn-sm btn-secondary">${t("common.back", lang)}</a></p></div>`;
        return res.status(result.status).send(layout({ title: t("nav.contacts", lang), content }));
      }
```
- the `view === "profile"` branch becomes

```js
      const profile = await getMyProfile(db);
      // 2026-09-08 §5: the bird option needs a hatched bird AND a drawable engine.
      const { readActiveBird, loadBirdEngine } = await import("../../../sharing/profile-avatar.js");
      const birdAvailable = !!(await readActiveBird(db)) && !!loadBirdEngine();
      bodyHtml = renderMyProfile(profile, lang, { birdAvailable });
```

`servers/gateway/dashboard/panels/messages/data-queries.js`: add `import { contactName } from "../../../../sharing/contact-display.js";`; in `getUnifiedConversationList` the peer query's select list `SELECT c.id as contact_id, c.crow_id, c.display_name, c.last_seen, c.is_blocked, c.is_bot, c.verified,` becomes `SELECT c.*, c.id as contact_id,` (`SELECT *` so a db without the peer columns still lists; `GROUP BY c.id` makes it legal in SQLite), and the `displayName:` line becomes

```js
        // 2026-09-08 §4.5: typed name, else the peer's own, else what showed before.
        displayName: contactName(row, { fallback: row.display_name || (row.crow_id ? row.crow_id.substring(0, 16) + "..." : "Unknown") }),
```

Docs — `docs/guide/contacts.md`, the `## Your profile` section (headings unchanged) becomes:

```
## Your profile

Your own profile is what other Crow peers see when they connect with you: your display name and your picture travel in the pairing handshake, and again to every contact whenever you change them. A contact who typed their own name or picture for you keeps theirs.

### Editing your profile

From **Crow's Nest** > **Contacts** > **My Profile**, you can update:

- **Display name** — the name shown to your peers
- **Picture** — upload an image; your browser shrinks it to a 128 px square before it is stored, so it stays small enough to travel inline with the handshake. If Ramble is installed and a bird has hatched, you can show your active bird instead.
- **Bio** — a short description

Or ask your AI:

> "Crow, update my display name to 'Kevin H.'"
```

and in `## Contact profiles` the first bullet becomes `- **Display name** and picture — the ones you set, otherwise the ones the peer sent`.

`docs/es/guide/contacts.md` — `## Tu perfil`:

```
## Tu perfil

Tu propio perfil es lo que otros pares de Crow ven cuando se conectan contigo: tu nombre para mostrar y tu imagen viajan en el intercambio de emparejamiento, y de nuevo a cada contacto cuando los cambias. Un contacto que escribió su propio nombre o imagen para ti conserva los suyos.

### Editar tu perfil

Desde **Crow's Nest** > **Contactos** > **Mi perfil**, puedes actualizar:

- **Nombre para mostrar** — el nombre que ven tus pares
- **Imagen** — sube una imagen; tu navegador la reduce a un cuadrado de 128 px antes de guardarla, para que viaje en línea con el intercambio. Si Ramble está instalado y ha eclosionado un pájaro, puedes mostrar tu pájaro activo en su lugar.
- **Bio** — una descripción breve

O pídele a tu IA:

> "Crow, actualiza mi nombre para mostrar a 'Kevin H.'"
```

and in `## Perfiles de contacto` the first bullet becomes `- **Nombre para mostrar** e imagen — los que tú fijaste, o si no, los que envió el par`.

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/profile-avatar-form.test.js tests/contacts-peer-display.test.js tests/i18n-global-parity.test.js tests/contacts-trust-ui.test.js tests/profile-save-clears-override.test.js tests/contacts-peer-add.test.js tests/bot-directory-contacts-surface.test.js tests/messages-contacts-backfill.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add tests/profile-avatar-form.test.js tests/contacts-peer-display.test.js && git commit servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/contacts/client.js servers/gateway/dashboard/panels/contacts/css.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/shared/i18n.js servers/gateway/dashboard/panels/messages/data-queries.js docs/guide/contacts.md docs/es/guide/contacts.md tests/profile-avatar-form.test.js tests/contacts-peer-display.test.js -m "contacts: My profile picture upload + bird source, peer name/picture fallbacks, the guide points at Contacts > My Profile"`

---

## Task 6: Ramble — `contact_avatar` on a contact's mark, the popup picture, the sheet copy, docs en/es, 0.8.0, registry, full suite

**Files:**
- Modify: `bundles/ramble/server/delivery.js` (`contactsByPubkey`), `bundles/ramble/panel/routes.js` (`annotateMarks`), `bundles/ramble/panel/static/ramble.js` (`popupFor`), `bundles/ramble/panel/static/ramble.css`, `bundles/ramble/panel/ramble.js` (the Visible sheet copy), `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`
- Test: `tests/ramble-delivery.test.js`, `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Produces: `contactsByPubkey(db) → Map<xOnlyPubkey, { crow_id, name, avatar }>` (`avatar` = a `data:image/` string ≤ 32768 chars or `null`); `/api/ramble/marks` and `/api/ramble/around` rows gain `contact_avatar` beside `contact_name` when the contact has one; the client helper `contactPortrait(mark)`.

- [ ] **Step 1: Failing tests**

`tests/ramble-delivery.test.js` — the `CORE_DDL` contacts table gains three columns: `…, is_bot INTEGER DEFAULT 0, avatar_url TEXT, peer_display_name TEXT, peer_avatar TEXT);`. Add `contactsByPubkey` to the file's `delivery.js` import list. Append:

```js
test("contactsByPubkey: the display rule (typed name unless a placeholder, then the peer's, then the id) and an inline picture (local first, then the peer's; a URL never)", async () => {
  const PNG = "data:image/png;base64," + "A".repeat(32);
  const JPG = "data:image/jpeg;base64," + "B".repeat(32);
  const k = (ch) => ch.repeat(64);
  await db.executeMultiple(`
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, peer_display_name, peer_avatar) VALUES ('crow:ph', 'crow:ph', '02${k("1")}', 'Kevin', '${PNG}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, avatar_url, peer_display_name, peer_avatar) VALUES ('crow:typed', 'My Friend', '02${k("2")}', 'https://example.com/me.png', 'Kevin', '${JPG}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, avatar_url, peer_avatar) VALUES ('crow:localpic', 'Pic', '02${k("3")}', '${PNG}', '${JPG}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:bare', 'crow:bare', '${k("4")}');`);
  const m = await contactsByPubkey(db);
  assert.deepEqual(m.get(k("1")), { crow_id: "crow:ph", name: "Kevin", avatar: PNG }, "a placeholder yields to the peer's name; the peer's picture shows");
  assert.deepEqual(m.get(k("2")), { crow_id: "crow:typed", name: "My Friend", avatar: JPG }, "a typed name wins; a URL picture falls through to the peer's");
  assert.deepEqual(m.get(k("3")), { crow_id: "crow:localpic", name: "Pic", avatar: PNG }, "a local inline picture beats the peer's");
  assert.deepEqual(m.get(k("4")), { crow_id: "crow:bare", name: "crow:bare", avatar: null }, "nothing known: the id, no picture");
  assert.equal(m.get(PK)?.avatar, null, "the file's earlier seeds carry no picture");
});

test("the Ramble mirror of the display rule cannot drift from core (R1-S5): same constants, same answers", async () => {
  const src = readFileSync(new URL("../bundles/ramble/server/delivery.js", import.meta.url), "utf8");
  assert.ok(src.includes("const AVATAR_MAX = " + AVATAR_MAX_BYTES + ";"), "the cap is mirrored verbatim");
  assert.ok(src.includes(AVATAR_RE.source), "the regex is mirrored verbatim");
  const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE is_blocked = 0 AND request_status IS NULL", args: [] });
  const m = await contactsByPubkey(db);
  let checked = 0;
  for (const r of rows) {
    const key = String(r.secp256k1_pubkey || "").slice(-64);
    const got = m.get(key);
    if (!got || got.crow_id !== r.crow_id) continue; // a shared key names the older row
    assert.equal(got.name, contactName(r), r.crow_id);
    assert.equal(got.avatar, contactAvatar(r), r.crow_id);
    checked++;
  }
  assert.ok(checked >= 4, "the round-trip covered the seeded rows");
});
```

(`db` and `PK` are file-scope; the earlier seeds share `02${PK}`, so `m.get(PK)` resolves to the first of them. The drift test needs three more imports at the top of the file: `import { readFileSync } from "node:fs";`, `import { AVATAR_MAX_BYTES, AVATAR_RE } from "../servers/sharing/avatar.js";`, `import { contactName, contactAvatar } from "../servers/sharing/contact-display.js";`.)

`tests/ramble-panel.test.js`:
- the scratch `contacts` DDL gains `avatar_url TEXT, peer_display_name TEXT, peer_avatar TEXT`; the `crow:pal` INSERT becomes `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, peer_avatar) VALUES ('crow:pal', 'Pal', '02${PK}', 'data:image/png;base64,${"A".repeat(32)}');`
- in the test `"GET /api/ramble/marks names a remote mark by a contact; a stranger's stays anonymous"` append:

```js
  assert.equal(marks.find((m) => m.mark_id === "by-pal").contact_avatar, "data:image/png;base64," + "A".repeat(32), "a contact's picture rides beside the name");
  assert.equal(marks.find((m) => m.mark_id === "by-stranger").contact_avatar, undefined);
```
- in the test `"GET /api/ramble/around names a contact's remote mark …"` append `assert.equal(pal?.contact_avatar, "data:image/png;base64," + "A".repeat(32));`
- in the `GET /ramble/static/ramble.js` test add:

```js
  // A contact's profile picture on their pin (spec 2026-09-08 §4.5/§5): an <img>
  // via createElement, accepted only as an inline data: image; the bird stays
  // for strangers. A src assignment is not a markup sink (count unchanged).
  assert.ok(body.includes('function contactPortrait(mark)'));
  assert.ok(body.includes('src.indexOf("data:image/") !== 0'));
  assert.ok(body.includes('img.className = "rb-pop-avatar"'));
  assert.ok(body.includes('var portrait = contactPortrait(mark) || birdFor(mark);'));
```
- in the test `"panel handler renders the world-first shell, its three views and every asset"` (the one asserting `id="rb-world-name"`) add `assert.ok(sent.includes("Contacts see your Crow name."));` and `assert.ok(!sent.includes("they saved for you"));`
- in the test `"GET /ramble/static/ramble.css serves the panel stylesheet"` (its stylesheet text is the `body` variable) add `assert.ok(body.includes("#ramble .rb-pop-avatar {"), "a contact's picture on the pin has its rule");`

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/ramble-delivery.test.js tests/ramble-panel.test.js` → the new assertions FAIL.

- [ ] **Step 3: Implement**

`bundles/ramble/server/delivery.js` — `contactsByPubkey` and its doc comment become:

```js
/**
 * x-only pubkey -> { crow_id, name, avatar } for every unblocked full contact,
 * bots included on purpose (naming a bot's mark is harmless). ORDER BY id +
 * first-wins so two rows sharing a key name the older one deterministically.
 * SELECT * on purpose: peer_display_name / peer_avatar / avatar_url arrived
 * with core (2026-09-08) and a db that predates them must still name contacts.
 * Tolerant: an empty map when the core table is unreadable (the stdio MCP
 * process on a fresh db).
 */
export async function contactsByPubkey(db) {
  const map = new Map();
  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE is_blocked = 0 AND request_status IS NULL ORDER BY id", args: [] });
    for (const r of rows) {
      const pk = String(r.secp256k1_pubkey || "");
      const key = pk.length === 66 ? pk.slice(2) : pk;
      if (key && !map.has(key)) map.set(key, { crow_id: r.crow_id, name: contactNameOf(r), avatar: contactAvatarOf(r) });
    }
  } catch { /* no core tables: nobody is a contact */ }
  return map;
}

/* Mirrors core's servers/sharing/contact-display.js (a bundle server file
 * cannot import core statically): a typed name unless it is a placeholder,
 * then the name the peer sent, then the id; the first INLINE picture, local
 * first — never a URL (the panel's CSP could not show one anyway). */
const AVATAR_MAX = 32768;
function isPlaceholderName(name) {
  return name == null || name === "" || String(name).startsWith("req:") || String(name).startsWith("crow:");
}
function isInlineImage(v) {
  return typeof v === "string" && v.length <= AVATAR_MAX && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v);
}
function contactNameOf(r) {
  return (!isPlaceholderName(r.display_name) ? r.display_name : null) || r.peer_display_name || r.crow_id;
}
function contactAvatarOf(r) {
  return [r.avatar_url, r.peer_avatar].find(isInlineImage) || null;
}
```

`bundles/ramble/panel/routes.js` — `annotateMarks`'s map line becomes:

```js
      const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
      // 2026-09-08 §4.5: a contact's pin carries their picture beside their name.
      return c ? { ...m, contact_name: c.name, ...(c.avatar ? { contact_avatar: c.avatar } : {}) } : m;
```

`bundles/ramble/panel/static/ramble.js` — directly above `function popupFor(mark)` add:

```js
  /* A contact's profile picture on their pin (spec 2026-09-08 §5): the server
   * already bounded it to an inline data: image, and this checks again; a
   * stranger has none and keeps the bird. createElement + a src assignment —
   * not a markup sink. */
  function contactPortrait(mark) {
    var src = mark.contact_avatar;
    if (typeof src !== "string" || src.indexOf("data:image/") !== 0) return null;
    var img = document.createElement("img");
    img.className = "rb-pop-avatar";
    img.alt = "";
    img.src = src;
    return img;
  }
```
and in `popupFor` the line `var portrait = birdFor(mark);` becomes `var portrait = contactPortrait(mark) || birdFor(mark);`.

`bundles/ramble/panel/static/ramble.css` — after the `#ramble .rb-pop-bird { … }` rule add `#ramble .rb-pop-avatar { width: 24px; height: 24px; flex: 0 0 auto; border-radius: 50%; object-fit: cover; border: var(--rb-line-w) solid var(--rb-line); }`; after `#ramble .rb-ar-sheet .rb-pop-bird { … }` add `#ramble .rb-ar-sheet .rb-pop-avatar { width: 24px; height: 24px; }`.

`bundles/ramble/panel/ramble.js` — the Visible-sheet hint sentence `Contacts see the name they saved for you.` becomes `Contacts see your Crow name.`

`docs/guide/ramble.md` — in the World name paragraph, `Contacts never see it: they see the name they saved for you.` becomes `Contacts never see it: they see your Crow name, or the name they saved for you.` `docs/es/guide/ramble.md`: `Los contactos nunca lo ven: ven el nombre que guardaron para ti.` becomes `Los contactos nunca lo ven: ven tu nombre de Crow, o el nombre que guardaron para ti.`

Bump: `sed -i 's/"version": "0.7.0"/"version": "0.8.0"/' bundles/ramble/manifest.json bundles/ramble/package.json && npm run build-registry`.

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/ramble-delivery.test.js tests/ramble-panel.test.js tests/ramble-tools.test.js tests/ramble-labels.test.js` → PASS (sinks still 2, backticks 0 in `static/ramble.js`; the docs heading-parity test still green). Then the FULL suite in the foreground (`node scripts/run-suite.mjs 2>&1 | tail -12`; expect pass = total, fail 0: Plan A's 4197 + 38 new = 4235 — avatar 2, contact-display 3, peer-columns 1, peer-profile 7, handshake +6, peer-wire 3, bird 5, form 6, peer-display 3, delivery +2 — report the actual; Review round 1 measured 4232 before the three folded tests), `node scripts/check-port-allocation.js`, `npm run build-registry -- --check`.
- [ ] **Step 5: Commit** — `git commit bundles/ramble/server/delivery.js bundles/ramble/panel/routes.js bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css bundles/ramble/panel/ramble.js docs/guide/ramble.md docs/es/guide/ramble.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json tests/ramble-delivery.test.js tests/ramble-panel.test.js -m "ramble 0.8.0: a contact's profile picture on their pin; the sheet says Crow name; docs en/es; registry"`
- [ ] **Step 6 (controller):** the Task 1 Step 6 dry-run result is in hand; push, PR, check-runs, merge, `CROW-SCHEDULE.md`, three-gateway restart, the journal lines (only grackle has an INSTALLED bundle copy, so only grackle's journal shows `refreshed ramble 0.7.0 -> 0.8.0`; crow primary and r4 run the repo copy and show `[ramble] transport started` / routes mounted / 15 tools only — Review R1-M), then read-only verification: `PRAGMA table_info(contacts)` on each live db shows the two peer columns (grackle: `grackle "sqlite3 ~/.crow/data/crow.db 'PRAGMA table_info(contacts)' | grep peer_"`). Cross-version note: an UNREFRESHED 0.7.0 bundle copy beside the new core still names contacts (its `contactsByPubkey` reads `display_name`; `contact_avatar` simply absent) and the new core's `loadBirdEngine` works against it (0.2.0-era exports) — no ordering hazard; the refreshed 0.8.0 copy beside an OLD core (impossible on the three lab gateways: the copy refreshes at the same boot) would only lack `contact_avatar` on pins. Live acceptance (Kevin, later): on grackle set a picture in Contacts → My Profile, confirm the crow primary's contact row for grackle's identity gains `peer_avatar` (read-only SELECT on `~/.crow/data/crow.db`) and grackle's mark pin on crow shows it; switch the source to the bird and confirm the swap.

## Self-review notes
- **Spec coverage.** §4.1 storage/form/validation: Tasks 1, 3, 5. §4.2 handshake both ways + peer fields + placeholder rule kept: Task 2. §4.3 profile message, `sendControl` per full contact, receiver contact-only, sync emit: Task 2. §4.4 columns, dry-run, both sync doors, `EXCLUDED_COLUMNS` unchanged: Tasks 1, 3. §4.5 display rule + Ramble `contact_avatar` + the 24 px `createElement` img: Tasks 1, 5, 6. §4.6 docs: Task 5 (contacts) + Task 6 (the Ramble sentence). §5 bird source, `activateBird` + first-hatch refresh, fallback to picture: Task 4 (+ Task 5 for the save). §6 `save_profile` accepts `avatar` + `avatar_source`; `GET …/profile` "plus avatar_source" = `getMyProfile` (Task 3). §7 bounds: every input bounded (Tasks 1, 5). §8 Plan B test list: validator (Task 1), handshake both ways incl. a bad one (Task 2), profile round-trip through the real ladder from a contact / a stranger / a blocked contact (Task 2), columns through both doors (Task 3), deterministic SVG under the cap (Task 4), the form with the source switch only with a bird (Task 5), Ramble `contact_avatar` (Task 6), the dry-run (Task 1 Step 6), docs parity (Tasks 5, 6).
- **Deviations from the spec text, recorded for approval:** (a) the bird option is decided SERVER-SIDE (`readActiveBird` + `loadBirdEngine` in the panel handler) instead of the client asking `GET /api/ramble/pet` — same information, no client fetch, testable; (b) `display_name || peer_display_name || crow_id` is applied with the existing placeholder rule (a `crow:`/`req:` display_name counts as empty), otherwise a contact created before their name arrived would never show the peer name; (c) the display rule's scope is the Contacts panel, the Messages list, `crow_list_contacts` and Ramble — the remaining `display_name || crow_id` sites (notification titles, rooms/bots admin text, share inbox, MCP tool text elsewhere) are a follow-up, not silently widened; (d) the profile envelope uses the dispatcher's existing `{ type, version, subtype, payload }` shape; (e) the bird refresh listens on the in-process bus (`ramble:hatched` already exists; `ramble:bird-activated` is new) instead of the bundle importing a core hook — no new cross-import in either direction; a hatch in the stdio MCP process does not refresh until the next gateway-side event; (f) `contactAvatar` skips a legacy `https:` `avatar_url` in favour of the peer's inline picture (a URL cannot render under the dashboard CSP anyway); (g) spec §6 names a `GET /dashboard/contacts/profile` route "unchanged in shape plus avatar_source" — no such route exists in the codebase (the reader is `getMyProfile`, which gains the key; nothing is added); (h) `profile_avatar_source` syncs as a user-level key but only a Ramble-bearing instance renders the radios or runs the refresh hooks — on a Ramble-less sibling a `bird` source is invisible and frozen until a Ramble instance saves again (Review R1-Q3).
- **Placeholder scan:** none (every step carries code; every test is written out).
- **Type consistency:** `applyPeerProfile(db, contactId, { displayName, avatar })` ↔ boot.js call sites ↔ `handleProfileMessage`; `buildHandshakeComplete(ids, name, avatar)` ↔ `ackHandshake`; `handleHandshakeComplete(db, ids, pk, displayName, avatar)` ↔ the dispatcher; `contactsByPubkey` value shape `{ crow_id, name, avatar }` ↔ `annotateMarks` ↔ `server.js` (reads `c.name` only — unchanged); `getMyProfile().avatar_source` ↔ `renderMyProfile` ↔ `save_profile` before/after; `renderBirdAvatar` ↔ `renderActiveBirdAvatar` ↔ the form test's expected URI; `{ status, text }` ↔ `contacts.js`.
- **Sizes on the wire (measured in Review round 1):** a 128 px JPEG at 0.82 is ~4–10 KB → ~6–14 KB as base64; the bird SVG ~1.6–4 KB; the 32768-char cap is the ceiling. At the cap a profile DM is 32 875 B of plaintext, which NIP-44 v2 pads to 40 960 B (its power-of-two chunking) → a serialized event of ~55.1 KB, 10.4 KB under strfry's default 64 KiB `maxEventSize`; it goes once per full contact per changed save/bird refresh, to every configured relay (20 contacts × 4 relays ≈ 4.3 MB at the cap). The retry-queue row for an `invite_accepted` and a contacts sync-conflict row (local + wire JSON) grow the same way. The cap is the spec's number (Kevin restated it); halving it to 16 384 would halve the padded bucket and still fit any 128 px JPEG — recorded as Q4, not changed here.
- **Open questions for Kevin (do not block the build):** Q1 stdio-MCP hatches not refreshing the bird avatar until the next gateway-side event or gateway boot (the hook now repaints once at install) — acceptable? Q2 the follow-up list in (c) — a separate small PR after Plan B, or fold into models plan 2's tail? Q3 the contact editor keeps its `Avatar URL` text field with an `https://...` placeholder (a local override; a URL cannot render, an inline data URI pasted there does, and the raw value is stored unbounded as today) — leave as is, or turn it into the same file input in the follow-up? Q4 keep `AVATAR_MAX_BYTES` at the spec's 32768, or lower it to 16384 (halves the NIP-44 padded bucket; a 128 px JPEG never needs more)? Q5 `bio` is stored uncapped today; with the 100 kb urlencoded body limit a crafted POST (a max-size all-`+` avatar plus a long bio) would hit an unhandled 413 — cap `bio` (e.g. 2000 chars) in the follow-up?

## Review

### Round 1 — 2026-09-08, opus, code-traced (implemented the plan verbatim in a scratch mirror; every named test passed first try; full suite 4232/0; check-ports OK; build-registry in sync)
**Verdict: REVISE.** Folded:
- **C1** `handleHandshakeComplete` wrote the peer fields with no blocked/pending gate — reached from the broad incoming subscription, a blocked contact could keep repainting its own picture and an unpaired `req:` row could store 32 KB per envelope (proved in the mirror). Fixed: the same full-and-unblocked gate as the profile receiver, plus a test seeding a blocked contact and a pending row. **Ruling R1-1 (Plan B):** every writer of `peer_*` is contact-only — full (`request_status` NULL) AND unblocked — no matter which door it came through.
- **S1** the "~46 KB" wire estimate was wrong: NIP-44 v2 pads 32 875 B to 40 960 B → ~55.1 KB serialized, 10.4 KB under strfry's 64 KiB default. Note corrected; the cap stays at the spec's 32768 (Q4 for Kevin).
- **S2** a `{ status: 400 }` was sent as a bare `text/html` string, which Turbo Drive renders as the whole page. Fixed: the panel wraps it in `layout()` with a Back link; a handler-level test pins it.
- **S3** `ensurePeerProfileColumns` swallowed every error, and on an existing host it is the only path to the columns while instance-sync caches the column list once per process. Fixed: a PRAGMA verify after the adds logs a `console.error` naming the fix.
- **S4** two of the three Task-3 "failing tests" already pass before Task 3's code (the columns exist since Task 1; the PRAGMA whitelist copies any live column). Step 2 relabelled: they are wire-contract pins, the sanitize/validate test is the gate.
- **S5** the display rule and the avatar bound were mirrored by hand in `delivery.js` with no drift guard. Fixed: the delivery test pins the mirrored constants against core's and round-trips the seeded rows through `contactsByPubkey` vs `contactName`/`contactAvatar`.
- **Q2** the bird hook only subscribed, so a bird that changed while the gateway was down stayed stale. Fixed: one idempotent `refreshBirdAvatar` at install; the hook test covers install, hatch, activation, and three broadcasts.
- **Q1** (contact editor's dead `Avatar URL` field), **Q3** (a `bird` source is frozen on a Ramble-less sibling), the uncapped `bio` vs the 100 kb body limit, and the spec's non-existent `GET /dashboard/contacts/profile` route are recorded in the deviations / Kevin's Q list, not changed.
- Traces verified by the reviewer: no import cycle (boot.js and the stdio sharing entrypoint load; the only cycle-closing edge stays contact-sync's lazy managers import); `crow_social` has exactly one door (`subscribeToIncoming`, deduped per relay by `seenEventIds`); `upsertFullContact` returns `{ contactId }` on all four outcomes; `_applyContact`'s whitelist drops peer fields on an un-migrated instance as claimed and its column cache is warmed only after sharing init; the CSP allows `data:` and `blob:` for the preview and the inline `onchange`; i18n parity passes; `SELECT c.*, c.id as contact_id … GROUP BY c.id` is legal SQLite with no alias collision; `contact_avatar` is only ever set for a resolved contact; `bird-svg.cjs` has exported `rollGenome`/`drawBird` since its first commit (a synthetic stale installed copy rendered fine — R1-1 of Plan A satisfied); only grackle has an installed bundle copy (the refresh journal line appears there alone).
