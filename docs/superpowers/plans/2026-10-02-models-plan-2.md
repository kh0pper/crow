# Models arc plan 2 of 4: replication fix, gateway doors, lifecycle API, pi contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a native model reachable and controllable from anywhere on the tailnet through the owning gateway (the door and the lifecycle API), make provider changes actually reach paired peers again (black-swan has been stalled since 2026-08-20), and make pi see exactly the providers Crow has, so plan 4 can convert rows without breaking consumers.

**Architecture:** One crow PR (`feat/models-doors`) plus one pi-lab change delivered through a handoff file. Order: the replication fix first (its own failing two-instance test), then the reconciler guard (I5), then the door as a pure resolver plus thin route changes, then the lifecycle API (pure job store and listing builder, then routes), then the pi models.json managed sync (M1), the pre-spawn check (M2) and the picker marks (M3), then the pi-lab `lib/local-models.mjs` gateway mode. Nothing here converts a provider row, deletes a bundle or starts a model; two operational steps after merge mark the gufo slots external and run a ~30-minute acceptance window.

**Tech Stack:** Node 24 (`export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH` before every node/npm command), `node:test` through the scratch harness, express routes, `@libsql/client` via `servers/db.js`, the InstanceSyncManager stub-feed harness (`tests/providers-war-sim.test.js` pattern).

**Spec:** `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md` §5 (doors, lifecycle API, pi contract), §7 step 0, §8, §9, and **§11 Amendment A** (§11.3 external interim, §11.4 door rulings, §11.6 M1–M3, §11.7 I5, §11.8 replication). Plan 1 (shipped as #305/#306) built `door.js`, `native-locality.js`, the owner gate and `NOT_OWNER`.

## Global Constraints

- Work in a worktree: `git worktree add ~/crow-wt-models-doors -b feat/models-doors origin/main`. Never `git checkout` in `~/crow`.
- Commit with positional paths: `git add <new files>` then `git commit <paths> -m "…"`; verify with `git show --stat HEAD`. Never `git add -A`. No AI attribution anywhere.
- Single test files ONLY through the harness: `npm test -- tests/<file>.test.js`. Never bare `node --test` (it writes the live `crow.db`).
- CI must be green before merge: query `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` and require `suite`, `static-checks`, `audit` all `completed`/`success`.
- No `SCHEMA_GENERATION` bump, no DDL. New persisted state lives in `dashboard_settings` keys (never allow-listed for sync) or files under `CROW_HOME`.
- Every new dashboard string ships `en` + `es` (`tests/i18n-global-parity.test.js`). Panel client JS is emitted inside template literals: no backticks, no stray `${`, createElement/textContent only.
- The door stays unauthenticated on the tailnet and loopback, and is never Funnel-exposed (`/llm` is not in `PUBLIC_FUNNEL_PREFIXES`). Run `tests/auth-network.test.js` after touching mounts.
- Never on crow without a registered window: no gateway restart, no model start/stop, no DB write on `~/.crow`. Deploys ride auto-update only when `node scripts/ops/box-reserve.mjs status` prints `none` and no CROW-SCHEDULE row is active.
- pi-lab's repo (`~/pi-lab`) is changed only through the handoff file in Task 12; the crow PR must keep working with pi-lab's current compose-based `localModels`.

## Review Focus

1. **A companion turn that names a bare id** (`qwen3.5-4b`, `qwen3.6-35b-a3b`, `crow`) must keep the fast/escalate heuristics; explicit addressing must never capture it. Test: Task 4 "companion alias ids still route by heuristics".
2. **A cloud provider addressed through the door** (`X-Crow-Provider: qwen-cloud`) must be refused, not proxied with its key. Test: Task 3 "cloud rows are refused".
3. **Two gateways on one box** (crow `:3001`, r4 `:3008`): a door forwarding to a foreign-owned row that points back at a door must stop at one hop. Test: Task 4 "a second hop answers 508".
4. **A hand-written `models.json` entry with the same id as a DB row** (`crow-local`) must never be rewritten or removed by the managed sync. Test: Task 9 "hand-written entries are never touched".
5. **`pi --list-models` failing or slow** must not block every bot turn. Test: Task 10 "a failed listing lets the turn proceed".

---

## File structure

| File | Responsibility |
|---|---|
| `servers/sharing/instance-sync.js` | Task 1: persist a "peer is behind" marker when a providers entry parks for an unarmed peer; catch up behind peers at boot and when a feed arms. |
| `servers/shared/providers-db.js` | Task 2: reconciler skips native rows (I5) and `$crowManaged` ids; Task 9: `setProviderChangeHook`. |
| `servers/gateway/models/door-resolve.js` (new) | Task 3: pure door addressing (`resolveDoorTarget`, `listDoorModels`, header names). |
| `servers/gateway/routes/llm-router.js` | Task 4: explicit addressing before the companion heuristics; `/completions`, `/embeddings`, `/rerank`; `/llm/v1/models` lists door models. |
| `servers/gateway/process-supervisor.js`, `servers/gateway/models/runtime.js` | Task 5: last-40-lines stderr ring buffer on every supervised child. |
| `servers/gateway/local-token.js` | Task 6: the path-scoped `models-token`. |
| `servers/gateway/models/lifecycle.js` (new) | Task 7: job store and the `GET /llm/models` listing builder (pure). |
| `servers/gateway/routes/llm-models.js` (new), `servers/gateway/gpu-orchestrator.js`, `servers/gateway/boot/late-mounts.js` | Task 8: lifecycle routes, `stopNativeProvider`, `nativeSnapshot`, mount. |
| `servers/shared/pi-models-sync.js` (new), `servers/gateway/boot/admin-api.js` | Task 9: M1 managed entries in pi's `models.json`. |
| `scripts/pi-bots/pi-model-catalog.mjs` (new), `scripts/pi-bots/bot-world.mjs`, `scripts/pi-bots/job_runner.mjs` | Task 10: M2 pre-spawn validation. |
| `servers/gateway/dashboard/panels/bot-builder/data-queries.js`, `…/editor.js`, `servers/gateway/dashboard/shared/i18n.js` | Task 11: M3 picker marks. |
| `~/pi-lab/docs/handoffs-inbox-2026-10-0X-from-crow-models-gateway-contract.md` (new, in pi-lab) | Task 12: the pi-lab change, with code and tests. |
| `docs/architecture/models.md` | Task 13: door, lifecycle API, managed sync. |
| Tests | `tests/providers-replication-gate.test.js`, `tests/providers-reconcile-native-guard.test.js`, `tests/door-resolve.test.js`, `tests/llm-router-door.test.js`, `tests/process-supervisor-stderr.test.js`, `tests/models-token.test.js`, `tests/models-lifecycle.test.js`, `tests/llm-models-routes.test.js`, `tests/pi-models-sync.test.js`, `tests/pi-model-catalog.test.js`, `tests/bot-builder-model-marks.test.js`. |

---

### Task 1: Replication — diagnose black-swan, pin it with a failing two-instance test, fix

Spec §11.8. The audit (2026-10-02) found black-swan's `providers` at max lamport 5054 (2026-08-20) against crow's 6641, and 1 memory against 59: crow's changes stopped arriving across tables. r4 (separate identity) and grackle (decommissioning) are out of scope.

**Files:**
- Modify: `servers/sharing/instance-sync.js` (`_appendToPeer` at the `parked` branch; `backfillProvidersForNewPeers`; `_initInstanceInner` after `_drainPendingEmits`)
- Test: `tests/providers-replication-gate.test.js`

**Interfaces:**
- Consumes: `InstanceSyncManager` (`emitChange`, `_appendToPeer`, `_processNewEntries`, `backfillProvidersForNewPeers`, `outFeeds`), `upsertProvider`, `disableProvider`, `setProviderSyncManager` from `servers/shared/providers-db.js`.
- Produces: `BEHIND_FLAG_PREFIX = "__sync_behind_v1:"` (dashboard_settings key prefix, value = the lowest parked providers lamport as a decimal string); `InstanceSyncManager#_markPeerBehind(peerId, lamport) -> Promise<void>`; `InstanceSyncManager#catchUpBehindPeers(peerIds?: string[]) -> Promise<number>` (entries re-emitted).

- [ ] **Step 1: Read-only diagnosis (15 minutes, no writes anywhere).** Record every output in the PR description.

```bash
# crow: black-swan's peer row and crow's own counter
sqlite3 -readonly ~/.crow/data/crow.db "SELECT id, name, status, last_seen_at, tailscale_ip, sync_url FROM crow_instances WHERE name LIKE '%swan%' OR hostname LIKE '%swan%';"
sqlite3 -readonly ~/.crow/data/crow.db "SELECT instance_id, local_counter, last_applied_seq_per_peer FROM sync_state;"
# crow: is the out-feed to black-swan armed? parked-emit warnings and overflow drops since 08-19
sudo journalctl -u crow-gateway --since 2026-08-19 --no-pager | grep -E "instance-sync|tailnet-sync" | grep -iE "77ac9c01|pending emit|overflow|parked|feed for" | tail -n 60
# black-swan: what it has applied from crow, and why it stopped
ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT instance_id, local_counter, last_applied_seq_per_peer FROM sync_state;"'
ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT id, name, status, last_seen_at FROM crow_instances;"'
ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT MAX(lamport_ts), MAX(updated_at) FROM providers;"'
ssh black-swan 'sudo journalctl -u crow-gateway --since 2026-08-19 --no-pager | grep -E "instance-sync|tailnet-sync" | grep -iE "0867ac28|Failed to process|Signature|dead feed|reset to 0|invalid_token" | tail -n 60'
```

Classify the stall with this table. Exactly one row should match; if none does, stop and report NEEDS_DECISION with the outputs.

| id | evidence | stage | what to do |
|---|---|---|---|
| **H1** | crow logs `pending emit queue overflow for <black-swan id>` or no `appended` path to it; black-swan's applied seq for crow equals its feed length (nothing new arrives) | crow never appended to black-swan's out-feed (feed unarmed); parked entries were dropped at the 256 cap or lost at a restart | Steps 2–6 below |
| H2 | black-swan logs `Signature verification failed` or `Failed to process entry` for crow's id | black-swan rejects entries | Stop; report with the failing entry's table/op |
| H3 | crow's `crow_instances` row for black-swan is `paused` or `revoked` | crow no longer targets it (`emitChange` only targets `active`/`offline`) | Stop; this is an operator state, report it |
| H4 | black-swan logs `belonged to a dead feed — reset to 0` repeatedly or `invalid_token` | feed rotation or pairing auth loop | Stop; report with the log lines |

- [ ] **Step 2: Write the gate test (H1 case is the red one; the other two are guards that must already pass).**

```js
// tests/providers-replication-gate.test.js
//
// The executable gate for spec §7 step 0 / §11.8. Two real init-db.js
// databases, two real InstanceSyncManagers, stub feeds (no Hypercore), the
// shared test identity — the providers-war-sim.test.js harness. Three cases:
//   1. guard: a DISABLE reaches an armed peer;
//   2. guard: a bundle -> native CONVERSION reaches an armed peer and keeps
//      its door + owner (the peer must not localize a row it does not own);
//   3. RED today (H1): a change emitted while the peer's out-feed is UNARMED
//      parks in RAM; after a restart (new manager over the same DB) and the
//      boot hook, the peer still never receives it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { upsertProvider, disableProvider, setProviderSyncManager } from "../servers/shared/providers-db.js";
import { localizeNativeRow } from "../servers/shared/native-locality.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const A_ID = "aaaaaaaa-0000-0000-0000-00000000000a"; // crow (owner)
const B_ID = "bbbbbbbb-0000-0000-0000-00000000000b"; // black-swan (peer)

const dirA = mkdtempSync(join(tmpdir(), "repl-gate-A-"));
const dirB = mkdtempSync(join(tmpdir(), "repl-gate-B-"));
for (const dir of [dirA, dirB]) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
}
const PREV_DATA_DIR = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = dirA;

const TEST_PRIV = Buffer.alloc(32, 0xCD);
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex") };

const dbA = createDbClient(join(dirA, "crow.db"));
const dbB = createDbClient(join(dirB, "crow.db"));

// Each stub feed gets its own key: B's applied-seq record is feed-keyed (2d
// C2), so a fresh feed in a later test starts at seq 0 instead of inheriting
// the previous test's checkpoint and silently skipping entries.
let _feedN = 0;
function stubFeed() {
  const feed = {
    key: Buffer.alloc(32, ++_feedN),
    entries: [],
    get length() { return feed.entries.length; },
    async get(seq) { return feed.entries[seq]; },
    async append(e) { feed.entries.push(e); return feed.entries.length - 1; },
  };
  return feed;
}
function manager(db, id) {
  const m = new InstanceSyncManager(IDENTITY, db, id);
  m.feedsDisabled = false;
  return m;
}
async function pairOnA() {
  await dbA.execute({
    sql: `INSERT OR IGNORE INTO crow_instances (id, name, crow_id, status) VALUES (?, 'black-swan', 'crow:test', 'active')`,
    args: [B_ID],
  });
}
async function rowOn(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] || null;
}

after(() => {
  setProviderSyncManager(null);
  if (PREV_DATA_DIR === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = PREV_DATA_DIR;
  try { dbA.close(); } catch {}
  try { dbB.close(); } catch {}
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("guard: a disable reaches an armed peer", async () => {
  await pairOnA();
  const mgrA = manager(dbA, A_ID);
  const mgrB = manager(dbB, B_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  setProviderSyncManager(mgrA);
  await upsertProvider(dbA, { id: "g-disable", baseUrl: "http://100.64.9.1:8003/v1", host: "local", models: [{ id: "m" }] });
  await disableProvider(dbA, "g-disable");
  await mgrB._processNewEntries(A_ID, feed);
  const b = await rowOn(dbB, "g-disable");
  assert.ok(b, "the row arrived on the peer");
  assert.equal(Number(b.disabled), 1, "the disable arrived on the peer");
});

test("guard: a bundle -> native conversion reaches an armed peer and keeps its door", async () => {
  await pairOnA();
  const mgrA = manager(dbA, A_ID);
  const mgrB = manager(dbB, B_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  setProviderSyncManager(mgrA);
  await upsertProvider(dbA, { id: "g-conv", baseUrl: "http://100.64.9.1:8004/v1", host: "local", bundleId: "llamacpp-vulkan-qwen3-embed", models: [{ id: "qwen3-embedding-0.6b" }] });
  const door = "http://100.64.9.1:3001/llm/v1";
  await upsertProvider(dbA, {
    id: "g-conv", baseUrl: door, host: "local", bundleId: null, models: [{ id: "qwen3-embedding-0.6b" }],
    gpuPolicy: { runtime: "native", catalogId: "qwen3-embedding-0.6b", quant: "Q8_0", port: 18101, owner: A_ID },
  });
  await mgrB._processNewEntries(A_ID, feed);
  const b = await rowOn(dbB, "g-conv");
  assert.equal(b.base_url, door, "the peer holds the door");
  assert.equal(b.bundle_id, null, "bundle id cleared on the peer");
  const gp = JSON.parse(b.gpu_policy);
  assert.equal(gp.runtime, "native");
  assert.equal(gp.owner, A_ID);
  const localized = localizeNativeRow({ baseUrl: b.base_url, gpuPolicy: gp }, B_ID);
  assert.equal(localized.baseUrl, door, "a peer never rewrites a foreign-owned row to its own loopback");
});

test("RED before the fix (H1): changes parked for an unarmed peer survive a restart and reach the peer (new row AND a disable of a row it already holds)", async () => {
  await pairOnA();
  // Both instances hold the same old row, as after a long-ago successful sync.
  for (const db of [dbA, dbB]) {
    await db.execute({ sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id) VALUES ('g-stale', 'http://100.64.9.1:8012/v1', 'local', '[{"id":"s"}]', 0, 3, ?)`, args: [A_ID] });
  }
  // Boot 1: the peer is paired but its out-feed never armed.
  const mgrA1 = manager(dbA, A_ID);
  const mgrB = manager(dbB, B_ID);
  setProviderSyncManager(mgrA1);
  await upsertProvider(dbA, { id: "g-parked", baseUrl: "http://100.64.9.1:8011/v1", host: "local", models: [{ id: "parked" }] });
  await disableProvider(dbA, "g-stale");
  assert.equal(mgrA1.pendingEmitStats()[B_ID] >= 1, true, "the entry parked in RAM");
  // Mark the peer as already backfilled, as a long-paired peer is in production.
  await dbA.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, 'done:1')", args: ["__providers_backfill_v1:" + B_ID] });

  // Restart: the RAM queue is gone. Boot 2 arms the feed and runs the boot hook.
  const mgrA2 = manager(dbA, A_ID);
  setProviderSyncManager(mgrA2);
  const feed = stubFeed();
  mgrA2.outFeeds.set(B_ID, feed);
  await mgrA2.backfillProvidersForNewPeers();

  await mgrB._processNewEntries(A_ID, feed);
  const b = await rowOn(dbB, "g-parked");
  assert.ok(b, "the change emitted while the peer was unarmed must reach it after a restart");
  assert.equal(Number((await rowOn(dbB, "g-stale")).disabled), 1, "the disable of a row the peer already held arrives too");
  const { rows } = await dbB.execute("SELECT COUNT(*) AS n FROM sync_conflicts");
  assert.equal(Number(rows[0].n), 0, "catch-up is conflict-free");
});

test("the behind-marker keeps the LOWEST parked lamport and is cleared after catch-up", async () => {
  await pairOnA();
  const mgrA = manager(dbA, A_ID);
  await mgrA._markPeerBehind(B_ID, 40);
  await mgrA._markPeerBehind(B_ID, 90);
  await mgrA._markPeerBehind(B_ID, 30);
  const { rows } = await dbA.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: ["__sync_behind_v1:" + B_ID] });
  assert.equal(rows[0].value, "30");
  mgrA.outFeeds.set(B_ID, stubFeed());
  await mgrA.catchUpBehindPeers([B_ID]);
  const after = await dbA.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: ["__sync_behind_v1:" + B_ID] });
  assert.equal(after.rows.length, 0, "marker cleared once the peer's feed carried the catch-up");
});

test("catch-up never re-emits a loopback or local_only row (shouldSyncRow parity)", async () => {
  await pairOnA();
  const mgrA = manager(dbA, A_ID);
  setProviderSyncManager(null); // write without emitting
  await upsertProvider(dbA, { id: "g-loop", baseUrl: "http://127.0.0.1:18100/v1", host: "local", models: [{ id: "x" }] });
  await mgrA._markPeerBehind(B_ID, 0);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  await mgrA.catchUpBehindPeers([B_ID]);
  assert.equal(feed.entries.some((e) => e.row && e.row.id === "g-loop"), false);
});
```

- [ ] **Step 3: Run it; expect cases 1, 2 PASS and case 3 FAIL** ("the change emitted while the peer was unarmed must reach it after a restart"), cases 4–5 FAIL with `mgrA._markPeerBehind is not a function`.

Run: `npm test -- tests/providers-replication-gate.test.js`

If case 1 or 2 fails, that is the bug (not H1): stop, keep the failing case as the red test, and report the stage before changing code.

- [ ] **Step 4: Implement the behind-marker and catch-up in `servers/sharing/instance-sync.js`.**

Near the top-level constants (after `SYNCED_TABLES`):

```js
/** dashboard_settings key prefix: `<prefix><peerId>` = the lowest providers
 * lamport that parked for that peer while its out-feed was unarmed. Never
 * allow-listed for sync (dashboard_settings rows sync only by allowlist). */
export const BEHIND_FLAG_PREFIX = "__sync_behind_v1:";
```

In `_appendToPeer`, replace the parked branch (the lines from `if (strict) return "parked";` to the final `return "parked";`) with:

```js
      if (strict) return "parked";
      const slot = this._pendingPeerEmits.get(peerId) || [];
      slot.push(entry);
      if (slot.length > 256) {
        slot.shift();
        console.warn(`[instance-sync] pending emit queue overflow for ${peerId} — dropped oldest (LWW-safe direction)`);
      }
      this._pendingPeerEmits.set(peerId, slot);
      // RAM parking does not survive a restart or the 256 cap. Providers are
      // the fleet's routing table, so remember durably that this peer is
      // behind and re-emit from the lowest parked lamport once its feed arms
      // (catchUpBehindPeers). Spec §11.8 / plan 2 Task 1, hypothesis H1.
      if (entry.table === "providers") {
        await this._markPeerBehind(peerId, Number(entry.lamport_ts) || 0);
      }
      return "parked";
```

Add the two methods to the class (beside `backfillProvidersForNewPeers`):

```js
  /** Persist "peer is behind from lamport L" keeping the LOWEST L. Never throws. */
  async _markPeerBehind(peerId, lamport) {
    try {
      await this.db.execute({
        sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = CAST(MIN(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
        args: [BEHIND_FLAG_PREFIX + peerId, String(Math.max(0, Math.floor(lamport)))],
      });
    } catch (err) {
      console.warn(`[instance-sync] could not mark ${peerId} behind: ${err.message}`);
    }
  }

  /**
   * Re-emit every syncable providers row with lamport_ts >= the peer's
   * behind-marker (as an update then an insert, see below), preserving each
   * row's lamport (a redelivery must never fabricate recency), then clear the
   * marker. Only peers whose out-feed is
   * ARMED are caught up; an unarmed peer keeps its marker for the next try.
   * The re-emit broadcasts through emitChange like the new-peer backfill
   * (accepted re-delivery cost: LWW makes it a no-op elsewhere).
   * @param {string[]} [peerIds] default: every armed out-feed
   * @returns {Promise<number>} entries re-emitted
   */
  async catchUpBehindPeers(peerIds = [...this.outFeeds.keys()]) {
    let emitted = 0;
    for (const peerId of peerIds) {
      if (!this.outFeeds.has(peerId)) continue;
      let from = null;
      try {
        const { rows } = await this.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [BEHIND_FLAG_PREFIX + peerId] });
        if (rows.length) from = Number(rows[0].value);
      } catch { from = null; }
      if (from === null || !Number.isFinite(from)) continue;
      const { rows } = await this.db.execute({
        sql: "SELECT * FROM providers WHERE COALESCE(lamport_ts, 0) >= ? ORDER BY lamport_ts ASC",
        args: [from],
      });
      for (const row of rows) {
        if (!shouldSyncRow("providers", row)) continue;
        // Each row goes out as an UPDATE then an INSERT. The update lands on a
        // peer that holds a stale copy (LWW by lamport; a missing row is a
        // no-op). The insert creates the row on a peer that never had it, and
        // is benign re-delivery where the update already applied
        // (_applyInsert's rowsEquivalent check) — so no conflict rows either way.
        // An insert alone would log a conflict on every stale copy; an update
        // alone would never create a missing row.
        for (const op of ["update", "insert"]) {
          const res = await this.emitChange("providers", op, row, { lamportTs: Number(row.lamport_ts) || 0 });
          if (op === "insert" && res !== null && res !== undefined) emitted++;
        }
      }
      await this.db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [BEHIND_FLAG_PREFIX + peerId] });
      console.log(`[instance-sync] providers catch-up for ${peerId.slice(0, 12)}…: re-emitted ${rows.length} row(s) from lamport ${from}`);
    }
    return emitted;
  }
```

At the end of `backfillProvidersForNewPeers` (every return path that is reached with armed feeds), run the catch-up. Rename the existing body to `_backfillProvidersForNewPeersInner` and wrap it:

```js
  async backfillProvidersForNewPeers() {
    const n = await this._backfillProvidersForNewPeersInner();
    try {
      await this.catchUpBehindPeers();
    } catch (err) {
      console.warn(`[instance-sync] providers catch-up failed: ${err.message}`);
    }
    return n;
  }
```

In `_initInstanceInner`, immediately after the existing `const drainDone = this._drainPendingEmits(remoteInstanceId);` statement and its handling, chain the catch-up so an in-process arming (no restart) also recovers what the 256 cap dropped:

```js
      drainDone
        .then(() => this.catchUpBehindPeers([remoteInstanceId]))
        .catch((err) => console.warn(`[instance-sync] catch-up after arming ${remoteInstanceId} failed: ${err.message}`));
```

(Keep the existing use of `drainDone` untouched; add this as a separate fire-and-forget line right after it. It must not be awaited inside the `_initLocks` chain, because `emitChange` takes the per-peer append chain.)

- [ ] **Step 5: Run the gate and the neighbours.**

Run: `npm test -- tests/providers-replication-gate.test.js tests/providers-backfill.test.js tests/providers-war-sim.test.js tests/instance-sync.test.js tests/sync-emit.test.js tests/sync-outbox-drain.test.js`
Expected: all PASS. If `providers-backfill.test.js` counts emitted entries, the catch-up adds none there (no marker is written in those tests); if a count moves, read why before changing an assertion.

- [ ] **Step 6: Commit.**

```bash
git add tests/providers-replication-gate.test.js
git commit servers/sharing/instance-sync.js tests/providers-replication-gate.test.js -m "fix(sync): providers parked for an unarmed peer are caught up after a restart or arming (black-swan stall since 08-20)"
```

---

### Task 2: Reconciler guard — never de-native a row, never re-import managed entries (I5)

Spec §11.7.

**Files:**
- Modify: `servers/shared/providers-db.js` (`readModelsJson`, `syncProvidersFromModelsJson`)
- Test: `tests/providers-reconcile-native-guard.test.js`

**Interfaces:**
- Consumes: `syncProvidersFromModelsJson(db, { force, ownAddrs })`.
- Produces: counters `skipped_native` and `skipped_managed` in its return value; `readModelsJson()` returns `{ path, config, managedIds: Set<string> }` (the union of every file's top-level `$crowManaged` array). Task 9 writes `$crowManaged`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/providers-reconcile-native-guard.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { upsertProvider, syncProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";

const dir = mkdtempSync(join(tmpdir(), "reconcile-guard-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prev = { dd: process.env.CROW_DATA_DIR, mj: process.env.CROW_MODELS_JSON };
process.env.CROW_DATA_DIR = dir;
const file = join(dir, "models.json");
process.env.CROW_MODELS_JSON = file;
const db = createDbClient(join(dir, "crow.db"));
setProviderSyncManager(null);
const OWN = new Set(["127.0.0.1", "100.64.9.1"]);

after(() => {
  for (const [k, v] of [["CROW_DATA_DIR", prev.dd], ["CROW_MODELS_JSON", prev.mj]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function row(id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

test("a converted native row is never rebuilt from models.json", async () => {
  const gp = { runtime: "native", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", port: 18102, owner: "me", mutexGroup: "crow-strix-vram" };
  await upsertProvider(db, { id: "crow-local", baseUrl: "http://100.64.9.1:3001/llm/v1", host: "local", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: gp });
  writeFileSync(file, JSON.stringify({ providers: { "crow-local": { baseUrl: "http://100.64.9.1:8003/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  const res = await syncProvidersFromModelsJson(db, { ownAddrs: OWN });
  assert.equal(res.skipped_native, 1);
  const r = await row("crow-local");
  assert.equal(r.base_url, "http://100.64.9.1:3001/llm/v1", "door kept");
  assert.equal(JSON.parse(r.gpu_policy).runtime, "native", "still native");
});

test("an id listed in $crowManaged is never imported or asserted", async () => {
  writeFileSync(file, JSON.stringify({
    $crowManaged: ["crow-chat"],
    providers: { "crow-chat": { baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const res = await syncProvidersFromModelsJson(db, { ownAddrs: OWN });
  assert.equal(res.skipped_managed, 1);
  assert.equal(await row("crow-chat"), undefined, "the managed entry was not imported as a new row");
});

test("hand-written owned entries still assert as before (no over-exclusion)", async () => {
  writeFileSync(file, JSON.stringify({ providers: { "crow-local-oss": { baseUrl: "http://100.64.9.1:8005/v1", apiKey: "none", models: [{ id: "gpt-oss-120b" }] } } }));
  const res = await syncProvidersFromModelsJson(db, { ownAddrs: OWN });
  assert.equal(res.upserted + res.unchanged, 1);
  assert.ok(await row("crow-local-oss"));
});
```

- [ ] **Step 2: Run, expect FAIL** (`res.skipped_native` is `undefined`).

Run: `npm test -- tests/providers-reconcile-native-guard.test.js`

- [ ] **Step 3: Implement.** In `readModelsJson`:

```js
function readModelsJson() {
  const merged = { providers: {} };
  const paths = [];
  const managedIds = new Set();
  for (const p of modelsJsonSearchPaths()) {
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      if (j && Array.isArray(j.$crowManaged)) {
        for (const id of j.$crowManaged) if (typeof id === "string") managedIds.add(id);
      }
      if (j && j.providers) {
        Object.assign(merged.providers, j.providers);
        paths.push(p);
      }
    } catch {}
  }
  return { path: paths.join(", ") || null, config: merged, managedIds };
}
```

In `syncProvidersFromModelsJson`: destructure `managedIds`, add the two counters, and select `gpu_policy` (already selected) for the native test. Replace the opening of the loop body:

```js
  const { path, config, managedIds } = readModelsJson();
  const counters = { upserted: 0, unchanged: 0, skipped_disabled: 0, skipped_unowned: 0, skipped_native: 0, skipped_managed: 0, reenabled: 0, repaired: 0, failed: 0 };
  …
  for (const [id, p] of entries) {
    try {
      // §11.7: M1's own output is never an input (it would loop).
      if (managedIds.has(id)) { counters.skipped_managed++; continue; }
      const cur = existing.get(id);
      // §11.7 / I5: a native row is owned by the model manager; models.json
      // must never rebuild its gpu_policy or base_url.
      if (cur && parseStoredPolicy(cur.gpu_policy)?.runtime === "native") { counters.skipped_native++; continue; }
      const decision = reconcileDecision({ … unchanged … });
```

Update the JSDoc `@returns` counters list to include `skipped_native` and `skipped_managed`.

- [ ] **Step 4: Run, expect PASS**, plus neighbours: `npm test -- tests/providers-reconcile-native-guard.test.js tests/providers-reconcile-gate.test.js tests/providers-war-sim.test.js tests/models-json-seam.test.js tests/providers-external-engine-write.test.js`

- [ ] **Step 5: Commit.**

```bash
git add tests/providers-reconcile-native-guard.test.js
git commit servers/shared/providers-db.js tests/providers-reconcile-native-guard.test.js -m "fix(providers): reconciler never de-natives a converted row or re-imports crow-managed entries (I5)"
```

---

### Task 3: Door resolver (pure)

Spec §5.1, §11.4. One module decides where a door request goes. No I/O.

**Files:**
- Create: `servers/gateway/models/door-resolve.js`
- Test: `tests/door-resolve.test.js`

**Interfaces:**
- Consumes: provider objects in the `loadProviders()` shape (`{ baseUrl, apiKey, host, bundleId, models, gpuPolicy, doorUrl? }`, already localized by `localizeNativeRow`); `isExternalEngine` from `servers/shared/provider-engine.js`; `addressClass` from `servers/shared/locality.js`.
- Produces:
  - `DOOR_PROVIDER_HEADER = "x-crow-provider"`, `DOOR_HOP_HEADER = "x-crow-door-hop"`
  - `doorKindOf(provider) -> "native-owned" | "native-foreign" | "external" | "bundle" | "local" | "cloud"`
  - `resolveDoorTarget({ providers, providerHeader, model, companionModelIds, hop }) -> { kind: "companion" } | { kind: "forward", providerId, modelId, url, apiKey, doorKind } | { kind: "error", status, code, message, candidates? }` — `providerHeader` is also how the provider-scoped path `/llm/p/<provider>/v1/…` (Task 4) addresses a provider
  - `isDoorUrl(url) -> boolean` (true for `…/llm/v1` and `…/llm/p/<provider>/v1`)
  - `providerDoorUrl(doorBase, providerId) -> string` (`http://h:3001/llm/v1` → `http://h:3001/llm/p/<id>/v1`)
  - `listDoorModels(providers) -> Array<{ id, object: "model", owned_by: "crow", provider, doorKind }>`

- [ ] **Step 1: Write the failing test.**

```js
// tests/door-resolve.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDoorTarget, listDoorModels, doorKindOf, isDoorUrl, providerDoorUrl, DOOR_PROVIDER_HEADER, DOOR_HOP_HEADER } from "../servers/gateway/models/door-resolve.js";

const P = {
  "crow-chat": { baseUrl: "http://127.0.0.1:18102/v1", doorUrl: "http://100.64.9.1:3001/llm/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 18102, mutexGroup: "crow-strix-vram", defaultMember: true } },
  "crow-voice": { baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
  "crow-local-27b": { baseUrl: "http://100.64.9.1:8006/v1", apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "crow-local-27b-copilot": { baseUrl: "http://100.64.9.1:8010/v1", apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "r4-gemma": { baseUrl: "http://100.64.9.1:3008/llm/v1", apiKey: "none", models: [{ id: "gemma-4-e2b-it" }], gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "qwen-cloud": { baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", apiKey: "sk-secret", models: [{ id: "qwen3.8-max" }] },
  "raven-flash-next": { baseUrl: "http://10.0.0.126:8030/v1", apiKey: "none", models: [{ id: "qwen3.8-flash-next" }], gpuPolicy: { engine: { managed: "external", host: "raven", label: "gufo" } } },
};
const COMPANION = ["qwen3.5-4b", "qwen3.6-35b-a3b"];

test("isDoorUrl and providerDoorUrl", () => {
  assert.equal(isDoorUrl("http://100.64.9.1:3001/llm/v1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:3001/llm/p/crow-chat/v1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:8003/v1"), false);
  assert.equal(providerDoorUrl("http://100.64.9.1:3001/llm/v1", "crow-chat"), "http://100.64.9.1:3001/llm/p/crow-chat/v1");
});

test("an alias row whose base_url is a provider-scoped door is local, and a second door hop is refused", () => {
  const P2 = { ...P, "crow-local": { baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] } };
  assert.equal(doorKindOf(P2["crow-local"]), "local");
  const first = resolveDoorTarget({ providers: P2, providerHeader: "crow-local", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION });
  assert.equal(first.url, "http://100.64.9.1:3001/llm/p/crow-chat/v1");
  const second = resolveDoorTarget({ providers: P2, providerHeader: "crow-local", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION, hop: 1 });
  assert.equal(second.status, 508);
});

test("header names are lower-case (express lower-cases incoming headers)", () => {
  assert.equal(DOOR_PROVIDER_HEADER, "x-crow-provider");
  assert.equal(DOOR_HOP_HEADER, "x-crow-door-hop");
});

test("doorKindOf classifies every row shape", () => {
  assert.equal(doorKindOf(P["crow-chat"]), "native-owned");
  assert.equal(doorKindOf(P["r4-gemma"]), "native-foreign");
  assert.equal(doorKindOf(P["crow-local-27b"]), "external");
  assert.equal(doorKindOf(P["crow-voice"]), "bundle");
  assert.equal(doorKindOf(P["qwen-cloud"]), "cloud");
  assert.equal(doorKindOf({ baseUrl: "http://10.0.0.50:8000/v1", models: [] }), "local");
});

test("the header addresses a provider; the model field stays bare", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-local-27b-copilot", model: "qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.kind, "forward");
  assert.equal(r.providerId, "crow-local-27b-copilot");
  assert.equal(r.modelId, "qwen3.8-27b");
  assert.equal(r.url, "http://100.64.9.1:8010/v1");
});

test("a qualified model addresses a provider", () => {
  const r = resolveDoorTarget({ providers: P, model: "crow-local-27b/qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.providerId, "crow-local-27b");
  assert.equal(r.modelId, "qwen3.8-27b");
});

test("an owned native row forwards to loopback, never to its own door", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-chat", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION });
  assert.equal(r.url, "http://127.0.0.1:18102/v1");
  assert.equal(r.doorKind, "native-owned");
});

test("a foreign-owned native row forwards to the owner's door", () => {
  const r = resolveDoorTarget({ providers: P, model: "r4-gemma/gemma-4-e2b-it", companionModelIds: COMPANION });
  assert.equal(r.url, "http://100.64.9.1:3008/llm/v1");
  assert.equal(r.doorKind, "native-foreign");
});

test("a second hop to a door answers 508", () => {
  const r = resolveDoorTarget({ providers: P, model: "r4-gemma/gemma-4-e2b-it", companionModelIds: COMPANION, hop: 1 });
  assert.equal(r.kind, "error");
  assert.equal(r.status, 508);
  assert.equal(r.code, "DOOR_LOOP");
});

test("cloud rows are refused", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "qwen-cloud", model: "qwen3.8-max", companionModelIds: COMPANION });
  assert.equal(r.kind, "error");
  assert.equal(r.status, 400);
  assert.equal(r.code, "NOT_LOCAL");
  assert.equal(JSON.stringify(r).includes("sk-secret"), false, "the key never appears in an error");
});

test("a unique bare id that is not a companion alias resolves", () => {
  const r = resolveDoorTarget({ providers: P, model: "qwen3.8-flash-next", companionModelIds: COMPANION });
  assert.equal(r.providerId, "raven-flash-next");
});

test("companion alias ids and unknown ids stay with the companion heuristics", () => {
  assert.equal(resolveDoorTarget({ providers: P, model: "qwen3.5-4b", companionModelIds: COMPANION }).kind, "companion");
  assert.equal(resolveDoorTarget({ providers: P, model: "qwen3.6-35b-a3b", companionModelIds: COMPANION }).kind, "companion");
  assert.equal(resolveDoorTarget({ providers: P, model: "crow", companionModelIds: COMPANION }).kind, "companion");
  assert.equal(resolveDoorTarget({ providers: P, model: undefined, companionModelIds: COMPANION }).kind, "companion");
});

test("an ambiguous bare id answers 400 with the qualified forms", () => {
  const r = resolveDoorTarget({ providers: P, model: "qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.status, 400);
  assert.equal(r.code, "AMBIGUOUS_MODEL");
  assert.deepEqual(r.candidates.sort(), ["crow-local-27b-copilot/qwen3.8-27b", "crow-local-27b/qwen3.8-27b"]);
});

test("an ambiguous bare id resolves to the group's defaultMember when exactly one candidate is one", () => {
  const P2 = { ...P, "crow-chat-alt": { ...P["crow-chat"], gpuPolicy: { ...P["crow-chat"].gpuPolicy, defaultMember: false, port: 18103 }, baseUrl: "http://127.0.0.1:18103/v1" } };
  const r = resolveDoorTarget({ providers: P2, model: "qwen3.6-35b-a3b", companionModelIds: [] });
  assert.equal(r.providerId, "crow-chat");
});

test("an unknown header provider or a model the provider does not serve is 404", () => {
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "nope", model: "x", companionModelIds: COMPANION }).status, 404);
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-voice", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION });
  assert.equal(r.status, 404);
  assert.equal(r.code, "MODEL_NOT_SERVED");
});

test("listDoorModels lists every non-cloud model qualified, cloud rows excluded", () => {
  const ids = listDoorModels(P).map((m) => m.id);
  assert.ok(ids.includes("crow-chat/qwen3.6-35b-a3b"));
  assert.ok(ids.includes("crow-local-27b-copilot/qwen3.8-27b"));
  assert.ok(ids.includes("raven-flash-next/qwen3.8-flash-next"));
  assert.equal(ids.some((id) => id.startsWith("qwen-cloud/")), false);
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found). `npm test -- tests/door-resolve.test.js`

- [ ] **Step 3: Implement.**

```js
// servers/gateway/models/door-resolve.js
/**
 * Door addressing (spec §5.1, §11.4). Pure: given the provider map (the
 * loadProviders() shape, ALREADY localized — an owned native row carries
 * baseUrl = loopback and doorUrl = its door) and the request's addressing
 * inputs, decide where a /llm/v1 request goes.
 *
 * Order: provider named by the path (/llm/p/<provider>/v1) or the
 * X-Crow-Provider header → qualified "<provider>/<model>" → a bare id
 * that matches exactly one enabled non-companion row → companion heuristics
 * (the two companion alias ids and anything unknown, e.g. "crow").
 *
 * Forwardable: native rows (owned → loopback, foreign → owner's door),
 * external engines, bundle rows and other private-network rows. Cloud rows
 * (public endpoints) are refused so the unauthenticated tailnet door can
 * never spend a paid key.
 */
import { isExternalEngine } from "../../shared/provider-engine.js";
import { addressClass } from "../../shared/locality.js";

export const DOOR_PROVIDER_HEADER = "x-crow-provider";
export const DOOR_HOP_HEADER = "x-crow-door-hop";

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return null; }
}
export function isDoorUrl(url) {
  try { return /\/llm(\/p\/[^/]+)?\/v1$/.test(new URL(url).pathname.replace(/\/+$/, "")); } catch { return false; }
}

/** The provider-scoped door: a base URL that already names its provider, so a
 * client needs no header and no qualified model id (alias rows, pi entries). */
export function providerDoorUrl(doorBase, providerId) {
  return String(doorBase).replace(/\/llm\/v1\/?$/, `/llm/p/${encodeURIComponent(providerId)}/v1`);
}
function isPublicEndpoint(url) {
  const h = hostnameOf(url);
  if (!h) return true; // unparseable: treat as not forwardable
  const c = addressClass(h);
  if (c) return c === "public4" || c === "public6";
  if (h === "localhost") return false;
  if (!h.includes(".")) return false; // bare LAN name
  return !/\.(local|lan|internal|home\.arpa|ts\.net)$/.test(h);
}

export function doorKindOf(p) {
  if (!p) return "cloud";
  if (p.gpuPolicy?.runtime === "native") {
    return p.doorUrl || !isDoorUrl(p.baseUrl) ? "native-owned" : "native-foreign";
  }
  if (isExternalEngine(p)) return "external";
  if (p.bundleId) return "bundle";
  return isPublicEndpoint(p.baseUrl) ? "cloud" : "local";
}

function modelIdsOf(p) {
  return (Array.isArray(p?.models) ? p.models : []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
}

function forward(providers, providerId, modelId, hop) {
  const p = providers[providerId];
  if (!p) return { kind: "error", status: 404, code: "UNKNOWN_PROVIDER", message: `no enabled provider "${providerId}"` };
  const doorKind = doorKindOf(p);
  if (doorKind === "cloud") {
    return { kind: "error", status: 400, code: "NOT_LOCAL", message: `provider "${providerId}" is a cloud endpoint; the door forwards local models only` };
  }
  const ids = modelIdsOf(p);
  const mid = modelId || ids[0];
  if (!mid || !ids.includes(mid)) {
    return { kind: "error", status: 404, code: "MODEL_NOT_SERVED", message: `provider "${providerId}" does not serve "${modelId}"`, candidates: ids.map((i) => `${providerId}/${i}`) };
  }
  const url = String(p.baseUrl || "").replace(/\/+$/, "");
  if (isDoorUrl(url) && Number(hop) >= 1) {
    return { kind: "error", status: 508, code: "DOOR_LOOP", message: `refusing a second door hop to ${providerId}` };
  }
  return { kind: "forward", providerId, modelId: mid, url, apiKey: p.apiKey || "none", doorKind };
}

export function resolveDoorTarget({ providers = {}, providerHeader = null, model = null, companionModelIds = [], hop = 0 } = {}) {
  const header = typeof providerHeader === "string" && providerHeader.trim() ? providerHeader.trim() : null;
  const m = typeof model === "string" ? model.trim() : "";

  if (header) {
    const bare = m.startsWith(header + "/") ? m.slice(header.length + 1) : m;
    return forward(providers, header, bare || null, hop);
  }
  const slash = m.indexOf("/");
  if (slash > 0) {
    const pid = m.slice(0, slash);
    if (providers[pid]) return forward(providers, pid, m.slice(slash + 1), hop);
  }
  if (!m || companionModelIds.includes(m)) return { kind: "companion" };

  const candidates = Object.entries(providers)
    .filter(([, p]) => doorKindOf(p) !== "cloud" && modelIdsOf(p).includes(m))
    .map(([id]) => id);
  if (candidates.length === 0) return { kind: "companion" };
  if (candidates.length === 1) return forward(providers, candidates[0], m, hop);
  const defaults = candidates.filter((id) => providers[id]?.gpuPolicy?.defaultMember === true);
  if (defaults.length === 1) return forward(providers, defaults[0], m, hop);
  return {
    kind: "error", status: 400, code: "AMBIGUOUS_MODEL",
    message: `model "${m}" is served by more than one provider; address it as <provider>/<model> or with the ${DOOR_PROVIDER_HEADER} header`,
    candidates: candidates.map((id) => `${id}/${m}`),
  };
}

export function listDoorModels(providers = {}) {
  const out = [];
  for (const [pid, p] of Object.entries(providers)) {
    const doorKind = doorKindOf(p);
    if (doorKind === "cloud") continue;
    for (const mid of modelIdsOf(p)) out.push({ id: `${pid}/${mid}`, object: "model", owned_by: "crow", provider: pid, doorKind });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/door-resolve.test.js`

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/models/door-resolve.js tests/door-resolve.test.js
git commit servers/gateway/models/door-resolve.js tests/door-resolve.test.js -m "feat(models): pure door resolver — provider path/header/qualified/bare addressing, cloud refused, one-hop guard"
```

---

### Task 4: Door routes in `/llm/v1`

**Files:**
- Modify: `servers/gateway/routes/llm-router.js`
- Test: `tests/llm-router-door.test.js`

**Interfaces:**
- Consumes: `resolveDoorTarget`, `listDoorModels`, `DOOR_PROVIDER_HEADER`, `DOOR_HOP_HEADER` (Task 3); `loadProviders` from `servers/shared/providers.js`; `maybeAcquireLocalProvider` (existing).
- Produces: router seam `loadProvidersFn` (default `loadProviders`); `POST /llm/v1/completions`, `/llm/v1/embeddings`, `/llm/v1/rerank`; `GET /llm/v1/models` returns the two companion ids followed by `listDoorModels()`; the provider-scoped door `POST /llm/p/:provider/v1/{chat/completions,completions,embeddings,rerank}` and `GET /llm/p/:provider/v1/models` (the path names the provider; the companion heuristics never apply there).

- [ ] **Step 1: Write the failing test.**

```js
// tests/llm-router-door.test.js
process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";

let up, upUrl, seen, srv, appUrl, acquired;

before(async () => {
  up = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  const providers = {
    "crow-chat": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 1 } },
    "crow-voice": { baseUrl: upUrl, apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
    "crow-embed": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/v1", apiKey: "none", models: [{ id: "qwen3-embedding-0.6b" }], gpuPolicy: { runtime: "native", owner: "me", port: 2 } },
    "crow-local-27b": { baseUrl: upUrl, apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow" } } },
    "crow-local-27b-copilot": { baseUrl: upUrl, apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow" } } },
    "peer-door": { baseUrl: "http://127.0.0.1:9/llm/v1", apiKey: "none", models: [{ id: "far" }], gpuPolicy: { runtime: "native", owner: "other", port: 3 } },
    "qwen-cloud": { baseUrl: "https://example.com/v1", apiKey: "sk-x", models: [{ id: "qwen3.8-max" }] },
  };
  const router = llmRouterRouter({
    acquireFn: async (pid) => { acquired.push(pid); return true; },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers }),
  });
  const app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); up?.close(); });

function post(path, body, headers = {}) {
  seen = []; acquired = [];
  return fetch(`${appUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("header-addressed chat forwards to that provider with its bare model id", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] }, { "X-Crow-Provider": "crow-local-27b-copilot" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].path, "/v1/chat/completions");
  assert.equal(seen[0].body.model, "qwen3.8-27b");
  assert.deepEqual(acquired, [], "external engines are never acquired");
});

test("qualified chat warms a native provider before forwarding", async () => {
  await post("/llm/v1/chat/completions", { model: "crow-chat/qwen3.6-35b-a3b", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(acquired, ["crow-chat"]);
  assert.equal(seen[0].body.model, "qwen3.6-35b-a3b", "the qualified form is rewritten to the bare alias upstream");
});

test("embeddings forward by bare id", async () => {
  const r = await post("/llm/v1/embeddings", { model: "qwen3-embedding-0.6b", input: "x" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].path, "/v1/embeddings");
});

test("companion alias ids still route by heuristics", async () => {
  await post("/llm/v1/chat/completions", { model: "qwen3.5-4b", messages: [{ role: "user", content: "hello there" }] });
  assert.deepEqual(acquired, ["crow-voice"], "fast path, exactly as before");
});

test("ambiguous bare id answers 400 with candidates", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-27b", messages: [] });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, "AMBIGUOUS_MODEL");
  assert.equal(j.error.candidates.length, 2);
});

test("cloud rows are refused, never proxied", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-max", messages: [] }, { "X-Crow-Provider": "qwen-cloud" });
  assert.equal(r.status, 400);
  assert.equal(seen.length, 0);
});

test("a second hop answers 508", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "peer-door/far", messages: [] }, { "X-Crow-Door-Hop": "1" });
  assert.equal(r.status, 508);
});

test("the provider-scoped path addresses an alias row with a companion-alias model id (no heuristics)", async () => {
  const r = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [{ role: "user", content: "hello there" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(acquired, ["crow-chat"], "crow-chat, not the fast companion model");
  const m = await (await fetch(`${appUrl}/llm/p/crow-chat/v1/models`)).json();
  assert.deepEqual(m.data.map((x) => x.id), ["qwen3.6-35b-a3b"]);
  assert.equal((await fetch(`${appUrl}/llm/p/qwen-cloud/v1/models`)).status, 404);
});

test("GET /llm/v1/models lists companion ids then door models", async () => {
  const r = await fetch(`${appUrl}/llm/v1/models`);
  const ids = (await r.json()).data.map((m) => m.id);
  assert.ok(ids.includes("qwen3.5-4b") && ids.includes("qwen3.6-35b-a3b"), "companion aliases kept");
  assert.ok(ids.includes("crow-local-27b-copilot/qwen3.8-27b"));
  assert.equal(ids.some((i) => i.startsWith("qwen-cloud/")), false);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/llm-router-door.test.js`

- [ ] **Step 3: Implement.** In `llm-router.js`:

Add imports:

```js
import { loadProviders } from "../../shared/providers.js";
import { resolveDoorTarget, listDoorModels, isDoorUrl, DOOR_PROVIDER_HEADER, DOOR_HOP_HEADER } from "../models/door-resolve.js";
```

Add a forwarding helper (below `authHeaders`):

```js
const COMPANION_MODEL_IDS = [FAST_KEY, ESC_KEY].map((k) => splitKey(k)[1]).filter(Boolean);

/** Forward one door request verbatim and stream the response back. */
async function forwardDoor(req, res, target, op, deps) {
  if (target.doorKind === "native-owned" || target.doorKind === "bundle") {
    await deps.acquireFn(target.providerId, { requester: requesterTag(req) });
  }
  const body = { ...(req.body || {}), model: target.modelId };
  const headers = { "Content-Type": "application/json", Accept: req.headers.accept || "application/json", ...authHeaders(target.apiKey) };
  if (target.doorKind === "native-foreign") headers[DOOR_PROVIDER_HEADER] = target.providerId;
  // Any forward to a door (an owner's door, or an alias row's provider-scoped
  // door) is a hop; the receiving door refuses a second one (508).
  if (isDoorUrl(target.url)) headers[DOOR_HOP_HEADER] = "1";
  const url = `${target.url}/${op}`;
  let upstream;
  try {
    const t = connectTimeout(LLM_CONNECT_TIMEOUT_MS);
    upstream = t.disarm(await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: t.signal }));
  } catch (e) {
    const msg = isTimeoutError(e) ? `upstream connect timeout after ${Math.round(LLM_CONNECT_TIMEOUT_MS / 1000)}s` : `upstream ${url} unreachable: ${e.message}`;
    return res.status(502).json({ error: { code: "UPSTREAM_UNREACHABLE", message: msg } });
  }
  console.log(`[llm-router] door ${op} -> ${target.providerId}/${target.modelId} (${target.doorKind}) requester=${requesterTag(req)}`);
  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
  if (!upstream.body) return res.end();
  await new Promise((resolve, reject) => {
    const s = Readable.fromWeb(upstream.body);
    s.on("error", reject);
    res.on("close", () => s.destroy());
    s.pipe(res);
    res.on("finish", resolve);
  }).catch((e) => { console.error(`[llm-router] door stream error: ${e.message}`); if (!res.writableEnded) res.end(); });
}

function doorTargetFor(req, deps) {
  const cfg = deps.loadProvidersFn() || { providers: {} };
  return resolveDoorTarget({
    providers: cfg.providers || {},
    providerHeader: (req.params && req.params.provider) || req.headers[DOOR_PROVIDER_HEADER] || null,
    model: req.body && req.body.model,
    companionModelIds: COMPANION_MODEL_IDS,
    hop: Number(req.headers[DOOR_HOP_HEADER] || 0),
  });
}

function sendDoorError(res, t) {
  return res.status(t.status).json({ error: { code: t.code, message: t.message, ...(t.candidates ? { candidates: t.candidates } : {}) } });
}

/** Map orchestrator refusals the same way the companion path does. */
function sendAcquireError(res, err) {
  if (err instanceof ReservedError) {
    return res.status(409).json({ error: { code: "box_reserved", message: err.message, owner: err.owner, expires_at: err.expires_at } });
  }
  if (err instanceof ServingClassError) {
    return res.status(409).json({ error: { code: "serving_class_refused", message: err.message, serving_class: err.servingClass } });
  }
  return res.status(502).json({ error: { code: "router_error", message: err?.message || String(err) } });
}
```

At the top of `handleChat`, before `const manualEsc = …`:

```js
  const door = doorTargetFor(req, deps);
  if (door.kind === "error") return sendDoorError(res, door);
  if (door.kind === "forward") {
    try { return await forwardDoor(req, res, door, "chat/completions", deps); }
    catch (err) { return sendAcquireError(res, err); }
  }
  // door.kind === "companion": fall through to the fast/escalate heuristics, unchanged.
```

Replace `handleModels` with:

```js
async function handleModels(res, deps) {
  const out = [];
  for (const key of [FAST_KEY, ESC_KEY]) {
    try {
      const up = await deps.resolveKeyFn(key);
      out.push({ id: up.model, object: "model", owned_by: "crow", created: 0 });
    } catch { /* skip unresolved */ }
  }
  try {
    for (const m of listDoorModels((deps.loadProvidersFn() || {}).providers || {})) out.push({ id: m.id, object: "model", owned_by: "crow", created: 0 });
  } catch { /* the companion ids alone are still a valid listing */ }
  res.json({ object: "list", data: out });
}
```

In `llmRouterRouter`: add `loadProvidersFn: loadProviders` to the default `deps`, change the models route to `handleModels(res, deps)`, and register the three new door endpoints:

```js
  // Provider-scoped door: the path names the provider (alias rows such as
  // crow-local, and pi's managed entries, point here — no header needed).
  for (const op of ["chat/completions", "completions", "embeddings", "rerank"]) {
    router.post(`/llm/p/:provider/v1/${op}`, async (req, res) => {
      const door = doorTargetFor(req, deps);
      if (door.kind !== "forward") return sendDoorError(res, door.kind === "error" ? door : { status: 404, code: "UNKNOWN_PROVIDER", message: `no provider "${req.params.provider}"` });
      try { await forwardDoor(req, res, door, op, deps); }
      catch (err) { if (!res.headersSent) sendAcquireError(res, err); }
    });
  }
  router.get("/llm/p/:provider/v1/models", (req, res) => {
    const p = ((deps.loadProvidersFn() || {}).providers || {})[req.params.provider];
    const listed = p ? listDoorModels({ [req.params.provider]: p }) : [];
    if (!listed.length) return res.status(404).json({ error: { code: "UNKNOWN_PROVIDER", message: `no local provider "${req.params.provider}"` } });
    res.json({ object: "list", data: listed.map((m) => ({ id: m.id.slice(req.params.provider.length + 1), object: "model", owned_by: "crow", created: 0 })) });
  });

  for (const op of ["completions", "embeddings", "rerank"]) {
    router.post(`/llm/v1/${op}`, async (req, res) => {
      const door = doorTargetFor(req, deps);
      if (door.kind === "error") return sendDoorError(res, door);
      if (door.kind === "companion") {
        return res.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: `no local model "${req.body?.model ?? ""}" for /${op}` } });
      }
      try { await forwardDoor(req, res, door, op, deps); }
      catch (err) { if (!res.headersSent) sendAcquireError(res, err); }
    });
  }
```

Update the file header comment's route list and the `late-mounts.js` mount log line to list the new routes.

- [ ] **Step 4: Run the new test and every router test.**

Run: `npm test -- tests/llm-router-door.test.js tests/llm-router-reserved.test.js tests/llm-router-serving-class.test.js tests/llm-router-crash.test.js tests/auth-network.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add tests/llm-router-door.test.js
git commit servers/gateway/routes/llm-router.js servers/gateway/boot/late-mounts.js tests/llm-router-door.test.js -m "feat(llm-router): model-addressed door — provider path, header, qualified, bare; embeddings/completions/rerank; door models listing"
```

---

### Task 5: Stderr tail on supervised processes

Spec §8: a start that dies before readiness returns the last 40 stderr lines as `cause`.

**Files:**
- Modify: `servers/gateway/process-supervisor.js` (inside `spawnChild`, after `handle.child = child`), `servers/gateway/models/runtime.js` (`startModel` status)
- Test: `tests/process-supervisor-stderr.test.js`

**Interfaces:**
- Produces: `superviseProcess({ …, stderrTailLines = 40 })`; `handle.stderrTail() -> string[]` (most recent last, at most `stderrTailLines`, kept across restarts); `startModel(...).status().stderrTail` (same array).

- [ ] **Step 1: Write the failing test.**

```js
// tests/process-supervisor-stderr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { superviseProcess } from "../servers/gateway/process-supervisor.js";

function fakeSpawn() {
  const children = [];
  const spawn = () => {
    const c = new EventEmitter();
    c.pid = 4242 + children.length;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = () => c.emit("exit", null, "SIGTERM");
    children.push(c);
    return c;
  };
  return { spawn, children };
}

test("stderrTail keeps the last N lines, split on newlines, across chunk boundaries", async () => {
  const { spawn, children } = fakeSpawn();
  const h = superviseProcess({ key: "t1", command: "x", spawn, stderrTailLines: 3, maxRestarts: 0 });
  children[0].stderr.write("one\ntw");
  children[0].stderr.write("o\nthree\nfour\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.stderrTail(), ["two", "three", "four"]);
});

test("the tail survives a restart (the cause of a crash loop stays visible)", async () => {
  const { spawn, children } = fakeSpawn();
  const h = superviseProcess({ key: "t2", command: "x", spawn, stderrTailLines: 5, maxRestarts: 1, backoffMs: () => 0, setTimeoutFn: (fn) => { fn(); return 0; } });
  children[0].stderr.write("load failed: out of memory\n");
  await new Promise((r) => setImmediate(r));
  children[0].emit("exit", 1, null);
  children[1].stderr.write("load failed again\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.stderrTail(), ["load failed: out of memory", "load failed again"]);
});
```

- [ ] **Step 2: Run, expect FAIL** (`h.stderrTail is not a function`). `npm test -- tests/process-supervisor-stderr.test.js`

- [ ] **Step 3: Implement.** Add `stderrTailLines = 40,` to the `superviseProcess` options. After `const handle = {…}` add:

```js
  const tail = [];
  let partial = "";
  function pushStderr(chunk) {
    const text = partial + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      tail.push(line);
      if (tail.length > stderrTailLines) tail.shift();
    }
  }
  handle.stderrTail = () => [...tail];
```

In `spawnChild`, right after `handle.child = child;`:

```js
    partial = "";
    if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", pushStderr);
    // stdout is piped but nothing reads it; drain it so a chatty child never blocks on a full pipe.
    if (child.stdout && typeof child.stdout.resume === "function") child.stdout.resume();
```

In `runtime.js` `startModel`'s `handle.status`, add `stderrTail: handle.stderrTail ? handle.stderrTail() : [],` to the returned object.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-runtime.test.js tests/gpu-orchestrator-native.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add tests/process-supervisor-stderr.test.js
git commit servers/gateway/process-supervisor.js servers/gateway/models/runtime.js tests/process-supervisor-stderr.test.js -m "feat(supervisor): keep the last 40 stderr lines per supervised process (start failure cause)"
```

---

### Task 6: The models token

*(Ruling, spec gap)* §5.2 says the lifecycle API uses "the local MCP token pi-lab already holds". pi-lab holds no Crow token today (`~/.crow` has `board-token`, `phone-token`, `peer-tokens.json` only). The lifecycle API therefore accepts **either** the full local MCP token **or** a new path-scoped `models-token`, minted at boot to `<CROW_HOME>/models-token` (mode 0600) exactly like the board and phone tokens.

**Files:**
- Modify: `servers/gateway/local-token.js`; `servers/gateway/boot/mcp-mounts.js` (beside the `ensurePhoneToken(phoneDb)` call at ~line 282)
- Test: `tests/models-token.test.js`

**Interfaces:**
- Produces: `generateModelsToken(db) -> Promise<string>`, `validateModelsToken(db, token) -> Promise<boolean>`, `ensureModelsToken(db) -> Promise<{ minted: boolean }>`, `modelsTokenPath() -> string`, `MODELS_TOKEN_KEYS = { MODELS_HASH_KEY: "mcp_models_token_hash", MODELS_CREATED_KEY: "mcp_models_token_created" }`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/models-token.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { generateModelsToken, validateModelsToken, ensureModelsToken, modelsTokenPath, validateLocalToken } from "../servers/gateway/local-token.js";

const home = mkdtempSync(join(tmpdir(), "models-token-"));
const dataDir = join(home, "data");
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dataDir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prev = process.env.CROW_HOME;
process.env.CROW_HOME = home;
const db = createDbClient(join(dataDir, "crow.db"));
after(() => { if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev; try { db.close(); } catch {} rmSync(home, { recursive: true, force: true }); });

test("ensureModelsToken mints once, 0600, and the file validates", async () => {
  assert.deepEqual(await ensureModelsToken(db), { minted: true });
  assert.deepEqual(await ensureModelsToken(db), { minted: false });
  assert.equal(modelsTokenPath(), join(home, "models-token"));
  assert.equal(statSync(modelsTokenPath()).mode & 0o777, 0o600);
  const raw = readFileSync(modelsTokenPath(), "utf8").trim();
  assert.equal(await validateModelsToken(db, raw), true);
  assert.equal(await validateModelsToken(db, raw + "x"), false);
  assert.equal(await validateLocalToken(db, raw), false, "the models token is not the full local token");
});

test("generateModelsToken rotates", async () => {
  const a = readFileSync(modelsTokenPath(), "utf8").trim();
  const b = await generateModelsToken(db);
  assert.notEqual(a, b);
  assert.equal(await validateModelsToken(db, a), false);
  assert.equal(await validateModelsToken(db, b), true);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-token.test.js`

- [ ] **Step 3: Implement** in `local-token.js`, mirroring the phone token block (same helpers `sha256Hex`, `crowHome`, `readSetting`, `writeSetting`):

```js
// Models token (models arc plan 2, Task 6): path-scoped to the lifecycle API
// under /llm/models. pi-lab reads it from <crowHome>/models-token. It cannot
// reach any MCP mount: the MCP middleware never consults it.
const MODELS_HASH_KEY = "mcp_models_token_hash";
const MODELS_CREATED_KEY = "mcp_models_token_created";
export function modelsTokenPath() {
  return join(crowHome(), "models-token");
}

export async function generateModelsToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, MODELS_HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, MODELS_CREATED_KEY, new Date().toISOString(), { scope: "local" });
  const path = modelsTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}

export async function validateModelsToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, MODELS_HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function ensureModelsToken(db) {
  const hash = await readSetting(db, MODELS_HASH_KEY);
  if (hash && existsSync(modelsTokenPath())) return { minted: false };
  await generateModelsToken(db);
  return { minted: true };
}

export const MODELS_TOKEN_KEYS = { MODELS_HASH_KEY, MODELS_CREATED_KEY };
```

In `servers/gateway/boot/mcp-mounts.js`, directly after the block that calls `ensurePhoneToken(phoneDb)` (and inside the same kind of try/catch), add:

```js
    try {
      const { ensureModelsToken } = await import("../local-token.js");
      const { minted } = await ensureModelsToken(phoneDb);
      if (minted) console.log("[local-token] minted models token at CROW_HOME/models-token");
    } catch (err) {
      console.warn(`[local-token] models token mint failed: ${err.message}`);
    }
```

(If the phone block imports `ensurePhoneToken` statically at the file top, import `ensureModelsToken` the same way instead of the dynamic import.)

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/models-token.test.js tests/auth-network.test.js`, plus every existing token test (`ls tests | grep -E "token|board-mcp"`).

- [ ] **Step 5: Commit.**

```bash
git add tests/models-token.test.js
git commit servers/gateway/local-token.js servers/gateway/boot/mcp-mounts.js tests/models-token.test.js -m "feat(auth): path-scoped models token for the lifecycle API (minted at boot to CROW_HOME/models-token)"
```

---

### Task 7: Lifecycle job store and listing builder (pure)

Spec §5.2.

**Files:**
- Create: `servers/gateway/models/lifecycle.js`
- Test: `tests/models-lifecycle.test.js`

**Interfaces:**
- Consumes: `doorKindOf` (Task 3); `isStartAllowed` from `servers/gateway/box-reservation.js`.
- Produces:
  - `JOB_STATES = ["queued", "evicting", "starting", "resident", "failed", "blocked_by_reservation"]`
  - `createJobStore({ now = Date.now, maxJobs = 200, idFn }) -> { create(provider): job, update(id, patch): job|null, get(id): job|null, activeFor(provider): job|null }`; a job is `{ id, provider, state, createdAt, updatedAt, cause: string[]|null, reservation: {owner, expires_at}|null, error: string|null }`
  - `buildModelsListing({ providers, ownInstanceId, snapshotOf, jobs, reservation, externalHealth, siblingsOf }) -> Array<{ provider, model, quant, status, mutexGroup, wouldEvict, argv, owner, managed }>`; `status ∈ resident | loading | stopped | blocked_by_reservation | external_up | external_down | foreign`

- [ ] **Step 1: Write the failing test.**

```js
// tests/models-lifecycle.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobStore, buildModelsListing, JOB_STATES } from "../servers/gateway/models/lifecycle.js";

test("job store: create, update, activeFor, eviction of old finished jobs", () => {
  let t = 1000, n = 0;
  const s = createJobStore({ now: () => t, maxJobs: 2, idFn: () => `j${++n}` });
  const a = s.create("crow-chat");
  assert.equal(a.state, "queued");
  assert.equal(s.activeFor("crow-chat").id, "j1");
  t = 2000;
  s.update("j1", { state: "resident" });
  assert.equal(s.get("j1").updatedAt, 2000);
  assert.equal(s.activeFor("crow-chat"), null, "a resident job is finished");
  s.create("a"); s.create("b");
  assert.equal(s.get("j1"), null, "oldest finished job evicted past maxJobs");
  assert.throws(() => s.update("j2", { state: "nope" }), /unknown job state/);
  assert.deepEqual(JOB_STATES, ["queued", "evicting", "starting", "resident", "failed", "blocked_by_reservation"]);
});

const providers = {
  "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", mutexGroup: "crow-strix-vram", port: 18102 } },
  "crow-local-27b-512k": { models: [{ id: "qwen3.8-27b-512k" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", mutexGroup: "crow-strix-vram", port: 18104 } },
  "crow-local-27b": { models: [{ id: "qwen3.8-27b" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "r4-gemma": { models: [{ id: "gemma-4-e2b-it" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "qwen-cloud": { models: [{ id: "x" }], baseUrl: "https://example.com/v1" },
};

test("listing: resident/stopped/blocked, wouldEvict lists resident siblings, external and foreign rows, cloud omitted", () => {
  const rows = buildModelsListing({
    providers,
    ownInstanceId: "me",
    snapshotOf: (name) => (name === "crow-chat" ? { live: true, argv: ["--model", "/m.gguf"] } : null),
    jobs: { activeFor: () => null },
    reservation: { owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: ["crow-chat"] },
    externalHealth: { "crow-local-27b": { ready: true } },
    siblingsOf: (name) => (name === "crow-local-27b-512k" ? ["crow-chat"] : name === "crow-chat" ? ["crow-local-27b-512k"] : []),
  });
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.equal(by["crow-chat"].status, "resident");
  assert.deepEqual(by["crow-chat"].argv, ["--model", "/m.gguf"]);
  assert.equal(by["crow-local-27b-512k"].status, "blocked_by_reservation", "not on the allow list while reserved");
  assert.deepEqual(by["crow-local-27b-512k"].wouldEvict, ["crow-chat"], "only RESIDENT siblings");
  assert.equal(by["crow-local-27b"].status, "external_up");
  assert.equal(by["crow-local-27b"].managed, "external");
  assert.equal(by["r4-gemma"].status, "foreign");
  assert.equal(by["r4-gemma"].owner, "r4");
  assert.equal(by["qwen-cloud"], undefined);
});

test("listing: an active job reports loading", () => {
  const rows = buildModelsListing({
    providers: { "crow-chat": providers["crow-chat"] }, ownInstanceId: "me", snapshotOf: () => null,
    jobs: { activeFor: () => ({ id: "j1", state: "starting" }) }, reservation: null, externalHealth: {}, siblingsOf: () => [],
  });
  assert.equal(rows[0].status, "loading");
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/models-lifecycle.test.js`

- [ ] **Step 3: Implement.**

```js
// servers/gateway/models/lifecycle.js
/**
 * Lifecycle API state (spec §5.2), pure. The route layer (routes/llm-models.js)
 * owns I/O; this module owns the job state machine and the listing shape.
 */
import { randomUUID } from "node:crypto";
import { doorKindOf } from "./door-resolve.js";
import { isStartAllowed } from "../box-reservation.js";

export const JOB_STATES = ["queued", "evicting", "starting", "resident", "failed", "blocked_by_reservation"];
const FINISHED = new Set(["resident", "failed", "blocked_by_reservation"]);

export function createJobStore({ now = Date.now, maxJobs = 200, idFn = randomUUID } = {}) {
  const jobs = new Map();
  function evict() {
    if (jobs.size <= maxJobs) return;
    for (const [id, j] of jobs) {
      if (jobs.size <= maxJobs) break;
      if (FINISHED.has(j.state)) jobs.delete(id);
    }
  }
  return {
    create(provider) {
      const t = now();
      const job = { id: idFn(), provider, state: "queued", createdAt: t, updatedAt: t, cause: null, reservation: null, error: null };
      jobs.set(job.id, job);
      evict();
      return { ...job };
    },
    update(id, patch = {}) {
      const j = jobs.get(id);
      if (!j) return null;
      if (patch.state !== undefined && !JOB_STATES.includes(patch.state)) throw new Error(`unknown job state "${patch.state}"`);
      Object.assign(j, patch, { updatedAt: now() });
      return { ...j };
    },
    get(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },
    activeFor(provider) {
      for (const j of jobs.values()) if (j.provider === provider && !FINISHED.has(j.state)) return { ...j };
      return null;
    },
  };
}

function firstModelId(p) {
  const m = Array.isArray(p?.models) ? p.models[0] : null;
  return typeof m === "string" ? m : m?.id ?? null;
}

export function buildModelsListing({ providers = {}, ownInstanceId, snapshotOf, jobs, reservation, externalHealth = {}, siblingsOf }) {
  const out = [];
  for (const [name, p] of Object.entries(providers)) {
    const kind = doorKindOf(p);
    if (kind === "cloud" || kind === "local" || kind === "bundle") continue;
    const gp = p.gpuPolicy || {};
    const base = {
      provider: name, model: firstModelId(p), quant: gp.quant ?? null, mutexGroup: gp.mutexGroup ?? null,
      wouldEvict: [], argv: null, owner: gp.owner ?? null, managed: kind === "external" ? "external" : "native",
    };
    if (kind === "external") {
      out.push({ ...base, status: externalHealth[name]?.ready ? "external_up" : "external_down" });
      continue;
    }
    if (kind === "native-foreign" || (gp.owner && gp.owner !== ownInstanceId)) {
      out.push({ ...base, status: "foreign" });
      continue;
    }
    const snap = snapshotOf(name);
    const isResident = (n) => !!snapshotOf(n)?.live;
    const wouldEvict = (siblingsOf(name) || []).filter(isResident);
    let status;
    if (snap?.live) status = "resident";
    else if (jobs.activeFor(name)) status = "loading";
    else if (reservation && !isStartAllowed(reservation, name)) status = "blocked_by_reservation";
    else status = "stopped";
    out.push({ ...base, status, wouldEvict, argv: snap?.argv ?? null });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}
```

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/models-lifecycle.test.js`

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/models/lifecycle.js tests/models-lifecycle.test.js
git commit servers/gateway/models/lifecycle.js tests/models-lifecycle.test.js -m "feat(models): lifecycle job store and GET /llm/models listing builder (pure)"
```

---

### Task 8: Lifecycle routes

**Files:**
- Create: `servers/gateway/routes/llm-models.js`
- Modify: `servers/gateway/gpu-orchestrator.js` (export `stopNativeProvider`, `nativeSnapshot`, `mutexSiblingsOf`), `servers/gateway/boot/late-mounts.js` (mount before `llmRouterRouter`)
- Test: `tests/llm-models-routes.test.js`

**Interfaces:**
- Consumes: Task 6 (`validateLocalToken`, `validateModelsToken`), Task 7 (`createJobStore`, `buildModelsListing`), `acquireProvider`, `getNativeHandle`, `readReservation`, `getProviderHealth`.
- Produces:
  - orchestrator: `export async function stopNativeProvider(name, opts = {}) -> Promise<{ stopped: boolean }>` (throws `NOT_OWNER` for a foreign row, `EXTERNAL_ENGINE` via `ExternalEngineError`); `export function nativeSnapshot(name) -> { live, argv, stderrTail } | null`; `export function mutexSiblingsOf(name) -> string[]` (wraps `getMutexSiblings`).
  - routes: `GET /llm/models`, `POST /llm/models/:provider/start` → `202 { job_id }`, `GET /llm/models/jobs/:id`, `POST /llm/models/:provider/stop`; 401 without a valid bearer; 409 `NOT_OWNER` with `{ owner, door }`; 409 `EXTERNAL_ENGINE`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/llm-models-routes.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmModelsRouter from "../servers/gateway/routes/llm-models.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";

const providers = {
  "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18102, mutexGroup: "g" } },
  "crow-slow": { models: [{ id: "slow" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18103/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18103 } },
  "crow-dead": { models: [{ id: "dead" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18104 } },
  "crow-reserved": { models: [{ id: "r" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18105/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18105 } },
  "r4-gemma": { models: [{ id: "gemma" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "crow-local-27b": { models: [{ id: "qwen3.8-27b" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "crow" } } },
};
let srv, url, stopped;
const RES = { owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: [] };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(llmModelsRouter({
    authFn: async (token) => token === "good",
    loadProvidersFn: () => ({ providers }),
    ownInstanceIdFn: () => "me",
    readReservationFn: () => null,
    snapshotOfFn: (n) => (n === "crow-chat" ? { live: true, argv: ["a"], stderrTail: [] } : null),
    siblingsOfFn: () => [],
    externalHealthFn: () => ({ "crow-local-27b": { ready: false } }),
    acquireFn: async (name) => {
      if (name === "crow-slow") { await new Promise((r) => setTimeout(r, 50)); return true; }
      if (name === "crow-dead") { const e = new Error("failed to bind"); throw e; }
      if (name === "crow-reserved") throw new ReservedError(RES, name);
      return true;
    },
    stopFn: async (name) => { stopped.push(name); return { stopped: true }; },
  }));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const auth = { authorization: "Bearer good", "content-type": "application/json" };
async function waitJob(id) {
  for (let i = 0; i < 40; i++) {
    const j = await (await fetch(`${url}/llm/models/jobs/${id}`, { headers: auth })).json();
    if (["resident", "failed", "blocked_by_reservation"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job never finished");
}

test("401 without a bearer, 401 with a wrong one", async () => {
  assert.equal((await fetch(`${url}/llm/models`)).status, 401);
  assert.equal((await fetch(`${url}/llm/models`, { headers: { authorization: "Bearer bad" } })).status, 401);
});

test("GET /llm/models lists native, external and foreign rows", async () => {
  const j = await (await fetch(`${url}/llm/models`, { headers: auth })).json();
  const by = Object.fromEntries(j.models.map((m) => [m.provider, m]));
  assert.equal(by["crow-chat"].status, "resident");
  assert.equal(by["crow-local-27b"].status, "external_down");
  assert.equal(by["r4-gemma"].status, "foreign");
});

test("start returns 202 with a job that reaches resident", async () => {
  const r = await fetch(`${url}/llm/models/crow-slow/start`, { method: "POST", headers: auth });
  assert.equal(r.status, 202);
  const { job_id } = await r.json();
  assert.equal((await waitJob(job_id)).state, "resident");
});

test("a start that fails carries cause (stderr tail) and error", async () => {
  const { job_id } = await (await fetch(`${url}/llm/models/crow-dead/start`, { method: "POST", headers: auth })).json();
  const j = await waitJob(job_id);
  assert.equal(j.state, "failed");
  assert.match(j.error, /failed to bind/);
  assert.ok(Array.isArray(j.cause));
});

test("a reserved start reports blocked_by_reservation with owner and expiry", async () => {
  const { job_id } = await (await fetch(`${url}/llm/models/crow-reserved/start`, { method: "POST", headers: auth })).json();
  const j = await waitJob(job_id);
  assert.equal(j.state, "blocked_by_reservation");
  assert.deepEqual(j.reservation, { owner: "win", expires_at: "2026-10-05T12:00:00Z" });
});

test("a second start while one is active returns the same job", async () => {
  const a = await (await fetch(`${url}/llm/models/crow-slow/start`, { method: "POST", headers: auth })).json();
  const b = await (await fetch(`${url}/llm/models/crow-slow/start`, { method: "POST", headers: auth })).json();
  assert.equal(a.job_id, b.job_id);
  await waitJob(a.job_id);
});

test("NOT_OWNER and EXTERNAL_ENGINE are 409s; stop works for an owned row", async () => {
  const f = await fetch(`${url}/llm/models/r4-gemma/stop`, { method: "POST", headers: auth });
  assert.equal(f.status, 409);
  const fj = await f.json();
  assert.equal(fj.error.code, "NOT_OWNER");
  assert.equal(fj.error.owner, "r4");
  assert.equal(fj.error.door, "http://100.64.9.1:3008/llm/v1");
  const e = await fetch(`${url}/llm/models/crow-local-27b/start`, { method: "POST", headers: auth });
  assert.equal(e.status, 409);
  assert.equal((await e.json()).error.code, "EXTERNAL_ENGINE");
  stopped = [];
  const s = await fetch(`${url}/llm/models/crow-chat/stop`, { method: "POST", headers: auth });
  assert.equal(s.status, 200);
  assert.deepEqual(stopped, ["crow-chat"]);
});

test("unknown provider is 404", async () => {
  assert.equal((await fetch(`${url}/llm/models/nope/start`, { method: "POST", headers: auth })).status, 404);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/llm-models-routes.test.js`

- [ ] **Step 3: Implement the orchestrator exports** in `gpu-orchestrator.js` (beside `getNativeHandle`):

```js
/** Lifecycle API (plan 2 Task 8): a read-only snapshot of a native handle. */
export function nativeSnapshot(name) {
  const h = _nativeHandles.get(name);
  if (!h) return null;
  const s = typeof h.status === "function" ? h.status() : {};
  return { live: !!h.live, argv: h.argv || s.argv || null, stderrTail: s.stderrTail || [] };
}

/** Mutex siblings of a provider by name (for the listing's wouldEvict). */
export function mutexSiblingsOf(name) {
  return getMutexSiblings(name, loadProviders());
}

/** Stop a native provider this instance owns. */
export async function stopNativeProvider(name, opts = {}) {
  const cfg = loadProviders();
  const p = getProvider(name, cfg);
  if (!p) { const e = new Error(`no provider "${name}"`); e.code = "UNKNOWN_PROVIDER"; throw e; }
  if (isExternalEngine(p)) throw new ExternalEngineError(name, externalEngineInfo(p)?.host ?? null);
  if (!isNativeRuntime(p)) { const e = new Error(`provider "${name}" is not native`); e.code = "NOT_NATIVE"; throw e; }
  if (!orchestratableHere(p, opts)) {
    const e = new Error(`provider "${name}" is owned by another instance`);
    e.code = "NOT_OWNER"; e.owner = p.gpuPolicy?.owner ?? null; e.door = p.doorUrl || p.baseUrl;
    throw e;
  }
  const h = _nativeHandles.get(name);
  if (!h || !h.live) return { stopped: false };
  await stopModel(h);
  _nativeHandles.delete(name);
  _lastUsedAt.delete(name);
  console.log(`[gpu-orchestrator] stopped native ${name} (requested-by=${opts.requester || "-"})`);
  return { stopped: true };
}
```

(`loadProviders` here is the module's existing local `loadProviders()` function; `getProvider`, `getMutexSiblings`, `isNativeRuntime`, `orchestratableHere`, `_nativeHandles`, `_lastUsedAt`, `stopModel` already exist in the file.)

- [ ] **Step 4: Implement the routes.**

```js
// servers/gateway/routes/llm-models.js
/**
 * Lifecycle API for programs (spec §5.2): pi-lab and the board start, stop
 * and inspect local models through the owning gateway. Bearer auth: the full
 * local MCP token OR the path-scoped models token (<CROW_HOME>/models-token).
 * Mounted beside /llm/v1 with no dashboard auth; Funnel-rejected globally.
 */
import express from "express";
import { createDbClient } from "../../db.js";
import { validateLocalToken, validateModelsToken } from "../local-token.js";
import { loadProviders } from "../../shared/providers.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { readReservation, ReservedError } from "../box-reservation.js";
import { getProviderHealth } from "../provider-health.js";
import { acquireProvider, stopNativeProvider, nativeSnapshot, mutexSiblingsOf } from "../gpu-orchestrator.js";
import { createJobStore, buildModelsListing } from "../models/lifecycle.js";
import { doorKindOf } from "../models/door-resolve.js";
import { requesterTag } from "../requester-tag.js";

export default function llmModelsRouter(opts = {}) {
  let _db = null;
  const db = () => (_db ||= createDbClient());
  const deps = {
    authFn: async (token) => (await validateLocalToken(db(), token)) || (await validateModelsToken(db(), token)),
    loadProvidersFn: loadProviders,
    ownInstanceIdFn: getOrCreateLocalInstanceId,
    readReservationFn: readReservation,
    snapshotOfFn: nativeSnapshot,
    siblingsOfFn: mutexSiblingsOf,
    externalHealthFn: () => getProviderHealth().external,
    acquireFn: acquireProvider,
    stopFn: stopNativeProvider,
    jobs: createJobStore(),
    ...opts,
  };
  const jobs = deps.jobs;
  const router = express.Router();
  router.use("/llm/models", express.json({ limit: "1mb" }));

  router.use("/llm/models", async (req, res, next) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    try {
      if (token && (await deps.authFn(token))) return next();
    } catch (err) {
      console.warn(`[llm-models] auth check failed: ${err.message}`);
    }
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "bearer token required (local MCP token or CROW_HOME/models-token)" } });
  });

  const providersNow = () => (deps.loadProvidersFn() || {}).providers || {};

  function refuseIfNotStartable(res, name, p) {
    if (!p) { res.status(404).json({ error: { code: "UNKNOWN_PROVIDER", message: `no enabled provider "${name}"` } }); return true; }
    const kind = doorKindOf(p);
    if (kind === "external") { res.status(409).json({ error: { code: "EXTERNAL_ENGINE", message: `"${name}" is an external engine; Crow never starts or stops it` } }); return true; }
    if (kind === "native-foreign" || (p.gpuPolicy?.owner && p.gpuPolicy.owner !== deps.ownInstanceIdFn())) {
      res.status(409).json({ error: { code: "NOT_OWNER", message: `"${name}" is owned by another instance`, owner: p.gpuPolicy?.owner ?? null, door: p.doorUrl || p.baseUrl } });
      return true;
    }
    if (kind !== "native-owned") { res.status(409).json({ error: { code: "NOT_NATIVE", message: `"${name}" is not a native model` } }); return true; }
    return false;
  }

  router.get("/llm/models", (req, res) => {
    const models = buildModelsListing({
      providers: providersNow(), ownInstanceId: deps.ownInstanceIdFn(), snapshotOf: deps.snapshotOfFn,
      jobs, reservation: deps.readReservationFn(), externalHealth: deps.externalHealthFn() || {}, siblingsOf: deps.siblingsOfFn,
    });
    res.json({ models });
  });

  router.post("/llm/models/:provider/start", (req, res) => {
    const name = req.params.provider;
    const p = providersNow()[name];
    if (refuseIfNotStartable(res, name, p)) return;
    const active = jobs.activeFor(name);
    if (active) return res.status(202).json({ job_id: active.id });
    const job = jobs.create(name);
    res.status(202).json({ job_id: job.id });
    const requester = requesterTag(req);
    (async () => {
      jobs.update(job.id, { state: (deps.siblingsOfFn(name) || []).some((s) => deps.snapshotOfFn(s)?.live) ? "evicting" : "starting" });
      try {
        await deps.acquireFn(name, { requester });
        jobs.update(job.id, { state: "resident" });
      } catch (err) {
        if (err instanceof ReservedError) {
          jobs.update(job.id, { state: "blocked_by_reservation", reservation: { owner: err.owner, expires_at: err.expires_at }, error: err.message });
        } else {
          jobs.update(job.id, { state: "failed", error: err?.message || String(err), cause: deps.snapshotOfFn(name)?.stderrTail || [] });
        }
      }
    })();
  });

  router.get("/llm/models/jobs/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: { code: "UNKNOWN_JOB", message: "no such job" } });
    res.json(j);
  });

  router.post("/llm/models/:provider/stop", async (req, res) => {
    const name = req.params.provider;
    const p = providersNow()[name];
    if (refuseIfNotStartable(res, name, p)) return;
    try {
      res.json(await deps.stopFn(name, { requester: requesterTag(req) }));
    } catch (err) {
      res.status(500).json({ error: { code: err.code || "STOP_FAILED", message: err.message } });
    }
  });

  return router;
}
```

Mount it in `servers/gateway/boot/late-mounts.js` immediately before the `llmRouterRouter` mount, inside the same try/catch style:

```js
    const { default: llmModelsRouter } = await import("../routes/llm-models.js");
    app.use(llmModelsRouter());
    console.log("  [llm-models] mounted: GET /llm/models, POST /llm/models/:provider/start|stop, GET /llm/models/jobs/:id");
```

Note on the start state: `acquireProvider` runs the sibling eviction itself; the route reports `evicting` when a resident sibling exists at job start, then `starting` is skipped. That is coarse but honest; the orchestrator has no progress callback, and adding one is not in scope.

- [ ] **Step 5: Run, expect PASS**, plus `npm test -- tests/llm-models-routes.test.js tests/gpu-orchestrator-native.test.js tests/auth-network.test.js`.

- [ ] **Step 6: Commit.**

```bash
git add servers/gateway/routes/llm-models.js tests/llm-models-routes.test.js
git commit servers/gateway/routes/llm-models.js servers/gateway/gpu-orchestrator.js servers/gateway/boot/late-mounts.js tests/llm-models-routes.test.js -m "feat(llm): lifecycle API — /llm/models list, async start jobs, stop, NOT_OWNER/EXTERNAL_ENGINE, token auth"
```

---

### Task 9: pi `models.json` managed sync (M1)

Spec §11.6.

**Files:**
- Create: `servers/shared/pi-models-sync.js`
- Modify: `servers/shared/providers-db.js` (`setProviderChangeHook`, call it from `emitSync`), `servers/gateway/boot/admin-api.js` (boot run + hook install)
- Test: `tests/pi-models-sync.test.js`

**Interfaces:**
- Consumes: `listProvidersAll(db)`; `doorKindOf`, `providerDoorUrl` (Task 3) for a row in the parsed `listProvidersAll` shape (`baseUrl`, `bundleId`, `gpuPolicy`, `models`).
- Produces:
  - `CROW_MANAGED_KEY = "$crowManaged"`
  - `piModelsSyncPath({ env, crowHome, home }) -> string|null` (null = disabled)
  - `buildManagedEntries(rows) -> Record<id, { baseUrl, apiKey, api, models }>` (a native row's `baseUrl` is its provider-scoped door, so pi needs no header)
  - `mergeManaged(fileJson, entries) -> { json, added: string[], updated: string[], removed: string[] }`
  - `syncPiModelsJson(db, { path, readFileFn, writeFileAtomicFn }) -> Promise<{ path, added, updated, removed } | { disabled: true }>`
  - providers-db: `setProviderChangeHook(fn | null)`; `emitSync` calls the hook (never awaited, never throws).

- [ ] **Step 1: Write the failing test.**

```js
// tests/pi-models-sync.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManagedEntries, mergeManaged, piModelsSyncPath, syncPiModelsJson, CROW_MANAGED_KEY } from "../servers/shared/pi-models-sync.js";

const rows = [
  { id: "crow-chat", baseUrl: "http://100.64.9.1:3001/llm/v1", apiKey: null, bundleId: null, disabled: false, provider_type: "openai-compat",
    models: [{ id: "qwen3.6-35b-a3b", contextWindow: 262144 }], gpuPolicy: { runtime: "native", owner: "me", port: 18102 } },
  { id: "crow-voice", baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", disabled: false, provider_type: "openai-compat", models: [{ id: "qwen3.5-4b" }], gpuPolicy: null },
  { id: "Qwen Cloud", baseUrl: "https://maas.example.com/v1", apiKey: "sk-live", bundleId: null, disabled: false, provider_type: "openai-compat", models: [{ id: "qwen3.8-max" }], gpuPolicy: null },
  { id: "anthropic-x", baseUrl: "https://api.anthropic.com", apiKey: "k", bundleId: null, disabled: false, provider_type: "anthropic", models: [{ id: "c" }], gpuPolicy: null },
  { id: "hf-token", baseUrl: "https://huggingface.co", apiKey: "hf_x", bundleId: null, disabled: true, provider_type: null, models: [], gpuPolicy: { local_only: true } },
  { id: "old", baseUrl: "http://100.64.9.1:8009/v1", apiKey: "none", bundleId: null, disabled: true, provider_type: "openai-compat", models: [{ id: "n" }], gpuPolicy: null },
];

test("buildManagedEntries: enabled OpenAI-compatible rows only; native rows get their provider-scoped door", () => {
  const e = buildManagedEntries(rows);
  assert.deepEqual(Object.keys(e).sort(), ["Qwen Cloud", "crow-chat", "crow-voice"]);
  assert.equal(e["crow-chat"].baseUrl, "http://100.64.9.1:3001/llm/p/crow-chat/v1");
  assert.equal(e["crow-chat"].headers, undefined);
  assert.equal(e["crow-chat"].apiKey, "none", "pi requires an apiKey string");
  assert.equal(e["crow-chat"].api, "openai-completions");
  assert.deepEqual(e["crow-chat"].models, [{ id: "qwen3.6-35b-a3b", contextWindow: 262144 }]);
  assert.equal(e["crow-voice"].headers, undefined);
  assert.equal(e["Qwen Cloud"].apiKey, "sk-live", "the DB key is the source of truth (the 10-01 stale-key failure)");
});

test("mergeManaged: adds, updates, removes managed ids; hand-written entries are never touched", () => {
  const file = {
    providers: {
      "crow-local": { baseUrl: "http://100.64.9.1:8003/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] },
      "crow-voice": { baseUrl: "http://hand-written/v1", apiKey: "none", models: [{ id: "qwen3.5-4b" }] },
      "gone": { baseUrl: "http://x/v1", apiKey: "none", models: [] },
      "Qwen Cloud": { baseUrl: "https://maas.example.com/v1", apiKey: "sk-stale", models: [] },
    },
    [CROW_MANAGED_KEY]: ["gone", "Qwen Cloud"],
  };
  const { json, added, updated, removed } = mergeManaged(file, buildManagedEntries(rows));
  assert.deepEqual(added, ["crow-chat"]);
  assert.deepEqual(updated, ["Qwen Cloud"]);
  assert.deepEqual(removed, ["gone"]);
  assert.equal(json.providers["crow-local"].baseUrl, "http://100.64.9.1:8003/v1", "hand-written untouched");
  assert.equal(json.providers["crow-voice"].baseUrl, "http://hand-written/v1", "a hand-written id wins over a DB row");
  assert.equal(json.providers["Qwen Cloud"].apiKey, "sk-live");
  assert.deepEqual(json[CROW_MANAGED_KEY].sort(), ["Qwen Cloud", "crow-chat"]);
  assert.equal(json.providers.gone, undefined);
});

test("mergeManaged is idempotent", () => {
  const once = mergeManaged({ providers: {} }, buildManagedEntries(rows)).json;
  const twice = mergeManaged(once, buildManagedEntries(rows));
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.updated, []);
  assert.deepEqual(twice.removed, []);
});

test("piModelsSyncPath: primary home only by default; explicit path; kill switch", () => {
  const home = "/home/u";
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home }), "/home/u/.pi/agent/models.json");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow-r4", home }), null);
  assert.equal(piModelsSyncPath({ env: { CROW_PI_MODELS_SYNC_PATH: "/x/models.json" }, crowHome: "/home/u/.crow-r4", home }), "/x/models.json");
  assert.equal(piModelsSyncPath({ env: { CROW_PI_MODELS_SYNC: "0" }, crowHome: "/home/u/.crow", home }), null);
});

test("syncPiModelsJson writes atomically with mode 0600 and skips the write when nothing changed", async () => {
  const writes = [];
  const fakeDb = { execute: async () => ({ rows: [] }) };
  const listFn = async () => rows;
  let content = JSON.stringify({ providers: {} });
  const res = await syncPiModelsJson(fakeDb, {
    path: "/tmp/pi/models.json", listProvidersAllFn: listFn,
    readFileFn: () => content,
    writeFileAtomicFn: (p, data, mode) => { writes.push({ p, mode }); content = data; },
  });
  assert.deepEqual(res.added.sort(), ["Qwen Cloud", "crow-chat", "crow-voice"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, 0o600);
  await syncPiModelsJson(fakeDb, { path: "/tmp/pi/models.json", listProvidersAllFn: listFn, readFileFn: () => content, writeFileAtomicFn: (p, d, m) => writes.push({ p, m }) });
  assert.equal(writes.length, 1, "no-op run does not rewrite the file");
});

test("syncPiModelsJson refuses to clobber an unparseable file", async () => {
  await assert.rejects(
    syncPiModelsJson({}, { path: "/tmp/x.json", listProvidersAllFn: async () => rows, readFileFn: () => "{not json", writeFileAtomicFn: () => { throw new Error("must not write"); } }),
    /not valid JSON/,
  );
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/pi-models-sync.test.js`

- [ ] **Step 3: Implement.**

```js
// servers/shared/pi-models-sync.js
/**
 * M1 (spec §11.6): keep crow-managed provider entries in pi's models.json.
 * The Crow providers table is the source of truth for Bot Builder and
 * Perch; pi reads models.json. A top-level "$crowManaged" array names the
 * ids this module owns. Hand-written entries are never touched, and a
 * hand-written id wins over a DB row of the same id. The reconciler
 * (providers-db.js) skips $crowManaged ids so this output is never
 * re-imported (Task 2).
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { doorKindOf, providerDoorUrl } from "../gateway/models/door-resolve.js";
import { listProvidersAll } from "./providers-db.js";

export const CROW_MANAGED_KEY = "$crowManaged";
const OPENAI_TYPES = new Set([null, undefined, "", "openai-compat", "openai"]);

export function piModelsSyncPath({ env = process.env, crowHome = env.CROW_HOME || join(homedir(), ".crow"), home = env.HOME || homedir() } = {}) {
  if (env.CROW_PI_MODELS_SYNC === "0") return null;
  if (env.CROW_PI_MODELS_SYNC_PATH) return env.CROW_PI_MODELS_SYNC_PATH;
  return resolve(crowHome) === resolve(join(home, ".crow")) ? join(home, ".pi", "agent", "models.json") : null;
}

function cleanModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => {
      const out = { id: m.id };
      for (const k of ["name", "contextWindow", "maxTokens", "reasoning", "input"]) if (m[k] !== undefined) out[k] = m[k];
      return out;
    });
}

export function buildManagedEntries(rows) {
  const out = {};
  for (const r of rows) {
    if (r.disabled) continue;
    if (r.gpuPolicy?.local_only === true) continue;
    if (!OPENAI_TYPES.has(r.provider_type)) continue;
    const models = cleanModels(r.models);
    if (!models.length || !r.baseUrl) continue;
    const kind = doorKindOf({ baseUrl: r.baseUrl, bundleId: r.bundleId, gpuPolicy: r.gpuPolicy, models: r.models });
    const native = kind === "native-owned" || kind === "native-foreign";
    out[r.id] = { baseUrl: native ? providerDoorUrl(r.baseUrl, r.id) : r.baseUrl, apiKey: r.apiKey || "none", api: "openai-completions", models };
  }
  return out;
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function mergeManaged(fileJson, entries) {
  const json = { ...(fileJson || {}), providers: { ...((fileJson && fileJson.providers) || {}) } };
  const prevManaged = new Set(Array.isArray(json[CROW_MANAGED_KEY]) ? json[CROW_MANAGED_KEY] : []);
  const handWritten = new Set(Object.keys(json.providers).filter((id) => !prevManaged.has(id)));
  const added = [], updated = [], removed = [];
  const nextManaged = new Set();
  for (const [id, entry] of Object.entries(entries)) {
    if (handWritten.has(id)) continue;
    nextManaged.add(id);
    if (!(id in json.providers)) { json.providers[id] = entry; added.push(id); }
    else if (!same(json.providers[id], entry)) { json.providers[id] = entry; updated.push(id); }
  }
  for (const id of prevManaged) {
    if (!nextManaged.has(id) && id in json.providers) { delete json.providers[id]; removed.push(id); }
  }
  json[CROW_MANAGED_KEY] = [...nextManaged].sort();
  return { json, added: added.sort(), updated: updated.sort(), removed: removed.sort() };
}

function defaultWriteAtomic(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.crow-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export async function syncPiModelsJson(db, {
  path = piModelsSyncPath(),
  listProvidersAllFn = listProvidersAll,
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileAtomicFn = defaultWriteAtomic,
} = {}) {
  if (!path) return { disabled: true };
  let current = { providers: {} };
  let raw = null;
  try { raw = readFileFn(path); } catch (err) { if (err.code !== "ENOENT") throw err; }
  if (raw !== null) {
    try { current = JSON.parse(raw); } catch { throw new Error(`pi models.json at ${path} is not valid JSON — refusing to overwrite it`); }
  }
  const { json, added, updated, removed } = mergeManaged(current, buildManagedEntries(await listProvidersAllFn(db)));
  if (added.length || updated.length || removed.length || !Array.isArray(current[CROW_MANAGED_KEY])) {
    writeFileAtomicFn(path, JSON.stringify(json, null, 2) + "\n", 0o600);
  }
  return { path, added, updated, removed };
}
```

In `providers-db.js`:

```js
let _providerChangeHook = null;
/** M1: called (fire-and-forget) after every provider write that reaches emitSync. */
export function setProviderChangeHook(fn) { _providerChangeHook = typeof fn === "function" ? fn : null; }

async function emitSync(db, op, row) {
  await emitOrQueue(_syncManager, db, "providers", op, row);
  if (_providerChangeHook) {
    try { _providerChangeHook({ op, id: row?.id }); } catch (err) { console.warn(`[providers] change hook failed: ${err.message}`); }
  }
}
```

In `servers/gateway/boot/admin-api.js`, right after the boot `syncProvidersFromModelsJson` block (the reconciler must run first, so it sees the file before M1 rewrites it), install the hook and run once:

```js
    try {
      const { syncPiModelsJson, piModelsSyncPath } = await import("../../shared/pi-models-sync.js");
      const { setProviderChangeHook } = await import("../../shared/providers-db.js");
      const target = piModelsSyncPath();
      if (target) {
        let timer = null;
        const run = () => syncPiModelsJson(createDbClient(), { path: target })
          .then((r) => { if (r.added?.length || r.updated?.length || r.removed?.length) console.log(`[pi-models-sync] ${target}: +${r.added.length} ~${r.updated.length} -${r.removed.length}`); })
          .catch((err) => console.warn(`[pi-models-sync] ${err.message}`));
        setProviderChangeHook(() => { clearTimeout(timer); timer = setTimeout(run, 2000); timer.unref?.(); });
        await run();
      } else {
        console.log("[pi-models-sync] disabled for this instance (not the primary CROW_HOME and no CROW_PI_MODELS_SYNC_PATH)");
      }
    } catch (err) {
      console.warn(`[pi-models-sync] boot failed: ${err.message}`);
    }
```

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/pi-models-sync.test.js tests/providers-reconcile-native-guard.test.js tests/providers-upsert-noop.test.js tests/models-json-seam.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/shared/pi-models-sync.js tests/pi-models-sync.test.js
git commit servers/shared/pi-models-sync.js servers/shared/providers-db.js servers/gateway/boot/admin-api.js tests/pi-models-sync.test.js -m "feat(pi): keep crow-managed provider entries in pi models.json (M1), hand-written entries untouched"
```

---

### Task 10: Pre-spawn validation (M2)

**Files:**
- Create: `scripts/pi-bots/pi-model-catalog.mjs`
- Modify: `scripts/pi-bots/bot-world.mjs` (after `resolveModel`), `scripts/pi-bots/job_runner.mjs` (after its `resolveModel`)
- Test: `tests/pi-model-catalog.test.js`

**Interfaces:**
- Consumes: `resolveNodeBin`, `resolvePiCli` from `scripts/pi-bots/pi_resolver.mjs`.
- Produces:
  - `parsePiListModels(stdout) -> Set<"provider/model">`
  - `listPiModels({ spawnSyncFn, nowFn, ttlMs = 300000, force = false, resolvePiCliFn, resolveNodeBinFn }) -> { ok: true, keys: Set } | { ok: false, error: string }` (cached; a miss in `checkPiModel` re-lists once with `force`)
  - `invalidatePiModelCache()`
  - `checkPiModel({ provider, model }, deps) -> { ok: true } | { ok: false, message }` — message text exactly `model "<provider>/<model>" is not available to the bot engine`; a failed listing returns `{ ok: true, unverified: true }`.
  - `class PiModelUnavailableError extends Error { code = "PI_MODEL_UNAVAILABLE" }`

- [ ] **Step 1: Write the failing test.**

```js
// tests/pi-model-catalog.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiListModels, listPiModels, checkPiModel, invalidatePiModelCache } from "../scripts/pi-bots/pi-model-catalog.mjs";

// CI has no pi installed: every call injects the resolvers.
const R = { resolvePiCliFn: () => ({ cliPath: "/fake/pi/cli.js", source: "env" }), resolveNodeBinFn: () => "/fake/node" };
const OUT = [
  "provider         model              context  max-out  thinking  images",
  "crow-chat        qwen3.6-35b-a3b    262K     32K      yes       yes",
  "Qwen Cloud       qwen3.8-max        1M       64K      yes       no",
  "zai-coding       glm-5.1            200K     32K      yes       no",
].join("\n");

test("parse: columns are separated by two or more spaces (provider ids may contain one space)", () => {
  const keys = parsePiListModels(OUT);
  assert.ok(keys.has("crow-chat/qwen3.6-35b-a3b"));
  assert.ok(keys.has("Qwen Cloud/qwen3.8-max"));
  assert.ok(keys.has("zai-coding/glm-5.1"));
  assert.equal(keys.size, 3);
});

test("listing is cached for ttl and invalidated on demand", () => {
  invalidatePiModelCache();
  let calls = 0, t = 0;
  const spawnSyncFn = () => { calls++; return { status: 0, stdout: OUT, stderr: "" }; };
  listPiModels({ ...R, spawnSyncFn, nowFn: () => t });
  t = 1000;
  listPiModels({ ...R, spawnSyncFn, nowFn: () => t });
  assert.equal(calls, 1);
  invalidatePiModelCache();
  listPiModels({ ...R, spawnSyncFn, nowFn: () => t });
  assert.equal(calls, 2);
});

test("unknown model fails with the exact operator message", () => {
  invalidatePiModelCache();
  const r = checkPiModel({ provider: "crow-chat", model: "nope" }, { ...R, spawnSyncFn: () => ({ status: 0, stdout: OUT, stderr: "" }) });
  assert.deepEqual(r, { ok: false, message: 'model "crow-chat/nope" is not available to the bot engine' });
});

test("a failed listing lets the turn proceed (unverified)", () => {
  invalidatePiModelCache();
  const r = checkPiModel({ provider: "crow-chat", model: "qwen3.6-35b-a3b" }, { ...R, spawnSyncFn: () => ({ status: 1, stdout: "", stderr: "boom" }) });
  assert.deepEqual(r, { ok: true, unverified: true });
});

test("a known model passes", () => {
  invalidatePiModelCache();
  assert.deepEqual(checkPiModel({ provider: "zai-coding", model: "glm-5.1" }, { ...R, spawnSyncFn: () => ({ status: 0, stdout: OUT, stderr: "" }) }), { ok: true });
});

test("a missing pi CLI is a failed listing, not a crash", () => {
  invalidatePiModelCache();
  const l = listPiModels({ resolvePiCliFn: () => null, resolveNodeBinFn: () => "/fake/node" });
  assert.equal(l.ok, false);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/pi-model-catalog.test.js`

- [ ] **Step 3: Implement.**

```js
// scripts/pi-bots/pi-model-catalog.mjs
/**
 * M2 (spec §11.6): know which provider/model keys pi can actually use, so a
 * bot turn fails fast with a clear message instead of spawning pi into
 * "Unknown provider". Source: `pi --list-models` (pi's own resolver, so it
 * includes pi's built-in providers that models.json never lists). Cached
 * 5 minutes; M1 writes invalidate it through the gateway's change hook.
 * A listing that fails never blocks a turn (unverified pass + one log line).
 */
import { spawnSync } from "node:child_process";
import { resolveNodeBin, resolvePiCli } from "./pi_resolver.mjs";

let _cache = null; // { at, keys }
let _warned = false;

export function invalidatePiModelCache() { _cache = null; }

export function parsePiListModels(stdout) {
  const keys = new Set();
  const lines = String(stdout || "").split("\n");
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length >= 2 && cols[0] && cols[1]) keys.add(`${cols[0]}/${cols[1]}`);
  }
  return keys;
}

export class PiModelUnavailableError extends Error {
  constructor(message) { super(message); this.name = "PiModelUnavailableError"; this.code = "PI_MODEL_UNAVAILABLE"; }
}

export function listPiModels({
  spawnSyncFn = spawnSync, nowFn = Date.now, ttlMs = 300_000, force = false,
  resolvePiCliFn = resolvePiCli, resolveNodeBinFn = resolveNodeBin,
} = {}) {
  const now = nowFn();
  if (!force && _cache && now - _cache.at < ttlMs) return { ok: true, keys: _cache.keys };
  let res;
  try {
    const cli = resolvePiCliFn();
    if (!cli || !cli.cliPath) return { ok: false, error: "pi CLI not found (pi_resolver ladder)" };
    res = spawnSyncFn(resolveNodeBinFn(), [cli.cliPath, "--list-models"], { encoding: "utf8", timeout: 15_000 });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res || res.status !== 0) return { ok: false, error: (res && (res.stderr || `exit ${res.status}`)) || "no result" };
  const keys = parsePiListModels(res.stdout);
  _cache = { at: now, keys };
  return { ok: true, keys };
}

export function checkPiModel({ provider, model }, deps = {}) {
  const l = listPiModels(deps);
  if (!l.ok) {
    if (!_warned) { _warned = true; console.warn(`[pi-model-catalog] pi --list-models failed, not validating models: ${l.error}`); }
    return { ok: true, unverified: true };
  }
  const key = `${provider}/${model}`;
  if (l.keys.has(key)) return { ok: true };
  // A provider added in the last 5 minutes (an M1 write) is not in the cache
  // yet: re-list once, uncached, before refusing.
  if (!deps.force) {
    const again = listPiModels({ ...deps, force: true });
    if (again.ok && again.keys.has(key)) return { ok: true };
  }
  return { ok: false, message: `model "${key}" is not available to the bot engine` };
}
```

In `scripts/pi-bots/bot-world.mjs`, right after `const resolved = await resolveModel(def, { escalate });`:

```js
  // M2: fail the turn before spawning when pi cannot use the resolved model.
  const piCheck = checkPiModel(resolved);
  if (!piCheck.ok) throw new PiModelUnavailableError(piCheck.message);
```

with `import { checkPiModel, PiModelUnavailableError } from "./pi-model-catalog.mjs";` at the top. In `scripts/pi-bots/job_runner.mjs`, right after its `const resolved = await resolveModel(def, { escalate: !!job.escalate });`, add the same two lines and import. The callers already turn a thrown error into an in-band failure reply (the bridge's turn error path); verify by reading how `bot-world.mjs`'s caller handles a rejection before committing, and if it does not surface the message to the operator, wrap the throw site's caller to post `err.message` as the reply.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/pi-model-catalog.test.js tests/pi-bots-instance-paths.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/pi-bots/pi-model-catalog.mjs tests/pi-model-catalog.test.js
git commit scripts/pi-bots/pi-model-catalog.mjs scripts/pi-bots/bot-world.mjs scripts/pi-bots/job_runner.mjs tests/pi-model-catalog.test.js -m "feat(pi-bots): fail a turn fast when pi cannot use the resolved model (M2)"
```

---

### Task 11: Bot Builder picker marks models pi cannot resolve (M3)

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/data-queries.js` (`loadModelOptions`), `servers/gateway/dashboard/panels/bot-builder/editor.js` (`optGroups`), `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/bot-builder-model-marks.test.js`

**Interfaces:**
- Consumes: `listPiModels` (Task 10).
- Produces: `loadModelOptions(db, { listPiModelsFn }) -> { error, opts: Array<{ provider, key, label, piKnown: boolean|null }> }` (`null` = listing failed, unknown); i18n key `botbuilder.modelNotInEngine` (en: "not available to the bot engine", es: "no disponible para el motor de bots").

- [ ] **Step 1: Write the failing test.**

```js
// tests/bot-builder-model-marks.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModelOptions } from "../servers/gateway/dashboard/panels/bot-builder/data-queries.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const db = {
  execute: async () => ({ rows: [
    { id: "crow-chat", base_url: "http://x/llm/v1", models: JSON.stringify([{ id: "qwen3.6-35b-a3b" }]), disabled: 0 },
    { id: "Qwen Cloud", base_url: "https://y/v1", models: JSON.stringify([{ id: "qwen3.8-max" }]), disabled: 0 },
  ] }),
};

test("each option carries piKnown from the pi listing", async () => {
  const { opts } = await loadModelOptions(db, { listPiModelsFn: () => ({ ok: true, keys: new Set(["crow-chat/qwen3.6-35b-a3b"]) }) });
  const by = Object.fromEntries(opts.map((o) => [o.key, o.piKnown]));
  assert.equal(by["crow-chat/qwen3.6-35b-a3b"], true);
  assert.equal(by["Qwen Cloud/qwen3.8-max"], false);
});

test("a failed listing leaves piKnown null (no false warnings)", async () => {
  const { opts } = await loadModelOptions(db, { listPiModelsFn: () => ({ ok: false, error: "x" }) });
  assert.ok(opts.every((o) => o.piKnown === null));
});

test("the mark string exists in en and es", () => {
  assert.equal(t("botbuilder.modelNotInEngine", "en"), "not available to the bot engine");
  assert.equal(t("botbuilder.modelNotInEngine", "es"), "no disponible para el motor de bots");
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/bot-builder-model-marks.test.js`

- [ ] **Step 3: Implement.** `data-queries.js`:

```js
import { listPiModels } from "../../../../../scripts/pi-bots/pi-model-catalog.mjs";

export async function loadModelOptions(db, { listPiModelsFn = listPiModels } = {}) {
  try {
    const all = await listProvidersAll(db);
    const enabled = all.filter((p) => !p.disabled);
    let known = null;
    try { const l = listPiModelsFn(); known = l.ok ? l.keys : null; } catch { known = null; }
    const opts = [];
    for (const row of enabled) {
      for (const m of row.models || []) {
        const mid = typeof m === "string" ? m : m.id;
        if (!mid) continue;
        const key = `${row.id}/${mid}`;
        opts.push({ provider: row.id, key, label: (m.name || mid), piKnown: known ? known.has(key) : null });
      }
    }
    if (!opts.length) return { error: "No providers configured.", opts: [] };
    return { error: null, opts };
  } catch (err) {
    return { error: "Provider registry unavailable: " + err.message, opts: [] };
  }
}
```

`editor.js` `optGroups` option label: replace `${escapeHtml(m.label)}` with `${escapeHtml(m.label)}${m.piKnown === false ? " (" + escapeHtml(t("botbuilder.modelNotInEngine", lang)) + ")" : ""}` (this is server-rendered HTML, not client JS). `i18n.js`, beside the other `botbuilder.*` keys:

```js
  "botbuilder.modelNotInEngine": { en: "not available to the bot engine", es: "no disponible para el motor de bots" },
```

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/bot-builder-model-marks.test.js tests/i18n-global-parity.test.js` and every `tests/bot-builder*.test.js` (`ls tests | grep bot-builder`).

- [ ] **Step 5: Commit.**

```bash
git add tests/bot-builder-model-marks.test.js
git commit servers/gateway/dashboard/panels/bot-builder/data-queries.js servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/shared/i18n.js tests/bot-builder-model-marks.test.js -m "feat(bot-builder): mark picker models the bot engine cannot resolve (M3)"
```

---

### Task 12: pi-lab contract — `lib/local-models.mjs` gateway mode (handoff file)

Spec §5.3, D8. pi-lab owns `~/pi-lab`; this task writes a handoff file into pi-lab's inbox carrying the exact change below, and the pi-lab session lands it (the route that worked for #386 and the gufo evaluation). Crow's PR must not depend on it: compose entries keep working unchanged.

**Files (in `~/pi-lab`, delivered by the handoff):**
- Modify: `lib/local-models.mjs`
- Create: `lib/local-models-gateway.test.mjs`; add it to `package.json` `test:lib`
- Create (crow side, committed in pi-lab's repo by the handoff author): `~/pi-lab/docs/handoffs-inbox-<date>-from-crow-models-gateway-contract.md`

**Interfaces:**
- Consumes: Task 8 routes (`GET /llm/models`, `POST /llm/models/:provider/start|stop`, `GET /llm/models/jobs/:id`), Task 6 token file `<CROW_HOME>/models-token`.
- Produces (pi-lab, unchanged names): `readLocalModels`, `isRunning`, `startModel`, `stopModel`, `wouldEvict`, `annotate`, `enqueueLifecycle`; new `refreshGatewayState()`; a `localModels` entry may now be `{ gateway: "http://127.0.0.1:3001", provider: "crow-chat" }` instead of `{ composeDir, url, group, evicts }`; `startModel`'s `onProgress` gains the stage `"reserved"`.

- [ ] **Step 1: Write the pi-lab test** (`~/pi-lab/lib/local-models-gateway.test.mjs`, pi-lab's plain-node assertion style):

```js
/**
 * Gateway-mode entries (crow models arc plan 2 Task 12): localModels entries
 * with { gateway, provider } drive Crow's lifecycle API instead of docker
 * compose. Run from the repo root: node lib/local-models-gateway.test.mjs
 */
import http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lm-gw-"));
fs.writeFileSync(path.join(tmp, "models-token"), "tok");
process.env.CROW_HOME = tmp;

const state = { resident: new Set(["crow-chat"]), jobs: new Map(), seq: 0, reserved: false };
const srv = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer tok") { res.writeHead(401); return res.end("{}"); }
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/llm/models") {
    return send(200, { models: [
      { provider: "crow-chat", status: state.resident.has("crow-chat") ? "resident" : "stopped", wouldEvict: [] },
      { provider: "crow-local-27b-512k", status: state.resident.has("crow-local-27b-512k") ? "resident" : "stopped", wouldEvict: state.resident.has("crow-chat") ? ["crow-chat"] : [] },
    ] });
  }
  let m = req.url.match(/^\/llm\/models\/([^/]+)\/start$/);
  if (req.method === "POST" && m) {
    const id = `j${++state.seq}`;
    // Each GET of the job returns the next state; the last one sticks.
    state.jobs.set(id, state.reserved
      ? [{ state: "blocked_by_reservation", reservation: { owner: "win", expires_at: "x" } }]
      : [{ state: "starting" }, { state: "resident" }]);
    if (!state.reserved) { state.resident.delete("crow-chat"); state.resident.add(m[1]); }
    return send(202, { job_id: id });
  }
  m = req.url.match(/^\/llm\/models\/jobs\/(.+)$/);
  if (m) { const seq = state.jobs.get(m[1]); return send(200, seq.length > 1 ? seq.shift() : seq[0]); }
  m = req.url.match(/^\/llm\/models\/([^/]+)\/stop$/);
  if (req.method === "POST" && m) { state.resident.delete(m[1]); return send(200, { stopped: true }); }
  send(404, {});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const gw = `http://127.0.0.1:${srv.address().port}`;
const settings = path.join(tmp, "settings.json");
fs.writeFileSync(settings, JSON.stringify({ localModels: {
  "crow-local/qwen3.6-35b-a3b": { gateway: gw, provider: "crow-chat" },
  "crow-local-27b-512k/qwen3.8-27b-512k": { gateway: gw, provider: "crow-local-27b-512k" },
} }));
process.env.PI_LOCAL_MODELS_SETTINGS = settings;
const lm = await import("./local-models.mjs");

a("isRunning reads gateway status", (await lm.isRunning("crow-local/qwen3.6-35b-a3b")) === true);
a("isRunning false for a stopped provider", (await lm.isRunning("crow-local-27b-512k/qwen3.8-27b-512k")) === false);
await lm.refreshGatewayState();
const models = lm.readLocalModels();
a("wouldEvict comes from the gateway's wouldEvict[]", lm.wouldEvict(models, "crow-local-27b-512k/qwen3.8-27b-512k", "crow-local/qwen3.6-35b-a3b") === true);
a("wouldEvict is false the other way", lm.wouldEvict(models, "crow-local/qwen3.6-35b-a3b", "crow-local-27b-512k/qwen3.8-27b-512k") === false);
const stages = [];
await lm.startModel("crow-local-27b-512k/qwen3.8-27b-512k", { onProgress: (s) => stages.push(s), pollMs: 5 });
a("start reaches resident through the job", (await lm.isRunning("crow-local-27b-512k/qwen3.8-27b-512k")) === true);
a("progress reports starting then loading", stages[0] === "starting" && stages.includes("loading"));
state.reserved = true;
const st2 = [];
let err = null;
await lm.startModel("crow-local/qwen3.6-35b-a3b", { onProgress: (s) => st2.push(s), pollMs: 5 }).catch((e) => { err = e; });
a("a reserved box rejects with the owner", err && /reserved by win/.test(err.message));
a("progress reports reserved", st2.includes("reserved"));
await lm.stopModel("crow-local-27b-512k/qwen3.8-27b-512k");
a("stop goes through the gateway", state.resident.has("crow-local-27b-512k") === false);
fs.writeFileSync(settings, JSON.stringify({ localModels: { "x/y": { composeDir: "/nonexistent", url: "http://127.0.0.1:1/v1", group: "g" } } }));
a("compose entries still read as before", lm.readLocalModels()["x/y"].composeDir === "/nonexistent");
srv.close();
console.log("all gateway-mode tests passed");
```

- [ ] **Step 2: Run in pi-lab, expect FAIL:** `cd ~/pi-lab && node lib/local-models-gateway.test.mjs` (fails at the first assertion: `isRunning` returns null for an entry without `url`).

- [ ] **Step 3: Implement in `~/pi-lab/lib/local-models.mjs`.** Replace the `SETTINGS_PATH` constant and add the gateway client; branch each exported function on `entry.gateway`:

```js
const SETTINGS_PATH = process.env.PI_LOCAL_MODELS_SETTINGS || path.join(os.homedir(), ".pi", "agent", "settings.json");
const CROW_HOME = () => process.env.CROW_HOME || path.join(os.homedir(), ".crow");

/** Bearer for Crow's lifecycle API: the path-scoped models token Crow mints at boot. */
function modelsToken() {
	try { return fs.readFileSync(path.join(CROW_HOME(), "models-token"), "utf8").trim(); } catch { return null; }
}

async function gw(entry, method, p) {
	const token = modelsToken();
	if (!token) throw new Error(`no Crow models token at ${path.join(CROW_HOME(), "models-token")}`);
	const res = await fetch(`${entry.gateway.replace(/\/+$/, "")}${p}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok && res.status !== 202) {
		const e = body?.error || {};
		throw new Error(`${method} ${p}: ${res.status} ${e.code || ""} ${e.message || ""}`.trim());
	}
	return body;
}

// provider -> { status, wouldEvict[] } from the last GET /llm/models per gateway
const gatewayState = new Map();

/** Refresh the cached gateway listing (wouldEvict stays a sync predicate). */
export async function refreshGatewayState() {
	const gateways = new Set(Object.values(readLocalModels()).filter((e) => e?.gateway).map((e) => e.gateway));
	for (const g of gateways) {
		try {
			const { models = [] } = await gw({ gateway: g }, "GET", "/llm/models");
			for (const m of models) gatewayState.set(m.provider, m);
		} catch {
			/* leave the previous snapshot; isRunning reports false on its own failure */
		}
	}
}
```

`isRunning(ref)`, first lines:

```js
	const entry = readLocalModels()[ref];
	if (entry?.gateway) {
		try {
			const { models = [] } = await gw(entry, "GET", "/llm/models");
			for (const m of models) gatewayState.set(m.provider, m);
			return models.find((m) => m.provider === entry.provider)?.status === "resident";
		} catch {
			return false;
		}
	}
	if (!entry?.url) return null;
```

`wouldEvict(models, starterRef, runningRef)`, first lines after the self/undefined guard:

```js
	const starter = models[starterRef];
	const peer = models[runningRef];
	if (starter?.gateway) {
		const snap = gatewayState.get(starter.provider);
		return !!(snap && peer?.provider && Array.isArray(snap.wouldEvict) && snap.wouldEvict.includes(peer.provider));
	}
```

`annotate(refs)`: call `await refreshGatewayState();` before the `Promise.all`.

`stopModel(ref)`, inside the queued function before the compose branch:

```js
		if (entry?.gateway) { await gw(entry, "POST", `/llm/models/${encodeURIComponent(entry.provider)}/stop`); return; }
```

`startModelNow(ref, { timeoutMs = 600_000, onProgress, pollMs = 2000 } = {})`, right after reading `entry` and before the compose eviction loop:

```js
	if (entry?.gateway) {
		onProgress?.("starting");
		const { job_id } = await gw(entry, "POST", `/llm/models/${encodeURIComponent(entry.provider)}/start`);
		const deadline = Date.now() + timeoutMs;
		let announcedLoading = false;
		while (Date.now() < deadline) {
			const job = await gw(entry, "GET", `/llm/models/jobs/${encodeURIComponent(job_id)}`);
			if (job.state === "resident") return true;
			if (job.state === "blocked_by_reservation") {
				onProgress?.("reserved");
				throw new Error(`${ref}: box reserved by ${job.reservation?.owner || "?"} until ${job.reservation?.expires_at || "?"}`);
			}
			if (job.state === "failed") {
				const tail = Array.isArray(job.cause) && job.cause.length ? `\n${job.cause.slice(-10).join("\n")}` : "";
				throw new Error(`${ref} failed to start: ${job.error || "unknown"}${tail}`);
			}
			if (job.state === "evicting") onProgress?.("evicting");
			if (!announcedLoading && (job.state === "starting" || job.state === "evicting")) { onProgress?.("loading"); announcedLoading = true; }
			await sleep(pollMs);
		}
		throw new Error(`${ref} did not become resident within ${Math.round(timeoutMs / 60000)} min`);
	}
	if (!entry?.composeDir) throw new Error(`not a managed local model: ${ref}`);
```

(the old `if (!entry?.composeDir) throw …` line moves below this block, unchanged.) In the compose eviction loop, skip gateway peers: `if (peer.gateway) continue;` as the first statement (the gateway evicts its own siblings).

Add `&& node lib/local-models-gateway.test.mjs` to `test:lib` in `package.json`.

- [ ] **Step 4: Run in pi-lab:** `cd ~/pi-lab && node lib/local-models.test.mjs && node lib/local-models-gateway.test.mjs` → both pass.

- [ ] **Step 5: Write the handoff file** `~/pi-lab/docs/handoffs-inbox-<YYYY-MM-DD>-from-crow-models-gateway-contract.md` with: what shipped in crow (the door and its provider-scoped form `/llm/p/<provider>/v1`, the `X-Crow-Provider` header alternative, the lifecycle API, the models token path, M1's `$crowManaged` entries), the code of Steps 1 and 3 verbatim, and the **settings and models.json changes that happen later, per plan 4 window** (not now):

| when | `~/.pi/agent/settings.json` `localModels` | `~/.pi/agent/models.json` (hand-written entries pi-lab owns) |
|---|---|---|
| after plan 4 window 3 (35B native) | `"crow-local/qwen3.6-35b-a3b": { "gateway": "http://127.0.0.1:3001", "provider": "crow-chat" }` | `crow-local`: `baseUrl` → `http://100.118.41.122:3001/llm/p/crow-chat/v1` (the window does this edit and backs the file up; pi-lab keeps it) |
| after plan 4 window 4 (512k native) | `"crow-local-27b-512k/qwen3.8-27b-512k": { "gateway": "http://127.0.0.1:3001", "provider": "crow-local-27b-512k" }` | `crow-local-27b-512k`: `baseUrl` → `http://100.118.41.122:3001/llm/p/crow-local-27b-512k/v1` |
| solo/copilot stay external (spec §11.3) | unchanged (compose) | unchanged |

Ask pi-lab to land Steps 1–4 on its working branch and answer in a reply file. Commit only the handoff file in pi-lab: `cd ~/pi-lab && git add docs/handoffs-inbox-…md && git commit docs/handoffs-inbox-…md -m "handoff from crow: models gateway contract"`.

---

### Task 13: Architecture doc, full suite, PR

**Files:**
- Modify: `docs/architecture/models.md`

- [ ] **Step 1: Extend `docs/architecture/models.md`** with three sections, 4–8 sentences each, drawn from spec §5 and §11: *The door* (addressing order with the provider path/header/qualified/bare/companion rules, forwarded endpoints, cloud refusal, the one-hop guard, `GET /llm/v1/models`); *The lifecycle API* (routes, job states, `NOT_OWNER`/`EXTERNAL_ENGINE`, the models token at `<CROW_HOME>/models-token`); *pi's models.json* (`$crowManaged`, hand-written entries win, which instance writes, the reconciler's `skipped_native`/`skipped_managed`, the pre-spawn check and its fail-open rule). Add one paragraph on replication: the behind-marker (`__sync_behind_v1:<peer>`) and when the catch-up runs.
- [ ] **Step 2:** `cd docs && npm run build` succeeds.
- [ ] **Step 3: Full suite and static checks** (node 24 on PATH): `npm test`; `node scripts/check-port-allocation.js`; `node scripts/build-registry.mjs --check`; `npm run validate-model-catalog`. All green; record the pass count.
- [ ] **Step 4: Commit, rebase, push, PR** (the github MCP server; `gh` is not installed on crow):

```bash
git commit docs/architecture/models.md -m "docs(models): door, lifecycle API, pi models.json managed sync, providers catch-up"
git pull --rebase origin main && git push -u origin feat/models-doors
```

PR title: `feat: models doors — replication catch-up, model-addressed /llm/v1, lifecycle API, pi models.json sync (arc plan 2/4)`. Body: the task list, the Task 1 diagnosis outputs and the matched hypothesis, and "no row converted, no bundle deleted, no model started; deploy rides auto-update only when the box is free".
- [ ] **Step 5: Gate.** Poll `https://api.github.com/repos/kh0pper/crow/commits/<head sha>/check-runs` until `suite`, `static-checks`, `audit` are `completed`/`success`. Merge only then.

---

## Operational steps (after merge and auto-update; NOT code tasks)

Preconditions for every step: the PR is merged and CI is green; `git -C ~/crow log -1 --oneline` shows the merge commit; `auto_update_last_result` in `dashboard_settings` is not "Skipped"; `node ~/crow/scripts/ops/box-reserve.mjs status` prints `none`.

### Op 1: catch black-swan up (only if Task 1 matched H1)

The behind-marker only exists for emits parked after the fix shipped; the 08-20 → today gap needs a seeded marker. This writes one `dashboard_settings` row on the live DB (Kevin's go required) and starts nothing.

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
BS_ID=$(sqlite3 -readonly ~/.crow/data/crow.db "SELECT id FROM crow_instances WHERE name LIKE '%swan%' AND status='active' LIMIT 1;")
BS_MAX=$(ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT COALESCE(MAX(lamport_ts),0) FROM providers;"')
echo "black-swan id=$BS_ID providers max lamport=$BS_MAX"
cd ~/crow && CROW_DATA_DIR=/home/kh0pp/.crow/data node --input-type=module -e "
import { createDbClient } from './servers/db.js';
const db = createDbClient();
await db.execute({ sql: 'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['__sync_behind_v1:$BS_ID', String($BS_MAX)] });
console.log('marker set'); db.close();"
```

The catch-up runs at the next gateway boot or the next time black-swan's feed arms. Verify within 30 minutes, read-only: `ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT id FROM providers WHERE id IN (\"crow-embed\",\"raven-flash-next\");"'` returns both ids. If not, read crow's journal for `providers catch-up for` and stop.

black-swan itself runs app `249d5919` (behind main) and needs the fix only if it emits to peers; updating it is a separate, Kevin-approved step.

### Op 2: mark the gufo slots as external engines, correct raven's label (spec §11.3)

Starts no model; no reservation needed. Writes three provider rows on crow's live DB through the normal upsert path (they replicate through the outbox).

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd ~/crow && CROW_DATA_DIR=/home/kh0pp/.crow/data node --input-type=module -e '
import { createDbClient } from "./servers/db.js";
import { listProvidersAll, upsertProvider } from "./servers/shared/providers-db.js";
const MARKS = [
  { id: "crow-local-27b",         url: "http://100.118.41.122:8006/v1", engine: { managed: "external", host: "crow",  label: "gufo" } },
  { id: "crow-local-27b-copilot", url: "http://100.118.41.122:8010/v1", engine: { managed: "external", host: "crow",  label: "gufo" } },
  { id: "raven-flash-next",       url: "http://10.0.0.126:8030/v1",     engine: { managed: "external", host: "raven", label: "gufo" } },
];
const db = createDbClient();
try {
  const all = await listProvidersAll(db);
  for (const m of MARKS) {
    const row = all.find((r) => r.id === m.id);
    if (!row) throw new Error(m.id + " MISSING — stop");
    if (row.baseUrl !== m.url) throw new Error(m.id + " base_url is " + row.baseUrl + ", expected " + m.url + " — stop");
    if (row.bundleId || row.gpuPolicy?.runtime === "native") throw new Error(m.id + " has a bundle or native runtime — stop");
    const res = await upsertProvider(db, { ...row, gpuPolicy: { ...(row.gpuPolicy || {}), engine: m.engine } });
    console.log(m.id, JSON.stringify(res));
  }
} finally { db.close(); }
'
```

Verify: `sqlite3 -readonly ~/.crow/data/crow.db "SELECT id, gpu_policy FROM providers WHERE id IN ('crow-local-27b','crow-local-27b-copilot','raven-flash-next');"` shows the three markers; within 60 s the Providers tab shows the "external · crow" badge on both 27B rows. pi-lab keeps starting them with compose; nothing else changes.

### Op 3: live acceptance window (~30 minutes)

Register first. CROW-SCHEDULE row (Reservations table):

```
| **<date> (<day>) <HH:MM> → <HH:MM+30>, hard cap 45 min (deadman)** | **models plan 2 acceptance**: door + lifecycle API on crow; starts ONLY the native qwen3.5-4b (:18100, ~3 GB, beside prod, evicts nothing) and stops it; one reservation-refusal check. Prod 35B/voice/embed untouched. | Claude session (crow) | curl against :3001 /llm/v1 and /llm/models with the models token; `box-reserve.mjs hold --allow qwen3.5-4b` | no native qwen3.5-4b running AND no box hold AND the deadman timer is gone AND this row moved to Done |
```

Slot: a weekday between 09:00 and 16:30 (the Engram queue never runs Mon–Fri 07:00–17:00), outside 02:15–04:15, not overlapping any row in the table.

Deadman (armed BEFORE anything starts; out of process; stops the 4B and releases the hold at the cap):

```bash
TOKEN=$(cat ~/.crow/models-token)
systemd-run --user --unit=models-p2-accept-deadman --on-active=45min --collect \
  /bin/sh -c "curl -s -m 20 -X POST -H 'authorization: Bearer $TOKEN' http://127.0.0.1:3001/llm/models/qwen3.5-4b/stop; node /home/kh0pp/crow/scripts/ops/box-reserve.mjs release"
```

Checks (each must pass; record outputs on the PR):

1. `node ~/crow/scripts/ops/box-reserve.mjs status` → `none`. Then `node ~/crow/scripts/ops/box-reserve.mjs hold --owner models-p2-accept --reason "plan 2 acceptance" --minutes 40 --allow qwen3.5-4b`.
2. Door, header addressing to a bundle row: `curl -s -m 60 http://127.0.0.1:3001/llm/v1/chat/completions -H 'content-type: application/json' -H 'X-Crow-Provider: crow-chat' -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Say OK."}],"max_tokens":8}'` → a completion.
3. Door from raven (tailnet reach of `:3001`): `ssh raven "curl -s -m 20 http://100.118.41.122:3001/llm/v1/embeddings -H 'content-type: application/json' -d '{\"model\":\"qwen3-embedding-0.6b\",\"input\":\"hello\"}' | head -c 200"` → an embedding. If it times out, the ufw rule for `:3001` from raven is missing: stop and report (window 1 of plan 4 depends on it).
4. Provider-scoped path: the same request to `http://127.0.0.1:3001/llm/p/crow-chat/v1/chat/completions` without the header → a completion from the 35B (check the gateway log line `door chat/completions -> crow-chat/…`). Cloud refusal: `-H 'X-Crow-Provider: qwen-cloud'` → HTTP 400 `NOT_LOCAL`.
5. Lifecycle: `curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:3001/llm/models | head -c 1000` lists `crow-local-27b` as `external_*`; then `POST /llm/models/qwen3.5-4b/start` → job → poll to `resident`; `GET /llm/models` shows it resident with `argv`.
6. Reservation refusal: `box-reserve.mjs hold --owner models-p2-accept --reason refusal-check --minutes 10` (no allow), `POST /llm/models/qwen3.5-4b/stop`, then `POST …/start` → job `blocked_by_reservation` with owner `models-p2-accept`.
7. Restore: `box-reserve.mjs release`; `systemctl --user stop models-p2-accept-deadman.timer`; confirm `GET /llm/models` shows `qwen3.5-4b` stopped and `curl -s http://100.118.41.122:8003/health` is 200 (35B untouched). Move the CROW-SCHEDULE row to Done with the result.

Rollback: nothing here changes prod; the deadman covers an abandoned window.

---

## Self-review (plan 2 against spec §5, §7 step 0, §8, §9, §11)

- §7 step 0 / §11.8 replication → Task 1 (diagnosis table H1–H4, two guard cases, the H1 red case, the fix), Op 1 (historical gap). r4 and grackle explicitly out of scope per §11.8.
- §5.1 + §11.4 door → Task 3 (resolver: provider path, header, qualified, bare, companion fall-through, ambiguity 400, defaultMember, cloud refusal, 508), Task 4 (routes: chat, completions, embeddings, rerank, models listing; acquire before forwarding native/bundle; external never acquired).
- §5.2 lifecycle API → Task 6 (auth; ruling: models token in addition to the local token), Task 7 (job states, listing statuses incl. external/foreign, `wouldEvict` = resident siblings only), Task 8 (routes, `NOT_OWNER` with owner and door, `EXTERNAL_ENGINE`, async jobs, `blocked_by_reservation` with owner/expiry, `cause` from Task 5's stderr tail).
- §5.3 + §11.6 pi contract → Task 9 (M1), Task 10 (M2), Task 11 (M3), Task 12 (pi-lab `local-models.mjs` keeps every exported name; `"reserved"` stage).
- §11.7 I5 → Task 2. §11.3 external interim → Op 2. §8 error codes: `AMBIGUOUS_MODEL`, `NOT_LOCAL`, `DOOR_LOOP`, `MODEL_NOT_SERVED`, `UNKNOWN_PROVIDER`, `NOT_OWNER`, `EXTERNAL_ENGINE`, `UNAUTHENTICATED`, `PI_MODEL_UNAVAILABLE`.
- §9 tests named in the spec and covered here: `/llm/v1` qualified and bare addressing, ambiguity, companion unchanged, 409 while reserved (Task 4 maps `ReservedError` to 409 on the door path, matching `/llm/acquire`); lifecycle auth, job states, stop, `NOT_OWNER`, status shape; two-instance sync of a disable and a conversion.
- Deliberately not here: panels (plan 3), runtimes and gufo (plan 3), any conversion or window that moves a role (plan 4).
- Names used across tasks: `resolveDoorTarget`, `listDoorModels`, `doorKindOf`, `isDoorUrl`, `providerDoorUrl`, `DOOR_PROVIDER_HEADER`, `DOOR_HOP_HEADER`, `createJobStore`, `buildModelsListing`, `JOB_STATES`, `stopNativeProvider`, `nativeSnapshot`, `mutexSiblingsOf`, `ensureModelsToken`, `validateModelsToken`, `modelsTokenPath`, `buildManagedEntries`, `mergeManaged`, `syncPiModelsJson`, `piModelsSyncPath`, `CROW_MANAGED_KEY`, `setProviderChangeHook`, `listPiModels`, `checkPiModel`, `parsePiListModels`, `invalidatePiModelCache`, `PiModelUnavailableError`, `BEHIND_FLAG_PREFIX`, `catchUpBehindPeers`, `_markPeerBehind`. Checked consistent.
- Placeholder scan: Task 1's fix is conditional on the diagnosis by design (H2–H4 stop and report, because their fix depends on evidence this plan cannot know); every other step has code or an exact command.
