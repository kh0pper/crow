# Crow Workspace W2 — Task 1 spike results

Plan: `docs/superpowers/plans/2026-10-03-workspace-w2-toolset.md`, Task 1. Host: crow, Nextcloud 34.0.4 (`nextcloud:34.0.4-apache`, build `2026-09-10T13:12:32+00:00 77c7284f`), ONLYOFFICE Document Server 9.4.0.1 CE. Runs as `crow-bot` in `Shared with Crow/Casa Nueva/W2 spike <ts>/`.

This file has two kinds of section: **DONE** (automated, run 2026-10-03 ~18:45 local) and **PENDING — Kevin run** (interactive steps that have not run yet). Nothing in a PENDING section is a result.

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

Every Step 5 expectation holds: S1 204 / true / true; S2 207, true; S2b 207; S2c true; S3 201 and `one`; S3b true; S4 = 3; S5 `error` = 1. S8 is `skipped` (Menu is not shared with crow-bot yet), so Task 16 Step 3 re-runs S8.

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
- **R-PROCEED: PENDING — Kevin run (S6/S6b).** It is not decided by the automated run.
- **Labeling the current version:** S2b 207 and S2c true. `finishWrite` may label the current version; the etag is unchanged by labeling, so undo tokens can use the pre-label etag.

## PENDING — Kevin run (S6/S6b): editor test

`node scripts/workspace-w2-spike.mjs --editor-test`. This is not run yet, so there is no S6/S6b FACTS JSON and no S6 editor-UI description, and R-PROCEED is not decided.

## PENDING — Kevin run (S7): ONLYOFFICE-written fixtures

`node scripts/workspace-w2-spike.mjs --capture-fixtures`. This is not run yet, so `tests/fixtures/workspace/oo-rich.{docx,xlsx,pptx}` do not exist.

## PENDING — Kevin run (S9): plugin probe

`scripts/workspace-w2-plugin-probe/run-probe.sh`. This is not run yet, so there are no S9 facts and no `API present` line yet. Task 13's ops test parses that line from this file once the probe has run.

Facts already established for S9, all read-only:
- The bundled plugin `{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}/index.html` loads `./../v1/plugins.js`, `./../v1/plugins-ui.js` and `./../v1/plugins.css`. The probe's `index.html` uses the same includes.
- `documentserver-flush-cache.sh` is at `/usr/bin/documentserver-flush-cache.sh` in `crow-workspace-onlyoffice-1`. It rewrites the nginx cache tag and `api.js`, then reloads nginx.
- `http://127.0.0.1:3071/plugins.json` lists the plugin folders (11 GUIDs plus marketplace) with `"autostart":[]`. It is not yet known whether the document server rebuilds this list per request or only at start. `run-probe.sh` checks it after the copy and stops if the probe is not listed: a container restart would cut open sessions, and that needs a decision.
