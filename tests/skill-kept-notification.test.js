// Skills panel option C, PR 1 (review I5): the boot notification for an edited
// extension skill told the owner to "Delete your copy in Skills to get the new
// one". That is false: deleting an edited copy leaves its install record, so
// every later boot reads skip-deleted and the new version never arrives. The
// text now names the path that works (delete, then reinstall) and links to the
// copy itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keptSkillNotification } from "../servers/gateway/bundle-skill-sync.js";

test("the kept-skill notification points at Compare / Restore original / Keep mine on the skill (PR 3)", () => {
  const n = keptSkillNotification({ bundle: "media", skill: "media.md" });
  assert.equal(n.title, 'Your edited skill "media.md" was kept');
  assert.equal(n.body, "A newer version ships with the media extension, but your copy was edited after install, so it was not replaced. Open it in Skills to compare it with the new version, restore the original or keep yours.");
  assert.doesNotMatch(n.body, /to get the new one/);
  assert.equal(n.action_url, "/dashboard/skills?skill=media&compare=1");
  assert.equal(n.type, "system");
  assert.equal(n.source, "bundles");
  assert.equal(keptSkillNotification({ bundle: "x", skill: "a b&c.md" }).action_url, "/dashboard/skills?skill=a%20b%26c&compare=1");
});

test("the boot pass posts exactly that notification", () => {
  const src = readFileSync(new URL("../servers/gateway/boot/mcp-mounts.js", import.meta.url), "utf8");
  assert.match(src, /createNotification\(ndb, keptSkillNotification\(k\)\)/);
  assert.doesNotMatch(src, /Delete your copy in Skills/);
});
