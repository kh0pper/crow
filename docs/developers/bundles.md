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

**Refresh on a version bump.** When a bundle's `version` changes, the gateway re-copies its code into the installed copy (`~/.crow/bundles/<id>/`). Docker bundles get a narrow set (`server/`, `panel/`, `skills/`, `package*.json`, declared roots) plus their compose file (next paragraph) — never anything a container mounts. A docker bundle that needs more opts in with `"refreshFiles": ["<plugin dir>"]`: plain bundle-relative paths, never `.env*`, `data`, `node_modules`, `.git`, `manifest.json`, or a path a read-write bind mount reaches (those are refused). Running containers keep the old files until the bundle is restarted.

**The compose file is refreshed by default — unless you edited it.** A docker bundle's compose file is code: it declares the ports, mounts and settings the container runs with, so it is caught up with the repo's copy **on every boot, at any version** — the release that tightens a bind is a commit to the compose file, not necessarily a manifest bump, so an install whose version already matches the repo can still be running an old file. Project-name changes, volume/service renames and every other compose edit therefore reach every install, not just a fresh one. A copied compose takes effect at the next `compose up` of any kind — an on-demand Start, a Restart, or a boot-time start; of everything a refresh carries, only an image change is held back for the owner (below). Crow overwrites the installed copy only when it is unmodified: its bytes match the sha256 recorded in `~/.crow/bundles/<id>/.crow-compose.sha256` at the last install or refresh, or — for an install made before that record existed — the bundle's compose at some past commit of the checkout (one bounded `git log --raw` call; the decision is cached in `~/.crow/bundles/<id>/.crow-compose.state.json` for that exact pair of files, so a steady-state boot only hashes two files). A modified copy is never overwritten: it is kept, the gateway logs one line naming the bundle, and a Fix-it card on the Nest says the compose file has local changes — with a **Restore Crow's compose** action that keeps your copy as `<composefile>.bak` and puts Crow's back. The card clears by itself once the file matches again. If git history is unavailable, or the checkout does not track the bundle folder at all, the answer is `unknown`: nothing is marked, no card is raised, that answer is never cached (the next boot asks again), and one lookup that cannot answer stops the history lookups for the rest of that boot pass.

A refresh never breaks Start: if the shipped compose requires a variable (`${X:?…}`) that the installed `.env` (or the gateway's own environment) cannot fill, the old copy stays and the Fix-it card names the key to set first (`Crow could not update …: it needs X set first`). The next boot retries.

**An update that would change an image is held, not applied.** Before copying the repo's compose over an unmodified installed one, Crow compares the `image:` value of every service (with `${VAR:-default}` resolved against the installed `.env`, the same resolution the port check uses, and a service the other file does not have counts as a change). Any difference means the update is kept back: the installed compose stays exactly as it is, the note `~/.crow/bundles/<id>/.crow-compose.image-change` records `[{ service, from, to }]` (image names only), and a Fix-it card says so. The reason is that the new tag may be OLDER than the one running — a pinned `linkding:1.47.0` shipped after `linkding:latest`, say — and a downgraded image can migrate the data's schema on the next restart. The card explains the hold and offers **Apply the update**: owner-only, it keeps the current file as `<composefile>.bak`, applies Crow's copy, records it and clears the notes, and it never restarts anything — the "restart to apply" card then appears as usual. The hold clears by itself as soon as the two files name the same images, and while it is in effect the repo-tighter card stays quiet for that bundle, so the two never contradict each other.

Keep owner-specific settings in `docker-compose.override.yml` next to the compose file. Compose merges that file into the running model, Crow never writes it, and it survives every refresh. The exception is a compose the manifest lists in `refreshFiles`: that entry is copied on every version change whether or not you edited it, so put your changes in the override instead.

**The "restart to apply" card.** Refreshing the file does not change a running container — it keeps the ports it was created with until the bundle is restarted. On boot (and right after a bundle Start, a stop, and an install's `up`) the gateway compares each installed docker bundle's published ports with the running containers' binds (`docker inspect`, per compose project and per `com.docker.compose.service`) and raises one Fix-it card per bundle that is still reachable on a wider bind (say `0.0.0.0:8555` while the compose now binds `127.0.0.1:8555`), or that publishes a port the compose no longer has on every interface. A loopback-only extra port is never carded, and a compose port range (`8000-8002`) covers the running ports inside it (Docker reports those one port at a time), so a wide running port inside a loopback-bound range is carded while one inside a wide range is not. The card links to the Extensions page, where Restart applies the new settings; it never restarts anything itself and clears once the binds match. Docker unreachable → no card, one log line.

When the installed compose could not be refreshed (it was edited, or git could not say) and the REPO's compose binds the port to a specific IP while the running container publishes it on every interface, a second card says so: a restart cannot fix that one, because the owner's own file keeps the port open. It is skipped for a port an override file declares — that widening was deliberate.

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

## Environment an add-on receives

An add-on's MCP server is a child process of the gateway, and it does **not** inherit the gateway's environment. It starts with exactly this:

1. **A base allowlist.** System basics, locale, time zone, `TMPDIR`, the `XDG_*` folders, proxy/CA settings and `NODE_ENV` — the same list a bot's pi process gets (`servers/shared/bot-env.js`) — plus the Crow instance keys `CROW_APP_ROOT`, `CROW_HOME`, `CROW_DATA_DIR`, `CROW_DB_PATH`, `CROW_GATEWAY_PORT` and `PORT` when the gateway has them.
2. **What your bundle's registry entry declares.** A key from the gateway's own environment is passed through only when the bundle's entry in the tracked `registry/add-ons.json` names it: either in `server.envKeys` or as an `env_vars[].name` that is meant to reach the server (an entry with `propagate: false` or a `generate` kind is the installer's, not a passthrough). The registry is generated from git-tracked, valid, published manifests, so "declared" means reviewed; an untracked folder in a checkout, a draft, a symlink or a community listing gets no passthrough at all — and the installed copy of `manifest.json`, which the bundle's own container can write, never widens it.
3. **A deny list.** Crow's own secrets never reach an add-on from the gateway's environment, even when the registry entry names them: `CROW_LOCAL_MCP_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_TOKEN`, `PHONE_RUNNER_SECRET`, `CROW_BROWSER_VNC_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `VAPID_PRIVATE_KEY`, `CROW_OAUTH_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `CLOUDFLARE_TUNNEL_TOKEN`, `NTFY_AUTH_TOKEN`, `CROW_BACKUP_TOKEN`, `CROW_SETUP_TOKEN`, `CROW_ENROLL_OTC`, `CROW_PEER_TOKENS_PATH`, `CREDENTIALS_DIRECTORY`, `TURN_SECRET`, and any key ending in `_ROOT_PASSWORD`. There is no exception for a bundle that shares a key's name, and the deny list does not touch the entry's own `env` (item 5): a value it carries is the add-on's own configuration, not the gateway's secret.
4. **The storage env, for the four bundles that read the app's storage client.** `artifacts`, `data-dashboard`, `studio` and `sunvox-studio` also get `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_USE_SSL`, `S3_REGION`, `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` when the gateway has them. That is the fallback `servers/storage/s3-client.js` uses when Shared Storage is not configured in the database, and an instance configured only through the environment would otherwise lose storage without a word. It is a code-held table (`STORAGE_ENV_CONSUMERS` in `servers/gateway/addon-env.js`), so no manifest declaration is involved and no other add-on ever receives these keys; giving each add-on scoped storage access instead is a later phase.
5. **The entry's own `env`** (`mcp-addons.json`), which is where values you enter in the extension's form and the manifest's `default`s live, plus the manifest's derived keys (e.g. Render's `AUTH_HEADER`). These win over the passthrough. The gateway sets `CROW_ADDON_HOST=gateway` last; an entry cannot claim or drop it.

So a value your server needs from the gateway's `.env` (an API key, a host, a tuning knob) must be declared in the manifest — and so in the registry entry `npm run build-registry` generates from it. `tests/addon-env-declared.test.js` scans every published bundle's `server/` code for environment reads (including a read through a local alias such as `const env = process.env` or a `function f(env = process.env)` parameter) and fails on a key that is neither in the base allowlist nor declared by that bundle's entry nor one of the storage keys its bundle keeps; it also scans the app modules a server `appImport`s, and the few exemptions it carries each name a key that is set somewhere else (for example in the bundle's own `.env`) and say why. While developing a server outside the gateway, `node --import ./scripts/dev/addon-env-read-logger.mjs` with `CROW_ADDON_ENV_ALLOW` set to the keys it should have prints one line per undeclared key it reads (`[addon-env] read of undeclared <KEY>`, never a value).

## The sandbox block

A manifest may say what its MCP server is allowed to reach when Crow runs it inside a wall. Crow derives the add-on's profile from this block, the values the owner entered and the bundle's compose file; the wall itself is described in [Add-on Walls](../architecture/addon-walls.md).

```json
"sandbox": {
  "network": { "internet": true, "hosts": ["env:MY_SERVICE_URL"] },
  "doors": ["my-addon-id"],
  "files": {
    "read": ["env:MY_DATA_DIR"],
    "write": ["env:MY_STATE_FILE"],
    "oauthDir": "env:MY_TOKEN_FILE"
  },
  "ownEnvFile": true
}
```

### `network`

| Shape | What the add-on reaches |
|---|---|
| `"none"` | Nothing. No internet, no listed host. |
| `"internet"` | HTTPS CONNECT on port 443 only, to public global-unicast addresses. Never this computer, the LAN or the tailnet. |
| `{ "internet": true, "hosts": ["env:NAME", ...] }` | The same internet rule, plus one exact `host:port` entry per listed field. A private or LAN address is allowed there because the owner typed it. |
| omitted | The internet, plus every declared `*_URL`, `*_HOST` or `*_BASE_URL` field that is set — the rule from before this block existed. |

`hosts` holds `env:` names only, never a literal host: the address is whatever the owner enters in that field. Name fields your `env_vars` (or `envKeys`) already declare, so the install form asks for them. A listed field the owner left empty is dropped and reported, and the add-on starts without that host. There are no wildcards, subdomains or port ranges — an entry is the whole permission.

A manifest default is not a choice the owner made. A default address is bound only when it is loopback and names a port this bundle's own compose file publishes on `127.0.0.1` over TCP; a public `https:` default is covered by the internet instead. Anything else is dropped and reported.

### `doors`

A few first-party bundles may talk to the gateway through a door (the kiosk display state, Studio's song hub, the browser container's restart). The door sets live in Crow's core table (`ADDON_DOORS`); a manifest can name its own set but never add one. The example above uses a placeholder id: a `doors` entry only means something for a bundle id Crow ships a set for — `kiosk`, `studio` and `browser` today — and for every other id the field is left out.

**An add-on cannot name another add-on's doors.** A listed door whose name is not the bundle's own id is refused, a door listed for an id Crow ships no set for is refused, and doors are for first-party bundles only. Leave the field out unless you are shipping one of those bundles: an omitted `doors` gives a first-party bundle its own set when one exists, and nothing otherwise.

### `files`

| Field | Meaning |
|---|---|
| `files.read` | Paths bound read-only. |
| `files.write` | Paths bound read-write. |
| `files.oauthDir` | One path naming a token file. Its **folder** is bound read-write, so the app can add files beside the token. |

Every value is `env:NAME` and only a value the owner typed is bound: a path that is only a manifest default is refused, because it is not a choice the owner made.

State folders are **not** a manifest field. A few add-ons keep state directly in the Crow home, and those folder names come from Crow's core table `ADDON_STATE_DIRS` — keyed by id, only for a first-party bundle. A pattern or a manifest-chosen name would collide with Crow's own home entries.

### `ownEnvFile`

Set `true` to let the add-on read its own `.env`: the file `<CROW_HOME>/bundles/<id>/.env`, bound read-only on top of the mask that hides every other `.env` in the trees the wall binds. The file must be a real file in that folder — a symlinked `.env` names a file the add-on does not own, and is refused.

### Where a first-party bundle's policy comes from

For a bundle that exists in Crow's own checkout, the `sandbox` block, the `env_vars` defaults and the compose ports are read from **the checkout copy**, never from the installed one — unwalled code can write the installed manifest. When the installed manifest's `sandbox` block or defaults differ from the checkout copy, the add-on stays off with the card "its installed files changed; reinstall it to wall it". Editing an installed manifest therefore turns the wall off; it never widens it. A local or third-party bundle has no checkout copy, so its installed manifest is used as it was installed.

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
| `finish-setup` | The app has its own first-run admin/setup page | shows "Finish &lt;app&gt;'s setup now", with a direct link, until the operator presses Done |
| `default-login` | The app ships a documented default login | same notice, naming the default user |
| `external` | It connects to an app you already run, whose login is that app's (Immich, Kodi) | nothing — there is no account of ours to claim |
| `none` | The app has no login of its own (a public/anonymous UI, or a viewer whose gate Crow already applies) | nothing |

Optional fields:

| Field | Rule |
|---|---|
| `path` | the app page to open, starting with `/` (a setup or login page when it is not the root) |
| `user` | the documented default username (`default-login`), or the admin username Crow itself creates (`crow` / `via: "setup"`) |
| `note` | one short plain sentence added to the notice (e.g. where the app prints its first password) |
| `via` | **with `crow` only**: `"env"`, `"postInstall"` or `"setup"` — how Crow creates the admin |
| `setup` | with `crow`/`via: "setup"`: `{ "script": "scripts/first-admin.sh", "timeout_s": 180 }`, optionally with `after` (see "setup.after" below) |
| `secretEnv` | with `crow`: the keychain entry name for the admin password — an `env_vars` entry with `generate: "secret"` + `keychain: true` for `via: "env"`, any name for `via: "setup"` |
| `userEnv` | with `crow`, optional: the `env_vars` entry holding the admin's username |
| `urlEnv` | with `crow`, optional: a declared, NON-SECRET `env_vars` entry whose installed `.env` value is the app's own address — the saved keychain row then carries that URL (only when it is an `http(s)` URL of at most 512 characters), so Settings → Passwords can link to the app |
| `invite` | with `finish-setup` only: the name of a CODE-HELD invite handler (today: `"vaultwarden"`) — see the next section |

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
  - `{ "mode": "crow", "via": "setup" }` — see the next section.
  - Saying `crow` with nothing behind it (or a mechanism that only lives in
    `.env`) is refused.
- `default-login` requires `user`; `user` is allowed with `default-login` and with
  `crow`/`via: "setup"` (where the script needs a username to create), and nowhere else.
- `via`/`secretEnv`/`userEnv`/`urlEnv` are only allowed with `crow`, and `setup` only with
  `via: "setup"`. `urlEnv` must name a declared, non-secret `env_vars` entry.
- `invite` is only allowed with `finish-setup`, and its value must name a handler
  Crow really ships (`INVITE_HANDLER_NAMES` in
  `servers/gateway/first-admin/registry.js`). The manifest names code; it never
  supplies it. Each handler is also bound to the ONE bundle it belongs to
  (`INVITE_HANDLERS[name].bundleId`): a manifest that merely names it on any other
  bundle resolves to nothing, so it can never drive that app's admin token. The only
  value a handler reads from a reviewed manifest is the local port it talks to
  (`webUI.port`); the operator's email comes from the bundle's own `.env` at install
  time, never from a manifest.
- With `crow`/`via: "setup"`, `secretEnv` and `userEnv` must be plain uppercase env
  names (letters, digits and `_`) and must not start with `COMPOSE_`, `DOCKER_` or
  `CROW_` — Crow and Compose reserve those prefixes.
- Every manifest with a `webUI` must declare `firstAdmin`.

At runtime the declaration is **fail-safe the other way**: a web UI bundle with
no usable declaration (a community-store manifest written before this field, or
a typo'd mode) is treated as `finish-setup`, so the card and the bell still
appear. Silence has to be an explicit `crow`, `external` or `none`.

### `via: "setup"`: the script that gives the app its admin

For an app that has no environment variable for its admin and whose first-run page
you do not want to leave open, ship a small script that creates the account:

```json
"firstAdmin": {
  "mode": "crow",
  "via": "setup",
  "setup": { "script": "scripts/first-admin.sh", "timeout_s": 180 },
  "user": "admin",
  "secretEnv": "FRIGATE_PASSWORD",
  "userEnv": "FRIGATE_USER"
}
```

Crow runs it once, right after `compose up -d` succeeded, in its own process group
(the whole group dies on a timeout), with a minimal environment (`PATH`, `HOME`,
and Crow's usual hook variables) plus `CROW_FIRST_ADMIN_USER=<user>`. The manifest
and the script are read from Crow's OWN copy of the bundle (the bundle source tree
`manifest.json` and the `setup.script` it names), never from the installed folder
`~/.crow/bundles/<id>`: that folder can be mounted into the bundle's own container,
so nothing in it decides what Crow runs. The installed folder is only the working
directory (`cwd`, `CROW_BUNDLE_DIR`) and where `.env` is written. A script whose
real path (symlinks resolved) is outside Crow's copy of the bundle is refused, and
a bundle whose source manifest Crow cannot read is not set up at all.
`timeout_s` is 1–600 (default 180). Like `postInstall`, a setup script is honored
for first-party bundles only: `origin: "community"` is refused.

**The password arrives on stdin, and nowhere else.** Crow generates it, writes one
line to the script's stdin (`<password>\n`) and closes it. It is never in the
environment, the arguments or a log, so a script that prints it is the only way it
can leak. Read it with `read -r PASSWORD` (bash) or `IFS= read -r PASSWORD` (sh).
The generated value is URL-safe, so it can start with `-`: hand it to another
program only on a stdin pipe (`printf '%s' "$PASSWORD" | app …`), never as a bare
argument — `app -x $PASSWORD` reads a leading-`-` value as an option.

A script that reaches its app through `docker exec` names the container from the
compose file's `container_name`, as `${CROW_FA_CONTAINER:-<that name>}`: the override
exists for the script's tests only, and Crow never sets it. The password goes into the
container on a pipe (`printf … | docker exec -i …`), never as a command argument — an
argument is visible in the process list on both sides.

Exit `5` exists so that a password the app really did take is never thrown away because
the script could not log in with it afterwards: a proof that fails is not a failure of
the change. Retry the proof a couple of times (an app that just restarted may not answer
yet), and exit `5` only once the app itself has confirmed the change — then Crow keeps the
password and says on the card that it could not log in with it to confirm.

The script reports what happened through its exit code:

| exit | meaning | Crow then |
|---|---|---|
| `0` | the app's admin `<user>` now has exactly that password | saves it in the keychain (Settings → Passwords), into the bundle `.env` under `secretEnv`/`userEnv` when those are declared `env_vars`, and into the bundle's `mcp-addons.json` entry when it has one |
| `3` | the app already has its own admin (set up earlier by the operator); nothing changed | leaves everything alone, and asks the operator to save the login they use |
| `4` | the app is not running / not answering; nothing changed | tells the operator to use "Set it up for me" on the Extensions card later |
| `5` | the app accepted the new password, but logging in with it did not succeed | keeps it exactly like `0` (the app holds that password now), and adds "Crow saved the new login, but could not log in with it to confirm" to the card and the install log |
| anything else, or a timeout | failed | says so on the card and in the install log |

### `setup.after`: what Crow does once the admin exists

Some apps can be given their admin from a script but keep the door open afterwards — an
app whose own registration page accepts anyone still does, even with Crow's account in
place. Those bundles declare the follow-up step beside the script:

```json
"setup": {
  "script": "scripts/first-admin.sh",
  "timeout_s": 180,
  "after": { "env": { "APP_ENABLE_REGISTRATION": "false" }, "recreate": true }
}
```

| field | rule |
|---|---|
| `env` | `KEY: value` pairs written into the installed bundle's `.env` after the setup script reports `0` or `5` (that is, once the app really holds the password). Every key must be a plain env name (`A-Z`, digits, `_`) that names an `env_vars` entry the bundle DECLARES — Crow never writes a variable the app's own manifest did not declare — and must not be `COMPOSE_…`/`DOCKER_…` (those change how compose itself runs), `firstAdmin.secretEnv` or `firstAdmin.userEnv` (Crow writes those two itself), or an entry that is `secret: true`, has `generate`, or has `keychain: true` (a value Crow keeps or generates is not a constant to write). Every value is a plain string of at most 200 characters that the `.env` codec can write (no line break or NUL, no backtick next to a quote or a trailing backslash). The write is the line-preserving one every install-time step uses (mode 600, comments and other values untouched). |
| `recreate` | boolean. `true` recreates the bundle's containers ONCE, through Crow's guarded path (the same consent + compose safety check + ownership check a Start runs, then `up -d --force-recreate`), because a container keeps its old environment until it is re-created. |

No other fields are accepted, and a block that writes nothing and recreates nothing is
refused: it would do nothing. The step runs only after a successful setup — on exit `3`
(the app already had its own admin) and `4` (not running) nothing is written and nothing is
restarted, so an install somebody set up by hand is never touched.

A failure here never undoes the account: the password is already in Crow's keychain and the
app still holds it. One plain line says what happened — `after: "applied"`, or
`after: "recreate-failed: <plain reason>"` (a settings file that would not take the value is
`after: "env-failed: <plain reason>"`) — and the answer adds that registration may still be
open and to press Restart. The line lands in the install log, and in the Extensions card's
answer; at install it also rings the owner's bell once (the same notice the card is), because
an app that still accepts sign-ups is as claimable as one nobody set up. It never fails the
install. Like every other bundle change, this one needs a `version` bump.

The script's last 20 non-empty stdout lines become part of the install log (and of
the card's answer when the run is retried from Extensions), so print what you did,
never the password. On a failure that log also carries a short tail of the script's
stderr (its last few lines, without the exit line): that is the reason the operator
reads, on the card and in the install log. Both are scrubbed before they leave
Crow — every occurrence of the generated password in a log line or a reason becomes
`[hidden]` — so an accidental `echo` never puts it in front of the operator.

When the keychain save AND the `.env` write both fail after the app's password
changed, the answer is `failed` with "the app's admin password changed but Crow
could not keep it; reset it in the app": the login now exists only inside the app,
so the card and the bell stay until the operator resets it (or saves it by hand).

The saved login also goes into the bundle's own `mcp-addons.json` entry, and the run
asks for the same gateway reload the operator's Configure save asks for: an MCP child
is spawned with ITS entry's env and never reads the bundle's `.env`, so a bundle whose
MCP server logs in (calibre-server, kavita, navidrome) would otherwise start with a
username and no password and answer 401 to every call. A bundle that declares no
`server` has no entry, and that is not an error. The install path does not restart
mid-job: it marks the install as needing one, and its single end-of-install restart
loads the entry.

Two calls in one install are not wasted: Crow never runs the script when the
keychain already holds this app's admin login, and it makes sure the keychain can be
written *before* the app's password changes — a password that nothing holds would
lock the app. Only one run per app is in flight at a time: the install path and the
Extensions card share that lock, so a second one is refused with "Crow is already
setting up this app's admin login" (409 on the card's request) instead of racing the
first.
In the Extensions card, an app whose setup Crow can do itself offers "Set it up for
me", and every card offers "Save the login you made" (the operator's own username
and password, saved under the bundle's admin key) — either one clears the card, and
so does a keychain entry the operator saved by hand. That form never replaces a
login Crow already keeps; changing one is done in Settings → Passwords. (An
invite-only app's card is different: it has neither form — see below.)

**Prefer `crow` whenever the app can take its admin from the environment or a CLI**
(Miniflux's `ADMIN_USERNAME`/`ADMIN_PASSWORD`, JupyterHub's NativeAuthenticator
bootstrapping, a `postInstall` script that drives the app's own admin command).
That is the only mode where nothing on the machine can claim the account between
install and the operator's first visit. Use a `via: "setup"` script when the app has no
environment variable for its admin but can be given one from inside its container, and
`finish-setup` when the app only has a first-run page; add a `note` when the app prints
or documents the first password (Peertube prints it in its logs; Plex's server is
claimed by the first Plex account that reaches it unless a claim token was set).

Like every other bundle change, a new or edited `firstAdmin` needs a `version`
bump: the installed copy refreshes only when the version differs.

## Invite-only apps: `firstAdmin.invite`

A few apps can be closed off completely without Crow ever creating an account:
their own admin API can INVITE an address and stop accepting sign-ups. The one that
exists today is Vaultwarden, and it is the reason the field exists — Crow can never
create a usable Vaultwarden account (its vault keys are made in the browser) and the
admin token's plaintext lives only in Crow's keychain, so this has to run in the
gateway with a secret in hand:

```json
"firstAdmin": { "mode": "finish-setup", "invite": "vaultwarden" },
"env_vars": [
  { "name": "VAULTWARDEN_SIGNUPS_ALLOWED", "default": "false" },
  { "name": "VAULTWARDEN_OWNER_EMAIL", "required": false,
    "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
    "pattern_hint": "an email address like you@example.com" }
]
```

What happens, in order:

1. At install, after `compose up` succeeded, the installer waits up to 60 s for the
   app's `/alive` to answer, then runs the handler: it logs in to the app's admin
   panel with the token from Crow's keychain, invites the address in the bundle's
   `.env` (`VAULTWARDEN_OWNER_EMAIL`), and closes sign-ups. Closing reads the app's
   WHOLE admin settings form and posts all of it back with `signups_allowed` off
   (Vaultwarden replaces its stored `config.json` with whatever the body holds, so a
   partial body would wipe SMTP and every other setting), then re-reads the app's
   state to confirm — a 200 from the app proves nothing on its own. The bundle's
   `.env` gets `VAULTWARDEN_SIGNUPS_ALLOWED=false` too. One plain sentence lands in
   the install log. A failed invite NEVER fails the install.
2. The Extensions card follows the app's own state. A registered account with
   sign-ups closed shows nothing; sign-ups still open offer **Close sign-ups**; an
   invited address (and only that: a *disabled* account does not count) with no
   account yet says to create it; no account at all asks for the email (**Invite my
   email**); an app Crow cannot read keeps today's card plus one sentence saying why.
   Accounts registered under addresses other than the one Crow invited are named on
   the card. That address is recorded in `dashboard_settings`
   (`first_admin_invited:<id>`, never synced) when an invite succeeds; the editable
   `.env` is only the install-time input, so changing it hides nobody. With no
   recorded invite, every registered address is named.
   **Done** only hides the "Crow could not read the app" card: every state that is a
   live warning (close / create / invite) shows the card again on the next render,
   whether or not Done was pressed.
3. A handler is only ever resolved from the frozen `INVITE_HANDLERS` map
   (`servers/gateway/first-admin/vaultwarden-invite.js`), and only for the bundle it
   is bound to (`inviteHandlerFor(manifest, bundleId)`); the manifest is always the
   REVIEWED one (`bundles-config.getManifest`), never `~/.crow/bundles/<id>/manifest.json`.
   Handlers talk to `http://127.0.0.1:<webUI.port of the reviewed manifest>` and
   nothing else: `VAULTWARDEN_URL` in the installed `.env` is ignored for admin
   calls, because that file is writable through `POST /bundles/api/env`.
   The app's admin cookie is kept in memory and reused while it works, because
   Vaultwarden rate-limits admin logins; a 429 reads as `rate-limited` in the card
   and in the action's answer.

A keychain entry named by a handler as its ADMIN-PANEL token (e.g.
`VAULTWARDEN_ADMIN_TOKEN`) is never treated as "the app's login": it does not hide
the card (`firstAdminSavedKey` returns null for it). The app's own state is the
signal.

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
