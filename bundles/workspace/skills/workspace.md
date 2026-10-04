---
name: workspace
description: Use Crow Workspace (the household's private Nextcloud + ONLYOFFICE) — files, Word/Excel/PowerPoint documents, calendars (incl. Menu) and contacts — through the ws_* tools
triggers:
  - workspace
  - nextcloud
  - document
  - documento
  - spreadsheet
  - hoja de cálculo
  - presentation
  - calendar
  - calendario
  - menu calendar
  - contacts
  - contactos
tools:
  - crow-workspace
---

# Crow Workspace

## When to activate
The user asks about files, documents (.docx), spreadsheets (.xlsx), slides (.pptx), calendars or contacts in their own Workspace (not Google).

## What you can reach
Only what the household shared with the **Crow bot** account. If something is missing, say so and ask them to share it with "Crow bot" in Workspace (edit rights for changes).

## How to work
1. **Find before you touch.** `ws_drive_search` or `ws_drive_list_folder`, then `ws_docs_get_structure` / `ws_sheets_get_tabs` / `ws_slides_get_structure`.
2. **Use the narrowest edit.** `ws_docs_find_replace` (batch with `pairs`) > `ws_docs_rewrite_passages` > `ws_docs_insert_at_heading` > `ws_docs_replace_section`. There is no whole-document replace, on purpose.
3. **Every write returns `version_id`.** Tell the user what changed and that they can say "undo". On "undo", call `ws_undo_last_change` with the same `path` (for calendar and contacts, the `cal:`/`contacts:` ref the write returned) and its `version_id` (for a queued change, its `change_id`). If it answers `changed_since`, explain that someone edited it after you and offer `ws_drive_list_versions` + `ws_drive_restore_version`. If it answers `version_gone`, Workspace no longer keeps the old version (see "Versions" below); offer the version list instead.
4. **If a write answers `queued: true`** (the file is open): tell the user who has it open and that the change will appear in their editor or when it closes. Ask nothing. Later, `ws_change_status` gives the result (applied with `version_id`, failed with reason); `ws_cancel_change` cancels it while it is still pending. Use `if_open: "force_close"` ONLY when the user explicitly says to apply it now even if it closes the other person's editor; never on your own, never twice. An undo with `force_close` can still end in `changed_since` if the person had typed. Bot Builder bots should enable only the `ws_*` tools they need.
4b. **If a write answers `open_in_editor`** (move/rename/trash, which are not queueable): tell the user who has it open (`data.open_by`) and ask: "Go ahead anyway — their editor reloads and their typing is saved first — or try later?" Only on a clear yes, call the same tool again with `if_open: "force_close"`. On `locked_by_person` or `stale_editor_lock`, relay the message. Never retry in a loop.
5. **Confirm first** before `ws_drive_trash_file`, `ws_sheets_delete_tab`, `ws_slides_delete_slide`, `ws_cal_delete_event`, `ws_contacts_delete`.

## What happens when a file is open (verified facts)
- Writes to an open file are **queued by default** and applied either **live** in the open editor or **when it closes**. Live apply happens only when the person in the editor is the file's owner or someone the file was shared with directly with edit rights (Crow must be able to verify it); otherwise the change waits for close.
- A file opened **only on a phone** (view mode) still holds the lock, so the change waits until it is closed.
- Comments (`ws_docs_add_comment`, replies, resolve, comment edits), formatting (`ws_docs_format_text`), `ws_sheets_add_tab`, and text edits in slides are applied **at close only**, never live.
- `force_close` closes only editor sessions. It never removes a lock a person set by hand (`locked_by_person`), and it is never sent twice for one change without asking again.

## Versions
Every change makes a labelled version. Labelled versions survive Workspace's normal version expiry, but **not** storage-quota pressure: if the drive runs short of space, old versions can be removed, and undo then answers `version_gone`.

## Errors
Results are JSON (`{success, data}` or `{success:false, code, error}`), except when the arguments don't match a tool's schema (a wrong type, a missing field): then the reply is a plain-text validation message, not the JSON envelope. Read it, fix the arguments, and try once more.

## Sheets
After writing formulas, cached results are stale until someone opens the file. Read formulas with `value_render_option: "FORMULA"`, and do not report computed totals from a `stale_formulas: true` read.

## Calendar
All-day events use `YYYY-MM-DD`; the same day is fine for a one-day event. Timed events need an offset (e.g. `2026-10-22T18:00:00-05:00`). New events are stored in **UTC** (the time is right; Workspace shows it converted). If more than one calendar is writable, ask which. Kitchen's meal plan lives on **Menu**. No invitations are sent unless the user asks (`send_updates: "all"`).

## Daily briefing / meeting prep
"What's on this week?" → `ws_cal_list_events` on each calendar for the next 7 days, then a short summary. "Prep for X" → `ws_cal_get_event`, then `ws_drive_search` for related documents and `ws_docs_read_section` on the relevant part.
