# Ramble World Name + "Your mark" (Plan A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Ramble "World name" a user chooses for strangers, carried on public marks and caws only at the pseudonym or real Name level, shown as "name · key4"; contacts keep their saved name; the user's own marks read "your mark" / "your caw" on the map, in the Nearby list, in AR and in the MCP world query.

**Architecture:** One new replicated Ramble setting (`world.name`, sanitized by a pure `sanitizeWorldName` in `grid.js`), one new column (`ramble_marks.author_name`, guarded `ensureColumn`, added to the instance-sync wire columns), one new wire field (`content.name` on kinds 30397/20397, written by `markToEvent` only when the transport hands it a name for that row — the transport decides per row from the row's own `author_level`; read by `eventToMark` through the same sanitizer), one label rule implemented twice deliberately — a pure server `labelFor` (new `labels.js`, used by the MCP world query) and the client's `markLabel` (plain script) — plus a shared `contactsByPubkey` reader moved into `delivery.js` so the panel routes and the MCP server name contacts the same way. The Visible sheet gets the field. No new table, no new route, no new tool.

**Tech Stack:** Node 22 ESM, libsql client, `nostr-tools` events, Express router, plain-script panel client (no backticks), Node test runner via `scripts/run-suite.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-ramble-names-and-profile-design.md` §0 D1–D3, §1, §2, §3, §6 (Plan A rows), §7, §8 (Plan A). Phase-5 rulings still bind (`docs/superpowers/plans/2026-09-07-ramble-phase5-first-walk.md` Global Constraints + Review).

## Global Constraints

- **DB access** through the bundle's `createDbClient()` / `appImport("servers/db.js")` only; async libsql-shaped client. Test files may use `@libsql/client` in-memory; bundle server files never import it.
- **No `SCHEMA_GENERATION` bump; no new table.** The one new column is `ramble_marks.author_name TEXT` via `ensureColumn` in `bundles/ramble/server/init-tables.js`. `ramble_marks` is already replicated: the column joins `RAMBLE_MARK_WIRE_COLUMNS` in `servers/sharing/instance-sync.js` (and therefore `RAMBLE_MARK_UPDATE_COLUMNS`); the apply door is tested with the column. The setting `world.name` is a plain `ramble_settings` row (not `local.`-prefixed → replicates; `EXCLUDED_COLUMNS.ramble_settings` unchanged).
- **World name rules (spec §2.1, exact):** `sanitizeWorldName(value)`: non-string → `null`; strip C0/DEL/C1 controls and bidi overrides/isolates; collapse whitespace, trim; reject `/^(crow|req):/i` → `null`; cap at `WORLD_NAME_MAX = 24` code points (truncate); reject a value that is only hex of 4+ chars `/^[0-9a-f]{4,}$/i` → `null`; empty → `null`. Applied on save AND on every read from the wire, and again at the store (`insertRemoteMark`) as defense in depth; instance sync carries the column trusted (same-owner instances; own rows never carry a name, so a synced `author_name` is never displayed).
- **Wire (spec §2.2, exact):** `markToEvent(row, { precision, crowId, bird, name })` adds `content.name` only when `sanitizeWorldName(name)` is non-null; the TRANSPORT passes `name` only when `(row.author_level ?? level) ∈ { pseudonym, real }` (`level` = the instance's `public_identity_level`), so a `rotating` row never carries one (D1; note: at `rotating` only CAWS rotate their key — marks already use the stable world key — the decision stands: the level decides). `eventToMark` sets `author_name: sanitizeWorldName(content.name)`. Contacts/group marks (`markPayload` / `payloadToMark`) never carry or read a name.
- **Labels (spec §3.1, exact, in this order):** own (`origin` ∈ `local`, `sync`) → `your mark` / `your caw`; contact (`contact_name`) → `mark by <contact name>`; stranger with `author_name` → `mark by <author_name> · <key4>`; else → `mark by <key8>`. `key4`/`key8` = the first 4/8 characters of `author`, `anon` when missing. AR caw title: `Your caw` / `A caw from <contact name>` / `A caw from <author_name> · <key4>` / `A caw`.
- **Teasers:** `reveal.js`'s allowlist gains `author_name` (a locked stranger's mark still shows who left it, as `author` already does).
- **Panel rules:** `router.use("/api/ramble", dashboardAuth)` path-scoped; `static/ramble.js` ZERO backticks, `textContent` only, EXACTLY two engine markup sinks (unchanged), no emoji; every input bounded (`worldName` ≤ 128 chars on the wire into the route, then sanitized to ≤ 24). Direction C tokens only.
- **Tests:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`; `node scripts/run-suite.mjs tests/<file>.test.js` foreground only; never bare `node --test`; never boot a gateway from the worktree without a scratch `CROW_DATA_DIR`. Docs en/es heading parity: no new headings (paragraph edits only).
- **Commits:** subject-only, positional paths, `git add` new files first, no attribution trailers. Worktree `/home/kh0pp/crow-wt-names` (branch `feat/ramble-world-name`, `node_modules` symlinked from `~/crow`); never `git checkout` in `~/crow`. PR + green `suite`/`static-checks`/`audit` on the head sha (public check-runs API via python; GitHub MCP tools for PR/merge). Read `/home/kh0pp/CROW-SCHEDULE.md` before the deploy; restart all three gateways back-to-back after merge; grackle's journal must show `[bundles] refreshed ramble 0.6.0 -> 0.7.0`, `[ramble] transport started`, `[panel] ramble routes mounted`, `addon ramble: connected, 15 tools discovered`.
- **Bundle version bump:** `bundles/ramble/manifest.json` AND `package.json` `0.6.0` → `0.7.0`; `npm run build-registry`.
- **Base:** `main` @0cd42ce2 (PR #322 merge).

---

## File structure

**Create**
- `bundles/ramble/server/labels.js` — `keyTail(author, n)`, `labelFor(row, { contactName })`, `cawTitleFor(row, { contactName })`.
- `tests/ramble-labels.test.js`.

**Modify**
- `bundles/ramble/server/grid.js` — `WORLD_NAME_MAX`, `sanitizeWorldName`, `setWorldName`, `getGrid` returns `worldName`.
- `bundles/ramble/server/init-tables.js` — `ensureColumn(db, "ramble_marks", "author_name", "TEXT")`.
- `bundles/ramble/server/nostr-map.js` — `markToEvent` `name` option; `eventToMark` `author_name`.
- `bundles/ramble/server/marks.js` — `insertRemoteMark` writes `author_name`.
- `bundles/ramble/server/reveal.js` — teaser allowlist.
- `bundles/ramble/server/delivery.js` — exported `contactsByPubkey(db)` (moved from routes.js).
- `bundles/ramble/server/server.js` — `ramble_query_world` rows gain `label`.
- `servers/sharing/instance-sync.js` — `RAMBLE_MARK_WIRE_COLUMNS` + `author_name`.
- `servers/gateway/boot/ramble-transport.js` — the drain passes `name` per row.
- `bundles/ramble/panel/routes.js` — `POST /api/ramble/grid` accepts `worldName`; `contactsByPubkey` imported from delivery.js.
- `bundles/ramble/panel/ramble.js` — the World name field in the Visible sheet.
- `bundles/ramble/panel/static/ramble.js` — `markLabel`, `arTitle`, the field wiring.
- `bundles/ramble/panel/static/ramble.css` — the text input in the sheet.
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- Tests: `ramble-grid`, `ramble-nostr-map`, `ramble-marks`, `ramble-sync`, `ramble-transport`, `ramble-tools`, `ramble-panel`.

---

## Task 1: `sanitizeWorldName` + the `world.name` setting + the column

**Files:**
- Modify: `bundles/ramble/server/grid.js`, `bundles/ramble/server/init-tables.js`
- Test: `tests/ramble-grid.test.js` (append), `tests/ramble-tables.test.js` (append one assertion)

**Interfaces:**
- Produces: `WORLD_NAME_MAX = 24`; `sanitizeWorldName(value) → string | null`; `setWorldName(db, name, { emit }) → string | null` (writes `world.name` = the clean value or `""`); `getGrid(db)` gains `worldName: string | null`.

- [ ] **Step 1: Failing tests**

Append to `tests/ramble-grid.test.js` (its import from `../bundles/ramble/server/grid.js` gains `sanitizeWorldName, WORLD_NAME_MAX, setWorldName`; the file's shared `db` is reset by its `beforeEach`, so the second test starts from empty settings):

```js
test("sanitizeWorldName: controls and bidi stripped, whitespace collapsed, crow:/req: rejected, hex-only rejected, capped at 24 code points, empty is null", () => {
  assert.equal(sanitizeWorldName("Kevin"), "Kevin");
  assert.equal(sanitizeWorldName("  Kevin\u202E   H\u0000 "), "Kevin H");
  assert.equal(sanitizeWorldName("crow:kevin"), null);
  assert.equal(sanitizeWorldName("REQ:x"), null);
  assert.equal(sanitizeWorldName("f665c26b"), null, "a key look-alike");
  assert.equal(sanitizeWorldName("DEADBEEF1234"), null);
  assert.equal(sanitizeWorldName("Kev1"), "Kev1", "hex-ish but not all hex");
  assert.equal(sanitizeWorldName("Kev · f665"), "Kev f665", "the label separator cannot be faked");
  assert.equal(sanitizeWorldName("abc"), "abc", "3 hex chars is a word, not a tail");
  assert.equal(sanitizeWorldName("x".repeat(40)), "x".repeat(24));
  assert.equal(sanitizeWorldName("x".repeat(23) + " yz"), "x".repeat(23), "a cut that lands on a space is re-trimmed");
  assert.equal(sanitizeWorldName("🐦".repeat(30)), "🐦".repeat(24), "code points, not UTF-16 units");
  assert.equal(sanitizeWorldName(""), null);
  assert.equal(sanitizeWorldName("   "), null);
  assert.equal(sanitizeWorldName(123), null);
  assert.equal(sanitizeWorldName(null), null);
  assert.equal(WORLD_NAME_MAX, 24);
});

test("world name: set/read through the grid; unset reads null; the setting replicates (not local.)", async () => {
  assert.equal((await getGrid(db)).worldName, null);
  const calls = [];
  assert.equal(await setWorldName(db, "  Kevin  ", { emit: async (t, op, row) => calls.push([t, op, row.key, row.value]) }), "Kevin");
  assert.equal((await getGrid(db)).worldName, "Kevin");
  assert.deepEqual(calls, [["ramble_settings", "update", "world.name", "Kevin"]]);
  assert.equal(await setWorldName(db, "crow:nope"), null);
  assert.equal((await getGrid(db)).worldName, null, "a rejected name clears the setting");
  assert.equal(await setWorldName(db, "f665c26b"), null);
});
```

If the file's existing "default grid" test compares the whole `getGrid` result with `deepEqual`, add `worldName: null` to its expected object.

In `tests/ramble-tables.test.js`, the loop `for (const c of ["bird_species", "bird_seed"]) assert.ok(marks.includes(c), …)` gains `"author_name"` in its list.

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/ramble-grid.test.js tests/ramble-tables.test.js` → FAIL (missing exports / column).

- [ ] **Step 3: Implement**

`bundles/ramble/server/grid.js`, after `export const IDENTITY_LEVELS = […];`:

```js
/** Spec 2026-09-08 §2.1: the name strangers see, capped short so a label stays one line. */
export const WORLD_NAME_MAX = 24;

/**
 * The same seven steps as core's sanitizeDisplayName (kept in the bundle so
 * the stdio MCP process needs no core import), then the two Ramble rules: a
 * 24-code-point cap and no hex-only values (a name that looks like a key
 * tail would defeat the "name · key4" disambiguation). Applied on save AND
 * on every read from the wire.
 */
export function sanitizeWorldName(value) {
  if (typeof value !== "string") return null;
  let s = value
    .replace(/[\x00-\x1F\x7F\x80-\x9F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\u00B7/g, " "); // the label's own separator: "Kev · f665" could fake a key tail
  s = s.replace(/\s+/g, " ").trim();
  if (/^(crow|req):/i.test(s)) return null;
  const points = Array.from(s);
  if (points.length > WORLD_NAME_MAX) s = points.slice(0, WORLD_NAME_MAX).join("").trim();
  if (/^[0-9a-f]{4,}$/i.test(s)) return null;
  return s.length > 0 ? s : null;
}
```

In `getGrid`, after the `identityLevel` line: `const worldName = sanitizeWorldName(await readSetting(db, "world.name"));` and return `{ master, cells, identityLevel, worldName, activeArea }`.

After `setIdentityLevel` add:

```js
/** Store the sanitized world name ("" when rejected/empty, so a bad value never lingers). Returns what was stored, or null. */
export async function setWorldName(db, name, { emit } = {}) {
  const clean = sanitizeWorldName(name);
  await writeSetting(db, "world.name", clean ?? "", { emit });
  return clean;
}
```

`bundles/ramble/server/init-tables.js`: beside the two `bird_*` `ensureColumn` lines add `await ensureColumn(db, "ramble_marks", "author_name", "TEXT");`.

- [ ] **Step 4: Run** the two files → PASS.
- [ ] **Step 5: Commit** — `git commit bundles/ramble/server/grid.js bundles/ramble/server/init-tables.js tests/ramble-grid.test.js tests/ramble-tables.test.js -m "ramble grid: the world name setting and its sanitizer; author_name column"`

---

## Task 2: The wire — `content.name`, `author_name` on stored rows, sync, the drain

**Files:**
- Modify: `bundles/ramble/server/nostr-map.js`, `bundles/ramble/server/marks.js`, `bundles/ramble/server/reveal.js`, `servers/sharing/instance-sync.js`, `servers/gateway/boot/ramble-transport.js`
- Test: `tests/ramble-nostr-map.test.js`, `tests/ramble-marks.test.js`, `tests/ramble-sync.test.js`, `tests/ramble-transport.test.js` (append)

**Interfaces:**
- Consumes: `sanitizeWorldName` (Task 1).
- Produces: `markToEvent(row, { precision, crowId, bird, name })`; `eventToMark(event).author_name`; `insertRemoteMark` stores `author_name`; teasers keep it; sync carries it; the transport passes `name` per row.

- [ ] **Step 1: Failing tests**

`tests/ramble-nostr-map.test.js` — append (the file has a `baseRow`/fixture helper; reuse the one its bird tests use):

```js
test("world name: rides in content only when given and clean; eventToMark reads it through the sanitizer", () => {
  const row = { ...openMarkRow, author_level: "pseudonym" };
  const withName = JSON.parse(markToEvent(row, { name: "  Kevin\u202E " }).content);
  assert.equal(withName.name, "Kevin");
  assert.equal(JSON.parse(markToEvent(row, {}).content).name, undefined, "no name given, none sent");
  assert.equal(JSON.parse(markToEvent(row, { name: "f665c26b" }).content).name, undefined, "a key look-alike is dropped");
  assert.equal(JSON.parse(markToEvent(row, { name: "crow:x" }).content).name, undefined);
  const ev = { id: "e".repeat(64), pubkey: "a".repeat(64), kind: MARK_KIND, created_at: 1, tags: [["g", "9v6m2"], ["d", "m1"]], content: JSON.stringify({ v: 1, text: "hi", name: "  Bad\u0000 Name " }) };
  assert.equal(eventToMark(ev).author_name, "Bad Name", "collapsed, not squeezed");
  ev.content = JSON.stringify({ v: 1, text: "hi", name: "deadbeef" });
  assert.equal(eventToMark(ev).author_name, null);
  ev.content = JSON.stringify({ v: 1, text: "hi" });
  assert.equal(eventToMark(ev).author_name, null);
  ev.content = JSON.stringify({ v: 1, text: "hi", name: 42 });
  assert.equal(eventToMark(ev).author_name, null);
});
```

(`baseRow()` = `({ ...openMarkRow })`, the file's public open mark fixture; `MARK_KIND` is already imported.)

`tests/ramble-marks.test.js` — append:

```js
test("insertRemoteMark stores author_name and a locked teaser keeps it", async () => {
  const result = await insertRemoteMark(db, {
    mark_id: "named-remote-1", author: "pk9", kind: "mark", anchor_kind: "geo", geohash: "9v6m2c",
    lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "locked", content_text: "named",
    created_at: Date.now(), nostr_event_id: "ev-named-1", author_name: "  Kevin\u202E ",
  });
  assert.equal(result.inserted, true);
  assert.equal(result.row.author_name, "Kevin", "sanitized at the store too");
  const listed = (await listMarks(db, { visibility: "public" })).find((r) => r.mark_id === "named-remote-1");
  assert.equal(listed.author_name, "Kevin", "the teaser allowlist carries the name");
  assert.equal(listed.content_text, undefined, "still a teaser");
});
```

`tests/ramble-sync.test.js` — append (`b` is the file's peer db; `applyRemoteOp` is imported). Only the apply door is tested: own rows never carry a name, so an outbox-door assertion would be vacuous (Review ruling R1-3).

```js
test("author_name rides the apply door (wire column) and is updatable by LWW", async () => {
  const row = { mark_id: "named-9", author: "c".repeat(64), author_level: "pseudonym", kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, visibility: "public", reveal: "open", content_text: "n", content_kind: "none", created_at: 1, expires_at: null, nostr_event_id: "ev-n9", author_name: "Kevin" };
  await applyRemoteOp(b, "ramble_marks", "insert", row, 11);
  let got = (await b.execute({ sql: "SELECT author_name, origin FROM ramble_marks WHERE mark_id = 'named-9'", args: [] })).rows[0];
  assert.deepEqual([got.author_name, got.origin], ["Kevin", "sync"]);
  await applyRemoteOp(b, "ramble_marks", "update", { ...row, author_name: "Kev" }, 12);
  got = (await b.execute({ sql: "SELECT author_name FROM ramble_marks WHERE mark_id = 'named-9'", args: [] })).rows[0];
  assert.equal(got.author_name, "Kev");
});
```

`tests/ramble-transport.test.js` — append; FIRST change the existing import `import { MARK_KIND, CAW_KIND } from "../bundles/ramble/server/nostr-map.js";` to `import { MARK_KIND, CAW_KIND, eventToMark } from "../bundles/ramble/server/nostr-map.js";` (one import line, not a second one):

```js
test("world name rides only pseudonym/real rows: a rotating row never carries it; eventToMark round-trips it", async () => {
  const h = await makeHarness();
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);
  await h.db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('world.name', ?)", args: ["Kevin"] });
  const rot = await seedPublicMark(h.db, "rotating row", { author_level: "rotating" });
  const pseud = await seedPublicMark(h.db, "pseudonym row", { author_level: "pseudonym" });
  const real = await seedPublicMark(h.db, "real row", { author_level: "real" });
  await h.transport.drainOnce();
  const byText = (t) => h.published.find((e) => JSON.parse(e.content).text === t);
  assert.equal(JSON.parse(byText("rotating row").content).name, undefined);
  assert.equal(JSON.parse(byText("pseudonym row").content).name, "Kevin");
  assert.equal(JSON.parse(byText("real row").content).name, "Kevin");
  assert.equal(eventToMark(byText("pseudonym row")).author_name, "Kevin");
  // A row with no level of its own follows the instance level (createMark stores author_level ?? null).
  await h.db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('public_identity_level', 'pseudonym') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] });
  const bare = await seedPublicMark(h.db, "bare row", { author_level: null });
  await h.transport.drainOnce();
  assert.equal(JSON.parse(byText("bare row").content).name, "Kevin");
  void rot; void pseud; void real; void bare;
});

(`makeHarness`, `seedPublicMark(db, text, extra)` — `extra` spreads over `author_level` — `setMaster`, `setCell`, `h.published`, `h.transport.drainOnce()` are the file's existing fixtures; the harness's default gate is the real `makePublishGate`, hence the master + public/geo cell.)
```

`tests/ramble-delivery.test.js` — append (`PK`, `db`, `createMark`, `markPayload`, `payloadToMark` are file-scope in that test; the other tests' `row` variables are test-local, so build your own):

```js
test("contacts marks never carry a world name in either direction", async () => {
  const row = await createMark(db, {
    author: "c".repeat(64), author_level: "pseudonym", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08, accuracy_m: 12 },
    visibility: "contacts", reveal: "open",
    content: { content_text: "for my people", content_kind: "none" },
  });
  const payload = markPayload({ ...row, author_name: "Kevin" });
  assert.equal(payload.author_name, undefined);
  assert.equal(payload.name, undefined);
  const back = payloadToMark({ ...payload, author_name: "Kevin", name: "Kevin" }, { author: PK, eventId: "evt-n" });
  assert.equal(back.author_name, undefined, "a contact is named from the contacts table, never from the payload");
});
```

- [ ] **Step 2: Run** the five files → the new tests FAIL.

- [ ] **Step 3: Implement**

`bundles/ramble/server/nostr-map.js`: import `sanitizeWorldName` from `./grid.js`. `markToEvent(row, { precision = 5, crowId = null, bird = null, name = null } = {})`; after the bird line add:

```js
  // The author's chosen world name (spec 2026-09-08 §2.2). The transport
  // hands it over only for pseudonym/real rows — a rotating row never gets
  // one — and it is sanitized again here so a bad setting cannot reach a relay.
  const cleanName = sanitizeWorldName(name);
  if (cleanName) content.name = cleanName;
```

In `eventToMark`'s returned object add `author_name: sanitizeWorldName(content.name),` after `bird_seed`.

`bundles/ramble/server/marks.js`: `import { sanitizeWorldName } from "./grid.js";` (grid.js imports nothing from marks.js — no cycle). `insertRemoteMark`: add `author_name` as the last INSERT column with `sanitizeWorldName(row.author_name)` as the last arg (the VALUES list gains one `?`); if the function builds `result.row` from its own args rather than a re-read, use the same sanitized value there. Nothing for `createMark` (own rows carry no name; their label is "your mark").

`bundles/ramble/server/reveal.js`: add `"author_name"` to `allowed` after `"bird_seed"`.

`servers/sharing/instance-sync.js`: append `"author_name",` to `RAMBLE_MARK_WIRE_COLUMNS` with the comment `// 2026-09-08: the world name a stranger's mark was left under.`

`servers/gateway/boot/ramble-transport.js`: core consumes NO new bundle export (an installed copy older than 0.7.0 must keep draining — the phase-3 guarded-load lesson). In `drainMarks`, after `const bird = await activeBird(db);` add:

```js
    // Raw on purpose: markToEvent sanitizes (an installed bundle older than
    // 0.7.0 ignores the option, so a stale copy keeps draining unchanged).
    const worldName = await getSetting("world.name");
```

and inside the row loop change the `markToEvent(...)` call to:

```js
        const rowLevel = row.author_level ?? level;
        const name = rowLevel === "pseudonym" || rowLevel === "real" ? worldName : null;
        const template = markToEvent(row, { precision: prec, crowId: persona.crowId, bird, name });
```

- [ ] **Step 4: Run** `node scripts/run-suite.mjs tests/ramble-nostr-map.test.js tests/ramble-marks.test.js tests/ramble-sync.test.js tests/ramble-transport.test.js tests/ramble-delivery.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit bundles/ramble/server/nostr-map.js bundles/ramble/server/marks.js bundles/ramble/server/reveal.js servers/sharing/instance-sync.js servers/gateway/boot/ramble-transport.js tests/ramble-nostr-map.test.js tests/ramble-marks.test.js tests/ramble-sync.test.js tests/ramble-transport.test.js tests/ramble-delivery.test.js -m "ramble wire: the world name rides pseudonym/real rows as content.name; author_name stored, teased and synced"`

---

## Task 3: Labels — `labels.js` + the MCP world query + the client

**Files:**
- Create: `bundles/ramble/server/labels.js`, `tests/ramble-labels.test.js`
- Modify: `bundles/ramble/server/delivery.js` (exported `contactsByPubkey`), `bundles/ramble/panel/routes.js` (use it), `bundles/ramble/server/server.js` (`label` on world-query rows), `bundles/ramble/panel/static/ramble.js` (`markLabel`, `arTitle`)
- Test: `tests/ramble-tools.test.js`, `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Produces: `keyTail(author, n)`, `labelFor(row, { contactName }) → string`, `cawTitleFor(row, { contactName }) → string`; `contactsByPubkey(db) → Map<xOnlyPubkey, { crow_id, name }>` (delivery.js); `ramble_query_world` rows gain `label`.

- [ ] **Step 1: Failing tests**

Create `tests/ramble-labels.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyTail, labelFor, cawTitleFor } from "../bundles/ramble/server/labels.js";

const A = "f665c26b" + "0".repeat(56);
test("labelFor: own > contact > named stranger with key4 > key8; caws use their noun", () => {
  assert.equal(labelFor({ kind: "mark", origin: "local", author: A }), "your mark");
  assert.equal(labelFor({ kind: "caw", origin: "sync", author: A, author_name: "Kevin" }), "your caw");
  assert.equal(labelFor({ kind: "mark", origin: "remote", author: A, author_name: "Kevin" }, { contactName: "Pal" }), "mark by Pal");
  assert.equal(labelFor({ kind: "caw", origin: "remote", author: A, author_name: "Kevin" }), "caw by Kevin · f665");
  assert.equal(labelFor({ kind: "mark", origin: "remote", author: A }), "mark by f665c26b");
  assert.equal(labelFor({ kind: "mark", origin: "remote" }), "mark by anon");
  assert.equal(keyTail(A, 4), "f665");
  assert.equal(keyTail(null, 8), "anon");
});
test("cawTitleFor mirrors the rule for the AR title", () => {
  assert.equal(cawTitleFor({ kind: "caw", origin: "local", author: A }), "Your caw");
  assert.equal(cawTitleFor({ kind: "caw", origin: "remote", author: A }, { contactName: "Pal" }), "A caw from Pal");
  assert.equal(cawTitleFor({ kind: "caw", origin: "remote", author: A, author_name: "Kevin" }), "A caw from Kevin · f665");
  assert.equal(cawTitleFor({ kind: "caw", origin: "remote", author: A }), "A caw");
});
```

`tests/ramble-tools.test.js` — in the first test ("leave_mark then query_world …") after `assert.match(m.author, …)` add `assert.equal(m.label, "your mark");`. Append:

```js
test("ramble_query_world labels a named stranger's mark 'mark by <name> · key4'", async () => {
  const { insertRemoteMark } = await import("../bundles/ramble/server/marks.js");
  await insertRemoteMark(db, { mark_id: "named-tool", author: "f665c26b" + "1".repeat(56), kind: "mark", anchor_kind: "geo", geohash: encodeGeohash(30.2672, -97.7431, 7), lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "open", content_text: "named", created_at: Date.now(), nostr_event_id: "ev-named-tool", author_name: "Kevin" });
  const q = await h.ramble_query_world({ lat: 30.2672, lon: -97.7431, visibility: "public" });
  const m = JSON.parse(q.content[0].text).marks.find((x) => x.mark_id === "named-tool");
  assert.equal(m.label, "mark by Kevin · f665");
});
```

(`db`, `h`, `encodeGeohash` are the file's existing fixtures/imports.)

`tests/ramble-panel.test.js` — in the `GET /ramble/static/ramble.js` test add:

```js
  // World name labels (spec 2026-09-08 §3.1): own marks say so; a named stranger gets a key tail.
  assert.ok(body.includes('return "your " + noun;'), "own marks read your mark / your caw");
  assert.ok(body.includes('" · " + who.slice(0, 4)'), "a named stranger carries a key4 tail");
  assert.ok(body.includes('"Your caw"') && body.includes('"A caw from "'));
```

- [ ] **Step 2: Run** `node scripts/run-suite.mjs tests/ramble-labels.test.js tests/ramble-tools.test.js tests/ramble-panel.test.js` → FAIL.

- [ ] **Step 3: Implement**

Create `bundles/ramble/server/labels.js`:

```js
/**
 * Ramble labels — the ONE rule for "who left this" (spec 2026-09-08 §3.1),
 * used by the MCP world query here and mirrored by the panel client's
 * markLabel (a plain script cannot import this). Order matters:
 *   1. yours (origin local or sync — sync rows are your own other instances);
 *   2. a contact's saved name (verified by the handshake key; no tail);
 *   3. a stranger's chosen world name plus a key tail (unverified, so the
 *      tail keeps two "Kevin"s apart and matches the key the map showed);
 *   4. the short key alone.
 */
export function keyTail(author, n) {
  return typeof author === "string" && author.length > 0 ? author.slice(0, n) : "anon";
}

export function labelFor(row, { contactName = null } = {}) {
  const noun = row?.kind === "caw" ? "caw" : "mark";
  if (row?.origin === "local" || row?.origin === "sync") return `your ${noun}`;
  if (contactName) return `${noun} by ${contactName}`;
  if (row?.author_name) return `${noun} by ${row.author_name} · ${keyTail(row.author, 4)}`;
  return `${noun} by ${keyTail(row?.author, 8)}`;
}

/** The AR anchor title for a caw, same order. */
export function cawTitleFor(row, { contactName = null } = {}) {
  if (row?.origin === "local" || row?.origin === "sync") return "Your caw";
  if (contactName) return `A caw from ${contactName}`;
  if (row?.author_name) return `A caw from ${row.author_name} · ${keyTail(row.author, 4)}`;
  return "A caw";
}
```

`bundles/ramble/server/delivery.js` — add (after `listAudiences`):

```js
/**
 * x-only pubkey -> { crow_id, name } for every unblocked full contact, bots
 * included on purpose (naming a bot's mark is harmless). ORDER BY id +
 * first-wins so two rows sharing a key name the older one deterministically.
 * Tolerant: an empty map when the core table is unreadable (the stdio MCP
 * process on a fresh db).
 */
export async function contactsByPubkey(db) {
  const map = new Map();
  try {
    const { rows } = await db.execute({ sql: "SELECT crow_id, display_name, secp256k1_pubkey FROM contacts WHERE is_blocked = 0 AND request_status IS NULL ORDER BY id", args: [] });
    for (const r of rows) {
      const pk = String(r.secp256k1_pubkey || "");
      const key = pk.length === 66 ? pk.slice(2) : pk;
      if (key && !map.has(key)) map.set(key, { crow_id: r.crow_id, name: r.display_name || r.crow_id });
    }
  } catch { /* no core tables: nobody is a contact */ }
  return map;
}
```

`bundles/ramble/panel/routes.js`: delete the router-local zero-arg `contactsByPubkey()` function (body identical to the one above) and replace its one use in `annotateMarks` with `const byPubkey = await mods.deliveryMod.contactsByPubkey(db);`.

`bundles/ramble/server/server.js`: import `{ labelFor } from "./labels.js"` and `contactsByPubkey` from `./delivery.js` (extend the existing delivery import). Extend the tool description `"List nearby marks and caws within the geohash cell containing the given location."` with ` Each row carries a label ("your mark", "mark by <contact>", "mark by <world name> · <key4>", or "mark by <key8>").`. In `ramble_query_world` replace `const marks = await listMarks(db, { visibility, geohashPrefix: cell });` with:

```js
        const rows = await listMarks(db, { visibility, geohashPrefix: cell });
        const byPubkey = await contactsByPubkey(db);
        const marks = rows.map((m) => {
          const c = m.origin === "remote" ? byPubkey.get(String(m.author)) : null;
          return { ...m, label: labelFor(m, { contactName: c ? c.name : null }) };
        });
```

`bundles/ramble/panel/static/ramble.js` — replace `markLabel`:

```js
  /* The one label rule (spec 2026-09-08 §3.1), mirrored from server/labels.js:
   * yours, then a contact's saved name, then a stranger's world name with a
   * key tail (unverified, so the tail keeps two Kevins apart), then the key. */
  function markLabel(mark) {
    var noun = mark.kind === "caw" ? "caw" : "mark";
    if (mark.origin === "local" || mark.origin === "sync") return "your " + noun;
    if (mark.contact_name) return noun + " by " + mark.contact_name;
    var who = mark.author || "anon";
    if (mark.author_name) return noun + " by " + mark.author_name + " · " + who.slice(0, 4);
    return noun + " by " + who.slice(0, 8);
  }
```

and in `arTitle` replace the caw line with:

```js
    if (mark.kind === "caw") {
      if (mark.origin === "local" || mark.origin === "sync") return "Your caw";
      if (mark.contact_name) return "A caw from " + mark.contact_name;
      if (mark.author_name) return "A caw from " + mark.author_name + " · " + (mark.author || "anon").slice(0, 4);
      return "A caw";
    }
```

- [ ] **Step 4: Run** the three files (plus `tests/ramble-marks.test.js` is unaffected) → PASS; sinks still 2, backticks 0 in `static/ramble.js`.
- [ ] **Step 5: Commit** — `git add bundles/ramble/server/labels.js tests/ramble-labels.test.js && git commit bundles/ramble/server/labels.js tests/ramble-labels.test.js bundles/ramble/server/delivery.js bundles/ramble/panel/routes.js bundles/ramble/server/server.js bundles/ramble/panel/static/ramble.js tests/ramble-tools.test.js tests/ramble-panel.test.js -m "ramble labels: your mark, contact name, world name with a key tail, then the key — server and client"`

---

## Task 4: The Visible sheet field, the route, docs en/es, 0.7.0, registry, suite

**Files:**
- Modify: `bundles/ramble/panel/ramble.js`, `bundles/ramble/panel/routes.js`, `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`, `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`
- Test: `tests/ramble-panel.test.js`

- [ ] **Step 1: Failing tests**

In the panel shell test add `assert.match(sent, /id="rb-world-name"[^>]*maxlength="24"/);`. In the `GET /ramble/static/ramble.js` test add `assert.ok(body.includes('postGrid({ worldName: worldNameEl.value })'));`. Append after the grid tests:

```js
test("POST /api/ramble/grid stores a sanitized worldName, clears a rejected one, and bounds the input", async () => {
  let res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "  Kevin\u202E  " } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).worldName, "Kevin");
  assert.equal((await (await req("/api/ramble/grid")).json()).worldName, "Kevin");
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "f665c26b" } });
  assert.equal((await res.json()).worldName, null, "a key look-alike clears the name");
  await req("/api/ramble/grid", { method: "POST", body: { worldName: "Kevin" } });
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "" } });
  assert.equal((await res.json()).worldName, null, "an empty string clears");
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: null, master: true } });
  assert.equal(res.status, 200, "null means not-sent, not clear");
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: "x".repeat(129) } });
  assert.equal(res.status, 400);
  res = await req("/api/ramble/grid", { method: "POST", body: { worldName: 7 } });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run** `tests/ramble-panel.test.js` → the new assertions FAIL.

- [ ] **Step 3: Implement**

`bundles/ramble/panel/ramble.js`, after the Name `</div>` (the `rb-identity` row) and before `<p class="rb-muted rb-fine" id="rb-grid-status"></p>`:

```html
            <div class="rb-row">
              <label class="rb-label" for="rb-world-name">World name</label>
              <input id="rb-world-name" type="text" maxlength="24" autocomplete="nickname" placeholder="how strangers see you">
            </div>
            <p class="rb-muted rb-fine">Strangers see your world name on your marks when Name is pseudonym or real, next to a short key so two people with one name stay apart. Contacts always see your Crow name.</p>
```

`bundles/ramble/panel/routes.js` `POST /api/ramble/grid`: in the validation block add `if (b.worldName != null && (typeof b.worldName !== "string" || b.worldName.length > 128)) bad("worldName must be a string of at most 128 characters");` and after the identity-level write add `if (b.worldName != null) await mods.gridMod.setWorldName(db, b.worldName, { emit });` (the response is `getGrid`, which now carries `worldName`).

`bundles/ramble/panel/static/ramble.js`: beside `var identityEl = $("rb-identity");` add `var worldNameEl = $("rb-world-name");`; in `paintGrid` add `if (worldNameEl && worldNameEl !== document.activeElement) worldNameEl.value = grid.worldName || "";`; beside the identity `change` listener add `if (worldNameEl) worldNameEl.addEventListener("change", function () { worldNameEl.blur(); postGrid({ worldName: worldNameEl.value }); });` (the blur closes the phone keyboard and lets the saved, sanitized value repaint the field — `paintGrid` skips a focused field so an SSE repaint never clobbers typing).

`bundles/ramble/panel/static/ramble.css`: the existing `#ramble select { … }` rule becomes `#ramble select,\n#ramble .rb-sheet input[type="text"] { … }` (same declarations), plus one new rule `#ramble .rb-sheet input[type="text"] { flex: 1; min-width: 0; }`.

Docs — `docs/guide/ramble.md`, in `## Privacy` append a paragraph:

```
**World name.** In the Visible sheet you can set a world name (up to 24 characters) that strangers see on your public marks and caws instead of a bare key — but only while your Name level is `pseudonym` or `real`; at `rotating` nothing but the short key goes out. It is unverified, so a stranger's name is always shown with the first four characters of their key ("Kevin · f665"). Contacts never see it: they see the name they saved for you. Your own marks read "your mark".
```

`docs/es/guide/ramble.md`, in `## Privacidad` append:

```
**Nombre en el mundo.** En la hoja Visible puedes fijar un nombre en el mundo (hasta 24 caracteres) que los desconocidos ven en tus marcas y caws públicos en lugar de una clave — pero solo mientras tu nivel de Nombre sea `pseudonym` o `real`; en `rotating` no sale nada más que la clave corta. No está verificado, así que el nombre de un desconocido se muestra siempre con los cuatro primeros caracteres de su clave ("Kevin · f665"). Los contactos nunca lo ven: ven el nombre que guardaron para ti. Tus propias marcas dicen "your mark".
```

Bump: `sed -i 's/"version": "0.6.0"/"version": "0.7.0"/' bundles/ramble/manifest.json bundles/ramble/package.json && npm run build-registry`.

- [ ] **Step 4: Run** `tests/ramble-panel.test.js` → PASS (parity included). Then the FULL suite in the foreground (`node scripts/run-suite.mjs 2>&1 | tail -12`, expect pass = total, fail 0: 4186 + 11 new = 4197 — grid +2, nostr-map +1, marks +1, sync +1, transport +1, delivery +1, labels +2, tools +1, panel +1; report the actual), `node scripts/check-port-allocation.js`, `npm run build-registry -- --check`.
- [ ] **Step 5: Commit** — `git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/routes.js bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css docs/guide/ramble.md docs/es/guide/ramble.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json tests/ramble-panel.test.js -m "ramble 0.7.0: the World name field; docs en/es; registry"`
- [ ] **Step 6 (controller):** push, PR, check-runs, merge, CROW-SCHEDULE.md, three-gateway restart. Cross-version note: a new core beside an UNREFRESHED 0.6.0 bundle copy has no `author_name` column, so a synced row carrying one fails to apply until the copy refreshes — on grackle confirm the journal's `refreshed ramble 0.6.0 -> 0.7.0` line comes before `[ramble] transport started`, then `PRAGMA table_info(ramble_marks)` on grackle's live db shows `author_name` (read-only); crow primary and r4 load the server from the repo tree and add the column on boot. Kevin sets a world name and leaves a pseudonym-level mark from grackle; a second instance (crow's transport receives the public event) stores `author_name` — verify with a read-only SELECT on crow's live db.

## Self-review notes
- D1: the level decides (transport, per row from `author_level ?? level`); `rotating` never carries a name (transport test). D2: key4 tail on named strangers (labels test, client pin). D3: own marks (labels test, tools assertion, client pin).
- §2.1 rules: grid test covers each rule incl. code points and hex-only. §2.2: nostr-map + transport + sync door. Teaser allowlist: marks test. Contacts marks never carry a name: `markPayload`/`payloadToMark` untouched (asserted implicitly — `payloadToMark` ignores unknown keys).
- Type consistency: `markToEvent`'s `name` option ↔ the transport call; `author_name` on rows ↔ `labelFor`/`markLabel`/`RAMBLE_MARK_WIRE_COLUMNS`/`insertRemoteMark`/teaser; `getGrid().worldName` ↔ the route response ↔ `paintGrid`; `contactsByPubkey` in delivery.js ↔ routes.js and server.js.

## Review

### Round 1 — 2026-09-08, opus, code-traced (implemented the plan verbatim in a scratch mirror; full suite 4196/0 after C1)
**Verdict: REVISE.** Folded:
- **C1** nostr-map test expected `"BadName"` for `"  Bad Name "`; the sanitizer collapses whitespace → `"Bad Name"`. Fixed.
- **C2** the drain destructured a NEW export (`sanitizeWorldName`) from the INSTALLED bundle's grid.js unguarded; booted against the real 0.6.0 copy the whole drain (marks, tombstones, trade expiry, contacts delivery) died with `sanitizeWorldName is not a function`. **Ruling R1-1:** core consumes no new bundle export at all — the transport passes the raw setting and `markToEvent` sanitizes; a stale copy ignores the unknown option. No guard, no stale-bundle test needed for this class (nothing new is imported).
- **S1** unsanitized ingress at `insertRemoteMark` → sanitize there too (defense in depth; the marks test now feeds a dirty name). **Ruling R1-2:** the instance-sync apply door stays a trusted same-owner path (no bundle import from core); a synced `author_name` lands on a row labelled "your mark" and is never displayed.
- **S2** both sync doors: **Ruling R1-3:** apply door only; own rows never carry a name, an outbox assertion would be vacuous.
- **S3** contacts marks: explicit `markPayload`/`payloadToMark` test added (delivery test).
- **S4** `·` in a name could fake a key tail (`Kevin · f665 · <real4>`): **Ruling R1-4:** the sanitizer replaces U+00B7 with a space (a third Ramble rule beyond the spec's two; recorded here as a spec amendment).
- **S5** `maxlength="24"` counts UTF-16 units, the sanitizer code points: **Ruling R1-5:** keep 24 — an emoji-heavy name is merely shorter in the field; the server cap is the contract.
- **S6** suite arithmetic corrected (4186 → 4197 with the delivery test).
- **Q1** `worldName: null` = not sent; `""` clears (route test pins both). **Q2** the wire column is forward-looking per spec §6 (harmless today). **Q3** D1 stands (marks use the stable key already; the level decides). **Q4** yes, r4 is one of the three gateways.

### Round 2 — 2026-09-08, opus, code-traced (fresh mirror; full suite 4197/0; stale-0.6.0-bundle probe PASSED: published 1, no `name`)
**Verdict: APPROVE with two test-fixture edits.** Folded:
- **C1** the delivery test reused a `row` that is test-local in that file → the new test builds its own row with `createMark`.
- **C2** `eventToMark` was not imported in the transport test → the existing import line is extended (stated definitely).
- **S1** the Nearby list appends `· <ago>` after the label: **Ruling R2-1:** keep — the sanitizer strips U+00B7 from names, so the tail always sits immediately after the name and the trailing ` · 3 min ago` is ours; no faking is possible.
- **S2** Enter kept the field focused so the sanitized value never repainted → the change handler blurs first.
- **S3** no save on Turbo-navigate-away before blur: **Ruling R2-2:** accepted; `change` fires on blur, matching the Name select's behaviour.
- **S4** cross-version skew (new core + unrefreshed copy lacks the column) → restart-order + PRAGMA verification note in Step 6; same class as `bird_species`, covered by the manifest bump.
- **S5** truncation re-trimmed; bidi characters in the plan's source are `\u` escapes now.
- **S6** the tool description mentions `label`. **S7** the moved `contactsByPubkey` keeps its ORDER BY provenance comment (already in the plan's code).
- Verified by the reviewer: `origin = "sync"` rows are provably the owner's own (no emit path replicates remote/contact marks); `markLabel`/`arTitle` are the only "by" builders; all client sinks are `textContent`; `labels.js` ships with the bundle (manifest lists no server files individually).
