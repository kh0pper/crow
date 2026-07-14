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
| `skills` | `["skills/<id>.md", ...]` | every path exists |
| `ports` / `port` / `webUI.port` | integers (1–65535); `webUI` may also be `null` | — |
| `requires.bundles` / `optional_bundles` | `["<bundle-id>", ...]` | each id is a `bundles/<id>` dir with a `manifest.json` (a real bundle) |
| `env_vars` | `[{ "name": "X", "description": "...", "required": false, "secret": false, "default": "" }]` | each entry has a `name` |

Unknown fields are allowed (the schema is lenient) — bundle-specific extras like `capabilities`, `companion`, `storage`, `providers`, `sttProfileSeed` pass through untouched. The canonical shape is `registry/manifest.schema.json`.

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
