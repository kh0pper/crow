# F6b — First-Run Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided, bilingual (EN/ES), orient-and-route first-run onboarding flow that shows automatically after a new user sets their dashboard password and is replayable from Settings → Help & Setup.

**Architecture:** One new hidden dashboard panel (`panels/onboarding.js`) renders a 5-step guided tour driven by a `?step=N` query param (server-rendered, no client JS). Each step explains one thing and deep-links (new tab) to the existing surface that does the work (Settings → Integrations, Bot Builder, Settings → Help & Setup). Two tiny wiring changes: register the panel + redirect first-run logins to it (`index.js`), and add a replay link (`help-setup.js`). No `.env` writes, no inline config, no new DB tables.

**Tech Stack:** Node ESM, Express, the F6a design-system primitives (`stepper`, `section`, `callout`, `button` from `shared/components.js`), the flat-key i18n module (`shared/i18n.js`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-10-f6b-first-run-onboarding-design.md`

**Conventions (load-bearing):**
- Commit with explicit paths: `git commit <path> -m "..."` (never `git add` + bare commit — parallel sessions share the tree). Verify `git show --stat HEAD` after each commit. Never add a Claude co-author trailer.
- crow.md writing rules: **no em dashes** (use commas/semicolons/colons/periods/parentheses); no "not X, but Y" contrast. All copy below already complies.
- Token gotcha: never write a literal `var(--crow-<alnum>${...})` (even in a comment) — the F6a token-completeness scanner mis-reads it. All token refs below are complete literals.

---

## File Structure

| File | Responsibility |
|---|---|
| `servers/gateway/dashboard/panels/onboarding.js` | **new** — hidden panel; renders the 5-step `?step` flow; resolves lang cookie-first |
| `servers/gateway/dashboard/shared/i18n.js` | **modify** — add the `onboarding.*` EN/ES key block |
| `servers/gateway/dashboard/index.js` | **modify** — import + register the panel; redirect first-run logins to `/dashboard/onboarding` |
| `servers/gateway/dashboard/settings/sections/help-setup.js` | **modify** — add bilingual "Replay setup guide" link |
| `tests/onboarding.test.js` | **new** — i18n parity, step render, clamping, identity, bilingual |
| `docs/architecture/dashboard.md` | **modify** — short note documenting the hidden onboarding panel |

---

## Task 0: Create the feature branch

- [ ] **Step 1: Branch off main**

```bash
cd /home/kh0pp/crow
git checkout main && git pull --rebase
git checkout -b feat/f6b-first-run-onboarding
```

Expected: `Switched to a new branch 'feat/f6b-first-run-onboarding'`.

---

## Task 1: i18n keys for the onboarding namespace

**Files:**
- Modify: `servers/gateway/dashboard/shared/i18n.js` (insert a new key block before the closing `};` of the `translations` object at line ~740)
- Test: `tests/onboarding.test.js` (new — parity test only in this task)

- [ ] **Step 1: Write the failing parity test**

Create `tests/onboarding.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

// The full set of onboarding.* keys the feature depends on. t() returns the
// key string unchanged when a key is missing, so "resolves" == "value present".
export const ONBOARDING_KEYS = [
  "onboarding.title",
  "onboarding.welcome.title", "onboarding.welcome.body",
  "onboarding.integrations.title", "onboarding.integrations.body",
  "onboarding.integrationsNote", "onboarding.openIntegrations",
  "onboarding.bot.title", "onboarding.bot.body", "onboarding.openBotBuilder",
  "onboarding.connect.title", "onboarding.connect.body",
  "onboarding.connectNote", "onboarding.openConnections",
  "onboarding.done.title", "onboarding.done.body", "onboarding.doneNote",
  "onboarding.btnNext", "onboarding.btnBack", "onboarding.btnSkip",
  "onboarding.btnGoDashboard", "onboarding.replayLink",
];

test("every onboarding.* key resolves in both en and es", () => {
  for (const k of ONBOARDING_KEYS) {
    const en = i18n.t(k, "en");
    const es = i18n.t(k, "es");
    assert.ok(en && en !== k, `missing en value for ${k}`);
    assert.ok(es && es !== k, `missing es value for ${k}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/onboarding.test.js`
Expected: FAIL — `missing en value for onboarding.title` (keys not added yet).

- [ ] **Step 3: Add the onboarding key block to i18n.js**

In `servers/gateway/dashboard/shared/i18n.js`, immediately before the line `};` that closes the `translations` object (currently line ~740, right after the `"contacts.importButton"` entry), insert:

```js

  // ─── Onboarding (first-run guided tour) ───
  "onboarding.title": { en: "Welcome to Crow", es: "Bienvenido a Crow" },
  "onboarding.welcome.title": { en: "Welcome", es: "Bienvenido" },
  "onboarding.welcome.body": {
    en: "Crow is your persistent memory and research assistant. It remembers what matters and works across the AI clients you already use. This short tour points you to the few things worth setting up.",
    es: "Crow es tu asistente de memoria persistente e investigación. Recuerda lo importante y funciona con los clientes de IA que ya usas. Este breve recorrido te muestra las pocas cosas que vale la pena configurar.",
  },
  "onboarding.integrations.title": { en: "Connect your tools", es: "Conecta tus herramientas" },
  "onboarding.integrations.body": {
    en: "Link services like Google, Slack, and GitHub so Crow can act on them for you. You add API keys in Settings, where each integration explains what it needs.",
    es: "Conecta servicios como Google, Slack y GitHub para que Crow pueda actuar en ellos por ti. Agrega las claves API en Ajustes, donde cada integración explica lo que necesita.",
  },
  "onboarding.integrationsNote": {
    en: "Some integrations need a gateway restart to take effect after you add their keys.",
    es: "Algunas integraciones requieren reiniciar el gateway para activarse después de agregar sus claves.",
  },
  "onboarding.openIntegrations": { en: "Open Integrations", es: "Abrir Integraciones" },
  "onboarding.bot.title": { en: "Set up a bot", es: "Configura un bot" },
  "onboarding.bot.body": {
    en: "Crow can run bots on channels like Gmail and Discord, each with its own persona, skills, and tools. Create one in the Bot Builder.",
    es: "Crow puede ejecutar bots en canales como Gmail y Discord, cada uno con su propia personalidad, habilidades y herramientas. Crea uno en el Bot Builder.",
  },
  "onboarding.openBotBuilder": { en: "Open Bot Builder", es: "Abrir Bot Builder" },
  "onboarding.connect.title": { en: "Connect an AI client", es: "Conecta un cliente de IA" },
  "onboarding.connect.body": {
    en: "Use Crow's memory and tools from Claude Code, claude.ai, and other clients over MCP.",
    es: "Usa la memoria y herramientas de Crow desde Claude Code, claude.ai y otros clientes mediante MCP.",
  },
  "onboarding.connectNote": {
    en: "A guided connect wizard is on the way. For now, the connection URLs and per-platform steps live in Settings, Help and Setup.",
    es: "Un asistente de conexión guiado está en camino. Por ahora, las URLs de conexión y los pasos por plataforma están en Ajustes, Ayuda y configuración.",
  },
  "onboarding.openConnections": { en: "View connection URLs", es: "Ver URLs de conexión" },
  "onboarding.done.title": { en: "You're all set", es: "Todo listo" },
  "onboarding.done.body": {
    en: "That's the tour. Explore the dashboard at your own pace. Everything here is available from the sidebar.",
    es: "Eso es todo. Explora el panel a tu ritmo. Todo está disponible en la barra lateral.",
  },
  "onboarding.doneNote": {
    en: "You can replay this guide anytime from Settings, Help and Setup.",
    es: "Puedes repetir esta guía cuando quieras desde Ajustes, Ayuda y configuración.",
  },
  "onboarding.btnNext": { en: "Next", es: "Siguiente" },
  "onboarding.btnBack": { en: "Back", es: "Atrás" },
  "onboarding.btnSkip": { en: "Skip to dashboard", es: "Ir al panel" },
  "onboarding.btnGoDashboard": { en: "Go to the dashboard", es: "Ir al panel" },
  "onboarding.replayLink": { en: "Replay setup guide", es: "Repetir guía de configuración" },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/onboarding.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/shared/i18n.js tests/onboarding.test.js
git commit servers/gateway/dashboard/shared/i18n.js tests/onboarding.test.js -m "F6b: onboarding.* i18n keys (EN/ES) + parity test"
git show --stat HEAD
```

Expected: 2 files changed.

---

## Task 2: The onboarding panel

**Files:**
- Create: `servers/gateway/dashboard/panels/onboarding.js`
- Test: `tests/onboarding.test.js` (append render/clamp/identity/bilingual tests)

- [ ] **Step 1: Write the failing panel tests**

Append to `tests/onboarding.test.js`:

```js
import onboardingPanel from "../servers/gateway/dashboard/panels/onboarding.js";

// Invoke the panel handler with a stubbed layout (returns content for assertions).
// parseCookies reads req.headers.cookie, so headers must always be an object.
async function render(query = {}, cookie = "") {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query, headers: cookie ? { cookie } : {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en" });
  return typeof out === "string" ? out : captured;
}

test("panel identity: id / route / hidden", () => {
  assert.equal(onboardingPanel.id, "onboarding");
  assert.equal(onboardingPanel.route, "/dashboard/onboarding");
  assert.equal(onboardingPanel.hidden, true);
});

test("renders all 5 steps with the stepper and step-specific deep links", async () => {
  const deepLinkPerStep = [
    null,                                              // 0 welcome — no deep link
    "/dashboard/settings?section=integrations",        // 1 integrations
    "/dashboard/bot-builder",                          // 2 bot
    "/dashboard/settings?section=help-setup",          // 3 connect
    null,                                              // 4 done — go to dashboard
  ];
  for (let step = 0; step < 5; step++) {
    const html = await render({ step: String(step) });
    assert.ok(html.includes("stepper"), `step ${step} renders the stepper`);
    assert.ok(html.includes("step-active"), `step ${step} marks the active step`);
    if (deepLinkPerStep[step]) {
      assert.ok(html.includes(deepLinkPerStep[step]), `step ${step} links to ${deepLinkPerStep[step]}`);
    }
  }
  const done = await render({ step: "4" });
  assert.ok(done.includes('href="/dashboard"'), "last step links to the dashboard");
});

test("clamps out-of-range / non-numeric step to a valid page without throwing", async () => {
  for (const step of ["-1", "99", "abc"]) {
    const html = await render({ step });
    assert.ok(html.includes("stepper"), `step=${step} still renders a valid page`);
  }
  const noParam = await render({});
  assert.ok(noParam.includes("stepper"), "missing step param renders step 0");
  // Express parses ?step=1&step=2 into an array; parseInt stringifies it and
  // reads the leading int, so it must clamp/render rather than throw.
  const arrayStep = await render({ step: ["1", "2"] });
  assert.ok(arrayStep.includes("stepper"), "array step param still renders");
});

test("honors the crow_lang=es cookie for Spanish copy", async () => {
  const es = await render({ step: "0" }, "crow_lang=es");
  const en = await render({ step: "0" }, "crow_lang=en");
  assert.notEqual(es, en, "ES and EN render differently");
  assert.ok(es.includes(i18n.t("onboarding.welcome.body", "es")), "ES body present");
  assert.ok(en.includes(i18n.t("onboarding.welcome.body", "en")), "EN body present");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/onboarding.test.js`
Expected: FAIL — `Cannot find module '.../panels/onboarding.js'`.

- [ ] **Step 3: Create the panel**

Create `servers/gateway/dashboard/panels/onboarding.js`:

```js
/**
 * First-run onboarding — a hidden, server-rendered guided tour shown once after
 * a new user sets their dashboard password (and replayable from Settings, Help
 * and Setup). Orient-and-route: each step explains one thing and deep-links to
 * the existing surface that does the work. No inline config, no .env writes.
 * Step navigation is a ?step=N query param (no client JS; refresh/back safe).
 */
import { stepper, section, callout, button } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";

const STEP_KEYS = ["welcome", "integrations", "bot", "connect", "done"];

/**
 * Resolve language cookie-first. The panel-dispatch lang derives from the DB
 * "language" setting, which a brand-new user has not set, so it would default
 * to English even for a user who chose Spanish on the setup/login pages. Those
 * pages persist the choice in the crow_lang cookie, so honor it here (matches
 * what settings/sections/help-setup.js already does).
 */
function resolveLang(req) {
  return parseCookies(req).crow_lang === "es" ? "es" : "en";
}

/** A secondary button that opens an existing surface in a new tab so the tour
 *  stays open behind it. */
function deepLink(label, href) {
  return button(label, { variant: "secondary", href, attrs: 'target="_blank" rel="noopener"' });
}

function renderStepBody(stem, lang) {
  const body = `<p style="font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-4)">${t(`onboarding.${stem}.body`, lang)}</p>`;
  const linkWrap = (html) => `<div style="margin-top:var(--crow-space-4)">${html}</div>`;
  switch (stem) {
    case "integrations":
      return body + callout(t("onboarding.integrationsNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openIntegrations", lang), "/dashboard/settings?section=integrations"));
    case "bot":
      return body + linkWrap(deepLink(t("onboarding.openBotBuilder", lang), "/dashboard/bot-builder"));
    case "connect":
      return body + callout(t("onboarding.connectNote", lang), "info")
        + linkWrap(deepLink(t("onboarding.openConnections", lang), "/dashboard/settings?section=help-setup"));
    case "done":
      return body + callout(t("onboarding.doneNote", lang), "success");
    case "welcome":
    default:
      return body;
  }
}

function renderNav(current, lang) {
  const last = STEP_KEYS.length - 1;
  const parts = [];
  if (current > 0) {
    parts.push(button(t("onboarding.btnBack", lang), { variant: "ghost", href: `/dashboard/onboarding?step=${current - 1}` }));
  }
  if (current < last) {
    parts.push(button(t("onboarding.btnSkip", lang), { variant: "ghost", href: "/dashboard" }));
    parts.push(button(t("onboarding.btnNext", lang), { variant: "primary", href: `/dashboard/onboarding?step=${current + 1}` }));
  } else {
    parts.push(button(t("onboarding.btnGoDashboard", lang), { variant: "primary", href: "/dashboard" }));
  }
  return `<div style="display:flex;gap:var(--crow-space-3);margin-top:var(--crow-space-5);flex-wrap:wrap">${parts.join("")}</div>`;
}

export default {
  id: "onboarding",
  name: "Onboarding",        // literal; never shown (hidden panel)
  icon: "skills",            // unused while hidden; present for registry shape parity
  route: "/dashboard/onboarding",
  navOrder: 96,
  category: "tools",
  hidden: true,              // reachable by URL + first-run redirect, not in the sidebar

  async handler(req, res, { layout }) {
    const lang = resolveLang(req);

    // Clamp step into [0, last]; non-numeric or out-of-range falls to a valid page.
    const raw = parseInt(req.query.step, 10);
    const last = STEP_KEYS.length - 1;
    const current = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), last) : 0;
    const stem = STEP_KEYS[current];

    const steps = STEP_KEYS.map((k) => ({ label: t(`onboarding.${k}.title`, lang) }));
    const content =
      stepper(steps, current) +
      section(t(`onboarding.${stem}.title`, lang), renderStepBody(stem, lang)) +
      renderNav(current, lang);

    return layout({ title: t("onboarding.title", lang), content });
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/onboarding.test.js`
Expected: PASS (5 tests: parity, identity, steps, clamping, bilingual).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/panels/onboarding.js tests/onboarding.test.js
git commit servers/gateway/dashboard/panels/onboarding.js tests/onboarding.test.js -m "F6b: onboarding panel (5-step ?step flow, bilingual, deep-links) + tests"
git show --stat HEAD
```

Expected: 2 files changed.

---

## Task 3: Register the panel + first-run redirect

**Files:**
- Modify: `servers/gateway/dashboard/index.js` (import ~line 77; register ~line 104; redirect ~line 131 + ~line 190)

This task is wiring (no isolated unit test — the change is exercised by booting the gateway). Verify with `node --check` and a boot smoke test.

- [ ] **Step 1: Import the panel**

In `servers/gateway/dashboard/index.js`, after the line:

```js
import designSystemPanel from "./panels/design-system.js";
```

add:

```js
import onboardingPanel from "./panels/onboarding.js";
```

- [ ] **Step 2: Register the panel**

After the line:

```js
  registerPanel(designSystemPanel);
```

add:

```js
  registerPanel(onboardingPanel);
```

- [ ] **Step 3: Capture the first-run flag**

In the `POST /dashboard/login` handler, find:

```js
    const hasPassword = await isPasswordSet();
```

(inside the login POST, currently line ~131). Immediately after it, add:

```js
    const wasFirstSetup = !hasPassword;
```

- [ ] **Step 4: Redirect first-run logins to onboarding**

Find the final success redirect (currently line ~190):

```js
    setSessionCookie(res, result.token);
    res.redirectAfterPost("/dashboard");
```

Change the redirect to:

```js
    setSessionCookie(res, result.token);
    res.redirectAfterPost(wasFirstSetup ? "/dashboard/onboarding" : "/dashboard");
```

(Leave the `needs2faSetup()` branch above it untouched — managed-hosting 2FA first-run is a documented non-goal and keeps landing in `/dashboard`.)

- [ ] **Step 5: Syntax check + run the full suite**

Run:
```bash
node --check servers/gateway/dashboard/index.js && echo "syntax ok"
node --test tests/onboarding.test.js
```
Expected: `syntax ok`; onboarding tests still PASS.

- [ ] **Step 6: Boot smoke test (panel registers, gateway starts clean)**

Run the gateway in the background against a **throwaway data dir on a free port** (never the prod 3001 / dev state), confirm health, confirm the onboarding route is registered (it redirects unauthenticated requests to login rather than 404'ing), then stop it:

```bash
export CROW_DATA_DIR=$(mktemp -d)
PORT=3999 node servers/gateway/index.js --no-auth >/tmp/f6b-boot.log 2>&1 &
BOOT_PID=$!
sleep 4
curl -s -o /dev/null -w "health:%{http_code}\n" http://localhost:3999/health
curl -s -o /dev/null -w "onboarding:%{http_code}\n" http://localhost:3999/dashboard/onboarding
kill $BOOT_PID 2>/dev/null
grep -iE "error|throw|undefined is not" /tmp/f6b-boot.log || echo "no boot errors"
rm -rf "$CROW_DATA_DIR"; unset CROW_DATA_DIR
```

Expected: `health:200`; `onboarding:` a 200 or 3xx (route exists, not 404); `no boot errors`. (Using a `mktemp -d` data dir + `PORT=3999` keeps this fully isolated from the running prod gateway on 3001 and from real dev data. If the gateway needs an initialized DB to boot, run `CROW_DATA_DIR=$CROW_DATA_DIR node scripts/init-db.js` first.)

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/dashboard/index.js
git commit servers/gateway/dashboard/index.js -m "F6b: register onboarding panel + redirect first-run logins to it"
git show --stat HEAD
```

Expected: 1 file changed.

---

## Task 4: Replay link in Help & Setup

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/help-setup.js`
- Test: `tests/onboarding.test.js` (append a replay-link render test)

- [ ] **Step 1: Write the failing test**

Append to `tests/onboarding.test.js`:

```js
import helpSetupSection from "../servers/gateway/dashboard/settings/sections/help-setup.js";

test("Help & Setup renders a replay link to the onboarding tour", async () => {
  // Stub db.execute for the language lookup; no cookie => default English.
  const db = { execute: async () => ({ rows: [] }) };
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/onboarding?step=0"), "links to onboarding step 0");
  assert.ok(html.includes(i18n.t("onboarding.replayLink", "en")), "uses the replay link label");
});

test("Help & Setup replay link honors Spanish (DB language = es)", async () => {
  // render() resolves language DB-first; lock that the ES label is emitted so a
  // future refactor that drops cookie/DB resolution is caught.
  const db = { execute: async () => ({ rows: [{ value: "es" }] }) };
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/onboarding?step=0"), "links to onboarding step 0");
  assert.ok(html.includes(i18n.t("onboarding.replayLink", "es")), "uses the ES replay label");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/onboarding.test.js`
Expected: FAIL — `links to onboarding step 0` (link not added yet).

- [ ] **Step 3: Add the replay link to help-setup.js**

In `servers/gateway/dashboard/settings/sections/help-setup.js`, the `render` method ends with a returned template literal beginning with:

```js
    return `
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.platformSetup}</h4>
```

Replace that opening (the `return \`` line and the first `<h4>` line) with a version that prepends the replay link. The `t` function is already imported and `currentLang` is already resolved earlier in the method:

```js
    const replayHtml = `<p style="margin-bottom:1rem"><a href="/dashboard/onboarding?step=0" style="color:var(--crow-accent);text-decoration:none;font-weight:600">&#8635; ${escapeHtml(t("onboarding.replayLink", currentLang))}</a></p>`;
    return `
      ${replayHtml}
      <h4 style="font-size:0.9rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${ht.platformSetup}</h4>
```

(Leave the rest of the returned template unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/onboarding.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/settings/sections/help-setup.js tests/onboarding.test.js
git commit servers/gateway/dashboard/settings/sections/help-setup.js tests/onboarding.test.js -m "F6b: replayable onboarding link in Help & Setup + test"
git show --stat HEAD
```

Expected: 2 files changed.

---

## Task 5: Documentation + final verification

**Files:**
- Modify: `docs/architecture/dashboard.md`

- [ ] **Step 1: Document the onboarding panel**

Append to `docs/architecture/dashboard.md` (at the end of the file) the following section:

```markdown

## First-run onboarding (F6b)

`panels/onboarding.js` is a hidden dashboard panel (`hidden: true`, route `/dashboard/onboarding`) that renders a 5-step guided tour (Welcome, Integrations, Bot, Connect, Done) driven by a `?step=N` query param — server-rendered, no client JS. It is **orient-and-route**: each step explains one thing and deep-links (new tab) to the surface that does the work (Settings → Integrations, Bot Builder, Settings → Help & Setup). It writes nothing.

It is shown automatically once: `POST /dashboard/login` redirects to it the first time a password is set (`wasFirstSetup` branch in `index.js`); normal logins go straight to `/dashboard`. It is replayable anytime via the "Replay setup guide" link in Settings → Help & Setup.

Copy is bilingual (EN/ES) via the `onboarding.*` keys in `shared/i18n.js`; the handler resolves language cookie-first (`crow_lang`) so a user who chose Spanish at setup gets Spanish onboarding. Tests: `tests/onboarding.test.js`.
```

- [ ] **Step 2: Run the full onboarding suite + the F6a token test (regression)**

Run:
```bash
node --test tests/onboarding.test.js tests/design-system.test.js
```
Expected: ALL PASS. The F6a token-completeness test (`design-system.test.js`) walks the whole dashboard tree, so it now also covers `panels/onboarding.js` — a PASS confirms the new panel uses only defined `--crow-*` tokens.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/dashboard.md
git commit docs/architecture/dashboard.md -m "F6b: document first-run onboarding panel in dashboard architecture"
git show --stat HEAD
```

Expected: 1 file changed.

- [ ] **Step 4: Final review gate (before merge)**

Stop here for the holistic review (subagent-driven-development's final review, then finishing-a-development-branch). Do NOT merge or deploy in this plan. Deploy is a separate attended step:
- Deploy = `git pull` + **gateway restart** (the panel + CSS/JS load at startup), one host at a time, verify-after (`systemctl is-active`, `NRestarts=0`, `/dashboard`→403/303, `/health`→200; black-swan starts slowly). No `init-db`. The 4 prod `pibot-*@crow-mpa` bot units are unaffected by gateway restarts.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Hidden panel + 5 steps → Task 2. ✓
- First-run redirect trigger → Task 3 (steps 3-4). ✓
- Replay link in Help & Setup → Task 4. ✓
- Bilingual EN/ES + cookie-first lang → Task 1 (keys) + Task 2 (resolveLang + bilingual test). ✓
- Server-side `?step` + clamping → Task 2 (handler + clamp test). ✓
- Deep-link targets (verified `?section=` scheme, not hash anchors) → Task 2. ✓
- Tests: i18n parity, step render, clamping, identity, bilingual, replay link → Tasks 1/2/4. ✓
- Docs note → Task 5. ✓
- Non-goals (no inline config, no F6c duplication, no 2FA path) → respected; redirect change is a single ternary leaving the 2FA branch alone. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; all copy is final EN/ES text. ✓

**Type/name consistency:** `STEP_KEYS`, `resolveLang`, `deepLink`, `renderStepBody`, `renderNav` used consistently between panel and tests; i18n keys identical between Task 1 block, the panel, and the `ONBOARDING_KEYS` test list. Deep-link URLs identical between panel (`renderStepBody`) and the test's `deepLinkPerStep`. ✓

**Em-dash / writing-rule check:** all `onboarding.*` copy uses periods/commas/parentheses, no em dashes, no "not X but Y". (The `dashboard.md` doc prose may use em dashes — that is developer docs, not Crow-authored UI copy, so the crow.md rule does not apply.) ✓

---

## Review

**Reviewer:** adversarial staff-engineer subagent (Plan agent), verifying every claim against the live tree.
**Date:** 2026-06-10
**Verdict:** APPROVE (no critical issues).

The review confirmed against the actual code: the redirect edit is safe (all first-run early-return paths at `index.js:137/140/145/171/174/183` correctly leave `wasFirstSetup` irrelevant or land on the documented 2FA non-goal; `redirectAfterPost` is defined at `servers/gateway/index.js:182`; fixed-string target → no open-redirect); the hidden-panel manifest mirrors the proven `design-system.js` and routes via `getPanel` while `getVisiblePanels` (`panel-registry.js:100-103`) keeps it out of the sidebar/home-redirect; the i18n block inserts validly before the `};` at `i18n.js:740` and `t()` returns the key when missing (parity logic valid); the help-setup edit has `escapeHtml`/`t`/`currentLang` in scope and the `db.execute(...).rows` stub matches; `escapeHtml` (`components.js:5-7`) escapes only `& < > "`, and no deep-link href contains `&`, so the `includes()` assertions survive; all panel tokens (`--crow-text-base/-secondary`, `--crow-leading-relaxed`, `--crow-space-3/4/5`, `--crow-accent`) are defined and the F6a tree-walk test covers the new panel; and `?step` as an array does not throw.

**Suggestions adopted (all three):**
1. Added a second help-setup test asserting the Spanish replay label when DB `language = es` (locks cookie/DB-first resolution against future refactors) — Task 4.
2. Added a `?step=["1","2"]` array edge assertion to the clamping test — Task 2.
3. Made the boot smoke test default to a throwaway `mktemp -d` `CROW_DATA_DIR` + `PORT=3999` (never prod 3001 / real dev state) — Task 3 Step 6.

**Open UX note (intentional, not a defect):** step 2's "Open Bot Builder" deep-link uses `target="_blank"` even though Bot Builder is an in-app panel. This is the deliberate "keep the tour open behind you" behavior from the spec, applied uniformly to all deep-links.
