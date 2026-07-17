---
name: pm-workspace
description: Personal PM workspace — notes (markdown + handwritten drawings with OCR), a daily digest, and deterministic Monday.com board sync
triggers:
  - note
  - notes
  - drawing note
  - handwriting
  - OCR my note
  - daily digest
  - digest
  - monday sync
  - sync monday
  - pm workspace
  - project notes
  - plan a block
  - calendar block
  - planned events
  - approve proposal
tools:
  - crow-pm-workspace
---

# PM Workspace

## When to Activate
- User mentions taking, finding, or transcribing notes (markdown or handwritten/drawing)
- User asks about their daily digest (preview it, send it, why it didn't send)
- User asks to sync with Monday.com, or about sync conflicts/health
- User says "PM workspace" or asks what's due/overdue across their boards

## Tool Map

| Intent | Tool |
|---|---|
| Create a note | `crow_pm_note_create` (markdown here; drawing notes are made in the panel editor) |
| Read a note | `crow_pm_note_get` |
| Browse notes | `crow_pm_note_list` |
| Find something in notes | `crow_pm_search` (FTS default; pass `semantic: true` to also rank memories by embedding similarity) |
| Transcribe a drawing note | `crow_pm_ocr_note` |
| Show today's digest without sending | `crow_pm_digest_preview` |
| Send today's digest now | `crow_pm_digest_send` |
| Run a Monday sync pass | `crow_pm_sync_run` |
| Check sync health / conflicts | `crow_pm_sync_status` |
| What's configured? | `crow_pm_status` (adapters, endpoints, cron state, DB paths) |
| Propose a calendar block | `crow_pm_plan_propose` (status `proposed`; goes nowhere without a human decision) |
| List proposals / feed state | `crow_pm_plan_list` |
| Record the human's approve/reject | `crow_pm_plan_decide` (ONLY after an explicit human decision) |
| Push approved blocks to the feed now | `crow_pm_plan_export` (otherwise the planner cron does it) |
| Check which exports became real events | `crow_pm_plan_reconcile` |

## Boundaries — important
- **Boards and kanban are NOT this server's job.** Task/board CRUD is done
  with the tasks bundle's `tasks_*` tools and Bot Board `tracker_*` tools
  (other add-ons). PM Workspace only READS them for the digest and syncs
  them with Monday.
- Sync never deletes anything on either side — deletions are flagged in
  the sync log for a human. If the user asks why a deleted item keeps
  reappearing in the log, point them at `crow_pm_sync_status`.
- Drawing notes need a saved PNG snapshot before OCR works; if
  `crow_pm_ocr_note` says there is no snapshot, the user should open the
  note in the panel editor and let it autosave first.
- **The planner gate is a human gate.** Never call `crow_pm_plan_decide`
  with `approved` unless the human explicitly approved that specific
  block (in chat, or they used the dashboard queue). Proposals are cheap;
  approvals are not yours to make. Keep event titles clean — the marker
  is a calendar category, not a title tag.

## Workflow notes
- After OCR, the transcription is FTS-searchable immediately and is also
  indexed into crow memories (best-effort embedding).
- The digest runs itself only when PM_RUN_CRON=1 is set on the server
  registration; otherwise `crow_pm_digest_send` is the manual path.
- If `crow_pm_status` shows an adapter unconfigured, tell the user which
  env keys to set (they live in `$CROW_HOME/env/pm-workspace.env` or the
  file named by PM_SECRETS_FILE).
