# Bundles — the Bundle Contract

A **bundle** is the modular unit of Crow's extension layer: a directory under `bundles/<id>/` described by a `manifest.json`. A bundle may provide any combination of surfaces — a containerized **service** (Docker), an **MCP server** (tools), a **dashboard panel**, and **skills** — hence "bundle = service + tools + skills". The contract is *surface-based*: a bundle is only required to satisfy the rules for the surfaces it actually declares.

## Where bundles come from

- Source of truth: each `bundles/<id>/manifest.json`.
- Install catalog: `registry/add-ons.json` is **generated** from the manifests by `npm run build-registry` — never hand-edit it. It is committed (lockfile model) and a test fails if it drifts.

## Universal required fields

Every manifest must have:

| Field | Rule |
|---|---|
| `id` | must equal the directory name |
| `name` | non-empty |
| `description` | non-empty |
| `type` | `bundle` \| `mcp-server` \| `skill` (a coarse category tag, not what drives required fields) |
| `category` | non-empty |

`version` (semver) and `author` are **optional** but shape-checked when present (some first-party model/media bundles ship without them).

## Surfaces (declare what you provide)

A surface is "declared" by the presence of its key. Each declared surface is validated for shape **and** that its referenced files exist under the bundle dir:

| Surface | Shape | Integrity |
|---|---|---|
| `docker` | `{ "composefile": "docker-compose.yml" }` | the composefile exists |
| `server` | `{ "command": "node", "args": ["server/index.js"], "envKeys": [...] }`, or `null` | entry file checked **only** when `command` is `node` and `args[0]` is a path (external `npx`/`uv` servers are exempt) |
| `panel` | `"panel/<id>.js"` **or** `{ "id": "...", "extends": "..." }` | string form: the file exists; object form: shape-only (resolved at runtime) |
| `panelRoutes` | `"panel/routes.js"` | the file exists |
| `widgets` | `[{ "id": "…", "title": "…", "sizes": [[2, 2]] }]` | each declaration's `widgets/<id>.js` exists |
| `skills` | `["skills/<id>.md", ...]` | every path exists |
| `ports` / `port` / `webUI.port` | integers (1–65535); `webUI` may also be `null` | — |
| `requires.bundles` / `optional_bundles` | `["<bundle-id>", ...]` | each id is a `bundles/<id>` dir with a `manifest.json` (a real bundle) |
| `env_vars` | `[{ "name": "X", "description": "...", "required": false, "secret": false, "default": "" }]` | each entry has a `name` |

**Refresh on a version bump.** When a bundle's `version` changes, the gateway re-copies its code into the installed copy (`~/.crow/bundles/<id>/`). Docker bundles get a narrow set (`server/`, `panel/`, `skills/`, `package*.json`, declared roots) — never the compose file or anything a container mounts. A docker bundle that needs more opts in with `"refreshFiles": ["docker-compose.yml", "<plugin dir>"]`: plain bundle-relative paths, never `.env*`, `data`, `node_modules`, `.git`, `manifest.json`, or a path a read-write bind mount reaches (those are refused). Running containers keep the old files until the bundle is restarted.

**Skills stay current.** On every boot (version bump or not) the gateway syncs each installed bundle's `skills` into `~/.crow/skills/`. A copy is replaced only when it is provably unedited: it matches what Crow last wrote (`~/.crow/skill-installs.json`) or a past shipped version listed in `bundles/skill-history.json`. An edited copy is kept and the owner is notified once per new version; a copy that matches nothing known is kept without a notification; a symlink is never touched. After editing a bundle skill, run `node scripts/build-skill-history.mjs` and commit the ledger (CI runs `--check`, which also requires the ledger to stay append-only against the base commit). `CROW_SKILL_SYNC=on|report|off` sets the mode per gateway (`report` logs and writes nothing). `node scripts/ops/skill-sync-report.mjs --home <CROW_HOME>` is a read-only dry run for one instance.

**Opting an installed copy out.** An installed copy that you maintain by hand (for example a fork deployed over a first-party bundle id) is skipped when its *installed* manifest (`~/.crow/bundles/<id>/manifest.json`) carries `"refresh": false`. The gateway logs the skip on each boot while the versions differ. Only the literal `false` opts out, and the missing-file repair (a deleted `panel/`, `settings-section.js` or `manifest.json`) still runs.

### Widgets

A bundle can put its own widget on the dashboard widget grid (For You and `/dashboard/widgets`). It declares the widget in its manifest and ships its code beside it:

```json
"widgets": [
  { "id": "cameras", "title": { "en": "Cameras", "es": "Cámaras" }, "sizes": [[2, 2], [4, 2]] }
]
```

- `id` is a short slug (`a-z`, `0-9`, `-`), unique inside the manifest.
- `title` is a string of 1 to 60 characters, or `{ "en": "…", "es": "…" }` with `en` required.
- `sizes` lists 1 to 4 sizes. Each size is `[w, h]` with `w` of 1, 2 or 4 and `h` of 1 or 2. The first one is the size the widget starts at. A manifest may declare at most 8 widgets.
- There is no path field. The code for a widget is always `widgets/<id>.js` in the bundle.

That file exports one loader:

```js
export async function load(ctx) {
  return { state: "ok", headline: "", items: [], more_href: "/dashboard/your-page" };
}
```

- `ctx` holds exactly `lang` ("en" or "es") and `now` (the page request's clock in milliseconds). It is frozen. There is no database, no session and no host path to reach for.
- The gateway imports the file from the installed copy of your bundle, and gives the import and the call three seconds together. A loader that throws, hangs or answers with the wrong shape costs only its own cell: the page draws the other widgets, and yours says it could not load.
- The answer is a widget summary:
  - `state` is `"ok"`, `"empty"` or `"error"`.
  - `headline` is one short line of text.
  - `items` is up to 12 entries. Each needs a `title`, and may add `key`, `kind`, a same-site `href` and a same-site `image`. An item with an image is drawn as a still that reloads when it is tapped; one without is a row.
  - `more_href` is a same-site link, drawn as "Open" at the bottom of the card.
- Only same-site links (`/dashboard/…` and the like) are used. Anything else is dropped. Every string is escaped before it reaches the page.
- All other fields are dropped, so an add-on widget cannot act: there are no buttons and no actions in this release.
- Add-on widgets are never part of a page's default layout. They appear once the owner adds them from "+ Add widget" in Edit mode.
- The loader runs in the gateway process, with the same trust as a bundle panel. It is code you ship, not a sandboxed script.
- Unlike a panel, a widget is not loaded once at boot: its code is imported on page views, so a newly installed version goes live with no restart.
- A widget runs whenever its bundle is installed, even if the bundle's panel is switched off.
- Like every bundle change, a new or edited widget needs a `version` bump, or an installed copy keeps running the old file.

### Running from the installed copy

A bundle runs from its installed copy, never from the app checkout. The MCP server is spawned from `<CROW_HOME>/bundles/<id>/`, and the gateway loads a second copy of the panel and panel-routes files from `<CROW_HOME>/panels/<id>.js` and `<CROW_HOME>/panels/<id>-routes.js`. A relative path out of the bundle (`../../../servers/db.js`, or `../server/x.js` from a panel file) resolves only in the checkout: the installed server dies at spawn with `ERR_MODULE_NOT_FOUND`, an installed panel never loads, and an import inside a `try/catch` quietly switches the feature off.

- **App code** (`servers/…`, another first-party bundle's module): from the MCP server, `import { appImport } from "./app-root.js"` and `await appImport("servers/db.js")` (copy `server/app-root.js` from an existing bundle); from code the gateway loads, use the panel handler's `appRoot` or `process.env.CROW_APP_ROOT`, which the gateway exports for itself and its children.
- **The bundle's own modules from a panel file**: by path from this instance's installed copy, `join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "<id>", "server", …)`. Never hardcode `~/.crow`: co-hosted instances each have their own `CROW_HOME`.

`tests/bundle-installed-copy-imports.test.js` lays every bundle out as an install does, in a scratch home outside the repo, and fails on any import that resolves only from the checkout.

Unknown fields are allowed (the schema is lenient) — bundle-specific extras like `capabilities`, `companion`, `storage`, `providers`, `sttProfileSeed` pass through untouched. The canonical shape is `registry/manifest.schema.json`.

## Voice display phrase lists (`capabilities.voice_intent`)

An add-on whose tools an assistant may use by voice can say which words mean "this request is for me":

```json
"capabilities": {
  "tools": [{ "name": "mb_play" }],
  "voice_intent": { "en": ["music", "song", "songs", "next track"], "es": ["musica", "cancion", "canciones"] }
}
```

Each entry is a plain phrase of one to four words (letters and digits; accents and case are ignored), at most 40 per language, in `en` and `es`. Matching is by whole words, so list the singular and the plural. A voice display offers the add-on's tools to its quick model only on a turn that contains one of these phrases, or on the turn right after one that used them. An add-on with no list is used only on turns sent to the larger model, and the display's Diagnostics list shows it as not offered. Patterns are not accepted: anything that is not a short plain phrase is ignored.

## First admin: every web UI must say how its admin is created

A freshly installed app that has a first-run admin page of its own — "create the
administrator account" — is claimable by ANYONE or anything else on the machine
while it waits: those pages answer on `127.0.0.1`, and nothing about them knows
who the owner is. (A security audit's VM run showed another account reaching
uptime-kuma's setup page before the owner did.)

So **a bundle that declares a `webUI` must also declare `firstAdmin`**, and
`npm run build-registry -- --check` fails the build when it does not:

```json
"firstAdmin": { "mode": "finish-setup" }
```

| `mode` | Meaning | What Crow does |
|---|---|---|
| `crow` | Crow creates the app's first admin at install | the generated password is in the keychain (Settings → Passwords) |
| `finish-setup` | The app has its own first-run admin/setup page | shows "Finish <app>'s setup now", with a direct link, until the operator presses Done |
| `default-login` | The app ships a documented default login | same notice, naming the default user |
| `external` | It connects to an app you already run, whose login is that app's (Immich, Kodi) | nothing — there is no account of ours to claim |
| `none` | The app has no login of its own (a public/anonymous UI, or a viewer whose gate Crow already applies) | nothing |

Optional fields:

| Field | Rule |
|---|---|
| `path` | the app page to open, starting with `/` (a setup or login page when it is not the root) |
| `user` | the documented default username — **only** with `default-login` |
| `note` | one short plain sentence added to the notice (e.g. where the app prints its first password) |
| `via` | **with `crow` only**: `"env"` or `"postInstall"` — how Crow creates the admin |
| `secretEnv` | with `crow`/`via: "env"`: the `env_vars` entry Crow generates and keeps in the keychain |
| `userEnv` | with `crow`/`via: "env"`, optional: the `env_vars` entry holding the admin's username |

Contract rules (`scripts/lib/bundle-contract.mjs`, enforced by `build-registry`):

- `crow` must name the mechanism, and that mechanism must be wired to **this** app:
  - `{ "mode": "crow", "via": "env", "secretEnv": "MINIFLUX_ADMIN_PASSWORD" }` —
    `secretEnv` must name an `env_vars` entry with `generate: "secret"` **and**
    `keychain: true`, and the bundle's compose file must interpolate it
    (`${MINIFLUX_ADMIN_PASSWORD…}`). A generated secret the app never reads does
    not create its admin (a Vaultwarden-style `ADMIN_TOKEN` is not a login).
  - `{ "mode": "crow", "via": "postInstall" }` — requires `postInstall`, and
    the script must name at least one `generate: "secret"` + `keychain: true`
    env var: the hook is what turns the generated value into the admin.
  - Saying `crow` with nothing behind it (or a mechanism that only lives in
    `.env`) is refused.
- `default-login` requires `user`, and `user` is only allowed with that mode.
- `via`/`secretEnv`/`userEnv` are only allowed with `crow`.
- Every manifest with a `webUI` must declare `firstAdmin`.

At runtime the declaration is **fail-safe the other way**: a web UI bundle with
no usable declaration (a community-store manifest written before this field, or
a typo'd mode) is treated as `finish-setup`, so the card and the bell still
appear. Silence has to be an explicit `crow`, `external` or `none`.

**Prefer `crow` whenever the app can take its admin from the environment or a CLI**
(Miniflux's `ADMIN_USERNAME`/`ADMIN_PASSWORD`, JupyterHub's NativeAuthenticator
bootstrapping, a `postInstall` script that drives the app's own admin command).
That is the only mode where nothing on the machine can claim the account between
install and the operator's first visit. Use `finish-setup` when the app only has
a first-run page, and add a `note` when the app prints or documents the first
password (Peertube and Frigate print it in their logs; Plex's server is claimed
by the first Plex account that reaches it unless a claim token was set).

Like every other bundle change, a new or edited `firstAdmin` needs a `version`
bump: the installed copy refreshes only when the version differs.

## Draft / unpublished

- `"draft": true` excludes a bundle from the generated registry.
- An **untracked** bundle dir (not committed to git) is treated as an implicit draft — excluded and reported, never auto-published. This keeps work-in-progress out of the registry.

## Contributing a third-party bundle (provenance)

Third-party contributions are welcome, and they are listed honestly — never presented
as first-party. Declare provenance in the manifest:

```json
{ "origin": "community" }
```

- `origin: "community"` → the generated registry entry carries `official: false`
  (plus the `origin` field), and the store renders a **Community** badge on the card
  and a "not verified by Crow" caution in the install modal.
- Omitting `origin` (or `origin: "official"`) keeps `official: true`. A manifest
  `official` field is always ignored — the registry derives it; you cannot opt into
  the Official badge by declaring it.
- Community bundles are not eligible for `featured` placement or curated collections.

The bar for a third-party listing (reviewers will check all of these):

- A **real, reachable upstream** with a disclosed operator (who runs the service,
  and under what terms — a public terms/privacy page counts; anonymity does not).
- An **accurate `author`** — the contributor or vendor, never "Crow".
- **Functional out of the box**: the bundle's declared surfaces (skills, server,
  docker) must actually work with what the bundle installs. A skill describing API
  workflows nothing in the bundle can execute is not functional.
- Scope honesty: the skill/manifest must not claim less access than the upstream
  API grants without saying so (e.g. "read-only" atop a write-capable key).

## Validate + generate

```bash
npm run build-registry -- --check   # validate all manifests + drift-check (CI)
npm run build-registry              # regenerate registry/add-ons.json
npm run test:bundle-contract        # the node:test gate
```

`--check` prints a per-bundle audit (id, type, surfaces, status) and exits nonzero on any invalid manifest or if the committed registry is out of date.

## Minimal example

```
bundles/your-bundle/
├── manifest.json
├── docker-compose.yml      (if it ships a service)
├── server/index.js         (if it provides MCP tools)
├── panel/your-bundle.js    (if it adds a dashboard panel)
└── skills/your-bundle.md   (if it adds skills)
```

```json
{
  "id": "your-bundle",
  "name": "Your Bundle",
  "version": "1.0.0",
  "description": "What it does",
  "type": "bundle",
  "author": "You",
  "category": "utilities",
  "docker": { "composefile": "docker-compose.yml" },
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["YOUR_API_KEY"] },
  "panel": "panel/your-bundle.js",
  "skills": ["skills/your-bundle.md"],
  "requires": { "env": ["YOUR_API_KEY"] },
  "env_vars": [
    { "name": "YOUR_API_KEY", "description": "API key", "required": true, "secret": true }
  ]
}
```

After adding or editing a bundle, run `npm run build-registry` and commit both the manifest and the regenerated `registry/add-ons.json`.

## Collections

`registry/collections.json` groups official bundles into curated, one-click "starter collections" (Home Server, Education, Research, Development) surfaced on the Extensions page's Browse view. Each collection is `{ id, name, description, icon, members }`, where every member is `{ id, kind, you_need? }`.

Membership is constrained by hard rules, enforced by `tests/extensions-collections.test.js`:

- **Official**: every member `id` must exist in `registry/add-ons.json` and have a manifest under `bundles/<id>/`.
- **Non-privileged, non-consent**: no member may set `privileged: true` or `consent_required: true` — a one-click install must never bypass the consent gate.
- **Non-GPU**: no member may declare `requires.gpu` or `requires.min_vram_gb` — collections are host-independent, not tuned to any one machine's hardware.
- **No host networking, no Docker socket**: no member's `docker-compose.yml` may use `network_mode: host` or mount `/var/run/docker.sock` — `validateComposeFile` refuses both without the privileged/consent gate, so such a member would fail the one-click install.
- **Dependency-closed and topologically ordered**: every `requires.bundles` dependency of a member must itself be a member of the same collection, and must appear earlier in the `members` array than its dependent.
- **`kind` matches compose presence**: a member with a `docker-compose.yml` must be `kind: "deploys"`; a member without one is `"builtin"` or `"connects"`.
- **`connects` members declare `you_need`**: a member that connects to something the user already runs (e.g. an existing Home Assistant instance) must set `kind: "connects"` and a non-empty `you_need` string describing what the user needs to bring.

At install time the gateway does not trust the loaded JSON blindly — it re-validates each member's manifest against these same rules from the on-disk `bundles/<id>/manifest.json` files before running the install job, so a collection can't be used to smuggle in a bundle whose manifest changed (or was removed) since `collections.json` was written.

### Deployment invariant: co-hosted gateways need distinct `CROW_HOME`

The one-click install path guards against concurrent installs with an in-process busy flag plus an `installed.json` file under `CROW_HOME`. Both are **per-process**, not cross-process: if two gateway processes are co-hosted and share the same `~/.crow` (the same `CROW_HOME`), they can race on `installed.json` and on the install-set busy gate, corrupting installed-bundle bookkeeping. Every gateway instance — including scratch/throwaway ones spun up for testing — must run with its own distinct `CROW_HOME`.
