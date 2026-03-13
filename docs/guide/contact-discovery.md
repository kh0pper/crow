---
title: Contact Discovery
---

# Contact Discovery

Make it easier for other Crow users to find and connect with you.

## What is this?

By default, connecting two Crow instances requires sharing an invite code out-of-band (via email, messaging, etc.). Contact discovery adds an **optional** public endpoint that lets other users look up your Crow ID and public keys if they know your gateway URL.

Think of it like a digital business card posted on your door: it shows your name and how to reach you, but nothing else.

## How to enable

Open the Crow's Nest and go to **Settings**. Under the **Contact Discovery** section:

1. Set the dropdown to **Enabled**
2. Optionally enter a **display name** (e.g., "Alice", "Kevin's Research Crow")
3. Click **Save**

Or ask your AI:

> "Crow, enable contact discovery with the display name 'Alice'"

## What gets exposed

When discovery is enabled, a public JSON endpoint is available at:

```
GET /discover/profile
```

It returns:

```json
{
  "crow_discovery": true,
  "crow_id": "crow:k3x7f9m2q4",
  "display_name": "Alice",
  "ed25519_pubkey": "a1b2c3...",
  "secp256k1_pubkey": "d4e5f6..."
}
```

### What is NOT exposed

- Private keys (never shared)
- Memories, projects, or any stored data
- Contact list or shared items
- Email, location, or personal information
- Blog posts (those have their own visibility controls)
- API keys or configuration

The public keys are cryptographic material already designed to be shared -- they're used for end-to-end encryption and identity verification.

## How others use it

1. Another Crow user (or their AI) fetches your `/discover/profile` endpoint
2. They get your Crow ID and public keys
3. They generate an invite and send it to you (the invite system still requires mutual acceptance)
4. You accept the invite, verify the safety number, and the connection is established

Discovery makes the **first step** easier but does not bypass the invite handshake. Both users must still explicitly agree to connect.

## How to disable

Go to **Settings** in the Crow's Nest, set Contact Discovery to **Disabled**, and save. The endpoint immediately returns 404.

Or ask your AI:

> "Crow, disable contact discovery"

## Privacy considerations

- Discovery is **completely opt-in** and **disabled by default**
- Only your Crow ID, display name, and public keys are shared
- There is no central directory -- someone must already know your gateway URL
- Disabling discovery takes effect immediately
- The endpoint is unauthenticated and publicly accessible (when enabled), so consider this when deciding whether to enable it
