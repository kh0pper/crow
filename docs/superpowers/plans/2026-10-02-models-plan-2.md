# Models arc plan 2 of 4: replication fix, gateway doors, lifecycle API, pi contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a native model reachable and controllable from anywhere on the tailnet through the owning gateway (the door and the lifecycle API), make provider changes actually reach paired peers again (black-swan has been stalled since 2026-08-20), and make pi see exactly the providers Crow has, so plan 4 can convert rows without breaking consumers.

**Revision 2 (2026-10-02, after the staff review at `~/crow-weekend-push/reports/models-plan2-review.md`).** This revision addresses criticals C1–C9 and adopts the cheap suggestions; the changes are summarized at the end of this file. Re-anchored to origin/main `8a3a8588` (#342 Ramble `lamport_origin`). It is compatible with PR #400 (`fix/platform-defects`): Task 1 adds marker cleanup to `teardownRevokedPeer` once that PR has merged.

**Architecture:** One crow PR (`feat/models-doors`) plus one pi-lab change delivered through a handoff file. Order: the replication diagnosis first (it stops unless the evidence isolates H1), then that fix with its own failing two-instance test, then the reconciler guard (I5), then the door as a pure resolver plus thin route changes, then the lifecycle API (pure job store and listing builder, then routes), then the pi models.json managed sync (M1), the pre-spawn check (M2) and the picker marks (M3), then the pi-lab `lib/local-models.mjs` gateway mode. Nothing here converts a provider row, deletes a bundle or starts a model; two operational steps after merge mark the gufo slots external and run a ~30-minute acceptance window.

**Tech Stack:** Node 24 (`export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH` before every node/npm command), `node:test` through the scratch harness, express routes, `@libsql/client` via `servers/db.js`, the InstanceSyncManager stub-feed harness (`tests/providers-war-sim.test.js` pattern).

**Spec:** `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md` §5 (doors, lifecycle API, pi contract), §7 step 0, §8, §9, and **§11 Amendment A** (§11.3 external interim, §11.4 door rulings, §11.6 M1–M3, §11.7 I5, §11.8 replication). Plan 1 (shipped as #305/#306) built `door.js`, `native-locality.js`, the owner gate and `NOT_OWNER`.

## Global Constraints

- Work in a worktree: `git worktree add ~/crow-wt-models-doors -b feat/models-doors origin/main`. Never `git checkout` in `~/crow`.
- Commit with positional paths: `git add <new files>` then `git commit <paths> -m "…"`; verify with `git show --stat HEAD`. Never `git add -A`. No AI attribution anywhere.
- Single test files ONLY through the harness: `npm test -- tests/<file>.test.js`. Never bare `node --test` (it writes the live `crow.db`).
- CI must be green before merge: query `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` and require `suite`, `static-checks`, `audit` all `completed`/`success`.
- No `SCHEMA_GENERATION` bump, no DDL. New persisted state lives in `dashboard_settings` keys (never allow-listed for sync) or files under `CROW_HOME`.
- Every new dashboard string ships `en` + `es` (`tests/i18n-global-parity.test.js`). Panel client JS is emitted inside template literals: no backticks, no stray `${`, createElement/textContent only.
- `:3001` listens on all interfaces, and crow's ufw allows LAN interfaces, so the door's protection is in code:
  - **Non-companion door addressing** is limited to loopback and tailnet sources (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), or requests that carry a valid bearer.
  - **Forwarding covers only rows Crow manages** (native, external engine, bundle, or `gpu_policy.door_forward: true`). Link-local and metadata targets are always refused.
  - **`/llm` refuses Funnel-headed requests itself**, as well as through the global middleware.
  - Never route on the display-only `isPrivateHost`/`addressClass`.
  - Run `tests/auth-network.test.js` after touching mounts.
- Never on crow without a registered window: no gateway restart, no model start/stop, no DB write on `~/.crow`. Deploys ride auto-update only when `node scripts/ops/box-reserve.mjs status` prints `none` and no CROW-SCHEDULE row is active.
- pi-lab's repo (`~/pi-lab`) is changed only through the handoff file in Task 12; the crow PR must keep working with pi-lab's current compose-based `localModels`.

## Review Focus

1. **A companion turn that names a bare id** (`qwen3.5-4b`, `qwen3.6-35b-a3b`, `crow`) must keep the fast/escalate heuristics; explicit addressing must never capture it. Test: Task 4 "companion alias ids still route by heuristics".
2. **A row that is not Crow-managed, addressed through the door** (a cloud row with a paid key, a LAN box, or a synced row pointing at `169.254.169.254`), must be refused, not proxied. Tests: Task 3 "unmanaged rows are refused" and "a managed row pointing at a metadata address is refused". Task 4: "a LAN source is refused for door addressing".
3. **Two gateways on one box** (crow `:3001`, r4 `:3008`): a door forwarding to a foreign-owned row that points back at a door must stop at one hop. Test: Task 4 "a second hop answers 508".
4. **A hand-written `models.json` entry with the same id as a DB row** (`crow-local`) must never be rewritten or removed by the managed sync. Test: Task 9 "hand-written entries are never touched".
5. **`pi --list-models` failing or slow** must not block every bot turn, or any gateway request. Tests: Task 10 "a failed listing … lets the turn proceed" and "shared between concurrent callers"; Task 11 reads `models.json` and never spawns pi.
6. **A peer holding a newer copy of a row the catch-up re-delivers** must keep it and log no conflict. Test: Task 1 "lamport 9000 vs 50".

---

## File structure

| File | Responsibility |
|---|---|
| `servers/sharing/instance-sync.js` | Task 1 (only if the diagnosis isolates H1): persist a "peer is behind" marker when a providers entry parks for an unarmed peer; re-deliver to that peer only, at boot and when its feed arms; the receiver skips a re-delivery that is not newer. |
| `servers/shared/providers-db.js` | Task 2: reconciler skips native rows (I5) and `$crowManaged` ids; Task 9: `setProviderChangeHook`. |
| `servers/gateway/models/door-resolve.js` (new), `servers/gateway/models/door.js` | Task 3: pure door addressing (managed rows only, forbidden targets); `providerDoorUrl`. Task 4: `isTrustedDoorSource`. |
| `servers/gateway/routes/llm-router.js`, `servers/gateway/models/manager.js` | Task 4: explicit addressing before the companion heuristics; source check; in-router Funnel refusal; `/completions`, `/embeddings`, `/rerank`; provider-scoped door; `/llm/v1/models` lists door models; native rows advertise `/llm/p/<id>/v1`. |
| `servers/gateway/process-supervisor.js`, `servers/gateway/models/runtime.js` | Task 5: last-40-lines stderr ring buffer on every supervised child. |
| `servers/gateway/local-token.js` | Task 6: the path-scoped `models-token`. |
| `servers/gateway/models/lifecycle.js` (new) | Task 7: job store and the `GET /llm/models` listing builder (pure). |
| `servers/gateway/routes/llm-models.js` (new), `servers/gateway/gpu-orchestrator.js`, `servers/gateway/boot/late-mounts.js` | Task 8: lifecycle routes, `stopNativeProvider`, `nativeSnapshot`, mount. |
| `servers/shared/pi-models-sync.js` (new), `servers/gateway/boot/admin-api.js` | Task 9: M1 managed entries in pi's `models.json`. |
| `scripts/pi-bots/pi-model-catalog.mjs` (new), `scripts/pi-bots/bot-world.mjs`, `scripts/pi-bots/job_runner.mjs` | Task 10: M2 pre-spawn validation. |
| `servers/gateway/dashboard/panels/bot-builder/data-queries.js`, `…/editor.js`, `servers/gateway/dashboard/shared/i18n.js` | Task 11: M3 picker marks. |
| `~/pi-lab/docs/handoffs-inbox-2026-10-0X-from-crow-models-gateway-contract.md` (new, in pi-lab) | Task 12: the pi-lab change, with code and tests. |
| `docs/architecture/models.md` | Task 13: door, lifecycle API, managed sync. |
| Tests | `tests/providers-replication-gate.test.js`, `tests/providers-reconcile-native-guard.test.js`, `tests/door-resolve.test.js`, `tests/llm-router-door.test.js`, `tests/process-supervisor-stderr.test.js`, `tests/models-token.test.js`, `tests/models-lifecycle.test.js`, `tests/llm-models-routes.test.js`, `tests/gpu-orchestrator-stderr-cause.test.js`, `tests/pi-models-sync.test.js`, `tests/pi-model-catalog.test.js`, `tests/bot-builder-model-marks.test.js`; additions to `tests/auth-network.test.js` and `tests/models-registration.test.js` (and `tests/peer-revoke-teardown.test.js` once PR #400 has merged). |

---

### Task 1: Replication — diagnose black-swan with discriminating evidence, then (only for H1) a failing two-instance test and the fix

Spec §11.8. The audit (2026-10-02) found black-swan's `providers` at max lamport 5054 (2026-08-20) against crow's 6641, and 1 memory against 59: crow's changes stopped arriving across tables. r4 (separate identity) and grackle (decommissioning) are out of scope.

**Revision 2 note (review C1).** Out-feeds are local Hypercores, armed at every boot for every `active`/`offline` peer (`eagerInitPairedPeers`), so RAM parking only happens in a boot window. Memories written by stdio servers ride the durable outbox, which never drops a parked peer. A six-week, cross-table stall is therefore more likely a transport or apply fault than H1. This task does **not** fix anything until Step 1 produces evidence that only H1 explains. Every other outcome stops and reports.

**Files:**
- Modify: `servers/sharing/instance-sync.js` (`_appendToPeer` parked branch; new `_markPeerBehind`, `_signedRedelivery`, `catchUpBehindPeers`; `backfillProvidersForNewPeers` wrapper; `_initInstanceInner` after `_drainPendingEmits`; `_applyEntry` redelivery guard; and `teardownRevokedPeer` when PR #400 has merged)
- Test: `tests/providers-replication-gate.test.js`

**Interfaces:**
- Consumes: `InstanceSyncManager` (`_appendToPeer`, `_chainAppendTask`, `_processNewEntries`, `backfillProvidersForNewPeers`, `outFeeds`), `sign` from `./identity.js`, `EXCLUDED_COLUMNS`, `OUTBOUND_TRANSFORMS`, `shouldSyncRow`; `upsertProvider`, `disableProvider`, `setProviderSyncManager`.
- Produces:
  - `BEHIND_FLAG_PREFIX = "__sync_behind_v1:"`. A `dashboard_settings` key prefix whose value is the lowest parked providers lamport, as a decimal string. It is never on the sync allowlist.
  - `_markPeerBehind(peerId, lamport) -> Promise<void>`.
  - `_signedRedelivery(table, op, row, lamportTs) -> entry`. The signed envelope is exactly what `emitChange` signs. `redelivery: true` rides **outside** the signed payload, so a peer on older code still verifies the entry.
  - `catchUpBehindPeers(peerIds?) -> Promise<number>`. Returns the rows re-delivered to **the behind peer only**. Rows are read inside that peer's append chain, and the marker is removed with a compare-and-delete.

- [ ] **Step 1: Read-only diagnosis (about 20 minutes, no writes to any live DB or feed).** Record every output in the PR description.

```bash
SCRATCH=$(mktemp -d)
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
# Both ends' peer rows, including gateway_url (PR #400's drift class) and status
sqlite3 -readonly ~/.crow/data/crow.db "SELECT id, name, status, gateway_url, sync_url, tailscale_ip, last_seen_at FROM crow_instances;"
ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT id, name, status, gateway_url, sync_url, tailscale_ip, last_seen_at FROM crow_instances;"'
BS=$(sqlite3 -readonly ~/.crow/data/crow.db "SELECT id FROM crow_instances WHERE name LIKE '%swan%' LIMIT 1;")
CROW=$(cat ~/.crow/data/instance-id)
echo "black-swan=$BS crow=$CROW"

# (a) crow's OUT-feed to black-swan: length and the last entry. Read a COPY; never open the live feed.
cp -r ~/.crow/data/instance-sync/$BS/out "$SCRATCH/crow-out"
(cd ~/crow && node --input-type=module -e '
import Hypercore from "hypercore";
const f = new Hypercore(process.argv[1], { valueEncoding: "json" }); await f.ready();
console.log("crow out-feed length", f.length);
if (f.length) { const e = await f.get(f.length - 1); console.log("last entry", e.table, e.op, e.lamport_ts); }
await f.close();' "$SCRATCH/crow-out")

# (b) black-swan's IN-feed copy of crow, and what it has applied
ssh black-swan "rm -rf /tmp/bs-diag && mkdir -p /tmp/bs-diag && cp -r ~/.crow/data/instance-sync/$CROW/in /tmp/bs-diag/in"
ssh black-swan 'cd ~/.crow/app && node --input-type=module -e "
import Hypercore from \"hypercore\";
const f = new Hypercore(\"/tmp/bs-diag/in\", { valueEncoding: \"json\" }); await f.ready();
console.log(\"black-swan in-feed length\", f.length); await f.close();"'
ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT last_applied_seq_per_peer FROM sync_state;"'

# (c) crow's durable outbox: depth, and rows black-swan has not taken
sqlite3 -readonly ~/.crow/data/crow.db "SELECT COUNT(*), SUM(CASE WHEN COALESCE(delivered_json,'') NOT LIKE '%$BS%' THEN 1 ELSE 0 END), MIN(created_at) FROM sync_outbox;"

# (d) the newest providers write crow made itself (to compare with the out-feed's last entry)
sqlite3 -readonly ~/.crow/data/crow.db "SELECT MAX(lamport_ts), MAX(updated_at) FROM providers WHERE instance_id = '$CROW';"

# (e) logs since 08-19: parking, drain, transport, apply
sudo journalctl -u crow-gateway --since 2026-08-19 --no-pager | grep -E "instance-sync|tailnet-sync|sync-outbox" | grep -iE "$BS|${BS:0:12}|pending emit|overflow|parkedPeers=|dial|handshake|connect|refused|timeout" | tail -n 80
ssh black-swan "sudo journalctl -u crow-gateway --since 2026-08-19 --no-pager | grep -E 'instance-sync|tailnet-sync' | grep -iE '${CROW:0:12}|Failed to process|Signature|dead feed|reset to 0|invalid_token|dial|handshake|connect|refused|timeout' | tail -n 80"
```

Write down five numbers: **O** = crow out-feed length; **I** = black-swan in-feed length; **A** = black-swan's applied seq for crow (the `s` of its `{k,s}` record, and whether `k` is crow's current out-feed key); **L** = the out-feed's last entry lamport; **P** = crow's newest own providers lamport.

| id | the evidence must show | stage | what to do |
|---|---|---|---|
| **H5 (transport)** | **O > I** (crow appended, black-swan never received), or dial/handshake/connect errors in either log, or a `gateway_url`/`sync_url` that points somewhere black-swan does not listen | replication transport | **Stop.** Report the numbers and log lines. A transport fix is not in plan 2's scope until Kevin rules (question 7 in the plan 2 review). PR #400's `CROW_PEER_GATEWAY_URL` fix may be the cure. |
| H2 (apply) | **I > A** and A stuck, or `Signature verification failed` / `Failed to process entry` on black-swan | apply | **Stop.** Report the failing entries' table/op. |
| H3 (status) | either side's row for the other is `paused` or `revoked` | operator state | **Stop.** Report it. |
| H4 (feed/auth) | `belonged to a dead feed — reset to 0` repeating, a `k` that is not crow's current out-feed key, or `invalid_token` | feed rotation or pairing auth | **Stop.** Report the lines. |
| **H1 (unarmed out-feed)** | **all** of: O = I = A (everything crow appended was received and applied); **P > L** (crow wrote providers rows newer than anything it ever appended for black-swan); and crow logs show `pending emit queue overflow for <black-swan id>` or black-swan's out-feed missing from boot arming. And memories that black-swan lacks were written by the gateway process, not by a stdio server, because the outbox never drops those. | crow never appended | Steps 2–7 below |

If no row matches, or more than one does, stop and report NEEDS_DECISION with the numbers. A green test for H1 does not repair H5.

**On H2–H5 (or no match), "stop" stops this task only (re-review N2).** Skip Task 1's code and Op 1. Ship the behind-marker code only if Kevin asks for it as a latent guard. Then **continue with Tasks 2–13**: only the black-swan repair waits for Kevin.

- [ ] **Step 2: Write the gate test.** Cases 1–2 are guards that already pass. Cases 3–8 are red today.

```js
// tests/providers-replication-gate.test.js
//
// The executable gate for spec §7 step 0 / §11.8. Two or three real init-db.js
// databases, real InstanceSyncManagers, stub feeds (no Hypercore), the shared
// test identity — the providers-war-sim.test.js harness.
//   1. guard: a DISABLE reaches an armed peer;
//   2. guard: a bundle -> native CONVERSION reaches an armed peer and keeps its door;
//   3. RED (H1): changes emitted while the peer's out-feed is UNARMED (a new row
//      and a disable of a row the peer already holds) reach it after a restart;
//   4. RED: the catch-up reaches ONLY the behind peer;
//   5. RED: a peer holding a NEWER copy (lamport 9000) of a row the catch-up
//      re-delivers at lamport 50 keeps its copy and logs ZERO conflicts;
//   6. RED: the marker keeps the lowest lamport and is compare-and-deleted
//      (a lower mark that races in during the catch-up survives);
//   7. RED: a live upsert racing the catch-up lands after it (the peer ends on
//      the newest content);
//   8. RED: a revoked peer is never caught up, and keeps its marker;
//   9. the catch-up re-checks shouldSyncRow itself (it bypasses emitChange):
//      a loopback row is never re-delivered.
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
const B_ID = "bbbbbbbb-0000-0000-0000-00000000000b"; // black-swan (behind)
const C_ID = "cccccccc-0000-0000-0000-00000000000c"; // a third, up-to-date peer

const dirs = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "repl-gate-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  dirs.push(dir);
  return { dir, db: createDbClient(join(dir, "crow.db")) };
}
const A = freshDb();
const PREV_DATA_DIR = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = A.dir; // upsertProvider's instance id keys on CROW_DATA_DIR

const TEST_PRIV = Buffer.alloc(32, 0xCD);
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex") };

// Each stub feed has its own key: the peer's applied-seq record is feed-keyed
// (2d C2), so a fresh feed starts at seq 0 instead of inheriting a checkpoint.
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
async function pair(db, id, status = "active") {
  await db.execute({ sql: `INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, 'crow:test', ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status`, args: [id, id.slice(0, 4), status] });
}
async function rowOn(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] || null;
}
async function conflicts(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_conflicts");
  return Number(rows[0].n);
}
async function marker(db, peer) {
  const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: ["__sync_behind_v1:" + peer] });
  return rows[0]?.value ?? null;
}
async function setMarker(db, peer, v) {
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: ["__sync_behind_v1:" + peer, String(v)] });
}

after(() => {
  setProviderSyncManager(null);
  if (PREV_DATA_DIR === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = PREV_DATA_DIR;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("guard: a disable reaches an armed peer", async () => {
  const B = freshDb();
  await pair(A.db, B_ID);
  const mgrA = manager(A.db, A_ID), mgrB = manager(B.db, B_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  setProviderSyncManager(mgrA);
  await upsertProvider(A.db, { id: "g-disable", baseUrl: "http://100.64.9.1:8003/v1", host: "local", models: [{ id: "m" }] });
  await disableProvider(A.db, "g-disable");
  await mgrB._processNewEntries(A_ID, feed);
  assert.equal(Number((await rowOn(B.db, "g-disable")).disabled), 1);
});

test("guard: a bundle -> native conversion reaches an armed peer and keeps its door", async () => {
  const B = freshDb();
  await pair(A.db, B_ID);
  const mgrA = manager(A.db, A_ID), mgrB = manager(B.db, B_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  setProviderSyncManager(mgrA);
  await upsertProvider(A.db, { id: "g-conv", baseUrl: "http://100.64.9.1:8004/v1", host: "local", bundleId: "llamacpp-vulkan-qwen3-embed", models: [{ id: "qwen3-embedding-0.6b" }] });
  const door = "http://100.64.9.1:3001/llm/p/g-conv/v1";
  await upsertProvider(A.db, { id: "g-conv", baseUrl: door, host: "local", bundleId: null, models: [{ id: "qwen3-embedding-0.6b" }],
    gpuPolicy: { runtime: "native", catalogId: "qwen3-embedding-0.6b", quant: "Q8_0", port: 18101, owner: A_ID } });
  await mgrB._processNewEntries(A_ID, feed);
  const b = await rowOn(B.db, "g-conv");
  assert.equal(b.base_url, door);
  assert.equal(b.bundle_id, null);
  const gp = JSON.parse(b.gpu_policy);
  assert.equal(gp.owner, A_ID);
  assert.equal(localizeNativeRow({ baseUrl: b.base_url, gpuPolicy: gp }, B_ID).baseUrl, door, "a peer never localizes a row it does not own");
});

test("RED (H1): changes parked for an unarmed peer survive a restart and reach it (a new row AND a disable of a row it already holds)", async () => {
  const B = freshDb();
  await pair(A.db, B_ID);
  for (const db of [A.db, B.db]) {
    await db.execute({ sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id) VALUES ('g-stale', 'http://100.64.9.1:8012/v1', 'local', '[{"id":"s"}]', 0, 3, ?)`, args: [A_ID] });
  }
  const mgrA1 = manager(A.db, A_ID), mgrB = manager(B.db, B_ID);
  setProviderSyncManager(mgrA1);
  await upsertProvider(A.db, { id: "g-parked", baseUrl: "http://100.64.9.1:8011/v1", host: "local", models: [{ id: "parked" }] });
  await disableProvider(A.db, "g-stale");
  assert.ok(mgrA1.pendingEmitStats()[B_ID] >= 2, "both entries parked in RAM");
  await A.db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, 'done:1')", args: ["__providers_backfill_v1:" + B_ID] });

  // Restart: the RAM queue is gone. Boot 2 arms the feed and runs the boot hook.
  const mgrA2 = manager(A.db, A_ID);
  setProviderSyncManager(mgrA2);
  const feed = stubFeed();
  mgrA2.outFeeds.set(B_ID, feed);
  await mgrA2.backfillProvidersForNewPeers();
  await mgrB._processNewEntries(A_ID, feed);

  assert.ok(await rowOn(B.db, "g-parked"), "the new row arrived");
  assert.equal(Number((await rowOn(B.db, "g-stale")).disabled), 1, "the disable of a held row arrived");
  assert.equal(await conflicts(B.db), 0, "conflict-free");
  assert.equal(await marker(A.db, B_ID), null, "marker cleared");
});

test("RED: the catch-up reaches ONLY the behind peer", async () => {
  await pair(A.db, B_ID);
  await pair(A.db, C_ID);
  const mgrA = manager(A.db, A_ID);
  const fb = stubFeed(), fc = stubFeed();
  mgrA.outFeeds.set(B_ID, fb);
  mgrA.outFeeds.set(C_ID, fc);
  await setMarker(A.db, B_ID, 0);
  await mgrA.catchUpBehindPeers();
  assert.ok(fb.length > 0, "the behind peer got the re-delivery");
  assert.equal(fc.length, 0, "an up-to-date peer got nothing");
  assert.ok(fb.entries.every((e) => e.redelivery === true && e.table === "providers"));
});

test("RED: a peer holding a NEWER copy keeps it and logs zero conflicts (lamport 9000 vs 50)", async () => {
  const B = freshDb();
  await pair(A.db, B_ID);
  await A.db.execute({ sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id) VALUES ('g-race', 'http://100.64.9.1:8013/v1', 'local', '[{"id":"old"}]', 0, 50, ?)`, args: [A_ID] });
  await B.db.execute({ sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id) VALUES ('g-race', 'http://100.64.9.1:8013/v1', 'local', '[{"id":"new"}]', 1, 9000, ?)`, args: [B_ID] });
  const mgrA = manager(A.db, A_ID), mgrB = manager(B.db, B_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  await setMarker(A.db, B_ID, 0);
  await mgrA.catchUpBehindPeers([B_ID]);
  await mgrB._processNewEntries(A_ID, feed);
  const b = await rowOn(B.db, "g-race");
  assert.equal(Number(b.lamport_ts), 9000, "the newer copy stays");
  assert.equal(JSON.parse(b.models)[0].id, "new");
  assert.equal(await conflicts(B.db), 0, "no conflict rows, no operator notifications");
});

test("RED: the marker keeps the lowest lamport and is compare-and-deleted", async () => {
  await pair(A.db, B_ID);
  const mgrA = manager(A.db, A_ID);
  await A.db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: ["__sync_behind_v1:" + B_ID] });
  await mgrA._markPeerBehind(B_ID, 40);
  await mgrA._markPeerBehind(B_ID, 90);
  await mgrA._markPeerBehind(B_ID, 30);
  assert.equal(await marker(A.db, B_ID), "30");
  mgrA.outFeeds.set(B_ID, stubFeed());
  // A lower mark races in while the catch-up holds the append chain.
  const original = mgrA._chainAppendTask.bind(mgrA);
  mgrA._chainAppendTask = async (peerId, fn) => { await mgrA._markPeerBehind(B_ID, 10); return original(peerId, fn); };
  await mgrA.catchUpBehindPeers([B_ID]);
  assert.equal(await marker(A.db, B_ID), "10", "the racing lower mark survives the compare-and-delete");
});

test("RED: a live upsert racing the catch-up lands after it", async () => {
  const B = freshDb();
  await pair(A.db, B_ID);
  const mgrA = manager(A.db, A_ID), mgrB = manager(B.db, B_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  setProviderSyncManager(mgrA);
  await upsertProvider(A.db, { id: "g-live", baseUrl: "http://100.64.9.1:8014/v1", host: "local", models: [{ id: "v1" }] });
  await setMarker(A.db, B_ID, 0);
  const original = mgrA._chainAppendTask.bind(mgrA);
  let racing = null;
  mgrA._chainAppendTask = (peerId, fn) => {
    const p = original(peerId, fn);
    if (!racing) racing = upsertProvider(A.db, { id: "g-live", baseUrl: "http://100.64.9.1:8014/v1", host: "local", models: [{ id: "v2" }] });
    return p;
  };
  await mgrA.catchUpBehindPeers([B_ID]);
  await racing;
  await mgrB._processNewEntries(A_ID, feed);
  assert.equal(JSON.parse((await rowOn(B.db, "g-live")).models)[0].id, "v2", "the peer ends on the newest content");
});

test("RED: a revoked peer is never caught up and keeps its marker", async () => {
  await pair(A.db, B_ID, "revoked");
  const mgrA = manager(A.db, A_ID);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  await setMarker(A.db, B_ID, 0);
  await mgrA.catchUpBehindPeers([B_ID]);
  assert.equal(feed.length, 0);
  assert.equal(await marker(A.db, B_ID), "0");
  await pair(A.db, B_ID, "active");
});

test("the catch-up re-checks shouldSyncRow itself: a loopback row is never re-delivered", async () => {
  await pair(A.db, B_ID);
  const mgrA = manager(A.db, A_ID);
  setProviderSyncManager(null);
  await upsertProvider(A.db, { id: "g-loop", baseUrl: "http://127.0.0.1:18100/v1", host: "local", models: [{ id: "x" }] });
  await setMarker(A.db, B_ID, 0);
  const feed = stubFeed();
  mgrA.outFeeds.set(B_ID, feed);
  await mgrA.catchUpBehindPeers([B_ID]);
  assert.equal(feed.entries.some((e) => e.row && e.row.id === "g-loop"), false);
});
```

- [ ] **Step 3: Run it.** Expect cases 1–2 to pass, case 3 to fail with "the new row arrived", and cases 4–9 to fail with `mgrA.catchUpBehindPeers is not a function` or `_markPeerBehind is not a function`.

Run: `npm test -- tests/providers-replication-gate.test.js`

If case 1 or 2 fails, that is the bug (not H1). Stop, keep it as the red test, and report.

- [ ] **Step 4: Implement in `servers/sharing/instance-sync.js`.**

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
      // behind and re-deliver from the lowest parked lamport once its feed
      // arms (catchUpBehindPeers). Spec §11.8 / plan 2 Task 1, H1.
      if (entry.table === "providers") {
        await this._markPeerBehind(peerId, Number(entry.lamport_ts) || 0);
      }
      return "parked";
```

Add these methods to the class (beside `backfillProvidersForNewPeers`):

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
   * The envelope emitChange would sign for `row`, keeping the row's own
   * lamport (a re-delivery must never fabricate recency). `redelivery: true`
   * is set AFTER signing, outside the signed payload: a peer on older code
   * verifies the entry exactly as before and simply ignores the flag.
   */
  _signedRedelivery(table, op, row, lamportTs) {
    let cleanRow = { ...row };
    for (const col of EXCLUDED_COLUMNS[table] || []) delete cleanRow[col];
    const transform = OUTBOUND_TRANSFORMS[table];
    if (transform) cleanRow = transform(cleanRow);
    const entry = { table, op, row: cleanRow, lamport_ts: lamportTs, instance_id: this.localInstanceId };
    entry.signature = sign(JSON.stringify(entry), this.identity.ed25519Priv);
    entry.redelivery = true;
    return entry;
  }

  /**
   * Re-deliver every syncable providers row with lamport_ts >= a behind
   * peer's marker, to THAT PEER ONLY. The rows are read inside the peer's
   * append chain, so a live emit queued meanwhile lands after them. Each
   * row goes out as an update and then an insert: the update lands on a
   * stale copy, and the insert creates a missing row. The peer's apply skips
   * any re-delivery whose lamport is not newer than its own copy
   * (_applyEntry), so a newer copy is kept with no conflict row. The marker
   * is compare-and-deleted, so a lower mark that raced in survives.
   * Revoked or paused peers are skipped and keep their marker.
   * @param {string[]} [peerIds] default: every armed out-feed
   * @returns {Promise<number>} rows re-delivered
   */
  async catchUpBehindPeers(peerIds = [...this.outFeeds.keys()]) {
    let total = 0;
    for (const peerId of peerIds) {
      if (!this.outFeeds.has(peerId)) continue;
      let status = null;
      try {
        const { rows } = await this.db.execute({ sql: "SELECT status FROM crow_instances WHERE id = ?", args: [peerId] });
        status = rows[0]?.status ?? null;
      } catch { status = null; }
      if (status !== "active" && status !== "offline") continue;
      let seen = null;
      try {
        const { rows } = await this.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [BEHIND_FLAG_PREFIX + peerId] });
        seen = rows.length ? String(rows[0].value) : null;
      } catch { seen = null; }
      if (seen === null || !Number.isFinite(Number(seen))) continue;
      const from = Number(seen);
      const sent = await this._chainAppendTask(peerId, async () => {
        const feed = this.outFeeds.get(peerId);
        if (!feed) return -1;
        const { rows } = await this.db.execute({
          sql: "SELECT * FROM providers WHERE COALESCE(lamport_ts, 0) >= ? ORDER BY lamport_ts ASC",
          args: [from],
        });
        let n = 0;
        for (const row of rows) {
          if (!shouldSyncRow("providers", row)) continue;
          const ts = Number(row.lamport_ts) || 0;
          await feed.append(this._signedRedelivery("providers", "update", row, ts));
          await feed.append(this._signedRedelivery("providers", "insert", row, ts));
          n++;
        }
        return n;
      });
      if (sent < 0) continue; // the feed went away: keep the marker for the next arming
      await this.db.execute({
        sql: "DELETE FROM dashboard_settings WHERE key = ? AND value = ?",
        args: [BEHIND_FLAG_PREFIX + peerId, seen],
      });
      total += sent;
      console.log(`[instance-sync] providers catch-up for ${peerId.slice(0, 12)}…: re-delivered ${sent} row(s) from lamport ${from}`);
    }
    return total;
  }
```

Rename the existing body of `backfillProvidersForNewPeers` to `_backfillProvidersForNewPeersInner`, and wrap it:

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

In `_initInstanceInner`, right after the existing `await drainDone.catch(() => {});`, chain the catch-up as a fire-and-forget step. This lets an in-process arming (no restart) also recover what the 256 cap dropped. Do not await it inside the `_initLocks` chain: it takes the per-peer append chain.

```js
      drainDone
        .then(() => this.catchUpBehindPeers([remoteInstanceId]))
        .catch((err) => console.warn(`[instance-sync] catch-up after arming ${remoteInstanceId} failed: ${err.message}`));
```

In `_applyEntry`, directly after `await this._advanceCounter(lamport_ts);`, add the receiver half:

```js
    // A catch-up re-delivery (catchUpBehindPeers) fills gaps; it never
    // overrides, or conflicts with, a local copy that is as new or newer.
    if (entry.redelivery === true && table === "providers" && row && row.id !== undefined) {
      const { rows: local } = await this.db.execute({ sql: "SELECT lamport_ts FROM providers WHERE id = ?", args: [row.id] });
      if (local.length && Number(local[0].lamport_ts || 0) >= Number(lamport_ts)) return;
    }
```

**PR #400 (`fix/platform-defects`).** If it has merged by the time this task runs, `teardownRevokedPeer(remoteInstanceId)` exists. Add, as its first statement:

```js
    try { await this.db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [BEHIND_FLAG_PREFIX + remoteInstanceId] }); } catch {}
```

and add a case to `tests/peer-revoke-teardown.test.js` asserting that the marker is gone after `revokePeer`. If it has not merged, skip this step and note it in the PR, so that whichever lands second carries it. Without it, a revoked peer keeps its marker forever and a later re-pair triggers a stale catch-up.

**Mixed-version note.** A peer still running older code ignores `redelivery` and treats the entries as ordinary updates and inserts. Where that peer holds a newer copy, it logs conflict rows. Black-swan (app `249d5919`) is that peer, so Op 1 updates it first.

- [ ] **Step 5: Run the gate and the neighbours.**

Run: `npm test -- tests/providers-replication-gate.test.js tests/providers-backfill.test.js tests/providers-war-sim.test.js tests/instance-sync.test.js tests/sync-emit.test.js tests/sync-outbox-drain.test.js tests/ramble-sync.test.js`
Expected: all PASS. The catch-up is providers-only, by design. Widening it to ramble tables would re-attribute the envelope `instance_id` that #342 uses as the Lamport-tie `origin` (review cross-stream note).

- [ ] **Step 6: Commit.**

```bash
git add tests/providers-replication-gate.test.js
git commit servers/sharing/instance-sync.js tests/providers-replication-gate.test.js -m "fix(sync): durable catch-up for providers parked while a peer's feed was unarmed — behind peer only, conflict-free, compare-and-delete marker"
```

---

### Task 2: Reconciler and seed guard — never de-native a row, never re-import managed entries (I5)

Spec §11.7. `readModelsJson` has **two** callers (review C7): the hourly reconciler, and `seedProvidersFromModelsJson`, which runs at every boot when `providers` is empty (that has happened after DB restores). Both must skip `$crowManaged` ids. Otherwise a restore re-imports M1's output as plain rows, and a native row comes back as a self-pointing door row (a 508 or a loop).

**Files:**
- Modify: `servers/shared/providers-db.js` (`readModelsJson`, `seedProvidersFromModelsJson`, `syncProvidersFromModelsJson`)
- Test: `tests/providers-reconcile-native-guard.test.js`

**Interfaces:**
- Consumes: `syncProvidersFromModelsJson(db, { force, ownAddrs })`.
- Produces: counters `skipped_native` and `skipped_managed` in the reconciler's return value; `seedProvidersFromModelsJson` returns `{ seeded, skipped_managed, source }`; `readModelsJson()` returns `{ path, config, managedIds: Set<string> }` (the union of every file's top-level `$crowManaged` array). Task 9 writes `$crowManaged`.

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
import { upsertProvider, syncProvidersFromModelsJson, seedProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";

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

test("the first-boot seed never imports $crowManaged entries (a DB restore must not re-import M1's output)", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "seed-guard-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir2 }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db2 = createDbClient(join(dir2, "crow.db"));
  try {
    writeFileSync(file, JSON.stringify({
      $crowManaged: ["crow-chat"],
      providers: {
        "crow-chat": { baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] },
        "crow-local": { baseUrl: "http://100.64.9.1:8003/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] },
      },
    }));
    const res = await seedProvidersFromModelsJson(db2);
    assert.equal(res.seeded, 1);
    assert.equal(res.skipped_managed, 1);
    const { rows } = await db2.execute("SELECT id FROM providers ORDER BY id");
    assert.deepEqual(rows.map((r) => r.id), ["crow-local"]);
  } finally { try { db2.close(); } catch {} rmSync(dir2, { recursive: true, force: true }); }
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

In `seedProvidersFromModelsJson`, change `const { path, config } = readModelsJson();` to `const { path, config, managedIds } = readModelsJson();`, add `let skippedManaged = 0;`, add `if (managedIds.has(id)) { skippedManaged++; continue; }` as the second line of the loop (after the `$` check), and return `{ seeded: count, skipped_managed: skippedManaged, source: path }`. Make the early return `{ seeded: 0, skipped_managed: 0, source: path }` the same shape.

- [ ] **Step 4: Run, expect PASS**, plus neighbours: `npm test -- tests/providers-reconcile-native-guard.test.js tests/providers-reconcile-gate.test.js tests/providers-war-sim.test.js tests/models-json-seam.test.js tests/providers-external-engine-write.test.js`

- [ ] **Step 5: Commit.**

```bash
git add tests/providers-reconcile-native-guard.test.js
git commit servers/shared/providers-db.js tests/providers-reconcile-native-guard.test.js -m "fix(providers): reconciler and first-boot seed never de-native a row or re-import crow-managed entries (I5)"
```

---

### Task 3: Door resolver (pure): forwards only rows Crow manages

Spec §5.1, §11.4 (revised 2026-10-02, review C4). One module decides where a door request goes, with no I/O.

**Security rules (review C4, Kevin's ruling):**
- The door forwards only **Crow-managed rows**: native (owned → loopback, foreign → the owner's door), external-engine, and bundle rows, plus rows that carry the explicit opt-in marker `gpu_policy.door_forward: true`.
- There is no "any private address" catch-all, and the display-only `isPrivateHost`/`addressClass` helpers are never used for routing.
- Every target, managed or not, is refused if it is link-local or a cloud metadata address. Any paired peer can write a row's `base_url` through sync, so a synced row must never turn the door into a proxy to `169.254.169.254` (black-swan is an Oracle VM).

**Files:**
- Create: `servers/gateway/models/door-resolve.js`
- Modify: `servers/gateway/models/door.js` (add `providerDoorUrl` beside `doorBaseUrl`)
- Test: `tests/door-resolve.test.js`

**Interfaces:**
- Consumes: `isExternalEngine` from `servers/shared/provider-engine.js`.
- Produces:
  - `DOOR_PROVIDER_HEADER = "x-crow-provider"`, `DOOR_HOP_HEADER = "x-crow-door-hop"`
  - `isDoorUrl(url) -> boolean`: true for `…/llm/v1` and `…/llm/p/<provider>/v1`.
  - `providerDoorUrl(doorBase, providerId) -> string`, in `door.js`: `http://h:3001/llm/v1` → `http://h:3001/llm/p/<id>/v1`.
  - `canonicalTargetHost(hostname) -> string`: strips brackets and one trailing dot, lower-cases, and unwraps IPv4-mapped/compatible IPv6 to IPv4 (re-review N1).
  - `isForbiddenTarget(url) -> boolean` (on the canonical host): link-local IPv4 (`169.254.0.0/16`) and IPv6 (`fe80::/10`); cloud metadata hosts (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `metadata`, `metadata.google.internal`, `instance-data`, `instance-data.ec2.internal`); Tailscale's own `100.100.100.100`; and any URL that does not parse.
  - `doorKindOf(provider) -> "native-owned" | "native-foreign" | "external" | "bundle" | "opt-in" | "unmanaged"`
  - `resolveDoorTarget({ providers, providerHeader, model, companionModelIds, hop }) -> { kind: "companion" } | { kind: "forward", providerId, modelId, url, apiKey, doorKind } | { kind: "error", status, code, message, candidates? }`. `providerHeader` is also how the provider-scoped path `/llm/p/<provider>/v1/…` (Task 4) names a provider.
  - `listDoorModels(providers) -> Array<{ id, object: "model", owned_by: "crow", provider, doorKind }>`, covering forwardable rows only.

- [ ] **Step 1: Write the failing test.**

```js
// tests/door-resolve.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDoorTarget, listDoorModels, doorKindOf, isDoorUrl, isForbiddenTarget, canonicalTargetHost, DOOR_PROVIDER_HEADER, DOOR_HOP_HEADER } from "../servers/gateway/models/door-resolve.js";
import { providerDoorUrl } from "../servers/gateway/models/door.js";

const P = {
  "crow-chat": { baseUrl: "http://127.0.0.1:18102/v1", doorUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 18102, mutexGroup: "crow-strix-vram", defaultMember: true } },
  "crow-voice": { baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
  "crow-local-27b": { baseUrl: "http://100.64.9.1:8006/v1", apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "crow-local-27b-copilot": { baseUrl: "http://100.64.9.1:8010/v1", apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "r4-gemma": { baseUrl: "http://100.64.9.1:3008/llm/p/r4-gemma/v1", apiKey: "none", models: [{ id: "gemma-4-e2b-it" }], gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "qwen-cloud": { baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", apiKey: "sk-secret", models: [{ id: "qwen3.8-max" }] },
  "raven-flash-next": { baseUrl: "http://10.0.0.126:8030/v1", apiKey: "none", models: [{ id: "qwen3.8-flash-next" }], gpuPolicy: { engine: { managed: "external", host: "raven", label: "gufo" } } },
  "lan-box": { baseUrl: "http://10.0.0.50:8000/v1", apiKey: "k-lan", models: [{ id: "lan-model" }] },
  "lan-optin": { baseUrl: "http://10.0.0.51:8000/v1", apiKey: "none", models: [{ id: "optin-model" }], gpuPolicy: { door_forward: true } },
  "evil-bundle": { baseUrl: "http://169.254.169.254/latest", apiKey: "none", bundleId: "x", models: [{ id: "meta" }] },
};
const COMPANION = ["qwen3.5-4b", "qwen3.6-35b-a3b"];

test("isDoorUrl and providerDoorUrl", () => {
  assert.equal(isDoorUrl("http://100.64.9.1:3001/llm/v1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:3001/llm/p/crow-chat/v1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:8003/v1"), false);
  assert.equal(providerDoorUrl("http://100.64.9.1:3001/llm/v1", "crow-chat"), "http://100.64.9.1:3001/llm/p/crow-chat/v1");
});

test("isForbiddenTarget: link-local, metadata hosts, Tailscale's own address, garbage", () => {
  for (const u of ["http://169.254.169.254/latest", "http://169.254.1.2:80/v1", "http://[fe80::1]:8000/v1", "http://[fd00:ec2::254]/", "http://100.100.100.200/", "http://100.100.100.100/", "http://metadata.google.internal/", "http://metadata/", "not a url"]) {
    assert.equal(isForbiddenTarget(u), true, u);
  }
  for (const u of ["http://127.0.0.1:18102/v1", "http://100.64.9.1:8006/v1", "http://10.0.0.126:8030/v1"]) assert.equal(isForbiddenTarget(u), false, u);
});

test("isForbiddenTarget: IPv4-mapped IPv6 and trailing-dot bypasses are closed (re-review N1)", () => {
  for (const u of [
    "http://[::ffff:169.254.169.254]/latest", "http://[::ffff:a9fe:a9fe]/latest", "http://[::ffff:100.100.100.100]/",
    "http://[::ffff:6464:64c8]/", "http://[::a9fe:a9fe]/", "http://metadata.google.internal./", "http://metadata./",
    "http://instance-data.ec2.internal./", "http://169.254.169.254./",
  ]) assert.equal(isForbiddenTarget(u), true, u);
  assert.equal(canonicalTargetHost("[::ffff:a9fe:a9fe]"), "169.254.169.254");
  assert.equal(canonicalTargetHost("Metadata.Google.Internal."), "metadata.google.internal");
  assert.equal(isForbiddenTarget("http://[::ffff:7f00:1]:18102/v1"), false, "a mapped loopback is not forbidden (it maps to 127.0.0.1)");
});

test("header names are lower-case (express lower-cases incoming headers)", () => {
  assert.equal(DOOR_PROVIDER_HEADER, "x-crow-provider");
  assert.equal(DOOR_HOP_HEADER, "x-crow-door-hop");
});

test("doorKindOf: managed kinds, the explicit opt-in, and everything else unmanaged", () => {
  assert.equal(doorKindOf(P["crow-chat"]), "native-owned");
  assert.equal(doorKindOf(P["r4-gemma"]), "native-foreign");
  assert.equal(doorKindOf(P["crow-local-27b"]), "external");
  assert.equal(doorKindOf(P["crow-voice"]), "bundle");
  assert.equal(doorKindOf(P["lan-optin"]), "opt-in");
  assert.equal(doorKindOf(P["qwen-cloud"]), "unmanaged");
  assert.equal(doorKindOf(P["lan-box"]), "unmanaged", "a private address is NOT enough");
});

test("the header addresses a provider; the model field stays bare", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-local-27b-copilot", model: "qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.kind, "forward");
  assert.equal(r.providerId, "crow-local-27b-copilot");
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

test("a foreign-owned native row forwards to the owner's door; a second hop answers 508", () => {
  const r = resolveDoorTarget({ providers: P, model: "r4-gemma/gemma-4-e2b-it", companionModelIds: COMPANION });
  assert.equal(r.url, "http://100.64.9.1:3008/llm/p/r4-gemma/v1");
  const r2 = resolveDoorTarget({ providers: P, model: "r4-gemma/gemma-4-e2b-it", companionModelIds: COMPANION, hop: 1 });
  assert.equal(r2.status, 508);
  assert.equal(r2.code, "DOOR_LOOP");
});

test("unmanaged rows are refused — cloud keys never leak, LAN rows need the opt-in", () => {
  const c = resolveDoorTarget({ providers: P, providerHeader: "qwen-cloud", model: "qwen3.8-max", companionModelIds: COMPANION });
  assert.equal(c.status, 400);
  assert.equal(c.code, "NOT_FORWARDABLE");
  assert.equal(JSON.stringify(c).includes("sk-secret"), false);
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "lan-box", model: "lan-model", companionModelIds: COMPANION }).code, "NOT_FORWARDABLE");
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "lan-optin", model: "optin-model", companionModelIds: COMPANION }).kind, "forward");
});

test("a managed row pointing at a metadata address is refused", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "evil-bundle", model: "meta", companionModelIds: COMPANION });
  assert.equal(r.status, 400);
  assert.equal(r.code, "FORBIDDEN_TARGET");
});

test("a unique bare id that is not a companion alias resolves; unmanaged rows are not candidates", () => {
  assert.equal(resolveDoorTarget({ providers: P, model: "qwen3.8-flash-next", companionModelIds: COMPANION }).providerId, "raven-flash-next");
  assert.equal(resolveDoorTarget({ providers: P, model: "lan-model", companionModelIds: COMPANION }).kind, "companion", "an unmanaged row is invisible to bare addressing");
});

test("companion alias ids and unknown ids stay with the companion heuristics", () => {
  for (const m of ["qwen3.5-4b", "qwen3.6-35b-a3b", "crow", undefined]) {
    assert.equal(resolveDoorTarget({ providers: P, model: m, companionModelIds: COMPANION }).kind, "companion", String(m));
  }
});

test("an ambiguous bare id answers 400 with the qualified forms, or resolves to a lone defaultMember", () => {
  const r = resolveDoorTarget({ providers: P, model: "qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.code, "AMBIGUOUS_MODEL");
  assert.deepEqual(r.candidates.sort(), ["crow-local-27b-copilot/qwen3.8-27b", "crow-local-27b/qwen3.8-27b"]);
  const P2 = { ...P, "crow-chat-alt": { ...P["crow-chat"], gpuPolicy: { ...P["crow-chat"].gpuPolicy, defaultMember: false, port: 18103 }, baseUrl: "http://127.0.0.1:18103/v1" } };
  assert.equal(resolveDoorTarget({ providers: P2, model: "qwen3.6-35b-a3b", companionModelIds: [] }).providerId, "crow-chat");
});

test("an unknown header provider or a model the provider does not serve is 404", () => {
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "nope", model: "x", companionModelIds: COMPANION }).status, 404);
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-voice", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION });
  assert.equal(r.code, "MODEL_NOT_SERVED");
});

test("listDoorModels lists forwardable models only, qualified", () => {
  const ids = listDoorModels(P).map((m) => m.id);
  assert.ok(ids.includes("crow-chat/qwen3.6-35b-a3b"));
  assert.ok(ids.includes("lan-optin/optin-model"));
  assert.equal(ids.some((id) => id.startsWith("qwen-cloud/") || id.startsWith("lan-box/") || id.startsWith("evil-bundle/")), false);
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found). `npm test -- tests/door-resolve.test.js`

- [ ] **Step 3: Implement.** In `servers/gateway/models/door.js` add:

```js
/** The provider-scoped door: a base URL that names its provider, so a client
 * needs no header and no qualified model id (native rows, alias rows, pi). */
export function providerDoorUrl(doorBase, providerId) {
  return String(doorBase).replace(/\/llm\/v1\/?$/, `/llm/p/${encodeURIComponent(providerId)}/v1`);
}
```

```js
// servers/gateway/models/door-resolve.js
/**
 * Door addressing (spec §5.1, §11.4). Pure: given the provider map (the
 * loadProviders() shape, ALREADY localized — an owned native row carries
 * baseUrl = loopback and doorUrl = its door) and the request's addressing
 * inputs, decide where a /llm request goes.
 *
 * Order: provider named by the path (/llm/p/<provider>/v1) or the
 * X-Crow-Provider header → qualified "<provider>/<model>" → a bare id that
 * matches exactly one forwardable non-companion row → companion heuristics.
 *
 * SECURITY (review C4): only rows Crow manages are forwardable — native,
 * external-engine, bundle — or rows that opt in with
 * gpu_policy.door_forward === true. A private address is never enough: any
 * paired peer can write base_url through sync. Link-local and cloud
 * metadata targets are refused for every row. The source-address and
 * Funnel checks live in the route (llm-router.js), not here.
 */
import { isExternalEngine } from "../../shared/provider-engine.js";

export const DOOR_PROVIDER_HEADER = "x-crow-provider";
export const DOOR_HOP_HEADER = "x-crow-door-hop";

const FORBIDDEN_HOSTS = new Set([
  "169.254.169.254", "fd00:ec2::254", "100.100.100.200", "100.100.100.100",
  "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
]);

export function isDoorUrl(url) {
  try { return /\/llm(\/p\/[^/]+)?\/v1$/.test(new URL(url).pathname.replace(/\/+$/, "")); } catch { return false; }
}

/** Canonical host for the blocklist (re-review N1): brackets off, lower-case,
 * ONE trailing dot stripped (`metadata.google.internal.`), and IPv4-mapped /
 * IPv4-compatible IPv6 unwrapped to IPv4. WHATWG URL rewrites
 * `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, and Node's dual-stack
 * socket still reaches the IPv4 metadata address through it. */
export function canonicalTargetHost(hostname) {
  let x = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (x.endsWith(".")) x = x.slice(0, -1);
  const dotted = x.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = x.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return x;
}

export function isForbiddenTarget(url) {
  let h;
  try { h = canonicalTargetHost(new URL(url).hostname); } catch { return true; }
  if (!h || FORBIDDEN_HOSTS.has(h)) return true;
  if (/^169\.254\./.test(h)) return true;                   // IPv4 link-local
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;           // IPv6 link-local
  return false;
}

export function doorKindOf(p) {
  if (!p) return "unmanaged";
  if (p.gpuPolicy?.runtime === "native") {
    return p.doorUrl || !isDoorUrl(p.baseUrl) ? "native-owned" : "native-foreign";
  }
  if (isExternalEngine(p)) return "external";
  if (p.bundleId) return "bundle";
  if (p.gpuPolicy?.door_forward === true) return "opt-in";
  return "unmanaged";
}

const forwardable = (p) => doorKindOf(p) !== "unmanaged";

function modelIdsOf(p) {
  return (Array.isArray(p?.models) ? p.models : []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
}

function forward(providers, providerId, modelId, hop) {
  const p = providers[providerId];
  if (!p) return { kind: "error", status: 404, code: "UNKNOWN_PROVIDER", message: `no enabled provider "${providerId}"` };
  const doorKind = doorKindOf(p);
  if (doorKind === "unmanaged") {
    return { kind: "error", status: 400, code: "NOT_FORWARDABLE", message: `provider "${providerId}" is not a Crow-managed local model (native, external engine or bundle) and has no door_forward opt-in` };
  }
  const ids = modelIdsOf(p);
  const mid = modelId || ids[0];
  if (!mid || !ids.includes(mid)) {
    return { kind: "error", status: 404, code: "MODEL_NOT_SERVED", message: `provider "${providerId}" does not serve "${modelId}"`, candidates: ids.map((i) => `${providerId}/${i}`) };
  }
  const url = String(p.baseUrl || "").replace(/\/+$/, "");
  if (isForbiddenTarget(url)) {
    return { kind: "error", status: 400, code: "FORBIDDEN_TARGET", message: `provider "${providerId}" points at a link-local or metadata address; the door refuses it` };
  }
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
  const candidates = Object.entries(providers).filter(([, p]) => forwardable(p) && modelIdsOf(p).includes(m)).map(([id]) => id);
  if (candidates.length === 0) return { kind: "companion" };
  if (candidates.length === 1) return forward(providers, candidates[0], m, hop);
  const defaults = candidates.filter((id) => providers[id]?.gpuPolicy?.defaultMember === true);
  if (defaults.length === 1) return forward(providers, defaults[0], m, hop);
  return {
    kind: "error", status: 400, code: "AMBIGUOUS_MODEL",
    message: `model "${m}" is served by more than one provider; use /llm/p/<provider>/v1, <provider>/<model>, or the ${DOOR_PROVIDER_HEADER} header`,
    candidates: candidates.map((id) => `${id}/${m}`),
  };
}

export function listDoorModels(providers = {}) {
  const out = [];
  for (const [pid, p] of Object.entries(providers)) {
    if (!forwardable(p) || isForbiddenTarget(p.baseUrl)) continue;
    const doorKind = doorKindOf(p);
    for (const mid of modelIdsOf(p)) out.push({ id: `${pid}/${mid}`, object: "model", owned_by: "crow", provider: pid, doorKind });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/door-resolve.test.js tests/models-door-locality.test.js`

- [ ] **Step 5: Commit.**

```bash
git add servers/gateway/models/door-resolve.js tests/door-resolve.test.js
git commit servers/gateway/models/door-resolve.js servers/gateway/models/door.js tests/door-resolve.test.js -m "feat(models): door resolver — managed rows only (native/external/bundle/opt-in), link-local and metadata refused, one-hop guard"
```

---

### Task 4: Door routes in `/llm`, with the source check and Funnel refusal, and native rows advertising their provider-scoped door

**Exposure, stated plainly (review C4).** `:3001` listens on `0.0.0.0`, and crow's ufw allows it on `eno1` and `wlp195s0` from anywhere, so the LAN, local containers and loopback reach `/llm`, not only the tailnet. The companion path keeps today's exposure (question for Kevin). Every **non-companion** door request, meaning provider path, header, qualified id or a bare id that resolves to a forwardable row, must come from loopback or the tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), or carry a valid bearer (the full local MCP token; Task 6 adds the models token). Every `/llm` request with `Tailscale-Funnel-Request` is refused by the router itself, even when `CROW_DASHBOARD_PUBLIC=true` bypasses the global Funnel middleware.

**Files:**
- Modify: `servers/gateway/routes/llm-router.js`, `servers/gateway/models/door-resolve.js` (add `isTrustedDoorSource`), `servers/gateway/models/manager.js` (one line), `servers/gateway/boot/late-mounts.js` (log line), `tests/auth-network.test.js`, `tests/models-registration.test.js` (three door-URL assertions)
- Test: `tests/llm-router-door.test.js`

**Interfaces:**
- Consumes: Task 3; `loadProviders` (`servers/shared/providers.js`); `maybeAcquireLocalProvider`; `validateLocalToken` (`servers/gateway/local-token.js`); `providerDoorUrl` (`door.js`).
- Produces:
  - `isTrustedDoorSource(addr) -> boolean`, in door-resolve.js.
  - Router seams `loadProvidersFn` (default `loadProviders`), `remoteAddressFn` (default `req.socket.remoteAddress`), and `doorAuthFn(token) -> Promise<boolean>` (default: the local MCP token; Task 6 widens it).
  - Routes: `POST /llm/v1/{completions,embeddings,rerank}`; the provider-scoped door `POST /llm/p/:provider/v1/{chat/completions,completions,embeddings,rerank}` and `GET /llm/p/:provider/v1/models`; and `GET /llm/v1/models`, which returns the two companion ids followed by `listDoorModels()`.
  - Error codes: `403 DOOR_SOURCE_REFUSED`, `403 FUNNEL_REFUSED`, and `409 box_reserved` / `409 serving_class_refused` on door paths (program-facing, matching `/llm/acquire`; the companion path keeps its 503 + Retry-After).
  - `registerModel` writes a native row's `base_url` as its provider-scoped door, `http://<tailnet ip>:<port>/llm/p/<providerId>/v1`. A bare door URL is ambiguous to peers whenever two rows share a model id; today `crow-embed` and `grackle-embed` both serve `qwen3-embedding-0.6b` (review C8).

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
import { isTrustedDoorSource } from "../servers/gateway/models/door-resolve.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";
import { ServingClassError } from "../servers/gateway/models/serving-class.js";

let up, upUrl, seen, srv, appUrl, acquired, remote = "127.0.0.1";

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
    "crow-chat": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 1 } },
    "crow-voice": { baseUrl: upUrl, apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
    "crow-embed": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/p/crow-embed/v1", apiKey: "none", models: [{ id: "qwen3-embedding-0.6b" }], gpuPolicy: { runtime: "native", owner: "me", port: 2 } },
    "crow-local-27b": { baseUrl: upUrl, apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow" } } },
    "crow-local-27b-copilot": { baseUrl: upUrl, apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow" } } },
    "peer-door": { baseUrl: "http://127.0.0.1:9/llm/p/peer-door/v1", apiKey: "none", models: [{ id: "far" }], gpuPolicy: { runtime: "native", owner: "other", port: 3 } },
    "qwen-cloud": { baseUrl: "https://example.com/v1", apiKey: "sk-x", models: [{ id: "qwen3.8-max" }] },
    "crow-reserved": { baseUrl: upUrl, doorUrl: "http://d/llm/p/crow-reserved/v1", apiKey: "none", models: [{ id: "r" }], gpuPolicy: { runtime: "native", owner: "me", port: 4 } },
    "crow-wedge": { baseUrl: upUrl, doorUrl: "http://d/llm/p/crow-wedge/v1", apiKey: "none", models: [{ id: "w" }], gpuPolicy: { runtime: "native", owner: "me", port: 5 } },
  };
  const router = llmRouterRouter({
    acquireFn: async (pid) => {
      acquired.push(pid);
      if (pid === "crow-reserved") throw new ReservedError({ owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: [] }, pid);
      if (pid === "crow-wedge") throw new ServingClassError("wedge-risk", "crow-wedge");
      return true;
    },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers }),
    remoteAddressFn: () => remote,
    doorAuthFn: async (token) => token === "good-token",
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

test("isTrustedDoorSource: loopback and tailnet only", () => {
  for (const a of ["127.0.0.1", "::1", "100.64.0.1", "100.118.41.122", "100.127.255.254", "fd7a:115c:a1e0::1"]) assert.equal(isTrustedDoorSource(a), true, a);
  for (const a of ["10.0.0.50", "192.168.1.2", "172.17.0.2", "100.128.0.1", "8.8.8.8", ""]) assert.equal(isTrustedDoorSource(a), false, a);
});

test("header-addressed chat forwards to that provider with its bare model id; external engines are never acquired", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] }, { "X-Crow-Provider": "crow-local-27b-copilot" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].path, "/v1/chat/completions");
  assert.equal(seen[0].body.model, "qwen3.8-27b");
  assert.deepEqual(acquired, []);
});

test("qualified chat warms a native provider before forwarding", async () => {
  await post("/llm/v1/chat/completions", { model: "crow-chat/qwen3.6-35b-a3b", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(acquired, ["crow-chat"]);
  assert.equal(seen[0].body.model, "qwen3.6-35b-a3b");
});

test("the provider-scoped path addresses crow-chat even with a companion-alias model id", async () => {
  const r = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [{ role: "user", content: "hello there" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(acquired, ["crow-chat"]);
  const m = await (await fetch(`${appUrl}/llm/p/crow-chat/v1/models`)).json();
  assert.deepEqual(m.data.map((x) => x.id), ["qwen3.6-35b-a3b"]);
  assert.equal((await fetch(`${appUrl}/llm/p/qwen-cloud/v1/models`)).status, 404);
});

test("embeddings forward through the provider path", async () => {
  const r = await post("/llm/p/crow-embed/v1/embeddings", { model: "qwen3-embedding-0.6b", input: "x" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].path, "/v1/embeddings");
});

test("companion alias ids still route by heuristics", async () => {
  await post("/llm/v1/chat/completions", { model: "qwen3.5-4b", messages: [{ role: "user", content: "hello there" }] });
  assert.deepEqual(acquired, ["crow-voice"]);
});

test("an ambiguous bare id answers 400 with candidates", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-27b", messages: [] });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.candidates.length, 2);
});

test("unmanaged (cloud) rows are refused, never proxied", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-max", messages: [] }, { "X-Crow-Provider": "qwen-cloud" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "NOT_FORWARDABLE");
  assert.equal(seen.length, 0);
});

test("a second hop answers 508", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "peer-door/far", messages: [] }, { "X-Crow-Door-Hop": "1" });
  assert.equal(r.status, 508);
});

test("a LAN source is refused for door addressing unless it carries a valid bearer; companion is unchanged", async () => {
  remote = "10.0.0.50";
  try {
    const r = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [] });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, "DOOR_SOURCE_REFUSED");
    assert.deepEqual(acquired, [], "nothing was started");
    const ok = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [] }, { authorization: "Bearer good-token" });
    assert.equal(ok.status, 200);
    const c = await post("/llm/v1/chat/completions", { model: "qwen3.5-4b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(c.status, 200, "companion path keeps today's exposure");
  } finally { remote = "127.0.0.1"; }
});

test("/llm/acquire: a LAN source is refused, loopback still works", async () => {
  remote = "10.0.0.50";
  try {
    const r = await post("/llm/acquire", { provider: "crow-chat" });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "DOOR_SOURCE_REFUSED");
  } finally { remote = "127.0.0.1"; }
  const ok = await post("/llm/acquire", { provider: "crow-chat" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test("the router refuses Funnel-headed requests itself", async () => {
  for (const path of ["/llm/v1/chat/completions", "/llm/p/crow-chat/v1/chat/completions", "/llm/v1/embeddings"]) {
    const r = await post(path, { model: "qwen3.5-4b", messages: [] }, { "tailscale-funnel-request": "?1" });
    assert.equal(r.status, 403, path);
  }
  const g = await fetch(`${appUrl}/llm/v1/models`, { headers: { "tailscale-funnel-request": "?1" } });
  assert.equal(g.status, 403);
});

test("door parity: 409 while reserved, 409 for a serving-class refusal", async () => {
  const a = await post("/llm/p/crow-reserved/v1/chat/completions", { model: "r", messages: [] });
  assert.equal(a.status, 409);
  assert.equal((await a.json()).error.code, "box_reserved");
  const b = await post("/llm/p/crow-wedge/v1/chat/completions", { model: "w", messages: [] });
  assert.equal(b.status, 409);
  assert.equal((await b.json()).error.code, "serving_class_refused");
});

test("GET /llm/v1/models lists companion ids then forwardable door models", async () => {
  const ids = (await (await fetch(`${appUrl}/llm/v1/models`)).json()).data.map((m) => m.id);
  assert.ok(ids.includes("qwen3.5-4b") && ids.includes("qwen3.6-35b-a3b"));
  assert.ok(ids.includes("crow-local-27b-copilot/qwen3.8-27b"));
  assert.equal(ids.some((i) => i.startsWith("qwen-cloud/")), false);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/llm-router-door.test.js`

- [ ] **Step 3: Implement.**

In `door-resolve.js` (Task 3's module), add:

```js
/** Loopback or the tailnet (Tailscale CGNAT 100.64.0.0/10, ULA fd7a:115c:a1e0::/48). */
export function isTrustedDoorSource(addr) {
  const a = String(addr || "").replace(/^::ffff:/i, "");
  if (a === "::1" || /^127\./.test(a)) return true;
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  return /^fd7a:115c:a1e0:/i.test(a);
}
```

In `llm-router.js`, add the imports:

```js
import { loadProviders } from "../../shared/providers.js";
import { validateLocalToken } from "../local-token.js";
import { resolveDoorTarget, listDoorModels, isDoorUrl, isTrustedDoorSource, DOOR_PROVIDER_HEADER, DOOR_HOP_HEADER } from "../models/door-resolve.js";
```

Then add the helpers below `authHeaders`:

```js
const COMPANION_MODEL_IDS = [FAST_KEY, ESC_KEY].map((k) => splitKey(k)[1]).filter(Boolean);

async function defaultDoorAuth(token) {
  if (!token) return false;
  try { return await validateLocalToken(db(), token); } catch { return false; }
}

/** Non-companion door addressing: loopback/tailnet source, or a valid bearer. */
async function doorCallerAllowed(req, deps) {
  if (isTrustedDoorSource(deps.remoteAddressFn(req))) return true;
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? !!(await deps.doorAuthFn(h.slice(7))) : false;
}

/** Forward one door request and stream the response back. */
async function forwardDoor(req, res, target, op, deps) {
  if (target.doorKind === "native-owned" || target.doorKind === "bundle") {
    await deps.acquireFn(target.providerId, { requester: requesterTag(req) });
  }
  const body = { ...(req.body || {}), model: target.modelId };
  const headers = { "Content-Type": "application/json", Accept: req.headers.accept || "application/json", ...authHeaders(target.apiKey) };
  if (target.doorKind === "native-foreign") headers[DOOR_PROVIDER_HEADER] = target.providerId;
  // Any forward to a door URL is a hop; the receiving door refuses a second one (508).
  if (isDoorUrl(target.url)) headers[DOOR_HOP_HEADER] = "1";
  const url = `${target.url}/${op}`;
  let upstream;
  try {
    const t = connectTimeout(LLM_CONNECT_TIMEOUT_MS);
    upstream = t.disarm(await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: t.signal }));
  } catch (e) {
    const msg = isTimeoutError(e) ? `upstream connect timeout after ${Math.round(LLM_CONNECT_TIMEOUT_MS / 1000)}s` : `upstream ${target.providerId} unreachable: ${e.message}`;
    return res.status(502).json({ error: { code: "UPSTREAM_UNREACHABLE", message: msg } });
  }
  console.log(`[llm-router] door ${op} -> ${target.providerId}/${target.modelId} (${target.doorKind}) requester=${requesterTag(req)}`);
  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
  if (!upstream.body) return res.end();
  await new Promise((resolve) => {
    const s = Readable.fromWeb(upstream.body);
    s.on("error", (e) => { console.error(`[llm-router] door stream error: ${e.message}`); if (!res.writableEnded) res.end(); resolve(); });
    // A client abort destroys the stream with "close", not "error", and res never
    // emits "finish": resolve on close too, or one promise leaks per aborted stream.
    res.on("close", () => { s.destroy(); resolve(); });
    res.on("finish", resolve);
    s.pipe(res);
  });
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

/** Program-facing door: orchestrator refusals answer 409, as /llm/acquire does. */
function sendAcquireError(res, err) {
  if (err instanceof ReservedError) {
    return res.status(409).json({ error: { code: "box_reserved", message: err.message, owner: err.owner, expires_at: err.expires_at } });
  }
  if (err instanceof ServingClassError) {
    return res.status(409).json({ error: { code: "serving_class_refused", message: err.message, serving_class: err.servingClass } });
  }
  return res.status(502).json({ error: { code: "router_error", message: err?.message || String(err) } });
}

/** One door request: resolve, gate the caller, forward. */
async function handleDoor(req, res, op, deps, door) {
  if (!(await doorCallerAllowed(req, deps))) {
    return res.status(403).json({ error: { code: "DOOR_SOURCE_REFUSED", message: "door addressing is limited to loopback and the tailnet, or a bearer token" } });
  }
  if (door.kind === "error") return sendDoorError(res, door);
  try { await forwardDoor(req, res, door, op, deps); }
  catch (err) { if (!res.headersSent) sendAcquireError(res, err); }
}
```

At the top of `handleChat`, before `const manualEsc = …`:

```js
  const door = doorTargetFor(req, deps);
  if (door.kind !== "companion") return handleDoor(req, res, "chat/completions", deps, door);
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

In `llmRouterRouter`:
- Add to the default `deps`: `loadProvidersFn: loadProviders`, `remoteAddressFn: (req) => req.socket?.remoteAddress || ""`, `doorAuthFn: defaultDoorAuth`.
- Change the models route to `handleModels(res, deps)`.
- Add the Funnel refusal **as the router's first middleware**, before the JSON parser.
- Register the door endpoints after the existing chat route:

```js
  // Defense in depth (review C4): the global rejectFunneledMiddleware can be
  // bypassed by CROW_DASHBOARD_PUBLIC=true; /llm never is.
  router.use("/llm", (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: { code: "FUNNEL_REFUSED", message: "/llm is never reachable through Funnel" } });
    next();
  });
```

```js
  // /llm/acquire starts (and evicts) any local model. Its only caller, the
  // pi-bots host, comes over loopback, so it gets the door's source check too
  // (re-review hardening). Register this BEFORE the existing /llm/acquire
  // handler so it runs first.
  router.post("/llm/acquire", async (req, res, next) => {
    if (await doorCallerAllowed(req, deps)) return next();
    res.status(403).json({ ok: false, error: "DOOR_SOURCE_REFUSED", message: "/llm/acquire is limited to loopback and the tailnet, or a bearer token" });
  });

  // Provider-scoped door: the path names the provider (native rows, alias rows
  // such as crow-local, and pi's managed entries point here).
  for (const op of ["chat/completions", "completions", "embeddings", "rerank"]) {
    router.post(`/llm/p/:provider/v1/${op}`, (req, res) => {
      handleDoor(req, res, op, deps, doorTargetFor(req, deps)).catch((err) => {
        if (!res.headersSent) res.status(502).json({ error: { code: "router_error", message: err.message } });
      });
    });
  }
  router.get("/llm/p/:provider/v1/models", (req, res) => {
    const p = ((deps.loadProvidersFn() || {}).providers || {})[req.params.provider];
    const listed = p ? listDoorModels({ [req.params.provider]: p }) : [];
    if (!listed.length) return res.status(404).json({ error: { code: "UNKNOWN_PROVIDER", message: `no forwardable provider "${req.params.provider}"` } });
    res.json({ object: "list", data: listed.map((m) => ({ id: m.id.slice(req.params.provider.length + 1), object: "model", owned_by: "crow", created: 0 })) });
  });
  for (const op of ["completions", "embeddings", "rerank"]) {
    router.post(`/llm/v1/${op}`, (req, res) => {
      const door = doorTargetFor(req, deps);
      if (door.kind === "companion") {
        return res.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: `no forwardable local model "${req.body?.model ?? ""}" for /${op}` } });
      }
      handleDoor(req, res, op, deps, door).catch((err) => {
        if (!res.headersSent) res.status(502).json({ error: { code: "router_error", message: err.message } });
      });
    });
  }
```

Correct the file-header SECURITY paragraph: the gateway listens on all interfaces (LAN + tailnet + loopback). The companion path is reachable from all three. Door addressing and `/llm/acquire` are limited to loopback and the tailnet (or a bearer). Funnel is refused here and by the global middleware.

The `/llm/acquire` source-check middleware above must be registered **before** the file's existing `router.post("/llm/acquire", …)` handler. Place the provider-door block, which starts with it, above that handler, or move the middleware there on its own.

In `servers/gateway/models/manager.js` `registerModel`, change `const baseUrl = doorBaseUrl({ tailnetIp, port: gatewayPortFn() });` to:

```js
  // Provider-scoped door (plan 2 Task 4): unambiguous to every peer even when
  // two rows serve the same model id (crow-embed and grackle-embed both serve
  // qwen3-embedding-0.6b today).
  const baseUrl = providerDoorUrl(doorBaseUrl({ tailnetIp, port: gatewayPortFn() }), providerId);
```

(Import `providerDoorUrl` from `./door.js`.) In `tests/models-registration.test.js`, update the regex in "registerModel: writes a provider row with the FINAL base_url, models[], and native gpu_policy" (about line 175) to `/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/llm\/p\/[^/]+\/v1$/`. Then update the three door assertions: "registerModel: row carries the door base_url…" expects `http://100.118.41.122:3001/llm/p/chat-test-model/v1` for both `r.baseUrl` and `row.base_url`, and "registerModel: no tailnet ip -> loopback door…" expects `http://127.0.0.1:3001/llm/p/chat-test-model/v1`.

In `tests/auth-network.test.js`, extend the path list of "rejectFunneled middleware: private paths blocked with Funnel header" with `"/llm/p/x/v1/chat/completions"`, `"/llm/v1/embeddings"` and `"/llm/models"`. Then add:

```js
test("/llm routers refuse Funnel themselves, even with CROW_DASHBOARD_PUBLIC=true", async () => {
  const prev = process.env.CROW_DASHBOARD_PUBLIC;
  process.env.CROW_DASHBOARD_PUBLIC = "true";
  const { default: llmRouterRouter } = await import("../servers/gateway/routes/llm-router.js");
  const app = express();
  app.use(llmRouterRouter({ acquireFn: async () => true, resolveKeyFn: async () => ({ baseUrl: "http://127.0.0.1:9/v1", model: "m" }), loadProvidersFn: () => ({ providers: {} }) }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    for (const path of ["/llm/v1/chat/completions", "/llm/p/x/v1/chat/completions", "/llm/v1/embeddings", "/llm/v1/models"]) {
      const r = await request(server.address().port, path, { "tailscale-funnel-request": "?1" });
      assert.equal(r.status, 403, path);
    }
  } finally {
    server.close();
    if (prev === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prev;
  }
});
```

Use the file's existing `request(port, path, headers)` helper and `express` import. If `request` only issues GETs, that is enough: the Funnel refusal runs before any route matching.

Update the `late-mounts.js` mount log line to list the new routes.

- [ ] **Step 4: Run.** `npm test -- tests/llm-router-door.test.js tests/llm-router-reserved.test.js tests/llm-router-serving-class.test.js tests/llm-router-crash.test.js tests/auth-network.test.js tests/models-registration.test.js tests/door-resolve.test.js` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add tests/llm-router-door.test.js
git commit servers/gateway/routes/llm-router.js servers/gateway/models/door-resolve.js servers/gateway/models/manager.js servers/gateway/boot/late-mounts.js tests/llm-router-door.test.js tests/auth-network.test.js tests/models-registration.test.js -m "feat(llm-router): model-addressed door — provider path/header/qualified/bare, loopback+tailnet source or bearer, Funnel refused in-router; native rows advertise their provider door"
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

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/models-runtime.test.js tests/gpu-orchestrator-native.test.js`. Call this out in the PR body: today nothing reads the stdout or stderr pipes of any supervised child (including `bot-runtime.js`'s Discord child), so a chatty child blocks once the 64 KB pipe buffer fills. This task fixes a latent hang (review).

- [ ] **Step 5: Commit.**

```bash
git add tests/process-supervisor-stderr.test.js
git commit servers/gateway/process-supervisor.js servers/gateway/models/runtime.js tests/process-supervisor-stderr.test.js -m "feat(supervisor): keep the last 40 stderr lines per supervised process (start failure cause)"
```

---

### Task 6: The models token

*(Ruling, spec gap)* §5.2 says the lifecycle API uses "the local MCP token pi-lab already holds". pi-lab holds no Crow token today (`~/.crow` has `board-token`, `phone-token`, `peer-tokens.json` only). The lifecycle API therefore accepts **either** the full local MCP token **or** a new path-scoped `models-token`, minted at boot to `<CROW_HOME>/models-token` (mode 0600) exactly like the board and phone tokens.

**Files:**
- Modify: `servers/gateway/local-token.js`; `servers/gateway/boot/mcp-mounts.js` (a new block right after the board-token block at ~lines 259–269, **not** inside the phone-bundle branch, review C5); `servers/gateway/routes/llm-router.js` (`defaultDoorAuth` also accepts the models token)
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

In `servers/gateway/boot/mcp-mounts.js`, add a block **mirroring the board-token block** (its own DB client) immediately after that block ends, before `mountMcpServer(app, "/board", …)`. Never place it inside or after the phone branch: `phoneDb` exists only inside `if (existsSync(…/bundles/phone/server/mcp.js))`. There a ReferenceError would be swallowed by the try/catch, and the token would never be minted on hosts without the phone bundle (review C5).

```js
  // Models arc plan 2 Task 6: the path-scoped models token for the lifecycle
  // API (/llm/models). Same shape as the board token above; best-effort.
  try {
    const tokenDb = createDbClient();
    try {
      const { minted } = await ensureModelsToken(tokenDb);
      if (minted) console.log("[gateway] models token minted");
    } finally {
      try { tokenDb.close(); } catch {}
    }
  } catch (err) {
    console.warn(`[gateway] ensureModelsToken failed: ${err.message}`);
  }
```

Import `ensureModelsToken` beside `ensureBoardToken` in the file's existing import from `../local-token.js`. Add the boot-wiring test to `tests/models-token.test.js`:

```js
test("boot wiring: the models token is minted in its own block, before the phone-bundle branch", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "boot", "mcp-mounts.js"), "utf8");
  const call = src.indexOf("ensureModelsToken(");
  const phone = src.indexOf("const phoneServerDir");
  assert.ok(call > 0, "ensureModelsToken is called at boot");
  assert.ok(phone < 0 || call < phone, "the call sits before (outside) the phone-bundle branch");
  const block = src.slice(src.lastIndexOf("try {", src.lastIndexOf("try {", call) - 1), call);
  assert.match(block, /createDbClient\(\)/, "with its own DB client, not phoneDb");
});
```

In `llm-router.js`, widen `defaultDoorAuth` (Task 4) to accept the models token too:

```js
async function defaultDoorAuth(token) {
  if (!token) return false;
  try { return (await validateLocalToken(db(), token)) || (await validateModelsToken(db(), token)); } catch { return false; }
}
```

(import `validateModelsToken` beside `validateLocalToken`).

- [ ] **Step 4: Run, expect PASS.** `npm test -- tests/models-token.test.js tests/auth-network.test.js`, plus every existing token test (`ls tests | grep -E "token|board-mcp"`).

- [ ] **Step 5: Commit.**

```bash
git add tests/models-token.test.js
git commit servers/gateway/local-token.js servers/gateway/boot/mcp-mounts.js servers/gateway/routes/llm-router.js tests/models-token.test.js -m "feat(auth): path-scoped models token for the lifecycle API (minted at boot to CROW_HOME/models-token)"
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
    // Native and external-engine rows only (bundle/opt-in/unmanaged rows have no lifecycle here).
    if (kind !== "native-owned" && kind !== "native-foreign" && kind !== "external") continue;
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

Known gap (review suggestion 10, not taken here): `wouldEvict` sees only **native** resident siblings, so a resident **bundle** sibling (the 35B before plan 4's W3) is missing from the prediction. State this in the pi-lab handoff (Task 12); it disappears as roles move native.

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
  "crow-null": { models: [{ id: "n" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18106/v1", gpuPolicy: { runtime: "native", owner: "me", port: 18106 } },
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
      if (name === "crow-dead") { const e = new Error("failed to bind"); e.stderrTail = ["llama_model_load: error loading model", "out of memory"]; throw e; }
      if (name === "crow-null") return null; // acquireProvider's "not orchestratable here"

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
  assert.deepEqual(j.cause, ["llama_model_load: error loading model", "out of memory"], "the orchestrator's stderr tail, not the (already removed) handle's");
});

test("an acquire that returns anything but true is a failed job, never resident", async () => {
  const { job_id } = await (await fetch(`${url}/llm/models/crow-null/start`, { method: "POST", headers: auth })).json();
  const j = await waitJob(job_id);
  assert.equal(j.state, "failed");
  assert.match(j.error, /not started/);
});

test("/llm/models refuses Funnel-headed requests itself", async () => {
  const r = await fetch(`${url}/llm/models`, { headers: { ...auth, "tailscale-funnel-request": "?1" } });
  assert.equal(r.status, 403);
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
  // Through the single-flight queue, so a stop never races an in-flight
  // acquire or eviction (review). The handle's onTerminal already persists
  // the wasLive:false liveness marker, so a stopped model is not re-warmed at
  // boot; idle-revert may still bring back a group's defaultMember (unchanged).
  const run = _swapInFlight.then(async () => {
    const h = _nativeHandles.get(name);
    if (!h || !h.live) return { stopped: false };
    await stopModel(h);
    _nativeHandles.delete(name);
    _lastUsedAt.delete(name);
    console.log(`[gpu-orchestrator] stopped native ${name} (requested-by=${opts.requester || "-"})`);
    return { stopped: true };
  });
  _swapInFlight = run.catch(() => {});
  return run;
}
```

(`loadProviders` here is the module's existing local `loadProviders()` function; `getProvider`, `getMutexSiblings`, `isNativeRuntime`, `orchestratableHere`, `_nativeHandles`, `_lastUsedAt`, `_swapInFlight`, `stopModel` already exist in the file.)

**The stderr tail rides on the start error (review C6).** In `startNativeAndAwaitReady`, the failure branch stops the handle and deletes it from `_nativeHandles` before any caller can read it. Capture the tail first: directly before `try { await handle.stop(); }` in the post-readiness failure path, add

```js
  const stderrTail = typeof handle.status === "function" ? (handle.status().stderrTail || []) : [];
```

and attach it to both throws:

```js
  if (result === "conflict") {
    const err = new NativePortConflictError(providerName, nativeLocalUrl(p));
    err.stderrTail = stderrTail;
    throw err;
  }
  const err = new Error(`orchestrator: native provider "${providerName}" failed to bind port ${port} within ${readinessTimeoutMs}ms — refusing to rebind on a different port`);
  err.stderrTail = stderrTail;
  throw err;
```

Test it in a new `tests/gpu-orchestrator-stderr-cause.test.js`:

```js
// tests/gpu-orchestrator-stderr-cause.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireProvider, _setOwnInstanceIdForTest, _setReservationReaderForTest } from "../servers/gateway/gpu-orchestrator.js";

_setOwnInstanceIdForTest("me");
_setReservationReaderForTest(() => null);

const catalog = { models: [{ id: "m-dead", task: "chat", context_len: 8192, serving: { class: "resident" } }] };
const state = { registry: { "m-dead@Q": { catalogId: "m-dead", quant: "Q", file: "m.gguf", path: "/w/m.gguf", sizeMb: 1 } }, reservations: {}, conversions: {}, runtimeOverrides: {} };
const cfg = { providers: { "m-dead": { baseUrl: "http://127.0.0.1:18177/v1", doorUrl: "http://d/llm/p/m-dead/v1", models: [{ id: "m-dead" }],
  gpuPolicy: { runtime: "native", owner: "me", catalogId: "m-dead", quant: "Q", port: 18177 } } } };

test("a native start that never becomes ready throws with the child's stderr tail, after stopping it", async () => {
  let stopped = false;
  const opts = {
    cfg, resolveDataDirFn: () => "/fake", loadStateFn: () => state, loadCatalogFn: () => catalog,
    getCachedProbeFn: () => ({ accel: "cpu" }), reprobeFn: async () => ({ accel: "cpu" }), existsSyncFn: () => true,
    ensureRuntimeFn: async () => "/opt/llama/llama-server", getRuntimeOverrideFn: () => null, getModelRuntimeOverrideFn: () => null,
    identityProbeFn: async () => "down", acquireHostLockFn: () => () => {},
    startModelFn: () => ({ live: true, argv: [], touch() {}, status: () => ({ stderrTail: ["llama_model_load: error loading model", "out of memory"] }), stop: async () => { stopped = true; } }),
    readinessTimeoutMs: 20, readinessPollMs: 1, readinessInitialDelayMs: 0,
  };
  await assert.rejects(acquireProvider("m-dead", opts), (e) => Array.isArray(e.stderrTail) && e.stderrTail.includes("out of memory"));
  assert.equal(stopped, true);
});
```

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
  router.use("/llm/models", (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: { code: "FUNNEL_REFUSED", message: "/llm is never reachable through Funnel" } });
    next();
  });
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
        const result = await deps.acquireFn(name, { requester });
        // acquireProvider returns null when the row is not orchestratable here
        // and false on a readiness timeout: only `true` means resident (review C6).
        if (result === true) jobs.update(job.id, { state: "resident" });
        else jobs.update(job.id, { state: "failed", error: `${name} was not started (acquire returned ${JSON.stringify(result)})`, cause: [] });
      } catch (err) {
        if (err instanceof ReservedError) {
          jobs.update(job.id, { state: "blocked_by_reservation", reservation: { owner: err.owner, expires_at: err.expires_at }, error: err.message });
        } else {
          // The orchestrator removes the handle on a failed start, so the tail
          // rides on the error (startNativeAndAwaitReady attaches it).
          jobs.update(job.id, { state: "failed", error: err?.message || String(err), cause: Array.isArray(err?.stderrTail) ? err.stderrTail : [] });
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

Mount it in `servers/gateway/boot/late-mounts.js` immediately before the `llmRouterRouter` block, in **its own** try/catch. An import failure of the new router must never stop the companion `/llm/v1` router (the production voice path) from mounting:

```js
  try {
    const { default: llmModelsRouter } = await import("../routes/llm-models.js");
    app.use(llmModelsRouter());
    console.log("  [llm-models] mounted: GET /llm/models, POST /llm/models/:provider/start|stop, GET /llm/models/jobs/:id");
  } catch (err) {
    console.warn("[llm-models] Failed to mount:", err.message);
  }
```

**What the token actually protects (review).** `/llm/acquire` and the door already start, and evict, models without a token, from loopback and the tailnet. The models token therefore gates the lifecycle API's `stop`, its job polling and its listing. It does not gate starting. Say so in the docs (Task 13).

Note on the start state: `acquireProvider` runs the sibling eviction itself; the route reports `evicting` when a resident sibling exists at job start, then `starting` is skipped. That is coarse but honest; the orchestrator has no progress callback, and adding one is not in scope.

- [ ] **Step 5: Run, expect PASS**, plus `npm test -- tests/llm-models-routes.test.js tests/gpu-orchestrator-stderr-cause.test.js tests/gpu-orchestrator-native.test.js tests/auth-network.test.js`.

- [ ] **Step 6: Commit.**

```bash
git add servers/gateway/routes/llm-models.js tests/llm-models-routes.test.js tests/gpu-orchestrator-stderr-cause.test.js
git commit servers/gateway/routes/llm-models.js servers/gateway/gpu-orchestrator.js servers/gateway/boot/late-mounts.js tests/llm-models-routes.test.js tests/gpu-orchestrator-stderr-cause.test.js -m "feat(llm): lifecycle API — /llm/models list, async start jobs, stop, NOT_OWNER/EXTERNAL_ENGINE, token auth"
```

---

### Task 9: pi `models.json` managed sync (M1)

Spec §11.6, revised after the review:
- **Local rows by default.** Only rows Crow manages (`doorKindOf` ≠ `unmanaged`: native, external engine, bundle, door opt-in) become managed entries. A cloud row is added only if its id is listed in `CROW_PI_MODELS_SYNC_CLOUD`, comma-separated. Today's DB holds five paid cloud providers that pi bots would otherwise be able to select (review Q1); scope is a question for Kevin.
- **Embedding and rerank models are dropped** (their model `task` is in `EMBED_TASKS`/`RERANK_TASKS`). A provider left with no models is skipped.
- **A native row's pi URL is built** from this gateway's door base plus the provider id (`providerDoorUrl(doorBaseUrl(...), id)`), never from the row's stored `base_url`. A legacy native row such as `qwen3.5-4b` stores a loopback URL that would bypass the door.
- **Off by default except where pi actually runs.** It writes only when `CROW_PI_MODELS_SYNC_PATH` is set, or when this is the primary `CROW_HOME` (`~/.crow`), `~/.pi/agent` exists, and the pi CLI resolves. `CROW_PI_MODELS_SYNC=0` disables it.
- **Lost-update safe.** pi-lab and plan 4's windows hand-edit the same file, so the writer re-reads it immediately before the rename and retries (up to 3 times) if it changed.
- **When it runs:** installed only in admin-api's authenticated branch (never `--no-auth`). It runs at boot, after every local provider write (debounced), and on the hourly reconcile tick. That last trigger covers changes that arrive by replication, which the local hook does not see.

**Files:**
- Create: `servers/shared/pi-models-sync.js`
- Modify: `servers/shared/providers-db.js` (`setProviderChangeHook`, called from `emitSync`); `servers/gateway/boot/admin-api.js` (inside the existing `else` branch that runs the reconciler)
- Test: `tests/pi-models-sync.test.js`

**Interfaces:**
- Consumes: `listProvidersAll(db)`; `doorKindOf` (Task 3); `providerDoorUrl`, `doorBaseUrl`, `gatewayPort` (`door.js`); `getOwnTailnetIp`; `EMBED_TASKS`, `RERANK_TASKS` (`provider-task.js`); `resolvePiCli` (`scripts/pi-bots/pi_resolver.mjs`).
- Produces:
  - `CROW_MANAGED_KEY = "$crowManaged"`
  - `piModelsSyncPath({ env, crowHome, home, existsFn, piCliFn }) -> string|null` (null means disabled)
  - `buildManagedEntries(rows, { doorBase, cloudAllow }) -> Record<id, { baseUrl, apiKey, api, models }>`
  - `mergeManaged(fileJson, entries) -> { json, added, updated, removed }`
  - `syncPiModelsJson(db, { path, doorBase, cloudAllow, listProvidersAllFn, readFileFn, writeFileAtomicFn }) -> Promise<{ path, added, updated, removed } | { disabled: true }>`
  - providers-db: `setProviderChangeHook(fn | null)`. `emitSync` calls the hook; it is never awaited and never throws.

- [ ] **Step 1: Write the failing test.**

```js
// tests/pi-models-sync.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManagedEntries, mergeManaged, piModelsSyncPath, syncPiModelsJson, CROW_MANAGED_KEY } from "../servers/shared/pi-models-sync.js";

const DOOR = "http://100.64.9.1:3001/llm/v1";
const rows = [
  { id: "crow-chat", baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: null, bundleId: null, disabled: false, provider_type: "openai-compat",
    models: [{ id: "qwen3.6-35b-a3b", contextWindow: 262144 }], gpuPolicy: { runtime: "native", owner: "me", port: 18102 } },
  { id: "qwen3.5-4b", baseUrl: "http://127.0.0.1:18100/v1", apiKey: null, bundleId: null, disabled: false, provider_type: null,
    models: [{ id: "qwen3.5-4b" }], gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } },
  { id: "crow-voice", baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", disabled: false, provider_type: "openai-compat", models: [{ id: "qwen3.5-4b" }], gpuPolicy: null },
  { id: "crow-embed", baseUrl: "http://100.64.9.1:3001/llm/p/crow-embed/v1", apiKey: null, bundleId: null, disabled: false, provider_type: "openai-compat",
    models: [{ id: "qwen3-embedding-0.6b", task: "embedding" }], gpuPolicy: { runtime: "native", owner: "me", port: 18101 } },
  { id: "Qwen Cloud", baseUrl: "https://maas.example.com/v1", apiKey: "sk-live", bundleId: null, disabled: false, provider_type: "openai-compat", models: [{ id: "qwen3.8-max" }], gpuPolicy: null },
  { id: "crow-swap-agentic", baseUrl: "http://localhost:3001/llm/v1", apiKey: "none", bundleId: null, disabled: false, provider_type: "openai-compat", models: [{ id: "crow" }], gpuPolicy: null },
  { id: "anthropic-x", baseUrl: "https://api.anthropic.com", apiKey: "k", bundleId: null, disabled: false, provider_type: "anthropic", models: [{ id: "c" }], gpuPolicy: null },
  { id: "old", baseUrl: "http://100.64.9.1:8009/v1", apiKey: "none", bundleId: "b", disabled: true, provider_type: "openai-compat", models: [{ id: "n" }], gpuPolicy: null },
];

test("buildManagedEntries: managed local rows only; native rows get this gateway's provider door; embeddings dropped", () => {
  const e = buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: [] });
  assert.deepEqual(Object.keys(e).sort(), ["crow-chat", "crow-voice", "qwen3.5-4b"]);
  assert.equal(e["crow-chat"].baseUrl, "http://100.64.9.1:3001/llm/p/crow-chat/v1");
  assert.equal(e["qwen3.5-4b"].baseUrl, "http://100.64.9.1:3001/llm/p/qwen3.5-4b/v1", "a loopback-stored native row still goes through the door");
  assert.equal(e["crow-chat"].apiKey, "none");
  assert.equal(e["crow-chat"].api, "openai-completions");
  assert.deepEqual(e["crow-chat"].models, [{ id: "qwen3.6-35b-a3b", contextWindow: 262144 }]);
  assert.equal(e["crow-embed"], undefined, "an embedding-only provider is not a chat model for pi");
  assert.equal(e["crow-swap-agentic"], undefined, "an unmanaged alias row is skipped");
  assert.equal(e["Qwen Cloud"], undefined, "cloud rows need the explicit allowlist");
});

test("buildManagedEntries: an allow-listed cloud row is included with its DB key", () => {
  const e = buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: ["Qwen Cloud"] });
  assert.equal(e["Qwen Cloud"].apiKey, "sk-live");
  assert.equal(e["anthropic-x"], undefined, "non-OpenAI types never");
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
  const { json, added, updated, removed } = mergeManaged(file, buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: ["Qwen Cloud"] }));
  assert.deepEqual(added, ["crow-chat", "qwen3.5-4b"]);
  assert.deepEqual(updated, ["Qwen Cloud"]);
  assert.deepEqual(removed, ["gone"]);
  assert.equal(json.providers["crow-local"].baseUrl, "http://100.64.9.1:8003/v1");
  assert.equal(json.providers["crow-voice"].baseUrl, "http://hand-written/v1", "a hand-written id wins over a DB row");
  assert.equal(json.providers["Qwen Cloud"].apiKey, "sk-live");
});

test("mergeManaged is idempotent", () => {
  const entries = buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: [] });
  const once = mergeManaged({ providers: {} }, entries).json;
  const twice = mergeManaged(once, entries);
  assert.deepEqual([twice.added, twice.updated, twice.removed], [[], [], []]);
});

test("piModelsSyncPath: explicit path; primary home only when pi is installed; kill switch", () => {
  const home = "/home/u";
  const yes = { existsFn: () => true, piCliFn: () => ({ cliPath: "/x/cli.js" }) };
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home, ...yes }), "/home/u/.pi/agent/models.json");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home, existsFn: () => false, piCliFn: yes.piCliFn }), null, "no ~/.pi/agent: never create one");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home, existsFn: () => true, piCliFn: () => null }), null, "no pi installed");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow-r4", home, ...yes }), null);
  assert.equal(piModelsSyncPath({ env: { CROW_PI_MODELS_SYNC_PATH: "/x/models.json" }, crowHome: "/home/u/.crow-r4", home, ...yes }), "/x/models.json");
  assert.equal(piModelsSyncPath({ env: { CROW_PI_MODELS_SYNC: "0" }, crowHome: "/home/u/.crow", home, ...yes }), null);
});

test("syncPiModelsJson writes 0600, skips a no-op, and retries when the file changed under it", async () => {
  let content = JSON.stringify({ providers: {} });
  const writes = [];
  let reads = 0;
  // The second read (the pre-rename re-check) sees a hand edit that landed meanwhile.
  const readFileFn = () => { reads++; if (reads === 2) content = JSON.stringify({ providers: { "hand": { baseUrl: "http://h/v1", apiKey: "none", models: [{ id: "h" }] } } }); return content; };
  const writeFileAtomicFn = (p, data, mode) => { writes.push({ mode }); content = data; };
  const res = await syncPiModelsJson({}, { path: "/tmp/pi/models.json", doorBase: DOOR, cloudAllow: [], listProvidersAllFn: async () => rows, readFileFn, writeFileAtomicFn });
  assert.deepEqual(res.added.sort(), ["crow-chat", "crow-voice", "qwen3.5-4b"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, 0o600);
  assert.ok(JSON.parse(content).providers.hand, "the concurrent hand edit survived (re-read + retry)");
  const n = writes.length;
  await syncPiModelsJson({}, { path: "/tmp/pi/models.json", doorBase: DOOR, cloudAllow: [], listProvidersAllFn: async () => rows, readFileFn: () => content, writeFileAtomicFn });
  assert.equal(writes.length, n, "no-op run does not rewrite");
});

test("syncPiModelsJson refuses to clobber an unparseable file", async () => {
  await assert.rejects(
    syncPiModelsJson({}, { path: "/tmp/x.json", doorBase: DOOR, listProvidersAllFn: async () => rows, readFileFn: () => "{not json", writeFileAtomicFn: () => { throw new Error("must not write"); } }),
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
 * hand-written id wins over a DB row of the same id. The reconciler and the
 * first-boot seed (providers-db.js) skip $crowManaged ids, so this output is
 * never re-imported (Task 2).
 *
 * Scope (review, Q1 open): rows Crow manages (native, external engine,
 * bundle, door opt-in) and only allow-listed cloud rows
 * (CROW_PI_MODELS_SYNC_CLOUD). Embedding and rerank models are not chat
 * models for pi and are dropped.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { doorKindOf } from "../gateway/models/door-resolve.js";
import { providerDoorUrl } from "../gateway/models/door.js";
import { EMBED_TASKS, RERANK_TASKS } from "./provider-task.js";
import { listProvidersAll } from "./providers-db.js";
import { resolvePiCli } from "../../scripts/pi-bots/pi_resolver.mjs";

export const CROW_MANAGED_KEY = "$crowManaged";
const OPENAI_TYPES = new Set([null, undefined, "", "openai-compat", "openai"]);
const NON_CHAT = new Set([...EMBED_TASKS, ...RERANK_TASKS]);

export function piModelsSyncPath({
  env = process.env, crowHome = env.CROW_HOME || join(homedir(), ".crow"), home = env.HOME || homedir(),
  existsFn = existsSync, piCliFn = () => resolvePiCli({ env, crowHome }),
} = {}) {
  if (env.CROW_PI_MODELS_SYNC === "0") return null;
  if (env.CROW_PI_MODELS_SYNC_PATH) return env.CROW_PI_MODELS_SYNC_PATH;
  if (resolve(crowHome) !== resolve(join(home, ".crow"))) return null;
  if (!existsFn(join(home, ".pi", "agent"))) return null; // never create pi's dir on a host that does not run pi
  if (!piCliFn()) return null;
  return join(home, ".pi", "agent", "models.json");
}

function chatModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m && typeof m.id === "string" && m.id && !NON_CHAT.has(m.task))
    .map((m) => {
      const out = { id: m.id };
      for (const k of ["name", "contextWindow", "maxTokens", "reasoning", "input"]) if (m[k] !== undefined) out[k] = m[k];
      return out;
    });
}

export function buildManagedEntries(rows, { doorBase, cloudAllow = [] } = {}) {
  const allow = new Set(cloudAllow);
  const out = {};
  for (const r of rows) {
    if (r.disabled || r.gpuPolicy?.local_only === true) continue;
    if (!OPENAI_TYPES.has(r.provider_type)) continue;
    const kind = doorKindOf({ baseUrl: r.baseUrl, bundleId: r.bundleId, gpuPolicy: r.gpuPolicy, models: r.models });
    if (kind === "unmanaged" && !allow.has(r.id)) continue;
    const models = chatModels(r.models);
    if (!models.length || !r.baseUrl) continue;
    const native = kind === "native-owned" || kind === "native-foreign";
    const baseUrl = native && doorBase && kind === "native-owned" ? providerDoorUrl(doorBase, r.id) : r.baseUrl;
    out[r.id] = { baseUrl, apiKey: r.apiKey || "none", api: "openai-completions", models };
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

function readOrNull(readFileFn, path) {
  try { return readFileFn(path); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

export async function syncPiModelsJson(db, {
  path = piModelsSyncPath(),
  doorBase = null,
  cloudAllow = String(process.env.CROW_PI_MODELS_SYNC_CLOUD || "").split(",").map((s) => s.trim()).filter(Boolean),
  listProvidersAllFn = listProvidersAll,
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileAtomicFn = defaultWriteAtomic,
} = {}) {
  if (!path) return { disabled: true };
  const entries = buildManagedEntries(await listProvidersAllFn(db), { doorBase, cloudAllow });
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = readOrNull(readFileFn, path);
    let current = { providers: {} };
    if (raw !== null) {
      try { current = JSON.parse(raw); } catch { throw new Error(`pi models.json at ${path} is not valid JSON — refusing to overwrite it`); }
    }
    const { json, added, updated, removed } = mergeManaged(current, entries);
    if (!added.length && !updated.length && !removed.length && Array.isArray(current[CROW_MANAGED_KEY])) return { path, added, updated, removed };
    // Lost-update guard: pi-lab and plan 4's windows hand-edit this file. If it
    // changed since we read it, merge again from the new content.
    if (readOrNull(readFileFn, path) !== raw) continue;
    writeFileAtomicFn(path, JSON.stringify(json, null, 2) + "\n", 0o600);
    return { path, added, updated, removed };
  }
  throw new Error(`pi models.json at ${path} kept changing under the writer; not written`);
}
```

The guard re-reads immediately before the atomic rename, which narrows the race. Any writer that edits between that read and the rename still loses. The test drives the retry branch by changing the second read.

In `providers-db.js`:

```js
let _providerChangeHook = null;
/** M1: called (fire-and-forget) after every LOCAL provider write that reaches emitSync.
 * Replicated applies do not pass through here; the hourly tick covers them. */
export function setProviderChangeHook(fn) { _providerChangeHook = typeof fn === "function" ? fn : null; }

async function emitSync(db, op, row) {
  await emitOrQueue(_syncManager, db, "providers", op, row);
  if (_providerChangeHook) {
    try { _providerChangeHook({ op, id: row?.id }); } catch (err) { console.warn(`[providers] change hook failed: ${err.message}`); }
  }
}
```

In `servers/gateway/boot/admin-api.js`, **inside the same `else` branch as the reconciler** (it is skipped under `--no-auth`, so a no-auth companion that shares `~/.crow` never becomes a second writer), right after `t.unref();`:

```js
    try {
      const { syncPiModelsJson, piModelsSyncPath } = await import("../../shared/pi-models-sync.js");
      const { setProviderChangeHook } = await import("../../shared/providers-db.js");
      const { doorBaseUrl, gatewayPort } = await import("../models/door.js");
      const { getOwnTailnetIp } = await import("../../shared/tailnet-ip.js");
      const target = piModelsSyncPath();
      if (target) {
        let timer = null;
        const run = () => syncPiModelsJson(createDbClient(), { path: target, doorBase: doorBaseUrl({ tailnetIp: getOwnTailnetIp(), port: gatewayPort() }) })
          .then((r) => { if (r.added?.length || r.updated?.length || r.removed?.length) console.log(`[pi-models-sync] ${target}: +${r.added.length} ~${r.updated.length} -${r.removed.length}`); })
          .catch((err) => console.warn(`[pi-models-sync] ${err.message}`));
        setProviderChangeHook(() => { clearTimeout(timer); timer = setTimeout(run, 2000); timer.unref?.(); });
        setInterval(run, reconcileIntervalMs()).unref(); // replicated changes reach pi within the hour
        await run();
      } else {
        console.log("[pi-models-sync] off on this host (no pi here, not the primary CROW_HOME, or CROW_PI_MODELS_SYNC=0)");
      }
    } catch (err) {
      console.warn(`[pi-models-sync] boot failed: ${err.message}`);
    }
```

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/pi-models-sync.test.js tests/providers-reconcile-native-guard.test.js tests/providers-upsert-noop.test.js tests/models-json-seam.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add servers/shared/pi-models-sync.js tests/pi-models-sync.test.js
git commit servers/shared/pi-models-sync.js servers/shared/providers-db.js servers/gateway/boot/admin-api.js tests/pi-models-sync.test.js -m "feat(pi): crow-managed provider entries in pi models.json (M1) — managed local rows, allow-listed cloud, lost-update guard, only where pi runs"
```

---

### Task 10: Pre-spawn validation (M2), asynchronous

**Revision 2 (review C9).** `pi --list-models` takes about 1.1 s on crow and starts pi's MCP servers to answer. A `spawnSync` would block the bridge's event loop, Discord heartbeats included. The listing therefore runs through async `execFile` with one shared in-flight promise, is cached for 5 minutes, and a miss re-lists once. The cache lives in the bot process; M1's writes happen in the gateway and cannot invalidate it. The re-list on a miss is what picks up a provider M1 just wrote.

**Files:**
- Create: `scripts/pi-bots/pi-model-catalog.mjs`
- Modify: `scripts/pi-bots/bot-world.mjs` (after `resolveModel`), `scripts/pi-bots/job_runner.mjs` (after its `resolveModel`)
- Test: `tests/pi-model-catalog.test.js`

**Interfaces:**
- Consumes: `resolveNodeBin`, `resolvePiCli` from `scripts/pi-bots/pi_resolver.mjs`.
- Produces:
  - `parsePiListModels(stdout) -> Set<"provider/model">`
  - `listPiModels({ execFileFn, nowFn, ttlMs = 300000, force = false, resolvePiCliFn, resolveNodeBinFn }) -> Promise<{ ok: true, keys: Set } | { ok: false, error }>`. Concurrent callers share one spawn.
  - `piModelsFileKeys({ path, readFileFn }) -> Set<"provider/model"> | null`: what pi's `models.json` declares, with no spawn. Task 11 uses it.
  - `invalidatePiModelCache()`
  - `checkPiModel({ provider, model }, deps) -> Promise<{ ok: true } | { ok: true, unverified: true } | { ok: false, message }>`. A key that pi's `models.json` declares passes without a spawn; only other keys pay for the listing. This keeps `tests/perch-interactive.test.js`'s `prepareSpawn` cases, which write `PI_MODELS_JSON`, from spawning a real pi. The message is exactly `model "<provider>/<model>" is not available to the bot engine`. A failed listing lets the turn proceed.
  - `class PiModelUnavailableError extends Error { code = "PI_MODEL_UNAVAILABLE" }`

- [ ] **Step 1: Write the failing test.**

```js
// tests/pi-model-catalog.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiListModels, listPiModels, checkPiModel, invalidatePiModelCache, piModelsFileKeys } from "../scripts/pi-bots/pi-model-catalog.mjs";

// CI has no pi installed: every call injects the resolvers.
const R = { resolvePiCliFn: () => ({ cliPath: "/fake/pi/cli.js", source: "env" }), resolveNodeBinFn: () => "/fake/node", piKeysFn: () => null };
const OUT = [
  "provider         model              context  max-out  thinking  images",
  "crow-chat        qwen3.6-35b-a3b    262K     32K      yes       yes",
  "Qwen Cloud       qwen3.8-max        1M       64K      yes       no",
  "zai-coding       glm-5.1            200K     32K      yes       no",
].join("\n");
const okExec = (counter) => (cmd, args, opts, cb) => { if (counter) counter.n++; setImmediate(() => cb(null, OUT, "")); };

test("parse: columns are separated by two or more spaces (provider ids may contain one space)", () => {
  const keys = parsePiListModels(OUT);
  assert.ok(keys.has("crow-chat/qwen3.6-35b-a3b"));
  assert.ok(keys.has("Qwen Cloud/qwen3.8-max"));
  assert.equal(keys.size, 3);
});

test("listing is async, cached for ttl, shared between concurrent callers, and invalidated on demand", async () => {
  invalidatePiModelCache();
  const c = { n: 0 };
  let t = 0;
  const [a, b] = await Promise.all([listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t }), listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t })]);
  assert.equal(c.n, 1, "one spawn for two concurrent callers");
  assert.ok(a.ok && b.ok);
  t = 1000;
  await listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t });
  assert.equal(c.n, 1, "cached");
  invalidatePiModelCache();
  await listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t });
  assert.equal(c.n, 2);
});

test("unknown model fails with the exact operator message (after one forced re-list)", async () => {
  invalidatePiModelCache();
  const c = { n: 0 };
  const r = await checkPiModel({ provider: "crow-chat", model: "nope" }, { ...R, execFileFn: okExec(c) });
  assert.deepEqual(r, { ok: false, message: 'model "crow-chat/nope" is not available to the bot engine' });
  assert.equal(c.n, 2);
});

test("a failed listing or a missing pi lets the turn proceed (unverified)", async () => {
  invalidatePiModelCache();
  const failing = (cmd, args, opts, cb) => setImmediate(() => cb(new Error("exit 1"), "", "boom"));
  assert.deepEqual(await checkPiModel({ provider: "crow-chat", model: "qwen3.6-35b-a3b" }, { ...R, execFileFn: failing }), { ok: true, unverified: true });
  invalidatePiModelCache();
  assert.equal((await listPiModels({ resolvePiCliFn: () => null, resolveNodeBinFn: () => "/fake/node" })).ok, false);
});

test("a known model passes", async () => {
  invalidatePiModelCache();
  assert.deepEqual(await checkPiModel({ provider: "zai-coding", model: "glm-5.1" }, { ...R, execFileFn: okExec() }), { ok: true });
});

test("a key declared in pi's models.json passes without spawning pi", async () => {
  invalidatePiModelCache();
  const c = { n: 0 };
  const r = await checkPiModel({ provider: "crow-chat", model: "qwen3.6-35b-a3b" }, { ...R, piKeysFn: () => new Set(["crow-chat/qwen3.6-35b-a3b"]), execFileFn: okExec(c) });
  assert.deepEqual(r, { ok: true });
  assert.equal(c.n, 0);
});

test("piModelsFileKeys reads models.json without spawning; unreadable → null", () => {
  const json = JSON.stringify({ $crowManaged: ["crow-chat"], providers: { "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }] }, "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } });
  const keys = piModelsFileKeys({ path: "/x", readFileFn: () => json });
  assert.ok(keys.has("crow-chat/qwen3.6-35b-a3b") && keys.has("crow-local/qwen3.6-35b-a3b"));
  assert.equal(piModelsFileKeys({ path: "/x", readFileFn: () => { throw new Error("ENOENT"); } }), null);
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/pi-model-catalog.test.js`

- [ ] **Step 3: Implement.**

```js
// scripts/pi-bots/pi-model-catalog.mjs
/**
 * M2 (spec §11.6): know which provider/model keys pi can use, so a bot turn
 * fails fast with a clear message instead of spawning pi into "Unknown
 * provider". Source: `pi --list-models`, run ASYNCHRONOUSLY (about 1.1 s on
 * crow, and it starts pi's MCP servers) with one shared in-flight promise.
 * Cached 5 minutes in THIS process. The gateway's M1 writes cannot
 * invalidate it; a miss re-lists once instead. A listing that fails never
 * blocks a turn.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveNodeBin, resolvePiCli } from "./pi_resolver.mjs";

let _cache = null; // { at, keys }
let _inflight = null;
let _warned = false;

export function invalidatePiModelCache() { _cache = null; }

export function parsePiListModels(stdout) {
  const keys = new Set();
  for (const line of String(stdout || "").split("\n").slice(1)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length >= 2 && cols[0] && cols[1]) keys.add(`${cols[0]}/${cols[1]}`);
  }
  return keys;
}

export class PiModelUnavailableError extends Error {
  constructor(message) { super(message); this.name = "PiModelUnavailableError"; this.code = "PI_MODEL_UNAVAILABLE"; }
}

export function listPiModels({
  execFileFn = execFile, nowFn = Date.now, ttlMs = 300_000, force = false,
  resolvePiCliFn = resolvePiCli, resolveNodeBinFn = resolveNodeBin,
} = {}) {
  if (!force && _cache && nowFn() - _cache.at < ttlMs) return Promise.resolve({ ok: true, keys: _cache.keys });
  if (_inflight) return _inflight;
  _inflight = new Promise((resolveP) => {
    let cli;
    try { cli = resolvePiCliFn(); } catch (e) { return resolveP({ ok: false, error: e.message }); }
    if (!cli || !cli.cliPath) return resolveP({ ok: false, error: "pi CLI not found (pi_resolver ladder)" });
    execFileFn(resolveNodeBinFn(), [cli.cliPath, "--list-models"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolveP({ ok: false, error: String(stderr || err.message) });
      const keys = parsePiListModels(stdout);
      _cache = { at: nowFn(), keys };
      resolveP({ ok: true, keys });
    });
  }).finally(() => { _inflight = null; });
  return _inflight;
}

/** What pi's models.json declares, without spawning pi (the gateway's M3 marks). */
export function piModelsFileKeys({ path = process.env.PI_MODELS_JSON || `${process.env.HOME || homedir()}/.pi/agent/models.json`, readFileFn = (p) => readFileSync(p, "utf8") } = {}) {
  let j;
  try { j = JSON.parse(readFileFn(path)); } catch { return null; }
  const keys = new Set();
  for (const [pid, p] of Object.entries((j && j.providers) || {})) {
    for (const m of Array.isArray(p?.models) ? p.models : []) if (m && m.id) keys.add(`${pid}/${m.id}`);
  }
  return keys;
}

export async function checkPiModel({ provider, model }, deps = {}) {
  const key = `${provider}/${model}`;
  // Fast path, no spawn: a key pi's models.json declares (every M1 entry and
  // every hand-written one) is usable. Only a key absent from the file (a pi
  // built-in, or a genuinely unknown model) pays for `pi --list-models`.
  const fileKeys = (deps.piKeysFn || piModelsFileKeys)();
  if (fileKeys && fileKeys.has(key)) return { ok: true };
  const l = await listPiModels(deps);
  if (!l.ok) {
    if (!_warned) { _warned = true; console.warn(`[pi-model-catalog] pi --list-models failed, not validating models: ${l.error}`); }
    return { ok: true, unverified: true };
  }
  if (l.keys.has(key)) return { ok: true };
  if (!deps.force) {
    const again = await listPiModels({ ...deps, force: true });
    if (again.ok && again.keys.has(key)) return { ok: true };
  }
  return { ok: false, message: `model "${key}" is not available to the bot engine` };
}
```

In `scripts/pi-bots/bot-world.mjs`, right after `const resolved = await resolveModel(def, { escalate });`:

```js
  // M2: fail the turn before spawning when pi cannot use the resolved model.
  const piCheck = await checkPiModel(resolved);
  if (!piCheck.ok) throw new PiModelUnavailableError(piCheck.message);
```

Add `import { checkPiModel, PiModelUnavailableError } from "./pi-model-catalog.mjs";` at the top. In `scripts/pi-bots/job_runner.mjs`, add the same two lines and the import right after its `const resolved = await resolveModel(def, { escalate: !!job.escalate });`. Read how `bot-world.mjs`'s caller handles a rejection before committing. If that path does not surface `err.message` to the operator as the reply, wrap the call site so it does.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/pi-model-catalog.test.js tests/pi-bots-instance-paths.test.js`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/pi-bots/pi-model-catalog.mjs tests/pi-model-catalog.test.js
git commit scripts/pi-bots/pi-model-catalog.mjs scripts/pi-bots/bot-world.mjs scripts/pi-bots/job_runner.mjs tests/pi-model-catalog.test.js -m "feat(pi-bots): fail a turn fast when pi cannot use the resolved model (M2) — async listing, shared in-flight, re-list on miss"
```

---

### Task 11: Bot Builder picker marks models pi cannot resolve (M3), without spawning pi

**Revision 2 (review C9).** `loadModelOptions` runs on every Bot Builder render and on every readiness checklist (`html.js:68`, `checklist.js:123`). It must never spawn pi inside the gateway. The marks come from pi's `models.json` via `piModelsFileKeys`: one file read, no spawn. On crow, pi lists only `models.json` providers and no built-ins (review Q8). On a host where pi has built-in providers, a built-in model would show as unmarked-unknown; that is acceptable for a hint.

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/data-queries.js` (`loadModelOptions`), `servers/gateway/dashboard/panels/bot-builder/editor.js` (`optGroups`), `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/bot-builder-model-marks.test.js`

**Interfaces:**
- Consumes: `piModelsFileKeys` (Task 10).
- Produces: `loadModelOptions(db, { piKeysFn }) -> { error, opts: Array<{ provider, key, label, piKnown: boolean|null }> }`. `piKnown` is `null` when the file is unreadable. i18n key `botbuilder.modelNotInEngine` (en: "not available to the bot engine", es: "no disponible para el motor de bots").

- [ ] **Step 1: Write the failing test.**

```js
// tests/bot-builder-model-marks.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModelOptions } from "../servers/gateway/dashboard/panels/bot-builder/data-queries.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const db = {
  execute: async () => ({ rows: [
    { id: "crow-chat", base_url: "http://x/llm/p/crow-chat/v1", models: JSON.stringify([{ id: "qwen3.6-35b-a3b" }]), disabled: 0 },
    { id: "Qwen Cloud", base_url: "https://y/v1", models: JSON.stringify([{ id: "qwen3.8-max" }]), disabled: 0 },
  ] }),
};

test("each option carries piKnown from pi's models.json (no spawn)", async () => {
  const { opts } = await loadModelOptions(db, { piKeysFn: () => new Set(["crow-chat/qwen3.6-35b-a3b"]) });
  const by = Object.fromEntries(opts.map((o) => [o.key, o.piKnown]));
  assert.equal(by["crow-chat/qwen3.6-35b-a3b"], true);
  assert.equal(by["Qwen Cloud/qwen3.8-max"], false);
});

test("an unreadable models.json leaves piKnown null (no false warnings)", async () => {
  const { opts } = await loadModelOptions(db, { piKeysFn: () => null });
  assert.ok(opts.every((o) => o.piKnown === null));
});

test("the mark string exists in en and es", () => {
  assert.equal(t("botbuilder.modelNotInEngine", "en"), "not available to the bot engine");
  assert.equal(t("botbuilder.modelNotInEngine", "es"), "no disponible para el motor de bots");
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test -- tests/bot-builder-model-marks.test.js`

- [ ] **Step 3: Implement.** In `data-queries.js`:

```js
import { piModelsFileKeys } from "../../../../../scripts/pi-bots/pi-model-catalog.mjs";

export async function loadModelOptions(db, { piKeysFn = () => piModelsFileKeys() } = {}) {
  try {
    const all = await listProvidersAll(db);
    const enabled = all.filter((p) => !p.disabled);
    let known = null;
    try { known = piKeysFn(); } catch { known = null; }
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

In `editor.js` `optGroups`, change the option label from `${escapeHtml(m.label)}` to `${escapeHtml(m.label)}${m.piKnown === false ? " (" + escapeHtml(t("botbuilder.modelNotInEngine", lang)) + ")" : ""}`. This is server-rendered HTML, not client JS. In `i18n.js`, beside the other `botbuilder.*` keys:

```js
  "botbuilder.modelNotInEngine": { en: "not available to the bot engine", es: "no disponible para el motor de bots" },
```

PR #400 also adds i18n keys near these. Rebase before pushing and keep both sets.

- [ ] **Step 4: Run, expect PASS**, plus `npm test -- tests/bot-builder-model-marks.test.js tests/i18n-global-parity.test.js` and every `tests/bot-builder*.test.js` (`ls tests | grep bot-builder`).

- [ ] **Step 5: Commit.**

```bash
git add tests/bot-builder-model-marks.test.js
git commit servers/gateway/dashboard/panels/bot-builder/data-queries.js servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/shared/i18n.js tests/bot-builder-model-marks.test.js -m "feat(bot-builder): mark picker models the bot engine cannot resolve (M3), from models.json — no pi spawn in the gateway"
```

---

### Task 12: pi-lab contract — `lib/local-models.mjs` gateway mode (handoff file)

Spec §5.3, D8. pi-lab owns `~/pi-lab`. This task writes a handoff file into pi-lab's inbox carrying the exact change below, and the pi-lab session lands it (the route that worked for #386 and the gufo evaluation). Crow's PR must not depend on it: compose entries keep working unchanged.

**Revision 2 (review suggestion 13).** The executor never edits or tests inside `~/pi-lab`'s working tree. Steps 1–4 run in a **scratch copy**: `SCR=$(mktemp -d) && rsync -a --exclude .git --exclude node_modules ~/pi-lab/ $SCR/pi-lab/ && ln -s ~/pi-lab/node_modules $SCR/pi-lab/node_modules`. Read every `~/pi-lab/…` path in Steps 1–4 as `$SCR/pi-lab/…`. Only Step 5's handoff file is written and committed in `~/pi-lab`.

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

- [ ] **Step 2: Run in the scratch copy, expect FAIL:** `cd $SCR/pi-lab && HOME=$SCR node lib/local-models-gateway.test.mjs` (fails at the first assertion: `isRunning` returns null for an entry without `url`).

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

- [ ] **Step 4: Run in the scratch copy:** `cd $SCR/pi-lab && HOME=$SCR node lib/local-models.test.mjs && HOME=$SCR node lib/local-models-gateway.test.mjs` → both pass. Then paste the final `lib/local-models.mjs` diff (`diff -u ~/pi-lab/lib/local-models.mjs $SCR/pi-lab/lib/local-models.mjs`) and the new test into the handoff.

- [ ] **Step 5: Write the handoff file** `~/pi-lab/docs/handoffs-inbox-<YYYY-MM-DD>-from-crow-models-gateway-contract.md` with: what shipped in crow (the door and its provider-scoped form `/llm/p/<provider>/v1`; the `X-Crow-Provider` header alternative; door addressing limited to loopback, tailnet or a bearer; the lifecycle API; the models token path; M1's `$crowManaged` entries for managed local rows). Include the known gap that `wouldEvict` sees only native resident siblings, so a resident bundle sibling is missing until its role moves native. Include the test and the `local-models.mjs` diff from Step 4 verbatim, and the **settings and models.json changes that happen later, per plan 4 window** (not now):

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

- [ ] **Step 1: Extend `docs/architecture/models.md`** with three sections, 4–8 sentences each, drawn from spec §5 and §11: *The door*:
- the real exposure: the gateway listens on all interfaces, so LAN + tailnet + loopback;
- the companion path and its unchanged exposure;
- the addressing order (provider path/header/qualified/bare/companion);
- the forwarding rules: managed rows only (native, external, bundle, `door_forward` opt-in); link-local and metadata targets refused; door addressing limited to loopback or tailnet sources, or a bearer; Funnel refused in-router;
- the forwarded endpoints, the one-hop guard, and `GET /llm/v1/models`.

*The lifecycle API*:
- routes, job states, `NOT_OWNER`/`EXTERNAL_ENGINE`, and the models token at `<CROW_HOME>/models-token`;
- **what the token does and does not gate:**
  - It does **not gate model start or evict.** The door and `/llm/acquire` start and evict from any loopback or tailnet source without it; it gates `stop`, job polling and the listing.
  - It is **not a bot boundary.** Bots run as the same uid and can read `~/.crow/models-token`, like every other token file, until S6 (#401's `pi_sandbox.mjs` note: bots can still read "anything the uid can read"). The bwrap sandbox has no network namespace, so a bot reaches `127.0.0.1:3001` as a trusted source anyway.
  - `door_forward: true` rides `gpu_policy` and syncs, so a paired peer can opt a row into forwarding. That is acceptable under the same-identity trust model, but write it down.

*pi's models.json*:
- `$crowManaged`;
- scope: managed local rows, plus allow-listed cloud rows;
- hand-written entries win;
- which host writes (only where pi is installed);
- the lost-update guard;
- the reconciler's and the seed's `skipped_managed`/`skipped_native`;
- the asynchronous pre-spawn check and its fail-open rule.

A paragraph on replication: the behind-marker (`__sync_behind_v1:<peer>`); that the catch-up reaches only the behind peer and that a re-delivery never overrides a newer local copy; and when it runs (boot, feed arming).
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

### Op 1: catch black-swan up (only if Task 1's diagnosis matched H1). Runs inside Op 3's registered window.

The behind-marker only exists for emits that parked after the fix shipped, so the 08-20 → today gap needs a seeded marker. **Seed 0** (review C2). crow's counter is floored by lamports it receives from peers, so a crow edit made after the stall can carry a lamport below black-swan's maximum. The table is about 32 rows, so re-delivering all of them is cheap and LWW-safe.

The catch-up runs only at a gateway boot, or when black-swan's feed arms in-process. black-swan's feed is already armed, so the seeded marker is consumed at **the next crow gateway restart**. *(Ruling, recorded.)* The restart is folded into Op 3's registered window. The alternative was a new authenticated "run catch-up" route; the restart adds no code and no auth surface, so it is smaller and safer. Op 3's row and deadman cover it.

Prerequisites, each needing Kevin's go:
- black-swan was updated from `249d5919` to `8ce478ba` on 2026-10-02 (`~/crow-weekend-push/reports/blackswan-update-report.md`). Neither build knows the `redelivery` flag, so it must be updated again, to a build that contains this PR. Otherwise any row it holds newer than crow's copy logs conflict rows when the catch-up arrives. Because of that update, Task 1's diagnosis must be run fresh, after it: a restarted black-swan gateway may itself have changed the picture.
- The live writes below (one `dashboard_settings` row on crow) and the crow gateway restart.

Inside the Op 3 window, after its preflight and deadman:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
BS_ID=$(sqlite3 -readonly ~/.crow/data/crow.db "SELECT id FROM crow_instances WHERE name LIKE '%swan%' AND status='active' LIMIT 1;")
cd ~/crow && CROW_DATA_DIR=/home/kh0pp/.crow/data node --input-type=module -e "
import { createDbClient } from './servers/db.js';
const db = createDbClient();
await db.execute({ sql: 'INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['__sync_behind_v1:$BS_ID', '0'] });
console.log('marker set to 0 for $BS_ID'); db.close();"
sudo systemctl restart crow-gateway
for i in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:3001/llm/health >/dev/null && break; sleep 2; done
sudo journalctl -u crow-gateway --since "-5 min" --no-pager | grep "providers catch-up for"
```

Verify within 15 minutes, read-only:
- `ssh black-swan 'sqlite3 -readonly ~/.crow/data/crow.db "SELECT id FROM providers WHERE id IN (\"crow-embed\",\"raven-flash-next\");"'` returns both ids;
- black-swan's `sync_conflicts` count did not grow;
- crow's marker row is gone.

If the rows did not arrive, stop and report with the journal lines. The restart is the same kind auto-update performs; the deadman restores nothing extra for it.

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
| **<date> (<day>) <HH:MM> → <HH:MM+45>, hard cap 60 min (deadman)** | **models plan 2 acceptance** (+ Op 1 if H1): door + lifecycle API on crow; starts ONLY the native qwen3.5-4b (:18100, ~3 GB, beside prod, evicts nothing) and stops it; one reservation-refusal check; with Op 1, one crow gateway restart (~30 s: bots, companion and Perch blink). Prod 35B/voice/embed untouched. | Claude session (crow) | curl against :3001 /llm and /llm/models with the models token; `box-reserve.mjs hold --allow qwen3.5-4b`; `sudo systemctl restart crow-gateway` (Op 1) | no native qwen3.5-4b running AND no box hold AND the deadman timer is gone AND the gateway answers /llm/health AND this row moved to Done |
```

Slot: a weekday between 09:00 and 16:30 (the Engram queue never runs Mon–Fri 07:00–17:00), outside 02:15–04:15, not overlapping any row in the table.

Deadman (armed BEFORE anything starts; out of process; stops the 4B and releases the hold at the cap):

```bash
# Absolute node path: nvm's node is not on the user manager's PATH (review C8).
# The token is read INSIDE the unit's shell, never placed on its command line
# (systemctl show / ps would reveal it).
systemd-run --user --unit=models-p2-accept-deadman --on-active=60min --collect /bin/sh -c \
  'curl -s -m 20 -X POST -H "authorization: Bearer $(cat /home/kh0pp/.crow/models-token)" http://127.0.0.1:3001/llm/models/qwen3.5-4b/stop; /home/kh0pp/.nvm/versions/node/v24.21.0/bin/node /home/kh0pp/crow/scripts/ops/box-reserve.mjs release'
TOKEN=$(cat ~/.crow/models-token)   # for the operator's own curls below only
```

Checks (each must pass; record outputs on the PR):

1. `node ~/crow/scripts/ops/box-reserve.mjs status` → `none`. Then `node ~/crow/scripts/ops/box-reserve.mjs hold --owner models-p2-accept --reason "plan 2 acceptance" --minutes 55 --allow qwen3.5-4b`. If Task 1 matched H1, run Op 1 now (it restarts the gateway; the hold file survives the restart).
2. Door, header addressing to a bundle row: `curl -s -m 60 http://127.0.0.1:3001/llm/v1/chat/completions -H 'content-type: application/json' -H 'X-Crow-Provider: crow-chat' -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"Say OK."}],"max_tokens":8}'` → a completion.
3. Door from raven (tailnet reach of `:3001`, tailnet source allowed): `ssh raven "curl -s -m 60 http://100.118.41.122:3001/llm/p/crow-chat/v1/chat/completions -H 'content-type: application/json' -d '{\"model\":\"qwen3.6-35b-a3b\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}],\"max_tokens\":8}' | head -c 300"` → a completion. Use the provider path: a bare id can be ambiguous (`qwen3-embedding-0.6b` is served by both `crow-embed` and `grackle-embed`) and answers `400 AMBIGUOUS_MODEL`, which is not a ufw symptom (review C8). Only a timeout means the ufw rule for `:3001` from raven is missing: stop and report (plan 4's W1 depends on it). `crow-embed` itself is an unmanaged row until W1 makes it native, so `/llm/p/crow-embed/v1` correctly answers `400 NOT_FORWARDABLE` today.
3b. Door from a LAN address is refused: `ssh raven "curl -s -o /dev/null -w '%{http_code}' http://10.0.0.237:3001/llm/p/crow-chat/v1/chat/completions -H 'content-type: application/json' -d '{\"model\":\"qwen3.6-35b-a3b\",\"messages\":[]}'"` prints `403`. Hitting crow's LAN IP gives raven a 10.0.0.x source. Magpie is outbound-only, so a crow session cannot run the check there. The same request to `/llm/acquire` with `{\"provider\":\"crow-chat\"}` also prints `403`.
4. Provider-scoped path: the same request to `http://127.0.0.1:3001/llm/p/crow-chat/v1/chat/completions` without the header → a completion from the 35B (check the gateway log line `door chat/completions -> crow-chat/…`). Cloud refusal: `-H 'X-Crow-Provider: qwen-cloud'` → HTTP 400 `NOT_FORWARDABLE`.
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
- §11.7 I5 → Task 2. §11.3 external interim → Op 2. §8 error codes: `AMBIGUOUS_MODEL`, `NOT_FORWARDABLE`, `FORBIDDEN_TARGET`, `DOOR_SOURCE_REFUSED`, `FUNNEL_REFUSED`, `DOOR_LOOP`, `MODEL_NOT_SERVED`, `UNKNOWN_PROVIDER`, `NOT_OWNER`, `EXTERNAL_ENGINE`, `UNAUTHENTICATED`, `PI_MODEL_UNAVAILABLE`.
- §9 tests named in the spec and covered here: `/llm/v1` qualified and bare addressing, ambiguity, companion unchanged, 409 while reserved (Task 4 maps `ReservedError` to 409 on the door path, matching `/llm/acquire`); lifecycle auth, job states, stop, `NOT_OWNER`, status shape; two-instance sync of a disable and a conversion.
- Deliberately not here: panels (plan 3), runtimes and gufo (plan 3), any conversion or window that moves a role (plan 4).
- Names used across tasks: `resolveDoorTarget`, `listDoorModels`, `doorKindOf`, `isDoorUrl`, `providerDoorUrl`, `DOOR_PROVIDER_HEADER`, `DOOR_HOP_HEADER`, `createJobStore`, `buildModelsListing`, `JOB_STATES`, `stopNativeProvider`, `nativeSnapshot`, `mutexSiblingsOf`, `ensureModelsToken`, `validateModelsToken`, `modelsTokenPath`, `buildManagedEntries`, `mergeManaged`, `syncPiModelsJson`, `piModelsSyncPath`, `CROW_MANAGED_KEY`, `setProviderChangeHook`, `listPiModels`, `checkPiModel`, `parsePiListModels`, `invalidatePiModelCache`, `PiModelUnavailableError`, `BEHIND_FLAG_PREFIX`, `catchUpBehindPeers`, `_markPeerBehind`. Checked consistent.
- Placeholder scan: Task 1's fix is conditional on the diagnosis by design (H2–H4 stop and report, because their fix depends on evidence this plan cannot know); every other step has code or an exact command.

---

## Revision 2 (2026-10-02): what changed after the staff review

| review item | change |
|---|---|
| C1 diagnosis | Task 1 Step 1 now reads crow's out-feed length (from a copy), black-swan's in-feed length and applied seq, outbox depth/`delivered_json`, `parkedPeers=` drain lines, dial/handshake logs on both ends, and both `gateway_url`s. New **H5 transport** row (stop and report). H1 requires O = I = A, P > L, and parking evidence. No fix without that. |
| C2 Op 1 | Seed **0**. The catch-up is triggered by a crow gateway restart **inside Op 3's registered window**, which was ruled smaller and safer than a new authenticated trigger route. black-swan is updated first. |
| C3 catch-up | Appends only to the behind peer (`_signedRedelivery` + direct append inside `_chainAppendTask`); rows are read inside the chain; compare-and-delete marker; revoked/paused peers skipped; the receiver skips a re-delivery not newer than its copy (flag outside the signed payload, so older peers still verify). Tests for lamport 9000 vs 50, behind-peer-only, the racing lower mark, a racing live upsert, a revoked peer. |
| C4 door security | Managed rows only (native/external/bundle/`door_forward` opt-in); no `local` catch-all; link-local, metadata and Tailscale-own addresses refused; non-companion addressing requires a loopback/tailnet source or a bearer; `/llm` and `/llm/models` refuse Funnel in-router; `auth-network.test.js` assertions added; `isPrivateHost` not used. |
| C5 token anchor | Its own block mirroring the board token (own DB client), outside the phone branch; boot-wiring test. |
| C6 cause / null | The orchestrator attaches `stderrTail` to the start error before removing the handle; the route reads it (non-vacuous test). A non-`true` acquire result is `failed`. |
| C7 seed | `seedProvidersFromModelsJson` skips `$crowManaged` ids, with a test. |
| C8 Op 3 | Provider-path checks (no bare-id ambiguity); a LAN-refusal check; the deadman uses the absolute node path and reads the token inside its shell. |
| C9 pi spawns | M2 uses async `execFile` with a shared in-flight promise; M3 reads `models.json` and never spawns pi in the gateway. |

**Suggestions taken:**
- **1.** The trivial test is replaced: the catch-up now re-checks `shouldSyncRow` itself.
- **2.** Behind-peer and concurrency tests added.
- **3.** M1 drops embed/rerank models and unmanaged alias rows.
- **4.** M1 builds a native row's pi URL from the door base. Native rows also store `/llm/p/<id>/v1`.
- **5.** Lost-update guard; writer only in the authenticated branch and only where pi is installed.
- **6.** An hourly M1 run covers replicated changes.
- **7.** The M2 doc comment is corrected.
- **8.** The lifecycle router mounts in its own try/catch.
- **9.** Stop runs through `_swapInFlight`. The liveness marker is already written by `onTerminal`.
- **11.** Door 409 parity tests for reserved and serving-class refusals.
- **12.** The stream resolves on `close`.
- **13.** pi-lab is prototyped in a scratch copy; handoff only.
- **14 and 15.** Documented in Task 13.

**Suggestions not taken:**
- **10.** Bundle siblings in `wouldEvict`: documented as a known gap in Task 7 and the handoff.
- **9 (part):** whether idle-revert may re-warm a stopped `defaultMember` is left unchanged and noted.

**Open for Kevin (from the review):**
- M1 cloud scope (allowlist by default here).
- Whether the LAN exposure of `:3001` is deliberate.
- Tailnet membership: shared nodes and the Dayane container.
- Whether the models token is worth its surface.
- Whether the catch-up should go beyond providers. If yes, the ramble origin re-attribution hazard applies.
- Whether a transport fix (H5) belongs in plan 2.
- M2's reliance on `pi --list-models`.

