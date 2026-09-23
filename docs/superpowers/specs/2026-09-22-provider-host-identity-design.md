# Provider host identity: honest `host` inference and repair

**Status:** design, 2026-09-22. Sub-project 1 of the Crow-side Strix Halo track (Gitea `crow-engineering` `backlog/2026-09-22-crow-improvement-queue.md` §2).

**Decisions:** Kevin decided the direction and the questions listed under "Kevin's decisions" below. Everything else was decided by me (the crow session) under his standing autonomy grant of 2026-09-22 and is marked as mine.

**Prerequisite for:**
- sub-project 2 (`serving.class`);
- sub-project 3 (the Strix Halo runtime profile);
- sub-project 4 (the external-engine provider kind);
- the queued item to pair raven as a Crow instance.

## 1. Problem

The `providers.host` column is supposed to hold one of three values (`servers/shared/providers-db.js` header):

| value | meaning |
|---|---|
| `local` | the writing instance's own machine |
| `<instance-id>` | a paired Crow instance |
| `cloud` | not on this machine: call `base_url` directly |

Three defects break it, and all are live on crow today.

1. **`inferHost` calls every private address `local`** (`providers-db.js:50`).
   - It treats `10.*`, `192.168.*` and all of `100.*` as local. `100.*` is the whole Tailscale CGNAT range, so every other lab box counts as "this machine" too.
   - It runs whenever the hourly reconciler seeds a models.json id the DB does not have yet (`syncProvidersFromModelsJson` → `reconcileDecision` → `seed`).
   - **Live evidence:** `raven-halogen-smoke` → `http://10.0.0.126:8731/v1` has `host='local'`, last written by crow (`instance_id = 0867ac28…`). `raven-flash-next` was written the same way on 2026-09-10. It was then corrected by hand to `host='raven'`, which none of the three allowed values covers.
2. **The first-boot seed never infers at all.** `seedProvidersFromModelsJson` writes `p.host || "local"` (`providers-db.js:97`), so on a fresh install every models.json entry is `local`, cloud APIs included.
3. **`upsertProvider` fills a missing host with `local`** (`providers-db.js:248`, `:282`, `:298`). Any caller that forgets the field produces the same bad value.

A second invalid value is live fleet-wide:
- grackle's `grackle-embed` / `grackle-rerank` / `grackle-vision` rows carry `host='grackle-5fc01ac74463b6f4'`.
- That string is **not** grackle's instance id, which is `49cf71ca878643ba7717f344329266fd`. It is a hand-written label in grackle's own untracked `~/crow/config/models.json` (verified 2026-09-22).
- grackle is the last writer of all three rows.

**Reader side (latent):** `gpu-orchestrator.js:574` (`maybeAcquireLocalProvider`) and `:619` (`resolveWarmableProviderName`) test `host !== "local"`, so a row whose `host` is the *reader's own* instance id counts as foreign.
- No live row hits this today.
- But `registerProviderFromManifest` writes `manifest.host` verbatim (`providers-db.js:383`), and the cross-host bundle path uses instance ids for that field. So an instance can hold a row carrying its own id.

**Why this matters now:** raven is a second production host. Kevin has decided it will become a paired Crow instance, which is queued. Every later sub-project asks "which machine serves this endpoint?", and today the answer is wrong for every LAN or tailnet box.

## 2. Constraints that shape the design

- **`host` rides the sync wire.** It is not in `EXCLUDED_COLUMNS.providers`, so the lamport winner imposes its value on every peer. `instance_id` on a row is the **last writer**: `upsertProvider` stamps the local id, and sync apply preserves the origin's.
- **Co-owners exist.** crow and r4 share one machine and therefore one own-address set. Loopback is in every instance's own-address set.
- **The owner-asserts reconciler re-asserts owned rows every hour.** `assert` compares the full write image, `host` included, before writing (D2 no-op suppression). So if two instances compute *different* `host` values for the same row, the result is an endless sync war: the 211-conflict class, `providers-war-sim.test.js`.
- **Locality decisions already come from addresses, not from `host`.** `locality.js` says outright that `host` "cannot be used" for that. `isLocallyOrchestratable` checks the base-URL host against the machine's own addresses. `isOrchestratableHere` prefers `gpu_policy.owner` for native rows. This design leaves both untouched.

## 3. Design

### 3.1 Canonical meaning of `host` (unchanged set, sharper definitions)

| value | meaning | who writes it |
|---|---|---|
| `local` | The endpoint is on the writer's own machine: loopback or one of its interface addresses. It means the same thing to every co-owner, and that neutrality is why it exists (§2 war constraint). **Readers must never treat it as proof of locality**; they keep using the address checks. | inference, `manager.js` native registration |
| `<instance-id>` | The endpoint is served by that paired Crow instance. | explicit writers only: bundle manifests' `host`, operator edits, existing rows. **Inference never writes an instance id** (mine, §4 D2). |
| `cloud` | Crow does not manage this endpoint from here; call `base_url` directly. This covers public APIs **and unmanaged network machines such as raven today** (Kevin's decision). | inference, dashboard add form, migrations |

Any other stored value is **invalid**; `'raven'` is the only one known. See §3.4.

### 3.2 `inferHost` (pure)

```
inferHost(baseUrl, existingHost, { ownAddrs }) →
  existingHost is a valid value     → existingHost        (unchanged short-circuit)
  no baseUrl / unparseable          → "local"             (unchanged: an endpoint-less row is ours)
  hostname ∈ ownAddrs (incl. loopback, [::1] unbracketed) → "local"
  otherwise                         → "cloud"
```

- It **no longer pattern-matches private ranges.** The fix is the rule "is this one of my addresses?". `getOwnAddresses` is already imported in the same file.
- `existingHost` counts as valid only if it is `local`, `cloud`, or a string that looks like an instance id. See §3.4 for the check. An invalid `existingHost` falls through to inference.
- `ownAddrs` is injected. Callers pass `getOwnAddresses()` fresh each time, following the reconciler's existing rule of never caching it at module level.

**Callers:**
- the reconciler (`seed` and `assert`);
- `seedProvidersFromModelsJson`, which is defect 2 and now calls `inferHost` instead of `p.host || "local"`;
- `upsertProvider`'s missing-host fallback (defect 3): `provider.host || inferHost(baseUrl, null, …)`.

### 3.3 Readers: `isSelfHost` (pure)

A new `isSelfHost(host, ownInstanceId)` returns true for `local` and for the reader's own instance id.
- `gpu-orchestrator.js:574` and `:619` switch to it, which closes the latent reader bug in §1.
- The address, owner and native checks that come after it are unchanged, so no row becomes *more* startable than the address rule allows.
- Behaviour changes only for a row whose `host` is the reader's own id **and** whose address or owner already passes. That is exactly the latent bug.

### 3.4 One-time repair of rows this instance wrote wrongly

A repair pass runs inside the existing hourly reconciler, after the models.json loop, over `listProvidersAll`. It is idempotent.

**Rewrite rule:** a row is rewritten to `inferHost(base_url, null, {ownAddrs})` **only when all three conditions hold:**
1. **This instance was the last writer:** `row.instance_id === ownInstanceId`.
2. The stored `host` is either:
   - (a) invalid (§3.1), or
   - (b) `local`, but the row's hostname is **not** in `ownAddrs`.
3. The recomputed value differs from the stored one. Anything else would be a no-op, so no emit.

**Why only this instance's own writes (mine, §4 D3):** it makes repair single-writer by construction.
- A `local` written by another instance is that instance's own claim. It is correct from its own side, or it is that instance's job to fix. Overwriting it would restart the war: the owner re-asserts `local` every hour, and we rewrite it to `cloud` again.
- Rule 1 guarantees two instances never repair the same row to different values, because at most one of them is the last writer.

**The instance-id check for (a) is by shape, not by the `crow_instances` table.** A value counts as an instance id when it is a 32-character lowercase hex string, which is what `generateInstanceId` produces. `grackle-5fc01ac74463b6f4` is therefore invalid, and correctly so.

Reason (mine, §4 D4): the instances table differs across the fleet (MPA is still `active` on crow a month after it was retired). A set lookup would make "invalid" depend on the host, and the repair would then disagree across instances.

**On crow today this rewrites exactly two rows**, both last written by crow:

| row | before | after |
|---|---|---|
| `raven-halogen-smoke` | `local` | `cloud` |
| `raven-flash-next` | `raven` (invalid) | `cloud` |

It touches nothing else **on crow**.

**grackle rewrites its own three `grackle-*` rows** from the invalid label to `local`, because their endpoint is grackle's own address. Those rows then sync to the fleet as `local`, and viewers show them as "network" (§3.5).

This does not start a war:
- grackle's hourly `assert` for those ids goes through `inferHost(p.baseUrl, p.host)`, and the invalid file value falls through to the same `local`;
- every other instance holding those rows reaches `skip_unowned`.

The grackle-local `config/models.json` label is left as it is: inference overrides it. Deleting it is optional operator cleanup, not a code change.

The plan must verify both claims (2 rows on crow, 3 on grackle, 0 on r4) against copies of the live DBs before any deploy.

### 3.5 Display: say where it actually is

- `providers-tab.js` `hostBadge` gains an address-derived label. The stored value stays as it is; only the label changes.
  - A `cloud` row whose hostname is private (RFC1918, CGNAT `100.64/10`, link-local, `.local`, `*.ts.net`) shows **"network"**. A public one shows "cloud · <type>" as today.
  - A `local` row shows **"this machine"** only when its hostname is in the viewer's `ownAddrs`. Otherwise it shows "network", which fixes crow's `crow-chat` reading "local" on grackle.
  - Instance-id rows show the instance's `name` when `crow_instances` has it, and otherwise the truncated id, as today.
- The private-address classifier is a small pure helper (`isPrivateHost`) in `locality.js`. It is used **only for display**, never for any routing or starting decision. The docstring must say so; mixing up display and ownership is the original bug.

### 3.6 Docs

- Update the `host` invariant comment in `providers-db.js`: the three meanings from §3.1, "inference never writes instance ids", and "readers use `isSelfHost` plus address checks".
- **Two-host spec §3.1** (PR #344): the "Set `host = 'raven'`" instruction is superseded. Unmanaged network endpoints are `cloud`. Add a one-line pointer to this spec.

## 4. Decisions (all mine unless marked Kevin's)

- **D1 (Kevin):** raven-like unmanaged machines are stored as `cloud` and shown as "network". There is no new stored value, and so no schema change and no sync-wire change.
- **D2:** inference never writes an instance id.
  - Two instances looking at the same peer endpoint would disagree: the peer computes `local`, a viewer would compute `<peer-id>`. That is the war.
  - When raven becomes an instance, its own rows arrive as `local` from raven, and viewers show them correctly through §3.5.
  - An explicit id (a manifest, an operator edit) stays allowed.
- **D3:** repair rewrites only rows this instance wrote last (§3.4).
- **D4:** instance-id validity is judged by shape, not by a fleet-divergent table.
- **D5:** there is no migration and no `SCHEMA_GENERATION` bump. Repair is data, run by the existing reconciler, and fully idempotent.
- **D6 (not done):** instances will not advertise their LAN addresses so viewers could map endpoints to peers. Nothing needs it until raven pairs, and even then §3.5 display plus D2 are enough. Revisit in the raven-pairing item only if a concrete need shows up.

## 5. Out of scope

- `serving.class`, gates, host-aware eviction (sub-project 2).
- The external-engine provider kind and health (sub-project 4).
- Bundle-manifest `host` semantics (`routes/bundles.js`), which is a separate cross-host proxy concept and stays untouched.
- `gpu_policy.owner` and the native-row rules.
- Pairing raven.

## 6. Testing

- **Unit, `inferHost`:**
  - loopback v4 and v6, and bracketed `[::1]`;
  - own interface address;
  - a foreign address in `10.`, `192.168.` and `100.`, which must now be `cloud` (these are the regression cases);
  - public;
  - unparseable;
  - no baseUrl;
  - a valid `existingHost` short-circuits;
  - an invalid `existingHost` (`raven`) falls through.
- **Unit, `isSelfHost`:** `local`, own id, a foreign id, `cloud`, null.
- **Unit, repair decision** as a pure function over (row, ownId, ownAddrs): the full matrix of the §3.4 conditions, including "another instance wrote it" → never.
- **Orchestrator:** extend `gpu-orchestrator-host-gate.test.js`.
  - A bundle row whose `host` is the reader's own id and whose address is own is now acquirable.
  - The same row with a foreign address is still refused, which proves the address gate still binds.
- **Seed:** a fresh DB seeded from a models.json holding a cloud entry, a foreign-LAN entry and a loopback entry comes out as `cloud` / `cloud` / `local`.
- **Multi-instance, MUTUAL case**, which is required by the sync-layer lesson (memory `crow-item-2a-prune-design`). Use the existing war-sim harness (`tests/providers-war-sim.test.js`):
  - two instances hold the same row;
  - A wrote the bad `local` last;
  - both run reconcile and repair repeatedly;
  - the row converges to `cloud` on both;
  - the conflict count stops growing;
  - the lamport clock stops advancing after convergence.
  - A second arm: B is the endpoint's owner and asserts `local`, and A never rewrites B's write.
  - Each test must be shown to fail against the pre-change code (red before green).
- **Live-data dry run (plan task):** run the repair decision read-only against copies of crow's, r4's and grackle's `crow.db`. Record every row it would touch; the expectation is 2 on crow, 3 on grackle, 0 on r4.
- **Full suite:** via `scripts/run-suite.mjs` (Node 22), plus `tests/auth-network.test.js`, which is untouched but cheap to include.

## 7. Rollout

- Ships as one PR. CI must be green, with check-runs verified.
- Merge only in a free CROW-SCHEDULE slot. Auto-update restarts the crow and r4 gateways.
- After deploy, check live:
  - Within one reconcile tick (hourly, or force it through the dashboard "Sync bundle providers" button), crow shows `raven-flash-next` / `raven-halogen-smoke` as `cloud`, badged "network".
  - The rows' lamport clocks do not keep rising (sample twice, one hour apart).
  - `sync_conflicts` gains no recurring `providers` rows.
  - grackle's badges read "this machine" for its own rows and "network" for crow's.
