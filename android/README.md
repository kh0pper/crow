# Crow's Nest - Android App

A thin WebView shell that wraps the Crow's Nest dashboard for mobile access.

## Features

- WebView shell loading the Crow gateway dashboard
- Pull-to-refresh
- File upload support
- Self-signed certificate handling (home lab friendly)
- Tailscale integration (status check, install/open)
- External links open in system browser
- Dark theme matching Crow's Nest design

## Requirements

- Android SDK 34 (compile) / SDK 24+ (min, Android 7.0)
- Java 17
- Gradle 8.2+

## Build

```bash
cd android
./gradlew assembleDebug
```

APK location: `app/build/outputs/apk/debug/app-debug.apk`

## Release Build

```bash
# Requires a signing keystore
./gradlew assembleRelease
```

## Setup

1. Install the APK on your Android device
2. On first launch, the Settings screen opens
3. Enter your Crow gateway URL (e.g., `http://100.121.254.89:3001`)
4. Tap "Test Connection" to verify
5. If accessing remotely, install and connect Tailscale first
6. Tap "Save" to start using the app

## Architecture

The app is a minimal WebView wrapper. All functionality comes from the Crow's Nest web dashboard served by the gateway. The app provides:

- `MainActivity` — WebView host with pull-to-refresh and menu
- `CrowWebViewClient` — Same-origin routing, SSL error handling
- `CrowWebChromeClient` — File upload and JS dialog support
- `TailscaleHelper` — VPN status detection, app launching
- `SettingsActivity` — Gateway URL configuration and connection testing
