/** Settings → Passwords (Task 8): pure render + the client executed in linkedom/vm. */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { renderPasswordsPage, passwordsClientJS } from "../servers/gateway/dashboard/settings/sections/passwords.js";
import section from "../servers/gateway/dashboard/settings/sections/passwords.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const ENTRIES = [
  { id: 1, kind: "extension", label: "Crow Workspace — WORKSPACE_ADMIN_PASSWORD", bundle_id: "workspace", env_key: "WORKSPACE_ADMIN_PASSWORD", username: "admin", url: null, origin: "typed", status: "active", updated_at: "2026-10-03T12:00:00.000Z" },
  { id: 2, kind: "manual", label: "<script>alert(1)</script>", bundle_id: null, env_key: null, username: "casey", url: "https://ws.example:8456", origin: "manual", status: "active", updated_at: "2026-10-03T12:00:00.000Z" },
  { id: 3, kind: "extension", label: "Vaultwarden — admin token", bundle_id: "vaultwarden", env_key: "VAULTWARDEN_ADMIN_TOKEN", username: null, url: "http://localhost:8097/admin", origin: "generated", status: "extension_removed", updated_at: "2026-10-03T12:00:00.000Z", readable: true },
  { id: 4, kind: "manual", label: "From the old machine", bundle_id: null, env_key: null, username: null, url: null, origin: "manual", status: "active", updated_at: "2026-10-03T12:00:00.000Z", readable: false },
  { id: 5, kind: "extension", label: "Vaultwarden — live token", bundle_id: "vaultwarden", env_key: "X", username: null, url: null, origin: "generated", status: "active", updated_at: "2026-10-03T12:00:00.000Z", readable: true },
];

function boot({ method = "password", vaultAvailable = true, routes = {}, confirmAnswer = true, port = null, crow = null, userAgent = "Mozilla/5.0 (X11; Linux x86_64)" } = {}) {
  const html = renderPasswordsPage({ entries: ENTRIES, method, vaultAvailable, lang: "en" });
  const client = passwordsClientJS("en");
  const js = client.slice(client.indexOf("<script>") + 8, client.lastIndexOf("</script>"));
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  const clipboard = [];
  const fetchStub = (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const path = String(url).replace("/dashboard/keychain/api", "");
    const h = routes[path] || (() => ({ status: 200, d: {} }));
    const { status, d } = h(body, calls);
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(d), text: () => Promise.resolve(typeof d === "string" ? d : JSON.stringify(d)) });
  };
  window.CrowDownloadPort = port || undefined; // linkedom shares one window object across parseHTML calls
  window.Crow = crow || undefined;
  const anchorClicks = [];
  document.addEventListener("click", (e) => { if (e.target && e.target.tagName === "A") anchorClicks.push({ href: e.target.getAttribute("href"), download: e.target.getAttribute("download"), turbo: e.target.getAttribute("data-turbo"), prefetch: e.target.getAttribute("data-turbo-prefetch") }); });
  const reloads = { n: 0 };
  const confirms = [];
  const timers = [];
  const ctx = vm.createContext({
    window, document, console, fetch: fetchStub,
    location: { reload() { reloads.n++; } },
    navigator: { userAgent, clipboard: { writeText: (s) => { clipboard.push(s); return Promise.resolve(); } } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (id) => { if (typeof id === "number" && timers[id - 1]) timers[id - 1] = () => {}; }, Date,
  });
  ctx.confirm = (q) => { confirms.push(q); return confirmAnswer; };
  vm.runInContext(js, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { document, click, settle, calls, clipboard, reloads, confirms, timers, anchorClicks };
}

test("the page lists metadata only, escapes labels, marks removed extensions, and asks for the right re-auth", () => {
  const html = renderPasswordsPage({ entries: ENTRIES, method: "totp", vaultAvailable: false, lang: "en" });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, new RegExp(t("passwords.statusRemoved", "en")));
  assert.match(html, /id="pw-root"[^>]*data-method="totp"/);
  assert.match(html, /id="pw-reauth-input"[^>]*inputmode="numeric"/);
  assert.equal((html.match(/class="[^"]*pw-vault[ "]/g) || []).length, 0, "no vault buttons without the CLI");
  assert.equal((renderPasswordsPage({ entries: ENTRIES, method: "password", vaultAvailable: true, lang: "en" }).match(/class="[^"]*pw-vault[ "]/g) || []).length, 5);
  assert.match(renderPasswordsPage({ entries: [], method: "password", vaultAvailable: false, lang: "es" }), new RegExp(t("passwords.empty", "es")));
  assert.equal(section.id, "passwords");
  assert.equal(section.group, "account");
  assert.notEqual(t("settings.section.passwords", "es"), "settings.section.passwords");
});

test("Reveal without a grant opens the re-auth panel; confirming retries and shows the secret", async () => {
  let granted = false;
  const s = boot({ routes: {
    "/reveal": () => (granted ? { status: 200, d: { secret: "p a$s'w\"d" } } : { status: 403, d: { code: "reauth_required" } }),
    "/reauth": (b) => (b.password === "right" ? ((granted = true), { status: 200, d: { ok: true, expires_at: Date.now() + 300000 } }) : { status: 401, d: { error: "That password is not correct." } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  await s.settle();
  const row = s.document.querySelector('tr.pw-row[data-id="1"]');
  s.click(row.querySelector(".pw-reveal"));
  await s.settle();
  const panel = s.document.getElementById("pw-reauth");
  assert.equal(panel.hidden, false);
  s.document.getElementById("pw-reauth-input").value = "wrong";
  s.click(s.document.getElementById("pw-reauth-go"));
  await s.settle();
  assert.match(s.document.getElementById("pw-reauth-error").textContent, /not correct/);
  s.document.getElementById("pw-reauth-input").value = "right";
  s.click(s.document.getElementById("pw-reauth-go"));
  await s.settle();
  assert.equal(panel.hidden, true);
  assert.equal(s.document.getElementById("pw-reauth-input").value, "", "the typed password is cleared");
  const cell = row.querySelector(".pw-secret");
  assert.equal(cell.hidden, false);
  assert.equal(cell.textContent, "p a$s'w\"d");
  assert.deepEqual(s.calls.filter((c) => c.url.endsWith("/reveal")).map((c) => c.body), [{ id: 1, purpose: "reveal" }, { id: 1, purpose: "reveal" }]);
});

test("TOTP mode sends totp_code, never password", async () => {
  const s = boot({ method: "totp", routes: { "/reveal": () => ({ status: 403, d: { code: "reauth_required" } }), "/reauth": () => ({ status: 401, d: { error: "That code is not valid." } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-reveal'));
  await s.settle();
  s.document.getElementById("pw-reauth-input").value = "123456";
  s.click(s.document.getElementById("pw-reauth-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/reauth")).body, { totp_code: "123456" });
});

test("Copy copies, Delete removes the row, Save to vault sends the typed credentials once", async () => {
  const s = boot({ routes: {
    "/reveal": () => ({ status: 200, d: { secret: "copied-secret" } }),
    "/delete": () => ({ status: 200, d: { ok: true } }),
    "/vault-save": () => ({ status: 200, d: { ok: false, reason: "Vaultwarden did not accept that email or master password." } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  s.click(s.document.querySelector('tr.pw-row[data-id="2"] .pw-copy'));
  await s.settle();
  assert.deepEqual(s.clipboard, ["copied-secret"]);
  assert.equal(s.document.querySelector('tr.pw-row[data-id="2"] .pw-secret').hidden, true, "copy never paints the secret");

  s.click(s.document.querySelector('tr.pw-row[data-id="2"] .pw-delete'));
  await s.settle();
  assert.equal(s.document.querySelector('tr.pw-row[data-id="2"]'), null);

  s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-vault'));
  s.document.getElementById("pw-vault-email").value = "k@example.invalid";
  s.document.getElementById("pw-vault-password").value = "Master-PW";
  s.click(s.document.getElementById("pw-vault-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/vault-save")).body, { id: 1, vault_email: "k@example.invalid", vault_password: "Master-PW" });
  assert.equal(s.document.getElementById("pw-vault-password").value, "", "master password field cleared after the attempt");
  assert.match(s.document.getElementById("pw-vault-msg").textContent, /did not accept/);
});

test("Add posts the form and reloads; an empty form is refused client-side", async () => {
  const s = boot({ routes: { "/add": () => ({ status: 200, d: { ok: true, id: 9 } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.getElementById("pw-add-go"));
  await s.settle();
  assert.equal(s.calls.filter((c) => c.url.endsWith("/add")).length, 0);
  s.document.getElementById("pw-add-label").value = "Workspace phone (Casey)";
  s.document.getElementById("pw-add-secret").value = "abcd-efgh";
  s.click(s.document.getElementById("pw-add-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/add")).body, { label: "Workspace phone (Casey)", username: "", url: "", secret: "abcd-efgh" });
  assert.equal(s.reloads.n, 1);
});

test("C7 — an entry sealed under a missing key shows as unreadable: no reveal/copy/vault, delete still allowed", () => {
  const { document } = boot();
  const row = document.querySelector('tr.pw-row[data-id="4"]');
  assert.match(row.textContent, new RegExp(t("passwords.statusUnreadable", "en")));
  for (const c of [".pw-reveal", ".pw-copy", ".pw-vault"]) assert.equal(row.querySelector(c).hasAttribute("disabled"), true, c);
  assert.equal(row.querySelector(".pw-delete").hasAttribute("disabled"), false);
});

test("Q6 — with no dashboard password and no 2FA the page explains and disables everything that needs re-auth", () => {
  const html = renderPasswordsPage({ entries: ENTRIES, method: "none", vaultAvailable: true, lang: "en" });
  assert.match(html, /id="pw-noreauth"/);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const sel of [".pw-reveal", ".pw-copy", ".pw-delete", "#pw-export-go", "#pw-import-go"]) {
    for (const el of document.querySelectorAll(sel)) assert.equal(el.hasAttribute("disabled"), true, sel);
  }
  assert.equal(document.getElementById("pw-add-go").hasAttribute("disabled"), false, "adding needs no re-auth");
});

test("C5 — deleting an in-use generated token asks a stronger question and sends confirm_generated", async () => {
  const s = boot({ routes: { "/delete": () => ({ status: 200, d: { ok: true } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.querySelector('tr.pw-row[data-id="5"] .pw-delete'));
  await s.settle();
  assert.match(s.confirms[0], /keeps no other copy/);
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/delete")).body, { id: 5, confirm_generated: true });
});

test("S2 — a revealed password is wiped after 30 s", async () => {
  const s = boot({ routes: { "/reveal": () => ({ status: 200, d: { secret: "shown-once" } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-reveal'));
  await s.settle();
  const cell = s.document.querySelector('tr.pw-row[data-id="1"] .pw-secret');
  assert.equal(cell.textContent, "shown-once");
  s.timers.splice(0).forEach((fn) => fn());
  assert.equal(cell.textContent, "");
  assert.equal(cell.hidden, true);
});

test("Export checks the passphrase pair client-side, then posts it (re-auth flow applies); Import posts the parsed file", async () => {
  const exported = { format: "crow-keychain-export", version: 1, count: 2 };
  const s = boot({ routes: {
    "/export": () => ({ status: 200, d: TICKET }),
    "/import": () => ({ status: 200, d: { ok: true, imported: 2, skipped: 0 } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  s.document.getElementById("pw-export-pass").value = "short";
  s.click(s.document.getElementById("pw-export-go"));
  assert.equal(s.calls.filter((c) => c.url.endsWith("/export")).length, 0);
  s.document.getElementById("pw-export-pass").value = "correct horse battery";
  s.document.getElementById("pw-export-confirm").value = "correct horse batteryX";
  s.click(s.document.getElementById("pw-export-go"));
  assert.equal(s.calls.filter((c) => c.url.endsWith("/export")).length, 0, "mismatch refused");
  s.document.getElementById("pw-export-confirm").value = "correct horse battery";
  s.click(s.document.getElementById("pw-export-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/export")).body, { passphrase: "correct horse battery" });
  assert.match(s.document.getElementById("pw-export-msg").textContent, /Your file of 2 passwords is ready/);
  assert.equal(s.document.getElementById("pw-export-pass").value, "", "passphrase cleared");

  const input = s.document.getElementById("pw-import-file");
  Object.defineProperty(input, "files", { value: [{ text: () => Promise.resolve(JSON.stringify(exported)) }] });
  s.document.getElementById("pw-import-pass").value = "correct horse battery";
  s.click(s.document.getElementById("pw-import-go"));
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/import")).body, { file: exported, passphrase: "correct horse battery" });
  assert.match(s.document.getElementById("pw-import-msg").textContent, /2 imported, 0 already here/);
});

const TOKEN = "T".repeat(43);
const TICKET = { ok: true, count: 2, filename: "crow-keychain-2026-10-20.json", token: TOKEN, download: "/dashboard/keychain/api/export/file/" + TOKEN, expires_at: "2026-10-20T12:02:00.000Z" };
const exportWith = async (s) => {
  s.document.getElementById("pw-export-pass").value = "correct horse battery";
  s.document.getElementById("pw-export-confirm").value = "correct horse battery";
  s.click(s.document.getElementById("pw-export-go"));
  await s.settle();
};
function fakePort({ answer = { ok: true } } = {}) {
  const port = { sent: [], listeners: [] };
  port.addEventListener = (type, fn) => { if (type === "message") port.listeners.push(fn); };
  port.removeEventListener = (type, fn) => { port.listeners = port.listeners.filter((f) => f !== fn); };
  port.postMessage = (s) => {
    port.sent.push(JSON.parse(s));
    const m = JSON.parse(s);
    if (answer) setImmediate(() => port.listeners.forEach((fn) => fn({ data: JSON.stringify({ type: "download", id: m.id, ...answer }) })));
  };
  return port;
}

test("browser Export: a one-time attachment link (no blob:) the user taps; it goes away once tapped, or after 2 minutes; nothing is confirmed", async () => {
  const s = boot({ routes: { "/export": () => ({ status: 200, d: TICKET }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  assert.deepEqual(s.anchorClicks, [], "no programmatic click: the tap is the user's");
  const box = s.document.getElementById("pw-export-link");
  assert.equal(box.hidden, false);
  const link = box.querySelector("a");
  assert.equal(link.getAttribute("href"), TICKET.download);
  assert.equal(link.getAttribute("download"), TICKET.filename);
  assert.equal(link.getAttribute("data-turbo"), "false");
  assert.equal(link.getAttribute("data-turbo-prefetch"), "false");
  assert.match(s.document.getElementById("pw-export-msg").textContent, /ready.*works once/);
  assert.equal(s.calls.filter((c) => c.url.includes("/export/file/")).length, 0, "the page itself never fetches the file");
  link.click();
  assert.deepEqual(s.anchorClicks, [{ href: TICKET.download, download: TICKET.filename, turbo: "false", prefetch: "false" }]);
  assert.match(s.document.getElementById("pw-export-msg").textContent, /Downloading crow-keychain-2026-10-20\.json \(2 passwords\).*If no file appeared/);
  s.timers.splice(0).forEach((fn) => fn());
  assert.equal(box.hidden, true, "spent once tapped");
  assert.match(s.document.getElementById("pw-export-msg").textContent, /Downloading/, "the expiry timer was cancelled by the tap");
  assert.equal(s.calls.filter((c) => c.url.endsWith("/export/saved")).length, 0);

  const u = boot({ routes: { "/export": () => ({ status: 200, d: TICKET }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(u);
  u.timers.splice(0).forEach((fn) => fn());
  assert.equal(u.document.getElementById("pw-export-link").hidden, true, "untapped: gone after 2 minutes");
  assert.match(u.document.getElementById("pw-export-msg").textContent, /expired/);
});

test("Crow app: Saved, but a refused /export/saved says the reminder stays", async () => {
  const port = fakePort();
  const s = boot({ port, userAgent: "CrowAndroid/1.6.3", routes: { "/export": () => ({ status: 200, d: TICKET }), ["/export/file/" + TOKEN + "?confirm=1"]: () => ({ status: 200, d: "{}" }), "/export/saved": () => ({ status: 410, d: { code: "export_link_expired" } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  await s.settle();
  assert.match(s.document.getElementById("pw-export-msg").textContent, /^Saved 2 passwords.*reminder stays/);
});

test("Crow app on a WebView without the save bridge (downloadStatus 'unsupported') says so, without spending the link", async () => {
  const s = boot({ crow: { downloadStatus: () => "unsupported" }, userAgent: "CrowAndroid/1.6.3", routes: { "/export": () => ({ status: 200, d: TICKET }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  assert.equal(s.calls.filter((c) => c.url.includes("/export/file/")).length, 0);
  assert.match(s.document.getElementById("pw-export-msg").textContent, /WebView on this phone is too old/);
});

test("an answer without our link shape is an error, not a navigation", async () => {
  const s = boot({ routes: { "/export": () => ({ status: 200, d: { ...TICKET, download: "https://elsewhere.example/x" } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  assert.deepEqual(s.anchorClicks, []);
  assert.equal(s.document.getElementById("pw-export-link").hidden, true);
});

test("Crow app 1.6.3+: fetch with ?confirm=1, save through CrowDownloadPort, confirm only after the app says ok", async () => {
  const port = fakePort();
  const s = boot({ port, userAgent: "Mozilla/5.0 CrowAndroid/1.6.3", routes: {
    "/export": () => ({ status: 200, d: TICKET }),
    ["/export/file/" + TOKEN + "?confirm=1"]: () => ({ status: 200, d: '{"format":"crow-keychain-export"}' }),
    "/export/saved": () => ({ status: 200, d: { ok: true } }),
    "/activity": () => ({ status: 200, d: { events: [] } }),
  } });
  await exportWith(s);
  assert.deepEqual(s.anchorClicks, [], "no download navigation inside the app");
  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].op, "save");
  assert.match(port.sent[0].id, /^[A-Za-z0-9]{1,32}$/);
  assert.equal(port.sent[0].name, TICKET.filename);
  assert.equal(port.sent[0].mime, "application/json");
  assert.equal(port.sent[0].text, '{"format":"crow-keychain-export"}');
  await s.settle();
  assert.deepEqual(s.calls.find((c) => c.url.endsWith("/export/saved")).body, { token: TOKEN });
  assert.match(s.document.getElementById("pw-export-msg").textContent, /^Saved 2 passwords/);
});

test("Crow app: a cancelled or failed save says so and never confirms", async () => {
  for (const answer of [{ ok: false, reason: "cancelled" }, { ok: false, reason: "failed" }]) {
    const port = fakePort({ answer });
    const s = boot({ port, userAgent: "CrowAndroid/1.6.3", routes: {
      "/export": () => ({ status: 200, d: TICKET }),
      ["/export/file/" + TOKEN + "?confirm=1"]: () => ({ status: 200, d: "{}" }),
      "/activity": () => ({ status: 200, d: { events: [] } }),
    } });
    await exportWith(s);
    await s.settle();
    assert.equal(s.calls.filter((c) => c.url.endsWith("/export/saved")).length, 0);
    assert.match(s.document.getElementById("pw-export-msg").textContent, /The file was not saved/);
  }
  // A reply for an id the page never sent is ignored.
  const port = fakePort({ answer: null });
  const s = boot({ port, userAgent: "CrowAndroid/1.6.3", routes: { "/export": () => ({ status: 200, d: TICKET }), ["/export/file/" + TOKEN + "?confirm=1"]: () => ({ status: 200, d: "{}" }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  port.listeners.forEach((fn) => fn({ data: JSON.stringify({ type: "download", id: "someoneelse", ok: true }) }));
  await s.settle();
  assert.equal(s.calls.filter((c) => c.url.endsWith("/export/saved")).length, 0);
});

test("an older Crow app (no CrowDownloadPort) is told to update; the link is never fetched or clicked", async () => {
  const s = boot({ userAgent: "Mozilla/5.0 CrowAndroid/1.6.1", routes: { "/export": () => ({ status: 200, d: TICKET }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  assert.deepEqual(s.anchorClicks, []);
  assert.equal(s.calls.filter((c) => c.url.includes("/export/file/")).length, 0);
  assert.match(s.document.getElementById("pw-export-msg").textContent, /cannot save files/);
});

test("a Crow app 1.6.3+ away from its paired server says so, and never spends the link", async () => {
  const s = boot({ crow: { downloadStatus: () => "unavailable" }, userAgent: "CrowAndroid/1.6.3", routes: { "/export": () => ({ status: 200, d: TICKET }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  assert.deepEqual(s.anchorClicks, []);
  assert.equal(s.calls.filter((c) => c.url.includes("/export/file/")).length, 0);
  assert.match(s.document.getElementById("pw-export-msg").textContent, /paired/);
});

test("Crow app: the picked file name is shown; no reply in 10 minutes reads as not saved", async () => {
  const port = fakePort({ answer: { ok: true, name: "my-keys.json" } });
  const s = boot({ port, userAgent: "CrowAndroid/1.6.3", routes: { "/export": () => ({ status: 200, d: TICKET }), ["/export/file/" + TOKEN + "?confirm=1"]: () => ({ status: 200, d: "{}" }), "/export/saved": () => ({ status: 200, d: { ok: true } }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(s);
  await s.settle();
  assert.match(s.document.getElementById("pw-export-msg").textContent, /Saved 2 passwords to my-keys\.json/);
  const silent = fakePort({ answer: null });
  const t2 = boot({ port: silent, userAgent: "CrowAndroid/1.6.3", routes: { "/export": () => ({ status: 200, d: TICKET }), ["/export/file/" + TOKEN + "?confirm=1"]: () => ({ status: 200, d: "{}" }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(t2);
  await t2.settle();
  assert.match(t2.document.getElementById("pw-export-msg").textContent, /Choose where/);
  t2.timers.splice(0).forEach((fn) => fn());
  assert.match(t2.document.getElementById("pw-export-msg").textContent, /The file was not saved/);
  assert.equal(t2.calls.filter((c) => c.url.endsWith("/export/saved")).length, 0);
});

test("turbo:before-cache unwires the port listener and removes the one-time link", async () => {
  const port = fakePort({ answer: null });
  const s = boot({ port, routes: { "/activity": () => ({ status: 200, d: { events: [] } }) } });
  assert.equal(port.listeners.length, 1);
  s.document.dispatchEvent(new s.document.defaultView.Event("turbo:before-cache"));
  assert.equal(port.listeners.length, 0);
  const b = boot({ routes: { "/export": () => ({ status: 200, d: TICKET }), "/activity": () => ({ status: 200, d: { events: [] } }) } });
  await exportWith(b);
  assert.equal(b.document.getElementById("pw-export-link").hidden, false);
  b.document.dispatchEvent(new b.document.defaultView.Event("turbo:before-cache"));
  assert.equal(b.document.getElementById("pw-export-link").hidden, true);
});

test("the export strings exist in en and es; the client has no backtick and no backslash", () => {
  for (const k of ["exportReady", "exportLink", "exportSaving", "exportSaved", "exportNotSaved", "exportOldApp", "exportElsewhere", "exportNoBridge", "exportDownloading", "exportLinkExpired", "exportSavedUnrecorded", "event.keychain_export_fetched", "event.keychain_export_saved"]) {
    for (const lang of ["en", "es"]) assert.notEqual(t("passwords." + k, lang), "passwords." + k, k + " " + lang);
  }
  for (const lang of ["en", "es"]) {
    const js = passwordsClientJS(lang);
    assert.ok(!js.includes("`"), "no backtick");
    assert.ok(!js.includes("\\"), "no backslash");
    assert.ok(!js.includes("createObjectURL"), "no blob: download any more");
  }
});

test("R-B — vault availability needs a secure https Vaultwarden; otherwise the page shows the https note and no vault buttons", async () => {
  const { vaultState } = await import("../servers/gateway/dashboard/settings/sections/passwords.js");
  assert.deepEqual(vaultState({ installed: true, cliPath: "/bw", secure: true }), { vaultAvailable: true, vaultNeedsHttps: false });
  assert.deepEqual(vaultState({ installed: true, cliPath: "/bw", secure: false }), { vaultAvailable: false, vaultNeedsHttps: true });
  assert.deepEqual(vaultState({ installed: true, cliPath: null, secure: false }), { vaultAvailable: false, vaultNeedsHttps: false });
  assert.deepEqual(vaultState({ installed: false, cliPath: "/bw", secure: true }), { vaultAvailable: false, vaultNeedsHttps: false });
  for (const lang of ["en", "es"]) {
    const html = renderPasswordsPage({ entries: ENTRIES, method: "password", vaultAvailable: false, vaultNeedsHttps: true, lang });
    assert.match(html, /id="pw-vault-https-note"/);
    assert.ok(html.includes(t("keychain.vaultNeedsHttps", lang)));
    assert.equal((html.match(/class="[^"]*pw-vault[ "]/g) || []).length, 0);
  }
  assert.doesNotMatch(renderPasswordsPage({ entries: ENTRIES, method: "password", vaultAvailable: true, lang: "en" }), /pw-vault-https-note/);
});

test("[hidden] carry — a scoped rule keeps toggled elements hidden despite display rules, and they sit inside the scope", () => {
  const html = renderPasswordsPage({ entries: ENTRIES, method: "password", vaultAvailable: true, lang: "en" });
  assert.match(html, /#pw-root \[hidden\]\s*\{\s*display:\s*none\s*!important/);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const hiddens = document.querySelectorAll("[hidden]");
  assert.ok(hiddens.length >= 3);
  for (const el of hiddens) assert.ok(el.closest("#pw-root"), "hidden element outside #pw-root");
});

test("S2/Turbo — revealed plaintext is wiped on turbo:before-cache and when the tab is hidden", async () => {
  const reveal = { "/reveal": () => ({ status: 200, d: { secret: "shown" } }), "/activity": () => ({ status: 200, d: { events: [] } }) };
  for (const how of ["cache", "hidden"]) {
    const s = boot({ routes: reveal });
    s.click(s.document.querySelector('tr.pw-row[data-id="1"] .pw-reveal'));
    await s.settle();
    const cell = s.document.querySelector('tr.pw-row[data-id="1"] .pw-secret');
    assert.equal(cell.textContent, "shown");
    if (how === "cache") s.document.dispatchEvent(new s.document.defaultView.Event("turbo:before-cache"));
    else {
      Object.defineProperty(s.document, "visibilityState", { value: "visible", configurable: true });
      s.document.dispatchEvent(new s.document.defaultView.Event("visibilitychange"));
      assert.equal(cell.textContent, "shown", "visible tab keeps it");
      Object.defineProperty(s.document, "visibilityState", { value: "hidden", configurable: true });
      s.document.dispatchEvent(new s.document.defaultView.Event("visibilitychange"));
    }
    assert.equal(cell.textContent, "", how);
    assert.equal(cell.hidden, true, how);
  }
});

test("a javascript: entry url renders as plain text, never an href; http(s) stays a link", () => {
  const entries = [
    { id: 1, kind: "manual", label: "a", url: "javascript:alert(1)", origin: "manual", status: "active", updated_at: "" },
    { id: 2, kind: "manual", label: "b", url: "HTTPS://ok.example/x", origin: "manual", status: "active", updated_at: "" },
  ];
  const html = renderPasswordsPage({ entries, method: "password", vaultAvailable: false, lang: "en" });
  assert.ok(!/href="javascript:/i.test(html));
  assert.ok(html.includes("javascript:alert(1)"), "shown as text");
  assert.match(html, /<a href="HTTPS:\/\/ok\.example\/x"/);
});
