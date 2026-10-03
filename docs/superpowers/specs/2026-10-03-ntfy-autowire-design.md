# ntfy autowire — design note (spec-lite)

Date: 2026-10-03 · Stream: NTFY-AUTOWIRE (weekend push follow-ups backlog) · Status: implemented on `feat/ntfy-autowire`

## Problem

Crow-native pushes (Perch turn-end/ask cards, reminders, peer messages; `servers/gateway/push/ntfy.js`)
only reach a phone when the gateway's environment carries `NTFY_TOPIC` (+ token). Nothing sets it:

- crow's primary gateway had no `NTFY_*` → `GET /api/push/ntfy-config` answered `{enabled:false}` →
  the Android app's `NtfyListenerService` stopped → no phone push at all.
- grackle worked only because `NTFY_TOPIC`/`NTFY_EXTRA_TOPICS` were hand-set in `~/crow/.env`.
- r4 has `NTFY_TOPIC=kevin-r4` and no token; crow's ntfy runs `auth-default-access: deny` and refused
  every publish. The sender ignored the HTTP status, so this failed silently.
- The stock bundle ran ntfy with no user database at all, so a private topic was impossible, and its
  required `NTFY_TOPIC` manifest var was propagated into the repo `.env` that co-hosted gateways share.

Approved direction (Kevin): *when the notification extension is installed, Crow automatically creates its
own login on it, picks a private channel, and hands both to the app; co-hosted instances get their own topic.*

## Decisions

1. **Provisioning runs in the gateway (JS), not a bash post-install hook.** It must also run for hosts that
   already have the bundle (crow), for a co-hosted instance that shares another instance's ntfy (r4, which
   has no bundle dir), and from a Settings button — a hook runs only at install. It shells out with
   `execFile("docker", ["exec", "crow-ntfy", "ntfy", ...])` (no shell), through an injectable runner.
   Steps, each idempotent:
   - `ntfy user list` → add `crow-<key>-pub` and `crow-<key>-app` if missing (`ntfy user add`, a random
     throwaway password passed as `NTFY_PASSWORD` through the docker CLI's environment — never argv; Crow
     only ever uses tokens).
   - `ntfy access crow-<key>-pub crow-<key> write-only`, `ntfy access crow-<key>-app crow-<key> read-only`,
     `ntfy access everyone crow-<key> deny` — the topic is private even on a server whose default access is
     read-write.
   - Tokens: a stored token is reused only if `ntfy token list <user>` still lists it; otherwise
     `ntfy token add --label=crow-autowire <user>` mints one.
   - "auth-file does not exist" right after `compose up` (the server has not started yet) is retried for
     ~30 s; a server with no user database at all fails with a plain-language reason.
2. **Key = the instance id.** `<key>` is the first 10 hex chars of `$CROW_DATA_DIR/instance-id`. A second
   `CROW_HOME`/`CROW_DATA_DIR` (r4) has its own instance id → its own users, topic and tokens on the same
   ntfy server. Nothing is shared between instances except the container.
3. **Storage: a per-instance 0600 file, `$CROW_DATA_DIR/ntfy-push.json`** — not `dashboard_settings`, not
   the bundle `.env`:
   - The sender must stay **DB-free**: the corruption breaker (`cross-host-auth.js`) and migration guard
     call `sendNtfyNotification` directly *because* crow.db may be malformed (PR #124 pattern). A DB-backed
     config would silence exactly those alerts.
   - The bundle `.env` lives in the installing instance's `bundles/ntfy/`; a co-hosted instance sharing the
     server has no such directory, and the repo `.env` (where install propagation writes) is shared by
     every gateway running from `~/crow` — the opposite of "own topic per instance".
   - The data dir is per-instance, already holds `instance-id`, is inherited by MCP children (which also call
     `createNotification`), and is written with the existing `writePrivateFile` (atomic, 0600). The keychain
     is not used: these are machine credentials, not human-facing values.
   - Push status (last send ok/failed + HTTP status, last time a paired app fetched the config) goes in a
     sibling `ntfy-push-status.json`, best-effort, never blocking a send.
4. **Env stays an override; existing env hosts are unchanged.** If `NTFY_TOPIC` is set, every path behaves
   exactly as before (topic, host, port, `NTFY_AUTH_TOKEN`, `NTFY_EXTRA_TOPICS`, URL derivation) and
   autowire never runs at boot. In auto mode, `NTFY_HOST`/`NTFY_PORT`/`NTFY_EXTERNAL_URL`/`NTFY_EXTRA_TOPICS`
   still override field-by-field. New optional `NTFY_SUBSCRIBER_TOKEN` lets an env host stop handing its
   publisher token to apps.
5. **`/api/push/ntfy-config` serves the read-only `-app` token in auto mode — never the publisher token.**
6. **External URL** = a Settings field (`ntfy-push.json` `externalUrl`) with `NTFY_EXTERNAL_URL` semantics:
   the HTTPS address phones use (e.g. Tailscale Serve `https://host.ts.net:8445`). `NTFY_EXTERNAL_URL`
   env overrides it; with neither, the existing derivation (gateway URL host + ntfy port — the port the
   installer's `tailscale serve` uses) applies.
7. **Triggers.** (a) After a successful install of a bundle declaring `"autowire": "ntfy-push"` (logged in
   the install job, non-fatal). (b) Once at boot, 20 s after listen, when no env topic and no config file
   exist and either this instance has the bundle installed or a `crow-ntfy` container is running on the
   host (co-hosted case). Kill switch `CROW_DISABLE_NTFY_AUTOWIRE=1`, forced by `scripts/run-suite.mjs`
   so a scratch suite gateway can never add users to a host's real ntfy. (c) Settings › Notifications
   "Set up phone notifications" button (also the repair path). Uninstalling the bundle removes the
   config file so the sender stops posting to a dead server.
8. **Stock bundle 1.1.0** runs ntfy with a user database and `deny-all` default access
   (`NTFY_AUTH_FILE`/`NTFY_CACHE_FILE` under `/var/lib/ntfy`, same paths crow's override uses, so the exec'd
   CLI and the server agree), and drops the `NTFY_TOPIC`/`NTFY_AUTH_TOKEN` manifest vars (no more topic
   propagation into the shared repo `.env`). The refresh path never copies `docker-compose.yml`, so
   existing installs (crow's override-pinned 2.25.0) are untouched.
9. **Sender reports failure.** A non-2xx publish is recorded as a failed push (status + time) instead of
   being silently ignored; the sender still never throws.

## Settings surface

Settings › Notifications gains "Phone notifications": source (automatic / environment / not set up),
topic, server address field, "a phone fetched these settings <time>" (the best available proxy for "app
subscribed" — ntfy exposes no subscriber list), last push result, and buttons **Set up phone
notifications** (provision/repair) and **Send test notification**. Server-rendered form posts, no client JS.

## Out of scope

- Cross-instance topic sharing (a phone paired to crow also receiving r4's topic): still `NTFY_EXTRA_TOPICS`,
  and in auto mode the app's read token covers only its own topic.
- Migrating r4 off its broken `NTFY_TOPIC=kevin-r4` env: operator removes the env line, then autowire runs.
- Image bump of the stock bundle.
