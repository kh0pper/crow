---
name: matrix-bridges
description: Matrix appservice bridges — Signal, Telegram, WhatsApp, custom crow-matrix-bridge. Opt-in per bridge.
triggers:
  - "matrix bridge"
  - "bridge signal"
  - "bridge telegram"
  - "bridge whatsapp"
  - "mautrix"
  - "signal to matrix"
  - "telegram to matrix"
tools: []
---

# Matrix Bridges — relay closed-platform chat into Matrix

This meta-bundle installs Matrix appservice bridges from the mautrix project: Signal, Telegram, WhatsApp. Each bridge runs as a sidecar container on the shared `crow-federation` network; Dendrite (from F.3) registers each bridge's appservice YAML and routes events to/from it.

This bundle is **opt-in per bridge.** Enable only the bridges you need.

## Legal + privacy caveats

Each bridge has a distinct legal profile — they are not equivalent.

- **Signal** explicitly prohibits automated clients and bot relays in its Terms of Service. Running mautrix-signal against a personal Signal number risks Signal terminating that number **with no appeal.** Use only if you accept that risk or you're using a burner.
- **Telegram** tolerates bot bridges via its official API, but throttles aggressively on new accounts. Requires a Telegram API ID + hash from [my.telegram.org/apps](https://my.telegram.org/apps).
- **WhatsApp** (mautrix-whatsapp) works by registering as a "multi-device companion" on your phone's WhatsApp account. **Meta may ban the linked phone number.** Assume the number is at risk; don't bridge a number you can't afford to lose.

Beyond platform-ToS risk, bridges create a privacy surface:

- **Double-puppeting** — the bridge bot impersonates YOU inside Matrix rooms so your messages appear authored by `@you:your-server`. This is usually what you want, but it means every federated Matrix server with a member in your room sees messages that originated on Signal/Telegram/WhatsApp.
- **Media relay** — bridges fetch media from the remote platform and re-upload it to Dendrite. Retention matches Dendrite's media cache.
- **History** — most bridges backfill room history by default. First-time bridging a large chat can produce hours of sync activity.

If you don't want any of the above, don't install this bundle.

## Hardware

Each enabled bridge adds 500 MB - 2 GB of RAM and 5-20 GB of disk.

| Bridge   | RAM idle | RAM under load | Disk (1y of use) |
|----------|----------|----------------|-------------------|
| Signal   | 256 MB   | 512 MB         | 2-5 GB            |
| Telegram | 384 MB   | 768 MB         | 5-15 GB           |
| WhatsApp | 512 MB   | 1.5-2 GB       | 10-20 GB          |

Media-heavy chats (WhatsApp group with family photos) push the upper bound.

## Enable a bridge

Edit the bundle's `.env`:

```
BRIDGE_SIGNAL_ENABLED=true
# or
BRIDGE_TELEGRAM_ENABLED=true
BRIDGE_TELEGRAM_API_ID=<from my.telegram.org>
BRIDGE_TELEGRAM_API_HASH=<from my.telegram.org>
# or
BRIDGE_WHATSAPP_ENABLED=true
```

Then `crow bundle restart matrix-bridges`. The post-install script:

1. Starts the corresponding compose profile so the bridge container generates its `/data/registration.yaml`.
2. Copies each registration YAML into `crow-dendrite:/etc/dendrite/appservices/<bridge>.yaml`.
3. Patches `dendrite.yaml` to include each registration (idempotent).
4. **Restarts Dendrite** — appservice registrations are read ONLY at startup. Hot reload silently no-ops. Mid-restart, the homeserver is unreachable for ~20 seconds.

## Pair your accounts

After the bridge bot is alive inside Dendrite, DM it from any Matrix client you're logged into as your personal user (Element is the reference client):

- **Signal**: DM `@signalbot:<your-matrix-domain>` → send `login`. A QR code appears; scan it from Signal → Settings → Linked Devices.
- **Telegram**: DM `@telegrambot:<your-matrix-domain>` → send `login` → enter phone number → enter SMS code or 2FA password.
- **WhatsApp**: DM `@whatsappbot:<your-matrix-domain>` → send `login qr` → scan from WhatsApp → Settings → Linked Devices.

Bridged rooms appear in your Matrix client automatically once pairing completes.

## Disable / remove a bridge

Bridges leave state behind even after disabling:

1. Stop the bridge sidecar: toggle `BRIDGE_*_ENABLED=false` in `.env` and `crow bundle restart matrix-bridges`.
2. Log out the bridge bot from the remote platform (Signal → Linked Devices → Unlink; WhatsApp → Linked Devices → Log Out).
3. Optionally remove the appservice YAML from Dendrite:
   ```bash
   docker exec crow-dendrite rm /etc/dendrite/appservices/<bridge>.yaml
   # Remove the corresponding config_files entry from dendrite.yaml by hand
   docker compose -f bundles/matrix-dendrite/docker-compose.yml restart dendrite
   ```
4. Bridged rooms in your Matrix client become inert (bridge bot appears offline, no new messages flow in either direction, but history is preserved).

Leaving a bridge enabled but logged-out is NOT equivalent to removing it — the bridge process continues to run and consume resources.

## F.11 identity attestation

You can optionally attest that `@signalbot:your-domain` belongs to your Crow identity via `crow_identity_attest`. This is most useful if you have public bridged rooms where you want remote viewers to confirm the bridge is operated by you, not a spoofed actor on a homeserver with the same name.

```
crow_identity_attest {
  "app": "matrix-dendrite",
  "external_handle": "@signalbot:your-domain.example",
  "confirm": "yes"
}
```

## Bridge updates + CVE awareness

The mautrix project pushes fixes (including security) frequently. This bundle uses the floating `:latest` tag to stay current. `crow bundle restart matrix-bridges` pulls the newest image. Review mautrix changelogs before bridging against production accounts; breaking config changes sometimes require manual YAML edits under `~/.crow/matrix-bridges/<bridge>/config.yaml`.

## Troubleshooting

- **"Bridge bot not responding"** — check `docker logs crow-mautrix-<bridge>`. Missing registration.yaml in Dendrite is the usual culprit; re-run `post-install.sh`.
- **"401 from homeserver"** — bridge's as_token doesn't match what Dendrite has. Copy the registration YAML again + restart Dendrite.
- **Paired but messages don't flow** — check the bridge's `.env`: `MAUTRIX_HOMESERVER_DOMAIN` must exactly match `MATRIX_SERVER_NAME` from the matrix-dendrite bundle. A mismatch silently drops every event.
- **Signal bot stuck "connecting…"** — signald (the Signal sidecar mautrix-signal talks to) sometimes wedges. `docker restart crow-mautrix-signal`.
- **WhatsApp pairing fails repeatedly** — Meta is almost certainly detecting and blocking. Try from a different account. This is expected and not a bundle bug.
