# W2-1 — Route-Layer Unification: Implementation Plan

**Date:** 2026-06-11
**Spec:** `docs/superpowers/specs/2026-06-11-w2-1-route-layer-unification-design.md`
**Repo:** `/home/kh0pp/crow` (all paths below are relative to this root; run all commands from it)
**Branch:** `overhaul/w2-1` (created from `main` in Task 1, Step 1)

**Goal:** Unify four route-layer divergences in the gateway: (1) one canonical JSON error shape `{error, ...extra}` for the outlier routes (`stt-debug`, `bot-board-api`'s private `jerr`, `admin-backup`/`bundles` `{ok:false}` error bodies); (2) one shared HMAC verify middleware factory in `servers/shared/cross-host-auth.js` replacing the two inline copies in `bundles.js` and `federation.js`; (3) one rate-limit factory module (`tieredRateLimit` + `fixedWindowLimit`) replacing three implementations; (4) close the WebSocket auth gap in `extension-proxy.js` (upgrades bypass Express, so `dashboardAuth` never ran for WS). Plus a tidy: `push.js` and `settings-scope.js` move to prefix-level `router.use` auth.

**Architecture:** All changes are in-process Express middleware/helpers. New files: `servers/gateway/routes/_error.js`, `servers/gateway/middleware/rate-limit.js`, three test files. Extended file: `servers/shared/cross-host-auth.js` (new exported factory; existing exports untouched). No DB schema changes, no new dependencies (reuses `express-rate-limit`, already a dependency used by `blog-embed-api.js`).

**Tech stack:** Node ESM (`"type": "module"`), Express 4, node built-in test runner (`node --test`), libsql client for DB (untouched).

## Executor guardrails (apply to EVERY task)

- **Commits use positional path args**: `git commit <path1> <path2> -m "..."` — NEVER `git add -A`, NEVER a bare `git commit` after `git add` (parallel sessions modify this working tree; the tree currently has unrelated untracked `bundles/*` dirs that must NOT be swept in). For **new** files only: `git add <exact-new-file>` first, then commit with positional paths. Verify after every commit: `git show --stat HEAD` must list ONLY the files in your task.
- **NEVER add `Co-Authored-By`, "Generated with Claude", or any AI/Claude attribution to any commit message.**
- **No DB schema changes.** No edits to anything in `scripts/init-db*` or migrations.
- **Baseline:** `node --test tests/` currently prints `# pass 353` / `# fail 0`. Every task must leave the suite green (pass count only grows when a task adds tests).
- Do not touch route SUCCESS response shapes (`{ok:true,...}` bodies stay). Only ERROR shapes listed explicitly below change.
- Run `node --check <file>` on every JS file you edit before running tests.

---

## Task 1 — Branch, `_error.js` helper, and stt-debug error-shape migration

**Files:**
- new: `servers/gateway/routes/_error.js`
- edit: `servers/gateway/routes/stt-debug.js`

**Context (verified):** `stt-debug.js` has exactly 4 error sites wrapping in `{ok:false, error}` (lines 31, 41, 46, 69–73). The only in-repo reference to its endpoint outside the route itself is a **documentation string** in `servers/gateway/dashboard/settings/sections/llm/stt-profiles.js:210` (HTML help text saying "POST audio to `/api/stt/debug`"). No dashboard client JS fetches `/api/stt/debug` — verified via `grep -rn "stt/debug" servers/gateway/` (hits: `ai/stt/index.js:103` note string, `index.js:1014` log line, the route file, and the help-text line). The `data.ok` read in `stt-profiles.js` (`testSttProfile`) targets `POST /dashboard/settings` (a different endpoint, unaffected). **No client change needed.**

**Steps:**

- [ ] **1.1 Create the branch:**
  ```bash
  cd /home/kh0pp/crow && git checkout main && git pull && git checkout -b overhaul/w2-1
  ```
  Expected: `Switched to a new branch 'overhaul/w2-1'`.

- [ ] **1.2 Create `servers/gateway/routes/_error.js`** with exactly this content:
  ```js
  /**
   * Canonical JSON error helper for gateway routes (W2-1).
   *
   * One shape for every JSON API error: { error: string, ...optionalExtra }.
   * Success shapes are deliberately NOT standardized here — only errors.
   *
   * Usage:
   *   jsonError(res, 404, "card not found")
   *   jsonError(res, 500, err.message, { code: err.code || "unknown" })
   */
  export function jsonError(res, status, error, extra = undefined) {
    return res.status(status).json(extra ? { error, ...extra } : { error });
  }
  ```

- [ ] **1.3 Edit `servers/gateway/routes/stt-debug.js`.** Make these six exact replacements (a–f):

  (a) Header doc, replace the line:
  ```js
   * Returns: { ok, provider, text, language?, duration? } or { ok:false, error }
  ```
  with:
  ```js
   * Returns: { ok, provider, text, language?, duration? } on success,
   * or { error, code? } on failure (canonical W2-1 error shape).
  ```

  (b) Add the import after the existing import block (after the line `import { createSttAdapter, getSttProfiles, getDefaultSttProfile } from "../ai/stt/index.js";`):
  ```js
  import { jsonError } from "./_error.js";
  ```

  (c) Replace:
  ```js
      return res.status(400).json({ ok: false, error: "No audio file uploaded (use `file` field)" });
  ```
  with:
  ```js
      return jsonError(res, 400, "No audio file uploaded (use `file` field)");
  ```

  (d) Replace:
  ```js
          return res.status(404).json({ ok: false, error: `No STT profile with id ${req.body.profile_id}` });
  ```
  with:
  ```js
          return jsonError(res, 404, `No STT profile with id ${req.body.profile_id}`);
  ```

  (e) Replace:
  ```js
          return res.status(400).json({ ok: false, error: "No STT profiles configured" });
  ```
  with:
  ```js
          return jsonError(res, 400, "No STT profiles configured");
  ```

  (f) Replace:
  ```js
      res.status(500).json({
        ok: false,
        error: err.message,
        code: err.code || "unknown",
      });
  ```
  with:
  ```js
      jsonError(res, 500, err.message, { code: err.code || "unknown" });
  ```

- [ ] **1.4 Verify and run:**
  ```bash
  node --check servers/gateway/routes/_error.js
  node --check servers/gateway/routes/stt-debug.js
  grep -c "ok: false" servers/gateway/routes/stt-debug.js
  node --test tests/
  ```
  Expected: both `--check` silent; grep prints `0`; suite prints `# pass 353` / `# fail 0`.

- [ ] **1.5 Commit:**
  ```bash
  git add servers/gateway/routes/_error.js
  git commit servers/gateway/routes/_error.js servers/gateway/routes/stt-debug.js -m "W2-1: add jsonError helper; stt-debug errors {ok:false,error} -> {error}"
  git show --stat HEAD
  ```
  Expected: exactly 2 files in the commit.

---

## Task 2 — `bot-board-api.js`: delete local `jerr`, use shared `jsonError`

**Files:** edit: `servers/gateway/routes/bot-board-api.js`

**Context (verified):** The file contains 109 lines matching `jerr(res`: 1 definition (`function jerr(res, code, obj) { return res.status(code).json(obj); }`, line 69), 96 single-line calls shaped `jerr(res, <code>, { error: <expr> })` (one of them uses a variable status: `jerr(res, status, { error: r.message })`), 11 single-line calls shaped `jerr(res, 409, { reason: ... })` (one also carries `mtime`), and 1 multi-line call opening with `jerr(res, 409, {` followed by a `reason:` line. The `{reason}` 409s are a **client contract** (Bot Board drawer reads `reason`) — they must stay `{reason}`, so they become direct `res.status(409).json({ reason: ... })` rather than `jsonError`. Do **NOT** touch the two HTTP-200 bodies that carry `ok:false` flags (`bulk-assign` rollback response and `session/stop` `{ok:false, reason:"no session"}`) — they are 200-status reports, not error responses, and clients read `ok` there.

**Steps:**

- [ ] **2.1** Confirm baseline counts:
  ```bash
  grep -c "jerr(res" servers/gateway/routes/bot-board-api.js
  ```
  Expected: `109`.

- [ ] **2.2** Add the import. After the line:
  ```js
  import { createDbClient } from "../../db.js";
  ```
  insert:
  ```js
  import { jsonError } from "./_error.js";
  ```

- [ ] **2.3** Mechanically convert the `{ error: ... }` calls (96 sites):
  ```bash
  perl -pi -e 's/\bjerr\(res, (\d+|status), \{ error: (.*) \}\)/jsonError(res, $1, $2)/' servers/gateway/routes/bot-board-api.js
  grep -c "jerr(res" servers/gateway/routes/bot-board-api.js
  ```
  Expected count after: `13` (12 reason-shaped call lines + the definition).

- [ ] **2.4** Convert the `{ reason: ... }` 409s to direct responses (12 sites, incl. the multi-line opener — this regex covers both because the multi-line call's first line ends with `{`):
  ```bash
  perl -pi -e 's/\bjerr\(res, 409, \{/res.status(409).json({/' servers/gateway/routes/bot-board-api.js
  grep -c "jerr(res" servers/gateway/routes/bot-board-api.js
  ```
  Expected count after: `1` (only the definition remains).

- [ ] **2.5** Delete the definition line. Remove exactly this line:
  ```js
  function jerr(res, code, obj) { return res.status(code).json(obj); }
  ```

- [ ] **2.6** Verify and run:
  ```bash
  grep -c "jerr" servers/gateway/routes/bot-board-api.js          # expect 0
  grep -c "jsonError(res" servers/gateway/routes/bot-board-api.js # expect 96
  grep -c "res.status(409).json({ reason" servers/gateway/routes/bot-board-api.js  # expect 11 (the 12th is multi-line: "res.status(409).json({" + next-line "reason:")
  node --check servers/gateway/routes/bot-board-api.js
  node --test tests/
  ```
  Expected: counts as annotated; `--check` silent; `# pass 353` / `# fail 0`.

- [ ] **2.7 Commit:**
  ```bash
  git commit servers/gateway/routes/bot-board-api.js -m "W2-1: bot-board-api — replace local jerr with shared jsonError; 409 reason bodies stay {reason}"
  git show --stat HEAD
  ```

---

## Task 3 — Normalize `{ok:false}` ERROR bodies in `admin-backup.js` + `bundles.js`

**Files:** edit: `servers/gateway/routes/admin-backup.js`, `servers/gateway/routes/bundles.js`

**Context (verified):** Enumerated `ok: false` ERROR sites (success `ok:true` bodies are untouched):
- `admin-backup.js:104` — 500 error body.
- `bundles.js` — 7 sites, all non-2xx error responses inside `POST /bundles/api/install` and `POST /bundles/api/uninstall`: lines 982 (400 missing deps), 1013 (400 hardware gate), 1031 (400 GPU gate), 1043 (403 consent required), 1056 (403 consent expired), 1069 (403 hosted host-networking), 1560 (409 uninstall dependents).

**Client evidence (verified):** the only in-repo consumer is the Extensions panel (`servers/gateway/dashboard/panels/extensions.js`). Its `apiCall` helper derives `ok` from the **HTTP status** (`{ ok: r.ok, data: d }`, line 835), and error rendering reads `res.data.error` plus extra fields (`res.data.consent_expired` at line ~1117) — all of which are preserved. `servers/gateway/dashboard/settings/sections/shared-storage.js` hits only the shared-storage endpoints whose shapes don't change. **No client change needed.** External curl callers of `/api/admin/backup` (none found in-repo besides the `index.js` mount) get `{error}` instead of `{ok:false,error}` on the 500 path only.

**Steps:**

- [ ] **3.1** In `admin-backup.js`, replace:
  ```js
      res.status(500).json({ ok: false, error: err.message });
  ```
  with:
  ```js
      res.status(500).json({ error: err.message });
  ```
  No header-doc change is needed in admin-backup.js (its doc never mentions the error shape). The `ok: true` SUCCESS body at line 93 stays unchanged.

- [ ] **3.2** In `bundles.js`, make these 7 exact replacements (each old string is unique in the file):

  (a)
  ```js
        return res.status(400).json({
          ok: false,
          error: `Bundle '${bundle_id}' requires the following bundles to be installed first: ${missing.join(", ")}`,
          missing_dependencies: missing,
        });
  ```
  →
  ```js
        return res.status(400).json({
          error: `Bundle '${bundle_id}' requires the following bundles to be installed first: ${missing.join(", ")}`,
          missing_dependencies: missing,
        });
  ```

  (b)
  ```js
        return res.status(400).json({
          ok: false,
          error: gate.reason,
          hardware_gate: gate,
        });
  ```
  →
  ```js
        return res.status(400).json({
          error: gate.reason,
          hardware_gate: gate,
        });
  ```

  (c)
  ```js
        return res.status(400).json({
          ok: false,
          error: gpuCheck.reason,
          gpu_arch_gate: gpuCheck,
        });
  ```
  →
  ```js
        return res.status(400).json({
          error: gpuCheck.reason,
          gpu_arch_gate: gpuCheck,
        });
  ```

  (d)
  ```js
        return res.status(403).json({
          ok: false,
          error: "Consent token required. Call GET /bundles/api/consent-challenge/:id to obtain one.",
          consent_required: true,
        });
  ```
  →
  ```js
        return res.status(403).json({
          error: "Consent token required. Call GET /bundles/api/consent-challenge/:id to obtain one.",
          consent_required: true,
        });
  ```

  (e)
  ```js
        return res.status(403).json({
          ok: false,
          error: "Consent token is invalid, expired, or already consumed. Mint a new one and retry.",
          consent_expired: true,
        });
  ```
  →
  ```js
        return res.status(403).json({
          error: "Consent token is invalid, expired, or already consumed. Mint a new one and retry.",
          consent_expired: true,
        });
  ```

  (f)
  ```js
          return res.status(403).json({ ok: false, error: "This bundle requires host networking and is not available on managed hosting." });
  ```
  →
  ```js
          return res.status(403).json({ error: "This bundle requires host networking and is not available on managed hosting." });
  ```

  (g)
  ```js
      return res.status(409).json({
        ok: false,
        error: `Cannot uninstall '${bundle_id}' — other installed bundles depend on it: ${dependents.join(", ")}. Uninstall the dependents first.`,
        dependents,
      });
  ```
  →
  ```js
      return res.status(409).json({
        error: `Cannot uninstall '${bundle_id}' — other installed bundles depend on it: ${dependents.join(", ")}. Uninstall the dependents first.`,
        dependents,
      });
  ```

- [ ] **3.3** Verify and run:
  ```bash
  grep -n "ok: false" servers/gateway/routes/bundles.js servers/gateway/routes/admin-backup.js
  node --check servers/gateway/routes/bundles.js
  node --check servers/gateway/routes/admin-backup.js
  node --test tests/
  ```
  Expected: grep prints **nothing**; `# pass 353` / `# fail 0`.

- [ ] **3.4 Commit:**
  ```bash
  git commit servers/gateway/routes/admin-backup.js servers/gateway/routes/bundles.js -m "W2-1: normalize {ok:false} ERROR bodies to {error,...} in admin-backup + bundles (success shapes unchanged)"
  git show --stat HEAD
  ```

---

## Task 4 — Shared `crossHostVerifyMiddleware` factory + tests

**Files:**
- edit: `servers/shared/cross-host-auth.js` (append factory + one import)
- new: `tests/cross-host-middleware.test.js`

**Reference — the two inline copies the factory must preserve EXACTLY.**

`servers/gateway/routes/bundles.js:211–266` (verbatim):
```js
function crossHostVerifyMiddleware(dbClient) {
  return async (req, res, next) => {
    const sig = req.headers["x-crow-signature"];
    if (!sig) return next(); // not a peer call — pass through

    const source = req.headers["x-crow-source"];
    if (!source) {
      return res.status(401).json({ error: "missing_x_crow_source" });
    }

    // Load shared signing_key from peer-tokens.json
    const creds = getPeerCreds(source);
    if (!creds || !creds.signing_key) {
      await auditCrossHostCall(dbClient, {
        sourceInstanceId: source,
        direction: "inbound",
        action: `bundle.${(req.path.split("/").pop() || "")}`,
        error: "no_signing_key_for_source",
      });
      return res.status(401).json({ error: "unknown_peer" });
    }

    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const result = verifyRequest({
      method: req.method,
      path: req.originalUrl || req.url,
      body: rawBody,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      ),
      signingKey: creds.signing_key,
    });

    req.crossHostAuth = result;

    // Audit the validation attempt regardless of outcome. Handler path may
    // still fail (e.g. bundle missing) but the HMAC-validity fact is what
    // matters for the security log.
    await auditCrossHostCall(dbClient, {
      sourceInstanceId: source,
      direction: "inbound",
      action: `bundle.${(req.path.split("/").pop() || "")}`,
      bundleId: req.body?.bundle_id,
      hmacValid: result.valid,
      timestampSkewMs: result.timestampSkewMs,
      nonce: result.nonce,
      error: result.valid ? null : result.reason,
    });

    if (!result.valid) {
      return res.status(401).json({ error: result.reason });
    }

    return next();
  };
}
```

`servers/gateway/routes/federation.js:64–119` (verbatim):
```js
function federationVerifyMiddleware(dbClient) {
  return async (req, res, next) => {
    const sig = req.headers["x-crow-signature"];
    if (!sig) {
      return res.status(401).json({ error: "signature_required" });
    }
    const source = req.headers["x-crow-source"];
    if (!source) {
      return res.status(401).json({ error: "missing_x_crow_source" });
    }
    const creds = getPeerCreds(source);
    if (!creds || !creds.signing_key) {
      await auditCrossHostCall(dbClient, {
        sourceInstanceId: source,
        direction: "inbound",
        action: OVERVIEW_ACTION,
        error: "no_signing_key_for_source",
      });
      return res.status(401).json({ error: "unknown_peer" });
    }

    // Canonical body must match what the signer used. express.json() sets
    // req.body to {} for GETs with no body; treat that as the empty string
    // so signer-side and verifier-side hash the same bytes.
    const isEmptyObj = req.body && typeof req.body === "object"
      && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
    const rawBody = typeof req.body === "string"
      ? req.body
      : (isEmptyObj || !req.body ? "" : JSON.stringify(req.body));
    const result = verifyRequest({
      method: req.method,
      path: req.originalUrl || req.url,
      body: rawBody,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      ),
      signingKey: creds.signing_key,
    });

    req.crossHostAuth = result;

    await auditCrossHostCall(dbClient, {
      sourceInstanceId: source,
      direction: "inbound",
      action: OVERVIEW_ACTION,
      hmacValid: result.valid,
      error: result.valid ? null : result.reason,
      timestampSkewMs: result.timestampSkewMs,
    });

    if (!result.valid) {
      return res.status(401).json({ error: result.reason });
    }
    return next();
  };
}
```

**Difference analysis (drives the factory options):**
1. **No-signature:** bundles → `next()` (pass-through to session auth); federation → `401 {error:"signature_required"}`. → option `optional` (bundles `true`, federation `false`).
2. **Audit action:** bundles → dynamic `` `bundle.${(req.path.split("/").pop() || "")}` ``; federation → constant `"federation.overview"`. → option `audit` accepts a string or `(req) => string`.
3. **Empty-body canonicalization:** bundles serializes empty/absent parsed bodies as `"{}"` (`JSON.stringify(req.body || {})`); federation as `""`. These produce different HMACs — must stay per-caller. → option `emptyBodyString` (default `"{}"`, federation passes `""`). For non-empty objects both do `JSON.stringify(req.body)`; string bodies pass through unchanged in both.
4. **Post-verify audit row:** bundles additionally records `bundleId: req.body?.bundle_id` and `nonce: result.nonce`; federation records neither (and `auditCrossHostCall` writes `null` for absent fields). → option `auditBundleId` (bundles `true`).
5. Identical in both (preserved unconditionally): `401 {error:"missing_x_crow_source"}`; `401 {error:"unknown_peer"}` + no-creds audit row; `req.crossHostAuth = result`; lowercased single-valued header map; `401 {error: result.reason}` on invalid; `next()` on valid.

**Note on the spec's `req.crossHost = {...}` wording:** both existing copies set **`req.crossHostAuth`** and downstream handlers read it (`bundles.js:1836,1851`: `req.crossHostAuth?.sourceInstanceId`). Exact-behavior preservation wins: the factory sets `req.crossHostAuth` (the full `verifyRequest` result, which includes `sourceInstanceId`).

**Steps:**

- [ ] **4.1** In `servers/shared/cross-host-auth.js`, add this import directly below the existing `import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";` line (verified: `peer-credentials.js` imports only node builtins — no import cycle):
  ```js
  import { getPeerCreds } from "./peer-credentials.js";
  ```

- [ ] **4.2** Append this block at the **end** of `servers/shared/cross-host-auth.js` (after `auditCrossHostCall`):
  ```js
  // -----------------------------------------------------------------------
  // Express middleware factory (W2-1) — single implementation of the
  // verify-signature-or-reject logic previously duplicated inline in
  // routes/bundles.js and routes/federation.js.
  // -----------------------------------------------------------------------

  /**
   * Express middleware that verifies an inbound cross-host signed request.
   *
   * @param {object} dbClient  libsql client used ONLY for audit writes
   * @param {object} [opts]
   * @param {boolean} [opts.optional=false]
   *   true  → requests without X-Crow-Signature pass through (next()) so
   *           existing session/OAuth auth paths apply (bundles behavior).
   *   false → requests without X-Crow-Signature get 401 {error:"signature_required"}
   *           (federation behavior — the router is HMAC-only).
   * @param {string|((req)=>string)} [opts.audit=""]  audit-log action; a constant
   *   string ("federation.overview") or a per-request function
   *   (req => `bundle.${req.path.split("/").pop() || ""}`).
   * @param {boolean} [opts.auditBundleId=false]  when true, the post-verify
   *   audit row also records bundleId (req.body?.bundle_id) and the request
   *   nonce — bundles behavior. Federation rows leave both null.
   * @param {string} [opts.emptyBodyString="{}"]  canonical serialization of an
   *   empty/absent parsed JSON body. Bundles' signers hash "{}"; federation's
   *   signers hash "" for body-less GETs. Must match the signer or HMACs of
   *   empty-body requests fail.
   *
   * Behavior preserved exactly from both inline copies: status codes, error
   * strings, audit rows, and req.crossHostAuth = verifyRequest(...) result.
   */
  export function crossHostVerifyMiddleware(dbClient, {
    optional = false,
    audit = "",
    auditBundleId = false,
    emptyBodyString = "{}",
  } = {}) {
    const actionFor = typeof audit === "function" ? audit : () => audit;
    return async (req, res, next) => {
      const sig = req.headers["x-crow-signature"];
      if (!sig) {
        if (optional) return next(); // not a peer call — pass through
        return res.status(401).json({ error: "signature_required" });
      }

      const source = req.headers["x-crow-source"];
      if (!source) {
        return res.status(401).json({ error: "missing_x_crow_source" });
      }

      // Load shared signing_key from peer-tokens.json
      const creds = getPeerCreds(source);
      if (!creds || !creds.signing_key) {
        await auditCrossHostCall(dbClient, {
          sourceInstanceId: source,
          direction: "inbound",
          action: actionFor(req),
          error: "no_signing_key_for_source",
        });
        return res.status(401).json({ error: "unknown_peer" });
      }

      // Canonical body must match what the signer used. express.json() sets
      // req.body to {} for GETs with no body; emptyBodyString controls whether
      // that canonicalizes to "{}" (bundles) or "" (federation).
      const isEmptyObj = req.body && typeof req.body === "object"
        && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
      const rawBody = typeof req.body === "string"
        ? req.body
        : (isEmptyObj || !req.body ? emptyBodyString : JSON.stringify(req.body));

      const result = verifyRequest({
        method: req.method,
        path: req.originalUrl || req.url,
        body: rawBody,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
        ),
        signingKey: creds.signing_key,
      });

      req.crossHostAuth = result;

      // Audit the validation attempt regardless of outcome. Handler path may
      // still fail (e.g. bundle missing) but the HMAC-validity fact is what
      // matters for the security log.
      await auditCrossHostCall(dbClient, {
        sourceInstanceId: source,
        direction: "inbound",
        action: actionFor(req),
        ...(auditBundleId ? { bundleId: req.body?.bundle_id, nonce: result.nonce } : {}),
        hmacValid: result.valid,
        timestampSkewMs: result.timestampSkewMs,
        error: result.valid ? null : result.reason,
      });

      if (!result.valid) {
        return res.status(401).json({ error: result.reason });
      }

      return next();
    };
  }
  ```

- [ ] **4.3** Create `tests/cross-host-middleware.test.js` with exactly this content (pattern follows `tests/federation-overview.test.js`: peer creds staged via `CROW_PEER_TOKENS_PATH` **before** the module import, real HMAC signing via `signRequest` for the good-signature tests):
  ```js
  import { test, before, after } from "node:test";
  import assert from "node:assert/strict";
  import express from "express";
  import { writeFileSync, chmodSync, unlinkSync, mkdtempSync } from "node:fs";
  import { join } from "node:path";
  import { tmpdir } from "node:os";

  const TEST_SOURCE_ID = "test-peer-mw-1";
  const TEST_AUTH_TOKEN = "cc".repeat(32); // 64 hex chars
  const TEST_SIGNING_KEY = "dd".repeat(32); // 64 hex chars

  // Stage peer-tokens.json BEFORE the module import — the path is cached at load.
  const tmpDir = mkdtempSync(join(tmpdir(), "crow-xhost-mw-test-"));
  const peerTokensPath = join(tmpDir, "peer-tokens.json");
  writeFileSync(peerTokensPath, JSON.stringify({
    [TEST_SOURCE_ID]: {
      auth_token: TEST_AUTH_TOKEN,
      signing_key: TEST_SIGNING_KEY,
      inbound_token: TEST_AUTH_TOKEN,
      created_at: new Date().toISOString(),
      rotated_at: null,
    },
  }), { mode: 0o600 });
  chmodSync(peerTokensPath, 0o600);
  process.env.CROW_PEER_TOKENS_PATH = peerTokensPath;

  const { signRequest, _resetNonceCache, crossHostVerifyMiddleware } =
    await import("../servers/shared/cross-host-auth.js");

  // Audit sink: capture every db.execute the middleware issues.
  const auditStmts = [];
  const fakeDb = {
    execute: async (stmt) => { auditStmts.push(stmt); return { rows: [], rowsAffected: 1 }; },
    close: () => {},
  };

  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());

    // federation-style: signature required, empty body canonicalizes to ""
    app.get(
      "/required",
      crossHostVerifyMiddleware(fakeDb, { optional: false, audit: "test.required", emptyBodyString: "" }),
      (req, res) => res.json({ reached: true, valid: req.crossHostAuth?.valid === true }),
    );

    // bundles-style: signature optional (pass-through), empty body → "{}"
    app.post(
      "/optional",
      crossHostVerifyMiddleware(fakeDb, {
        optional: true,
        audit: (req) => `bundle.${req.path.split("/").pop() || ""}`,
        auditBundleId: true,
      }),
      (req, res) => res.json({ reached: true, crossHost: req.crossHostAuth || null }),
    );

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try { unlinkSync(peerTokensPath); } catch {}
  });

  test("required mode: no signature → 401 signature_required", async () => {
    const r = await fetch(`${baseUrl}/required`);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "signature_required");
  });

  test("optional mode: no signature → passes through to the handler", async () => {
    const r = await fetch(`${baseUrl}/optional`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle_id: "demo" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.reached, true);
    assert.equal(body.crossHost, null); // middleware never set req.crossHostAuth
  });

  test("signature present but X-Crow-Source missing → 401 missing_x_crow_source", async () => {
    const r = await fetch(`${baseUrl}/required`, {
      headers: {
        "X-Crow-Signature": "ab".repeat(32),
        "X-Crow-Timestamp": String(Date.now()),
        "X-Crow-Nonce": "0".repeat(32),
      },
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "missing_x_crow_source");
  });

  test("unknown peer → 401 unknown_peer + audit row written", async () => {
    const auditCountBefore = auditStmts.length;
    const r = await fetch(`${baseUrl}/required`, {
      headers: {
        "X-Crow-Signature": "ab".repeat(32),
        "X-Crow-Timestamp": String(Date.now()),
        "X-Crow-Nonce": "0".repeat(32),
        "X-Crow-Source": "nobody-knows-me",
      },
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "unknown_peer");
    assert.ok(auditStmts.length > auditCountBefore, "expected an audit INSERT");
    assert.match(auditStmts[auditStmts.length - 1].sql, /INSERT INTO cross_host_calls/);
  });

  test("bad signature (path tampered) → 401 hmac_mismatch", async () => {
    _resetNonceCache();
    const headers = signRequest({
      method: "GET",
      path: "/required",
      body: "",
      authToken: TEST_AUTH_TOKEN,
      signingKey: TEST_SIGNING_KEY,
      sourceInstanceId: TEST_SOURCE_ID,
    });
    const r = await fetch(`${baseUrl}/required?tampered=1`, { headers });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "hmac_mismatch");
  });

  test("valid signed GET in required mode → 200, req.crossHostAuth.valid", async () => {
    _resetNonceCache();
    const headers = signRequest({
      method: "GET",
      path: "/required",
      body: "",
      authToken: TEST_AUTH_TOKEN,
      signingKey: TEST_SIGNING_KEY,
      sourceInstanceId: TEST_SOURCE_ID,
    });
    const r = await fetch(`${baseUrl}/required`, { headers });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.reached, true);
    assert.equal(body.valid, true);
  });

  test("valid signed POST in optional mode → 200, crossHostAuth carries source", async () => {
    _resetNonceCache();
    const rawBody = JSON.stringify({ bundle_id: "demo-bundle" });
    const headers = signRequest({
      method: "POST",
      path: "/optional",
      body: rawBody,
      authToken: TEST_AUTH_TOKEN,
      signingKey: TEST_SIGNING_KEY,
      sourceInstanceId: TEST_SOURCE_ID,
    });
    const r = await fetch(`${baseUrl}/optional`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: rawBody,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.reached, true);
    assert.equal(body.crossHost.valid, true);
    assert.equal(body.crossHost.sourceInstanceId, TEST_SOURCE_ID);
  });
  ```

- [ ] **4.4** Run:
  ```bash
  node --check servers/shared/cross-host-auth.js
  node --test tests/cross-host-middleware.test.js
  node --test tests/
  ```
  Expected: new file prints `# pass 7` / `# fail 0`; full suite prints `# pass 360` / `# fail 0`.

- [ ] **4.5 Commit:**
  ```bash
  git add tests/cross-host-middleware.test.js
  git commit servers/shared/cross-host-auth.js tests/cross-host-middleware.test.js -m "W2-1: shared crossHostVerifyMiddleware factory in cross-host-auth (+7 tests)"
  git show --stat HEAD
  ```

---

## Task 5 — Replace both inline HMAC middlewares with the shared factory

**Files:** edit: `servers/gateway/routes/bundles.js`, `servers/gateway/routes/federation.js`

**Steps:**

- [ ] **5.1 `bundles.js` imports.** Replace:
  ```js
  import { verifyRequest, auditCrossHostCall } from "../../shared/cross-host-auth.js";
  import { getPeerCreds } from "../../shared/peer-credentials.js";
  ```
  with:
  ```js
  import { auditCrossHostCall, crossHostVerifyMiddleware } from "../../shared/cross-host-auth.js";
  ```
  (`verifyRequest` and `getPeerCreds` were used ONLY inside the inline middleware — verified by grep; `auditCrossHostCall` is still used by `dispatchBundleAction`.)

- [ ] **5.2 `bundles.js`: delete the inline copy.** Delete the entire block from (and including) this comment:
  ```js
  /**
   * Express middleware that verifies an inbound cross-host signed request.
   * Mounted on bundle action routes so only cross-host peers can hit them
   * WITHOUT dashboardAuth — local (same-origin) callers continue to rely on
   * dashboardAuth or OAuth. Peer calls short-circuit those via HMAC.
   *
   * Sets req.crossHostAuth = { valid, sourceInstanceId, ... }.
   * Non-signed requests are passed through (next()) so existing auth paths apply.
   */
  function crossHostVerifyMiddleware(dbClient) {
  ```
  through the function's closing `}` (the full verbatim body is quoted in Task 4; it ends with `  };\n}` immediately before `function resolvePanelPath(manifest, bundleId) {`).

- [ ] **5.3 `bundles.js`: instantiate via the factory.** Replace:
  ```js
  const dbForXhost = createDbClient();
  const xhostVerify = crossHostVerifyMiddleware(dbForXhost);
  ```
  with:
  ```js
  const dbForXhost = createDbClient();
  const xhostVerify = crossHostVerifyMiddleware(dbForXhost, {
    optional: true, // non-signed requests fall through to dashboardAuth/OAuth
    audit: (req) => `bundle.${(req.path.split("/").pop() || "")}`,
    auditBundleId: true,
    // emptyBodyString stays at the default "{}" — bundle signers hash JSON.stringify(body || {})
  });
  ```

- [ ] **5.4 `federation.js` imports.** Replace:
  ```js
  import { verifyRequest, auditCrossHostCall } from "../../shared/cross-host-auth.js";
  import { getPeerCreds } from "../../shared/peer-credentials.js";
  ```
  with:
  ```js
  import { crossHostVerifyMiddleware } from "../../shared/cross-host-auth.js";
  ```

- [ ] **5.5 `federation.js`: delete the inline copy.** Delete the line:
  ```js
  const OVERVIEW_ACTION = "federation.overview";
  ```
  and the entire block from (and including):
  ```js
  /**
   * Inbound HMAC verification middleware scoped to federation routes. Mirrors
   * the one in routes/bundles.js but uses `federation.overview` as the audit
   * action instead of `bundle.*`. Non-signed requests pass through to 404 —
   * the router is HMAC-only.
   */
  function federationVerifyMiddleware(dbClient) {
  ```
  through the function's closing `}` (verbatim body quoted in Task 4; the next remaining code is the `loadInstalledBundles` doc comment).

- [ ] **5.6 `federation.js`: instantiate once, reuse three times.** Replace:
  ```js
  export default function federationRouter({ createDbClient }) {
    const router = Router();
    const dbForAudit = createDbClient();
  ```
  with:
  ```js
  export default function federationRouter({ createDbClient }) {
    const router = Router();
    const dbForAudit = createDbClient();

    // HMAC-only gate for every federation route. Required signature (no
    // session path), audit action "federation.overview", and empty bodies
    // canonicalize to "" because the federation signer hashes "" for
    // body-less GETs (see signedHeaders in tests/federation-overview.test.js).
    const federationVerify = crossHostVerifyMiddleware(dbForAudit, {
      optional: false,
      audit: "federation.overview",
      emptyBodyString: "",
    });
  ```
  Then replace each of the three usages:
  - `router.get("/overview", federationVerifyMiddleware(dbForAudit), async (req, res) => {` → `router.get("/overview", federationVerify, async (req, res) => {`
  - `router.get("/capabilities", federationVerifyMiddleware(dbForAudit), async (req, res) => {` → `router.get("/capabilities", federationVerify, async (req, res) => {`
  - `router.use("/", botFederationRouter({ createDbClient, verifyMiddleware: federationVerifyMiddleware(dbForAudit) }));` → `router.use("/", botFederationRouter({ createDbClient, verifyMiddleware: federationVerify }));`

- [ ] **5.7** Verify and run (the federation + bot-federation + sso suites are the end-to-end regression net for this refactor — they sign real requests through this middleware):
  ```bash
  node --check servers/gateway/routes/bundles.js
  node --check servers/gateway/routes/federation.js
  grep -n "verifyRequest\|getPeerCreds\|federationVerifyMiddleware" servers/gateway/routes/bundles.js servers/gateway/routes/federation.js
  node --test tests/federation-overview.test.js
  node --test tests/
  ```
  Expected: grep prints **nothing**; federation test green; full suite `# pass 360` / `# fail 0`.

- [ ] **5.8 Commit:**
  ```bash
  git commit servers/gateway/routes/bundles.js servers/gateway/routes/federation.js -m "W2-1: bundles + federation use shared crossHostVerifyMiddleware; delete both inline copies"
  git show --stat HEAD
  ```

---

## Task 6 — Rate-limit factory module + tests

**Files:**
- new: `servers/gateway/middleware/rate-limit.js`
- new: `tests/rate-limit-middleware.test.js`

**Context (verified):** `blog-embed-api.js` uses `express-rate-limit` **v8** (package.json pins ^8.3.0; `max` remains a supported alias) with dynamic `max`/`keyGenerator` functions (tiers: tailscale-user-login → 600/min keyed `tsuser:<login lowercase>`; funnel → 200/min keyed `funnel:shared`; else 1200/min keyed `ip:<ipKeyGenerator(req.ip)>`; `standardHeaders: true`, `legacyHeaders: false`, `message: { error: "Too many requests" }`). `chat.js:36–50` and `bot-chat.js:26–29,171–180` each hand-roll the identical Map limiter: lazy window reset when `(now - windowStart) > windowMs` (strictly greater), increment-then-compare `count <= max`, no pruning. The factory preserves those exact semantics and adds an injectable `now()` plus an optional periodic prune.

**Steps:**

- [ ] **6.1** Create `servers/gateway/middleware/rate-limit.js` with exactly this content:
  ```js
  /**
   * Shared rate-limit factories for gateway routes (W2-1).
   *
   * Two flavors:
   *   - tieredRateLimit: wraps express-rate-limit v8 with an ordered tier
   *     list (first matching tier wins) — extracted from blog-embed-api.js.
   *   - fixedWindowLimit: in-process Map-based fixed window with lazy reset —
   *     formalizes the hand-rolled limiters previously in chat.js/bot-chat.js.
   *     Exact legacy semantics preserved: window resets when
   *     (now - windowStart) > windowMs (strictly greater), and the check is
   *     increment-then-compare (count <= max).
   *
   * Both accept an injectable `now` for tests (fixedWindowLimit) / pure
   * tier-picking (pickTier) so no fake timers are needed.
   */

  import rateLimit from "express-rate-limit";

  /**
   * Pick the first tier whose match(req) is truthy; a tier without `match`
   * always matches (use as the final fallback). Exported for tests.
   *
   * @param {Array<{match?: (req)=>boolean, key: (req)=>string, max: number}>} tiers
   * @param {object} req
   */
  export function pickTier(tiers, req) {
    for (const t of tiers) {
      if (!t.match || t.match(req)) return t;
    }
    return tiers[tiers.length - 1];
  }

  /**
   * Tiered express-rate-limit middleware. Behavior-identical wrapper: the
   * picked tier supplies both the per-window max and the bucket key.
   *
   * @param {object} opts
   * @param {number} [opts.windowMs=60000]
   * @param {Array<{match?: (req)=>boolean, key: (req)=>string, max: number}>} opts.tiers
   * @param {object} [opts.message={ error: "Too many requests" }]  429 body
   */
  export function tieredRateLimit({ windowMs = 60 * 1000, tiers, message = { error: "Too many requests" } }) {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new Error("tieredRateLimit requires a non-empty tiers array");
    }
    return rateLimit({
      windowMs,
      max: (req) => pickTier(tiers, req).max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => pickTier(tiers, req).key(req),
      message,
    });
  }

  /**
   * Fixed-window in-process limiter.
   *
   * Returns an Express middleware function that also exposes:
   *   .check(key)  — raw check for handlers that gate mid-route (chat,
   *                  bot-chat keep their original response ordering: 404/409
   *                  checks still run before the 429).
   *   .prune()     — drop expired buckets (also runs on an interval unless
   *                  pruneIntervalMs is 0).
   *
   * @param {object} opts
   * @param {number} opts.max               requests per window
   * @param {number} opts.windowMs          window length in ms
   * @param {(req)=>string} [opts.keyGenerator]  middleware key (default req.ip || "unknown")
   * @param {object} [opts.message={ error: "Too many requests" }]  middleware 429 body
   * @param {()=>number} [opts.now=Date.now]  injectable clock for tests
   * @param {number} [opts.pruneIntervalMs=300000]  0 disables the interval
   */
  export function fixedWindowLimit({
    max,
    windowMs,
    keyGenerator = (req) => req.ip || "unknown",
    message = { error: "Too many requests" },
    now = Date.now,
    pruneIntervalMs = 5 * 60 * 1000,
  }) {
    /** key → { count, windowStart } */
    const buckets = new Map();

    function check(key) {
      const t = now();
      let entry = buckets.get(key);
      if (!entry || (t - entry.windowStart) > windowMs) {
        entry = { count: 0, windowStart: t };
        buckets.set(key, entry);
      }
      entry.count++;
      return entry.count <= max;
    }

    function prune() {
      const t = now();
      for (const [key, entry] of buckets) {
        if ((t - entry.windowStart) > windowMs) buckets.delete(key);
      }
    }

    if (pruneIntervalMs > 0) {
      const timer = setInterval(prune, pruneIntervalMs);
      timer.unref?.();
    }

    function middleware(req, res, next) {
      if (!check(keyGenerator(req))) {
        return res.status(429).json(message);
      }
      next();
    }
    middleware.check = check;
    middleware.prune = prune;
    middleware._buckets = buckets; // test introspection only
    return middleware;
  }
  ```

- [ ] **6.2** Create `tests/rate-limit-middleware.test.js` with exactly this content:
  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { fixedWindowLimit, tieredRateLimit, pickTier } from "../servers/gateway/middleware/rate-limit.js";

  function mkRes() {
    return {
      statusCode: null,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }

  test("fixedWindowLimit.check: allows max requests, blocks max+1", () => {
    let t = 1_000_000;
    const limiter = fixedWindowLimit({ max: 3, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
    assert.equal(limiter.check("k"), true);
    assert.equal(limiter.check("k"), true);
    assert.equal(limiter.check("k"), true);
    assert.equal(limiter.check("k"), false); // 4th in window → blocked
  });

  test("fixedWindowLimit.check: resets only when strictly past the window (legacy semantics)", () => {
    let t = 0;
    const limiter = fixedWindowLimit({ max: 1, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
    assert.equal(limiter.check("k"), true);
    assert.equal(limiter.check("k"), false);
    t = 60_000; // (now - windowStart) === windowMs → NOT reset (legacy used strict >)
    assert.equal(limiter.check("k"), false);
    t = 60_001; // strictly past → fresh window
    assert.equal(limiter.check("k"), true);
  });

  test("fixedWindowLimit.check: keys are independent", () => {
    let t = 5_000;
    const limiter = fixedWindowLimit({ max: 1, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
    assert.equal(limiter.check("a"), true);
    assert.equal(limiter.check("a"), false);
    assert.equal(limiter.check("b"), true); // different key unaffected
  });

  test("fixedWindowLimit middleware: 429 with the configured body when over limit", () => {
    let t = 0;
    const message = { error: "Rate limited — max 10 messages per minute" };
    const mw = fixedWindowLimit({
      max: 1, windowMs: 60_000, keyGenerator: (req) => req.ip || "unknown",
      message, now: () => t, pruneIntervalMs: 0,
    });
    const req = { ip: "100.64.0.9" };

    let nexted = false;
    const res1 = mkRes();
    mw(req, res1, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res1.statusCode, null);

    nexted = false;
    const res2 = mkRes();
    mw(req, res2, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(res2.statusCode, 429);
    assert.deepEqual(res2.body, message);
  });

  test("fixedWindowLimit.prune: drops expired buckets", () => {
    let t = 0;
    const limiter = fixedWindowLimit({ max: 5, windowMs: 60_000, now: () => t, pruneIntervalMs: 0 });
    limiter.check("stale");
    t = 120_000;
    limiter.check("fresh");
    limiter.prune();
    assert.equal(limiter._buckets.has("stale"), false);
    assert.equal(limiter._buckets.has("fresh"), true);
  });

  test("pickTier: blog-embed tier selection and keys", () => {
    const tiers = [
      {
        match: (req) => !!req.headers["tailscale-user-login"],
        key: (req) => `tsuser:${String(req.headers["tailscale-user-login"]).toLowerCase()}`,
        max: 600,
      },
      {
        match: (req) => !!req.headers["tailscale-funnel-request"],
        key: () => "funnel:shared",
        max: 200,
      },
      { key: (req) => `ip:${req.ip || ""}`, max: 1200 },
    ];

    const tsReq = { headers: { "tailscale-user-login": "Alice@Example.com" } };
    assert.equal(pickTier(tiers, tsReq).max, 600);
    assert.equal(pickTier(tiers, tsReq).key(tsReq), "tsuser:alice@example.com");

    const funnelReq = { headers: { "tailscale-funnel-request": "?1" } };
    assert.equal(pickTier(tiers, funnelReq).max, 200);
    assert.equal(pickTier(tiers, funnelReq).key(funnelReq), "funnel:shared");

    const lanReq = { headers: {}, ip: "192.168.1.20" };
    assert.equal(pickTier(tiers, lanReq).max, 1200);
    assert.equal(pickTier(tiers, lanReq).key(lanReq), "ip:192.168.1.20");

    // tieredRateLimit constructs a real middleware from the same tiers
    const mw = tieredRateLimit({ windowMs: 60_000, tiers, message: { error: "Too many requests" } });
    assert.equal(typeof mw, "function");
  });
  ```

- [ ] **6.3** Run:
  ```bash
  node --check servers/gateway/middleware/rate-limit.js
  node --test tests/rate-limit-middleware.test.js
  node --test tests/
  ```
  Expected: new file `# pass 6` / `# fail 0`; full suite `# pass 366` / `# fail 0`.

- [ ] **6.4 Commit:**
  ```bash
  git add servers/gateway/middleware/rate-limit.js tests/rate-limit-middleware.test.js
  git commit servers/gateway/middleware/rate-limit.js tests/rate-limit-middleware.test.js -m "W2-1: rate-limit factory (tieredRateLimit + fixedWindowLimit, injectable clock) +6 tests"
  git show --stat HEAD
  ```

---

## Task 7 — Migrate blog-embed-api, chat, bot-chat to the factory (behavior-identical)

**Files:** edit: `servers/gateway/routes/blog-embed-api.js`, `servers/gateway/routes/chat.js`, `servers/gateway/routes/bot-chat.js`

**Steps:**

- [ ] **7.1 `blog-embed-api.js`.** Replace the import line:
  ```js
  import rateLimit, { ipKeyGenerator } from "express-rate-limit";
  ```
  with:
  ```js
  import { ipKeyGenerator } from "express-rate-limit";
  import { tieredRateLimit } from "../middleware/rate-limit.js";
  ```
  Then replace this entire block (functions + limiter, currently lines 58–85):
  ```js
  function embedApiKey(req) {
    const login = req.headers["tailscale-user-login"];
    if (login) return `tsuser:${String(login).toLowerCase()}`;
    const funnel = req.headers["tailscale-funnel-request"];
    if (funnel) return "funnel:shared";
    return `ip:${ipKeyGenerator(req.ip || "")}`;
  }

  function embedApiMax(req) {
    // Budget per 60-second window. Each chapter hydrate fetches
    // config.json + data.json for every chart (~2× chart count) + 1
    // geojson per map — Ch 4D Cleveland alone is 30 × 2 + 5 = 65 calls
    // on a fresh load. Previous 60/min ceiling caused widespread 429s
    // and alt-text-only rendering. Numbers below accommodate 1–2 chapter
    // loads per minute comfortably.
    if (req.headers["tailscale-user-login"]) return 600;
    if (req.headers["tailscale-funnel-request"]) return 200;
    return 1200;
  }

  const embedLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: embedApiMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: embedApiKey,
    message: { error: "Too many requests" },
  });
  ```
  with:
  ```js
  // Budget per 60-second window. Each chapter hydrate fetches
  // config.json + data.json for every chart (~2× chart count) + 1
  // geojson per map — Ch 4D Cleveland alone is 30 × 2 + 5 = 65 calls
  // on a fresh load. Previous 60/min ceiling caused widespread 429s
  // and alt-text-only rendering. Numbers below accommodate 1–2 chapter
  // loads per minute comfortably. First matching tier wins.
  const embedLimiter = tieredRateLimit({
    windowMs: 60 * 1000,
    tiers: [
      {
        match: (req) => !!req.headers["tailscale-user-login"],
        key: (req) => `tsuser:${String(req.headers["tailscale-user-login"]).toLowerCase()}`,
        max: 600,
      },
      {
        match: (req) => !!req.headers["tailscale-funnel-request"],
        key: () => "funnel:shared",
        max: 200,
      },
      { key: (req) => `ip:${ipKeyGenerator(req.ip || "")}`, max: 1200 },
    ],
    message: { error: "Too many requests" },
  });
  ```

- [ ] **7.2 `chat.js`.** Add to the import block (after `import { chooseProvider as smartRoute, stripSlashCommand, SmartChatDisabled } from "../ai/smart-router.js";`):
  ```js
  import { fixedWindowLimit } from "../middleware/rate-limit.js";
  ```
  Replace this block (lines 36–50):
  ```js
  /** Rate limiter state: sessionToken → { count, windowStart } */
  const rateLimits = new Map();
  const RATE_LIMIT_MAX = 10;
  const RATE_LIMIT_WINDOW_MS = 60 * 1000;

  function checkRateLimit(sessionToken) {
    const now = Date.now();
    let entry = rateLimits.get(sessionToken);
    if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      rateLimits.set(sessionToken, entry);
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }
  ```
  with:
  ```js
  /** Rate limiter: 10 messages / 60s, keyed by req.ip (legacy key name: sessionToken) */
  const messageRateLimit = fixedWindowLimit({ max: 10, windowMs: 60 * 1000 });
  ```
  Replace the call site:
  ```js
      // Rate limiting
      const sessionToken = req.ip || "unknown";
      if (!checkRateLimit(sessionToken)) {
        return res.status(429).json({ error: "Rate limited — max 10 messages per minute" });
      }
  ```
  with:
  ```js
      // Rate limiting
      const sessionToken = req.ip || "unknown";
      if (!messageRateLimit.check(sessionToken)) {
        return res.status(429).json({ error: "Rate limited — max 10 messages per minute" });
      }
  ```

- [ ] **7.3 `bot-chat.js`.** Add to the import block (after `import { getObject } from "../../storage/s3-client.js";`):
  ```js
  import { fixedWindowLimit } from "../middleware/rate-limit.js";
  ```
  Replace:
  ```js
  /** Rate limiter: botId → { count, windowStart } */
  const rateLimits = new Map();
  const RATE_LIMIT_MAX = 10;
  const RATE_LIMIT_WINDOW_MS = 60 * 1000;
  const MAX_MESSAGE_BYTES = 10 * 1024;
  ```
  with:
  ```js
  /** Rate limiter: 10 messages / 60s per botId */
  const botMessageRateLimit = fixedWindowLimit({ max: 10, windowMs: 60 * 1000 });
  const MAX_MESSAGE_BYTES = 10 * 1024;
  ```
  Delete this function entirely (lines 171–180):
  ```js
  function checkRateLimit(botId) {
    const now = Date.now();
    let entry = rateLimits.get(botId);
    if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      rateLimits.set(botId, entry);
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }
  ```
  Replace the call site (NOTE: it stays where it is, AFTER the bot 404/409 checks — response ordering is a behavior contract):
  ```js
        if (!checkRateLimit(botId)) {
          return res.status(429).json({ error: "Rate limit exceeded (10 msg/min)" });
        }
  ```
  with:
  ```js
        if (!botMessageRateLimit.check(botId)) {
          return res.status(429).json({ error: "Rate limit exceeded (10 msg/min)" });
        }
  ```

- [ ] **7.4** Verify and run:
  ```bash
  node --check servers/gateway/routes/blog-embed-api.js
  node --check servers/gateway/routes/chat.js
  node --check servers/gateway/routes/bot-chat.js
  grep -n "checkRateLimit\|RATE_LIMIT_MAX\|embedApiKey\|embedApiMax" servers/gateway/routes/blog-embed-api.js servers/gateway/routes/chat.js servers/gateway/routes/bot-chat.js
  node --test tests/
  ```
  Expected: grep prints **nothing**; suite `# pass 366` / `# fail 0`.

- [ ] **7.5 Commit:**
  ```bash
  git commit servers/gateway/routes/blog-embed-api.js servers/gateway/routes/chat.js servers/gateway/routes/bot-chat.js -m "W2-1: migrate blog-embed-api/chat/bot-chat to shared rate-limit factory (same tiers, keys, windows, 429 bodies)"
  git show --stat HEAD
  ```

---

## Task 8 — Extension-proxy WebSocket auth (security fix) + tests

**Files:**
- edit: `servers/gateway/routes/extension-proxy.js`
- new: `tests/extension-ws-auth.test.js`

**Context (verified):** `setupWebSocket(server)` registers `server.on("upgrade", ...)` and calls `proxyMiddleware.upgrade(req, socket, head)` with **no auth** — `server.on("upgrade")` bypasses Express, so the `authMiddleware` mounted on the HTTP routes never runs. `servers/gateway/dashboard/auth.js` exports (verified signatures): `parseCookies(req)` (named export, sync, returns `{name: value}` map) and `verifySession(token)` (async, returns boolean; short-circuits `if (!token) return false` **before** opening the DB). The session cookie name is the non-exported constant `crow_session`. Precedent: `calls-signaling.js` rejects unauthorized upgrades with `socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy();` at connect time.

**Steps:**

- [ ] **8.1** In `extension-proxy.js`, add to the import block (after `import { homedir } from "node:os";`):
  ```js
  import { isAllowedNetwork, parseCookies, verifySession } from "../dashboard/auth.js";
  ```

- [ ] **8.2** Insert this exported function immediately before `export default function extensionProxyFactory(authMiddleware) {`:
  ```js
  /**
   * Authorize a WebSocket upgrade for /proxy/<id> paths (W2-1 security fix).
   *
   * server.on("upgrade") bypasses Express entirely, so the dashboardAuth
   * middleware mounted on the HTTP routes never runs for WS — previously an
   * unauthenticated LAN/tailnet client could reach extension web UIs
   * (including noVNC) over WS. Mirror the layers here:
   *   1. Network gate — isAllowedNetwork (funnel reject + private-network
   *      allowlist), exactly the layer the HTTP routes get via dashboardAuth.
   *   2. Session check — the crow_session cookie must be a live dashboard
   *      session (verifySession; DB-backed).
   *
   * @param {import('http').IncomingMessage} req  raw upgrade request
   * @returns {Promise<boolean>} true only when the upgrade may proceed
   */
  export async function authorizeExtensionUpgrade(req) {
    // Layer parity with the HTTP gate: isAllowedNetwork covers the funnel
    // reject AND the network allowlist (loopback reject, private-IP ranges,
    // CROW_DASHBOARD_PUBLIC) — it reads req.headers + req.connection, both
    // present on a raw upgrade request.
    if (!isAllowedNetwork(req)) return false;
    const token = parseCookies(req)["crow_session"];
    if (!token) return false;
    try {
      return (await verifySession(token)) === true;
    } catch {
      return false;
    }
  }
  ```

- [ ] **8.3** Replace the `setupWebSocket` function body:
  ```js
    function setupWebSocket(server) {
      if (proxyInstances.length === 0) return;

      server.on("upgrade", (req, socket, head) => {
        for (const { proxyPath, proxyMiddleware } of proxyInstances) {
          if (req.url?.startsWith(proxyPath)) {
            proxyMiddleware.upgrade(req, socket, head);
            return;
          }
        }
      });

      console.log(`  [proxy] WebSocket upgrade handler registered for ${proxyInstances.length} extension(s)`);
    }
  ```
  with:
  ```js
    function setupWebSocket(server) {
      if (proxyInstances.length === 0) return;

      server.on("upgrade", (req, socket, head) => {
        for (const { proxyPath, proxyMiddleware } of proxyInstances) {
          if (req.url?.startsWith(proxyPath)) {
            // W2-1: upgrades bypass Express, so enforce dashboard auth here.
            authorizeExtensionUpgrade(req).then((ok) => {
              if (!ok) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
              }
              proxyMiddleware.upgrade(req, socket, head);
            }).catch(() => {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
            });
            return;
          }
        }
      });

      console.log(`  [proxy] WebSocket upgrade handler registered for ${proxyInstances.length} extension(s) (session-gated)`);
    }
  ```

- [ ] **8.4** Create `tests/extension-ws-auth.test.js` with exactly this content. **Scope note:** these tests cover only the rejection paths (funnel header, disallowed network, missing/irrelevant cookie) — all three return `false` without touching the DB (`verifySession` short-circuits on a falsy token, and the funnel/missing-cookie branches return before calling it). A positive "valid session → true" test would require seeding `oauth_tokens` in a real DB and is deliberately out of scope; the wiring is exercised at boot (Task 10 boot check) and the function is 12 lines of straight-line code over two already-tested primitives.
  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { authorizeExtensionUpgrade } from "../servers/gateway/routes/extension-proxy.js";

  // Rejection paths only — none of these touch the DB:
  //  - funnel header → rejected before any cookie parsing
  //  - no/irrelevant cookies → rejected before verifySession opens the DB
  //    (verifySession itself short-circuits on a falsy token).

  test("ws auth: funneled upgrade is rejected even with a session cookie", async () => {
    const ok = await authorizeExtensionUpgrade({
      headers: {
        "tailscale-funnel-request": "?1",
        cookie: "crow_session=abc123",
      },
    });
    assert.equal(ok, false);
  });

  // For the cookie-path tests, give the request an allowed-network identity
  // (tailnet CGNAT ip) so isAllowedNetwork passes and the cookie branch is
  // actually exercised.
  function tailnetReq(headers = {}) {
    return { headers, ip: "100.64.0.5", connection: { remoteAddress: "100.64.0.5" } };
  }

  test("ws auth: allowed network but no cookies is rejected", async () => {
    assert.equal(await authorizeExtensionUpgrade(tailnetReq()), false);
  });

  test("ws auth: allowed network with unrelated cookies (no crow_session) is rejected", async () => {
    const ok = await authorizeExtensionUpgrade(tailnetReq({ cookie: "theme=dark; csrf=xyz" }));
    assert.equal(ok, false);
  });

  test("ws auth: disallowed network is rejected even WITH a session cookie", async () => {
    const ok = await authorizeExtensionUpgrade({
      headers: { cookie: "crow_session=abc123" },
      ip: "8.8.8.8",
      connection: { remoteAddress: "8.8.8.8" },
    });
    assert.equal(ok, false);
  });
  ```

- [ ] **8.5** Run:
  ```bash
  node --check servers/gateway/routes/extension-proxy.js
  node --test tests/extension-ws-auth.test.js
  node --test tests/
  ```
  Expected: new file `# pass 4` / `# fail 0`; full suite `# pass 370` / `# fail 0`.

- [ ] **8.6 Commit:**
  ```bash
  git add tests/extension-ws-auth.test.js
  git commit servers/gateway/routes/extension-proxy.js tests/extension-ws-auth.test.js -m "W2-1 security: extension-proxy WS upgrades require a live dashboard session and reject funneled requests"
  git show --stat HEAD
  ```

---

## Task 9 — Prefix-level auth tidy: `push.js` + `settings-scope.js`

**Files:** edit: `servers/gateway/routes/push.js`, `servers/gateway/routes/settings-scope.js`

**Context (verified):** `push.js` has exactly 5 routes, every one under `/api/push/` and every one currently passing `authMiddleware` per-handler (`/api/push/vapid-key`, `POST+DELETE /api/push/register`, `/api/push/notifications`, `/api/push/ntfy-config`) — none is intentionally public. `settings-scope.js` has exactly 2 routes, both `/api/settings/scope`, both per-handler authed. Both factories receive `dashboardAuth` from `index.js` (lines 995, 1004). Converting to prefix-level `router.use` is semantically identical (same middleware, same paths).

**Steps:**

- [ ] **9.1 `push.js`.** Replace:
  ```js
  export default function pushRouter(authMiddleware) {
    const router = Router();

    // GET /api/push/vapid-key — public key for PushManager.subscribe()
    router.get("/api/push/vapid-key", authMiddleware, (req, res) => {
  ```
  with:
  ```js
  export default function pushRouter(authMiddleware) {
    const router = Router();

    // Every push route is private — auth the whole prefix (W2-1 tidy).
    router.use("/api/push", authMiddleware);

    // GET /api/push/vapid-key — public key for PushManager.subscribe()
    router.get("/api/push/vapid-key", (req, res) => {
  ```
  Then remove `authMiddleware, ` from the remaining 4 handlers:
  - `router.post("/api/push/register", authMiddleware, async (req, res) => {` → `router.post("/api/push/register", async (req, res) => {`
  - `router.delete("/api/push/register", authMiddleware, async (req, res) => {` → `router.delete("/api/push/register", async (req, res) => {`
  - `router.get("/api/push/notifications", authMiddleware, async (req, res) => {` → `router.get("/api/push/notifications", async (req, res) => {`
  - `router.get("/api/push/ntfy-config", authMiddleware, (req, res) => {` → `router.get("/api/push/ntfy-config", (req, res) => {`

- [ ] **9.2 `settings-scope.js`.** Replace:
  ```js
  export default function settingsScopeRouter(authMiddleware) {
    const router = Router();

    router.get("/api/settings/scope", authMiddleware, async (req, res) => {
  ```
  with:
  ```js
  export default function settingsScopeRouter(authMiddleware) {
    const router = Router();

    // Both routes are private — auth the whole prefix (W2-1 tidy).
    router.use("/api/settings/scope", authMiddleware);

    router.get("/api/settings/scope", async (req, res) => {
  ```
  and:
  ```js
    router.post("/api/settings/scope", authMiddleware, async (req, res) => {
  ```
  →
  ```js
    router.post("/api/settings/scope", async (req, res) => {
  ```

- [ ] **9.3** Verify and run:
  ```bash
  node --check servers/gateway/routes/push.js
  node --check servers/gateway/routes/settings-scope.js
  grep -c "authMiddleware" servers/gateway/routes/push.js            # expect 3 (param, doc @param, router.use)
  grep -c "authMiddleware" servers/gateway/routes/settings-scope.js  # expect 2 (param, router.use)
  node --test tests/
  ```
  Expected: suite `# pass 370` / `# fail 0`.

- [ ] **9.4 Commit:**
  ```bash
  git commit servers/gateway/routes/push.js servers/gateway/routes/settings-scope.js -m "W2-1: push + settings-scope use prefix-level router.use(dashboardAuth) like the other Tier-1 routes"
  git show --stat HEAD
  ```

---

## Task 10 — Final verification: full suite + boot checks

**Files:** none (verification only). The docs build is **NOT** needed for this change.

**Steps:**

- [ ] **10.1 Full suite:**
  ```bash
  cd /home/kh0pp/crow && node --test tests/
  ```
  Expected: `# pass 370` / `# fail 0` (baseline 353 + 7 cross-host + 6 rate-limit + 4 ws-auth).

- [ ] **10.2 Targeted re-runs of the suites adjacent to touched auth/boundary code:**
  ```bash
  node --test tests/auth-network.test.js tests/federation-overview.test.js tests/csrf-middleware.test.js tests/bot-federation-endpoints.test.js tests/sso-ticket.test.js
  ```
  Expected: all pass, 0 fail.

- [ ] **10.3 Gateway boot check** (use a non-default port so a live gateway on this host can't collide; the process is killed by `timeout` — exit code 124 is expected and fine):
  ```bash
  PORT=3999 timeout 20 node servers/gateway/index.js --no-auth > /tmp/w21-boot.log 2>&1
  grep -E "listening|mounted|\[proxy\]" /tmp/w21-boot.log | head -20
  grep -inE "syntaxerror|cannot find module|unhandled|TypeError" /tmp/w21-boot.log
  ```
  Expected: first grep shows `Crow Gateway listening on http://...:3999` and `STT debug API mounted at /api/stt/debug` (and, if extensions are installed, the `[proxy] WebSocket upgrade handler registered ... (session-gated)` line); second grep prints **nothing**.

- [ ] **10.4 Syntax sweep of every file touched in this plan:**
  ```bash
  for f in servers/gateway/routes/_error.js servers/gateway/routes/stt-debug.js \
           servers/gateway/routes/bot-board-api.js servers/gateway/routes/admin-backup.js \
           servers/gateway/routes/bundles.js servers/gateway/routes/federation.js \
           servers/shared/cross-host-auth.js servers/gateway/middleware/rate-limit.js \
           servers/gateway/routes/blog-embed-api.js servers/gateway/routes/chat.js \
           servers/gateway/routes/bot-chat.js servers/gateway/routes/extension-proxy.js \
           servers/gateway/routes/push.js servers/gateway/routes/settings-scope.js; do
    node --check "$f" || echo "FAIL $f"
  done
  ```
  Expected: no `FAIL` lines.

- [ ] **10.5 Branch hygiene:** `git log --oneline main..overhaul/w2-1` shows the 9 commits from Tasks 1–9 (and nothing else); `git status` shows no staged stragglers from this work (the pre-existing untracked `bundles/*` dirs are expected and must remain untracked). Run `rm /tmp/w21-boot.log`. Do not merge or push — hand off for `/security-review` (auth + boundary were touched) per the spec's testing section.

---

### Critical Files for Implementation
- /home/kh0pp/crow/servers/shared/cross-host-auth.js
- /home/kh0pp/crow/servers/gateway/routes/bundles.js
- /home/kh0pp/crow/servers/gateway/routes/federation.js
- /home/kh0pp/crow/servers/gateway/middleware/rate-limit.js (new)
- /home/kh0pp/crow/servers/gateway/routes/extension-proxy.js

## Review

**Round 1 (2026-06-11, Plan subagent, adversarial vs live tree): APPROVE.** Zero anchor drift, zero semantic drift found across all 10 tasks (every quoted block token-verified; perl regexes adversarially tested; all three test files traced end-to-end; 353-baseline reproduced). Suggestions adopted: express-rate-limit version corrected to v8 (^8.3.0; `max` alias supported; keep `req.ip` out of keyGenerator source text or v8 throws at boot); stale blog-embed header comment refreshed in Task 7; WS gate upgraded from bare funnel-check to full `isAllowedNetwork` parity with the HTTP gate (tests updated: cookie-path tests now carry a tailnet identity; added disallowed-network-with-cookie rejection; counts 369→370); Task 1/3 typos fixed. Questions resolved: (Q1) boot-check pattern identical to W1 (short timeout, no incident); (Q2) Android app reaches /proxy via the dashboard WebView which carries the session cookie — HTTP /proxy already required it, so no cookie-less client can exist; (Q3) the 02:30 backup cron (`~/bin/backup-crow-via-api.sh`) parses HTTP status only, never body `.ok` — verified on this host.
