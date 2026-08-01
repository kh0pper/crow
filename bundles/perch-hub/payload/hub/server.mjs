#!/usr/bin/env node
/**
 * pi-hub — standalone multi-session hub daemon (one per machine).
 *
 * Two listeners, both loopback-only:
 *   127.0.0.1:4200  public surface (front it with Tailscale Serve for HTTPS):
 *     GET  /                     hub home (live sessions, on-disk sessions, spawn)
 *     GET  /login, POST /login   cookie login (token = pi-webserver apiToken)
 *     *    /s/<pid>/...          reverse proxy to that session's web server
 *                                (SSE-safe; Bearer header injected)
 *     GET  /api/hub/sessions     on-disk sessions (bot workspaces filtered;
 *                                ?archived=1 includes archived)
 *     GET  /api/hub/live         registered live sessions
 *     POST /api/hub/archive      {id, archived} → sidecar archive flag
 *     POST /api/hub/spawn        {cwd, prompt?, model?} → tmux pi session
 *     POST /api/hub/resume       {file} → tmux pi session (refused if a live
 *                                registered process already owns the file)
 *   127.0.0.1:4201  registry (NEVER fronted by Serve; loopback peers only):
 *     POST /register             {pid, sessionId, sessionFile, cwd, name}
 *                                → {port} from the 4101–4139 pool (idempotent upsert)
 *     POST /unregister           {pid}
 *
 * Why the split: Tailscale Serve proxies arrive FROM 127.0.0.1, so a
 * remote-address check on one port can't tell tailnet traffic from local pi
 * processes. The registry port simply is not part of the Serve config, so
 * nothing off-machine can reach it to hijack the /s/ proxy targets.
 *
 * Auth on :4200: Bearer <apiToken> (read live from ~/.pi/agent/settings.json
 * → "pi-webserver".apiToken) or the HMAC session cookie set by /login.
 * Everything except /login requires auth — /api/hub/spawn is arbitrary code
 * execution and the tailnet is not a trust boundary.
 *
 * Crow mode (PERCH_CROW_MODE=1): the hub runs as a supervised child of a Crow
 * gateway, on loopback ports of the gateway's choosing, reached only through
 * the gateway's session-gated proxy at PERCH_BASE_PATH. The gateway mints the
 * bearer (PERCH_API_TOKEN) and injects it on every proxied request, so /login
 * is switched off — it could only misfire. Every env below is optional and
 * defaults to today's behavior byte-for-byte.
 */

import crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_EXCLUDE_CWD_PATTERNS, listSessions, listTmuxPiSessions, setSessionArchived, spawnSession, teleportCommand } from "../lib/sessions.mjs";
import { apiTokenFromEnv } from "./auth-source.mjs";
import { renderBotsPage } from "./bots-page.mjs";

const PUBLIC_PORT = Number(process.env.PI_HUB_PORT ?? 4200);
const REGISTRY_PORT = Number(process.env.PI_HUB_REGISTRY_PORT ?? 4201);
const POOL_START = Number(process.env.PI_HUB_POOL_START ?? 4101);
const POOL_END = Number(process.env.PI_HUB_POOL_END ?? 4139);
const HEARTBEAT_TTL_MS = 90_000;

/** Embedded in a Crow gateway rather than standing alone. */
const CROW_MODE = process.env.PERCH_CROW_MODE === "1";
/** Path prefix this hub is served under, e.g. "/proxy/perch-hub". "" = served at the root. */
const BASE_PATH = (process.env.PERCH_BASE_PATH || "").replace(/\/$/, "");

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const sessionSecret = crypto.randomBytes(32);

function readSettings() {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
	} catch {
		return {};
	}
}

function apiToken() {
	return apiTokenFromEnv(process.env, () => readSettings()?.["pi-webserver"]?.apiToken ?? null);
}

function excludePatterns() {
	return readSettings()?.sessionWeb?.excludeCwdPatterns ?? DEFAULT_EXCLUDE_CWD_PATTERNS;
}

function peerHubs() {
	// settings.json → "piHub": { "peers": [{"label": "grackle", "url": "https://grackle...:8448"}] }
	return readSettings()?.piHub?.peers ?? [];
}

// ── Registry ──────────────────────────────────────────────────

/** pid → { pid, port, sessionId, sessionFile, cwd, name, lastSeen } */
const live = new Map();

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sweep() {
	const now = Date.now();
	for (const [pid, entry] of live) {
		if (now - entry.lastSeen > HEARTBEAT_TTL_MS || !pidAlive(pid)) live.delete(pid);
	}
}
setInterval(sweep, 30_000).unref();

function assignPort(pid) {
	const existing = live.get(pid);
	if (existing) return existing.port;
	const used = new Set([...live.values()].map((e) => e.port));
	for (let p = POOL_START; p <= POOL_END; p++) {
		if (!used.has(p)) return p;
	}
	return null;
}

// ── Auth (public listener) ────────────────────────────────────

function signCookie() {
	const payload = `hub.${Date.now()}`;
	const mac = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
	return `${payload}.${mac}`;
}

function cookieValid(cookieHeader) {
	const match = /(?:^|;\s*)pi-hub=([^;]+)/.exec(cookieHeader ?? "");
	if (!match) return false;
	const value = decodeURIComponent(match[1]);
	const lastDot = value.lastIndexOf(".");
	if (lastDot <= 0) return false;
	const payload = value.slice(0, lastDot);
	const mac = value.slice(lastDot + 1);
	const expect = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
	try {
		return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
	} catch {
		return false;
	}
}

function tokensEqual(a, b) {
	if (!a || !b) return false;
	const ba = Buffer.from(String(a));
	const bb = Buffer.from(String(b));
	return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isAuthed(req) {
	const token = apiToken();
	const auth = req.headers.authorization ?? "";
	if (auth.startsWith("Bearer ") && tokensEqual(auth.slice(7), token)) return true;
	return cookieValid(req.headers.cookie);
}

// ── Helpers ───────────────────────────────────────────────────

function json(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function readBody(req, limit = 65536) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
			if (body.length > limit) reject(new Error("body too large"));
		});
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A perched songbird silhouette, feet on the wire (fill = currentColor).
const BIRD_SVG = `<svg viewBox="0 0 32 22" fill="currentColor" aria-hidden="true">
<path d="M2 9c3-4 7-5 10-4 1.2-2.4 3.4-3.6 5.8-3.2 1.7.3 3 1.4 3.7 2.9l4.2 1.5c.4.15.4.6.05.8l-3.6 1.6c.2 2.6-.9 5.2-3.2 6.8-1.8 1.2-3.9 1.6-5.9 1.2l-1.5 3h-1.7l1.2-3.6c-1.9-.8-3.4-2.3-4.1-4.3C5.4 11 3.6 10 2 9z"/>
<circle cx="19.6" cy="5.6" r=".9" fill="var(--sky)"/>
<path d="M12.5 18.5h1.4l-.3 3h-1zM16.5 18.7h1.4l-.3 2.8h-1z"/>
</svg>`;

// ── Reverse proxy /s/<pid>/... ────────────────────────────────

function proxy(req, res, entry, subPath) {
	const upstream = http.request(
		{
			host: "127.0.0.1",
			port: entry.port,
			path: subPath || "/",
			method: req.method,
			headers: {
				...req.headers,
				host: `127.0.0.1:${entry.port}`,
				// Session servers check Bearer on /api/*; the hub already authed this request.
				authorization: `Bearer ${apiToken() ?? ""}`,
			},
		},
		(up) => {
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.pipe(res); // streams SSE fine — no buffering
		},
	);
	upstream.on("error", () => {
		if (!res.headersSent) json(res, 502, { error: "session web server unreachable" });
		else res.end();
	});
	req.pipe(upstream);
}

// ── Pages ─────────────────────────────────────────────────────

// ── Perch design system (user-selected: Perch layout + mono data bars) ──
const PERCH_CSS = `
:root{--sky:#eef1f3;--card:#fff;--ink:#22303a;--dim:#6b7c88;--teal:#0e6b62;--teal-soft:#dcecea;
--wire:#94a4ae;--alive:#2fa36b;--attn:#d1633e;--line:#dde4e8}
@media (prefers-color-scheme:dark){:root{--sky:#131a1f;--card:#1b242b;--ink:#e4ebef;--dim:#8fa0ab;
--teal:#4fbdb0;--teal-soft:#16322f;--wire:#46565f;--line:#2a353d}}
*{box-sizing:border-box;margin:0}
body{background:var(--sky);color:var(--ink);font:15px/1.5 Inter,"Public Sans",system-ui,sans-serif;max-width:640px;margin:0 auto;padding:0 16px 56px}
header{padding:30px 0 20px;display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.brand{font-size:26px;font-weight:600;letter-spacing:-.03em}
.brand small{color:var(--dim);font-weight:400;font-size:15px;margin-left:6px}
.machines{display:flex;gap:6px;font-size:13px}
.machines a{text-decoration:none;color:var(--dim);padding:5px 12px;border-radius:999px;border:1px solid var(--line)}
.machines a.here{background:var(--teal);border-color:var(--teal);color:#fff}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);font-weight:600;margin:30px 0 12px}
.perch{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 16px 0;margin:22px 0 12px;box-shadow:0 1px 2px rgb(0 0 0/4%)}
.perch::before{content:"";position:absolute;left:-6px;right:-6px;top:0;border-top:2px solid var(--wire)}
.bird{position:absolute;top:-17px;left:22px;width:26px;height:18px;color:var(--alive)}
.bird svg{width:100%;height:100%;display:block}
.bird.attn{color:var(--attn)}.bird.idle{color:var(--wire)}
.perch-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.title{font-weight:600;font-size:17px}
.meta{color:var(--dim);font-size:13px;margin-top:2px;word-break:break-all}
.state{font-size:13px;color:var(--alive);font-weight:500;white-space:nowrap}
.state.attn{color:var(--attn)}.state.idle{color:var(--dim)}
.row-actions{display:flex;gap:8px;margin:12px 0 14px;flex-wrap:wrap}
button{font:500 14px/1 Inter,system-ui,sans-serif;cursor:pointer;border-radius:10px;padding:10px 16px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button.primary{background:var(--teal);border-color:var(--teal);color:#fff}
button.quiet{color:var(--dim)}
a.btn{display:inline-block;text-decoration:none;font:500 14px/1 Inter,system-ui,sans-serif;border-radius:10px;padding:10px 16px;background:var(--teal);color:#fff}
.databar{margin:0 -16px;background:var(--teal-soft);border-top:1px solid var(--line);border-radius:0 0 13px 13px;padding:7px 16px;font:12px "JetBrains Mono",ui-monospace,monospace;color:var(--teal);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.databar .mono-dim{color:var(--dim)}
.spawn{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:grid;gap:10px}
input,textarea{font:14px Inter,system-ui,sans-serif;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--sky);color:var(--ink)}
input::placeholder,textarea::placeholder{color:var(--dim)}
.roost{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.roost-row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.roost-row:last-child{border-bottom:none}
.roost-dot{width:8px;height:8px;border-radius:50% 50% 50% 2px;background:var(--wire);flex-shrink:0;transform:rotate(-8deg)}
.roost-main{flex:1;min-width:180px}
.roost-cwd{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roost-when{color:var(--dim);font-size:12.5px;font-family:"JetBrains Mono",ui-monospace,monospace}
.roost-row button{padding:8px 12px;font-size:13px}
#msg{margin:10px 0;font-size:13px;min-height:18px}.ok{color:var(--alive)}
.empty{color:var(--dim);padding:16px;font-size:14px}
`;

const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Perch — sign in</title>
<style>${PERCH_CSS}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}
form{display:grid;gap:10px;width:300px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;position:relative}
form::before{content:"";position:absolute;left:0;right:0;top:0;border-top:2px solid var(--wire);border-radius:14px 14px 0 0}
form .bird{top:-5px}</style></head>
<body><form method="POST" action="login"><span class="bird">${BIRD_SVG}</span><div class="brand">Perch<small>pi session hub</small></div>
<input type="password" name="token" placeholder="API token" autofocus><button class="primary">Sign in</button></form></body></html>`;

/** Ask a live session's own web server for model/idle state. Fail-soft. */
async function sessionStatus(entry) {
	try {
		const res = await fetch(`http://127.0.0.1:${entry.port}/api/mobile/status`, {
			headers: { Authorization: `Bearer ${apiToken() ?? ""}` },
			signal: AbortSignal.timeout(600),
		});
		if (!res.ok) return null;
		const data = await res.json();
		return { model: data?.agent?.model ?? null, idle: data?.agent?.idle ?? null };
	} catch {
		return null;
	}
}

function homeTilde(p) {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function fmtAge(ms) {
	const m = (Date.now() - ms) / 60000;
	if (m < 60) return `${Math.round(m)}m ago`;
	if (m < 2880) return `${Math.round(m / 60)}h ago`;
	return `${Math.round(m / 1440)}d ago`;
}

async function homePage(host, { showArchived = false } = {}) {
	sweep();
	const entries = [...live.values()].sort((a, b) => b.lastSeen - a.lastSeen);
	const statuses = await Promise.all(entries.map(sessionStatus));

	const perches = entries
		.map((e, i) => {
			const st = statuses[i];
			const idle = st?.idle;
			const birdCls = idle === false ? "" : idle === true ? " idle" : "";
			const stateCls = idle === false ? "" : "idle";
			const stateTxt = idle === false ? "working" : idle === true ? "idle" : "live";
			return `<div class="perch"><span class="bird${birdCls}">${BIRD_SVG}</span>
<div class="perch-head"><div><div class="title">${esc(e.name || path.basename(e.cwd))}</div>
<div class="meta">${esc(homeTilde(e.cwd))}</div></div>
<div class="state ${stateCls}">${stateTxt}</div></div>
${CROW_MODE ? "" : `<div class="row-actions"><a class="btn" href="${BASE_PATH}/s/${e.pid}/mobile">Open chat</a></div>\n`}<div class="databar"><span>${esc(st?.model ?? "model unknown")}</span>
<span class="mono-dim">${esc((e.sessionId || "").slice(0, 8))} · pid ${e.pid}</span></div></div>`;
		})
		.join("");

	const disk = listSessions({ limit: 25, excludeCwdPatterns: excludePatterns(), includeArchived: showArchived })
		.filter((s) => s.archived === showArchived)
		.map(
			(s) => `<div class="roost-row"><span class="roost-dot"></span>
<div class="roost-main"><div class="roost-cwd">${esc(s.name || homeTilde(s.cwd))}</div>
<div class="roost-when">${s.name ? `${esc(homeTilde(s.cwd))} · ` : ""}${fmtAge(s.mtimeMs)} · ${esc(s.id.slice(0, 8))}</div></div>
<button class="resume" data-file="${esc(s.file)}">Resume</button>
<button class="quiet copy" data-cmd="${esc(teleportCommand(s))}">Teleport</button>
<button class="quiet arch" data-id="${esc(s.id)}" data-archived="${s.archived ? "1" : "0"}">${s.archived ? "Unarchive" : "Archive"}</button></div>`,
		)
		.join("");

	const peers = CROW_MODE
		? ""
		: peerHubs()
				.map((p) => `<a href="${esc(p.url)}">${esc(p.label)}</a>`)
				.join("");

	// Crow mode swaps the peer chips for the bots lens: peers are other machines'
	// hubs on their own origins, which the gateway's subpath proxy cannot reach,
	// and the /s/<pid>/ session panes above are raw pass-throughs it cannot rewrite.
	// What the crow surface gains instead is the second lens.
	const nav = CROW_MODE ? `<a class="here" href="${BASE_PATH}/">${esc(host)}</a><a href="${BASE_PATH}/bots">Bots</a>` : `<a class="here" href="${BASE_PATH}/">${esc(host)}</a>${peers}`;

	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perch · ${esc(host)}</title><style>${PERCH_CSS}</style></head><body>
<header><div class="brand">Perch<small>${esc(host)}</small></div>
<nav class="machines">${nav}</nav></header>
<div id="msg"></div>
<h2>On the wire — ${entries.length} live</h2>
${perches || '<div class="roost"><div class="empty">Nothing on the wire — start pi anywhere on this machine and it appears here.</div></div>'}
<h2>Start a session</h2>
<form class="spawn" id="spawn"><input name="cwd" placeholder="Working directory — e.g. /home/kh0pp/pi-lab" required>
<textarea name="prompt" rows="2" placeholder="First prompt (optional)"></textarea>
<button class="primary" style="justify-self:start">Spawn on ${esc(host)}</button></form>
<h2>${showArchived ? `Archived sessions — <a href="${BASE_PATH}/" style="color:var(--teal)">back to recent</a>` : `Roost — recent sessions · <a href="${BASE_PATH}/?archived=1" style="color:var(--dim)">archived</a>`}</h2>
<div class="roost">${disk || `<div class="empty">${showArchived ? "Nothing archived." : "No sessions on disk yet."}</div>`}</div>
<script>
const msg=(t,ok)=>{const el=document.getElementById("msg");el.textContent=t;el.className=ok?"ok":""};
const api=(p,b)=>fetch("${BASE_PATH}/api/hub"+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
document.getElementById("spawn").onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);
const r=await api("/spawn",{cwd:f.get("cwd"),prompt:f.get("prompt")||undefined});msg(r.error||("Spawned: "+r.command),!r.error);setTimeout(()=>location.reload(),1200)};
for(const b of document.querySelectorAll("button.resume"))b.onclick=async()=>{const r=await api("/resume",{file:b.dataset.file});msg(r.error||("Resumed: "+r.command),!r.error);setTimeout(()=>location.reload(),1200)};
for(const b of document.querySelectorAll("button.copy"))b.onclick=()=>navigator.clipboard.writeText(b.dataset.cmd).then(()=>msg("Copied: "+b.dataset.cmd,true));
for(const b of document.querySelectorAll("button.arch"))b.onclick=async()=>{const r=await api("/archive",{id:b.dataset.id,archived:b.dataset.archived!=="1"});msg(r.error||"Done",!r.error);setTimeout(()=>location.reload(),500)};
</script></body></html>`;
}

// ── Public listener ───────────────────────────────────────────

const publicServer = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${PUBLIC_PORT}`);
		const pathname = url.pathname;

		// Behind the crow gateway the bearer is injected on every proxied request,
		// so isAuthed() always passes and the login flow can only misfire — and a
		// cookie minted here would outlive the dashboard session that granted it.
		if (CROW_MODE && pathname === "/login") return json(res, 404, { error: "not found" });

		if (pathname === "/login" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			return res.end(LOGIN_HTML);
		}
		if (pathname === "/login" && req.method === "POST") {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				const token = new URLSearchParams(body).get("token") ?? "";
				if (!tokensEqual(token, apiToken())) {
					res.writeHead(302, { Location: `${BASE_PATH}/login` });
					return res.end();
				}
				res.writeHead(302, {
					Location: `${BASE_PATH}/`,
					// Path stays "/" deliberately: crow mode never mints this cookie (login is
					// off), and the crow proxy rewrites "path=/" to its own prefix on the way
					// out — prefixing here too would emit path=/proxy/perch-hub/proxy/perch-hub/.
					"Set-Cookie": `pi-hub=${encodeURIComponent(signCookie())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
				});
				res.end();
			});
			return;
		}

		if (!isAuthed(req)) {
			if (pathname.startsWith("/api/")) return json(res, 401, { error: "unauthorized" });
			res.writeHead(302, { Location: `${BASE_PATH}/login` });
			return res.end();
		}

		// /s/<pid>/... → session proxy
		const proxyMatch = /^\/s\/(\d+)(\/.*)?$/.exec(pathname);
		if (proxyMatch) {
			sweep();
			const entry = live.get(Number(proxyMatch[1]));
			if (!entry) return json(res, 404, { error: "no such live session (it may have exited)" });
			const sub = proxyMatch[2] ?? "/";
			// The session server's own root is its internal mounts dashboard — a
			// dead end behind the proxy. Land on the chat instead.
			if (sub === "/" || sub === "") {
				res.writeHead(302, { Location: `${BASE_PATH}/s/${proxyMatch[1]}/mobile` });
				return res.end();
			}
			return proxy(req, res, entry, sub + (url.search ?? ""));
		}

		// The bots lens exists only inside Crow — its whole content comes from the
		// gateway's /dashboard/perch-api routes, which do not exist beside a
		// standalone hub. Off crow mode this falls through to the 404 below.
		if (CROW_MODE && pathname === "/bots" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			return res.end(renderBotsPage({ host: os.hostname(), basePath: BASE_PATH, css: PERCH_CSS, birdSvg: BIRD_SVG, esc }));
		}

		if (pathname === "/" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			return res.end(await homePage(os.hostname(), { showArchived: url.searchParams.get("archived") === "1" }));
		}

		if (pathname === "/api/hub/sessions" && req.method === "GET") {
			const includeArchived = url.searchParams.get("archived") === "1";
			const sessions = listSessions({ excludeCwdPatterns: excludePatterns(), includeArchived }).map((s) => ({
				...s,
				teleport: teleportCommand(s),
			}));
			return json(res, 200, { sessions });
		}
		if (pathname === "/api/hub/archive" && req.method === "POST") {
			const body = await readBody(req);
			if (!body.id) return json(res, 400, { error: "id required" });
			setSessionArchived(String(body.id), body.archived !== false);
			return json(res, 200, { ok: true, archived: body.archived !== false });
		}
		if (pathname === "/api/hub/live" && req.method === "GET") {
			sweep();
			return json(res, 200, { live: [...live.values()], tmux: await listTmuxPiSessions() });
		}
		if (pathname === "/api/hub/spawn" && req.method === "POST") {
			const body = await readBody(req);
			if (!body.cwd) return json(res, 400, { error: "cwd required" });
			return json(res, 200, await spawnSession({ cwd: body.cwd, prompt: body.prompt, model: body.model }));
		}
		if (pathname === "/api/hub/resume" && req.method === "POST") {
			const body = await readBody(req);
			sweep();
			for (const entry of live.values()) {
				if (entry.sessionFile === body.file) {
					return json(res, 409, { error: `session already live (pid ${entry.pid}) — open its chat instead` });
				}
			}
			const target = listSessions({ limit: 500, excludeCwdPatterns: excludePatterns(), includeArchived: true }).find((s) => s.file === body.file);
			if (!target) return json(res, 404, { error: "unknown session file" });
			return json(res, 200, await spawnSession({ cwd: target.cwd, resumeFile: target.file }));
		}

		return json(res, 404, { error: "not found" });
	} catch (err) {
		if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
	}
});

// ── Registry listener (loopback pi processes only) ────────────

const registryServer = http.createServer(async (req, res) => {
	try {
		if (req.method !== "POST") return json(res, 405, { error: "POST only" });
		const body = await readBody(req);

		if (req.url === "/register") {
			const pid = Number(body.pid);
			if (!pid || !pidAlive(pid)) return json(res, 400, { error: "valid pid required" });
			const port = assignPort(pid);
			if (port === null) return json(res, 503, { error: "port pool exhausted" });
			live.set(pid, {
				pid,
				port,
				sessionId: String(body.sessionId ?? ""),
				sessionFile: String(body.sessionFile ?? ""),
				cwd: String(body.cwd ?? ""),
				name: String(body.name ?? ""),
				lastSeen: Date.now(),
			});
			return json(res, 200, { port });
		}
		if (req.url === "/unregister") {
			live.delete(Number(body.pid));
			return json(res, 200, { ok: true });
		}
		return json(res, 404, { error: "not found" });
	} catch (err) {
		if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
	}
});

publicServer.listen(PUBLIC_PORT, "127.0.0.1", () => {
	console.log(`pi-hub public on http://127.0.0.1:${PUBLIC_PORT}`);
});
registryServer.listen(REGISTRY_PORT, "127.0.0.1", () => {
	console.log(`pi-hub registry on http://127.0.0.1:${REGISTRY_PORT}`);
});
for (const srv of [publicServer, registryServer]) {
	srv.on("error", (err) => {
		console.error(`pi-hub listen error: ${err.message}`);
		process.exit(1);
	});
}
