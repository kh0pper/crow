---
title: Auto-Update
---

# Auto-Update

Crow includes a built-in auto-updater that checks for new versions, pulls changes, and restarts the gateway. No manual SSH or git commands required.

## How It Works

The auto-updater runs as a background task inside the gateway process:

1. **Fetch** — runs `git fetch origin main` to check for new commits
2. **Stash** — if there are local changes (modified files, uncommitted work), stashes them automatically
3. **Pull** — runs `git pull --ff-only origin main` (fast-forward only, no merge commits)
4. **Dependencies** — runs `npm install` if `package.json` or `package-lock.json` changed
5. **Migrations** — runs `node scripts/init-db.js` for any schema changes
6. **Restore** — pops the stash to restore local changes. If there are conflicts, restores a clean state and logs a warning
7. **Restart** — gracefully closes the HTTP server and exits so systemd restarts the process

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-update enabled | Yes | Toggle in Settings > Updates |
| Check interval | 6 hours | How often to check for new versions |

### Settings page

Go to **Settings > Updates** in the Crow's Nest to:

- Enable or disable auto-update
- See the current version (git commit hash)
- See when the last check ran and what it found
- Manually trigger an update check

## Dirty Working Tree

If your instance has local modifications (common on development machines or after manual config edits), the auto-updater handles them gracefully:

1. Before pulling, runs `git stash --include-untracked` to save all local changes
2. After the update completes, runs `git stash pop` to restore them
3. If the restore has merge conflicts, the updater:
   - Runs `git checkout -- .` to return to a clean post-update state
   - Logs a warning with instructions to recover changes manually
   - Your changes are preserved in `git stash list` and can be recovered with `git stash pop`

This means the gateway always restarts with valid source code, even if your local changes conflict with the update.

## Graceful Restart

When the auto-updater (or a bundle install) triggers a restart, it:

1. Emits a `crow:shutdown` event to close the HTTP server's listening socket
2. Waits 1 second for the socket to release
3. Exits with code 1 so systemd's `Restart=on-failure` brings the service back up

This prevents the common `EADDRINUSE` error where the new process starts before the old one has released the port.

## Manual Update

If you prefer to update manually:

```bash
cd ~/crow
git pull origin main
npm install
npm run init-db
sudo systemctl restart crow-gateway
```

Or trigger a one-time check from the Settings page without enabling automatic checks.

## Rollback

If an update causes issues:

```bash
cd ~/crow
git log --oneline -5          # Find the previous commit
git checkout <commit-hash>    # Roll back
sudo systemctl restart crow-gateway
```

The auto-updater only uses fast-forward pulls, so `git reflog` always has the previous state.

## Logs

Update activity is logged to the gateway's stdout (visible in `journalctl -u crow-gateway`):

```
[auto-update] Enabled — checking every 6h
[auto-update] 3 new commit(s) available. Updating...
[auto-update] Dependencies changed — running npm install...
[auto-update] Running database migrations...
[auto-update] Local changes stashed and restored successfully.
[auto-update] Updated: c29e19c → 9d18049
[auto-update] Restarting gateway via systemd...
```

Update results are also saved to the database and visible in Settings > Updates.
