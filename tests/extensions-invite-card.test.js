/**
 * The Extensions page's invite card, rendered through the panel handler itself
 * (round 3, finding 1).
 *
 * The invite state is computed only for the owner at this machine: the block used
 * to reach for `../../local-session.js`, which does not exist, and a catch-all
 * swallowed the failed import — so every owner saw the "Crow cannot read the app"
 * card and never the Close sign-ups button. This renders the real panel (real
 * registry, scratch CROW_HOME, a stub db) with the invite-state read replaced by a
 * seam reporting one registered account and sign-ups still open.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ext-invite-card-"));
const HOME = join(scratch, "home");
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
mkdirSync(join(HOME, "data"), { recursive: true });
mkdirSync(join(HOME, "bundles", "vaultwarden"), { recursive: true });
writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "vaultwarden", installedAt: "2026-11-09T10:00:00.000Z" }]));
// The installed manifest the card is built from (the reviewed copy is the repo's).
writeFileSync(
  join(HOME, "bundles", "vaultwarden", "manifest.json"),
  readFileSync(new URL("../bundles/vaultwarden/manifest.json", import.meta.url), "utf8"),
);

after(() => rmSync(scratch, { recursive: true, force: true }));

const { default: panel, _setInviteStatesForTest } = await import("../servers/gateway/dashboard/panels/extensions.js");
const { _setDockerProbeForTest } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");

_setDockerProbeForTest(false);

/** A db that says "the owner's session" and "no keychain entry", nothing else. */
const db = {
  execute: async ({ sql }) => {
    if (/FROM oauth_tokens\b/.test(sql)) return { rows: [{ scopes: "dashboard" }] };
    return { rows: [] };
  },
};

/** One registered account, sign-ups still open → the card offers Close sign-ups. */
const CLOSE_STATE = {
  signups: "on",
  users: [{ email: "owner@example.com", status: 0, registered: true, invited: false, disabled: false }],
  others: [],
  reachable: true,
  reason: null,
};

/** A request the owner's-turn rule sees as another machine (documentation range). */
function remoteReq() {
  return { method: "GET", headers: {}, socket: { remoteAddress: "192.0.2.10" }, dashboardSession: "a-local-session" };
}

/** A request from this machine itself: browses as signed in, never the owner's turn. */
function onHostReq() {
  return { method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" }, dashboardSession: "a-local-session" };
}

/** The rendered Close sign-ups button (`ext-firstadmin-close` alone is also in the client JS). */
const CLOSE_BUTTON = /class="btn btn-sm btn-secondary ext-firstadmin-close"/;

async function render(req = remoteReq()) {
  return panel.handler(req, {}, { db, layout: ({ content }) => content, lang: "en" });
}

test("the owner's Extensions page renders the invite card with Close sign-ups", async () => {
  let calls = 0;
  _setInviteStatesForTest(async ({ installed }) => {
    calls += 1;
    assert.ok(installed.vaultwarden, "the panel hands in the installed bundles");
    return { vaultwarden: CLOSE_STATE };
  });
  try {
    const html = await render();
    assert.equal(calls, 1, "the invite state was computed exactly once");
    assert.match(html, CLOSE_BUTTON, "the Close sign-ups button is on the card");
  } finally {
    _setInviteStatesForTest(null);
  }
});

test("a request from this machine itself computes no invite state and gets no Close button", async () => {
  let calls = 0;
  _setInviteStatesForTest(async () => {
    calls += 1;
    return { vaultwarden: CLOSE_STATE };
  });
  try {
    const html = await render(onHostReq());
    assert.equal(calls, 0, "the app's admin panel is never logged in to for a same-box request");
    assert.doesNotMatch(html, CLOSE_BUTTON);
  } finally {
    _setInviteStatesForTest(null);
  }
});

test("without the owner's turn the card is the plain finish-setup one", async () => {
  // No seam at all: the real read would need a container, and on a same-box request
  // it is never reached. The card is still owed, just without an invite state.
  const html = await render(onHostReq());
  assert.match(html, /class="callout callout-warning ext-firstadmin"/, "the card is still owed");
  assert.doesNotMatch(html, CLOSE_BUTTON);
  assert.doesNotMatch(html, /class="ext-firstadmin-invite-email"/, "and it asks for no email");
});