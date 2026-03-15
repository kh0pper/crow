---
name: tailscale
description: Private network access — reach your Crow from any device on your Tailnet without exposing it to the public internet
triggers:
  - tailscale
  - private access
  - remote access
  - VPN
  - acceso privado
  - red privada
tools:
  - crow-memory
---

# Tailscale Integration

## When to Activate

- User wants to access Crow remotely from another device
- User asks about Tailscale, VPN, private networking, or remote access
- User wants to reach Crow without exposing ports to the public internet
- User mentions "acceso privado" or "red privada"

## Setup Workflow

Guide the user through these steps:

### 1. Create a Tailscale Account

If the user doesn't already have one, direct them to [tailscale.com](https://tailscale.com) to create a free account. The free tier supports up to 100 devices.

### 2. Generate a Reusable Auth Key

Direct the user to https://login.tailscale.com/admin/settings/keys and walk them through:

1. Click **Generate auth key**
2. Check the **Reusable** checkbox — this is important so the container can re-authenticate after restarts without generating a new key each time
3. Optionally set an expiration (90 days is a good default)
4. Copy the key (it starts with `tskey-auth-`)

### 3. Install the Bundle

The user can install via the Extensions panel in the Crow's Nest or by asking:

> "Install the Tailscale bundle"

When prompted for environment variables:
- **TS_AUTHKEY** (required): Paste the reusable auth key from step 2
- **TS_HOSTNAME** (optional): The name this device will appear as on the Tailnet (default: `crow`)

### 4. Verify Connection

After the bundle starts, the device should appear on the user's Tailnet within a few seconds. They can verify at https://login.tailscale.com/admin/machines.

Once connected, Crow is reachable at `http://<TS_HOSTNAME>/` (default: `http://crow/`) from any device on the same Tailnet.

## Important Notes

### Uninstall Warning

Removing the Tailscale bundle deletes the `tailscale-state` Docker volume. This means the device disappears from the Tailnet entirely. Reinstalling the bundle will create a new device entry on the Tailnet (with a new Tailscale IP). If the user has firewall rules or DNS records pointing to the old Tailscale IP, those will need updating.

### Managed Hosting

This bundle is **not available on managed hosting** instances. The container uses `network_mode: host`, which gives it access to all host ports — this is unsafe on shared infrastructure. Managed hosting users should use the Cloudflare Tunnel integration instead.

### After Install

- The device appears on the Tailnet as the configured `TS_HOSTNAME` (default: `crow`)
- Access Crow at `http://<TS_HOSTNAME>/` from any device on the Tailnet
- Tailscale handles NAT traversal automatically — no port forwarding needed
- The connection persists across container restarts thanks to the persistent state volume

## Error Handling

- If the container exits immediately: "Check that your TS_AUTHKEY is valid and hasn't expired. Generate a new one at https://login.tailscale.com/admin/settings/keys."
- If the device doesn't appear on the Tailnet: "Make sure /dev/net/tun is available on your host. On some VPS providers, TUN/TAP must be enabled in the control panel."
- If Crow is unreachable via Tailnet: "Verify the gateway is running and listening. Try `curl http://localhost:3001/health` on the host first to confirm the gateway is up."
