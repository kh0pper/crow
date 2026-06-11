# F7 — Public docs + GitHub page realignment (v1 narrative) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realign Crow's four public surfaces (repo README, VitePress docs landing EN+ES, GitHub repo metadata, maestro.press product page) around the approved v1 narrative spine, via a fuller restructure.

**Architecture:** Content/marketing work only — no server code, no DB, no new gateway routes, funnel invariant untouched. Each long-form surface is reorganized so the identity sentence leads and the "use it two ways" frame is the organizing principle. One canonical set of copy blocks (defined once below) is reused across surfaces (DRY).

**Deploy model (VERIFIED 2026-06-10, corrects an earlier assumption):**
- **README** — truly automatic: it's a repo file, live on GitHub the instant the branch merges to `main`.
- **GitHub Pages** (`deploy-docs.yml`) fires on push, but the resulting `kh0pper.github.io/crow/` site is **base-mismatched** (VitePress `base: '/software/crow/'` makes its assets resolve at `/software/crow/…`, which 404s under `github.io/crow/`). So github.io is NOT the canonical public docs surface — do not use it for og:image or links.
- **The canonical public docs URL `https://maestro.press/software/crow/` is served by nginx on the DigitalOcean droplet** (verified: `curl -sI` → `server: nginx`, and `…/software/crow/crow-hero.svg` → 200, proving the droplet serves the built `docs/public/` tree at that path). **Pushing to `main` does NOT auto-update this URL** — the droplet re-publishes via a separate mechanism (the SAME unverified path as the maestro.press landing repo). Therefore **the public docs, the social-card PNG, and the maestro.press landing page all share ONE droplet-publish dependency**, consolidated into the final deploy task (Task 8).
- **GitHub metadata** and the **droplet publish** have tooling/access gaps flagged as ⚠ decision points (Tasks 5, 6, 8).

**Tech Stack:** Markdown (README, VitePress `docs/`), VitePress `index.md` home layout (frontmatter `hero`/`features`), static HTML (maestro.press, separate gitea repo), GitHub repo settings.

**Spec:** `docs/superpowers/specs/2026-06-10-f7-public-docs-realignment-design.md` (read it first — it carries the spine, the load-bearing positioning points, and the per-surface scope).

---

## Canonical copy blocks (define once, reuse across surfaces — DRY)

These are the load-bearing lines. The exact identity/differentiator/home-server/bundle sentences MUST be consistent across surfaces. Connective prose around them is the implementer's to draft, following each surface's section outline. **Voice:** prose/marketing — em dashes fine; competitors UNNAMED; keep "ships today" qualifiers from existing copy.

**[ID] Identity one-liner (EN):**
> Crow is a modular, agentic framework and MCP platform that integrates with the services and AI tools you already use — run on hardware you own, with local or cloud models.

**[TWO-WAYS] Use it two ways (EN):**
> **Use it two ways, or both at once.** *As an agentic framework*, build and run your own agents (the Bot Builder) over email, Discord, and voice — local and operator-gated. *As an MCP platform*, connect Crow to the AI client you already pay for (Claude Code, claude.ai, Cursor, opencode) as a native MCP server.

**[MCP-DIFF] The MCP-connector differentiator — the standout line, must land prominently (EN):**
> It rides your existing subscription as a first-class connector — the supported extension point, not a third-party harness you run instead of your client.

**[BUNDLE] Bundle definition (EN):**
> A bundle is the unit of capability: a service plus its MCP tools plus its skills. Install it once and it is available everywhere you use Crow — your agents, your connected AI clients, and the dashboard (Crow's Nest).

**[HOME] All-in-one home server (EN):**
> Crow is also an all-in-one self-hosted home server. Install apps from an app store — file sync, photos, smart home, media, local AI — the way you would on any home server. The difference: because every app installs as a bundle, what you self-host is not just an app, it is a capability your agents and AI clients can use.

**[SHARE] Sharing + multi-instance + Android (EN):**
> Share memories, projects, and messages directly with other Crow users over an encrypted peer-to-peer layer, with no central server. Crow spans your devices, pulling multiple instances into one private interface — access and control all of your connected instances from the open-source Android app, or from the dashboard in any browser.

**[PRIVACY] Local-or-cloud data ownership (EN):**
> Your data stays on infrastructure you control. Pair Crow with a local model and nothing leaves your network; connect a cloud assistant and only what you choose to send that provider goes out. Either way, the system of record is yours.

**[DEV] Developers welcome (EN):**
> Crow is open source, and developers are welcome — build integrations, skills, core tools, panels, and self-hosting bundles for the ecosystem.

**[ID-ES] Identity one-liner (ES):**
> Crow es un marco de trabajo modular y con agentes, y una plataforma MCP, que se integra con los servicios y herramientas de IA que ya usas — ejecútalo en hardware que tú controlas, con modelos locales o en la nube.

**[TWO-WAYS-ES] Use it two ways (ES):**
> **Úsalo de dos maneras, o ambas a la vez.** *Como marco de trabajo con agentes*, crea y ejecuta tus propios agentes (el Bot Builder) por correo, Discord y voz — locales y con aprobación del operador. *Como plataforma MCP*, conecta Crow al cliente de IA que ya pagas (Claude Code, claude.ai, Cursor, opencode) como servidor MCP nativo.

**[MCP-DIFF-ES] (ES):**
> Funciona dentro de tu suscripción existente como un conector de primera clase — el punto de extensión compatible, no un arnés de terceros que ejecutas en lugar de tu cliente.

**[HOME-ES] (ES):**
> Crow también es un servidor doméstico autoalojado todo en uno. Instala apps desde una tienda de apps — sincronización de archivos, fotos, hogar inteligente, multimedia, IA local — como en cualquier servidor doméstico. La diferencia: como cada app se instala como un bundle, lo que autoalojas no es solo una app, es una capacidad que tus agentes y clientes de IA pueden usar.

> **ES translation note:** The implementer for the ES task should be Spanish-fluent; treat these as canonical anchors and keep the existing `docs/es/` register (informal "tú", the voice in the current `docs/es/index.md`). Translate the remaining EN blocks ([BUNDLE], [SHARE], [PRIVACY], [DEV]) consistently when writing the ES landing.

**[GH-DESC] GitHub About/description (263 chars — VERIFIED under GitHub's 350-char limit):**
> Modular, agentic framework and MCP platform you self-host. Build and run your own AI agents, connect Claude/ChatGPT/Cursor as a native MCP connector, self-host your apps, and share over encrypted P2P — on hardware you own, with local or cloud models. Open source.

**[GH-TOPICS] GitHub topics:**
> `mcp`, `model-context-protocol`, `ai-agents`, `agent-framework`, `self-hosted`, `home-server`, `local-first`, `privacy`, `personal-ai`, `bot-builder`, `llm`, `p2p`, `nodejs`

---

## Task 0: Create the implementation branch (crow repo)

**Files:** none (git branch only).

- [ ] **Step 1: Confirm clean-ish base + sync main.** The working tree has pre-existing unrelated WIP (android `CrowWebViewClient.java`, bench `REPORT.md`, untracked bundles/scripts) — leave it alone; never `git add -A`.

Run:
```bash
cd ~/crow && git fetch origin && git log --oneline -1 origin/main && git status --short | head
```
Expected: shows current `origin/main` head; the WIP files listed are the known pre-existing ones (not ours).

- [ ] **Step 2: Create branch off latest main.**

Run:
```bash
cd ~/crow && git pull --ff-only origin main && git switch -c f7-public-docs-realignment
```
Expected: `Switched to a new branch 'f7-public-docs-realignment'`. (The spec + this plan already live on `main`; they'll be present on the branch too.)

---

## Task 1: README restructure (Surface 1, EN)

**Files:**
- Modify: `README.md` (repo root)

Restructure around the spine. Target section order (reorganize existing content; do not delete the capability table or field cuts):

1. **Opener** — replace the current single paragraph (`README.md:3`) with [ID] + 2-3 sentences expanding it.
2. **Use it two ways** (NEW section) — [TWO-WAYS] with [MCP-DIFF] landing as its own emphasized line. This subsumes/leads the existing "Build and run your own agents" (Bot Builder) and "Works With" content.
3. Fold existing **Bot Builder** section (`README.md:13-24`) under the "agentic framework" half. **Reframe the named OpenClaw/Hermes sentence** (`README.md:22`, "Where engines like OpenClaw or Hermes lean on auto-authoring and hosted control...") to the unnamed capability contrast (e.g. "Unlike hosted, auto-authoring bot platforms, Crow keeps the engine on your hardware with an operator-approval gate in front of anything an agent writes for itself.").
   > **Scope note:** the OpenClaw/Hermes removal applies ONLY to this README marketing sentence. Do NOT touch the legitimate `/platforms/openclaw` doc page (`docs/.vitepress/config.ts:123`) or the `CrowClaw (Legacy)` entry (`config.ts:185`) — those are real reference pages, not competitor name-drops.
4. Fold existing **Works With** table (`README.md:63-67`) + **AI Chat Gateway** (`README.md:75-79`) under the "MCP platform" half.
5. **Bundles** — add [BUNDLE] where add-ons/Crow OS are introduced (near `README.md:131` "Crow OS & Self-Hosting").
6. **All-in-one home server** — fold [HOME] into the "Crow OS & Self-Hosting" section (`README.md:131-141`), elevating it.
7. **Sharing + multi-instance + Android** — keep the strong P2P section (`README.md:40-52`); add the [SHARE] Android/multi-instance line (README currently OMITS the Android app — this fills the gap).
8. **Privacy** — reframe "Your AI, your devices, your data" (`README.md:7-11`) to [PRIVACY] (local-or-cloud, not local-only — it already is; keep).
9. Keep **What Crow does** table (`README.md:26-38`), **Crow for your field** (`README.md:54-61`), **Quick Start** (add a one-line first-run-wizard + connect-wizard mention near `README.md:81`), **Developer Program** — add [DEV] as a visible beat near the top too, not only the closing section.
10. Preserve ALL outbound links (maestro.press deep-links, MCP, CONTRIBUTING, SECURITY, GitHub) and the MIT license line.

- [ ] **Step 1: Draft + apply the restructured README** following the outline above, using the canonical blocks verbatim for [ID]/[MCP-DIFF]/[BUNDLE]/[HOME]/[SHARE]. Match the existing README voice.

- [ ] **Step 2: Verify no links lost + competitor names removed.** Diff the actual URL SET (not a line count — a restructure can merge link-bearing lines and skew a count without losing a link):

Run:
```bash
cd ~/crow && git show HEAD:README.md | grep -oE 'https?://[^) ]+' | sort -u > /tmp/readme-urls-before.txt
grep -oE 'https?://[^) ]+' README.md | sort -u > /tmp/readme-urls-after.txt
echo "=== URLs present BEFORE but missing AFTER (should be empty) ===" ; comm -23 /tmp/readme-urls-before.txt /tmp/readme-urls-after.txt
echo "=== competitor names (should be empty) ===" ; grep -n "OpenClaw\|Hermes" README.md
```
Expected: the "missing AFTER" set is empty (no outbound link dropped); the OpenClaw/Hermes grep returns nothing.

- [ ] **Step 3: Eyeball the diff for preserved qualifiers + field cuts.**

Run: `cd ~/crow && git diff README.md | head -200`
Expected: "What Crow does" table, "Crow for your field" cuts, P2P section all still present (moved, not deleted); "ships today" / "planned follow-on" qualifiers intact.

- [ ] **Step 4: Commit.**
```bash
cd ~/crow && git commit README.md -m "F7: restructure README around v1 dual-use spine (agentic framework + MCP connector, home server, Android, bundles)" && git show --stat HEAD | head -5
```

---

## Task 2: VitePress docs landing — English (Surface 2, EN)

**Files:**
- Modify: `docs/index.md` (home layout: `hero` + `features` frontmatter)

- [ ] **Step 1: Rewrite the `hero` block.** Replace `docs/index.md:5-7`:
```yaml
hero:
  name: Crow
  text: A modular, agentic framework and MCP platform that runs on your hardware
  tagline: Build and run your own AI agents, connect the AI client you already pay for as a native MCP connector, and self-host your apps — on hardware you own, with local or cloud models. Your AI, your devices, your data.
```
Keep the existing `image`, and the `actions` list (4 buttons) as-is (Get Started / Build an Agent / P2P Sharing Guide / View on GitHub).

- [ ] **Step 2: Restructure the `features` cards** so the first two cards are the dual-use frame, third is the dashboard, then supporting cards. Use these 9 cards (reuse existing `docs/public/icon-*.svg` — no new assets):
  1. **Build & Run Your Own Agents** (`icon-mcp.svg`) — Bot Builder, [TWO-WAYS] agentic half, operator-gated.
  2. **Connect Your AI Client over MCP** (`icon-platforms.svg`) — [MCP-DIFF] verbatim as the card body's spine: native MCP server, rides your existing subscription, first-class connector not a third-party harness.
  3. **All-in-One Home Server** (`icon-deploy.svg`) — [HOME]: AI-driven app store; every app is also an agent capability.
  4. **Persistent Memory** (`icon-memory.svg`) — keep existing copy.
  5. **Projects & Research** (`icon-research.svg`) — keep existing copy.
  6. **Encrypted P2P Sharing** (`icon-sharing.svg`) — keep existing copy; add the multi-instance/Android beat from [SHARE].
  7. **Integrations & Bundles** (`icon-integrations.svg`) — [BUNDLE]: 20+ integrations + self-hosting add-ons, each a bundle (service + tools + skills).
  8. **Your Data Stays Yours** (`icon-deploy.svg`) — [PRIVACY] local-or-cloud.
  9. **Managed, Cloud, or Self-Host** (`icon-platforms.svg`) — keep existing deploy copy; mention the open-source Android app + developers-welcome ([DEV]).

- [ ] **Step 3: Verify VitePress build succeeds.**

Run:
```bash
cd ~/crow/docs && npm run build 2>&1 | tail -15
echo "=== spine landed in the built EN landing? ===" ; grep -rci "agentic framework\|MCP platform\|all-in-one" .vitepress/dist/software/crow/index.html
```
Expected: `build complete` (no errors); the spine grep ≥1 (the new hero/cards rendered into the build). If `npm ci` needed first and `node_modules` present, build runs directly.

- [ ] **Step 4: Commit.**
```bash
cd ~/crow && git commit docs/index.md -m "F7: restructure docs landing (EN) hero + cards around dual-use spine" && git show --stat HEAD | head -5
```

---

## Task 3: VitePress docs landing — Spanish parity (Surface 2, ES)

**Files:**
- Modify: `docs/es/index.md`

**Context:** the ES landing is STALE (pre-agentic: leads with "project management, memory, blog", no Bot Builder, stale "$15/mes" line). This is a fuller rewrite to reach parity with the new EN landing — NOT a light touch.

- [ ] **Step 1: Rewrite the ES `hero`** to mirror the new EN hero, using [ID-ES]:
```yaml
hero:
  name: Crow
  text: Un marco de trabajo modular y con agentes, y una plataforma MCP, que se ejecuta en tu hardware
  tagline: Crea y ejecuta tus propios agentes de IA, conecta el cliente de IA que ya pagas como conector MCP nativo, y autoaloja tus apps — en hardware que tú controlas, con modelos locales o en la nube. Tu IA, tus dispositivos, tus datos.
```
Keep the existing `image` + `actions` (update the stale hosting button text only if it points somewhere dead; otherwise leave).

- [ ] **Step 2: Rewrite the ES `features` cards** to mirror the 9 EN cards (Task 2 Step 2), translating consistently and using [TWO-WAYS-ES]/[MCP-DIFF-ES]/[HOME-ES] for cards 1-3. Remove the stale "$15/mes" specific price (match EN's price-agnostic "Managed, Cloud, or Self-Host"). Keep informal "tú" register.

- [ ] **Step 3: Verify build still succeeds (ES is part of the same build).**

Run: `cd ~/crow/docs && npm run build 2>&1 | tail -15`
Expected: `build complete`, no errors (ES routes build).

- [ ] **Step 4: Commit.**
```bash
cd ~/crow && git commit docs/es/index.md -m "F7: rewrite docs landing (ES) to parity with v1 dual-use spine" && git show --stat HEAD | head -5
```

---

## Task 4: Wire og:image into VitePress config (Surface 3 prep)

**Files:**
- Modify: `docs/.vitepress/config.ts:10-12` (the `head` array)

This wires the social card (created in Task 5) so the docs site also emits an `og:image`. Done before Task 5 commits the PNG; reference the committed path.

- [ ] **Step 1: Add og:image + twitter:card meta to the `head` array.** Replace `docs/.vitepress/config.ts:10-12`:
```ts
  head: [
    ['meta', { name: 'theme-color', content: '#1d1d1f' }],
    ['meta', { property: 'og:image', content: 'https://maestro.press/software/crow/crow-social-card.png' }],
    ['meta', { property: 'og:title', content: 'Crow — modular agentic framework + MCP platform' }],
    ['meta', { property: 'og:description', content: 'Self-host your own AI agents and apps. Connect Claude/ChatGPT/Cursor as a native MCP connector. Local or cloud models.' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
```
(**VERIFIED:** the droplet serves `docs/public/` assets at `/software/crow/` — `https://maestro.press/software/crow/crow-hero.svg` returns 200 — so `crow-social-card.png` will serve at `https://maestro.press/software/crow/crow-social-card.png` once committed AND the droplet re-publishes (Task 8). Use this absolute maestro.press URL, NOT a github.io URL — the github.io build is base-mismatched and would 404 the asset. Social scrapers require an absolute URL, so a relative path is not an option.)

- [ ] **Step 2: Verify build still succeeds.**

Run: `cd ~/crow/docs && npm run build 2>&1 | tail -8`
Expected: `build complete`. (The og:image URL resolves at runtime; build does not fail if the PNG isn't committed yet, but commit Task 5's PNG before pushing.)

- [ ] **Step 3: Commit.**
```bash
cd ~/crow && git commit docs/.vitepress/config.ts -m "F7: add og:image/twitter social-card meta to docs head" && git show --stat HEAD | head -5
```

---

## Task 5: Social-preview card image (Surface 3) — ⚠ TOOLING DECISION

**Files:**
- Create: `docs/public/crow-social-card.svg` (source, hand-authored, 1200×630)
- Create: `docs/public/crow-social-card.png` (1200×630, rasterized — REQUIRED by GitHub: PNG/JPG, ≥640×320, ≤1MB)

**⚠ BLOCKER:** No SVG→PNG rasterizer is installed on crow (no rsvg-convert / ImageMagick / Chromium / sharp / puppeteer). Per the global rule, installing a package requires the user's permission. **Resolve at execution time:**
- **Option A (ask):** request permission to install one of `librsvg2-bin` (`rsvg-convert`) or `imagemagick`, then rasterize. Recommended (`rsvg-convert` is tiny).
- **Option B (user-provides):** hand the user the finished SVG; they export the PNG (any design tool) and drop it at `docs/public/crow-social-card.png`.

- [ ] **Step 1: Author `crow-social-card.svg`** — 1200×630, brand bg `#1d1d1f`, the "Crow" wordmark + the `crow-hero.svg` motif (reuse `docs/public/crow-hero.svg` / `grackle-pattern.svg`), and a one-line tagline ("Agentic framework + MCP platform you self-host"). Match brand colors in `docs/guide/brand` / `docs/developers/design-system.md`.

- [ ] **Step 2: Rasterize to PNG** (after the tooling decision):
```bash
# Option A example (rsvg-convert):
rsvg-convert -w 1200 -h 630 docs/public/crow-social-card.svg -o docs/public/crow-social-card.png
file docs/public/crow-social-card.png   # expect: PNG image data, 1200 x 630
```
Expected: a 1200×630 PNG ≤1MB.

- [ ] **Step 3: Commit both assets.**
```bash
cd ~/crow && git add docs/public/crow-social-card.svg docs/public/crow-social-card.png && git commit docs/public/crow-social-card.svg docs/public/crow-social-card.png -m "F7: add social-preview card (svg source + png)" && git show --stat HEAD | head -6
```

---

## Task 6: GitHub repo metadata (Surface 3) — ⚠ ACCESS DECISION

**Files:** none in-repo (GitHub repo settings: description, topics, social preview).

**⚠ BLOCKER:** `gh` is NOT installed, and the GitHub MCP tools available do not expose repo-description / topics / social-preview editing. **Resolve at execution time, pick one:**
- **Option A (gh):** ask permission to install `gh`, `gh auth login`, then run the commands below.
- **Option B (REST + PAT):** if the user supplies a GitHub PAT with `repo` scope, set description + topics via `curl` to the REST API. (Social preview image has NO public REST endpoint — still web-UI.)
- **Option C (user web-UI):** hand the user [GH-DESC], [GH-TOPICS], and the PNG to apply via the repo Settings page. The social-preview image is web-UI-only regardless of A/B.

- [ ] **Step 1: Set description + topics** (Option A shown):
```bash
gh repo edit kh0pper/crow --description "Modular, agentic framework and MCP platform you self-host. Build and run your own AI agents, connect Claude/ChatGPT/Cursor as a native MCP connector, self-host your apps, and share over encrypted P2P — on hardware you own, with local or cloud models. Open source."
gh repo edit kh0pper/crow --add-topic mcp,model-context-protocol,ai-agents,agent-framework,self-hosted,home-server,local-first,privacy,personal-ai,bot-builder,llm,p2p,nodejs
```
- [ ] **Step 2: Upload the social-preview PNG** via repo Settings → Options → Social preview (web UI; no API). Hand the user `docs/public/crow-social-card.png`.

- [ ] **Step 3: Verify.**
```bash
gh repo view kh0pper/crow --json description,repositoryTopics  # Option A
```
Expected: description = [GH-DESC]; topics include the [GH-TOPICS] set. (Social card: confirm visually on the repo page.)

---

## Task 7: maestro.press product page restructure (Surface 4, separate gitea repo)

**Files (in `~/maestro-press-landing`, NOT the crow repo):**
- Modify: `software/crow-overview/index.html`
- Modify: `software/index.html` (the Crow card blurb)

- [ ] **Step 1: Restructure `software/crow-overview/index.html`** mirroring the README outline (Task 1). Update `<meta name="description">` (line 7) to [GH-DESC]-style wording. Update the hero `<p class="tagline">` (line 27) to [ID]. Reorganize `Key Features` (lines 53-90) so the lead cards are the dual-use frame ("Build Your Own Agents" + a new "Connect Your AI Client over MCP" card carrying [MCP-DIFF]) + an "All-in-One Home Server" card ([HOME]). Add a bundle definition ([BUNDLE]) and the Android/multi-instance beat ([SHARE]). **KEEP** the "Open Research Infrastructure" / Texas education-data section (lines 119-140) unchanged — it is maestro.press-specific positioning, not generic spine. Keep all CTAs/links.

- [ ] **Step 2: Refresh the Crow card** in `software/index.html` (lines 34-42) to lead with the dual-use identity (currently "modular, agentic framework for assistance, research, and home...") — add the MCP-connector + home-server angle in one tightened sentence. Keep the CTAs.

- [ ] **Step 3: Verify the spine landed AND the Texas section survived (real phrase checks, not a substring count).**

Run:
```bash
cd ~/maestro-press-landing
echo "=== new spine phrases present (each should be ≥1) ===" ; for p in "MCP" "all-in-one" "home server" "bundle"; do printf "%-14s " "$p"; grep -ci "$p" software/crow-overview/index.html; done
echo "=== Texas section MUST survive (should be 1) ===" ; grep -c "Open Research Infrastructure" software/crow-overview/index.html
echo "=== balanced tags sanity (open vs close <section>) ===" ; echo "open: $(grep -oc '<section' software/crow-overview/index.html)  close: $(grep -oc '</section>' software/crow-overview/index.html)"
```
Expected: each spine phrase ≥1; "Open Research Infrastructure" == 1 (the maestro-specific section kept); `<section` open count == `</section>` close count (no broken nesting). Then open the file in a browser to eyeball before committing.

- [ ] **Step 4: Commit to the gitea repo (separate from crow).**
```bash
cd ~/maestro-press-landing && git commit software/crow-overview/index.html software/index.html -m "Crow: restructure product page + software card around v1 dual-use spine" && git show --stat HEAD | head -6
```

---

## Task 8: Droplet publish (public docs + social card + maestro landing) — ⚠ VERIFY BEFORE GO-LIVE

> **⚠ EXECUTION ORDER (despite the number): Task 8 runs LAST — after Task 9's crow→main merge.** The droplet pulls the docs build from `main`, so the merge must land first. Sequence: Tasks 0-7 (build all surfaces) → Task 9 Steps 1-4 (verify, review, PNG gate, merge crow→main + GitHub metadata) → **Task 8 (droplet go-live, handed to the user).**

**This is the SINGLE go-live task for everything served at `maestro.press`.** Per the verified deploy model, THREE things only become public when the droplet re-publishes: (a) the VitePress docs at `maestro.press/software/crow/` (Tasks 2-4), (b) the social-card PNG at `maestro.press/software/crow/crow-social-card.png` (Task 5, needed for the og:image to resolve), and (c) the maestro landing pages (Task 7). They share ONE droplet mechanism.

**⚠ BLOCKER:** the droplet publish path is UNVERIFIED from this session (root SSH key-denied; no `maestro` alias in non-interactive shell). The maestro landing lives in gitea (`ssh://git@gitea:2222/kh0pp/maestro-press-landing.git`); the docs are built from the crow repo. Both are served by **nginx on the maestro.press droplet**. **Do NOT claim the public surfaces shipped until the live URLs reflect the change.** Prerequisite: the crow-repo branch is already merged to `main` (Task 9) so the droplet can pull the new docs.

- [ ] **Step 1: Discover BOTH publish paths** (interactive shell — the user has the `maestro`/`maestro.press` alias + droplet key):
```bash
# user runs (interactive):
maestro "echo '--- nginx roots ---'; grep -rn 'root\|location' /etc/nginx/sites-enabled/ | grep -i 'crow\|software\|maestro' ;
         echo '--- landing checkout ---'; (cd /var/www/maestro.press 2>/dev/null && git remote -v && git log --oneline -1) ;
         echo '--- docs build: where does /software/crow come from? ---'; ls -la /var/www/maestro.press/software/crow 2>/dev/null | head ;
         echo '--- any cron/webhook that rebuilds vitepress? ---'; crontab -l 2>/dev/null | grep -i 'crow\|vitepress\|docs'; ls /etc/cron.d 2>/dev/null"
```
Determine: (i) how the landing repo reaches `/var/www/...` (pull / rsync / webhook), and (ii) how the VitePress docs get built+served at `/software/crow/` (droplet `git pull crow && npm run build` + nginx, or a proxy, or a cron). Record both.

- [ ] **Step 2: Publish the landing repo.**
```bash
cd ~/maestro-press-landing && git pull --rebase && git push origin main
# then the droplet-side pull/rsync identified in Step 1(i)
```

- [ ] **Step 3: Publish the docs build** via the mechanism found in Step 1(ii) (e.g. droplet pulls `crow` main + `cd docs && npm ci && npm run build`, or triggers whatever cron/hook does it). The committed `docs/public/crow-social-card.png` is part of that build, so this is also what makes the og:image resolve.

- [ ] **Step 4: Verify ALL THREE live.**
```bash
echo "=== landing product page (spine copy) ===" ; curl -s --max-time 12 https://maestro.press/software/crow-overview/ | grep -ci "all-in-one\|MCP server\|native MCP" 
echo "=== public docs landing (new hero) ===" ; curl -s --max-time 12 https://maestro.press/software/crow/ | grep -ci "agentic framework\|MCP platform"
echo "=== social card resolves (HTTP 200) ===" ; curl -sI --max-time 12 https://maestro.press/software/crow/crow-social-card.png | head -1
```
Expected: landing ≥1 match; docs ≥1 match; social card → `HTTP/2 200`. Any 0 / non-200 means that surface did not propagate — investigate before declaring done.

> **Note:** Steps 1-3 require the user (interactive shell + droplet key/alias). This task is a HANDOFF — surface it with the user at execution time; the agent prepares the commits/pushes, the user (or the droplet's own automation) performs the publish.

---

## Task 9: Final holistic review + finish

- [ ] **Step 1: Verify the crow repo build + invariant once more.**
```bash
cd ~/crow/docs && npm run build 2>&1 | tail -5
cd ~/crow && git diff --stat origin/main..f7-public-docs-realignment   # confirm: touches only README.md, docs/** — NO servers/gateway/**
```
Expected: build complete; diff touches only README + docs (no gateway/funnel files → network-exposure invariant untouched, no `tests/auth-network.test.js` run needed).

- [ ] **Step 2: Opus holistic review** of the full diff across all surfaces — spine consistency (identity/[MCP-DIFF]/[HOME]/[BUNDLE] phrased the same everywhere), no competitor names leaked, EN/ES parity, no broken links, qualifiers preserved. (subagent-driven-development handles the per-task spec+quality reviews; this is the final cross-surface pass.)

- [ ] **Step 3: HARD MERGE GATE — the social-card PNG must exist before merge/push.** The og:image meta committed in Task 4 points at `crow-social-card.png`; merging before Task 5 produces the PNG would ship a broken og:image. Run:
```bash
cd ~/crow && test -f docs/public/crow-social-card.png && file docs/public/crow-social-card.png || echo "BLOCKED: PNG missing — resolve Task 5 tooling decision before merging"
```
Expected: `PNG image data, 1200 x 630`. If missing, do NOT merge — finish Task 5 first.

- [ ] **Step 4: finishing-a-development-branch (crow repo) — independent of the droplet publish.** Merge `f7-public-docs-realignment` → `main`, `git pull --rebase` then `git push origin main`. This makes the README live on GitHub immediately and fires the GitHub Pages Action. **Note (corrects the earlier assumption): pushing does NOT make the public docs at `maestro.press/software/crow/` live — that requires the droplet re-publish in Task 8.** The crow-repo merge is the prerequisite for Task 8 (the droplet pulls from it), and Task 6 GitHub metadata can be done in parallel. So: merge crow → main here; then Task 8 is the final public go-live (docs + card + landing), handed off to the user. Do not declare F7 "shipped" until Task 8 Step 4 verifies all three public URLs.

---

## Self-review (planner, against the spec)

**Spec coverage:** Surface 1 (README)=Task 1 ✓. Surface 2 EN=Task 2, ES=Task 3 ✓. Surface 3 (GitHub: About/topics=Task 6, social card=Task 5, og:image wiring=Task 4) ✓. Surface 4 (maestro.press page=Task 7, deploy=Task 8) ✓. Spine load-bearing points: dual-use+[MCP-DIFF] (Tasks 1/2/7), local-or-cloud [PRIVACY] (Tasks 1/2/3/7), modular+[BUNDLE] (Tasks 1/2/7), sharing+multi-instance+Android [SHARE] (Tasks 1/2/3/7), home-server [HOME] (Tasks 1/2/7), developers-welcome [DEV] (Tasks 1/2), unnamed-competitor reframe (Task 1 Step + verified Task 1 Step 2 grep) ✓. Funnel invariant sanity-check = Task 9 Step 1 ✓.

**Placeholder scan:** no TBD/TODO; the three ⚠ blockers (Tasks 5/6/8) are real decision points with concrete options + commands, not placeholders.

**Consistency:** canonical blocks [ID]/[TWO-WAYS]/[MCP-DIFF]/[BUNDLE]/[HOME]/[SHARE]/[PRIVACY]/[DEV] (+ES variants) defined once, referenced by ID throughout. Social card path `docs/public/crow-social-card.png` consistent across Tasks 4/5/6. Branch name `f7-public-docs-realignment` consistent (Task 0/9).

**Risks carried from spec:** maestro deploy unverified → Task 8 gates go-live on a live-URL check. GH social API absent → Task 6 falls back to web-UI. ES drift → Task 3 rewrites from the EN final. Tooling installs → Tasks 5/6 ask permission per global rule.

---

## Review

**Reviewer:** Plan subagent (staff-engineer adversarial pass), against the live tree. **Date:** 2026-06-10. **Verdict:** REVISE → resolved → **re-review APPROVE.**

**Re-review (2026-06-10):** Focused adversarial re-pass confirmed all four critical issues genuinely resolved (re-verified live: `maestro.press/software/crow/crow-hero.svg`→200, `kh0pper.github.io/software/crow/`→404; [GH-DESC] measured 263 chars; PNG merge-gate correctly precedes the merge; Task 8→Task 9 dependency is linear, not circular). Topic count = 13 (< GitHub's 20 max). No critical issues remain ("Ship it"). Two non-blocking suggestions: (1) the Task 9 Step 3 gate guarantees "PNG committed," not "PNG live" — live-resolution is covered by Task 8 Step 4's 200-check; (2) added a built-output spine-phrase grep to Task 2 Step 3 for symmetry with Task 7. Both addressed/noted.

The reviewer verified every line-number anchor in the plan against the live tree (all accurate) and confirmed the three ⚠ blockers are real (`gh` absent, no SVG→PNG rasterizer, GitHub MCP tools don't expose repo metadata). Four critical issues + suggestions raised; resolutions:

- **C1 (og:image domain asserted, not verified) — RESOLVED by verification.** Empirically confirmed the droplet serves `docs/public/` at `/software/crow/` (`curl -sI .../software/crow/crow-hero.svg` → 200), and that `kh0pper.github.io/crow/` is base-mismatched (its `/software/crow/` base 404s assets there). So the maestro.press absolute og:image URL is correct and canonical. Task 4 + the Architecture block now record this with the warning not to use github.io.
- **C2 (misleading "docs auto-live on push") — FIXED.** Verified `maestro.press/software/crow/` is nginx-on-droplet, not GitHub Pages. The Architecture block now documents the real deploy model; the public docs, social card, and landing share ONE droplet-publish dependency, consolidated into Task 8; Task 9 no longer claims push = public-live.
- **C3 (og:image committed before PNG exists) — FIXED.** Task 9 Step 3 is now a HARD MERGE GATE that fails if `docs/public/crow-social-card.png` is absent.
- **C4 (description over 350-char limit) — NOT AN ISSUE (reviewer estimated; I measured).** [GH-DESC] is 263 chars; label updated to record the verified length.
- **S1 (split maestro into its own plan) — PARTIALLY ADOPTED.** Kept in F7 (user wants all 4 surfaces) but Task 9 now merges the crow-repo work independently; Task 8 is a separable, user-handed-off droplet publish that doesn't block the crow merge.
- **S2 (Task 7 theater checks) — FIXED.** Replaced `grep -c section` / tolerant HTMLParser with real spine-phrase greps + Texas-section survival + `<section>` open/close balance.
- **S3 (README link-count weak) — FIXED.** Task 1 Step 2 now diffs the actual URL set before/after.
- **S4 (redundant `git add` in Task 5) — REJECTED (reviewer wrong):** these are NEW files; repo CLAUDE.md explicitly requires `git add <path>` before `git commit <path>` for new files (`git commit <pathspec>` errors on untracked paths). Kept.
- **S5 (legit OpenClaw refs) — ADOPTED.** Task 1 now scopes the OpenClaw/Hermes removal to the README sentence only, with an explicit do-not-touch note for `config.ts:123/185`.
- **Q1/Q2 (deploy topology / custom domain) — ANSWERED** by the C1/C2 verification (droplet-served, maestro.press canonical, github.io base-broken). **Q3 (rasterizer choice) — stands** as the Task 5 decision point. **Q4 (parallel-session conflict / token leak) — no leak** (reviewer confirmed no gitea token in committed files); normal `git pull --rebase` discipline covers parallel pushes.
