# PR #356 — completion of the outstanding review of `75a006ee`

**Date:** 2026-09-11 · **Reviewer:** pi session (following Kevin's rushed merge of PR #356, 2026-09-10 22:08 UTC)
**Scope:** exactly what the PR's "Outstanding review" section named — the final scoped re-review of commit `75a006ee` ("Perch: judge a reply by its turn, and restore an adopted session's model") that was stopped part-way for budget.

State of the world: `75a006ee` is merged to `main` (`85feb555` = merge of #356). No formal GitHub reviews exist; all review rounds lived in Claude Code sessions. This document closes them out.

---

## Findings

### R1 — CONFIRMED, MEDIUM — the adopted-model restore pins the *resolved default*, not just explicit choices

The PR flagged this as "believed correct but beyond the defect." It is worse than believed, and the mechanism is now identified:

- The row's `model` column is stamped **unconditionally** at every spawn/wake/turn-end:
  - `perch-interactive.js:1228` (`startChild` → `writeRow(…, model: prep.resolved.key)`)
  - `perch-interactive.js:1512` (`onTurnEnd` → `writeRow(…, model: s.resolved.key)`)
  - `perch-interactive.js:1710` (spawn-active stamp)
- `adoptRow` (`:873-877`) restores **whatever the row carries** into `s.currentModelParts` / `s.currentModel`.
- `startChild`'s override (`:1181-1192`) then treats that value as an operator override and forces it over `prepareSpawn`'s fresh resolution.

There is **no provenance distinction** between "the operator picked this" and "this is what the resolver happened to return at the last wake." Consequences:

1. **Sticky defaults across restarts.** Change a bot def's default model in Bot Builder → any session that survives in memory keeps following the def (override is skipped when `currentModelParts` is null — the common case), but after a gateway restart every existing session snaps back to whatever its row stamped and **ignores the def change forever**. The stamp is self-perpetuating: each wake re-stamps the row with the same value.
2. **Asymmetry is the confusing part.** Two identical sessions, one adopted across a restart and one not, behave differently after a def change. "It worked before I restarted the gateway" is the bug report this will generate.

The comment's justification ("an explicit operator choice should survive a restart") is sound **for explicit choices**; the implementation grants that authority to every value the row has ever held.

**Recommendation:** record provenance. Cheapest shape: stop stamping `model` from `startChild`/`onTurnEnd` and let `writeModel()` (called only from `control()` and `onModelSelect`) be the sole writer — then a non-NULL `model` column *means* "operator chose this," and the restore's authority is exactly as wide as the justification. (Check: `writeRow`'s default is `model = null` and its UPDATE list — confirm it does not already null other writers' values; today `writeRow` at `:1294` etc. pass no model, so the column would need to stay out of `writeRow` entirely.) Alternative: a `model_explicit` boolean column. The first option is a deletion, the second a migration — prefer the first.

### R2 — CONFIRMED, MEDIUM — a well-formed but dead model key bypasses every fail-closed rail; unvalidated at write, unprobed at wake

The named "crow-dsv4 disabled the same day" case, traced:

- **Write side:** `routes/perch-interactive-api.js:610` maps `body.model` → `{provider, modelId}` with only object-shape checks; `control()` (`perch-interactive.js:1914`) checks truthiness only. Any string pair is accepted **and now persisted** by `writeModel()` — the API can plant a poison pill that outlives restarts. The drawer's picker only offers catalogue values, so this is API-hardening, not a UI defect.
- **Wake side:** `resolveModel()` (model_resolver.mjs) is fail-closed — an invalid key resolves to `LOCAL_FALLBACK`. But the `startChild` override injects `currentModelParts` **after** that resolution and **without validation**, so the restore path skips the resolver's only safety rail.
- **Actual failure mode:** `warmModel()` is genuinely best-effort and never throws (`warm.mjs` — verified). pi is spawned with `--provider <dead> --model <dead>` (`bridge.mjs:166`). If pi rejects at startup, `attachExit` parks the session (`s.pi=null`, state → hibernating, `lastError = "pi exited unexpectedly"`) and the `s.pi !== pi` bail at `:1259` prevents the "awake" lie — this is the I-1 rail and it holds. If pi starts and only fails per-request, every turn errors or replies nothing.
- **Recovery exists but is undiscoverable:** the operator *can* fix it — `options()` serves the catalogue without a child, and `control()` while hibernating stores + persists the new model. But nothing in the error names the model as the cause, and every retry re-attempts the dead model first. The PR's own N2 tests cover *malformed* keys (`splitModelKey` shape) but **no test drives a well-formed key naming a deleted/disabled provider**.

**Recommendation (two small, layered changes):**
1. **Validate at control() time:** reject `model` pairs not present in `providerModelListWarm()` (the module built exactly for this, `perch-model-catalog.js` — same single source the picker uses) with `bad_request`. Makes the pill un-plantable.
2. **Fail-open at wake:** in the `startChild` override, if `s.currentModelParts` names a key absent from the catalogue, drop the override (serve the fresh def resolution), clear the tracking fields, and `emit` a visible `log` frame ("row model X no longer available — resumed on Y"). Turns the opaque crash-park loop into one honest sentence.
   - Do **not** clear the row in this path silently — if the provider is *temporarily* disabled, clearing loses a real operator choice. With R1's provenance split, "keep the row, log the fallback" is coherent.

### R3 — VERIFIED CLEAN — `writeModel()`'s targeted UPDATE does not clobber

The PR asked for a second pair of eyes on this specifically:

- `bot_sessions` schema (`scripts/init-db.js:2601-2629`): no CHECK on `model`, no generated columns, **no triggers on the table at all** (grep for `TRIGGER` + session/bot returns nothing).
- The statement is `UPDATE bot_sessions SET model=?, updated_at=datetime('now') WHERE id=?` — two columns, parameterized, keyed on row id.
- The documented `writeRow` clobber (status restamp + `control` reset to `'run'`, `perch-interactive.js:691`, and the rename doc at `:2159-2161`) is exactly what `writeModel` avoids by not going through `writeRow`.
- Null-safety: `servingModel(s)` = `s.currentModel || s.resolved?.key`; both `control()` call sites assign `s.currentModel` **before** calling `writeModel`, so a NULL overwrite of a good value is not constructible from these paths. `s.rowId == null` early-returns.
- Race with `onTurnEnd`'s `writeRow`: `control()` throws `turn_in_progress` while `s.turn` is set, so the two writers are serialized by design.

No action.

### R4 — VERIFIED CLEAN — turn-id reply logic (the N1 half of the commit)

- Turn ids are `randomUUID()` per turn (`perch-interactive.js:1701`) — no reuse across the reconnect window, so `renderedTurn===d.turnId` can never match a stale turn.
- `text` frames carry `s.turn?.id ?? null`; the `null` fallback keeps the legacy transition-flag path intact for out-of-turn child speech (verified the client handles the mixed cases at `client.js:909,929`).
- `if(!d.text) return` correctly distinguishes malformed-JSON `d={}` from real frames given the engine only emits `text` for non-empty messages (`:1328`).
- Session switch resets `renderedTurn` (`client.js:1121`) alongside `turnRendered` — no bleed between sessions.
- Coverage: both reconnect shapes driven in the unit harness (`tests/perch-hub-client.test.js:2169-2231`, including the no-turn-id legacy shape and the malformed-frame test) and live over a server-closed connection (`tests/perch-hub-stream-leak.test.js:357-392`).

**One adjacent, pre-existing race, NOT a regression from this commit** (noted so it lands on the radar rather than being blamed on it): `afterHeader` opens the stream **before** the transcript fetch resolves (`client.js:769`). A message that completes between the subscribe and the transcript landing renders twice — once from the `text` frame, once inside the fetched history. The `reply` itself stays suppressed (`renderedTurn` matches), so the blast radius is a duplicated bubble, same visual class as the defect this commit killed. Candidate for the integration-issues list.

### R5 — RESOLVED BY INSPECTION, re-run pending — the two mutations "judged wrong rather than green"

The commit names them: (a) a partial pre-fix client, (b) engine-side edits tested against client tests that build their own frames.

- (b) is addressed by real tests that read **engine-emitted** frames from a live `message()` turn and assert `turnId` on both `text` and `reply` (`tests/perch-interactive-controls.test.js:1066-1092`) — an engine-side stamping deletion is now red-able.
- (a) is addressed by the two reconnect tests shaping each case separately (unit + live, see R4).

By inspection these are right. The mutation matrix should still be re-run once (see verification) since the round that was supposed to confirm it never finished.

---

## Verification checklist (for execution, in budget order)

1. `npm test -- tests/perch-hub-client.test.js tests/perch-hub-stream-leak.test.js tests/perch-interactive-controls.test.js tests/perch-hub-render.test.js` — green on current `main`.
2. Mutation re-run, each restored alone, expect the named red:
   - delete `turnId` from the `reply` emit (`perch-interactive.js:1492`) → engine stamping test red
   - delete `turnId` from the `text` emit (`:1328`) → two stamping tests red
   - remove `adoptRow` restore (`:873-877`) → three N2 tests red
   - make `writeModel` a no-op → three N2 tests red
   - revert `renderedTurn` client logic → cross-turn test red
3. New drives the old suite lacks (become regression tests for R1/R2 fixes):
   - **Dead-provider wake:** stamp a session's row with `provider/model`, disable/remove that provider row, restart the engine, `message()` → assert the session serves on the fresh def resolution (or the validated rejection, per fix shape) **and** that a `log` frame naming the fallback reaches subscribers. Today this scenario is untested end to end.
   - **Def-change pin:** spawn a session on def default A, change def default to B, restart engine (adopt), `message()` → today it silently serves A (the bug); after the fix, serves B when the row carries no explicit choice.

---

## Verdict

The rushed merge did not break anything that the merged tests cover — the client half (N1/R4) and the DB hygiene (R3) hold up. The two genuine gaps are exactly the two the PR flagged as its own leftovers, and both live in the wake path:

| # | Issue | Severity | Fix size |
|---|-------|----------|----------|
| R1 | Row-stamped *defaults* get operator-choice authority; def changes silently pinned across restarts | Medium | small — stop stamping `model` outside `control()`/`onModelSelect` |
| R2 | Well-formed dead model key: unvalidated at write, unprobed at wake, opaque failure | Medium | small — catalogue validation at `control()`, fail-open + log at wake |
| R4-adjacent | openStream/loadHistory duplicate bubble race (pre-existing) | Low | separate issue — belongs to the integration-issues plan |

R1 and R2 share a root: the engine grants the row's `model` column more trust than the column's writers deserve. They should ship as one change, and they are candidates to fold into the perch-hub integration issue plan (next section, awaiting Kevin's notes).

---

## Status footer (resolved 2026-09-12)

All three findings are **closed**, shipped as Phase A of the operator-approved
open-anywhere plan (`docs/superpowers/plans/2026-09-11-perch-hub-open-anywhere.md`):

| Finding | Closed by | Where |
|---|---|---|
| **R1** — row-stamped defaults got operator-choice authority | **PR #357** | `perch-interactive.js` A1: the `model` column means an explicit choice only (stamps dropped; `onModelSelect`→`writeModel`; revocation path clears to NULL) |
| **R2** — well-formed dead model key: unvalidated at write, unprobed at wake | **PR #357** | A2: `control()` validates the pair against the catalogue before persisting; A3: a dead recorded model falls open at wake with a log frame naming the fallback |
| **R4-adjacent** — openStream/loadHistory duplicate bubble | **PR #357** | A4: a message landing between subscribe and history renders once (the client's `histBuf`/`flushHistBuf` sequence-guard) |

The verification checklist's mutation matrix and the two new drives (dead-provider
wake, def-change pin) are covered by `tests/perch-interactive-controls.test.js`
and were re-run green in PR #357 and again in the open-anywhere PR3 full suite
(`npm test`, 4717/0). R1/R2's fail-open path was additionally walked live on a
real gateway + real local model on 2026-09-12 (a disabled provider resumed on
the def default with the `recorded model … is not available — resumed on …` log
line; the row kept the dead key by design).
