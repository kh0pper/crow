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

test("the kept-skill notification tells the truth and links to the copy", () => {
  const n = keptSkillNotification({ bundle: "media", skill: "media.md" });
  assert.equal(n.title, 'Your edited skill "media.md" was kept');
  assert.equal(n.body, "A newer version ships with the media extension, but your copy was edited after install, so it was not replaced. Open it in Skills to see your copy. To switch to the new version, delete your copy, then in Extensions uninstall media (leave \"Delete all stored data\" unchecked) and install it again.");
  assert.doesNotMatch(n.body, /reinstall/, "an installed extension can't be installed again (409 already_installed)");
  assert.doesNotMatch(n.body, /to get the new one/);
  assert.equal(n.action_url, "/dashboard/skills?edit=media.md&source=user");
  assert.equal(n.type, "system");
  assert.equal(n.source, "bundles");
  assert.equal(keptSkillNotification({ bundle: "x", skill: "a b&c.md" }).action_url, "/dashboard/skills?edit=a%20b%26c.md&source=user");
});

test("the boot pass posts exactly that notification", () => {
  const src = readFileSync(new URL("../servers/gateway/boot/mcp-mounts.js", import.meta.url), "utf8");
  assert.match(src, /createNotification\(ndb, keptSkillNotification\(k\)\)/);
  assert.doesNotMatch(src, /Delete your copy in Skills/);
});
