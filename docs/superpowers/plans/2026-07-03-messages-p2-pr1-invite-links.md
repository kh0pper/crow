# Messages Phase 2 PR1 — Invite Links + QR + One Surface (C1+C3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person invite becomes a shareable **link + QR** (pointing at a public *static* page with the code in the URL fragment — zero new gateway surface), the recipient's own dashboard accepts a `?invite=` deep link with a pre-filled confirm card, and the Contacts panel gains the full peer-add flow through **one shared component** used by both Contacts and Messages.

**Architecture:** Four pieces. (1) **`servers/sharing/invite-url.js`** — pure URL builder/parser: `buildInviteUrl(code)` = `${base}#${encodeURIComponent(code)}` where base is `CROW_INVITE_PAGE_URL` or the product default `https://maestro.press/software/crow/invite/`; `extractInviteCode(input)` forgives users pasting a whole URL anywhere a code is expected. (2) **`servers/gateway/dashboard/shared/peer-invite-ui.js`** — the ONE shared component (C3): parses the code out of `crow_generate_invite`'s text, builds `{code, url, qrDataUrl}` (QR via the existing `qrcode` dep, same pattern as `bot-builder/editor.js:441-444`), and renders the share block + the generate/accept forms both panels embed. (3) **Panel integration** — Messages keeps its tray entry but renders the shared forms, gains the `?invite=` deep-link card (modeled on the existing `?bot_invite=` card at `messages/html.js:35-44`) and surfaces accept errors in the existing banner instead of a silent redirect; Contacts gains an "Add a peer" section beside its R4 `add_by_id` repair form. (4) **`docs/public/invite/index.html`** — the self-contained bilingual static page (VitePress serves `docs/public/` verbatim at the site root → `https://maestro.press/software/crow/invite/`); it reads `location.hash`, never sends the code anywhere, and walks first-timers through install.

**Tech Stack:** Node ESM, `qrcode` (already a dependency, `package.json:76`), Node built-in test runner. **No new dependencies. No schema change → NO `SCHEMA_GENERATION` bump** (stays 3); plain-restart deploy.

## Global Constraints

- **Commit with a positional path arg**: `git commit <path> -m "..."`, never `git add <path> && git commit` (bare). For NEW files, `git add <thatpath>` first, then `git commit <thatpath> ... -m`. Verify with `git show --stat HEAD` after each commit. Substantial untracked WIP in the tree (`bundles/`, `bots/`, `scripts/`) must never be swept.
- **`git pull --rebase` before any push** — parallel sessions push to `main`.
- **Never attribute Claude as a co-author**; never add Claude as a contributor.
- **Tests**: `node --test tests/<file>.test.js`. Full suite must stay green (`node --test tests/` — 982/982 on `main` as of `356924a9`).
- **XSS discipline**: every interpolated user/tool value in HTML goes through `escapeHtml` (from `servers/gateway/dashboard/shared/components.js:5`) — the R2 review standard.
- **Never instantiate the sharing client from render code** — QR/share building happens in panel *loaders/handlers*; `peer-invite-ui.js` renderers are pure sync string functions (the QW2 live-socket trap).
- **The invite code NEVER appears in a URL query or server log** — fragment (`#`) only in links; `console.error` lines must not echo `req.body.invite_code`.
- **Kiosk guards**: `crow_generate_invite` kiosk-guards at `servers/sharing/tools/contacts.js:44`; **`crow_accept_invite` does NOT (pre-existing gap)** — Task 1 adds the guard as the handler's first line, so every new accept surface (Contacts section, `?invite=` deep link) is covered. Nothing may bypass the tools.
- **i18n**: every new user-visible string in `servers/gateway/dashboard/shared/i18n.js` with BOTH `en` and `es`. The static page carries its own bilingual strings (it is not a gateway render).
- **The network-exposure invariant is untouched**: NO new gateway routes, NO Funnel changes. The static page lives in `docs/public/` (GitHub Pages), not on any gateway.
- Branch: `feat/messages-p2-invite-links` (base = the spec/plan commits on `main`). Design spec: `docs/superpowers/specs/2026-07-03-messages-phase2-contact-add-ux-design.md` (§PR1).

---

## Background — the exact code being changed (verified @ `main` d920d258)

**Invite code + tool.** `generateInviteCode(identity)` (`servers/sharing/identity.js:287`) returns `` `${crowId}.${payload}.${hmac}` `` — `crowId` = `crow:` + 10 base36 chars, `payload`/`hmac` = base64url. `crow_generate_invite` (`servers/sharing/tools/contacts.js:38-63`) kiosk-guards then returns a text block containing the code in backticks: `` `\`${code}\`` ``. `crow_accept_invite` is the next tool in the same file (`:66`) taking `{ invite_code }`.

**Messages panel.** Loader `servers/gateway/dashboard/panels/messages.js`: POST → `handlePostAction` (`:35` comment: `false` = generate_invite, re-render); `?bot_invite=` parsed at `:67-78` into `botInvite = { code, name, csrf: csrfInput(req) }`; `buildMessagesHTML({ items, totalUnread, aiConfigured, storageAvailable, inviteResult: req._inviteResult, inviteError: req._inviteError, lang, botInvite, botDirectory, requests, csrf })` at `:82-95`. HTML builder `messages/html.js`: bot-invite card `:35-44`; `inviteBanner` renders `inviteResult` as a raw `<pre>` `:141-148` and `inviteError` `:149-155`; popover tray dialogs `#invite-generate` (`:223-229`, posts `generate_invite`) and `#invite-accept` (`:230-236`, textarea `invite_code`, posts `accept_invite`). POST handlers `messages/api-handlers.js`: `generate_invite` `:101-119` (stores `req._inviteResult = text`, returns `false`); `accept_invite` `:121-133` — **catches errors with only a `console.error` and redirects anyway** (silent failure; this plan fixes that). `handlePostAction` receives an injectable `sharingClientFactory` (QW2).

**Contacts panel.** Orchestrator `panels/contacts.js`: POST → `handleContactAction(req, db)` → honors `result?.redirect` / `result?.download`, else falls through to render (`:28-36`); list view calls `renderContactList(contacts, groups, filters, lang)`. `contacts/html.js`: toolbar + `addForm` (add_manual) + R4's `addByIdForm` (`:115-124`) + grid, returned at `:160`. `contacts/api-handlers.js`: local `makeSharingClient()` helper (`:20-27`, in-memory MCP pair); `add_by_id` action (`:98-119`) is the pattern for calling sharing tools; actions return `{ redirect: "/dashboard/contacts" }`. Contacts forms carry NO csrf input (panel convention; messages forms DO carry `${csrf}`).

**QR precedent.** `bot-builder/editor.js:441-444`: `const QRCode = (await import("qrcode")).default; const dataUrl = await QRCode.toDataURL(shareUrl, { width: 220, margin: 1 });` inside try/catch with QR optional.

**Docs site.** VitePress base `/software/crow/` (`docs/.vitepress/config.ts:6`) → public URL `https://maestro.press/software/crow/`. Files under `docs/public/` are copied verbatim to the site root (so `docs/public/invite/index.html` serves at `…/software/crow/invite/`). Markdown pages CANNOT carry plain inline `<script>` (VitePress treats them as Vue SFC blocks) — hence the verbatim file.

**Test scaffolding to reuse.** `tests/messages-add-bot-form.test.js` — string-level render tests against `buildMessagesHTML` with a `BASE` fixture + form-isolation helper. `tests/contacts-add-by-id-action.test.js` — contacts action-handler test pattern.

## File Structure

- **Create** `servers/sharing/invite-url.js` — pure: `DEFAULT_INVITE_PAGE_URL`, `invitePageBase(env)`, `buildInviteUrl(code, env)`, `extractInviteCode(input)`. Zero non-stdlib imports.
- **Modify** `servers/sharing/tools/contacts.js` — generate output gains the share-link line; accept runs `extractInviteCode` first (forgiving paste-a-URL).
- **Create** `servers/gateway/dashboard/shared/peer-invite-ui.js` — `parseInviteCodeFromText`, `buildInviteShare` (async, QR), `renderInviteShare` (sync), `renderPeerInviteForms` (sync). The C3 single component.
- **Modify** `servers/gateway/dashboard/shared/i18n.js` — new `invite.*` + `contacts.addPeer*` keys (EN+ES).
- **Modify** `servers/gateway/dashboard/panels/messages.js`, `messages/html.js`, `messages/api-handlers.js` — share block, `?invite=` card, error surfacing, shared forms.
- **Modify** `servers/gateway/dashboard/panels/contacts.js`, `contacts/html.js`, `contacts/api-handlers.js` — "Add a peer" section + generate/accept actions.
- **Create** `docs/public/invite/index.html` — the static page.
- **Create** tests: `tests/invite-url.test.js`, `tests/peer-invite-ui.test.js`, `tests/messages-invite-share.test.js`, `tests/contacts-peer-add.test.js`, `tests/invite-page.test.js`.

---

## Task 1: `invite-url.js` + tool integration

**Files:**
- Create: `servers/sharing/invite-url.js`
- Modify: `servers/sharing/tools/contacts.js` (crow_generate_invite text; crow_accept_invite input normalization)
- Test: `tests/invite-url.test.js`

**Interfaces:**
- Produces (later tasks rely on these exact signatures):
  - `DEFAULT_INVITE_PAGE_URL: string` — `"https://maestro.press/software/crow/invite/"`
  - `invitePageBase(env = process.env): string` — env override or default, trailing `#…` stripped, trimmed; never throws.
  - `buildInviteUrl(code, env = process.env): string` — `` `${invitePageBase(env)}#${encodeURIComponent(code)}` ``
  - `extractInviteCode(input): string` — trims; if the string contains `#`, returns `decodeURIComponent` of the part after the LAST `#` (empty string if nothing follows); else returns the trimmed input; `""` for null/undefined/non-string. Never throws (bad percent-encoding falls back to the raw fragment).

- [ ] **Step 1: Write the failing test**

Create `tests/invite-url.test.js`:

```js
// tests/invite-url.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INVITE_PAGE_URL,
  invitePageBase,
  buildInviteUrl,
  extractInviteCode,
} from "../servers/sharing/invite-url.js";

const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln"; // shape: crowId.payload.hmac

test("default base is the product invite page", () => {
  assert.equal(DEFAULT_INVITE_PAGE_URL, "https://maestro.press/software/crow/invite/");
  assert.equal(invitePageBase({}), DEFAULT_INVITE_PAGE_URL);
});

test("CROW_INVITE_PAGE_URL overrides the base (trimmed, fragment stripped)", () => {
  assert.equal(invitePageBase({ CROW_INVITE_PAGE_URL: " https://my.site/inv " }), "https://my.site/inv");
  assert.equal(invitePageBase({ CROW_INVITE_PAGE_URL: "https://my.site/inv#old" }), "https://my.site/inv");
  assert.equal(invitePageBase({ CROW_INVITE_PAGE_URL: "" }), DEFAULT_INVITE_PAGE_URL);
});

test("buildInviteUrl puts the code in the fragment, encoded", () => {
  const url = buildInviteUrl(CODE, {});
  assert.equal(url, `${DEFAULT_INVITE_PAGE_URL}#${encodeURIComponent(CODE)}`);
  assert.ok(!url.includes("?"), "no query string — fragment only");
});

test("extractInviteCode: raw code passes through trimmed", () => {
  assert.equal(extractInviteCode(`  ${CODE}\n`), CODE);
});

test("extractInviteCode: full invite URL yields the code", () => {
  assert.equal(extractInviteCode(buildInviteUrl(CODE, {})), CODE);
});

test("extractInviteCode: percent-encoded fragment is decoded", () => {
  assert.equal(extractInviteCode(`https://x/inv#${encodeURIComponent(CODE)}`), CODE);
});

test("extractInviteCode: edge cases never throw", () => {
  assert.equal(extractInviteCode(null), "");
  assert.equal(extractInviteCode(undefined), "");
  assert.equal(extractInviteCode(""), "");
  assert.equal(extractInviteCode("https://x/inv#"), "");
  assert.equal(extractInviteCode("no-hash-here"), "no-hash-here");
  // Bad percent-encoding: falls back to the raw fragment, does not throw.
  assert.equal(extractInviteCode("https://x/inv#%E0%A4%A"), "%E0%A4%A");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invite-url.test.js`
Expected: FAIL — `Cannot find module '../servers/sharing/invite-url.js'`

- [ ] **Step 3: Write the implementation**

Create `servers/sharing/invite-url.js`:

```js
/**
 * Invite URL helpers (Messages Phase 2 PR1 / C1).
 *
 * The share link points at a PUBLIC STATIC page (docs site — never a gateway)
 * with the invite code in the URL FRAGMENT, so no server ever receives or
 * logs the code. Pure module: no sharing-client imports, safe anywhere.
 */

export const DEFAULT_INVITE_PAGE_URL = "https://maestro.press/software/crow/invite/";

/** Resolve the invite-page base URL (env override for self-hosters). */
export function invitePageBase(env = process.env) {
  const raw = (env && typeof env.CROW_INVITE_PAGE_URL === "string") ? env.CROW_INVITE_PAGE_URL.trim() : "";
  if (!raw) return DEFAULT_INVITE_PAGE_URL;
  // A configured base must not itself carry a fragment.
  const hash = raw.indexOf("#");
  return hash === -1 ? raw : raw.slice(0, hash);
}

/** Build the shareable invite URL: base + '#' + encoded code. */
export function buildInviteUrl(code, env = process.env) {
  return `${invitePageBase(env)}#${encodeURIComponent(String(code))}`;
}

/**
 * Forgiving code extraction: users paste either a raw invite code OR a full
 * invite URL. If the input contains '#', take what follows the LAST '#'
 * (decoded); otherwise return the trimmed input. Never throws.
 */
export function extractInviteCode(input) {
  if (typeof input !== "string") return "";
  const s = input.trim();
  const hash = s.lastIndexOf("#");
  if (hash === -1) return s;
  const frag = s.slice(hash + 1).trim();
  if (!frag) return "";
  try {
    return decodeURIComponent(frag);
  } catch {
    return frag; // malformed percent-encoding — hand back the raw fragment
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invite-url.test.js`
Expected: PASS (7/7)

- [ ] **Step 5: Wire into the sharing tools**

In `servers/sharing/tools/contacts.js`:

(a) Add to the imports at the top (near the `identity.js` import at `:10`):

```js
import { buildInviteUrl, extractInviteCode } from "../invite-url.js";
```

(b) In `crow_generate_invite`'s handler (currently `:44-62`), compute the URL after the code and add TWO lines to the text array. The FULL handler body becomes (note the existing kiosk guard STAYS as line 1 — do not drop it):

```js
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_generate_invite");
      const code = generateInviteCode(identity);
      const url = buildInviteUrl(code);
      return {
        content: [
          {
            type: "text",
            text: [
              `Invite code generated (expires in 24 hours):`,
              ``,
              `\`${code}\``,
              ``,
              `Share link (opens a page with the code and instructions):`,
              url,
              ``,
              `Share this code with the person you want to connect with.`,
              `They should use \`crow_accept_invite\` with this code.`,
              `Your Crow ID: ${identity.crowId}`,
            ].join("\n"),
          },
        ],
      };
```

(c) In `crow_accept_invite`'s handler (`server.tool` at `:67`, body from `:74`), make the FIRST TWO lines of the handler body:

```js
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_accept_invite");
      invite_code = extractInviteCode(invite_code);
```

The kiosk guard is NEW — the accept handler is currently unguarded (verified: only `crow_generate_invite:44`, `crow_add_contact:182`, `crow_accept_bot_invite:209` guard today), and this plan widens the accept surface, so the guard ships with it. `isKioskActive`/`kioskBlockedResponse` are already imported in this file (used at `:44`). `invite_code` is a destructured parameter (reassignment legal). The extraction makes a pasted URL work from any MCP client, not just the dashboard.

- [ ] **Step 6: Document the env override**

Append to `.env.example` (with the neighboring optional-var comment style):

```bash
# Optional: override the public static page invite share-links point at
# (default: https://maestro.press/software/crow/invite/). Self-hosters only.
# CROW_INVITE_PAGE_URL=
```

- [ ] **Step 7: Sanity-run the neighboring sharing tests**

Run: `node --test tests/invite-url.test.js tests/contact-promote.test.js tests/invite-accepted-promote.test.js`
Expected: ALL PASS (the tool text change is additive; nothing parses the old text shape — verify with `grep -rn "Invite code generated" servers/ tests/ scripts/` → only `tools/contacts.js` defines it; if any consumer asserts the old exact text, update that assertion in this task).

- [ ] **Step 8: Commit**

```bash
git add servers/sharing/invite-url.js tests/invite-url.test.js
git commit servers/sharing/invite-url.js tests/invite-url.test.js servers/sharing/tools/contacts.js .env.example -m "feat(sharing): invite share URL builder + forgiving code extraction + kiosk-guard accept (P2/C1)"
git show --stat HEAD
```

---

## Task 2: `peer-invite-ui.js` shared component + i18n

**Files:**
- Create: `servers/gateway/dashboard/shared/peer-invite-ui.js`
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new keys, EN+ES)
- Test: `tests/peer-invite-ui.test.js`

**Interfaces:**
- Consumes: `buildInviteUrl` from `servers/sharing/invite-url.js` (Task 1); `escapeHtml` from `./components.js`; `t` from `./i18n.js`; dynamic `import("qrcode")`.
- Produces (Tasks 3+4 rely on these exact signatures):
  - `parseInviteCodeFromText(text): string|null` — first match of `/crow:[a-z0-9]{10}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/` in the tool's text output.
  - `async buildInviteShare(toolText, env = process.env): {code, url, qrDataUrl}|null` — null when no code found; `qrDataUrl` null when QR generation fails (optional, never throws).
  - `renderInviteShare(share, lang): string` — sync HTML share block ('' for falsy share).
  - `renderPeerInviteForms({ lang, csrf = "", prefillCode = "" }): { generateForm, acceptForm }` — sync HTML form strings (each a complete `<form method="POST">…</form>` posting `generate_invite` / `accept_invite`; `csrf` is included verbatim when non-empty; `prefillCode` pre-fills the accept textarea).

**i18n keys added (all EN+ES; exact copy below is the source of truth):**

```js
  // ─── Peer invite share (Messages Phase 2 PR1) ───
  "invite.shareLabel": { en: "Share this link", es: "Comparte este enlace" },
  "invite.shareHint": {
    en: "Anyone who sees this link can use the code inside it — send it over a channel you trust. It expires in 24 hours.",
    es: "Cualquiera que vea este enlace puede usar el código que contiene: envíalo por un canal de confianza. Caduca en 24 horas.",
  },
  "invite.copyLink": { en: "Copy link", es: "Copiar enlace" },
  "invite.rawCode": { en: "Or share the raw code", es: "O comparte el código directamente" },
  "invite.generateBtn": { en: "Create invite link", es: "Crear enlace de invitación" },
  "invite.acceptTitle": { en: "Accept an invite", es: "Aceptar una invitación" },
  "invite.pastePlaceholder": { en: "Paste an invite link or code...", es: "Pega un enlace o código de invitación..." },
  "invite.acceptBtn": { en: "Accept invite", es: "Aceptar invitación" },
  "invite.connectWith": { en: "Connect with", es: "Conectar con" },
  "invite.invalidCode": { en: "This invite looks invalid or has expired. Ask for a new one.", es: "Esta invitación parece inválida o ha caducado. Pide una nueva." },
  "invite.verifyLater": { en: "After connecting, compare safety numbers to verify each other.", es: "Después de conectar, comparen los números de seguridad para verificarse." },
  "contacts.addPeer": { en: "Add a Crow peer", es: "Añadir un par de Crow" },
  "contacts.addPeerDesc": { en: "Invite someone with a link or accept theirs", es: "Invita a alguien con un enlace o acepta el suyo" },
```

- [ ] **Step 1: Write the failing test**

Create `tests/peer-invite-ui.test.js`:

```js
// tests/peer-invite-ui.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInviteCodeFromText,
  buildInviteShare,
  renderInviteShare,
  renderPeerInviteForms,
} from "../servers/gateway/dashboard/shared/peer-invite-ui.js";
import { buildInviteUrl } from "../servers/sharing/invite-url.js";

const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln";
const TOOL_TEXT = [
  "Invite code generated (expires in 24 hours):", "",
  `\`${CODE}\``, "",
  "Share link (opens a page with the code and instructions):",
  buildInviteUrl(CODE, {}), "",
  "Your Crow ID: crow:abc123def0",
].join("\n");

test("parseInviteCodeFromText finds the backticked code", () => {
  assert.equal(parseInviteCodeFromText(TOOL_TEXT), CODE);
  assert.equal(parseInviteCodeFromText("no code here"), null);
  assert.equal(parseInviteCodeFromText(null), null);
});

test("buildInviteShare returns code+url (+ qr data URL) and never throws", async () => {
  const share = await buildInviteShare(TOOL_TEXT, {});
  assert.equal(share.code, CODE);
  assert.equal(share.url, buildInviteUrl(CODE, {}));
  // qrcode dep is installed in this repo — expect a data URL.
  assert.ok(share.qrDataUrl && share.qrDataUrl.startsWith("data:image/"), "QR data URL");
  assert.equal(await buildInviteShare("nothing", {}), null);
});

test("renderInviteShare renders url, QR, raw-code fallback, honest hint (en+es)", async () => {
  const share = await buildInviteShare(TOOL_TEXT, {});
  const en = renderInviteShare(share, "en");
  assert.ok(en.includes(share.url), "url shown");
  assert.ok(en.includes('src="data:image/'), "QR img");
  assert.ok(en.includes(CODE), "raw code fallback");
  assert.ok(en.includes("channel you trust"), "honest copy");
  assert.ok(en.includes("Copy link"), "copy button");
  const es = renderInviteShare(share, "es");
  assert.ok(es.includes("Copiar enlace"), "es copy button");
  assert.ok(!es.includes("invite.copyLink"), "no raw i18n keys");
  assert.equal(renderInviteShare(null, "en"), "");
});

test("renderInviteShare omits the QR img when qrDataUrl is null", () => {
  const html = renderInviteShare({ code: CODE, url: "https://x/#c", qrDataUrl: null }, "en");
  assert.ok(!html.includes("<img"), "no img without QR");
});

test("renderInviteShare escapes hostile values", () => {
  const html = renderInviteShare({ code: '<script>x</script>', url: '"><img onerror=1>', qrDataUrl: null }, "en");
  assert.ok(!html.includes("<script>"), "code escaped");
  assert.ok(!html.includes('"><img onerror'), "url escaped");
});

test("renderPeerInviteForms returns generate + accept forms with csrf and prefill", () => {
  const { generateForm, acceptForm } = renderPeerInviteForms({
    lang: "en", csrf: '<input type="hidden" name="_csrf" value="tok">', prefillCode: CODE,
  });
  assert.ok(generateForm.includes('value="generate_invite"'), "generate action");
  assert.ok(generateForm.includes('name="_csrf"'), "csrf in generate form");
  assert.ok(acceptForm.includes('value="accept_invite"'), "accept action");
  assert.ok(acceptForm.includes('name="invite_code"'), "accept field");
  assert.ok(acceptForm.includes(CODE), "prefill present");
  assert.ok(acceptForm.includes("Paste an invite link or code"), "placeholder resolved");
  const es = renderPeerInviteForms({ lang: "es" });
  assert.ok(es.acceptForm.includes("Pega un enlace"), "es placeholder");
});

test("renderPeerInviteForms escapes a hostile prefill", () => {
  const { acceptForm } = renderPeerInviteForms({ lang: "en", prefillCode: '</textarea><script>x</script>' });
  assert.ok(!acceptForm.includes("<script>"), "prefill escaped");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/peer-invite-ui.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, add the key block from the Interfaces section above (verbatim), placed after the existing `messages.*` key group (keep the file's `// ───` section-comment style).

- [ ] **Step 4: Write the implementation**

Create `servers/gateway/dashboard/shared/peer-invite-ui.js`:

```js
/**
 * Peer-invite shared component (Messages Phase 2 PR1 / C1+C3).
 *
 * The ONE component both the Messages tray and the Contacts "Add a peer"
 * section render. Pure sync renderers (no sharing-client imports — the QW2
 * trap); the async QR/share building happens in panel loaders/handlers.
 */

import { escapeHtml } from "./components.js";
import { t } from "./i18n.js";
import { buildInviteUrl } from "../../../sharing/invite-url.js";

const CODE_RE = /crow:[a-z0-9]{10}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

/** Find the invite code inside crow_generate_invite's text output. */
export function parseInviteCodeFromText(text) {
  if (typeof text !== "string") return null;
  const m = text.match(CODE_RE);
  return m ? m[0] : null;
}

/** Build { code, url, qrDataUrl } from the tool text. QR optional; never throws. */
export async function buildInviteShare(toolText, env = process.env) {
  const code = parseInviteCodeFromText(toolText);
  if (!code) return null;
  const url = buildInviteUrl(code, env);
  let qrDataUrl = null;
  try {
    const QRCode = (await import("qrcode")).default;
    qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
  } catch { /* qr optional */ }
  return { code, url, qrDataUrl };
}

/** Sync HTML share block: link + copy button + QR + raw-code fallback. */
export function renderInviteShare(share, lang) {
  if (!share || !share.url) return "";
  const url = escapeHtml(share.url);
  const qr = share.qrDataUrl
    ? `<div style="margin:.5rem 0"><img src="${escapeHtml(share.qrDataUrl)}" alt="QR" width="220" height="220" style="image-rendering:pixelated;border-radius:8px;background:#fff;padding:6px"></div>`
    : "";
  return `<div class="invite-share">
    <div style="font-size:0.8rem;font-weight:600;margin-bottom:4px">${t("invite.shareLabel", lang)}</div>
    <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 6px">${t("invite.shareHint", lang)}</p>
    <textarea readonly rows="2" onclick="this.select()" style="width:100%;font-size:0.75rem;word-break:break-all;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;padding:8px;color:var(--crow-text)">${url}</textarea>
    <button type="button" style="margin-top:4px;font-size:0.75rem;padding:4px 10px;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg-elevated);color:var(--crow-text);cursor:pointer" onclick="var u=this.previousElementSibling.value;(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(()=>{this.textContent=this.dataset.done},()=>{this.previousElementSibling.select()})" data-done="${escapeHtml(t("invite.copyLink", lang))} ✓">${t("invite.copyLink", lang)}</button>
    ${qr}
    <details style="margin-top:6px"><summary style="cursor:pointer;font-size:0.75rem;color:var(--crow-text-muted)">${t("invite.rawCode", lang)}</summary>
      <pre style="font-size:0.7rem;white-space:pre-wrap;word-break:break-all;background:var(--crow-bg-deep);padding:8px;border-radius:6px;margin:4px 0 0">${escapeHtml(share.code)}</pre>
    </details>
    <p style="font-size:0.7rem;color:var(--crow-text-muted);margin:6px 0 0">${t("invite.verifyLater", lang)}</p>
  </div>`;
}

/** Sync generate + accept form strings both panels embed. */
export function renderPeerInviteForms({ lang, csrf = "", prefillCode = "" }) {
  const generateForm = `<form method="POST">
    <input type="hidden" name="action" value="generate_invite">${csrf}
    <button type="submit" class="btn btn-primary" style="width:100%;font-size:0.8rem;padding:6px">${t("invite.generateBtn", lang)}</button>
  </form>`;
  const acceptForm = `<form method="POST">
    <input type="hidden" name="action" value="accept_invite">${csrf}
    <textarea name="invite_code" placeholder="${escapeHtml(t("invite.pastePlaceholder", lang))}" rows="3" required style="width:100%;font-size:0.75rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;padding:8px;color:var(--crow-text)">${escapeHtml(prefillCode)}</textarea>
    <button type="submit" class="btn btn-primary" style="width:100%;font-size:0.8rem;padding:6px;margin-top:4px">${t("invite.acceptBtn", lang)}</button>
  </form>`;
  return { generateForm, acceptForm };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/peer-invite-ui.test.js`
Expected: PASS (7/7)

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/shared/peer-invite-ui.js tests/peer-invite-ui.test.js
git commit servers/gateway/dashboard/shared/peer-invite-ui.js servers/gateway/dashboard/shared/i18n.js tests/peer-invite-ui.test.js -m "feat(dashboard): shared peer-invite component — share block, QR, forms (P2/C1+C3)"
git show --stat HEAD
```

---

## Task 3: Messages panel — share block, `?invite=` deep link, honest accept errors

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages.js` (loader: `?invite=` parse + share build)
- Modify: `servers/gateway/dashboard/panels/messages/html.js` (person-invite card; share block in banner; tray uses shared forms)
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js` (accept_invite: extract + surface errors)
- Test: `tests/messages-invite-share.test.js`

**Interfaces:**
- Consumes: `buildInviteShare`, `renderInviteShare`, `renderPeerInviteForms` (Task 2); `extractInviteCode` (Task 1); `parseInviteCode` from `servers/sharing/identity.js`.
- Produces: `buildMessagesHTML` gains two data fields — `inviteShare` (`{code,url,qrDataUrl}|null`) and `personInvite` (`{ code, fromId|null, csrf }|null`). Existing fields unchanged (additive; all current tests keep passing).

- [ ] **Step 1: Write the failing test**

Create `tests/messages-invite-share.test.js`:

```js
// tests/messages-invite-share.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

const BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  botDirectory: { groups: [], total: 0, notAddedCount: 0 },
  requests: [],
  csrf: '<input type="hidden" name="_csrf" value="tok">',
  inviteShare: null, personInvite: null,
};
const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln";
const SHARE = { code: CODE, url: `https://maestro.press/software/crow/invite/#${encodeURIComponent(CODE)}`, qrDataUrl: "data:image/png;base64,AAAA" };

test("inviteShare renders the share block (url + QR), not the raw pre dump", () => {
  const html = buildMessagesHTML({ ...BASE, inviteResult: "Invite code generated...", inviteShare: SHARE });
  assert.ok(html.includes(SHARE.url), "share url");
  assert.ok(html.includes('src="data:image/'), "QR");
  assert.ok(html.includes("Copy link"), "copy button");
});

test("inviteResult without a share still renders as before (fallback)", () => {
  const html = buildMessagesHTML({ ...BASE, inviteResult: "some tool text" });
  assert.ok(html.includes("some tool text"), "raw fallback preserved");
});

test("personInvite renders a pre-filled accept card with preview", () => {
  const html = buildMessagesHTML({ ...BASE, personInvite: { code: CODE, fromId: "crow:abc123def0", csrf: BASE.csrf } });
  const start = html.indexOf("msg-person-invite-card");
  assert.notEqual(start, -1, "card present");
  const card = html.slice(start, html.indexOf("</form>", start));
  assert.ok(card.includes('value="accept_invite"'), "posts accept_invite");
  assert.ok(card.includes(CODE), "code carried");
  assert.ok(card.includes("crow:abc123def0"), "peer preview");
  assert.ok(card.includes('name="_csrf"'), "csrf");
  assert.ok(html.includes("Connect with"), "i18n title");
});

test("personInvite with fromId=null shows invalid notice, no accept form", () => {
  const html = buildMessagesHTML({ ...BASE, personInvite: { code: "junk", fromId: null, csrf: BASE.csrf } });
  assert.ok(html.includes("invalid or has expired"), "invalid notice");
  const start = html.indexOf("msg-person-invite-card");
  const card = html.slice(start, start + 800);
  assert.ok(!card.includes('value="accept_invite"'), "no accept form for invalid code");
});

test("tray dialogs use the shared forms (same actions as before)", () => {
  const html = buildMessagesHTML({ ...BASE });
  const gen = html.indexOf('id="invite-generate"');
  const acc = html.indexOf('id="invite-accept"');
  assert.notEqual(gen, -1); assert.notEqual(acc, -1);
  assert.ok(html.slice(gen, acc).includes('value="generate_invite"'), "generate action kept");
  const accBlock = html.slice(acc, html.indexOf("</form>", acc));
  assert.ok(accBlock.includes('value="accept_invite"'), "accept action kept");
  assert.ok(accBlock.includes("Paste an invite link or code"), "shared placeholder");
});

test("spanish strings resolve", () => {
  const html = buildMessagesHTML({ ...BASE, lang: "es", personInvite: { code: CODE, fromId: "crow:abc123def0", csrf: BASE.csrf } });
  assert.ok(html.includes("Conectar con"), "es connectWith");
  assert.ok(!html.includes("invite.connectWith"), "no raw keys");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/messages-invite-share.test.js`
Expected: FAIL (no share block / no person card yet).

- [ ] **Step 3: Update `messages/html.js`**

(a) Add the import at the top (beside the existing shared imports at `:8-10`):

```js
import { renderInviteShare, renderPeerInviteForms } from "../../shared/peer-invite-ui.js";
```

(b) Destructure the two new fields at `:33`: add `inviteShare` and `personInvite` to the existing destructure list.

(c) **Person-invite card** — directly after the `botInviteCard` block (`:35-44`), add:

```js
  // Person-invite deep link (?invite=<code>) opened on THIS instance (P2/C1).
  let personInviteCard = "";
  if (personInvite) {
    personInviteCard = personInvite.fromId
      ? `<div class="msg-person-invite-card" style="margin:12px;padding:12px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">` +
        `<div style="font-size:0.85rem;font-weight:600;margin-bottom:6px">${t("invite.connectWith", lang)} ${escapeHtml(personInvite.fromId)}?</div>` +
        `<form method="POST" action="/dashboard/messages">` +
        `<input type="hidden" name="action" value="accept_invite">` +
        `<input type="hidden" name="invite_code" value="${escapeHtml(personInvite.code)}">` +
        `${personInvite.csrf || ""}` +
        `<button type="submit" class="msg-send-btn" style="font-size:0.8rem;padding:6px 14px">${t("invite.acceptBtn", lang)}</button>` +
        `</form></div>`
      : `<div class="msg-person-invite-card" style="margin:12px;padding:12px;background:var(--crow-bg-elevated);border:1px solid var(--crow-error);border-radius:8px">` +
        `<div style="font-size:0.8rem;color:var(--crow-error)">${t("invite.invalidCode", lang)}</div></div>`;
  }
```

and include `personInviteCard` in the final return concatenation right after `botInviteCard`.

(d) **Share block in the banner** — in the `inviteResult` branch (`:141-148`), render the share block when `inviteShare` is present, keeping the raw `<pre>` ONLY as the no-share fallback:

```js
  if (inviteResult) {
    const body = inviteShare
      ? renderInviteShare(inviteShare, lang)
      : `<pre style="font-size:0.75rem;white-space:pre-wrap;word-break:break-all;background:var(--crow-bg-deep);padding:8px;border-radius:6px;max-height:120px;overflow-y:auto">${escapeHtml(inviteResult)}</pre>`;
    inviteBanner = `<div style="position:absolute;top:0;left:0;right:0;z-index:50;padding:12px;background:var(--crow-bg-elevated);border-bottom:1px solid var(--crow-border);max-height:70%;overflow-y:auto">
      <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">${t("messages.inviteGenerated", lang)}</div>
      ${body}
      <button onclick="this.parentElement.remove()" style="margin-top:6px;font-size:0.75rem;background:none;border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-muted);cursor:pointer;padding:3px 8px">${t("messages.dismiss", lang)}</button>
    </div>`;
  }
```

(keep the existing `inviteError` branch as-is).

(e) **Tray funnels to the shared component** — replace the INNER `<form>…</form>` of `#invite-generate` (`:224-228`) and of `#invite-accept` (`:231-235`) with:

```js
        <div class="msg-invite-dialog" id="invite-generate">
          ${peerForms.generateForm}
        </div>
        <div class="msg-invite-dialog" id="invite-accept">
          ${peerForms.acceptForm}
        </div>
```

where, near the top of the function body (after the destructure), you add:

```js
  const peerForms = renderPeerInviteForms({ lang, csrf: csrf || "" });
```

(NOTE: this ADDS csrf to the person generate/accept tray forms, which previously lacked it — matching the group/bot forms in the same file, which already carry `${csrf}`. The POST layer accepts it.)

- [ ] **Step 4: Update `messages/api-handlers.js`**

(a) Add to imports:

```js
import { extractInviteCode } from "../../../../sharing/invite-url.js";
```

(b) Replace the `accept_invite` block (`:121-133`) with:

```js
  if (action === "accept_invite" && req.body.invite_code) {
    try {
      const code = extractInviteCode(req.body.invite_code);
      const client = await sharingClientFactory();
      let result;
      try {
        result = await client.callTool({
          name: "crow_accept_invite",
          arguments: { invite_code: code },
        });
      } finally { try { await client.close?.(); } catch {} }
      if (result?.isError) {
        req._inviteError = result.content?.[0]?.text || "Invite could not be accepted.";
        return false; // re-render with the error banner
      }
    } catch (err) {
      console.error("[messages] Failed to accept invite"); // never echo the code
      req._inviteError = err.message;
      return false;
    }
    return res.redirectAfterPost("/dashboard/messages");
  }
```

- [ ] **Step 5: Update the loader `messages.js`**

(a) Add to imports at the top:

```js
import { buildInviteShare } from "../shared/peer-invite-ui.js";
import { extractInviteCode } from "../../../sharing/invite-url.js";
```

(NOTE: `messages.js` lives at `panels/messages.js`; the shared dir is a SIBLING of `panels/`, so the specifier is `../shared/…` — exactly like the file's existing `../shared/csrf.js` import at `:18`. The sharing depth matches its existing `../../../sharing/identity.js` dynamic import at `:72`.)

(b) After the bot-invite parse block (`:67-78`), add the person-invite parse:

```js
    // --- Person-invite landing (?invite=<code or full URL>) — P2/C1 deep link.
    let personInvite = null;
    const piRaw = (req.query && req.query.invite) || null;
    if (piRaw) {
      const code = extractInviteCode(String(piRaw));
      let fromId = null;
      try {
        const { parseInviteCode } = await import("../../../sharing/identity.js");
        fromId = parseInviteCode(code).crowId;
      } catch { /* invalid/expired — card renders the invalid notice */ }
      personInvite = { code, fromId, csrf: csrfInput(req) };
    }
```

(c) Build the share object for the banner — right before the `buildMessagesHTML` call, add:

```js
    let inviteShare = null;
    if (req._inviteResult) {
      try { inviteShare = await buildInviteShare(req._inviteResult); } catch {}
    }
```

(d) Pass both new fields in the `buildMessagesHTML({...})` call: add `inviteShare,` and `personInvite,` beside the existing `botInvite,`.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/messages-invite-share.test.js tests/messages-add-bot-form.test.js tests/bot-directory-messages-surface.test.js tests/messages-room-i18n.test.js`
Expected: ALL PASS (new file green; the three neighbors prove the html-builder change is non-breaking).

- [ ] **Step 7: Commit**

```bash
git add tests/messages-invite-share.test.js
git commit tests/messages-invite-share.test.js servers/gateway/dashboard/panels/messages.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages/api-handlers.js -m "feat(messages): invite share block + ?invite= deep-link card + honest accept errors (P2/C1)"
git show --stat HEAD
```

---

## Task 4: Contacts panel — "Add a peer" section (C3)

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (generate_invite + accept_invite actions)
- Modify: `servers/gateway/dashboard/panels/contacts.js` (loader: thread invite results + share build)
- Modify: `servers/gateway/dashboard/panels/contacts/html.js` (Add-a-peer section in `renderContactList`)
- Test: `tests/contacts-peer-add.test.js`

**Interfaces:**
- Consumes: Task 2 renderers; Task 1 `extractInviteCode`; the handler's injectable `sharingClientFactory` param (signature `handleContactAction(req, db, { sharingClientFactory = makeSharingClient } = {})` at `api-handlers.js:33` — same injection `add_by_id` uses at `:103`).
- Produces: `handleContactAction` may return `{ inviteResult }` or `{ inviteError }` (new, alongside the existing `{ redirect }`/`{ download }`); `renderContactList(contacts, groups, filters, lang, peerAdd)` gains an optional 5th param `peerAdd = { inviteShare, inviteError, csrf }` (default `{}` — all existing call sites keep working).

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-peer-add.test.js`:

```js
// tests/contacts-peer-add.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContactList } from "../servers/gateway/dashboard/panels/contacts/html.js";

const CODE = "crow:abc123def0.eyJmYWtlIjoxfQ.c2ln";
const SHARE = { code: CODE, url: `https://maestro.press/software/crow/invite/#x`, qrDataUrl: null };

test("contact list renders an Add-a-peer section with generate + accept forms", () => {
  const html = renderContactList([], [], {}, "en");
  const start = html.indexOf("contacts-add-peer");
  assert.notEqual(start, -1, "add-peer section present");
  const block = html.slice(start);
  assert.ok(block.includes('value="generate_invite"'), "generate form");
  assert.ok(block.includes('value="accept_invite"'), "accept form");
  assert.ok(block.includes("Add a Crow peer"), "i18n title");
});

test("share result renders inside the add-peer section", () => {
  const html = renderContactList([], [], {}, "en", { inviteShare: SHARE });
  assert.ok(html.includes(SHARE.url), "share url shown");
  assert.ok(html.includes("Copy link"), "share block rendered");
});

test("invite error renders", () => {
  const html = renderContactList([], [], {}, "en", { inviteError: "expired" });
  assert.ok(html.includes("expired"), "error surfaced");
});

test("spanish strings resolve", () => {
  const html = renderContactList([], [], {}, "es");
  assert.ok(html.includes("Añadir un par de Crow"), "es title");
  assert.ok(!html.includes("contacts.addPeer"), "no raw keys");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/contacts-peer-add.test.js`
Expected: FAIL (no add-peer section yet).

- [ ] **Step 3: Add the actions to `contacts/api-handlers.js`**

(a) Add to imports:

```js
import { extractInviteCode } from "../../../../sharing/invite-url.js";
```

(b) Inside `handleContactAction`, beside the `add_by_id` block (`:98-119`), add two actions using the handler's injectable `sharingClientFactory` param (same as `add_by_id` at `:103` — it defaults to `makeSharingClient`, and keeps the actions handler-level testable):

```js
  // P2/C1+C3: full peer-add from the Contacts panel — generate an invite…
  if (action === "generate_invite") {
    try {
      const client = await sharingClientFactory();
      try {
        const result = await client.callTool({ name: "crow_generate_invite", arguments: {} });
        const text = result.content?.[0]?.text || "";
        if (result?.isError) return { inviteError: text || "Could not generate invite." };
        return { inviteResult: text };
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] generate_invite failed:", err.message);
      return { inviteError: err.message };
    }
  }

  // …and accept one (forgiving: raw code or full share URL).
  if (action === "accept_invite" && req.body.invite_code) {
    try {
      const code = extractInviteCode(req.body.invite_code);
      const client = await sharingClientFactory();
      try {
        const result = await client.callTool({ name: "crow_accept_invite", arguments: { invite_code: code } });
        if (result?.isError) return { inviteError: result.content?.[0]?.text || "Invite could not be accepted." };
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] accept_invite failed"); // never echo the code
      return { inviteError: err.message };
    }
    return { redirect: "/dashboard/contacts" };
  }
```

- [ ] **Step 4: Thread results through the loader `contacts.js`**

(a) Add to imports at the top (beside the existing `../shared/components.js` import at `:15`):

```js
import { buildInviteShare } from "../shared/peer-invite-ui.js";
import { csrfInput } from "../shared/csrf.js";
```

(`contacts.js` lives in `panels/`; shared is a sibling dir → `../shared/…`, same as its existing shared imports.)

(b) In the POST block (`:28-36`), capture invite results:

```js
    let peerAdd = {};
    if (req.method === "POST") {
      const result = await handleContactAction(req, db);
      if (result?.redirect) return res.redirectAfterPost(result.redirect);
      if (result?.download) {
        res.setHeader("Content-Type", "text/vcard; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=contacts.vcf");
        return res.send(result.download);
      }
      if (result?.inviteResult) {
        try { peerAdd.inviteShare = await buildInviteShare(result.inviteResult); } catch {}
        if (!peerAdd.inviteShare) peerAdd.inviteError = "Invite generated but could not be rendered — use the Messages panel.";
      }
      if (result?.inviteError) peerAdd.inviteError = result.inviteError;
    }
    peerAdd.csrf = csrfInput(req);
```

(declare `let peerAdd = {}` BEFORE the `if` so it's in scope for rendering below; `peerAdd.csrf` makes the Contacts forms robust with Turbo disabled, matching the Messages side — the shared component behaves identically in both panels.)

(c) Pass it to the list render — the `renderContactList(contacts, groups, filters, lang)` call in the default/all view becomes `renderContactList(contacts, groups, filters, lang, peerAdd)`.

- [ ] **Step 5: Render the section in `contacts/html.js`**

(a) Add to imports:

```js
import { renderInviteShare, renderPeerInviteForms } from "../../shared/peer-invite-ui.js";
```

(b) Change the signature at `:75` to `export function renderContactList(contacts, groups, filters, lang, peerAdd = {})`.

(c) After `addByIdForm` (`:115-124`), build the section:

```js
  const peerForms = renderPeerInviteForms({ lang, csrf: peerAdd.csrf || "" });
  const peerAddSection = `<details class="contacts-add-peer" style="margin-bottom:1rem"${peerAdd.inviteShare || peerAdd.inviteError ? " open" : ""}>
    <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-accent);font-weight:500">${t("contacts.addPeer", lang)}</summary>
    <div style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
      <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0 0 0.75rem">${t("contacts.addPeerDesc", lang)}</p>
      ${peerAdd.inviteError ? `<div style="font-size:0.8rem;color:var(--crow-error);margin-bottom:0.5rem">${escapeHtml(peerAdd.inviteError)}</div>` : ""}
      ${peerAdd.inviteShare ? renderInviteShare(peerAdd.inviteShare, lang) : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.5rem">
        <div>${peerForms.generateForm}</div>
        <div>${peerForms.acceptForm}</div>
      </div>
    </div>
  </details>`;
```

(d) Include it in the return at `:160`: `return toolbar + addForm + peerAddSection + addByIdForm + gridHtml + importModal;`

- [ ] **Step 6: Run the tests**

Run: `node --test tests/contacts-peer-add.test.js tests/contacts-add-by-id-action.test.js tests/bot-directory-contacts-surface.test.js`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/contacts-peer-add.test.js
git commit tests/contacts-peer-add.test.js servers/gateway/dashboard/panels/contacts.js servers/gateway/dashboard/panels/contacts/html.js servers/gateway/dashboard/panels/contacts/api-handlers.js -m "feat(contacts): full peer-add flow via shared invite component (P2/C3)"
git show --stat HEAD
```

---

## Task 5: The static invite page

**Files:**
- Create: `docs/public/invite/index.html`
- Test: `tests/invite-page.test.js`

**Interfaces:**
- Consumes: nothing at runtime (fully self-contained). The test cross-checks `DEFAULT_INVITE_PAGE_URL` (Task 1) against this file's path so the two can't drift.
- Produces: the page served at `https://maestro.press/software/crow/invite/` (VitePress copies `docs/public/` verbatim; deployed by the existing Deploy Docs workflow on merge).

- [ ] **Step 1: Write the failing test**

Create `tests/invite-page.test.js`:

```js
// tests/invite-page.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { DEFAULT_INVITE_PAGE_URL } from "../servers/sharing/invite-url.js";

const PAGE = new URL("../docs/public/invite/index.html", import.meta.url).pathname;

test("static invite page exists where DEFAULT_INVITE_PAGE_URL points", () => {
  assert.ok(existsSync(PAGE), "docs/public/invite/index.html present");
  // The URL path (…/software/crow/invite/) must map to docs/public/invite/
  // under the VitePress base /software/crow/.
  assert.ok(DEFAULT_INVITE_PAGE_URL.endsWith("/software/crow/invite/"), "URL matches public dir layout");
});

test("page is self-contained and reads the fragment client-side only", () => {
  const html = readFileSync(PAGE, "utf-8");
  assert.ok(html.includes("location.hash"), "reads the fragment");
  assert.ok(!/\b(src|href)\s*=\s*"https?:\/\//.test(html.replace(/href="https:\/\/maestro\.press[^"]*"/g, "")),
    "no external scripts/styles/images (own-domain install links exempt)");
  assert.ok(!html.includes("fetch("), "no network calls");
  assert.ok(!html.includes("XMLHttpRequest"), "no network calls");
  assert.ok(html.includes("navigator.clipboard"), "copy button");
});

test("page is bilingual", () => {
  const html = readFileSync(PAGE, "utf-8");
  assert.ok(html.includes("Copy code"), "EN copy");
  assert.ok(html.includes("Copiar código"), "ES copy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/invite-page.test.js`
Expected: FAIL — file missing.

- [ ] **Step 3: Write the page**

Create `docs/public/invite/index.html` (complete file):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Crow invite</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 560px; margin: 0 auto; padding: 24px 16px; line-height: 1.5;
         background: #0f1115; color: #e6e6e6; }
  @media (prefers-color-scheme: light) { body { background: #fafafa; color: #1a1a1a; } .card { background:#fff !important; border-color:#ddd !important; } code { background:#eee !important; } }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 1.4rem; }
  .card { background: #181b22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 16px; margin: 14px 0; }
  code, .code { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .code { display: block; word-break: break-all; background: #10131a; border-radius: 8px;
          padding: 10px; font-size: 0.85rem; margin: 8px 0; }
  button { font-size: 0.9rem; padding: 8px 16px; border-radius: 8px; border: 1px solid #3a4150;
           background: #232838; color: inherit; cursor: pointer; }
  .muted { opacity: 0.7; font-size: 0.85rem; }
  .hidden { display: none; }
  a { color: #7aa2ff; }
  .langbtn { float: right; font-size: 0.75rem; padding: 4px 10px; }
</style>
</head>
<body>
<button class="langbtn" id="langToggle" type="button">ES</button>

<div data-lang="en">
  <h1>🐦‍⬛ You've been invited to connect on Crow</h1>
  <div id="codeCard-en" class="card hidden">
    <div class="muted">Invite code (expires 24 hours after it was created, single acceptance):</div>
    <span class="code" id="code-en"></span>
    <button type="button" onclick="copyCode(this)" data-done="Copied ✓">Copy code</button>
  </div>
  <div id="noCode-en" class="card hidden">
    <strong>This link has no invite code attached.</strong>
    <p class="muted">Ask the person who invited you to send the full link (it ends with <code>#crow:…</code>).</p>
  </div>
  <div id="expired-en" class="card hidden">
    <strong>This invite looks expired.</strong>
    <p class="muted">Invite codes last 24 hours — ask for a fresh one.</p>
  </div>
  <h2>Have Crow already?</h2>
  <p>Open your Crow dashboard → <strong>Messages</strong> → <strong>+</strong> → <strong>Accept an invite</strong> → paste the code.</p>
  <p class="muted">Or open it directly on your Crow (enter your dashboard address — this stays on your device):</p>
  <div class="card"><input id="gw-en" placeholder="https://your-crow.example.ts.net:8444" style="width:100%;padding:8px;border-radius:8px;border:1px solid #3a4150;background:transparent;color:inherit">
  <button type="button" style="margin-top:8px" onclick="openOnCrow('en')">Open my Crow</button></div>
  <h2>New to Crow?</h2>
  <p>Crow is a private, self-hosted AI + messaging hub. <a href="https://maestro.press/software/crow/getting-started/">Install Crow</a>, then come back to this link.</p>
  <p class="muted">Privacy: the code lives only in this link (after the <code>#</code>) — this page sends nothing anywhere. Whoever carried the link could see the code, which is why it expires. After connecting, compare <strong>safety numbers</strong> to verify each other.</p>
</div>

<div data-lang="es" class="hidden">
  <h1>🐦‍⬛ Te han invitado a conectar en Crow</h1>
  <div id="codeCard-es" class="card hidden">
    <div class="muted">Código de invitación (caduca 24 horas después de crearse, un solo uso):</div>
    <span class="code" id="code-es"></span>
    <button type="button" onclick="copyCode(this)" data-done="Copiado ✓">Copiar código</button>
  </div>
  <div id="noCode-es" class="card hidden">
    <strong>Este enlace no lleva ningún código de invitación.</strong>
    <p class="muted">Pide a quien te invitó que envíe el enlace completo (termina en <code>#crow:…</code>).</p>
  </div>
  <div id="expired-es" class="card hidden">
    <strong>Esta invitación parece caducada.</strong>
    <p class="muted">Los códigos duran 24 horas — pide uno nuevo.</p>
  </div>
  <h2>¿Ya tienes Crow?</h2>
  <p>Abre tu panel de Crow → <strong>Mensajes</strong> → <strong>+</strong> → <strong>Aceptar una invitación</strong> → pega el código.</p>
  <p class="muted">O ábrelo directamente en tu Crow (escribe la dirección de tu panel — no sale de tu dispositivo):</p>
  <div class="card"><input id="gw-es" placeholder="https://tu-crow.example.ts.net:8444" style="width:100%;padding:8px;border-radius:8px;border:1px solid #3a4150;background:transparent;color:inherit">
  <button type="button" style="margin-top:8px" onclick="openOnCrow('es')">Abrir mi Crow</button></div>
  <h2>¿Nuevo en Crow?</h2>
  <p>Crow es un centro privado y autoalojado de IA + mensajería. <a href="https://maestro.press/software/crow/getting-started/">Instala Crow</a> y vuelve a este enlace.</p>
  <p class="muted">Privacidad: el código vive solo en este enlace (tras el <code>#</code>) — esta página no envía nada a ningún sitio. Quien llevó el enlace pudo ver el código; por eso caduca. Tras conectar, comparen los <strong>números de seguridad</strong> para verificarse.</p>
</div>

<script>
(function () {
  var code = "";
  try { code = decodeURIComponent((location.hash || "").slice(1)); } catch (e) { code = (location.hash || "").slice(1); }
  var valid = /^crow:[a-z0-9]{10}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code);
  var expired = false;
  if (valid) {
    try {
      var payload = JSON.parse(atob(code.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload && payload.expires && Date.now() > payload.expires) expired = true;
    } catch (e) { /* payload undecodable — let the accepting Crow judge it */ }
  }
  ["en", "es"].forEach(function (l) {
    if (valid && !expired) {
      document.getElementById("code-" + l).textContent = code;
      document.getElementById("codeCard-" + l).classList.remove("hidden");
    } else if (valid && expired) {
      document.getElementById("expired-" + l).classList.remove("hidden");
    } else {
      document.getElementById("noCode-" + l).classList.remove("hidden");
    }
  });
  window.copyCode = function (btn) {
    var text = btn.previousElementSibling.textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { btn.textContent = btn.getAttribute("data-done"); });
  };
  window.openOnCrow = function (l) {
    var gw = (document.getElementById("gw-" + l).value || "").trim().replace(/\/+$/, "");
    if (!gw) return;
    if (!/^https?:\/\//.test(gw)) gw = "https://" + gw;
    location.href = gw + "/dashboard/messages?invite=" + encodeURIComponent(code) ;
  };
  var showing = (navigator.language || "").toLowerCase().indexOf("es") === 0 ? "es" : "en";
  function render() {
    document.querySelectorAll("[data-lang]").forEach(function (el) {
      el.classList.toggle("hidden", el.getAttribute("data-lang") !== showing);
    });
    document.getElementById("langToggle").textContent = showing === "en" ? "ES" : "EN";
    document.documentElement.lang = showing;
  }
  document.getElementById("langToggle").onclick = function () { showing = showing === "en" ? "es" : "en"; render(); };
  render();
})();
</script>
</body>
</html>
```

**Design notes the implementer must keep:** `noindex` (invite pages shouldn't be searchable); the ONLY external hrefs are same-domain `maestro.press` install links (the test enforces this); the gateway-address deep link passes the code via `?invite=` — this is the ONE place the code intentionally rides a query param, going ONLY to the recipient's own gateway over HTTPS at the user's explicit request (Task 3's loader immediately consumes it; it appears in that gateway's own access log only, which the recipient controls). The expiry pre-check decodes the middle base64url segment client-side and MUST NOT render any other payload field (no pubkeys).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/invite-page.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Verify the docs build accepts the page**

Run: `cd docs && npm run build 2>&1 | tail -5; cd ..`
Expected: build completes; `docs/.vitepress/dist/invite/index.html` exists (`ls docs/.vitepress/dist/invite/`).

- [ ] **Step 6: Commit**

```bash
git add docs/public/invite/index.html tests/invite-page.test.js
git commit docs/public/invite/index.html tests/invite-page.test.js -m "feat(docs): public static invite landing page — code in fragment, bilingual (P2/C1)"
git show --stat HEAD
```

---

## Task 6: Full suite + boot verify + final review + ledger → PR

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-messages-p2-pr1-invite-links.md` (Review + Execution record)
- Modify: `.superpowers/sdd/progress.md` (ledger — git-ignored, do NOT git add)

- [ ] **Step 1: Full suite**

Run: `node --test tests/ 2>&1 | tail -5`
Expected: 0 fail (982 baseline + 27 new from Tasks 1–5 ≈ 1009).

- [ ] **Step 2: Isolated gateway boot**

Run: `CROW_GATEWAY_URL= CROW_DATA_DIR=$(mktemp -d) PORT=3999 timeout -k 5 25 node servers/gateway/index.js --no-auth 2>&1 | grep -E "listening|Subscribed|error|Error" | head`
Expected: boots clean, `[nostr] Subscribed to incoming on 4 relay(s)` + `[sharing] Subscribed to incoming Nostr messages`, no new errors.

- [ ] **Step 3: Final whole-branch review (opus subagent)** — diff base…HEAD; the reviewer verifies: XSS-escape on every new interpolation; the code never lands in a query param except the user-initiated `openOnCrow` deep link; no sharing-client instantiation from render code; kiosk guards intact (tools unchanged apart from text/normalization); existing panel tests untouched and green; the static page's external references are same-domain only.

- [ ] **Step 4: Fix anything Critical/Important; re-review the fixes.**

- [ ] **Step 5: Record the review + execution summary in this plan's Review section; update the ledger.**

- [ ] **Step 6: Push + PR**

```bash
git pull --rebase && git push -u origin feat/messages-p2-invite-links
```

PR via github MCP (`mcp__github__create_pull_request`, owner=kh0pper repo=crow, base=main) titled `feat(messages): invite links + QR + one add-peer surface (Phase 2 PR1, C1+C3)`. Check-runs before merge (only PR-triggered workflow is port-allocation, path-filtered — expect 0 applicable; verify via `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs`). Merge = operator-gated. Deploy crow after merge: `git checkout main && git pull --rebase`, `echo '8r00kly^' | sudo -S systemctl restart crow-gateway.service`, verify `/health` 200 + both subscribe lines. NOTE: the static page goes live only when the **merge to main** triggers Deploy Docs (known cosmetic Pages flake — re-run if the deploy step fails; build green is what matters).

---

## Self-Review (against the design spec §PR1)

- Spec §1 URL builder → Task 1. §2 static page → Task 5 (spec amended: `docs/public/invite/index.html`, not markdown — VitePress script-block constraint). §3 share block → Tasks 2+3. §4 deep link → Task 3. §5 one surface → Tasks 2+4. Honest copy → Task 2 (`invite.shareHint`) + Task 5 (privacy paragraph). Error handling → Task 3 Step 4 (accept surfaces errors), Task 4 Step 3, Task 5 (invalid/expired cards). C2/C4 items (short codes, safety-number UI, handshake retry) are deliberately NOT here — PR2/PR3.
- Type consistency: `{ code, url, qrDataUrl }` shape identical across Tasks 2/3/4 tests; `renderPeerInviteForms({ lang, csrf, prefillCode })` consumed with subsets everywhere (defaults cover); `personInvite = { code, fromId, csrf }` produced in Task 3 Step 5 and consumed in Step 3(c).
- Placeholder scan: none — every step carries real code/commands.

## Review

**Round 1 (2026-07-03, adversarial subagent, opus): REVISE — all addressed.**
1. [CRITICAL] Both panel-loader imports used `./shared/peer-invite-ui.js` (resolves to nonexistent `panels/shared/`) with a false justifying note → fixed to `../shared/…` (matches `messages.js:18` `../shared/csrf.js`); note corrected.
2. [IMPORTANT] Plan claimed `crow_accept_invite` kiosk-guards — it does NOT (only generate/:44, add_contact/:182, accept_bot_invite/:209 guard). Since this plan widens the accept surface (Contacts section + deep link), Task 1 now ADDS the guard as the handler's first line; constraint text corrected.
3. [MINOR] Contacts actions now use the injectable `sharingClientFactory` (parity with `add_by_id:103`, testable). 4. [MINOR] Person-invite card form got explicit `action="/dashboard/messages"` so the POST target carries no `?invite=` query. 5. [MINOR] Contacts side now threads `csrfInput(req)` (Turbo-off robustness, component parity). 6. [MINOR] Test count corrected to 27 (baseline ≈1009).
Verified clean by the reviewer: CODE_RE vs real base36 output (always lowercase, no URL false-match — `encodeURIComponent` encodes `:`); csrf double-submit accepts header OR field (additive); `invite_code` reassignable; `openOnCrow` scheme-safe; static-page test regexes correct; no gateway URL access-logging (deep-link claim holds); `renderContactList` single call site.

**Round 2 (2026-07-03, fresh adversarial subagent, opus): APPROVE — 3 minors, all applied.**
1. Task 1's generate-handler reproduction now includes the existing kiosk guard as line 1 (no test covers kiosk-generate; a whole-block misread could have dropped it silently). 2. Messages `accept_invite` closes the client in `finally` (no FD leak on throw; matches the contacts block). 3. `CROW_INVITE_PAGE_URL` documented in `.env.example` (new Task 1 Step 6).
Round-1 fixes re-verified correct against live source (`db` in scope via `registerContactsTools` ctx destructure `:33`; guard imports present `:9`; all import depths; `handleContactAction` signature `:33`). Explicitly cleared: atob unpadded base64url is safe (WHATWG forgiving-base64; length%4==1 impossible for valid payloads); only 2 tests import `buildMessagesHTML`, neither touches the changed forms; zero tests import `renderContactList`; no tool-text consumers parse the generate output; no i18n/CSS collisions; `?invite=` conflicts none; re-render-on-false path confirmed (`messages.js:34` gates on `res.headersSent`).

*(Execution record to be appended by Task 6.)*

## Execution & Final Review (2026-07-03)

Executed via subagent-driven development on `feat/messages-p2-invite-links` (base `dbf5efbf`), fresh sonnet implementer + sonnet reviewer per task:
- Task 1 `1368df13` — invite-url.js + tool wiring + NEW crow_accept_invite kiosk guard + .env.example (SPEC ✅, QUALITY Approved, zero findings, 16/16).
- Task 2 `695e0e58` — peer-invite-ui.js + 14 i18n keys EN+ES (SPEC ✅, Approved, zero findings, 7/7 + full 996/996).
- Task 3 `6d672c71` — messages panel: share block, ?invite= card, honest accept errors, tray→shared forms (SPEC ✅ 7/7 items, Approved, zero findings, 6/6 + 68/68 widened net).
- Task 4 `ee69f6ba` — contacts add-peer section via injectable factory (SPEC ✅, Approved, zero findings, 6/6 incl. regression).
- Task 5 `2b5157e0` + fix `d5947cf4` — static page + integrity test; reviewer's Important (weak external-ref guard regex) FIXED and re-review RESOLVED (hardened: any-quote/case/protocol-relative/formaction/css-url/meta-refresh, catch-capability proven).

Controller verification: **full suite 1009/1009** (982 baseline + 27 new, exact); isolated gateway boot clean (`listening` + `[nostr] Subscribed to incoming` + `[sharing] Subscribed to incoming Nostr messages`).

**FINAL whole-branch review (opus, dbf5efbf..d5947cf4): READY TO MERGE — Yes. 0 Critical / 0 Important / 3 Minor follow-ups.** Security: invite-code lifecycle traced exfiltration-clean end-to-end (no server log echoes the code; only query-param appearance is the user-initiated `?invite=` into the recipient's own gateway; every HTML sink escaped; static page fully self-contained, scheme-forced deep link). Kiosk: BOTH tools now guard (the pre-existing accept gap is closed by this PR); all four panel paths route through the tools. Trust boundaries L6/R4/R5 untouched. CSRF strictly improved (tray/contacts/card forms now Turbo-off-safe). Round-1's critical `./shared/` import bug confirmed fixed. Independent verification: 27/27 new + 17/17 neighbors + all 7 modules import clean.

Minor follow-ups (non-blocking): M1 tighten the test's maestro.press exemption to `maestro\.press\/` (prefix-match nit); M2 optionally unify the Contacts share-null fallback with Messages' raw-code fallback; M3 remove 3 orphaned `messages.*` i18n keys (generateInviteCode / acceptInviteButton / pasteInvitePlaceholder).
