/**
 * Bar on every Crow page (2026-10-16): the player shell never reaches a public or anonymous response.
 *
 *  - Allowlist: the only modules that emit the shell are routes behind dashboardAuth (the artifact viewer,
 *    the markdown file viewer). A new caller must be added here, after checking its route is authenticated
 *    and never Funnel-reachable.
 *  - Funnel: a request carrying Tailscale-Funnel-Request to either page is refused by the gateway's own
 *    middleware (rejectFunneledMiddleware, unchanged) before any route runs, and by isAllowedNetwork.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import express from "express";
import { rejectFunneledMiddleware, PUBLIC_FUNNEL_PREFIXES, isFunnelPublicPath } from "../servers/gateway/funnel.js";
import { isAllowedNetwork } from "../servers/gateway/dashboard/auth.js";

const ROOT = new URL("..", import.meta.url).pathname;
const ALLOWED = new Set(["bundles/artifacts/panel/routes.js", "servers/gateway/routes/fileview.js"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("only the allowlisted, dashboardAuth'd routes emit the player shell", () => {
  const callers = [];
  for (const dir of ["servers", "bundles", "scripts"]) {
    for (const f of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, f);
      if (rel === "servers/gateway/dashboard/shared/player-shell.js") continue;
      if (/player-shell(\.js)?["']|playerShellHtml/.test(readFileSync(f, "utf8"))) callers.push(rel);
    }
  }
  assert.deepEqual(callers.sort(), [...ALLOWED].sort());
});

test("both shell pages are /dashboard/* paths, which are never in the Funnel allowlist", () => {
  for (const p of ["/dashboard/artifacts/view/art_abcdef12", "/dashboard/fileview"]) {
    assert.equal(isFunnelPublicPath(p, PUBLIC_FUNNEL_PREFIXES), false, p);
  }
});

test("a Funnel request to the viewer or the file viewer is refused before any route (even with a session cookie), and isAllowedNetwork refuses it too", async () => {
  const app = express();
  app.use(rejectFunneledMiddleware());
  app.get(["/dashboard/artifacts/view/:id", "/dashboard/fileview"], (_req, res) => res.type("html").send('<div id="crow-player-bar"></div>'));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of ["/dashboard/artifacts/view/art_abcdef12", "/dashboard/fileview?path=/home/x/a.md"]) {
      const r = await fetch(base + p, { headers: { "Tailscale-Funnel-Request": "?1", Cookie: "crow_session=anything" } });
      assert.equal(r.status, 403, p);
      assert.doesNotMatch(await r.text(), /crow-player-bar/, p);
      const ok = await fetch(base + p);
      assert.equal(ok.status, 200, "the same path off Funnel reaches the route (the control)");
    }
  } finally { srv.close(); }
  const prev = process.env.CROW_DASHBOARD_PUBLIC;
  delete process.env.CROW_DASHBOARD_PUBLIC;
  try {
    assert.equal(isAllowedNetwork({ headers: { "tailscale-funnel-request": "?1", "tailscale-user-login": "alex@example.com" }, ip: "127.0.0.1" }), false);
  } finally { if (prev !== undefined) process.env.CROW_DASHBOARD_PUBLIC = prev; }
});
