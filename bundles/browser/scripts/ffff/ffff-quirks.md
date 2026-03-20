# FFFF Quirks & Known Behaviors

Documented from the 2025 filing attempt. Reference this before any FFFF automation.

## Randomized Field IDs

FFFF generates random DOM `id` attributes on every page load. **Never use `id` selectors.**

**Solution:** Use `aria-label` attributes, which are stable across sessions. The `field-resolver.js` module handles this.

## Confirmation Popups

FFFF shows native `confirm()` dialogs when:
- Adding a form to the return
- Removing a form
- Navigating away from an unsaved form
- After "Do the Math" in some cases

These popups appear in the **outer frame**, not inside the form iframe. If not handled, they can cause:
- Session to appear frozen
- Subsequent navigation to fail
- Automatic logout

**Solution:** `popup-handler.js` sets up a `page.on('dialog')` listener. Safe patterns (add/remove form) are auto-accepted.

## "Do the Math" Clears Fields

The "Do the Math" button recalculates the form. Side effects:
- **Readonly/calculated fields** are updated (expected)
- **Some user-entered fields may be cleared** (CRITICAL BUG)
- **Commas may be added** to numeric values (cosmetic)

**Solution:** `post-math-refill.js` implements snapshot → diff → refill.

## Session Timeout

FFFF sessions expire after approximately **15 minutes** of inactivity.

Symptoms:
- Form fields become unresponsive
- Navigation returns to login page
- Data entered in the current session may be lost

**Solution:** `frame-manager.js` runs a heartbeat `evaluate()` every 5 minutes in the outer frame.

## Nested Iframe Detachment

Forms render inside an `<iframe>`. After certain operations, the iframe reference becomes stale:
- After navigating between forms
- After "Do the Math"
- After handling a popup
- After the session times out and refreshes

Error messages: "Execution context was destroyed", "Frame was detached", "Target closed"

**Solution:** `frame-manager.js` provides `getFormFrame()` with automatic retry and `withFormFrame()` wrapper that reacquires the frame on detachment.

## Form Add Order

When adding forms, FFFF may reorder or renumber them. Always verify the form list after adding.

## W-2 Entry Is Step 2

W-2 data is NOT entered on the main form. FFFF has a separate "Step 2: Enter W-2 Information" section. This is where Box 1-17 data goes.

## E-File Is Step 4

The e-file submission is in "Step 4". This should NEVER be automated — the user must review and submit manually.

## 6013(h) Statement

FFFF does not support file attachments. If a Section 6013(h) election statement is needed (nonresident spouse electing to be treated as resident), it must be printed and mailed separately to the IRS.
