---
title: Android App
---

# Android App

Access Crow from your Android device with the native app or as a Progressive Web App (PWA).

## Option A: Install the APK

### Step 1: Download the APK

Download the latest Crow Android app:

[Download Crow for Android](https://github.com/kh0pper/crow/releases/download/android-v1.3.0/app-release.apk)

### Step 2: Enable unknown sources

Before installing, allow your device to install apps from outside the Play Store:

1. Open **Settings** on your Android device
2. Go to **Security** (or **Privacy** on some devices)
3. Enable **Install from unknown sources** (or **Install unknown apps**)
4. If prompted for a specific app, allow your browser (Chrome, Firefox, etc.)

::: tip
On Android 8+, this setting is per-app. You only need to allow the browser you used to download the APK.
:::

### Step 3: Install

1. Open the downloaded `crow-android.apk` file
2. Tap **Install** when prompted
3. Once installed, open the Crow app

### Step 4: Connect to your gateway

1. Enter your gateway URL (e.g., `http://100.121.254.89:3001` or `https://your-server.ts.net`)
2. Tap **Test Connection** to verify
3. Log in with your Crow's Nest password

## Option B: PWA (no install)

If you prefer not to install an APK, you can add the Crow's Nest as a home screen app directly from Chrome:

1. Open Chrome on your Android device
2. Navigate to your Crow's Nest URL (e.g., `http://100.121.254.89:3001`)
3. Log in to the Crow's Nest
4. Tap the **three-dot menu** (top right)
5. Tap **Add to Home Screen**
6. Name it "Crow" and tap **Add**

The PWA runs in a standalone window without browser chrome, giving it a native app feel.

## Tailscale Setup

If your Crow gateway runs on a home server or local network, install Tailscale to access it from anywhere:

1. Install [Tailscale from the Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)
2. Open Tailscale and sign in with the same account used on your server
3. Toggle Tailscale **on**
4. Use your server's Tailscale IP as the gateway URL (e.g., `http://100.121.254.89:3001`)

::: tip
Tailscale runs in the background with minimal battery impact. Your Crow connection stays available as long as Tailscale is active.
:::

## Push Notifications

The Crow app delivers push notifications through two channels:

### Instant push via ntfy (v1.3.0+)

When the [ntfy bundle](/guide/notifications#ntfy-bundle) is installed on your Crow instance, the app maintains a persistent connection to the ntfy server and delivers notifications instantly. No separate app needed.

1. Install the ntfy bundle on your Crow instance (from Extensions or `crow bundle install ntfy`)
2. Open the Crow app and connect to your gateway
3. The app automatically detects ntfy and starts the push listener
4. A small "Crow connected" indicator appears in your notification shade

The ntfy listener runs as a background service, surviving app closure and device reboots.

### Background polling (fallback)

If ntfy is not installed, the app polls your gateway every 15 minutes for new notifications. This is slower but requires no additional setup.

### Notification setup

1. When the app first launches, it will request notification permission — tap **Allow**
2. If you dismissed the prompt, go to **Android Settings** > **Apps** > **Crow** > **Notifications** and enable them
3. Notification preferences can be configured in **Crow's Nest** > **Settings** > **Notifications**

## Features

All Crow's Nest panels are available from the Android app:

- **Calls** — Peer-to-peer voice and video calling with camera support
- **Memory** — Browse and search your stored memories
- **Messages** — AI Chat and peer messaging
- **Blog** — Read and manage posts
- **Files** — Upload, download, and manage stored files
- **Podcasts** — Subscribe to feeds and stream episodes
- **Contacts** — View and manage your contact list
- **Skills** — Browse available skills
- **Settings** — Full configuration access

### Instant Push Notifications (v1.3.0)

With the ntfy bundle installed, notifications arrive within a second. Calls, messages, reminders, and system alerts all push to your phone instantly without the 15-minute polling delay. See [Notifications & Push](/guide/notifications) for details.

### Voice and Video Calls (v1.2.0)

The Calls panel lets you start peer-to-peer voice and video calls with your contacts:

- Audio calls with echo cancellation and noise suppression
- Camera video with adaptive quality (adjusts to network conditions)
- Standalone call pages via shareable room links
- Camera permission is requested only when you first enable video

## Troubleshooting

### "Connection refused" or timeout

- Verify your gateway is running (`npm run gateway` or Docker)
- Check that your device can reach the server IP — try opening the URL in Chrome first
- If using Tailscale, make sure it's connected on both the phone and the server

### SSL certificate errors

- If your gateway uses a self-signed certificate, Chrome and the app may block the connection
- Use Tailscale Funnel for automatic HTTPS, or access via plain HTTP over Tailscale (the VPN encrypts traffic)

### App not installing

- Make sure you enabled "Install from unknown sources" for the correct app (your browser)
- Check that your Android version is 8.0 or higher
- If storage is full, free up space and retry

### PWA not working offline

The PWA requires a network connection to your gateway. It does not cache data for offline use — it connects to your Crow instance in real time.
