# Google Cloud Free Tier Guide + Multi-Instance Chaining Documentation

**Date:** 2026-03-20
**Status:** Approved

## Overview

Add a Google Cloud free tier setup guide for Crow and improve the visibility/clarity of multi-instance chaining documentation across the site.

## New Page: `docs/getting-started/google-cloud.md`

### Structure

1. **Overview** — Google Cloud's always-free e2-micro VM: 0.25 vCPU, 1GB RAM, 30GB disk. Enough for base Crow (no heavy bundles like Nominatim). US regions only (us-west1, us-central1, us-east1).

2. **Prerequisites** — Google account, billing enabled (required for free tier but won't be charged). gcloud CLI optional (Console walkthrough primary).

3. **Create VM** — Step-by-step Console walkthrough:
   - Navigate to Compute Engine → VM Instances → Create
   - Machine type: e2-micro (free tier eligible)
   - Region: us-central1 (or us-west1/us-east1)
   - Boot disk: Ubuntu 22.04 LTS, 30GB standard persistent
   - Do NOT check "Allow HTTP/HTTPS traffic" — Tailscale provides private access
   - Create and note external IP

4. **Install Crow** — SSH into VM, install Node.js 20 (recommended, minimum 18), clone repo, npm install, npm run setup, npm run init-db.

5. **Security Hardening** — Mirrors the Oracle Cloud guide's hardening section:
   - GCP VPC firewall: verify no public ingress rules on port 3001 (default rules only allow SSH/ICMP)
   - On-instance: UFW (allow SSH + Tailscale, deny all), fail2ban, disable SSH password auth, enable unattended-upgrades
   - Brief "What to do if compromised" section (stop instance, backup with `npm run backup`, recreate)

6. **Install Tailscale** — Private networking for secure cross-cloud access. Install, authenticate, note Tailscale IP.

7. **Start Gateway** — systemd service or nohup, verify health endpoint via Tailscale IP. Optional: link to Oracle guide's "Make Your Blog Public" section for public blog setup (same steps apply).

8. **Chain with Oracle Cloud** — The payoff section:
   - Export identity from existing Oracle Cloud instance
   - Import on Google Cloud instance
   - Register both instances (Oracle as home, Google Cloud as satellite)
   - Cross-register in each other's databases
   - Verify Hyperswarm discovery
   - Test federation: call tools on Oracle instance from Google Cloud
   - Explain the value: redundancy, memories synced across clouds, tools accessible from either

## Updates to Existing Pages

### `docs/getting-started/index.md`
- Add Google Cloud Free Tier entry to the deployment options list
- Add callout box: "**Multi-Instance Chaining** — Run Crow on multiple free-tier clouds and chain them together. Your memories sync automatically, and you can call tools on any instance from any other. [Learn more →](multi-device)"

### `docs/getting-started/free-hosting.md`
- Add Google Cloud row to comparison table:
  - Provider: Google Cloud
  - Always Free: Yes
  - Specs: e2-micro (0.25 vCPU, 1GB RAM, 30GB disk)
  - Limitation: US regions only
  - Recommended: Yes (as secondary/satellite)
- Update narrative to position: Oracle = primary, Google Cloud = great secondary for chaining

### `docs/getting-started/oracle-cloud.md`
- Add final callout section: "**Have another machine?** Chain your Oracle Cloud instance with a Google Cloud free tier VM, a Raspberry Pi, or any other device. [Set up multi-device chaining →](multi-device)"

### `docs/getting-started/multi-device.md`
- Keep existing provider-agnostic server-a/server-b walkthrough (useful for non-cloud setups)
- Add a concrete "Example: Oracle Cloud + Google Cloud" subsection below the generic walkthrough with specific IPs and commands
- Add troubleshooting section: Tailscale connectivity, firewall rules, Hyperswarm over Tailscale, identity mismatch errors

### `docs/guide/instances.md`
- Add "Why Chain Instances?" section that integrates with (not duplicates) the existing opening content:
  - Redundancy: if one instance goes down, the other has your data
  - Geographic distribution: low-latency access from different regions
  - Project isolation: separate instances for separate workstreams
  - Free tier stacking: combine Oracle + Google Cloud for more resources

### `docs/.vitepress/config.ts`
- Add `{ text: 'Google Cloud Free Tier', link: '/getting-started/google-cloud' }` to Getting Started sidebar, after Oracle Cloud
- Add corresponding entry in the `es` locale sidebar

### Spanish locale
- Add stub page `docs/es/getting-started/google-cloud.md` linking to English version

## Cross-Linking Strategy

- Oracle Cloud guide → "Chain it" callout at bottom
- Google Cloud guide → ends with full chaining walkthrough
- Getting Started overview → banner about multi-instance
- Free hosting comparison → links to both cloud guides
- Multi-device quickstart → concrete Oracle ↔ Google Cloud example

## Files to Create/Modify

| File | Action |
|------|--------|
| `docs/getting-started/google-cloud.md` | Create (new guide) |
| `docs/es/getting-started/google-cloud.md` | Create (locale stub) |
| `docs/getting-started/index.md` | Add Google Cloud + chaining callout |
| `docs/getting-started/free-hosting.md` | Add Google Cloud row |
| `docs/getting-started/oracle-cloud.md` | Add chaining callout |
| `docs/getting-started/multi-device.md` | Concrete Oracle↔GCloud example |
| `docs/guide/instances.md` | Add "Why Chain?" section |
| `docs/.vitepress/config.ts` | Add sidebar entry |
