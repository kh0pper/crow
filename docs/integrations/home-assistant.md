---
title: Home Assistant
---

# Home Assistant

Connect Crow to Home Assistant to control smart home devices, automations, and scenes through your AI assistant.

## What You Get

- Control lights, switches, and other devices
- Trigger automations and scenes
- Read sensor values (temperature, humidity, motion, etc.)
- View device states and attributes

## Setup

### Step 1: Find your Home Assistant URL

Your Home Assistant URL is the address you use to access it, for example:
- `http://homeassistant.local:8123` (local network)
- `http://192.168.1.100:8123` (local IP)
- `https://your-instance.duckdns.org` (remote access via DuckDNS)
- `https://your-instance.ui.nabu.casa` (Nabu Casa cloud)

### Step 2: Create a Long-Lived Access Token

1. Open your Home Assistant web interface
2. Click your profile icon in the bottom-left corner of the sidebar
3. Scroll down to the **Long-Lived Access Tokens** section
4. Click **Create Token**
5. Name it (e.g., "Crow")
6. Click **OK**
7. Copy the token — Home Assistant only shows it once

### Step 3: Add to Crow

Paste your URL and token in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

The environment variables are `HA_URL` and `HA_TOKEN`.

## Required Permissions

| Permission | Why |
|---|---|
| Long-Lived Access Token | Authenticates API requests with the permissions of your HA user account |

The token inherits all permissions of the Home Assistant user that created it. For more restrictive access, create a dedicated HA user with limited permissions and generate the token from that account.

## Troubleshooting

### "Connection refused" or timeout

Make sure the `HA_URL` is reachable from the machine running Crow. If Home Assistant is on a different network, you'll need remote access configured (DuckDNS, Nabu Casa, Tailscale, etc.).

### "401 Unauthorized"

The token may have been deleted. Create a new Long-Lived Access Token from your Home Assistant profile page.

### Devices not appearing

Home Assistant's API exposes all entities. If a device is missing, check that it's properly integrated in Home Assistant first (Settings → Devices & services).
