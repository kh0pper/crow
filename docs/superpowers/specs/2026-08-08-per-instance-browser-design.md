# Design — the per-instance browser

Written 2026-08-08. Approved by Kevin in two sections during the brainstorm.

The `crow-browser` MCP server is the last member of the defect family PR #279 fixed:
a Crow server that a bot or an operator shell resolves to an instance other than its
own. PR #279 deliberately left it, because `rebindBlock` reads its repo `cwd` as
instance-neutral. Its port says otherwise.

---

## 1. The model

**An instance either owns a browser or has none.** Owning means its own container, its
own port triple, and its own state directories, declared in that instance's own
`mcp-addons.json` under the name **`browser`**. Nothing about a browser is inherited
from a user-global config.

On this host that is two owners:

| instance | container | CDP | noVNC | RFB |
|---|---|---|---|---|
| `~/.crow` (primary) | `crow-browser` | 9222 | 6080 | 5900 |
| `~/.crow-r4` | `crow-browser-r4` | 9223 | 6081 | 5901 |

MPA gets none. It is a same-identity peer of the primary and is slated for retirement
(Item F amendment, `plans/2026-07-17-crow-state-and-direction-review.md` in Gitea
`kh0pp/crow-engineering`), so building it a browser — or a sharing mechanism — would
be work for an instance that is going away. Its two `crow-browser` selections are
dropped instead; see §4.

There is deliberately **no sharing mechanism**. An earlier draft carried a
`CROW_BROWSER_STATE_DIR` so a non-owning instance could point at an owner's browser.
Kevin's scoping decision — independent instances get their own, same-identity
co-hosting is being retired — removes the only case it served. YAGNI.

## 2. What is actually broken

Verified live on 2026-08-08. Every database claim was made against a copy of the
`.db` plus `-wal` and `-shm`, never against a running gateway's file.

1. **`~/.pi/agent/mcp.json` carries `crow-browser`** with `cwd` of
   `/home/kh0pp/crow/bundles/browser` and `CROW_BROWSER_CDP_URL=http://127.0.0.1:9222`.
   `rebindBlock`'s anchor is `INSTANCE_BUNDLE_CWD = /\/\.crow[^/]*\/bundles\/([^/]+)\/?$/`
   (`crow-server-catalog.mjs:90`), which the repo path does not match, and
   `CROW_BROWSER_CDP_URL` is not one of the four
   `INSTANCE_ENV_KEYS`. So the block reads as instance-neutral and falls through to the
   canonical branch unchanged. `~/r4-tehcy/.mcp.json` defines no browser, so pi sessions
   in the r4 tree inherit it and drive the primary's Chrome.

2. **`bundles/browser/server/server.js` disagrees with itself about `CROW_HOME`.**
   `browser-sessions` honors it (line 35); `browser-exports` (960) and
   `browser-downloads` (1411) hardcode `join(homedir(), ".crow", …)`. Two tool
   descriptions promise `~/.crow/browser-…` in prose, which is false on any instance
   but the primary.

3. **`crow-browser-r4`'s `/downloads` bind mount is the primary's directory** —
   `docker inspect` reports `/home/kh0pp/.crow/browser-downloads`. This is **not** a
   product defect: `runCompose` uses `execFile` with no `env` option
   (`servers/gateway/routes/bundles.js:702-712, 743-746`), so it inherits the gateway's
   environment, and `crow-r4-gateway.service` sets `CROW_HOME=/home/kh0pp/.crow-r4`.
   Installing through the Extensions panel would have produced the right mount. The
   container was created by hand from the bundle directory, where `CROW_HOME` was unset
   and `${CROW_HOME:-${HOME}/.crow}` silently fell back to the primary.

4. **The catalog never injects `CROW_HOME` into derived bundle blocks.** `rebindBlock`
   rewrites instance env keys only when they are *already present*. r4's `browser` addon
   carries none of the four, so the server's `CROW_HOME` comes from whatever ambient
   environment pi happened to have. `browser-sessions` directories exist under all three
   instance homes, and `~/.crow-r4/browser-sessions/brandfolder-tea.json` shows the
   ambient value *was* correct at least once — which is the point: correctness here is a
   property of the caller's shell, not of the block, and nothing makes it hold.

5. **`router: true` silently disables per-tool selection.** With it set, pi registers a
   single gateway tool `mcp__crow-browser` and no individual tools
   (`pi-lab/extensions/mcp-client.ts:399`); direct registration would name them
   `mcp__<server>__<tool>` (`:313`). `toolAllowlist()` emits
   `mcp__crow-browser__crow_browser_launch`, and pi's `--tools` filter is exact Set
   membership (`agent-session.js:1788`). So MPA's `job-searcher` and
   `job-searcher-dayane` get **zero** browser tools — and would for as long as the flag
   has been set, though I did not date when it was. They are not driving the wrong
   Chrome; they are driving none.

6. **Bundle drift in both directions.** r4's `entrypoint.sh` carries two local patches
   the repo lacks (`DISP_NUM="${DISPLAY_NUM:-99}"`, `x11vnc -noshm`). The primary's
   *installed* `entrypoint.sh` is stale against the repo — it hardcodes 6080/5900 and
   ignores `NOVNC_PORT`/`RFB_PORT`. Bundle updates deliberately never copy
   `docker-compose.yml`, `Dockerfile`, `entrypoint.sh` or `.env`
   (`servers/gateway/routes/bundles.js:513-514`), so neither drift self-heals.

**Consumers, for the record.** Only MPA's two `job-searcher` bots select `crow-browser`.
No r4 bot and no primary bot does. `bot_jobs` is empty on MPA and the only saved browser
session anywhere is r4's `brandfolder-tea.json` from 2026-07-23: in practice this is an
interactive, human-supervised tool.

### The router rule, settled

`router: true` belongs in **operator project configs** — an interactive shell has no
`--tools` allowlist, and 28 browser tools is real context cost. It belongs **absent from
addon blocks** — for a bot the per-tool allowlist *is* the permission envelope, and
collapsing 28 tools into one ungated gateway would grant navigate-anywhere,
evaluate-JS and download behind a single name. The addon blocks were already right. The
bug was bots resolving the canonical block at all.

## 3. Repo changes

**3.1 One state root.** Extract `bundles/browser/server/instance.js` — one module whose
single responsibility is answering "which instance is this server bound to":

```js
export const stateRoot = () => process.env.CROW_HOME || join(homedir(), ".crow");
export const stateDir = (name) => join(stateRoot(), name);
```

`server.js` uses it for all three directories. A separate module rather than an export
from `server.js` so the tests import twenty lines instead of dragging in playwright. Fix
the two tool descriptions to describe the resolved directory instead of asserting
`~/.crow`.

**3.2 Make the mount fail loudly.** In `bundles/browser/docker-compose.yml`, replace
`${CROW_HOME:-${HOME}/.crow}/browser-downloads` with `${CROW_HOME:?…}`. A hand-run
`docker compose up` in a second instance's bundle directory then errors instead of
quietly mounting the primary's downloads. This matches the style already in that file
(`${CROW_BROWSER_VNC_PASSWORD:?…}`) and is the precise failure that produced finding 3.
Add `CROW_HOME` to `.env.example` with a comment saying why.

**3.3 Derived bundle blocks carry their instance.** In `crowServerCatalog`'s
`mcp-addons.json` loop, set `CROW_HOME` on the resulting block. Deliberately **in that
loop and not inside `rebindBlock`**, which is also used for third-party canonical blocks
that have no business carrying an instance. Only `CROW_HOME`: injecting `CROW_DB_PATH`
would trip `touchesCrowDb()` and apply the journal guard to bundles that never open
`crow.db`.

**3.4 Settle r4's entrypoint patches on evidence, then upstream what survives.** My
first hypothesis — that two containers on `network_mode: host` collide on Xvfb's TCP
port — is **disproven**: both run `Xvfb -nolisten tcp` and nothing listens in the
6000–6099 range. So the reason for `:98` is not yet known and nothing gets upstreamed on
faith. The plan determines it empirically (run r4's container at `:99`, observe) and
upstreams only what is justified, with the reason recorded. If the patches turn out to be
incidental, the honest outcome is to drop them from r4 rather than add them to the repo.

## 4. Host changes, in order

Nothing may reference a name that is about to disappear — the ordering trap from the
previous session, where the rename had to precede the strip.

1. **Drop the dead `crow-browser/*` selections** from MPA's `job-searcher` and
   `job-searcher-dayane`. Per finding 5 these resolve to zero tools, so this removes a
   lie rather than a capability.
2. **Rename `crow-browser` → `browser`** in `~/.pi/agent/mcp.json`, bound explicitly to
   the primary: `cwd` `~/.crow/bundles/browser`, `CROW_HOME=/home/kh0pp/.crow`,
   `CROW_BROWSER_CDP_PORT=9222`, `router: true`. The *installed* bundle rather than the
   repo, because the repo tree gets branch-switched under running services — Item H's
   complaint.
3. **Add `browser` to `~/r4-tehcy/.mcp.json`**: `cwd` `~/.crow-r4/bundles/browser`,
   `CROW_HOME=/home/kh0pp/.crow-r4`, `CROW_BROWSER_CDP_PORT=9223`, `router: true`.
   Nearest-file-wins makes this authoritative in the r4 tree.
4. **Add `CROW_HOME` to both bundles' `.env`** so a hand-run compose interpolates rather
   than tripping the new `:?` guard.
5. **Verify by running, not reading.** `scripts/pi-bots/s0_mcp_probe.mjs` already exists:
   confirm pi in `~/crow` resolves `browser` to 9222 and in `~/r4-tehcy` to 9223.

**Accepted tension.** Step 2 puts an instance-bound Crow server back into the homedir
config, which PR #279's rule reserves for third-party servers carrying credentials rather
than identity. Approved deliberately: the alternative — a hand-added block in
`~/crow/.mcp.json` — does not survive, because `scripts/generate-mcp-config.js:135`
rewrites that file wholesale with no merge. Bots are unaffected either way: the catalog
is consulted before canonical, and unselected canonical names are written
`{"disabled": true}`. The exposure is limited to interactive shells, where a
primary-by-default browser is the desired behavior.

**Container handling.** Fixing `crow-browser-r4`'s mount requires **recreating** it, and
there is no volume for Chrome's profile, so anything logged in inside r4's browser is
lost — Kevin picks the moment. The primary's container is left strictly alone: its mount
is already correct and recreating it would drop logged-in job-board sessions for no gain.

**Deployment reality.** The `server.js` fix reaches instances through the Extensions
*update* path, which copies `server/`, and needs no container restart because the MCP
server is a fresh child on each pi spawn. The compose and entrypoint changes reach
nothing automatically (`routes/bundles.js:513-514`) and must be applied deliberately.

## 5. Testing

- `stateDir()` returns `<CROW_HOME>/browser-{sessions,downloads,exports}`, and falls back
  to `~/.crow` when `CROW_HOME` is unset.
- The catalog gives an r4-derived `browser` block `CROW_HOME=~/.crow-r4` and CDP 9223,
  and no value anywhere in that block containing the primary's `.crow/`. Extends the
  existing `tests/pibot-crow-server-catalog.test.js`.
- **Mutation check, not optional:** delete the §3.3 injection line and confirm the test
  goes red. The previous session's central claim shipped with no executable protection
  and its acceptance harness was bound to a scratch copy it could not have detected a
  leak through. A test that passes without the mechanism it names is worse than no test.
- The browser compose contains no `${CROW_HOME:-` default — the exact regression that
  produced finding 3.
- Full suite green, plus `node bundles/browser/server/index.js` starting cleanly.

## 6. Risk

`crow-server-catalog.mjs` lives under `scripts/pi-bots/`, inside the
`pibot-gateways@r4` soak's blast radius through ~2026-08-12. The worktree leaves `~/crow`
untouched until merge, but the post-merge `git pull` will change a file that unit's
process has already loaded, and it takes effect only on restart. `bridge.mjs` is not
touched, so its exports stay name-stable for `job_runner`; the §3.3 change is purely
additive. The pull and the restart both get logged, and `r4-deploy.sh` does not restart
that unit, so the restart is a separate deliberate step.

`check-ports` does not bite here. It only scans `bundles/*/docker-compose.yml` for
`host:container` port mappings, and the browser bundle uses `network_mode: host` with no
`ports:` list. No new host ports are introduced either — 9223/6081/5901 already exist,
and `docs/developers/port-allocation.md:66` already documents the +1 convention.

## 7. Out of scope — flagged, not fixed

- **`crow-core` in Kevin's Claude Code user config** points at
  `http://localhost:3001/router/mcp`, the **primary** gateway (r4's is 3008, MPA's 3006).
  User scope means every project, including `~/r4-tehcy`. Not the browser — the router
  exposes core categories plus `media`, not browser tools — but it is the same defect
  family through a second door.
- **`servers/gateway/router.js:105`** hardcodes `~/.crow/bundles/media`.
- **The primary's `crow-home` bot selects `crow-tasks`**, a name that exists in neither
  the registry nor any `mcp-addons.json` since the previous session's MPA-only rename. A
  one-row fix, left alone only because it is outside this change's story.

---

## Addendum — 2026-08-09, found while writing the plan

**Finding 8: the browser server ignores its own container name, and one of the calls is
destructive.** `CROW_BROWSER_CONTAINER_NAME` is declared in `manifest.json:18` as a
configurable env key, and r4's addon sets it to `crow-browser-r4` — but `server.js` never
reads it. Four `docker` invocations hardcode the string `"crow-browser"`:

| line | call | effect on a non-primary instance |
|---|---|---|
| 125 | `docker inspect … {{range .Config.Env}}` | reads the primary's VNC password |
| 127 | `docker inspect … compose.project.config_files` | finds the primary's compose file |
| 155 | `docker restart crow-browser` | **restarts the primary's container** |
| 200 | `docker inspect -f {{.State.Running}}` | `crow_browser_status` reports the primary |

Line 155 is the sharp one: r4's browser server, asked to restart its own browser, kills
the primary's Chrome and every session logged into it. Line 39's `{ name: "crow-browser" }`
is the MCP protocol server name, not a container, and stays as is.

This is the same defect as the rest of §2 — a value that looks instance-neutral and
silently resolves to the primary — so it is folded into scope as its own task rather than
deferred. `containerName()` joins `stateRoot()`/`stateDir()` in the extracted module,
which is therefore named `server/instance.js` rather than `server/paths.js`: its
responsibility is instance identity, of which paths are one part.

**Consequence for §4's verification step.** The spec proposed verifying with
`scripts/pi-bots/s0_mcp_probe.mjs`. That was an over-claim on my part — the probe is an
S0-era spike with `TARGETS` hardcoded to MPA's `tasks` and `bots-sql` bundles, not a
general resolver. Better, and available once this task lands: `crow_browser_status` today
reports neither the CDP endpoint nor the container it inspected, so the task adds
`container`, `cdp_url` and `state_root` to its payload. Verification then becomes a single
tool call per instance whose output names exactly what it bound to.

**One interaction to expect.** §3.2's `${CROW_HOME:?…}` guard makes the proxy-recreate
path at lines 136-139 (`docker compose … up -d --force-recreate`, which passes
`{ ...process.env }`) fail when `CROW_HOME` is unset. That is the correct behavior, not a
regression: the catalog injection (§3.3) and the operator blocks (§4) both guarantee it is
set on every path that should be recreating a container.
