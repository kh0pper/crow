/**
 * Task 7B of the Crow-to-Crow plan: the JSON routes the Projects panel calls
 * (`servers/gateway/routes/c2c-api.js`) and the panel's own Crow-to-Crow UI.
 *
 * Every case runs against a REAL scripts/init-db.js database (the real 0016 tables,
 * the real `project_members` CHECK) and the REAL owner.js / visitor.js behind the
 * routes; the only fakes are the dashboard's session gate and the absence of a
 * sharing runtime (no peer manager in a test process, so a frame stays queued for
 * boot.js's tick — which is what the outbox is for).
 *
 * What is pinned here:
 *   - the session and CSRF rails, and that a peer-SSO session is not the owner;
 *   - the status mapping the plan lists (400 bad role, 409 contact_not_bound,
 *     404 unknown project/contact/visit, 400 invalid ids, 403 for the rest);
 *   - that an owner invite really lists the member, and that accept/leave move a
 *     visit and queue the answer frames;
 *   - the panel: only bound contacts in the picker, a hostile contact name escaped,
 *     the update-required line, and the visitor's Accept / Decline / Leave;
 *   - the panel client is safe inside a template literal (no backtick, no `${`).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { markFromLaptop } from "./helpers/off-box.js";

const REPO = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "c2c-api-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_INSTANCES_JSON_PATH = join(dir, "instances.json");
mkdirSync(process.env.CROW_HOME, { recursive: true });

let server;
let base;
let db;
let localId;

const BOUND = 1; // alex: pinned key + this instance's cb pin
const UNBOUND = 2; // sam: a key, no pin
const HOSTILE = 3; // a display name that is markup
const HOSTILE_NAME = "<script>alert(1)</script>";
const OWNER_SESSION = "owner-session-token";
const SSO_SESSION = "sso-session-token";
const SSH = (s) => createHash("sha256").update(s).digest("hex");

let seq = 0;

/** A fresh project with its local OWNER row: every owner action is gated on manage_members. */
async function newProject() {
  seq += 1;
  const r = await db.execute({
    sql: "INSERT INTO project_spaces (slug, name, type) VALUES (?, ?, 'general')",
    args: [`c2c-api-${seq}`, `Labs ${seq}`],
  });
  const id = Number(r.lastInsertRowid);
  await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')",
    args: [id],
  });
  return { id };
}

/** A visit row, as visitor.js's onInvite would have written it. */
async function newVisit({ state = "invited", name = "Lab notes" } = {}) {
  const projectUuid = randomBytes(16).toString("hex");
  const r = await db.execute({
    sql: `INSERT INTO c2c_visits
            (owner_contact_id, project_uuid, name, role, epoch, gen, owner_instance_id, state)
          VALUES (?, ?, ?, 'viewer', ?, 1, 'inst-owner', ?)`,
    args: [BOUND, projectUuid, name, randomBytes(16).toString("hex"), state],
  });
  return { id: Number(r.lastInsertRowid), projectUuid };
}

/** Queue ids the outbox holds for one stream (the answer frames a visit action wrote). */
async function outboxKinds(projectUuid) {
  const { rows } = await db.execute({
    sql: "SELECT kind FROM c2c_outbox WHERE project_uuid = ? ORDER BY id",
    args: [projectUuid],
  });
  return rows.map((r) => r.kind);
}

const AUTHED = { cookie: `crow_session=${OWNER_SESSION}; crow_csrf=tok`, "x-crow-csrf": "tok" };

async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => null) };
}

async function get(path, headers = AUTHED) {
  const r = await fetch(base + path, { redirect: "manual", headers });
  return { status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => null) };
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    stdio: "pipe",
    cwd: REPO,
  });
  const { createDbClient } = await import("../servers/db.js");
  const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
  db = createDbClient();
  localId = getOrCreateLocalInstanceId();

  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES
            ('crow:alex', 'alex', ?, ?), ('crow:sam', 'sam', ?, ?), ('crow:hostile', ?, ?, ?)`,
    args: [
      "a".repeat(64), "a".repeat(64), "b".repeat(64), "b".repeat(64),
      HOSTILE_NAME, "c".repeat(64), "c".repeat(64),
    ],
  });
  // PT-3: only alex and the hostile contact have proved the bound key on THIS instance.
  for (const crowId of ["crow:alex", "crow:hostile"]) {
    await db.execute({
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, ?, '1')`,
      args: [`contact_hs_cb:${crowId}`, localId],
    });
  }
  // The dashboard's sessions: one minted by this instance's own password login, one by
  // a peer's SSO (scopes are what isLocalPasswordSessionOn compares).
  await db.execute({
    sql: `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES
            (?, 'access', 'dashboard', 'dashboard', datetime('now', '+1 day')),
            (?, 'access', 'dashboard', 'dashboard sso src:peer-1', datetime('now', '+1 day'))`,
    args: [SSH(OWNER_SESSION), SSH(SSO_SESSION)],
  });

  const { c2cApiRouter } = await import("../servers/gateway/routes/c2c-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  // The dashboard's own gate, stubbed: a cookie signs the request in, and the client is
  // "the owner's laptop" so the origin rule inside isLocalPasswordSessionOn can pass.
  const gate = (req, res, next) => {
    const cookies = parseCookies(req);
    if (!cookies.crow_session) return res.redirect("/dashboard/login");
    req.dashboardSession = cookies.crow_session;
    markFromLaptop(req);
    next();
  };
  const app = express();
  app.use("/dashboard", csrfMiddleware); // the real CSRF rail, in the real order
  app.use(c2cApiRouter(gate));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}/dashboard/c2c-api`;
});

after(() => {
  if (server) server.close();
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- the rails */

test("a request with no session never reaches a route", async () => {
  const p = await newProject();
  const r = await post(`/projects/${p.id}/invite`, { contact_id: BOUND, role: "viewer" },
    { cookie: "crow_csrf=tok", "x-crow-csrf": "tok" });
  assert.notEqual(r.status, 200);
  assert.equal(r.location, "/dashboard/login");
  const members = await get(`/projects/${p.id}/members`, { cookie: "crow_csrf=tok" });
  assert.notEqual(members.status, 200);
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL",
    args: [p.id],
  });
  assert.equal(Number(rows[0].n), 0, "nothing was written for a caller with no session");
});

test("a state-changing call needs the CSRF token", async () => {
  const p = await newProject();
  const r = await post(`/projects/${p.id}/invite`, { contact_id: BOUND, role: "viewer" },
    { cookie: `crow_session=${OWNER_SESSION}; crow_csrf=tok` });
  assert.equal(r.status, 403, "the real csrfMiddleware refuses the request before the route");
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM c2c_outbox WHERE contact_id = ?",
    args: [BOUND],
  });
  assert.equal(Number(rows[0].n), 0);
});

test("a peer-SSO session is not the owner: 403 not_owner, nothing read or written", async () => {
  const p = await newProject();
  const sso = { cookie: `crow_session=${SSO_SESSION}; crow_csrf=tok`, "x-crow-csrf": "tok" };
  for (const [label, call] of [
    ["invite", () => post(`/projects/${p.id}/invite`, { contact_id: BOUND, role: "viewer" }, sso)],
    ["members", () => get(`/projects/${p.id}/members`, sso)],
    ["visits", () => get("/visits", sso)],
    ["unshare", () => post(`/projects/${p.id}/members/${BOUND}/unshare`, {}, sso)],
  ]) {
    const r = await call();
    assert.equal(r.status, 403, label);
    assert.deepEqual(r.body, { error: "not_owner", code: "not_owner" }, label);
  }
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL",
    args: [p.id],
  });
  assert.equal(Number(rows[0].n), 0, "an SSO caller changed nothing");
});

/* ------------------------------------------------------------------ the statuses */

test("a role outside viewer|commenter|editor is 400 bad_role", async () => {
  const p = await newProject();
  for (const body of [
    { contact_id: BOUND, role: "owner" }, { contact_id: BOUND, role: "admin" },
    { contact_id: BOUND, role: "" }, { contact_id: BOUND }, { contact_id: BOUND, role: 5 },
    { contact_id: BOUND, role: "viewer " },
  ]) {
    const r = await post(`/projects/${p.id}/invite`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "bad_role");
  }
  const role = await post(`/projects/${p.id}/members/${BOUND}/role`, { role: "committer" });
  assert.equal(role.status, 400);
  assert.equal(role.body.error, "bad_role");
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL",
    args: [p.id],
  });
  assert.equal(Number(rows[0].n), 0, "a refused role wrote no membership");
});

test("an unbound contact is 409 contact_not_bound", async () => {
  const p = await newProject();
  const r = await post(`/projects/${p.id}/invite`, { contact_id: UNBOUND, role: "viewer" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "contact_not_bound");
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL",
    args: [p.id],
  });
  assert.equal(Number(rows[0].n), 0, "an invite to an unbound contact writes nothing");
});

test("invalid ids are 400, and an unknown project, contact or visit is 404", async () => {
  for (const [path, body] of [
    ["/projects/abc/members", null],
    ["/projects/0/members", null],
    ["/projects/1.5/members", null],
    ["/visits/abc/accept", {}],
    ["/visits/0/leave", {}],
  ]) {
    const r = body === null ? await get(path) : await post(path, body);
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error, "bad_request", path);
  }
  const p = await newProject();
  const noContact = await post(`/projects/${p.id}/invite`, { contact_id: "seven", role: "viewer" });
  assert.equal(noContact.status, 400);
  assert.equal(noContact.body.error, "bad_request");

  const noProject = await get("/projects/999999/members");
  assert.equal(noProject.status, 404);
  assert.equal(noProject.body.error, "not_found");

  const noContactRow = await post(`/projects/${p.id}/invite`, { contact_id: 999999, role: "viewer" });
  assert.equal(noContactRow.status, 404);
  assert.equal(noContactRow.body.error, "not_found");

  const noVisit = await post("/visits/999999/accept", {});
  assert.equal(noVisit.status, 404);
  assert.equal(noVisit.body.error, "not_found");
});

test("a member the caller does not manage is 403", async () => {
  // A project with no local owner row at all: the caller is not a member, so there is
  // no manage_members to have (owner.js W3).
  const r = await db.execute({
    sql: "INSERT INTO project_spaces (slug, name) VALUES ('no-owner', 'No owner')",
    args: [],
  });
  const projectId = Number(r.lastInsertRowid);
  const refused = await post(`/projects/${projectId}/invite`, { contact_id: BOUND, role: "viewer" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "forbidden");
  assert.equal(refused.body.code, "not_member");
});

/* ------------------------------------------------------------- the owner's routes */

test("an owner invite is 200, and the member is listed", async () => {
  const p = await newProject();
  const r = await post(`/projects/${p.id}/invite`, { contact_id: BOUND, role: "commenter" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.memberUuid, /^[0-9a-f]{32}$/, "the route returns the membership's epoch");

  const list = await get(`/projects/${p.id}/members`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.members, [{
    contactId: BOUND, displayName: "alex", role: "commenter", state: "invited", updateRequired: false,
  }]);
  // The invite frame is queued (no peer manager in a test process: it stays for the tick).
  assert.deepEqual(await outboxKinds(await uuidOf(p.id)), ["project.invite"], "one invite frame, queued");
});

/** The project_spaces uuid, which is the stream the outbox keys its frames by. */
async function uuidOf(projectId) {
  const { rows } = await db.execute({ sql: "SELECT uuid FROM project_spaces WHERE id = ? LIMIT 1", args: [projectId] });
  return rows[0].uuid;
}

test("role and unshare on an accepted member: 200, and the member leaves the list", async () => {
  const p = await newProject();
  await post(`/projects/${p.id}/invite`, { contact_id: BOUND, role: "viewer" });
  // Simulate the contact's Crow having accepted (the pipeline writes these).
  await db.execute({
    sql: `UPDATE project_members SET accepted_at = datetime('now'), origin_instance_id = 'inst-visitor'
           WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL`,
    args: [p.id, BOUND],
  });

  const role = await post(`/projects/${p.id}/members/${BOUND}/role`, { role: "editor" });
  assert.equal(role.status, 200);
  assert.equal(role.body.ok, true);
  let list = await get(`/projects/${p.id}/members`);
  assert.equal(list.body.members[0].role, "editor");
  assert.equal(list.body.members[0].state, "active");

  const unshare = await post(`/projects/${p.id}/members/${BOUND}/unshare`, {});
  assert.equal(unshare.status, 200);
  list = await get(`/projects/${p.id}/members`);
  assert.deepEqual(list.body.members, [], "an unshared member is not live any more");
  assert.deepEqual(await outboxKinds(await uuidOf(p.id)), ["project.invite", "project.role", "project.unshare"]);
});

/* ----------------------------------------------------------- the visitor's routes */

test("accept and leave on a visit: 200, the state changes, and the answers are queued", async () => {
  const visit = await newVisit({ state: "invited" });

  const accept = await post(`/visits/${visit.id}/accept`, {});
  assert.equal(accept.status, 200);
  assert.deepEqual(accept.body, { ok: true, state: "active" });

  let list = await get("/visits");
  assert.equal(list.status, 200);
  assert.equal(list.body.visits.find((v) => v.id === visit.id).state, "active");
  const active = list.body.visits.find((v) => v.id === visit.id);
  assert.equal(active.projectName, "Lab notes");
  assert.equal(active.ownerName, "alex");

  const leave = await post(`/visits/${visit.id}/leave`, {});
  assert.equal(leave.status, 200);
  assert.deepEqual(leave.body, { ok: true, state: "left" });
  list = await get("/visits");
  assert.equal(list.body.visits.find((v) => v.id === visit.id).state, "left");

  assert.deepEqual(await outboxKinds(visit.projectUuid), ["project.accept", "project.decline"],
    "accept then a decline carrying reason left, both queued on the visit's stream");
});

test("decline on a visit is 200, and a second answer is 409 bad_state", async () => {
  const visit = await newVisit({ state: "invited" });
  const decline = await post(`/visits/${visit.id}/decline`, {});
  assert.equal(decline.status, 200);
  assert.deepEqual(decline.body, { ok: true, state: "declined" });
  const again = await post(`/visits/${visit.id}/leave`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "bad_state");
});

/* ----------------------------------------------------------------- the panel */

const { default: panel, c2cClientJs } = await import("../servers/gateway/dashboard/panels/projects.js");

/** Render one panel page exactly as the dashboard dispatcher does. */
async function renderPanel(query, lang = "en") {
  return panel.handler({ method: "GET", body: {}, query, headers: {} }, {}, {
    db, layout: ({ content }) => content, lang,
  });
}

test("the panel offers only bound contacts, escapes a hostile name, and shows the update-required line", async () => {
  const p = await newProject();
  await post(`/projects/${p.id}/invite`, { contact_id: BOUND, role: "viewer" });
  // The receive pipeline's legacy-proof flag (receive.js R5/S10): ANY instance's row counts.
  await db.execute({
    sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, 'sibling-instance', '1')`,
    args: [`c2c_update_required:crow:alex`],
  });
  try {
    const html = await renderPanel({ view: String(p.id) });
    const { document } = parseHTML(`<html><body>${html}</body></html>`);

    const picker = document.querySelector("[data-c2c-invite] [data-c2c-contact]");
    assert.ok(picker, "the share form is drawn");
    const offered = [...picker.querySelectorAll("option")].map((o) => o.value).sort();
    assert.deepEqual(offered, [String(BOUND), String(HOSTILE)].sort(),
      "only the cb-pinned contacts are offered (sam has a key but never bound)");
    assert.deepEqual([...picker.querySelectorAll("option")].map((o) => o.textContent).sort(),
      ["alex", HOSTILE_NAME].sort(), "the option text is the contact's name");

    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the hostile name is escaped");
    assert.ok(!html.includes(HOSTILE_NAME), "and never reaches the page as markup");

    const roles = [...document.querySelectorAll("[data-c2c-invite] [data-c2c-role] option")].map((o) => o.textContent);
    assert.deepEqual(roles, ["Can view", "Can comment", "Can edit"]);

    const member = document.querySelector(`[data-c2c-member="${BOUND}"]`);
    assert.ok(member, "the live member is listed");
    assert.ok(member.querySelector("[data-c2c-update-required]"), "the update-required row is drawn");
    assert.equal(member.querySelector("[data-c2c-update-required]").textContent,
      "Ask them to update Crow to share with them.");
    assert.ok(member.querySelector("[data-c2c-member-role]"), "the role control");
    assert.ok(member.querySelector("[data-c2c-unshare]"), "the unshare control");

    // The unshare confirm's words, verbatim (the copy is pinned, the client carries the esc).
    const { t, tJs } = await import("../servers/gateway/dashboard/shared/i18n.js");
    assert.equal(t("projects.c2c.unshareConfirm", "en"),
      "Their Crow will be asked to delete it. We can't guarantee a copy wasn't kept.");
    assert.ok(c2cClientJs("en").includes(tJs("projects.c2c.unshareConfirm", "en")),
      "and the client is what asks it");
  } finally {
    await db.execute({ sql: "DELETE FROM dashboard_settings_overrides WHERE key = ?", args: [`c2c_update_required:crow:alex`] });
  }
});

test("the panel's visitor list draws Accept / Decline / Leave for a live visit", async () => {
  const invited = await newVisit({ state: "invited", name: "Shared garden" });
  const active = await newVisit({ state: "active", name: "Shared shed" });
  const ended = await newVisit({ state: "left", name: "Old thing" });

  const html = await renderPanel({});
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.ok(html.includes("Shared with you"), "the section is on the projects list");

  const invitedRow = document.querySelector(`[data-c2c-visit="${invited.id}"]`);
  assert.ok(invitedRow, "an unanswered invitation is listed");
  assert.equal(invitedRow.querySelector("[data-c2c-visit-state]").textContent, "Invited");
  assert.equal(invitedRow.querySelector('[data-c2c-act="accept"]').hasAttribute("hidden"), false);
  assert.equal(invitedRow.querySelector('[data-c2c-act="decline"]').hasAttribute("hidden"), false);
  assert.equal(invitedRow.querySelector('[data-c2c-act="leave"]').hasAttribute("hidden"), true);
  assert.match(invitedRow.textContent, /Shared garden/);
  assert.match(invitedRow.textContent, /from alex/);

  const activeRow = document.querySelector(`[data-c2c-visit="${active.id}"]`);
  assert.equal(activeRow.querySelector("[data-c2c-visit-state]").textContent, "Active");
  assert.equal(activeRow.querySelector('[data-c2c-act="accept"]').hasAttribute("hidden"), true);
  assert.equal(activeRow.querySelector('[data-c2c-act="leave"]').hasAttribute("hidden"), false);

  assert.equal(document.querySelector(`[data-c2c-visit="${ended.id}"]`), null,
    "a visit that is over has nothing to answer and is not listed");
});

test("the panel client is a template literal's worth: no backtick, no dollar-brace, parses", () => {
  for (const lang of ["en", "es"]) {
    const js = c2cClientJs(lang);
    assert.equal(js.includes("`"), false, `no backtick (${lang})`);
    assert.equal(js.includes("${"), false, `no dollar-brace (${lang})`);
    const body = js.slice(js.indexOf("<script>") + "<script>".length, js.lastIndexOf("</script>"));
    assert.doesNotThrow(() => new Function(body), `the client parses (${lang})`);
    assert.match(js, /'X-Crow-Csrf': csrf\(\)/, "it posts JSON with the dashboard's CSRF token");
    assert.match(js, /\/dashboard\/c2c-api/);
    assert.match(js, /textContent/, "and writes text, never markup");
    assert.doesNotMatch(js, /\.innerHTML|insertAdjacentHTML|document\.write/);
  }
});