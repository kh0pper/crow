# F6c-1 Connect-to-Clients Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hidden `/dashboard/connect` wizard panel with per-client, copy-paste MCP config (local stdio + remote HTTP-over-OAuth, no token), consolidate the scattered connect guidance, and fulfill F6b onboarding step 3.

**Architecture:** A new server-rendered hidden panel (`panels/connect.js`) mirroring the F6b onboarding / design-system pattern, built from the F6a `shared/components.js` primitives (`tabs`, `codeBlock` with built-in copy, `callout`, `button`, `section`). It embeds the reachable base URL via `${req.protocol}://${req.get("host")}` (same derivation as `connections.js`). New `connect.*` i18n keys (EN/ES). Three small consolidation edits (onboarding step 3, Help & Setup, Connections). No server-side auth, no `.env` writes, no token surfacing, no `init-db` (all deferred to F6c-2).

**Tech Stack:** Node.js ESM, Express-style panel handlers, Node's built-in `node --test`, the dashboard component library + flat-object i18n.

**Spec:** `docs/superpowers/specs/2026-06-10-f6c1-connect-wizard-design.md`

---

## Conventions (read once before starting)

- **Commit with explicit paths**: `git commit <path1> <path2> -m "..."` (never bare `git add .` + commit — parallel sessions share the tree). New files: `git add <path>` first. Verify each commit with `git show --stat HEAD`. **Never** add a Claude co-author / attribution trailer.
- **Run a single test file**: `node --test tests/connect.test.js`. Run all: `node --test tests/`.
- **i18n**: `translations` (flat object, keys like `"connect.title": { en, es }`) and `SUPPORTED_LANGS` are exported from `servers/gateway/dashboard/shared/i18n.js`; `t(key, lang)` returns `entry[lang] || entry.en || key` (a missing key returns the key string, so "resolves" == "present").
- **Token-completeness test gotcha** (`tests/design-system.test.js` auto-scans every dashboard file): write CSS vars as complete literals, e.g. `var(--crow-space-4)`. Never interpolate an index into the middle of a token name.
- **Copy rules (crow.md, apply to ALL user-facing UI copy)**: no em dashes (use commas, semicolons, colons, periods, parentheses); no "not X, but Y" contrast constructions. Spanish strings: no em dashes either.
- **Honesty rule**: only embed the verified MCP endpoint URL (`<baseUrl>/router/mcp`) and the project's already-shipped per-platform guidance. Do not invent config-file property names that aren't already documented in the repo.

---

## File Structure

**Create**
- `servers/gateway/dashboard/panels/connect.js` — the wizard panel (one responsibility: render the connect surface).
- `tests/connect.test.js` — unit tests for the panel + i18n parity.

**Modify**
- `servers/gateway/dashboard/shared/i18n.js` — add `connect.*` keys; update two `onboarding.*` values.
- `servers/gateway/dashboard/index.js` — import + register the panel.
- `servers/gateway/dashboard/panels/onboarding.js` — re-point step 3's href to `/dashboard/connect`.
- `servers/gateway/dashboard/settings/sections/help-setup.js` — replace the 8-platform list with a pointer; keep the context-usage stats.
- `servers/gateway/dashboard/settings/sections/connections.js` — add a pointer to the wizard.
- `docs/architecture/dashboard.md` — document the new panel.

---

## Task 1: Add `connect.*` i18n keys + update onboarding step-3 copy

**Files:**
- Modify: `servers/gateway/dashboard/shared/i18n.js` (insert before line `export const SUPPORTED_LANGS = ["en", "es"];`, and edit two existing `onboarding.*` entries near lines 769-773)
- Test: `tests/connect.test.js`

- [ ] **Step 1: Write the failing i18n parity test**

Create `tests/connect.test.js` with (this file will grow in Task 2; start with the i18n block):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

const CONNECT_KEYS = [
  "connect.title", "connect.intro",
  "connect.localStdioHeading", "connect.remoteHttpHeading",
  "connect.stdioNote", "connect.oauthNote",
  "connect.cc.stdioLead", "connect.cc.remoteLead",
  "connect.cursor.lead", "connect.cline.lead",
  "connect.gemini.lead", "connect.desktop.lead",
  "connect.cloud.warning",
  "connect.moreHeading", "connect.openConnections",
  "connect.openWizard", "connect.settingsPointer",
];

test("every connect.* key has a non-empty en AND es value", () => {
  for (const k of CONNECT_KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/connect.test.js`
Expected: FAIL — `missing translations entry for connect.title`.

- [ ] **Step 3: Insert the `connect.*` keys**

In `servers/gateway/dashboard/shared/i18n.js`, immediately before the line `export const SUPPORTED_LANGS = ["en", "es"];` (currently line 790), insert these entries inside the `translations` object — i.e. add them just after the `"onboarding.replayLink"` entry and its closing `};`. Place them as new properties of `translations`, so add a comma after the new block is NOT needed (they go before the closing `};` at line 788). Concretely, change the tail of the object from:

```js
  "onboarding.replayLink": { en: "Replay setup guide", es: "Repetir guía de configuración" },
};
```

to:

```js
  "onboarding.replayLink": { en: "Replay setup guide", es: "Repetir guía de configuración" },

  // F6c-1 connect wizard
  "connect.title": { en: "Connect a client", es: "Conecta un cliente" },
  "connect.intro": {
    en: "Connect an MCP client to use Crow's memory and tools. Local clients (Claude Code, Cursor, and others on this machine or your Tailnet) connect directly. Pick your client below for copy-paste setup.",
    es: "Conecta un cliente MCP para usar la memoria y las herramientas de Crow. Los clientes locales (Claude Code, Cursor y otros en esta máquina o tu Tailnet) se conectan directamente. Elige tu cliente abajo para una configuración lista para copiar.",
  },
  "connect.localStdioHeading": { en: "Local (stdio)", es: "Local (stdio)" },
  "connect.remoteHttpHeading": { en: "Remote (HTTP)", es: "Remoto (HTTP)" },
  "connect.stdioNote": {
    en: "Local stdio needs the Crow repository checked out on this machine.",
    es: "El stdio local necesita el repositorio de Crow descargado en esta máquina.",
  },
  "connect.oauthNote": {
    en: "On first use the client opens a browser to authorize access. No token is needed.",
    es: "En el primer uso el cliente abre un navegador para autorizar el acceso. No se necesita ningún token.",
  },
  "connect.cc.stdioLead": {
    en: "In your Crow repo, run the config generator, then restart Claude Code:",
    es: "En tu repo de Crow, ejecuta el generador de configuración y luego reinicia Claude Code:",
  },
  "connect.cc.remoteLead": {
    en: "Or connect over HTTP from any Tailnet machine. Add this to ~/.claude/mcp.json (or .mcp.json in a project):",
    es: "O conéctate por HTTP desde cualquier máquina del Tailnet. Agrega esto a ~/.claude/mcp.json (o a .mcp.json en un proyecto):",
  },
  "connect.cursor.lead": {
    en: "Add this to .cursor/mcp.json, then reload Cursor:",
    es: "Agrega esto a .cursor/mcp.json y luego recarga Cursor:",
  },
  "connect.cline.lead": {
    en: "In VS Code, open Cline's MCP settings, add a remote (streamable HTTP) server, and paste this URL:",
    es: "En VS Code, abre los ajustes MCP de Cline, agrega un servidor remoto (streamable HTTP) y pega esta URL:",
  },
  "connect.gemini.lead": {
    en: "Add this MCP endpoint URL to your Gemini CLI settings (~/.gemini/settings.json), then restart Gemini CLI:",
    es: "Agrega esta URL de endpoint MCP a tus ajustes de Gemini CLI (~/.gemini/settings.json) y luego reinicia Gemini CLI:",
  },
  "connect.desktop.lead": {
    en: "Claude Desktop connects over local stdio. In your Crow repo, run the config generator, then restart Claude Desktop:",
    es: "Claude Desktop se conecta por stdio local. En tu repo de Crow, ejecuta el generador de configuración y luego reinicia Claude Desktop:",
  },
  "connect.cloud.warning": {
    en: "Cloud web clients (claude.ai, ChatGPT) cannot reach a private Crow. This instance is reachable on your Tailnet only, and exposing the MCP endpoints publicly is intentionally blocked. Use a local client instead.",
    es: "Los clientes web en la nube (claude.ai, ChatGPT) no pueden alcanzar un Crow privado. Esta instancia es accesible solo en tu Tailnet, y exponer los endpoints MCP públicamente está bloqueado a propósito. Usa un cliente local en su lugar.",
  },
  "connect.moreHeading": { en: "More", es: "Más" },
  "connect.openConnections": { en: "View raw connection URLs", es: "Ver URLs de conexión sin formato" },
  "connect.openWizard": { en: "Open the connect wizard", es: "Abrir el asistente de conexión" },
  "connect.settingsPointer": {
    en: "Need step-by-step setup for a specific client? Open the guided connect wizard.",
    es: "¿Necesitas configuración paso a paso para un cliente específico? Abre el asistente de conexión guiado.",
  },
};
```

- [ ] **Step 4: Update the two onboarding step-3 strings**

Still in `i18n.js`, change the existing `"onboarding.connectNote"` and `"onboarding.openConnections"` entries (currently lines 769-773) from:

```js
  "onboarding.connectNote": {
    en: "A guided connect wizard is on the way. For now, the connection URLs and per-platform steps live in Settings, Help and Setup.",
    es: "Un asistente de conexión guiado está en camino. Por ahora, las URLs de conexión y los pasos por plataforma están en Ajustes, Ayuda y configuración.",
  },
  "onboarding.openConnections": { en: "View connection URLs", es: "Ver URLs de conexión" },
```

to:

```js
  "onboarding.connectNote": {
    en: "Open the guided connect wizard to set up Claude Code, Cursor, Gemini CLI, and other clients with copy-paste config.",
    es: "Abre el asistente de conexión guiado para configurar Claude Code, Cursor, Gemini CLI y otros clientes con configuración lista para copiar.",
  },
  "onboarding.openConnections": { en: "Open the connect wizard", es: "Abrir el asistente de conexión" },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/connect.test.js`
Expected: PASS (1 test). Also run `node --test tests/onboarding.test.js` — Expected: PASS (the onboarding key set is unchanged in name; only values changed).

- [ ] **Step 6: Commit**

```bash
git add tests/connect.test.js
git commit tests/connect.test.js servers/gateway/dashboard/shared/i18n.js -m "F6c-1: connect.* i18n keys + onboarding step-3 copy"
git show --stat HEAD
```

---

## Task 2: The connect wizard panel

**Files:**
- Create: `servers/gateway/dashboard/panels/connect.js`
- Test: `tests/connect.test.js` (append)

- [ ] **Step 1: Append the failing panel tests**

Append to `tests/connect.test.js`:

```js
import connectPanel from "../servers/gateway/dashboard/panels/connect.js";

// Invoke the panel handler with a stubbed layout (returns content for assertions).
// connections.js-style base URL needs req.protocol + req.get("host").
// parseCookies reads req.headers.cookie, so headers must always be an object.
function render(host = "crow.example.ts.net:8444", cookie = "") {
  const layout = ({ content }) => content;
  const res = { send() {}, setHeader() {} };
  const req = {
    method: "GET", query: {}, headers: cookie ? { cookie } : {},
    protocol: "https",
    get(h) { return h.toLowerCase() === "host" ? host : ""; },
  };
  return connectPanel.handler(req, res, { layout });
}

test("panel identity: id / route / hidden", () => {
  assert.equal(connectPanel.id, "connect");
  assert.equal(connectPanel.route, "/dashboard/connect");
  assert.equal(connectPanel.hidden, true);
});

test("renders a tab per local client", async () => {
  const html = await render();
  for (const label of ["Claude Code", "Cursor", "Cline", "Gemini CLI", "Claude Desktop"]) {
    assert.ok(html.includes(label), `renders a ${label} tab`);
  }
  assert.ok(html.includes("tab-trigger"), "uses the tabs component");
});

test("embeds the request host in the MCP endpoint, not localhost", async () => {
  const html = await render("crow.example.ts.net:8444");
  assert.ok(html.includes("https://crow.example.ts.net:8444/router/mcp"),
    "embeds the request-host /router/mcp endpoint");
  assert.ok(!html.includes("localhost"), "no hardcoded localhost in the page");
});

test("cloud web clients get an honest warning, not a config", async () => {
  const html = await render();
  assert.ok(html.includes("callout-warning"), "renders a warning callout");
  assert.ok(html.includes(i18n.t("connect.cloud.warning", "en")), "cloud warning text present");
});

test("no token is surfaced anywhere (F6c-2 boundary)", async () => {
  const html = await render();
  assert.ok(!/CROW_LOCAL_MCP_TOKEN/.test(html), "does not name the token env var");
  assert.ok(!/Bearer/i.test(html), "does not show a Bearer header");
});

test("honors the crow_lang=es cookie for Spanish copy", async () => {
  const es = await render("h.example:8444", "crow_lang=es");
  const en = await render("h.example:8444", "crow_lang=en");
  assert.notEqual(es, en, "ES and EN render differently");
  assert.ok(es.includes(i18n.t("connect.intro", "es")), "ES intro present");
  assert.ok(en.includes(i18n.t("connect.intro", "en")), "EN intro present");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/connect.test.js`
Expected: FAIL — cannot find module `../servers/gateway/dashboard/panels/connect.js`.

- [ ] **Step 3: Create the panel**

Create `servers/gateway/dashboard/panels/connect.js`:

```js
/**
 * Connect a client — a hidden, server-rendered wizard with per-client, copy-paste
 * MCP config. Covers the two connection styles that work today with no token:
 * local stdio (npm run mcp-config) and remote HTTP via OAuth. Cloud web clients
 * (claude.ai, ChatGPT) get an honest reachability warning, because a private Crow
 * is Tailnet-only and exposing MCP publicly is blocked by the network-exposure
 * invariant. Token surfacing + server-side validation are deferred to F6c-2.
 * No client JS beyond the shared tabs/copy handlers in componentsJs().
 */
import { section, tabs, codeBlock, callout, button } from "../shared/components.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";

/**
 * Resolve language cookie-first. The dispatcher-provided lang derives from the DB
 * "language" setting, which a brand-new user has not set, so it would default to
 * English even for a user who chose Spanish on the setup/login pages (which persist
 * the choice in crow_lang). Matches onboarding.js / help-setup.js.
 */
function resolveLang(req) {
  const lang = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

const P_STYLE = "font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-2)";
const H_STYLE = "font-size:var(--crow-text-md);margin:var(--crow-space-4) 0 var(--crow-space-2)";

/**
 * One labelled config block: optional sub-heading, lead text, code snippet, note
 * callout. Each client's steps are folded into a single lead sentence ("run X,
 * then restart Y") rather than a numbered <ol>: the steps are one or two actions,
 * so a sentence reads cleaner and needs fewer i18n keys. (This is a deliberate
 * simplification of the spec's "numbered sequence" wording; see the spec note.)
 */
function block({ heading, lead, code, codeLang, note, noteType = "info" }) {
  return (heading ? `<h4 style="${H_STYLE}">${heading}</h4>` : "")
    + (lead ? `<p style="${P_STYLE}">${lead}</p>` : "")
    + (code ? codeBlock(code, codeLang ? { lang: codeLang } : {}) : "")
    + (note ? callout(note, noteType) : "");
}

function clientTabs(baseUrl, lang) {
  const endpoint = `${baseUrl}/router/mcp`;
  const ccHttp = `{\n  "mcpServers": {\n    "crow": { "type": "http", "url": "${endpoint}" }\n  }\n}`;
  const cursorCfg = `{\n  "mcpServers": {\n    "crow": { "url": "${endpoint}" }\n  }\n}`;

  return tabs([
    {
      id: "claude-code", label: "Claude Code",
      content:
        block({ heading: t("connect.localStdioHeading", lang), lead: t("connect.cc.stdioLead", lang),
          code: "npm run mcp-config", codeLang: "sh", note: t("connect.stdioNote", lang) })
        + block({ heading: t("connect.remoteHttpHeading", lang), lead: t("connect.cc.remoteLead", lang),
          code: ccHttp, codeLang: "json", note: t("connect.oauthNote", lang) }),
    },
    {
      id: "cursor", label: "Cursor",
      content: block({ lead: t("connect.cursor.lead", lang), code: cursorCfg, codeLang: "json",
        note: t("connect.oauthNote", lang) }),
    },
    {
      id: "cline", label: "Cline",
      content: block({ lead: t("connect.cline.lead", lang), code: endpoint,
        note: t("connect.oauthNote", lang) }),
    },
    {
      id: "gemini", label: "Gemini CLI",
      content: block({ lead: t("connect.gemini.lead", lang), code: endpoint,
        note: t("connect.oauthNote", lang) }),
    },
    {
      id: "claude-desktop", label: "Claude Desktop",
      content: block({ lead: t("connect.desktop.lead", lang), code: "npm run mcp-config", codeLang: "sh",
        note: t("connect.stdioNote", lang) }),
    },
    {
      id: "cloud", label: "claude.ai / ChatGPT",
      content: callout(t("connect.cloud.warning", lang), "warning"),
    },
  ], { active: 0 });
}

// The wizard is the self-contained source of truth for client setup, so "More"
// only links back to the raw-URL reference. We deliberately do NOT re-link the
// external maestro.press per-platform docs here (Task 5 de-emphasizes that list
// in Help & Setup; re-linking its parent page would be inconsistent and the page
// is not verified live). Token surfacing lands in F6c-2.
function moreLinks(lang) {
  return `<p style="${P_STYLE}">${t("connect.settingsPointer", lang)}</p>`
    + `<div style="display:flex;gap:var(--crow-space-3);flex-wrap:wrap;margin-top:var(--crow-space-3)">`
    + button(t("connect.openConnections", lang), { variant: "secondary", href: "/dashboard/settings?section=connections" })
    + `</div>`;
}

export default {
  id: "connect",
  name: "Connect a client",  // literal; never shown (hidden panel)
  icon: "skills",            // unused while hidden; present for registry shape parity
  route: "/dashboard/connect",
  navOrder: 97,
  category: "tools",
  hidden: true,              // reachable by URL + deep-link, not in the sidebar

  async handler(req, res, { layout }) {
    const lang = resolveLang(req);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const content =
      `<p style="font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-4)">${t("connect.intro", lang)}</p>` +
      section(t("connect.title", lang), clientTabs(baseUrl, lang)) +
      section(t("connect.moreHeading", lang), moreLinks(lang));
    return layout({ title: t("connect.title", lang), content });
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/connect.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the design-system token scanner to confirm no truncated tokens**

Run: `node --test tests/design-system.test.js`
Expected: PASS (it scans every dashboard file, including the new `connect.js`; all `var(--crow-...)` refs are complete literals).

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/panels/connect.js
git commit servers/gateway/dashboard/panels/connect.js tests/connect.test.js -m "F6c-1: connect wizard panel + tests"
git show --stat HEAD
```

---

## Task 3: Register the panel

**Files:**
- Modify: `servers/gateway/dashboard/index.js` (import near line 78, register near line 106)

- [ ] **Step 1: Add the import**

In `servers/gateway/dashboard/index.js`, after the line `import onboardingPanel from "./panels/onboarding.js";` (line 78), add:

```js
import connectPanel from "./panels/connect.js";
```

- [ ] **Step 2: Register it**

After the line `registerPanel(onboardingPanel);` (line 106), add:

```js
  registerPanel(connectPanel);
```

- [ ] **Step 3: Syntax-check the module graph**

Run: `node --check servers/gateway/dashboard/index.js`
Expected: no output, exit 0 (parses cleanly).

- [ ] **Step 4: Confirm the wiring is present**

Run: `grep -n "connectPanel" servers/gateway/dashboard/index.js`
Expected: two lines — the import and the `registerPanel(connectPanel);`.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/index.js -m "F6c-1: register the connect wizard panel"
git show --stat HEAD
```

---

## Task 4: Re-point onboarding step 3 to the wizard

**Files:**
- Modify: `servers/gateway/dashboard/panels/onboarding.js:43`
- Test: `tests/onboarding.test.js:54` (update the expected deep-link)

- [ ] **Step 1: Update the onboarding test expectation**

In `tests/onboarding.test.js`, in the `deepLinkPerStep` array (around line 49-55), change the step-3 (index 3) entry from `"/dashboard/settings?section=help-setup"` to `"/dashboard/connect"`:

```js
  const deepLinkPerStep = [
    null,
    "/dashboard/settings?section=integrations",
    "/dashboard/bot-builder",
    "/dashboard/connect",
    null,
  ];
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/onboarding.test.js`
Expected: FAIL — step 3 links to `/dashboard/connect` assertion fails (panel still points at help-setup).

- [ ] **Step 3: Re-point the href in the panel**

In `servers/gateway/dashboard/panels/onboarding.js`, in `renderStepBody`'s `case "connect":` (line 41-43), change the href from `/dashboard/settings?section=help-setup` to `/dashboard/connect`:

```js
    case "connect":
      return body + callout(t("onboarding.connectNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openConnections", lang), "/dashboard/connect"));
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/onboarding.test.js`
Expected: PASS (the updated `onboarding.connectNote` / `onboarding.openConnections` copy from Task 1 still resolves; deep-link now matches).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/panels/onboarding.js tests/onboarding.test.js -m "F6c-1: onboarding step 3 deep-links to the connect wizard"
git show --stat HEAD
```

---

## Task 5: Slim Help & Setup to a wizard pointer (keep stats)

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/help-setup.js`
- Test: `tests/connect.test.js` (append)

The 8-platform list moves into the wizard. Help & Setup keeps its replay link and context-usage stats, and gains a pointer to `/dashboard/connect`. The per-platform `instr` strings, `platforms` array, `platformListHtml`, and `docsBase` become unused and are removed. The local `helpT` object gains `connectGuide` (heading) + `connectPointer` (sentence) + `openWizard` (link label) in both `en` and `es`.

- [ ] **Step 1: Append the failing pointer test**

Append to `tests/connect.test.js`:

```js
import helpSetupSection from "../servers/gateway/dashboard/settings/sections/help-setup.js";

test("Help & Setup points at the connect wizard and keeps context stats", async () => {
  const db = { execute: async () => ({ rows: [] }) }; // default English
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard");
  assert.ok(html.includes("Context Usage"), "still shows the context-usage stats heading");
  assert.ok(!html.includes("maestro.press/software/crow/platforms"),
    "the old per-platform docs list is gone");
});

test("Help & Setup wizard pointer honors Spanish (DB language = es)", async () => {
  const db = { execute: async () => ({ rows: [{ value: "es" }] }) };
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard in ES");
  assert.ok(html.includes("Uso de Contexto"), "ES context-usage heading present");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/connect.test.js`
Expected: FAIL — the section still renders the platform list / `maestro.press/software/crow/platforms` and has no `/dashboard/connect` link.

- [ ] **Step 3: Edit `help-setup.js`**

(a) In the `helpT.en` object, remove the eight `*Instr` keys (`claudeWebInstr` … `claudeCodeInstr`) and the `platformSetup` key, and add:

```js
        connectGuide: "Connect a client",
        connectPointer: "Set up Claude Code, Cursor, Gemini CLI, and other clients with copy-paste config.",
        openWizard: "Open the connect wizard",
```

(b) In the `helpT.es` object, likewise remove the eight `*Instr` keys and `platformSetup`, and add:

```js
        connectGuide: "Conecta un cliente",
        connectPointer: "Configura Claude Code, Cursor, Gemini CLI y otros clientes con configuración lista para copiar.",
        openWizard: "Abrir el asistente de conexión",
```

(c) Delete the now-unused `docsBase`, `platforms`, and `platformListHtml` declarations (lines 65-78).

(d) Replace the platform-setup heading + list in the returned template (lines 93-96) — the block:

```js
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.platformSetup}</h4>
      <ul style="font-size:0.85rem;padding-left:1.2rem;list-style:disc;line-height:1.8">
        ${platformListHtml}
      </ul>
```

with a pointer to the wizard:

```js
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.connectGuide}</h4>
      <p style="font-size:0.85rem;line-height:1.6;margin-bottom:0.75rem">${ht.connectPointer}</p>
      <p><a href="/dashboard/connect" style="color:var(--crow-accent);text-decoration:none;font-weight:600">${ht.openWizard} &rarr;</a></p>
```

(e) Update `getPreview()` (line 16-18) to return the wizard pointer instead of the platform count:

```js
  async getPreview() {
    return "Connect a client";
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/connect.test.js`
Expected: PASS. Also run `node --test tests/onboarding.test.js` — Expected: PASS (its two Help & Setup replay-link tests still pass; the replay link and language resolution are unchanged).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/settings/sections/help-setup.js tests/connect.test.js -m "F6c-1: Help & Setup points at the connect wizard, drops the platform list"
git show --stat HEAD
```

---

## Task 6: Add a wizard pointer to the Connections section

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/connections.js`
- Test: `tests/connect.test.js` (append)

- [ ] **Step 1: Append the failing test**

Append to `tests/connect.test.js`:

```js
import connectionsSection from "../servers/gateway/dashboard/settings/sections/connections.js";

test("Connections section points at the connect wizard", async () => {
  const req = { protocol: "https", get: (h) => (h.toLowerCase() === "host" ? "crow.example.ts.net:8444" : ""), headers: {} };
  const html = await connectionsSection.render({ req, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard");
  assert.ok(html.includes(i18n.t("connect.openWizard", "en")), "uses the wizard link label");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/connect.test.js`
Expected: FAIL — Connections section has no `/dashboard/connect` link.

- [ ] **Step 3: Add the pointer**

In `servers/gateway/dashboard/settings/sections/connections.js`, the `render` already imports `t` from `../../shared/i18n.js`. At the end of the returned template string (after the final `</div>` that closes the MCP-endpoints block, line 64), append a pointer paragraph. Change the tail of the return from:

```js
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">Use these Streamable HTTP endpoints to connect Claude.ai, ChatGPT, Gemini, Cursor, or other MCP clients. See the Help &amp; Setup section for platform-specific instructions.</p></div>`;
```

to:

```js
      + `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">Use these Streamable HTTP endpoints to connect Gemini, Cursor, or other local MCP clients.</p>`
      + `<p style="margin-top:0.75rem"><a href="/dashboard/connect" style="color:var(--crow-accent);text-decoration:none;font-weight:600">${t("connect.openWizard", lang)} &rarr;</a> <span style="color:var(--crow-text-muted);font-size:0.8rem">${t("connect.settingsPointer", lang)}</span></p></div>`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/connect.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/settings/sections/connections.js tests/connect.test.js -m "F6c-1: Connections section links to the connect wizard"
git show --stat HEAD
```

---

## Task 7: Document the panel + full-suite green

**Files:**
- Modify: `docs/architecture/dashboard.md`

- [ ] **Step 1: Add a docs note**

In `docs/architecture/dashboard.md`, find the section that lists the hidden panels (search for `design-system` or `onboarding`). Add an entry describing the connect wizard. If there is a "Hidden panels" list, add:

```markdown
- **Connect wizard** (`panels/connect.js`, route `/dashboard/connect`, hidden): per-client copy-paste MCP config. Covers local stdio (`npm run mcp-config`) and remote HTTP via OAuth (no token). Embeds the request-host `/router/mcp` endpoint (`${req.protocol}://${req.get("host")}`). Cloud web clients (claude.ai/ChatGPT) show a reachability warning by design (Tailnet-only + no MCP-over-Funnel). Reached from onboarding step 3, Help & Setup, and Connections. Token surfacing + server-side static-token validation are deferred to F6c-2.
```

If no such list exists, add a short "### Connect wizard (F6c-1)" subsection near the onboarding/design-system documentation with the same content.

- [ ] **Step 2: Run the full dashboard test suite**

Run: `node --test tests/connect.test.js tests/onboarding.test.js tests/design-system.test.js`
Expected: PASS for all three files (connect: i18n parity + panel + the two section pointers; onboarding: updated deep-link + unchanged replay tests; design-system: token scan covers `connect.js`).

- [ ] **Step 3: Run the whole tests directory as a regression sweep**

Run: `node --test tests/`
Expected: no new failures introduced by F6c-1. (Pre-existing unrelated failures, if any, are out of scope; note them but do not fix.)

- [ ] **Step 4: Commit**

```bash
git commit docs/architecture/dashboard.md -m "F6c-1: document the connect wizard panel in dashboard architecture"
git show --stat HEAD
```

---

## Deploy (after merge — separate from task execution)

Panel + strings load at **startup** (panel registration), so deploy = `git pull` + **gateway restart** + verify (like F6a/F6b). Do NOT chain a `systemctl restart` through `grep` (a no-match grep exits 1 and breaks the `&&` chain before verify runs). Per host:

- **crow**: restart `crow-gateway` (:3001) and `crow-mpa-gateway` (:3006). Non-interactive sudo: `echo "8r00kly^" | sudo -S systemctl restart <svc>`.
- **grackle**: restart `crow-gateway` (:3002).
- **black-swan**: restart `crow-gateway` (:3001); wait ~10s before health-checking (slow Oracle Cloud start).

Verify each: `systemctl is-active`, `NRestarts=0`, `ActiveEnterTimestamp` advanced, `/health` → 200. A 403 on `/dashboard/connect` only proves dashboardAuth runs before panel lookup; panel correctness is proven by the unit tests + a clean restart from the on-disk SHA. The 4 `pibot-*@crow-mpa` bots are independent of gateway restarts. **No `init-db`.**

---

## Self-Review (completed by plan author)

**Spec coverage:** new hidden `/dashboard/connect` panel (Task 2) ✓; per-client copy-paste config via `tabs`/`codeBlock` (Task 2) ✓; local stdio + remote HTTP-via-OAuth, no token (Task 2 copy + tests) ✓; honest cloud-client warning (Task 2 cloud tab + test) ✓; base URL from request host (Task 2 handler + test) ✓; consolidation — onboarding step 3 (Task 4), Help & Setup slim (Task 5), Connections pointer (Task 6) ✓; bilingual EN/ES (Task 1 + parity test) ✓; no token surfaced regression guard (Task 2 test) ✓; design-system token scanner coverage (Task 2/7) ✓; docs (Task 7) ✓; no init-db / auth / .env (none of the tasks touch these) ✓.

**Placeholder scan:** every code step shows complete code; every run step has an exact command + expected result. No TBD/TODO.

**Type/name consistency:** panel exports `{ id:"connect", route:"/dashboard/connect", hidden:true, handler }` — matches all test assertions. i18n key names in Task 1 exactly match the `CONNECT_KEYS` array (Task 1 test) and every `t("connect.*")` call in Task 2. `block({...})` option names (`heading,lead,code,codeLang,note,noteType`) are consistent between definition and all call sites. `connect.openWizard` is reused by Tasks 5 (help-setup, via local `helpT.openWizard` value) and 6 (connections, via global key) — note: Task 5 uses help-setup's in-file `helpT` object (its established pattern), Task 6 uses the global `t()` key; both are intentional and independent.

---

## Review

**Reviewer:** adversarial staff-engineer subagent (Plan), verifying every claim against the real tree.
**Date:** 2026-06-10.
**Verdict:** APPROVE (no critical issues). All 10 review criteria + the Host-header-reflection security check verified against actual code. Key confirmations: the dashboard dispatcher routes hidden panels by **panel `id`** (`getPanel(panelId)`), so `/dashboard/connect` works with just the one `registerPanel` line (no route table / nav-registry / allow-list edit); the OAuth-on-first-use claim is repo-backed (`requireBearerAuth` + `/register` dynamic client registration are mounted on the gateway), and the plan correctly uses plain `npm run mcp-config` (stdio) rather than the broken `--http`/`CROW_LOCAL_MCP_TOKEN` mode; `req.get("host")` reflected into `codeBlock` is `escapeHtml`-escaped (incl. `"`), so no XSS; every identifier Task 5 removes exists and the kept strings ("Context Usage"/"Uso de Contexto") survive; no test asserts the old onboarding/getPreview values; all TDD commit boundaries are green.

**Suggestions adopted:**
1. **Dropped the external `connect.openDocs` button** — re-linking the maestro.press per-platform docs (which Task 5 de-emphasizes, and which is not verified live) would be inconsistent; the wizard is now self-contained. Removed the key from the Task 1 block, the `CONNECT_KEYS` test array, and `moreLinks()`.
2. **Documented the `<ol>` decision** — the spec's "numbered sequence" is consciously folded into a single lead sentence per tab (one-or-two-step instructions); noted in `block()`'s doc comment and the spec aligned to match. Not a silent drop.

**Suggestions noted but not changed (non-blocking):** bare endpoint URL in a `codeBlock` for Cline/Gemini (cosmetic; the copy button is useful for a URL); `getPreview()` returns English-only (no regression — the prior `"8 platforms"` was also English-only).
