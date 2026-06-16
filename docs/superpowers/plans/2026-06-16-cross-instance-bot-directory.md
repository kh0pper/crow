# Cross-instance Bot Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browsable directory of bots advertised across the operator's trusted Crow fleet, surfaced in both the Contacts panel and the Messages "+" picker; adding/messaging a bot produces an ordinary contact flagged `is_bot=1`.

**Architecture:** Reuse the existing signed `GET /dashboard/advertised-bots` transport + `advertised-bots-cache.js`. Enrich the advertisement payload with an operator-authored tagline (in the bot def JSON, no schema). A new `getBotDirectory(db)` aggregates+groups peers' bots with an added-state; a shared `bot-directory.js` renders it for two contexts. Materialize routes through the existing `crow_accept_bot_invite`; a shared gateway helper marks the resulting contact `is_bot=1` (mirrors the existing `origin='advertised'` write). The legacy inline send-box strip + `message_advertised_bot` action are removed.

**Tech Stack:** Node built-in test runner (`node --test --test-force-exit`), `@libsql/client` (gateway/UI db), server-rendered HTML string builders, `t(key, lang)` i18n.

Spec: `docs/superpowers/specs/2026-06-16-cross-instance-bot-directory-design.md`.

**Conventions (all tasks):**
- Tests: `node --test --test-force-exit tests/<file>.test.js`. No aggregate runner.
- Commits: `git add` any NEW file first, then positional-path `git commit <paths> -m "..."`. **No `Co-Authored-By` trailer** (project policy). Verify with `git show --stat HEAD`.
- All user-visible strings escaped via `escapeHtml`; every new POST form includes `${csrf || ""}` / `csrfInput(req)`.

---

## Phase A — data foundation

### Task 1: `contacts.is_bot` column + backfill

**Files:**
- Modify: `scripts/init-db.js` (after the `addColumnIfMissing("contacts", "origin", ...)` line, ~2531)
- Test: `tests/bot-directory-schema.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/bot-directory-schema.test.js`:

```javascript
// tests/bot-directory-schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

// Mirrors the REAL init-db.js helper EXACTLY: signature (table, column,
// definition) and DDL `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
// (verified scripts/init-db.js:140-148). The third arg is the TYPE clause only
// ("INTEGER DEFAULT 0"), NOT a full "is_bot INTEGER..." decl — matching this
// here is what protects the production migration call in Step 3.
async function addColumnIfMissing(db, table, column, definition) {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`);
  if (!rows.some((r) => r.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

test("contacts.is_bot is added idempotently and backfills origin='advertised'", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, origin TEXT)`);
  await db.execute(`INSERT INTO contacts (crow_id, origin) VALUES ('crow:bot1','advertised')`);
  await db.execute(`INSERT INTO contacts (crow_id, origin) VALUES ('crow:human1', NULL)`);

  for (let i = 0; i < 2; i++) {
    await addColumnIfMissing(db, "contacts", "is_bot", "INTEGER DEFAULT 0");
    // Backfill is guarded to run once-effectively: only flips rows still at 0.
    await db.execute("UPDATE contacts SET is_bot = 1 WHERE origin = 'advertised' AND is_bot = 0");
  }

  const cols = await db.execute(`PRAGMA table_info(contacts)`);
  assert.ok(cols.rows.some((r) => r.name === "is_bot"), "contacts.is_bot exists");
  const bot = await db.execute("SELECT is_bot FROM contacts WHERE crow_id='crow:bot1'");
  assert.equal(Number(bot.rows[0].is_bot), 1, "advertised contact backfilled to is_bot=1");
  const human = await db.execute("SELECT is_bot FROM contacts WHERE crow_id='crow:human1'");
  assert.equal(Number(human.rows[0].is_bot), 0, "non-advertised contact stays is_bot=0");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-schema.test.js`
Expected: PASS actually — this test mirrors the helper inline, so it passes immediately. That is intentional: it is a *characterization* test pinning the migration semantics. Confirm it passes, then proceed (the real migration in Step 3 must match it).

- [ ] **Step 3: Add the migration to `scripts/init-db.js`**

Immediately after the `await addColumnIfMissing("bot_message_invites", "kind", "TEXT");` line (~2532), insert:

```javascript
// --- Cross-instance bot directory (phase 2, 2026-06-16) ---
// contacts.is_bot marks a contact that is a Crow Messages bot (vs a human), so
// the UI can badge it and the future group phase can treat "add a bot" and
// "add a person" uniformly. Backfill the reliably-known bots (origin='advertised').
await addColumnIfMissing("contacts", "is_bot", "INTEGER DEFAULT 0");
await db.execute({ sql: "UPDATE contacts SET is_bot = 1 WHERE origin = 'advertised' AND is_bot = 0" });
```

CRITICAL: the real `addColumnIfMissing(table, column, definition)` (scripts/init-db.js:140) builds `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, so the third arg is the TYPE CLAUSE ONLY — `"INTEGER DEFAULT 0"`, NOT `"is_bot INTEGER DEFAULT 0"` (the precedent is `addColumnIfMissing("contacts", "origin", "TEXT")` at :2531). Passing the full decl produces `ADD COLUMN is_bot is_bot INTEGER...` which the helper's try/catch swallows — the column would silently never be added. Note `db.execute` here takes an object (`{ sql }`), matching the surrounding init-db calls.

- [ ] **Step 4: Run init-db against a temp dir and ASSERT the column actually exists**

```bash
D=$(mktemp -d); CROW_DB_PATH="$D/crow.db" node scripts/init-db.js 2>&1 | tail -3
node -e 'const Database=require("better-sqlite3"); const db=new Database(process.env.D+"/crow.db",{readonly:true}); const cols=db.pragma("table_info(contacts)").map(c=>c.name); if(!cols.includes("is_bot")){console.error("FAIL: is_bot missing"); process.exit(1);} console.log("is_bot column present");' D="$D"
```
Expected: prints "is_bot column present". (This guards against C1 — the characterization test in Step 1 mirrors the helper but a real init-db run is what proves the production call is correct.)

- [ ] **Step 5: Commit**

```bash
git add tests/bot-directory-schema.test.js
git commit tests/bot-directory-schema.test.js scripts/init-db.js -m "feat(crow-messages): add contacts.is_bot column + backfill advertised bots"
git show --stat HEAD
```

---

### Task 2: advertise the tagline in the payload

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js` (`listAdvertisedBots` ~139-155, `buildAdvertisementPayload` ~170-195)
- Test: `tests/bot-directory-payload.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/bot-directory-payload.test.js`:

```javascript
// tests/bot-directory-payload.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdvertisementPayload } from "../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js";

function fakeDb(defs) {
  return {
    async execute(q) {
      // listAdvertisedBots SELECTs bot_id, display_name, definition FROM pi_bot_defs WHERE enabled=1
      return { rows: defs };
    },
  };
}

const ident = { secp256k1Pubkey: "02" + "a".repeat(64) };
const seams = {
  instanceId: "inst-1",
  instanceLabel: "Phone",
  _identityFor: () => ident,
  _buildInviteCode: async () => "crow:bot.payload.sig",
};

test("advertisement carries the tagline (description) from the gateway config", async () => {
  const db = fakeDb([{
    bot_id: "b1", display_name: "Helper",
    definition: JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true, description: "Schedules & reminders" }] }),
  }]);
  const { bots } = await buildAdvertisementPayload(db, seams);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].description, "Schedules & reminders", "tagline advertised");
});

test("advertisement omits description when the tagline is unset", async () => {
  const db = fakeDb([{
    bot_id: "b2", display_name: "Quiet",
    definition: JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] }),
  }]);
  const { bots } = await buildAdvertisementPayload(db, seams);
  assert.equal(bots.length, 1);
  assert.equal("description" in bots[0], false, "no description field when unset");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-payload.test.js`
Expected: FAIL — `description` is `undefined` (not advertised yet).

- [ ] **Step 3: Implement — carry the tagline through `listAdvertisedBots` + `buildAdvertisementPayload`**

In `listAdvertisedBots` (crow-messages-admin.js), capture the gateway's `description` alongside the matched gateway. Change the push from:

```javascript
    if (!gw) continue;
    out.push({ botId: r.bot_id, displayName: r.display_name || r.bot_id });
```
to:
```javascript
    if (!gw) continue;
    const description = (typeof gw.description === "string" && gw.description.trim())
      ? gw.description.trim().slice(0, 140) : null;
    out.push({ botId: r.bot_id, displayName: r.display_name || r.bot_id, description });
```

In `buildAdvertisementPayload`, add `description` to the pushed entry ONLY when set:

```javascript
      const entry = {
        bot_id: b.botId,
        display_name: b.displayName,
        instance_id: instanceId,
        instance_label: instanceLabel,
        messaging_pubkey: xOnly(ident.secp256k1Pubkey),
        invite_code: inviteCode,
      };
      if (b.description) entry.description = b.description;
      bots.push(entry);
```

(Replace the existing inline `bots.push({...})` with the `entry` form above.)

- [ ] **Step 4: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-payload.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/bot-directory-payload.test.js
git commit tests/bot-directory-payload.test.js servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js -m "feat(crow-messages): advertise bot tagline in the advertised-bots payload"
git show --stat HEAD
```

---

### Task 3: tagline input + save in the Bot Builder

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/editor.js` (crow-messages block, the `pairedToggle`/`gwFields` at ~404-408)
- Modify: `servers/gateway/dashboard/panels/bot-builder/api-handlers.js` (crow-messages save branch ~314-316)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new keys)
- Test: `tests/bot-directory-editor.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/bot-directory-editor.test.js`. The editor builds HTML synchronously per gateway type; test the save-branch shape (pure) which is the load-bearing behavior:

```javascript
// tests/bot-directory-editor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrowMessagesGatewayConfig } from "../servers/gateway/dashboard/panels/bot-builder/api-handlers.js";

test("crow-messages save captures the tagline (trimmed, capped) when present", () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_allow_paired_instances: "on", gw_description: "  Schedules & reminders  " });
  assert.equal(gw.type, "crow-messages");
  assert.equal(gw.allow_paired_instances, true);
  assert.equal(gw.description, "Schedules & reminders", "trimmed tagline saved");
});

test("crow-messages save omits description when blank", () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_allow_paired_instances: "", gw_description: "   " });
  assert.equal(gw.allow_paired_instances, false);
  assert.equal("description" in gw, false, "no description key when blank");
});

test("crow-messages save caps the tagline at 140 chars", () => {
  const gw = buildCrowMessagesGatewayConfig({ gw_description: "x".repeat(300) });
  assert.equal(gw.description.length, 140);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-editor.test.js`
Expected: FAIL — `buildCrowMessagesGatewayConfig` is not exported.

- [ ] **Step 3: Extract + export the save-branch builder in `api-handlers.js`**

Find the crow-messages save branch (~307-316) that currently does:

```javascript
      } else if (gwType === "crow-messages") {
        ...
        def.gateways = [{
          type: "crow-messages",
          allow_paired_instances: b.gw_allow_paired_instances === "on" || b.gw_allow_paired_instances === "true",
        }];
```

Add an exported pure helper near the top of the module (after imports) and call it from the branch:

```javascript
export function buildCrowMessagesGatewayConfig(b) {
  const gw = {
    type: "crow-messages",
    allow_paired_instances: b.gw_allow_paired_instances === "on" || b.gw_allow_paired_instances === "true",
  };
  const desc = typeof b.gw_description === "string" ? b.gw_description.trim() : "";
  if (desc) gw.description = desc.slice(0, 140);
  return gw;
}
```

Then replace the inline object in the branch with:

```javascript
        def.gateways = [buildCrowMessagesGatewayConfig(b)];
```

(Preserve any surrounding comment lines about the adapter reading `allow_paired_instances`.)

- [ ] **Step 4: Add the tagline input to the editor**

In `editor.js`, the crow-messages block builds `pairedToggle` then `gwFields = pairedToggle`. Read the existing `gw` (the saved config) — `gw.description` holds the current tagline. Change:

```javascript
      gwFields = pairedToggle;
```
to:
```javascript
      const taglineField =
        `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmTaglineLabel", lang))}</label>` +
        `<input type="text" name="gw_description" maxlength="140" ` +
        `value="${escapeHtml(typeof gw.description === "string" ? gw.description : "")}" ` +
        `placeholder="${escapeHtml(t("botbuilder.cmTaglinePlaceholder", lang))}">` +
        `<p class="btb-hint">${escapeHtml(t("botbuilder.cmTaglineHint", lang))}</p></div>`;
      gwFields = pairedToggle + taglineField;
```

- [ ] **Step 5: Add i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, add near the other `botbuilder.cm*` keys:

```javascript
  "botbuilder.cmTaglineLabel": { en: "Directory tagline (optional)", es: "Lema del directorio (opcional)" },
  "botbuilder.cmTaglinePlaceholder": { en: "e.g. Schedules, reminders & weather", es: "p. ej. Agenda, recordatorios y clima" },
  "botbuilder.cmTaglineHint": { en: "Shown to your other Crows when they browse this bot. Never includes the system prompt.", es: "Se muestra a tus otros Crows cuando exploran este bot. Nunca incluye el prompt del sistema." },
```

- [ ] **Step 6: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-editor.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add tests/bot-directory-editor.test.js
git commit tests/bot-directory-editor.test.js servers/gateway/dashboard/panels/bot-builder/api-handlers.js servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/shared/i18n.js -m "feat(crow-messages): bot directory tagline field in Bot Builder"
git show --stat HEAD
```

---

### Task 4: cache passes the tagline through

**Files:**
- Modify: `servers/gateway/dashboard/advertised-bots-cache.js` (`validateBot` ~17-34)
- Test: `tests/bot-directory-cache.test.js` (create)

- [ ] **Step 1: Write the failing test**

`validateBot` is module-private. Test it through the public `getPeerAdvertisedBots` + the `_setFetchImpl` seam:

```javascript
// tests/bot-directory-cache.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPeerAdvertisedBots, _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PK = "a".repeat(64);
function withBody(body) {
  _resetCache();
  _setFetchImpl(async () => ({ ok: true, body }));
}

test("validated advertised bot carries a sanitized description", async () => {
  withBody({ bots: [{ bot_id: "b1", display_name: "Helper", messaging_pubkey: "02" + PK, invite_code: "crow:a.b.c", description: "Schedules & reminders" }] });
  const r = await getPeerAdvertisedBots({}, "inst-1");
  assert.equal(r.status, "ok");
  assert.equal(r.bots[0].description, "Schedules & reminders");
  _setFetchImpl(null);
});

test("description is null when absent and capped when overlong", async () => {
  withBody({ bots: [
    { bot_id: "b2", display_name: "Quiet", messaging_pubkey: "02" + PK, invite_code: "crow:a.b.c" },
    { bot_id: "b3", display_name: "Long", messaging_pubkey: "03" + PK, invite_code: "crow:a.b.c", description: "x".repeat(500) },
  ] });
  const r = await getPeerAdvertisedBots({}, "inst-2");
  assert.equal(r.bots[0].description, null, "absent → null");
  assert.equal(r.bots[1].description.length, 140, "capped at 140");
  _setFetchImpl(null);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-cache.test.js`
Expected: FAIL — `description` is undefined on the validated object.

- [ ] **Step 3: Implement — add description to `validateBot`'s returned object**

In `advertised-bots-cache.js`, inside `validateBot`, add to the returned object:

```javascript
    description: (typeof b.description === "string" && b.description.trim())
      ? b.description.trim().slice(0, 140) : null,
```

(Add it as a field in the existing `return { ... }`. Everything else in `validateBot` is unchanged.)

- [ ] **Step 4: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-cache.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/bot-directory-cache.test.js
git commit tests/bot-directory-cache.test.js servers/gateway/dashboard/advertised-bots-cache.js -m "feat(crow-messages): pass bot tagline through the advertised-bots cache"
git show --stat HEAD
```

---

### Task 5: `getBotDirectory` aggregation

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js` (add `getBotDirectory`; keep `getAdvertisedBotItems` for now — Task 7 removes its inline use)
- Test: `tests/bot-directory-query.test.js` (create)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-directory-query.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { getBotDirectory } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PKA = "a".repeat(64), PKB = "b".repeat(64);

async function seedDb(contactRows = []) {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  for (const c of contactRows) {
    await db.execute({ sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, origin) VALUES (?,?,?)", args: [c.crow_id, c.pk, c.origin || null] });
  }
  // Minimal crow_instances so getTrustedInstances returns our peers.
  await db.execute(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, crow_id TEXT, trusted INTEGER, status TEXT, is_home INTEGER, gateway_url TEXT)`);
  await db.execute(`INSERT INTO crow_instances (id,name,crow_id,trusted,status,is_home) VALUES ('phone','Phone','crow:p',1,'active',0)`);
  return db;
}

test("getBotDirectory groups by instance and marks already-added bots", async () => {
  _resetCache();
  // Two bots from one peer; one of them is already a contact (PKA).
  _setFetchImpl(async () => ({ ok: true, body: { bots: [
    { bot_id: "b1", display_name: "Helper", instance_label: "Phone", messaging_pubkey: "02" + PKA, invite_code: "crow:a.b.c", description: "tag A" },
    { bot_id: "b2", display_name: "Chef", instance_label: "Phone", messaging_pubkey: "03" + PKB, invite_code: "crow:a.b.c" },
  ] } }));
  const db = await seedDb([{ crow_id: "crow:bot1", pk: "02" + PKA, origin: "advertised" }]);
  const dir = await getBotDirectory(db);
  assert.equal(dir.groups.length, 1, "one instance group");
  assert.equal(dir.groups[0].instanceLabel, "Phone");
  const byId = Object.fromEntries(dir.groups[0].bots.map((b) => [b.botId, b]));
  assert.equal(byId.b1.added, true, "PKA already a contact → added");
  assert.equal(byId.b2.added, false, "PKB not a contact");
  assert.equal(dir.total, 2);
  assert.equal(dir.notAddedCount, 1);
  _setFetchImpl(null);
});

test("getBotDirectory never throws when a peer fetch fails", async () => {
  _resetCache();
  _setFetchImpl(async () => { throw new Error("boom"); });
  const db = await seedDb([]);
  const dir = await getBotDirectory(db);
  assert.deepEqual(dir.groups, []);
  assert.equal(dir.total, 0);
  _setFetchImpl(null);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-query.test.js`
Expected: FAIL — `getBotDirectory` is not exported.

- [ ] **Step 3: Implement `getBotDirectory`**

In `messages/data-queries.js`, add (it reuses the existing imports `getTrustedInstances`, `getPeerAdvertisedBots`, `getOrCreateLocalInstanceId`, and the existing `pruneStaleAdvertisedContacts`):

```javascript
/**
 * Cross-instance bot directory: all advertised bots across trusted peers,
 * grouped by instance, each marked added/contactId via a pubkey match against
 * contacts (includes blocked — a blocked bot is still "known"). Shows ALL bots
 * (added ones are badged, not hidden). Never throws.
 */
export async function getBotDirectory(db) {
  // Map trailing-64 lowercased x-only pubkey -> contact id (incl. blocked).
  const known = new Map();
  try {
    const { rows } = await db.execute("SELECT id, secp256k1_pubkey FROM contacts WHERE secp256k1_pubkey IS NOT NULL");
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      if (h.length >= 64) known.set(h.slice(-64).toLowerCase(), Number(r.id));
    }
  } catch {}

  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch {}
  let insts = [];
  try { insts = await getTrustedInstances(db); } catch {}
  const peerIds = insts.map((i) => i.id).filter((id) => id && id !== localId);

  const settled = await Promise.allSettled(peerIds.map((id) => getPeerAdvertisedBots(db, id)));
  const seen = new Set();
  const live = new Set();
  const groupsByInst = new Map(); // instanceId -> { instanceId, instanceLabel, bots:[] }
  let total = 0, notAddedCount = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    for (const b of s.value.bots) {
      live.add(b.messaging_pubkey);
      if (seen.has(b.messaging_pubkey)) continue; // dedup across peers
      seen.add(b.messaging_pubkey);
      const contactId = known.get(b.messaging_pubkey) ?? null;
      const added = contactId != null;
      total += 1;
      if (!added) notAddedCount += 1;
      const g = groupsByInst.get(b.instance_id) || { instanceId: b.instance_id, instanceLabel: b.instance_label || null, bots: [] };
      g.bots.push({
        botId: b.bot_id,
        displayName: b.display_name,
        description: b.description || null,
        instanceId: b.instance_id,
        instanceLabel: b.instance_label || null,
        messagingPubkey: b.messaging_pubkey,
        inviteCode: b.invite_code,
        added,
        contactId,
      });
      groupsByInst.set(b.instance_id, g);
    }
  }
  if (live.size > 0) { try { await pruneStaleAdvertisedContacts(db, live); } catch {} }
  return { groups: Array.from(groupsByInst.values()), total, notAddedCount };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-query.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/bot-directory-query.test.js
git commit tests/bot-directory-query.test.js servers/gateway/dashboard/panels/messages/data-queries.js -m "feat(crow-messages): getBotDirectory aggregation grouped by instance"
git show --stat HEAD
```

---

## Phase B — shared component + Messages surface

### Task 6: shared `bot-directory.js` render component

**Files:**
- Create: `servers/gateway/dashboard/shared/bot-directory.js`
- Modify: `servers/gateway/dashboard/shared/i18n.js` (directory strings)
- Test: `tests/bot-directory-render.test.js` (create)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-directory-render.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotDirectory } from "../servers/gateway/dashboard/shared/bot-directory.js";

const GROUPS = [{
  instanceId: "phone", instanceLabel: "Phone", bots: [
    { botId: "b1", displayName: "Helper", description: "Schedules & reminders", inviteCode: "crow:a.b.c", added: false, contactId: null, instanceLabel: "Phone" },
    { botId: "b2", displayName: "Chef <x>", description: null, inviteCode: "crow:d.e.f", added: true, contactId: 7, instanceLabel: "Phone" },
  ],
}];
const CSRF = '<input type="hidden" name="_csrf" value="tok">';

test("messages context renders Add + Message for not-added, Added for added, with csrf + escaping", () => {
  const html = buildBotDirectory({ groups: GROUPS, context: "messages", csrf: CSRF, lang: "en" });
  assert.ok(html.includes("Phone"), "instance group header");
  assert.ok(html.includes("Schedules &amp; reminders"), "tagline escaped");
  assert.ok(html.includes("Chef &lt;x&gt;"), "display name escaped");
  assert.ok(html.includes('value="dir_add_bot"'), "Add action present");
  assert.ok(html.includes('value="dir_message_bot"'), "Message action present");
  assert.ok(html.includes('name="_csrf"'), "csrf present");
  assert.ok(/Added/.test(html), "added bot shows Added state");
  // The added bot links to its conversation by contactId.
  assert.ok(html.includes("?open=7") || html.includes('data-contact-id="7"'), "added → open chat by id");
  // A bot search box exists.
  assert.ok(html.includes('data-bot-directory-search'), "search input present");
});

test("contacts context renders Add only (no Message)", () => {
  const html = buildBotDirectory({ groups: GROUPS, context: "contacts", csrf: CSRF, lang: "en" });
  assert.ok(html.includes('value="dir_add_bot"'), "Add present");
  assert.ok(!html.includes('value="dir_message_bot"'), "no Message in contacts context");
});

test("empty directory renders the resolved empty-state, no forms, no raw keys", () => {
  const html = buildBotDirectory({ groups: [], context: "messages", csrf: CSRF, lang: "en" });
  assert.ok(!html.includes("dir_add_bot"), "no add forms when empty");
  assert.ok(html.includes("No bots available"), "resolved empty-state string (catches a missing botdir.empty key)");
  assert.ok(!html.includes("botdir."), "no raw i18n key leaked");
});

test("es branch resolves the directory strings (t() falls back to en silently)", () => {
  const html = buildBotDirectory({ groups: GROUPS, context: "messages", csrf: CSRF, lang: "es" });
  assert.ok(html.includes("Agregar"), "es Add label resolved");
  assert.ok(html.includes("Buscar bots"), "es search placeholder resolved");
  assert.ok(!html.includes("botdir."), "no raw key leaked in es");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-render.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `servers/gateway/dashboard/shared/bot-directory.js`**

```javascript
/**
 * Shared cross-instance bot directory render. Used by the Messages "+" picker
 * modal (context "messages") and the Contacts panel add-source (context
 * "contacts"). All user text escaped. Every POST form carries the CSRF token.
 *
 * Actions (handled in each panel's POST handler):
 *   dir_add_bot     — materialize the bot as a contact (is_bot=1), no message.
 *   dir_message_bot — materialize then redirect to the conversation (messages ctx only).
 */
import { escapeHtml } from "./components.js";
import { t } from "./i18n.js";

export function buildBotDirectory({ groups, context, csrf, lang }) {
  const csrfInput = csrf || "";
  const isMessages = context === "messages";

  if (!Array.isArray(groups) || groups.length === 0) {
    return `<div class="bot-dir-empty">${escapeHtml(t("botdir.empty", lang))}</div>`;
  }

  const groupHtml = groups.map((g) => {
    const rows = g.bots.map((b) => {
      const name = escapeHtml(b.displayName || b.botId);
      const tagline = b.description ? `<div class="bot-dir-tagline">${escapeHtml(b.description)}</div>` : "";
      let actions;
      if (b.added) {
        const href = b.contactId != null ? `/dashboard/messages?open=${encodeURIComponent(b.contactId)}` : "/dashboard/messages";
        actions = `<a class="bot-dir-added" href="${href}" data-contact-id="${escapeHtml(String(b.contactId ?? ""))}">${escapeHtml(t("botdir.added", lang))}</a>`;
      } else {
        const addForm =
          `<form method="POST" style="display:inline">` +
          `<input type="hidden" name="action" value="dir_add_bot">` +
          `<input type="hidden" name="invite_code" value="${escapeHtml(b.inviteCode)}">` +
          `${csrfInput}` +
          `<button type="submit" class="bot-dir-btn">${escapeHtml(t("botdir.add", lang))}</button></form>`;
        const msgForm = isMessages
          ? `<form method="POST" style="display:inline">` +
            `<input type="hidden" name="action" value="dir_message_bot">` +
            `<input type="hidden" name="invite_code" value="${escapeHtml(b.inviteCode)}">` +
            `${csrfInput}` +
            `<button type="submit" class="bot-dir-btn bot-dir-btn-primary">${escapeHtml(t("botdir.message", lang))}</button></form>`
          : "";
        actions = addForm + msgForm;
      }
      // data-bot-search lets the client-side filter match name+tagline.
      const haystack = escapeHtml(((b.displayName || "") + " " + (b.description || "")).toLowerCase());
      return `<div class="bot-dir-row" data-bot-search="${haystack}">` +
        `<div class="bot-dir-row-main"><strong>${name}</strong>${tagline}</div>` +
        `<div class="bot-dir-row-actions">${actions}</div></div>`;
    }).join("");
    const label = escapeHtml(g.instanceLabel || t("botdir.anotherCrow", lang));
    return `<div class="bot-dir-group"><div class="bot-dir-group-head">${label}</div>${rows}</div>`;
  }).join("");

  return `<div class="bot-dir">` +
    `<input type="text" data-bot-directory-search class="bot-dir-search" placeholder="${escapeHtml(t("botdir.searchPlaceholder", lang))}">` +
    groupHtml + `</div>`;
}
```

- [ ] **Step 4: Add i18n keys** in `i18n.js`:

```javascript
  "botdir.empty": { en: "No bots available on your other Crows yet.", es: "Aún no hay bots disponibles en tus otros Crows." },
  "botdir.added": { en: "Added ✓", es: "Agregado ✓" },
  "botdir.add": { en: "Add", es: "Agregar" },
  "botdir.message": { en: "Message", es: "Mensaje" },
  "botdir.anotherCrow": { en: "Another Crow", es: "Otro Crow" },
  "botdir.searchPlaceholder": { en: "Search bots...", es: "Buscar bots..." },
```

- [ ] **Step 5: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-render.test.js`
Expected: PASS (4 tests: messages-context, contacts-context, empty-state, es-branch).

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/shared/bot-directory.js tests/bot-directory-render.test.js
git commit servers/gateway/dashboard/shared/bot-directory.js tests/bot-directory-render.test.js servers/gateway/dashboard/shared/i18n.js -m "feat(crow-messages): shared bot-directory render component"
git show --stat HEAD
```

---

### Task 7: materialize handlers + `is_bot` marker; remove the legacy strip action

**Files:**
- Create: `servers/gateway/dashboard/shared/mark-contact-bot.js` (tiny shared helper)
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js` (add `dir_add_bot` + `dir_message_bot`; remove `message_advertised_bot`; mark is_bot in the existing `accept_bot_invite` path too)
- Test: `tests/bot-directory-materialize.test.js` (create)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-directory-materialize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

const SEED = randomBytes(32);
const BOT_ID = "dir-bot-1";
const ident = deriveBotIdentity(SEED, BOT_ID);
const CODE = generateBotInviteCode(ident, "tok-1", [], "Dir Bot");
const CROW_ID = parseBotInviteCode(CODE).botCrowId;

function fakeRes() { return { headersSent: false, _redir: null, redirectAfterPost(u){ this.headersSent = true; this._redir = u; return this; } }; }
async function db0() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  return db;
}
function fakeClientThatAccepts(db, calls) {
  return { async callTool(a){ calls.push(a.name); if (a.name==="crow_accept_bot_invite") { await db.execute({ sql:"INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES (?,?)", args:[CROW_ID, ident.secp256k1Pubkey] }); } return { content:[{type:"text",text:"ok"}] }; }, async close(){} };
}

test("dir_add_bot materializes the contact and flags is_bot=1", async () => {
  const db = await db0(); const calls = [];
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, sharingClientFactory: async () => fakeClientThatAccepts(db, calls) });
  assert.equal(res.headersSent, true);
  assert.deepEqual(calls, ["crow_accept_bot_invite"], "accept only, no send");
  const { rows } = await db.execute({ sql: "SELECT is_bot, origin FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(Number(rows[0].is_bot), 1, "contact flagged is_bot");
  assert.equal(rows[0].origin, "advertised", "new contact tagged origin=advertised (prune lifecycle)");
});

test("dir_message_bot materializes, flags is_bot, and redirects to ?open=<id>", async () => {
  const db = await db0(); const calls = [];
  const req = { body: { action: "dir_message_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, sharingClientFactory: async () => fakeClientThatAccepts(db, calls) });
  assert.deepEqual(calls, ["crow_accept_bot_invite"], "accept only; no forced message");
  const { rows } = await db.execute({ sql: "SELECT id, is_bot FROM contacts WHERE crow_id=?", args: [CROW_ID] });
  assert.equal(Number(rows[0].is_bot), 1);
  assert.equal(res._redir, `/dashboard/messages?open=${rows[0].id}`, "redirects to the new conversation");
});

test("dir_add_bot on a failed accept does not flag anything", async () => {
  const db = await db0(); const calls = [];
  const fc = { async callTool(a){ calls.push(a.name); return { isError: true, content:[{type:"text",text:"bad"}] }; }, async close(){} };
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const res = fakeRes();
  await handlePostAction(req, res, { db, sharingClientFactory: async () => fc });
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM contacts");
  assert.equal(Number(rows[0].n), 0, "nothing materialized");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-materialize.test.js`
Expected: FAIL — `dir_add_bot`/`dir_message_bot` not handled (returns false; `res.headersSent` stays false).

- [ ] **Step 3: Create the shared `is_bot` marker helper**

Create `servers/gateway/dashboard/shared/mark-contact-bot.js`:

```javascript
/**
 * Mark a contact as a Crow Messages bot. Idempotent; never throws. Called by
 * every gateway materialize path (directory add/message, paste form, deep
 * link) right after a successful accept. A bot is always a bot, so this sets
 * the flag unconditionally on the matching crow_id.
 */
export async function markContactIsBot(db, crowId) {
  if (!crowId) return;
  try { await db.execute({ sql: "UPDATE contacts SET is_bot = 1 WHERE crow_id = ?", args: [crowId] }); } catch {}
}
```

- [ ] **Step 4: Wire the handlers in `messages/api-handlers.js`**

Add the import at top:

```javascript
import { markContactIsBot } from "../../shared/mark-contact-bot.js";
```

Add these two action branches (place them where `message_advertised_bot` was, and DELETE the entire `message_advertised_bot` branch ~146-190):

```javascript
  if ((action === "dir_add_bot" || action === "dir_message_bot") && req.body.invite_code) {
    const code = req.body.invite_code.trim();
    let botCrowId = null;
    try {
      const { parseBotInviteCode } = await import("../../../../sharing/identity.js");
      botCrowId = parseBotInviteCode(code).botCrowId;
    } catch { /* malformed — accept will report; bail to plain redirect */ }

    // Was this bot already a contact? Only tag origin on contacts WE create
    // (mirrors the removed message_advertised_bot discipline), preserving the
    // pruneStaleAdvertisedContacts lifecycle + the Task-1 backfill grain.
    let wasNew = false;
    if (botCrowId) {
      try { const { rows } = await db.execute({ sql: "SELECT 1 FROM contacts WHERE crow_id = ?", args: [botCrowId] }); wasNew = rows.length === 0; } catch {}
    }

    let redirectTo = "/dashboard/messages";
    try {
      const client = await sharingClientFactory();
      try {
        const accepted = await client.callTool({ name: "crow_accept_bot_invite", arguments: { invite_code: code } });
        if (accepted?.isError) return res.redirectAfterPost("/dashboard/messages");
        if (botCrowId) {
          if (wasNew) await db.execute({ sql: "UPDATE contacts SET origin = 'advertised' WHERE crow_id = ?", args: [botCrowId] });
          await markContactIsBot(db, botCrowId);
          if (action === "dir_message_bot") {
            const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [botCrowId] });
            if (rows[0]?.id != null) redirectTo = `/dashboard/messages?open=${rows[0].id}`;
          }
        }
      } finally {
        await client.close();
      }
    } catch (err) {
      console.error("[messages] dir bot materialize failed:", err.message);
    }
    return res.redirectAfterPost(redirectTo);
  }
```

Also, in the EXISTING `accept_bot_invite` branch (the phase-1 paste + deep-link path), add an `is_bot` flag after a successful accept so those contacts are badged too. After the `await client.close();` in that branch, before the redirect, insert:

```javascript
      try {
        const { parseBotInviteCode } = await import("../../../../sharing/identity.js");
        await markContactIsBot(db, parseBotInviteCode(req.body.invite_code.trim()).botCrowId);
      } catch {}
```

(Note: the `sharingClientFactory` default param already exists on `handlePostAction`; `dir_*` uses it. Confirm the signature `handlePostAction(req, res, { db, sharingClientFactory = getSharingClient })`.)

- [ ] **Step 5: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-materialize.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm the removed action breaks nothing — run the messages action tests**

Run: `node --test --test-force-exit tests/crow-accept-bot-invite.test.js tests/messages-add-bot-form.test.js`
Expected: PASS. (`tests/roster-advertise-materialize.test.js` tested `message_advertised_bot` — Step 7 below updates/removes it.)

- [ ] **Step 7: Retire the obsolete `message_advertised_bot` test**

`tests/roster-advertise-materialize.test.js` exercises the removed action. Delete that file (its behavior is superseded by `tests/bot-directory-materialize.test.js`):

```bash
git rm tests/roster-advertise-materialize.test.js
```

- [ ] **Step 8: Commit**

```bash
git add servers/gateway/dashboard/shared/mark-contact-bot.js tests/bot-directory-materialize.test.js
git commit servers/gateway/dashboard/shared/mark-contact-bot.js tests/bot-directory-materialize.test.js servers/gateway/dashboard/panels/messages/api-handlers.js tests/roster-advertise-materialize.test.js -m "feat(crow-messages): directory add/message handlers + is_bot marker; drop message_advertised_bot"
git show --stat HEAD
```

---

### Task 8: Messages surface — collapse strip to Browse + "Message a Bot" modal + ?open hook

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages.js` (pass `botDirectory` instead of `advertisedBots`)
- Modify: `servers/gateway/dashboard/panels/messages/html.js` (replace `advertisedSection` with the collapsed Browse entry + the directory modal + the "Message a Bot" popover item)
- Modify: `servers/gateway/dashboard/panels/messages/client.js` (modal open/close, search filter, `?open=` on-load hook)
- Modify: `servers/gateway/dashboard/panels/messages/css.js` (modal + directory styles)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (Messages strings)
- Test: `tests/bot-directory-messages-surface.test.js` (create)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-directory-messages-surface.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

const BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  csrf: '<input type="hidden" name="_csrf" value="tok">',
};

test("collapsed Browse entry shows the not-added count and opens the directory", () => {
  const html = buildMessagesHTML({ ...BASE, botDirectory: { groups: [{ instanceId:"p", instanceLabel:"Phone", bots:[{botId:"b1",displayName:"Helper",inviteCode:"crow:a.b.c",added:false,contactId:null}] }], total: 1, notAddedCount: 1 } });
  assert.ok(/1/.test(html), "count rendered");
  assert.ok(html.includes("msgOpenBotDirectory") || html.includes("bot-dir-modal"), "wired to open the directory");
  assert.ok(html.includes('value="dir_message_bot"') || html.includes('value="dir_add_bot"'), "directory forms embedded");
});

test("Browse entry hidden when nothing is available", () => {
  const html = buildMessagesHTML({ ...BASE, botDirectory: { groups: [], total: 0, notAddedCount: 0 } });
  assert.ok(!html.includes("bots available on your other Crows"), "no browse entry at zero");
});

test("popover has a 'Message a Bot' item", () => {
  const html = buildMessagesHTML({ ...BASE, botDirectory: { groups: [], total: 0, notAddedCount: 0 } });
  assert.ok(html.includes("msgOpenBotDirectory"), "Message a Bot item wired");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-messages-surface.test.js`
Expected: FAIL — `buildMessagesHTML` still expects `advertisedBots`; no directory markup.

- [ ] **Step 3: Update `messages.js`** to build the directory instead of `getAdvertisedBotItems`

Replace the `advertisedBots` block (~59-61) and the `buildMessagesHTML` arg:

```javascript
    // Cross-instance bot directory (read-only browse; never throws).
    let botDirectory = { groups: [], total: 0, notAddedCount: 0 };
    try {
      const { getBotDirectory } = await import("./messages/data-queries.js");
      botDirectory = await getBotDirectory(db);
    } catch {}
```

And in the `buildMessagesHTML({...})` call, replace `advertisedBots,` with `botDirectory,`. Update the import line at top from `getUnifiedConversationList, getAdvertisedBotItems` to `getUnifiedConversationList` (drop the now-unused import).

Then **remove the now-orphaned `getAdvertisedBotItems`** from `messages/data-queries.js` (nothing imports it after this change — `getBotDirectory` supersedes it; `pruneStaleAdvertisedContacts` stays, used by `getBotDirectory`). Confirm with `grep -rn "getAdvertisedBotItems" servers/ tests/` — the only remaining hit should be `tests/roster-advertise-aggregate.test.js`, which Step 8 deletes.

- [ ] **Step 4: Update `html.js`** — import the shared component, replace the advertised section, add the Browse entry + modal + popover item

At top of `html.js`:
```javascript
import { buildBotDirectory } from "../../shared/bot-directory.js";
```

Replace the entire `advertisedSection` block (the `if (Array.isArray(advertisedBots) && advertisedBots.length) {...}`) with a collapsed Browse entry + a hidden modal:

```javascript
  // Collapsed "browse bots on your other Crows" entry + the directory modal.
  const dir = data.botDirectory || { groups: [], total: 0, notAddedCount: 0 };
  let browseEntry = "", botDirModal = "";
  if (dir.total > 0) {
    browseEntry =
      `<div class="msg-browse-bots" onclick="msgOpenBotDirectory()">` +
      `${escapeHtml(t("messages.botsAvailable", lang).replace("{n}", String(dir.notAddedCount)))}` +
      ` <span class="msg-browse-cta">${escapeHtml(t("messages.browse", lang))}</span></div>`;
    botDirModal =
      `<div class="bot-dir-modal" id="bot-dir-modal"><div class="bot-dir-modal-card">` +
      `<div class="bot-dir-modal-head"><strong>${escapeHtml(t("messages.botDirectoryTitle", lang))}</strong>` +
      `<button class="bot-dir-modal-close" onclick="msgCloseBotDirectory()">&times;</button></div>` +
      buildBotDirectory({ groups: dir.groups, context: "messages", csrf, lang }) +
      `</div></div>`;
  }
```

- Add the `browseEntry` into the returned markup just before the `<div class="msg-hub" ...>` (where `advertisedSection` used to be prepended): change `return botInviteCard + advertisedSection + \`` to `return botInviteCard + browseEntry + \`` and append `${botDirModal}` inside the hub (e.g. right after `${inviteBanner}`).
- Add the popover item after the "Add a Bot" item in `#msg-popover`:
```javascript
        <div class="msg-popover-item" onclick="msgOpenBotDirectory()">
          <div class="msg-popover-item-title">${t("messages.messageABot", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.messageABotDesc", lang)}</div>
        </div>
```
- Confirm `data.botDirectory` is destructured: add `botDirectory` to the `const { ... } = data;` line (alongside the others), or reference `data.botDirectory` as above (the snippet uses `data.botDirectory` directly, so no destructure change is strictly required — keep it consistent with the file).

- [ ] **Step 5: Update `client.js`** — modal open/close, search filter, `?open=` hook

Add these functions (near `msgShowInviteDialog`) and an on-load hook:

```javascript
  function msgOpenBotDirectory() {
    var m = document.getElementById('bot-dir-modal');
    if (m) m.classList.add('visible');
    var pop = document.getElementById('msg-popover');
    if (pop) pop.classList.remove('visible');
  }
  function msgCloseBotDirectory() {
    var m = document.getElementById('bot-dir-modal');
    if (m) m.classList.remove('visible');
  }
  // Live search filter over the directory rows.
  document.addEventListener('input', function (e) {
    if (!e.target || !e.target.hasAttribute('data-bot-directory-search')) return;
    var q = e.target.value.toLowerCase();
    document.querySelectorAll('.bot-dir-row').forEach(function (row) {
      var hay = row.getAttribute('data-bot-search') || '';
      row.style.display = hay.indexOf(q) === -1 ? 'none' : '';
    });
  });
```

Add an attach-once on-load hook that opens a conversation when `?open=<id>` is present (guard with `window.__msgOpenHook` like the existing outside-click guard):

```javascript
  if (!window.__msgOpenHookBound) {
    window.__msgOpenHookBound = true;
    var params = new URLSearchParams(window.location.search);
    var openId = params.get('open');
    if (openId && /^\d+$/.test(openId)) {
      // msgSelectItem opens the conversation; defer so the list is in the DOM.
      setTimeout(function () { try { msgSelectItem('peer', parseInt(openId, 10)); } catch (e) {} }, 0);
    }
  }
```

No global-exposure step is needed: `client.js` is a bare `<script>` template with NO IIFE, so top-level `function` declarations auto-globalize (that is why the existing inline `onclick="msgSelectItem(...)"` already works). Declare `msgOpenBotDirectory`/`msgCloseBotDirectory` as plain top-level functions like `msgSelectItem`; do NOT add any `window.* =` assignment (there are none in this file).

- [ ] **Step 6: Add CSS** in `css.js` (append to the returned template; keep the existing visual language — reuse `--crow-*` vars):

```css
  .msg-browse-bots { padding:8px 12px; cursor:pointer; font-size:0.8rem; color:var(--crow-text-muted); border-bottom:1px solid var(--crow-border); }
  .msg-browse-cta { color:var(--crow-accent); }
  .bot-dir-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:200; }
  .bot-dir-modal.visible { display:flex; align-items:center; justify-content:center; }
  .bot-dir-modal-card { background:var(--crow-bg-elevated); border:1px solid var(--crow-border); border-radius:10px; width:min(560px,92vw); max-height:80vh; overflow:auto; padding:16px; }
  .bot-dir-modal-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .bot-dir-modal-close { background:none; border:none; color:var(--crow-text-muted); font-size:1.4rem; cursor:pointer; }
  .bot-dir-search { width:100%; margin-bottom:10px; padding:6px 8px; border:1px solid var(--crow-border); border-radius:6px; background:var(--crow-bg-deep); color:var(--crow-text); }
  .bot-dir-group-head { font-size:0.72rem; text-transform:uppercase; color:var(--crow-text-muted); margin:8px 0 4px; }
  .bot-dir-row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--crow-border); }
  .bot-dir-tagline { font-size:0.75rem; color:var(--crow-text-muted); }
  .bot-dir-btn { font-size:0.75rem; padding:4px 10px; border:1px solid var(--crow-border); border-radius:6px; background:var(--crow-bg-deep); color:var(--crow-text); cursor:pointer; }
  .bot-dir-btn-primary { background:var(--crow-accent); color:#fff; border-color:var(--crow-accent); }
  .bot-dir-added { font-size:0.75rem; color:var(--crow-text-muted); text-decoration:none; }
  .bot-dir-empty { padding:16px; color:var(--crow-text-muted); font-size:0.85rem; }
```

- [ ] **Step 7: Add i18n keys** in `i18n.js`:

```javascript
  "messages.botsAvailable": { en: "{n} bots available on your other Crows", es: "{n} bots disponibles en tus otros Crows" },
  "messages.browse": { en: "Browse", es: "Explorar" },
  "messages.botDirectoryTitle": { en: "Bots on your other Crows", es: "Bots en tus otros Crows" },
  "messages.messageABot": { en: "Message a Bot", es: "Enviar mensaje a un bot" },
  "messages.messageABotDesc": { en: "Browse bots on your other Crows", es: "Explora bots en tus otros Crows" },
```

- [ ] **Step 8: Run the surface test + the prior Messages render tests**

Run: `node --test --test-force-exit tests/bot-directory-messages-surface.test.js tests/messages-add-bot-form.test.js`
Expected: PASS.

Now retire the two tests that asserted the removed behavior:
- `tests/roster-advertise-html.test.js` — asserted the OLD `message_advertised_bot` inline section (`getAdvertisedBotItems` render). Read it; it only tests the removed section, so `git rm tests/roster-advertise-html.test.js`.
- `tests/roster-advertise-aggregate.test.js` — imports/tests the now-removed `getAdvertisedBotItems` (verified: only that). `git rm tests/roster-advertise-aggregate.test.js`.

(If on reading either file you find it also covers still-live behavior, update rather than delete — but per the review both only exercise removed code.)

- [ ] **Step 9: Commit**

```bash
git add tests/bot-directory-messages-surface.test.js
git rm tests/roster-advertise-html.test.js tests/roster-advertise-aggregate.test.js
git commit tests/bot-directory-messages-surface.test.js tests/roster-advertise-html.test.js tests/roster-advertise-aggregate.test.js servers/gateway/dashboard/panels/messages.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/panels/messages/css.js servers/gateway/dashboard/shared/i18n.js -m "feat(crow-messages): Messages bot directory modal + Browse entry + open-hook"
git show --stat HEAD
```

---

## Phase C — Contacts surface + bot badge

### Task 9: Contacts panel "Browse Crow bots" add-source + add action

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts.js` (a new `view=bots` that renders the directory; build `getBotDirectory` there)
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (handle `dir_add_bot`)
- Modify: `servers/gateway/dashboard/panels/contacts/html.js` (a "Browse Crow bots" tab/entry)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (contacts strings)
- Test: `tests/bot-directory-contacts-surface.test.js` (create)

- [ ] **Step 1: Read the contacts panel tab/view + action plumbing**

Read `servers/gateway/dashboard/panels/contacts.js` (the `view` switch ~38-90) and `contacts/api-handlers.js` (the `add_manual` branch ~60-79) to match the exact tab + action patterns. The contacts panel returns HTML via `section(...)`; the POST handler returns `{ redirect }`.

- [ ] **Step 2: Write the failing test**

The contacts add action is testable like the manual-add path. Test that `handleContactAction` routes `dir_add_bot` through the sharing client and flags is_bot:

```javascript
// tests/bot-directory-contacts-surface.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";

const ident = deriveBotIdentity(randomBytes(32), "c-dir-bot");
const CODE = generateBotInviteCode(ident, "tok", [], "Dir Bot");
const CROW_ID = parseBotInviteCode(CODE).botCrowId;

test("contacts dir_add_bot materializes + flags is_bot", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  const calls = [];
  const fakeClient = { async callTool(a){ calls.push(a.name); if (a.name==="crow_accept_bot_invite") await db.execute({ sql:"INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES (?,?)", args:[CROW_ID, ident.secp256k1Pubkey] }); return { content:[{type:"text",text:"ok"}] }; }, async close(){} };
  const req = { body: { action: "dir_add_bot", invite_code: CODE } };
  const result = await handleContactAction(req, db, { sharingClientFactory: async () => fakeClient });
  assert.equal(result.redirect, "/dashboard/contacts?view=bots");
  assert.deepEqual(calls, ["crow_accept_bot_invite"]);
  const { rows } = await db.execute({ sql:"SELECT is_bot, origin FROM contacts WHERE crow_id=?", args:[CROW_ID] });
  assert.equal(Number(rows[0].is_bot), 1);
  assert.equal(rows[0].origin, "advertised", "new contact tagged origin=advertised");
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-contacts-surface.test.js`
Expected: FAIL — `dir_add_bot` not handled; `handleContactAction` may not accept a `sharingClientFactory` seam yet.

- [ ] **Step 4: Implement the contacts `dir_add_bot` handler**

Real signature is `handleContactAction(req, db)` (`contacts/api-handlers.js:17`), and its sole caller `contacts.js:29` passes exactly two args. So the new param MUST have a destructure default: change the signature to:

```javascript
export async function handleContactAction(req, db, { sharingClientFactory = makeSharingClient } = {}) {
```

`getSharingClient` in `messages/api-handlers.js` is NOT exported, so REPLICATE the tiny in-memory factory at the top of `contacts/api-handlers.js` (copy the 6-line `getSharingClient` body verbatim, name it `makeSharingClient`). Add `import { markContactIsBot } from "../../shared/mark-contact-bot.js";`. The required imports for the factory: `Client` from `@modelcontextprotocol/sdk/client/index.js`, `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js`, `createSharingServer` from `../../../../sharing/server.js`. Then add the handler:

```javascript
  if (action === "dir_add_bot" && req.body.invite_code) {
    const code = req.body.invite_code.trim();
    let botCrowId = null;
    try {
      const { parseBotInviteCode } = await import("../../../../sharing/identity.js");
      botCrowId = parseBotInviteCode(code).botCrowId;
    } catch {}
    let wasNew = false;
    if (botCrowId) { try { const { rows } = await db.execute({ sql: "SELECT 1 FROM contacts WHERE crow_id = ?", args: [botCrowId] }); wasNew = rows.length === 0; } catch {} }
    try {
      const client = await sharingClientFactory();
      try {
        const accepted = await client.callTool({ name: "crow_accept_bot_invite", arguments: { invite_code: code } });
        if (!accepted?.isError && botCrowId) {
          if (wasNew) await db.execute({ sql: "UPDATE contacts SET origin = 'advertised' WHERE crow_id = ?", args: [botCrowId] });
          await markContactIsBot(db, botCrowId);
        }
      } finally { await client.close(); }
    } catch (err) { console.error("[contacts] dir_add_bot failed:", err.message); }
    return { redirect: "/dashboard/contacts?view=bots" };
  }
```

The existing `contacts.js:29` caller (`await handleContactAction(req, db)`) stays UNCHANGED — the `= {}` default makes the third arg optional.

- [ ] **Step 5: Add the `view=bots` render in `contacts.js`**

`contacts.js` assigns `bodyHtml` through an `if/else` chain (`:52-74`) and builds a `tabs` array (`:79-83`); there is NO `section()` helper or `body` var. Add a new arm to the chain (after the `view === "profile"` arm, before the final `else`):

```javascript
    } else if (view === "bots") {
      const { getBotDirectory } = await import("./messages/data-queries.js");
      const { buildBotDirectory } = await import("../shared/bot-directory.js");
      const { csrfInput } = await import("../shared/csrf.js");
      const dir = await getBotDirectory(db).catch(() => ({ groups: [], total: 0, notAddedCount: 0 }));
      bodyHtml = buildBotDirectory({ groups: dir.groups, context: "contacts", csrf: csrfInput(req), lang });
```

The import paths from `contacts.js` (at `servers/gateway/dashboard/panels/contacts.js`): `getBotDirectory` is at `panels/messages/data-queries.js` → `"./messages/data-queries.js"`; `bot-directory.js` and `csrf.js` are at `dashboard/shared/` → from `panels/` that is `"../shared/bot-directory.js"` and `"../shared/csrf.js"` (matches the existing `../shared/...` imports in contacts.js). The snippet above already uses the correct paths — paste it verbatim.

Then add `{ id: "bots", label: t("contacts.browseBots", lang) },` to the `tabs` array (`:79-83`) so the view is reachable from the tab bar.

- [ ] **Step 6: Add i18n keys**

```javascript
  "contacts.browseBots": { en: "Browse Crow bots", es: "Explorar bots de Crow" },
```

- [ ] **Step 7: Run, verify PASS**

Run: `node --test --test-force-exit tests/bot-directory-contacts-surface.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/bot-directory-contacts-surface.test.js
git commit tests/bot-directory-contacts-surface.test.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/shared/i18n.js -m "feat(crow-messages): Contacts 'Browse Crow bots' directory add-source"
git show --stat HEAD
```

---

### Task 10: bot badge in the unified list

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js` (`getUnifiedConversationList` peer SELECT adds `is_bot`; item carries `isBot`)
- Modify: `servers/gateway/dashboard/panels/messages/html.js` (badge on peer avatar/list item where `isBot`)
- Test: `tests/bot-directory-badge.test.js` (create)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-directory-badge.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

test("getUnifiedConversationList carries isBot for bot contacts", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE chat_conversations (id INTEGER PRIMARY KEY, title TEXT, provider TEXT, model TEXT, updated_at TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, conversation_id INTEGER)`);
  // created_at is required: getUnifiedConversationList orders peers by c.created_at;
  // without it the peer SELECT throws and is swallowed, leaving items empty.
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, display_name TEXT, last_seen TEXT, is_blocked INTEGER DEFAULT 0, is_bot INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE messages (id INTEGER PRIMARY KEY, contact_id INTEGER, created_at TEXT, is_read INTEGER, direction TEXT)`);
  await db.execute(`INSERT INTO contacts (crow_id, display_name, is_bot) VALUES ('crow:bot','Helper',1)`);
  await db.execute(`INSERT INTO contacts (crow_id, display_name, is_bot) VALUES ('crow:human','Kevin',0)`);

  const { items } = await getUnifiedConversationList(db);
  const bot = items.find((i) => i.displayName === "Helper");
  const human = items.find((i) => i.displayName === "Kevin");
  assert.equal(bot.isBot, true, "bot contact flagged");
  assert.equal(human.isBot, false, "human contact not flagged");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --test --test-force-exit tests/bot-directory-badge.test.js`
Expected: FAIL — `isBot` is undefined on the items.

- [ ] **Step 3: Implement**

In `getUnifiedConversationList`, the peer SELECT — add `c.is_bot` to the selected columns, and on the pushed item add `isBot: !!Number(row.is_bot)`.

In `html.js`, where peer avatar items render (the `else` branch building `msg-avatar-item`), add a small badge when the item is a bot. Find where `items.map` builds peer items and append a bot marker (e.g. a `🤖`/"bot" tag) to the title or as a small element:

```javascript
      const botTag = item.isBot ? `<span class="msg-bot-tag" title="${escapeHtml(t("messages.botTag", lang))}">${escapeHtml(t("messages.botTag", lang))}</span>` : "";
```
and include `${botTag}` in the peer item markup (e.g. inside the avatar item, after the badge span). Add an `i18n` key `"messages.botTag": { en: "bot", es: "bot" }` and a minimal `.msg-bot-tag` CSS rule in `css.js`.

- [ ] **Step 4: Run, verify PASS + the surface test**

Run: `node --test --test-force-exit tests/bot-directory-badge.test.js tests/bot-directory-messages-surface.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/bot-directory-badge.test.js
git commit tests/bot-directory-badge.test.js servers/gateway/dashboard/panels/messages/data-queries.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages/css.js servers/gateway/dashboard/shared/i18n.js -m "feat(crow-messages): badge bot contacts in the unified Messages list"
git show --stat HEAD
```

---

### Task 11: full-suite regression sweep

- [ ] **Step 1: Run the whole new feature suite + the prior crow-messages tests**

```bash
node --test --test-force-exit \
  tests/bot-directory-schema.test.js tests/bot-directory-payload.test.js \
  tests/bot-directory-editor.test.js tests/bot-directory-cache.test.js \
  tests/bot-directory-query.test.js tests/bot-directory-render.test.js \
  tests/bot-directory-materialize.test.js tests/bot-directory-messages-surface.test.js \
  tests/bot-directory-contacts-surface.test.js tests/bot-directory-badge.test.js \
  tests/messages-add-bot-form.test.js tests/crow-accept-bot-invite.test.js \
  tests/crow-messages-editor.test.js tests/tool-manifests.test.js \
  tests/auth-network.test.js
```
Expected: all PASS.

- [ ] **Step 2: Validate the module graph imports cleanly (no full boot)**

```bash
node --input-type=module -e 'await import("./servers/gateway/dashboard/shared/bot-directory.js"); await import("./servers/gateway/dashboard/panels/messages/html.js"); await import("./servers/gateway/dashboard/panels/messages/data-queries.js"); await import("./servers/gateway/dashboard/panels/contacts.js"); console.log("imports ok");'
```
Expected: prints `imports ok` with no throw.

- [ ] **Step 3: Commit any fixups** (positional paths; no Co-Authored-By).

---

## Self-Review

**Spec coverage:**
- §1 `contacts.is_bot` + backfill → Task 1. ✓
- §1 tagline in def JSON → Tasks 2–3. ✓
- §2 single is_bot marker → Task 7 (`mark-contact-bot.js`, gateway-layer; documented deviation from "inside the tool" for testability/DRY — see note). ✓ (deviation flagged)
- §3 payload `description` → Task 2; §4 cache passthrough → Task 4. ✓
- §4 `getBotDirectory` (group, added-state, dedup, never-throws) → Task 5. ✓
- §4 shared `bot-directory.js` render → Task 6. ✓
- §5 Messages "+" "Message a Bot" + modal → Task 8; collapsed strip → Task 8; Contacts add-source → Task 9; bot badge → Task 10. ✓
- §6 Add/Message actions + ?open hook → Tasks 7–8. ✓
- §8 testing items → covered per task; full sweep Task 11. ✓
- §9/§10 deploy → below. ✓

**Deviation from spec (intentional, flag for reviewer):** the spec §2 says set `is_bot` inside `crow_accept_bot_invite`. The plan instead sets it via a shared gateway helper (`markContactIsBot`) called from each materialize handler, because the sharing tool is integration-heavy to unit-test whereas the handler layer is covered by the `handlePostAction`/`handleContactAction` seams (mirrors how `origin='advertised'` is already written). Trade-off: a bot added by a DIRECT `crow_accept_bot_invite` MCP call (e.g. the AI assistant) is not badged. Acceptable (rare; contact still functions). If the reviewer prefers tool-level marking, add one line to the tool INSERT in addition.

**Placeholder scan:** no TBD/TODO. UI tasks (8, 9) include explicit "read the real file / verify the relative path" steps because the exact insertion anchors depend on current file shape; all code blocks are complete.

**Type/name consistency:** action names `dir_add_bot` / `dir_message_bot` used identically in Tasks 6/7/9. `getBotDirectory` shape `{groups,total,notAddedCount}` consistent across Tasks 5/8. `markContactIsBot(db, crowId)` consistent Tasks 7/9. `buildBotDirectory({groups,context,csrf,lang})` consistent Tasks 6/8/9. `isBot` item field consistent Tasks 10.

---

## Review

**Reviewer:** Plan subagent (staff-engineer adversarial pass), 2026-06-16. **Verdict: REVISE → fixed inline below.** Every anchor/signature was checked against the real files.

**Critical fixes applied:**
1. **C1 — migration call was malformed.** Real `addColumnIfMissing(table, column, definition)` builds `ADD COLUMN ${column} ${definition}`, so the 3rd arg is the type clause only. Plan now passes `"INTEGER DEFAULT 0"` (not `"is_bot INTEGER DEFAULT 0"`), the Task-1 test mirror matches the REAL helper signature, and Step 4 now asserts the column actually exists after a real init-db run (the wrong form was silently swallowed by the helper's try/catch).
2. **C2 — Task 9 referenced a nonexistent `section()`/`body`.** Rewritten to use the real `bodyHtml` + the `if/else` view chain + the `tabs` array.
3. **C3 — `handleContactAction` signature.** Now `(req, db, { sharingClientFactory = makeSharingClient } = {})` (the `= {}` keeps the existing 2-arg caller working); `getSharingClient` isn't exported, so the factory is replicated as `makeSharingClient` with explicit imports listed.
4. **C4 — prune-lifecycle regression.** The directory materialize handlers (Messages Task 7 + Contacts Task 9) now also set `origin='advertised'` on NEW contacts (wasNew guard), preserving `pruneStaleAdvertisedContacts` semantics + the Task-1 backfill grain. Tests assert `origin`.

**Suggestions applied:** S1 (deleted the wrong "mirror `window.msgShowInviteDialog`" prose — bare functions auto-globalize, no IIFE), S2 (corrected the contacts→shared import path to `../shared/...`), S3 (Task 10 test `contacts` table gains `created_at` so the peer SELECT doesn't throw-and-swallow), S4 (added es-branch + empty-state + raw-key-leak assertions per spec §8), S5 (Task 8 removes the orphaned `getAdvertisedBotItems` and `git rm`s `roster-advertise-aggregate.test.js` + `roster-advertise-html.test.js`).

**Approved as sound:** the spec-§2 deviation (mark `is_bot` at the gateway-handler layer via `markContactIsBot`, not inside the integration-heavy sharing tool) — the reviewer confirmed `origin='advertised'` was always written at the handler layer (the tool never set `origin` either), so this mirrors the existing pattern; the AI-direct-tool path being unbadged is pre-existing and minor. **Noted (S6):** `markContactIsBot` sets `is_bot=1` unconditionally by `crow_id` — harmless for a bot (a bot is always a bot). **Noted (Q3):** a `?open=<id>` pointing at a blocked contact is a harmless no-op (blocked contacts aren't in the strip); `dir_message_bot`'s post-accept `SELECT id` is safe (same in-process libsql, the INSERT is committed before the SELECT).

## Deploy (after merge)

**Schema-change deploy.** Per host: `git pull --rebase` → `node scripts/init-db.js` per data dir FIRST → restart the gateway(s). crow main `~/.crow` → `:3001`; MPA `~/.crow-mpa` (`CROW_DB_PATH=~/.crow-mpa/data/crow.db node scripts/init-db.js`) → `:3006`; grackle `~/crow` → `:3002`; black-swan (`ssh black-swan`) → `:3001` (slow boot). Sudo `8r00kly^`. **pi-bots NOT restarted** (the adapter does not read the tagline or `is_bot`; `buildAdvertisementPayload` runs in the gateway). Verify via node ports, not ts.net `/health`. **Live-verify cross-instance:** set a tagline + `allow_paired_instances` on a bot on one Crow; from another paired Crow confirm it shows (with tagline) in Messages "+" → "Message a Bot" and in Contacts → "Browse Crow bots"; Add → it becomes a badged contact; Message → opens the chat. A signed `GET /dashboard/advertised-bots` from a paired peer should 200 with a `bots` array carrying `description`.
