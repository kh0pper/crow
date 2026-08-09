# Per-Instance Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each independent Crow instance own its browser — its own container, port triple and state directories — so no instance's browser server can read, write, or restart another instance's Chrome.

**Architecture:** One new module, `bundles/browser/server/instance.js`, answers "which instance am I bound to" (`stateRoot`, `stateDir`, `containerName`); `server.js` routes every path and every `docker` call through it. The compose mount loses its `~/.crow` fallback so a mis-run `docker compose up` fails loudly instead of borrowing the primary's directory. `crowServerCatalog` stamps `CROW_HOME` onto every bundle block it derives, so a bundle server is told its instance rather than inheriting it from the caller's shell. The rest is host configuration, executed in an order where nothing ever references a name that is about to disappear.

**Tech Stack:** Node 22 (ESM), `node:test` + `node:assert/strict`, playwright + Chrome DevTools Protocol, Docker Compose (`network_mode: host`), pi 0.82.0 with pi-lab's `mcp-client` extension.

**Spec:** `docs/superpowers/specs/2026-08-08-per-instance-browser-design.md` (read the Addendum — it adds finding 8 and renames the module).

## Global Constraints

- **Node 22 on every invocation:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`
- **Work in the worktree** `/home/kh0pp/crow-wt-browser`, branch `fix/per-instance-browser`, branched from `origin/main` (`53efc76a`). Never switch branches in `/home/kh0pp/crow` — it runs live services.
- **`0aad37e8 fix(35b)` is unpushed on local `main` and is not ours.** The worktree is branched from `origin/main` precisely so it cannot ride along. Never cherry-pick or rebase it in.
- **Commit with a positional path:** `git commit <exact/path> -m "..."`. For a new file, `git add <exact/path>` first, never bare `git add`. Verify with `git show --stat HEAD` after every commit.
- **Never attribute Claude.** No `Co-Authored-By` trailer, no "generated with" line.
- **Never open a running gateway's `crow.db` / `tasks.db`.** Copy the `.db` plus `-wal` and `-shm`, query the copy. The only exception is Task 7, which stops the gateways first.
- **CI:** query `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs`. Never the legacy commit-status API. Contexts are `suite`, `static-checks`, `audit`. `enforce_admins` is TRUE — a red check blocks the merge, including yours.
- **`gh` is not installed.** Use the GitHub MCP tools (`mcp__github__*`).
- **`pibot-gateways@r4` is soaking from the `/home/kh0pp/crow` working tree until ~2026-08-12.** It consumes `bridge.mjs` exports via `job_runner.mjs` — this plan does not touch `bridge.mjs`, and must not. **Log every `~/crow` pull that touches `scripts/pi-bots/` and every restart of that unit** (Task 6). `r4-deploy.sh` does not restart it.
- **A pre-existing unstaged change to `scripts/bench/h2-35b-overnight/compose-prod-snapshot.yml` lives in `~/crow` and blocks `git pull --rebase`.** Scoped-stash it, pull, pop. It is not ours.
- **Live values:** primary gateway port 3001, MPA 3006, r4 3008 (`:8449`, dashboard password `H0ust0nTX_2026`). sudo `8r00kly^`. Ports: primary browser CDP 9222 / noVNC 6080 / RFB 5900; r4 CDP 9223 / noVNC 6081 / RFB 5901.

---

## File Structure

| File | Responsibility |
|---|---|
| `bundles/browser/server/instance.js` | **New.** The single source of "which instance is this server bound to": state root, state directories, container name. No I/O, no side effects, so tests import it without pulling in playwright. |
| `bundles/browser/server/server.js` | **Modified.** Routes all three state directories and all four `docker` calls through `instance.js`. Reports what it bound to via `crow_browser_status`. |
| `bundles/browser/docker-compose.yml` | **Modified.** The downloads mount requires `CROW_HOME` instead of defaulting to `~/.crow`. |
| `bundles/browser/.env.example` | **Modified.** Documents `CROW_HOME` and why it is required. |
| `bundles/browser/manifest.json` | **Modified.** Version bump — the only thing that makes `repairInstalledBundleAssets` re-copy `server/` into installed bundles. |
| `scripts/pi-bots/crow-server-catalog.mjs` | **Modified.** Stamps `CROW_HOME` on every block derived from `mcp-addons.json`. |
| `tests/browser-bundle-instance.test.js` | **New.** The browser bundle's instance-isolation contract: paths, container name, compose. |
| `tests/pibot-crow-server-catalog.test.js` | **Modified.** Adds the `CROW_HOME`-stamping assertions. |

---

## Task 1: The instance module and one state root

**Files:**
- Create: `bundles/browser/server/instance.js`
- Create: `tests/browser-bundle-instance.test.js`
- Modify: `bundles/browser/server/server.js` (imports at 16-20; `sessionDir` at 34-35; export tool at 956 and 960; download tool at 1403 and 1411)

**Interfaces:**
- Produces: `stateRoot(): string` and `stateDir(name: string): string`, both from `bundles/browser/server/instance.js`. Task 2 adds `containerName(): string` to the same module. Task 8's verification reads the `state_root` field Task 2 adds to `crow_browser_status`.

- [ ] **Step 1: Write the failing test**

Create `tests/browser-bundle-instance.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateRoot, stateDir } from "../bundles/browser/server/instance.js";

const SERVER_JS = new URL("../bundles/browser/server/server.js", import.meta.url);

/** Run `fn` with CROW_HOME forced to `value` (or unset when value is null). */
function withCrowHome(value, fn) {
  const prev = process.env.CROW_HOME;
  if (value === null) delete process.env.CROW_HOME;
  else process.env.CROW_HOME = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME;
    else process.env.CROW_HOME = prev;
  }
}

test("every state directory derives from CROW_HOME", () => {
  withCrowHome("/tmp/scratch-crow-r4", () => {
    assert.equal(stateRoot(), "/tmp/scratch-crow-r4");
    assert.equal(stateDir("browser-sessions"), "/tmp/scratch-crow-r4/browser-sessions");
    assert.equal(stateDir("browser-downloads"), "/tmp/scratch-crow-r4/browser-downloads");
    assert.equal(stateDir("browser-exports"), "/tmp/scratch-crow-r4/browser-exports");
  });
});

test("state directories fall back to ~/.crow when CROW_HOME is unset", () => {
  withCrowHome(null, () => {
    assert.equal(stateRoot(), join(homedir(), ".crow"));
    assert.equal(stateDir("browser-downloads"), join(homedir(), ".crow", "browser-downloads"));
  });
});

test("server.js never hardcodes the primary's home", () => {
  const src = readFileSync(SERVER_JS, "utf8");
  assert.ok(
    !/join\(\s*homedir\(\)\s*,\s*"\.crow"/.test(src),
    "server.js must resolve state through stateDir(), not join(homedir(), \".crow\", ...)",
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-browser && npm test -- tests/browser-bundle-instance.test.js
```

Expected: FAIL — `Cannot find module '.../bundles/browser/server/instance.js'`.

- [ ] **Step 3: Create the module**

`bundles/browser/server/instance.js`:

```js
/**
 * Which Crow instance is this browser server bound to?
 *
 * One module, one answer. server.js used to disagree with itself: browser-sessions
 * honored CROW_HOME while browser-exports and browser-downloads hardcoded ~/.crow,
 * so a second instance on the same host wrote its downloads into the primary's
 * directory. Everything instance-scoped resolves here now.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** This instance's home. Falls back to the primary, which is correct only for the primary. */
export function stateRoot() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/** A state directory under this instance's home, e.g. stateDir("browser-downloads"). */
export function stateDir(name) {
  return join(stateRoot(), name);
}
```

- [ ] **Step 4: Run the tests — two pass, the third still fails**

```bash
npm test -- tests/browser-bundle-instance.test.js
```

Expected: the two `stateDir` tests PASS; `server.js never hardcodes the primary's home` still FAILS. That failure is the point — it is the real defect, and Step 5 fixes it.

- [ ] **Step 5: Route server.js through the module**

Add the import alongside the existing ones (after the `homedir` import at line 18):

```js
import { stateDir } from "./instance.js";
```

Replace the `sessionDir` default (lines 34-35), currently:

```js
  const sessionDir = options.sessionDir ||
    join(process.env.CROW_HOME || join(homedir(), ".crow"), "browser-sessions");
```

with:

```js
  const sessionDir = options.sessionDir || stateDir("browser-sessions");
```

Replace the export directory (line 960), currently `const exportDir = join(homedir(), ".crow", "browser-exports");`, with:

```js
        const exportDir = stateDir("browser-exports");
```

Replace the download directory (line 1411), currently `const hostDir = join(homedir(), ".crow", "browser-downloads");`, with:

```js
        const hostDir = stateDir("browser-downloads");
```

Fix the two descriptions that assert a path they no longer control. Line 956, currently `filename: z.string().optional().describe("Output filename (saved to ~/.crow/browser-exports/)"),`:

```js
      filename: z.string().optional().describe("Output filename (saved to this instance's browser-exports/ directory — see crow_browser_status for the resolved path)"),
```

Line 1403, currently `"Trigger a file download by clicking an element, and save it to the host at ~/.crow/browser-downloads/. Uses a container bind mount + CDP download behavior.",`:

```js
    "Trigger a file download by clicking an element, and save it to this instance's browser-downloads/ directory on the host (see crow_browser_status for the resolved path). Uses a container bind mount + CDP download behavior.",
```

**Remove the now-dead `homedir` import.** Those three lines were its only uses in `server.js` (verified 2026-08-09), and `node:os` is imported for nothing else, so delete the whole line at 18:

```js
import { homedir } from "node:os";
```

Keep the `join` import — it is still used throughout the file. After the edit, `grep -n 'homedir' bundles/browser/server/server.js` must return nothing.

- [ ] **Step 6: Run the tests and confirm all three pass**

```bash
npm test -- tests/browser-bundle-instance.test.js
```

Expected: PASS, 3/3.

- [ ] **Step 7: Confirm the server still starts**

```bash
cd /home/kh0pp/crow-wt-browser/bundles/browser && node server/index.js
```

Expected: starts without throwing, then hangs on stdio waiting for a client. Ctrl-C to exit. A `Cannot find module` or a thrown error here means the import path is wrong.

- [ ] **Step 8: Commit**

```bash
cd /home/kh0pp/crow-wt-browser
git add bundles/browser/server/instance.js tests/browser-bundle-instance.test.js
git commit bundles/browser/server/instance.js tests/browser-bundle-instance.test.js bundles/browser/server/server.js -m "fix(browser): resolve every state directory from CROW_HOME

server.js disagreed with itself: browser-sessions honored CROW_HOME while
browser-exports and browser-downloads hardcoded ~/.crow, so a second instance
on the same host wrote into the primary's directories. One module now answers
which instance the server is bound to."
git show --stat HEAD
```

---

## Task 2: Target this instance's container, not the primary's

**Files:**
- Modify: `bundles/browser/server/instance.js`
- Modify: `bundles/browser/server/server.js` (lines 125, 127, 155, 200; status payload at 210-219)
- Modify: `tests/browser-bundle-instance.test.js`

**Interfaces:**
- Consumes: `stateRoot()` from Task 1.
- Produces: `containerName(): string` from `bundles/browser/server/instance.js`, and three new fields on the `crow_browser_status` JSON payload — `container` (string), `cdp_url` (string), `state_root` (string). Task 8 verifies the deployment by reading exactly those three fields.

**Why this task exists:** `manifest.json:18` declares `CROW_BROWSER_CONTAINER_NAME` as configurable and r4's addon sets it to `crow-browser-r4`, but `server.js` never reads it. Line 155 is `docker restart crow-browser` — so r4's browser server, asked to restart its own browser, restarts the primary's container and destroys every session logged into it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser-bundle-instance.test.js`:

```js
test("containerName honors CROW_BROWSER_CONTAINER_NAME and defaults to crow-browser", async () => {
  const { containerName } = await import("../bundles/browser/server/instance.js");
  const prev = process.env.CROW_BROWSER_CONTAINER_NAME;
  try {
    process.env.CROW_BROWSER_CONTAINER_NAME = "crow-browser-r4";
    assert.equal(containerName(), "crow-browser-r4");
    delete process.env.CROW_BROWSER_CONTAINER_NAME;
    assert.equal(containerName(), "crow-browser");
  } finally {
    if (prev === undefined) delete process.env.CROW_BROWSER_CONTAINER_NAME;
    else process.env.CROW_BROWSER_CONTAINER_NAME = prev;
  }
});

test("no docker call in server.js hardcodes a container name", () => {
  const src = readFileSync(SERVER_JS, "utf8");
  const dockerLines = src.split("\n").filter((l) => l.includes('execFileSync("docker"'));
  assert.ok(dockerLines.length >= 4, `expected the docker calls to still exist, found ${dockerLines.length}`);
  for (const line of dockerLines) {
    assert.ok(
      !line.includes('"crow-browser"'),
      `docker call targets the primary's container by name: ${line.trim()}`,
    );
  }
});

test("crow_browser_status reports what the server bound to", () => {
  const src = readFileSync(SERVER_JS, "utf8");

  // Scope to the crow_browser_status handler only — checking the whole file lets
  // unrelated matches (e.g. a Zod field named `container` on a different tool, or
  // a pre-existing `cdp_url` in the reconnect response) pass the assertion even
  // when this handler's own payload never mentions the field.
  const statusStart = src.indexOf('"crow_browser_status"');
  assert.ok(statusStart !== -1, "could not find the crow_browser_status tool registration");
  const nextToolStart = src.indexOf("server.tool(", statusStart);
  const handlerSlice = nextToolStart === -1 ? src.slice(statusStart) : src.slice(statusStart, nextToolStart);
  assert.ok(handlerSlice.length > 0, "crow_browser_status handler slice must be non-empty");

  // Narrow further to the JSON.stringify(...) payload object itself, so the tool's
  // own description text ("Check browser container...") can't satisfy the check.
  const payloadStart = handlerSlice.indexOf("JSON.stringify(");
  assert.ok(payloadStart !== -1, "could not find the JSON.stringify(...) status payload inside the handler");
  const payloadEnd = handlerSlice.indexOf("}, null, 2)", payloadStart);
  assert.ok(payloadEnd !== -1, "could not find the end of the status payload object");
  const payloadSlice = handlerSlice.slice(payloadStart, payloadEnd);
  assert.ok(payloadSlice.length > 0, "crow_browser_status payload slice must be non-empty");

  for (const field of ["container", "cdp_url", "state_root"]) {
    // Word-boundary match: "container" must not be satisfied by "container_running".
    const re = new RegExp(`\\b${field}\\b`);
    assert.ok(re.test(payloadSlice), `crow_browser_status payload must report ${field} so a deploy can be verified by running it`);
  }
});
```

Field names carry no trailing colon here on purpose: the payload writes `container` as an ES6 shorthand property (`container,`), so a `"container:"` search would be false against the real file.

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-browser && npm test -- tests/browser-bundle-instance.test.js
```

Expected: FAIL on all three new tests — `containerName is not a function`, four hardcoded docker lines, and the three missing status fields.

- [ ] **Step 3: Add containerName to the module**

Append to `bundles/browser/server/instance.js`:

```js
/**
 * The docker container this instance's browser runs in.
 *
 * manifest.json declares CROW_BROWSER_CONTAINER_NAME and r4's addon sets it, but
 * server.js used to hardcode "crow-browser" in all four of its docker calls — one
 * of which is `docker restart`, so a secondary instance restarting "its" browser
 * killed the primary's Chrome and every session logged into it.
 */
export function containerName() {
  return process.env.CROW_BROWSER_CONTAINER_NAME || "crow-browser";
}
```

- [ ] **Step 4: Use it in server.js**

Extend the Task 1 import to:

```js
import { stateDir, containerName } from "./instance.js";
```

Add a resolved constant next to `cdpUrl` in `createBrowserServer` (after the `vncPort` line, line 36):

```js
  const container = containerName();
```

Replace the four hardcoded names. Line 125:

```js
            const env = execFileSync("docker", ["inspect", container, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { timeout: 10000 }).toString();
```

Line 127:

```js
            composeFile = execFileSync("docker", ["inspect", container, "--format", '{{index .Config.Labels "com.docker.compose.project.config_files"}}'], { timeout: 10000 }).toString().trim();
```

Line 155:

```js
            execFileSync("docker", ["restart", container], { timeout: 30000 });
```

Line 200:

```js
          const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf-8", timeout: 5000 }).trim();
```

Leave line 39 (`{ name: "crow-browser", version: "0.1.0" }`) alone — that is the MCP protocol server name, not a container.

Extend the `crow_browser_status` payload (lines 213-218) to name what it bound to:

```js
          text: JSON.stringify({
            container,
            container_running: containerRunning,
            cdp_url: cdpUrl,
            cdp_connected: cdpConnected,
            state_root: stateRoot(),
            current_url: currentUrl,
            vnc_url: containerRunning ? `http://localhost:${vncPort}/vnc.html` : null,
          }, null, 2),
```

That needs `stateRoot` in the import too:

```js
import { stateDir, stateRoot, containerName } from "./instance.js";
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- tests/browser-bundle-instance.test.js
```

Expected: PASS, 6/6.

- [ ] **Step 6: Confirm the server still starts**

```bash
cd /home/kh0pp/crow-wt-browser/bundles/browser && node server/index.js
```

Expected: starts clean, hangs on stdio. Ctrl-C.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-browser
git commit bundles/browser/server/instance.js bundles/browser/server/server.js tests/browser-bundle-instance.test.js -m "fix(browser): act on this instance's container, never a hardcoded one

CROW_BROWSER_CONTAINER_NAME was declared in the manifest and set by r4's addon
but never read. Four docker calls named \"crow-browser\" outright, including a
restart — so r4's browser server restarted the primary's container. Status now
reports the container, CDP endpoint and state root it resolved, which is what
makes a deploy verifiable by running it rather than reading it."
git show --stat HEAD
```

---

## Task 3: Make a mis-run compose fail loudly

**Files:**
- Modify: `bundles/browser/docker-compose.yml` (the `volumes:` entry)
- Modify: `bundles/browser/.env.example`
- Modify: `tests/browser-bundle-instance.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks. Task 8 relies on the guard being present when it recreates r4's container.

**Why this task exists:** `crow-browser-r4`'s `/downloads` is bind-mounted to `/home/kh0pp/.crow/browser-downloads` — the primary's. Not a product defect: `runCompose` inherits the gateway's env (`routes/bundles.js:702-712, 743-746`) and `crow-r4-gateway.service` sets `CROW_HOME`. The container was created by hand from the bundle directory, where `CROW_HOME` was unset and `${CROW_HOME:-${HOME}/.crow}` silently fell back.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser-bundle-instance.test.js`:

```js
test("the downloads mount requires CROW_HOME instead of defaulting to the primary", () => {
  const compose = readFileSync(new URL("../bundles/browser/docker-compose.yml", import.meta.url), "utf8");
  assert.ok(
    !compose.includes("${CROW_HOME:-"),
    "a CROW_HOME default lets a hand-run compose mount the primary's downloads into a second instance's container",
  );
  assert.match(compose, /\$\{CROW_HOME:\?/, "the mount must fail loudly when CROW_HOME is unset");
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-browser && npm test -- tests/browser-bundle-instance.test.js
```

Expected: FAIL — "a CROW_HOME default lets a hand-run compose mount…".

- [ ] **Step 3: Change the mount**

In `bundles/browser/docker-compose.yml`, replace:

```yaml
      - ${CROW_HOME:-${HOME}/.crow}/browser-downloads:/downloads
```

with:

```yaml
      # No default: a second instance whose CROW_HOME is unset must fail here rather
      # than silently mount the primary's downloads directory into its container.
      - ${CROW_HOME:?CROW_HOME is required so each instance writes downloads to its own directory}/browser-downloads:/downloads
```

Do not put `}`, `{` or `:` inside the error message — Compose's `${VAR:?err}` parsing ends at the first `}`.

- [ ] **Step 4: Document it in `.env.example`**

Append to `bundles/browser/.env.example`:

```
# Required. The Crow instance this browser belongs to — decides where downloads,
# exports and saved sessions land. The gateway sets it automatically when you
# install through the Extensions panel; set it here if you run docker compose by
# hand, or the mount will refuse to start.
CROW_HOME=/home/youruser/.crow
```

- [ ] **Step 5: Verify Compose still parses, and that the guard actually bites**

```bash
cd /home/kh0pp/crow-wt-browser/bundles/browser
CROW_HOME=/tmp/scratch-crow CROW_BROWSER_VNC_PASSWORD=x docker compose config >/dev/null && echo "PARSES OK"
env -u CROW_HOME CROW_BROWSER_VNC_PASSWORD=x docker compose config >/dev/null 2>&1 && echo "GUARD FAILED TO BITE" || echo "GUARD BITES OK"
```

Expected: `PARSES OK` then `GUARD BITES OK`. This is a config parse only — it starts nothing and touches no running container.

- [ ] **Step 6: Run the tests**

```bash
cd /home/kh0pp/crow-wt-browser && npm test -- tests/browser-bundle-instance.test.js
```

Expected: PASS, 7/7.

- [ ] **Step 7: Commit**

```bash
git commit bundles/browser/docker-compose.yml bundles/browser/.env.example tests/browser-bundle-instance.test.js -m "fix(browser): require CROW_HOME for the downloads mount

The :- default is how crow-browser-r4 ended up bind-mounted to the primary's
browser-downloads: created by hand from the bundle dir, where CROW_HOME was
unset. Installing through the Extensions panel was always correct, since
runCompose inherits the gateway's env. Now the hand path fails instead of
borrowing."
git show --stat HEAD
```

---

## Task 4: Stamp CROW_HOME on every derived bundle block

**Files:**
- Modify: `scripts/pi-bots/crow-server-catalog.mjs` (the `readAddons` loop, lines 206-215)
- Modify: `tests/pibot-crow-server-catalog.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: every block in `crowServerCatalog().servers` that came from `mcp-addons.json` now carries `env.CROW_HOME === crowHome`. Task 7's operator blocks set `CROW_HOME` explicitly and do not depend on this; bots do.

**Why this task exists:** `rebindBlock` rewrites instance env keys only when they are *already present*. r4's `browser` addon carries none of the four, so the spawned server's `CROW_HOME` came from whatever ambient environment pi happened to have.

- [ ] **Step 1: Write the failing tests**

In `tests/pibot-crow-server-catalog.test.js`, add `homedir` to the existing `node:os` import so it reads:

```js
import { tmpdir, homedir } from "node:os";
```

Then add a fixture and two tests. Put the fixture next to `instanceB()` near the top of the file:

```js
/** An instance home with a browser bundle whose addon names no instance env at all. */
function instanceBrowser() {
  const dir = mkdtempSync(join(tmpdir(), "instBrowser-"));
  const home = join(dir, ".crow-r4");
  mkdirSync(join(home, "bundles", "browser"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    browser: {
      command: "node",
      args: ["server/index.js"],
      env: { CROW_BROWSER_CDP_PORT: "9223", CROW_BROWSER_CONTAINER_NAME: "crow-browser-r4" },
    },
  }));
  return { dir, home };
}
```

And the tests at the end of the file:

```js
test("catalog stamps CROW_HOME on every bundle server it derives", () => {
  const { home } = instanceB();
  const { servers } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.equal(servers.tasks.env.CROW_HOME, home,
    "a bundle server must be TOLD its instance, not inherit it from the caller's shell");
});

test("a derived browser block names its own instance and never the primary", () => {
  const { home } = instanceBrowser();
  const { servers } = crowServerCatalog(home, { binding: BINDING_B(home) });
  const block = servers.browser;
  assert.ok(block, "the browser addon should be in the catalog");
  assert.equal(block.env.CROW_HOME, home);
  assert.equal(block.env.CROW_BROWSER_CDP_PORT, "9223", "the addon's own port must survive the stamp");
  assert.equal(block.env.CROW_BROWSER_CONTAINER_NAME, "crow-browser-r4");
  assert.equal(block.cwd, join(home, "bundles", "browser"));

  const primary = join(homedir(), ".crow");
  for (const [k, v] of Object.entries(block.env)) {
    assert.ok(v !== primary && !String(v).startsWith(primary + "/"),
      `browser block env ${k} points at the primary instance: ${v}`);
  }
  assert.ok(!block.cwd.startsWith(primary + "/"), `browser block cwd points at the primary: ${block.cwd}`);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-browser && npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: FAIL on both new tests — `expected undefined to equal '<home>'`.

- [ ] **Step 3: Stamp the block**

In `scripts/pi-bots/crow-server-catalog.mjs`, the addon loop currently reads:

```js
    const r = rebindBlock(id, { ...addon, cwd }, binding, crowHome);
    if (r.disabled) unconfigured[id] = r.reason;
    else servers[id] = r.block;
```

Replace with:

```js
    const r = rebindBlock(id, { ...addon, cwd }, binding, crowHome);
    if (r.disabled) {
      unconfigured[id] = r.reason;
    } else {
      // A bundle server runs UNDER this instance, so it must be told which one.
      // rebindBlock only rewrites instance keys a block already carries, and most
      // addon blocks carry none — which left CROW_HOME to whatever ambient
      // environment the caller happened to have (the browser bundle wrote its
      // sessions wherever that pointed). CROW_HOME only: injecting CROW_DB_PATH
      // would trip touchesCrowDb() and apply the journal guard to bundles that
      // never open crow.db.
      r.block.env = { ...(r.block.env || {}), CROW_HOME: crowHome };
      servers[id] = r.block;
    }
```

Deliberately here and not inside `rebindBlock`: that function is also used for third-party canonical blocks, which have no business carrying an instance.

- [ ] **Step 4: Run and confirm the tests pass**

```bash
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: PASS, whole file.

- [ ] **Step 5: Mutation check — prove the tests can actually fail**

This step is mandatory, not optional. The previous session in this defect family shipped a design whose central claim had no executable protection, and an acceptance harness bound to a scratch copy that could not have detected a real leak. A test that passes without the mechanism it names is worse than no test.

Comment out the stamping line:

```js
      // r.block.env = { ...(r.block.env || {}), CROW_HOME: crowHome };
```

Then:

```bash
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: FAIL on both new tests. If either still passes, the test is vacuous — fix the test before restoring the line.

Restore the line and re-run:

```bash
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit scripts/pi-bots/crow-server-catalog.mjs tests/pibot-crow-server-catalog.test.js -m "fix(pi-bots): a derived bundle block must name its own instance

rebindBlock only rewrites instance env keys a block already carries, and most
addon blocks carry none — so a bundle server's CROW_HOME came from whatever
ambient environment pi happened to have. Stamp it in the addon loop, not in
rebindBlock, which also serves third-party blocks that carry no instance."
git show --stat HEAD
```

---

## Task 5: Version bump, full suite, PR, green CI, merge

**Files:**
- Modify: `bundles/browser/manifest.json` (`version`)
- Modify: `registry/add-ons.json` (regenerated — it is a generated snapshot that pins each bundle's version, so bumping the manifest without rebuilding it drifts and reddens both `tests/bundle-contract.test.js` and `tests/bundle-provider-audit.test.js`, plus the `static-checks` CI job)

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a merge commit on `main`. Task 6 deploys it.

**Why the version bump:** `repairInstalledBundleAssets` runs on every gateway start, but `refreshVersionedBundle` returns early unless the repo and installed `manifest.json` versions differ (`routes/bundles.js:497`). Without the bump the `server/` fix never reaches `~/.crow/bundles/browser` or `~/.crow-r4/bundles/browser`, and the whole change is inert on the host.

- [ ] **Step 1: Bump the version**

In `bundles/browser/manifest.json`, change `"version": "1.0.0",` to:

```json
  "version": "1.1.0",
```

- [ ] **Step 1b: Regenerate the add-ons registry**

`registry/add-ons.json` is generated and checked in, and it carries `"version": "1.0.0"` for the `browser` bundle. Bumping the manifest alone leaves the two out of step.

```bash
cd /home/kh0pp/crow-wt-browser && npm run build-registry
git diff --stat registry/add-ons.json
```

Expected: `registry/add-ons.json` changes, and the browser entry's `version` now reads `1.1.0`. Confirm the diff touches only version-related fields for this bundle — if it rewrites unrelated entries, stop and report, because that means the checked-in snapshot was already stale for some other reason.

- [ ] **Step 2: Run the full suite**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-browser && npm test 2>&1 | tail -30
```

Expected: all pass, 0 failures. Baseline before this change was 2961 passing; this plan adds 7 in `browser-bundle-instance.test.js` and 2 in `pibot-crow-server-catalog.test.js`. Record the actual numbers — do not assert a count you did not see.

- [ ] **Step 3: Run the static checks CI will run**

```bash
cd /home/kh0pp/crow-wt-browser
node scripts/check-port-allocation.js && echo "PORTS OK"
node scripts/build-registry.mjs --check && echo "REGISTRY OK"
```

Expected: both OK. `check-ports` only scans `bundles/*/docker-compose.yml` for `host:container` mappings and the browser bundle uses `network_mode: host` with no `ports:` list, so it should be unaffected — but run it rather than assume.

- [ ] **Step 4: Commit the bump and push**

```bash
git commit bundles/browser/manifest.json registry/add-ons.json -m "chore(browser): 1.0.0 -> 1.1.0 so installed bundles refresh

repairInstalledBundleAssets only re-copies server/ when the manifest versions
differ, so without this the instance fixes never reach ~/.crow/bundles/browser
or ~/.crow-r4/bundles/browser. registry/add-ons.json is generated and pins the
same version, so it is regenerated in the same commit."
git show --stat HEAD
git push -u origin fix/per-instance-browser
```

- [ ] **Step 5: Open the PR**

Use `mcp__github__create_pull_request` — `gh` is not installed. Owner `kh0pper`, repo `crow`, base `main`, head `fix/per-instance-browser`.

Title: `fix(browser): each instance gets its own browser`

Body: summarize the nine findings, the four repo changes, and state explicitly that the host sequence (Tasks 6-8) follows separately and that r4's container is recreated in an operator window. No `Co-Authored-By` trailer, no "generated with" line.

- [ ] **Step 6: Wait for CI and verify every check**

```bash
SHA=$(git rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('total', d['total_count']); [print(r['name'], r['status'], r['conclusion']) for r in d['check_runs']]"
```

Expected: `total 3` or more, every run `completed` / `success`, covering `suite`, `static-checks`, `audit`. An empty `check_runs` on a current sha means something is **wrong**, not that CI is idle — the `Tests` workflow has no path filters and every commit gets check-runs. Never use the legacy commit-status API; it omits Actions and can read green while a check is red.

- [ ] **Step 7: Merge**

Merge with `mcp__github__merge_pull_request` once every check is green. `enforce_admins` is TRUE, so a red check blocks the merge — do not try to work around it.

---

## Task 6: Deploy to both instances

**Files:** none in the repo. This task changes the host.

**Interfaces:**
- Consumes: the merged `main` from Task 5.
- Produces: `~/.crow/bundles/browser/server/instance.js` and `~/.crow-r4/bundles/browser/server/instance.js` present on disk, with the fixed `server.js` beside them. Task 7 points MCP config at those directories.

**Soak coordination:** this pull touches `scripts/pi-bots/crow-server-catalog.mjs`, inside `pibot-gateways@r4`'s blast radius. `bridge.mjs` is untouched, so its exports stay name-stable for `job_runner.mjs`. Log the pull and the restart.

- [ ] **Step 1: Log the pull before making it**

Append to the soak log the operator keeps for this unit, or create `~/crow-soak-log.md` if absent:

```
2026-08-09 <HH:MM> CDT — ~/crow pull for PR "fix(browser): each instance gets its own browser".
Touches scripts/pi-bots/crow-server-catalog.mjs (adds a CROW_HOME stamp in the
mcp-addons loop; additive). bridge.mjs UNTOUCHED — job_runner exports unchanged.
pibot-gateways@r4 restarted at <HH:MM> to pick it up.
```

- [ ] **Step 2: Pull into the live tree, working around the pre-existing dirty file**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow
git stash push -m "not-ours: 35b compose snapshot" scripts/bench/h2-35b-overnight/compose-prod-snapshot.yml
git pull --rebase
git stash pop
git log --oneline -3
```

Expected: the merge commit from Task 5 is present, and `0aad37e8 fix(35b)` is still sitting unpushed on top or rebased above it — either is fine, it is not ours to ship. Confirm `git status --short` shows the compose snapshot modified again after the pop.

- [ ] **Step 3: Restart both gateways so `repairInstalledBundleAssets` refreshes the bundles**

```bash
echo 8r00kly^ | sudo -S systemctl restart crow-gateway crow-r4-gateway
sleep 10
systemctl is-active crow-gateway crow-r4-gateway
```

Expected: `active` twice. This restarts the gateways, not the browser containers — Chrome is untouched.

- [ ] **Step 4: Verify both installed bundles actually refreshed**

```bash
for d in /home/kh0pp/.crow /home/kh0pp/.crow-r4; do
  echo "== $d"
  ls -la $d/bundles/browser/server/instance.js 2>&1
  grep -c 'stateDir(' $d/bundles/browser/server/server.js 2>/dev/null
  python3 -c "import json;print('installed version', json.load(open('$d/bundles/browser/manifest.json'))['version'])"
done
```

Expected for both: `instance.js` exists, `server.js` contains 3 `stateDir(` calls, manifest version `1.1.0`. If a bundle did not refresh, check the gateway's startup log for the `refreshed 1.0.0 -> 1.1.0` line before touching anything by hand — the product path is the one that has to work.

- [ ] **Step 5: Restart the soaking bot unit and confirm it comes back**

```bash
echo 8r00kly^ | sudo -S systemctl restart pibot-gateways@r4
sleep 10
systemctl is-active pibot-gateways@r4
journalctl -u pibot-gateways@r4 -n 30 --no-pager
```

Expected: `active`, no errors about missing exports from `bridge.mjs`. Record the restart time in the soak log from Step 1.

---

## Task 7: The host MCP configuration sequence

**Files:** none in the repo. This task changes `~/.pi/agent/mcp.json`, `~/r4-tehcy/.mcp.json`, two bundle `.env` files, and two bot definitions in MPA's database.

**Interfaces:**
- Consumes: Task 6's refreshed bundles at `~/.crow/bundles/browser` and `~/.crow-r4/bundles/browser`.
- Produces: `browser` resolving to 9222 in `~/crow` and 9223 in `~/r4-tehcy`; no `crow-browser` anywhere.

**Order is load-bearing.** Nothing may reference a name that is about to disappear — the trap from the previous session, where the rename had to precede the strip.

- [ ] **Step 1: Back everything up**

```bash
TS=$(date +%Y%m%d-%H%M%S)
cp ~/.pi/agent/mcp.json ~/.pi/agent/mcp.json.bak.$TS
cp ~/r4-tehcy/.mcp.json ~/r4-tehcy/.mcp.json.bak.$TS
echo 8r00kly^ | sudo -S systemctl stop crow-mpa-gateway pibot-gateways@crow-mpa pibot-discord@crow-mpa
sleep 3
for f in ~/.crow-mpa/data/crow.db ~/.crow-mpa/data/crow.db-wal ~/.crow-mpa/data/crow.db-shm; do
  [ -f "$f" ] && cp "$f" "$f.bak.$TS"
done
echo "backed up with suffix .bak.$TS"
```

MPA's gateways must be **stopped** before its database is written — this is the one place in the plan that opens a real `crow.db` for writing, and it is safe only because nothing is serving it.

- [ ] **Step 2: Drop the dead `crow-browser` selections from MPA's two bots**

Per finding 5 these resolve to zero tools today (`router: true` means pi registers only `mcp__crow-browser`, while the allowlist names `mcp__crow-browser__<tool>` and pi's `--tools` filter is exact-match). This removes a lie, not a capability.

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node -e '
const D = require("/home/kh0pp/crow/node_modules/better-sqlite3");
const db = new D("/home/kh0pp/.crow-mpa/data/crow.db");
const rows = db.prepare("select bot_id, definition from pi_bot_defs").all();
let changed = 0;
for (const r of rows) {
  const d = JSON.parse(r.definition);
  const sel = d.tools && d.tools.crow_mcp;
  if (!Array.isArray(sel)) continue;
  const kept = sel.filter((s) => s.split("/")[0] !== "crow-browser");
  if (kept.length === sel.length) continue;
  d.tools.crow_mcp = kept;
  db.prepare("update pi_bot_defs set definition = ?, updated_at = datetime(\"now\") where bot_id = ?")
    .run(JSON.stringify(d), r.bot_id);
  console.log(r.bot_id, sel.length, "->", kept.length);
  changed++;
}
console.log("bots changed:", changed);
'
```

Expected: `job-searcher 34 -> 29`, `job-searcher-dayane` similarly, `bots changed: 2`. If any other bot appears, stop and re-read — only those two should select `crow-browser`.

- [ ] **Step 3: Verify no selection of `crow-browser` remains anywhere**

```bash
for i in .crow .crow-r4 .crow-mpa; do
  node -e "
const D = require(\"/home/kh0pp/crow/node_modules/better-sqlite3\");
const db = new D(\"/home/kh0pp/$i/data/crow.db\", { readonly: true });
for (const r of db.prepare(\"select bot_id, definition from pi_bot_defs\").all()) {
  // Check the SELECTIONS, not the raw definition JSON — several bots mention
  // crow-browser tool names in their system_prompt prose, which is stale text
  // but not a resolvable server reference and not what this step is about.
  const d = JSON.parse(r.definition);
  const servers = new Set(((d.tools && d.tools.crow_mcp) || []).map((s) => s.split(\"/\")[0]));
  if (servers.has(\"crow-browser\")) console.log(\"$i\", r.bot_id, \"STILL SELECTS crow-browser\");
}
console.log(\"$i checked\");
"
done
```

Expected: three `checked` lines and no `STILL SELECTS`. Read `.crow` and `.crow-r4` directly only because their gateways are running and this is a **readonly** open of a file nothing is mid-write on — if this makes you uneasy, copy the db plus `-wal` and `-shm` first and query the copies.

- [ ] **Step 4: Restart MPA's services**

```bash
echo 8r00kly^ | sudo -S systemctl start crow-mpa-gateway pibot-gateways@crow-mpa pibot-discord@crow-mpa
sleep 8
systemctl is-active crow-mpa-gateway pibot-gateways@crow-mpa pibot-discord@crow-mpa
```

Expected: `active` three times.

- [ ] **Step 5: Rename `crow-browser` to `browser` in the homedir config, bound to the primary**

Edit `~/.pi/agent/mcp.json`. Remove the `crow-browser` entry entirely and add, in its place:

```json
    "browser": {
      "command": "/home/kh0pp/.nvm/versions/node/v22.23.1/bin/node",
      "args": ["server/index.js"],
      "cwd": "/home/kh0pp/.crow/bundles/browser",
      "env": {
        "CROW_HOME": "/home/kh0pp/.crow",
        "CROW_BROWSER_CDP_PORT": "9222",
        "CROW_BROWSER_CONTAINER_NAME": "crow-browser"
      },
      "router": true
    }
```

Three deliberate choices. `cwd` is the **installed** bundle, not `/home/kh0pp/crow/bundles/browser` — the repo tree gets branch-switched under running services, which is Item H's complaint. `router: true` stays because this serves interactive shells, which have no `--tools` allowlist and would otherwise carry 28 tool schemas. And this is an instance-bound Crow server living in the homedir config, which PR #279's rule reserves for third-party servers — an accepted, approved exception, because `generate-mcp-config.js:135` rewrites `~/crow/.mcp.json` wholesale and a hand-added block there would not survive.

Validate before moving on:

```bash
python3 -c "import json; d=json.load(open('/home/kh0pp/.pi/agent/mcp.json')); print(sorted(d['mcpServers']))"
```

Expected: `['brave-search', 'browser', 'google-workspace', 'google-workspace-dayane']` — no `crow-browser`.

- [ ] **Step 6: Add the r4-bound override**

Edit `~/r4-tehcy/.mcp.json` and add, alongside the existing `r4-tasks` / `r4-trackers` / `crow-memory` entries:

```json
    "browser": {
      "command": "/home/kh0pp/.nvm/versions/node/v22.23.1/bin/node",
      "args": ["server/index.js"],
      "cwd": "/home/kh0pp/.crow-r4/bundles/browser",
      "env": {
        "CROW_HOME": "/home/kh0pp/.crow-r4",
        "CROW_BROWSER_CDP_PORT": "9223",
        "CROW_BROWSER_CONTAINER_NAME": "crow-browser-r4"
      },
      "router": true
    }
```

pi merges the homedir config first and then every cwd-ancestor `.mcp.json` from the filesystem root down, so the nearest file wins on collision — this block is authoritative anywhere under `~/r4-tehcy`. No VNC password here: `crow_browser_launch` reads it from the running container when it needs it, so there is no reason to spread the credential.

Validate:

```bash
python3 -c "
import json
d = json.load(open('/home/kh0pp/r4-tehcy/.mcp.json'))['mcpServers']['browser']
print(d['cwd'], d['env']['CROW_BROWSER_CDP_PORT'], d['env']['CROW_HOME'])"
```

Expected: `/home/kh0pp/.crow-r4/bundles/browser 9223 /home/kh0pp/.crow-r4`.

- [ ] **Step 7: Give both bundle `.env` files a CROW_HOME**

Task 3's guard makes a hand-run compose fail without it.

```bash
grep -q '^CROW_HOME=' /home/kh0pp/.crow/bundles/browser/.env || echo 'CROW_HOME=/home/kh0pp/.crow' >> /home/kh0pp/.crow/bundles/browser/.env
grep -q '^CROW_HOME=' /home/kh0pp/.crow-r4/bundles/browser/.env || echo 'CROW_HOME=/home/kh0pp/.crow-r4' >> /home/kh0pp/.crow-r4/bundles/browser/.env
tail -3 /home/kh0pp/.crow/bundles/browser/.env /home/kh0pp/.crow-r4/bundles/browser/.env
```

Expected: each file ends with its own instance's `CROW_HOME`. Note `~/.crow/bundles/browser/.env` currently has no `CROW_BROWSER_CONTAINER_NAME`; the default is `crow-browser`, which is correct, so leave it.

- [ ] **Step 8: Verify by running, not by reading**

For each tree, start pi, call the browser gateway's status action, and read what it says it bound to. From `~/crow`:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow
node /home/kh0pp/.crow/bundles/browser/server/index.js < /dev/null &
```

That only proves the file runs. The real check spawns the server exactly as pi would and calls the tool. Write a throwaway probe at `/tmp/browser-probe.mjs`:

```js
import { spawn } from "node:child_process";
const [cwd, ...envPairs] = process.argv.slice(2);
const env = { ...process.env };
for (const p of envPairs) { const i = p.indexOf("="); env[p.slice(0, i)] = p.slice(i + 1); }
const child = spawn("node", ["server/index.js"], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  for (const line of buf.split("\n").slice(0, -1)) {
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crow_browser_status", arguments: {} } }) + "\n");
    }
    if (msg.id === 2) { console.log(msg.result.content[0].text); child.kill(); process.exit(0); }
  }
  buf = buf.slice(buf.lastIndexOf("\n") + 1);
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }) + "\n");
```

Run it against each instance's resolved block:

```bash
node /tmp/browser-probe.mjs /home/kh0pp/.crow/bundles/browser \
  CROW_HOME=/home/kh0pp/.crow CROW_BROWSER_CDP_PORT=9222 CROW_BROWSER_CONTAINER_NAME=crow-browser

node /tmp/browser-probe.mjs /home/kh0pp/.crow-r4/bundles/browser \
  CROW_HOME=/home/kh0pp/.crow-r4 CROW_BROWSER_CDP_PORT=9223 CROW_BROWSER_CONTAINER_NAME=crow-browser-r4
```

Expected — the primary reports `"container": "crow-browser"`, `"cdp_url": "http://127.0.0.1:9222"`, `"state_root": "/home/kh0pp/.crow"`; r4 reports `crow-browser-r4`, `http://127.0.0.1:9223`, `/home/kh0pp/.crow-r4`. Both should show `"container_running": true`. **If r4's status reports `crow-browser` or `/home/kh0pp/.crow`, stop** — Task 2 or Task 6 did not land, and continuing would paper over it.

- [ ] **Step 9: Confirm pi itself resolves the override**

The probe proves the servers behave; this proves pi picks the right block. In `~/r4-tehcy`, start a pi session and have it call the browser gateway tool with `action="call"`, `tool="crow_browser_status"`. Confirm the returned JSON names `crow-browser-r4` and port 9223. Then do the same from `~/crow` and confirm `crow-browser` and 9222.

This is the step that actually closes the reported defect — everything before it is machinery. Do not skip it because the probe passed; the probe supplies the env by hand, and the whole bug was that pi supplied it differently.

---

## Task 8: Operator window — recreate r4's container

**Files:** possibly `bundles/browser/entrypoint.sh`, depending on what Step 2 finds.

**Interfaces:**
- Consumes: Tasks 3, 6 and 7 complete.
- Produces: `crow-browser-r4` bind-mounted to `/home/kh0pp/.crow-r4/browser-downloads`, and a decision on r4's local entrypoint patches.

**Requires Kevin.** Recreating the container discards Chrome's profile — there is no volume for it — so anything logged in inside r4's browser is lost. **The primary's container is not touched**: its mount is already correct and recreating it would drop logged-in job-board sessions for nothing.

- [ ] **Step 1: Confirm the operator is ready and record the current state**

```bash
docker inspect crow-browser-r4 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
docker inspect crow-browser-r4 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'DISPLAY|CDP_PORT|NOVNC|RFB'
ls /home/kh0pp/.crow-r4/browser-sessions/
```

Expected: mount shows `/home/kh0pp/.crow/browser-downloads` (the bug), env shows `DISPLAY_NUM=98`, `CDP_PORT=9223`. Saved sessions under `~/.crow-r4/browser-sessions/` live on the host and survive the recreate.

- [ ] **Step 2: Settle the entrypoint patches empirically**

r4's `~/.crow-r4/bundles/browser/entrypoint.sh` differs from the repo in exactly two ways: `DISP_NUM="${DISPLAY_NUM:-99}"` instead of a hardcoded `99`, and `x11vnc … -noshm`. Nobody recorded why. The obvious hypothesis — two containers on `network_mode: host` colliding on Xvfb's TCP port — is **disproven**: both run `Xvfb -nolisten tcp` and nothing listens in 6000-6099. Do not upstream a patch whose reason is unknown.

Test it directly. With `CROW_BROWSER_DISPLAY` removed from r4's `.env`, recreate and observe:

```bash
cd /home/kh0pp/.crow-r4/bundles/browser
cp .env .env.bak.$(date +%Y%m%d-%H%M%S)
sed -i 's/^CROW_BROWSER_DISPLAY=98/CROW_BROWSER_DISPLAY=99/' .env
docker compose up -d --force-recreate
sleep 15
docker logs crow-browser-r4 --tail 40
curl -s http://127.0.0.1:9223/json/version | head -3
```

Two outcomes, both useful:
- **Both containers healthy on `:99`** — the patch is incidental. Revert r4 to the repo's `entrypoint.sh`, delete `CROW_BROWSER_DISPLAY` from its `.env`, and upstream nothing for `DISPLAY_NUM`.
- **r4's Xvfb or Chrome fails** — the patch is required. Capture the exact error, restore `CROW_BROWSER_DISPLAY=98`, and upstream `DISP_NUM="${DISPLAY_NUM:-99}"` to `bundles/browser/entrypoint.sh` in a follow-up PR **with the captured error quoted in the commit message** as the justification.

Repeat the same reasoning for `-noshm`: remove it, recreate, and see whether VNC still renders at `http://localhost:6081/vnc.html`. Record what you observe either way.

- [ ] **Step 3: Fix the bind mount**

Task 7 Step 7 already put `CROW_HOME=/home/kh0pp/.crow-r4` in this `.env`, so the recreate above should already have corrected the mount. Verify:

```bash
docker inspect crow-browser-r4 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

Expected: `/home/kh0pp/.crow-r4/browser-downloads -> /downloads`. If it still reads `/home/kh0pp/.crow/browser-downloads`, the `.env` edit did not take — Compose reads `.env` from the directory containing the compose file, so confirm you edited `/home/kh0pp/.crow-r4/bundles/browser/.env` and not the repo's.

- [ ] **Step 4: Prove the two browsers are actually separate**

```bash
curl -s http://127.0.0.1:9222/json/version | python3 -c "import json,sys; print('9222', json.load(sys.stdin)['webSocketDebuggerUrl'][:60])"
curl -s http://127.0.0.1:9223/json/version | python3 -c "import json,sys; print('9223', json.load(sys.stdin)['webSocketDebuggerUrl'][:60])"
docker inspect crow-browser --format '{{range .Mounts}}{{.Source}}{{end}}'
docker inspect crow-browser-r4 --format '{{range .Mounts}}{{.Source}}{{end}}'
```

Expected: two different debugger endpoints, and two different mount sources — `/home/kh0pp/.crow/browser-downloads` and `/home/kh0pp/.crow-r4/browser-downloads`.

- [ ] **Step 5: Confirm the primary was left alone**

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -i brows
```

Expected: `crow-browser` shows an uptime predating this window — it must **not** have been recreated. If its uptime resets, something targeted the wrong container; investigate before continuing, because that is precisely the defect this whole change exists to prevent.

- [ ] **Step 6: Record the outcome**

Write the entrypoint decision, its evidence, and the final mount state into the session handoff. If Step 2 concluded the patches are required, open the follow-up PR upstreaming them with the captured error as justification.

---

## Self-Review

**Spec coverage.** §1 model → Tasks 7-8 (two owners, MPA none). §2 finding 1 → Task 7 Steps 5-6. Finding 2 → Task 1. Finding 3 → Tasks 3, 8. Finding 4 → Task 4. Finding 5 → Task 7 Step 2. Finding 6 → Task 8 Step 2. Addendum finding 8 → Task 2. §3.1 → Task 1. §3.2 → Task 3. §3.3 → Task 4. §3.4 → Task 8 Step 2. §4 steps 1-5 → Task 7 Steps 2, 5, 6, 7, 8-9. §5 testing → Tasks 1-4 plus Task 5 Steps 2-3, with the mutation check at Task 4 Step 5. §6 risk → Task 6 Steps 1 and 5 (soak logging), Task 5 Step 3 (`check-ports`). §7 out-of-scope items are correctly absent from every task.

One thing the spec did not name and the plan adds: the `manifest.json` version bump (Task 5 Step 1). Without it `refreshVersionedBundle` returns early on equal versions and the entire repo change stays inert on the host. Discovered while writing Task 6.

**Placeholder scan.** No TBD, TODO, "handle appropriately", or "similar to Task N". Every code step carries the actual code. Task 8 Step 2's branch is not a placeholder — it is a genuine empirical fork with both outcomes specified, which is the honest shape for a question whose answer nobody recorded.

**Type consistency.** `stateRoot()` and `stateDir(name)` are defined in Task 1 and used in Tasks 1, 2 and 8. `containerName()` is defined in Task 2 and used only there. The `crow_browser_status` fields `container`, `cdp_url`, `state_root` are added in Task 2 and read in Task 7 Step 8 under exactly those names. `crowServerCatalog(crowHome, { binding })` matches the existing signature and the existing test file's `BINDING_B` helper. The `.env` key is `CROW_HOME` everywhere; the compose interpolation is `${CROW_HOME:?…}` in both the change and its test.
