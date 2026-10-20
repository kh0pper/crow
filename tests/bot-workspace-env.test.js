/**
 * The bot's own project workspace, as handed to pi-lab (PI_BOT_WORKSPACE /
 * PI_BOT_PROJECTS_ROOT / PI_BOT_ID). Every way out of the projects root
 * must yield NO keys: `..` segments, a symlink that points outside, the root
 * itself, a folder of the wrong shape, a missing folder, a file, a relative
 * path, a bad bot id.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botWorkspaceEnv, BOT_ID_RE } from "../scripts/pi-bots/bot-workspace-env.mjs";

let dir, root, ws, outside;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-ws-env-"));
  root = join(dir, "data", "projects");
  ws = join(root, "board-1", "workspace");
  outside = join(dir, "data", "secrets");
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "afile"), "x");
  symlinkSync(outside, join(root, "escape"));          // a link inside the root, pointing out
  symlinkSync(ws, join(dir, "ws-link"));                // a link outside the root, pointing in
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("a workspace strictly under the projects root yields all three keys, as realpaths", () => {
  const env = botWorkspaceEnv({ workspaceDir: ws, projectsRoot: root, botId: "a-bot" });
  assert.deepEqual(env, {
    PI_BOT_WORKSPACE: realpathSync(ws),
    PI_BOT_PROJECTS_ROOT: realpathSync(root),
    PI_BOT_ID: "a-bot",
  });
});

test("a link from outside that resolves inside the root is followed to its real path", () => {
  const env = botWorkspaceEnv({ workspaceDir: join(dir, "ws-link"), projectsRoot: root, botId: "a-bot" });
  assert.equal(env.PI_BOT_WORKSPACE, realpathSync(ws));
});

test("traversal out of the root yields nothing", () => {
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: join(ws, "..", "..", "..", "secrets"), projectsRoot: root, botId: "a-bot" }), {});
});

test("a symlink inside the root that points outside yields nothing", () => {
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: join(root, "escape"), projectsRoot: root, botId: "a-bot" }), {});
});

test("the projects root itself is not a workspace", () => {
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: root, projectsRoot: root, botId: "a-bot" }), {});
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: root + "/", projectsRoot: root, botId: "a-bot" }), {});
});

test("only the <root>/<one segment>/workspace shape counts", () => {
  const deeper = join(ws, "sub", "workspace");
  const shallow = join(root, "board-2");
  const otherName = join(root, "board-3", "work");
  for (const d of [deeper, shallow, otherName]) mkdirSync(d, { recursive: true });
  for (const d of [deeper, shallow, otherName]) {
    assert.deepEqual(botWorkspaceEnv({ workspaceDir: d, projectsRoot: root, botId: "a-bot" }), {}, d);
  }
});

test("a sibling whose name only shares the root's prefix is outside", () => {
  const sib = join(dir, "data", "projects-evil", "w", "workspace");
  mkdirSync(sib, { recursive: true });
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: sib, projectsRoot: root, botId: "a-bot" }), {});
});

test("missing folders, files, relative paths and empty input yield nothing", () => {
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: join(root, "nope"), projectsRoot: root, botId: "a-bot" }), {});
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: join(root, "afile"), projectsRoot: root, botId: "a-bot" }), {});
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: "data/projects/board-1/workspace", projectsRoot: root, botId: "a-bot" }), {});
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: ws, projectsRoot: join(dir, "missing"), botId: "a-bot" }), {});
  assert.deepEqual(botWorkspaceEnv({ workspaceDir: null, projectsRoot: root, botId: "a-bot" }), {});
  assert.deepEqual(botWorkspaceEnv(), {});
});

test("a bot id outside the plain charset yields nothing", () => {
  for (const bad of ["", "../x", "a/b", ".hidden", "-x", "a b", "a\nb", "x".repeat(65), null, 7]) {
    assert.deepEqual(botWorkspaceEnv({ workspaceDir: ws, projectsRoot: root, botId: bad }), {}, String(bad));
  }
  assert.ok(BOT_ID_RE.test("alex-assistant"));
  assert.ok(BOT_ID_RE.test("crow.glasses_2"));
});
