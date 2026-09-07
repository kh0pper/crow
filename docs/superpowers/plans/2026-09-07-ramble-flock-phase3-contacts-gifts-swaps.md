# Ramble Flock Phase 3 — Contacts Delivery, Gifts, Swaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contacts/group marks, gifted eggs and egg swaps travel between contacts as NIP-44 DMs through the gateway's one live `NostrManager`, with `ramble_trades` as the first new replicated table since phase 1.

**Architecture:** Authoring (panel routes, MCP tools) writes rows plus one LOCAL `ramble_outbox` row per recipient; the core transport (`servers/gateway/boot/ramble-transport.js`) drains the outbox into `nostrManager.sendControl(contact, json)` and receives the other direction through a new `ramble:envelope` bus event that `NostrManager.subscribeToContact` emits for any decrypted DM whose `type` starts with `ramble.`. Two new bundle modules carry the logic: `delivery.js` (payload codecs, audience resolution, the outbox) and `trades.js` (gift/swap protocol, expiry, inbound envelope router). `ramble_trades` replicates to the user's own instances through instance sync exactly like `ramble_eggs`.

**Tech Stack:** Node 22 ESM, libsql client (`db.execute`/`db.batch`), `nostr-tools` (`nip44`, `finalizeEvent`), Express router, plain-script panel client (no modules, no backticks), Node built-in test runner via `scripts/run-suite.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-07-ramble-flock-design.md` — §2.5, §4 (contacts delivery, gifts/swaps wire), §5 (`ramble_trades`), §7 (routes/tools/`ramble:trade`), §9, §10, §11 item 3. Phase-2 rulings that still bind: `docs/superpowers/plans/2026-09-07-ramble-flock-phase2-nests-flock-shelf.md` "Global Constraints" + "## Review"; handoff `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase2-shipped-pr314.md`.

## Global Constraints

Phase-1/2 constraints still bind (copied, with the phase-3 deltas marked **[P3]**):

- **DB access:** bundle server code reaches the DB only through `server/app-root.js` → `appImport("servers/db.js")` / the bundle's `createDbClient()` (never a second SQLite driver in the gateway process). Client is async libsql-shaped: `await db.execute({ sql, args })`, `await db.executeMultiple(sql)`, `await db.batch([...])`.
- **No `SCHEMA_GENERATION` bump:** new tables via `CREATE TABLE IF NOT EXISTS` in `bundles/ramble/server/init-tables.js`; new columns via `ensureColumn`. Never edit `scripts/init-db.js`. **[P3]** The core tables `contacts`, `contact_groups`, `contact_group_members` are READ only (never created, altered or written by ramble). Tests that need them create a minimal copy (the exact DDL is in Task 2, repeated in every test file that needs it).
- **Every replicated table carries `lamport_ts INTEGER DEFAULT 0`** and needs: an entry in `SYNCED_TABLES`, `EXCLUDED_COLUMNS` (at least `["lamport_ts"]`), a natural-key apply handler (LWW on the envelope lamport), a `shouldSyncRow` gate, a `stampSql` by-key branch (`servers/shared/sync-stamp.js`), the live `_applyEntry` dispatch block AND the `applyRemoteOp` seam case, and both outbox-door and apply-door tests. **[P3]** `ramble_trades` (natural key `trade_id`) is the ONE new replicated table. `ramble_outbox` is LOCAL (like `ramble_tombstones`): never in `SYNCED_TABLES`, no `lamport_ts`; a test asserts it. The emit hook shape everywhere is `emit(table, op, row)`; in the stdio process it is `emitOrQueue(null, db, …)`, in the gateway `emitOrQueue(getInstanceSyncManager(), db, …)`.
- **Seeds are server-minted, immutable, never accepted from a client.** **[P3]** A gift/trade payload NEVER carries `species` or `seed` (`eggPayload` builds exactly `{ egg_id, warmth, found_cell, found_week }`; `parseEggPayload` ignores anything else). A received egg is unhatched; whoever hatches it rolls the bird.
- **Credits are idempotent server-side** via `ramble_credits(kind, key)`. **[P3]** A contacts mark received from a contact credits `meet_crow` (persona = the contact's x-only pubkey) exactly like a public one; gifts and trades credit nothing.
- **Warmth weights, `nest.rate`, `shelf.cap` are settings** read live. **[P3]** No new setting. `TRADE_TTL_MS = 7 × 86400e3` is a constant exported from `trades.js`.
- **Shelf origin rulings (phase 2, unchanged):** only `shelf_origin = 'sync'` shelf eggs re-promote (mark kept); NULL-origin beats `'sync'` in convergence; an explicit `null` on the wire means plain; a peer's user-shelve never triggers re-promotion; a hatched row never takes an origin. **[P3]** A received egg is written `status='received', shelf_origin='user'` so sync never auto-promotes it (`RAMBLE_EGG_REPROMOTE_SQL` selects `status='shelf'` only — `'received'` is never a candidate). Incubating a received egg writes `shelf_origin = NULL` (the existing incubate swap). A gifted egg becomes `status='gifted'` and keeps its row (never deleted; if it is later gifted back it is revived to `'received'`).
- **Shelf cap counts `'user'` shelf eggs only** (`status='shelf' AND shelf_origin='user'`). **[P3]** Received eggs (`status='received'`) do NOT count toward the claim cap and are listed on the shelf as a separate class ("From <name>"). Ruling: a gift arrives asynchronously and cannot be refused for lack of a spot; spec §9 "no scarcity ledger" makes a cap on gifts pointless.
- **Egg states:** `incubating | shelf | hatched | gifted | received` (spec §5). **Giftable / swappable** = `status IN ('shelf','received')` AND not locked by an open trade. **Locked** = named as `my_egg_id` by a `ramble_trades` row in `state IN ('proposed','accepted')`. Locked eggs cannot be incubated, gifted or offered again (reason `in-trade`).
- **Wire (spec §4, exact):** contacts audience → one NIP-44 kind-4 DM per contact via the EXISTING `nostrManager.sendControl(contact, content)` (no `messages` row, no retry queue); `group:<group_uid>` → the same per member of the core `contact_groups` row (phase-1 `ramble_groups` shared key is DROPPED — the table stays, unused; `ramble_groups` is neither read nor written). Payloads: `{ type: "ramble.mark", v: 1, mark: <wire mark incl. bird> }`, `{ type: "ramble.egg", v: 1, egg: { egg_id, warmth, found_cell, found_week } }`, `{ type: "ramble.trade", v: 1, trade: { trade_id, state, my_egg_id, want_egg_id }, egg?: <egg payload> }`. **Deviation recorded:** the trade envelope may carry `egg` (the sender's offered egg summary) so accept/complete are one message each and never split across two DMs. Receive: `subscribeToContact`'s decrypt path recognizes `type` starting with `ramble.` → `bus.emit("ramble:envelope", …)` → the transport → `receiveEnvelope` → `insertRemoteMark` / `receiveGift` / `receiveTrade`. Contacts marks are persistent (`expires_at = NULL`). Nothing about a contacts/group mark reaches a relay in the clear: the DM's `content` is NIP-44 ciphertext and its only tag is `["p", recipient]` — a test decrypts it and asserts no `g` tag.
- **Contact-only:** the per-contact subscription (authors = that contact's pubkey) is the ONLY inbound door for `ramble.*`; the catch-all `subscribeToIncoming` marks `ramble.*` envelopes handled-and-dropped so a stranger's envelope never becomes a message request. A blocked contact's envelope is dropped (the branch sits after the existing block check). Outbound recipients must be FULL, unblocked, non-bot contacts with a secp key (`request_status IS NULL AND is_blocked = 0 AND COALESCE(is_bot,0) = 0 AND secp256k1_pubkey <> '' AND crow_id NOT LIKE 'req:%'`).
- **Grid gate:** a queued contacts/group MARK is sent only when the privacy grid allows its audience on `geo` (`emitAllowed(grid, audienceOf(visibility), "geo")`, re-read every drain tick, same as public marks). Gifts and trades are explicit directed sends and are NEVER gated. A mark flips to `publish_state='published'` when its last outbox row has been accepted by a relay (or dropped because the recipient vanished).
- **Trade state machine (spec §10, exact):** `proposed → accepted → completed`, `proposed → declined` (either side, only while `proposed`), `proposed|accepted → expired` (local sweep on the drain tick at `expires_at = created_at + TRADE_TTL_MS`), and on the PROPOSER `proposed|expired → declined` when an `accepted` arrives that cannot be honoured (lapsed, egg gone, or it names an egg we hold) — one `declined` reply, then every further copy is a no-op. On the RECEIVING side a `declined` is honoured from `proposed` OR `accepted` (that asymmetry heals the withdraw-vs-accept race: the acceptor's locked egg is released by the proposer's reply). The proposer's row goes `proposed → completed` on receipt of `accepted`; the acceptor's row goes `proposed → accepted → completed` on receipt of `completed`. Every transition is idempotent by `trade_id` (re-delivery of any envelope is a no-op). Eggs change hands ONLY at completion, on each side, inside one `db.batch`.
- **Inbound ceilings (review round 1, S2):** at most `MAX_OPEN_PROPOSALS_PER_CONTACT = 20` open trade rows per counterpart and `MAX_GIFTS_PER_CONTACT_PER_DAY = 20` received eggs per contact per local day; past them an envelope is a silent no-op. A contacts mark is bounded by the existing block list only (a contact who floods marks gets blocked, exactly like a public persona).
- **Rulings (review round 1):** Q1 — the compose card's Group audience STAYS (without it spec §4 group delivery would be MCP-only and unreachable from the panel; the button only appears when a plain contact group exists). Q2 — the decline asymmetry is the protocol (sender only while `proposed`; receiver honours `declined` from `proposed` or `accepted`), documented. Q3 — the duplicate-egg outcomes at the exact moment an offer lapses are accepted under spec §9 (no scarcity ledger); a LOST egg is never accepted (C3 guard). Q4 — a contacts mark credits `meet_crow` keyed on the contact's instance pubkey; meeting the same person on the public wire under a rotating persona the same week credits again — accepted (persona-keyed by design, bounded by `MEET_CROW_DAILY_CAP`). A contacts mark with nobody to send to settles as `published` at once (S4).
- **Delivery identity (round-2 Q1, verified at `servers/sharing/nostr.js:155` "All instances share the same Nostr identity"):** every one of the user's instances subscribes to every contact and therefore RECEIVES every ramble envelope; each applies it locally (idempotent by mark_id / egg_id / trade_id) and instance sync converges the egg/trade rows. A swap reply (`completed`/`declined`) is therefore queued on EVERY instance that received the `accepted`; the counterpart receives N copies and applies one (its own dedup + idempotent transitions). Outbound authoring rows are queued only on the instance that authored. Documented in Operating notes.
- **Panel rules:** `router.use("/api/ramble", dashboardAuth)` path-scoped (never unpathed); client script `static/ramble.js` contains ZERO backticks; remote/user text is written with `textContent` only — the only `innerHTML`/`html:` sinks stay EXACTLY the two engine sinks (`el.innerHTML = Bird.drawEgg(` and `html: nestEggHtml(`); never `express.static`; nothing under `PUBLIC_FUNNEL_PREFIXES`; every input bounded (regex/`.max`, enums); icons are inline SVG, never emoji. **[P3]** No dead buttons: every Gift / Swap / Accept / Decline control posts to a real route.
- **Visual direction C tokens** only; reuse `rb-card`, `rb-step`, `rb-btn`, `rb-btn-ghost`, `rb-tag`, `rb-sheet`, `rb-eyebrow` — no new colours.
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` then `node scripts/run-suite.mjs tests/<file>.test.js` in the FOREGROUND (never bare `node --test`, never a backgrounded suite run). In-memory `createClient({ url: "file::memory:" })` from `@libsql/client` in TEST files only; bundle server files never import it. **NEVER boot a gateway or the MCP server from this worktree without a scratch `CROW_DATA_DIR`.**
- **Commits:** subject-only, positional paths (`git commit <paths> -m …`), verify `git show --stat HEAD`, **no AI attribution trailers of any kind**. Work in `/home/kh0pp/crow-wt-flock3` (branch `feat/ramble-flock-phase3`, `node_modules` symlinked from `~/crow`), never `git checkout` a branch in `~/crow`. `main` is protected: PR + green `suite`/`static-checks`/`audit` check-runs on the head sha (public check-runs API; no `gh` on crow — use the GitHub MCP tools).
- **Bundle version bump is mandatory:** `bundles/ramble/manifest.json` AND `bundles/ramble/package.json` go `0.3.0` → `0.4.0`; `npm run build-registry` regenerates `registry/add-ons.json`. Done in Task 9, before the PR. The docs en/es heading-parity test (`tests/ramble-panel.test.js`, last test) must stay green: every `##`/`###` added to `docs/guide/ramble.md` is mirrored in `docs/es/guide/ramble.md` in the same order and level.
- **Deploy:** restart ALL THREE gateways back-to-back after merge (crow primary `crow-gateway.service`, `crow-r4-gateway.service`, grackle's `crow-gateway` after `git pull --ff-only origin main` in `~/crow` there) before anyone uses the new wire (a phase-2 `NostrManager` stores a ramble envelope as a chat message). Verify grackle's journal shows `[bundles] refreshed ramble 0.3.0 -> 0.4.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered`.
- **Base:** branch from `main` at `b189f033` (PR #315 merge). **Models:** nothing here starts a model; `CROW-SCHEDULE.md` is read before the deploy step only because it is the house rule.

---

## File structure

**Create**
- `bundles/ramble/server/delivery.js` — payload codecs (`markPayload`/`payloadToMark`, `eggPayload`/`parseEggPayload`, `tradePayload`/`parseTradePayload`, `giftPayload`, `markEnvelope`, `isRambleEnvelope`), audience resolution (`resolveContact`, `resolveAudience`, `listAudiences`), the local `ramble_outbox` queue (`enqueueDeliveries`, `enqueueMark`, `pendingDeliveries`, `deleteDelivery`, `noteDeliveryFailure`, `remainingDeliveries`).
- `bundles/ramble/server/trades.js` — gifts (`giftEgg`, `receiveGift`), swaps (`proposeSwap`, `acceptSwap`, `declineSwap`, `receiveTrade`, `expireTrades`, `listTrades`), locks (`lockedEggIds`, `isEggLocked`), and the inbound router `receiveEnvelope`.
- `tests/ramble-delivery.test.js`, `tests/ramble-trades.test.js`, `tests/ramble-nostr-envelope.test.js`.

**Modify**
- `bundles/ramble/server/init-tables.js` — `ramble_trades` (replicated) + `ramble_outbox` (local).
- `servers/sharing/instance-sync.js` — `SYNCED_TABLES`, `EXCLUDED_COLUMNS`, `shouldSyncRow`, `applyRambleTrade`, `applyRemoteOp`, live dispatch.
- `servers/shared/sync-stamp.js` — `ramble_trades` stamp branch.
- `servers/sharing/nostr.js` — `subscribeToContact` ramble branch → `bus.emit("ramble:envelope")`; `subscribeToIncoming` drops `ramble.*`.
- `servers/gateway/boot/ramble-transport.js` — `drainDeliveries`, `expireTrades` on the tick, `onEnvelope`.
- `bundles/ramble/server/flock.js` — `incubateEgg` admits `received`, refuses locked; `flockState` lists received + `locked`.
- `bundles/ramble/panel/routes.js` — `GET /api/ramble/contacts`, `POST /api/ramble/eggs/:id/gift`, `GET/POST /api/ramble/trades`, `/:id/accept`, `/:id/decline`, contacts/group enqueue on `POST /api/ramble/marks`, `contact_name` on listed remote marks.
- `servers/gateway/routes/streams.js` — `ramble-trade` frame.
- `bundles/ramble/server/server.js` — `ramble_gift_egg`, `ramble_propose_swap`, contacts/group enqueue in `ramble_leave_mark`.
- `bundles/ramble/panel/ramble.js`, `panel/static/ramble.js`, `panel/static/ramble.css` — Gift / Swap / Accept / Decline, contact picker sheet, "From <name>", group audience, "Share an invite".
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- Tests: `ramble-tables`, `ramble-sync`, `ramble-flock`, `ramble-transport`, `ramble-panel`, `ramble-stream`, `ramble-tools`.

**Minimal core-table DDL for tests** (the exact columns ramble reads; paste verbatim where a test needs `contacts`/groups — the bundle NEVER creates these in production):

```js
const CORE_DDL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
    secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
  CREATE TABLE IF NOT EXISTS contact_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);`;
```

---

## Task 1: `ramble_trades` (replicated) + `ramble_outbox` (local) — tables and sync plumbing

**Files:**
- Modify: `bundles/ramble/server/init-tables.js` (append after the `ramble_nest_claims` block, line 162)
- Modify: `servers/sharing/instance-sync.js:93-98` (SYNCED_TABLES), `:148-156` (EXCLUDED_COLUMNS), `:333-346` (shouldSyncRow), after `applyRamblePet` (`:818`), `applyRemoteOp` (`:831-840`), live dispatch after the `ramble_pet` block (`:2397-2405`)
- Modify: `servers/shared/sync-stamp.js:196-207` (after the `ramble_pet` branch)
- Test: `tests/ramble-tables.test.js`, `tests/ramble-sync.test.js`

**Interfaces:**
- Produces: table `ramble_trades (trade_id TEXT PK, counterpart TEXT NOT NULL, role TEXT NOT NULL ('proposer'|'acceptor'), my_egg_id TEXT, their_egg_id TEXT, offer_json TEXT, state TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lamport_ts INTEGER DEFAULT 0)`; table `ramble_outbox (id INTEGER PK AUTOINCREMENT, to_crow_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`; `export async function applyRambleTrade(db, op, row, lamportTs)`; `applyRemoteOp(db, "ramble_trades", op, row, lamportTs)`; `stampSql("ramble_trades", { trade_id }, ts)`.
- Deviation from spec §5 recorded: `ramble_trades` gains `role`, `offer_json`, `expires_at` (the protocol needs which side we are, what was offered, and when it lapses).

- [ ] **Step 1: Write the failing table tests**

Append to `tests/ramble-tables.test.js`:

```js
test("phase 3: ramble_trades is a replicated natural-key table; ramble_outbox is local", async () => {
  const cols = async (t) => (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name);
  const trades = await cols("ramble_trades");
  for (const c of ["trade_id", "counterpart", "role", "my_egg_id", "their_egg_id", "offer_json", "state", "created_at", "updated_at", "expires_at", "lamport_ts"]) {
    assert.ok(trades.includes(c), `ramble_trades.${c}`);
  }
  const outbox = await cols("ramble_outbox");
  for (const c of ["id", "to_crow_id", "kind", "ref_id", "payload_json", "attempts", "created_at"]) assert.ok(outbox.includes(c), `ramble_outbox.${c}`);
  assert.ok(!outbox.includes("lamport_ts"), "ramble_outbox never replicates, so it carries no lamport");
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(SYNCED_TABLES.includes("ramble_trades"), "trades follow the user across their instances (spec §5)");
  assert.ok(!SYNCED_TABLES.includes("ramble_outbox"), "the delivery queue is one instance's outbound work");
  await db.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, state, created_at, updated_at, expires_at) VALUES ('t1','crow:x','proposer','proposed',1,1,2)", args: [] });
  await assert.rejects(db.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, state, created_at, updated_at, expires_at) VALUES ('t1','crow:y','acceptor','proposed',1,1,2)", args: [] }));
});
```

Append to `tests/ramble-sync.test.js`:

```js
test("phase 3: allowlist + exclusions + gate for ramble_trades", () => {
  assert.ok(SYNCED_TABLES.includes("ramble_trades"));
  assert.deepEqual(EXCLUDED_COLUMNS.ramble_trades, ["lamport_ts"]);
  assert.equal(shouldSyncRow("ramble_trades", null), false);
  assert.equal(shouldSyncRow("ramble_trades", { counterpart: "crow:x" }), false, "keyless rows never sync");
  assert.equal(shouldSyncRow("ramble_trades", { trade_id: "t1" }), true);
});

test("phase 3 outbox door: a trade write with no manager queues and is stamped by trade_id", async () => {
  await a.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, state, created_at, updated_at, expires_at) VALUES ('t-out','crow:peer','proposer','egg-1','proposed',10,10,999)", args: [] });
  const { rows } = await a.execute("SELECT * FROM ramble_trades WHERE trade_id='t-out'");
  const res = await emitOrQueue(null, a, "ramble_trades", "insert", rows[0]);
  assert.ok(res && res.queued, "emitOrQueue returned null — missing stampSql branch or lamport_ts?");
  const stamped = await a.execute("SELECT lamport_ts FROM ramble_trades WHERE trade_id='t-out'");
  assert.ok(Number(stamped.rows[0].lamport_ts) > 0, "trade row was never stamped — missing stampSql branch?");
  const queued = await a.execute("SELECT row_json, lamport_ts FROM sync_outbox WHERE table_name='ramble_trades' ORDER BY id DESC LIMIT 1");
  const wire = JSON.parse(queued.rows[0].row_json);
  assert.equal(wire.trade_id, "t-out");
  assert.equal(wire.role, "proposer");
  assert.equal(wire.state, "proposed");
  assert.ok(!("lamport_ts" in wire), "lamport rides the envelope, never the row");
  assert.equal(Number(queued.rows[0].lamport_ts), Number(stamped.rows[0].lamport_ts));
});

test("phase 3 apply door: trade insert, LWW by envelope lamport, update, delete by trade_id", async () => {
  const row = { trade_id: "t-in", counterpart: "crow:peer", role: "acceptor", my_egg_id: null, their_egg_id: "egg-9", offer_json: '{"warmth":40}', state: "proposed", created_at: 5, updated_at: 5, expires_at: 99 };
  await applyRemoteOp(b, "ramble_trades", "insert", row, 5);
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, state: "declined" }, 3); // stale
  let got = await b.execute("SELECT state, role, their_egg_id FROM ramble_trades WHERE trade_id='t-in'");
  assert.deepEqual([got.rows[0].state, got.rows[0].role, got.rows[0].their_egg_id], ["proposed", "acceptor", "egg-9"]);
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, state: "accepted", my_egg_id: "egg-2", updated_at: 7 }, 7);
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, state: "accepted", my_egg_id: "egg-2", updated_at: 7 }, 7); // idempotent re-delivery
  got = await b.execute("SELECT state, my_egg_id, lamport_ts FROM ramble_trades WHERE trade_id='t-in'");
  assert.deepEqual([got.rows[0].state, got.rows[0].my_egg_id, Number(got.rows[0].lamport_ts)], ["accepted", "egg-2", 7]);
  // created_at is immutable on conflict
  await applyRemoteOp(b, "ramble_trades", "update", { ...row, created_at: 1, state: "completed" }, 8);
  got = await b.execute("SELECT created_at, state FROM ramble_trades WHERE trade_id='t-in'");
  assert.deepEqual([got.rows[0].created_at, got.rows[0].state], [5, "completed"]);
  await applyRemoteOp(b, "ramble_trades", "delete", { trade_id: "t-in" }, 9);
  assert.equal((await b.execute("SELECT 1 FROM ramble_trades WHERE trade_id='t-in'")).rows.length, 0);
  await assert.doesNotReject(applyRemoteOp(b, "ramble_trades", "update", { counterpart: "x" }, 10), "a keyless row is ignored, never thrown on");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-flock3 && node scripts/run-suite.mjs tests/ramble-tables.test.js && node scripts/run-suite.mjs tests/ramble-sync.test.js`
Expected: FAIL — `no such table: ramble_trades`, `SYNCED_TABLES.includes("ramble_trades")` false, `applyRemoteOp: no natural-key handler for table "ramble_trades"`.

- [ ] **Step 3: Add the tables**

Append to `initRambleTables` in `bundles/ramble/server/init-tables.js`, after the `ramble_nest_claims` block (before the closing `}`):

```js
  // Phase 3: egg swaps. REPLICATED (the user's own instances show the same
  // open offers) — natural key trade_id, lamport_ts for the envelope LWW
  // (servers/sharing/instance-sync.js applyRambleTrade). `role` says which
  // side of the swap this instance's user is; `offer_json` is the sanitized
  // summary of the counterpart's egg as it arrived (display only; the egg
  // itself is materialized from the completing envelope); `expires_at` is
  // created_at + TRADE_TTL_MS, swept locally on the drain tick.
  await initTable(db, "ramble_trades", `
    CREATE TABLE IF NOT EXISTS ramble_trades (
      trade_id TEXT PRIMARY KEY,
      counterpart TEXT NOT NULL,
      role TEXT NOT NULL,
      my_egg_id TEXT,
      their_egg_id TEXT,
      offer_json TEXT,
      state TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_trades_state ON ramble_trades(state);`);

  // Phase 3: the contacts-delivery queue. LOCAL by design, exactly like
  // ramble_tombstones: one row per (recipient, thing to send); the gateway
  // transport turns each into one NIP-44 DM and deletes the row once a relay
  // accepted it. No lamport_ts, never in SYNCED_TABLES — only the instance
  // that authored a mark/gift/offer, or answered a swap step, delivers it (a
  // replicated copy on the user's other Crow must not send it a second time).
  await initTable(db, "ramble_outbox", `
    CREATE TABLE IF NOT EXISTS ramble_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_crow_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ramble_outbox_ref ON ramble_outbox(kind, ref_id);`);
```

- [ ] **Step 4: Sync plumbing in `servers/sharing/instance-sync.js`**

(a) `SYNCED_TABLES` — after `"ramble_pet",` add:

```js
  // Phase 3: swaps follow the user too — an offer made on one Crow is visible
  // (and answerable) on their others. NOT ramble_outbox: the delivery queue is
  // one instance's outbound work item, like ramble_tombstones.
  "ramble_trades",
```

(b) `EXCLUDED_COLUMNS` — after `ramble_pet: ["lamport_ts"],` add:

```js
  // Phase 3: natural-key (trade_id), no surrogate key; lamport is envelope metadata.
  ramble_trades: ["lamport_ts"],
```

(c) `shouldSyncRow` — after the `ramble_pet` branch (before `if (table === "ramble_settings")`) add:

```js
  if (table === "ramble_trades") {
    // trade_id is the wire key — a row without it can be neither stamped,
    // applied nor deleted on a peer.
    if (!row) return false;
    return Boolean(row.trade_id);
  }
```

(d) After `applyRamblePet` (before the `applyRemoteOp` doc comment) add:

```js
/** Portable columns of `ramble_trades`, in schema order. `lamport_ts` is envelope metadata. */
const RAMBLE_TRADE_WIRE_COLUMNS = [
  "trade_id", "counterpart", "role", "my_egg_id", "their_egg_id", "offer_json",
  "state", "created_at", "updated_at", "expires_at",
];

/** `trade_id` is the key; `created_at` is the immutable birth time (and the expiry base). */
const RAMBLE_TRADE_UPDATE_COLUMNS = RAMBLE_TRADE_WIRE_COLUMNS.filter((c) => c !== "trade_id" && c !== "created_at");

/**
 * Apply a `ramble_trades` mutation, keyed on `trade_id`. Same LWW-on-the-
 * envelope rule as `applyRambleMark`; deletes are honoured (no product path
 * deletes a trade today, but a future prune on the authoring side must be
 * able to reach the peer). Only the columns the wire row carries are
 * written, so a sparse row never binds `undefined`. Applies never emit and
 * never touch ramble_eggs: the egg movements of a completed swap ride the
 * wire as their own ramble_eggs ops from the instance that completed it.
 */
export async function applyRambleTrade(db, op, row, lamportTs) {
  if (!row || !row.trade_id) return;

  const { rows: existing } = await db.execute({
    sql: `SELECT lamport_ts FROM ramble_trades WHERE trade_id = ?`,
    args: [row.trade_id],
  });
  const localTs = Number(existing[0]?.lamport_ts) || 0;
  if (lamportTs < localTs) return;

  if (op === "delete") {
    await db.execute({ sql: `DELETE FROM ramble_trades WHERE trade_id = ?`, args: [row.trade_id] });
    return;
  }

  const cols = RAMBLE_TRADE_WIRE_COLUMNS.filter((c) => row[c] !== undefined);
  const setClauses = [
    ...cols.filter((c) => RAMBLE_TRADE_UPDATE_COLUMNS.includes(c)).map((c) => `${c} = excluded.${c}`),
    "lamport_ts = excluded.lamport_ts",
  ];
  await db.execute({
    sql: `INSERT INTO ramble_trades (${cols.join(", ")}, lamport_ts)
          VALUES (${cols.map(() => "?").join(", ")}, ?)
          ON CONFLICT(trade_id) DO UPDATE SET ${setClauses.join(", ")}`,
    args: [...cols.map((c) => row[c] ?? null), lamportTs],
  });
}
```

(e) `applyRemoteOp`: add `case "ramble_trades":   return applyRambleTrade(db, op, row, lamportTs);` after the `ramble_pet` case, and extend the JSDoc `@param` union with `"ramble_trades"` ("six ramble natural-key handlers").

(f) Live dispatch — after the `if (table === "ramble_pet") { … return; }` block add:

```js
    if (table === "ramble_trades") {
      try {
        await applyRambleTrade(this.db, op, row, lamport_ts);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on ramble_trades:`, err.message);
      }
      return;
    }
```

- [ ] **Step 5: Stamp branch in `servers/shared/sync-stamp.js`**

After the `ramble_pet` branch add:

```js
  // Phase 3: swaps are keyed on trade_id (no `id` column) — same story.
  if (table === "ramble_trades" && row.trade_id !== undefined) {
    return {
      sql: `UPDATE ramble_trades SET lamport_ts = ? WHERE trade_id = ?`,
      args: [lamportTs, row.trade_id],
    };
  }
```

- [ ] **Step 6: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-tables.test.js && node scripts/run-suite.mjs tests/ramble-sync.test.js && node scripts/run-suite.mjs tests/sync-stamp.test.js && node scripts/run-suite.mjs tests/instance-sync.test.js`
Expected: all PASS (the last two exist already and must not regress; if `tests/sync-stamp.test.js` does not exist, skip it).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-09-07-ramble-flock-phase3-contacts-gifts-swaps.md   # new file: positional commit needs it tracked first
git commit docs/superpowers/plans/2026-09-07-ramble-flock-phase3-contacts-gifts-swaps.md bundles/ramble/server/init-tables.js servers/sharing/instance-sync.js servers/shared/sync-stamp.js tests/ramble-tables.test.js tests/ramble-sync.test.js -m "ramble: ramble_trades replicated table + ramble_outbox local queue"
git show --stat HEAD
```

---

## Task 2: `delivery.js` — payload codecs, audience resolution, the outbox

**Files:**
- Create: `bundles/ramble/server/delivery.js`
- Test: `tests/ramble-delivery.test.js`

**Interfaces:**
- Consumes: `CELL7_RE`, `WEEK_RE` from `./nests.js`; `isValidBird` from `./bird-svg.cjs`; table `ramble_outbox` (Task 1); core `contacts` / `contact_groups` / `contact_group_members` (read only).
- Produces (all exported):
  - `CROW_ID_RE`, `ID_RE` (`/^[A-Za-z0-9_:.-]{1,128}$/`), `GEOHASH_RE`, `MAX_TEXT_LEN = 2000`, `MAX_WARMTH = 100000`, `DELIVERY_KINDS = ["mark","egg","trade"]`, `TRADE_STATES`, `MAX_DELIVERY_ATTEMPTS = 20`
  - `isRambleEnvelope(p): boolean`
  - `eggPayload(eggRow) -> { egg_id, warmth, found_cell, found_week }`; `parseEggPayload(obj) -> same | null`
  - `markPayload(row, { bird }) -> wire mark`; `markEnvelope(row, { bird }) -> { type:"ramble.mark", v:1, mark }`; `payloadToMark(mark, { author, eventId }) -> insertRemoteMark row | null`
  - `giftPayload(eggRow) -> { type:"ramble.egg", v:1, egg }`
  - `tradePayload({ trade_id, state, my_egg_id, want_egg_id }, eggRow|null) -> { type:"ramble.trade", v:1, trade, egg? }`; `parseTradePayload(obj) -> { trade_id, state, my_egg_id, want_egg_id, egg } | null`
  - `resolveContact(db, crowId) -> { id, crow_id, display_name, secp256k1_pubkey } | null`
  - `listAudiences(db) -> { contacts: [{ crow_id, display_name }], groups: [{ group_uid, name, member_count }] }`
  - `resolveAudience(db, visibility) -> { ok:true, crowIds } | { ok:false, reason:"unknown-group"|"not-deliverable" }`
  - `enqueueDeliveries(db, { toCrowIds, kind, refId, payload, now }) -> number`; `enqueueMark(db, row, { bird, now }) -> { ok, recipients, reason? }`
  - `pendingDeliveries(db, limit)`, `deleteDelivery(db, id)`, `noteDeliveryFailure(db, row, max) -> { parked, attempts }`, `remainingDeliveries(db, kind, refId) -> number`

- [ ] **Step 1: Write the failing tests**

Create `tests/ramble-delivery.test.js`:

```js
/**
 * Phase 3 — delivery.js: the wire codecs (what a mark/egg/trade look like
 * inside a NIP-44 DM), audience resolution against the core contact tables,
 * and the LOCAL ramble_outbox queue. No Nostr here.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark } from "../bundles/ramble/server/marks.js";
import {
  isRambleEnvelope, eggPayload, parseEggPayload, markPayload, markEnvelope, payloadToMark,
  giftPayload, tradePayload, parseTradePayload,
  resolveContact, listAudiences, resolveAudience,
  enqueueDeliveries, enqueueMark, pendingDeliveries, deleteDelivery, noteDeliveryFailure, remainingDeliveries,
  MAX_DELIVERY_ATTEMPTS, MAX_WARMTH,
} from "../bundles/ramble/server/delivery.js";

const CORE_DDL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
    secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
  CREATE TABLE IF NOT EXISTS contact_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);`;

const PK = "ab".repeat(32);
let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await db.executeMultiple(CORE_DDL);
  await db.executeMultiple(`
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:full', 'Full', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:other', 'Other', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blocked', 'Blocked', '02${PK}', 1);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, request_status) VALUES ('req:${PK}', NULL, '${PK}', 'pending');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_bot) VALUES ('crow:bot', 'Bot', '02${PK}', 1);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:nokey', 'NoKey', '');
    INSERT INTO contact_groups (name, group_uid) VALUES ('Walkers', 'grp-walk');
    INSERT INTO contact_groups (name, group_uid, room_uid) VALUES ('A room', 'grp-room', 'room-1');
    INSERT INTO contact_groups (name, group_uid) VALUES ('Legacy', NULL);
    INSERT INTO contact_group_members (group_id, contact_id) VALUES (1, 1), (1, 3), (1, 5);`);
});

test("egg payload never carries species/seed and parses back bounded", () => {
  const p = eggPayload({ egg_id: "e1", warmth: 40.7, found_cell: "9v6m21h", found_week: "2026-W37", species: "crow", seed: 9 });
  assert.deepEqual(p, { egg_id: "e1", warmth: 40, found_cell: "9v6m21h", found_week: "2026-W37" });
  assert.deepEqual(parseEggPayload({ ...p, species: "crow", seed: 1 }), p);
  assert.deepEqual(parseEggPayload({ egg_id: "e2", warmth: 5e9, found_cell: "bad", found_week: "W3" }), { egg_id: "e2", warmth: 0, found_cell: null, found_week: null }, "a non-integer warmth reads as 0; bad cell/week read as null");
  assert.deepEqual(parseEggPayload({ egg_id: "e3", warmth: MAX_WARMTH + 5 }), { egg_id: "e3", warmth: MAX_WARMTH, found_cell: null, found_week: null });
  assert.equal(parseEggPayload({ egg_id: "../x", warmth: 1 }), null);
  assert.equal(parseEggPayload(null), null);
  assert.equal(parseEggPayload("e1"), null);
  assert.deepEqual(giftPayload({ egg_id: "e1", warmth: 3 }), { type: "ramble.egg", v: 1, egg: { egg_id: "e1", warmth: 3, found_cell: null, found_week: null } });
});

test("mark payload round-trips through payloadToMark as a persistent contacts mark attributed to the sender", async () => {
  const row = await createMark(db, {
    author: "c".repeat(64), author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08, accuracy_m: 12 },
    visibility: "contacts", reveal: "locked",
    content: { content_text: "for my people", content_kind: "none" },
  });
  const env = markEnvelope(row, { bird: { species: "crow", seed: 5 } });
  assert.equal(env.type, "ramble.mark"); assert.equal(env.v, 1);
  assert.deepEqual(env.mark.bird, { species: "crow", seed: 5 });
  assert.ok(!("visibility" in env.mark) && !("author" in env.mark) && !("origin" in env.mark), "the recipient decides visibility/author/origin, never the wire");
  assert.equal(markPayload(row, { bird: { species: "dragon", seed: 1 } }).bird, undefined, "an invalid bird is dropped, not shipped");

  const back = payloadToMark(env.mark, { author: PK, eventId: "evt-1" });
  assert.equal(back.mark_id, row.mark_id);
  assert.equal(back.author, PK); assert.equal(back.author_level, "real");
  assert.equal(back.visibility, "contacts"); assert.equal(back.expires_at, null, "contacts marks are persistent (spec §4)");
  assert.equal(back.origin, "remote"); assert.equal(back.publish_state, "remote"); assert.equal(back.nostr_event_id, "evt-1");
  assert.equal(back.reveal, "locked"); assert.equal(back.content_text, "for my people");
  assert.equal(back.lat, 30.46); assert.equal(back.geohash, row.geohash);
  assert.deepEqual([back.bird_species, back.bird_seed], ["crow", 5]);

  // Bounds: text truncated, bad coords/ids/kinds rejected, no anchor at all rejected.
  const long = payloadToMark({ ...env.mark, content_text: "x".repeat(5000) }, { author: PK });
  assert.equal(long.content_text.length, 2000);
  assert.equal(payloadToMark({ ...env.mark, mark_id: "bad id" }, { author: PK }), null);
  assert.equal(payloadToMark({ ...env.mark, kind: "shout" }, { author: PK }), null);
  assert.equal(payloadToMark({ ...env.mark, lat: 91 }, { author: PK }).lat, null, "an out-of-range coordinate is dropped, not stored");
  assert.equal(payloadToMark({ ...env.mark, lat: null, lon: null, geohash: null }, { author: PK }), null, "nothing to pin");
  assert.equal(payloadToMark({ ...env.mark, bird: { species: "dragon", seed: 1 } }, { author: PK }).bird_species, null);
  assert.equal(payloadToMark(env.mark, { author: null }), null);
  assert.equal(payloadToMark("nope", { author: PK }), null);
});

test("trade payload builds and parses; malformed ids, states and eggs are rejected", () => {
  const p = tradePayload({ trade_id: "t1", state: "proposed", my_egg_id: "e1", want_egg_id: null }, { egg_id: "e1", warmth: 7 });
  assert.deepEqual(p, { type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "proposed", my_egg_id: "e1", want_egg_id: null }, egg: { egg_id: "e1", warmth: 7, found_cell: null, found_week: null } });
  assert.deepEqual(parseTradePayload(p), { trade_id: "t1", state: "proposed", my_egg_id: "e1", want_egg_id: null, egg: { egg_id: "e1", warmth: 7, found_cell: null, found_week: null } });
  const bare = tradePayload({ trade_id: "t1", state: "declined" });
  assert.equal(bare.egg, undefined);
  assert.deepEqual(parseTradePayload(bare), { trade_id: "t1", state: "declined", my_egg_id: null, want_egg_id: null, egg: null });
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "stolen" } }), null);
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t 1", state: "proposed" } }), null);
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "proposed", my_egg_id: "e/1" } }), null);
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "proposed" }, egg: { warmth: 1 } }), null, "an egg without an id is malformed, not ignored");
  assert.equal(parseTradePayload({ type: "ramble.egg", v: 1, egg: {} }), null);
  assert.equal(isRambleEnvelope({ type: "ramble.mark" }), true);
  assert.equal(isRambleEnvelope({ type: "crow_social" }), false);
  assert.equal(isRambleEnvelope(["ramble.mark"]), false);
  assert.equal(isRambleEnvelope(null), false);
});

test("audience: full unblocked non-bot keyed contacts only; groups by group_uid, rooms and legacy groups excluded", async () => {
  assert.deepEqual((await resolveAudience(db, "contacts")), { ok: true, crowIds: ["crow:full", "crow:other"] });
  assert.deepEqual((await resolveAudience(db, "group:grp-walk")), { ok: true, crowIds: ["crow:full"] }, "blocked and bot members are skipped");
  assert.deepEqual(await resolveAudience(db, "group:grp-room"), { ok: false, reason: "unknown-group" }, "a room is not a plain group");
  assert.deepEqual(await resolveAudience(db, "group:nope"), { ok: false, reason: "unknown-group" });
  assert.deepEqual(await resolveAudience(db, "group:"), { ok: false, reason: "unknown-group" });
  assert.deepEqual(await resolveAudience(db, "public"), { ok: false, reason: "not-deliverable" });
  assert.deepEqual(await resolveAudience(db, "private"), { ok: false, reason: "not-deliverable" });
  const aud = await listAudiences(db);
  assert.deepEqual(aud.contacts, [{ crow_id: "crow:full", display_name: "Full" }, { crow_id: "crow:other", display_name: "Other" }]);
  assert.deepEqual(aud.groups, [{ group_uid: "grp-walk", name: "Walkers", member_count: 1 }]);
  assert.equal((await resolveContact(db, "crow:full")).display_name, "Full");
  assert.equal(await resolveContact(db, "crow:blocked"), null);
  assert.equal(await resolveContact(db, "crow:bot"), null);
  assert.equal(await resolveContact(db, "crow:nokey"), null);
  assert.equal(await resolveContact(db, `req:${PK}`), null);
  assert.equal(await resolveContact(db, "crow:no such"), null, "an id that fails CROW_ID_RE never reaches SQL");
});

test("outbox: one row per unique recipient, drain helpers, failure parking at MAX_DELIVERY_ATTEMPTS", async () => {
  const n = await enqueueDeliveries(db, { toCrowIds: ["crow:full", "crow:other", "crow:full", "bad id"], kind: "egg", refId: "e1", payload: giftPayload({ egg_id: "e1", warmth: 1 }), now: 100 });
  assert.equal(n, 2);
  let rows = await pendingDeliveries(db, 50);
  assert.deepEqual(rows.map((r) => [r.to_crow_id, r.kind, r.ref_id, r.attempts]), [["crow:full", "egg", "e1", 0], ["crow:other", "egg", "e1", 0]]);
  assert.equal(JSON.parse(rows[0].payload_json).type, "ramble.egg");
  assert.equal(await remainingDeliveries(db, "egg", "e1"), 2);
  await deleteDelivery(db, rows[0].id);
  assert.equal(await remainingDeliveries(db, "egg", "e1"), 1);
  let r = await noteDeliveryFailure(db, rows[1], MAX_DELIVERY_ATTEMPTS);
  assert.deepEqual(r, { parked: false, attempts: 1 });
  rows = await pendingDeliveries(db, 50);
  assert.equal(rows[0].attempts, 1);
  for (let i = 1; i < MAX_DELIVERY_ATTEMPTS - 1; i++) r = await noteDeliveryFailure(db, { ...rows[0], attempts: i }, MAX_DELIVERY_ATTEMPTS);
  assert.equal(r.parked, false);
  r = await noteDeliveryFailure(db, { ...rows[0], attempts: MAX_DELIVERY_ATTEMPTS - 1 }, MAX_DELIVERY_ATTEMPTS);
  assert.equal(r.parked, true);
  assert.equal(await remainingDeliveries(db, "egg", "e1"), 0, "a parked delivery leaves the queue");
  await assert.rejects(enqueueDeliveries(db, { toCrowIds: ["crow:full"], kind: "letter", refId: "x", payload: {} }));
  assert.equal(await enqueueDeliveries(db, { toCrowIds: [], kind: "egg", refId: "x", payload: {} }), 0);
});

test("enqueueMark fans a contacts mark out to every full contact and refuses an unknown group", async () => {
  const row = await createMark(db, {
    author: "c".repeat(64), author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08 },
    visibility: "contacts", reveal: "open", content: { content_text: "fan out" },
  });
  assert.deepEqual(await enqueueMark(db, row, { bird: null, now: 5 }), { ok: true, recipients: 2 });
  const rows = (await pendingDeliveries(db, 50)).filter((r) => r.kind === "mark" && r.ref_id === row.mark_id);
  assert.deepEqual(rows.map((r) => r.to_crow_id), ["crow:full", "crow:other"]);
  assert.equal(JSON.parse(rows[0].payload_json).mark.content_text, "fan out");
  assert.deepEqual(await enqueueMark(db, { ...row, mark_id: "m-g", visibility: "group:nope" }), { ok: false, reason: "unknown-group", recipients: 0 });
  assert.deepEqual(await enqueueMark(db, { ...row, mark_id: "m-g2", visibility: "group:grp-walk" }), { ok: true, recipients: 1 });
  assert.deepEqual(await enqueueMark(db, { ...row, mark_id: "m-p", visibility: "public" }), { ok: false, reason: "not-deliverable", recipients: 0 });
  // Trades and gifts jump the queue ahead of marks (C1: gated marks must never starve them).
  await enqueueDeliveries(db, { toCrowIds: ["crow:full"], kind: "trade", refId: "t-late", payload: {}, now: 9 });
  assert.equal((await pendingDeliveries(db, 1))[0].kind, "trade");
  // A mark with nobody to send to settles at once (S4).
  await db.execute("INSERT INTO contact_groups (name, group_uid) VALUES ('Empty', 'grp-empty')");
  const lonely = await createMark(db, {
    author: "c".repeat(64), author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08 },
    visibility: "group:grp-empty", reveal: "open", content: { content_text: "echo" },
  });
  assert.deepEqual(await enqueueMark(db, lonely), { ok: true, recipients: 0 });
  assert.equal((await db.execute({ sql: "SELECT publish_state FROM ramble_marks WHERE mark_id = ?", args: [lonely.mark_id] })).rows[0].publish_state, "published");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/run-suite.mjs tests/ramble-delivery.test.js`
Expected: FAIL — `Cannot find module '../bundles/ramble/server/delivery.js'`.

- [ ] **Step 3: Write `bundles/ramble/server/delivery.js`**

```js
/**
 * Ramble delivery — the contacts wire, minus Nostr (spec §4, phase 3).
 *
 * Three things live here:
 *   1. the payload codecs: what a mark, a gifted egg or a swap step looks like
 *      INSIDE a NIP-44 DM. Every inbound field is bounded here and nowhere else
 *      (the transport hands a decrypted object straight to these parsers);
 *   2. audience resolution against the CORE tables `contacts`,
 *      `contact_groups`, `contact_group_members` (read only — ramble never
 *      creates or writes them). `group:<group_uid>` means a plain contact
 *      group; the phase-1 `ramble_groups` shared-key table is unused;
 *   3. the LOCAL `ramble_outbox` queue: one row per (recipient, thing to
 *      send). The gateway transport (servers/gateway/boot/ramble-transport.js)
 *      drains it into `nostrManager.sendControl` and deletes each row once a
 *      relay accepted the DM.
 *
 * An egg on the wire is unhatched by definition: `eggPayload` ships exactly
 * { egg_id, warmth, found_cell, found_week } and `parseEggPayload` ignores
 * anything else, so species/seed can never travel (Global Constraints).
 */
import { createRequire } from "node:module";
import { CELL7_RE, WEEK_RE } from "./nests.js";

const require = createRequire(import.meta.url);
const { isValidBird } = require("./bird-svg.cjs");

export const CROW_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
/** mark_id / egg_id / trade_id — the same shape routes.js already accepts. */
export const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
export const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/;
const GROUP_UID_RE = /^[A-Za-z0-9_:.-]{1,120}$/;
const ANCHOR_KIND_RE = /^[a-z]{1,16}$/;
export const MAX_TEXT_LEN = 2000;
export const MAX_WARMTH = 100000;
const MAX_CREATED_AT = 4102444800000; // 2100-01-01
export const DELIVERY_KINDS = ["mark", "egg", "trade"];
export const TRADE_STATES = ["proposed", "accepted", "completed", "expired", "declined"];
export const MAX_DELIVERY_ATTEMPTS = 20;

export function isRambleEnvelope(p) {
  return !!p && typeof p === "object" && !Array.isArray(p) && typeof p.type === "string" && p.type.startsWith("ramble.");
}

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
const idOrNull = (v) => (typeof v === "string" && ID_RE.test(v) ? v : null);
const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/* ------------------------------------------------------------------ eggs */

/** The unhatched egg as it travels: no species, no seed, no status, no origin. */
export function eggPayload(egg) {
  return {
    egg_id: egg.egg_id,
    warmth: Math.max(0, Math.min(MAX_WARMTH, Math.trunc(Number(egg.warmth) || 0))),
    found_cell: egg.found_cell ?? null,
    found_week: egg.found_week ?? null,
  };
}

/** Inverse of eggPayload with bounds: null only when there is no usable egg_id. */
export function parseEggPayload(egg) {
  if (!egg || typeof egg !== "object" || Array.isArray(egg)) return null;
  const egg_id = idOrNull(egg.egg_id);
  if (!egg_id) return null;
  const warmth = Number.isInteger(egg.warmth) ? Math.max(0, Math.min(MAX_WARMTH, egg.warmth)) : 0;
  const found_cell = typeof egg.found_cell === "string" && CELL7_RE.test(egg.found_cell) ? egg.found_cell : null;
  const found_week = typeof egg.found_week === "string" && WEEK_RE.test(egg.found_week) ? egg.found_week : null;
  return { egg_id, warmth, found_cell, found_week };
}

export function giftPayload(egg) {
  return { type: "ramble.egg", v: 1, egg: eggPayload(egg) };
}

/* ----------------------------------------------------------------- marks */

/**
 * A `ramble_marks` row as it travels to a contact. No visibility, author,
 * origin or publish bookkeeping: the recipient sets those from the DM
 * itself (the sender IS the contact the DM came from).
 */
export function markPayload(row, { bird = null } = {}) {
  const mark = {
    mark_id: row.mark_id,
    kind: row.kind,
    anchor_kind: row.anchor_kind,
    geohash: row.geohash ?? null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    accuracy_m: row.accuracy_m ?? null,
    anchor_ref: row.anchor_ref ?? null,
    reveal: row.reveal ?? "open",
    content_text: typeof row.content_text === "string" ? row.content_text.slice(0, MAX_TEXT_LEN) : null,
    content_kind: row.content_kind ?? "none",
    content_ref: row.content_ref ?? null,
    created_at: row.created_at,
  };
  if (isValidBird(bird)) mark.bird = { species: bird.species, seed: bird.seed };
  return mark;
}

export function markEnvelope(row, { bird = null } = {}) {
  return { type: "ramble.mark", v: 1, mark: markPayload(row, { bird }) };
}

/**
 * Inverse of markPayload, shaped for `insertRemoteMark`. `author` is the
 * VERIFIED sender (the contact's x-only pubkey the DM decrypted under), never
 * anything from the payload. Contacts marks are persistent (`expires_at`
 * null) and always land as visibility 'contacts' — a group uid means nothing
 * to the recipient. Returns null when there is nothing safe to store.
 */
export function payloadToMark(mark, { author, eventId = null } = {}) {
  if (!mark || typeof mark !== "object" || Array.isArray(mark)) return null;
  if (typeof author !== "string" || !/^[0-9a-f]{64}$/.test(author)) return null;
  const mark_id = idOrNull(mark.mark_id);
  if (!mark_id) return null;
  const kind = mark.kind === "caw" ? "caw" : (mark.kind === "mark" ? "mark" : null);
  if (!kind) return null;
  const lat = num(mark.lat, -90, 90);
  const lon = num(mark.lon, -180, 180);
  const geohash = typeof mark.geohash === "string" && GEOHASH_RE.test(mark.geohash) ? mark.geohash : null;
  if (!geohash && (lat == null || lon == null)) return null; // nothing to pin
  const bird = isValidBird(mark.bird) ? mark.bird : null;
  return {
    mark_id,
    author,
    author_level: "real",
    kind,
    anchor_kind: typeof mark.anchor_kind === "string" && ANCHOR_KIND_RE.test(mark.anchor_kind) ? mark.anchor_kind : "geo",
    geohash,
    lat,
    lon,
    accuracy_m: num(mark.accuracy_m, 0, 100000),
    anchor_ref: str(mark.anchor_ref, 256),
    visibility: "contacts",
    reveal: mark.reveal === "locked" ? "locked" : "open",
    content_text: typeof mark.content_text === "string" ? mark.content_text.slice(0, MAX_TEXT_LEN) : null,
    content_kind: str(mark.content_kind, 64) ?? "none",
    content_ref: str(mark.content_ref, 1024),
    created_at: num(mark.created_at, 0, MAX_CREATED_AT) ?? Date.now(),
    expires_at: null,
    nostr_event_id: eventId,
    origin: "remote",
    publish_state: "remote",
    bird_species: bird ? bird.species : null,
    bird_seed: bird ? bird.seed : null,
  };
}

/* ---------------------------------------------------------------- trades */

export function tradePayload({ trade_id, state, my_egg_id = null, want_egg_id = null }, egg = null) {
  const out = { type: "ramble.trade", v: 1, trade: { trade_id, state, my_egg_id, want_egg_id } };
  if (egg) out.egg = eggPayload(egg);
  return out;
}

/** Null for anything malformed: a bad id, an unknown state, an egg without an id. */
export function parseTradePayload(p) {
  if (!isRambleEnvelope(p) || p.type !== "ramble.trade") return null;
  const t = p.trade;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const trade_id = idOrNull(t.trade_id);
  const state = TRADE_STATES.includes(t.state) ? t.state : null;
  if (!trade_id || !state) return null;
  const my_egg_id = t.my_egg_id == null ? null : idOrNull(t.my_egg_id);
  if (t.my_egg_id != null && !my_egg_id) return null;
  const want_egg_id = t.want_egg_id == null ? null : idOrNull(t.want_egg_id);
  if (t.want_egg_id != null && !want_egg_id) return null;
  const egg = p.egg == null ? null : parseEggPayload(p.egg);
  if (p.egg != null && !egg) return null;
  return { trade_id, state, my_egg_id, want_egg_id, egg };
}

/* -------------------------------------------------------------- audience */

/** A deliverable contact: full (not a request), unblocked, not a bot, with a key. */
function contactFilter(alias) {
  const a = alias ? `${alias}.` : "";
  return `${a}is_blocked = 0 AND ${a}request_status IS NULL AND COALESCE(${a}is_bot, 0) = 0
          AND ${a}secp256k1_pubkey IS NOT NULL AND ${a}secp256k1_pubkey <> '' AND ${a}crow_id NOT LIKE 'req:%'`;
}

export async function resolveContact(db, crowId) {
  if (typeof crowId !== "string" || !CROW_ID_RE.test(crowId)) return null;
  const { rows } = await db.execute({
    sql: `SELECT id, crow_id, display_name, secp256k1_pubkey FROM contacts WHERE crow_id = ? AND ${contactFilter("")}`,
    args: [crowId],
  });
  return rows[0] ?? null;
}

export async function listAudiences(db) {
  const { rows: c } = await db.execute({
    sql: `SELECT crow_id, display_name FROM contacts WHERE ${contactFilter("")} ORDER BY display_name, crow_id`,
    args: [],
  });
  const { rows: g } = await db.execute({
    sql: `SELECT g.group_uid, g.name,
                 (SELECT count(*) FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
                   WHERE m.group_id = g.id AND ${contactFilter("c")}) AS member_count
            FROM contact_groups g WHERE g.group_uid IS NOT NULL AND g.room_uid IS NULL ORDER BY g.name, g.group_uid`,
    args: [],
  });
  return {
    contacts: c.map((r) => ({ crow_id: r.crow_id, display_name: r.display_name ?? null })),
    groups: g.map((r) => ({ group_uid: r.group_uid, name: r.name, member_count: Number(r.member_count) || 0 })),
  };
}

/**
 * Who a mark with this visibility goes to. `contacts` = every deliverable
 * contact; `group:<uid>` = the deliverable members of that PLAIN contact group
 * (rooms — room_uid NOT NULL — are not groups). Public/private marks never
 * take this path at all.
 */
export async function resolveAudience(db, visibility) {
  if (visibility === "contacts") {
    const { rows } = await db.execute({ sql: `SELECT crow_id FROM contacts WHERE ${contactFilter("")} ORDER BY id`, args: [] });
    return { ok: true, crowIds: rows.map((r) => r.crow_id) };
  }
  if (typeof visibility === "string" && visibility.startsWith("group:")) {
    const uid = visibility.slice("group:".length);
    if (!GROUP_UID_RE.test(uid)) return { ok: false, reason: "unknown-group" };
    const { rows: g } = await db.execute({ sql: "SELECT id FROM contact_groups WHERE group_uid = ? AND room_uid IS NULL", args: [uid] });
    if (!g[0]) return { ok: false, reason: "unknown-group" };
    const { rows } = await db.execute({
      sql: `SELECT c.crow_id FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
             WHERE m.group_id = ? AND ${contactFilter("c")} ORDER BY c.id`,
      args: [g[0].id],
    });
    return { ok: true, crowIds: rows.map((r) => r.crow_id) };
  }
  return { ok: false, reason: "not-deliverable" };
}

/* ---------------------------------------------------------------- outbox */

/** One outbox row per unique, well-formed recipient. Returns how many were queued. */
export async function enqueueDeliveries(db, { toCrowIds, kind, refId, payload, now = Date.now() }) {
  if (!DELIVERY_KINDS.includes(kind)) throw new Error(`unknown delivery kind: ${kind}`);
  const unique = [...new Set(toCrowIds)].filter((c) => typeof c === "string" && CROW_ID_RE.test(c));
  if (unique.length === 0) return 0;
  const json = JSON.stringify(payload);
  await db.batch(unique.map((to) => ({
    sql: `INSERT INTO ramble_outbox (to_crow_id, kind, ref_id, payload_json, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    args: [to, kind, refId, json, now],
  })));
  return unique.length;
}

/** Queue a contacts/group mark for every member of its audience (snapshot at authoring time). */
export async function enqueueMark(db, row, { bird = null, now = Date.now() } = {}) {
  const audience = await resolveAudience(db, row.visibility);
  if (!audience.ok) return { ok: false, reason: audience.reason, recipients: 0 };
  const recipients = await enqueueDeliveries(db, {
    toCrowIds: audience.crowIds, kind: "mark", refId: row.mark_id, payload: markEnvelope(row, { bird }), now,
  });
  if (recipients === 0) {
    // Nobody to send to: the row would otherwise sit 'pending' forever with
    // no outbox row to ever settle it (review round 1, S4).
    await db.execute({
      sql: "UPDATE ramble_marks SET publish_state = 'published' WHERE mark_id = ? AND publish_state = 'pending'",
      args: [row.mark_id],
    });
  }
  return { ok: true, recipients };
}

/**
 * Gifts and trade steps first, then marks, then insertion order. A MARK row
 * can sit queued while the privacy grid is closed; without this ordering
 * fifty gated mark rows would fill every batch and starve the trades behind
 * them (review round 1, C1).
 */
export async function pendingDeliveries(db, limit = 50) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM ramble_outbox ORDER BY CASE WHEN kind = 'mark' THEN 1 ELSE 0 END, id LIMIT ?",
    args: [limit],
  });
  return rows;
}

export async function deleteDelivery(db, id) {
  await db.execute({ sql: "DELETE FROM ramble_outbox WHERE id = ?", args: [id] });
}

/**
 * Count one failed attempt; at `max` the row is parked (deleted) so a
 * recipient whose relays never accept cannot occupy a drain slot forever —
 * the same R15 rule the public drain applies to marks.
 */
export async function noteDeliveryFailure(db, row, max = MAX_DELIVERY_ATTEMPTS) {
  const attempts = (Number(row.attempts) || 0) + 1;
  if (attempts >= max) {
    await deleteDelivery(db, row.id);
    return { parked: true, attempts };
  }
  await db.execute({ sql: "UPDATE ramble_outbox SET attempts = ? WHERE id = ?", args: [attempts, row.id] });
  return { parked: false, attempts };
}

export async function remainingDeliveries(db, kind, refId) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_outbox WHERE kind = ? AND ref_id = ?", args: [kind, refId] });
  return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 4: Run the test**

Run: `node scripts/run-suite.mjs tests/ramble-delivery.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add bundles/ramble/server/delivery.js tests/ramble-delivery.test.js   # new files
git commit bundles/ramble/server/delivery.js tests/ramble-delivery.test.js -m "ramble: delivery codecs, audience resolution and the local outbox"
git show --stat HEAD
```

---

## Task 3: `trades.js` — gifts, swaps, expiry, the inbound router; `flock.js` admits received eggs

**Files:**
- Create: `bundles/ramble/server/trades.js`
- Modify: `bundles/ramble/server/flock.js:153-190` (`incubateEgg`), `:205-246` (`flockState`), imports at `:13-18`
- Test: `tests/ramble-trades.test.js`, `tests/ramble-flock.test.js`

**Interfaces:**
- Consumes (Task 2): `parseEggPayload`, `giftPayload`, `tradePayload`, `parseTradePayload`, `payloadToMark`, `isRambleEnvelope`, `enqueueDeliveries`, `CROW_ID_RE`; `insertRemoteMark` from `./marks.js`; `xOnly` from `./persona.js`.
- Produces (all exported from `trades.js`):
  - `TRADE_TTL_MS = 7 * 86400e3`, `OPEN_STATES = ["proposed","accepted"]`, `GIFTABLE = new Set(["shelf","received"])`
  - `lockedEggIds(db) -> Set<string>`, `isEggLocked(db, eggId) -> boolean`
  - `giftEgg(db, { eggId, toCrowId, now, emit }) -> { ok:true, egg } | { ok:false, reason:"not-found"|"not-an-egg"|"in-trade" }`
  - `receiveGift(db, eggPayload, { fromCrowId, now, emit }) -> { inserted:boolean, egg?, egg_id?, reason? }`
  - `proposeSwap(db, { eggId, toCrowId, now, emit }) -> { ok:true, trade } | { ok:false, reason }`
  - `acceptSwap(db, { tradeId, eggId, now, emit }) -> { ok:true, trade } | { ok:false, reason:"not-found"|"not-open"|"expired"|"not-an-egg"|"in-trade" }`
  - `declineSwap(db, { tradeId, now, emit }) -> { ok:true, trade } | { ok:false, reason:"not-found"|"not-open" }`
  - `receiveTrade(db, parsed, { fromCrowId, now, emit }) -> { changed:boolean, state?, trade_id, egg_id?, deliveries:number }`
  - `expireTrades(db, now, { emit }) -> number`
  - `listTrades(db, { now, limit }) -> [{ trade_id, counterpart, role, state, open, my_egg_id, their_egg_id, offer, created_at, updated_at, expires_at }]`
  - `receiveEnvelope(db, { crowId, pubkey, payload, eventId }, { now, emit }) -> { kind:"mark"|"egg"|"trade", … } | null`
- `flock.js`: `incubateEgg` returns `{ ok:false, reason:"in-trade" }` for a locked egg and admits `status='received'`; `flockState().eggs[]` items gain `from_crow_id` and `locked`, and include `status='received'` rows.

- [ ] **Step 1: Write the failing trades tests**

Create `tests/ramble-trades.test.js`:

```js
/**
 * Phase 3 — trades.js: gifts, the swap state machine (two dbs, envelopes
 * passed by hand exactly as the transport would), locks, expiry, and the
 * inbound envelope router. No Nostr, no HTTP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { ensureIncubatingEgg } from "../bundles/ramble/server/eggs.js";
import { pendingDeliveries, deleteDelivery } from "../bundles/ramble/server/delivery.js";
import {
  TRADE_TTL_MS, giftEgg, receiveGift, proposeSwap, acceptSwap, declineSwap, receiveTrade, expireTrades,
  listTrades, lockedEggIds, isEggLocked, receiveEnvelope,
} from "../bundles/ramble/server/trades.js";

const T0 = Date.UTC(2026, 8, 7, 12);
const PK = "ab".repeat(32);

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }
async function shelf(db, eggId, warmth = 10, extra = "") {
  await db.execute({ sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at) VALUES (?, 'shelf', 'user', ?, '9v6m21h', '2026-W37', ?)`, args: [eggId, warmth, T0] });
}
async function egg(db, id) { return (await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [id] })).rows[0] ?? null; }
async function trade(db, id) { return (await db.execute({ sql: "SELECT * FROM ramble_trades WHERE trade_id = ?", args: [id] })).rows[0] ?? null; }
/** Pop the one queued delivery and return its parsed payload (what the transport would send). */
async function popDelivery(db) {
  const rows = await pendingDeliveries(db, 50);
  assert.equal(rows.length, 1, `expected exactly one queued delivery, found ${rows.length}`);
  await deleteDelivery(db, rows[0].id);
  return { to: rows[0].to_crow_id, kind: rows[0].kind, payload: JSON.parse(rows[0].payload_json) };
}
const emitter = () => { const calls = []; return { calls, emit: async (t, op, row) => calls.push([t, op, row.egg_id ?? row.trade_id, row.status ?? row.state]) }; };

test("giftEgg: shelf/received only, egg leaves as 'gifted', one queued ramble.egg without species/seed", async () => {
  const db = await freshDb();
  await shelf(db, "g1", 30);
  await ensureIncubatingEgg(db, { now: T0 });
  const { calls, emit } = emitter();
  const r = await giftEgg(db, { eggId: "g1", toCrowId: "crow:friend", now: T0, emit });
  assert.equal(r.ok, true); assert.equal(r.egg.status, "gifted"); assert.equal(r.egg.shelf_origin, "user");
  assert.deepEqual(calls, [["ramble_eggs", "update", "g1", "gifted"]]);
  const d = await popDelivery(db);
  assert.equal(d.to, "crow:friend"); assert.equal(d.kind, "egg");
  assert.deepEqual(d.payload, { type: "ramble.egg", v: 1, egg: { egg_id: "g1", warmth: 30, found_cell: "9v6m21h", found_week: "2026-W37" } });
  assert.deepEqual(await giftEgg(db, { eggId: "g1", toCrowId: "crow:friend", now: T0 }), { ok: false, reason: "not-an-egg" }, "already gone");
  assert.deepEqual(await giftEgg(db, { eggId: "nope", toCrowId: "crow:friend", now: T0 }), { ok: false, reason: "not-found" });
  const inc = (await db.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows[0].egg_id;
  assert.deepEqual(await giftEgg(db, { eggId: inc, toCrowId: "crow:friend", now: T0 }), { ok: false, reason: "not-an-egg" }, "the incubating egg is not giftable — swap it out first");
});

test("receiveGift: lands as received/user with from_crow_id; re-delivery is a no-op; an egg gifted away comes back revived", async () => {
  const db = await freshDb();
  const { calls, emit } = emitter();
  const r = await receiveGift(db, { egg_id: "in1", warmth: 44, found_cell: "9v6m21h", found_week: "2026-W37", species: "crow", seed: 9 }, { fromCrowId: "crow:friend", now: T0, emit });
  assert.equal(r.inserted, true);
  const row = await egg(db, "in1");
  assert.deepEqual([row.status, row.shelf_origin, row.warmth, row.from_crow_id, row.species, row.seed, row.created_at], ["received", "user", 44, "crow:friend", null, null, T0]);
  assert.deepEqual(calls, [["ramble_eggs", "insert", "in1", "received"]]);
  assert.deepEqual(await receiveGift(db, { egg_id: "in1", warmth: 99 }, { fromCrowId: "crow:friend", now: T0 + 1, emit }), { inserted: false, egg_id: "in1" });
  assert.equal((await egg(db, "in1")).warmth, 44, "a re-delivered gift changes nothing");
  assert.equal(calls.length, 1);
  // Gift it onward, then it comes back: the row revives (created_at untouched).
  assert.equal((await giftEgg(db, { eggId: "in1", toCrowId: "crow:other", now: T0 + 2 })).ok, true);
  const back = await receiveGift(db, { egg_id: "in1", warmth: 50 }, { fromCrowId: "crow:other", now: T0 + 3 });
  assert.equal(back.inserted, true);
  const revived = await egg(db, "in1");
  assert.deepEqual([revived.status, revived.from_crow_id, revived.warmth, revived.created_at], ["received", "crow:other", 50, T0]);
  // A shelf egg of mine that someone claims to 'gift' me is not touched.
  await shelf(db, "mine", 5);
  assert.deepEqual(await receiveGift(db, { egg_id: "mine", warmth: 1 }, { fromCrowId: "crow:x", now: T0 }), { inserted: false, egg_id: "mine" });
  assert.equal((await egg(db, "mine")).status, "shelf");
  assert.deepEqual(await receiveGift(db, { warmth: 1 }, { fromCrowId: "crow:x", now: T0 }), { inserted: false, reason: "malformed" });
  assert.deepEqual(await receiveGift(db, { egg_id: "z", warmth: 1 }, { fromCrowId: "bad id", now: T0 }), { inserted: false, reason: "malformed" });
});

test("a full swap: propose (A) -> accept (B) -> complete (A) -> complete (B); eggs cross exactly once; every envelope is idempotent", async () => {
  const A = await freshDb(); const B = await freshDb();
  await shelf(A, "a-egg", 20); await shelf(B, "b-egg", 60);
  const ea = emitter(); const eb = emitter();

  // A proposes.
  const p = await proposeSwap(A, { eggId: "a-egg", toCrowId: "crow:B", now: T0, emit: ea.emit });
  assert.equal(p.ok, true);
  const tid = p.trade.trade_id;
  assert.deepEqual([p.trade.role, p.trade.state, p.trade.my_egg_id, p.trade.their_egg_id, p.trade.counterpart, p.trade.expires_at], ["proposer", "proposed", "a-egg", null, "crow:B", T0 + TRADE_TTL_MS]);
  assert.equal(await isEggLocked(A, "a-egg"), true);
  assert.deepEqual(await proposeSwap(A, { eggId: "a-egg", toCrowId: "crow:C", now: T0 }), { ok: false, reason: "in-trade" });
  assert.deepEqual(await giftEgg(A, { eggId: "a-egg", toCrowId: "crow:C", now: T0 }), { ok: false, reason: "in-trade" });
  const d1 = await popDelivery(A);
  assert.equal(d1.to, "crow:B");
  assert.deepEqual(d1.payload.trade, { trade_id: tid, state: "proposed", my_egg_id: "a-egg", want_egg_id: null });
  assert.deepEqual(d1.payload.egg, { egg_id: "a-egg", warmth: 20, found_cell: "9v6m21h", found_week: "2026-W37" });

  // B receives the proposal (twice — the second is a no-op).
  const parsedP = { trade_id: tid, state: "proposed", my_egg_id: "a-egg", want_egg_id: null, egg: d1.payload.egg };
  let r = await receiveTrade(B, parsedP, { fromCrowId: "crow:A", now: T0 + 10, emit: eb.emit });
  assert.deepEqual([r.changed, r.state, r.deliveries], [true, "proposed", 0]);
  assert.deepEqual(await receiveTrade(B, parsedP, { fromCrowId: "crow:A", now: T0 + 11, emit: eb.emit }), { changed: false, trade_id: tid, deliveries: 0 });
  let tb = await trade(B, tid);
  assert.deepEqual([tb.role, tb.state, tb.my_egg_id, tb.their_egg_id, tb.counterpart, JSON.parse(tb.offer_json).warmth], ["acceptor", "proposed", null, "a-egg", "crow:A", 20]);
  assert.equal(await egg(B, "a-egg"), null, "nothing changes hands at proposal time");

  // B accepts with b-egg.
  assert.deepEqual(await acceptSwap(B, { tradeId: tid, eggId: "nope", now: T0 + 20 }), { ok: false, reason: "not-an-egg" });
  const acc = await acceptSwap(B, { tradeId: tid, eggId: "b-egg", now: T0 + 20, emit: eb.emit });
  assert.equal(acc.ok, true); assert.equal(acc.trade.state, "accepted"); assert.equal(acc.trade.my_egg_id, "b-egg");
  assert.equal(await isEggLocked(B, "b-egg"), true);
  assert.deepEqual(await acceptSwap(B, { tradeId: tid, eggId: "b-egg", now: T0 + 21 }), { ok: false, reason: "not-open" });
  assert.deepEqual(await declineSwap(B, { tradeId: tid, now: T0 + 21 }), { ok: false, reason: "not-open" }, "no backing out once accepted — the proposer may already be completing");
  const d2 = await popDelivery(B);
  assert.equal(d2.to, "crow:A");
  assert.deepEqual(d2.payload.trade, { trade_id: tid, state: "accepted", my_egg_id: "b-egg", want_egg_id: "a-egg" });
  assert.equal(d2.payload.egg.egg_id, "b-egg");
  assert.equal((await egg(B, "b-egg")).status, "shelf", "still B's until completion");

  // A receives 'accepted': completes on A's side and queues 'completed'.
  const parsedA = { trade_id: tid, state: "accepted", my_egg_id: "b-egg", want_egg_id: "a-egg", egg: d2.payload.egg };
  r = await receiveTrade(A, parsedA, { fromCrowId: "crow:B", now: T0 + 30, emit: ea.emit });
  assert.deepEqual([r.changed, r.state, r.egg_id, r.deliveries], [true, "completed", "b-egg", 1]);
  assert.equal((await egg(A, "a-egg")).status, "gifted");
  const gotB = await egg(A, "b-egg");
  assert.deepEqual([gotB.status, gotB.shelf_origin, gotB.warmth, gotB.from_crow_id], ["received", "user", 60, "crow:B"]);
  assert.deepEqual([(await trade(A, tid)).state, (await trade(A, tid)).their_egg_id], ["completed", "b-egg"]);
  assert.equal(await isEggLocked(A, "a-egg"), false);
  assert.deepEqual(await receiveTrade(A, parsedA, { fromCrowId: "crow:B", now: T0 + 31, emit: ea.emit }), { changed: false, trade_id: tid, deliveries: 0 }, "re-delivered 'accepted' is a no-op");
  const d3 = await popDelivery(A);
  assert.equal(d3.to, "crow:B");
  assert.deepEqual(d3.payload.trade, { trade_id: tid, state: "completed", my_egg_id: "a-egg", want_egg_id: "b-egg" });
  assert.deepEqual(d3.payload.egg, { egg_id: "a-egg", warmth: 20, found_cell: "9v6m21h", found_week: "2026-W37" });

  // B receives 'completed': eggs cross on B's side.
  const parsedC = { trade_id: tid, state: "completed", my_egg_id: "a-egg", want_egg_id: "b-egg", egg: d3.payload.egg };
  r = await receiveTrade(B, parsedC, { fromCrowId: "crow:A", now: T0 + 40, emit: eb.emit });
  assert.deepEqual([r.changed, r.state, r.egg_id, r.deliveries], [true, "completed", "a-egg", 0]);
  assert.equal((await egg(B, "b-egg")).status, "gifted");
  const gotA = await egg(B, "a-egg");
  assert.deepEqual([gotA.status, gotA.shelf_origin, gotA.warmth, gotA.from_crow_id], ["received", "user", 20, "crow:A"]);
  assert.equal((await trade(B, tid)).state, "completed");
  assert.deepEqual(await receiveTrade(B, parsedC, { fromCrowId: "crow:A", now: T0 + 41 }), { changed: false, trade_id: tid, deliveries: 0 });
  assert.equal((await pendingDeliveries(B, 50)).length, 0);

  // Emits: every egg movement and every trade transition rode the sync hook.
  assert.deepEqual(ea.calls, [
    ["ramble_trades", "insert", tid, "proposed"],
    ["ramble_eggs", "update", "a-egg", "gifted"], ["ramble_eggs", "insert", "b-egg", "received"], ["ramble_trades", "update", tid, "completed"],
  ]);
  assert.deepEqual(eb.calls, [
    ["ramble_trades", "insert", tid, "proposed"], ["ramble_trades", "update", tid, "accepted"],
    ["ramble_eggs", "update", "b-egg", "gifted"], ["ramble_eggs", "insert", "a-egg", "received"], ["ramble_trades", "update", tid, "completed"],
  ]);
  // 'expired' never travels: a peer cannot expire our row.
  assert.equal((await receiveTrade(B, { trade_id: tid, state: "expired", my_egg_id: null, want_egg_id: null, egg: null }, { fromCrowId: "crow:A", now: T0 })).changed, false);
  assert.equal((await trade(B, tid)).state, "completed");
  // Wrong counterpart, wrong egg ids, unknown trade: all ignored.
  assert.deepEqual(await receiveTrade(B, { ...parsedC, trade_id: "ghost" }, { fromCrowId: "crow:A", now: T0 }), { changed: false, trade_id: "ghost", deliveries: 0 });
  assert.deepEqual(await receiveTrade(A, parsedA, { fromCrowId: "crow:Z", now: T0 }), { changed: false, trade_id: tid, deliveries: 0 });
});

test("decline: either side while proposed; the counterpart's egg unlocks; an accept after decline is refused", async () => {
  const A = await freshDb(); const B = await freshDb();
  await shelf(A, "a1"); await shelf(B, "b1");
  const p = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 });
  const d1 = await popDelivery(A);
  await receiveTrade(B, { trade_id: p.trade.trade_id, state: "proposed", my_egg_id: "a1", want_egg_id: null, egg: d1.payload.egg }, { fromCrowId: "crow:A", now: T0 });
  const dec = await declineSwap(B, { tradeId: p.trade.trade_id, now: T0 + 5 });
  assert.equal(dec.ok, true); assert.equal(dec.trade.state, "declined");
  const d2 = await popDelivery(B);
  assert.deepEqual(d2.payload, { type: "ramble.trade", v: 1, trade: { trade_id: p.trade.trade_id, state: "declined", my_egg_id: null, want_egg_id: null } });
  const r = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "declined", my_egg_id: null, want_egg_id: null, egg: null }, { fromCrowId: "crow:B", now: T0 + 6 });
  assert.deepEqual([r.changed, r.state], [true, "declined"]);
  assert.equal(await isEggLocked(A, "a1"), false, "a declined offer releases the egg");
  assert.equal((await egg(A, "a1")).status, "shelf");
  assert.deepEqual(await acceptSwap(B, { tradeId: p.trade.trade_id, eggId: "b1", now: T0 + 7 }), { ok: false, reason: "not-open" });
  // The proposer can cancel their own open offer the same way.
  const p2 = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 + 8 });
  await popDelivery(A);
  assert.equal((await declineSwap(A, { tradeId: p2.trade.trade_id, now: T0 + 9 })).trade.state, "declined");
  assert.equal((await popDelivery(A)).payload.trade.state, "declined");
  assert.deepEqual(await declineSwap(A, { tradeId: "ghost", now: T0 }), { ok: false, reason: "not-found" });
});

test("an 'accepted' that arrives after the offer lapsed (expired or egg gone) is answered with 'declined', not completed", async () => {
  const A = await freshDb();
  await shelf(A, "a1");
  const p = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 });
  await popDelivery(A);
  assert.equal(await expireTrades(A, T0 + TRADE_TTL_MS, {}), 1);
  assert.equal((await trade(A, p.trade.trade_id)).state, "expired");
  assert.equal(await isEggLocked(A, "a1"), false);
  const r = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "b1", want_egg_id: "a1", egg: { egg_id: "b1", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + TRADE_TTL_MS + 1 });
  assert.deepEqual([r.changed, r.state, r.deliveries], [true, "declined", 1], "a lapsed offer answers 'declined' once and settles as declined");
  assert.equal((await egg(A, "a1")).status, "shelf", "nothing changed hands");
  assert.equal(await egg(A, "b1"), null);
  assert.equal((await popDelivery(A)).payload.trade.state, "declined");
  assert.equal(await expireTrades(A, T0 + TRADE_TTL_MS + 5, {}), 0, "already-terminal rows are not re-expired");
  // C2: every further copy of that 'accepted' is a silent no-op — never another DM.
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const again = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "b1", want_egg_id: "a1", egg: { egg_id: "b1", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + TRADE_TTL_MS + 2 + i });
    assert.deepEqual([again.changed, again.deliveries], [false, 0]);
  }
  assert.equal((await pendingDeliveries(A, 50)).length, 0);
});

test("C3: an offer, an acceptance or a completion naming an egg we still hold is ignored (or declined), never a lost egg", async () => {
  const B = await freshDb();
  await shelf(B, "b1", 15);
  await shelf(B, "held", 20);
  // A proposal offering an egg we hold: ignored, no row.
  let r = await receiveTrade(B, { trade_id: "t-held", state: "proposed", my_egg_id: "held", want_egg_id: null, egg: { egg_id: "held", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 });
  assert.equal(r.changed, false);
  assert.equal(await trade(B, "t-held"), null);
  // A completion whose egg is one we hold: ignored, our answer egg stays ours.
  await B.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-c','crow:A','acceptor','b1','held','{}','accepted',?,?,?)", args: [T0, T0, T0 + 999] });
  r = await receiveTrade(B, { trade_id: "t-c", state: "completed", my_egg_id: "held", want_egg_id: "b1", egg: { egg_id: "held", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 + 1 });
  assert.equal(r.changed, false);
  assert.equal((await egg(B, "b1")).status, "shelf");
  assert.equal((await egg(B, "held")).status, "shelf");
  // An acceptance (we proposed) that names an egg we hold: declined reply, our egg untouched.
  const A = await freshDb();
  await shelf(A, "a1"); await shelf(A, "mine-too", 3);
  const p = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 });
  await popDelivery(A);
  r = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "mine-too", want_egg_id: "a1", egg: { egg_id: "mine-too", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + 1 });
  assert.deepEqual([r.changed, r.state, r.deliveries], [true, "declined", 1]);
  assert.equal((await popDelivery(A)).payload.trade.state, "declined");
  assert.deepEqual([(await egg(A, "a1")).status, (await egg(A, "mine-too")).status], ["shelf", "shelf"]);
  // The same egg on both sides of a swap is nonsense: ignored.
  const p2 = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 + 2 });
  await popDelivery(A);
  r = await receiveTrade(A, { trade_id: p2.trade.trade_id, state: "accepted", my_egg_id: "a1", want_egg_id: "a1", egg: { egg_id: "a1", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + 3 });
  assert.equal(r.changed, false);
  assert.equal((await trade(A, p2.trade.trade_id)).state, "proposed");
});

test("S2: inbound ceilings — at most 20 open proposals per contact and 20 received gifts per contact per day", async () => {
  const B = await freshDb();
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await receiveTrade(B, { trade_id: "t" + i, state: "proposed", my_egg_id: "e" + i, want_egg_id: null, egg: { egg_id: "e" + i, warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:spam", now: T0 + i });
    assert.equal(r.changed, true);
  }
  const over = await receiveTrade(B, { trade_id: "t20", state: "proposed", my_egg_id: "e20", want_egg_id: null, egg: { egg_id: "e20", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:spam", now: T0 + 20 });
  assert.equal(over.changed, false);
  assert.equal((await receiveTrade(B, { trade_id: "t-other", state: "proposed", my_egg_id: "e-o", want_egg_id: null, egg: { egg_id: "e-o", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:other", now: T0 + 21 })).changed, true, "the cap is per contact");
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await receiveGift(B, { egg_id: "g" + i, warmth: 1 }, { fromCrowId: "crow:spam", now: T0 + i })).inserted, true);
  }
  assert.deepEqual(await receiveGift(B, { egg_id: "g20", warmth: 1 }, { fromCrowId: "crow:spam", now: T0 + 20 }), { inserted: false, reason: "capped", egg_id: "g20" });
  assert.equal((await receiveGift(B, { egg_id: "g21", warmth: 1 }, { fromCrowId: "crow:spam", now: T0 + 86400e3 })).inserted, true, "a new local day opens the cap");
});

test("expiry sweeps proposed AND accepted rows, emits them, and a 'completed' still lands on an acceptor whose row expired if the egg is still theirs", async () => {
  const B = await freshDb();
  await shelf(B, "b1", 15);
  await B.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-acc','crow:A','acceptor','b1','a1','{}','accepted',?,?,?)", args: [T0, T0, T0 + 100] });
  await B.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-prop','crow:A','acceptor',NULL,'a2','{}','proposed',?,?,?)", args: [T0, T0, T0 + 100] });
  const { calls, emit } = emitter();
  assert.equal(await expireTrades(B, T0 + 100, { emit }), 2);
  assert.deepEqual(calls.map((c) => [c[2], c[3]]).sort(), [["t-acc", "expired"], ["t-prop", "expired"]]);
  assert.equal(await isEggLocked(B, "b1"), false);
  const r = await receiveTrade(B, { trade_id: "t-acc", state: "completed", my_egg_id: "a1", want_egg_id: "b1", egg: { egg_id: "a1", warmth: 3, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 + 200, emit });
  assert.deepEqual([r.changed, r.state], [true, "completed"]);
  assert.equal((await egg(B, "b1")).status, "gifted");
  assert.equal((await egg(B, "a1")).status, "received");
  // A 'completed' for a proposal that was never accepted is ignored.
  const r2 = await receiveTrade(B, { trade_id: "t-prop", state: "completed", my_egg_id: "a2", want_egg_id: "zzz", egg: { egg_id: "a2", warmth: 3, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 + 201 });
  assert.equal(r2.changed, false);
  assert.equal(await egg(B, "a2"), null);
});

test("listTrades: open offers first, newest first, with the parsed offer; lockedEggIds covers both roles", async () => {
  const db = await freshDb();
  await shelf(db, "x1");
  await db.executeMultiple(`
    INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at)
    VALUES ('old-done','crow:A','proposer','x0',NULL,NULL,'completed',1,2,999),
           ('open-1','crow:B','acceptor',NULL,'y1','{"egg_id":"y1","warmth":33,"found_cell":null,"found_week":null}','proposed',5,5,999),
           ('open-2','crow:C','proposer','x1',NULL,NULL,'proposed',7,7,999),
           ('open-3','crow:D','acceptor','x2','y2',NULL,'accepted',3,9,999);`);
  const list = await listTrades(db, { now: 10, limit: 20 });
  assert.deepEqual(list.map((t) => [t.trade_id, t.open]), [["open-3", true], ["open-2", true], ["open-1", true], ["old-done", false]]);
  assert.deepEqual(list[2].offer, { egg_id: "y1", warmth: 33, found_cell: null, found_week: null });
  assert.equal(list[1].offer, null);
  assert.deepEqual([...(await lockedEggIds(db))].sort(), ["x1", "x2"]);
  assert.equal(await isEggLocked(db, "x0"), false);
});

test("receiveEnvelope routes marks (as persistent contacts marks + meet payload), eggs and trades; junk is null", async () => {
  const db = await freshDb();
  const mark = { mark_id: "m-1", kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, accuracy_m: 10, anchor_ref: null, reveal: "open", content_text: "hi contact", content_kind: "none", content_ref: null, created_at: T0, bird: { species: "raven", seed: 3 } };
  const r = await receiveEnvelope(db, { crowId: "crow:F", pubkey: "02" + PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-1" }, { now: T0 });
  assert.deepEqual([r.kind, r.inserted, r.geohash, r.mark_id, r.markKind], ["mark", true, "9v6m21h", "m-1", "mark"]);
  const stored = (await db.execute("SELECT * FROM ramble_marks WHERE mark_id='m-1'")).rows[0];
  assert.deepEqual([stored.visibility, stored.expires_at, stored.origin, stored.author, stored.author_level, stored.bird_species, stored.nostr_event_id], ["contacts", null, "remote", PK, "real", "raven", "ev-1"]);
  assert.equal((await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-2" }, { now: T0 })).inserted, false, "same mark_id: a re-delivery is a no-op");
  const g = await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "gift-1", warmth: 2 } } }, { now: T0 });
  assert.deepEqual([g.kind, g.inserted, g.egg_id], ["egg", true, "gift-1"]);
  assert.equal((await egg(db, "gift-1")).from_crow_id, "crow:F");
  const t = await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.trade", v: 1, trade: { trade_id: "t-9", state: "proposed", my_egg_id: "e9", want_egg_id: null }, egg: { egg_id: "e9", warmth: 5 } } }, { now: T0 });
  assert.deepEqual([t.kind, t.changed, t.state, t.trade_id], ["trade", true, "proposed", "t-9"]);
  assert.deepEqual(await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.trade", v: 1, trade: { trade_id: "t-9", state: "weird" } } }, { now: T0 }), { kind: "trade", changed: false, trade_id: null, deliveries: 0 });
  assert.equal(await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "crow_social" } }, { now: T0 }), null);
  assert.equal(await receiveEnvelope(db, { crowId: "bad id", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "x" } } }, { now: T0 }), null);
  assert.deepEqual(await receiveEnvelope(db, { crowId: "crow:F", pubkey: "nothex", payload: { type: "ramble.mark", v: 1, mark } }, { now: T0 }), { kind: "mark", inserted: false });
  assert.equal(await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.unknown", v: 1 } }, { now: T0 }), null);
});
```

Append to `tests/ramble-flock.test.js` (imports: add `giftEgg, proposeSwap` from `../bundles/ramble/server/trades.js`):

```js
test("phase 3: incubateEgg admits a received egg (origin cleared), refuses a locked one and a gifted one; flockState lists received + locked", async () => {
  const d = await freshDb();
  const first = await ensureIncubatingEgg(d, { now: T0 });
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, from_crow_id, created_at) VALUES ('rx','received','user',35,'crow:friend',7)");
  await d.execute("INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('sw','shelf','user',5,8), ('gone','gifted','user',5,9)");
  const p = await proposeSwap(d, { eggId: "sw", toCrowId: "crow:friend", now: T0 });
  assert.equal(p.ok, true);
  assert.deepEqual(await incubateEgg(d, "sw", { now: T0 }), { ok: false, reason: "in-trade" });
  assert.deepEqual(await incubateEgg(d, "gone", { now: T0 }), { ok: false, reason: "not-an-egg" });

  const s = await flockState(d, { now: T0 });
  const rx = s.eggs.find((e) => e.egg_id === "rx");
  assert.deepEqual([rx.status, rx.from_crow_id, rx.locked, rx.percent], ["received", "crow:friend", false, 35]);
  assert.equal(s.eggs.find((e) => e.egg_id === "sw").locked, true);
  assert.ok(!s.eggs.find((e) => e.egg_id === "gone"), "gifted eggs are not on the shelf");
  assert.equal(s.eggs[0].status, "incubating");
  assert.equal(s.shelf_count, 1, "received eggs do not use a claim spot");

  const r = await incubateEgg(d, "rx", { now: T0 });
  assert.equal(r.ok, true); assert.equal(r.egg.status, "incubating"); assert.equal(r.egg.shelf_origin, null);
  assert.equal(r.egg.from_crow_id, "crow:friend", "provenance survives incubation");
  assert.deepEqual([r.shelved.egg_id, r.shelved.status, r.shelved.shelf_origin], [first.egg_id, "shelf", "user"]);
  assert.equal((await d.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status='incubating'")).rows[0].n, 1);
  // giftEgg from flock.js's neighbour still sees the same lock.
  assert.deepEqual(await giftEgg(d, { eggId: "sw", toCrowId: "crow:x", now: T0 }), { ok: false, reason: "in-trade" });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node scripts/run-suite.mjs tests/ramble-trades.test.js; node scripts/run-suite.mjs tests/ramble-flock.test.js`
Expected: FAIL — `Cannot find module '../bundles/ramble/server/trades.js'`.

- [ ] **Step 3: Write `bundles/ramble/server/trades.js`**

```js
/**
 * Ramble trades — gifts and swaps between contacts (spec §2.5, §4, §10).
 *
 * A GIFT is one envelope: the sender's egg becomes `gifted` (the row stays,
 * never deleted), the recipient inserts it as `received` with
 * `shelf_origin='user'` (sync never auto-promotes it) and `from_crow_id`.
 *
 * A SWAP is three envelopes and eggs change hands ONLY at completion:
 *
 *   proposer                                   acceptor
 *   proposeSwap: row(proposed, my=A)  --proposed(A)-->  row(proposed, their=A)
 *                                                       acceptSwap: state=accepted, my=B
 *   receiveTrade(accepted): A->gifted, <--accepted(B)--
 *     insert B received, state=completed
 *                                     --completed(A)--> receiveTrade(completed): B->gifted,
 *                                                         insert A received, state=completed
 *
 * `declined` is legal from either side only while `proposed`; `expired` is a
 * local sweep at created_at + TRADE_TTL_MS on both sides. Every envelope is
 * idempotent by trade_id (re-delivery is a no-op) and every hand-over is one
 * db.batch. A `completed` that reaches an acceptor whose row already expired
 * still lands if their egg is still theirs (the proposer has already given
 * theirs away); if the egg is gone the proposer holds a free copy — accepted
 * under spec §9 "no scarcity ledger, no value".
 *
 * An egg named by an open trade is LOCKED: it cannot be incubated, gifted or
 * offered again until the trade closes (flock.js asks isEggLocked).
 */
import { randomUUID } from "node:crypto";
import { insertRemoteMark } from "./marks.js";
import { xOnly } from "./persona.js";
import { startOfLocalDay } from "./eggs.js";
import {
  CROW_ID_RE, isRambleEnvelope, parseEggPayload, giftPayload, tradePayload, parseTradePayload,
  payloadToMark, enqueueDeliveries,
} from "./delivery.js";

export const TRADE_TTL_MS = 7 * 86400e3;
export const OPEN_STATES = ["proposed", "accepted"];
export const GIFTABLE = new Set(["shelf", "received"]);
/** Inbound ceilings per contact (review round 1, S2): past them an envelope is a silent no-op. */
export const MAX_OPEN_PROPOSALS_PER_CONTACT = 20;
export const MAX_GIFTS_PER_CONTACT_PER_DAY = 20;

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble trades] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

async function getEgg(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}
async function getTrade(db, tradeId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_trades WHERE trade_id = ?", args: [tradeId] });
  return rows[0] ?? null;
}

const OPEN_SQL = "state IN ('proposed', 'accepted')";
const LOCK_GUARD_SQL = `NOT EXISTS (SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND ${OPEN_SQL})`;
/** Binds ONE ?: the egg must still be giftable at write time (a gift racing a propose must not lock a gone egg — S1). */
const GIFTABLE_GUARD_SQL = "EXISTS (SELECT 1 FROM ramble_eggs WHERE egg_id = ? AND status IN ('shelf', 'received'))";

/* ---------------------------------------------------------------- locks */

export async function lockedEggIds(db) {
  const { rows } = await db.execute({ sql: `SELECT my_egg_id FROM ramble_trades WHERE my_egg_id IS NOT NULL AND ${OPEN_SQL}`, args: [] });
  return new Set(rows.map((r) => r.my_egg_id));
}

export async function isEggLocked(db, eggId) {
  const { rows } = await db.execute({ sql: `SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND ${OPEN_SQL} LIMIT 1`, args: [eggId] });
  return rows.length > 0;
}

/** The "receive an egg" upsert shared by gifts and swap completion: insert if new, revive if it was gifted away, else no-op. */
function receivedEggStatement(egg, fromCrowId, now) {
  return {
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, from_crow_id, created_at)
          VALUES (?, 'received', 'user', ?, ?, ?, ?, ?)
          ON CONFLICT(egg_id) DO UPDATE SET status = 'received', shelf_origin = 'user', warmth = excluded.warmth,
            found_cell = excluded.found_cell, found_week = excluded.found_week, from_crow_id = excluded.from_crow_id
          WHERE ramble_eggs.status = 'gifted'`,
    args: [egg.egg_id, egg.warmth, egg.found_cell, egg.found_week, fromCrowId, now],
  };
}

/* ---------------------------------------------------------------- gifts */

export async function giftEgg(db, { eggId, toCrowId, now = Date.now(), emit } = {}) {
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (!GIFTABLE.has(egg.status)) return { ok: false, reason: "not-an-egg" };
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_eggs SET status = 'gifted' WHERE egg_id = ? AND status IN ('shelf', 'received') AND ${LOCK_GUARD_SQL}`,
    args: [eggId, eggId],
  });
  if (rowsAffected === 0) return { ok: false, reason: "not-an-egg" };
  const gifted = await getEgg(db, eggId);
  await safeEmit(emit, "ramble_eggs", "update", gifted);
  await enqueueDeliveries(db, { toCrowIds: [toCrowId], kind: "egg", refId: eggId, payload: giftPayload(egg), now });
  return { ok: true, egg: gifted };
}

/**
 * Store a gifted egg as 'received'. The per-contact daily ceiling counts rows
 * whose `created_at` is today; a revived (gifted-back) egg keeps its original
 * `created_at` and so never counts — deliberate, revives are our own eggs.
 */
export async function receiveGift(db, eggIn, { fromCrowId, now = Date.now(), emit } = {}) {
  const egg = parseEggPayload(eggIn);
  if (!egg || typeof fromCrowId !== "string" || !CROW_ID_RE.test(fromCrowId)) return { inserted: false, reason: "malformed" };
  const { rows: today } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_eggs WHERE from_crow_id = ? AND status = 'received' AND created_at >= ?",
    args: [fromCrowId, startOfLocalDay(now)],
  });
  if (Number(today[0]?.n ?? 0) >= MAX_GIFTS_PER_CONTACT_PER_DAY) return { inserted: false, reason: "capped", egg_id: egg.egg_id };
  const { rowsAffected } = await db.execute(receivedEggStatement(egg, fromCrowId, now));
  if (rowsAffected === 0) return { inserted: false, egg_id: egg.egg_id };
  const row = await getEgg(db, egg.egg_id);
  await safeEmit(emit, "ramble_eggs", "insert", row);
  return { inserted: true, egg: row };
}

/* ---------------------------------------------------------------- swaps */

export async function proposeSwap(db, { eggId, toCrowId, now = Date.now(), emit } = {}) {
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (!GIFTABLE.has(egg.status)) return { ok: false, reason: "not-an-egg" };
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };
  const trade_id = randomUUID();
  // One statement decides the lock: two concurrent proposals of the same egg
  // cannot both pass (the second INSERT ... SELECT finds the first's open row).
  const { rowsAffected } = await db.execute({
    sql: `INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at)
          SELECT ?, ?, 'proposer', ?, NULL, NULL, 'proposed', ?, ?, ?
          WHERE ${LOCK_GUARD_SQL} AND ${GIFTABLE_GUARD_SQL}`,
    args: [trade_id, toCrowId, eggId, now, now, now + TRADE_TTL_MS, eggId, eggId],
  });
  if (rowsAffected === 0) return { ok: false, reason: (await isEggLocked(db, eggId)) ? "in-trade" : "not-an-egg" };
  const trade = await getTrade(db, trade_id);
  await safeEmit(emit, "ramble_trades", "insert", trade);
  await enqueueDeliveries(db, {
    toCrowIds: [toCrowId], kind: "trade", refId: trade_id,
    payload: tradePayload({ trade_id, state: "proposed", my_egg_id: eggId, want_egg_id: null }, egg), now,
  });
  return { ok: true, trade };
}

export async function acceptSwap(db, { tradeId, eggId, now = Date.now(), emit } = {}) {
  const trade = await getTrade(db, tradeId);
  if (!trade) return { ok: false, reason: "not-found" };
  if (trade.role !== "acceptor" || trade.state !== "proposed") return { ok: false, reason: "not-open" };
  if (Number(trade.expires_at) <= now) return { ok: false, reason: "expired" };
  const egg = await getEgg(db, eggId);
  if (!egg || !GIFTABLE.has(egg.status)) return { ok: false, reason: "not-an-egg" };
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_trades SET state = 'accepted', my_egg_id = ?, updated_at = ?
           WHERE trade_id = ? AND state = 'proposed' AND ${LOCK_GUARD_SQL} AND ${GIFTABLE_GUARD_SQL}`,
    args: [eggId, now, tradeId, eggId, eggId],
  });
  if (rowsAffected === 0) return { ok: false, reason: (await isEggLocked(db, eggId)) ? "in-trade" : "not-open" };
  const updated = await getTrade(db, tradeId);
  await safeEmit(emit, "ramble_trades", "update", updated);
  await enqueueDeliveries(db, {
    toCrowIds: [trade.counterpart], kind: "trade", refId: tradeId,
    payload: tradePayload({ trade_id: tradeId, state: "accepted", my_egg_id: eggId, want_egg_id: trade.their_egg_id }, egg), now,
  });
  return { ok: true, trade: updated };
}

/** Either side, only while `proposed` (an acceptor who already accepted may be mid-completion on the other side). */
export async function declineSwap(db, { tradeId, now = Date.now(), emit } = {}) {
  const trade = await getTrade(db, tradeId);
  if (!trade) return { ok: false, reason: "not-found" };
  const { rowsAffected } = await db.execute({
    sql: "UPDATE ramble_trades SET state = 'declined', updated_at = ? WHERE trade_id = ? AND state = 'proposed'",
    args: [now, tradeId],
  });
  if (rowsAffected === 0) return { ok: false, reason: "not-open" };
  const updated = await getTrade(db, tradeId);
  await safeEmit(emit, "ramble_trades", "update", updated);
  await enqueueDeliveries(db, {
    toCrowIds: [trade.counterpart], kind: "trade", refId: tradeId,
    payload: tradePayload({ trade_id: tradeId, state: "declined" }), now,
  });
  return { ok: true, trade: updated };
}

async function setState(db, tradeId, state, now, extra = {}) {
  const sets = ["state = ?", "updated_at = ?"];
  const args = [state, now];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(v); }
  args.push(tradeId);
  await db.execute({ sql: `UPDATE ramble_trades SET ${sets.join(", ")} WHERE trade_id = ?`, args });
}

/**
 * Apply one inbound trade envelope from `fromCrowId`. Returns
 * { changed, state?, trade_id, egg_id?, deliveries } — `deliveries` > 0 means
 * a reply was queued and the caller should poke the drain.
 */
export async function receiveTrade(db, parsed, { fromCrowId, now = Date.now(), emit } = {}) {
  const none = (extra = {}) => ({ changed: false, trade_id: parsed?.trade_id ?? null, deliveries: 0, ...extra });
  if (!parsed || typeof fromCrowId !== "string" || !CROW_ID_RE.test(fromCrowId)) return none();
  const t = parsed;
  const existing = await getTrade(db, t.trade_id);
  if (existing && existing.counterpart !== fromCrowId) return none();

  // C3: an egg the counterpart "offers" or "gives" must not be one THIS
  // instance still holds (anything but 'gifted'): a contact who remembers the
  // id of an egg they once gave us could otherwise make a completion batch
  // mark our answer egg 'gifted' while the revive no-ops — a lost egg.
  const stillOurs = async (eggId) => {
    if (!eggId) return true;
    const held = await getEgg(db, eggId);
    return !!held && held.status !== "gifted";
  };

  if (t.state === "proposed") {
    if (existing) return none();
    if (!t.egg || !t.my_egg_id || t.egg.egg_id !== t.my_egg_id) return none();
    if (await stillOurs(t.my_egg_id)) return none();
    const { rows: open } = await db.execute({
      sql: `SELECT count(*) AS n FROM ramble_trades WHERE counterpart = ? AND role = 'acceptor' AND ${OPEN_SQL}`, args: [fromCrowId],
    });
    if (Number(open[0]?.n ?? 0) >= MAX_OPEN_PROPOSALS_PER_CONTACT) return none();
    await db.execute({
      sql: `INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at)
            VALUES (?, ?, 'acceptor', NULL, ?, ?, 'proposed', ?, ?, ?) ON CONFLICT(trade_id) DO NOTHING`,
      args: [t.trade_id, fromCrowId, t.my_egg_id, JSON.stringify(t.egg), now, now, now + TRADE_TTL_MS],
    });
    await safeEmit(emit, "ramble_trades", "insert", await getTrade(db, t.trade_id));
    return { changed: true, state: "proposed", trade_id: t.trade_id, egg_id: t.my_egg_id, deliveries: 0 };
  }

  if (t.state === "accepted") {
    if (!existing || existing.role !== "proposer") return none();
    if (existing.state === "completed" || existing.state === "declined") return none();
    if (!t.egg || !t.my_egg_id || t.egg.egg_id !== t.my_egg_id || t.want_egg_id !== existing.my_egg_id) return none();
    if (t.my_egg_id === existing.my_egg_id) return none();
    const mine = await getEgg(db, existing.my_egg_id);
    if (existing.state !== "proposed" || !mine || !GIFTABLE.has(mine.status) || (await stillOurs(t.my_egg_id))) {
      // Cannot honour it (lapsed, my egg is gone, or they named an egg we
      // hold): tell them so their egg unlocks. The row becomes 'declined'
      // (from 'proposed' OR 'expired') so the NEXT copy of this 'accepted'
      // hits the declined early-return above — exactly one reply per trade,
      // never one DM per re-delivery (C2).
      await setState(db, t.trade_id, "declined", now);
      await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
      await enqueueDeliveries(db, { toCrowIds: [fromCrowId], kind: "trade", refId: t.trade_id, payload: tradePayload({ trade_id: t.trade_id, state: "declined" }), now });
      return { changed: true, state: "declined", trade_id: t.trade_id, deliveries: 1 };
    }
    await db.batch([
      { sql: "UPDATE ramble_eggs SET status = 'gifted' WHERE egg_id = ? AND status IN ('shelf', 'received')", args: [mine.egg_id] },
      receivedEggStatement(t.egg, fromCrowId, now),
      { sql: "UPDATE ramble_trades SET state = 'completed', their_egg_id = ?, offer_json = ?, updated_at = ? WHERE trade_id = ?", args: [t.egg.egg_id, JSON.stringify(t.egg), now, t.trade_id] },
    ]);
    await safeEmit(emit, "ramble_eggs", "update", await getEgg(db, mine.egg_id));
    await safeEmit(emit, "ramble_eggs", "insert", await getEgg(db, t.egg.egg_id));
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
    await enqueueDeliveries(db, {
      toCrowIds: [fromCrowId], kind: "trade", refId: t.trade_id,
      payload: tradePayload({ trade_id: t.trade_id, state: "completed", my_egg_id: mine.egg_id, want_egg_id: t.egg.egg_id }, mine), now,
    });
    return { changed: true, state: "completed", trade_id: t.trade_id, egg_id: t.egg.egg_id, deliveries: 1 };
  }

  if (t.state === "completed") {
    if (!existing || existing.role !== "acceptor" || !existing.my_egg_id) return none();
    if (existing.state === "completed" || existing.state === "declined") return none();
    if (!t.egg || t.egg.egg_id !== existing.their_egg_id || t.want_egg_id !== existing.my_egg_id) return none();
    if (t.egg.egg_id === existing.my_egg_id || (await stillOurs(t.egg.egg_id))) return none();
    await db.batch([
      { sql: "UPDATE ramble_eggs SET status = 'gifted' WHERE egg_id = ? AND status IN ('shelf', 'received')", args: [existing.my_egg_id] },
      receivedEggStatement(t.egg, fromCrowId, now),
      { sql: "UPDATE ramble_trades SET state = 'completed', updated_at = ? WHERE trade_id = ?", args: [now, t.trade_id] },
    ]);
    await safeEmit(emit, "ramble_eggs", "update", await getEgg(db, existing.my_egg_id));
    await safeEmit(emit, "ramble_eggs", "insert", await getEgg(db, t.egg.egg_id));
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
    return { changed: true, state: "completed", trade_id: t.trade_id, egg_id: t.egg.egg_id, deliveries: 0 };
  }

  if (t.state === "declined") {
    if (!existing || !OPEN_STATES.includes(existing.state)) return none();
    await setState(db, t.trade_id, "declined", now);
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
    return { changed: true, state: "declined", trade_id: t.trade_id, deliveries: 0 };
  }

  return none(); // 'expired' never travels
}

/** Local sweep: open rows past expires_at become 'expired' (emitted). Returns how many. */
export async function expireTrades(db, now = Date.now(), { emit } = {}) {
  const { rows } = await db.execute({ sql: `SELECT trade_id FROM ramble_trades WHERE ${OPEN_SQL} AND expires_at <= ?`, args: [now] });
  if (rows.length === 0) return 0;
  await db.execute({ sql: `UPDATE ramble_trades SET state = 'expired', updated_at = ? WHERE ${OPEN_SQL} AND expires_at <= ?`, args: [now, now] });
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, r.trade_id));
  }
  return rows.length;
}

export async function listTrades(db, { now = Date.now(), limit = 20 } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM ramble_trades ORDER BY CASE WHEN ${OPEN_SQL} THEN 0 ELSE 1 END, updated_at DESC, trade_id LIMIT ?`,
    args: [limit],
  });
  return rows.map((r) => {
    let offer = null;
    if (r.offer_json) { try { offer = parseEggPayload(JSON.parse(r.offer_json)); } catch { offer = null; } }
    return {
      trade_id: r.trade_id, counterpart: r.counterpart, role: r.role, state: r.state,
      open: OPEN_STATES.includes(r.state) && Number(r.expires_at) > now,
      my_egg_id: r.my_egg_id ?? null, their_egg_id: r.their_egg_id ?? null, offer,
      created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at,
    };
  });
}

/* --------------------------------------------------------- inbound router */

/**
 * One decrypted ramble envelope from a CONTACT (the transport got it from
 * NostrManager's per-contact subscription, so `crowId`/`pubkey` are the
 * verified sender). Returns a small result the transport turns into bus
 * events, or null for anything that is not ours.
 */
export async function receiveEnvelope(db, { crowId, pubkey, payload, eventId = null } = {}, { now = Date.now(), emit } = {}) {
  if (!isRambleEnvelope(payload) || typeof crowId !== "string" || !CROW_ID_RE.test(crowId)) return null;
  if (payload.type === "ramble.mark") {
    const author = typeof pubkey === "string" ? xOnly(pubkey) : null;
    const row = payloadToMark(payload.mark, { author, eventId });
    if (!row) return { kind: "mark", inserted: false };
    const r = await insertRemoteMark(db, row);
    return { kind: "mark", inserted: !!r.inserted, row: r.row ?? null, geohash: row.geohash, mark_id: row.mark_id, markKind: row.kind };
  }
  if (payload.type === "ramble.egg") {
    const r = await receiveGift(db, payload.egg, { fromCrowId: crowId, now, emit });
    return { kind: "egg", inserted: r.inserted, egg_id: r.egg?.egg_id ?? r.egg_id ?? null, deliveries: 0 };
  }
  if (payload.type === "ramble.trade") {
    const parsed = parseTradePayload(payload);
    if (!parsed) return { kind: "trade", changed: false, trade_id: null, deliveries: 0 };
    const r = await receiveTrade(db, parsed, { fromCrowId: crowId, now, emit });
    return { kind: "trade", ...r };
  }
  return null;
}
```

- [ ] **Step 4: Update `flock.js`**

(a) Imports: add `import { isEggLocked, lockedEggIds } from "./trades.js";` after the `./nests.js` import.

(b) `incubateEgg` — replace the three status checks and the UPDATE:

```js
  if (target.status === "incubating") return { ok: true, already: true, egg: target, shelved: null, hatched: null };
  if (target.status !== "shelf" && target.status !== "received") return { ok: false, reason: "not-an-egg" };
  // An egg named by an open swap is spoken for: it may not move until the
  // trade closes (Task 3 lock rule).
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };

  const { rows: current } = await db.execute({ sql: "SELECT egg_id FROM ramble_eggs WHERE status = 'incubating'", args: [] });
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_eggs
             SET status = CASE WHEN egg_id = ? THEN 'incubating' ELSE 'shelf' END,
                 shelf_origin = CASE WHEN egg_id = ? THEN NULL ELSE 'user' END
           WHERE (status = 'incubating' OR egg_id = ?)
             AND EXISTS (SELECT 1 FROM ramble_eggs WHERE egg_id = ? AND status IN ('shelf', 'received'))`,
    args: [eggId, eggId, eggId, eggId],
  });
```

Update the docstring's first sentence to "Make `eggId` (a shelf or received egg) the incubating egg."

(c) `flockState` — after `const pet = await getPetRow(db);` add `const locked = await lockedEggIds(db);`, and replace the `eggs` mapping:

```js
  const eggs = rows
    .filter((r) => r.status === "incubating" || r.status === "shelf" || r.status === "received")
    .sort((x, y) => (x.status === y.status ? 0 : x.status === "incubating" ? -1 : y.status === "incubating" ? 1 : 0))
    .map((r) => ({
      egg_id: r.egg_id, status: r.status, warmth: r.warmth, percent: pct(r.warmth),
      found_cell: r.found_cell ?? null, found_week: r.found_week ?? null, created_at: r.created_at,
      shelf_origin: r.shelf_origin ?? null,
      // Phase 3: who gave it (received eggs), and whether an open swap has it spoken for.
      from_crow_id: r.from_crow_id ?? null,
      locked: locked.has(r.egg_id),
    }));
```

(d) Module docstring: add a line "Phase 3: received eggs (gifts/swaps) sit on the shelf as their own class and never count toward the claim cap; an egg named by an open trade is locked (trades.js)."

- [ ] **Step 5: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-trades.test.js && node scripts/run-suite.mjs tests/ramble-flock.test.js && node scripts/run-suite.mjs tests/ramble-panel.test.js && node scripts/run-suite.mjs tests/ramble-tools.test.js && node scripts/run-suite.mjs tests/ramble-sync.test.js`
Expected: all PASS (the phase-2 flock/panel/tools/sync tests must not regress: the `flockState` sort keeps shelf rows in `created_at` order — the existing assertion `[["s0", "shelf", 5, "sync"], ["s1", "shelf", 50, "user"]]` still holds).

- [ ] **Step 6: Commit**

```bash
git add bundles/ramble/server/trades.js tests/ramble-trades.test.js   # new files
git commit bundles/ramble/server/trades.js bundles/ramble/server/flock.js tests/ramble-trades.test.js tests/ramble-flock.test.js -m "ramble: gifts and swaps (trades.js); received eggs incubate, locked eggs stay put"
git show --stat HEAD
```

---

## Task 4: `NostrManager` — route `ramble.*` DMs to the bus, never to the chat store

**Files:**
- Modify: `servers/sharing/nostr.js:495-628` (`subscribeToContact`), `:697-790` (`subscribeToIncoming`)
- Test: `tests/ramble-nostr-envelope.test.js`

**Interfaces:**
- Consumes: `bus` (already imported at `nostr.js:27`), the existing `sendControl(contact, content)` (unchanged).
- Produces: `bus.emit("ramble:envelope", { crowId, contactId, pubkey, payload, eventId, createdAt })` from the per-contact decrypt path, AFTER the block check and BEFORE the `messages` INSERT; `subscribeToIncoming` treats `payload.type` starting with `ramble.` as handled (dropped).

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-nostr-envelope.test.js`:

```js
/**
 * Phase 3 — the NostrManager side of the contacts wire.
 *
 * Outbound: `sendControl` wraps a ramble envelope as a kind-4 DM whose
 * content is NIP-44 ciphertext and whose only tag is ["p", recipient] —
 * nothing about the mark is on the relay in the clear.
 * Inbound: the per-contact subscription hands a decrypted `ramble.*`
 * envelope to the bus and stores NO chat message; a blocked contact's
 * envelope vanishes; the catch-all incoming subscription never turns a
 * stranger's envelope into a message request.
 *
 * Harness mirrors tests/block-onevent-guard.test.js (real init-db scratch
 * db, stub relay, real NIP-44 keys).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { getPublicKey, nip44 } from "nostr-tools";
import bus from "../servers/shared/event-bus.js";
import { NostrManager } from "../servers/sharing/nostr.js";

function stubRelay() {
  const r = {
    connected: true, subscribeCalls: [], published: [], closed: false,
    subscribe(filters, { onevent, onclose }) {
      r.subscribeCalls.push({ filters, onevent, onclose });
      return { onevent, onclose, closed: false, close() { this.closed = true; } };
    },
    async publish(event) { r.published.push(event); },
    async connect() { r.connected = true; },
    close() { r.closed = true; },
  };
  return r;
}

const ourPriv = new Uint8Array(32).fill(1);
const theirPriv = new Uint8Array(32).fill(2);
const strangerPriv = new Uint8Array(32).fill(3);
const ourPub = getPublicKey(ourPriv);
const theirPub = getPublicKey(theirPriv);
const strangerPub = getPublicKey(strangerPriv);
const identity = { secp256k1Pubkey: ourPub, secp256k1Priv: ourPriv };
const encryptToUs = (priv, pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(priv, ourPub));

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ramble-envelope-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const ENVELOPE = { type: "ramble.mark", v: 1, mark: { mark_id: "m-secret", kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, reveal: "open", content_text: "SECRET TEXT", content_kind: "none", created_at: 1 } };

test("sendControl ships a ramble envelope as encrypted kind-4 with only a p tag, and stores no message", async () => {
  const { db, cleanup } = freshDb();
  try {
    const mgr = new NostrManager(identity, db);
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    const out = await mgr.sendControl({ id: 1, crow_id: "crow:them", secp256k1_pubkey: "02" + theirPub }, JSON.stringify(ENVELOPE));
    assert.deepEqual(out.relays, ["wss://stub"]);
    assert.equal(relay.published.length, 1);
    const ev = relay.published[0];
    assert.equal(ev.kind, 4);
    assert.deepEqual(ev.tags, [["p", theirPub]], "no g tag, no d tag — nothing about the mark is public");
    assert.ok(!ev.content.includes("SECRET TEXT") && !ev.content.includes("ramble.") && !ev.content.includes("9v6m21h"), "content is ciphertext");
    const plain = nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(theirPriv, ourPub));
    assert.deepEqual(JSON.parse(plain), ENVELOPE);
    const { rows } = await db.execute("SELECT count(*) AS n FROM messages");
    assert.equal(Number(rows[0].n), 0, "a control envelope never becomes a chat row");
  } finally { cleanup(); }
});

test("subscribeToContact: a ramble envelope reaches the bus and stores no message; a plain DM still stores", async () => {
  const { db, cleanup } = freshDb();
  const got = [];
  const listener = (p) => got.push(p);
  bus.on("ramble:envelope", listener);
  let mgr = null;
  try {
    const ins = await db.execute({
      sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:them', 'ed', ?, 'Them')",
      args: [theirPub],
    });
    const contactId = Number(ins.lastInsertRowid);
    mgr = new NostrManager(identity, db);
    let receipts = 0;
    mgr._sendDeliveryReceipt = async () => { receipts++; };
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    await mgr.subscribeToContact({ id: contactId, crow_id: "crow:them", secp256k1_pubkey: theirPub, display_name: "Them" });
    const onevent = relay.subscribeCalls[0].onevent;

    await onevent({ id: "evt-r1", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs(theirPriv, JSON.stringify(ENVELOPE)) });
    assert.ok(await waitFor(() => got.length === 1), "the envelope must reach the bus");
    assert.deepEqual({ crowId: got[0].crowId, contactId: got[0].contactId, pubkey: got[0].pubkey, eventId: got[0].eventId, createdAt: got[0].createdAt }, { crowId: "crow:them", contactId, pubkey: theirPub, eventId: "evt-r1", createdAt: 1_700_000_000 });
    assert.deepEqual(got[0].payload, ENVELOPE);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] });
    assert.equal(Number(rows.rows[0].n), 0, "never a chat row");
    assert.equal(receipts, 0, "no delivery receipt for a control envelope");

    await onevent({ id: "evt-p1", pubkey: theirPub, created_at: 1_700_000_001, content: encryptToUs(theirPriv, "hello there") });
    assert.ok(await waitFor(async () => Number((await db.execute({ sql: "SELECT count(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] })).rows[0].n) === 1), "a plain DM still stores");
    assert.equal(got.length, 1);

    // A non-ramble JSON DM is untouched by the new branch.
    await onevent({ id: "evt-j1", pubkey: theirPub, created_at: 1_700_000_002, content: encryptToUs(theirPriv, JSON.stringify({ type: "note", text: "x" })) });
    assert.ok(await waitFor(async () => Number((await db.execute({ sql: "SELECT count(*) AS n FROM messages WHERE contact_id = ?", args: [contactId] })).rows[0].n) === 2));
    assert.equal(got.length, 1);
  } finally { bus.off("ramble:envelope", listener); await mgr?.destroy?.(); cleanup(); }
});

test("subscribeToContact: a BLOCKED contact's ramble envelope is dropped before the bus", async () => {
  const { db, cleanup } = freshDb();
  const got = [];
  const listener = (p) => got.push(p);
  bus.on("ramble:envelope", listener);
  let mgr = null;
  try {
    const ins = await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, is_blocked) VALUES ('crow:blk', 'ed', ?, 'B', 1)", args: [theirPub] });
    const contactId = Number(ins.lastInsertRowid);
    mgr = new NostrManager(identity, db);
    mgr._sendDeliveryReceipt = async () => {};
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    await mgr.subscribeToContact({ id: contactId, crow_id: "crow:blk", secp256k1_pubkey: theirPub, display_name: "B" });
    await relay.subscribeCalls[0].onevent({ id: "evt-b1", pubkey: theirPub, created_at: 1_700_000_000, content: encryptToUs(theirPriv, JSON.stringify(ENVELOPE)) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, 0);
  } finally { bus.off("ramble:envelope", listener); await mgr?.destroy?.(); cleanup(); }
});

test("subscribeToIncoming: a stranger's ramble envelope is consumed silently (no message request); a plain DM still requests", async () => {
  const { db, cleanup } = freshDb();
  let mgr = null;
  try {
    mgr = new NostrManager(identity, db);
    const relay = stubRelay();
    mgr.relays.set("wss://stub", relay);
    const requests = [];
    await mgr.subscribeToIncoming(async () => {}, async () => {}, async (sender, content) => { requests.push({ sender, content }); });
    const onevent = relay.subscribeCalls[0].onevent;
    await onevent({ id: "in-1", pubkey: strangerPub, created_at: 1_700_000_000, content: encryptToUs(strangerPriv, JSON.stringify(ENVELOPE)) });
    await onevent({ id: "in-2", pubkey: strangerPub, created_at: 1_700_000_001, content: encryptToUs(strangerPriv, "can we talk") });
    assert.ok(await waitFor(() => requests.length === 1));
    assert.deepEqual(requests, [{ sender: strangerPub, content: "can we talk" }]);
  } finally { await mgr?.destroy?.(); cleanup(); }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/run-suite.mjs tests/ramble-nostr-envelope.test.js`
Expected: test 1 PASSES already (sendControl is unchanged); tests 2–4 FAIL (the envelope is stored as a message / a request is created / no bus event).

- [ ] **Step 3: Edit `subscribeToContact`**

In `servers/sharing/nostr.js`, inside `subscribeToContact`'s `onevent`, directly AFTER the F-BLOCK-1 block check (`if (Number(blockRows?.[0]?.is_blocked ?? 0) === 1) return;` and its closing braces) and BEFORE `if (contactId && this.db) { try { const result = await this.db.execute({ sql: \`INSERT OR IGNORE INTO messages …`, insert:

```js
            // Ramble (phase 3): a `{ "type": "ramble.*" }` envelope is a
            // contacts-delivered mark, a gifted egg or a swap step — never a
            // chat message. Hand it to the ramble transport over the bus
            // (servers/gateway/boot/ramble-transport.js listens; with no
            // bundle installed nothing does and it is simply dropped) and
            // stop: no messages row, no notification, no unread bump, no
            // delivery receipt, no onMessage. Sits AFTER the block check on
            // purpose — a blocked contact's envelope vanishes like their DMs.
            if (decrypted.startsWith("{")) {
              let envelope = null;
              try { envelope = JSON.parse(decrypted); } catch { envelope = null; }
              if (envelope && typeof envelope.type === "string" && envelope.type.startsWith("ramble.")) {
                try {
                  bus.emit("ramble:envelope", {
                    crowId, contactId, pubkey: contactPubkey, payload: envelope,
                    eventId: event.id, createdAt: event.created_at,
                  });
                } catch { /* a subscriber's throw must never break the subscription */ }
                return;
              }
            }
```

- [ ] **Step 4: Edit `subscribeToIncoming`**

In the `if (decrypted.startsWith("{"))` block, extend the `if / else if` chain:

```js
                } else if (payload.type === "crow_social" && payload.subtype && onSocialMessage) {
                  handled = true;
                  await onSocialMessage(payload.subtype, payload.payload || {}, senderPubkey);
                } else if (typeof payload.type === "string" && payload.type.startsWith("ramble.")) {
                  // Ramble envelopes are contact-only: the per-contact
                  // subscription (subscribeToContact) is their only door. On
                  // this catch-all path they are consumed silently so a
                  // stranger's envelope can never surface as a message request.
                  handled = true;
                }
```

Also add the bullet `- ramble.* → consumed (contact-only; see subscribeToContact)` to the method's doc comment list.

- [ ] **Step 5: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-nostr-envelope.test.js && node scripts/run-suite.mjs tests/block-onevent-guard.test.js && node scripts/run-suite.mjs tests/contact-promote.test.js && node scripts/run-suite.mjs tests/boot-receive-decouple.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ramble-nostr-envelope.test.js   # new file
git commit servers/sharing/nostr.js tests/ramble-nostr-envelope.test.js -m "nostr: route ramble.* contact envelopes to the bus, never the chat store"
git show --stat HEAD
```

---

## Task 5: Transport — deliver the outbox, sweep trades, receive envelopes

**Files:**
- Modify: `servers/gateway/boot/ramble-transport.js` (header comment `:37-38`, `startRambleTransport` loads `:83-91`, `drainOnce` `:301-320`, wiring `:432-476`)
- Test: `tests/ramble-transport.test.js`

**Interfaces:**
- Consumes (Task 2): `resolveContact`, `pendingDeliveries`, `deleteDelivery`, `noteDeliveryFailure`, `remainingDeliveries`, `MAX_DELIVERY_ATTEMPTS`; (Task 3): `expireTrades`, `receiveEnvelope`; `nostrManager.sendControl(contact, content) -> { eventId, relays }`; `bus` event `ramble:envelope` (Task 4).
- Produces: `drainOnce()` now returns `{ published, skipped, failed, expired, delivered }`; `transport.onEnvelope(msg)` exported for tests; bus events `ramble:nearby` (existing shape) for a received contacts mark, `ramble:trade` `{ kind: "gift"|"trade", trade_id, egg_id, state }` for gifts/trade transitions; a reply queued by `receiveTrade` triggers an immediate `drainOnce`.

- [ ] **Step 1: Write the failing tests**

In `tests/ramble-transport.test.js`:

(a) Extend `makeHarness`: add `const sent = [];` beside `published`, add to the `nostrManager` stub:

```js
    sendControl: async (contact, content) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.throwErr) throw new Error(state.throwErr);
      sent.push({ contact, content: JSON.parse(content) });
      return { eventId: "ctl-" + sent.length, relays: state.accept ? ["wss://fake"] : [] };
    },
```

return `sent` from the harness, and after `startRambleTransport` create the minimal core tables:

```js
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);`);
```

(b) In the existing test "drain publishes the pending public mark…" change the message on the contacts assertion to `"a bare createMark (no enqueueMark) queues nothing, so the row stays pending"`.

(c) In the stop() test change the final assertion to `assert.deepEqual(result, { published: 0, skipped: 0, failed: 0, expired: 0, delivered: 0 });`.

(d) Add imports: `import { enqueueMark, pendingDeliveries } from "../bundles/ramble/server/delivery.js";` and `import { giftEgg, proposeSwap } from "../bundles/ramble/server/trades.js";`.

(e) Append:

```js
// ---------------------------------------------------------------------------
// Phase 3 — contacts delivery (outbox drain), gifts/swaps, inbound envelopes.
// ---------------------------------------------------------------------------

const PK = "cd".repeat(32);
async function seedContacts(db) {
  await db.executeMultiple(`
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:one', 'One', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:two', 'Two', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blocked', 'Blk', '02${PK}', 1);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, request_status) VALUES ('req:${PK}', NULL, '${PK}', 'pending');`);
}
function seedContactsMark(db, text = "for my contacts") {
  return createMark(db, {
    author: WORLD_AUTHOR, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON, accuracy_m: 5 },
    visibility: "contacts", reveal: "open", content: { content_text: text, content_kind: "none" },
  });
}

test("phase 3: a contacts mark fans out one DM per full contact, then flips to published", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  const row = await seedContactsMark(h.db);
  assert.deepEqual(await enqueueMark(h.db, row, { bird: null }), { ok: true, recipients: 2 });
  const result = await h.transport.drainOnce();
  assert.equal(result.delivered, 2);
  assert.equal(result.published, 0, "nothing went to the public relays");
  assert.equal(h.published.length, 0);
  assert.deepEqual(h.sent.map((s) => s.contact.crow_id).sort(), ["crow:one", "crow:two"]);
  assert.equal(h.sent[0].contact.secp256k1_pubkey, "02" + PK);
  assert.equal(h.sent[0].content.type, "ramble.mark");
  assert.equal(h.sent[0].content.mark.mark_id, row.mark_id);
  assert.equal(h.sent[0].content.mark.content_text, "for my contacts");
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published");
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0);
});

test("phase 3: the grid gates contacts marks (they wait, queued); gifts are never gated", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  const row = await seedContactsMark(h.db);
  await enqueueMark(h.db, row, { bird: null });
  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('g1','shelf','user',9,1)", args: [] });
  assert.equal((await giftEgg(h.db, { eggId: "g1", toCrowId: "crow:one", now: Date.now() })).ok, true);
  let result = await h.transport.drainOnce();
  assert.equal(result.delivered, 1, "only the gift went");
  assert.equal(h.sent[0].content.type, "ramble.egg");
  assert.equal((await pendingDeliveries(h.db, 50)).length, 2, "the two mark rows are still queued");
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "pending");
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  result = await h.transport.drainOnce();
  assert.equal(result.delivered, 2);
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published");
});

test("phase 3: a relay refusal retries and parks at MAX attempts; a vanished recipient or deleted mark drops the row", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  const row = await seedContactsMark(h.db);
  await enqueueMark(h.db, row, { bird: null });
  h.state.accept = false;
  let result = await h.transport.drainOnce();
  assert.equal(result.delivered, 0);
  let rows = await pendingDeliveries(h.db, 50);
  assert.deepEqual(rows.map((r) => r.attempts), [1, 1]);
  await h.db.execute({ sql: "UPDATE ramble_outbox SET attempts = 19 WHERE to_crow_id = 'crow:two'", args: [] });
  await h.transport.drainOnce();
  rows = await pendingDeliveries(h.db, 50);
  assert.deepEqual(rows.map((r) => [r.to_crow_id, r.attempts]), [["crow:one", 2]], "twenty refusals park the delivery");
  h.state.accept = true;
  await h.db.execute({ sql: "DELETE FROM contacts WHERE crow_id = 'crow:one'", args: [] });
  await h.transport.drainOnce();
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0, "no contact, no delivery");
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published", "every row left the queue");
  // A mark deleted before the drain never goes out.
  const doomed = await seedContactsMark(h.db, "doomed");
  await enqueueMark(h.db, doomed, { bird: null });
  await h.db.execute({ sql: "DELETE FROM ramble_marks WHERE mark_id = ?", args: [doomed.mark_id] });
  const before = h.sent.length;
  await h.transport.drainOnce();
  assert.equal(h.sent.length, before);
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0);
});

test("phase 3: an inbound ramble.mark envelope lands as a persistent contacts mark, pokes ramble:nearby and credits meet_crow", async () => {
  const h = await makeHarness();
  const nearby = []; const trades = [];
  h.bus.on("ramble:nearby", (p) => nearby.push(p));
  h.bus.on("ramble:trade", (p) => trades.push(p));
  const mark = { mark_id: "friend-mark", kind: "mark", anchor_kind: "geo", geohash: FULL_GEOHASH, lat: LAT, lon: LON, reveal: "open", content_text: "from a friend", content_kind: "none", created_at: Date.now(), bird: { species: "magpie", seed: 8 } };
  // Through the bus, exactly as NostrManager delivers it (the listener is
  // async and not awaited by emit, so poll for the row).
  h.bus.emit("ramble:envelope", { crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-m" });
  for (let i = 0; i < 200 && !(await getMark(h.db, "friend-mark")); i++) await new Promise((r) => setTimeout(r, 10));
  const stored = await getMark(h.db, "friend-mark");
  assert.ok(stored, "the mark was stored via the bus listener");
  // A second copy (re-delivery), awaited directly: a no-op.
  await h.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-m2" });
  assert.deepEqual([stored.visibility, stored.expires_at, stored.origin, stored.author, stored.bird_species], ["contacts", null, "remote", PK, "magpie"]);
  assert.equal(nearby.length, 1);
  assert.deepEqual(nearby[0], { geohash: FULL_GEOHASH, mark_id: "friend-mark", kind: "mark" });
  const creditKey = `${PK}:${isoWeek(Date.now())}`;
  const credits = async () => (await h.db.execute({ sql: "SELECT * FROM ramble_credits WHERE kind = 'meet_crow' AND key = ?", args: [creditKey] })).rows.length;
  for (let i = 0; i < 200 && (await credits()) === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await credits(), 1);
  assert.equal(trades.length, 0);
});

test("phase 3: an inbound gift lands as received and pokes ramble:trade; an accepted swap completes and its reply drains immediately", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  const trades = [];
  h.bus.on("ramble:trade", (p) => trades.push(p));
  await h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "gift-in", warmth: 12, found_cell: null, found_week: null } } });
  const { rows } = await h.db.execute({ sql: "SELECT status, shelf_origin, from_crow_id FROM ramble_eggs WHERE egg_id = 'gift-in'", args: [] });
  assert.deepEqual(rows[0], { status: "received", shelf_origin: "user", from_crow_id: "crow:one" });
  assert.deepEqual(trades, [{ kind: "gift", trade_id: null, egg_id: "gift-in", state: "received" }]);

  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('mine','shelf','user',3,1)", args: [] });
  const p = await proposeSwap(h.db, { eggId: "mine", toCrowId: "crow:one", now: Date.now() });
  await h.transport.drainOnce(); // the proposal goes out
  assert.equal(h.sent.at(-1).content.trade.state, "proposed");
  await h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: { type: "ramble.trade", v: 1, trade: { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "theirs", want_egg_id: "mine" }, egg: { egg_id: "theirs", warmth: 40, found_cell: null, found_week: null } } });
  assert.deepEqual(trades.at(-1), { kind: "trade", trade_id: p.trade.trade_id, egg_id: "theirs", state: "completed" });
  assert.ok(await new Promise((r) => setTimeout(() => r(h.sent.at(-1).content.trade.state === "completed"), 50)), "the completion reply drained without waiting for a tick");
  assert.equal((await h.db.execute("SELECT status FROM ramble_eggs WHERE egg_id='mine'")).rows[0].status, "gifted");
  assert.equal((await h.db.execute("SELECT status FROM ramble_eggs WHERE egg_id='theirs'")).rows[0].status, "received");
});

test("phase 3 S3: a reply queued while a drain is in flight goes out right after it, not a tick later", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('slow','shelf','user',3,1)", args: [] });
  const p = await proposeSwap(h.db, { eggId: "slow", toCrowId: "crow:one", now: Date.now() });
  h.state.delayMs = 120;
  const inFlight = h.transport.drainOnce(); // sends the proposal, slowly
  await new Promise((r) => setTimeout(r, 20));
  await h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, eventId: "acc-1", payload: { type: "ramble.trade", v: 1, trade: { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "theirs-2", want_egg_id: "slow" }, egg: { egg_id: "theirs-2", warmth: 4, found_cell: null, found_week: null } } });
  await inFlight;
  h.state.delayMs = 0;
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(h.sent.map((x) => x.content.trade.state), ["proposed", "completed"], "the completion rode the redrain, with no manual second drain");
});

test("phase 3 C1: sixty gated mark rows do not starve a gift behind them", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  // Grid closed for contacts: every mark row is skipped but stays queued.
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop
    const row = await seedContactsMark(h.db, "gated " + i);
    // eslint-disable-next-line no-await-in-loop
    await enqueueMark(h.db, row, { bird: null });
  }
  assert.equal((await pendingDeliveries(h.db, 100)).length, 60);
  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('late-gift','shelf','user',1,1)", args: [] });
  assert.equal((await giftEgg(h.db, { eggId: "late-gift", toCrowId: "crow:one", now: Date.now() })).ok, true);
  const result = await h.transport.drainOnce();
  assert.equal(result.delivered, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content.type, "ramble.egg");
});

test("phase 3 C5: the same envelope arriving from several relays is applied once", async () => {
  const h = await makeHarness();
  const trades = [];
  h.bus.on("ramble:trade", (p) => trades.push(p));
  const msg = { crowId: "crow:one", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "dup-gift", warmth: 1, found_cell: null, found_week: null } }, eventId: "same-event" };
  await Promise.all([h.transport.onEnvelope(msg), h.transport.onEnvelope({ ...msg }), h.transport.onEnvelope({ ...msg })]);
  assert.equal(trades.length, 1, "one ramble:trade for three copies of one DM");
  // A different event id with the same egg is still idempotent at the row level.
  await h.transport.onEnvelope({ ...msg, eventId: "other-event" });
  assert.equal(trades.length, 1);
  assert.equal((await h.db.execute("SELECT count(*) AS n FROM ramble_eggs WHERE egg_id='dup-gift'")).rows[0].n, 1);
});

test("phase 3: stop() detaches the envelope listener; a malformed envelope never throws", async () => {
  const h = await makeHarness();
  const before = h.bus.listenerCount("ramble:envelope");
  assert.ok(before >= 1);
  await assert.doesNotReject(h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: "junk" }));
  await assert.doesNotReject(h.transport.onEnvelope(null));
  h.transport.stop();
  assert.equal(h.bus.listenerCount("ramble:envelope"), before - 1);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/run-suite.mjs tests/ramble-transport.test.js`
Expected: the phase-3 tests FAIL (`delivered` undefined, `onEnvelope` not a function).

- [ ] **Step 3: Implement in `servers/gateway/boot/ramble-transport.js`**

(a) Replace the header lines 37-38 ("Phase-1 wire is public-only…") with:

```
 * Contacts/group marks, gifts and swaps (phase 3) never touch the public
 * relays: they ride the LOCAL `ramble_outbox` (bundle delivery.js) and this
 * module's `drainDeliveries` turns each row into one NIP-44 DM through the
 * manager's `sendControl` — the same door every other Crow control envelope
 * uses. Inbound, `NostrManager.subscribeToContact` emits `ramble:envelope`
 * on the bus for any decrypted `ramble.*` DM; `onEnvelope` below hands it to
 * the bundle's `receiveEnvelope`. A contacts mark row flips to `published`
 * when its LAST outbox row is gone (accepted, or dropped because the
 * recipient vanished or the mark was deleted first).
 *
 * Replica note: a user's OTHER instance that had meanwhile incubated an egg
 * this instance gifted applies the `gifted` update and is left with zero
 * incubating eggs until its next mint — the phase-2 "convergence beats
 * choice" ruling, one more time. And because all of a user's instances share
 * one Nostr identity, EVERY instance receives every contact envelope and
 * applies it (idempotent); a swap reply is queued by each of them and the
 * counterpart ignores the copies.
```

(b) Extend the module loads:

```js
  const [{ initRambleTables }, { insertRemoteMark, expireMarks }, nostrMap, { resolvePersona }, { makePublishGate }, { activeBird }, { feedAll }, delivery, trades] = await Promise.all([
    load("init-tables.js"),
    load("marks.js"),
    load("nostr-map.js"),
    load("persona.js"),
    load("grid.js"),
    load("eggs.js"),
    load("feed.js"),
    load("delivery.js"),
    load("trades.js"),
  ]);
  const { resolveContact, pendingDeliveries, deleteDelivery, noteDeliveryFailure, remainingDeliveries, MAX_DELIVERY_ATTEMPTS } = delivery;
  const { expireTrades, receiveEnvelope } = trades;
```

(c) Add after `drainTombstones`:

```js
  /**
   * Phase 3: the contacts wire. One outbox row = one `sendControl` DM. A MARK
   * row is gated by the privacy grid for its audience (re-read every tick,
   * like public marks) and skipped — left queued — while the cell is off; it
   * is dropped if the mark was deleted meanwhile. Gifts and trades are
   * explicit directed sends and are never gated. A recipient that is no
   * longer a deliverable contact drops the row; a relay refusal counts an
   * attempt and parks the row at MAX_DELIVERY_ATTEMPTS (R15). When a mark's
   * last row leaves the queue the mark flips to `published`.
   */
  let warnedNoSendControl = false;
  async function drainDeliveries() {
    if (typeof nostrManager.sendControl !== "function") {
      if (!warnedNoSendControl) { warnedNoSendControl = true; console.warn("[ramble] nostrManager has no sendControl; contacts delivery disabled"); }
      return 0;
    }
    // Gifts/trades first, marks after (pendingDeliveries orders them — C1), so
    // gated mark rows can never fill the batch and starve a swap reply.
    const rows = await pendingDeliveries(db, DRAIN_BATCH);
    // The grid is read once per visibility per tick, not once per row (the
    // gate re-reads ~11 settings rows each call).
    const gateCache = new Map();
    const allowed = async (visibility) => {
      if (!gateCache.has(visibility)) gateCache.set(visibility, await gate({ visibility }));
      return gateCache.get(visibility);
    };
    let delivered = 0;
    for (const d of rows) {
      if (stopped) break;
      try {
        if (d.kind === "mark") {
          // eslint-disable-next-line no-await-in-loop
          const { rows: m } = await db.execute({ sql: "SELECT visibility FROM ramble_marks WHERE mark_id = ?", args: [d.ref_id] });
          // eslint-disable-next-line no-await-in-loop
          if (!m[0]) { await deleteDelivery(db, d.id); await settleMark(d.ref_id); continue; }
          // eslint-disable-next-line no-await-in-loop
          if (!(await allowed(m[0].visibility))) continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const contact = await resolveContact(db, d.to_crow_id);
        if (!contact) {
          console.warn(`[ramble] dropping ${d.kind} delivery to ${d.to_crow_id}: not a deliverable contact`);
          // eslint-disable-next-line no-await-in-loop
          await deleteDelivery(db, d.id);
          // eslint-disable-next-line no-await-in-loop
          if (d.kind === "mark") await settleMark(d.ref_id);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const out = await nostrManager.sendControl(contact, d.payload_json);
        if (!out || !Array.isArray(out.relays) || out.relays.length === 0) {
          // eslint-disable-next-line no-await-in-loop
          const { parked } = await noteDeliveryFailure(db, d, MAX_DELIVERY_ATTEMPTS);
          if (parked) console.warn(`[ramble] ${d.kind} delivery to ${d.to_crow_id} gave up after ${MAX_DELIVERY_ATTEMPTS} attempts`);
          // eslint-disable-next-line no-await-in-loop
          if (parked && d.kind === "mark") await settleMark(d.ref_id);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await deleteDelivery(db, d.id);
        delivered++;
        // eslint-disable-next-line no-await-in-loop
        if (d.kind === "mark") await settleMark(d.ref_id);
      } catch (err) {
        console.warn(`[ramble] ${d.kind} delivery to ${d.to_crow_id} failed:`, err?.message ?? err);
        // eslint-disable-next-line no-await-in-loop
        await noteDeliveryFailure(db, d, MAX_DELIVERY_ATTEMPTS).catch(() => {});
      }
    }
    return delivered;
  }

  /** A contacts mark is 'published' once no outbox row for it remains. */
  async function settleMark(markId) {
    if ((await remainingDeliveries(db, "mark", markId)) > 0) return;
    await db.execute({
      sql: "UPDATE ramble_marks SET publish_state = 'published' WHERE mark_id = ? AND publish_state = 'pending'",
      args: [markId],
    });
  }
```

(d) `drainOnce`:

```js
  // A drain requested WHILE one is running (a swap reply queued mid-tick)
  // runs again right after, instead of waiting a full interval (S3).
  let redrain = false;
  async function drainOnce() {
    if (stopped) return { published: 0, skipped: 0, failed: 0, expired: 0, delivered: 0 };
    if (draining) { redrain = true; return { published: 0, skipped: 0, failed: 0, expired: 0, delivered: 0 }; }
    draining = true;
    let expired = 0;
    let delivered = 0;
    try {
      expired = await expireMarks(db, Date.now(), { emit });
      const result = await drainMarks();
      await drainTombstones();
      // Phase 3: lapsed swap offers unlock their eggs on both sides by local
      // clock, then the contacts wire goes out.
      await expireTrades(db, Date.now(), { emit });
      delivered = await drainDeliveries();
      return { ...result, expired, delivered };
    } catch (err) {
      console.warn("[ramble] drain failed:", err?.message ?? err);
      return { published: 0, skipped: 0, failed: 0, expired, delivered };
    } finally {
      draining = false;
      if (redrain && !stopped) { redrain = false; void drainOnce().catch(() => {}); }
    }
  }
```

(e) After `onEvent` add:

```js
  /**
   * Phase 3 inbound: one decrypted `ramble.*` DM from a contact, as emitted
   * by NostrManager.subscribeToContact. Never throws; never rejects.
   */
  // NostrManager registers one onevent PER RELAY, so one DM can arrive up to
  // relays.size times with the same event id; the copies interleave across
  // awaits and would each run receiveTrade (C5). Bounded dedup by event id.
  const seenEnvelopes = new Set();
  const SEEN_ENVELOPES_MAX = 1000;
  async function onEnvelope(msg) {
    try {
      if (stopped || !msg || typeof msg !== "object" || !msg.payload) return;
      if (msg.eventId != null) {
        const key = String(msg.eventId);
        if (seenEnvelopes.has(key)) return;
        seenEnvelopes.add(key);
        if (seenEnvelopes.size > SEEN_ENVELOPES_MAX) seenEnvelopes.delete(seenEnvelopes.values().next().value);
      }
      const result = await receiveEnvelope(db, msg, { now: Date.now(), emit });
      if (!result) return;
      if (result.kind === "mark" && result.inserted) {
        try {
          bus.emit("ramble:nearby", { geohash: result.geohash, mark_id: result.mark_id, kind: result.markKind });
        } catch (emitErr) {
          console.warn("[ramble] ramble:nearby subscriber threw:", emitErr?.message ?? emitErr);
        }
        try {
          await feedAll(db, { type: "meet_crow", persona: String(msg.pubkey).length === 66 ? String(msg.pubkey).slice(2) : msg.pubkey }, {
            emit,
            onHatch: (egg) => {
              try { bus.emit("ramble:hatched", { egg_id: egg.egg_id, species: egg.species, seed: egg.seed }); }
              catch (hatchErr) { console.warn("[ramble] ramble:hatched subscriber threw:", hatchErr?.message ?? hatchErr); }
            },
          });
        } catch (feedErr) {
          console.warn("[ramble] meet_crow feed failed:", feedErr?.message ?? feedErr);
        }
        return;
      }
      if (result.kind === "egg" && result.inserted) {
        try { bus.emit("ramble:trade", { kind: "gift", trade_id: null, egg_id: result.egg_id, state: "received" }); }
        catch (e) { console.warn("[ramble] ramble:trade subscriber threw:", e?.message ?? e); }
        return;
      }
      if (result.kind === "trade") {
        if (result.changed) {
          try { bus.emit("ramble:trade", { kind: "trade", trade_id: result.trade_id, egg_id: result.egg_id ?? null, state: result.state }); }
          catch (e) { console.warn("[ramble] ramble:trade subscriber threw:", e?.message ?? e); }
        }
        // A reply (completed / declined) was queued: send it now, not next tick.
        if (result.deliveries > 0) void drainOnce().catch(() => {});
      }
    } catch (err) {
      console.warn("[ramble] incoming envelope dropped:", err?.message ?? err);
    }
  }
```

(f) Wiring: after `bus.on("ramble:area", onAreaChanged);` add `bus.on("ramble:envelope", onEnvelope);`; in `stop()` add `bus.off("ramble:envelope", onEnvelope);`; add `onEnvelope,` to the returned object.

- [ ] **Step 4: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-transport.test.js && node scripts/run-suite.mjs tests/ramble-nostr-envelope.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/boot/ramble-transport.js tests/ramble-transport.test.js -m "ramble transport: drain the contacts outbox, sweep trades, receive envelopes"
git show --stat HEAD
```

---

## Task 6: Panel routes + the `ramble-trade` stream frame

**Files:**
- Modify: `bundles/ramble/panel/routes.js` (validation constants `:66-78`, `ensureLoaded` `:191-242`, marks routes `:450-520`, after the activate route `:758-763`)
- Modify: `servers/gateway/routes/streams.js:222-247`
- Test: `tests/ramble-panel.test.js`, `tests/ramble-stream.test.js`

**Interfaces:**
- Consumes (Task 2): `listAudiences`, `resolveContact`, `resolveAudience`, `enqueueMark`; (Task 3): `giftEgg`, `proposeSwap`, `acceptSwap`, `declineSwap`, `listTrades`.
- Produces routes (all under the existing `router.use("/api/ramble", dashboardAuth)`):
  - `GET /api/ramble/contacts` → `{ contacts: [{ crow_id, display_name }], groups: [{ group_uid, name, member_count }] }` (empty lists when the core tables are unreadable)
  - `GET /api/ramble/marks` → each remote mark whose author is a contact gains `contact_name`
  - `POST /api/ramble/marks` → `{ mark, hatched, recipients }`; `400 unknown group`
  - `POST /api/ramble/eggs/:id/gift { crow_id }` → `200 { egg, to }`; `400` bad/unknown contact; `404 not-found`; `409 { error: "not-an-egg"|"in-trade" }`
  - `GET /api/ramble/trades` → `{ trades: [ …listTrades row, counterpart_name ] }`
  - `POST /api/ramble/trades { egg_id, crow_id }` → `201 { trade }`; `400`/`404`/`409` as gift
  - `POST /api/ramble/trades/:id/accept { egg_id }` → `200 { trade }`; `404 not-found`; `409 { error: "not-open"|"expired"|"not-an-egg"|"in-trade" }`
  - `POST /api/ramble/trades/:id/decline` → `200 { trade }`; `404`; `409 not-open`
  - Every mutating route pokes `ramble:drain` and `ramble:trade`.
- Stream: `event: ramble-trade` with data allow-listed to `{ kind, trade_id, egg_id, state }` (string-or-null each).

- [ ] **Step 1: Write the failing stream tests**

Append to `tests/ramble-stream.test.js`:

```js
// ---------------------------------------------------- trades (phase 3)

test("ramble-trade frame carries exactly kind, trade_id, egg_id, state; unsubscribes on close", () => {
  const prior = bus.listenerCount("ramble:trade");
  const handler = getRambleNearbyHandler();
  const { res, chunks, fireClose } = fakeRes();
  handler({ dashboardSession: "tok-t1" }, res);
  assert.equal(bus.listenerCount("ramble:trade"), prior + 1);
  const before = chunks.length;
  bus.emit("ramble:trade", { kind: "trade", trade_id: "t1", egg_id: "e1", state: "completed", offer_json: "nope" });
  const match = chunks.slice(before).join("").match(/event: ramble-trade\ndata: (.+)\n\n/);
  assert.ok(match, "frame must carry a data: JSON payload");
  assert.deepEqual(JSON.parse(match[1]), { kind: "trade", trade_id: "t1", egg_id: "e1", state: "completed" });
  assert.doesNotThrow(() => bus.emit("ramble:trade", {}));
  const sparse = chunks.slice(before).join("").match(/event: ramble-trade\ndata: (.+)\n\n/g);
  assert.equal(sparse.length, 2);
  assert.deepEqual(JSON.parse(sparse[1].match(/data: (.+)\n\n/)[1]), { kind: null, trade_id: null, egg_id: null, state: null });
  fireClose();
  assert.equal(bus.listenerCount("ramble:trade"), prior);
});
```

- [ ] **Step 2: Stream implementation**

In `servers/gateway/routes/streams.js`, after `claimedHandler` add:

```js
    // Phase 3: gifts and swap steps. The transport (an inbound envelope) and
    // bundles/ramble/panel/routes.js (a local gift/propose/accept/decline)
    // both poke `ramble:trade` with { kind, trade_id, egg_id, state }; the
    // panel refreshes its shelf and its swap list. Allow-listed to exactly
    // those four strings — never the offer, never a crow id.
    const tradeHandler = (payload) => {
      try {
        const out = {
          kind: payload?.kind != null ? String(payload.kind) : null,
          trade_id: payload?.trade_id != null ? String(payload.trade_id) : null,
          egg_id: payload?.egg_id != null ? String(payload.egg_id) : null,
          state: payload?.state != null ? String(payload.state) : null,
        };
        sendRaw(`event: ramble-trade\ndata: ${JSON.stringify(out)}\n\n`);
      } catch {
        // Subscriber isolation.
      }
    };
```

and register/unregister it beside the others: `bus.on("ramble:trade", tradeHandler);` and `bus.off("ramble:trade", tradeHandler);` inside `unsubscribe`.

Run: `node scripts/run-suite.mjs tests/ramble-stream.test.js` — Expected: PASS.

- [ ] **Step 3: Write the failing route tests**

In `tests/ramble-panel.test.js`:

(a) After `const BASE = …` create the minimal core tables in the scratch db and seed contacts:

```js
// Phase 3: the routes read the CORE contact tables. The scratch db never ran
// init-db.js, so plant the exact columns ramble reads (never in production).
const PK = "ef".repeat(32);        // crow:pal's key (x-only); every seeded contact gets a DISTINCT key
const PK_BUDDY = "ee".repeat(32);
const PK_BLOCKED = "ed".repeat(32);
{
  const db = createDbClient();
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:buddy', 'Buddy', '02${PK_BUDDY}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blocked', 'Blocked', '02${PK_BLOCKED}', 1);
    INSERT INTO contact_groups (name, group_uid) VALUES ('Walkers', 'grp-walk');
    INSERT INTO contact_groups (name, group_uid, room_uid) VALUES ('Room', 'grp-room', 'r1');
    INSERT INTO contact_group_members (group_id, contact_id) VALUES (1, 1);`);
  try { db.close?.(); } catch { /* scratch */ }
}
```

(b) Append the route tests (before the `// --- static` / docs-parity tests is fine; order is by file position, so place them after the activate tests):

```js
// -------------------------------------------------------- phase 3: contacts wire

test("GET /api/ramble/contacts lists full contacts and plain groups only", async () => {
  const out = await (await req("/api/ramble/contacts")).json();
  assert.deepEqual(out.contacts, [{ crow_id: "crow:buddy", display_name: "Buddy" }, { crow_id: "crow:pal", display_name: "Pal" }]);
  assert.deepEqual(out.groups, [{ group_uid: "grp-walk", name: "Walkers", member_count: 1 }]);
});

test("POST /api/ramble/marks: contacts fans out to every contact, group:<uid> to its members, an unknown group is a 400", async () => {
  const body = { kind: "mark", lat: LAT, lon: LON, text: "for you two", visibility: "contacts", reveal: "open" };
  let res = await req("/api/ramble/marks", { method: "POST", body });
  assert.equal(res.status, 201);
  let out = await res.json();
  assert.equal(out.recipients, 2);
  assert.equal(out.mark.publish_state, "pending", "queued, not published — the transport sends");
  const db = createDbClient();
  const { rows } = await db.execute({ sql: "SELECT to_crow_id, kind FROM ramble_outbox WHERE ref_id = ? ORDER BY to_crow_id", args: [out.mark.mark_id] });
  assert.deepEqual(rows.map((r) => [r.to_crow_id, r.kind]), [["crow:buddy", "mark"], ["crow:pal", "mark"]]);
  res = await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "group:grp-walk" } });
  assert.equal(res.status, 201); assert.equal((await res.json()).recipients, 1);
  res = await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "group:grp-room" } });
  assert.equal(res.status, 400, "a room is not a group");
  assert.equal((await res.json()).error, "unknown group");
  assert.equal((await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "group:nope" } })).status, 400);
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_marks WHERE visibility='group:nope'")).rows[0].n, 0, "no row for a refused group");
  res = await req("/api/ramble/marks", { method: "POST", body: { ...body, visibility: "public" } });
  assert.equal((await res.json()).recipients, 0, "public marks take the relay path, not the outbox");
});

test("GET /api/ramble/marks names a remote mark by a contact; a stranger's stays anonymous", async () => {
  const db = createDbClient();
  await db.execute({
    sql: `INSERT INTO ramble_marks (mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, visibility, reveal, content_text, created_at, origin, publish_state)
          VALUES ('by-pal', ?, 'real', 'mark', 'geo', '9v6m21h', ?, ?, 'contacts', 'open', 'hi', ?, 'remote', 'remote'),
                 ('by-stranger', ?, NULL, 'mark', 'geo', '9v6m21h', ?, ?, 'public', 'open', 'yo', ?, 'remote', 'remote')`,
    args: [PK, LAT, LON, Date.now(), "99".repeat(32), LAT, LON, Date.now()],
  });
  const { marks } = await (await req(`/api/ramble/marks?cells=${CELL}`)).json();
  assert.equal(marks.find((m) => m.mark_id === "by-pal").contact_name, "Pal");
  assert.equal(marks.find((m) => m.mark_id === "by-stranger").contact_name, undefined);
});

test("POST /api/ramble/eggs/:id/gift: unknown contact 400, unknown egg 404, incubating egg 409, shelf egg goes 'gifted' and queues one DM", async () => {
  const db = createDbClient();
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('gift-me','shelf','user',7,1) ON CONFLICT(egg_id) DO NOTHING", args: [] });
  assert.equal((await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: { crow_id: "crow:nobody" } })).status, 400);
  assert.equal((await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: { crow_id: "crow:blocked" } })).status, 400);
  assert.equal((await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: {} })).status, 400);
  assert.equal((await req("/api/ramble/eggs/nope/gift", { method: "POST", body: { crow_id: "crow:pal" } })).status, 404);
  const inc = (await (await req("/api/ramble/egg")).json()).egg.egg_id;
  const r409 = await req(`/api/ramble/eggs/${inc}/gift`, { method: "POST", body: { crow_id: "crow:pal" } });
  assert.equal(r409.status, 409); assert.equal((await r409.json()).error, "not-an-egg");
  const before = emitCalls.length;
  const res = await req("/api/ramble/eggs/gift-me/gift", { method: "POST", body: { crow_id: "crow:pal" } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual([out.egg.egg_id, out.egg.status, out.to], ["gift-me", "gifted", "crow:pal"]);
  assert.ok(emitCalls.slice(before).some((c) => c.table === "ramble_eggs" && c.op === "update" && c.row.egg_id === "gift-me" && c.row.status === "gifted"));
  const { rows } = await db.execute({ sql: "SELECT to_crow_id, kind, payload_json FROM ramble_outbox WHERE ref_id = 'gift-me'", args: [] });
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, "egg");
  const payload = JSON.parse(rows[0].payload_json);
  assert.deepEqual(Object.keys(payload.egg).sort(), ["egg_id", "found_cell", "found_week", "warmth"]);
  const flock = await (await req("/api/ramble/flock")).json();
  assert.ok(!flock.eggs.find((e) => e.egg_id === "gift-me"), "a gifted egg is off the shelf");
});

test("swaps over the routes: propose 201, list, accept refuses on the proposer side, decline 200; a planted incoming offer accepts with a shelf egg", async () => {
  const db = createDbClient();
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('offer-me','shelf','user',9,1), ('answer-with','received','user',4,2) ON CONFLICT(egg_id) DO NOTHING", args: [] });
  assert.equal((await req("/api/ramble/trades", { method: "POST", body: { egg_id: "offer-me", crow_id: "crow:nobody" } })).status, 400);
  assert.equal((await req("/api/ramble/trades", { method: "POST", body: { egg_id: "nope", crow_id: "crow:pal" } })).status, 404);
  let res = await req("/api/ramble/trades", { method: "POST", body: { egg_id: "offer-me", crow_id: "crow:pal" } });
  assert.equal(res.status, 201);
  const { trade } = await res.json();
  assert.deepEqual([trade.role, trade.state, trade.my_egg_id, trade.counterpart], ["proposer", "proposed", "offer-me", "crow:pal"]);
  res = await req("/api/ramble/trades", { method: "POST", body: { egg_id: "offer-me", crow_id: "crow:buddy" } });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, "in-trade");
  assert.equal((await req("/api/ramble/eggs/offer-me/incubate", { method: "POST", body: {} })).status, 409, "a locked egg cannot be incubated");
  assert.equal((await req("/api/ramble/eggs/offer-me/gift", { method: "POST", body: { crow_id: "crow:buddy" } })).status, 409);
  const list = await (await req("/api/ramble/trades")).json();
  const mine = list.trades.find((t) => t.trade_id === trade.trade_id);
  assert.deepEqual([mine.open, mine.counterpart_name, mine.offer], [true, "Pal", null]);
  assert.equal((await (await req("/api/ramble/flock")).json()).eggs.find((e) => e.egg_id === "offer-me").locked, true);
  res = await req(`/api/ramble/trades/${trade.trade_id}/accept`, { method: "POST", body: { egg_id: "answer-with" } });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, "not-open");
  assert.equal((await req("/api/ramble/trades/ghost/decline", { method: "POST", body: {} })).status, 404);
  res = await req(`/api/ramble/trades/${trade.trade_id}/decline`, { method: "POST", body: {} });
  assert.equal(res.status, 200); assert.equal((await res.json()).trade.state, "declined");
  assert.equal((await (await req("/api/ramble/flock")).json()).eggs.find((e) => e.egg_id === "offer-me").locked, false);

  await db.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('in-1','crow:buddy','acceptor',NULL,'their-egg','{\"egg_id\":\"their-egg\",\"warmth\":50,\"found_cell\":null,\"found_week\":null}','proposed',1,1,?)", args: [Date.now() + 1e9] });
  const incoming = (await (await req("/api/ramble/trades")).json()).trades.find((t) => t.trade_id === "in-1");
  assert.deepEqual([incoming.counterpart_name, incoming.offer.warmth, incoming.open], ["Buddy", 50, true]);
  assert.equal((await req("/api/ramble/trades/in-1/accept", { method: "POST", body: { egg_id: "nope" } })).status, 409);
  assert.equal((await req("/api/ramble/trades/in-1/accept", { method: "POST", body: {} })).status, 400);
  res = await req("/api/ramble/trades/in-1/accept", { method: "POST", body: { egg_id: "answer-with" } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).trade.state, "accepted");
  const { rows } = await db.execute({ sql: "SELECT to_crow_id, payload_json FROM ramble_outbox WHERE ref_id = 'in-1'", args: [] });
  assert.equal(rows[0].to_crow_id, "crow:buddy");
  assert.equal(JSON.parse(rows[0].payload_json).trade.state, "accepted");
  assert.equal(JSON.parse(rows[0].payload_json).egg.egg_id, "answer-with");
});

test("contacts, gift and trade routes are behind dashboardAuth", async () => {
  for (const [method, path] of [["GET", "/api/ramble/contacts"], ["GET", "/api/ramble/trades"], ["POST", "/api/ramble/trades"], ["POST", "/api/ramble/eggs/x/gift"], ["POST", "/api/ramble/trades/x/accept"], ["POST", "/api/ramble/trades/x/decline"]]) {
    const res = await realFetch(BASE + path, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});
```

- [ ] **Step 4: Run to see them fail**

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js`
Expected: the five new route tests FAIL (404s from unknown routes; `recipients` undefined).

- [ ] **Step 5: Routes implementation**

In `bundles/ramble/panel/routes.js`:

(a) Constants — after `EGG_ID_RE` add:

```js
const CROW_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const TRADE_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
```

(b) `ensureLoaded`: add `bundleImport("server/delivery.js")` and `bundleImport("server/trades.js")` to the `Promise.all` (destructure as `deliveryMod, tradesMod`), include them in the null check and in `mods`.

(c) Helpers after `getSetting`:

```js
  /** A deliverable contact by crow_id, or null — also null when the core tables are unreadable. */
  async function contactOrNull(crowId) {
    try { return await mods.deliveryMod.resolveContact(db, crowId); }
    catch (err) { console.warn("[ramble routes] contact lookup failed:", err?.message ?? err); return null; }
  }

  /** x-only pubkey -> { crow_id, name } for every unblocked full contact — bots included on purpose, naming a bot's mark is harmless (round-2 Q2). Tolerant: empty map without the core tables. */
  async function contactsByPubkey() {
    const map = new Map();
    try {
      // ORDER BY id + first-wins: two contact rows can share a key (a bot
      // hosted beside its owner); the older row names the mark, deterministically.
      const { rows } = await db.execute({ sql: "SELECT crow_id, display_name, secp256k1_pubkey FROM contacts WHERE is_blocked = 0 AND request_status IS NULL ORDER BY id", args: [] });
      for (const r of rows) {
        const pk = String(r.secp256k1_pubkey || "");
        const key = pk.length === 66 ? pk.slice(2) : pk;
        if (key && !map.has(key)) map.set(key, { crow_id: r.crow_id, name: r.display_name || r.crow_id });
      }
    } catch { /* no core tables: nobody is a contact */ }
    return map;
  }

  async function contactNames() {
    try {
      const { contacts } = await mods.deliveryMod.listAudiences(db);
      return new Map(contacts.map((c) => [c.crow_id, c.display_name || c.crow_id]));
    } catch { return new Map(); }
  }

  function tradeStatus(out) {
    if (out.reason === "not-found") return 404;
    return 409;
  }
```

(d) `GET /api/ramble/marks` — replace the final line with:

```js
    const marks = await mods.marksMod.listMarks(db, { visibility, cells });
    // Phase 3: a remote mark by a contact is named; a stranger's stays anonymous
    // (that is where the panel offers "share an invite").
    const byPubkey = await contactsByPubkey();
    res.json({
      marks: marks.map(withApproxAnchor).map((m) => {
        const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
        return c ? { ...m, contact_name: c.name } : m;
      }),
    });
```

(e) `POST /api/ramble/marks` — after the visibility validation add:

```js
    // Phase 3: a group audience must exist before a row is written for it.
    if (visibility.startsWith("group:")) {
      let a = null;
      try { a = await mods.deliveryMod.resolveAudience(db, visibility); } catch { a = null; }
      if (!a || !a.ok) bad("unknown group");
    }
```

and after `createMark(...)` (before `poke("ramble:drain")`):

```js
    // Phase 3: contacts/group marks ride the outbox as one DM per recipient.
    // The row already exists; a queue failure must not fail the author.
    let recipients = 0;
    if (visibility === "contacts" || visibility.startsWith("group:")) {
      try {
        const q = await mods.deliveryMod.enqueueMark(db, mark, { bird: await mods.eggsMod.activeBird(db), now: Date.now() });
        recipients = q.ok ? q.recipients : 0;
      } catch (err) {
        console.warn("[ramble routes] enqueueMark failed:", err?.message ?? err);
      }
    }
```

and change the response to `res.status(201).json({ mark, hatched: hatchedPayload(fed), recipients });`.

(f) New routes after the activate route:

```js
  // --- phase 3: contacts wire -------------------------------------------------
  router.get("/api/ramble/contacts", handle(async (req, res) => {
    try { res.json(await mods.deliveryMod.listAudiences(db)); }
    catch (err) {
      console.warn("[ramble routes] audiences unavailable:", err?.message ?? err);
      res.json({ contacts: [], groups: [] });
    }
  }));

  router.post("/api/ramble/eggs/:id/gift", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const b = req.body || {};
    if (typeof b.crow_id !== "string" || !CROW_ID_RE.test(b.crow_id)) bad("crow_id is required");
    const contact = await contactOrNull(b.crow_id);
    if (!contact) bad("unknown contact");
    const out = await mods.tradesMod.giftEgg(db, { eggId: req.params.id, toCrowId: contact.crow_id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "gift", trade_id: null, egg_id: out.egg.egg_id, state: "gifted" });
    res.json({ egg: out.egg, to: contact.crow_id });
  }));

  router.get("/api/ramble/trades", handle(async (req, res) => {
    const names = await contactNames();
    const trades = (await mods.tradesMod.listTrades(db, { now: Date.now(), limit: 20 }))
      .map((t) => ({ ...t, counterpart_name: names.get(t.counterpart) || t.counterpart }));
    res.json({ trades });
  }));

  router.post("/api/ramble/trades", handle(async (req, res) => {
    const b = req.body || {};
    if (typeof b.egg_id !== "string" || !EGG_ID_RE.test(b.egg_id)) bad("egg_id is required");
    if (typeof b.crow_id !== "string" || !CROW_ID_RE.test(b.crow_id)) bad("crow_id is required");
    const contact = await contactOrNull(b.crow_id);
    if (!contact) bad("unknown contact");
    const out = await mods.tradesMod.proposeSwap(db, { eggId: b.egg_id, toCrowId: contact.crow_id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "trade", trade_id: out.trade.trade_id, egg_id: b.egg_id, state: "proposed" });
    res.status(201).json({ trade: out.trade });
  }));

  router.post("/api/ramble/trades/:id/accept", handle(async (req, res) => {
    if (!TRADE_ID_RE.test(req.params.id)) bad("invalid trade id");
    const b = req.body || {};
    if (typeof b.egg_id !== "string" || !EGG_ID_RE.test(b.egg_id)) bad("egg_id is required");
    const out = await mods.tradesMod.acceptSwap(db, { tradeId: req.params.id, eggId: b.egg_id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "trade", trade_id: out.trade.trade_id, egg_id: b.egg_id, state: "accepted" });
    res.json({ trade: out.trade });
  }));

  router.post("/api/ramble/trades/:id/decline", handle(async (req, res) => {
    if (!TRADE_ID_RE.test(req.params.id)) bad("invalid trade id");
    const out = await mods.tradesMod.declineSwap(db, { tradeId: req.params.id, now: Date.now(), emit });
    if (!out.ok) return res.status(tradeStatus(out)).json({ error: out.reason });
    poke("ramble:drain");
    poke("ramble:trade", { kind: "trade", trade_id: out.trade.trade_id, egg_id: out.trade.my_egg_id ?? null, state: "declined" });
    res.json({ trade: out.trade });
  }));
```

(g) Update the file header: the "Egress" paragraph gains "Phase 3: contacts/group marks, gifts and swaps are queued into `ramble_outbox` here and sent by the transport's `drainDeliveries`; a 200/201 means queued."

- [ ] **Step 6: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js && node scripts/run-suite.mjs tests/ramble-stream.test.js`
Expected: all PASS (the existing `POST /api/ramble/marks` tests still pass: `recipients` is an added key).

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/routes.js servers/gateway/routes/streams.js tests/ramble-panel.test.js tests/ramble-stream.test.js -m "ramble routes: contacts list, gift, swap propose/accept/decline, ramble-trade stream"
git show --stat HEAD
```

---

## Task 7: MCP tools — `ramble_gift_egg`, `ramble_propose_swap`, contacts fan-out in `ramble_leave_mark`

**Files:**
- Modify: `bundles/ramble/server/server.js` (imports `:18-27`, header `:1-5`, `ramble_leave_mark` `:133-182`, new tools after `ramble_claim_nest` `:359-379`)
- Test: `tests/ramble-tools.test.js`

**Interfaces:**
- Consumes (Task 2): `resolveContact`, `enqueueMark`, `CROW_ID_RE`, `ID_RE`; (Task 3): `giftEgg`, `proposeSwap`.
- Produces tools: `ramble_gift_egg { egg_id, crow_id }` → `{ gifted: true, egg_id, to, queued: true }`; `ramble_propose_swap { egg_id, crow_id }` → `{ proposed: true, trade_id, egg_id, to, expires_at, queued: true }`; `ramble_leave_mark` output gains `recipients` (contacts/group only). Tool count goes 13 → 15.
- Spec §7 lists exactly these two tools; accept/decline stay panel-only (documented in Task 9).

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-tools.test.js` (the file's `db` is in-memory; add the core tables and seeds inside the test so earlier tests are untouched):

```js
test("phase 3 tools: gift and propose_swap validate the contact and the egg, queue one DM each; leave_mark reports recipients", async () => {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:pal', 'Pal', '02${"ab".repeat(32)}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blk', 'Blk', '02${"ab".repeat(32)}', 1);
    INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('t-gift','shelf','user',3,1), ('t-swap','received','user',8,2);`);

  let r = await h.ramble_gift_egg({ egg_id: "t-gift", crow_id: "crow:blk" });
  assert.ok(r.isError); assert.match(r.content[0].text, /unknown contact/);
  r = await h.ramble_gift_egg({ egg_id: "nope", crow_id: "crow:pal" });
  assert.ok(r.isError); assert.match(r.content[0].text, /not-found/);
  r = await h.ramble_gift_egg({ egg_id: "t-gift", crow_id: "crow:pal" });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(JSON.parse(r.content[0].text), { gifted: true, egg_id: "t-gift", to: "crow:pal", queued: true });
  assert.equal((await db.execute("SELECT status FROM ramble_eggs WHERE egg_id='t-gift'")).rows[0].status, "gifted");
  r = await h.ramble_gift_egg({ egg_id: "t-gift", crow_id: "crow:pal" });
  assert.ok(r.isError, "already gone");

  r = await h.ramble_propose_swap({ egg_id: "t-swap", crow_id: "crow:pal" });
  assert.ok(!r.isError, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.proposed, true); assert.equal(out.egg_id, "t-swap"); assert.equal(out.to, "crow:pal");
  assert.match(out.trade_id, /^[0-9a-f-]{36}$/);
  assert.ok(Number(out.expires_at) > Date.now());
  r = await h.ramble_propose_swap({ egg_id: "t-swap", crow_id: "crow:pal" });
  assert.ok(r.isError); assert.match(r.content[0].text, /in-trade/);

  const { rows } = await db.execute("SELECT kind, to_crow_id FROM ramble_outbox ORDER BY id");
  assert.deepEqual(rows.map((x) => [x.kind, x.to_crow_id]), [["egg", "crow:pal"], ["trade", "crow:pal"]]);

  r = await h.ramble_leave_mark({ lat: 30.2, lon: -97.7, text: "for contacts", visibility: "contacts" });
  assert.ok(!r.isError);
  assert.equal(JSON.parse(r.content[0].text).recipients, 1);
  r = await h.ramble_leave_mark({ lat: 30.2, lon: -97.7, text: "for a ghost group", visibility: "group:nope" });
  assert.ok(r.isError); assert.match(r.content[0].text, /unknown group/);
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_marks WHERE visibility='group:nope'")).rows[0].n, 0);
  r = await h.ramble_leave_mark({ lat: 30.2, lon: -97.7, text: "public", visibility: "public" });
  assert.equal(JSON.parse(r.content[0].text).recipients, undefined, "public marks do not report recipients");
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node scripts/run-suite.mjs tests/ramble-tools.test.js`
Expected: FAIL — `h.ramble_gift_egg is not a function`.

- [ ] **Step 3: Implement**

In `bundles/ramble/server/server.js`:

(a) Imports: add

```js
import { resolveContact, resolveAudience, enqueueMark, CROW_ID_RE, ID_RE } from "./delivery.js";
import { giftEgg, proposeSwap } from "./trades.js";
```

(b) Header comment: add `ramble_gift_egg, ramble_propose_swap` to the tool list and replace the "Groups are NOT in phase 1" paragraph with: "Phase 3: contacts/group marks, gifts and swaps are queued into `ramble_outbox` here and SENT by the gateway transport on its next tick (this stdio process has no relay socket and no bus, so there is no immediate poke — up to 15 s). Group audiences are the core contact groups (`group:<group_uid>`); the phase-1 `ramble_groups` table is unused."

(c) `ramble_leave_mark`: after `checkVisibility(visibility);` add

```js
        // Phase 3: an audience that cannot be resolved is refused BEFORE a row exists.
        if (visibility.startsWith("group:")) {
          let a = null;
          try { a = await resolveAudience(db, visibility); } catch { a = null; }
          if (!a || !a.ok) return errorText(`unknown group: ${visibility.slice(6)}`);
        }
```

and after `createMark(...)`:

```js
        let recipients;
        if (visibility === "contacts" || visibility.startsWith("group:")) {
          try { recipients = (await enqueueMark(db, row, { bird, now: Date.now() })).recipients; }
          catch (err) { console.warn("[ramble] enqueueMark failed:", err?.message ?? err); recipients = 0; }
        }
```

and add `...(recipients === undefined ? {} : { recipients })` to the returned JSON object.

(d) New tools after `ramble_claim_nest`:

```js
  register(
    "ramble_gift_egg",
    "Gift an unhatched egg from your shelf to a contact (by crow_id). The egg leaves your shelf and arrives on theirs still unhatched — whoever hatches it rolls the bird. Contacts only; sent on the gateway's next tick.",
    { egg_id: z.string().regex(ID_RE), crow_id: z.string().regex(CROW_ID_RE) },
    async ({ egg_id, crow_id }) => {
      try {
        let contact = null;
        try { contact = await resolveContact(db, crow_id); } catch { contact = null; }
        if (!contact) return errorText(`unknown contact: ${crow_id}`);
        const emit = await getEmit();
        const out = await giftEgg(db, { eggId: egg_id, toCrowId: contact.crow_id, now: Date.now(), emit });
        if (!out.ok) return errorText(out.reason);
        return text(JSON.stringify({ gifted: true, egg_id, to: contact.crow_id, queued: true }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );

  register(
    "ramble_propose_swap",
    "Offer one of your unhatched shelf eggs to a contact in exchange for one of theirs; they pick which egg to give back. The offer lapses after seven days. Accept or decline incoming offers from the Ramble panel.",
    { egg_id: z.string().regex(ID_RE), crow_id: z.string().regex(CROW_ID_RE) },
    async ({ egg_id, crow_id }) => {
      try {
        let contact = null;
        try { contact = await resolveContact(db, crow_id); } catch { contact = null; }
        if (!contact) return errorText(`unknown contact: ${crow_id}`);
        const emit = await getEmit();
        const out = await proposeSwap(db, { eggId: egg_id, toCrowId: contact.crow_id, now: Date.now(), emit });
        if (!out.ok) return errorText(out.reason);
        return text(JSON.stringify({ proposed: true, trade_id: out.trade.trade_id, egg_id, to: contact.crow_id, expires_at: out.trade.expires_at, queued: true }));
      } catch (err) {
        return errorText(err.message);
      }
    },
  );
```

- [ ] **Step 4: Run the tests**

Run: `node scripts/run-suite.mjs tests/ramble-tools.test.js && node scripts/run-suite.mjs tests/bundle-server-deps.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/server.js tests/ramble-tools.test.js -m "ramble tools: ramble_gift_egg, ramble_propose_swap, contacts fan-out on leave_mark"
git show --stat HEAD
```

---

## Task 8: Panel — Gift / Swap / Accept / Decline, contact picker, "From <name>", group audience, "Share an invite"

**Files:**
- Modify: `bundles/ramble/panel/ramble.js` (compose Who row `:143-150`, flock view `:294-315`, sheets `:317-343`)
- Modify: `bundles/ramble/panel/static/ramble.js` (marks `:224-278`, compose `:475-531`, flock `:857-961`, stream `:1026-1041`, startup `:1043-1055`)
- Modify: `bundles/ramble/panel/static/ramble.css` (after the `.rb-tag` rules `:618-625`)
- Test: `tests/ramble-panel.test.js` (shell + static assertions), `tests/ramble-stream.test.js` (client listener)

**Interfaces:**
- Consumes routes from Task 6 and the `ramble-trade` frame. `Bird` engine unchanged.
- Produces: new DOM ids `rb-who-group`, `rb-group`, `rb-trades`, `rb-trade-status`, `rb-pick-sheet`, `rb-pick-title`, `rb-pick-list`, `rb-pick-cancel`; client functions `refreshContacts`, `nameFor`, `openPicker`, `closePicker`, `giftEgg`, `proposeSwap`, `acceptTrade`, `declineTrade`, `refreshTrades`, `paintTrades`, `tradeRow`, `paintGroupChoice`, `composeVisibility`. Markup sinks stay EXACTLY the two engine sinks.

- [ ] **Step 1: Write the failing assertions**

In `tests/ramble-panel.test.js`, test "panel handler renders the world-first shell…" add at the end:

```js
  // Phase 3 surfaces: the group audience, the swaps card, the picker sheet.
  assert.match(sent, /data-visibility="group"/);
  assert.match(sent, /id="rb-group"/);
  assert.match(sent, /id="rb-trades"/);
  assert.match(sent, /id="rb-pick-sheet"/);
  assert.match(sent, /id="rb-pick-list"/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(sent), "no emoji in the panel markup — icons are inline SVG");
```

In test "GET /ramble/static/ramble.js serves the client script as JavaScript" add before the sink count:

```js
  // Phase 3 wiring: contacts, gift, swaps, the fourth named SSE frame, the
  // invite hand-off for strangers — and still no emoji, still textContent only.
  assert.ok(body.includes('"/api/ramble/contacts"'), "client must load contacts for the pickers");
  assert.ok(body.includes('"/gift"'));
  assert.ok(body.includes('"/api/ramble/trades"'));
  assert.ok(body.includes('"/accept"'));
  assert.ok(body.includes('"/decline"'));
  assert.ok(body.includes('addEventListener("ramble-trade"'), "client must subscribe to ramble-trade");
  assert.ok(body.includes('"/dashboard/contacts"'), "share-an-invite hands off to the Contacts panel");
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(body), "no emoji in the client script");
```

(the existing `sinks.length === 2` assertion stays and must still hold).

Append to `tests/ramble-stream.test.js`:

```js
test("the panel client subscribes to the ramble-trade frame by name", () => {
  const client = readFileSync(join(__repo, "bundles/ramble/panel/static/ramble.js"), "utf8");
  assert.ok(client.includes('addEventListener("ramble-trade"'));
});
```

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js; node scripts/run-suite.mjs tests/ramble-stream.test.js` — Expected: the new assertions FAIL.

- [ ] **Step 2: Markup (`bundles/ramble/panel/ramble.js`)**

(a) Header comment: "Three views" → "Four views (world | egg | pet | flock)"; add "Phase 3: the compose card gains a Group audience, the flock view a Swaps card with Gift / Swap / Accept / Decline, and a picker sheet (`#rb-pick-sheet`) for choosing a contact or an egg."

(c) Compose "Who" row — replace lines 143-150 with:

```html
            <div class="rb-row">
              <span class="rb-label">Who</span>
              <div class="rb-seg" id="rb-seg-who" role="group" aria-label="Who can see this">
                <button type="button" class="is-on" data-visibility="public" aria-pressed="true">Everyone</button>
                <button type="button" data-visibility="contacts" aria-pressed="false">Contacts</button>
                <button type="button" data-visibility="group" aria-pressed="false" id="rb-who-group" hidden>Group</button>
                <button type="button" data-visibility="private" aria-pressed="false">Just me</button>
              </div>
            </div>
            <div class="rb-row" id="rb-group-row" hidden>
              <label class="rb-label" for="rb-group">Group</label>
              <select id="rb-group" aria-label="Which group"></select>
            </div>
```

(d) Flock view — replace the "Egg shelf" card's hint text and add the Swaps card before the actions row:

```html
          <section class="rb-card">
            <p class="rb-eyebrow">Egg shelf</p>
            <p class="rb-muted rb-fine" id="rb-shelf-count">Nests appear on the map as eggs. Walk up to one to take it.</p>
            <div class="rb-steps" id="rb-shelf"></div>
            <p class="rb-muted rb-fine" id="rb-flock-status"></p>
          </section>

          <section class="rb-card">
            <p class="rb-eyebrow">Swaps</p>
            <p class="rb-muted rb-fine">Offer a shelf egg to a contact; they answer with one of theirs. Nobody knows what is inside until it hatches. Offers lapse after a week.</p>
            <div class="rb-steps" id="rb-trades"></div>
            <p class="rb-muted rb-fine" id="rb-trade-status"></p>
          </section>
```

(e) After the grid sheet `</div>` add the picker sheet:

```html
        <!-- ─────────────────────────────────── pick a contact or an egg, on demand -->
        <div class="rb-sheet" id="rb-pick-sheet" hidden>
          <div class="rb-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rb-pick-title">
            <div class="rb-sheet-head">
              <h3 class="rb-h" id="rb-pick-title">Pick one</h3>
              <button class="rb-icon-btn" id="rb-pick-cancel" type="button" aria-label="Close">${icon("close")}</button>
            </div>
            <div class="rb-steps" id="rb-pick-list"></div>
          </div>
        </div>
```

- [ ] **Step 3: Client (`bundles/ramble/panel/static/ramble.js`)**

Rules: string concatenation only (zero backticks), `textContent` for every string, `createElement` for every node, no emoji.

(a) Header comment "Sections, in order" gains `contacts, trades` after `flock`.

(b) After `function jsonFetch` add the contacts cache:

```js
  /* ------------------------------------------------------------- contacts */

  var contactsCache = { contacts: [], groups: [] };

  function refreshContacts() {
    return jsonFetch("/api/ramble/contacts").then(function (out) {
      if (out && Array.isArray(out.contacts)) contactsCache = out;
      paintGroupChoice();
    }).catch(function () { /* no contacts, no pickers */ });
  }

  function nameFor(crowId) {
    var list = contactsCache.contacts || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].crow_id === crowId) return list[i].display_name || crowId;
    }
    return crowId || "someone";
  }
```

(c) Marks — replace `audienceHint` and extend `popupFor`:

```js
  /** Non-public marks say who they are for; a public one needs no label. */
  function audienceHint(mark) {
    if (mark.visibility === "contacts") return "Contacts";
    if (typeof mark.visibility === "string" && mark.visibility.indexOf("group:") === 0) return "Group";
    if (mark.visibility === "private") return "Just me";
    return "";
  }

  function markLabel(mark) {
    if (mark.contact_name) return (mark.kind === "caw" ? "caw by " : "mark by ") + mark.contact_name;
    var who = (mark.author || "anon").slice(0, 8);
    return (mark.kind === "caw" ? "caw by " : "mark by ") + who;
  }

  /** A stranger's bird on your map: the way to trade with them is to become contacts first. */
  function inviteLine(mark) {
    if (mark.origin !== "remote" || mark.contact_name) return null;
    var p = document.createElement("p");
    p.className = "rb-pop-body rb-fine";
    p.textContent = "Not a contact yet. ";
    var a = document.createElement("a");
    a.href = "/dashboard/contacts";
    a.textContent = "Share an invite";
    a.setAttribute("data-turbo", "true");
    p.appendChild(a);
    p.appendChild(document.createTextNode(" to gift or swap eggs."));
    return p;
  }
```

(`markLabel` replaces the existing one at lines 172-175.) In `popupFor`, before each `return box;` add `var inv = inviteLine(mark); if (inv) box.appendChild(inv);` (both the locked and the open branch).

(d) Compose — replace `wireSeg("rb-seg-who", …)` and add the group choice:

```js
  var whoChoice = "public";
  wireSeg("rb-seg-who", "data-visibility", function (v) {
    whoChoice = v || "public";
    var row = $("rb-group-row");
    if (row) row.hidden = whoChoice !== "group";
  });
  wireSeg("rb-seg-reveal", "data-reveal", function (v) { reveal = v || "open"; });

  /** The visibility string the route wants: a group becomes "group:<uid>"; null = nothing chosen yet. */
  function composeVisibility() {
    if (whoChoice !== "group") return whoChoice;
    var sel = $("rb-group");
    return sel && sel.value ? "group:" + sel.value : null;
  }

  /** The Group segment only exists once there is a group to pick; losing the last group falls back to Everyone. */
  function paintGroupChoice() {
    var btn = $("rb-who-group");
    var sel = $("rb-group");
    var groups = contactsCache.groups || [];
    if (btn) btn.hidden = groups.length === 0;
    if (groups.length === 0 && whoChoice === "group") {
      var everyone = document.querySelector('#rb-seg-who button[data-visibility="public"]');
      if (everyone) everyone.click();
    }
    if (!sel) return;
    var keep = sel.value;
    sel.textContent = "";
    groups.forEach(function (g) {
      var opt = document.createElement("option");
      opt.value = g.group_uid;
      opt.textContent = g.name + " (" + g.member_count + ")";
      sel.appendChild(opt);
    });
    if (keep) sel.value = keep;
  }
```

Remove the old `var visibility = "public";`. In `compose()`, before `setText(statusEl, "Finding you…")`, add:

```js
    var visibility = kind === "mark" ? composeVisibility() : "public";
    if (!visibility) { setText(statusEl, "Pick a group first."); return; }
```

replace `body.visibility = visibility;` with `body.visibility = visibility;` (unchanged text, now referring to the local above) and update the status line:

```js
      setText(statusEl, kind === "caw"
        ? "Cawed. It fades in an hour."
        : (visibility === "private"
          ? "Kept for you alone. Nobody else will ever see it."
          : (visibility === "public"
            ? "Left here. You're invisible until you flip Visible on."
            : ((out && out.recipients) ? "Sealed for " + out.recipients + (out.recipients === 1 ? " contact." : " contacts.") + " It goes out once Visible is on for contacts." : "Nobody to send it to yet. Add a contact first."))));
```

(e) Picker sheet — after the grid section add:

```js
  /* --------------------------------------------------------------- picker */

  var pickSheet = $("rb-pick-sheet");
  var pickOnChoose = null;

  function closePicker() {
    if (pickSheet) pickSheet.hidden = true;
    pickOnChoose = null;
  }

  /** items: [{ label, sub, value }] -> onPick(value). Everything is text. */
  function openPicker(title, items, onPick) {
    var list = $("rb-pick-list");
    if (!pickSheet || !list) return;
    setText($("rb-pick-title"), title);
    list.textContent = "";
    if (items.length === 0) {
      var none = document.createElement("div");
      none.className = "rb-step";
      var t = document.createElement("div");
      t.className = "rb-step-txt rb-muted";
      t.textContent = "Nothing to pick from.";
      none.appendChild(t);
      list.appendChild(none);
    }
    items.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-step rb-pick";
      var txt = document.createElement("div");
      txt.className = "rb-step-txt";
      var strong = document.createElement("strong");
      strong.textContent = item.label;
      txt.appendChild(strong);
      if (item.sub) {
        var sub = document.createElement("span");
        sub.className = "rb-muted rb-fine";
        sub.textContent = item.sub;
        txt.appendChild(sub);
      }
      btn.appendChild(txt);
      btn.addEventListener("click", function () { var cb = pickOnChoose; closePicker(); if (cb) cb(item.value); });
      list.appendChild(btn);
    });
    pickOnChoose = onPick;
    pickSheet.hidden = false;
  }

  var pickCancel = $("rb-pick-cancel");
  if (pickCancel) pickCancel.addEventListener("click", closePicker);
  if (pickSheet) pickSheet.addEventListener("click", function (ev) { if (ev.target === pickSheet) closePicker(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && pickSheet && !pickSheet.hidden) closePicker();
  });

  function contactItems() {
    return (contactsCache.contacts || []).map(function (c) {
      return { label: c.display_name || c.crow_id, sub: c.crow_id, value: c.crow_id };
    });
  }
```

(f) Flock — replace `eggRow` with:

```js
  function eggSub(egg) {
    if (egg.status === "received") return "from " + nameFor(egg.from_crow_id);
    if (egg.found_cell) return "found in a nest, " + egg.found_week;
    if (egg.shelf_origin === "sync") return "came back from another of your Crows";
    return "your own egg";
  }

  function eggTitle(egg) {
    var what = egg.status === "incubating" ? "Incubating" : (egg.status === "received" ? "A gift" : "On the shelf");
    return what + " · " + Math.round(egg.percent || 0) + "%";
  }

  function shelfAction(egg, label, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-btn rb-btn-ghost rb-btn-sm";
    btn.textContent = label;
    btn.addEventListener("click", function () { onClick(btn); });
    return btn;
  }

  function flockStatus(msg) { setText($("rb-flock-status"), msg); }

  function incubate(egg, btn) {
    btn.disabled = true;
    jsonFetch("/api/ramble/eggs/" + encodeURIComponent(egg.egg_id) + "/incubate", { method: "POST", body: {} })
      .then(function (out) {
        flockStatus("Swapped. The other one keeps its warmth on the shelf.");
        handleHatched(out && out.hatched);
        refreshEgg();
        refreshPet();
        return refreshFlock();
      })
      .catch(function (err) { flockStatus(err.message); btn.disabled = false; });
  }

  function giftEgg(egg, btn) {
    openPicker("Give this egg to", contactItems(), function (crowId) {
      btn.disabled = true;
      jsonFetch("/api/ramble/eggs/" + encodeURIComponent(egg.egg_id) + "/gift", { method: "POST", body: { crow_id: crowId } })
        .then(function () { flockStatus("Sent to " + nameFor(crowId) + ". It leaves with the next relay tick."); return refreshFlock(); })
        .catch(function (err) { flockStatus(err.message); btn.disabled = false; });
    });
  }

  function proposeSwap(egg, btn) {
    openPicker("Offer this egg to", contactItems(), function (crowId) {
      btn.disabled = true;
      jsonFetch("/api/ramble/trades", { method: "POST", body: { egg_id: egg.egg_id, crow_id: crowId } })
        .then(function () { flockStatus("Offered to " + nameFor(crowId) + ". They pick what to give back."); refreshTrades(); return refreshFlock(); })
        .catch(function (err) { flockStatus(err.message); btn.disabled = false; });
    });
  }

  function eggRow(egg) {
    var row = document.createElement("div");
    row.className = "rb-step" + (egg.status === "incubating" ? " is-incubating" : "");
    var art = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    art.setAttribute("class", "rb-shelf-egg");
    art.setAttribute("viewBox", "0 0 120 152");
    drawEggArt(art, egg.egg_id);
    row.appendChild(art);
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var title = document.createElement("strong");
    title.textContent = eggTitle(egg);
    var sub = document.createElement("span");
    sub.className = "rb-muted rb-fine";
    sub.textContent = eggSub(egg);
    txt.appendChild(title);
    txt.appendChild(sub);
    row.appendChild(txt);
    if (egg.status === "incubating") return row;
    if (egg.locked) {
      var tag = document.createElement("span");
      tag.className = "rb-tag rb-tag-muted";
      tag.textContent = "In a swap";
      row.appendChild(tag);
      return row;
    }
    var acts = document.createElement("div");
    acts.className = "rb-acts";
    acts.appendChild(shelfAction(egg, "Incubate", function (b) { incubate(egg, b); }));
    acts.appendChild(shelfAction(egg, "Gift", function (b) { giftEgg(egg, b); }));
    acts.appendChild(shelfAction(egg, "Swap", function (b) { proposeSwap(egg, b); }));
    row.appendChild(acts);
    return row;
  }
```

(g) Trades — after `refreshFlock` add:

```js
  /* --------------------------------------------------------------- trades */

  var lastFlock = null;

  function giftableEggs() {
    var eggs = (lastFlock && lastFlock.eggs) || [];
    return eggs.filter(function (e) { return (e.status === "shelf" || e.status === "received") && !e.locked; })
      .map(function (e) { return { label: eggTitle(e), sub: eggSub(e), value: e.egg_id }; });
  }

  function tradeLine(t) {
    var who = t.counterpart_name || t.counterpart;
    var offer = t.offer ? (t.offer.warmth + "% warm" + (t.offer.found_week ? ", found " + t.offer.found_week : "")) : null;
    if (t.state === "proposed" && t.role === "acceptor") return who + " offers an egg" + (offer ? " (" + offer + ")" : "") + ". Pick one of yours to swap.";
    if (t.state === "proposed") return "Waiting for " + who + " to answer.";
    if (t.state === "accepted") return "You answered. Waiting for " + who + " to finish.";
    if (t.state === "completed") return "Swapped with " + who + ".";
    if (t.state === "declined") return "Declined with " + who + ".";
    if (t.state === "expired") return "The offer with " + who + " lapsed.";
    return who;
  }

  function acceptTrade(t, btn) {
    openPicker("Give back which egg?", giftableEggs(), function (eggId) {
      btn.disabled = true;
      jsonFetch("/api/ramble/trades/" + encodeURIComponent(t.trade_id) + "/accept", { method: "POST", body: { egg_id: eggId } })
        .then(function () { setText($("rb-trade-status"), "Answered. The swap finishes when they confirm."); refreshFlock(); return refreshTrades(); })
        .catch(function (err) { setText($("rb-trade-status"), err.message); btn.disabled = false; });
    });
  }

  function declineTrade(t, btn) {
    btn.disabled = true;
    jsonFetch("/api/ramble/trades/" + encodeURIComponent(t.trade_id) + "/decline", { method: "POST", body: {} })
      .then(function () { setText($("rb-trade-status"), t.role === "proposer" ? "Offer withdrawn." : "Declined."); refreshFlock(); return refreshTrades(); })
      .catch(function (err) { setText($("rb-trade-status"), err.message); btn.disabled = false; });
  }

  function tradeRow(t) {
    var row = document.createElement("div");
    row.className = "rb-step" + (t.open ? "" : " rb-muted");
    var badge = document.createElement("span");
    badge.className = "rb-step-n";
    badge.textContent = t.open ? "?" : "·";
    row.appendChild(badge);
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var strong = document.createElement("strong");
    strong.textContent = tradeLine(t);
    var sub = document.createElement("span");
    sub.className = "rb-muted rb-fine";
    sub.textContent = ago(Number(t.updated_at));
    txt.appendChild(strong);
    txt.appendChild(sub);
    row.appendChild(txt);
    if (t.open && t.state === "proposed") {
      var acts = document.createElement("div");
      acts.className = "rb-acts";
      if (t.role === "acceptor") acts.appendChild(shelfAction(t, "Accept", function (b) { acceptTrade(t, b); }));
      acts.appendChild(shelfAction(t, t.role === "proposer" ? "Withdraw" : "Decline", function (b) { declineTrade(t, b); }));
      row.appendChild(acts);
    }
    return row;
  }

  function paintTrades(out) {
    var list = $("rb-trades");
    if (!list) return;
    list.textContent = "";
    var trades = (out && out.trades) || [];
    if (trades.length === 0) {
      var empty = document.createElement("div");
      empty.className = "rb-step";
      var t = document.createElement("div");
      t.className = "rb-step-txt rb-muted";
      t.textContent = "No swaps yet. Use Swap on a shelf egg to offer one.";
      empty.appendChild(t);
      list.appendChild(empty);
      return;
    }
    trades.forEach(function (t) { list.appendChild(tradeRow(t)); });
  }

  function refreshTrades() {
    return jsonFetch("/api/ramble/trades").then(paintTrades).catch(function () { /* cosmetic */ });
  }
```

In `paintFlock` add `lastFlock = state;` as the first statement after the null guard, and change its shelf line to `setText($("rb-shelf-count"), state.shelf_count + " of " + state.shelf_cap + " shelf spots used. Nests appear on the map as eggs; walk up to one to take it. Eggs you are given land here too.");`. In `showView` change the flock line to `if (name === "flock") { refreshContacts().then(refreshFlock); refreshTrades(); }`.

(h) Stream: add `stream.addEventListener("ramble-trade", function () { refreshFlock(); refreshTrades(); });`.

(i) Startup: add `refreshContacts();` after `jsonFetch("/api/ramble/grid")…`.

- [ ] **Step 4: CSS (`bundles/ramble/panel/static/ramble.css`)**

After `#ramble .rb-step.is-incubating { … }` add:

```css
/* Phase 3: row actions, muted tags, pickable rows. */
#ramble .rb-acts { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
#ramble .rb-step .rb-acts .rb-btn { margin-left: 0; }
#ramble .rb-btn.rb-btn-sm { padding: 6px 10px; font-size: 13px; }
#ramble .rb-tag.rb-tag-muted { margin-left: auto; background: var(--rb-surface); color: var(--rb-text); }
#ramble button.rb-step { width: 100%; cursor: pointer; font: inherit; color: inherit; }
#ramble button.rb-step:active { transform: translate(2px, 2px); box-shadow: 0 0 0 var(--rb-shadow-col); }
#ramble button.rb-step:focus-visible { outline: 3px solid var(--rb-accent-2); outline-offset: 3px; }
#ramble .rb-pop-body a { color: var(--rb-accent-2); font-weight: 800; }
```

- [ ] **Step 5: Run the tests**

Run:

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js && node scripts/run-suite.mjs tests/ramble-stream.test.js \
  && node -e "new Function(require('fs').readFileSync('bundles/ramble/panel/static/ramble.js','utf8'))" \
  && ! grep -q '\`' bundles/ramble/panel/static/ramble.js && echo NO-BACKTICKS
```

Expected: tests PASS; the client parses as a script; `NO-BACKTICKS` is printed (the `!`-negated grep exits 0 only when no backtick exists).

- [ ] **Step 6: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js tests/ramble-stream.test.js -m "ramble panel: gift, swap, accept/decline, contact picker, group audience, share-an-invite"
git show --stat HEAD
```

---

## Task 9: Docs en/es, version bump, registry, integration gate, PR, deploy

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json` (generated)
- Test: full suite

- [ ] **Step 1: English guide (`docs/guide/ramble.md`)**

(a) In the intro list replace the "Public wire only" bullet with:

```
- **Contacts and groups travel as DMs.** Marks with visibility `contacts` or `group:<uid>` are sealed for each recipient (NIP-44, one DM per contact) and never touch a public relay in the clear — see below. Gifts and swaps use the same door.
```

(b) In the `publish_state` table change the `pending` row to: "Waiting for a drain tick, or the grid gate is closed, or (contacts/group) at least one recipient's DM has not been accepted by a relay yet." and the `published` row to: "At least one relay accepted the event — or, for a contacts/group mark, every recipient's DM was accepted (a mark with nobody to send to is published at once)." (Spanish: `published` → "Al menos un relay aceptó el evento — o, para una marca de contactos/grupo, el DM de cada destinatario fue aceptado (una marca sin nadie a quien enviarla se marca publicada al instante).")

(c) In "Expiry" keep "`contacts` / `groups` marks: no expiry".

(d) After the "## Your flock" section insert two new sections (in this order — the Spanish guide mirrors them):

```markdown
## Contacts and groups

A mark for **Contacts** goes to every full contact (unblocked, not a bot, not a pending request) as one NIP-44 DM each, signed by this instance's key — the same door every Crow DM uses. A mark for a **Group** goes to the members of that contact group (`group:<group_uid>`, the groups from the Contacts panel; the Ramble panel only shows the Group audience when you have one). The DM's only tag is the recipient; the mark's text, place and bird are ciphertext. Nothing about a contacts or group mark reaches a relay in the clear.

Delivery is queued, not immediate: authoring writes one `ramble_outbox` row per recipient, and the gateway transport sends them on its drain tick (every 15 s, or at once when you author from the panel). A contacts mark is gated by the privacy grid like a public one — the `contacts` (or `groups`) × `geo` cell and the master switch must be on, or it waits in the queue. The row flips to `published` once every recipient's DM has been accepted by a relay (or dropped because that contact is gone). A recipient stores it as a persistent contacts mark, named after the contact, and it counts as meeting their bird for warmth.

Contacts delivery is contact-only in both directions: a DM of this kind from someone who is not a contact is discarded and never becomes a message request. A stranger's pin on your map offers **Share an invite**, which opens the Contacts panel — become contacts first, then trade.

The queue is per instance: only the Crow you authored on sends a mark, a gift or an offer. All your Crows share one Nostr identity, so each of them receives what a contact sends and applies it; the rows then agree through instance sync. A swap step a contact answers is completed on each of your Crows, and each sends the confirmation — the contact simply ignores the copies.

## Gifts and swaps

Any unhatched egg on your shelf — claimed from a nest or received from someone — can be **gifted** to a contact (`POST /api/ramble/eggs/:id/gift { crow_id }`, tool `ramble_gift_egg`). The egg leaves your shelf as `gifted` and arrives on theirs as `received`, still unhatched: the wire carries only `{ egg_id, warmth, found_cell, found_week }`, never a species or seed — whoever hatches it rolls the bird. A received egg shows "A gift · from <name>" and can be incubated, gifted on, or offered in a swap. Received eggs do not use one of the five nest-claim spots. A gift delivered twice is stored once; an egg you gave away that comes back to you simply returns to your shelf.

A **swap** is an offer of one of your eggs for one of theirs (`POST /api/ramble/trades { egg_id, crow_id }`, tool `ramble_propose_swap`). The contact sees the offer on their Flock screen and answers with an egg of their choice (**Accept**, `POST /api/ramble/trades/:id/accept { egg_id }`) or **Decline**; you can **Withdraw** an unanswered offer. Eggs change hands only when the swap completes — on each side, atomically — and an egg named by an open offer is locked (it cannot be incubated, gifted or offered again until the offer closes). Offers lapse after seven days on each side; a lapsed offer releases the egg. If your answer arrives after the offer lapsed on their side, they reply with a decline and your egg is released. Accept and decline are panel actions (there is no MCP tool for them).

Everything here is contact-only and encrypted, and bounded: a contact can have at most 20 open offers with you and give you at most 20 eggs a day; anything past that is ignored. An offer, an answer or a completion that names an egg you still hold is ignored. There is no market, no ledger of value and no scarcity: if the two sides disagree at the very moment an offer lapses, the worst case is a duplicated egg, never a lost one. Meeting a contact through a mark counts toward warmth the same way meeting a stranger does (per key, per week).
```

(e) "## MCP tools" table — add rows:

```
| `ramble_gift_egg` | Gift an unhatched shelf egg to a contact (queued as one encrypted DM). |
| `ramble_propose_swap` | Offer a shelf egg to a contact for one of theirs; they choose what to give back. |
```

and replace "Groups (`ramble_group_create` / `ramble_group_join`) are not in phase 1." with "Group audiences are the contact groups from the Contacts panel (`visibility: "group:<group_uid>"`); there are no ramble-specific group tools. `ramble_leave_mark` reports `recipients` for a contacts or group mark."

(f) "## Operating notes" — append:

```
Contacts delivery, gifts and swaps need every gateway on the new code: a gateway running phase 2 stores a ramble envelope as a chat message. Restart all of them before anyone sends. The transport logs `dropping <kind> delivery to <crow_id>: not a deliverable contact` when a queued recipient was deleted or blocked, and `gave up after 20 attempts` when no relay accepts a DM.
```

- [ ] **Step 2: Spanish guide (`docs/es/guide/ramble.md`)**

Mirror (a)–(f) with the SAME heading levels and order — `## Contactos y grupos` and `## Regalos e intercambios` inserted after `## Tu bandada`, before `## Marcas solo para mí`:

```markdown
## Contactos y grupos

Una marca para **Contactos** llega a cada contacto completo (no bloqueado, no bot, no una solicitud pendiente) como un DM NIP-44 individual, firmado con la clave de esta instancia — la misma puerta que usa cualquier DM de Crow. Una marca para un **Grupo** llega a los miembros de ese grupo de contactos (`group:<group_uid>`, los grupos del panel Contactos; el panel de Ramble solo muestra la audiencia Grupo cuando tienes alguno). La única etiqueta del DM es el destinatario; el texto, el lugar y el pájaro de la marca van cifrados. Nada de una marca para contactos o grupo llega a un relay en claro.

La entrega se encola, no es inmediata: al escribir se crea una fila de `ramble_outbox` por destinatario y el transporte del gateway las envía en su tick de drenaje (cada 15 s, o al instante si escribes desde el panel). Una marca para contactos pasa por la rejilla de privacidad igual que una pública — la celda `contacts` (o `groups`) × `geo` y el interruptor maestro deben estar activados, o espera en la cola. La fila pasa a `published` cuando el DM de cada destinatario ha sido aceptado por un relay (o descartado porque ese contacto ya no existe). Quien la recibe la guarda como una marca de contactos persistente, con el nombre del contacto, y cuenta como haber conocido a su pájaro para el calor.

La entrega a contactos es solo entre contactos en ambas direcciones: un DM de este tipo de alguien que no es contacto se descarta y nunca se convierte en una solicitud de mensaje. El pin de un desconocido en tu mapa ofrece **Compartir una invitación**, que abre el panel Contactos — primero haceos contactos, luego intercambiad.

La cola es por instancia: solo el Crow desde el que escribiste envía una marca, un regalo o una oferta. Todos tus Crows comparten una misma identidad Nostr, así que cada uno recibe lo que un contacto envía y lo aplica; luego las filas coinciden mediante instance sync. Un paso de intercambio que un contacto responde se completa en cada uno de tus Crows, y cada uno envía la confirmación — el contacto simplemente ignora las copias.

## Regalos e intercambios

Cualquier huevo sin eclosionar de tu estante — recogido de un nido o recibido de alguien — se puede **regalar** a un contacto (`POST /api/ramble/eggs/:id/gift { crow_id }`, herramienta `ramble_gift_egg`). El huevo sale de tu estante como `gifted` y llega al suyo como `received`, aún sin eclosionar: el cable solo lleva `{ egg_id, warmth, found_cell, found_week }`, nunca una especie ni una semilla — quien lo haga eclosionar tira el pájaro. Un huevo recibido se muestra como "Un regalo · de <nombre>" y se puede incubar, regalar de nuevo u ofrecer en un intercambio. Los huevos recibidos no ocupan ninguna de las cinco plazas de recogida. Un regalo entregado dos veces se guarda una sola vez; un huevo que diste y te devuelven simplemente vuelve a tu estante.

Un **intercambio** es una oferta de uno de tus huevos por uno de los suyos (`POST /api/ramble/trades { egg_id, crow_id }`, herramienta `ramble_propose_swap`). El contacto ve la oferta en su pantalla Bandada y responde con un huevo de su elección (**Aceptar**, `POST /api/ramble/trades/:id/accept { egg_id }`) o **Rechazar**; tú puedes **Retirar** una oferta sin respuesta. Los huevos cambian de manos solo cuando el intercambio se completa — en cada lado, de forma atómica — y un huevo nombrado por una oferta abierta queda bloqueado (no se puede incubar, regalar ni ofrecer de nuevo hasta que la oferta se cierre). Las ofertas caducan a los siete días en cada lado; una oferta caducada libera el huevo. Si tu respuesta llega cuando la oferta ya caducó en su lado, responden con un rechazo y tu huevo queda libre. Aceptar y rechazar son acciones del panel (no hay herramienta MCP para ellas).

Todo esto es solo entre contactos, va cifrado y tiene límites: un contacto puede tener como máximo 20 ofertas abiertas contigo y darte como máximo 20 huevos al día; lo que pase de ahí se ignora. Una oferta, una respuesta o una finalización que nombre un huevo que todavía tienes se ignora. No hay mercado, ni registro de valor, ni escasez: si los dos lados discrepan justo en el momento en que una oferta caduca, el peor caso es un huevo duplicado, nunca uno perdido. Conocer a un contacto a través de una marca cuenta para el calor igual que conocer a un desconocido (por clave, por semana).
```

Tool rows:

```
| `ramble_gift_egg` | Regalar un huevo sin eclosionar del estante a un contacto (encolado como un DM cifrado). |
| `ramble_propose_swap` | Ofrecer un huevo del estante a un contacto a cambio de uno de los suyos; ellos eligen qué devolver. |
```

Replace the groups sentence with: "Las audiencias de grupo son los grupos de contactos del panel Contactos (`visibility: "group:<group_uid>"`); no hay herramientas de grupo propias de ramble. `ramble_leave_mark` informa `recipients` para una marca de contactos o grupo." Intro bullet: "**Contactos y grupos viajan como DMs.** Las marcas con visibilidad `contacts` o `group:<uid>` se sellan para cada destinatario (NIP-44, un DM por contacto) y nunca tocan un relay público en claro — ver más abajo. Regalos e intercambios usan la misma puerta." `pending` row: "Esperando un tick de drenaje, o la puerta de la rejilla está cerrada, o (contactos/grupo) el DM de algún destinatario aún no ha sido aceptado por un relay." Operating note: "La entrega a contactos, los regalos y los intercambios necesitan todos los gateways en el código nuevo: un gateway con la fase 2 guarda un sobre de ramble como un mensaje de chat. Reinícialos todos antes de que nadie envíe. El transporte registra `dropping <kind> delivery to <crow_id>: not a deliverable contact` cuando un destinatario encolado fue borrado o bloqueado, y `gave up after 20 attempts` cuando ningún relay acepta un DM."

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js` — Expected: PASS (heading parity).

- [ ] **Step 2b: Spec amendments (as phase 2 did for §2.4/§7)**

In `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`:
- §4 "Gifts / swaps (phase 3)": append "The trade envelope may carry `egg` (the sender's offered egg summary) so accept and complete are one DM each. Eggs change hands only at completion, in one batch per side. Decline is legal from either side only while `proposed`; the receiving side honours a `declined` from `proposed` or `accepted`."
- §5 `ramble_trades`: amend the column list to `(trade_id TEXT PK, counterpart TEXT, role TEXT proposer|acceptor, my_egg_id, their_egg_id, offer_json TEXT, state TEXT proposed|accepted|completed|expired|declined, created_at, updated_at, expires_at, lamport_ts)` and add "`ramble_outbox (id, to_crow_id, kind mark|egg|trade, ref_id, payload_json, attempts, created_at)` — the local contacts-delivery queue (never synced)."
- §2.5: append "Received eggs (`status='received'`, `shelf_origin='user'`, `from_crow_id`) sit on the shelf as their own class and do not count toward the nest-claim cap."

Run: `node scripts/run-suite.mjs tests/ramble-panel.test.js` (parity is on the guides, not the spec — this is a sanity run only).

- [ ] **Step 3: Version bump + registry**

- `bundles/ramble/manifest.json`: `"version": "0.4.0"`, description → `"Proximity broadcasts (caws) + a shared/private map of discoverable marks, with a bird companion: eggs, nests, an egg shelf, a flock, and gifts and swaps with contacts."`
- `bundles/ramble/package.json`: `"version": "0.4.0"`, description → `"Ramble MCP server — proximity marks, caws, privacy grid, egg and bird companion, gifts and swaps"`.
- Run `npm run build-registry` and confirm `registry/add-ons.json` shows ramble `0.4.0`; run `node scripts/build-registry.mjs --check` (exit 0).

- [ ] **Step 4: Integration gate**

Run, in the foreground, the whole suite: `node scripts/run-suite.mjs` (use the maximum tool timeout; if it exceeds it, run every `tests/ramble-*.test.js`, `tests/ramble-nostr-envelope.test.js`, `tests/instance-sync*.test.js`, `tests/sync-*.test.js`, `tests/block-*.test.js`, `tests/contact-*.test.js`, `tests/bundle-server-deps.test.js`, `tests/check-port-allocation*` individually and let CI run the rest). Expected: 0 failures. Also `node scripts/check-port-allocation.js` (no new ports; exit 0).

- [ ] **Step 5: Commit + PR**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md docs/superpowers/specs/2026-09-07-ramble-flock-design.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json -m "ramble 0.4.0: contacts delivery, gifts and swaps docs; spec amendments; registry"
git show --stat HEAD
git pull --rebase origin main
git push -u origin feat/ramble-flock-phase3
```

Open the PR against `main` with the GitHub MCP tool (`mcp__github__create_pull_request`), body = summary of the nine tasks, the rulings in Global Constraints (received eggs off the cap, trade envelope carries `egg`, `role`/`offer_json`/`expires_at` columns, grid gates marks not gifts, decline only while proposed, expired-acceptor healing), and the deploy discipline. Poll `https://api.github.com/repos/kh0pper/crow/commits/<head sha>/check-runs` until `suite`, `static-checks`, `audit` are all `completed`/`success`; then merge with `mcp__github__merge_pull_request` (squash or merge per repo habit — the previous phases used merge commits).

- [ ] **Step 6: Deploy (all three gateways, back-to-back) + verify**

Read `/home/kh0pp/CROW-SCHEDULE.md` first (house rule; restarts start no models). Then:

```bash
# crow primary + r4 (auto-update may already have pulled main; restart regardless)
cd ~/crow && git pull --ff-only origin main
echo '8r00kly^' | sudo -S systemctl restart crow-gateway.service crow-r4-gateway.service
# grackle
grackle "cd ~/crow && git pull --ff-only origin main && echo '8r00kly^' | sudo -S systemctl restart crow-gateway"
grackle "journalctl -u crow-gateway --since '2 min ago' --no-pager | grep -E 'refreshed ramble|ramble\] transport|ramble routes mounted|addon ramble'"
```

Expected on grackle: `[bundles] refreshed ramble 0.3.0 -> 0.4.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered`. Check the same three lines in crow's `journalctl -u crow-gateway` and `-u crow-r4-gateway`. Confirm `auto_update_last_result` in `dashboard_settings` is not "Skipped". Then a live acceptance: from crow's panel, gift a shelf egg to a contact hosted on grackle (or r4) and watch the recipient's Flock screen show "A gift · from <name>"; leave a Contacts mark and see it arrive named on the other side.

- [ ] **Step 7: Handoff**

Write `docs/superpowers/handoffs/2026-09-07-ramble-flock-phase3-shipped-pr<N>.md` (state, rulings, deploy verification, deferred minors, "next = phase 4 AR, spec §6; models arc plan 2 stays queued") on a docs branch + PR, and update the memory index entry.

---

## Self-review notes (coverage against the spec, phase 3 scope)

- §4 contacts delivery: Task 2 (codecs, audience, outbox), Task 5 (drain via `sendControl`, `published` flip), Task 4 (receive via `subscribeToContact` → bus; catch-all drops), Task 3 (`receiveEnvelope` → `insertRemoteMark`, persistent, visibility contacts). Group fan-out per member of the core group; phase-1 shared key dropped (table left, unused — `ramble-tables.test.js` still asserts it exists). "Nothing in the clear": `ramble-nostr-envelope.test.js` test 1.
- §4 gifts/swaps wire: `ramble.egg` / `ramble.trade` payloads (Task 2), never species/seed (asserted in delivery + tools + panel tests). Deviation: `egg` inside the trade envelope.
- §5 `ramble_trades` replicated: Task 1 (all six sync touch points + both doors tested). `ramble_outbox` local (asserted).
- §2.5 / received eggs: Task 3 (`received`/`user`, `from_crow_id`, incubate admits, cap untouched), Task 8 (shown as "A gift · from <name>").
- §7 routes/tools/`ramble:trade`: Task 6, Task 7; SSE frame + client listener (Task 6/8).
- §9 contact-only, encrypted, no market: Tasks 2/4/5 + docs.
- §10 tests: encrypt/decrypt round-trip (Task 4), trade state machine incl. expiry (Task 3), outbox + apply doors (Task 1), routes over loopback (Task 6), parity (Task 9).
- §11 "share invite on met-crow": Task 8 (`inviteLine` → `/dashboard/contacts`), Task 6 (`contact_name` annotation decides who is a stranger).
- Round-1 fixes: `pendingDeliveries` ordering (Task 2) ↔ transport C1 test (Task 5); `stillOurs`/caps (Task 3) ↔ trades tests; `seenEnvelopes` (Task 5) ↔ C5 test; `composeVisibility` null (Task 8) ↔ `compose()` early return.
- Placeholder scan: no TBD/TODO; every step carries code. Type consistency: `receiveEnvelope` result shapes used by the transport match Task 3 (`kind`, `inserted`, `geohash`, `mark_id`, `markKind`, `egg_id`, `changed`, `state`, `trade_id`, `deliveries`); `flockState` egg fields (`from_crow_id`, `locked`) match the client (`eggSub`, `eggRow`, `giftableEggs`); route reasons (`not-found`→404, others→409) match `tradeStatus`.

## Review

### Round 1 (2026-09-07, adversarial staff-engineer subagent, code-traced; every plan line cite verified against the worktree) — REVISE → fixed inline
Five criticals, all folded in above: **C1** gated contacts-mark rows at the head of `ramble_outbox` (ORDER BY id LIMIT 50) starved every gift/trade row behind them → `pendingDeliveries` orders `egg`/`trade` before `mark`, the grid gate is cached per visibility per tick, and a transport test drains one gift past sixty gated mark rows. **C2** a lapsed/declined offer replied `declined` on EVERY re-sent `accepted` (one DM per re-delivery) → the proposer's row settles as `declined` (from `proposed` or `expired`) on the first non-honourable `accepted` and every later copy hits the declined early-return; test loops three re-deliveries and asserts zero queued. **C3** a counterpart who remembered the id of an egg they once gave us could name it in a proposal/acceptance/completion and make our completion batch mark OUR answer egg `gifted` while the revive no-op'd (a lost egg) → `stillOurs()` guard on all three branches (proposal ignored, acceptance answered with `declined`, completion ignored) plus `my_egg_id === their_egg_id` rejected; new C3 test. **C4** the client silently widened a Group choice with no selected group to all contacts → `composeVisibility()` returns null and `compose()` refuses ("Pick a group first."); losing the last group clicks Everyone. **C5** `subscribeToContact` registers one `onevent` per relay with no dedup, so one DM emitted `ramble:envelope` up to four times and the copies interleaved through `receiveTrade` → bounded event-id dedup (1000) at the top of the transport's `onEnvelope`; test applies three copies concurrently.
Suggestions applied: **S1** `proposeSwap`/`acceptSwap` statements also require the egg to still be giftable at write time; **S2** inbound ceilings (20 open proposals per counterpart, 20 received gifts per contact per local day) with a test; **S3** a drain requested mid-drain re-runs in `finally` (`redrain`); **S4** a contacts mark with nobody to send to settles `published` inside `enqueueMark` (test + docs); **S5** the unused `gift`/`swap` icons dropped; **S6** the nostr tests call `mgr.destroy()`; **S7** Task 9 gains a spec-amendment step (§2.5/§4/§5); **S8** the trade badge uses the existing "?"/"·" glyphs, not "✓"; **S9** replica note in the transport header.
Rulings (Q1–Q4) recorded in Global Constraints: Group audience stays; decline asymmetry is the protocol; duplicate-egg outcomes at lapse accepted (lost eggs never); persona-keyed double credit accepted.

### Round 2 (2026-09-07, fresh adversarial subagent, code-traced; all 14 round-1 fixes re-verified as HOLDING, hand-simulating every trades/delivery/transport/panel test) — REVISE → fixed inline
**N1** the Task 6 seed gave `crow:pal` and `crow:buddy` the same key, so `contactsByPubkey` named the mark "Buddy" and the annotation test could never pass → distinct keys per seeded contact; the helper now reads `ORDER BY id` and first-wins so a shared key names the older row deterministically.
Suggestions applied: **S1** the open-proposal ceiling counts inbound rows only (`role='acceptor'`), so my own offers to a contact no longer block theirs; **S2** the spec file and the plan itself are on commit lines (Task 9 and Task 1); **S3** `mgr?.destroy?.()`; **S4** a redrain test (a reply queued mid-drain rides the re-run, no manual second drain); **S5** the "eggs you are given land here too" hint moved into `paintFlock`'s string (the markup text was overwritten on every paint); **S6** "expired never travels" asserted; **S7** the backtick check uses `! grep -q`; **S8** the cap's revive behaviour documented; **S9** the meet_crow credit is polled.
Rulings: **Q1** verified against `nostr.js:155` — all of a user's instances share one Nostr identity, so every instance receives and applies every contact envelope and a swap reply is queued by each (idempotent copies); Global Constraints, the transport header and both guides now say so. **Q2** `contactsByPubkey` deliberately includes bots (naming a bot's mark is harmless); noted in the helper.

### Scoped check (2026-09-07, narrow re-review of the round-2 edits; every one re-simulated, incl. the redrain test against the plan's transport code and the S2 cap against the `role='acceptor'` query) — REVISE → fixed inline
All round-2 edits hold. One mechanical defect: positional `git commit <path>` refuses UNTRACKED files (verified with `git commit --dry-run` in the worktree), so Tasks 1–4, which create files, now `git add` the new paths first (house style otherwise unchanged). Cosmetic: the `ramble_outbox` DDL comment now says "authored … or answered a swap step" to agree with the Q1 ruling; Task 8's backtick check moved into a fenced block so the literal backtick does not break the markdown. Global consistency sweep clean (every exported name, import, reason string, `receiveTrade` return shape and status mapping verified).

**Status: plan complete, three review gates passed. Awaiting Kevin's approval before execution (superpowers:subagent-driven-development in `/home/kh0pp/crow-wt-flock3`).**
