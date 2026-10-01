# Perch Phone Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A call a bot proposes from a Perch chat is approved, watched, typed into (simulated line) and finished from a card inside that same chat. Every gate stays the same as in the Phone panel. The runner gives the owner 120 s per business line and speaks first after 6 s of silence. The bot's result delivery survives a bot that is mid-turn.

**Architecture:**
- **Engine (core):** `notifyCard(sid, frame, {botId})` in `servers/gateway/perch-interactive.js`. It reaches resident sessions only, checks the bot (I3), allows only the `phone_call` frame type, and never persists frames.
- **Phone bundle (gateway side):**
  - A new `server/card.js` builds the pointer frame and audits a mismatched target once.
  - `phone_plan_call`, the dispatcher (state and transcript changes) and the approve/reject/edit routes push frames through it.
  - The approve CAS carries `plan_hash` (I4).
  - New read routes: `GET /api/phone/perch/:sid/calls` (I5) and `GET /api/phone/whoami` (I7).
  - Busy-bot delivery backs off for up to 10 min instead of burning 5 retries.
- **Perch client:** a new `servers/gateway/dashboard/perch-hub/phone-card.js` emits the card code. It is spliced into `perchHubJs()` with a handful of one-line hooks in `client.js`, so it does not collide with the concurrent fixes branch.
- **Runner (Python):**
  - `farend_timeout` comes from the line class (FakeLine 20 s, InteractiveFakeLine 120 s).
  - After `answered`, 6 s of silence makes the assistant speak first: the disclosure, then "Hello?" / "¿Hola?".

**Tech Stack:**
- Node 24 ESM, `node:test`, express, `@modelcontextprotocol/sdk`, zod, libsql via core `createDbClient`.
- Client: vanilla ES5 inside a template literal.
- Python 3.12, pytest + pytest-asyncio through `uv`.

**Spec:** `docs/superpowers/specs/2026-10-01-perch-phone-card-design.md`

**Pre-validated while writing (2026-10-01):** every code block in Tasks 1-8 was extracted from this file and applied to a scratch mirror of `feat/perch-phone-card` @5d535182 (pre-rebase), then run. Docs prose was not run.
- **Node (all green):**
  - 191/191 across `perch-interactive`, `phone-routes`, `phone-mcp`, `phone-authority`, `phone-installed-layout`, `phone-store`, `phone-dispatcher`, `phone-card`, `phone-deliver`;
  - 293/293 across `perch-phone-card`, `perch-hub-client`, `perch-hub-page`, `perch-hub-render`, `perch-hub-stream-leak`, `i18n-global-parity`, `a11y-baseline`;
  - `build-registry --check` OK.
- **Python:** 78/78 runner tests.

## Ordering (read first)

- **Rebase before starting.** A separate branch, `fix/phone-install-and-perch-polish`, is changing `servers/gateway/perch-interactive.js` (spawn-failure error surfacing) and the Perch client (showing errors). This branch goes **after** it (spec §6):
  - Once that branch merges, run `git fetch origin && git rebase origin/main` in this worktree **before Task 3**.
  - If it has not merged by the time Task 3 starts, stop and ask.
- **Keep card code in its own functions and modules.** The plan already does this: engine `notifyCard` is one new function plus one export line; all client card code lives in `phone-card.js`; `client.js` gets only one-line hooks. Do not refactor neighbouring code in either file.
- **After the rebase, re-count the client identity guards** (Task 5, Step 1). The fixes branch may have added `current.sid!==` guards, so the expected total in `tests/perch-hub-client.test.js` becomes *(the count on rebased main) + 5*.
- Do all work in `/home/kh0pp/crow-wt-perch-phone-card`. Never `git checkout` in `/home/kh0pp/crow`.

## Global Constraints

- Commit with positional paths: `git commit <paths> -m "..."` (new files: `git add <new files>` first, then the same positional commit). Verify every commit with `git show --stat HEAD`. Never `git add -A`; never commit the worktree's `node_modules` symlink.
- No Claude attribution anywhere (no co-author trailer, no "Generated with").
- Node tests only via `npm test -- tests/<file>.test.js` (the scratch-env runner). Never raw `node --test` (it writes to the live crow.db).
- Python runner tests: `cd /home/kh0pp/crow-wt-perch-phone-card/bundles/phone/runner && uv run --extra dev pytest -q <path>`.
- Perch client and panel client code is emitted inside template literals:
  - no backtick and no `${` in client code (only the generator's own `${tJs(...)}` / `${perchPhoneCardJs(lang)}` interpolations);
  - `createElement` + `textContent` only in the Perch client; `setSanitizedHtml` stays the single `innerHTML` site.
- Bump `bundles/phone/manifest.json` from `0.1.0` to `0.2.0` and regenerate `registry/add-ons.json` with `npm run build-registry`. CI runs `build-registry --check`.
- en + es for every new i18n key. es must differ from en, and `{placeholder}` sets must match (`tests/i18n-global-parity.test.js`).
- Card actions go through `/api/phone/calls/:id/{approve,reject,farend,stop}`. Never use the Perch `ask_user` / `/interactive/:sid/answer` channel (I1).
- The SSE frame is a pointer, exactly `{type:"phone_call", call_id, status, event_seq}`. The card content always comes from the `phone_calls` row (I2).
- A push is delivered only when the resident session exists AND `session.botId === created_by.id`. A mismatch means no card plus one `phone_audit` row with event `card_target_mismatch` (I3).
- Approve sends the `plan_hash` it rendered and the CAS checks `AND plan_hash = ?`. A missing hash returns 400 `plan_hash_required`; a mismatch returns 409 `plan_changed` (I4).
- `GET /api/phone/perch/:sid/calls` is local-session only: `deliver_to.session_id = sid` AND `created_by.id` = that session's bot, newest first, max 20 (I5).
- Non-local viewers get no approve/reject/farend controls. Stop stays available to them (I7).
- Runner timing:
  - InteractiveFakeLine waits **120 s** per business line; FakeLine keeps **20 s**.
  - Speak-first comes after **6 s** of initial silence. It says the disclosure, then `Hello?` / `¿Hola?`.
- Delivery to a bot mid-turn (`turn_in_progress` / `cycle_busy`) stays pending with backoff (5, 10, 20, 40, 60, 60… s) for up to **10 min** after `ended_at`. The owner notification fires once.
- Bundle tables stay bundle-owned. New columns are added with guarded `ALTER TABLE`, and there is no `SCHEMA_GENERATION` bump.

## Review Focus

The spec implies these five failure modes, but no task obviously tests them. Each now has a test in its owning task.

1. **Owner re-notified on every busy retry.** `deliverPhoneResult` notifies "once" by checking `delivery_attempts > 0`, but a busy deferral leaves `delivery_attempts` at 0, so every retry would ping the owner again. Fix: also check `delivery_busy > 0`. Test: Task 7, "notifies the owner once".
2. **Audit flood from a forged target.** The dispatcher pushes a frame on every tick that changes a call. A call whose `deliver_to` names another bot's session would write a `card_target_mismatch` row on every transcript event. Fix: audit once per call. Test: Task 4, `phone-card.test.js` "mismatch audited once".
3. **Approve with owner edits compares the wrong hash.** The CAS must compare the hash that was **shown** (pre-edit), then store the edited plan's hash. Comparing the post-edit hash would always 409, and skipping the check would approve blind. An edit landing between the store's read and its UPDATE must also lose. Tests: Task 1, "owner edits check the SHOWN hash" and "CAS itself carries plan_hash" (deterministic race through a db wrapper).
4. **`notifyCard` as a generic emitter.** Engine code that emits any frame could inject a fake `text`/`reply`/`ask_user` frame, or a nested object, into a chat. Fix: allowlist `phone_call`, copy primitive fields only, and require `botId`. Test: Task 3, "wrong bot, missing bot, or a non-card frame type delivers nothing" and "nested values are dropped".
5. **Speak-first swallows a slow IVR menu.** After the greeting, `_disclosed_for_segment` is true, so a menu that answers late would be classified `human`, and `press_digits` would be refused (the callee-injection guard). Fix: a narrow `_greeted_unanswered` flag keeps the first far-end line after the greeting eligible as a menu. Test: Task 6, `test_menu_after_greeting_is_still_a_menu`.

---

### Task 1: Approve exactly what was shown (I4): store CAS, approve route, Phone panel

**Files:**
- Modify: `bundles/phone/server/store.js:62-81` (`approveCall`)
- Modify: `bundles/phone/panel/routes.js:75` (error map), `:120` (approve call)
- Modify: `bundles/phone/panel/phone.js:85,105,107`
- Test: `tests/phone-store.test.js`, `tests/phone-routes.test.js`, `tests/phone-dispatcher.test.js` (existing `approveCall` call sites move to a helper)

**Interfaces:**
- Produces: `approveCall(db, id, { session, allowCloud, edits, runAfter, expectedHash })`, which now requires `expectedHash: string`.
  - Throws `{code:"plan_hash_required"}` when the hash is missing, and `{code:"plan_changed"}` on a mismatch (pre-check or CAS).
  - Throws `{code:"not_pending"}` when the call is no longer awaiting approval.
- Produces: `POST /api/phone/calls/:id/approve` body field `plan_hash` (string). It maps to 400 `plan_hash_required` / 409 `plan_changed`.
- Consumes: `planHash(plan)` from `bundles/phone/server/plan.js`.

- [ ] **Step 1: Move the existing direct `approveCall` callers to a hash-aware helper**

Run the replacement first. The helper itself contains `store.approveCall(`, so it must be inserted **after** the sed.

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
sed -i 's/store\.approveCall(/approveFresh(/g' tests/phone-store.test.js tests/phone-routes.test.js tests/phone-dispatcher.test.js
grep -c "approveFresh(" tests/phone-store.test.js tests/phone-routes.test.js tests/phone-dispatcher.test.js
```
Expected: `tests/phone-store.test.js:16`, `tests/phone-routes.test.js:3`, `tests/phone-dispatcher.test.js:1`.

Insert the helper into each of the three files directly after its last `import` line:

```js
// I4 (spec 2026-10-01): every approval names the plan_hash the owner was shown.
async function approveFresh(d, id, o = {}) {
  return store.approveCall(d, id, { expectedHash: (await store.getCall(d, id)).plan_hash, ...o });
}
```

- [ ] **Step 2: Write the failing store tests** (append to `tests/phone-store.test.js`)

```js
// ---- spec 2026-10-01 I4: approve exactly what was shown ----
test("approveCall requires the shown plan_hash (I4)", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  await assert.rejects(store.approveCall(db, call_id, { session: "s", allowCloud: false }), (e) => e.code === "plan_hash_required");
  await assert.rejects(store.approveCall(db, call_id, { session: "s", allowCloud: false, expectedHash: "0".repeat(64) }), (e) => e.code === "plan_changed");
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval");
  assert.equal(c.token_hash, null);
});

test("an edit between render and approve is never approved blind (plan_changed)", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const shown = (await store.getCall(db, call_id)).plan_hash;
  await store.editCall(db, call_id, { goal: "Book two cleanings" });
  await assert.rejects(store.approveCall(db, call_id, { session: "s", allowCloud: false, expectedHash: shown }), (e) => e.code === "plan_changed");
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval"); assert.equal(c.token_hash, null); assert.equal(c.goal, "Book two cleanings");
});

test("owner edits check the SHOWN hash, then store the edited plan's hash", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const shown = (await store.getCall(db, call_id)).plan_hash;
  const { token } = await store.approveCall(db, call_id, { session: "s", allowCloud: false, expectedHash: shown, edits: { shareable: { name: "" } } });
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "approved");
  assert.notEqual(c.plan_hash, shown);
  assert.deepEqual(c.shareable, {});
  assert.equal(await store.consumeToken(db, call_id, token), true);
});

test("the approve CAS itself carries plan_hash (an edit landing between read and UPDATE loses)", async () => {
  const { call_id } = await store.createPlan(db, plan(), bot, null);
  const shown = (await store.getCall(db, call_id)).plan_hash;
  let raced = false;
  const racy = {
    execute: async (q) => {
      if (!raced && typeof q === "object" && /SET status='approved'/.test(q.sql)) {
        raced = true;
        await db.execute({ sql: "UPDATE phone_calls SET plan_hash='edited-elsewhere' WHERE id=?", args: [call_id] });
      }
      return db.execute(q);
    },
  };
  await assert.rejects(store.approveCall(racy, call_id, { session: "s", allowCloud: false, expectedHash: shown }), (e) => e.code === "plan_changed");
  assert.equal(raced, true);
  const c = await store.getCall(db, call_id);
  assert.equal(c.status, "awaiting_approval"); assert.equal(c.token_hash, null);
});
```

- [ ] **Step 3: Write the failing route and panel tests** (`tests/phone-routes.test.js`)

Add next to `newPlan()`:

```js
const hashOf = async (id) => (await store.getCall(s.db, id)).plan_hash;
```

Use the Edit tool on the two existing successful approve calls:
- old `const ok = await post(\`/api/phone/calls/${id}/approve\`, { totp: "123456", business_confirmed: true, allow_cloud: true });`
  new `const ok = await post(\`/api/phone/calls/${id}/approve\`, { totp: "123456", business_confirmed: true, allow_cloud: true, plan_hash: await hashOf(id) });`
- old `{ totp: "123456", business_confirmed: true, edits: { shareable: { name: "Kev", date_of_birth: "" } } }`
  new `{ totp: "123456", business_confirmed: true, plan_hash: await hashOf(id), edits: { shareable: { name: "Kev", date_of_birth: "" } } }`

Append:

```js
test("I4: approve needs the plan_hash that was shown — missing 400, stale 409, SSO still 403", async () => {
  const id = await newPlan();
  const shown = await hashOf(id);
  let r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "plan_hash_required");
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: shown }, "sso")).status, 403);
  assert.equal((await post(`/api/phone/calls/${id}/edit`, { edits: { goal: "Ask hours" } })).status, 200);
  r = await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: shown });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "plan_changed");
  assert.equal((await store.getCall(s.db, id)).status, "awaiting_approval");
  assert.equal((await post(`/api/phone/calls/${id}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(id) })).status, 200);
});

test("I4: the Phone panel sends the plan_hash it rendered and re-renders when the hash changes", async () => {
  const { default: panel } = await import("../bundles/phone/panel/phone.js");
  const layout = ({ content, scripts }) => `${content}<script>${scripts || ""}</script>`;
  const html = await panel.handler({ query: {} }, {}, { db: s.db, layout, appRoot: process.env.CROW_APP_ROOT, lang: "en" });
  const script = html.split("<script>")[1].split("</script>")[0];
  assert.match(script, /plan_hash: c\.plan_hash/);
  assert.match(script, /return c\.id \+ ':' \+ c\.plan_hash;/);
  assert.match(script, /if \(e\.status === 409\) \{ lastPendingKey = null; load\(\); \}/);
  assert.equal(script.includes("`"), false);
  assert.doesNotThrow(function () { new Function(script); });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npm test -- tests/phone-store.test.js tests/phone-routes.test.js tests/phone-dispatcher.test.js`
Expected: FAIL.
- The four new store tests fail: no `plan_hash_required` / `plan_changed` exists yet, and approval succeeds with any hash.
- The two new route tests fail: approve returns 200 without a hash, and the panel regexes do not match.
- The pre-existing tests still pass, since `approveFresh` passes a hash the old store ignores.

- [ ] **Step 5: Implement `approveCall`** (`bundles/phone/server/store.js`, replace the whole function at lines 62-81)

```js
export async function approveCall(db, id, { session, allowCloud, edits, runAfter, expectedHash } = {}) {
  // I4 (spec 2026-10-01): approve exactly what was shown. The caller names the
  // plan_hash it rendered; the pre-check gives a clean error and the CAS below
  // re-checks it in the same UPDATE, so an edit landing in between still loses.
  if (typeof expectedHash !== "string" || !expectedHash) throw fail("plan_hash_required", "approval must name the plan_hash that was shown");
  const row = await getCall(db, id);
  if (!row) throw fail("not_found", "no such call");
  if (row.status !== "awaiting_approval") throw fail("not_pending", "call is not awaiting approval");
  if (row.plan_hash !== expectedHash) throw fail("plan_changed", "the plan changed since it was shown; review it again");
  // Validate the edited plan (if any) before the CAS. The CAS compares the SHOWN
  // hash; the row then carries the edited plan's hash.
  let plan = row;
  if (edits) {
    plan = planFromRow(row, edits);
  }
  const token = randomBytes(24).toString("hex");
  const newHash = planHash(plan);
  const r = await db.execute({
    sql: `UPDATE phone_calls SET status='approved', business_name=?, number_e164=?, goal=?, limits_json=?, shareable_json=?, language=?, notes=?, plan_hash=?, token_hash=?, approved_by_session=?, approved_at=datetime('now'), allow_cloud=?, run_after=COALESCE(?, run_after), updated_at=datetime('now')
          WHERE id=? AND status='awaiting_approval' AND plan_hash=?`,
    args: [plan.business_name, plan.number_e164, plan.goal, J(plan.limits), J(plan.shareable), plan.language, plan.notes, newHash, sha(token + ":" + id + ":" + newHash), sha(session || ""), allowCloud ? 1 : 0, runAfter || null, id, expectedHash],
  });
  if (!r.rowsAffected) {
    const now = await getCall(db, id);
    if (now && now.status === "awaiting_approval") throw fail("plan_changed", "the plan changed since it was shown; review it again");
    throw fail("not_pending", "call is not awaiting approval");
  }
  await audit(db, id, "owner", "approved", { allowCloud: !!allowCloud, runAfter: runAfter || null });
  return { token };
}
```

- [ ] **Step 6: Implement the route changes** (`bundles/phone/panel/routes.js`)

Edit the error map (line 75):
- old `const st = { not_found: 404, not_pending: 409, not_editable: 409, invalid_plan: 400, rate_limited: 429 }[e.code] || 500;`
- new `const st = { not_found: 404, not_pending: 409, not_editable: 409, invalid_plan: 400, rate_limited: 429, plan_changed: 409, plan_hash_required: 400 }[e.code] || 500;`

Edit the approve call (line 120):
- old `await mods.store.approveCall(db, req.params.id, { session: req.dashboardSession, allowCloud: !!b.allow_cloud, edits: b.edits || undefined, runAfter: b.run_after || undefined });`
- new:
```js
    // I4: the hash check runs last, after every other gate, so a refused session
    // or a missing 2FA code never learns whether the plan changed.
    await mods.store.approveCall(db, req.params.id, { session: req.dashboardSession, allowCloud: !!b.allow_cloud, edits: b.edits || undefined, runAfter: b.run_after || undefined,
      expectedHash: typeof b.plan_hash === "string" ? b.plan_hash : undefined });
```

- [ ] **Step 7: Implement the panel change** (`bundles/phone/panel/phone.js`)

- Line 85:
  - old `"    var key = list.map(function (c) { return c.id; }).join(',');" +`
  - new `"    var key = list.map(function (c) { return c.id + ':' + c.plan_hash; }).join(',');" +`
- Line 105:
  - old `"        var body = { business_confirmed: f.business_confirmed.checked, allow_cloud: f.allow_cloud.checked, totp: f.totp.value, run_after: ra };" +`
  - new `"        var body = { plan_hash: c.plan_hash, business_confirmed: f.business_confirmed.checked, allow_cloud: f.allow_cloud.checked, totp: f.totp.value, run_after: ra };" +`
- Line 107:
  - old `"        api('POST', '/calls/' + c.id + '/approve', body).then(load).catch(function () {});" +`
  - new `"        api('POST', '/calls/' + c.id + '/approve', body).then(load).catch(function (e) { if (e.status === 409) { lastPendingKey = null; load(); } });" +`

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test -- tests/phone-store.test.js tests/phone-routes.test.js tests/phone-dispatcher.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 9: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git commit bundles/phone/server/store.js bundles/phone/panel/routes.js bundles/phone/panel/phone.js tests/phone-store.test.js tests/phone-routes.test.js tests/phone-dispatcher.test.js -m "feat(phone): approve exactly what was shown — plan_hash in the approve CAS (I4)"
git show --stat HEAD
```

---

### Task 2: Read routes for the card: per-session list (I5) and whoami (I7)

**Files:**
- Modify: `bundles/phone/server/store.js` (add `listPerchCalls` after `listCalls`, ~line 45)
- Modify: `bundles/phone/server/authority.js` (add `totpRequired` after `stepUpOk`)
- Modify: `bundles/phone/panel/routes.js` (new seam near line 37; two routes after the `localOnly` definition, ~line 99)
- Test: `tests/phone-store.test.js`, `tests/phone-authority.test.js`, `tests/phone-routes.test.js`

**Interfaces:**
- Produces: `store.listPerchCalls(db, sessionId: string, botId: string, limit = 20) -> Promise<Call[]>`. It returns hydrated rows newest first and never more than 20.
- Produces: `authority.totpRequired(deps?) -> Promise<boolean>`.
- Produces: `GET /api/phone/perch/:sid/calls`.
  - Local session only (403 `local_login_required` otherwise). Answers `{calls: Call[]}` with no `token_hash` and no `approved_by_session`.
  - Unknown session: `{calls: []}`.
- Produces: `GET /api/phone/whoami`, open to any dashboard session.
  - Local: `{local:true, totp_required:boolean, cloud_model:string|null}`.
  - Not local: `{local:false, totp_required:false, cloud_model:null}`.
- Produces: router seam `seams.perchSessionBot(sid) -> Promise<string|null>`. The default reads `bot_sessions` (the same row `perch-interactive.js` `adoptRow` reads) and never touches the engine, so listing cards never adopts or wakes a session.

- [ ] **Step 1: Write the failing store test** (append to `tests/phone-store.test.js`)

```js
// ---- spec 2026-10-01 I5: per-session scoping ----
test("listPerchCalls: only this Perch session's calls from this session's bot, newest first, max 20 (I5)", async () => {
  const mk = async (actor, deliverTo) => (await store.createPlan(db, plan(), actor, deliverTo)).call_id;
  const mine = await mk({ kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-A" });
  await mk({ kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-B" });                                   // another session
  await mk({ kind: "bot", id: "mallory" }, { kind: "perch", session_id: "perch-A" });                                // forged thread, other bot
  await mk({ kind: "bot", id: "hank" }, { kind: "gateway", gateway_type: "discord", gateway_thread_id: "perch-A" });  // not a perch target
  await mk(null, { kind: "perch", session_id: "perch-A" });                                                          // no bot
  assert.deepEqual((await store.listPerchCalls(db, "perch-A", "hank")).map((c) => c.id), [mine]);
  assert.deepEqual(await store.listPerchCalls(db, "perch-A", "nobody"), []);
  for (let i = 0; i < 22; i++) {
    await db.execute({ sql: "INSERT INTO phone_calls (id, created_by, deliver_to, business_name, number_e164, goal, plan_hash, created_at) VALUES (?,?,?,?,?,?,?, datetime('now', ?))",
      args: ["call_bulk_" + i, JSON.stringify({ kind: "bot", id: "hank" }), JSON.stringify({ kind: "perch", session_id: "perch-C" }), "B", "+15125550101", "g", "h", `+${i} seconds`] });
  }
  const bulk = await store.listPerchCalls(db, "perch-C", "hank", 50);
  assert.equal(bulk.length, 20, "never more than 20");
  assert.equal(bulk[0].id, "call_bulk_21", "newest first");
});
```

- [ ] **Step 2: Write the failing authority test** (`tests/phone-authority.test.js`)

Edit the import:
- old `import { isLocalDashboardSession, stepUpOk } from "../bundles/phone/server/authority.js";`
- new `import { isLocalDashboardSession, stepUpOk, totpRequired } from "../bundles/phone/server/authority.js";`

Append:

```js
test("totpRequired mirrors whether 2FA is enabled", async () => {
  assert.equal(await totpRequired({ is2faEnabled: async () => true }), true);
  assert.equal(await totpRequired({ is2faEnabled: async () => false }), false);
});
```

- [ ] **Step 3: Write the failing route tests** (`tests/phone-routes.test.js`)

Edit the `authority` seam in `before()`:
- old `    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456" },`
- new `    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456", totpRequired: async () => s.totpOn === true },`

Append:

```js
test("I5: GET /perch/:sid/calls — local only, this session's bot only, no secrets", async () => {
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_type TEXT, gateway_thread_id TEXT, kind TEXT);
    INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind) VALUES ('hank','perch','perch-R1','perch-live'), ('ivy','perch','perch-R2','perch-live');`);
  const p = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const mine = (await store.createPlan(s.db, p, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-R1" })).call_id;
  await store.createPlan(s.db, p, { kind: "bot", id: "ivy" }, { kind: "perch", session_id: "perch-R1" }); // ivy's child forged hank's session
  await store.createPlan(s.db, p, { kind: "bot", id: "ivy" }, { kind: "perch", session_id: "perch-R2" });
  await store.approveCall(s.db, mine, { session: "local", allowCloud: false, expectedHash: await hashOf(mine) });
  const get = (path, session) => fetch(s.base + path, { headers: session ? { "x-test-session": session } : {} });
  assert.equal((await get("/api/phone/perch/perch-R1/calls")).status, 401);
  const sso = await get("/api/phone/perch/perch-R1/calls", "sso");
  assert.equal(sso.status, 403);
  assert.equal((await sso.json()).error, "local_login_required");
  const j = await (await get("/api/phone/perch/perch-R1/calls", "local")).json();
  assert.deepEqual(j.calls.map((c) => c.id), [mine]);
  for (const k of ["plan_hash", "status", "transcript", "allow_cloud", "outcome", "summary", "deliver_to"]) assert.ok(k in j.calls[0], k);
  assert.ok(!("token_hash" in j.calls[0]));
  assert.ok(!("approved_by_session" in j.calls[0]));
  assert.deepEqual((await (await get("/api/phone/perch/no-such-session/calls", "local")).json()).calls, []);
});

test("I7: whoami — local/totp/cloud for a password session; nothing for SSO", async () => {
  await s.db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('phone_cloud_model','cld/m9') ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [] });
  try {
    const who = async (sess) => (await fetch(s.base + "/api/phone/whoami", { headers: { "x-test-session": sess } })).json();
    assert.deepEqual(await who("local"), { local: true, totp_required: false, cloud_model: "cld/m9" });
    s.totpOn = true;
    assert.equal((await who("local")).totp_required, true);
    assert.deepEqual(await who("sso"), { local: false, totp_required: false, cloud_model: null });
    assert.equal((await fetch(s.base + "/api/phone/whoami")).status, 401);
  } finally {
    s.totpOn = false;
    await s.db.execute({ sql: "UPDATE dashboard_settings SET value='' WHERE key='phone_cloud_model'", args: [] });
  }
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npm test -- tests/phone-store.test.js tests/phone-authority.test.js tests/phone-routes.test.js`
Expected: FAIL.
- `store.listPerchCalls is not a function`.
- `totpRequired` is not exported (SyntaxError on import).
- Both routes return 404.

- [ ] **Step 5: Implement the store** (`bundles/phone/server/store.js`, after `listCalls`)

```js
/** I5 (spec 2026-10-01): the calls a Perch chat may show. BOTH the target
 *  session AND the creating bot must match: a child that forged another
 *  session's X-Crow-Actor-Thread names the wrong bot and is never listed. */
export async function listPerchCalls(db, sessionId, botId, limit = 20) {
  const n = Math.max(1, Math.min(20, Number(limit) || 20));
  const r = await db.execute({
    sql: `SELECT * FROM phone_calls
          WHERE json_extract(deliver_to,'$.kind')='perch' AND json_extract(deliver_to,'$.session_id')=?
            AND json_extract(created_by,'$.kind')='bot' AND json_extract(created_by,'$.id')=?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [String(sessionId), String(botId), n],
  });
  return r.rows.map(hydrate);
}
```

- [ ] **Step 6: Implement the authority helper** (`bundles/phone/server/authority.js`, append)

```js
/** Whether an approval needs a 2FA code right now (drives the card's 2FA field). */
export async function totpRequired(deps) {
  const d = deps || (await defaultDeps());
  return !!(await d.is2faEnabled());
}
```

- [ ] **Step 7: Implement the routes** (`bundles/phone/panel/routes.js`)

After `let ready = null;` (line 39) add:

```js
  // Perch session -> its bot, read from the row perch-interactive.js adoptRow
  // reads. A direct read on purpose: listing cards must never adopt or wake a
  // session (spec 2026-10-01 §4.1 rule, applied to reads too).
  const perchSessionBot = seams.perchSessionBot || (async (sid) => {
    try {
      const r = await db.execute({ sql: "SELECT bot_id FROM bot_sessions WHERE gateway_thread_id=? AND kind='perch-live' ORDER BY id DESC LIMIT 1", args: [sid] });
      return r.rows[0] ? String(r.rows[0].bot_id) : null;
    } catch { return null; } // no bot_sessions table: this instance has no Perch
  });
```

Immediately after the `localOnly` definition (after line 99) add:

```js
  // I7: any dashboard session may ask; only a local password session learns
  // the 2FA requirement and the cloud model label.
  router.get("/api/phone/whoami", wrap(async (req, res) => {
    const local = await authority.isLocalDashboardSession(db, req.dashboardSession);
    if (!local) return res.json({ local: false, totp_required: false, cloud_model: null });
    const st = await readSettings(db);
    res.json({ local: true, totp_required: !!(await authority.totpRequired()), cloud_model: st.cloudModel || null });
  }));
  // I5: one Perch chat's calls — that session's bot only, newest 20, local only.
  router.get("/api/phone/perch/:sid/calls", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    const sid = String(req.params.sid || "");
    const botId = await perchSessionBot(sid);
    if (!botId) return res.json({ calls: [] });
    const calls = await mods.store.listPerchCalls(db, sid, botId, 20);
    res.json({ calls: calls.map(({ token_hash, approved_by_session, ...c }) => c) });
  }));
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test -- tests/phone-store.test.js tests/phone-authority.test.js tests/phone-routes.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 9: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git commit bundles/phone/server/store.js bundles/phone/server/authority.js bundles/phone/panel/routes.js tests/phone-store.test.js tests/phone-authority.test.js tests/phone-routes.test.js -m "feat(phone): per-Perch-session call list (I5) and whoami (I7) for the chat card"
git show --stat HEAD
```

---

### Task 3: Engine `notifyCard` (resident sessions only, bot-checked, card frames only)

**Precondition:** the rebase in "Ordering" is done (this task edits `perch-interactive.js`).

**Files:**
- Modify: `servers/gateway/perch-interactive.js`:
  - add `CARD_FRAME_TYPES` + `notifyCard` immediately before the public `return {` (~line 3121);
  - add one export line after `stopAll,` (~line 3137).
- Test: `tests/perch-interactive.test.js` (append; reuses its `makeEngine`/`spawned`/`collect`/`tick` harness)

**Interfaces:**
- Produces: `engine.notifyCard(sessionId: string, frame: {type:"phone_call", ...primitives}, opts: {botId: string}) -> {delivered:boolean, botId:string|null, reason?: "no_session"|"bot_required"|"bot_mismatch"|"bad_frame"}`.
  - Synchronous.
  - Never calls `resolveSession` (no adopt, no wake).
  - Emits a copy that keeps primitive values only.
  - Never persists.
- Consumes: the internal `sessions` map and `emit(s, event)` (perch-interactive.js:719).

- [ ] **Step 1: Write the failing tests** (append to `tests/perch-interactive.test.js`)

```js
// ---------------------------------------------------------------------------
// Phone card hook (spec 2026-10-01 §4.1, I3)
// ---------------------------------------------------------------------------

const CARD = { type: "phone_call", call_id: "call_x", status: "awaiting_approval", event_seq: 0 };
const INJECTED = ["phone_call", "text", "reply", "ask_user", "file"];

test("notifyCard: a pointer frame reaches the session's subscribers and is never replayed", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, "hank");
  const sink = await collect(engine, s.sessionId);
  assert.deepEqual(engine.notifyCard(s.sessionId, CARD, { botId: "hank" }), { delivered: true, botId: "hank" });
  assert.deepEqual(sink.ofType("phone_call"), [CARD]);
  const late = await collect(engine, s.sessionId);
  assert.equal(late.ofType("phone_call").length, 0, "frames are not persisted or replayed");
});

test("notifyCard: wrong bot, missing bot, or a non-card frame type delivers nothing (I3)", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, "hank");
  const sink = await collect(engine, s.sessionId);
  assert.deepEqual(engine.notifyCard(s.sessionId, CARD, { botId: "mallory" }), { delivered: false, botId: "hank", reason: "bot_mismatch" });
  assert.equal(engine.notifyCard(s.sessionId, CARD, {}).reason, "bot_required");
  assert.equal(engine.notifyCard(s.sessionId, CARD).reason, "bot_required");
  for (const type of ["text", "reply", "ask_user", "state", "file", "error"]) {
    assert.equal(engine.notifyCard(s.sessionId, { type, text: "x" }, { botId: "hank" }).reason, "bad_frame", type);
  }
  assert.equal(engine.notifyCard(s.sessionId, null, { botId: "hank" }).reason, "bad_frame");
  assert.equal(sink.events.filter((e) => INJECTED.includes(e.type)).length, 0);
});

test("notifyCard: nested values are dropped — only primitive fields reach the chat", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, "hank");
  const sink = await collect(engine, s.sessionId);
  engine.notifyCard(s.sessionId, { ...CARD, html: { evil: 1 }, list: [1, 2], fn: () => 1 }, { botId: "hank" });
  assert.deepEqual(sink.ofType("phone_call"), [CARD]);
});

test("notifyCard: never adopts or wakes — a non-resident session gets nothing", async () => {
  const a = makeEngine();
  const s = await spawned(a.engine, "hank");           // writes the bot_sessions row
  _resetInteractiveEngineForTest();
  const b = makeEngine();                               // a fresh process: the row exists, the session is not resident
  assert.deepEqual(b.engine.notifyCard(s.sessionId, CARD, { botId: "hank" }), { delivered: false, botId: null, reason: "no_session" });
  assert.equal(b.engine._sessionRecordForTest(s.sessionId), null, "not adopted");
  assert.equal(b.state.instances.length, 0, "no child spawned");
  assert.equal(b.engine.notifyCard("no-such-session", CARD, { botId: "hank" }).reason, "no_session");
});

test("notifyCard: a hibernating resident session shows the card without waking", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine, "hank");
  const sink = await collect(engine, s.sessionId);
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  const before = state.instances.length;
  assert.equal(engine.notifyCard(s.sessionId, CARD, { botId: "hank" }).delivered, true);
  await tick();
  assert.equal(state.instances.length, before, "no new child");
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  assert.equal(sink.ofType("phone_call").length, 1);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- tests/perch-interactive.test.js`
Expected: FAIL. All five new tests fail with `engine.notifyCard is not a function`; every pre-existing test still passes.

- [ ] **Step 3: Implement** (`servers/gateway/perch-interactive.js`)

Insert immediately before the line `  return {` that precedes `    spawn,`:

```js
  /**
   * Phone card hook (spec 2026-10-01 §4.1). A card frame is a gateway-built
   * POINTER ({type:"phone_call", call_id, status, event_seq}); the client
   * fetches the row itself. Rules:
   *  - RESIDENT sessions only — sessions.get, never resolveSession: showing a
   *    card must never adopt a row or wake a child.
   *  - I3: the caller names the bot the call belongs to and the frame goes out
   *    only when this session is that bot's (a child with shell access can
   *    forge X-Crow-Actor-Thread against /phone/mcp).
   *  - Allowlisted types, primitive fields only: this hook can never inject a
   *    chat text/reply/ask_user frame or a nested payload.
   *  - Not persisted: cards are rebuilt from the DB on load.
   */
  const CARD_FRAME_TYPES = new Set(["phone_call"]);
  function notifyCard(sessionId, frame, opts) {
    const s = sessions.get(String(sessionId));
    if (!s) return { delivered: false, botId: null, reason: "no_session" };
    const want = opts && opts.botId != null ? String(opts.botId) : null;
    if (!want) return { delivered: false, botId: s.botId, reason: "bot_required" };
    if (want !== s.botId) return { delivered: false, botId: s.botId, reason: "bot_mismatch" };
    if (!frame || typeof frame !== "object" || !CARD_FRAME_TYPES.has(frame.type)) return { delivered: false, botId: s.botId, reason: "bad_frame" };
    const out = {};
    for (const [k, v] of Object.entries(frame)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    emit(s, out);
    return { delivered: true, botId: s.botId };
  }

```

In the public object:
- old:
```
    stopAll,
    /** Track 3 Task 6: exported so the dispatch ROUTE can 409 a card BEFORE
```
- new:
```
    stopAll,
    /** Phone card pointer frames (spec 2026-10-01 §4.1) — resident sessions only, bot-checked. */
    notifyCard,
    /** Track 3 Task 6: exported so the dispatch ROUTE can 409 a card BEFORE
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test -- tests/perch-interactive.test.js tests/perch-interactive-routes.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git commit servers/gateway/perch-interactive.js tests/perch-interactive.test.js -m "feat(perch): engine notifyCard — bot-checked pointer frames to resident sessions only"
git show --stat HEAD
```

---

### Task 4: Push points — plan, dispatcher transitions, approve/reject/edit (I2, I3)

**Files:**
- Create: `bundles/phone/server/card.js`
- Modify: `bundles/phone/server/mcp.js` (import; `createPhoneMcpServer` signature line 248; after the notify block, ~line 267; tool description line 253)
- Modify: `bundles/phone/server/dispatcher.js` (full file below)
- Modify: `servers/gateway/boot/mcp-mounts.js:284` (inject `notifyCard`)
- Modify: `bundles/phone/panel/routes.js`: module list (line 44-45); `notifyCard` setup and dispatcher deps (lines 52-66); pushes after approve/reject/edit.
- Test: create `tests/phone-card.test.js`; modify `tests/phone-mcp.test.js`, `tests/phone-dispatcher.test.js`, `tests/phone-routes.test.js` and `tests/phone-installed-layout.test.js` (`MODULES` gains `card.js`).

**Interfaces:**
- Produces: `cardFrame(call) -> {type:"phone_call", call_id:string, status:string, event_seq:number}`.
- Produces: `pushCallCard(db, call, notifyCard) -> Promise<{delivered:boolean, reason?:string, botId?:string|null}>`.
  - Pushes only for `deliver_to.kind === "perch"` with a bot creator.
  - Audits `card_target_mismatch` once per call.
- Produces: `createPhoneMcpServer({ db, ownerNumber, McpServer, z, notify, notifyCard })`.
- Produces: dispatcher dep `deps.notifyCard(sid, frame, {botId})`. It is called once per changed call per tick, before deliveries.
- Consumes: `engine.notifyCard` (Task 3), `store.audit`, `store.getCall`.

- [ ] **Step 1: Write the failing unit tests** (create `tests/phone-card.test.js`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import * as store from "../bundles/phone/server/store.js";
import { validatePlan } from "../bundles/phone/server/plan.js";
import { cardFrame, pushCallCard } from "../bundles/phone/server/card.js";

async function fresh() {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-card-")), "crow.db"));
  await initPhoneTables(db);
  return db;
}
const plan = () => validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en", shareable: { name: "Kevin" } });
const audits = async (db, id) => (await db.execute({ sql: "SELECT event, detail_json FROM phone_audit WHERE call_id=? AND event='card_target_mismatch'", args: [id] })).rows;

test("I2: the frame is a pointer — exactly type, call_id, status, event_seq", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "perch", session_id: "p1" });
  const f = cardFrame(await store.getCall(db, call_id));
  assert.deepEqual(f, { type: "phone_call", call_id, status: "awaiting_approval", event_seq: 0 });
});

test("pushes to the requesting session with the creating bot named (I3)", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "perch", session_id: "p1" });
  const seen = [];
  const r = await pushCallCard(db, await store.getCall(db, call_id), async (sid, frame, opts) => { seen.push([sid, frame, opts]); return { delivered: true, botId: "hank" }; });
  assert.equal(r.delivered, true);
  assert.deepEqual(seen, [["p1", { type: "phone_call", call_id, status: "awaiting_approval", event_seq: 0 }, { botId: "hank" }]]);
});

test("non-perch, owner-made, or hook-less calls never push", async () => {
  const db = await fresh();
  let calls = 0; const hook = async () => { calls++; return { delivered: true }; };
  const a = (await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "gateway", gateway_type: "discord", gateway_thread_id: "d1" })).call_id;
  const b = (await store.createPlan(db, plan(), null, { kind: "perch", session_id: "p1" })).call_id;
  const c = (await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, null)).call_id;
  assert.equal((await pushCallCard(db, await store.getCall(db, a), hook)).reason, "not_perch");
  assert.equal((await pushCallCard(db, await store.getCall(db, b), hook)).reason, "no_bot");
  assert.equal((await pushCallCard(db, await store.getCall(db, c), hook)).reason, "not_perch");
  assert.equal((await pushCallCard(db, await store.getCall(db, a), null)).reason, "no_hook");
  assert.equal(calls, 0);
});

test("I3: a mismatched target is audited ONCE per call, however many pushes follow", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "mallory" }, { kind: "perch", session_id: "hanks-session" });
  const engine = async () => ({ delivered: false, botId: "hank", reason: "bot_mismatch" });
  for (let i = 0; i < 3; i++) assert.equal((await pushCallCard(db, await store.getCall(db, call_id), engine)).delivered, false);
  const rows = await audits(db, call_id);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].detail_json), { session_id: "hanks-session", expected_bot: "mallory", session_bot: "hank" });
});

test("a missing session is not audited; a throwing hook never throws out", async () => {
  const db = await fresh();
  const { call_id } = await store.createPlan(db, plan(), { kind: "bot", id: "hank" }, { kind: "perch", session_id: "gone" });
  const c = await store.getCall(db, call_id);
  assert.equal((await pushCallCard(db, c, async () => ({ delivered: false, botId: null, reason: "no_session" }))).delivered, false);
  assert.equal((await pushCallCard(db, c, async () => { throw new Error("engine down"); })).reason, "error");
  assert.equal((await audits(db, call_id)).length, 0);
});
```

- [ ] **Step 2: Write the failing MCP tests** (append to `tests/phone-mcp.test.js`)

```js
// ---- spec 2026-10-01 §4.2 / I3: the card push from phone_plan_call ----
async function mountWithCards(notifyCard) {
  const app = express(); app.use(express.json());
  app.use(localTokenAuthMiddleware(s.db));
  mountMcpServer(app, "/phone", () => createPhoneMcpServer({ db: s.db, McpServer, z, notify: async () => {}, notifyCard }), new SessionManager(), (req, res) => res.status(401).json({}));
  const http = app.listen(0); await new Promise((r) => http.once("listening", r));
  return http;
}
async function planVia(http, headers) {
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/phone/mcp`),
    { requestInit: { headers: { ...headers, Authorization: `Bearer ${s.phoneToken}` } } });
  const c = new Client({ name: "t", version: "0" }); await c.connect(t);
  const r = payload(await c.callTool({ name: "phone_plan_call", arguments: args }));
  await c.close();
  return r;
}
// A stand-in engine: one resident session, owned by hank, with notifyCard's I3 rule.
function fakeEngine(cards) {
  const owner = { "perch-1": "hank" };
  return async (sid, frame, opts) => {
    if (!owner[sid]) return { delivered: false, botId: null, reason: "no_session" };
    if (opts?.botId !== owner[sid]) return { delivered: false, botId: owner[sid], reason: "bot_mismatch" };
    cards.push([sid, frame]); return { delivered: true, botId: owner[sid] };
  };
}

test("phone_plan_call from a Perch chat pushes ONE pointer frame to that chat", async () => {
  const cards = []; const http = await mountWithCards(fakeEngine(cards));
  try {
    const r = await planVia(http, { "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": "hank", "X-Crow-Actor-Thread": "perch-1", "X-Crow-Actor-Gateway": "perch" });
    assert.deepEqual(cards, [["perch-1", { type: "phone_call", call_id: r.call_id, status: "awaiting_approval", event_seq: 0 }]]);
  } finally { await new Promise((r2) => http.close(r2)); }
});

test("I3: a forged X-Crow-Actor-Thread naming another bot's session gets no card, an audit row, and the plan still lands in Phone", async () => {
  const cards = []; const http = await mountWithCards(fakeEngine(cards));
  try {
    const r = await planVia(http, { "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": "mallory", "X-Crow-Actor-Thread": "perch-1", "X-Crow-Actor-Gateway": "perch" });
    assert.equal(cards.length, 0);
    assert.equal((await getCall(s.db, r.call_id)).status, "awaiting_approval");
    const ev = (await s.db.execute({ sql: "SELECT event FROM phone_audit WHERE call_id=? AND event='card_target_mismatch'", args: [r.call_id] })).rows;
    assert.equal(ev.length, 1);
  } finally { await new Promise((r2) => http.close(r2)); }
});

test("the gateway mount injects notifyCard from the engine singleton, never creating one", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/boot/mcp-mounts.js", import.meta.url), "utf8");
  assert.match(src, /createPhoneMcpServer\(\{[^}]*notifyCard[^}]*\}\)/);
  assert.match(src, /getInteractiveEngine\(\{ createIfMissing: false \}\)/);
});
```

- [ ] **Step 3: Write the failing dispatcher test** (append to `tests/phone-dispatcher.test.js`)

```js
// ---- spec 2026-10-01 §4.2 / §4.6: card pushes ----
async function perchSetup(runner, log) {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-disp-card-")), "crow.db"));
  await initPhoneTables(db);
  const plan = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const { call_id } = await store.createPlan(db, plan, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-1" });
  await approveFresh(db, call_id, { session: "s", allowCloud: false });
  const d = createDispatcher({ db, runner,
    deps: { notify: async () => {},
      deliver: async (_db, c) => { log.push(["deliver", c.id]); return { via: "perch" }; },
      notifyCard: async (sid, frame, opts) => { log.push(["card", sid, frame, opts]); return { delivered: true, botId: opts.botId }; } },
    settings: () => ({ ownerName: "K", ownerNumber: null, dailyCap: 10, line: "fake", model: () => ({ label: "l" }) }) });
  return { db, call_id, d };
}

test("one pointer frame per changed call per tick: live, transcript, terminal — terminal BEFORE delivery", async () => {
  const log = []; let step = 0;
  const runner = { start: async () => ({ ok: true }), stop: async () => {},
    events: async (_id, since) => {
      step++;
      if (step === 1) return { events: [{ seq: 1, type: "state", data: { state: "answered" } }], done: false, active: true };
      if (step === 2) return { events: [], done: false, active: true };
      return { events: [{ seq: 2, type: "result", data: { outcome: "info_gathered", booking: null, summary: "ok" } }].filter((e) => e.seq > since), done: true };
    } };
  const { call_id, d } = await perchSetup(runner, log);
  await d.tick(); // claim + start -> live
  await d.tick(); // seq 1
  await d.tick(); // nothing new -> no frame
  await d.tick(); // result -> done
  const cards = log.filter((x) => x[0] === "card");
  assert.deepEqual(cards.map((x) => [x[2].status, x[2].event_seq]), [["live", 0], ["live", 1], ["done", 2]]);
  for (const c of cards) {
    assert.equal(c[1], "perch-1");
    assert.deepEqual(Object.keys(c[2]).sort(), ["call_id", "event_seq", "status", "type"]);
    assert.equal(c[2].type, "phone_call"); assert.equal(c[2].call_id, call_id);
    assert.deepEqual(c[3], { botId: "hank" });
  }
  const iDone = log.findIndex((x) => x[0] === "card" && x[2].status === "done");
  const iDeliver = log.findIndex((x) => x[0] === "deliver");
  assert.ok(iDone > -1 && iDeliver > iDone, "the owner sees the outcome before the bot hears about it");
});

test("a failed start pushes the terminal frame too", async () => {
  const log = [];
  const runner = { start: async () => { throw new Error("down"); }, stop: async () => {}, events: async () => ({ events: [], done: false }) };
  const { d } = await perchSetup(runner, log);
  await d.tick();
  assert.deepEqual(log.filter((x) => x[0] === "card").map((x) => x[2].status), ["done"]);
});
```

- [ ] **Step 4: Write the failing route test** (`tests/phone-routes.test.js`)

In `before()`:
- old `  s.farend = []; s.inits = 0; s.stops = []; s.runnerActive = true;`
  new `  s.farend = []; s.inits = 0; s.stops = []; s.runnerActive = true; s.cards = [];`
- old `    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456", totpRequired: async () => s.totpOn === true },`
  new:
```js
    authority: { isLocalDashboardSession: async (_db, sess) => sess === "local", stepUpOk: async (code) => code === "123456", totpRequired: async () => s.totpOn === true },
    notifyCard: async (sid, frame, opts) => { s.cards.push([sid, frame, opts]); return { delivered: true, botId: opts && opts.botId }; },
```

Append:

```js
test("approve, edit and reject push a pointer frame to the requesting Perch chat; a refused action pushes nothing", async () => {
  const mk = async () => (await store.createPlan(s.db, validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" }),
    { kind: "bot", id: "hank-" + (++planN) }, { kind: "perch", session_id: "perch-push" })).call_id;
  const botOf = async (id) => (await store.getCall(s.db, id)).created_by.id;
  s.cards.length = 0;
  const a = await mk();
  assert.equal((await post(`/api/phone/calls/${a}/approve`, { totp: "123456", business_confirmed: true, plan_hash: await hashOf(a) })).status, 200);
  const b = await mk();
  assert.equal((await post(`/api/phone/calls/${b}/edit`, { edits: { goal: "Ask hours" } })).status, 200);
  assert.equal((await post(`/api/phone/calls/${b}/reject`, {})).status, 200);
  assert.deepEqual(s.cards.map(([sid, f]) => [sid, f.call_id, f.status]),
    [["perch-push", a, "approved"], ["perch-push", b, "awaiting_approval"], ["perch-push", b, "rejected"]]);
  assert.deepEqual(s.cards[0][2], { botId: await botOf(a) });
  const c = await mk(); const n = s.cards.length;
  assert.equal((await post(`/api/phone/calls/${c}/approve`, { totp: "000000", business_confirmed: true, plan_hash: await hashOf(c) })).status, 403);
  assert.equal((await post(`/api/phone/calls/${c}/reject`, {}, "sso")).status, 403);
  assert.equal(s.cards.length, n);
});
```

In `tests/phone-installed-layout.test.js`:
- old `const MODULES = ["mcp.js", "init-tables.js", "store.js", "plan.js", "deliver.js", "dispatcher.js", "runner-client.js", "authority.js", "secrets.js"];`
- new `const MODULES = ["mcp.js", "init-tables.js", "store.js", "plan.js", "deliver.js", "dispatcher.js", "runner-client.js", "authority.js", "secrets.js", "card.js"];`

- [ ] **Step 5: Run the tests and watch them fail**

Run: `npm test -- tests/phone-card.test.js tests/phone-mcp.test.js tests/phone-dispatcher.test.js tests/phone-routes.test.js tests/phone-installed-layout.test.js`
Expected: FAIL.
- `phone-card.test.js` cannot resolve `card.js`.
- The MCP tests see `cards.length === 0`, and the mount regex does not match.
- The dispatcher test sees no `card` entries.
- The route test sees `s.cards` empty.
- The installed-layout test fails on `card.js`.

- [ ] **Step 6: Create `bundles/phone/server/card.js`**

```js
// NO bare imports (installed copy; see mcp.js).
import { audit } from "./store.js";

/** The SSE pointer for one call (spec 2026-10-01 I2). Built here from the DB
 *  row; the Perch client refetches the row by call_id. Nothing a pi child
 *  emitted is ever forwarded. */
export function cardFrame(call) {
  return { type: "phone_call", call_id: String(call.id), status: String(call.status), event_seq: Number(call.event_seq) || 0 };
}

/** Push a call's card into the Perch chat that asked for it (spec §4.2).
 *  I3: the engine emits only when its resident session belongs to the bot that
 *  created the call. A mismatch (a forged X-Crow-Actor-Thread) shows no card;
 *  the call still appears in the Phone panel, and ONE audit row records it.
 *  Never throws. */
export async function pushCallCard(db, call, notifyCard) {
  if (!notifyCard) return { delivered: false, reason: "no_hook" };
  if (!call) return { delivered: false, reason: "no_call" };
  const d = call.deliver_to;
  if (!d || d.kind !== "perch" || !d.session_id) return { delivered: false, reason: "not_perch" };
  const botId = call.created_by && call.created_by.kind === "bot" && call.created_by.id ? String(call.created_by.id) : null;
  if (!botId) return { delivered: false, reason: "no_bot" };
  let r;
  try { r = await notifyCard(String(d.session_id), cardFrame(call), { botId }); }
  catch (e) { return { delivered: false, reason: "error", error: e.message }; }
  r = r || { delivered: false, reason: "no_result" };
  if (r.reason === "bot_mismatch") {
    try {
      const seen = (await db.execute({ sql: "SELECT 1 FROM phone_audit WHERE call_id=? AND event='card_target_mismatch' LIMIT 1", args: [call.id] })).rows.length;
      if (!seen) await audit(db, call.id, "service", "card_target_mismatch", { session_id: String(d.session_id), expected_bot: botId, session_bot: r.botId ?? null });
    } catch (e) { console.warn(`[phone] mismatch audit failed for ${call.id}: ${e.message}`); }
  }
  return r;
}
```

- [ ] **Step 7: Wire `phone_plan_call`** (`bundles/phone/server/mcp.js`)

- Import:
  - old `import * as store from "./store.js";`
  - new:
```js
import * as store from "./store.js";
import { pushCallCard } from "./card.js";
```
- Signature:
  - old `export function createPhoneMcpServer({ db, ownerNumber, McpServer, z, notify } = {}) {`
  - new `export function createPhoneMcpServer({ db, ownerNumber, McpServer, z, notify, notifyCard } = {}) {`
- Tool description:
  - old `"Propose a phone call to a BUSINESS for the owner. This never dials: the owner must approve the plan in Crow's Nest → Phone. Give the goal, the limits the agent may agree to, and only the personal details the business needs.",`
  - new `"Propose a phone call to a BUSINESS for the owner. This never dials: the owner must approve the plan (in this chat's call card, or in Crow's Nest → Phone). Give the goal, the limits the agent may agree to, and only the personal details the business needs.",`
- Push:
  - old `      return { call_id, status: "awaiting_approval", note: "The owner has been asked to approve this call. You will receive the result in this conversation when it finishes." };`
  - new:
```js
      if (notifyCard) {
        // Spec 2026-10-01 §4.2: the approval card in the chat that asked (I3-checked).
        try { await pushCallCard(db, await store.getCall(db, call_id), notifyCard); }
        catch (e) { console.warn(`[phone] card push failed for ${call_id}: ${e.message}`); }
      }
      return { call_id, status: "awaiting_approval", note: "The owner has been asked to approve this call. You will receive the result in this conversation when it finishes." };
```

- [ ] **Step 8: Wire the mount** (`servers/gateway/boot/mcp-mounts.js`)

- old `      mountMcpServer(app, "/phone", () => createPhoneMcpServer({ db: phoneDb, ownerNumber, McpServer, z, notify: createNotification }), sessionManager, authMiddleware, peerExposureGate);`
- new:
```js
      // Spec 2026-10-01 §4.2: the call card in the requesting Perch chat. The
      // engine is looked up per push and never created here; it checks I3 itself.
      const notifyCard = async (sid, frame, opts) => {
        const { getInteractiveEngine } = await import("../perch-interactive.js");
        const eng = getInteractiveEngine({ createIfMissing: false });
        return eng && typeof eng.notifyCard === "function" ? eng.notifyCard(sid, frame, opts) : { delivered: false, botId: null, reason: "no_engine" };
      };
      mountMcpServer(app, "/phone", () => createPhoneMcpServer({ db: phoneDb, ownerNumber, McpServer, z, notify: createNotification, notifyCard }), sessionManager, authMiddleware, peerExposureGate);
```

- [ ] **Step 9: Replace `bundles/phone/server/dispatcher.js`** with:

```js
import * as store from "./store.js";
import { checkNumberPolicy, OUTCOMES } from "./plan.js";
import { deliverPhoneResult } from "./deliver.js";
import { pushCallCard } from "./card.js";

const MAX_FAILURES = 30;       // consecutive events() failures (~60s at 2s ticks)
const MAX_MINUTES = 25;
const LOST_GRACE_S = 15;       // start latency before "runner not running it" means lost
const cap = (v) => (v == null ? null : String(v).slice(0, 200));

function cleanBooking(b) {
  if (!b || typeof b !== "object") return null;
  const price = typeof b.price === "number" && Number.isFinite(b.price) ? b.price : null;
  return { date: cap(b.date), time: cap(b.time), location: cap(b.location), price, confirmation: cap(b.confirmation), notes: cap(b.notes) };
}

/** One tick: expire stale plans, advance the live call (pull events,
 *  finalize), or claim+start the next due call; push one card frame per
 *  changed call; then sweep undelivered results (at-least-once). Concurrency
 *  safety rests on the store's CAS. */
export function createDispatcher({ db, runner, deps, settings }) {
  let busy = false;
  const failures = new Map();
  const deliver = deps.deliver || deliverPhoneResult;
  // Spec 2026-10-01 §4.2: calls whose state or transcript changed this tick.
  // Flushed BEFORE deliveries (§4.6: the owner sees the outcome before the bot hears about it).
  const touched = new Set();

  async function flushCards() {
    const ids = [...touched]; touched.clear();
    if (!deps.notifyCard) return;
    for (const id of ids) {
      try { await pushCallCard(db, await store.getCall(db, id), deps.notifyCard); }
      catch (e) { console.warn(`[phone] card push failed for ${id}: ${e.message}`); }
    }
  }

  async function fail(call, outcome, error) {
    touched.add(call.id);
    await store.finalizeCall(db, call.id, { outcome, booking: null, summary: null, error });
  }

  async function stopAndFail(id, error) {
    await Promise.resolve().then(() => runner.stop(id)).catch(() => {});
    await fail({ id }, "failed", error);
  }

  async function sweepDeliveries() {
    for (const c of await store.listUndelivered(db, 5)) {
      try {
        await deliver(db, c, deps);
        await store.markDelivered(db, c.id);
      } catch (e) {
        await store.bumpDeliveryAttempt(db, c.id);
        console.warn(`[phone] delivery failed for ${c.id}: ${e.message}`);
      }
    }
  }

  async function startNext() {
    const call = await store.claimNextDue(db);
    if (!call) return;
    touched.add(call.id);
    const s = settings();
    try {
      checkNumberPolicy(call.number_e164, { ownerNumber: s.ownerNumber, suppressed: await store.suppressedSet(db) });
    } catch (e) { return fail(call, "failed", e.message); }
    if ((await store.callsTodayCount(db)) >= (s.dailyCap ?? 10)) return fail(call, "failed", "daily call cap reached");
    if (await store.recentCallToNumber(db, call.number_e164, 10)) return fail(call, "failed", "called this number less than 10 minutes ago");
    const model = s.model(call);
    if (!model) return fail(call, "not_admissible", "no model allowed for this call (enable a local model, or allow cloud on approval)");
    // Fresh single-use start token bound to the plan hash; the approval token never leaves the gateway.
    const token = await store.issueStartToken(db, call.id);
    if (!token) return fail(call, "failed", "could not issue start token");
    try {
      await runner.start(call, token, model, s.ownerName, s.line);
    } catch (e) { return stopAndFail(call.id, "runner start failed: " + e.message); }
    if (!(await store.markLive(db, call.id, model.label || model.model))) {
      await Promise.resolve().then(() => runner.stop(call.id)).catch(() => {});
      await fail(call, "failed", "call state changed during start");
    }
  }

  async function advanceLive() {
    const live = (await db.execute({
      sql: `SELECT id, event_seq, status, (julianday('now') - julianday(CASE WHEN status='live' THEN started_at ELSE updated_at END)) * 1440 AS age_min
            FROM phone_calls WHERE status IN ('live','starting') ORDER BY started_at LIMIT 1`, args: [] })).rows[0];
    if (!live) return false;
    if (live.age_min != null && live.age_min > MAX_MINUTES) {
      failures.delete(live.id);
      await stopAndFail(live.id, "call exceeded maximum duration");
      return true;
    }
    let r;
    try { r = await runner.events(live.id, live.event_seq); }
    catch {
      const n = (failures.get(live.id) || 0) + 1;
      failures.set(live.id, n);
      if (n >= MAX_FAILURES) { failures.delete(live.id); await stopAndFail(live.id, "runner unreachable"); }
      return true;
    }
    failures.delete(live.id);
    const events = r.events || [];
    if (events.length) touched.add(live.id);
    const result = events.find((e) => e.type === "result");
    if (result) {
      // Finalize BEFORE advancing event_seq so a crash can never lose the result.
      const d = result.data || {};
      if (!OUTCOMES.includes(d.outcome)) {
        await fail(live, "failed", "invalid outcome from runner");
      } else {
        if (d.do_not_call) { const c = await store.getCall(db, live.id); await store.addSuppression(db, c.number_e164, "business asked not to be called"); }
        await store.finalizeCall(db, live.id, { outcome: d.outcome, booking: cleanBooking(d.booking), summary: cap(d.summary), error: cap(d.error) });
      }
    }
    if (events.length) await store.appendEvents(db, live.id, events);
    if (!result && r.done) await fail(live, "failed", "runner ended without a result");
    // The runner answers but is not running this call and has no result for it
    // (e.g. it restarted before this build closed orphans): free the slot now
    // instead of holding it for MAX_MINUTES.
    else if (!result && r.done === false && r.active === false && live.age_min != null && live.age_min * 60 > LOST_GRACE_S) {
      await stopAndFail(live.id, "runner lost the call");
    }
    return true;
  }

  return {
    async tick() {
      if (busy) return; busy = true;
      try {
        await store.expirePlans(db);
        const hadLive = await advanceLive();
        if (!hadLive) await startNext();
        await flushCards();
        await sweepDeliveries();
      } finally { busy = false; }
    },
  };
}
```

- [ ] **Step 10: Wire the panel routes** (`bundles/phone/panel/routes.js`)

- Module list (lines 44-45):
  - old:
```js
    const [store, plan, auth, secrets, deliver, rc, disp] = await Promise.all(
      ["store.js", "plan.js", "authority.js", "secrets.js", "deliver.js", "runner-client.js", "dispatcher.js"].map(bundleImport));
```
  - new:
```js
    const [store, plan, auth, secrets, deliver, rc, disp, card] = await Promise.all(
      ["store.js", "plan.js", "authority.js", "secrets.js", "deliver.js", "runner-client.js", "dispatcher.js", "card.js"].map(bundleImport));
```
- Hook and deps:
  - old `    const m = { store, plan, secrets, deliver, disp };`
  - new:
```js
    const m = { store, plan, secrets, deliver, disp, card };
    // Spec 2026-10-01 §4.2: card frames into the requesting Perch chat (the engine checks I3).
    if (!notifyCard) notifyCard = async (sid, frame, opts) => {
      const { getInteractiveEngine } = await appImport("servers/gateway/perch-interactive.js");
      const eng = getInteractiveEngine({ createIfMissing: false });
      return eng && typeof eng.notifyCard === "function" ? eng.notifyCard(sid, frame, opts) : { delivered: false, botId: null, reason: "no_engine" };
    };
```
  - old `        deps: { notify: createNotification, deliver: deliver.deliverPhoneResult, perchMessage },`
  - new `        deps: { notify: createNotification, deliver: deliver.deliverPhoneResult, perchMessage, notifyCard },`
- Seams line 37:
  - old `  let mods = null, db = seams.db || null, runner = seams.runner || null, authority = seams.authority || null, csrf = seams.csrf || null;`
  - new `  let mods = null, db = seams.db || null, runner = seams.runner || null, authority = seams.authority || null, csrf = seams.csrf || null, notifyCard = seams.notifyCard || null;`
- After the `wrap` definition add:
```js
  const pushCard = async (id) => {
    try { await mods.card.pushCallCard(db, await mods.store.getCall(db, id), notifyCard); }
    catch (e) { console.warn(`[phone] card push failed for ${id}: ${e.message}`); }
  };
```
- Approve:
  - old `      expectedHash: typeof b.plan_hash === "string" ? b.plan_hash : undefined });\n    res.json({ ok: true });`
  - new `      expectedHash: typeof b.plan_hash === "string" ? b.plan_hash : undefined });\n    await pushCard(req.params.id);\n    res.json({ ok: true });`
- Reject:
  - old `    await mods.store.rejectCall(db, req.params.id); res.json({ ok: true });`
  - new `    await mods.store.rejectCall(db, req.params.id); await pushCard(req.params.id); res.json({ ok: true });`
- Edit:
  - old `    await mods.store.editCall(db, req.params.id, (req.body || {}).edits || {}); res.json({ ok: true });`
  - new `    await mods.store.editCall(db, req.params.id, (req.body || {}).edits || {}); await pushCard(req.params.id); res.json({ ok: true });`

- [ ] **Step 11: Run the tests and watch them pass**

Run: `npm test -- tests/phone-card.test.js tests/phone-mcp.test.js tests/phone-dispatcher.test.js tests/phone-routes.test.js tests/phone-installed-layout.test.js tests/phone-store.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 12: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git add bundles/phone/server/card.js tests/phone-card.test.js
git commit bundles/phone/server/card.js bundles/phone/server/mcp.js bundles/phone/server/dispatcher.js bundles/phone/panel/routes.js servers/gateway/boot/mcp-mounts.js tests/phone-card.test.js tests/phone-mcp.test.js tests/phone-dispatcher.test.js tests/phone-routes.test.js tests/phone-installed-layout.test.js -m "feat(phone): push call-card pointer frames to the requesting Perch chat (I2, I3)"
git show --stat HEAD
```

---

### Task 5: Perch client call card

**Files:**
- Create: `servers/gateway/dashboard/perch-hub/phone-card.js`
- Modify: `servers/gateway/dashboard/perch-hub/client.js`:
  - import (line 1-2);
  - `on('phone_call')` after `on('ask_user',…)` (line 1320);
  - `resetPhoneCards();` at the three `fileSeen={}` sites (lines ~1095, ~1451, ~1680);
  - `loadPhoneCards(current.sid);` at the end of `flushHistBuf` (~line 1551);
  - the snippet splice before the Wave 3 slash-menu comment (~line 2514).
- Modify: `servers/gateway/dashboard/perch-hub/css.js` (after the `.filecard .file-img` rule, ~line 441)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new `perch.phone*` keys before `"perch.filesCwdHeading"`, ~line 2388)
- Test: create `tests/perch-phone-card.test.js`; modify `tests/perch-hub-client.test.js:209` (identity-guard count)

**Interfaces:**
- Consumes:
  - `GET /api/phone/perch/:sid/calls`, `GET /api/phone/whoami` (Task 2);
  - `GET /api/phone/calls/:id`, `POST /api/phone/calls/:id/{approve,reject,farend,stop}` (Task 1 body with `plan_hash`);
  - SSE `phone_call` frames (Tasks 3-4);
  - outer-IIFE helpers `el`, `line`, `clearEl`, `csrf`, `live`, `current`, `histSettled`.
- Produces (client functions, emitted by `perchPhoneCardJs(lang)`):
  - `resetPhoneCards()`, `loadPhoneCards(sid)`, `phoneFrame(d, sid)`;
  - pure, test-extracted: `phoneView(status)`, `phoneControls(who, view)`, `phoneNeedsPrompt(transcript)`, `phoneBelongs(c, sid)`, `phoneLimits(l)`;
  - client var `phoneBuf` (frames parked until the history settles).
- Produces: `export function perchPhoneCardJs(lang = "en"): string`.

- [ ] **Step 1: Re-count the identity guards on rebased main**

Run: `cd /home/kh0pp/crow-wt-perch-phone-card && node -e 'import("./servers/gateway/dashboard/perch-hub/client.js").then(m=>console.log((m.perchHubJs("en").match(/current\.sid\s*!==/g)||[]).length))'`
Expected: `18` on 37c018b9. If the rebased main prints a different number G, use **G + 5** below wherever this plan says 23.

- [ ] **Step 2: Write the failing tests** (create `tests/perch-phone-card.test.js`)

```js
// The Perch call card (spec 2026-10-01 §4.4). The client is a string emitted
// inside a template literal; these tests check its static shape and extract
// its pure functions with new Function, as perch-hub-client.test.js does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchPhoneCardJs } from "../servers/gateway/dashboard/perch-hub/phone-card.js";
import { perchHubCss } from "../servers/gateway/dashboard/perch-hub/css.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}
function extract(src, name, extra = "") {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " is not in the snippet");
  const masked = maskComments(src);
  let depth = 0, end = -1;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return new Function(extra + src.slice(start, end + 1) + "; return " + name + ";")();
}

test("the card snippet is spliced into the hub script and wired to the stream and history", () => {
  for (const lang of ["en", "es"]) {
    const js = perchHubJs(lang);
    assert.ok(js.includes(perchPhoneCardJs(lang)), "snippet spliced verbatim");
    assert.match(js, /on\('phone_call',function\(d\)\{/);
    assert.match(js, /if\(!histSettled\)\{ phoneBuf\.push\(d\); return; \}/);
    assert.match(js, /loadPhoneCards\(current\.sid\);/);
    assert.equal((js.match(/resetPhoneCards\(\);/g) || []).length, 3, "every transcript reset also resets the cards");
    assert.doesNotThrow(() => new Function(js), lang + " parses");
  }
});

test("I6: createElement/textContent only — no HTML sinks, no backticks, no dollar-brace", () => {
  for (const lang of ["en", "es"]) {
    const js = perchPhoneCardJs(lang);
    assert.ok(!/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML\s*\(|document\.write\s*\(|setSanitizedHtml\(/.test(js), "no HTML sink");
    assert.equal(js.includes("`"), false, "no backtick");
    assert.equal(js.includes("${"), false, "no dollar-brace");
  }
  // the hub-wide rule still holds: exactly one innerHTML assignment, in setSanitizedHtml
  assert.equal((perchHubJs("en").match(/\.innerHTML\s*\+?=/g) || []).length, 1);
});

test("I2: cards come from the phone API by call_id; frames are only pointers", () => {
  const js = perchPhoneCardJs("en");
  assert.match(js, /phoneApi\('GET','\/calls\/'\+encodeURIComponent\(id\)\)/);
  assert.match(js, /phoneApi\('GET','\/perch\/'\+encodeURIComponent\(sid\)\+'\/calls'\)/);
  assert.match(js, /typeof d\.call_id!=='string'/);
});

test("I1: actions POST to the existing phone routes with CSRF and the shown plan_hash — never the ask/answer channel", () => {
  const js = perchPhoneCardJs("en");
  for (const p of ["/approve", "/reject", "/farend", "/stop"]) assert.ok(js.includes("'" + p + "'"), p);
  assert.ok(!/\/answer|ask_user|perchApi\(/.test(js));
  assert.match(js, /'X-Crow-Csrf':csrf\(\)/);
  assert.match(js, /plan_hash:c\.plan_hash/);
});

test("I7: controls only for a local session (a real boolean true); Stop for anyone on a live call", () => {
  const phoneControls = extract(perchPhoneCardJs("en"), "phoneControls");
  assert.deepEqual(phoneControls({ local: false }, "pending"), { approve: false, farend: false, stop: false });
  assert.deepEqual(phoneControls({ local: false }, "live"), { approve: false, farend: false, stop: true });
  assert.deepEqual(phoneControls({ local: true }, "pending"), { approve: true, farend: false, stop: false });
  assert.deepEqual(phoneControls({ local: true }, "live"), { approve: false, farend: true, stop: true });
  assert.deepEqual(phoneControls({ local: true }, "terminal"), { approve: false, farend: false, stop: false });
  assert.equal(phoneControls({ local: "true" }, "live").farend, false);
  assert.equal(phoneControls(null, "pending").approve, false);
});

test("views, and the 'business answered' prompt waits for the first business line", () => {
  const js = perchPhoneCardJs("en");
  const phoneView = extract(js, "phoneView");
  assert.deepEqual(["awaiting_approval", "approved", "starting", "live", "done", "rejected", "expired", "cancelled"].map(phoneView),
    ["pending", "queued", "queued", "live", "terminal", "terminal", "terminal", "terminal"]);
  const needs = extract(js, "phoneNeedsPrompt");
  assert.equal(needs([{ type: "state", state: "dialing" }]), false);
  assert.equal(needs([{ type: "state", state: "answered" }]), true);
  assert.equal(needs([{ type: "state", state: "answered" }, { type: "agent", text: "Hi, I'm an automated assistant" }, { type: "agent", text: "Hello?" }]), true,
    "after speak-first the owner still has to type the business's line");
  assert.equal(needs([{ type: "state", state: "answered" }, { type: "farend", text: "Smile Dental" }]), false);
  assert.equal(needs(null), false);
});

test("a card only ever lands in the chat that asked for the call", () => {
  const belongs = extract(perchPhoneCardJs("en"), "phoneBelongs");
  assert.equal(belongs({ id: "call_1", deliver_to: { kind: "perch", session_id: "s1" } }, "s1"), true);
  assert.equal(belongs({ id: "call_1", deliver_to: { kind: "perch", session_id: "s2" } }, "s1"), false);
  assert.equal(belongs({ id: "call_1", deliver_to: { kind: "gateway", gateway_thread_id: "s1" } }, "s1"), false);
  assert.equal(belongs({ id: "call_1", deliver_to: null }, "s1"), false);
  assert.equal(belongs({ id: 7, deliver_to: { kind: "perch", session_id: "s1" } }, "s1"), false);
});

test("limits render as plain text", () => {
  const phoneLimits = extract(perchPhoneCardJs("en"), "phoneLimits", "var PH_NO_LIMITS='none';");
  assert.equal(phoneLimits(null), "none");
  assert.equal(phoneLimits({ days_of_week: ["tue", "thu"], time_window: { start: "15:00", end: "18:00", tz: "America/Chicago" } }),
    "tue, thu; 15:00–18:00 America/Chicago");
});

test("five identity guards in the snippet (perch-hub-client.test.js counts them hub-wide)", () => {
  assert.equal((perchPhoneCardJs("en").match(/current\.sid\s*!==/g) || []).length, 5);
});

test("every perch.phone* key the card uses exists in EN and ES and they differ", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/phone-card.js", import.meta.url), "utf8");
  const keys = [...src.matchAll(/tJs\("(perch\.phone[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 33);
  for (const k of keys) {
    assert.ok(translations[k] && translations[k].en && translations[k].es, k);
    assert.notEqual(translations[k].en, translations[k].es, k);
  }
  assert.ok(translations["perch.phoneApprovedAt"].en.includes("{time}"));
  assert.ok(translations["perch.phoneApprovedAt"].es.includes("{time}"));
});

test("the card has its own styles", () => {
  assert.match(perchHubCss(), /#perch-hub-root \.phonecard\{/);
});
```

Edit `tests/perch-hub-client.test.js` line 209:
- old `  assert.equal(guards, 18, "expected exactly 18 identity guards, found " + guards);`
- new:
```js
  // 23 as of the Perch phone card (spec 2026-10-01): phoneRefetch,
  // loadPhoneCards, upsertPhoneCard, phoneAct and the live-card poll tick.
  assert.equal(guards, 23, "expected exactly 23 identity guards, found " + guards);
```
(If Step 1 printed G ≠ 18, write G + 5 instead of 23.)

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- tests/perch-phone-card.test.js tests/perch-hub-client.test.js`
Expected: FAIL. `phone-card.js` cannot be resolved, and the guard count is 18, not 23.

- [ ] **Step 4: Add the i18n keys** (`servers/gateway/dashboard/shared/i18n.js`)

- old `  "perch.filesCwdHeading": { en: "Working directory", es: "Directorio de trabajo" },`
- new:
```js
  /* Perch phone call card (spec 2026-10-01 §4.4). */
  "perch.phoneTitle": { en: "Phone call", es: "Llamada telefónica" },
  "perch.phoneGoal": { en: "Goal", es: "Objetivo" },
  "perch.phoneLimits": { en: "Limits", es: "Límites" },
  "perch.phoneNoLimits": { en: "none", es: "ninguno" },
  "perch.phoneShare": { en: "May share (clear a field to withhold it)", es: "Puede compartir (vacía un campo para no compartirlo)" },
  "perch.phoneBusiness": { en: "This is a business", es: "Es un negocio" },
  "perch.phoneAllowCloud": { en: "Allow cloud model for this call", es: "Permitir modelo en la nube para esta llamada" },
  "perch.phoneNoCloud": { en: "no cloud model configured", es: "no hay modelo en la nube configurado" },
  "perch.phoneTotp": { en: "2FA code", es: "Código 2FA" },
  "perch.phoneApprove": { en: "Approve now", es: "Aprobar ahora" },
  "perch.phoneApproveAt": { en: "Approve for…", es: "Aprobar para…" },
  "perch.phoneReject": { en: "Reject", es: "Rechazar" },
  "perch.phoneApprovedAt": { en: "Approved — calling at {time}", es: "Aprobada — llamará el {time}" },
  "perch.phoneStarting": { en: "Starting call…", es: "Iniciando la llamada…" },
  "perch.phoneLive": { en: "Live call", es: "Llamada en curso" },
  "perch.phoneSays": { en: "Business says…", es: "El negocio dice…" },
  "perch.phoneSend": { en: "Send", es: "Enviar" },
  "perch.phoneStop": { en: "Stop call", es: "Colgar" },
  "perch.phoneAnsweredPrompt": { en: "The business answered — type what they say.", es: "El negocio contestó — escribe lo que dice." },
  "perch.phoneOutcome": { en: "Outcome", es: "Resultado" },
  "perch.phoneOpenInPhone": { en: "Open in Phone", es: "Abrir en Teléfono" },
  "perch.phoneLocalOnly": {
    en: "Approve and follow this call from a password sign-in on this Crow.",
    es: "Aprueba y sigue esta llamada iniciando sesión con tu contraseña en este Crow.",
  },
  "perch.phonePlanChanged": { en: "The plan changed — review it again before approving.", es: "El plan cambió — revísalo de nuevo antes de aprobar." },
  "perch.phoneActionFailed": { en: "That did not work:", es: "No funcionó:" },
  "perch.phoneStatusPending": { en: "Waiting for your approval", es: "Esperando tu aprobación" },
  "perch.phoneStatusRejected": { en: "Rejected", es: "Rechazada" },
  "perch.phoneStatusExpired": { en: "Expired (not approved within 24 h)", es: "Vencida (sin aprobar en 24 h)" },
  "perch.phoneStatusCancelled": { en: "Cancelled", es: "Cancelada" },
  "perch.phoneStatusDone": { en: "Call finished", es: "Llamada terminada" },
  "perch.phoneWhoAgent": { en: "Assistant", es: "Asistente" },
  "perch.phoneWhoBusiness": { en: "Business", es: "Negocio" },
  "perch.phoneWhoState": { en: "Line", es: "Línea" },
  "perch.phoneWhoDigits": { en: "Keys", es: "Teclas" },
  "perch.filesCwdHeading": { en: "Working directory", es: "Directorio de trabajo" },
```

- [ ] **Step 5: Create `servers/gateway/dashboard/perch-hub/phone-card.js`**

```js
import { tJs } from "../shared/i18n.js";

/**
 * The Perch phone call card (spec docs/superpowers/specs/2026-10-01-perch-phone-card-design.md §4.4).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's
 * el / line / clearEl / csrf / live / current / histSettled. Kept in its own
 * module so client.js only carries one-line hooks.
 *
 * Rules (house + spec):
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - I6: createElement/textContent only. business_name, goal, shareable values
 *    and transcript text are bot- or business-controlled and never markup.
 *  - I2: every card is built from the phone_calls row fetched by call_id; an SSE
 *    phone_call frame is only a hint to refetch.
 *  - I1: actions POST to /api/phone/calls/:id/{approve,reject,farend,stop}.
 *  - I7: approve/reject/farend controls only for a local password session
 *    (whoami.local === true); Stop for anyone on a live call.
 */
export function perchPhoneCardJs(lang = "en") {
  return `
  /* ---- Perch phone call card (spec 2026-10-01) ------------------------- */
  var PH_TITLE='${tJs("perch.phoneTitle", lang)}';
  var PH_GOAL='${tJs("perch.phoneGoal", lang)}';
  var PH_LIMITS='${tJs("perch.phoneLimits", lang)}';
  var PH_NO_LIMITS='${tJs("perch.phoneNoLimits", lang)}';
  var PH_SHARE='${tJs("perch.phoneShare", lang)}';
  var PH_BUSINESS='${tJs("perch.phoneBusiness", lang)}';
  var PH_CLOUD='${tJs("perch.phoneAllowCloud", lang)}';
  var PH_NO_CLOUD='${tJs("perch.phoneNoCloud", lang)}';
  var PH_TOTP='${tJs("perch.phoneTotp", lang)}';
  var PH_APPROVE='${tJs("perch.phoneApprove", lang)}';
  var PH_APPROVE_AT='${tJs("perch.phoneApproveAt", lang)}';
  var PH_REJECT='${tJs("perch.phoneReject", lang)}';
  var PH_APPROVED_AT='${tJs("perch.phoneApprovedAt", lang)}';
  var PH_STARTING='${tJs("perch.phoneStarting", lang)}';
  var PH_LIVE='${tJs("perch.phoneLive", lang)}';
  var PH_SAYS='${tJs("perch.phoneSays", lang)}';
  var PH_SEND='${tJs("perch.phoneSend", lang)}';
  var PH_STOP='${tJs("perch.phoneStop", lang)}';
  var PH_ANSWERED='${tJs("perch.phoneAnsweredPrompt", lang)}';
  var PH_OUTCOME='${tJs("perch.phoneOutcome", lang)}';
  var PH_OPEN='${tJs("perch.phoneOpenInPhone", lang)}';
  var PH_LOCAL_ONLY='${tJs("perch.phoneLocalOnly", lang)}';
  var PH_PLAN_CHANGED='${tJs("perch.phonePlanChanged", lang)}';
  var PH_FAILED='${tJs("perch.phoneActionFailed", lang)}';
  var PH_ST_PENDING='${tJs("perch.phoneStatusPending", lang)}';
  var PH_ST_REJECTED='${tJs("perch.phoneStatusRejected", lang)}';
  var PH_ST_EXPIRED='${tJs("perch.phoneStatusExpired", lang)}';
  var PH_ST_CANCELLED='${tJs("perch.phoneStatusCancelled", lang)}';
  var PH_ST_DONE='${tJs("perch.phoneStatusDone", lang)}';
  var PH_WHO_AGENT='${tJs("perch.phoneWhoAgent", lang)}';
  var PH_WHO_BUSINESS='${tJs("perch.phoneWhoBusiness", lang)}';
  var PH_WHO_STATE='${tJs("perch.phoneWhoState", lang)}';
  var PH_WHO_DIGITS='${tJs("perch.phoneWhoDigits", lang)}';

  /* call_id -> {node,view,key,timer,tx,prompt,flash} for THIS transcript. Dies
     with the transcript at the same three seams as fileSeen. */
  var phoneCards={};
  /* phone_call frames that arrived before the history batch settled; replayed
     by loadPhoneCards so a card never lands above the transcript it belongs under. */
  var phoneBuf=[];
  /* One whoami per document: {local,totp_required,cloud_model}. */
  var phoneWhoP=null;

  function resetPhoneCards(){
    for(var k in phoneCards){ if(phoneCards[k].timer) clearInterval(phoneCards[k].timer); }
    phoneCards={}; phoneBuf=[];
  }
  function phoneApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch('/api/phone'+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }
  function phoneWhoami(){
    if(phoneWhoP) return phoneWhoP;
    phoneWhoP=phoneApi('GET','/whoami').then(function(r){
      if(!r.ok||!r.j){ if(r.status===0) phoneWhoP=null; return {local:false,totp_required:false,cloud_model:null}; }
      return {local:r.j.local===true,totp_required:r.j.totp_required===true,cloud_model:typeof r.j.cloud_model==='string'?r.j.cloud_model:null};
    });
    return phoneWhoP;
  }
  /* pending | queued | live | terminal — the card's four shapes (spec §4.4). */
  function phoneView(status){
    if(status==='awaiting_approval') return 'pending';
    if(status==='approved'||status==='starting') return 'queued';
    if(status==='live') return 'live';
    return 'terminal';
  }
  /* I7: owner controls only for a local password session; Stop for anyone. */
  function phoneControls(who,view){
    var local=!!who&&who.local===true;
    return { approve: local&&view==='pending', farend: local&&view==='live', stop: view==='live' };
  }
  /* The business answered and nobody has typed its first line yet. */
  function phoneNeedsPrompt(transcript){
    var t=Array.isArray(transcript)?transcript:[], answered=false;
    for(var i=0;i<t.length;i++){
      var e=t[i]||{};
      if(e.type==='farend') return false;
      if(e.type==='state'&&e.state==='answered') answered=true;
    }
    return answered;
  }
  /* A card only ever lands in the chat that asked for the call. */
  function phoneBelongs(c,sid){
    return !!c&&typeof c.id==='string'&&!!c.deliver_to&&c.deliver_to.kind==='perch'&&c.deliver_to.session_id===sid;
  }
  function phoneLimits(l){
    l=(l&&typeof l==='object')?l:{}; var out=[];
    if(l.date_range) out.push(String(l.date_range.from)+' – '+String(l.date_range.to));
    if(Array.isArray(l.days_of_week)&&l.days_of_week.length) out.push(l.days_of_week.join(', '));
    if(l.time_window) out.push(String(l.time_window.start)+'–'+String(l.time_window.end)+' '+String(l.time_window.tz||''));
    if(l.max_price) out.push('≤ '+String(l.max_price.amount)+' '+String(l.max_price.currency||''));
    if(l.duration_minutes) out.push(String(l.duration_minutes)+' min');
    if(l.notes) out.push(String(l.notes));
    return out.length?out.join('; '):PH_NO_LIMITS;
  }
  function phoneStatusText(status){
    var v=phoneView(status);
    if(v==='pending') return PH_ST_PENDING;
    if(v==='queued') return PH_STARTING;
    if(v==='live') return PH_LIVE;
    return ({done:PH_ST_DONE,rejected:PH_ST_REJECTED,expired:PH_ST_EXPIRED,cancelled:PH_ST_CANCELLED})[status]||String(status||'');
  }
  function phoneKey(c){ return [c.status,c.plan_hash,c.event_seq,c.outcome||''].join('|'); }
  function phoneButton(text){ var b=document.createElement('button'); b.type='button'; b.textContent=text; return b; }
  function phoneCheck(parent,text){
    var lab=document.createElement('label'); var cb=document.createElement('input'); cb.type='checkbox';
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' '+text)); parent.appendChild(lab); return cb;
  }
  function phoneLine(e){
    var t=(e.type==='agent'||e.type==='farend'||e.type==='dtmf')?e.type:'state';
    var who=t==='agent'?PH_WHO_AGENT:t==='farend'?PH_WHO_BUSINESS:t==='dtmf'?PH_WHO_DIGITS:PH_WHO_STATE;
    return line('ph-t ph-t-'+t, who+': '+String(e.text||e.digits||e.state||''));
  }
  function phoneShell(id){
    var tr=el('perch-transcript'); if(!tr) return null;
    var rec=phoneCards[id];
    if(!rec){
      rec=phoneCards[id]={node:document.createElement('div'),view:'',key:'',timer:null,tx:null,prompt:null,flash:''};
      rec.node.className='entry phonecard';
      tr.appendChild(rec.node); tr.scrollTop=tr.scrollHeight;
    }
    return rec;
  }
  function phoneStopPoll(rec){ if(rec&&rec.timer){ clearInterval(rec.timer); rec.timer=null; } }

  /* An SSE phone_call frame: a pointer only — refetch the row. */
  function phoneFrame(d,sid){
    if(!d||typeof d.call_id!=='string'||!d.call_id) return;
    phoneRefetch(d.call_id,sid,typeof d.status==='string'?d.status:'');
  }
  function phoneRefetch(id,sid,hint){
    phoneApi('GET','/calls/'+encodeURIComponent(id)).then(function(r){
      if(!live()||current.sid!==sid) return;
      if(r.ok&&r.j&&r.j.call){ upsertPhoneCard(r.j.call,sid,false); return; }
      /* Not a local password session: a status-only card from the gateway's
         own frame (never child bytes), with Stop while live. */
      if(r.status===403&&hint) phonePointer(id,hint,sid);
    });
  }
  /* History: this chat's calls (I5-scoped server-side). 404 = no phone bundle,
     403 = not a local session; both mean no cards from history. */
  function loadPhoneCards(sid){
    var buf=phoneBuf; phoneBuf=[];
    phoneApi('GET','/perch/'+encodeURIComponent(sid)+'/calls').then(function(r){
      if(!live()||current.sid!==sid) return;
      var calls=(r.ok&&r.j&&Array.isArray(r.j.calls))?r.j.calls:[];
      for(var i=calls.length-1;i>=0;i--) upsertPhoneCard(calls[i],sid,false);   /* oldest first, so the newest lands last */
      buf.forEach(function(d){ phoneFrame(d,sid); });
    });
  }
  function upsertPhoneCard(c,sid,force){
    if(!phoneBelongs(c,sid)) return;
    phoneWhoami().then(function(who){
      if(!live()||current.sid!==sid) return;
      var rec=phoneShell(c.id); if(!rec) return;
      var key=phoneKey(c), view=phoneView(c.status);
      if(!force&&rec.key===key) return;                  /* unchanged: keep a half-filled form */
      if(!force&&rec.view==='live'&&view==='live'){ rec.key=key; phoneLiveUpdate(rec,c); return; }
      rec.key=key; rec.view=view; phoneStopPoll(rec); rec.tx=null; rec.prompt=null;
      clearEl(rec.node);
      rec.node.appendChild(line('ph-title',PH_TITLE+' — '+String(c.business_name||'')));
      rec.node.appendChild(line('ph-meta',String(c.number_e164||'')));
      if(rec.flash){ rec.node.appendChild(line('ph-err',rec.flash)); rec.flash=''; }
      var ctl=phoneControls(who,view);
      if(view==='pending') phoneRenderPending(rec,c,sid,who,ctl);
      else if(view==='queued') phoneRenderQueued(rec,c);
      else if(view==='live') phoneRenderLive(rec,c,sid,ctl);
      else phoneRenderTerminal(rec,c);
    });
  }
  function phoneRenderPending(rec,c,sid,who,ctl){
    var n=rec.node;
    n.appendChild(line('ph-status',PH_ST_PENDING));
    n.appendChild(line('ph-goal',PH_GOAL+': '+String(c.goal||'')));
    n.appendChild(line('ph-limits',PH_LIMITS+': '+phoneLimits(c.limits)));
    var sh=(c.shareable&&typeof c.shareable==='object')?c.shareable:{}, keys=Object.keys(sh);
    if(!ctl.approve){
      if(keys.length) n.appendChild(line('ph-share',PH_SHARE+': '+keys.join(', ')));
      n.appendChild(line('ph-note',PH_LOCAL_ONLY));
      return;
    }
    var form=document.createElement('form'); form.className='ph-form';
    form.onsubmit=function(ev){ ev.preventDefault(); };
    var tas={};
    if(keys.length){
      form.appendChild(line('ph-share',PH_SHARE));
      keys.forEach(function(k){
        var lab=document.createElement('label'); lab.textContent=k+' ';
        var ta=document.createElement('textarea'); ta.rows=1; ta.maxLength=200; ta.value=String(sh[k]==null?'':sh[k]);
        lab.appendChild(ta); form.appendChild(lab); tas[k]=ta;
      });
    }
    var biz=phoneCheck(form,PH_BUSINESS);
    var cloud=phoneCheck(form,PH_CLOUD+' ('+(who.cloud_model||PH_NO_CLOUD)+')');
    if(!who.cloud_model) cloud.disabled=true;
    var totp=null;
    if(who.totp_required){
      var tl=document.createElement('label'); tl.textContent=PH_TOTP+' ';
      totp=document.createElement('input'); totp.type='text'; totp.inputMode='numeric'; totp.maxLength=6; totp.autocomplete='one-time-code';
      tl.appendChild(totp); form.appendChild(tl);
    }
    var when=document.createElement('input'); when.type='datetime-local';
    var err=line('ph-err','');
    var acts=document.createElement('div'); acts.className='ph-actions';
    var bNow=phoneButton(PH_APPROVE), bAt=phoneButton(PH_APPROVE_AT), bRej=phoneButton(PH_REJECT);
    acts.appendChild(bNow); acts.appendChild(when); acts.appendChild(bAt); acts.appendChild(bRej);
    form.appendChild(acts); form.appendChild(err);
    function approve(runAfter){
      var body={plan_hash:c.plan_hash,business_confirmed:biz.checked,allow_cloud:cloud.checked};
      if(totp) body.totp=totp.value;
      if(runAfter) body.run_after=runAfter;
      if(keys.length){ var ed={}; keys.forEach(function(k){ ed[k]=tas[k].value; }); body.edits={shareable:ed}; }
      phoneAct(c.id,'/approve',body,sid,err);
    }
    bNow.onclick=function(){ approve(null); };
    bAt.onclick=function(){ if(!when.value){ when.focus(); return; } approve(new Date(when.value).toISOString()); };
    bRej.onclick=function(){ phoneAct(c.id,'/reject',{},sid,err); };
    n.appendChild(form);
  }
  function phoneRenderQueued(rec,c){
    var ra=(c.status==='approved'&&c.run_after)?new Date(c.run_after):null;
    var future=!!ra&&!isNaN(ra.getTime())&&ra.getTime()>Date.now();
    rec.node.appendChild(line('ph-status',future?PH_APPROVED_AT.split('{time}').join(ra.toLocaleString()):PH_STARTING));
  }
  function phoneRenderLive(rec,c,sid,ctl){
    var n=rec.node;
    n.appendChild(line('ph-status',PH_LIVE));
    rec.tx=document.createElement('div'); rec.tx.className='ph-transcript'; n.appendChild(rec.tx);
    rec.prompt=line('ph-prompt',PH_ANSWERED); n.appendChild(rec.prompt);
    var err=line('ph-err','');
    if(ctl.farend){
      var f=document.createElement('form'); f.className='ph-farend';
      var inp=document.createElement('input'); inp.type='text'; inp.maxLength=1000; inp.placeholder=PH_SAYS;
      var send=document.createElement('button'); send.type='submit'; send.textContent=PH_SEND;
      f.appendChild(inp); f.appendChild(send);
      f.onsubmit=function(ev){ ev.preventDefault(); var v=inp.value.trim(); if(!v) return; inp.value=''; phoneAct(c.id,'/farend',{text:v},sid,err); };
      n.appendChild(f);
    }
    if(ctl.stop){ var b=phoneButton(PH_STOP); b.onclick=function(){ phoneAct(c.id,'/stop',{},sid,err); }; n.appendChild(b); }
    n.appendChild(err);
    phoneLiveUpdate(rec,c);
    /* Frames are hints; polling is the source of truth for the transcript,
       matching the Phone panel (spec §4.4). */
    rec.timer=setInterval(function(){
      if(!live()||current.sid!==sid||phoneCards[c.id]!==rec||rec.view!=='live'){ phoneStopPoll(rec); return; }
      phoneRefetch(c.id,sid,'');
    },1500);
  }
  function phoneLiveUpdate(rec,c){
    if(!rec.tx) return;
    clearEl(rec.tx);
    (Array.isArray(c.transcript)?c.transcript:[]).forEach(function(e){ if(e&&typeof e==='object') rec.tx.appendChild(phoneLine(e)); });
    rec.tx.scrollTop=rec.tx.scrollHeight;
    if(rec.prompt) rec.prompt.hidden=!phoneNeedsPrompt(c.transcript);
  }
  function phoneRenderTerminal(rec,c){
    var n=rec.node;
    n.appendChild(line('ph-status',phoneStatusText(c.status)));
    if(c.outcome) n.appendChild(line('ph-outcome',PH_OUTCOME+': '+String(c.outcome)));
    if(c.summary) n.appendChild(line('ph-summary',String(c.summary)));
    var b=c.booking;
    if(b&&typeof b==='object'){
      var parts=[b.date,b.time,b.location].filter(function(x){ return x!=null&&x!==''; }).map(String);
      if(parts.length) n.appendChild(line('ph-booking',parts.join(' · ')));
    }
    var a=document.createElement('a'); a.className='ph-open'; a.href='/dashboard/phone?call='+encodeURIComponent(c.id); a.textContent=PH_OPEN;
    n.appendChild(a);
  }
  /* I7 read-only card for a viewer who cannot read the row (SSO/peer): status
     from the gateway frame, Stop while live. */
  function phonePointer(id,status,sid){
    var rec=phoneShell(id); if(!rec) return;
    var key='ptr|'+status; if(rec.key===key) return;
    rec.key=key; rec.view='pointer'; phoneStopPoll(rec); clearEl(rec.node);
    rec.node.appendChild(line('ph-title',PH_TITLE));
    rec.node.appendChild(line('ph-status',phoneStatusText(status)));
    rec.node.appendChild(line('ph-note',PH_LOCAL_ONLY));
    if(phoneView(status)==='live'){
      var err=line('ph-err','');
      var b=phoneButton(PH_STOP); b.onclick=function(){ phoneAct(id,'/stop',{},sid,err); };
      rec.node.appendChild(b); rec.node.appendChild(err);
    }
  }
  function phoneAct(id,path,body,sid,errEl){
    if(errEl) errEl.textContent='';
    phoneApi('POST','/calls/'+encodeURIComponent(id)+path,body).then(function(r){
      if(!live()||current.sid!==sid) return;
      var rec=phoneCards[id];
      if(!r.ok){
        var code=r.j&&r.j.error;
        if(code==='plan_changed'||code==='not_pending'){
          /* I4: approved or edited elsewhere — refetch and show the fresh plan. */
          if(rec){ rec.key=''; rec.flash=code==='plan_changed'?PH_PLAN_CHANGED:''; }
          phoneRefetch(id,sid,'');
          return;
        }
        if(errEl) errEl.textContent=PH_FAILED+' '+String((r.j&&(r.j.message||r.j.error))||r.status);
        return;
      }
      phoneRefetch(id,sid,'');
    });
  }
`;
}
```

- [ ] **Step 6: Hook it into `client.js`** (Edit tool, one-line hooks only)

- Import (top of file):
  - old `import { PERCH_SPLIT_MIN_WIDTH } from "./css.js";`
  - new:
```js
import { PERCH_SPLIT_MIN_WIDTH } from "./css.js";
import { perchPhoneCardJs } from "./phone-card.js";
```
- Stream listener:
  - old `    on('ask_user',function(d){ renderAsk(d); });`
  - new:
```js
    on('ask_user',function(d){ renderAsk(d); });
    /* Spec 2026-10-01: a phone_call frame is a pointer — phone-card.js refetches the row. */
    on('phone_call',function(d){
      if(!histSettled){ phoneBuf.push(d); return; }   /* replayed by loadPhoneCards once the history lands */
      phoneFrame(d,sid);
    });
```
- Reset sites:
  - old `    fileSeen={};                          /* PR-E: same seam for the card dedupe */`
    new `    fileSeen={};                          /* PR-E: same seam for the card dedupe */\n    resetPhoneCards();`
  - old `    fileSeen={};\n    histSettled=false; histBuf=[];`
    new `    fileSeen={};\n    resetPhoneCards();\n    histSettled=false; histBuf=[];`
  - old `    toolChips={}; fileSeen={}; commandsCache=null; hideCmdMenu();`
    new `    toolChips={}; fileSeen={}; commandsCache=null; hideCmdMenu();\n    resetPhoneCards();`
- End of `flushHistBuf`:
  - old `      renderTextFrame(f);\n    });\n  }`
  - new `      renderTextFrame(f);\n    });\n    loadPhoneCards(current.sid);   /* spec 2026-10-01: this chat's call cards, after the transcript */\n  }`
- Splice:
  - old `  /* ---- Wave 3: the slash-command menu ------------------------------------`
  - new `${perchPhoneCardJs(lang)}\n\n  /* ---- Wave 3: the slash-command menu ------------------------------------`

- [ ] **Step 7: Add the styles** (`servers/gateway/dashboard/perch-hub/css.js`)

- old `#perch-hub-root .filecard .file-img{max-width:100%;height:auto;border-radius:6px;margin-bottom:4px}`
- new:
```css
#perch-hub-root .filecard .file-img{max-width:100%;height:auto;border-radius:6px;margin-bottom:4px}
/* Spec 2026-10-01: the phone call card (same box as a file card). */
#perch-hub-root .phonecard{flex-direction:column;gap:4px;align-self:stretch;width:100%;min-width:0;
background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin:2px 0}
#perch-hub-root .phonecard .ph-title{font-weight:600;font-size:13.5px;color:var(--ink);word-break:break-word}
#perch-hub-root .phonecard .ph-meta,#perch-hub-root .phonecard .ph-status,#perch-hub-root .phonecard .ph-note{font-size:13px;color:var(--dim)}
#perch-hub-root .phonecard .ph-goal,#perch-hub-root .phonecard .ph-limits,#perch-hub-root .phonecard .ph-summary{font-size:13px;color:var(--ink);white-space:pre-wrap;word-break:break-word}
#perch-hub-root .phonecard label{display:block;font-size:13px;margin:3px 0}
#perch-hub-root .phonecard textarea,#perch-hub-root .phonecard input[type=text]{width:100%;box-sizing:border-box}
#perch-hub-root .phonecard .ph-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px}
#perch-hub-root .phonecard .ph-transcript{max-height:240px;overflow-y:auto;font-size:13px;display:flex;flex-direction:column;gap:2px}
#perch-hub-root .phonecard .ph-t-farend{color:var(--teal)}
#perch-hub-root .phonecard .ph-t-state{color:var(--dim)}
#perch-hub-root .phonecard .ph-prompt{font-weight:600;color:var(--teal);font-size:13px}
#perch-hub-root .phonecard .ph-farend{display:flex;gap:6px}
#perch-hub-root .phonecard .ph-err{color:#b3261e;font-size:13px}
#perch-hub-root .phonecard .ph-err:empty{display:none}
#perch-hub-root .phonecard .ph-open{color:var(--teal);font-size:13px;text-decoration:none}
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test -- tests/perch-phone-card.test.js tests/perch-hub-client.test.js tests/perch-hub-page.test.js tests/perch-hub-render.test.js tests/perch-hub-stream-leak.test.js tests/i18n-global-parity.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 9: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git add servers/gateway/dashboard/perch-hub/phone-card.js tests/perch-phone-card.test.js
git commit servers/gateway/dashboard/perch-hub/phone-card.js servers/gateway/dashboard/perch-hub/client.js servers/gateway/dashboard/perch-hub/css.js servers/gateway/dashboard/shared/i18n.js tests/perch-phone-card.test.js tests/perch-hub-client.test.js -m "feat(perch): phone call card in the chat — approve, live view, outcome (I1, I2, I6, I7)"
git show --stat HEAD
```

---

### Task 6: Runner timing — 120 s per business line, assistant speaks first after 6 s

**Files:**
- Modify: `bundles/phone/runner/src/crow_phone/line.py` (class attributes)
- Modify: `bundles/phone/runner/src/crow_phone/policy.py` (add `greeting`, after `callback_line`, ~line 90)
- Modify: `bundles/phone/runner/src/crow_phone/controller.py`: `__init__` (lines 33-42) and `_converse` (lines 104-146)
- Test: `bundles/phone/runner/tests/test_controller.py`

**Interfaces:**
- Produces: `FakeLine.farend_timeout = 20`, `InteractiveFakeLine.farend_timeout = 120`.
- Produces: `policy.greeting(lang) -> "Hello?" | "¿Hola?"`.
- Produces: `CallController(..., farend_timeout=None, initial_silence=6)`. `None` means `getattr(line, "farend_timeout", 20)`.
- No gateway change: `app.py` builds the controller without `farend_timeout`, so the line class decides.

- [ ] **Step 1: Write the failing tests** (append to `bundles/phone/runner/tests/test_controller.py`)

```python
# ---- spec 2026-10-01 §4.5: simulated-line timing ----
from crow_phone.line import InteractiveFakeLine


class TimedLine(FakeLine):
    """next_farend pops the next scripted item (None = silence) and records each timeout."""

    def __init__(self, items):
        super().__init__([])
        self.items = list(items)
        self.timeouts = []

    async def next_farend(self, timeout):
        self.timeouts.append(timeout)
        return self.items.pop(0) if self.items else None


def _ctl(line, **kw):
    return CallController("c", PLAN, "Kevin", line, ScriptedBrain([]), lambda t, d: None, None, **kw)


def test_farend_timeout_is_per_line():
    assert InteractiveFakeLine.farend_timeout == 120
    assert FakeLine.farend_timeout == 20
    assert _ctl(InteractiveFakeLine()).farend_timeout == 120
    assert _ctl(FakeLine([])).farend_timeout == 20
    assert _ctl(InteractiveFakeLine(), farend_timeout=5).farend_timeout == 5
    assert _ctl(FakeLine([])).initial_silence == 6


async def test_initial_silence_assistant_speaks_first_disclosure_then_greeting():
    line = TimedLine([None, "Smile Dental, sorry, go ahead.", "Saturdays 9 to 1."])
    result, _, _ = await run(line, [
        R("What are your Saturday hours?"),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "Sat 9-1"})),
    ], initial_silence=0.01)
    assert line.said[:2] == [policy.disclosure("en", "Kevin"), policy.greeting("en")]
    assert line.said.count(policy.disclosure("en", "Kevin")) == 1
    assert line.timeouts[0] == 0.01 and line.timeouts[1] == 20
    assert result["outcome"] == "info_gathered"


async def test_initial_silence_spanish_greeting():
    line = TimedLine([None, None])
    result, _, _ = await run(line, [], plan={**PLAN, "language": "es"}, initial_silence=0.01)
    assert line.said == [policy.disclosure("es", "Kevin"), "¿Hola?"]
    assert result["outcome"] == "needs_callback"


async def test_business_speaks_first_unchanged_no_greeting():
    line = TimedLine(["Smile Dental, how can I help?", "Saturdays 9 to 1."])
    result, _, _ = await run(line, [
        R("What are your Saturday hours?"),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "Sat 9-1"})),
    ], initial_silence=0.01)
    assert line.said[0] == policy.disclosure("en", "Kevin")
    assert policy.greeting("en") not in line.said
    assert result["outcome"] == "info_gathered"


async def test_silence_after_greeting_is_needs_callback():
    line = TimedLine([None, None])
    result, _, _ = await run(line, [], initial_silence=0.01)
    assert result["outcome"] == "needs_callback"
    assert line.said == [policy.disclosure("en", "Kevin"), policy.greeting("en")]


async def test_menu_after_greeting_is_still_a_menu():
    line = TimedLine([None, "Thanks for calling. For appointments press 2.", "Front desk, this is Ana.", "Sure."])
    result, events, _ = await run(line, [
        R("", ("press_digits", {"digits": "2"})),
        R("I'd like to book a cleaning."),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "reached front desk"})),
    ], initial_silence=0.01)
    assert line.digits == ["2"]
    assert not any(t == "tool" and d["name"] == "press_digits" and not d["ok"] for t, d in events)
    assert line.said.count(policy.disclosure("en", "Kevin")) == 2  # before the greeting, and again for Ana
    assert result["outcome"] == "info_gathered"


async def test_a_person_saying_press_after_the_greeting_reply_is_not_a_menu():
    line = TimedLine([None, "Hi, this is Ana.", "To verify, press 9 now.", "Okay bye."])
    result, events, _ = await run(line, [
        R("I'd like to book a cleaning."),
        R("", ("press_digits", {"digits": "9"})),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "declined"})),
    ], initial_silence=0.01)
    assert line.digits == []
    assert any(t == "tool" and d["name"] == "press_digits" and not d["ok"] for t, d in events)
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd /home/kh0pp/crow-wt-perch-phone-card/bundles/phone/runner && uv run --extra dev pytest -q tests/test_controller.py`
Expected: FAIL.
- `AttributeError: type object 'InteractiveFakeLine' has no attribute 'farend_timeout'`.
- `TypeError: ... unexpected keyword argument 'initial_silence'`.
- `AttributeError: module 'crow_phone.policy' has no attribute 'greeting'`.
- The pre-existing tests still pass.

- [ ] **Step 3: Implement the line timeouts** (`line.py`)

- old:
```python
class FakeLine:
    def __init__(self, script, dial_result="answered"):
```
- new:
```python
class FakeLine:
    farend_timeout = 20  # scripted tests: a silent far end is a quick needs_callback

    def __init__(self, script, dial_result="answered"):
```
- old:
```python
    """The owner types the business's lines in the Phone panel (acceptance testing)."""

    def __init__(self):
```
- new:
```python
    """The owner types the business's lines in the Phone panel or the Perch call card."""

    farend_timeout = 120  # a person is typing each business line on a phone (spec 2026-10-01 §4.5)

    def __init__(self):
```

- [ ] **Step 4: Implement the greeting** (`policy.py`, after `callback_line`)

```python
_GREETING = {"en": "Hello?", "es": "¿Hola?"}


def greeting(lang: str) -> str:
    """Spoken after the disclosure when the business is silent after answering (spec 2026-10-01 §4.5)."""
    return _GREETING["es" if lang == "es" else "en"]
```

- [ ] **Step 5: Implement the controller** (`controller.py`)

- `__init__`:
  - old `    def __init__(self, call_id, plan, owner_name, line, brain, emit, verify, max_seconds=1200, ring_timeout=60, farend_timeout=20):`
  - new `    def __init__(self, call_id, plan, owner_name, line, brain, emit, verify, max_seconds=1200, ring_timeout=60, farend_timeout=None, initial_silence=6):`
  - old `        self.max_seconds, self.ring_timeout, self.farend_timeout = max_seconds, ring_timeout, farend_timeout`
  - new:
```python
        self.max_seconds, self.ring_timeout = max_seconds, ring_timeout
        # Per line (spec 2026-10-01 §4.5): an owner typing on a phone needs far longer than a script.
        self.farend_timeout = farend_timeout if farend_timeout is not None else getattr(line, "farend_timeout", 20)
        self.initial_silence = initial_silence
```
  - old `        self._disclosed_for_segment = False\n        self._n = 0`
  - new:
```python
        self._disclosed_for_segment = False
        # Set when we spoke first into initial silence and nobody has answered yet:
        # the first far-end line after that may still be an automated menu.
        self._greeted_unanswered = False
        self._n = 0
```

- Replace the whole `_converse` method (lines 104-146) with:

```python
    async def _converse(self):
        deadline = time.monotonic() + self.max_seconds
        first_wait = True
        while True:
            if self._stop:
                return self.result("failed", error="stopped by owner")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self.state.mode != "hold":
                    await self._ensure_disclosed()
                    await self.say(policy.callback_line(self.lang))
                return self.result("needs_callback", "time limit reached")
            wait = self.initial_silence if first_wait else self.farend_timeout
            text = await self.line.next_farend(min(wait, remaining))
            if self._stop:
                return self.result("failed", error="stopped by owner")
            if text is None:
                if time.monotonic() >= deadline:
                    continue
                if first_wait:
                    # Spec 2026-10-01 §4.5: silence right after answering -> speak first.
                    # The templated disclosure ALWAYS precedes the greeting; nothing
                    # model-generated is spoken here.
                    first_wait = False
                    await self._ensure_disclosed()
                    await self.say(policy.greeting(self.lang))
                    self._greeted_unanswered = True
                    continue
                return self.result("needs_callback", "the other side went silent") if self.state.mode != "hold" else self.result("needs_callback", "left on hold")
            first_wait = False
            greeted = self._greeted_unanswered
            self._greeted_unanswered = False
            self.emit("farend", {"text": text})
            kind = classify(text)
            if kind == "sit":
                return self.result("not_in_service", text[:200])
            if kind == "voicemail":
                return self.result("voicemail", "reached voicemail")
            if kind == "hold":
                self.state.mode = "hold"
                self._disclosed_for_segment = False
                self.emit("state", {"state": "on_hold"})
                continue
            # A menu is only honored before we have started talking to a human in this segment;
            # a person saying "press 9" mid-conversation is the callee-injection case. The one
            # exception: the very first line after our speak-first greeting (a slow IVR).
            if kind == "ivr" and (not self._disclosed_for_segment or greeted):
                self.state.mode = "ivr"
                self.state.menu_text = text
            else:
                self.state.mode = "human"
            if self.state.mode == "human" and not self._disclosed_for_segment:
                await self.say(policy.disclosure(self.lang, self.owner))
                self._disclosed_for_segment = True
            self.messages.append({"role": "user", "content": text})
            done = await self._think()
            if done:
                return done
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd /home/kh0pp/crow-wt-perch-phone-card/bundles/phone/runner && uv run --extra dev pytest -q`
Expected: PASS for every test in `tests/` (the pre-existing controller and app tests plus the 7 new ones).

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git commit bundles/phone/runner/src/crow_phone/line.py bundles/phone/runner/src/crow_phone/policy.py bundles/phone/runner/src/crow_phone/controller.py bundles/phone/runner/tests/test_controller.py -m "feat(phone-runner): 120 s per typed business line; speak first after 6 s of silence"
git show --stat HEAD
```

---

### Task 7: Result delivery survives a bot that is mid-turn

**Files:**
- Modify: `bundles/phone/server/init-tables.js` (guarded ALTERs after `executeMultiple`)
- Modify: `bundles/phone/server/store.js` (`listUndelivered` at line ~193; add `deferDelivery` after `bumpDeliveryAttempt`)
- Modify: `bundles/phone/server/deliver.js:370` (owner notified once)
- Modify: `bundles/phone/server/dispatcher.js` (`sweepDeliveries`)
- Test: `tests/phone-dispatcher.test.js`, `tests/phone-store.test.js`

**Interfaces:**
- Produces: columns `phone_calls.delivery_busy INTEGER NOT NULL DEFAULT 0` and `phone_calls.delivery_retry_at TEXT`, added idempotently and safe under concurrent init.
- Produces: `store.deferDelivery(db, id, windowMinutes = 10) -> Promise<{gaveUp:boolean, delaySeconds?:number}>`.
  - Backoff: `min(60, 5·2^min(n,4))` s.
  - After `windowMinutes` past `ended_at`, it gives up: sets `delivery_attempts = 5` and writes audit `delivery_gave_up`.
- Produces: `listUndelivered` skips rows whose `delivery_retry_at` is in the future.
- Consumes: engine errors with `.code` `turn_in_progress` / `cycle_busy` (thrown from `eng.message`, passed up unchanged by the routes' `perchMessage` and by `deliverPhoneResult`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/phone-store.test.js`:

```js
// ---- spec 2026-10-01 §4.6: delivery backoff columns ----
test("initPhoneTables adds the delivery backoff columns to an existing table, idempotently and concurrently", async () => {
  const old = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-store-old-")), "crow.db"));
  await old.execute({ sql: "CREATE TABLE phone_calls (id TEXT PRIMARY KEY, status TEXT, number_e164 TEXT, started_at TEXT)", args: [] });
  await Promise.all([initPhoneTables(old), initPhoneTables(old)]);
  await initPhoneTables(old);
  const cols = (await old.execute("PRAGMA table_info(phone_calls)")).rows.map((r) => r.name);
  assert.ok(cols.includes("delivery_busy"));
  assert.ok(cols.includes("delivery_retry_at"));
});
```

Append to `tests/phone-dispatcher.test.js`:

```js
// ---- spec 2026-10-01 §4.6: a bot that is mid-turn ----
async function doneCallForPerch() {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-disp-busy-")), "crow.db"));
  await initPhoneTables(db);
  const plan = validatePlan({ business_name: "Smile", number: "512-555-0101", goal: "Book", language: "en" });
  const { call_id } = await store.createPlan(db, plan, { kind: "bot", id: "hank" }, { kind: "perch", session_id: "perch-1" });
  await db.execute({ sql: "UPDATE phone_calls SET status='done', outcome='info_gathered', ended_at=datetime('now') WHERE id=?", args: [call_id] });
  return { db, call_id };
}
const idleRunner = { start: async () => ({ ok: true }), stop: async () => {}, events: async () => ({ events: [], done: false }) };
const busyErr = () => Object.assign(new Error("turn_in_progress"), { code: "turn_in_progress" });

test("a bot mid-turn keeps the result pending with backoff, notifies the owner ONCE, then delivers", async () => {
  const { db, call_id } = await doneCallForPerch();
  const notes = []; const sent = []; let busy = 2;
  const d = createDispatcher({ db, runner: idleRunner,
    deps: { notify: async (_db, n) => { notes.push(n); }, perchMessage: async (sid) => { if (busy-- > 0) throw busyErr(); sent.push(sid); } },
    settings: () => ({ dailyCap: 10, model: () => null }) });
  await d.tick();
  let c = await store.getCall(db, call_id);
  assert.equal(c.delivered, 0); assert.equal(c.delivery_attempts, 0); assert.equal(c.delivery_busy, 1);
  const wait = (await db.execute({ sql: "SELECT (julianday(delivery_retry_at) - julianday('now')) * 86400 AS s FROM phone_calls WHERE id=?", args: [call_id] })).rows[0].s;
  assert.ok(wait > 3 && wait <= 6, "first backoff is ~5 s, got " + wait);
  await d.tick(); // backoff not elapsed -> not retried
  assert.equal((await store.getCall(db, call_id)).delivery_busy, 1);
  for (let i = 0; i < 2; i++) {
    await db.execute({ sql: "UPDATE phone_calls SET delivery_retry_at=datetime('now','-1 second') WHERE id=?", args: [call_id] });
    await d.tick();
  }
  c = await store.getCall(db, call_id);
  assert.equal(c.delivered, 1);
  assert.deepEqual(sent, ["perch-1"]);
  assert.equal(notes.length, 1, "the owner is notified once, not once per busy retry");
});

test("a bot busy for 10 minutes: delivery gives up (audited); other errors keep the 5-attempt rule", async () => {
  const { db, call_id } = await doneCallForPerch();
  await db.execute({ sql: "UPDATE phone_calls SET ended_at=datetime('now','-11 minutes') WHERE id=?", args: [call_id] });
  let tries = 0;
  const d = createDispatcher({ db, runner: idleRunner,
    deps: { notify: async () => {}, perchMessage: async () => { tries++; throw busyErr(); } },
    settings: () => ({ dailyCap: 10, model: () => null }) });
  await d.tick(); await d.tick();
  const c = await store.getCall(db, call_id);
  assert.equal(c.delivered, 0); assert.equal(c.delivery_attempts, 5); assert.equal(tries, 1);
  const ev = (await db.execute({ sql: "SELECT event FROM phone_audit WHERE call_id=? AND event='delivery_gave_up'", args: [call_id] })).rows;
  assert.equal(ev.length, 1);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- tests/phone-store.test.js tests/phone-dispatcher.test.js`
Expected: FAIL.
- The columns are missing.
- In the busy test, `delivery_busy` is `undefined` and `delivery_attempts` is 1.
- The give-up test sees `tries` 2 and no audit row.

- [ ] **Step 3: Implement the columns** (`init-tables.js`, inside `initPhoneTables`, after the `executeMultiple` call)

```js
  // Spec 2026-10-01 §4.6: busy-bot delivery backoff. Bundle-owned columns (no
  // SCHEMA_GENERATION). Guarded: the /phone mount and the panel router both run
  // this at boot, so a concurrent duplicate ALTER is expected and ignored.
  const cols = new Set((await db.execute("PRAGMA table_info(phone_calls)")).rows.map((r) => r.name));
  for (const [name, ddl] of [["delivery_busy", "INTEGER NOT NULL DEFAULT 0"], ["delivery_retry_at", "TEXT"]]) {
    if (cols.has(name)) continue;
    try { await db.execute(`ALTER TABLE phone_calls ADD COLUMN ${name} ${ddl}`); }
    catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
```

- [ ] **Step 4: Implement the store** (`store.js`)

- `listUndelivered`:
  - old `  const rows = (await db.execute({ sql: "SELECT id FROM phone_calls WHERE status='done' AND delivered=0 AND delivery_attempts < 5 ORDER BY ended_at LIMIT ?", args: [limit] })).rows;`
  - new `  const rows = (await db.execute({ sql: "SELECT id FROM phone_calls WHERE status='done' AND delivered=0 AND delivery_attempts < 5 AND (delivery_retry_at IS NULL OR delivery_retry_at <= datetime('now')) ORDER BY ended_at LIMIT ?", args: [limit] })).rows;`
- Append after `bumpDeliveryAttempt`:

```js
/** Spec 2026-10-01 §4.6: the bot is mid-turn (turn_in_progress / cycle_busy).
 *  Not a failure — keep the delivery pending and back off 5,10,20,40,60,60… s,
 *  for up to `windowMinutes` after the call ended. Then give up (the result is
 *  still in Phone and on the chat card) and audit it. */
export async function deferDelivery(db, id, windowMinutes = 10) {
  const row = (await db.execute({ sql: "SELECT delivery_busy, (julianday('now') - julianday(ended_at)) * 1440 AS age_min FROM phone_calls WHERE id=?", args: [id] })).rows[0];
  if (!row) return { gaveUp: true };
  if (row.age_min != null && row.age_min >= windowMinutes) {
    await db.execute({ sql: "UPDATE phone_calls SET delivery_attempts=5, delivery_retry_at=NULL WHERE id=?", args: [id] });
    await audit(db, id, "service", "delivery_gave_up", { reason: "the bot stayed busy", minutes: windowMinutes });
    return { gaveUp: true };
  }
  const n = Number(row.delivery_busy || 0);
  const delaySeconds = Math.min(60, 5 * 2 ** Math.min(n, 4));
  await db.execute({ sql: "UPDATE phone_calls SET delivery_busy=delivery_busy+1, delivery_retry_at=datetime('now', ?) WHERE id=?", args: [`+${delaySeconds} seconds`, id] });
  return { gaveUp: false, delaySeconds };
}
```

- [ ] **Step 5: Notify the owner once** (`deliver.js`)

- old `  if (!(call.delivery_attempts > 0)) {`
- new `  if (!(call.delivery_attempts > 0) && !(call.delivery_busy > 0)) { // first attempt only — busy deferrals are retries too`

- [ ] **Step 6: Back off in the sweep** (`dispatcher.js`)

- old:
```js
      } catch (e) {
        await store.bumpDeliveryAttempt(db, c.id);
        console.warn(`[phone] delivery failed for ${c.id}: ${e.message}`);
      }
```
- new:
```js
      } catch (e) {
        if (e && BUSY_CODES.has(e.code)) {
          // §4.6: the bot is mid-turn. Keep the delivery pending with backoff
          // (the terminal card was already pushed this tick by flushCards).
          const r = await store.deferDelivery(db, c.id);
          if (r.gaveUp) console.warn(`[phone] gave up delivering ${c.id}: the bot stayed busy for 10 minutes`);
          continue;
        }
        await store.bumpDeliveryAttempt(db, c.id);
        console.warn(`[phone] delivery failed for ${c.id}: ${e.message}`);
      }
```
and below `const cap = …` add:
```js
const BUSY_CODES = new Set(["turn_in_progress", "cycle_busy"]); // perch-interactive.js engineError codes
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npm test -- tests/phone-store.test.js tests/phone-dispatcher.test.js tests/phone-deliver.test.js tests/phone-installed-layout.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 8: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git commit bundles/phone/server/init-tables.js bundles/phone/server/store.js bundles/phone/server/deliver.js bundles/phone/server/dispatcher.js tests/phone-store.test.js tests/phone-dispatcher.test.js -m "fix(phone): a busy bot keeps the result pending (backoff, 10 min) instead of losing it after 10 s"
git show --stat HEAD
```

---

### Task 8: Docs, version 0.2.0, registry, full suite

**Files:**
- Modify: `docs/guide/phone.md` (step 2 of "How it works"; new section "Approving from the chat" after "How it works"; "This release" timing note)
- Modify: `bundles/phone/manifest.json` (`version`, `notes`)
- Modify: `bundles/phone/server/mcp.js:250` (`McpServer` version string)
- Modify (generated): `registry/add-ons.json`
- Test: `tests/phone-installed-layout.test.js` (manifest/server version agreement)

**Interfaces:**
- Produces: manifest `version: "0.2.0"`. A differing version is what makes `refreshVersionedBundle` refresh installed copies.

- [ ] **Step 1: Write the failing test** (append to `tests/phone-installed-layout.test.js`)

```js
test("bundle version 0.2.0 (Perch call card) — the manifest and the MCP server agree", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(join(ROOT, "bundles", "phone", "manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.2.0");
  const mcpSrc = readFileSync(join(SRC, "mcp.js"), "utf8");
  assert.match(mcpSrc, /new McpServer\(\{ name: "crow-phone", version: "0\.2\.0" \}\)/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test -- tests/phone-installed-layout.test.js`
Expected: FAIL, `'0.1.0' !== '0.2.0'`.

- [ ] **Step 3: Bump the versions**

- `bundles/phone/manifest.json`:
  - old `  "version": "0.1.0",`
  - new `  "version": "0.2.0",`
  - old `  "notes": "Plan A: calls run on a simulated line (FakeLine). The Bluetooth phone line arrives in a later release. Every call needs owner approval."`
  - new `  "notes": "Calls run on a simulated line (you type the business's lines). Approve and follow a call from the Perch chat that asked for it, or from Crow's Nest → Phone. The Bluetooth phone line arrives in a later release. Every call needs owner approval."`
- `bundles/phone/server/mcp.js`:
  - old `  const server = new McpServer({ name: "crow-phone", version: "0.1.0" });`
  - new `  const server = new McpServer({ name: "crow-phone", version: "0.2.0" });`

Then regenerate the registry:

```bash
cd /home/kh0pp/crow-wt-perch-phone-card && npm run build-registry && node scripts/build-registry.mjs --check && git diff --stat registry/add-ons.json
```
Expected: `--check` exits 0, and the registry diff touches only the phone entry (version + notes).

- [ ] **Step 4: Write the docs** (`docs/guide/phone.md`)

- In "How it works":
  - old `2. Open **Crow's Nest → Phone**, review, tick **This is a business**, optionally`
  - new `2. Approve it **in the chat** (see below), or open **Crow's Nest → Phone**: review, tick **This is a business**, optionally`
- Insert after the "How it works" list, before `## Setup`:

```markdown
## Approving from the chat
When you ask a bot for a call in a **Perch** chat, the plan appears right there as a
**call card**, so you never have to leave the conversation (handy on a phone):

- **Waiting for your approval:** the business, number, goal and limits, and the details the
  assistant may share. Edit a detail, or clear it to withhold it. Tick **This is a business**,
  optionally **Allow cloud model for this call**, enter your 2FA code when 2FA is on, then
  **Approve now**, **Approve for…** a date and time, or **Reject**.
- **Live call:** the transcript updates as the call runs. On the simulated line, type what the
  business says into **Business says…** and press **Send**. When the business answers and nobody
  has typed yet, the card says *"The business answered — type what they say."*
  **Stop call** ends it at any time.
- **Finished:** the outcome, a short summary and any booking, with a link to the full record in
  **Phone**. The bot gets the result in the same chat; if it is busy, Crow keeps retrying for up
  to 10 minutes.

The card uses exactly the same checks as the Phone panel:
- Only a **password sign-in on this Crow** can approve, reject or type the business's lines.
  Someone viewing the chat through a peer sign-in sees the call's status and can only stop it.
- The approval covers exactly the plan you saw. If the plan changed in the meantime (edited in
  Phone, say), the card asks you to review it again.
- Calls proposed from Gmail, Discord or Telegram still appear only in **Phone**.
```

- In "This release":
  - old `and watch the assistant respond. This lets you try the whole flow safely. The real`
  - new:
```
and watch the assistant respond. You get two minutes for each line. If you say nothing for
six seconds after the call is answered, the assistant speaks first: its disclosure, then "Hello?".
This lets you try the whole flow safely. The real
```

- [ ] **Step 5: Run the test, then the full suite**

Run: `npm test -- tests/phone-installed-layout.test.js`
Expected: PASS.

Run: `cd /home/kh0pp/crow-wt-perch-phone-card && npm test`
Expected: the full suite passes with 0 failures (scratch env; never touches `~/.crow`).

Run: `cd /home/kh0pp/crow-wt-perch-phone-card/bundles/phone/runner && uv run --extra dev pytest -q`
Expected: all runner tests pass.

Run: `cd /home/kh0pp/crow-wt-perch-phone-card && node scripts/check-port-allocation.js && node scripts/build-registry.mjs --check`
Expected: both exit 0 (no new ports).

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-perch-phone-card
git commit docs/guide/phone.md bundles/phone/manifest.json bundles/phone/server/mcp.js registry/add-ons.json tests/phone-installed-layout.test.js -m "docs(phone): approving from the chat; bundle 0.2.0"
git show --stat HEAD
```

- [ ] **Step 7: Live acceptance on crow (spec §5), after the merge and deploy. Not part of CI.**

Before any model start, read `/home/kh0pp/CROW-SCHEDULE.md` and register the window. Then:
1. Open a Perch chat with hank and ask for a call. The card appears.
2. Approve in the card (with 2FA when it is on). The card goes live.
3. The assistant speaks first after about 6 s.
4. Type the business lines. The outcome shows on the card, and hank reports the result in the chat.

Clear the schedule entry afterwards.

---

## Self-review

**Spec coverage:**

| Spec item | Task | Test |
|---|---|---|
| I1 gates unchanged | 1, 4, 5 | routes: SSO 403 with a valid hash, wrong TOTP 403 pushes nothing; card: actions only on `/api/phone/calls/:id/*`, CSRF header, no ask/answer |
| I2 gateway-built card | 4, 5 | `cardFrame` exact keys; dispatcher frame keys; card fetches by call_id; `notifyCard` drops non-primitives |
| I3 delivery target verified | 3, 4 | engine `bot_mismatch`/`bot_required`; MCP forged thread → no card + one audit row; audit-once |
| I4 approve what was shown | 1 | store pre-check, deterministic CAS race, edit-then-approve; route 400/409; panel sends hash |
| I5 per-session scoping | 2 | store and route: other session, forged bot, non-perch, no-bot, max 20, local only |
| I6 rendering | 5 | no HTML sinks, no backticks or `${` in the snippet; hub keeps one innerHTML |
| I7 non-local viewers | 2, 5 | whoami for SSO; `phoneControls` (Stop only); pointer card |
| §4.1 engine hook | 3 | resident only, no adopt or wake, hibernating delivery, not persisted |
| §4.2 push points | 4 | plan, dispatcher live/transcript/terminal, failed start, approve/reject/edit |
| §4.3 routes | 1, 2 | list, whoami, approve `plan_hash` |
| §4.4 client card | 5 | static + pure-function tests, i18n parity, styles |
| §4.5 runner timing | 6 | 120/20 s per line, speak-first (en/es), business-first unchanged, IVR after greeting |
| §4.6 delivery hardening | 4, 7 | terminal frame before delivery; backoff, notify-once, 10-min give-up |
| §4.7 versioning | 8 | manifest and server 0.2.0, registry check |

**Placeholder scan:** no TBD/TODO/"similar to". Every step carries its code or exact command.

**Name consistency:**
- `expectedHash` (store option) vs `plan_hash` (HTTP body / client), used consistently.
- `notifyCard(sid, frame, {botId})` has the same signature in the engine, mount, routes, dispatcher deps and test fakes.
- `pushCallCard(db, call, notifyCard)` and `cardFrame(call)`.
- `listPerchCalls(db, sid, botId, limit)`, `totpRequired(deps)`, `deferDelivery(db, id, windowMinutes)`.
- Client: `resetPhoneCards`, `loadPhoneCards`, `phoneFrame`, `phoneBuf`. The three `resetPhoneCards();` hooks plus the one `loadPhoneCards(current.sid);` hook match the regexes in `tests/perch-phone-card.test.js`.
- The guard count is 5 in the snippet; the hub total is 18 + 5 = 23, recomputed after the rebase.
