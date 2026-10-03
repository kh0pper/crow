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

1. **Admin token: nothing to do.** Crow generates it when you install the
   extension, keeps only an Argon2id hash in the extension's settings, and
   saves the token itself in **Settings → Passwords** (encrypted, this machine
   only). The Extensions page shows it to you once right after install; later,
   reveal it from Settings → Passwords (Crow asks you to confirm it's you).
   Use it to sign in at `/admin`.

   **Installed before Crow generated tokens?** Your typed token keeps working: Crow
   reuses it as it is (plaintext in the extension's settings, not in the keychain) — add
   it to Settings → Passwords yourself if you want it there. Such an install also keeps
   its older Vaultwarden server image until you reinstall the extension (your vault data
   in `~/.crow/vaultwarden/data` is kept); saving passwords to the vault from Crow needs
   Vaultwarden 1.37 or newer, and Crow tells you when a reinstall is needed.
   A pre-1.1.0 install may also still have that typed token in the gateway `.env` and
   `mcp-addons.json` (older versions copied it there); only new installs get a generated,
   keychain-held token.

2. **Start the bundle** from the Extensions panel.

   **Give it a secure https address (needed to save passwords to the vault from
   Crow).** The Bitwarden CLI that Crow uses refuses plain `http://` servers, and
   phones and the web vault need https too. You run this step yourself (it needs
   sudo). Check which Serve ports are taken, then pick a free one:
   ```
   tailscale serve status
   sudo tailscale serve --bg --https=<port> http://127.0.0.1:8097
   ```
   Then, in this extension's settings, set
   `VAULTWARDEN_DOMAIN=https://<host>.<tailnet>.ts.net:<port>` (your machine's
   Tailscale name and the port you chose) and restart the bundle. Until you do,
   Crow tells you that vault saving needs a secure https address.

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
- `vaultwarden_user_count` — explains where to see accounts: Vaultwarden's admin API only accepts the browser session from its `/admin` login page, so the tool cannot list or count them itself
- `vaultwarden_backup_info` — size and age of the data directory

**Vaultwarden does not have a "read my passwords" API and Crow does not
build one.** Use the Bitwarden browser extension, desktop app, or mobile
app for every interactive password operation. Point them at
`http://localhost:8097` (or your Caddy-fronted HTTPS URL).

## Remote access

Vaultwarden binds to `127.0.0.1:8097`. To reach it from other devices:

- **Best:** install the Caddy bundle and add a site mapping, e.g.
  `vault.yourdomain.com -> http://127.0.0.1:8097`. Caddy handles TLS.
- **Tailscale:** use the Serve step in setup (step 2): an https address on your
  tailnet, which also works for saving to the vault from Crow.
- **Do not** bind Vaultwarden directly to `0.0.0.0` on the public
  internet without TLS — vault sync is fine over HTTP, but logins are
  not.

## Recovery from a forgotten master password

You can't. That's the point. Your master password encrypts the vault
and is never sent to the server in usable form. If you forget it, the
vault is gone. Store a printed one-time recovery code somewhere safe.
