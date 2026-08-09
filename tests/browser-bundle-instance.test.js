import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stateRoot, stateDir, containerName, cdpPort, vncPort } from "../bundles/browser/server/instance.js";

const SERVER_JS = new URL("../bundles/browser/server/server.js", import.meta.url);

/** Every executable file in the bundle — server and panel both run code. */
function bundleSources() {
  const out = [];
  for (const sub of ["server", "panel"]) {
    const dir = new URL(`../bundles/browser/${sub}/`, import.meta.url);
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".js")) out.push({ path: `${sub}/${f}`, src: readFileSync(new URL(f, dir), "utf8") });
    }
  }
  return out;
}

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

/** Run `fn` with each key of `overrides` set (or deleted when its value is null), restoring after. */
function withEnv(overrides, fn) {
  const prev = {};
  for (const key of Object.keys(overrides)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Build a fresh temp instance home with an optional bundles/browser/.env
 * (one "KEY=value" string per line), run `fn(dir)`, then clean up.
 *
 * A fresh mkdtemp dir per call means bundleEnv()'s path-keyed cache in
 * instance.js naturally invalidates between tests — no need to reset it.
 */
function withInstanceHome(envLines, fn) {
  const dir = mkdtempSync(join(tmpdir(), "crow-browser-instance-"));
  const bundleDir = join(dir, "bundles", "browser");
  mkdirSync(bundleDir, { recursive: true });
  if (envLines) writeFileSync(join(bundleDir, ".env"), envLines.join("\n") + "\n");
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("no file in the bundle hardcodes the primary's home", () => {
  // `process.env.CROW_HOME || join(homedir(), ".crow")` is the one legitimate
  // shape: instance.js's own stateRoot() fallback, and the unavoidable
  // bootstrap each panel file needs to locate instance.js before it can
  // delegate to stateDir() (see panel/browser.js and panel/routes.js). Any
  // OTHER join(homedir(), ".crow", ...) — without that CROW_HOME fallback —
  // is the defect: a path resolved straight to the primary's home.
  const HARDCODE = /join\(\s*homedir\(\)\s*,\s*"\.crow"/;
  const BOOTSTRAP = /process\.env\.CROW_HOME\s*\|\|\s*join\(\s*homedir\(\)\s*,\s*"\.crow"/;
  for (const { path, src } of bundleSources()) {
    for (const line of src.split("\n")) {
      if (!HARDCODE.test(line)) continue;
      assert.ok(
        BOOTSTRAP.test(line),
        `${path} must resolve state through stateDir()/the CROW_HOME fallback, not a bare join(homedir(), ".crow", ...): ${line.trim()}`,
      );
    }
  }
});

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

test("no docker call in the bundle hardcodes a container name", () => {
  let dockerLineCount = 0;
  for (const { path, src } of bundleSources()) {
    for (const line of src.split("\n")) {
      if (!line.includes('execFileSync("docker"')) continue;
      dockerLineCount++;
      assert.ok(!line.includes('"crow-browser"'), `${path} targets the primary's container by name: ${line.trim()}`);
    }
  }
  assert.ok(dockerLineCount >= 9, `expected the bundle's docker calls to still exist, found ${dockerLineCount}`);
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

test("the downloads mount requires CROW_HOME instead of defaulting to the primary", () => {
  const compose = readFileSync(new URL("../bundles/browser/docker-compose.yml", import.meta.url), "utf8");
  assert.ok(
    !compose.includes("${CROW_HOME:-"),
    "a CROW_HOME default lets a hand-run compose mount the primary's downloads into a second instance's container",
  );
  assert.match(compose, /\$\{CROW_HOME:\?/, "the mount must fail loudly when CROW_HOME is unset");
});

test("containerName, cdpPort, vncPort read the instance's bundle .env when process.env has no override", () => {
  withInstanceHome([
    "CROW_BROWSER_CONTAINER_NAME=crow-browser-r4",
    "CROW_BROWSER_CDP_PORT=9322",
    "CROW_BROWSER_VNC_PORT=6180",
  ], (dir) => {
    withEnv({
      CROW_HOME: dir,
      CROW_BROWSER_CONTAINER_NAME: null,
      CROW_BROWSER_CDP_PORT: null,
      CROW_BROWSER_VNC_PORT: null,
    }, () => {
      assert.equal(containerName(), "crow-browser-r4");
      assert.equal(cdpPort(), "9322");
      assert.equal(vncPort(), "6180");
    });
  });
});

test("process.env wins over the instance's bundle .env when both are set", () => {
  withInstanceHome([
    "CROW_BROWSER_CONTAINER_NAME=crow-browser-r4",
    "CROW_BROWSER_CDP_PORT=9322",
    "CROW_BROWSER_VNC_PORT=6180",
  ], (dir) => {
    withEnv({
      CROW_HOME: dir,
      CROW_BROWSER_CONTAINER_NAME: "crow-browser-override",
      CROW_BROWSER_CDP_PORT: "9999",
      CROW_BROWSER_VNC_PORT: "6999",
    }, () => {
      assert.equal(containerName(), "crow-browser-override");
      assert.equal(cdpPort(), "9999");
      assert.equal(vncPort(), "6999");
    });
  });
});

test("containerName, cdpPort, vncPort fall back to their defaults when neither process.env nor the bundle .env has a value", () => {
  withInstanceHome(null, (dir) => {
    withEnv({
      CROW_HOME: dir,
      CROW_BROWSER_CONTAINER_NAME: null,
      CROW_BROWSER_CDP_PORT: null,
      CROW_BROWSER_VNC_PORT: null,
    }, () => {
      assert.equal(containerName(), "crow-browser");
      assert.equal(cdpPort(), "9222");
      assert.equal(vncPort(), "6080");
    });
  });
});

test("stateRoot ignores a CROW_HOME written inside the bundle .env — it must come from process.env only", () => {
  withInstanceHome([
    "CROW_HOME=/tmp/should-never-be-used",
  ], (dir) => {
    withEnv({ CROW_HOME: dir }, () => {
      assert.equal(stateRoot(), dir);
    });
  });
});

test("docker-compose.yml passes DISPLAY_NUM from CROW_BROWSER_DISPLAY, not a bare DISPLAY=:99", () => {
  const compose = readFileSync(new URL("../bundles/browser/docker-compose.yml", import.meta.url), "utf8");
  assert.ok(
    !/DISPLAY=:99/.test(compose),
    "a hardcoded DISPLAY=:99 makes a second instance's Xvfb collide with the first's abstract X socket " +
      "(network_mode: host shares the network namespace) and silently attach to the first instance's display",
  );
  assert.match(
    compose,
    /DISPLAY_NUM=\$\{CROW_BROWSER_DISPLAY:-99\}/,
    "docker-compose.yml must pass DISPLAY_NUM through from CROW_BROWSER_DISPLAY so a second instance can pick its own X display number",
  );
});

test("entrypoint.sh derives DISP_NUM from DISPLAY_NUM instead of hardcoding it", () => {
  const entrypoint = readFileSync(new URL("../bundles/browser/entrypoint.sh", import.meta.url), "utf8");
  assert.ok(
    !/^DISP_NUM=99$/m.test(entrypoint),
    "a hardcoded DISP_NUM=99 ignores DISPLAY_NUM from the compose file, so every instance still starts Xvfb on :99",
  );
  assert.match(
    entrypoint,
    /^DISP_NUM="\$\{DISPLAY_NUM:-99\}"$/m,
    "entrypoint.sh must read DISP_NUM from ${DISPLAY_NUM:-99} so docker-compose.yml's CROW_BROWSER_DISPLAY pass-through takes effect",
  );
});

test("entrypoint.sh re-checks the Xvfb process after the readiness loop, not only inside it", () => {
  // A display answering xdpyinfo is not proof it's OURS: under network_mode:host,
  // a co-hosted instance already on this display number answers on the first
  // xdpyinfo poll while our own Xvfb is still losing the abstract-socket bind and
  // dying, so the loop's own kill -0 guard never gets a second iteration to catch
  // it. Scope strictly to the code AFTER the `ready` assertion (and before x11vnc
  // starts) so a match inside the polling loop above can't satisfy this.
  const entrypoint = readFileSync(new URL("../bundles/browser/entrypoint.sh", import.meta.url), "utf8");
  const readyAssertion = 'die "Xvfb did not become ready on :${DISP_NUM} within 15s"';
  const readyAssertionIdx = entrypoint.indexOf(readyAssertion);
  assert.ok(readyAssertionIdx !== -1, "could not find the Xvfb readiness assertion to scope past");
  const afterReady = entrypoint.slice(readyAssertionIdx + readyAssertion.length);
  const x11vncStart = afterReady.indexOf("Starting x11vnc");
  assert.ok(x11vncStart !== -1, "could not find the x11vnc startup section to scope before");
  const postReadySlice = afterReady.slice(0, x11vncStart);
  assert.match(
    postReadySlice,
    /kill -0 "\$XVFB_PID"/,
    "entrypoint.sh must re-check kill -0 \"$XVFB_PID\" after the readiness loop — a co-hosted instance on the same " +
      "display can make xdpyinfo succeed for OUR loop before our own Xvfb has finished dying, so the loop's guard " +
      "alone isn't enough; declaring ready without re-checking lets x11vnc attach to the other instance's display",
  );
});
