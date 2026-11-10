# Add-on Walls

An add-on is the MCP server part of an installed bundle. Crow can start an add-on inside a **wall**: a sandbox built with bubblewrap (`bwrap`) in which the add-on sees only the files, the folders and the network the wall handed it.

An add-on is **walled** or **not walled**; when it cannot run inside its wall it is **off**. Every surface takes those words from one module (`scripts/addon-sandbox/words.mjs`), so a status page, a bell notice and a Fix-it card never disagree.

## One walled spawn

- New namespaces for user, PID, IPC, UTS, cgroup and network. The network namespace has loopback and nothing else.
- Every capability dropped, `--die-with-parent`, a new session, and the working directory set to the add-on's install folder.
- A seccomp filter where the architecture has one. The resulting tier reads `walled`, or `walled-noseccomp` when there is no filter table.
- The add-on inherits exactly fds 0, 1 and 2. Everything else the wall opened belongs to `bwrap` and to the in-namespace entry, not to the add-on.
- The environment is built by the wall: an allowlisted slice of the gateway's environment, the keys the bundle's registry entry declares, and the add-on's own values (its `mcp-addons.json` `env`, a connection's values). The proxy variables, `CROW_ADDON_DOOR_TOKEN_FILE` and the cache paths are the wall's own. The gateway's credential directory and every key it applied from systemd credentials never reach the child.
- The wall fails closed. If the plan, a bind fd, the relay, the seccomp program or the bubblewrap probe fails, the add-on stays **off** with a card. Crow never falls back to an unwalled spawn after a walled attempt.

## What is bound

### Its own code

The installed copy, `<CROW_HOME>/bundles/<id>`, is bound read-only at its real path. So are the checkout, the node install and the system folders. A command that lives outside them is bound read-only as well, unless it sits in a folder the add-on can write — then it is refused, because a path the add-on can rewrite is not a valid source for what it runs.

### Its own data folder

`<dataDir>/<id>` is bound read-write, opened **by fd** rather than by path, so a symlink swapped in between the check and the bind cannot redirect it. The add-on's cache lives inside it: `XDG_CACHE_HOME`, `npm_config_cache` and `UV_CACHE_DIR` all point below `<dataDir>/<id>/.cache`, and a uv project's virtualenv lives at `<dataDir>/<id>/.venv`. `TMPDIR` is `/tmp` inside the namespace.

### The checkout, and what is masked over it

Every `.env` file in a tree the wall binds is masked at any depth, and so is every generated `.mcp.json`, which holds resolved secrets. A data dir or a Crow home that sits inside the checkout is masked over that read-only bind too. A tree too large to scan is not bound at all rather than bound unscanned.

### Files the owner set

Three manifest fields name files and folders the owner chooses:

- `sandbox.files.read` — each path is bound read-only (a read grant is never widened to a write).
- `sandbox.files.write` — each path is bound read-write.
- `sandbox.files.oauthDir` — the **folder** holding an owner-named token file is bound read-write, so an app can add files beside its token.

Each bound path is the value of an environment field the owner typed. A value that is only a manifest default is refused rather than bound. Every one of these is opened by fd, and a `.env` inside a folder bound this way is masked like any other.

### Its own `.env`

Only when the manifest says `ownEnvFile: true`, and only the file `<install folder>/.env`. It is masked with every other `.env`, then bound again by fd **on top of its own mask**, read-only. A symlinked `.env` is refused: it names a file the add-on does not own.

### State folders

A few add-ons keep state directly in the Crow home (browser sessions, downloads, exports). Those folder names come from Crow's core table (`ADDON_STATE_DIRS` in `servers/shared/addon-doors.js`) — never from a manifest, because a pattern would collide with Crow's own home entries. Each existing real folder is bound read-write by fd, and only for a first-party add-on whose policy Crow reads from its own checkout.

### What is never a bind source

- The Crow home, outside this add-on's own folders: `secrets/`, `env/`, peer tokens and identity files stay out of reach.
- Crow's add-on registry (`mcp-addons.json`) and the wall settings (`addon-walls.json`).
- Anything under the data dir except this add-on's own folder. Another add-on's data is another add-on's, at either spelling of the path.
- A `.env` file, except the add-on's own file above.
- A hidden top-level entry of the owner's home, unless it is one of this add-on's own state folders. (The core table for such folders, `ADDON_TOKEN_DIRS`, is empty today; an entry is added only for a reviewed first-party need.)
- An `autostart` or `systemd` folder inside the owner's home.

## The network

The network namespace has loopback and no route out. Crow opens the way out for it: a small egress relay inside the gateway process listens on a unix socket in a fresh `0700` directory that is removed when the spawn ends. Inside the namespace, `pi_netns_entry.mjs` listens on loopback for the gateway's door port, for each listed port, and for an HTTP CONNECT proxy (port 39080, bumped when a listed port already holds it). The add-on's proxy variables point at that proxy. Every connection crosses the socket to the relay, and the relay decides.

A wall uses no host port: the socket is a unix socket, and the proxy and the forwarded loopback ports exist only inside that one add-on's namespace. See [Port Allocation](../developers/port-allocation.md).

### `"network": "none"`

No internet, no listed host. The namespace has no way out at all.

### `"network": "internet"`

HTTPS CONNECT, on port 443 only. Every address the name resolves to must be global unicast, and must be neither one of this computer's own addresses nor in the operator's egress deny list. So no LAN address, no tailnet or CGNAT address, no loopback, no cloud metadata address — and this instance's own public names and addresses are refused like any other local one.

### Listed hosts and ports

`network.hosts` names environment fields, and each field's value becomes one exact `host:port` entry. A connection to a listed entry is allowed even when its address is private or on the LAN, because the owner named it. There are no wildcards, no port ranges and no subdomains: the entry is the whole permission.

### Plain HTTP

A listed plain-HTTP address is always one the owner typed, and it is reached with an absolute-form request instead of a CONNECT: one request per connection, `Connection: close` on every answer, and the same target checks a listed CONNECT gets. The internet shape never carries plain HTTP.

### Manifest defaults

A manifest default is not a choice the owner made, so it is bound under one narrow rule: the default must be a loopback address, and the port must be one this add-on's own compose file publishes on `127.0.0.1` over TCP. For a first-party bundle both the manifest and the compose file come from Crow's own checkout; for a local or third-party bundle they come from the installed copy, and the relay still requires the port to belong to that add-on's own running compose project.

A default that names the gateway's own port is refused. A public `https:` default needs no entry of its own: with the internet, the internet shape already covers it; without it, the default is refused. Anything else is dropped and reported, and the add-on starts without that address.

### The listener-owner check

An allow list of loopback ports cannot tell an add-on's own service from the gateway, a satellite, a root daemon, the installer's reverse proxy, or another add-on's published port. So every loopback connection is judged against the kernel and docker before it is spliced:

1. The listening socket is found in `/proc/net/tcp` and `/proc/net/tcp6`. Nothing listening means refusal, and when several listeners answer on the address and port, each is judged and any refusal is the answer.
2. A socket owned by the gateway's own user is mapped to every process holding it (a socket can be shared after a fork). A gateway or satellite process is refused, in any checkout, so a co-hosted instance is caught too. An inode that maps to no process is refused, and so are the wall's own processes (the relay, the in-namespace entry, `bwrap`). Any other process of that user counts as the add-on's own service only when nothing about it — an argv element, its working directory, its executable — lies under this Crow's checkout or home; and only for an address the owner typed: a manifest default never reaches a process of this user.
3. A root-owned socket must be a port a running container publishes, and that container must carry a compose project label naming an installed add-on: this add-on, or the one named exception (the media add-on's local text-to-speech add-ons). An unlabelled project, a project of no installed add-on, and another add-on's project are all refused. A port no container publishes therefore covers tailscaled and every other root daemon.
4. Any other user is refused — the reverse proxy runs as its own user.
5. Anything that throws is a refusal, never a pass.

The answer is cached for a moment and asked again on every connection, so a port that changes hands is caught inside the cache window. A listed address that belongs to a container gets the same treatment: only this add-on's own compose project (or the named exception) may hold it.

## Doors

A few first-party add-ons need to ask the gateway for something only the gateway can do: the kiosk display state, Studio's song hub, the browser container's restart. That is a **door**.

- The door sets live in Crow's core table (`ADDON_DOORS`). A manifest can name its own set; it can never add one.
- A manifest can only ever name its own id's set. **An add-on cannot name another add-on's doors**: a listed door whose name is not its own id is refused, and doors are for first-party add-ons only.
- When the wall starts an add-on that has a door set, it mints a fresh token (32 random bytes), keeps only its sha256 in the gateway's memory, and hands the token to the walled process as **bind data**: a `0400` file at `/run/crow-addon/door-token`, named by `CROW_ADDON_DOOR_TOKEN_FILE`. It is never a file in a folder the add-on can write, and it is forgotten when the spawn ends.
- The gateway accepts a door request only for that add-on id, only for a method and path of its own set, and only with a request target that cannot be rewritten (one leading slash, no `..`, no double slash, no percent-encoding, no query).
- Every other gateway path stays unreachable from inside the wall: the gateway's loopback port is served over the doors only.

## Add-ons that share Crow's database

Some first-party add-ons read and write Crow's own database, `crow.db`, through the app modules. A wall cannot hand an add-on Crow's tables and keep those tables private at the same time, so these add-ons are not walled away from the database:

- The Crow data folder is bound read-write by fd, with every entry masked except `crow.db`, its journals (`-wal`, `-shm`), and the add-on's own folder. `tasks.db` is masked like the rest.
- Their status word says exactly that: **not walled: shares Crow's database**. The sandbox line adds "read Crow's stored keys and change its database".

The set is derived, not listed by hand: `scanCrowDb()` in `scripts/addon-sandbox/profile.mjs` reads each bundle's `server/` code, and `npm run build-registry` records the answer as `crowDb` in `registry/addon-profiles.json`. Every entry in it today is first-party — `funkwhale`, `media`, `studio`, `knowledge-base` and `data-dashboard` among them — and a new add-on that starts reading Crow's database joins the list the next time the registry is built.

## What a wall does not cover

A walled add-on is not the only way an add-on's code runs on a computer. What stays outside:

- **Bots' and satellites' copies of add-ons.** A pi bot's own sandbox is a different wall with a different policy, and the satellite agent runs its own.
- **Approved data backends.** A backend command the owner approved runs unwalled; its word is **not walled (approved commands)**.
- **Object storage.** The four bundles that read Crow's storage client receive the root object-storage credentials, and their status keeps the residual **not walled: can use all of Crow's storage**.
- **Crow's own code.** The gateway is not walled from itself, which is why a listener owned by Crow's code is never reachable from inside a wall.

Every walled add-on's status line ends with the same sentence: **Bots' and satellites' copies of add-ons, and approved data backends, are not walled.**

## The switches

### The per-host default

`CROW_ADDON_WALLS_DEFAULT` is `walled` or `off`. It is read from the gateway's own service environment — a systemd drop-in for a native install, the container environment for a container install — and never from a bundle `.env`; Crow ignores the two switch keys there. Any other value (unset, empty, a typo) reads as the code default.

The code default in this release is `off`. Merging the wall code walls nothing on any computer: a host walls its add-ons only after the operator sets `walled` for it, one host at a time, restarting that host's gateway. That is deliberate — the rollout is per host, with a before/after baseline for each one.

### The kill switch

`CROW_ADDON_WALLS=off` turns every wall off at once, whatever the per-host default or an owner's per-add-on choice says. Rollback is one setting and a restart, and it needs no migration.

Both switches live in one leaf module, `scripts/addon-sandbox/host-switch.mjs`, read from the gateway's environment. The spawn decision, the status page, the notices, the linked-add-on migration and the install-time pinning all ask that module, so they cannot disagree.

The decision order for one add-on is: kill switch, then the per-host default, then the owner's choice for that add-on, then walled. Nothing an add-on can write is consulted — not its data folder, not crow.db, not the child environment.

### The owner's choice

An owner's per-add-on choice lives in `<CROW_HOME>/addon-walls.json` (mode `0600`), not in crow.db, because several add-ons can write crow.db. Two buttons on an add-on's card use it:

- **Run without the wall** — the Fix-it remedy after a wall failure. The card carries only a random ref; the id is read from the failure record that ref names, so a copied or forged card unwalls nothing. The records live in the gateway's memory, so a card raised before a restart names nothing.
- **Wall it again** — puts the add-on back under the wall. It can only ever set `walled`.

The status word for that choice is **not walled (your choice)**.

### A computer with no usable bubblewrap

If bubblewrap is not installed at all, nothing can run walled there, and every add-on's status reads **not walled on this computer; docker reachable** — docker is still reachable from an add-on on such a host, so the line says so. Crow still starts the child with `setpriv --no-new-privs` when setpriv exists.

A bubblewrap that is installed but cannot start a sandbox here (a refused user namespace, a blocked binary, a probe that timed out) is a different answer: the add-on stays off with a card. There is no weaker tier.

## The notices

- **Per boot**, when the kill switch is set, or when walls are on here and at least one add-on or approved backend is not walled: one bell note, "Some add-ons are not walled", with one line per entry and a closing line stating the kill switch.
- **Once per computer**, on the first boot that really runs walls on: "Add-ons now run inside walls on this computer", one line per add-on saying what it can reach. The marker lives in `addon-walls.json`, not crow.db, and is set only after the note went out — a failed send retries on the next boot.
- **A host switched off by the kill switch** gets one notice worded for that case the first time it boots a build that carries walls, instead of the per-boot note, so there is one bell rather than two.
- **A change to `addon-walls.json` that Crow did not write** is reported as one note, "Add-on wall settings were changed outside Crow", and the new settings take effect at the next connect.
- **Walls off and no kill switch**: nothing is sent. An install that has not switched walls on sees no new bell.

## Status words

The words are constants in `scripts/addon-sandbox/words.mjs`, in English and Spanish.

| Word | When |
|---|---|
| `walled` | The add-on runs inside its wall. |
| `not walled: shares Crow's database` | Its server code opens crow.db, so the data folder is bound read-write for the database. |
| `not walled: can use all of Crow's storage` | A storage-reading bundle that holds the root object-storage credentials. |
| `not walled (your choice)` | The owner pressed "Run without the wall". |
| `not walled (switched off for this computer)` | The per-host default is not `walled`. |
| `not walled (switched off by the operator)` | The kill switch is set. |
| `not walled on this computer; docker reachable` | No usable bubblewrap on this computer. |
| `not walled (approved commands)` | An approved data backend. |
| `off: it could not run inside its wall` | The wall could not be built, or the add-on failed inside it. |
| `off: it stopped` | The child went away. |

## Checkout-linked add-ons

An add-on whose install folder is a symlink into a checkout — or whose `mcp-addons.json` entry keeps a `cwd`, or an absolute `command`, outside `<CROW_HOME>/bundles/<id>` — runs code from a folder the wall would not bind as its own. A host that switches walls on therefore migrates those add-ons first, through `scripts/addon-sandbox/migrate-linked.mjs`:

- It runs from `repairInstalledBundleAssets`, once per bundle, and only when walls are on for this host and the kill switch is not set. With walls off it returns before reading a file.
- It copies the source to `<CROW_HOME>/bundles/<id>.migrating` without `.venv`, `.git`, `__pycache__` or `node_modules`, then compares source and copy entry by entry — type, symlink target, file size — and only then renames the old link to `<id>.linked-<stamp>` and the copy into place.
- A data file the entry names inside the source is copied to `<dataDir>/<id>/` and the entry is repointed to the copy; the source file stays where it was.
- The entry loses `cwd`, an absolute `command` inside the source is rewritten into the copy, and the launcher is re-pinned.
- A uv project gets `UV_PROJECT_ENVIRONMENT` pointing at `<dataDir>/<id>/.venv`; the virtualenv is rebuilt by the warm-up.
- Before anything changes, the whole entry and the link target go into `<CROW_HOME>/addon-walls-migrate/` (directory `0700`, files `0600`).
- funkwhale's entry: when its owner-set URL names this computer itself, it is repointed to the loopback port its own compose publishes. The old value stays in the backup.
- An add-on with no `manifest.json` whose code is a pinned `uvx --from git+…` ref gets an empty folder with a stub manifest (its `sandbox.files.oauthDir` names its token file) instead of a copy — its code is the pinned ref, not the folder.

Rollback is `node scripts/addon-sandbox/migrate-linked.mjs --undo [<id>...]` (no id: every migrated add-on; one or more ids: just those). It renames the copy aside as `<id>.migrated-<stamp>`, renames the kept link back, and restores the entry from the newest backup, launcher pin included. It deletes nothing, the copied data stays in `<dataDir>/<id>/`, and a second `--undo` finds no live backup and does nothing. It is not gated: a rollback always works. Restart the gateway afterwards.

## Packages: pinned at install, prepared inside the wall

**Pinning** (`scripts/addon-sandbox/pin.mjs`). An `npx` package with no version is resolved once at install — `npm view <package> version dist.integrity` — and written as `<package>@<version>` plus `npx_integrity`. A `uvx` `--from` ref must already carry a full commit (`git+…@<40 hex>`) or a `==<version>`; a bare `uvx <name>` is resolved to `<name>==<version>`. An install that cannot pin is refused with a reason and writes no entry. An update re-resolves through the normal update flow only, so no registry entry keeps a floating version.

The install pin and the warm-up read a launcher's arguments with one shared reader (`launcherSpec`, `pin.mjs`). Only the options that change nothing about where the code comes from are allowed before the spec; any other one — `-p`, `--package`, `--with`, `--index-url`, an unknown flag — is refused before either of them reads a spec, so the wall can never guard one source while the child fetches another.

**Warm-up** (`scripts/addon-sandbox/warmup.mjs`). Before the first connect, Crow runs the prepare steps its plan names, each inside a wall of its own, stopping at the first one that fails. What a prepare run may reach is an exact list of package registries on port 443 — `registry.npmjs.org` for `npx`, `pypi.org` and `files.pythonhosted.org` for `uv` and `uvx`, plus `github.com` and `codeload.github.com` for a tool that is a pinned git ref. Nothing else is reachable: no general internet, no listed host of the add-on, no door, no token. A tool whose code comes from a git ref on any other host is refused, and the card reason **could not get its packages ready inside its wall** says so.

Install and build scripts of third-party packages do not run in a prepare run. `npm exec` gets `--ignore-scripts` (and `npm_config_ignore_scripts=true`), `uv` and `uvx` get `--no-build` so every dependency comes from a pre-built wheel — a dependency that ships only a source distribution fails the step and the add-on stays off. The one build a prepare run allows is the add-on's own project (`uv sync` without `--no-install-project`, after the dependencies are in place), and even that build reaches the registries only. The prepare run also gets none of the add-on's own environment: the wall hands it the plan's fixed settings and nothing else, so a warm-up cannot use the add-on's credentials.

A warm-up that fails keeps the add-on off. A spawn whose plan already succeeded is skipped as ready.

## Where the code is

| File | What it does |
|---|---|
| `scripts/addon-sandbox/host-switch.mjs` | The kill switch and the per-host default, read in one place |
| `scripts/addon-sandbox/spawn.mjs` | The mode decision and the walled spawn, with the relay, the door token and the fds in one cleanup |
| `scripts/addon-sandbox/plan.mjs` | The bind plan: read-only code, data by fd, masks, env, fds, ports |
| `scripts/addon-sandbox/profile.mjs` | What the add-on may reach, from its manifest, its entry and its compose file |
| `scripts/addon-sandbox/bind-fd.mjs` | The opens every writable bind goes through: one fd, never a path |
| `scripts/addon-sandbox/listener-owner.mjs` | The listener-owner check and the container-address check |
| `scripts/addon-sandbox/gateway-wall.mjs` | The gateway's wall context: Crow's own roots, the docker view, the host's own names, past defaults |
| `scripts/addon-sandbox/wall-env.mjs` | The child environment |
| `scripts/addon-sandbox/words.mjs` | Every status word and notice title |
| `scripts/addon-sandbox/failures.mjs` | The in-memory failure records behind a Fix-it card |
| `scripts/addon-sandbox/notice.mjs` | The bell notices and the watch on the wall settings file |
| `scripts/addon-sandbox/migrate-linked.mjs` | The checkout-linked add-on migration and its `--undo` |
| `scripts/addon-sandbox/pin.mjs` | Install-time pinning of `npx` and `uvx` launchers |
| `scripts/addon-sandbox/warmup.mjs` | The one prepare run inside a wall |
| `scripts/pi-bots/pi_egress.mjs` | The egress relay (the same relay the bots use) |
| `scripts/pi-bots/pi_netns_entry.mjs` | The in-namespace proxy and forwarded loopback ports |
| `servers/shared/addon-doors.js` | The door sets, the state-folder table and the door token |
| `servers/shared/addon-walls-file.js` | The one reader and writer of `addon-walls.json` |
| `servers/gateway/addon-env.js` | The environment rules the wall reuses |

## Related

- [Bundles — the Bundle Contract](../developers/bundles.md#the-sandbox-block) — the `sandbox` block a manifest may carry.
- [Creating Add-ons](../developers/creating-addons.md) — the same block, from a bundle author's side.
- [Port Allocation Registry](../developers/port-allocation.md) — why a wall needs no host port.
- [Gateway](./gateway.md) — the process the walls are built in.