---
title: Satellite Servers
description: Keep an encrypted copy of Crow's nightly database backup on a paired satellite, and restore it on any machine without a running Crow.
---

# Satellite Servers

A **satellite** is a small Crow installation on a second machine that Crow manages over the tailnet. One of its jobs is holding an off-site copy of Crow's nightly database backup. The satellite stores that file and can never read it: the backup is encrypted on Crow with a key that lives in Crow's keychain — and nowhere else except the passphrase-encrypted keychain export you keep offline.

The satellite also cannot lose your only copy — Crow keeps its own local backups — but the off-site copy is what survives a dead primary machine.

## Restore without a running Crow

A restore is possible on **any** machine that has Crow's code and your keychain export. No gateway, no database, no network, and no satellite agent are involved: the backup key is read straight out of the export.

### 1. Get the keychain export

The restore needs the passphrase-encrypted keychain export that contains Crow's **off-site backup key** (`offsite-backup / CROW_OFFSITE_BACKUP_KEY`).

- If you already keep an export offline, use that one.
- If Crow is still running, make a fresh export first: **Settings → Security & passwords → Saved passwords & keys → Export**. Until an export holds that key, Crow says so on the Nest and does not upload any backup, because a backup nobody can decrypt is worse than no backup.
- The export file and its passphrase belong together. Without both, the off-site copy cannot be opened — that is the point of the design.

### 2. Copy the vault file off the satellite

The satellite stores one file per backup, named for the day it was taken, under a directory keyed by your Crow ID:

```
<satellite>:~/.crow-satellite/vault/<crow_id_hash>/crow-db-<YYYYMMDD>.vault
```

Copy it to the machine doing the restore with whatever file transfer you trust (`scp`, a USB stick, an object store). The file is encrypted, so the transfer does not need to be secret — but keep the file itself private anyway.

### 3. Run the restore

From a checkout of Crow's code (Node 24, nothing else):

```bash
node scripts/vault-restore.mjs \
  --file crow-db-20261030.vault \
  --date 2026-10-30 \
  --keychain-export crow-keychain-2026-10-30.json \
  --out /tmp/crow-restored.db
```

- The passphrase is read from **stdin**, never from the command line or the environment. Type it when prompted, or pipe it from your password manager.
- `--date` is the day the backup was taken. The file's header must name that day, and its creation time must fall inside that day ± 1 day: the satellite cannot serve an older backup under a newer name.
- `--out` is never overwritten. Pick a path that does not exist yet.

Every chunk of the file is authenticated before it is written. Plaintext goes to `<out>.partial` first and is renamed to `--out` only after the last chunk verifies, so a file at `--out` is always a complete, verified backup. The command prints one line — the backup date, the bytes written, `verified` — and nothing else: never the key, never the passphrase.

| Exit code | Meaning |
|---|---|
| 0 | Restored and verified |
| 2 | Usage: a missing or bad argument, an unreadable `--file`, or `--out` already exists |
| 3 | The export could not be opened (wrong passphrase, not an export file, or the export holds no off-site backup key) |
| 4 | The vault file was refused. The message names the reason: `bad_magic`, `bad_version`, `bad_header`, `header_too_large`, `bad_chunk_size`, `key_mismatch`, `chunk_too_large`, `tag_failure`, `truncated`, `trailing_data` or `rollback` |

A `rollback` refusal means the file is not the backup for the date you asked for. A `tag_failure` means the file is damaged, was sealed with a different key, or has been tampered with — restore a different copy instead of trying to repair it.

Afterwards, put the restored `crow.db` in place by hand: stop Crow, move the old database aside, copy the restored file to the data directory, and start Crow again. Keep the old file until you have checked that the restored instance has your memories and settings.

::: tip Keep a second way onto the satellite
The restore reads a file that sits on the satellite, so you need *some* way to log in there that does not depend on the primary machine — an ssh key kept with the keychain export, or the hosting provider's console. Keep it wherever you keep the export, and test it once before you need it.
:::