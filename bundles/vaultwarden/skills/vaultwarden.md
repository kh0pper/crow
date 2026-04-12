---
name: vaultwarden
description: Vaultwarden — self-hosted Bitwarden-compatible password manager
triggers:
  - "vaultwarden"
  - "bitwarden"
  - "password manager"
  - "self-host passwords"
  - "gestor de contraseñas"
  - "bóveda de contraseñas"
tools:
  - vaultwarden_status
  - vaultwarden_user_count
  - vaultwarden_backup_info
---

# Vaultwarden — self-hosted password vault

Vaultwarden is an unofficial Bitwarden-compatible server written in Rust.
Your passwords, notes, TOTP codes, and attachments live in a SQLite vault
on this host; the official Bitwarden browser extension and mobile apps
connect to it over HTTP(S).

## One-time setup (do this in order)

1. **Generate an admin token:**
   ```
   openssl rand -base64 48
   ```
   Store the output in `.env` as `VAULTWARDEN_ADMIN_TOKEN`. Vaultwarden
   accepts the raw token (simplest) or a hashed form — for MVP, use the
   raw token and keep `.env` readable only by your user.

2. **Start the bundle** from the Extensions panel.

3. **Create your account** at `http://localhost:8097` — this becomes your
   personal vault. Use a long, memorable master password you will
   remember forever. It cannot be reset from the admin panel.

4. **Disable open signups.** Edit `.env`:
   ```
   VAULTWARDEN_SIGNUPS_ALLOWED=false
   ```
   Restart the bundle. New users can now only be invited from the
   admin panel.

5. **Set up a backup.** The one thing standing between you and
   catastrophic loss is `~/.crow/vaultwarden/data`. A reasonable
   approach:
   ```
   0 3 * * * tar czf ~/backups/vaultwarden-$(date +\%Y\%m\%d).tgz -C ~/.crow vaultwarden/data
   ```
   Copy those tarballs off-host. Test a restore at least once.

## Day-to-day use

The MCP tools here are intentionally minimal:
- `vaultwarden_status` — is the server up?
- `vaultwarden_user_count` — how many accounts, via the admin API
- `vaultwarden_backup_info` — size and age of the data directory

**Vaultwarden does not have a "read my passwords" API and Crow does not
build one.** Use the Bitwarden browser extension, desktop app, or mobile
app for every interactive password operation. Point them at
`http://localhost:8097` (or your Caddy-fronted HTTPS URL).

## Remote access

Vaultwarden binds to `127.0.0.1:8097`. To reach it from other devices:

- **Best:** install the Caddy bundle and add a site mapping, e.g.
  `vault.yourdomain.com -> http://127.0.0.1:8097`. Caddy handles TLS.
- **Tailscale:** connect your phone to the same Tailscale network and
  use the host's Tailscale IP + `:8097`.
- **Do not** bind Vaultwarden directly to `0.0.0.0` on the public
  internet without TLS — vault sync is fine over HTTP, but logins are
  not.

## Recovery from a forgotten master password

You can't. That's the point. Your master password encrypts the vault
and is never sent to the server in usable form. If you forget it, the
vault is gone. Store a printed one-time recovery code somewhere safe.
