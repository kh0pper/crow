# F7 — Public docs + GitHub page realignment (v1 narrative)

**Date:** 2026-06-10
**Layer:** F7 — the final layer of the v1 refoundation arc (F1→F7). After this ships, the arc is complete.
**Status:** Design — approved in brainstorm, pending spec review.

## Goal

The repo README, the VitePress docs site, the GitHub repo metadata, and the maestro.press product page all describe Crow's ad-hoc history. Now that the architecture has settled (F1→F6c-2 shipped), realign all four public surfaces around a single **v1 narrative spine** so a first-time reader understands what Crow *is* in one coherent frame.

This is **content/marketing work, not server code.** No gateway code changes, no new gateway-served routes, no funnel-exposure changes.

## The spine (the through-line every surface is rewritten around)

> **Crow is a modular, agentic framework and MCP platform that integrates with the services and AI tools you already use.**
> You run it on hardware you own, paired with the models you choose — a local model on your own machine, a cloud assistant (Claude, ChatGPT, Gemini), or both.
>
> **Use it two ways, or both at once:**
> - **As an agentic framework** — build and run your own agents (the Bot Builder) over email, Discord, and voice, local and operator-gated.
> - **As an MCP platform** — connect it to the AI client you already pay for (Claude Code, claude.ai, Cursor, opencode…) as a native MCP server. It rides your existing subscription as a first-class connector — the supported extension point, not a third-party harness you run *instead* of your client.
>
> Each integration installs as a **bundle** — a service + its MCP tools + its skills (the formal contract landed in F4b). Install once and its capabilities reach every way you use Crow: your agents, your connected AI clients, and the dashboard (Crow's Nest).
>
> Crow also lets you **share** — memories, projects, and messages move directly between Crow users over an encrypted peer-to-peer layer, with no central server — and **spans your devices**, pulling multiple instances into one private interface.
>
> Set it up in minutes with the first-run and connect wizards. Your data stays on your hardware; only what you choose to send a cloud provider leaves.

### Load-bearing positioning points (must land prominently, not be buried)

1. **Dual nature.** Crow is *both* an agent engine *and* a native MCP connector. The MCP-connector half is the differentiator: it rides your existing AI subscription as a first-class, supported extension point — **not** a third-party harness you run instead of your client. Agent-only engines can't plug into your Claude Code/claude.ai subscription this way. **Make this point by capability — do NOT name specific competitors** (OpenClaw/Hermes) on the public marketing surfaces. The existing README Bot Builder paragraph currently *names* them; reframe that to the unnamed, capability-based contrast during the restructure.
2. **Local *or* cloud.** Crow is not a local-only privacy rig. It works with a local model, a cloud assistant, or both (BYOAI). Do not frame "your data stays yours" as requiring local-only.
3. **Modular.** Keep "modular" in the identity — the bundle system is the modularity.
4. **Sharing is a first-class pillar**, not a downstream feature: encrypted P2P sharing of memories/projects/messages between Crow users, plus multi-instance sync (F4a/F5: P2P sync, federated discovery + invocation, cross-instance SSO) spanning your devices.

The privacy / data-ownership story is reframed (local-or-cloud, system of record is yours), not dropped.

## Approach: fuller restructure

Chosen over targeted realignment. Each long-form surface (README, docs landing, maestro.press page) is **reorganized so the identity sentence is the lead and the "two ways to use Crow" frame is the organizing principle**, not merely an added block:

1. **Lead** with the identity: *modular, agentic framework and MCP platform that integrates with the services and AI tools you already use.*
2. **"Use it two ways" as the primary structural section** — (a) agentic framework / Bot Builder, (b) MCP platform / native connector that rides your existing subscription. The MCP-connector differentiator (first-class connector, not a third-party harness) lands here, prominently and unnamed.
3. **The three reach-points** (agents / connected MCP clients / dashboard) as supporting structure under that headline — how a bundle's capabilities reach you, not a named "three surfaces" abstraction.
4. **Bundles = service + tools + skills** as the unit of capability, explicitly defined (today they're described loosely as "add-ons"), tied to "integrates with the services you already use."
5. Existing feature inventory ("What Crow does" table, "Crow for your field" cuts) **repositioned as capabilities** reachable every way you use Crow — kept, not discarded.
6. **Sharing + multi-instance** as a first-class pillar section (encrypted P2P sharing; multi-device sync).
7. **Privacy/data-ownership** reframed as local-*or*-cloud (BYOAI), system-of-record-is-yours — not local-only.
8. **Onboarding/Quick Start** updated to foreground the first-run wizard (F6b: Welcome → Integrations → Bot → Connect → Done) and the connect wizard (F6c-1).
9. Developer Program retained.

Voice: match each surface's existing register. README/docs are prose — em dashes are fine (the crow.md "no em dash / no not-X-but-Y" rules are **exempt** for developer/marketing docs). Keep claims to capabilities Crow ships today (the existing copy is careful about this — preserve that discipline; e.g. "live one-way subscription is a planned follow-on").

## Per-surface scope

### Surface 1 — Repo README (`README.md`, EN)
Restructure around the spine. Concretely:
- Rewrite the opener to the identity sentence + add a short **"Use it two ways"** narrative (agentic framework / MCP connector) with the differentiator line landing prominently.
- Reorganize the body so **"use it two ways"** is the lead frame and the three reach-points (agents / connected MCP clients / dashboard) are supporting structure; fold the existing *Bot Builder*, *Works With*, *Crow's Nest*, *AI Chat Gateway* sections under it.
- **Reframe the existing named OpenClaw/Hermes contrast** in the Bot Builder paragraph to the unnamed, capability-based version (per load-bearing point 1).
- Add an explicit **bundle = service + MCP tools + skills** definition where add-ons/Crow OS are described.
- Update **Quick Start** to mention the first-run wizard + connect wizard.
- Keep: the "What Crow does" capability table, "Crow for your field" cuts, P2P/sharing section (elevated), Developer Program, license. Reposition, don't delete.
- Preserve all working outbound links (maestro.press docs deep-links, MCP, CONTRIBUTING, SECURITY).
- **Deploy:** none — live on GitHub the moment it's pushed to `main`.

### Surface 2 — VitePress docs landing (`docs/index.md` EN + `docs/es/index.md` ES)
- Rewrite the **hero** (`text`/`tagline`) to the identity sentence — modular agentic framework + MCP platform that integrates with what you already use; the "first-class MCP connector, not a third-party harness" line gets a visible beat.
- Restructure the **feature cards** so the two lead cards are the dual-use frame — "Build & Run Your Own Agents" (framework) and "Connect Your AI Client over MCP" (the native-connector differentiator) — followed by "Crow's Nest" (dashboard); supporting cards = memory, projects, P2P/sharing, integrations, local-or-cloud data-ownership, deploy.
- Reuse existing brand icons in `docs/public/` (`icon-*.svg`); no new icon assets required for the cards.
- **ES parity:** apply the same hero + card restructure to `docs/es/index.md`. Scope is the **landing page only** — the partial ES mirror has no architecture/developers pages and F7 does not expand it.
- **Deploy:** GitHub Pages via `.github/workflows/deploy-docs.yml` — triggers automatically on push to `main` touching `docs/**`. No manual step, no gateway restart.

### Surface 3 — GitHub repo metadata (About + topics + social preview)
- **About / description:** set the repo description to the v1 one-liner (capability layer / three surfaces / your hardware). Via `gh repo edit kh0pper/crow --description "..."`.
- **Topics:** refresh to reflect v1 (`mcp`, `model-context-protocol`, `ai-agents`, `self-hosted`, `bot-builder`, `local-first`, `privacy`, `personal-ai`, etc.). Via `gh repo edit --add-topic`.
- **Social preview image (og:image card):** generate a 1200×630 PNG from existing brand assets (`docs/public/crow-hero.svg`, `grackle-pattern.svg`, brand colors `#1d1d1f`). Set it via the GitHub API (`PATCH`/upload — `gh api` social-preview endpoint, or document the manual upload if the API path is unavailable). The image asset is committed to the repo (e.g. `docs/public/crow-social-card.png`) so it is versioned, and also wired as `og:image` in `docs/.vitepress/config.ts` `head` so the docs site gets a social card too.
- **Deploy:** immediate (metadata is live on save; social card needs the image generated first).

### Surface 4 — maestro.press product page (separate repo)
- Repo: `~/maestro-press-landing` (gitea `ssh://git@gitea:2222/kh0pp/maestro-press-landing.git`, branch `main`). Static HTML.
- File: `software/crow-overview/index.html` (the `/software/crow-overview/` product page) — restructure its sections (`Key Features`, `Works With`, `Crow for Your Field`, `Quick Start`, `Developer Program`) around the spine, mirroring the README restructure. Update the `<meta name="description">` to the v1 one-liner.
- Also refresh the Crow blurb in `software/index.html` (the software portfolio index) for consistency.
- Keep the "Open Research Infrastructure" / Texas education-data section — it is maestro.press-specific positioning, not part of the generic spine.
- **Deploy path is UNVERIFIED** (droplet root SSH is key-locked). Plan MUST include an explicit task to *discover and verify* how the gitea repo reaches the droplet webroot (via the `maestro` / `maestro.press` shell alias — likely a pull or rsync) **before** declaring surface 4 shipped. Commit + push to gitea first; verify the live publish path second.

## What this design explicitly does NOT do (YAGNI / scope guard)

- No new gateway-served public pages → the **network-exposure invariant is untouched** (`PUBLIC_FUNNEL_PREFIXES` unchanged). Sanity-check only; no `tests/auth-network.test.js` change expected.
- No expansion of the ES mirror beyond the landing page.
- No new VitePress architecture/guide pages (those are kept current through the arc already, e.g. `docs/architecture/dashboard.md`). F7 touches only the **landing/marketing surfaces**, not the per-feature reference docs.
- No server code, no DB schema, no `.env`, no systemd changes.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| maestro.press deploy path unknown → "shipped" but not live | Explicit plan task to verify the publish path via `maestro` alias before claiming surface 4 done. |
| Restructure loses a working outbound link or a careful "ships today" qualifier | Diff-review every removed line; preserve all links + qualifiers. Quality-review pass per surface. |
| ES copy drifts from EN meaning | Restructure ES from the EN final, not independently; keep section parity. |
| Social-card API path unavailable via `gh` | Fall back to documenting the manual GitHub social-preview upload; the committed PNG + docs `og:image` still land. |
| Funnel invariant accidentally touched | None expected (no gateway change); sanity-check `funnel.js` allowlist is untouched. |

## Verification per surface

- **README / docs:** render-check (`cd docs && npm run build` succeeds; `npm run dev` spot-check the landing + ES landing). Link-check the changed sections. No broken VitePress build.
- **GitHub metadata:** `gh repo view kh0pper/crow` shows new description/topics; social card visible on the repo page after upload.
- **maestro.press:** page renders locally (open the HTML); after deploy-path verification, confirm the live URL reflects the change.
- **Invariant:** confirm `git diff` touches no `servers/gateway/**` and no funnel allowlist.

## Workflow (carried from every prior layer)

spec (this doc) → writing-plans → **plan-reviewer (adversarial, verify every claim against the live tree)** → subagent-driven-development (per-task spec-review THEN quality-review; sonnet implementers/reviewers, **opus for the final holistic review**) → finishing-a-development-branch (commit per surface with explicit path args, `git pull --rebase` before push, no Claude co-author trailer; maestro.press is a separate repo/commit/deploy).

## Pointers

- Master plan F7 row: `~/.claude/plans/when-i-click-on-woolly-elephant.md`.
- Handoff: `~/.claude/plans/2026-06-10-f7-session-handoff.md`.
- F6 wizards the onboarding beat cites: `docs/architecture/dashboard.md` "First-run onboarding (F6b)" + "Connect wizard (F6c-1)".
- F6a design system (shared component language): `docs/developers/design-system.md`.
- Full F1→F6c-2 record: memory note `crow-v1-refoundation-f3-handoff.md`.
