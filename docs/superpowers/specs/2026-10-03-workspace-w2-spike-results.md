# Crow Workspace W2 — Task 1 spike results

Plan: `docs/superpowers/plans/2026-10-03-workspace-w2-toolset.md`, Task 1. Host: crow, Nextcloud 34.0.4 (`nextcloud:34.0.4-apache`, build `2026-09-10T13:12:32+00:00 77c7284f`), ONLYOFFICE Document Server 9.4.0.1 CE. Runs as `crow-bot` in `Shared with Crow/Casa Nueva/W2 spike <ts>/`.

Automated run: 2026-10-03 ~18:45 local. Kevin's interactive runs (S6/S6b, S7, S9): 2026-10-04 00:17–00:34 CDT. All sections are results.

## Automated run (DONE)

Command: `node scripts/workspace-w2-spike.mjs` (no flags). The box schedule was checked first: no crow window conflicted.

### FACTS JSON (run 2: the valid run)

```json
{
  "scratch_dir": "Shared with Crow/Casa Nueva/W2 spike 1791071013777",
  "mkcol": 201,
  "S1_put_if_match_status": 204,
  "S1_versions_after_two_puts": [
    "1791071013",
    "1791071015"
  ],
  "S1_current_listed_as_version": true,
  "S1_previous_version_id_equals_old_mtime": true,
  "S2_label_status": 207,
  "S2_etag_unchanged_by_label": true,
  "S2b_label_current_version_status": 207,
  "S2c_etag_unchanged_by_labeling_current": true,
  "S3_restore_status": 201,
  "S3_content_after_restore": "one",
  "S3_versions_after_restore": [
    "1791071013",
    "1791071015"
  ],
  "S3b_mtime_after_restore_equals_revision": true,
  "S4_versions_for_three_puts_1100ms": 3,
  "S5_config_has_key": true,
  "S5_info_no_session": {
    "key": "2063882263",
    "error": 1
  },
  "S8_cal_delete_then_recreate": "skipped (Menu not shared with crow-bot yet)",
  "cleanup_delete": 500
}
```

Every Step 5 expectation holds: S1 204 / true / true; S2 207, true; S2b 207; S2c true; S3 201 and `one`; S3b true; S4 = 3; S5 `error` = 1. S8 was `skipped` in this run because Menu was not shared with crow-bot yet. Kevin's runs below re-ran it after Menu was shared: **201**.

### Run 1 (void: a spike bug, not a Nextcloud fact)

The first run used the brief's `prop()` verbatim. Nextcloud returns the etag XML-escaped (`<d:getetag>&quot;…&quot;</d:getetag>`), so the spike sent `If-Match: &quot;…&quot;` and got **412**. Every later fact in that run was vacuous: one version only, and a restore of the current version returned 500. The fix decodes XML entities in `prop()`, then the run was repeated (run 2 above). Product code parses with xmldom, which decodes entities, so this is not a product finding. It is a warning for any regex-based PROPFIND parsing. Run 1's scratch folder was trashed normally (DELETE 204).

### Finding outside the Step 5 list: deleting a folder that holds a restored file returns 500

`cleanup_delete` = 500 in run 2. Nextcloud log (same request): `OCA\Files_Trashbin\Exceptions\CopyRecursiveException` from `Trashbin::retainVersions → copy_recursive("admin/files_versions/…/W2 spike …", "admin/files_trashbin/versions/…")`. A PHP warning comes first: `copy(…/files_versions/…/v.txt.v1791071013): Failed to open stream: No such file or directory`. After the S3 MOVE-restore, the filecache still lists the restored revision's version file, but the file is no longer on disk. The trash move of the versions directory then fails on it.

A small repro (`W2 repro <ts>`, same scratch parent, two files, PUT/PUT/restore each) showed:
- `DELETE` of the **file** after a restore: **204**. It lands in crow-bot's trash.
- `DELETE` of the **folder** that holds a restored file: **500**.

After the 500, the folder is gone from crow-bot's view (PROPFIND 404). It is **not** in crow-bot's trash. Whether it reached the owner's (`admin`) trash was not checked: that needs admin credentials or occ. The files are throwaway test data.

What this means for W2: undo-by-restore (S3) followed later by a **folder** delete of the parent can return 500, even though the delete took effect. A ws_* folder delete should treat a 500 as "re-check with PROPFIND" rather than as a hard failure. That ruling belongs to whichever task owns folder deletes. It is not decided here.

Leftovers from this spike, all test data: `W2 spike 1791070996054` (run 1) and `file_delete.txt` (repro) are in crow-bot's trash. The run-2 folder and the repro folder went wherever the 500 path puts them (see above).

### Step 6 — labeled-version expiry (NC 34.0.4, read-only in the container)

`docker exec crow-workspace-nextcloud-1 grep -rn -i label …/apps/files_versions/lib/Expiration.php …/Storage.php`:

- `apps/files_versions/lib/Expiration.php`: no `label` reference. The policy class knows nothing about labels.
- `apps/files_versions/lib/Storage.php:602` / `:613`, inside `expireOlderThanMaxForUser()` (`:562`), is the max-age background expiry. The comment reads "Check that the version does not have a label." and the code is `if ($versionEntity->getMetadataValue('label') !== null && … !== '') { return false; }`. A labeled version is **never** selected.
- `apps/files_versions/lib/Storage.php:965`, inside `expire()` (`:864`), is the per-file retention via `getExpireList()` (`:934`/`:945`). For each candidate it reads `if ($versionEntity->getMetadataValue('label') !== null && … !== '') { continue; }`. A labeled version is **skipped**.
- **Exception**, `apps/files_versions/lib/Storage.php:982-997`, still in `expire()`: when the user's version space is still exhausted after the retention pass ("running out of space! Delete oldest version", `:992`), Nextcloud deletes the oldest versions, keeping the newest 2. It does **not** check the label here. Labeled versions skipped at `:965` stay in `$allVersions`, so this loop can delete them.

### Rulings

- **R-EXPIRY: exempt, except under version-space exhaustion.** Labeled versions are exempt from age expiry and from retention expiry (Storage.php:602-615, :965). They are **not** exempt from the quota-exhausted fallback (Storage.php:982-997). Per R-EXPIRY nothing changes in code: undo already returns `version_gone` honestly. The skill should say "Before Crow" versions survive normal expiry but can be lost when the owner's storage is full.
- **R-COLLIDE: spacing stays 1100 ms.** S4 made three PUTs 1.1 s apart and got 3 versions. `WRITE_SPACING_MS = 1100` is confirmed.
- **Labeling the current version:** S2b 207 and S2c true. `finishWrite` may label the current version; the etag is unchanged by labeling, so undo tokens can use the pre-label etag.

## Kevin run 1: `--editor-test` (S6/S6b; also S1-S5 and S8)

```json
{
  "scratch_dir": "Shared with Crow/Casa Nueva/W2 spike 1791091046752",
  "mkcol": 201,
  "S1_put_if_match_status": 204,
  "S1_versions_after_two_puts": [
    "1791091046",
    "1791091048"
  ],
  "S1_current_listed_as_version": true,
  "S1_previous_version_id_equals_old_mtime": true,
  "S2_label_status": 207,
  "S2_etag_unchanged_by_label": true,
  "S2b_label_current_version_status": 207,
  "S2c_etag_unchanged_by_labeling_current": true,
  "S3_restore_status": 201,
  "S3_content_after_restore": "one",
  "S3_versions_after_restore": [
    "1791091046",
    "1791091048"
  ],
  "S3b_mtime_after_restore_equals_revision": true,
  "S4_versions_for_three_puts_1100ms": 3,
  "S5_config_has_key": true,
  "S5_info_no_session": {
    "key": "2465396683",
    "error": 1
  },
  "S6_lock_while_open": {
    "lock": "1",
    "type": "1",
    "owner": null
  },
  "S6_put_while_open_status": 423,
  "S6_info": {
    "key": "591336860",
    "error": 0,
    "users": [
      "oc3q5ynue57b_admin"
    ]
  },
  "S6_drop": {
    "key": "591336860",
    "error": 0
  },
  "S6_seconds_until_unlock": 1.039,
  "S6_typing_saved_contains_SPIKE": true,
  "S6_versions": [
    "1791091051",
    "1791091125"
  ],
  "S6b_bot_put_after_unlock_status": 204,
  "S6b_person_save_and_bot_write_are_distinct_versions": true,
  "S6_editor_ui": "I get a pop-up stating \"The file cannot be accessed right now\"",
  "S8_cal_recreate_same_href_after_delete_status": 201,
  "cleanup_delete": 500
}
```

- S6 lock while the editor is open: `nc:lock` = `1`, `lock-owner-type` = `1`. `lock-owner` came back **null**, where the plan expected `onlyoffice`. That is recorded as observed. Product code should key on the lock and its type, not on the owner string.
- S6 PUT while open: **423**. `info` listed the session user (`oc3q5ynue57b_admin`, i.e. `<instanceid>_admin`). `drop` returned `error` 0, and the lock cleared after **1.039 s**.
- `S6_typing_saved_contains_SPIKE` = true. S6b: the bot PUT after the unlock returned 204, and the person's save and the bot's write are **distinct versions**.
- **S6 editor UI (Kevin):** after the drop, the tab showed the pop-up "The file cannot be accessed right now".
- **S8:** re-creating the calendar object at the same href after a delete returned **201** (Menu is now shared with crow-bot).
- `cleanup_delete` = 500 again: the folder held a restored file (see the finding above).

## Kevin run 2: `--capture-fixtures` (S7; also S1-S5 and S8)

```json
{
  "scratch_dir": "Shared with Crow/Casa Nueva/W2 spike 1791091209849",
  "mkcol": 201,
  "S1_put_if_match_status": 204,
  "S1_versions_after_two_puts": [
    "1791091209",
    "1791091211"
  ],
  "S1_current_listed_as_version": true,
  "S1_previous_version_id_equals_old_mtime": true,
  "S2_label_status": 207,
  "S2_etag_unchanged_by_label": true,
  "S2b_label_current_version_status": 207,
  "S2c_etag_unchanged_by_labeling_current": true,
  "S3_restore_status": 201,
  "S3_content_after_restore": "one",
  "S3_versions_after_restore": [
    "1791091209",
    "1791091211"
  ],
  "S3b_mtime_after_restore_equals_revision": true,
  "S4_versions_for_three_puts_1100ms": 3,
  "S5_config_has_key": true,
  "S5_info_no_session": {
    "key": "2136596261",
    "error": 1
  },
  "S8_cal_recreate_same_href_after_delete_status": 201,
  "S7_captured_oo-rich.docx_bytes": 45244,
  "S7_captured_oo-rich.xlsx_bytes": 13548,
  "S7_captured_oo-rich.pptx_bytes": 36249,
  "cleanup_delete": 500
}
```

`tests/fixtures/workspace/oo-rich.{docx,xlsx,pptx}` were captured: 45,244, 13,548 and 36,249 bytes. Each one differs from its `rich.*` counterpart (`cmp`), and each is a valid zip (`unzip -tq`: no errors).

## Kevin run 3: S9 plugin probe (`run-probe.sh`)

S9 SUMMARY:

```json
{
  "S9_has_jwt": true,
  "S9_jwt_signature_valid": true,
  "S9_documentId_equals_key": true,
  "S9_token_user_in_info_users": true,
  "S9_token_kinds": [
    "word/edit: docservice_session (lifetime >= 1 day) (2592000s)",
    "cell/edit: docservice_session (lifetime >= 1 day) (2592000s)",
    "slide/edit: docservice_session (lifetime >= 1 day) (2592000s)",
    "word/view: docservice_session (lifetime >= 1 day) (2592000s)"
  ],
  "S9_view_mode_on_phone": true,
  "S9_callcommand_structured_result": true,
  "S9_indicator_method": "start called, end called ×5",
  "S9_edit_command": "{\"ok\":true}",
  "api_present": [
    "AddSheet",
    "AddText",
    "CreateParagraph",
    "CreateRun",
    "GetActiveSheet",
    "GetAllHeadingParagraphs",
    "GetAllParagraphs",
    "GetAllShapes",
    "GetDocContent",
    "GetDocument",
    "GetPresentation",
    "GetRange",
    "GetSheet",
    "GetSlideByIndex",
    "GetStyle",
    "GetText",
    "GetTextPr",
    "GetUsedRange",
    "GetValue",
    "InsertParagraph",
    "Push",
    "RemoveAllElements",
    "Search",
    "SearchAndReplace",
    "SetName",
    "SetNumberFormat",
    "SetStyle",
    "SetTextPr",
    "SetValue"
  ],
  "api_missing": [
    "AddComment",
    "SetBold",
    "SetColor",
    "SetItalic",
    "SetUnderline"
  ],
  "S9_view_mode_claim": {
    "marker_values_that_differ": {},
    "claims_only_in_edit": [],
    "claims_only_in_view": []
  },
  "S9_command_noop_while_user_edits_cell": {
    "ticks_in_window": 1,
    "ran": 1,
    "no_callback": 0,
    "callback_not_ok": 0
  },
  "S9_lock_baseline_before_phone": {
    "lock": "",
    "type": null,
    "owner": null
  },
  "S9_phone_locks_file": {
    "lock": "1",
    "type": "1",
    "owner": null
  }
}
```

API present: AddSheet, AddText, CreateParagraph, CreateRun, GetActiveSheet, GetAllHeadingParagraphs, GetAllParagraphs, GetAllShapes, GetDocContent, GetDocument, GetPresentation, GetRange, GetSheet, GetSlideByIndex, GetStyle, GetText, GetTextPr, GetUsedRange, GetValue, InsertParagraph, Push, RemoveAllElements, Search, SearchAndReplace, SetName, SetNumberFormat, SetStyle, SetTextPr, SetValue
API missing: AddComment, SetBold, SetColor, SetItalic, SetUnderline

- **Sessions.** Every session had a token with a valid HS256 signature against the shared secret. In every session `documentId` equalled both the token's `document.key` and the OCS config key, and the token user (`editorConfig.user.id`) was in `info.users`. The sessions were word/edit (view false, mobile false), cell/edit, slide/edit and word/view on the phone (view true, mobile true).
- **Token claim names** (identical in every session): document, document.key, document.permissions, document.permissions.edit, document.permissions.protect, document.permissions.changeHistory, document.ds_encrypted, editorConfig, editorConfig.user, editorConfig.user.id, editorConfig.user.name, editorConfig.user.index, editorConfig.ds_isCloseCoAuthoring, editorConfig.ds_sessionTimeConnect, iat, exp.
- **Token kind:** the docservice **session** token, lifetime 2,592,000 s (30 days), in every session. It is not a 5-minute editor-config JWT.
- **View-mode claim:** none. No claim differs between the edit and view tokens: `marker_values_that_differ` is `{}` and no claim name is present in one but not the other. `document.permissions.edit` is the same in both.
- **`S9_callcommand_structured_result`:** true. The result was `{"ok":true,"n":2,"kind":"object"}` in every session.
- **Indicator:** `StartAction`/`EndAction` were called without error in every edit session. On the laptop docx Kevin saw "Crow probe…" (y). The **xlsx indicator answer was empty**, so it is recorded as **unknown** (start and end were called). On the phone Kevin saw nothing (n).
- **Live edit:** the word command returned `{"ok":true}`. Kevin saw the "CROW-PROBE" paragraph (y), and the server-side check found CROW-PROBE in the saved probe.docx after close (1 occurrence).
- **`S9_command_noop_while_user_edits_cell`:** 1 tick landed inside the marked cell-edit window and it **ran** (no failures). Kevin confirmed Z99 showed the ticks (y).
- **Phone viewing locks the file.** The lock baseline with no editor open was `{"lock":"","type":null,"owner":null}`. While the phone viewed the file it was `{"lock":"1","type":"1","owner":null}`.
- **Cleanup** (runner output): the plugin dir was removed, the editor cache flushed, the Serve path turned off, **serve map identical to baseline**, and the scratch folder deleted.
- The full facts file is outside the repo: `~/crow-weekend-push/reports/w2-plugin-probe-facts-20261004-002510.json`. It was checked against the .env values before anything was copied from it: 0 secret hits, 0 JWT-like strings.

## Controller rulings (recorded verbatim)

* R-PROCEED CONFIRMED: drop releases the lock in 1.04 s, typing saved (SPIKE true), person save + bot write are distinct versions; the dropped tab shows "The file cannot be accessed right now".
* R-EXPIRY: labeled versions exempt from normal expiry, not from quota-pressure expiry (NC 34.0.4 Storage.php evidence) — undo returns version_gone honestly; skill notes it.
* R-COLLIDE: spacing stays 1100 ms (3 PUTs → 3 versions).
* S8: calendar re-create at the same href after delete = 201 → pimUndo delete branch re-creates at the same href (no fallback).
* R-LIVE ENABLED: token present, HS256 valid with the shared secret, documentId == key, user ∈ info.users, structured callCommand result true, live edit saved. The token is the docservice SESSION token (lifetime 2,592,000 s), not a 5-min editor JWT → auth MUST bind to a live session (current key + user ∈ info.users, checked per claim), never trust exp alone. View vs edit cannot be told from the token: the plugin self-reports isViewMode and never claims in view mode; the server additionally treats a claim-ack as unverified until the postcondition/save check (verified column), so a view-mode or no-op ack can never mark a change applied. LIVE_OPS excludes every op needing AddComment/SetBold/SetItalic/SetUnderline/SetColor → ws_docs_add_comment and ws_docs_format_text are close-time only. The live command ran while the user was mid-cell-edit (ticks 1, no failures).
* Phone viewing locks the file: queued changes for a file open only on a phone (view mode) wait for close-time apply; the skill says so.
