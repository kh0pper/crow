# F7 — Public docs + GitHub page realignment (v1 narrative)

**Date:** 2026-06-10
**Layer:** F7 — the final layer of the v1 refoundation arc (F1→F7). After this ships, the arc is complete.
**Status:** Design — approved in brainstorm, pending spec review.

## Goal

The repo README, the VitePress docs site, the GitHub repo metadata, and the maestro.press product page all describe Crow's ad-hoc history. Now that the architecture has settled (F1→F6c-2 shipped), realign all four public surfaces around a single **v1 narrative spine** so a first-time reader understands what Crow *is* in one coherent frame.

This is **content/marketing work, not server code.** No gateway code changes, no new gateway-served routes, no funnel-exposure changes.

## The spine (the through-line every surface is rewritten around)

> **Crow is one capability layer exposed through three surfaces.**
> Install a **bundle** — a self-contained unit of *a service + its MCP tools + its skills* (the formal contract landed in F4b) — once, and its capabilities become available to all three surfaces at once:
> 1. **Internal bots** (the Bot Builder) — agents you compose and run over email, Discord, and voice.
> 2. **External MCP clients** — claude.ai, Claude Code, Cursor, opencode, ChatGPT, Gemini, and any MCP-speaking tool.
> 3. **The dashboard** (Crow's Nest) — the web UI you operate it all from.
>
> You **set it up in minutes**: the first-run wizard walks you through integrations, your first bot, and connecting a client; the connect wizard hands each AI client its config. Everything runs on **hardware you own**, and the system of record never has to leave your network.

The spine sits *on top of* Crow's existing strengths (privacy / data ownership, multi-instance resource sharing, encrypted P2P) — it reframes them, it does not replace them. Multi-instance (P2P sync, federated discovery + invocation, cross-instance SSO — F4a/F5) is presented as "the capability layer spanning all your devices."

## Approach: fuller restructure

Chosen over targeted realignment. Each long-form surface (README, docs landing, maestro.press page) is **reorganized so the three-surfaces frame is the organizing principle**, not merely an added block:

1. **Lead** with the capability-layer idea (what Crow is).
2. **The three surfaces** as the primary structural section — bots / MCP clients / dashboard, each a facet of the one layer.
3. **Bundles = service + tools + skills** as the unit of capability, explicitly defined (today they're described loosely as "add-ons").
4. Existing feature inventory ("What Crow does" table, "Crow for your field" cuts) **repositioned as capabilities of the layer** surfaced *through* the three surfaces — kept, not discarded.
5. Cross-cutting pillars (privacy/data-ownership, multi-instance, encrypted P2P) as their own section.
6. **Onboarding/Quick Start** updated to foreground the first-run wizard (F6b: Welcome → Integrations → Bot → Connect → Done) and the connect wizard (F6c-1).
7. Developer Program retained.

Voice: match each surface's existing register. README/docs are prose — em dashes are fine (the crow.md "no em dash / no not-X-but-Y" rules are **exempt** for developer/marketing docs). Keep claims to capabilities Crow ships today (the existing copy is careful about this — preserve that discipline; e.g. "live one-way subscription is a planned follow-on").

## Per-surface scope

### Surface 1 — Repo README (`README.md`, EN)
Restructure around the spine. Concretely:
- Rewrite the opener + add a short **"How Crow works"** narrative establishing the capability-layer / three-surfaces / bundle frame.
- Reorganize the body so **the three surfaces** is the spine; fold the existing *Bot Builder*, *Works With*, *Crow's Nest*, *AI Chat Gateway* sections under it as the three facets.
- Add an explicit **bundle = service + MCP tools + skills** definition where add-ons/Crow OS are described.
- Update **Quick Start** to mention the first-run wizard + connect wizard.
- Keep: the "What Crow does" capability table, "Crow for your field" cuts, P2P section, Developer Program, license. Reposition, don't delete.
- Preserve all working outbound links (maestro.press docs deep-links, MCP, CONTRIBUTING, SECURITY).
- **Deploy:** none — live on GitHub the moment it's pushed to `main`.

### Surface 2 — VitePress docs landing (`docs/index.md` EN + `docs/es/index.md` ES)
- Rewrite the **hero** (`text`/`tagline`) to state the spine in one line.
- Restructure the **feature cards** so they group under the three-surfaces narrative (e.g. lead cards = "Build Your Own Agents" (bots) / "Works With Every AI Client" (MCP clients) / "Crow's Nest" (dashboard); supporting cards = memory, projects, P2P, integrations, data-ownership, deploy).
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
