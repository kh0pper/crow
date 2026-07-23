# Roadmap

*Rewritten July 2026. This page describes where Crow actually is and where it is deliberately going — not an aspirational feature list.*

## What v1 means

Crow was tagged **1.0.0 in July 2026**, when all of the following became true — each proven on a wiped scratch install, not asserted:

- A newcomer on supported hardware reaches first value — a connected AI client using Crow's memory, or a working agent — within 30 minutes of starting the installer, without help from the maintainer. (The timed walkthrough: under 2 minutes of interaction after the installer, zero terminal steps.)
- CI defines what is mergeable: the full test suite runs on every pull request and every push to `main`, and a red run blocks merge for everyone, the maintainer included.
- Every capability claim in the README and docs is demonstrably true on a fresh install, or explicitly labeled as planned.
- The release is tagged 1.0.0.

Everything aspirational — FERPA-specific tooling, education verticals — remains explicitly post-v1 or parked (see below).

## Shipped in 2026

The original 2026 roadmap on this page listed four education-focused milestones. Milestone 1 (typed projects + the data-backend registry) shipped; development then deliberately pivoted to the platform itself. What actually shipped:

- **Messages & federation** — encrypted P2P messaging over Nostr, contact and group management that follows the user across instances, delete-wins tombstones, live in-feed key rotation, and a multi-instance sync mesh proven by executable multi-instance tests rather than by hand.
- **Extensions** — the add-on store with provenance badges (official vs community), themed collections with one-click install sets, community stores for third-party listings, and ~90 published add-ons.
- **Bot Builder** — a guided agent-creation wizard with templates, a readiness checklist, per-agent tool scoping and permission policies, EN/ES localization, and channels for Gmail, Discord, and voice (Meta glasses / companion).
- **Install & first-run** — a one-line installer with a platform gate and point-of-use Docker/Tailscale offers, a first-run wizard with identity backup, honest empty states, and a connect wizard for pairing AI clients.
- **Project spaces** — the shareable project redesign: membership, roles, per-member capability overrides, and an audit log.
- **Engineering floor (July 2026)** — CI on every PR and push with branch protection that binds the maintainer too, a runtime database-migration guard with automatic backup and quarantine, and fleet auto-update that refuses to pull a red or unverified `main`.

- **First value (July 2026)** — the setup wizard now carries a fresh install to a working AI: a curated **Model Catalog** with Hugging Face downloads (llama.cpp runtime, hardware-fit filtering — local-first, no cloud key required), starter memories that make the first conversation demonstrate recall, and the CLI post-install steps folded into the dashboard.
- **Bot engine as an extension (July 2026)** — agent channels (Gmail, Discord) install their engine as a one-click bundle at the point of use instead of assuming a pre-provisioned machine; honest readiness states throughout.

## Current focus: after v1

- **Cloud web-client access** — claude.ai on the web, ChatGPT, and similar clients need a publicly reachable endpoint, which a private Crow deliberately does not expose today. A hardened opt-in path is the committed next arc, gated behind a dedicated security review (consent gate first). Until it ships, cloud web clients remain unsupported on self-hosted instances.
- **Platform breadth** — the Windows path runs via WSL2 (documented; GPU currently falls back to CPU there — CUDA-in-WSL2 enablement is filed), and the macOS path predates the current wizard. Hardening both with real-hardware proof is next.

## Deliberately parked

These are conscious decisions, not TODOs:

- **Education verticals (old Milestones 2–4)** — LMS course projects, Canvas backends, curriculum and institutional tooling. Parked until validated education users exist. The data-backend registry that would power them remains in place.
- **FERPA enforcement** — Self-hosted Crow keeps data on infrastructure you control, which suits FERPA-sensitive contexts; Crow does not itself implement FERPA controls, and none are currently planned.
- **Managed hosting** — not an active offering.
- **crowdsec-firewall-bouncer bundle** — the one bundle from the 2026-04 MVP expansion that never shipped (upstream publishes no Docker image; a safe install needs the privileged-install consent gate plus a tested unwind path). Parked until that machinery has been exercised.

## Add-on registry disposition (July 2026)

The in-repo registry (`registry/add-ons.json`) is the source of truth and ships with every install. The separate remote registry repository (`crow-addons`) was only ever a listing mirror — it drifted to less than half the real catalog and is being retired. Third-party add-ons are the community-stores mechanism's job.

Remaining engineering follow-ups from the 2026-04 bundle MVP (privileged-install gate exercise, install-flow QA coverage) are tracked in the maintainer's engineering backlog, not on this page.
