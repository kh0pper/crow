# Spec: two-host production, and heavy-model modes on top of it

Status: draft for review. Author: `~/r4-tehcy` session, 2026-09-09 evening, from Kevin's direction across
three sessions (`~/r4-tehcy`, `pi-lab-36`, `crow-34`).
Implementation owner: crow (format, orchestrator routing, catalog). Harness changes: pi-lab. First consumer: R4.

## 1. The configuration Kevin chose

Verbatim: run the normal production bots on crow, run Qwen3.8-Flash-Next at 1M on raven as normal production,
with the option to evict production on both boxes to run either GLM or DSv4. That is the standard configuration.

So there are three states, and only three:

| state | crow | raven |
|---|---|---|
| **standard** | prod bots (35b, vLLM 4b, embed, gemma) | Flash-Next Q4_K_XL @1M |
| **heavy: GLM** | evicted | evicted, GLM-5.3-Flash two-box master |
| **heavy: DSv4** | evicted, RPC worker | evicted, DSv4-Flash two-box master |

The standard state is the important one: both a fast runner and a 1M-context model are available at the same
time, because they sit on different boxes. No eviction, no RPC, no shared GPU.

## 2. Why this works, with the numbers

Per-box GTT is 124 GiB on both machines. Measured, from
`docs/research/2026-08-30-second-strix-halo-box-plan.md` and the serving doc
`~/pi-lab/docs/research/2026-09-09-heavy-model-serving-configs.md`:

- **Flash-Next Q4_K_XL fits 1M on one box.** Body 76.8 GiB plus 26.9 GiB lazy PLE, about 106 GiB resident at 1M,
  leaving **17.7 GiB free on raven**. Rungs measured on raven: 262k leaves 31.0 GiB free, 524k 23.4, 1M 17.7.
- **Single-box beats two-box for this model.** Raven single-box at 120 W measures 354 / 24.7 short and
  234 / 18.4 at depth, ahead of the two-box split on both prefill and decode (§7.16). Two-box earns its keep only
  as headroom for the Q5 quant or to host the MTP head on the master. So the 1M production config needs one box,
  which is what leaves crow untouched.
- **Flash-Next single-box has never wedged.** All three GPU wedges were DSv4 two-box at 86 to 91 GiB per box,
  confirmed against CROW-SCHEDULE's own incident rows, which name DSv4 and dspark and never Flash-Next or GLM.
- **Crow prod is 61 to 62 GiB of GTT**, measured two ways. A live read gives 60.5 GiB; two independent window
  teardowns gave MemAvailable swings of 64 and 61 GiB on evicting all four containers, with 17 MiB of GTT residue
  left behind. Of that, the vLLM 4b is 15.2 GiB by KFD accounting, which puts **the 35b at roughly 43 GiB** by
  subtraction. Cross-checked from the other direction: its weights are 27.16 GB plus a 0.9 GB mmproj, about
  26.1 GiB, and at `-c 262144` another ~17 GiB of KV and compute buffers is plausible. The Vulkan containers do not
  appear in ROCm accounting at all, so 43 GiB is a **bound rather than an isolated measurement**, and every gate in
  this spec treats it as one.
- **GLM and DSv4 cannot join the standard state.** Their weights exceed one box at every usable quant
  (GLM IQ4_XS 146 GiB, DSv4 IQ4_XS 128 GiB against 124 GiB MemTotal), so they are structurally two-box, and the
  second box is crow. A crow-side worker share of 46 to 56 GiB does not fit beside a 43 GiB 35b plus the rest of
  prod, and the splits that would make it fit (about 0.73/0.27 toward raven) are untested and put raven at its
  ceiling. Hence: they get their own state, with both boxes evicted.

**Assets are already in place.** Raven holds `qwen38-flash-next` UD-Q4_K_XL (104 GB) and UD-Q5_K_XL (148 GB), both
MTP heads including `shared-Q8_0`, plus `dsv4-flash-vision-exp`, `dsv4-flash-0731` and `glm53-flash`, with 614 GB
free at 66 percent. Crow has 168 GB free at 91 percent and does **not** hold the Flash-Next Q4/Q5 quants. Nothing
needs downloading for this design.

## 3. What the standard state requires

### 3.0 Ordering constraint: the two-host window lands FIRST

**Flash-Next production must not go onto raven until `dsv4-window.sh` can evict and restore raven prod.** This is a
hard ordering constraint rather than a preference.

`dsv4-window.sh` evicts and restores crow prod only, and its `preflight` requires raven to be idle with under 2 GiB
of GTT residue. The moment raven carries a production service, every two-box arm either fails pre-flight on "raven
busy", which is the good outcome, or contends with a live production service, which is the bad one. Thursday's
chain is safe only because raven is idle today.

So the deployment order is: teach the window two hosts, then stand up Flash-Next on raven. Doing it the other way
round breaks the two-box benchmark program on its next run.

### 3.1 Flash-Next as a production service on raven

Raven has run no production services until now. This makes it a second production host.

Launch, from the validated single-box config (tree `~/llama-max-stack`, or b10715 for the MTP head):

```
llama-server -m <UD-Q4_K_XL>/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf \
  -c 1048576 -b 4096 -ub 2048 -ctk q8_0 -ctv q8_0 \
  --rope-scaling yarn --rope-scale 4 --yarn-orig-ctx 262144 \
  --override-kv qwen4exp.attention.indexer.top_k=int:1024 \
  --spec-type draft-mtp -md <MTP>/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf --spec-draft-n-max 2 \
  -ngl 999 -fa on -np 1 --jinja --host 0.0.0.0 --port <PORT>
```

**Run it natively on raven's host, not in a container.** The bind-mount into the stock Vulkan image works
(pi-lab probed it: `llama-bench --list-devices` enumerates the GPU identically). The image does carry Mesa 25.3.6
against raven's host 25.2.8, and H.4 measured image choice moving 27b prefill by 36 to 57 percent. Every validated
number for this config was taken on the host. A native systemd unit keeps the measurements valid and removes the
container from the trust chain. The existing benchmark arms already run exactly this way.

Open items for the implementer:
- **Port 8030, confirmed free on raven** (2026-09-09: only 22, 53, 631 and two ephemeral ports listen there).
  8031 through 8033 are free too. Closing this before the provider row exists matters, because a provider row
  pointing at an occupied port is a subtler form of the `crow-dsv4` bug this spec retires.
- **Provider row** pointing at `http://10.0.0.126:<port>/v1`. Note `providers` is in `SYNCED_TABLES`
  (`servers/sharing/instance-sync.js:68`), so the row replicates to every paired instance. That is desirable here
  and must be deliberate.
- **Restart policy and a memory watchdog.** 17.7 GiB is the permanent headroom on raven in this state. It is a
  shape that has run for hours (R25/R25b) and never wedged, and it is still the tightest standing configuration in
  the lab.
- **MTP at 1M carries a known quality caveat**: output is not byte-identical between MTP and non-MTP at 1M
  (1752 versus 1777 tokens on prompt A), where it was identical at 262k. It has not shown up as a quality loss:
  the 1M arms scored 8/9 twice, the same as 262k, missing the same case. MTP is worth 1.82x on prompt A, so keep it,
  but record the caveat rather than discovering it.
- **8030 and 8036 are mutually exclusive on raven.** 8036 is the R25/R25b benchmark port for this same
  single-box Flash-Next config. Both ports being free is irrelevant: each instance wants about 92.6 GiB on a
  124 GiB box. Any R25-lineage arm must treat the production service as something to evict, exactly like the
  two-box arms in 3.0.
- **A 262k fallback is worth defining.** 262k leaves 31.0 GiB free instead of 17.7 and is the more exercised rung.
  If 1M proves uncomfortable in standing use, 262k is the same service with one flag changed.

### 3.2 Group and eviction convention

`group` and `evicts` in `settings.localModels` are global strings and host-blind. `wouldEvict` compares group
names and nothing else. So a raven entry that declared `evicts: ["standard"]` would stop crow's 35b for no reason.

**Decision (crow-34, owner): the group convention lives in `settings.localModels`, not in the catalog.**
`group`/`evicts` describe what else is running on a given box, which is instance topology rather than a property of
a model. The same Flash-Next entry would need a different group on crow than on raven, so putting it in a curated
file would bake one lab's host layout into content meant to describe models.

Convention for this design:
- raven's Flash-Next entry: its own group, `evicts: []`. It never evicts anything.
- crow's existing `standard` group: unchanged, and must not name raven's group.
- the heavy states: group `heavy`, evicting everything on both hosts. This is the only group that may cross hosts.

**This convention is a workaround and should be recorded as one.** Encoding a *host* distinction inside a global,
host-blind string works only while everyone remembers it, and this section is its own evidence: a raven entry that
declared `evicts: ["standard"]` would silently stop crow's 35b. **The intended end state is a host-aware eviction
relation**, after which the convention becomes unnecessary. Writing that down here is what stops every future
multi-host entry from re-learning the trap the same way.

### 3.3 The harness can consume this, and cannot manage it

`startModelNow` runs `docker compose up -d` with `cwd: entry.composeDir` on whichever box runs the harness. There
is no host field, no ssh, no docker context. **The harness cannot start or stop a raven-hosted model.** It can
consume one, because `isRunning` fetches `<url>/models` over the LAN.

For the standard state this does not matter: the service is persistent, so nothing needs to start it on demand.
This is the main reason this design is cheaper than the alternatives considered. Do not build a `composeDir`
entry for it that implies otherwise, because the first start would fail.

For the heavy states it does matter, and the window script already ssh-es to raven, so the lifecycle belongs there
rather than in the harness.

### 3.4 One harness defect this design will hit

`setRoleModel`'s conflict test is:

```js
const conflicted = bindings.filter(([role, m]) => role !== modelRole && m && m !== ref && isLocal(m));
```

It fires whenever two roles hold two different local models. It never calls `wouldEvict`, never reads
`group`/`evicts`, and has no host concept. So binding a raven model to one role and a crow model to another raises
"local models share one server slot" and offers to collapse them onto one model. It is a `confirm()`, so Cancel is
safe and nothing is destroyed, and the harness will argue against this configuration every time a binding changes.

The fix is to ask whether starting one actually evicts the other. `wouldEvict` is already exported and already the
right predicate, and with the convention in 3.2 it returns false for the raven/crow pair. The work is exposing the
eviction relation to the client, which today receives only a boolean `local` flag from `annotate()`. This is
pi-lab's tree and needs its own change with a test.

## 4. The heavy states

Both are window modes, not services. Entry conditions, per pi-lab's classes:

- **GLM-5.3-Flash IQ4_XS two-box**, pipeline parallelism off, `-b` equal to `-ub` at 2048 (#28360 asserts at 512
  at every rung, and at 1024/2048 with PP on). Least exercised of the three. Its top_k quality gate has not run.
- **DSv4-Flash IQ4_XS two-box**, tree `~/llama-hc-sop`, now equivalent to master plus #28571 since #26578 merged
  on 2026-09-07 (`7a333e724`). Highest quality of the three at 9/9, and the exact shape that wedged the box three
  times. Operator present, explicit override, never a one-tap option.

Both now require **evicting production on two hosts** and restoring both. Today `dsv4-window.sh` restores crow
prod only. Teaching it raven prod is a prerequisite for this design, and it is the one new capability the heavy
states need.

Context caps: on the max-stack lineage, keep two-box context below 128k, because the RPC worker aborts at
`ggml-rpc.cpp:1386` on 128k prompts on both cache and no-cache builds. This is lineage-scoped, not universal:
R24 W1b ran a 120k prompt two-box on `llama-hc-sop`, which carries `supports_op`, successfully. For qwen4exp above
64k on the #28571 lineage it is untested, and Thursday's W0 tests exactly that.

## 5. The window contract, which is not negotiable

Whatever wraps a heavy state must preserve these five properties. Each was written after an incident, and the
orchestrator should **call** `~/pi-lab/scripts/dsv4-window.sh` rather than reimplement it.

1. The deadman is **out of process**, a detached watchdog with its own wall clock, and restores production even if
   the orchestrator dies, hangs or is killed. This is a lab-wide rule.
2. The memory gate reads **live** state, MemAvailable plus GTT residue after eviction, never a static
   `min_vram_gb` floor. A static floor cannot see the 86 GiB a dead process is still pinning, which is the exact
   condition that produced the wedges.
3. Production restore is **verified**, health check plus DB integrity, before a window is called closed. With this
   design that now means both hosts.
4. The box reservation file is written, because that is what makes the gateway refuse a competing on-demand start.
5. The two-strike ownership guard stays.

**Veto, from pi-lab, carried here as a requirement:** a curated catalog must never be able to offer a known-wedge
shape as a one-tap option.

### 5.1 Open seam: window expiry during a live turn

Raised by crow-34, and jointly owned. A window expiring restores production out from under a live conversation,
which is correct for the box and bad for the bot.

Proposed answer, for review: **drain, never extend.** The out-of-process deadman keeps its absolute wall clock,
untouched, because property 1 above is not negotiable. A separate soft deadline before it stops accepting new
turns and lets the in-flight turn finish. If that turn is still running at the hard deadline, the deadman wins and
the turn dies. The operator sees the soft deadline in the session drawer.

Extending the deadman on activity is explicitly rejected: that is how a cap stops being a cap.

Note that in the standard state this seam is milder than it looks, because evicting for a heavy state stops
raven's Flash-Next but leaves crow's 35b as a genuine fallback, which is not true of any design where the heavy
model displaces crow prod.

## 6. Catalog work, in shippable order

`registry/model-catalog.json` v1 already carries `qwen3.8-flash-next`, `glm-5.3-flash` and `deepseek-v4-flash`.
Their `launch` blocks carry only `ctx`, `ngl`, `flash_attn`, `no_mmap`, `jinja` (plus `parallel` on Flash-Next).
None of the validated tuning is expressible and there are no topology or rung variants. On the memory fields, to be
exact: `min_vram_mb` is **absent at the entry level** and **present-but-zero on every quant**, while `min_ram_mb`
*is* populated and meaningful (115,068 MB for Flash-Next UD-Q4_K_XL, 157,911 for GLM UD-IQ4_XS). So the catalog
already carries a RAM figure; what it lacks is measured peak GTT per host per config, which is what a gate needs.
`min_runtime_version` says `b10068` on all three while each entry's own notes admit the stock runtime will not load
them.

crow-34's sequencing, adopted: land this in pieces rather than as one block.

1. **`serving.class`** first. Independently deployable, needs no build, topology or window support, and protects
   the box on day one by letting the orchestrator refuse a known-wedge shape without an explicit override. Classes:
   `resident` (single box, no RPC, safe behind a cap), `windowed` (operator present, two-box, evicts), and
   `wedge-risk` (above roughly 85 GiB per box, explicit override, never one-tap).

   **Decision (crow-34, owner): `serving.class` is a catalog schema field on the model entry, and must NOT live in
   `settings.localModels`.** The reason is the veto itself. A curated safety property held in per-instance settings
   is one settings edit, or one bug in a settings writer, away from a `wedge-risk` shape being relabelled `resident`
   locally, after which the orchestrator offers it as one tap. `registry/model-catalog.json` lives in git and gets
   reviewed, which is exactly the property a veto needs. **Instance settings may narrow what a box will run, never
   widen it.**

   **Class is a property of a config, not of a model**, and the catalog has no variant concept yet. Flash-Next
   single-box at 262k is `resident`; DSv4 two-box at 86 to 91 GiB per box is `wedge-risk`; those could be one entry.
   So the entry-level field is defined as **a ceiling, not a description: the most dangerous supported shape for
   that model.** DSv4 is `wedge-risk` outright and can never be one-tap however it is invoked, Flash-Next is
   `resident`, GLM is `windowed`. Over-restrictive in principle, correct in every case that exists today, and it
   preserves the veto on day one without waiting for step 4.

   When `topology` lands in step 4, class moves onto the variant, with the entry-level value kept as an **enforced
   ceiling: a variant may never declare itself safer than its model's class.** The ratchet is one-way by design
   rather than by whoever implements step 4.
2. **`gates`**, live state rather than a static floor: max GTT per host, required MemAvailable. The measured peaks
   per config are in the serving doc's memory table and belong here.
3. **`build`**, naming the tree or PR set a config needs, since `min_runtime_version` against a stock release is
   known-false for all three models.
4. **`topology`**, host roles and link preconditions. Last, and only needed once a two-box state is curated.

**Throughput numbers need care.** Any figure the catalog publishes per config must come from a run in the
configuration as deployed. The doc's numbers are host-native. If a config is ever containerized, it needs one
confirmation run first, for the Mesa reason in 3.1.

## 7. Decisions still open

- **The `crow-dsv4` provider row.** It points at `http://127.0.0.1:8020/v1`, is enabled, and validates in
  `resolveModel` while nothing listens there, so a bot pointed at it fails every turn on connection refused.
  Confirmed live on both the crow and R4 instances. Because `providers` syncs, this is a fleet decision and no
  session has touched it. Under this spec DSv4 is a window mode with no standing endpoint, so the row should be
  retired rather than repointed. Kevin's call.
- **Priority of the two harness changes** against the catalog work. Note that remote lifecycle (3.3) is *not*
  needed for the standard state and should not be built speculatively. That leaves the two-host window (3.0) and the
  swap predicate (3.4). pi-lab's read, which this spec endorses: **the two-host window first**, because it is the
  hard prerequisite that makes a two-box arm safe once raven carries production, where the swap predicate is a
  confirm dialog. Kevin's call.
- **An isolated per-container GTT measurement**, offered by pi-lab and not yet taken. The window restore path
  already brings containers back one at a time, so logging GTT between each restore would yield real per-container
  figures instead of the 43 GiB bound this spec uses. It is a log-only change in a script that runs unattended with
  a chain armed, so it is a five-minute job that wants a deliberate go rather than a quiet edit.
- **524k as a curated rung.** Deferred. It has exactly one two-box run, no byte-identity check and no quality arm,
  where 262k and 1M each have several runs, a full corpus twice and 8/9 twice. It wants an identity check and one
  zoo arm before curation.

## 8. Scheduling

Raven stops being single-tenant. It is master for every two-box arm, so a heavy state and any two-box benchmark
work are mutually exclusive in time, and Flash-Next production must be evicted before either.

pi-lab has rewritten the CROW-SCHEDULE standing note accordingly: raven is a production host, the service is native
systemd for the Mesa reason in 3.1, and three consequences follow. Raven is no longer free to borrow. The ordering
constraint in 3.0 applies. And property 3 of the window contract, verified restore, now spans two hosts.
