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

Any other stored value is **invalid**. Known invalid values:
- `'raven'`, set by hand;
- grackle's `grackle-5fc01ac74463b6f4` label;
- `'external'`, written by `routes/models.js:759` for the local-only Hugging Face token row. This PR changes that writer to `cloud`.

See §3.4.

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

### 3.3 Readers: `host` stops deciding what a machine may start (revised after plan review round 1)

`gpu-orchestrator.js:574` (`maybeAcquireLocalProvider`) and `:619` (`resolveWarmableProviderName`) currently refuse every row whose `host` is not the literal `local`. They change to refuse **only a foreign instance id**: `isInstanceIdShape(host) && host !== ownInstanceId`.

- `local`, `cloud` and invalid labels all fall through to the existing address, owner and native checks. Those checks already decide locality (`locality.js`: `host` "cannot be used").
- Consequence: **a wrong `host` value can no longer make a box refuse its own models**, whether it comes from repair, a seed during the Tailscale boot race, or an old value left over from the sync war.
- `host` becomes descriptive (display, vendor bucket) plus one real veto: "this belongs to that other instance".
- Nothing becomes *more* startable than the address rule allows:
  - a `cloud` row still needs a bundle or native runtime **and** an own address or owner match;
  - a public API row has neither.
- Side effects:
  - The latent own-id reader bug in §1 is fixed, since an own id is not foreign.
  - grackle's own `grackle-*` rows, labelled `grackle-5fc01ac74463b6f4`, stop being refused on grackle.
- Implemented as `isForeignInstanceHost(host, ownInstanceId)` in `provider-host.js`. The own instance id is read **lazily**, only when the host has instance-id shape (orchestrator "Ruling 3" comment, `gpu-orchestrator.js:350`).

### 3.4 One-time repair of rows this instance wrote wrongly

A repair pass runs inside the existing hourly reconciler, after the models.json loop, over `listProvidersAll`. It is idempotent.

**Scope (revised after plan review round 1):** repair considers only rows that meet all of these:
- `bundle_id IS NULL`;
- no `gpu_policy.owner`;
- not `gpu_policy.local_only`;
- `disabled = 0`.

The reason is that bundle and native rows take `host` from manifests and registration, never from inference. The review also showed D3's premise fails for them: `upsertProvider`, `disableProvider`, the dashboard enable and `reenableProviderPreservingContent` all re-stamp `instance_id` **without touching `host`**. Live on crow and on grackle, crow's own bundle rows `crow-chat`, `crow-voice` and `crow-swap-agentic` carry grackle's `instance_id` from the old sync war. Unscoped, grackle would repair them to `cloud`.

**Rewrite rule:** within that scope, a row is rewritten to `inferHost(base_url, null, {ownAddrs})` **only when all three conditions hold:**
1. **This instance was the last writer:** `row.instance_id === ownInstanceId`.
2. The stored `host` is either:
   - (a) invalid (§3.1), or
   - (b) `local`, but the row's hostname is **not** in `ownAddrs`.
3. The recomputed value differs from the stored one. Anything else would be a no-op, so no emit.

**Two guards, because repair WRITES** (mine, §4 D7). The reconciler's `assert` gate tolerates an incomplete own-address set because being unsure only makes it *skip*. Repair is a write, and a false "not mine" would flip this machine's own rows `local`→`cloud`. `maybeAcquireLocalProvider` would then refuse them, and nothing flips a bundle-manifest row back.

- **G1: judge an address only against a network this machine is on right now.** Skip the whole repair pass when `ownAddrs` holds no non-loopback address. Otherwise, **any repair whose result would be `cloud`, whether from condition 2(a) or 2(b),** is allowed only when the target is an IP literal and `ownAddrs` currently holds at least one non-loopback address of the **same class** as the target:

  | target class | ranges |
  |---|---|
  | CGNAT / Tailscale | `100.64/10` |
  | RFC1918 | `10/8`, `172.16/12`, `192.168/16` |
  | ULA | `fc00::/7` |
  | public v4 or v6 | anything else routable |

  Link-local targets are never judged.

  This covers the boot race where Tailscale comes up after the gateway: with no live `100.64/10` address, a `100.x` target is skipped rather than wrongly declared foreign. The next hourly run retries.

  (A recorded-`tailscale_ip` check was considered and rejected: `crow_instances.tailscale_ip` is empty for every instance, verified 2026-09-22.)
- **G2: `local`→`cloud` only for IP-literal hostnames.** Condition 2(b) applies only when the base-URL hostname is an IPv4 or IPv6 literal.
  - A DNS name (`crow.dachshund-chromatic.ts.net`, `raven`) cannot be judged against an address set, so a `local` row naming a host is left alone.
  - Condition 2(a), an invalid value, recomputes only when the result is `local`, or when the result is `cloud` and the target is an IP literal that passes G1. An invalid label on a DNS-name row is left for the operator.

**Why only this instance's own writes (mine, §4 D3):** it makes repair nearly single-writer.
- "Last writer" is only a proxy for "author of the host claim". The scope restriction above removes the rows where the two are known to differ.
- When copies of a row diverge, each instance can be the last writer of its own copy: r4 and crow each last-wrote their own raven rows. That is safe because every writer computes the same value from the same address.
- Any residual mistake now costs only display, because of §3.3.
- A `local` written by another instance is that instance's own claim. It is correct from its own side, or it is that instance's job to fix. Overwriting it would restart the war: the owner re-asserts `local` every hour, and we rewrite it to `cloud` again.

**The instance-id check for (a) is by shape, not by the `crow_instances` table.** A value counts as an instance id when it is a 32-character lowercase hex string, which is what `generateInstanceId` produces. `grackle-5fc01ac74463b6f4` is therefore invalid, and correctly so.

Reason (mine, §4 D4): the instances table differs across the fleet (MPA is still `active` on crow a month after it was retired). A set lookup would make "invalid" depend on the host, and the repair would then disagree across instances.

**On crow today this rewrites exactly two rows**, both last written by crow:

| row | before | after |
|---|---|---|
| `raven-halogen-smoke` | `local` | `cloud` |
| `raven-flash-next` | `raven` (invalid) | `cloud` |

**grackle's copies:** grackle holds `raven-flash-next` as `host='local'`, written by crow. It was offline for the 09-10 manual fix and later for five days. That copy is repaired by crow's emit once it syncs, not by grackle, under D3.

It touches nothing else **on crow**.

**grackle's `grackle-*` rows are bundle rows, so they are out of repair scope.** They still change, but through grackle's own reconciler rather than through repair. grackle's models.json declares them with the label and they are owned there, so its hourly **assert** now runs `inferHost(p.baseUrl, "grackle-5fc01…")`: the invalid label falls through to `local`, and that syncs fleet-wide. The copies on crow and r4 were written at lower lamports, which may log a one-time conflict burst. Verified in plan review round 2.

Behaviour change on grackle: with D9, `grackle-rerank` and `grackle-vision` (mutexGroup `grackle-specialists-swap`) become swappable on demand, since `maybeAcquireLocalProvider` no longer returns null for them. Also, r4's `CROW_EMBED_PROVIDER=grackle-embed` row now displays `local`, which is display only. grackle is being decommissioned anyway.

r4 was also the last writer of its own copies of both raven rows, so r4 repairs those two as well.

The plan must verify these claims (2 rows on crow, 2 on r4, 0 on grackle) against copies of the live DBs before any deploy.

(Kevin, 2026-09-22: grackle is to be **decommissioned and sold**, which is its own queue item. The grackle rows then become moot, but the rule stays correct for any instance.)

### 3.5 Display: say where it actually is

- `providers-tab.js` `hostBadge` gains an address-derived label. The stored value stays as it is; only the label changes.
  - A `cloud` row whose hostname is private (RFC1918, CGNAT `100.64/10`, link-local, `.local`, `*.ts.net`) shows **"network"**. A public one shows "cloud · <type>" as today.
  - A `local` row shows **"this machine"** only when its hostname is in the viewer's `ownAddrs`, or when it has no base URL. Otherwise it shows "network" for a private hostname, which fixes crow's `crow-chat` reading "local" on grackle, and "cloud" for a public one.
  - Example of the public case: r4's `zai-coding` row carries `host='local'` with `https://api.z.ai/...`, a relic of the first-boot seed bug. G2 leaves the stored value alone because the target is a DNS name, and the label shows "cloud".
  - Instance-id rows show the instance's `name` when `crow_instances` has it, and otherwise the truncated id, as today.
- The private-address classifier is a small pure helper (`isPrivateHost`) in `locality.js`. It is used **only for display**, never for any routing or starting decision. The docstring must say so; mixing up display and ownership is the original bug.

### 3.6 Docs

- Update the `host` invariant comment in `providers-db.js`: the three meanings from §3.1, "inference never writes instance ids", and "readers veto only a foreign instance id (`isForeignInstanceHost`); locality comes from the address and owner checks". Keep the existing paragraph about cloud rows versus bundle rows (`bundle_id`/`provider_type`).
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
- **D9 (after plan review):** `host` stops being an orchestration gate except for the foreign-instance-id veto (§3.3). This is what makes every remaining inference imperfection harmless, and it is the decision that makes the rest safe:
  - own `100.x` rows seeded as `cloud` during a Tailscale boot race;
  - the seed-insert race, where two non-owners compute different hosts;
  - rows written through `upsertProvider`'s missing-host fallback.
  All three are **accepted as display-only**.
- **D7:** the two repair guards, G1 (interfaces settled) and G2 (IP literals only for `local`→`cloud`), come from asymmetric risk. A missed repair costs one more hour of a wrong badge. A false repair makes crow refuse its own models.
- **D8:** `inferHost` keeps treating a DNS-name base URL as `cloud`, unchanged from today. Only addresses are compared, which matches `isLocallyOrchestratable`. A row naming this machine by DNS name must set `host` explicitly, as rows already do.
- **D6 (not done):** instances will not advertise their LAN addresses so viewers could map endpoints to peers. Nothing needs it until raven pairs, and even then §3.5 display plus D2 are enough. Revisit in the raven-pairing item only if a concrete need shows up.

## 4.1 Accepted limitations

- **Tailscale boot race on write-time inference.** Seeds and fallback writes during that window can store `cloud` for this machine's own `100.x` endpoint. The effect is display only (D9). models.json rows heal on the owner's next assert.
- **Seed-insert race.** Two instances seeding the same absent id at once can store different hosts and log one insert conflict. This is bounded, and display only.
- **Residual D3 hole.** A peer that disables, enables or force-reenables a *non-bundle* row re-stamps its `instance_id` without touching `host`. That peer then counts as the last writer, and may repair the owner's row to `cloud`. It heals only if the entry is in the owner's models.json. The effect is display only under D9.
- **G1 is class-coarse.** crow also has `thunderbolt0 10.99.0.1`, so while eno1 is still coming up, a `10.0.0.x` target is still judged. Matching the target against an own interface's subnet would be tighter. Not done: the effect is display only.
- **Messages picker.** `messages/client.js:416` appends " (cloud)" to `host==='cloud'` rows, so the raven rows will now read "(cloud)" there. This is accepted.

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
- **Unit, `isForeignInstanceHost`:** `local`, `cloud`, an invalid label and null are all not foreign. The own id is not foreign. A different 32-hex id is foreign. The own id is read lazily, only for id-shaped hosts.
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
- **Live-data dry run (plan task):** run the repair decision read-only against copies of crow's, r4's and grackle's `crow.db`. Record every row it would touch; the expectation is 2 on crow, 2 on r4, 0 on grackle.
- **Full suite:** via `scripts/run-suite.mjs` (Node 22), plus `tests/auth-network.test.js`, which is untouched but cheap to include.

## 7. Rollout

- Ships as one PR. CI must be green, with check-runs verified.
- Merge only in a free CROW-SCHEDULE slot. Auto-update restarts the crow and r4 gateways.
- After deploy, check live:
  - Within one reconcile tick (hourly, or force it through the dashboard "Sync bundle providers" button), crow shows `raven-flash-next` / `raven-halogen-smoke` as `cloud`, badged "network".
  - The rows' lamport clocks do not keep rising (sample twice, one hour apart).
  - `sync_conflicts` gains no recurring `providers` rows.
  - grackle's badges read "this machine" for its own rows and "network" for crow's.
