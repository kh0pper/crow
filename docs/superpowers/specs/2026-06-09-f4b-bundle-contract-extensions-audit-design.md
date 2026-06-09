# F4b — Bundle Contract + Extensions Audit (design)

**Date:** 2026-06-09
**Status:** Approved (design); spec under review
**Roadmap:** Refoundation F4b. Depends on nothing live; follows F4a-L3 (`origin/main`@`ad60da1`). Precedes F6 → F7.
**Master plan:** `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Problem

The refoundation architecture states the modular unit is the **bundle = service + MCP tools + skills**. In practice the bundle layer has drifted and was never formalized:

1. **Two drifted sources of truth.** Each bundle has a rich `bundles/<id>/manifest.json` (authoritative — e.g. jellyfin/plex/obsidian/trilium/nominatim/browser all declare `server` + `panel` + `skills`). But `registry/add-ons.json` is a **hand-maintained, stale, lossy copy**: its entries for those same bundles omit `server`/`skills`. There is **no generator** (only `scripts/sync-skills.js` exists, for the skills index). The handoff's framing of F4b as "backfill any bundle missing its MCP server/skills" is therefore largely a false alarm — most "missing" capabilities are *registry drift*, not bundle gaps.
2. **No formal or enforced contract.** Manifest fields vary; the only doc (`docs/developers/bundles.md`) is stale and describes a docker-compose-with-`crow-gateway` model that no current bundle uses.
3. **`type` is overloaded.** `type: "bundle"` covers both pure-docker services (jellyfin, minio, the `vllm-*`/`llamacpp-*` model servers — legitimately no MCP server/skills) and capability bundles (which should have them). Any contract must be *type-/surface-aware*, not a rigid per-type required-field table.
4. **Concrete drift to resolve.** As of 2026-06-09: 94 bundle dirs vs 90 registry entries. Two registry entries point at non-existent dirs (`tasks`, `developer-kit`). Six dirs are unregistered: `campaigns` (tracked) plus five uncommitted WIP dirs (`capstone-tracker`, `fed-gov-data`, `knowledge-base-mcp`, `research-integration`, `texas-gov-data`) flagged "leave alone" at session start.

## Goals

Deliver all four, as a pipeline:

1. **Formal typed contract** — a JSON Schema + surface-based referential-integrity rules + a rewritten developer doc, replacing the stale `bundles.md`.
2. **Validator + audit** — a script that validates every bundle manifest against the contract and reports nonconformance, plus a `node:test` that fails on drift.
3. **Registry generated from manifests** — `registry/add-ons.json` becomes a generated, committed artifact (lockfile model), killing the drift at its source.
4. **Fix drift + backfill** — regenerate the registry (auto-fixing the ~52 stale thin entries), fix any genuinely nonconformant manifest, and resolve the orphan/unregistered drift items.

## Non-goals

- No runtime/install-time schema enforcement in the gateway (the gate is build/test-time; install paths in `routes/bundles.js`/`extensions.js` are untouched beyond reading the richer regenerated registry).
- No change to the **community-store** merge path in `extensions.js` (remote GitHub add-on stores) — that is a separate, untouched code path.
- No re-typing of bundles or new `type` enum values (surface-based contract makes that unnecessary).
- No unrelated refactoring of bundle internals (servers, panels) beyond fixing manifests to conform.
- We do **not** auto-register uncommitted WIP bundle dirs.

## Design

### 1. The contract — surface-based

A manifest declares the **surfaces** it provides by the presence of keys. The contract = universal required fields (always) + per-surface referential-integrity rules (only for declared surfaces). `type` remains a coarse category tag, **not** the driver of required fields.

**Universal required fields** (every bundle, regardless of surfaces):

| Field | Rule |
|---|---|
| `id` | string; **must equal the bundle directory name** |
| `name` | non-empty string |
| `version` | semver string (`x.y.z`, optionally with prerelease/build) |
| `description` | non-empty string |
| `type` | enum: `bundle` \| `mcp-server` \| `skill` |
| `author` | non-empty string |
| `category` | non-empty string |

**Surfaces** (each validated only if its key is present), checked against the bundle dir:

| Surface key | Shape | Referential-integrity rule |
|---|---|---|
| `docker` | `{ composefile: string }` | `composefile` resolves to an existing file under the bundle dir |
| `ports` / `port` / `webUI.port` | integers (`ports` is an int array) | each is a positive integer ≤ 65535 |
| `server` | `{ command: string, args: string[], envKeys?: string[] }` | the entry file `args[0]` (resolved relative to the bundle dir) exists; `envKeys` entries are strings |
| `panel` | string (`.js` path) | file exists under the bundle dir |
| `panelRoutes` | string (`.js` path) | file exists under the bundle dir |
| `skills` | `string[]` | every path resolves to an existing file under the bundle dir |
| `requires.bundles` | `string[]` | each id exists as a `bundles/<id>` directory |
| `optional_bundles` | `string[]` | each id exists as a `bundles/<id>` directory |
| `env_vars` | array of `{ name: string, description: string, required?: boolean, secret?: boolean, default?: string }` | each entry matches the shape |

**Leniency.** The schema sets `additionalProperties: true`. Unknown fields pass unchanged (so diverse model/media bundles — `capabilities`, `companion`, `storage`, `sttProfileSeed`, `ttsProfileSeed`, `sibling_of`, `enhancedBy`, `age_gate`, `consent_required`, `install_consent_messages`, `providers`, `host`, `icon`, `tags`, `notes` — are preserved verbatim). Only the universal fields and the shape of *declared* surfaces are enforced.

**Draft flag.** `"draft": true` (boolean) marks a manifest as excluded from the generated registry. Default absent = false = published (subject to the tracked-dir rule in §4).

**Artifacts:**

- `registry/manifest.schema.json` — JSON Schema (Draft 2020-12) covering field shapes. Shape-only; it cannot express filesystem existence.
- `scripts/lib/bundle-contract.mjs` — exports `validateManifest(manifest, bundleDir) → { ok: boolean, errors: string[] }`. Performs (a) JSON Schema validation of shape, and (b) programmatic referential-integrity checks (file existence, `id == dirname`, dependency-dir existence). This is the **single source of validation logic**, imported by both the generator and the test. Also exports a small `detectSurfaces(manifest) → string[]` helper for the audit table.

> JSON Schema validation uses a dependency-free approach. The repo has no JSON-schema validator dependency today; rather than add `ajv` (which requires asking permission per the global package-install rule), the validator implements the small set of shape checks directly in `bundle-contract.mjs` and treats `manifest.schema.json` as the human-readable spec of record. If the user prefers `ajv`-backed validation against the schema file, that is a one-line dependency decision to raise before build — the schema file is authored either way.

### 2. Validator + audit + test

- `scripts/build-registry.mjs`:
  - Scans `bundles/*/manifest.json`.
  - Validates each via `bundle-contract.mjs`.
  - **`--check`** mode: validates only (no write). Prints an audit table (id, type, detected surfaces, pass/fail + errors, draft/untracked status). Exits nonzero if **any** manifest fails *or* if the committed `registry/add-ons.json` differs from what would be generated (drift detection).
  - **default** (write) mode: regenerates `registry/add-ons.json`.
  - Determines git-tracked status of each bundle dir (see §4) to apply the untracked = implicit-draft rule.
- `tests/bundle-contract.test.js` (`node:test`): (a) every bundle manifest validates; (b) `id == dirname` for every bundle; (c) committed `add-ons.json` equals the freshly-generated output (lockfile-style no-drift assertion). The test invokes the same `bundle-contract`/`build-registry` code in `--check` semantics so CI-style verification matches the script.
- `package.json` script: `"build-registry": "node scripts/build-registry.mjs"`.

### 3. Registry generated from manifests

`registry/add-ons.json` becomes a **generated, committed** artifact (treated like a lockfile):

```jsonc
{
  "version": 2,
  "add-ons": [ /* validated, non-draft, tracked manifests, sorted by id */ ]
}
```

- Each entry = the **full validated manifest object** with `official: true` injected (the only field the current registry has that manifests lack — confirmed by field-union analysis). Manifests are otherwise a strict superset of registry fields, so consumers gain fields, never lose them.
- Entries **sorted by `id`** for stable, reviewable diffs.
- Orphan entries (`tasks`, `developer-kit`) disappear automatically — no manifest, no entry.
- The `extensions.js` community-store merge and `bundles.js` install-check both only require `id`/`name`/standard fields, all preserved.

### 4. Fix drift + backfill

- **Untracked = implicit draft (safe WIP handling).** `build-registry` excludes any bundle dir that is not git-tracked and reports it. Consequence: a clean checkout's registry is fully determined by tracked manifests (git-state-independent for any committed tree), while locally the five uncommitted WIP dirs are excluded and their files are never touched. Each excluded/untracked/draft dir is reported for the user's explicit register / mark-draft / leave decision.
- **Regenerate** `registry/add-ons.json` — this single step fixes drift problem #1 (the ~52 stale thin entries regain their `server`/`skills`/`panel` from their manifests).
- **Audit-fix manifests.** Run `--check`; for any genuinely nonconformant tracked manifest (missing universal field, dangling surface reference), fix the manifest. Expectation: few, since manifests were the rich source. Each fix is a real correction (e.g. a missing `category`, a skill path that no longer exists), not a fabricated value — if a referenced file is genuinely gone, that is surfaced for a decision, not silently patched.
- **`campaigns`** (tracked, unregistered): validate; if it passes it is registered by regeneration; if it fails, report for a fix-or-draft decision.
- **Docs.** Rewrite `docs/developers/bundles.md` into the real surface-based contract (universal fields, surface table, draft flag, `npm run build-registry`, the generated-registry lockfile model). Update cross-references in `creating-addons.md` and `creating-servers.md` so they point at the new contract instead of the stale model.

### Build sequence

1. `bundle-contract.mjs` + `manifest.schema.json` + rewritten `bundles.md`.
2. `build-registry.mjs` (generator + `--check`).
3. `tests/bundle-contract.test.js`.
4. Regenerate `registry/add-ons.json`; review the diff.
5. Audit-fix any nonconformant tracked manifest; re-regenerate.
6. Resolve drift items (`campaigns`; report WIP/orphan outcomes).

## Components & boundaries

| Unit | Purpose | Depends on | Consumers |
|---|---|---|---|
| `registry/manifest.schema.json` | Human-readable shape spec of record | — | doc readers, (optional) ajv |
| `scripts/lib/bundle-contract.mjs` | Validate one manifest (shape + filesystem integrity); detect surfaces | `fs`, schema rules | generator, test |
| `scripts/build-registry.mjs` | Scan + validate + (write \| `--check`) the registry | `bundle-contract.mjs`, git for tracked-status | `npm run build-registry`, test, humans |
| `tests/bundle-contract.test.js` | Fail on invalid manifest or registry drift | `bundle-contract.mjs`, `build-registry.mjs` | `node --test` |
| `registry/add-ons.json` | Generated install catalog (committed) | manifests | `extensions.js`, `bundles.js` |
| `docs/developers/bundles.md` | The contract, for bundle authors | — | developers |

## Data flow

`bundles/<id>/manifest.json` (authored) → `build-registry.mjs` (validate via `bundle-contract.mjs`; exclude draft/untracked; inject `official`; sort) → `registry/add-ons.json` (committed) → gateway reads at runtime (`extensions.js` panel, `bundles.js` install-check), merged with remote community stores in `extensions.js`.

## Error handling

- Validation failure: `validateManifest` returns `{ ok: false, errors }`; the generator aggregates and, in `--check`, exits nonzero with the full audit table. In write mode, a failure aborts the write (never emit a registry containing an invalid bundle).
- Missing referenced file (skill/server/composefile): reported as a specific error naming the bundle, surface, and path — surfaced for a decision, never auto-stubbed.
- Drift between committed and generated registry in `--check`: nonzero exit with a unified-diff-style summary, so the test and humans see exactly what `npm run build-registry` would change.

## Testing

- `node:test` (repo convention; no other framework). `tests/bundle-contract.test.js` as above.
- Post-build manual verification: gateway boots clean (`node servers/gateway/index.js --no-auth`); the Extensions panel renders from the regenerated registry; spot-check that a previously-thin entry (e.g. jellyfin) now carries `server`/`skills`.
- Existing `tests/auth-network.test.js` and the broader suite remain green (this work touches no gateway routes or auth).

## Risks & mitigations

- **Sweeping WIP into the committed registry** → untracked = implicit-draft rule + explicit per-dir reporting; WIP files untouched.
- **Lossy verbatim copy** → field-union analysis confirmed `official` is the only registry-only field; injected by the generator. Re-verify at build time before committing the regenerated registry.
- **Adding a dependency without permission** → validator is dependency-free by default; `ajv` adoption is raised as an explicit decision, not assumed.
- **Non-deterministic diffs** → entries sorted by `id`; stable JSON formatting (2-space, trailing newline) matching the existing file style.

## Open questions (resolve before/at build)

1. **ajv vs hand-rolled validation** — default is dependency-free hand-rolled checks against the documented schema. Confirm, or approve adding `ajv`.
2. **`draft`/WIP outcomes** — the five uncommitted WIP dirs and `campaigns` get reported with validation status during the backfill phase; the register/draft/leave decision is the user's at that point (not pre-decided here).
