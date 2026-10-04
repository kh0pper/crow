# Phone migration (de-Google) — Crow product design

**Date:** 2026-10-04 · **Status:** draft for review
**Plan:** `docs/superpowers/plans/2026-10-04-phone-migration-product.md`

## 1. Summary

The target user is moving a Pixel phone from stock Android to **GrapheneOS with sandboxed Google Play**. They keep the Google apps they still want (email, maps, video, the Play Store) and move everything else to their own Crow instance. This spec covers only the **Crow product work** that makes that move possible.

| Google service | Crow replacement | Crow work in this arc |
|---|---|---|
| Google Photos (library may be large, > 200 GB) | **Immich**, hosted by Crow | Extend the existing `immich` connector bundle so it can also *run* Immich (v2.0.0, local/external modes); Photos page; nightly gpg DB backup; Takeout import tooling |
| Drive / Calendar / Contacts | **Crow Workspace** (Nextcloud) + DAVx⁵ | None; uses the existing Workspace bundle |
| Device backup | **Seedvault** (built into GrapheneOS) → Workspace WebDAV | How-to card in the checklist |
| Password manager | **Vaultwarden** (existing bundle) + Bitwarden app | None (operator setup) |
| Play Store updates for the Crow app | **Crow app self-update feed** served by the gateway | Gateway feed + publish script + in-app updater |
| — | **Settings › Phone migration** | New Settings section: live status checks plus manual ticks |

**Rule for the user's migration:** flash the phone only after the photo library has been imported into Immich and verified, the Workspace import is proven, and backups are green. The checklist page shows these gates.

## 2. Verified external facts (checked 2026-10-04)

Each fact is labelled VERIFIED (primary source), COMMUNITY, or UNVERIFIED (the plan checks it).

### GrapheneOS

- **CLI install.** VERIFIED.
  - Linux Mint 22 is supported (follow the Ubuntu 24.04 instructions).
  - fastboot "must be at least `35.0.1`". The guide calls the Debian/Ubuntu packages "broken and many years out-of-date"; use Google's standalone platform-tools zip.
  - Host setup: udev rules from `android-sdk-platform-tools-common`, `ssh-keygen` for signature checks, `bsdtar`, and stop `fwupd.service` during the flash.
  - Source: https://grapheneos.org/install/cli
- **Web installer.** VERIFIED. It needs a desktop Chromium-family browser with WebUSB; Snap and Flatpak browsers don't work. A headless server, or a browser running inside a container, cannot use it. Source: https://grapheneos.org/install/web
- **OEM unlocking.** VERIFIED. On SKUs that can be sold carrier-locked, enabling OEM unlocking needs internet access, so stock Android can check the carrier lock. The user should confirm the toggle is available before planning anything. Source: https://grapheneos.org/install/cli
- **Back to stock.** VERIFIED. Unlock the bootloader, run `fastboot erase avb_custom_key`, then flash the stock factory image. Source: https://grapheneos.org/install/cli
- **Sandboxed Google Play.** VERIFIED: "near complete compatibility". UNVERIFIED (not named in the docs): that specific Google apps work. Source: https://grapheneos.org/usage#sandboxed-google-play
- **Location.**
  - VERIFIED: Play geolocation requests are rerouted to the OS location service by default. Source: https://grapheneos.org/usage#sandboxed-google-play
  - VERIFIED: GrapheneOS network location is opt-in; it uses Apple's service or a GrapheneOS proxy, primarily based on wireless access points. Source: https://grapheneos.org/features
- **eSIM.** VERIFIED. Previously installed eSIMs keep working. Adding or managing eSIMs needs Settings › Network & internet › eSIM support, which does **not** require Play. Source: https://grapheneos.org/usage#esim-support
- **RCS in Google Messages.** VERIFIED. It works with sandboxed Play, in the Owner profile only. Source: https://grapheneos.org/usage#rcs
- **Banking apps.** VERIFIED: GrapheneOS passes basic integrity but fails the "certified" check. Source: https://grapheneos.org/usage#banking-apps
  - COMMUNITY: per-app status lives in the PrivSec list, https://privsec.dev/posts/android/banking-applications-compatibility-with-grapheneos/
- **WebView.** VERIFIED. Vanadium is the system WebView. Source: https://grapheneos.org/usage
- **Seedvault.** VERIFIED from source code.
  - GrapheneOS ships Seedvault with built-in WebDAV (upstream 14-4.1+).
  - Its allow-list permits USB storage, DAVx⁵ WebDAV and the built-in WebDAV.
  - The Nextcloud app is restore-only (upstream 15-5.3).
  - Apps that opt out of backup are skipped.
  - Sources: https://github.com/GrapheneOS/platform_packages_apps_Seedvault, https://github.com/seedvault-app/seedvault

### Immich and Takeout

- **Immich release and compose.** VERIFIED.
  - v3.2.4 is the latest stable release (https://github.com/immich-app/immich/releases/tag/v3.2.4).
  - The release compose runs `immich-server`, `immich-machine-learning` (the image with no tag suffix is CPU-only), Valkey (pinned by digest) and `ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0` (pinned by digest).
  - The DB password may use `A-Za-z0-9` only.
- **Storage and hardware.** VERIFIED (https://docs.immich.app/install/requirements, https://docs.immich.app/FAQ):
  - RAM: minimum 6 GB, 8 GB recommended.
  - Media should be on a Unix-compatible filesystem.
  - The database must not be on NTFS or exFAT.
  - Thumbnails and transcodes add 10–20 % to the library size.
- **Custom locations.** VERIFIED. Thumbs, encoded-video and backups can sit on other mounts under `/data/…`. Source: https://docs.immich.app/guides/custom-locations
- **Startup integrity check.** VERIFIED. Immich refuses to start if its `.immich` marker files can't be written or read. Source: https://docs.immich.app/administration/system-integrity
- **Backups.** VERIFIED. Use `pg_dump`. The originals (upload/library/profile) must be backed up separately. Source: https://docs.immich.app/administration/backup-and-restore
- **immich-go.** VERIFIED for v0.32.0: it reads Takeout zips directly, has `--dry-run`, syncs albums, and can resume. Exact flag names are rechecked against `--help` before use. Source: https://github.com/simulot/immich-go
- **Google Takeout.** VERIFIED: 50 GB split option, roughly 7-day expiry, 5 downloads per archive. Source: https://support.google.com/accounts/answer/3024190
  - COMMUNITY: the download links need a signed-in browser session.

## 3. Design

### 3.1 Immich hosting in the `immich` bundle (v1.0.0 → 2.0.0)

- The bundle keeps its id, its MCP tools and its skill. A new `IMMICH_MODE` setting picks the mode:
  - `local` (default): Crow runs Immich.
  - `external`: the old behaviour, a connector to an Immich running elsewhere.
- **Generic installer gate `docker.skip_when { env, equals }`.**
  - Measured: compose exits with "no service selected" when every service is profiled out, so compose profiles can't express "run nothing".
  - When the gate matches, install deletes the installed copy's compose file and skips the post-install hook.
  - `validateInstall` skips the Docker-reachable gate and the RAM gate for these connector-only installs.
- **New secret kind `generate: "alnum"`**, needed because Immich's DB password must be alphanumeric.
- **Compose project `crow-immich`.**
  - Images pinned exactly (server and ML at `v3.2.4`, Postgres and Valkey by tag + digest).
  - Loopback `127.0.0.1:2283` only; subnet `10.89.74.0/24`.
  - CPU and memory caps: server 4 GB/12 CPUs, ML 4 GB/8 CPUs, DB 2 GB, Valkey 512 MB.
  - **No GPU.** ML runs on CPU because the GPU belongs to Crow's models.
- **Storage.**
  - `IMMICH_LIBRARY_DIR` holds the originals. It may be a large external drive; the default is `~/.crow/immich/library`. It is a bind mount with `create_host_path: false`, so an unplugged drive stops Immich instead of filling the system disk.
  - Thumbs, encoded video, Immich's DB dumps, Postgres and the ML cache all live under `~/.crow/immich` (fast local disk).
  - Budget: thumbs + transcodes ≈ 10–20 % of the library. The import preflight refuses to run with less than 120 GB free.
  - **NTFS (ntfs-3g) for originals** is outside Immich's recommendation but not forbidden. A scratch spike tests it before merge: uploads, storage-template moves, delete/restore, marker files, the missing-drive refusal, a late mount after a Docker restart, and throughput. Fallbacks if it fails: a second ext4 disk, an ext4 loop image on the drive, or a partition carve. The carve needs a full backup first and is not recommended.
- **Secrets and bootstrap.**
  - The DB password is generated. The admin email and password are typed; the password can be generated and saved to the Crow keychain, is used once, then scrubbed from `.env`.
  - Bootstrap (Python, idempotent) waits for `/api/server/ping`, creates the admin, logs in, and mints a least-privilege `crow-connector` API key (replacing any stale one). It writes `IMMICH_API_KEY`, `IMMICH_URL`, `IMMICH_PUBLIC_HOST` (from `tailscale status`) and `IMMICH_BOOTSTRAP_DONE`.
  - Endpoint and permission names are UNVERIFIED for v3.2.4. The spike records the real responses first, and bootstrap stops on Immich's 400 and quotes it.
- **MCP server.** It reads the bundle `.env` first, then the spawn env, re-read on every call. This lets a key minted after the server spawned work without restarting the gateway.
- **Exposure.** Tailnet-only through Tailscale Serve: `sudo tailscale serve --bg --https=8458 http://127.0.0.1:2283`. **Never Funnel.** Immich can't be served under a sub-path, so the bundle drops `webUI` and gets a **Photos** panel instead. The Office panel links to it.
- **Backups.**
  - `ops/backup.sh`, a user timer at 04:15: `pg_dump` → gzip → gpg, plus `.env` → gpg. Latest copy in staging, 14 days on the backup destination.
  - `ops/restore-check.sh` verifies an archive.
  - The **originals are not backed up by Crow.** The guide tells users to keep a second copy and not to delete their Google Photos library until they have one.
- **Ports.** 2283 (loopback), Serve 8458 (Immich) and 8459 (Vaultwarden), scratch 12283, subnets 10.89.74/75. All registered in `docs/developers/port-allocation.md`.

### 3.2 Google Takeout → Immich tooling

- **Takeout settings.** Photos only, `.zip`, 50 GB parts.
- **Getting the archives onto the server.** Recommended: download on a laptop and copy into a network share. Fallback: Crow's shared browser container. It is an agent-driven browser, so the user must disable bot browser access for the window, set the download directory, and prove it with a small file.
- **`ops/takeout-mover.sh`** (browser fallback) moves finished, zip-tested archives one at a time into staging.
- **`ops/import-takeout.sh`** wraps immich-go:
  - all zips in **one run**, dry-run first;
  - the import key comes from a mode-600 file and is redacted from logs with a literal (non-regex) replace;
  - partner photos are off by default;
  - the import runs under an out-of-process wall-clock cap, with a documented "resume paused jobs" step.

### 3.3 Crow Android app self-update feed

- **Choice.** The gateway serves the feed and the app prompts. Obtainium watching GitHub releases is documented as an alternative.
  - Not an F-Droid repo: that needs fdroidserver, a separate signing key and a client app.
  - Not Obtainium alone: it needs a third-party app and manual GitHub releases.
- **Gateway.** `servers/gateway/android-updates.js` validates `${CROW_HOME}/android-updates/latest.json`: package name, the pinned release-cert SHA-256, X.Y.Z version name, sha256, size, and a file name with no path traversal. Routes, all behind dashboard auth:
  - `GET /api/android/update`
  - `GET /api/android/apk/:versionCode`
- **Publish.** `scripts/android/publish-apk.mjs` refuses unless the APK has exactly one signer equal to the release cert, the right package, and a newer versionCode. It writes the feed atomically and keeps the last 3 APKs.
- **App (1.6.0).**
  - Checks daily, or from a "Check for updates" launcher shortcut.
  - Downloads the APK, verifies its sha256, and checks the APK's signer **equals the installed app's own signer**.
  - Installs through `PackageInstaller`. If Crow is no longer in the foreground (Android 14 background-start limits), it posts a notification instead of launching the confirmation screen.

### 3.4 Settings › Phone migration

- **Live checks**, time-boxed; a failing probe shows "couldn't check":
  - the Crow app was seen on an Android phone and push works;
  - Workspace is ready;
  - Immich is ready;
  - the Immich app is signed in on Android (via `/api/sessions`);
  - Vaultwarden is served over https;
  - an Android peer is on the tailnet.
- **Manual ticks**, stored in `${CROW_HOME}/phone-migration.json` (mode 600, never synced):
  - **Before:**
    - OEM unlock available
    - Takeout imported
    - contacts imported
    - Drive/calendars imported
    - passwords moved
    - authenticator codes moved
    - SMS decision made
    - banking app checked
    - carrier/eSIM plan ready
    - backups green
    - Seedvault target ready
  - **After:**
    - app paired
    - DAVx⁵ syncing
    - Immich backing up
    - Bitwarden signed in
    - authenticator codes verified
    - home-automation app signed in
    - first Seedvault backup done
    - Crow pages OK
- **Seedvault how-to card.** Built-in WebDAV → `https://<tailnet-host>:<workspace-port>/remote.php/dav/files/<login>/Seedvault/`, using a Workspace app password. Keep the 12-word code offline, and leave photo backup off (Immich handles photos).
- **Languages.** en and es.

### 3.5 GrapheneOS compatibility of the Crow app (code audit)

- **No Google Play services dependency.** Push uses Crow's own ntfy listener. The app uses the system WebView (Vanadium). User-agent checks key on `CrowAndroid` / `wv)`.
- **Geolocation.** Goes through the WebView's platform location. Ramble asks for high accuracy with a 10–20 s timeout; check the first GPS fix on the device.
- **Risks to verify on a device:**
  - the hardened allocator (use per-app compatibility mode if needed);
  - the Meta glasses SDK under sandboxed Play (UNVERIFIED);
  - battery-optimization exemptions for the background listener.

## 4. Invariants

- No Funnel for Immich, Workspace or Vaultwarden. `/api/android/*` sits behind dashboard auth.
- Secrets never appear in argv (except the short-lived import key, documented), logs or HTML.
- Images pinned. No GPU devices in the Immich compose (tested).
- Every scratch window on a shared host carries an out-of-process deadman that restores production.

## 5. Testing

- **Unit tests:**
  - `immich-bundle`, `bundles-skip-when`, `immich-bootstrap` (fake Immich HTTP server), `immich-backup` (fake docker, real gpg)
  - `immich-mcp-env-fallback`, `immich-panel`, `immich-import`
  - `android-updates`, `android-publish-apk`
  - `phone-migration-checks`, `phone-migration-section`
  - plus `check-ports` and `build-registry --check`
- **Android:** JUnit for `UpdateDecision`; `assembleRelease`.
- **Live:** the storage spike; the deploy (Photos page ready; reachable on the tailnet, not on the internet); backup + restore-check; an in-app update from one version to the next on a test phone.

## 6. Open product questions

- **P1.** Second-copy tooling for Immich originals (rsync to a second disk). Follow-up arc?
- **P2.** Vaultwarden nightly backup timer, using the same gpg pattern. Follow-up arc?
- **P3.** If a late drive mount leaves Immich down after a reboot: an alert on the Photos page only, or a documented systemd ordering drop-in?
