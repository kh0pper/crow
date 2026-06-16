# Messages "Add a Bot" paste form — design

**Date:** 2026-06-16
**Status:** approved (brainstorming)
**Phase:** Crow Messages gateway arc — deferred "Future" phase 1 (paste-form polish)

## Problem

A recipient who wants to add a bot over Crow Messages currently has only two entry points:

1. The `?bot_invite=<code>` deep link, which renders an "Add & message" landing card.
2. The roster auto-advertise "Bots on your other Crows" section (only for the operator's own paired instances).

A recipient on a *different* instance who is handed a raw bot invite code (e.g. pasted into a chat, copied from elsewhere) has **no UI to paste it**. The Messages "+" popover offers "Accept Invite" for *instance* invites but nothing for *bot* invites — even though the backend action already exists.

## Goal

Add a "paste a bot invite code" form to the Messages "+" popover, mirroring the existing instance-invite "Accept Invite" paste UI. Reuse the already-shipped `accept_bot_invite` POST action and `crow_accept_bot_invite` tool — no backend change.

## What already exists (reused unchanged)

- **POST action** `accept_bot_invite` — `servers/gateway/dashboard/panels/messages/api-handlers.js:132`. Trims the code, calls `crow_accept_bot_invite`, redirects. Already used by the `?bot_invite=` landing card.
- **Client toggle** `msgShowInviteDialog(type)` — `servers/gateway/dashboard/panels/messages/client.js:114`. Hides all `.msg-invite-dialog` elements, then toggles `#invite-<type>`. Generic by id, so a new dialog `id="invite-bot"` works with **no JS change**.
- **CSS** `.msg-invite-dialog` / `.msg-popover-item` — existing classes; the new markup reuses them, so **no CSS change**.

## The change

All edits are in `servers/gateway/dashboard/panels/messages/html.js` and `servers/gateway/dashboard/shared/i18n.js`.

### 1. New popover item (`html.js`, inside `#msg-popover`, after the "Accept Invite" item)

```html
<div class="msg-popover-item" onclick="msgShowInviteDialog('bot')">
  <div class="msg-popover-item-title">${t("messages.addBot", lang)}</div>
  <div class="msg-popover-item-desc">${t("messages.addBotDesc", lang)}</div>
</div>
```

### 2. New paste dialog (`html.js`, after the `#invite-accept` dialog)

Mirrors `#invite-accept`, but posts `accept_bot_invite` and includes the CSRF token:

```html
<div class="msg-invite-dialog" id="invite-bot">
  <form method="POST">
    <input type="hidden" name="action" value="accept_bot_invite">
    <textarea name="invite_code" placeholder="${t("messages.pasteBotInvitePlaceholder", lang)}" rows="3" required></textarea>
    ${csrf || ""}
    <button type="submit" class="msg-send-btn" style="width:100%;font-size:0.8rem;padding:6px">${t("messages.addBotButton", lang)}</button>
  </form>
</div>
```

`csrf` is already destructured from `data` in `buildMessagesHTML` and passed in from `messages.js` (`csrfInput(req)`).

**CSRF note:** the existing `#invite-generate` / `#invite-accept` forms omit the CSRF token (a pre-existing inconsistency). This spec includes the token on the new form per the global "every dashboard POST form needs `csrfInput`" rule, matching the bot-invite landing card and the advertised-bot form. The existing instance forms are out of scope and left untouched.

### 3. New i18n keys (`i18n.js`, en + es), following the existing `messages.*` naming

| key | en | es |
|---|---|---|
| `messages.addBot` | `Add a Bot` | `Agregar un bot` |
| `messages.addBotDesc` | `Paste a bot invite code` | `Pega un código de invitación de bot` |
| `messages.addBotButton` | `Add Bot` | `Agregar bot` |
| `messages.pasteBotInvitePlaceholder` | `Paste a bot invite code...` | `Pega un código de invitación de bot...` |

## Error / edge behavior

Unchanged from the existing deep-link path: a malformed or expired code causes `crow_accept_bot_invite` to return `isError`; the `accept_bot_invite` handler logs and redirects to `/dashboard/messages`. No new error surface.

## Testing

One focused render test: `tests/messages-add-bot-form.test.js`. Asserts `buildMessagesHTML({...})` output contains:

- the `invite-bot` dialog,
- a form with `name="action" value="accept_bot_invite"`,
- a `name="invite_code"` textarea,
- the CSRF token (when a `csrf` string is supplied).

The `accept_bot_invite` action handler is already covered by the shipped `crow-accept-bot-invite` tests. There is no standalone i18n completeness test in the suite, so the render test indirectly exercises the four new keys: it builds the HTML with a real `lang`, and the asserted markup (item title, button label, placeholder) only appears if `t(...)` resolves each key rather than echoing the raw key string.

## Out of scope

- Auto-detecting a single unified "paste any code" field (considered, declined — operator chose the separate "Add a Bot" item for clarity + lower risk).
- Retrofitting CSRF onto the existing instance-invite forms.
- The other deferred phases (cross-instance bot directory/picker; group/multi-party threads).

## Deploy

**Code-only — no schema change.** No `init-db`, no pi-bots restart. Deploy = `git pull --rebase` + restart the gateway(s) per host (crow `:3001`, MPA `:3006`, grackle `:3002`, black-swan `:3001`). Verify via node ports.
