# F6c-2 — Local MCP Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a single, per-instance, full-tool-access static bearer token authenticate MCP requests server-side, with generate/rotate/revoke from the connect panel and no gateway restart to mint/rotate.

**Architecture:** A new `servers/gateway/local-token.js` module stores only `sha256(token)` in a local-scoped (never-synced) dashboard setting and exposes generate/revoke/meta/validate plus an Express verifier middleware. The middleware mounts right after `instanceAuthMiddleware`; a new branch in `routes/mcp.js`'s `skipAuthForInstance` synthesizes a full-access `req.auth` when the token validated. The F6c-1 connect panel becomes method-aware: it renders a masked token section on GET and handles generate/rotate/revoke POSTs, revealing the raw token exactly once on the POST response.

**Tech Stack:** Node 20 ESM, Express, better-sqlite3-backed `createDbClient`, `node --test`, the existing dashboard component + i18n + settings-registry helpers.

---

## Spec

`docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md`

## File map

- **Create** `servers/gateway/local-token.js` — token store + validate + MCP-path-scoped verifier middleware + `localOperatorAuth()` / `applyLocalTokenAuth()` synthesis helpers. One responsibility: the local MCP token.
- **Create** `tests/connect-token.test.js` — all F6c-2 unit tests.
- **Modify** `servers/gateway/index.js` — mount the verifier middleware after `instanceAuthMiddleware` (~line 520).
- **Modify** `servers/gateway/routes/mcp.js` — add the local-token branch in `skipAuthForInstance` (~line 243).
- **Modify** `servers/gateway/dashboard/shared/i18n.js` — bilingual `connect.token.*` keys (after the existing `connect.*` block, ~line 836).
- **Modify** `servers/gateway/dashboard/panels/connect.js` — method-aware handler + token section.
- **Modify** `servers/gateway/dashboard/settings/sections/connections.js` — one-line token pointer.
- **Modify** `tests/connect.test.js` — pass a stub `db` to `render()`; repurpose the "F6c-2 boundary" test.
- **Modify** `docs/architecture/dashboard.md` — note the connect panel now manages a token.

## Conventions (load-bearing)

- Commit with an explicit path arg: `git commit <paths> -m "..."`. For new files, `git add <path>` first. Verify `git show --stat HEAD`. **Never** add a Claude co-author trailer.
- UI copy obeys crow.md writing rules: **no em dashes, no "not X, but Y"**. Dev docs are exempt.
- `var(--crow-...)` tokens are written as complete literals, never interpolated mid-name (`tests/design-system.test.js` scans for this).
- Run a single test file with `node --test tests/<file>.test.js`.

---

### Task 1: `local-token.js` store + validate (no middleware yet)

**Files:**
- Create: `servers/gateway/local-token.js`
- Test: `tests/connect-token.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/connect-token.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateLocalToken, revokeLocalToken, getLocalTokenMeta,
  validateLocalToken, LOCAL_TOKEN_KEYS,
} from "../servers/gateway/local-token.js";
import { isSyncable } from "../servers/gateway/dashboard/settings/registry.js";

// In-memory db stub matching the exact SQL the settings registry emits for
// local-scoped reads/writes (readSetting / writeSetting{scope:"local"} /
// deleteLocalSetting). instance_id (args[1] on writes/reads) is irrelevant
// here: the test process is a single logical instance.
function memDb() {
  const overrides = new Map();
  const globals = new Map();
  return {
    async execute({ sql, args }) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("INSERT INTO dashboard_settings_overrides")) {
        overrides.set(args[0], args[2]); return { rows: [] };
      }
      if (s.startsWith("SELECT value FROM dashboard_settings_overrides")) {
        const v = overrides.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (s.startsWith("SELECT value FROM dashboard_settings WHERE")) {
        const v = globals.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (s.startsWith("DELETE FROM dashboard_settings_overrides")) {
        overrides.delete(args[0]); return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("no token configured: meta empty, validate false", async () => {
  const db = memDb();
  assert.deepEqual(await getLocalTokenMeta(db), { present: false, createdAt: null });
  assert.equal(await validateLocalToken(db, "anything"), false);
  assert.equal(await validateLocalToken(db, ""), false);
});

test("generate returns a raw token, stores hash, validates", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  assert.match(token, /^[0-9a-f]{64}$/, "32-byte hex token");
  const meta = await getLocalTokenMeta(db);
  assert.equal(meta.present, true);
  assert.ok(meta.createdAt, "records a created timestamp");
  assert.equal(await validateLocalToken(db, token), true, "the issued token validates");
  assert.equal(await validateLocalToken(db, token.replace(/.$/, "0")), false, "a tampered token fails");
});

test("rotate (generate again) invalidates the old token", async () => {
  const db = memDb();
  const first = await generateLocalToken(db);
  const second = await generateLocalToken(db);
  assert.notEqual(first, second);
  assert.equal(await validateLocalToken(db, first), false, "old token no longer valid");
  assert.equal(await validateLocalToken(db, second), true, "new token valid");
});

test("revoke clears the token", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  await revokeLocalToken(db);
  assert.equal((await getLocalTokenMeta(db)).present, false);
  assert.equal(await validateLocalToken(db, token), false);
});

test("the token hash key is NOT syncable (per-instance, never replicated)", () => {
  assert.equal(isSyncable(LOCAL_TOKEN_KEYS.HASH_KEY), false);
  assert.equal(isSyncable(LOCAL_TOKEN_KEYS.CREATED_KEY), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connect-token.test.js`
Expected: FAIL — cannot import `../servers/gateway/local-token.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `servers/gateway/local-token.js`:

```js
/**
 * Local MCP token — a single, per-instance, full-tool-access static bearer
 * token for headless / no-browser MCP clients (the remote-HTTP path that does
 * not run the OAuth dance). Only sha256(token) is stored, in a local-scoped
 * dashboard setting that never syncs to paired instances; the raw value is
 * shown exactly once at generation. See
 * docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  readSetting, writeSetting, deleteLocalSetting,
} from "./dashboard/settings/registry.js";

const HASH_KEY = "mcp_local_token_hash";
const CREATED_KEY = "mcp_local_token_created";

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Generate a new token, overwriting any existing one (this is also "rotate").
 *  Stores only the hash; returns the raw token for one-time display. */
export async function generateLocalToken(db) {
  const token = randomBytes(32).toString("hex");
  await writeSetting(db, HASH_KEY, sha256Hex(token), { scope: "local" });
  await writeSetting(db, CREATED_KEY, new Date().toISOString(), { scope: "local" });
  return token;
}

export async function revokeLocalToken(db) {
  await deleteLocalSetting(db, HASH_KEY);
  await deleteLocalSetting(db, CREATED_KEY);
}

/** Non-sensitive status for the UI. Never returns the raw token or the hash. */
export async function getLocalTokenMeta(db) {
  const hash = await readSetting(db, HASH_KEY);
  if (!hash) return { present: false, createdAt: null };
  const createdAt = await readSetting(db, CREATED_KEY);
  return { present: true, createdAt: createdAt || null };
}

export async function validateLocalToken(db, token) {
  if (!token) return false;
  const stored = await readSetting(db, HASH_KEY);
  if (!stored) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const LOCAL_TOKEN_KEYS = { HASH_KEY, CREATED_KEY };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connect-token.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/local-token.js tests/connect-token.test.js
git commit servers/gateway/local-token.js tests/connect-token.test.js -m "F6c-2: local MCP token store + validate"
git show --stat HEAD | head -6
```

---

### Task 2: verifier middleware + auth-synthesis helpers

**Files:**
- Modify: `servers/gateway/local-token.js`
- Test: `tests/connect-token.test.js`

Design notes addressing plan-review:
- **C2 (hot-path cost):** `req.localTokenAuth` is only consumed on MCP routes (`skipAuthForInstance`). So the middleware does its DB read ONLY when the request path is an MCP path (`/mcp`, `/sse`, `/messages` suffix — see `mcp.js:194-196`). Every non-MCP Bearer request (dashboard APIs, OAuth `/token`, `/blog`) skips the read entirely via a cheap string check. This makes the global mount effectively MCP-scoped with no routing changes.
- **S2 (testability of the security-critical branch):** the "not peer-gated" synthesis is extracted into `applyLocalTokenAuth(req)` so it is unit-tested directly (it has no `peerGate` dependency, which is exactly what proves it is not peer-gated).

- [ ] **Step 1: Write the failing test**

Append to `tests/connect-token.test.js`:

```js
import {
  localTokenAuthMiddleware, localOperatorAuth, applyLocalTokenAuth,
} from "../servers/gateway/local-token.js";

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, { status() { return this; }, json() {}, send() {} }, () => resolve(true));
  });
}

test("middleware sets req.localTokenAuth for a valid token on an MCP path", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: `Bearer ${token}` } };
  await run(localTokenAuthMiddleware(db), req);
  assert.deepEqual(req.localTokenAuth, { token: "local-mcp" });
});

test("middleware skips the DB read on non-MCP paths (cost guard)", async () => {
  const db = memDb();
  await generateLocalToken(db);
  let reads = 0;
  const spyDb = { execute: (...a) => { reads++; return db.execute(...a); } };
  const req = { path: "/dashboard/nest", headers: { authorization: "Bearer whatever" } };
  await run(localTokenAuthMiddleware(spyDb), req);
  assert.equal(reads, 0, "no settings read for a non-MCP request");
  assert.equal(req.localTokenAuth, undefined);
});

test("middleware ignores a wrong token (falls through, no flag)", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: "Bearer not-the-token" } };
  await run(localTokenAuthMiddleware(db), req);
  assert.equal(req.localTokenAuth, undefined);
});

test("middleware yields to instance auth (does not run when req.instanceAuth set)", async () => {
  const db = memDb();
  const token = await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: { authorization: `Bearer ${token}` }, instanceAuth: { instance: { id: "x" } } };
  await run(localTokenAuthMiddleware(db), req);
  assert.equal(req.localTokenAuth, undefined, "instance auth wins");
});

test("middleware no-ops without a Bearer header", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const req = { path: "/router/mcp", headers: {} };
  const ok = await run(localTokenAuthMiddleware(db), req);
  assert.equal(ok, true);
  assert.equal(req.localTokenAuth, undefined);
});

test("localOperatorAuth() is a full-access mcp:tools credential", () => {
  const a = localOperatorAuth();
  assert.equal(a.clientId, "local-mcp");
  assert.deepEqual(a.scopes, ["mcp:tools"]);
  assert.ok(a.expiresAt > Math.floor(Date.now() / 1000), "expiry in the future");
});

test("applyLocalTokenAuth: synthesizes full auth ONLY when the flag is set, never touches a gate", () => {
  const yes = { localTokenAuth: { token: "local-mcp" } };
  assert.equal(applyLocalTokenAuth(yes), true);
  assert.equal(yes.auth.clientId, "local-mcp");
  assert.deepEqual(yes.auth.scopes, ["mcp:tools"]);

  const no = {};
  assert.equal(applyLocalTokenAuth(no), false, "no flag -> falls through to OAuth");
  assert.equal(no.auth, undefined, "does not fabricate auth without the flag");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connect-token.test.js`
Expected: FAIL — `localTokenAuthMiddleware` / `localOperatorAuth` / `applyLocalTokenAuth` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `servers/gateway/local-token.js` (before the `LOCAL_TOKEN_KEYS` export):

```js
/** Synthesized req.auth for a validated local-operator token request. Full
 *  tool access, identical surface to an OAuth client (scopes ["mcp:tools"]).
 *  The 300s expiry is NOT a session lifetime: skipAuthForInstance re-runs and
 *  re-synthesizes per request, exactly like the peer branch (mcp.js:247).
 *  Nothing downstream re-checks expiresAt. */
export function localOperatorAuth() {
  return {
    token: "local-mcp",
    clientId: "local-mcp",
    scopes: ["mcp:tools"],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
}

/** Turn a validated local-token flag into a full-access req.auth. Returns true
 *  when it handled the request (caller should next()), false to fall through to
 *  OAuth. Deliberately takes ONLY req: it has no peerGate dependency, so a local
 *  token is never run through the peer exposure gate. Called by
 *  skipAuthForInstance in routes/mcp.js, after the instance branch. */
export function applyLocalTokenAuth(req) {
  if (!req.localTokenAuth) return false;
  req.auth = localOperatorAuth();
  return true;
}

// MCP transport path suffixes (see mcp.js:194-196). req.localTokenAuth is only
// consumed on these, so the middleware reads the DB only for these paths.
function isMcpPath(p) {
  return typeof p === "string"
    && (p === "/mcp" || p.endsWith("/mcp") || p.endsWith("/sse") || p.endsWith("/messages"));
}

/** Express middleware. Mounted globally right after instanceAuthMiddleware, but
 *  it only reads the DB for MCP-path requests (cost guard). Sets
 *  req.localTokenAuth on a valid local token. Yields to instance auth, never
 *  hard-rejects (falls through to OAuth), and fast-exits with no Bearer header,
 *  no token configured, or a non-MCP path. */
export function localTokenAuthMiddleware(db) {
  return async (req, res, next) => {
    try {
      if (req.instanceAuth) return next();
      if (!isMcpPath(req.path)) return next();
      const h = req.headers?.authorization;
      if (!h || !h.startsWith("Bearer ")) return next();
      if (await validateLocalToken(db, h.slice(7))) {
        req.localTokenAuth = { token: "local-mcp" };
      }
    } catch (err) {
      // Fail open to other auth methods on a read error, mirroring how
      // instanceAuthMiddleware never rejects here.
      console.warn("[local-token] auth check error:", err.message);
    }
    return next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connect-token.test.js`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/local-token.js tests/connect-token.test.js -m "F6c-2: local token verifier middleware (MCP-path-scoped) + auth-synthesis helpers"
git show --stat HEAD | head -6
```

---

### Task 3: wire into the gateway auth chain

**Files:**
- Modify: `servers/gateway/index.js` (~line 519-520)
- Modify: `servers/gateway/routes/mcp.js` (~line 243-250)

No new automated test for the full HTTP chain (it requires booting the gateway). The security-critical synthesis is covered by Task 2's `applyLocalTokenAuth` test (proves shape + not-peer-gated); this task only wires it in. A documented post-deploy curl smoke (Step 4) confirms the booted path.

**`--no-auth` mode (C1, dev-only):** under `--no-auth`, `authMiddleware` is `null` (`index.js:599-600`), so `mcp.js:258` mounts handlers WITHOUT `skipAuthForInstance` and the token branch never runs. This is correct: in `--no-auth` everything is already unauthenticated, so the token is simply a no-op (it neither grants nor blocks anything beyond the mode's existing behavior). This matches the existing instance branch, which is also inert under `--no-auth`. No code handles this specially; the comment added in Step 2 states it.

- [ ] **Step 1: Mount the middleware in `index.js`**

Find (around line 519-520):

```js
import { instanceAuthMiddleware } from "./instance-registry.js";
app.use(instanceAuthMiddleware(createDbClient()));
```

Change to:

```js
import { instanceAuthMiddleware } from "./instance-registry.js";
app.use(instanceAuthMiddleware(createDbClient()));
// F6c-2: local MCP token verifier. Runs AFTER instance auth (which wins) and
// BEFORE OAuth. Sets req.localTokenAuth for a valid static token; the MCP
// routes' skipAuthForInstance turns that into full local-operator access.
import { localTokenAuthMiddleware } from "./local-token.js";
app.use(localTokenAuthMiddleware(createDbClient()));
```

(If `index.js` hoists imports to the top rather than inline, place `import { localTokenAuthMiddleware } from "./local-token.js";` with the other top imports and keep only the `app.use(...)` line here. Match the file's existing style — `instanceAuthMiddleware` is imported inline right above, so inline is consistent.)

- [ ] **Step 2: Add the branch in `routes/mcp.js`**

In `servers/gateway/routes/mcp.js`, add the import near the top of the file (with the other imports):

```js
import { applyLocalTokenAuth } from "../local-token.js";
```

Then inside `skipAuthForInstance` (currently `mcp.js:224`), add a branch AFTER the `if (req.instanceAuth?.instance) { ... }` block closes and BEFORE `return authMiddleware(req, res, next);`:

```js
      // F6c-2: a validated local MCP token is a full local-operator credential
      // (same access surface as an OAuth client). It is NOT a paired peer, so
      // applyLocalTokenAuth deliberately does NOT run peerGate. Sits after the
      // instance branch (instance auth wins) and before the OAuth fallback.
      if (applyLocalTokenAuth(req)) return next();
```

The resulting tail of `skipAuthForInstance` reads:

```js
      if (req.instanceAuth?.instance) {
        // ... existing peerGate + synthesized peer req.auth ...
        return next();
      }
      if (applyLocalTokenAuth(req)) return next();
      return authMiddleware(req, res, next);
    };
```

- [ ] **Step 3: Verify the gateway still imports/boots**

Run: `node -e "import('./servers/gateway/local-token.js').then(m => console.log(Object.keys(m).join(',')))"`
Expected: prints the module exports including `generateLocalToken,revokeLocalToken,getLocalTokenMeta,validateLocalToken,localOperatorAuth,applyLocalTokenAuth,localTokenAuthMiddleware,LOCAL_TOKEN_KEYS` (order may vary).

Run: `node --check servers/gateway/index.js && node --check servers/gateway/routes/mcp.js`
Expected: no output (syntax OK).

- [ ] **Step 4: Commit (smoke test deferred to deploy)**

Document the post-deploy smoke in the commit body so it is not forgotten:

```bash
git commit servers/gateway/index.js servers/gateway/routes/mcp.js -m "F6c-2: authenticate local MCP token in the gateway auth chain

Post-deploy smoke: generate a token in the connect panel, then
curl -s -H \"Authorization: Bearer <token>\" -H 'Content-Type: application/json' \\
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' \\
  http://127.0.0.1:3001/router/mcp  → 200 with a tools list (not 401)."
git show --stat HEAD | head -6
```

---

### Task 4: bilingual `connect.token.*` i18n keys

**Files:**
- Modify: `servers/gateway/dashboard/shared/i18n.js` (after the `connect.settingsPointer` entry, ~line 836)
- Test: `tests/connect-token.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/connect-token.test.js`:

```js
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

const TOKEN_KEYS = [
  "connect.token.heading", "connect.token.intro",
  "connect.token.generate", "connect.token.rotate", "connect.token.revoke",
  "connect.token.activeSince", "connect.token.revealHeading",
  "connect.token.revealWarning", "connect.token.configLead",
  "connect.token.placeholderNote", "connect.token.connectionsPointer",
];

test("every connect.token.* key has a non-empty en AND es value", () => {
  for (const k of TOKEN_KEYS) {
    const e = i18n.translations[k];
    assert.ok(e, `missing entry for ${k}`);
    assert.ok(e.en && e.en.trim(), `missing en for ${k}`);
    assert.ok(e.es && e.es.trim(), `missing es for ${k}`);
  }
});

test("token UI copy obeys crow.md style (no em dash, no 'not X, but Y')", () => {
  for (const k of TOKEN_KEYS) {
    for (const lang of ["en", "es"]) {
      const v = i18n.t(k, lang);
      assert.ok(!v.includes("—"), `${k}.${lang} must not use an em dash`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connect-token.test.js`
Expected: FAIL — `missing entry for connect.token.heading`.

- [ ] **Step 3: Write minimal implementation**

In `servers/gateway/dashboard/shared/i18n.js`, the `connect.*` entries are the last block inside the `translations` object; `"connect.settingsPointer"` is a multi-line entry that closes with `},`, and the `translations` object itself closes with `};` immediately before `export const SUPPORTED_LANGS` (~line 842). Insert the following entries AFTER the closing `},` of the `connect.settingsPointer` entry and BEFORE the `};` that closes the object (do not land inside the multi-line entry):

```js
  "connect.token.heading": { en: "Headless / no browser (token)", es: "Sin navegador (token)" },
  "connect.token.intro": {
    en: "For a client that has no browser to complete the OAuth sign-in, generate a token and paste it into the client config below. The token grants full access to this Crow, so treat it like a password.",
    es: "Para un cliente que no tiene navegador para completar el inicio de sesión OAuth, genera un token y pégalo en la configuración del cliente. El token otorga acceso completo a este Crow, así que trátalo como una contraseña.",
  },
  "connect.token.generate": { en: "Generate token", es: "Generar token" },
  "connect.token.rotate": { en: "Rotate token", es: "Rotar token" },
  "connect.token.revoke": { en: "Revoke token", es: "Revocar token" },
  "connect.token.activeSince": { en: "A token is active. Created:", es: "Hay un token activo. Creado:" },
  "connect.token.revealHeading": { en: "Your new token", es: "Tu nuevo token" },
  "connect.token.revealWarning": {
    en: "Copy this token now. For your security it will not be shown again. If you lose it, rotate to get a new one.",
    es: "Copia este token ahora. Por tu seguridad no se mostrará de nuevo. Si lo pierdes, rótalo para obtener uno nuevo.",
  },
  "connect.token.configLead": {
    en: "Paste this into a client that supports an Authorization header (for example Claude Code):",
    es: "Pega esto en un cliente que admita un encabezado de autorización (por ejemplo Claude Code):",
  },
  "connect.token.placeholderNote": {
    en: "The token is stored hashed and cannot be shown again. The config below uses a placeholder. Rotate to issue a fresh token you can copy.",
    es: "El token se guarda cifrado y no se puede volver a mostrar. La configuración de abajo usa un marcador. Rota para emitir un token nuevo que puedas copiar.",
  },
  "connect.token.connectionsPointer": {
    en: "Generate a headless access token in the connect wizard.",
    es: "Genera un token de acceso sin navegador en el asistente de conexión.",
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connect-token.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/shared/i18n.js tests/connect-token.test.js -m "F6c-2: bilingual connect.token.* i18n keys"
git show --stat HEAD | head -6
```

---

### Task 5: connect panel token section (GET masked + POST generate/rotate/revoke)

**Files:**
- Modify: `servers/gateway/dashboard/panels/connect.js`
- Modify: `tests/connect.test.js` (stub db in `render()`; repurpose the boundary test)
- Test: `tests/connect-token.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/connect-token.test.js`:

```js
import connectPanel from "../servers/gateway/dashboard/panels/connect.js";

const HOST = "crow.example.ts.net:8444";
function mkReq({ method = "GET", body = null, db, csrf = "csrf-x", cookie = "" } = {}) {
  return {
    method, body, csrfToken: csrf,
    query: {}, headers: cookie ? { cookie } : {},
    protocol: "https",
    get(h) { return h.toLowerCase() === "host" ? HOST : ""; },
  };
}
function ctx(db) {
  return { db, layout: ({ content }) => content };
}

test("GET with no token: shows the token heading + a Generate control, reveals nothing", async () => {
  const db = memDb();
  const html = await connectPanel.handler(mkReq({ db }), { send() {}, setHeader() {} }, ctx(db));
  assert.ok(html.includes(i18n.t("connect.token.heading", "en")), "token section heading present");
  assert.ok(html.includes('value="generate_token"'), "Generate form present");
  assert.ok(!html.includes('value="revoke_token"'), "no Revoke control when no token");
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "no raw token revealed");
});

test("GET with a token present: masked state, placeholder config, Rotate + Revoke", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const html = await connectPanel.handler(mkReq({ db }), { send() {}, setHeader() {} }, ctx(db));
  assert.ok(html.includes(i18n.t("connect.token.activeSince", "en")), "masked active state");
  assert.ok(html.includes("&lt;YOUR-TOKEN&gt;"), "config shows an escaped placeholder, not a real token");
  assert.ok(html.includes('value="rotate_token"') && html.includes('value="revoke_token"'), "Rotate + Revoke present");
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "real token not shown in masked state");
});

test("POST generate_token: reveals the raw token once + a Bearer config", async () => {
  const db = memDb();
  const html = await connectPanel.handler(
    mkReq({ method: "POST", body: { action: "generate_token" }, db }),
    { send() {}, setHeader() {} }, ctx(db));
  const m = html.match(/Bearer ([0-9a-f]{64})/);
  assert.ok(m, "reveals a Bearer token in the config");
  assert.equal(await validateLocalToken(db, m[1]), true, "the revealed token is the one that was stored");
  assert.ok(html.includes(i18n.t("connect.token.revealWarning", "en")), "shows the one-time warning");
});

test("POST revoke_token: clears the token and returns to the empty state", async () => {
  const db = memDb();
  await generateLocalToken(db);
  const html = await connectPanel.handler(
    mkReq({ method: "POST", body: { action: "revoke_token" }, db }),
    { send() {}, setHeader() {} }, ctx(db));
  assert.equal((await getLocalTokenMeta(db)).present, false, "token cleared");
  assert.ok(html.includes('value="generate_token"'), "back to the Generate control");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connect-token.test.js`
Expected: FAIL — the panel does not render a token section / does not handle POST.

- [ ] **Step 3: Implement the panel changes**

Edit `servers/gateway/dashboard/panels/connect.js`.

3a. Extend the imports at the top:

```js
import { section, tabs, codeBlock, callout, button, escapeHtml } from "../shared/components.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { generateLocalToken, revokeLocalToken, getLocalTokenMeta } from "../../local-token.js";
```

3b. Add these helpers near `block()` (the `H_STYLE` / `P_STYLE` constants already exist):

```js
// Remote-HTTP config for a header-capable client. `token` is either the raw
// token (one-time reveal) or the literal "<YOUR-TOKEN>" placeholder.
function tokenConfig(endpoint, token) {
  return `{\n  "mcpServers": {\n    "crow": {\n      "type": "http",\n      "url": "${endpoint}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`;
}

function tokenForm(action, label, variant, csrf) {
  return `<form method="POST" action="/dashboard/connect" style="display:inline-block;margin:0">`
    + `<input type="hidden" name="_csrf" value="${escapeHtml(csrf || "")}">`
    + `<input type="hidden" name="action" value="${escapeHtml(action)}">`
    + button(label, { variant, type: "submit" })
    + `</form>`;
}

function tokenActions({ lang, present, csrf }) {
  const wrap = (inner) => `<div style="display:flex;gap:var(--crow-space-3);flex-wrap:wrap;margin-top:var(--crow-space-3)">${inner}</div>`;
  if (!present) {
    return wrap(tokenForm("generate_token", t("connect.token.generate", lang), "primary", csrf));
  }
  return wrap(
    tokenForm("rotate_token", t("connect.token.rotate", lang), "secondary", csrf)
    + tokenForm("revoke_token", t("connect.token.revoke", lang), "secondary", csrf),
  );
}

// Returns the token section BODY only (no heading element). The caller wraps it
// in section(t("connect.token.heading", lang), ...), so the section title is the
// single heading; the body adds no heading of its own (avoids a double label).
// `reveal` is the raw token immediately after generate/rotate (show once);
// otherwise null. `meta` is getLocalTokenMeta() output.
function tokenSection({ endpoint, lang, meta, reveal, csrf }) {
  if (reveal) {
    return callout(`<strong>${t("connect.token.revealHeading", lang)}</strong><br>${t("connect.token.revealWarning", lang)}`, "warning")
      + codeBlock(reveal)
      + `<p style="${P_STYLE}">${t("connect.token.configLead", lang)}</p>`
      + codeBlock(tokenConfig(endpoint, reveal), { lang: "json" })
      + tokenActions({ lang, present: true, csrf });
  }
  if (meta.present) {
    return `<p style="${P_STYLE}">${t("connect.token.activeSince", lang)} ${escapeHtml(meta.createdAt || "")}</p>`
      + callout(t("connect.token.placeholderNote", lang), "info")
      + codeBlock(tokenConfig(endpoint, "<YOUR-TOKEN>"), { lang: "json" })
      + tokenActions({ lang, present: true, csrf });
  }
  return `<p style="${P_STYLE}">${t("connect.token.intro", lang)}</p>`
    + tokenActions({ lang, present: false, csrf });
}
```

3c. Replace the existing `handler` with a method-aware version that shares one `renderPage`:

```js
  async handler(req, res, ctx) {
    const { layout, db } = ctx;
    const lang = resolveLang(req);
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    let meta = { present: false, createdAt: null };
    let reveal = null;
    if (req.method === "POST" && db) {
      const action = req.body?.action;
      try {
        if (action === "generate_token" || action === "rotate_token") {
          reveal = await generateLocalToken(db);
          meta = await getLocalTokenMeta(db);
        } else if (action === "revoke_token") {
          await revokeLocalToken(db);
        } else {
          meta = await getLocalTokenMeta(db);
        }
      } catch (err) {
        console.warn("[connect] token action failed:", err.message);
      }
    } else if (db) {
      try { meta = await getLocalTokenMeta(db); } catch { /* treat as no token */ }
    }

    const content =
      `<p style="font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-4)">${t("connect.intro", lang)}</p>` +
      section(t("connect.title", lang), clientTabs(baseUrl, lang)) +
      section(t("connect.token.heading", lang), tokenSection({ endpoint: `${baseUrl}/router/mcp`, lang, meta, reveal, csrf: req.csrfToken })) +
      section(t("connect.moreHeading", lang), moreLinks(lang));
    return layout({ title: t("connect.title", lang), content });
  },
```

Single heading: `tokenSection` returns the body WITHOUT a heading, and the `content` assembly above wraps it in `section(t("connect.token.heading", lang), ...)` (line shown in 3c). That is the one canonical form. Do not add an inner `<h4>` and do not use a bare `<div class="dashboard-section">`. The token section is thus visually consistent with the `clientTabs` and `moreLinks` sections, which are also wrapped by `section()`.

- [ ] **Step 4: Update `tests/connect.test.js` so existing tests pass with the new ctx**

In `tests/connect.test.js`, update the `render()` helper to pass a stub `db` and a csrf token, and repurpose the F6c-2 boundary test.

Replace the `render()` helper (lines ~33-42) with:

```js
// Minimal stub db: getLocalTokenMeta reads mcp_local_token_hash; returning no
// rows yields the empty-token state, which is what these UI tests expect.
const noTokenDb = { execute: async () => ({ rows: [] }) };
function render(host = "crow.example.ts.net:8444", cookie = "") {
  const layout = ({ content }) => content;
  const res = { send() {}, setHeader() {} };
  const req = {
    method: "GET", query: {}, headers: cookie ? { cookie } : {},
    protocol: "https", csrfToken: "csrf-x",
    get(h) { return h.toLowerCase() === "host" ? host : ""; },
  };
  return connectPanel.handler(req, res, { layout, db: noTokenDb });
}
```

Replace the `"no token is surfaced anywhere (F6c-2 boundary)"` test (lines ~71-75) with:

```js
test("empty-token state reveals no token and offers Generate", async () => {
  const html = await render();
  // In the no-token state the wizard shows a Generate control and reveals
  // nothing. A raw token only appears after an explicit generate/rotate POST.
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "no raw token revealed at rest");
  assert.ok(html.includes('value="generate_token"'), "offers a Generate control");
});
```

- [ ] **Step 5: Run both test files**

Run: `node --test tests/connect-token.test.js tests/connect.test.js`
Expected: PASS (all connect-token tests + all connect tests).

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/dashboard/panels/connect.js tests/connect.test.js tests/connect-token.test.js -m "F6c-2: connect panel manages the local MCP token (generate/rotate/revoke, reveal-once)"
git show --stat HEAD | head -8
```

---

### Task 6: Connections section token pointer

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/connections.js`
- Test: `tests/connect-token.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/connect-token.test.js`:

```js
import connectionsSection from "../servers/gateway/dashboard/settings/sections/connections.js";

test("Connections section points at the connect wizard for token generation", async () => {
  const req = { protocol: "https", headers: {}, get: (h) => (h.toLowerCase() === "host" ? HOST : "") };
  const html = await connectionsSection.render({ req, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard");
  assert.ok(html.includes(i18n.t("connect.token.connectionsPointer", "en")), "uses the token pointer copy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connect-token.test.js`
Expected: FAIL — the pointer copy is not present.

- [ ] **Step 3: Implement**

Open `servers/gateway/dashboard/settings/sections/connections.js`. `render({ req, lang })` returns a single concatenated string; the last line (currently line 65) renders the F6c-1 wizard pointer and ends with `...${t("connect.settingsPointer", lang)}</span></p></div>`. Insert a new pointer paragraph just before that final `</div>`. Concretely, change the tail of that line from:

```js
...${t("connect.settingsPointer", lang)}</span></p></div>`;
```

to:

```js
...${t("connect.settingsPointer", lang)}</span></p>`
      + `<p style="font-size:0.85rem;color:var(--crow-text-muted);margin-top:var(--crow-space-2)">${t("connect.token.connectionsPointer", lang)}</p></div>`;
```

`lang` is already in scope from `render({ req, lang })`. Keep the leading `...` exactly as the existing line has it (do not alter the wizard link/span before the insertion point).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connect-token.test.js tests/connect.test.js`
Expected: PASS (the existing connections test in connect.test.js still passes; the new pointer test passes).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/settings/sections/connections.js tests/connect-token.test.js -m "F6c-2: Connections section points at the connect wizard for token generation"
git show --stat HEAD | head -6
```

---

### Task 7: network-exposure invariant test

**Files:**
- Test: `tests/connect-token.test.js`

- [ ] **Step 1: Write the test**

Append to `tests/connect-token.test.js`:

```js
import { PUBLIC_FUNNEL_PREFIXES, rejectFunneledMiddleware } from "../servers/gateway/funnel.js";

// Hermetic: rejectFunneledMiddleware early-returns next() when
// CROW_DASHBOARD_PUBLIC === "true" (funnel.js:39). Clear it so this test
// asserts code behavior, not the ambient environment.
delete process.env.CROW_DASHBOARD_PUBLIC;

test("MCP paths are never in the public Funnel allowlist", () => {
  for (const p of PUBLIC_FUNNEL_PREFIXES) {
    assert.ok(!p.includes("mcp"), `${p} must not expose an MCP path`);
    assert.ok(!p.startsWith("/router"), `${p} must not expose the router`);
  }
});

test("a token-bearing MCP request over Funnel is rejected before auth", () => {
  const mw = rejectFunneledMiddleware();
  let status = 0, sent = "";
  const req = { headers: { "tailscale-funnel-request": "1", authorization: "Bearer deadbeef" }, path: "/router/mcp" };
  const res = { status(c) { status = c; return this; }, type() { return this; }, send(b) { sent = b; } };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, false, "must not call next for a funneled MCP request");
  assert.equal(status, 403, "rejects with 403");
  assert.match(sent, /Forbidden/, "explains the rejection");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/connect-token.test.js`
Expected: PASS. (These assert existing behavior, locking in the invariant for F6c-2.)

- [ ] **Step 3: Commit**

```bash
git commit tests/connect-token.test.js -m "F6c-2: lock the network-exposure invariant for the token path"
git show --stat HEAD | head -6
```

---

### Task 8: docs

**Files:**
- Modify: `docs/architecture/dashboard.md`

- [ ] **Step 1: Update the connect-panel doc**

In `docs/architecture/dashboard.md`, find the F6c-1 connect-wizard description (search for "connect"). Add a short paragraph (dev doc, em dashes allowed):

```markdown
**F6c-2 — local MCP token.** The connect panel also manages a single, per-instance,
full-access static bearer token for headless / no-browser clients. The gateway verifies
it server-side via `servers/gateway/local-token.js` (`localTokenAuthMiddleware`, mounted
after `instanceAuthMiddleware`; a `skipAuthForInstance` branch in `routes/mcp.js`
synthesizes full local-operator `req.auth`). Only `sha256(token)` is stored, in a
local-scoped dashboard setting (`mcp_local_token_hash`, never synced). The raw token is
revealed exactly once on generate/rotate. Generate/rotate/revoke need no gateway restart
(per-request hash read). See `docs/superpowers/specs/2026-06-10-f6c2-connect-token-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git commit docs/architecture/dashboard.md -m "F6c-2: document the local MCP token in dashboard architecture"
git show --stat HEAD | head -6
```

---

## Final verification (run before review/merge)

- [ ] **Full relevant suite green:**

Run:
```bash
node --test tests/connect-token.test.js tests/connect.test.js tests/onboarding.test.js tests/design-system.test.js
```
Expected: all PASS. (`design-system.test.js` enforces the complete-literal `var(--crow-...)` rule across dashboard files, so it covers the new panel code.)

- [ ] **Syntax check the touched server files:**

Run: `node --check servers/gateway/index.js && node --check servers/gateway/routes/mcp.js && node --check servers/gateway/dashboard/panels/connect.js`
Expected: no output.

- [ ] **No accidental token leakage in logs/strings:** grep the new code for any path that logs or returns the raw token outside the one-time reveal.

Run: `grep -n "console.log" servers/gateway/local-token.js servers/gateway/dashboard/panels/connect.js`
Expected: no line that logs a raw token (only the `console.warn` error paths, which log `err.message`, never the token).

---

## Self-review notes (author)

- **Spec coverage:** store (Task 1) · module API (Tasks 1-2) · auth-chain wiring (Task 3) · panel UI generate/rotate/revoke + reveal-once (Task 5) · i18n (Task 4) · Connections pointer (Task 6) · security: hash-only/timingSafeEqual/CSRF/funnel invariant (Tasks 1,2,5,7) · tests (every task) · docs (Task 8). All spec sections map to a task.
- **Not covered by automated tests (by design):** the full booted-gateway HTTP path for Task 3 (curl smoke at deploy) and CSRF rejection of the POST forms (enforced by the already-tested `csrfMiddleware` mounted on `/dashboard`, see `tests/csrf-middleware.test.js`).
- **Type/name consistency:** `LOCAL_TOKEN_KEYS.{HASH_KEY,CREATED_KEY}`, `req.localTokenAuth = { token: "local-mcp" }`, `localOperatorAuth()` shape, and the `generate_token|rotate_token|revoke_token` action strings are used identically across module, middleware, panel, and tests.
- **Security pass:** after implementation, run `/security-review` (or an adversarial reviewer) on the diff before merge, per the spec.

## Review

**Reviewer:** adversarial staff-engineer subagent (Plan), verified every load-bearing claim against the tree.
**Date:** 2026-06-10
**Verdict:** REVISE → addressed; all critical issues resolved in this plan.

| Issue | Resolution |
|---|---|
| **C1** — token is a no-op under `--no-auth` (authMiddleware null → `skipAuthForInstance` not mounted, `mcp.js:258`) | Documented in Task 3 + a code comment. Confirmed it is correct/inert (dev-only mode where everything is already unauthenticated); matches the existing instance branch. No code change. |
| **C2** — global middleware read DB on every Bearer request to every path | Middleware now path-gates the DB read to MCP paths only (`isMcpPath`, suffixes `/mcp` `/sse` `/messages` per `mcp.js:194-196`). Non-MCP Bearer requests skip the read. New test asserts zero reads on `/dashboard/*`. Spec wording corrected. |
| **C3 / Q1** — "never synced" rested on a possibly-misleading `isSyncable` assertion | Verified structurally: `dashboard_settings_overrides` is never replicated (`instance-sync.js:100,344`), `writeSetting{scope:"local"}` emits no sync event (`registry.js:201-211`), and `isSyncable("mcp_local_token_hash")===false` (not allowlisted; `sync-allowlist.js`). Three independent guarantees. The `isSyncable` test stays as a secondary check; a comment cites the structural one. |
| **C4** — Task 5 shipped two contradictory panel forms (double-heading) | Collapsed to one canonical form: `tokenSection` returns the body with no heading; the handler wraps it in `section(t("connect.token.heading", lang), ...)`. The "OR" alternative was deleted. |
| **C5** — funnel test could false-green if `CROW_DASHBOARD_PUBLIC=true` in env | Test now `delete process.env.CROW_DASHBOARD_PUBLIC` for hermeticity. |
| **S2** — the security-critical "not peer-gated" branch had zero test coverage | Extracted `applyLocalTokenAuth(req)` (no `peerGate` parameter, which structurally proves it is not peer-gated) and added a direct unit test for it. `mcp.js` now calls it. |
| **Q4** — imprecise i18n insertion line could land mid-entry | Task 4 now specifies inserting after the `connect.settingsPointer` entry's closing `},` and before the `translations` object's closing `};`. |
| **S1, S3, S4, S5** (rationale notes) | Folded in as comments: 300s expiry rationale (`localOperatorAuth` doc), CSRF-then-dashboardAuth ordering, body-parser presence, no un-awaited token work before `db.close()`. |
