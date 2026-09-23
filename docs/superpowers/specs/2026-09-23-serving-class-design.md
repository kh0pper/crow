# `serving.class` — a curated safety ceiling in the model catalog (design, 2026-09-23)

Strix Halo track, sub-project 2. Source: the two-host spec (PR #344,
`docs/superpowers/specs/2026-09-09-two-host-production-and-heavy-model-modes.md`
§5 veto and §6 step 1) and the decision doc
`backlog/2026-09-22-strix-halo-profile-and-external-engines.md` (Gitea).

Autonomous cycle: design decisions marked **(D#)** are mine, made under
Kevin's standing grant, and are open to his reversal. The two decisions
marked **crow-34** come from the two-host spec and are carried here unchanged.

## 1. Problem

The catalog now carries three large models: `qwen3.8-flash-next`,
`glm-5.3-flash` and `deepseek-v4-flash`. `deepseek-v4-flash` is the exact
shape that wedged the Strix Halo box three times. The gateway's orchestrator
starts any registered native model on demand: from the models panel's Start
button, a chat turn, the `/llm/v1` router, `/llm/acquire` or residency. Nothing
distinguishes a model that is safe to run behind a cap from one that needs an
operator-run window. pi-lab's veto, carried in §5 of the two-host spec: *a
curated catalog must never be able to offer a known-wedge shape as a one-tap
option.*

## 2. Classes

| class | meaning | gateway behaviour |
|---|---|---|
| `resident` | single box, no RPC, safe behind a cap | starts as today |
| `windowed` | operator present, two-box and/or evicts production | refused unless an explicit override names `windowed` |
| `wedge-risk` | above roughly 85 GiB per box on a shape that has wedged the box | refused unless an explicit override names `wedge-risk`; the dashboard never offers a start |

- **crow-34:** the class is a catalog schema field on the model entry, never in
  `settings.localModels` or any instance setting. A curated safety property
  must live in git, where it is reviewed. *Instance settings may narrow what a
  box will run, never widen it.* (Narrowing is not built here, per YAGNI, and
  no setting can widen.)
- **crow-34:** the entry-level class is a **ceiling**: the most dangerous
  supported shape for that model. When variants or `topology` land (§6 step 4),
  class moves onto the variant, and a variant may never declare itself safer
  than its model's class. That ratchet is recorded here; it is not built now,
  because no variant concept exists.

Initial assignments:

- `deepseek-v4-flash`: `wedge-risk`.
- `glm-5.3-flash`: `windowed`.
- `qwen3.8-flash-next`: `resident`, since it runs single-box at 262k.
- All other entries: `resident`.

## 3. Design

### 3.1 Schema: `serving: { class }` on every model entry

- **(D1) Required on every entry, not optional with a `resident` default.**
  With a default, forgetting the field on a new 150 GB entry would silently
  mean "safe". Required, the validator fails CI until someone decides.
- Validator (`scripts/validate-model-catalog.js`, runs in CI):
  - `serving` must be a plain object whose `class` is one of the three values.
    Unknown keys inside `serving` are errors, matching the strict `launch`
    block.
  - **(D2) The arithmetic rule** (per the two-host spec §4.1): if any quant's
    `min_ram_mb` exceeds `SINGLE_BOX_RAM_MB = 126976` (124 GiB: crow's
    `mem_info_gtt_total` is 133,143,986,176 B = exactly 126,976 MiB, read
    2026-09-23; MemTotal is 127,940 MiB), the class must not be `resident`.
    The model cannot run on one box, so it cannot be single-box-safe.
    `glm-5.3-flash` UD-IQ4_XS (157,911 MB) trips it; `qwen3.8-flash-next`
    (115,068 MB) does not.
  - **(D3)** The `first_run_default` model must be `resident`, because
    onboarding downloads it with one tap.
  - **(D4)** A model tagged `two-box` must not be `resident`.
- A catalog `version` bump is not needed. Readers ignore unknown keys, and the
  field is additive.

### 3.2 One module: `servers/gateway/models/serving-class.js`

Pure, with no I/O:

- `SERVING_CLASSES = ["resident", "windowed", "wedge-risk"]`
- `servingClassOf(entry)` returns the class string, or `null` when the entry
  is missing or has no valid class.
- `class ServingClassError extends Error` with `code = "serving_class_refused"`,
  `http = 409`, and fields `servingClass` and `provider`.
- `servingClassRefusal(entry, providerName, override)` returns a
  `ServingClassError`, or `null` when the start is allowed. The start is
  allowed when the class is `resident`, when the class is `null` (the entry is
  uncurated), or when `override === class` exactly.

**(D5) The override must name the class.** A generic `force: true` could be
set by a UI or a script that never looked at the class. An override string
equal to the class is a statement that the caller knows what it is starting.
`windowed` does not unlock `wedge-risk`, and the reverse does not hold either.

**(D6) Uncurated means allowed.** When the provider's `catalogId` is not in
the catalog, or the catalog is unreadable, the start proceeds as it does today
and one line is logged. The catalog is a git file shipped with the code, so
"unreadable" means a broken install everywhere. Blocking every native start on
that would be a new outage mode for a veto that exists only for curated
shapes. A provider that is not catalog-backed (Docker bundles, cloud, peers)
never reaches this check.

### 3.3 Enforcement at the single native choke point

The check goes in `acquireOrStartNative` (`gpu-orchestrator.js`), **after** the
resident fast path and **before** the box-reservation gate. The static
ceiling runs in front of every live gate, so a permanent refusal is never
reported as a transient `box_reserved` that tells a client to retry a start
that can never succeed (plan-review finding, 2026-09-23). A model
that is already running is never refused, for the same reason a reservation
never refuses one: refusing it would not make the box any safer.

The catalog lookup reuses the same `loadCatalogFn` seam that
`startNativeAndAwaitReady` uses, with lookup key
`p.gpuPolicy?.catalogId || providerName`. `opts.servingOverride` carries the
override.

The refusal is then handled like a reservation on every caller path:

- `maybeAcquireLocalProvider` rethrows `ServingClassError` next to
  `ReservedError`. A refusal is a decision, not a failure.
- `ensureNativeResident`, used by boot and the residency tick, never throws
  on it. It logs once per provider, returns `false`, and so never auto-starts
  a non-resident model even when `alwaysResident` is set.
- `POST /api/models/:id/start` answers 409 with body
  `{ code: "SERVING_CLASS_REFUSED", serving_class, error }`, and forwards
  `req.body.serving_override` as `servingOverride`.
- The `/llm/v1` router follows its reservation pattern:
  - on an escalation with a live fast model, it degrades to the fast model
    with a system note, labelled `degraded(serving_class)`;
  - otherwise it answers 409 `{ error: { code: "serving_class_refused", … } }`
    with no `Retry-After`, because the refusal is permanent, not transient.
- `POST /llm/acquire` answers 409 `{ ok:false, error:"serving_class_refused", serving_class }`.
- Dashboard chat sends an error event with the refusal message instead of
  falling through to a connection error.

**(D7) None of these paths plumbs an override except the models-panel start
API.** Bots, chat and the router cannot start a non-resident model at all. The
path for a heavy model stays the operator's window script
(`~/pi-lab/scripts/dsv4-window.sh`), which starts llama-server itself and
never goes through this gateway path.

### 3.4 API and dashboard

- `GET /api/models/catalog` and the panel's data shaping add
  `serving_class` to each entry.
- `renderModelCard`:
  - For a registered, non-`resident` model, it replaces the one-tap **Start**
    with a notice. For `windowed`: "Operator window only: this model runs two-box or
    evicts production." For `wedge-risk`: "Known wedge risk: never started
    from the dashboard."
  - A class badge is shown on every non-`resident` card.
  - **Download stays available**, because downloading never starts anything.
    The existing WONT_FIT gating still applies.
  - **(D8) The dashboard offers no override button, not even a two-step
    confirm.** A second tap is still a tap. The override exists in the API
    for an operator using curl or a script. That is the strongest reading of
    "never one-tap", and it costs nothing today: neither non-resident model can
    run single-box on this hardware through this path anyway.
- The runtime strip's own Start button applies the same rule. Both server
  renders call one exported helper, `startAffordance(servingClass)`, so they
  cannot drift apart. The client script never creates a Start button except
  through a server re-render. If it ever does, the card carries
  `data-serving-class`.
- i18n: all new strings in both `en` and `es`, since the global i18n parity
  gate is live.

## 4. Out of scope

- Live gates (the two-host spec §6 step 2: GTT and MemAvailable). They are
  the next sub-project, and the class check is the static ceiling that runs
  in front of them.
- `build` and `topology` (§6 steps 3 and 4), and the variant ratchet (§2),
  which is recorded above.
- Instance-level narrowing.
- Docker-bundle providers. They are not catalog-backed.

## 5. Testing

- **Validator:** a missing class, an unknown class and an unknown key inside
  `serving` all fail. The arithmetic rule fails in both directions (a
  157,911 MB quant with class `resident`, and a pass at 115,068 MB). A
  `first_run_default` that is not resident fails. `two-box` with class
  `resident` fails. The real catalog passes.
- **`serving-class.js`:** unit tests covering every class × override
  combination, including a cross-class override being refused.
- **Orchestrator** (the `gpu-orchestrator-native` harness seams):
  - a cold wedge-risk model is refused with `ServingClassError`, and no spawn
    happens;
  - a resident fast-path model is not refused even if its class is
    wedge-risk;
  - an override equal to the class starts it; a cross-class override is
    refused;
  - an uncurated `catalogId` starts;
  - `maybeAcquireLocalProvider` rethrows the refusal;
  - `ensureResident` returns `false` without throwing.
- **Routes:**
  - models start: 409 `SERVING_CLASS_REFUSED`, and the override is forwarded;
  - `llm-router`: the 409 and the escalate-degrade;
  - `/llm/acquire`: the 409;
  - chat: the error event.
- **Panel:** a non-resident registered card has no Start action and shows the
  notice; a resident card is unchanged; the catalog API carries
  `serving_class`; the client contract test is updated.
