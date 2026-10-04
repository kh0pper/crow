# Crow Phone: exploration spec

**Date:** 2026-10-04 · **Status:** exploration. This document defines the product and lists what has to be proven before anyone plans it. There is **no plan and no implementation** yet. Each phase in §11 gets its own design spec and plan when it starts.

**Readers.** This document is for Crow developers and contributors. The product is for any Crow user, as part of the public Crow OS product.

**What it builds on.** Some of these specs were still on their own branches when this was written.
- *Phone migration (de-Google) product design*, 2026-10-04. It covers Immich hosted by Crow, the self-update feed for the Crow Android app, and the migration checklist.
- *Crow Kiosk* design, 2026-10-03. It covers:
  - pairing a device with a 6-digit code that the user approves in the dashboard;
  - the reusable server-side voice turn (`servers/gateway/voice/turn.js`, `runVoiceTurn`).
- *Crow Workspace* (2026-10-02) and *Workspace W2 toolset* (2026-10-03). They cover Nextcloud files, CalDAV and CardDAV.
- *Crow Keychain* (2026-10-03, shipped). It covers the local keychain and saving passwords to Vaultwarden.
- The queued *customizable dashboard launcher* arc. Users arrange, hide and group launcher items the way they would on a phone home screen. Bookmark tiles open inside Crow.

**Labels on external facts.** Every external fact below is labelled:
- **VERIFIED**: read on the primary source on 2026-10-04; the URL is given.
- **UNVERIFIED**: inferred, from a secondary source, or not found. A spike in §12 checks it.

All sources are collected in §15.

---

## 1. Purpose and audience

A Crow user who wants a private phone today has to do several hard things by hand:
- install an alternative OS;
- point five separate apps at their own server: photos, files, calendar and contacts, passwords, and backup;
- set up a private network;
- accept that the phone's assistant, home screen and default apps belong to someone else.

Each step is documented somewhere, and none of it is connected to the server that holds their data.

**Crow Phone** makes that one product. The user plugs a supported phone into their Crow, follows one guided sitting, and walks away with:
- a phone running the official, verified GrapheneOS;
- their Crow as the assistant;
- their data syncing to their own server;
- a Crow home screen.

It is **public from the start**. It is written for "a user" with their own Crow, not for one household. It must be safe to follow without a developer in the room.

### Non-goals (v1)

- A modified, re-signed or rebranded operating system. See §10.
- Redistributing third-party APKs.
- Phones other than the GrapheneOS-supported Pixels for the full setup. Phase P1's app roles work on any Android phone the Crow app supports.
- Replacing the phone's dialer, SMS or carrier features.
- Making Crow a mobile-device-management (MDM) product for organisations.

## 2. Product definition

> **Crow Phone = official GrapheneOS + a "Set up a phone" wizard on the Crow OS desktop + the Crow Android app holding the phone's system roles.**

| Part | What it is | Who owns it |
|---|---|---|
| Operating system | **Official GrapheneOS** release images, verified against GrapheneOS's published signing key and never modified or re-signed. GrapheneOS keeps shipping the security updates over its own update server. | GrapheneOS |
| Setup | A **"Set up a phone"** wizard in Crow's Nest on the Crow OS machine. It detects the phone over USB, checks the unlock state, downloads and verifies the release, flashes it with GrapheneOS's documented CLI method, relocks, then pairs and configures. | Crow |
| Roles | The **Crow Android app** (the existing app, grown up). It provides the assistant, the home screen (launcher), file access to Workspace, calendar and contact sync, and autofill, and it guides device backup. | Crow |
| Server side | The user's Crow serves Immich, Workspace (Nextcloud), Vaultwarden, the voice loop and the signed app feed. | Crow |

### Trust rules (binding, from the decisions)

1. **Official images only, always verified.** Crow never flashes an image it has not checked against GrapheneOS's published signature.
2. **Crow's device management is visible and removable.**
   - Anything Crow controls on the phone is listed in the app with an off switch.
   - If Crow uses device-owner mode, the app has a visible "Release this phone" action (§8.3).
3. **The phone keeps working when the Crow is offline.**
   - Calls, SMS, apps and the home screen do not depend on the server.
   - Crow features degrade with a clear "Crow is unreachable" state.
4. **Third-party apps come from their official sources.** Crow serves only its own signed app.

## 3. What exists today (ground truth, `main` @ f90b2274)

**Android app (`android/`).** Package `press.maestro.crow`, version 1.6.0, `minSdk 34`, `targetSdk 34`.

*What it is and how it talks to Crow:*
- **The app is a WebView shell.** It wraps Crow's Nest and talks to the page through a bridge in `MainActivity`.
- **Push uses Crow's own ntfy listener** (`NtfyListenerService`, a foreground service), with no Google Play services.
- **`TailscaleHelper`** detects the official Tailscale app (`com.tailscale.ipn`) and opens it.

*Voice and glasses:*
- **Voice entry points:** a Quick Settings tile labelled "Ask Crow" (`CrowPttTileService`) and a push-to-talk shortcut activity.
- **`GlassesService`** runs a voice turn for Meta glasses against the gateway.
- **`WakeWordEngine`** is a stub. Wake word is off and push-to-talk is the only trigger.

*Dependencies and gaps:*
- **The Meta Wearables SDK (`mwdat-*`) is the one proprietary dependency.** Everything else is AndroidX, OkHttp and Kotlin.
- **None of the system roles exist yet:** no VoiceInteractionService, launcher, AutofillService, DocumentsProvider or sync adapter.

**Gateway and bundles.**
- **Device store.** `bundles/meta-glasses/server/device-store.js` keeps hashed device tokens with `device_kind` and `bound_bot_id`. The kiosk spec moves it to core and adds a `kiosk` kind.
- **Glasses voice loop.** The kiosk spec extracts it into `runVoiceTurn`. That function handles STT, the bound bot's persona and tools, a streamed tool loop, and sentence-chunked TTS.
- **Existing bundles:** `immich` (a connector today; the phone-migration spec makes it host Immich), `workspace` (Nextcloud + ONLYOFFICE), `nextcloud`, `vaultwarden`, `tailscale`, `ntfy`.
- **Keychain.** Shipped: a local encrypted store for extension passwords, plus an optional save into the user's Vaultwarden vault through the Bitwarden CLI. It is **not** a general password manager. The user's general vault is Vaultwarden.
- **Dashboard navigation.** `servers/gateway/dashboard/nav-registry.js` holds groups and panel assignments. The customizable launcher arc is queued but not designed.
- **Naming collision.** Crow's Nest already has a **Phone** panel for outbound assistant calls (spec 2026-09-30). See open question Q8.

## 4. The four day-one capabilities

### 4.1 One-sitting setup from the Crow OS desktop

**What the user sees.**
1. In Crow's Nest on the Crow OS machine: **Phones → Set up a phone**.
2. A preflight page:
   - "Back up anything on this phone first; it will be erased."
   - supported-device check;
   - battery level;
   - a reminder that carrier-locked phones may not unlock.
3. "Plug the phone in with a USB cable." Crow names the detected model and says whether GrapheneOS supports it and until when.
4. Guided device-side steps with pictures:
   - enable Developer options, then **OEM unlocking**;
   - reboot to the bootloader;
   - confirm the unlock on the phone (the phone wipes itself).
5. Crow downloads the release, shows **"Signature verified (GrapheneOS factory images key)"**, and flashes with a progress bar.
6. "Confirm the relock on the phone." Crow shows the official verified-boot key hash for this model to compare with the yellow boot notice.
7. First boot. The user finishes GrapheneOS's own setup. Its last screen disables OEM unlocking by default; the wizard tells them to leave it on.
8. Provisioning (§4.1.2). Crow then shows a summary checklist. Every item is green or names the one tap still needed.

**How it works: flashing.** Everything is VERIFIED from https://grapheneos.org/install/cli unless marked.
- **Host tools.**
  - `fastboot` must be at least `35.0.1`. Debian and Ubuntu "do not have a usable package for fastboot", so Crow fetches Google's standalone platform-tools at run time from Google's own URL.
  - It also needs the udev rules, `ssh-keygen` and `bsdtar`, and `fwupd.service` stopped during the flash.
  - Installing udev rules and stopping fwupd need root. The wizard asks once and restores fwupd afterwards, under an out-of-process deadman.
- **OEM unlocking.** The user turns it on in Developer options. On carrier-lockable SKUs this needs internet access. A Pixel 6a must first be on the June 2022 stock release or later.
- **Unlock.** `fastboot flashing unlock`, confirmed on the device. It wipes all data.
- **Download.**
  - `https://releases.grapheneos.org/DEVICE_NAME-install-VERSION.zip` and its `.zip.sig`.
  - The signer file `https://releases.grapheneos.org/allowed_signers`, which holds GrapheneOS's ed25519 key for `contact@grapheneos.org`.
- **Verify.**
  - `ssh-keygen -Y verify -f allowed_signers -I contact@grapheneos.org -n "factory images" -s <zip>.sig < <zip>`
  - Crow **pins** the allowed-signers key in its own source and fails closed if the downloaded `allowed_signers` disagrees. A rotation therefore needs a Crow release.
- **Flash.** `bsdtar xvf` the zip, then `bash flash-all.sh`.
- **Relock.** `fastboot flashing lock`, confirmed on the device.
- **Disable OEM unlocking.** The final screen of GrapheneOS's setup wizard has an OEM-unlocking toggle that is checked by default and disables it.
- **Check the install.** The yellow boot notice shows the SHA-256 of the verified-boot key, with full hashes on 6th-generation and later Pixels. Users compare it with the official hashes on the install page. The **Auditor** app does hardware attestation (TOFU model). Sources: https://grapheneos.org/install/cli and https://attestation.app/about

**Choosing a release.**
- GrapheneOS's update server is static. Per device it publishes `DEVICE-stable`, `DEVICE-beta` and `DEVICE-testing` channel metadata (VERIFIED, https://grapheneos.org/build).
- Crow installs the **Stable** channel only.
- UNVERIFIED: that the published channel metadata is a reliable machine-readable source for "the current stable install image" and "is this codename supported". Spike S8.

**Fallback: the official web installer.**
- GrapheneOS recommends its WebUSB installer for most users (VERIFIED, https://grapheneos.org/install/web).
- It needs a desktop Chromium-family browser with WebUSB, and does not work from Snap or Flatpak browsers.
- If the Crow host is headless, or the CLI path fails, the wizard links to the official web installer on a laptop. It then resumes at "first boot" for pairing and provisioning.
- Crow never wraps or re-hosts the web installer.

#### 4.1.2 Provisioning: how much can be automated

This is the main research finding of this exploration.

**Stock GrapheneOS has no QR-code (6-tap) managed provisioning today.**
- GrapheneOS's own pages never mention device owner or MDM.
- A pull request adding "Provisioning (MDM setup) by QR code" to GrapheneOS's SetupWizard2 was opened in April 2025 by a third-party MDM vendor. It is **still open**: it was reopened 2026-05-22, and the lead developer commented "It needs major cleanup and changes to meet our requirements." (VERIFIED, https://github.com/GrapheneOS/platform_packages_apps_SetupWizard2/pull/40)
- A community project enrolls GrapheneOS devices with adb for that reason (UNVERIFIED, secondary: https://github.com/themark-net/grapheneos-mdm).

**The automatable path is adb device-owner provisioning, right after first boot.** VERIFIED from AOSP `DevicePolicyManagerService` (main) and https://developer.android.com/work/dpc/dedicated-devices/cookbook.
- After setup has completed, `adb shell dpm set-device-owner` fails if:
  - more than one user exists;
  - **any account exists on the device**;
  - a device or profile owner is already set.
- Non-adb provisioning is only allowed before setup completes.
- `testOnly` is not required. It only waives the no-accounts rule, and Crow must not use it for a production build.
- A freshly flashed GrapheneOS phone has one user and no accounts. So the order is: **finish setup → enable USB debugging → Crow sets the device owner → only then add accounts or profiles.**
- **USB debugging requires the user**: tap Build number, turn on Developer options and USB debugging, then accept the host's RSA key on the phone. The wizard guides this, and reminds the user to turn USB debugging off at the end. (The adb authorization prompt is standard Android behaviour; UNVERIFIED that GrapheneOS changes it.)

**What a device owner can then do without asking the user.** VERIFIED from https://developer.android.com/reference/android/app/admin/DevicePolicyManager and the cookbook.

| Capability | Silent as device owner? | Notes |
|---|---|---|
| Install or update packages through `PackageInstaller` | **Yes** (Android 6.0+) | Only packages Crow has the APK for. Crow serves its own app; third-party apps come from official sources (§7, Q4) |
| Always-on VPN with lockdown (`setAlwaysOnVpnPackage`) | **Yes** | The VPN app must target API 24+ and not opt out. With lockdown on and no allowlist, only system apps bypass |
| Default home app (`addPersistentPreferredActivity` for HOME) | **Yes** | Survives a reset of preferences |
| Runtime permissions (`setPermissionGrantState`) | **Yes**, including microphone/location/camera on Android 12+ | Unless provisioning set the sensors opt-out. The user cannot change a policy-set grant, which conflicts with trust rule 2, so Crow would use it sparingly |
| Managed configuration for another app (`setApplicationRestrictions`) | **Yes** | Used to preconfigure Tailscale (§5) |
| Default dialer / SMS | Yes (API 34 / API 29) | Out of scope |
| **Assistant role** | **No public API found** | UNVERIFIED (absence only). The user picks the assistant in Settings |
| **Autofill service** | **No public API found** | UNVERIFIED (absence only). The user confirms through `ACTION_REQUEST_SET_AUTOFILL_SERVICE` |

**Which roles need a user tap, with or without device owner.**
- **Assistant: always a trip to Settings.**
  - AOSP `roles.xml` marks `ASSISTANT` as `requestable="false"` (VERIFIED, https://android.googlesource.com/platform/packages/modules/Permission/+/refs/heads/main/PermissionController/res/xml/roles.xml).
  - So `RoleManager.createRequestRoleIntent(ROLE_ASSISTANT)` cannot raise a confirmation dialog.
  - The app has to deep-link to the default-apps screen, and the user picks "Crow" as the digital assistant.
- **Home:** one confirmation dialog via `createRequestRoleIntent(ROLE_HOME)`, or silent as device owner.
  - `HOME` has no `requestable` attribute in `roles.xml`. Whether that means requestable by default is UNVERIFIED (S2).
- **Autofill:** one confirmation via `Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE` (VERIFIED, https://developer.android.com/reference/android/provider/Settings).
- **Backup (Seedvault):** configured by the user in Settings. Crow can only guide it (§4.3.5).
- **Tailscale sign-in:** one browser sign-in, unless an auth key is pushed. Tailscale's own docs warn against storing auth keys in MDM (§5).

**Result.** Even in the best case, provisioning on stock GrapheneOS is **"Crow does most of it, the user taps about six times"**:
- USB debugging plus the RSA prompt;
- the assistant in Settings;
- the autofill confirmation;
- Seedvault;
- the Tailscale sign-in;
- possibly the launcher.

The checklist screen makes each tap one button press away. Whether Crow should become device owner at all is open question Q1. It buys silent app updates, the launcher pin and always-on VPN, but it is heavy (§8.3).

**Dependencies on existing Crow pieces:**
- the phone-migration checklist (Settings › Phone migration), which becomes the post-setup checklist;
- the app feed (§7);
- pairing (§6);
- the `tailscale` bundle.

### 4.2 Crow as the phone's assistant

**What the user sees.**
- A long press of the power button, or the wake word if they turned it on, opens a small Crow sheet over whatever they were doing.
- They speak. Their bound Crow bot answers out loud, with captions and tool results (a timer, a note, a calendar entry) shown in the sheet.
- It works from the lock screen for questions that don't need unlocking. Anything touching private data asks to unlock first.

**How it works.**
- **The Crow app implements a `VoiceInteractionService`** (VERIFIED, https://developer.android.com/reference/android/service/voice/VoiceInteractionService):
  - guarded by `BIND_VOICE_INTERACTION`, which is a signature permission;
  - declared with `android.voice_interaction` meta-data pointing at a `<voice-interaction-service>` XML;
  - the system keeps the service running, and the UI lives in a `VoiceInteractionSessionService` in a separate process;
  - the XML attributes include `sessionService`, `recognitionService`, `supportsAssist` and `supportsLaunchVoiceAssistFromKeyguard` (VERIFIED, AOSP `core/res/res/values/attrs.xml`).
- **Long-press power.**
  - AOSP's default `config_longPressOnPowerBehavior` is 5, "Go to assistant" (VERIFIED, AOSP `config.xml`).
  - What GrapheneOS ships by default, and whether the user has to switch "Press and hold power button" from power menu to assistant, is UNVERIFIED (S3).
- **The voice turn runs on the user's Crow, not the phone.**
  - The session streams 16 kHz PCM to a phone voice-session endpoint that wraps `runVoiceTurn` (kiosk spec §7.1).
  - The phone is a new device kind, `phone`, bound to a bot exactly like a kiosk or glasses.
  - Replies come back as text, events and PCM audio. Barge-in is touch-only in v1, as on the kiosk.
- **Memory privacy** follows the kiosk rule: the memory tool category is removed unless the device's `memory_integration` is on. Since this is a personal device, the default is open question Q6.
- **Offline:** the sheet says "Can't reach your Crow" within a short timeout and offers the Quick Settings tile's existing push-to-talk retry.

**Wake word: a constraint found in research.**
- Android's privileged hotword path is closed to ordinary apps (VERIFIED, AOSP `HotwordDetectionService.java`, `VoiceInteractionService.java`, `core/res/AndroidManifest.xml`):
  - `HotwordDetectionService` and `createAlwaysOnHotwordDetector` are `@SystemApi`;
  - newer overloads need `MANAGE_HOTWORD_DETECTION`, which is `internal|preinstalled`;
  - `CAPTURE_AUDIO_HOTWORD` is `signature|privileged|role`.
- A third-party Crow app on official GrapheneOS therefore **cannot use the low-power, sandboxed hotword path**.
- The only option is an app-run detector, for example openWakeWord as in the kiosk spec, inside a **microphone foreground service**. That means:
  - a persistent notification;
  - the microphone privacy indicator lit while listening;
  - a real battery cost.
- Wake word is therefore **opt-in, off by default**, with honest battery numbers from S4. This is one of the concrete items on the P6 "needs an OS derivative" list.

**Depends on:**
- the kiosk spec's `runVoiceTurn` extraction and pairing model;
- the bound-bot device model;
- STT and TTS profiles: a fast small STT model and local TTS, per kiosk §7.3;
- the existing `GlassesService` turn plumbing in the app.

### 4.3 Data just syncs

**What the user sees.**
- Photos back up to their Crow.
- Workspace files appear in the system file picker ("Crow Workspace").
- Calendars and contacts appear in the phone's own Calendar and Contacts apps.
- Passwords fill from their vault.
- The phone backs itself up to their Crow.
- One screen in the Crow app shows each item's last successful sync.

#### 4.3.1 Photos → Immich
- **Use the official Immich Android app.** Crow does not rebuild photo backup.
- Crow hosts Immich (phone-migration spec §3.1), exposed on the tailnet only and never on Funnel.
- Crow's job:
  - mint a per-device Immich API key or login during pairing;
  - hand the server URL to the Immich app;
  - show Immich's backup status in the sync screen (the migration checklist already checks `/api/sessions`).
- UNVERIFIED: whether the Immich app accepts a server URL and credentials by deep link or QR, or only typed in (S11).

#### 4.3.2 Files → Workspace via a DocumentsProvider
- The Crow app ships a **`DocumentsProvider`** that browses the user's Workspace (Nextcloud WebDAV) under the name "Crow Workspace", so any app's file picker can open and save there.
- Prior art: the official Nextcloud Android app already registers a DocumentsProvider (`DocumentsStorageProvider`, VERIFIED, https://github.com/nextcloud/android).
- The alternative is "install the Nextcloud app" (open question Q3). Crow's own provider has two advantages:
  - one pairing instead of a second login;
  - it can use the per-device app password Crow minted.
- Writes into documents someone has open must respect the W2 write protocol's lock check. The provider writes plain WebDAV, so S5 checks how Nextcloud's lock surfaces there.

#### 4.3.3 Calendar and contacts → native sync adapters
- The Crow app registers an **account type with sync adapters** for the Calendar and Contacts providers, backed by Workspace CalDAV/CardDAV. The phone's own Calendar and Contacts apps then just show the data.
- **Prior art and licence.** DAVx⁵ is the mature open-source CalDAV/CardDAV sync app and contains such adapters (VERIFIED, https://www.davx5.com, https://github.com/bitfireAT/davx5-ose). It is **GPL-3.0**, while Crow is MIT.
  - Crow cannot copy DAVx⁵ code into the app without changing the app's licence.
  - The choice is: write a minimal adapter, or guide the user to install DAVx⁵ from its official source and hand it the account details. This is Q3.
- Sync adapters and accounts are standard Android (`AbstractThreadedSyncAdapter`, `AccountManager`). This spec found no GrapheneOS-specific restriction (UNVERIFIED, S5).
- **Order matters (§4.1.2).** An account added before Crow becomes device owner blocks adb device-owner provisioning. The wizard therefore creates the Crow sync account **after** provisioning.

#### 4.3.4 Passwords → autofill
- **Goal:** passwords fill from the user's own vault.
- **What exists on the Crow side:**
  - the Crow keychain stores extension passwords locally;
  - the user's general vault is **Vaultwarden** (Bitwarden-compatible). The keychain can save into it.
- **Two designs (Q2):**
  - **(a) Crow `AutofillService` reading the user's Vaultwarden vault.**
    - One app, one pairing.
    - But it means implementing a Bitwarden-compatible client: vault crypto, sync and TOTP. That is a large, security-critical surface.
  - **(b) Guide the official Bitwarden app** (it supports self-hosted servers) pointed at the user's Vaultwarden.
    - Crow pre-fills the server URL and checks it is HTTPS on the tailnet. Keychain follow-up 1 already notes that Vaultwarden needs an HTTPS tailnet URL for phones.
    - The Crow app's own autofill would be limited to Crow-held credentials, or skipped.
- **Either way, the user confirms the autofill service once** (§4.1.2).
- The exploration leans toward (b) for v1, because security-critical crypto should not be reimplemented without a strong reason. The operator decides.

#### 4.3.5 Device backup → the user's Crow
- **GrapheneOS ships Seedvault** as its OS backup service, which "must be explicitly enabled" (VERIFIED, https://grapheneos.org/faq).
- **Backends** (VERIFIED, https://github.com/seedvault-app/seedvault): the system file picker (SAF: USB or any DocumentsProvider) and a built-in WebDAV backend. There is no S3 backend.
- **The plan:** Seedvault's built-in WebDAV points at the user's Workspace (`/remote.php/dav/files/<login>/Seedvault/`), using a Workspace app password. This is the same how-to as the phone-migration spec §3.4.
  - Crow cannot configure Seedvault programmatically, so the setup is a guided step.
  - The user keeps Seedvault's 12-word recovery code offline.
- **Risk.** GrapheneOS says: "We plan on replacing it with a new implementation since the project has been taken over by another group of people not sharing our goals." (VERIFIED, https://grapheneos.org/features)
  - Crow Phone's backup step must be written against "the OS backup service" and re-checked when GrapheneOS ships its replacement.
  - Crow's own DocumentsProvider (§4.3.2) could also serve as a SAF target, which gives a second path that does not depend on WebDAV support.
- **Out of scope:** Crow's own backups of the server side. Immich originals are explicitly not backed up by Crow (phone-migration spec).

### 4.4 Crow home screen (launcher)

**What the user sees.** The phone's home screen is Crow:
- **The bird** (Ramble), alive in the corner, with today's state.
- **Today:** the next calendar items, reminders and the day's notes.
- **Notifications** from the user's Crow, through the existing ntfy push.
- **Quick actions:** ask Crow, new note, scan, call a contact, and toggles.
- **The user's apps.** It is a normal app grid and dock, so the phone stays a phone.

**One concept with the dashboard launcher.** The queued dashboard-launcher arc wants Crow's Nest to behave like a phone home screen:
- arrange, hide and group items;
- add *bookmark tiles* (URL tiles that open inside Crow).

Crow Phone and that arc share **one launcher model**, stored on the user's Crow:

| Item kind | Dashboard renders | Phone renders |
|---|---|---|
| `panel` (a Crow's Nest panel) | Opens the panel | Opens the panel in the app's WebView |
| `bookmark` (URL tile) | Opens inside Crow | Opens inside the Crow app (same-origin rules from `CrowWebViewClient`) |
| `widget` (bird, Today, notifications) | Card on the home grid | Native or WebView card on the home screen |
| `app` (an Android package) | Hidden on the dashboard | App icon |
| `group` (folder) | Nav group | Folder |

- **Layouts are per surface.** A dashboard layout and a phone layout share items but not positions.
- **The phone caches its layout and widget data locally**, so the home screen renders, and apps launch, with the Crow offline (trust rule 3).
- **Becoming the home app:**
  - one `ROLE_HOME` confirmation; or
  - silent `addPersistentPreferredActivity` if Crow is device owner.
- **The way out:** the stock GrapheneOS launcher is always one Settings change away, and the app says so.
- **Depends on:**
  - `nav-registry.js`, which becomes the dashboard renderer of the shared model;
  - ntfy push;
  - the Ramble bird state;
  - Workspace calendar (Today).

## 5. Connectivity

**Default: Tailscale, guided.**
- The phone reaches the user's Crow over the tailnet with the **official Tailscale Android app**, installed from its official source.
- The wizard checks it is installed and signed in, and that the Crow host is reachable over Tailscale Serve HTTPS. Crow already uses Serve for every private service, never Funnel.
- **With device owner:**
  - Crow sets Tailscale as the **always-on VPN** (`setAlwaysOnVpnPackage`).
  - Crow can push Tailscale's managed configuration. VERIFIED, https://tailscale.com/kb/1315/mdm-keys: Tailscale 1.66+ "reads and applies system policies stored in the Android RestrictionsManager".
    - Useful keys: `Hostname`, `ManagedByOrganizationName`, `LoginURL`, visibility keys such as `ExitNodesPicker`.
    - `AuthKey` exists, but Tailscale warns that "Storing authentication keys within an MDM solution poses a significant security risk", so Crow does not push one. The user signs in once.
- **Lockdown is a choice, off by default.** With lockdown on, apps cannot reach the internet when the tailnet is down, which conflicts with trust rule 3.

**Advanced: self-hosted Headscale (P5).**
- The official Tailscale Android app supports a custom control server: Settings › Accounts › ⋮ › "Use an alternate server" (VERIFIED, https://headscale.net/stable/usage/connect/android/).
- The MDM key `LoginURL` exists "if you're deploying your own server, such as Headscale" (VERIFIED, mdm-keys page).
- No new client app is needed.
- **Open risk.** Crow's private services are exposed with Tailscale Serve on HTTPS, using certificates issued through Tailscale's coordination service.
  - Whether Serve HTTPS and its certificates work under Headscale is UNVERIFIED and may not. S7 checks it.
  - If they don't, the Headscale option needs another TLS story, such as a private CA trusted on the phone or Let's Encrypt with DNS-01, before it can ship.

## 6. Pairing

**QR first, code fallback, one device model.**

1. **QR (primary, P2).** Dashboard: **Phones → Add a phone** shows a QR code that expires after 10 minutes. It encodes:
   - the instance's tailnet HTTPS URL;
   - a `pair_id`;
   - a one-time secret;
   - the instance's identity fingerprint, so the app can tell it is talking to the right Crow.

   The app scans it and claims the pairing. The dashboard shows the phone's model and tailnet address and asks the user to confirm. Approval mints a device token with `device_kind: "phone"`, bound to a bot.
2. **Code (fallback).** The kiosk flow unchanged: the app shows a 6-digit code and the user types it into the dashboard. Same rate limits and pending caps as kiosk spec §4.4.
3. **Wizard (P4).** After flashing, the phone is still on USB, so the wizard pairs it directly. It hands the claim to the app over adb (an intent extra or a file in the app's private storage), with no QR at all. UNVERIFIED mechanics, S1.

**Shared with the kiosk spec:**
- pairing endpoints;
- tailnet-only exposure (`isAllowedNetwork`);
- one-time token pickup;
- unpair closes sessions.

**What pairing grants.** One device token serves the voice session, the launcher model, the app feed and the sync screen. Workspace and Immich get **separate per-device credentials**, minted at pairing and revocable from the Phones panel.

## 7. App distribution and updates

**Crow's own app.** It comes from the user's Crow through the signed feed in the phone-migration spec §3.3:
- the gateway serves `latest.json` and APKs behind auth;
- the publish script refuses an APK unless its one signer equals the pinned release certificate;
- the app checks sha256 and that the signer equals its own signer before installing.

**Prompt-free updates.**
- `PackageInstaller.SessionParams.setRequireUserAction(USER_ACTION_NOT_REQUIRED)` skips the confirmation when **all** of these hold (VERIFIED, https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams):
  - the installer holds `REQUEST_INSTALL_PACKAGES`;
  - the installer is updating itself or is the installer of record;
  - the new APK targets a recent enough API: 34 on Android 16, 35 on the release after.
- The app is at `targetSdk 34` today, so Crow Phone needs a target-SDK bump policy.
- Apps "should always be prepared to handle STATUS_PENDING_USER_ACTION".
- As device owner, installs are silent regardless.

**Why not an F-Droid repo.**
- An F-Droid repo is a signed `entry.jar` pointing at `index-v2.json` (VERIFIED by fetching f-droid.org's), built with `fdroidserver`, which keeps its own signing keystore (VERIFIED, https://f-droid.org/docs/Setup_an_F-Droid_App_Repo/). The user would also need an F-Droid client.
- For one app, the simple signed feed is enough.
- An F-Droid-format repo stays possible later if Crow ever serves several first-party apps.
- Obtainium (watching Crow's public releases) remains the documented alternative for users who prefer it (VERIFIED, https://github.com/ImranR98/Obtainium).

**Third-party apps** (Tailscale, Immich, Bitwarden, optionally DAVx⁵, Nextcloud) come from their official sources: GrapheneOS's App Store where it carries them, F-Droid, or Google Play under sandboxed Play. **Crow never hosts their APKs.** Q4 is the open question of whether a device-owner Crow may *fetch from the official source and install silently*, with each upstream signer pinned.

**The OS itself** updates through GrapheneOS's own updater and server. Crow does not touch it (§10).

## 8. Trust and security model

### 8.1 What Crow can and cannot do to the phone

| Crow can | Crow cannot |
|---|---|
| Flash an official, signature-verified GrapheneOS image the user asked for | Modify, re-sign or host the OS |
| Hold the roles the user granted (assistant, home, autofill, files, sync) | Grant itself the assistant or autofill role (no public API; user confirms) |
| As device owner (optional): install and update its own app, pin the launcher, set always-on VPN, configure Tailscale | Read other apps' data; bypass GrapheneOS's sandbox or exploit protections |
| Revoke a phone's tokens from the dashboard | Wipe the phone remotely (not built, not planned for v1) |

### 8.2 Threats and mitigations

- **A tampered image.** Verified with `ssh-keygen -Y verify` against a key **pinned in Crow's source**, and cross-checked against the downloaded `allowed_signers`; it fails closed. Afterwards the user compares the verified-boot key hash, and the Auditor app is offered.
- **A stolen pairing QR.** It is short-lived and one-time, works on the tailnet only, and the user must confirm the phone's model and address on the dashboard.
- **A compromised Crow server.** Worst case, it pushes a malicious Crow app update.
  - Mitigation: the app accepts only updates signed by its **own** signer, and the release key does not live on the Crow server; only signed APKs do. So a compromised server can withhold updates but not forge them.
  - This holds only while the signing key stays off the server. That is a publishing rule for the Crow project.
- **A lost phone.** Revoke it in the Phones panel. The device token, Workspace app password and Immich key die together.
- **Background microphone (wake word).** Opt-in, with the OS privacy indicator lit, a persistent notification, and one switch to turn it off.
- **USB debugging left on.** The wizard's last step tells the user to turn it off and the checklist checks it. Whether the app can read that setting is UNVERIFIED (S1).

### 8.3 Device-owner mode and "visible and removable"

A device owner is powerful and sticky:
- Android shows the device as managed.
- The user cannot remove a device-owner app the normal way. An app that is device owner can release itself (`clearDeviceOwnerApp`), but if it breaks the usual recovery is a factory reset (UNVERIFIED for GrapheneOS, S1).

To meet trust rule 2, if Crow uses device-owner mode it must:
- list every policy it set, with the reason;
- offer **"Release this phone"**, which undoes the policies and drops device-owner status (the reverse of provisioning);
- never set policies that lock the user out of Settings, factory reset, or the OS updater.

Whether the default is "managed" or "unmanaged with more taps" is **Q1**.

## 9. Device support

- **The full Crow Phone setup supports exactly the devices official GrapheneOS supports.** As of 2026-10-04 (VERIFIED, https://grapheneos.org/faq):

  | Generation | Models |
  |---|---|
  | Pixel 10 | 10a, 10, 10 Pro, 10 Pro XL, 10 Pro Fold |
  | Pixel 9 | 9a, 9, 9 Pro, 9 Pro XL, 9 Pro Fold |
  | Pixel 8 | 8a, 8, 8 Pro |
  | Other | Fold, Tablet |
  | Pixel 7 | 7a, 7, 7 Pro |
  | Pixel 6 | 6a, 6, 6 Pro |

- **Support windows.**
  - 8th-generation and later Pixels have a 7-year minimum support guarantee from launch.
  - Minimum end dates range from **October 2026 (Pixel 6 / 6 Pro)** to March 2033 (Pixel 10a).
  - GrapheneOS "may provide temporary extended support releases for harm reduction", which "cannot provide full security patches". Pixel 5a and older are end-of-life.
- **The wizard shows the support end date** and refuses, or strongly warns about, devices within 12 months of it (Q9). Recommending a Pixel 6 today would be wrong.
- **Carrier-locked SKUs** may never allow OEM unlocking. The preflight says so before the user buys or wipes anything.
- **Crow's device list comes from GrapheneOS's published metadata, not a hand-kept table**, where that is reliable (S8).
- **P1 roles on any Android.** The app's `minSdk 34` means Android 14+. The roles in §4.2–§4.4 should work on stock Android too, which makes P1 useful to every Crow user and lets the roles ship before the wizard.

## 10. Why not a fork (yet)

A Crow-branded GrapheneOS derivative could do things the official OS plus an app cannot. It would also take on costs that the official route gets for free:

1. **Security-patch cadence, per device.**
   - GrapheneOS releases ship through Alpha → Beta → Stable (VERIFIED, https://grapheneos.org/releases).
   - A derivative must rebase, build and ship **every** release for **every** supported device, promptly, for each device's whole support life (up to 7 years for Pixel 8+).
   - Falling behind leaves users on a less patched OS than the one they replaced.
2. **Signing keys and verified-boot key custody.**
   - A derivative needs its own release keys **per device** (VERIFIED, https://grapheneos.org/build: keys are generated under `keys/DEVICE`, factory images signed with an ed25519 OpenSSH key).
   - Its own verified-boot key means the boot screen shows *its* key hash. (Official GrapheneOS on Pixels also boots with the yellow "custom OS" notice. The difference is whose key hash users and apps can recognise.)
   - Losing or leaking those keys is catastrophic and permanent for every installed phone.
3. **Attestation and app compatibility.**
   - GrapheneOS asks app developers to permit "our official release signing keys" through hardware attestation (VERIFIED, https://grapheneos.org/articles/attestation-compatibility-guide).
   - The Auditor app requires that "Alternative operating systems need their verified boot key included in the Auditor app and Attestation Server" (VERIFIED, https://attestation.app/about).
   - A derivative's key is on none of those allowlists, so apps that support GrapheneOS through attestation, including banking apps, would likely **not** support the derivative. That is inferred, UNVERIFIED for specific apps.
   - GrapheneOS already fails Play Integrity's "certified" level (VERIFIED, https://grapheneos.org/usage#banking-apps), so a derivative starts worse off.
4. **Build and update infrastructure.**
   - Multi-hundred-gigabyte build trees, a per-device build farm, and an update server.
   - GrapheneOS's Updater only points at its official server in official builds. Using it with other keys "will essentially perform a denial of service attack on our update service" (VERIFIED, https://grapheneos.org/build).
   - So a derivative must run its own update server and change the client.
5. **Trademark and branding.**
   - The GrapheneOS name and logo are registered US trademarks (VERIFIED, https://grapheneos.org/faq).
   - Derivatives "should replace the GrapheneOS branding with their own. It needs to be clear to users that it's a distinct OS based on GrapheneOS. Forks of GrapheneOS are not GrapheneOS itself and should not be presented that way" (VERIFIED, same page).
   - A derivative could not be called GrapheneOS or ride on its reputation, and its security claims would be Crow's to prove.

**What the official route cannot do, collected from this exploration** (the P6 list):

| Gap | Why it needs the OS | Alternative short of forking |
|---|---|---|
| Low-power, sandboxed wake word | `HotwordDetectionService` / `MANAGE_HOTWORD_DETECTION` are system/preinstalled-only (§4.2) | App-run detector in a microphone foreground service (battery cost) |
| Crow as assistant with no Settings trip | `ROLE_ASSISTANT` is not requestable; no device-owner API found | One guided Settings tap |
| QR managed provisioning at first boot | Not in stock SetupWizard2 | Contribute to or follow upstream PR #40; adb provisioning meanwhile |
| Preconfigured backup target | Seedvault has no external configuration API | Guided step; re-check after GrapheneOS's planned replacement |
| Crow app preinstalled and updated with the OS | Needs to be in the image | Signed app feed; device owner for silent updates |

**Criteria to revisit (P6).** Reopen the fork question only if **all** hold:
- (a) a gap on the list above blocks a capability users actually ask for;
- (b) no upstream contribution to GrapheneOS can close it within a reasonable time;
- (c) the project can commit people and infrastructure to same-week security releases for every supported device for each device's support life;
- (d) there is a key-custody plan with an independent review;
- (e) there is a concrete plan for attestation compatibility, or an accepted loss of it.

Until then, the preferred route is **upstream contributions**, such as provisioning and assistant-setup hooks, over a fork.

## 11. Phasing

| Phase | Ships | Depends on | Done when |
|---|---|---|---|
| **P1: app roles on any Android** | `VoiceInteractionService` assistant (server voice loop, long-press power, lock-screen policy); opt-in wake word FGS; `DocumentsProvider` for Workspace; CalDAV/CardDAV sync (own adapter or guided DAVx⁵, per Q3); autofill per Q2; sync-status screen; guided Seedvault step | Kiosk `runVoiceTurn` + device model (`phone` kind); Workspace; Immich hosting | On a stock-Android phone and on a GrapheneOS phone: assistant answers via long-press; files open from the picker; a calendar event made by a Crow bot shows in the phone's Calendar app |
| **P2: QR pairing + app feed** | Phones panel (add, list, revoke); QR pairing + 6-digit fallback; per-device Workspace/Immich credentials; signed app feed + in-app updater (phone-migration §3.3); target-SDK policy | P1; phone-migration feed | A new phone pairs by QR in under a minute; an app update installs from the user's Crow; revoke kills all of the phone's credentials |
| **P3: launcher** | Shared launcher model (server-side), dashboard renderer (customizable launcher arc), phone home screen with bird, Today, notifications and quick actions; offline cache | P2; dashboard-launcher arc designed **with** this phase | The same bookmark tile appears on the dashboard and the phone; home screen renders with the Crow unplugged |
| **P4: "Set up a phone" wizard** | Detect over USB, preflight, platform-tools fetch, download + pinned-key verify, flash, relock, boot-key check, provisioning (adb device owner if Q1 says so), pairing over USB, post-setup checklist; web-installer fallback | P1–P3; spikes S1, S2, S8 | A user with no Android experience goes from a supported Pixel on stock Android to a provisioned Crow Phone in one sitting, following only the wizard |
| **P5: Headscale option** | Advanced connectivity setting; Tailscale managed config `LoginURL`; TLS solution for private services under Headscale | S7 | A phone on a Headscale tailnet reaches every Crow service over valid HTTPS |
| **P6: revisit a true derivative** | A decision document using §10's gap list and criteria | Field experience from P1–P5 | Decision recorded: stay official, contribute upstream, or fork with the criteria met |

## 12. Spikes

Each spike is a small, throwaway experiment. "Gates" names the phase or decision that waits on it.

| # | Question | Cheapest probe | Gates |
|---|---|---|---|
| **S1** | How much provisioning can be automated on stock GrapheneOS? | On a spare supported Pixel with fresh GrapheneOS: finish setup with no accounts, enable USB debugging, then `adb shell dpm set-device-owner` with a minimal test DPC. Then: silent `PackageInstaller` install of a self-signed APK; `addPersistentPreferredActivity` HOME; `setAlwaysOnVpnPackage(tailscale)`; `setApplicationRestrictions` on Tailscale; `clearDeviceOwnerApp` release; whether the "managed device" notices are acceptable; handing a pairing claim to the app over adb; can the app read the USB-debugging state | Q1; P4 |
| **S2** | Which roles need user taps, and how many? | Same phone, also a stock-Android phone: `createRequestRoleIntent` for HOME and ASSISTANT; `ACTION_REQUEST_SET_AUTOFILL_SERVICE`; find the deep link that lands on the "Digital assistant app" screen; count taps | P1; P4 checklist design |
| **S3** | Is the assistant role feasible, and how fast is it? | Minimal `VoiceInteractionService` + session that streams to a stub `runVoiceTurn` endpoint over the tailnet. Measure long-press → listening and end-of-speech → first audio; check GrapheneOS's long-press-power default and the lock-screen behaviour (`supportsLaunchVoiceAssistFromKeyguard`) | P1 |
| **S4** | Can on-device wake word work, at what cost? | openWakeWord (kiosk model) in a microphone foreground service: 8 h idle battery drain, false wakes over 2 h of TV/radio, true wakes at arm's length; whether it can start after boot under Android 14+ foreground-service rules | Wake-word default; P1 |
| **S5** | DocumentsProvider and sync adapters against Nextcloud | Minimal provider over Workspace WebDAV (browse, open, save, a large file, a locked document); minimal CalDAV + CardDAV adapter (two-way event, contact photo, deletion); compare with DAVx⁵ + the Nextcloud app on effort and quality; licence check | Q3; P1 |
| **S6** | Is the device-backup target dependable? | Seedvault built-in WebDAV → Workspace: full backup, wipe, restore on the same model; time and size; what is skipped; track GrapheneOS's announced replacement | P1 backup step |
| **S7** | Does Headscale work with the stock Tailscale client and Crow's HTTPS? | Scratch Headscale + official Tailscale app via "alternate server" and via `LoginURL` managed config; then test whether Tailscale Serve HTTPS certificates work under Headscale | P5 |
| **S8** | Can the flash be driven reliably from the Crow host? | On a Crow OS machine: Google platform-tools ≥ 35.0.1, `fastboot getvar` for product and unlock ability, the channel-metadata lookup for the current stable image, pinned-key verify, `flash-all.sh` unattended, relock; the udev/fwupd root steps under a deadman; the web-installer fallback | P4 |
| **S9** | Prompt-free self-update on GrapheneOS | Two app builds at the target SDK the current GrapheneOS release needs; update with `USER_ACTION_NOT_REQUIRED`, without device owner | P2 |
| **S10** | May a device-owner Crow fetch third-party apps from official sources? | Fetch the Tailscale APK from an official source, verify against a pinned upstream signer, silent install; check each upstream's terms | Q4 |
| **S11** | Can the Immich app be signed in without typing? | Look for a deep link, QR or intent login in the official Immich app; otherwise measure the manual flow | P1 photos step |
| **S12** | Does the Meta glasses integration run on GrapheneOS? | The current app plus the Meta companion app under sandboxed Google Play | Q7 |

## 13. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A wrong step during unlock or flash wipes the user's data | Data loss, angry users | Backup-first preflight that can't be skipped; the checklist's "before" gates (phone-migration spec); clear wording that unlock and relock wipe |
| GrapheneOS changes install tooling, file names or keys | Wizard breaks or refuses | Pinned key fails closed with a clear message; web-installer fallback; S8 automated smoke on each Crow release |
| No QR provisioning upstream; adb path is fiddly | More taps in P4 | Guided steps; follow upstream PR #40 |
| Seedvault replaced by GrapheneOS | Backup step changes | Write the step against "the OS backup service"; re-check on each GrapheneOS feature release |
| Wake word drains battery or triggers falsely | Users turn it off or blame Crow | Off by default; honest numbers from S4 |
| Headscale lacks Serve HTTPS | P5 blocked | S7 first; alternative TLS designs |
| Device-owner mode feels like corporate MDM | Trust damage | Optional, visible, releasable (§8.3); Q1 |
| Pixel 6 / 6 Pro reach end of support this month | Users flash a soon-unsupported phone | Show end dates; warn or refuse near-EOL devices (Q9) |
| The app's one proprietary dependency (Meta SDK) | Phone build carries a closed SDK | Optional build flavour without it (Q7) |
| A compromised Crow server | Could withhold updates | Signer-pinned updates; release key never on the server |

## 14. Open questions for the operator

- **Q1.** **Device owner:** offer a "managed" mode? It gives silent Crow-app updates, the launcher pin, always-on Tailscale and preconfigured Tailscale, at the cost of the "managed device" label and a heavier release path. Default managed or unmanaged? Recommendation: offer it, default **unmanaged**, decide after S1.
- **Q2.** **Autofill:** (a) a Crow AutofillService over Vaultwarden (a large, security-critical build), or (b) the official Bitwarden app pointed at the user's Vaultwarden, guided by Crow? Recommendation: (b) for v1.
- **Q3.** **Files, calendar and contacts:** Crow's own DocumentsProvider and sync adapters (MIT, one pairing, more work), or guided DAVx⁵ + the Nextcloud app (mature, GPL, separate logins)? Or Crow's provider for files plus guided DAVx⁵ for calendar and contacts?
- **Q4.** **Third-party apps:** the user installs them from official stores (Crow guides), or a device-owner Crow fetches them from the official source and installs silently with pinned signers?
- **Q5.** **Headless Crow hosts:** must the phone plug into the Crow OS machine, or is "flash from a laptop with the official web installer, then pair" a first-class path?
- **Q6.** **Memory on the phone assistant:** a phone is personal, unlike a shared kiosk. Should `memory_integration` default to on for `phone` devices?
- **Q7.** **Proprietary SDK:** ship a phone build flavour without the Meta Wearables SDK, or keep one app?
- **Q8.** **Naming:** "Crow Phone" collides with the existing **Phone** panel (assistant calls). Rename one of them? Possible names: "Phones" panel for devices and "Calls" for assistant calls.
- **Q9.** **Near-end-of-support devices:** refuse, or warn, within 12 months of GrapheneOS's minimum support end date?
- **Q10.** **Sandboxed Google Play:** should the wizard offer to install it during setup (some users need it for banking or RCS), or leave it entirely to the user?

## 15. Sources

All checked 2026-10-04.

**GrapheneOS**
- https://grapheneos.org/install/cli: fastboot ≥ 35.0.1, OEM unlocking, `ssh-keygen -Y verify`, `allowed_signers`, flash-all, relock, boot-key hash.
- https://grapheneos.org/install/web: WebUSB installer recommended for most users; the OEM-unlocking toggle on the final setup screen.
- https://grapheneos.org/releases: Alpha → Beta → Stable channels.
- https://grapheneos.org/build: static update server, channel metadata files, per-device keys, the official update-server warning.
- https://grapheneos.org/faq: supported devices, support policy, trademarks, the derivatives statement, Seedvault.
- https://grapheneos.org/features: Seedvault replacement plan; OEM-unlocking toggle.
- https://grapheneos.org/usage: sandboxed Google Play; banking apps.
- https://grapheneos.org/articles/attestation-compatibility-guide: apps permit the official release signing keys.
- https://attestation.app/about: Auditor TOFU; alternative OSes need their key included.
- https://github.com/GrapheneOS/platform_packages_apps_SetupWizard2/pull/40: QR provisioning PR, open.
- https://github.com/themark-net/grapheneos-mdm: secondary; UNVERIFIED.

**Android**
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java: adb device-owner constraints.
- https://developer.android.com/work/dpc/dedicated-devices/cookbook: "No accounts on the device"; silent installs.
- https://developer.android.com/reference/android/app/admin/DevicePolicyManager: always-on VPN, persistent preferred activity, permission grants, QR provisioning extras.
- https://developer.android.com/reference/android/app/role/RoleManager and https://android.googlesource.com/platform/packages/modules/Permission/+/refs/heads/main/PermissionController/res/xml/roles.xml: ASSISTANT not requestable.
- https://developer.android.com/reference/android/provider/Settings: `ACTION_REQUEST_SET_AUTOFILL_SERVICE`.
- https://developer.android.com/reference/android/service/voice/VoiceInteractionService, plus AOSP `HotwordDetectionService.java`, `core/res/AndroidManifest.xml`, `core/res/res/values/attrs.xml`, `core/res/res/values/config.xml`.
- https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams: prompt-free update conditions.

**Apps and services**
- https://github.com/seedvault-app/seedvault: SAF and WebDAV backends.
- https://github.com/nextcloud/android: DocumentsProvider.
- https://www.davx5.com and https://github.com/bitfireAT/davx5-ose: GPL-3.0 CalDAV/CardDAV.
- https://headscale.net/stable/usage/connect/android/: alternate server in the official app.
- https://tailscale.com/kb/1315/mdm-keys: Android RestrictionsManager policies, `LoginURL`, `AuthKey` warning.
- https://f-droid.org/docs/Setup_an_F-Droid_App_Repo/: fdroidserver repo and keys.
- https://github.com/ImranR98/Obtainium: Obtainium.
