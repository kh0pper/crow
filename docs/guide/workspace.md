# Crow Workspace

Crow Workspace is your own private office on the machine that runs Crow: files, Word/Excel/PowerPoint documents you can edit together in the browser (ONLYOFFICE), and calendars and contacts that sync to your phones. It is built on Nextcloud and reachable only on your tailnet, never from the public internet.

Install it from **Extensions** (Crow Workspace), then open **Office** in the Crow's Nest. The **Setup** tab has your Workspace address, phone setup (DAVx⁵ on Android, CalDAV/CardDAV on iPhone) and the one-time admin commands. The **Quick edit** tab is described [below](#quick-edit-from-a-phone).

## What Crow can do

Crow's bots get a set of `ws_*` tools (the `workspace` skill teaches them how to use them):

- **Drive** (17 tools): list, search, read, create folders, move, copy, rename, trash, upload, export, share, and list or restore versions.
- **Documents** (.docx, 11 tools): read, outline, read a section, find and replace, append, insert under a heading, replace a section, rewrite passages, format text, insert images, create.
- **Document comments** (5 tools): list, add, reply, resolve, and apply a suggested edit.
- **Spreadsheets** (.xlsx, 11 tools): read, write, append rows, add/rename/delete tabs, number formats, batch updates, create.
- **Slides** (.pptx, 16 tools): read, outline, speaker notes, find and replace, add/duplicate/delete/reorder slides, text boxes, images, text and paragraph formatting, create.
- **Calendar** (7 tools): list calendars and events, read, create, update, delete, respond to invitations.
- **Contacts** (6 tools): list address books, search, read, create, update, delete.
- **Undo and queued changes** (3 tools): undo the last change, check the status of a waiting change, cancel it.

There is deliberately no "replace the whole document" tool: Crow edits the smallest piece that does the job, so formatting, charts and references elsewhere in the file are left alone.

## What Crow can see

Crow works as a separate Workspace account called **Crow bot**. It sees **only what you share with Crow bot**, the same way you would share with a person. To let Crow help with a folder, calendar (for example **Menu**) or address book, share it with "Crow bot" in Workspace, with edit rights if Crow should change things. Unshare it to take access away again. Quick edit (below) shows exactly the same view.

## Undo and versions

Every change Crow makes is saved as a new version, and the version from just before it is kept too. Both are labelled in the file's **Versions** sidebar in Workspace ("Before Crow: …", "Crow: …", "Quick edit: …"), so you can always see what changed and go back.

- Say "undo" to the bot right after a change: it reverts exactly that change.
- If someone edited the file after Crow, undo refuses rather than throwing their work away. Pick a version to restore instead (in Workspace's Versions sidebar, or ask the bot to list and restore versions).
- Labelled versions are kept past Workspace's normal version expiry, but not when the drive runs short of space: then old versions can be removed, and undo says the version is gone.
- Calendar and contact changes are undoable too (Crow keeps its own 30-day record of them).

## When a file is open

If someone has the document open in the editor when Crow wants to change it, nobody is kicked out. Crow's change **waits**:

- **Live:** the Crow plugin inside the open editor applies the change right there, as a normal undoable edit, when the person in the editor is the file's owner or someone it was shared with directly with edit rights (Crow must be able to verify that). The editor's own save stores it.
- **On close:** otherwise (or for comments, text formatting, adding a sheet tab, and slide text edits, which are never applied live) the change is applied as soon as the editor closes and Workspace has saved the file. A file open only on a phone in view mode still counts as open, so the change waits until it is closed.
- Before applying, Crow checks that the text, cell or slide it was going to change is still there. If it isn't, the change is not applied, and you are told why.
- Crow sends a notification when a change is waiting, applied or could not be applied. Ask the bot for its status, or cancel it while it is still waiting. A change that waits more than 7 days expires.

**Apply now (override).** If you really want the change applied immediately, tell the bot so explicitly ("apply it now even if it closes their editor"), or use **Apply now** on the Quick edit page. That closes the editor sessions on the file (their typing is saved first), applies the change, and is done at most once per change.

**Manual locks are never overridden.** If a person locked the file in Workspace (Files → ⋯ → Lock), Crow's change waits until they unlock it; "apply now" does not remove a person's lock.

**Stale editor lock.** If a browser crashed, a file can stay marked as open in the editor although nobody is editing it. Crow then says so. To fix it, the file's owner opens Workspace, goes to the file, opens its **⋯** menu and chooses **Unlock**. Crow cannot unlock it itself.

## Quick edit from a phone

**Office › Quick edit** makes small changes without the full editor:

- Browse the folders and Office files shared with Crow bot.
- **Documents:** a numbered list of paragraphs (headings in bold). Tap **Edit**, change the text, **Save**. The paragraph keeps its style. Paragraphs with links, pictures, fields or footnotes are refused (edit those in the editor so nothing is lost).
- **Spreadsheets:** pick a tab, tap a cell, type a value (start with `=` for a formula), **Save**.
- **Slides:** tap a text shape, change the text, **Save**.
- After saving you get an **Undo** button and the file's recent versions, each with **Restore**.
- If the page is out of date (someone changed that paragraph, cell or shape since it loaded), the save is refused; reload and try again.
- If the file is open, Quick edit waits up to 10 seconds, then queues the change and tells you who has it open. You can **Cancel change**, or use **Apply now** (behind a confirmation) to close their editor and apply it.

Quick edit uses your Crow's Nest login and changes files as Crow bot, so it can only touch what is shared with Crow bot. Layout, styles, tables, pictures and new files stay in the full editor.

## Limits

- Files Crow edits or reads: up to 50 MB (Quick edit: 20 MB). Uploads: up to 10 MB. Images: up to 5 MB.
- Spreadsheet reads: up to 50,000 cells at a time. After Crow writes formulas, their cached results are out of date until someone opens the file in the editor, so Crow reads the formulas instead of reporting stale totals.
- Recurring calendar events: Crow changes the whole series, not a single occurrence (moving one Tuesday of a weekly dinner is done in the calendar app for now).
- New events Crow creates are stored in UTC; the time is correct and your calendar app shows it in your time zone.
