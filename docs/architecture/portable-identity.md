# Portable Identity (Feasibility Study)

This document explores making Crow installations fully portable — moving your identity, data, and configuration between machines like carrying a key.

## The Pier Concept

Inspired by Urbit's "pier" model, where your entire digital identity is a single directory that you can move between computers. In Crow, the `~/.crow/` directory serves this role:

```
~/.crow/                    ← Your "pier"
├── data/
│   ├── crow.db             # All memories, research, blog posts, contacts
│   └── identity.json       # Cryptographic identity (Crow ID)
├── .env                    # API keys and configuration
├── installed.json          # Add-on state
├── bundles/                # Installed bundles
└── panels/                 # Custom panels
```

**The key insight:** After the data directory standardization (all data in `~/.crow/`), migration is already possible — it's just not automated yet.

## What Works Today

### Local SQLite Users (Most Common)

Migration is straightforward:

1. Stop Crow on the old machine
2. Copy `~/.crow/` to the new machine
3. Install Crow on the new machine (`npm run setup`)
4. Start Crow

Your Crow ID, all memories, research, blog posts, contacts, and messages come with you. The identity is deterministic — same seed produces same keys on any machine.

### P2P State

- **Contacts and messages** are in SQLite — they migrate with the database
- **Hypercore feeds** re-sync automatically via DHT discovery after restart
- **Nostr relay connections** re-establish based on `relay_config` table entries
- Overall: P2P state is mostly transparent to migrate

## Complications

### Turso (Cloud Database) Users

Users with `TURSO_DATABASE_URL` in their `.env` don't have a local database to copy. Options:

1. **Re-point .env** — Just set the same Turso URL on the new machine (trivial, but keeps cloud dependency)
2. **Export to local** — Future `crow export-db` command to dump Turso to local SQLite file for full portability

### MinIO (Object Storage) Users

Files stored in MinIO are not in `~/.crow/data/`. Options:

1. **If MinIO runs locally** — Copy `~/.crow/minio-data/` along with `~/.crow/data/`
2. **If MinIO is remote** — Just keep the same endpoint in `.env`
3. **Future:** `crow export-files` command to download all S3 objects to a local directory

### Docker Volumes

Bundle add-ons using Docker may store data in named volumes (e.g., Nextcloud database, Ollama models). These need separate backup:

```bash
# Export a Docker volume
docker run --rm -v nextcloud-db:/data -v $(pwd):/backup alpine tar czf /backup/nextcloud-db.tar.gz /data
```

### API Keys

API keys in `.env` are machine-specific in some cases (e.g., OAuth tokens tied to redirect URIs). After migration, some keys may need to be re-configured.

## Implementation Path

### Now: Manual Migration (Available Today)

```bash
# On old machine
sudo systemctl stop crow-gateway  # or Ctrl-C if running manually
tar czf crow-backup.tar.gz ~/.crow/

# Transfer to new machine
scp crow-backup.tar.gz newmachine:~/

# On new machine
tar xzf crow-backup.tar.gz -C ~/
git clone https://github.com/kh0pper/crow.git ~/.crow/app  # or update existing
cd ~/.crow/app && npm run setup
```

### Soon: `crow backup` Command (v2)

Add to the `crow` CLI:

```bash
crow backup                    # Create ~/.crow/crow-backup-2024-01-15.tar.gz
crow backup --include-bundles  # Include bundle Docker volumes
crow restore backup.tar.gz     # Restore on new machine
```

Implementation:
1. Create tarball of `~/.crow/` (excluding `app/node_modules/`)
2. Include SHA256 checksum for integrity verification
3. Optionally export Docker volumes for installed bundles
4. `crow restore` extracts, runs `npm install`, `npm run init-db`, starts services

### Later: Cloud-to-Local Migration

For users moving from Render + Turso to self-hosted:

```bash
crow export-db          # Dump Turso → local SQLite
crow export-files       # Download S3 → local directory
# Then migrate ~/.crow/ as normal
```

## Lessons from Urbit

Urbit's pier model demonstrates that state portability works well when:

1. **Identity and data are tightly coupled** — Crow achieves this with `identity.json` and `crow.db` in the same directory
2. **Atomic snapshots** — Don't try to back up a running database. Stop the service first, or use SQLite's backup API
3. **Formal migration protocol** — Document the exact steps and verify integrity. A corrupted backup is worse than no backup
4. **Avoid mutable backup complexity** — Simple tarballs beat incremental backup systems for personal data at this scale

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Corrupted backup | SHA256 checksum verification |
| Incomplete migration (missing Docker volumes) | `--include-bundles` flag with explicit warnings |
| API key incompatibility | Post-migration check that lists which keys need updating |
| Running on both machines simultaneously | Identity collision — warn user to stop old instance first |
| Large databases (>1 GB) | SQLite backup API for live snapshots without stopping service |

## Decision

Portable identity is feasible today for local SQLite users. The `~/.crow/` standardization provides the foundation. Full automation (`crow backup/restore`) is a natural v2 addition to the CLI. Cloud-to-local migration tools are a separate future effort.
