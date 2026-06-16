# Messages "Add a Bot" paste form — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "paste a bot invite code" form to the Messages "+" popover so a recipient on any instance can add a bot without the `?bot_invite=` deep link.

**Architecture:** A new popover item ("Add a Bot") + a paste dialog (`id="invite-bot"`) in the Messages HTML, mirroring the existing "Accept Invite" instance dialog. The dialog posts the already-shipped `accept_bot_invite` action (`crow_accept_bot_invite` tool). The existing `msgShowInviteDialog(type)` client helper toggles `#invite-bot` by id, so there is **no JS change**; existing `.msg-invite-dialog`/`.msg-popover-item` CSS is reused, so there is **no CSS change**. Edits are confined to `html.js` (markup) and `i18n.js` (4 en/es keys).

**Tech Stack:** Node built-in test runner (`node --test`), server-rendered HTML string builder, `t(key, lang)` i18n helper.

Spec: `docs/superpowers/specs/2026-06-16-messages-add-bot-paste-form-design.md`.

---

### Task 1: "Add a Bot" popover item + paste dialog (TDD)

**Files:**
- Test: `tests/messages-add-bot-form.test.js` (create)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (insert 4 keys after `messages.pasteInvitePlaceholder`, ~line 248)
- Modify: `servers/gateway/dashboard/panels/messages/html.js` (popover item after the "Accept Invite" item, ~line 140; new dialog after the `#invite-accept` dialog, ~line 153)

- [ ] **Step 1: Write the failing test**

Create `tests/messages-add-bot-form.test.js`:

```javascript
// tests/messages-add-bot-form.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

const BASE = {
  items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
  inviteResult: null, inviteError: null, lang: "en", botInvite: null,
  advertisedBots: [], csrf: '<input type="hidden" name="_csrf" value="tok">',
};

// Helper: isolate the markup of the invite-bot form (from its dialog id to the
// next closing </form>) so per-field assertions can't be satisfied by some
// OTHER form on the page.
function botForm(html) {
  const start = html.indexOf('id="invite-bot"');
  assert.notEqual(start, -1, "invite-bot dialog present");
  const end = html.indexOf("</form>", start);
  assert.notEqual(end, -1, "invite-bot form closes");
  return html.slice(start, end);
}

test("popover renders an 'Add a Bot' paste dialog posting accept_bot_invite", () => {
  const html = buildMessagesHTML({ ...BASE });
  const form = botForm(html);
  // Posts the already-shipped bot-invite action.
  assert.ok(form.includes('value="accept_bot_invite"'), "accept_bot_invite action present");
  // Has a textarea to paste the code into.
  assert.ok(/name="invite_code"/.test(form), "invite_code field present");
  // The popover item that toggles the dialog.
  assert.ok(html.includes("msgShowInviteDialog('bot')"), "Add a Bot popover item wired to dialog");
  // Resolved i18n strings (not raw keys) appear.
  assert.ok(html.includes("Add a Bot"), "item title resolved via i18n");
  // The placeholder key has a DISTINGUISHING ellipsis ("...") that addBotDesc
  // ("Paste a bot invite code", no ellipsis) does NOT — so this proves
  // messages.pasteBotInvitePlaceholder actually resolved (not just addBotDesc).
  assert.ok(form.includes('placeholder="Paste a bot invite code..."'), "placeholder key resolved");
  // Belt-and-braces: no raw i18n key leaked into the rendered output.
  assert.ok(!html.includes("messages.pasteBotInvitePlaceholder"), "no raw placeholder key");
  assert.ok(!html.includes("messages.addBot"), "no raw addBot key leaked");
});

test("Add a Bot form carries the CSRF token", () => {
  const html = buildMessagesHTML({ ...BASE });
  // Scope to the bot form so a _csrf on any other form can't pass this.
  assert.ok(botForm(html).includes('name="_csrf"'), "csrf token present in the bot paste form");
});

test("Add a Bot strings resolve in Spanish (es branch of the new keys)", () => {
  const html = buildMessagesHTML({ ...BASE, lang: "es" });
  // t() falls back to en on a missing es value WITHOUT erroring, so the only
  // way to catch a missing/typo'd es key is to assert the es string itself.
  assert.ok(html.includes("Agregar un bot"), "es item title resolved");
  assert.ok(botForm(html).includes('placeholder="Pega un código de invitación de bot..."'), "es placeholder resolved");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/messages-add-bot-form.test.js`
Expected: FAIL — `invite-bot dialog present` assertion fails (no such markup yet).

- [ ] **Step 3: Add the 4 i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, immediately after the `"messages.pasteInvitePlaceholder"` line, insert:

```javascript
  "messages.addBot": { en: "Add a Bot", es: "Agregar un bot" },
  "messages.addBotDesc": { en: "Paste a bot invite code", es: "Pega un código de invitación de bot" },
  "messages.addBotButton": { en: "Add Bot", es: "Agregar bot" },
  "messages.pasteBotInvitePlaceholder": { en: "Paste a bot invite code...", es: "Pega un código de invitación de bot..." },
```

- [ ] **Step 4: Add the popover item in `html.js`**

In `servers/gateway/dashboard/panels/messages/html.js`, immediately after the "Accept Invite" popover item block (the `<div class="msg-popover-item" onclick="msgShowInviteDialog('accept')">…</div>`, ~line 140), insert:

```javascript
        <div class="msg-popover-item" onclick="msgShowInviteDialog('bot')">
          <div class="msg-popover-item-title">${t("messages.addBot", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.addBotDesc", lang)}</div>
        </div>
```

- [ ] **Step 5: Add the paste dialog in `html.js`**

In the same file, immediately after the `#invite-accept` dialog block (the `<div class="msg-invite-dialog" id="invite-accept">…</div>`, ~line 153), insert:

```javascript
        <div class="msg-invite-dialog" id="invite-bot">
          <form method="POST">
            <input type="hidden" name="action" value="accept_bot_invite">
            <textarea name="invite_code" placeholder="${t("messages.pasteBotInvitePlaceholder", lang)}" rows="3" required></textarea>
            ${csrf || ""}
            <button type="submit" class="msg-send-btn" style="width:100%;font-size:0.8rem;padding:6px">${t("messages.addBotButton", lang)}</button>
          </form>
        </div>
```

Note: `csrf` is already destructured from `data` at the top of `buildMessagesHTML` — no signature change.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test --test-force-exit tests/messages-add-bot-form.test.js`
Expected: PASS (3 tests: render/action, csrf, es-strings).

- [ ] **Step 7: Run the existing Messages render test to confirm no regression**

Run: `node --test --test-force-exit tests/roster-advertise-html.test.js`
Expected: PASS (the advertised-section render is unaffected).

- [ ] **Step 8: Commit**

```bash
# `git add` the NEW test file first — a positional-path commit cannot reference
# an untracked path (CLAUDE.md / handoff gotcha). The other two files are already
# tracked. Do NOT add a Co-Authored-By trailer (global CLAUDE.md forbids it).
git add tests/messages-add-bot-form.test.js
git commit tests/messages-add-bot-form.test.js servers/gateway/dashboard/shared/i18n.js servers/gateway/dashboard/panels/messages/html.js -m "feat(crow-messages): Add a Bot paste form in Messages popover"
git show --stat HEAD
```

Expected: the commit shows exactly those 3 files.

---

## Self-Review

**Spec coverage:**
- "New popover item" → Task 1 Step 4. ✓
- "New paste dialog `id=invite-bot` posting `accept_bot_invite` + CSRF" → Task 1 Step 5. ✓
- "4 new i18n keys (en+es)" → Task 1 Step 3. ✓
- "No backend/JS/CSS change" → plan touches only `html.js` + `i18n.js` + the new test. ✓
- "One render test" → Task 1 Step 1 (`tests/messages-add-bot-form.test.js`). ✓
- Error/edge behavior unchanged (reuses existing `accept_bot_invite` handler) — nothing to implement. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete and literal.

**Type/name consistency:** Dialog id `invite-bot` matches `msgShowInviteDialog('bot')` (helper toggles `#invite-` + type). Action value `accept_bot_invite` matches the handler in `api-handlers.js:132`. i18n keys used in `html.js` (`messages.addBot`, `messages.addBotDesc`, `messages.addBotButton`, `messages.pasteBotInvitePlaceholder`) exactly match those added in Step 3.

---

## Deploy (after merge)

Code-only — **no schema change**, no `init-db`, no pi-bots restart. Per host: `git pull --rebase` → restart the gateway(s). crow main `~/.crow`→`crow-gateway` `:3001`; MPA `~/.crow-mpa`→`crow-mpa-gateway` `:3006`; grackle `~/crow`→`crow-gateway` `:3002`; black-swan (`ssh black-swan`)→`crow-gateway` `:3001` (slow boot, poll health). Sudo `8r00kly^`. Verify via node ports, not ts.net `/health`. Live-verify: open Messages → "+" → "Add a Bot" renders a paste box; pasting a valid bot code adds the bot + redirects.

---

## Review

**Reviewer:** Plan subagent (staff-engineer adversarial pass), 2026-06-16.
**Verdict:** APPROVE (with minor fixes). Every concrete claim verified against the real files: `msgShowInviteDialog` toggles `#invite-` + type by id (`client.js:116`); `accept_bot_invite` handler exists as described (`api-handlers.js:132-144`); `csrf` already destructured (`html.js:32`); popover renders unconditionally (`html.js:125`); `t()` returns the raw key on a miss (so resolved-string assertions are meaningful); reused CSS classes exist. Confirmed CSRF IS globally enforced on `/dashboard` POSTs (`index.js` + `csrf.js`) via header-or-`_csrf`-body — so adding the explicit token to the new form is the *safer* of the two existing patterns, not gratuitous.

**Fixes applied to the plan:**
1. **Testing gap (placeholder not actually verified):** the original `includes("Paste a bot invite code")` was satisfied by `addBotDesc` alone, so `pasteBotInvitePlaceholder` was unverified. Now assert the full `placeholder="Paste a bot invite code..."` (distinguishing ellipsis) + assert no raw i18n key leaked.
2. **es branch untested:** added a `lang:"es"` test (`t()` silently falls back to en, so only an explicit es-string assertion catches a missing/typo'd es value).
3. **Loose CSRF scoping:** the `_csrf` check is now scoped to the `invite-bot` form (via the `botForm()` helper, dialog-id → next `</form>`).

**Suggestions declined (with reasons):**
- *Add a `Co-Authored-By` trailer to the commit* — global CLAUDE.md forbids attributing Claude as co-author; user instruction overrides. Annotated in Step 8.
- *Collapse `git add … && git commit <paths>` into one `git add && git commit`* — reviewer misread it. CLAUDE.md mandates the positional-path commit form, and a NEW (untracked) file must be `git add`ed first. Step 8 is already correct; annotated why.

**Out of scope (acknowledged, not changed):** un-escaped `t(...)` injection of the new popover strings matches the existing `#invite-accept` pattern; safe today (no `<>&'"` in any of the 4 strings) — a future translator adding `&`/apostrophe would be a low-severity, operator-controlled correctness bug in pre-existing code, not introduced here.
