/**
 * Perch — the bots lens (crow mode only).
 *
 * Perch's second lens: every Crow bot on the instance, its real sessions across
 * every channel, their transcripts, per-session tool narrowing, and a chat card
 * for the bots that have the `perch` gateway attached.
 *
 * WHERE THIS RUNS. The page is served by the hub but reached only through the
 * Crow gateway's session-gated proxy, at
 *
 *     <gateway>/proxy/perch-hub/bots        (hub route: /bots — the proxy strips the prefix)
 *
 * The data it needs, though, lives on the GATEWAY, not on the hub: bots, their
 * sessions, envelopes and turns are Crow's, and the hub knows nothing about
 * them. So every call the client makes is a ROOT-ABSOLUTE `/dashboard/perch-api/…`
 * URL — one level ABOVE the proxy prefix. A relative `fetch("dashboard/…")`
 * would resolve under `/proxy/perch-hub/` and be proxied straight back into this
 * hub, which has no such route. That pin is the single most important detail on
 * this page; it is restated at the constants themselves.
 *
 * The gateway's dashboard session is the auth (the proxy injects the hub bearer
 * for us and forwards the browser's cookies), so there is no token plumbing
 * here. Mutating calls echo the `crow_csrf` cookie in the `X-Crow-Csrf` header —
 * Crow's double-submit rail.
 *
 * STYLE. Perch keeps its own look inside Crow (an explicit design decision): the
 * page reuses the hub's PERCH_CSS, its bird-on-a-wire perches and mono databars,
 * and adds only bots-lens-specific rules written in the same vocabulary. Nothing
 * is imported or imitated from Crow's dashboard.
 *
 * The client is written as a real function (`botsClient`) and serialized into
 * the page with `Function.prototype.toString()`. That keeps it readable,
 * template-literal-friendly source instead of one long escaped string — and it
 * lets the page hand the client the hub's OWN `esc` helper as an argument, so
 * server-rendered and client-rendered text go through exactly the same escaping.
 */

/**
 * Render the bots lens.
 *
 * @param {object} opts
 * @param {string} opts.host      machine name for the header
 * @param {string} opts.basePath  PERCH_BASE_PATH — prefix for URLs served BY THE HUB
 * @param {string} opts.css       the hub's PERCH_CSS
 * @param {string} opts.birdSvg   the hub's BIRD_SVG
 * @param {(s:unknown)=>string} opts.esc  the hub's escaping helper (also shipped to the client)
 */
export function renderBotsPage({ host, basePath = "", css = "", birdSvg = "", esc = (s) => String(s ?? "") }) {
	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perch · bots · ${esc(host)}</title><style>${css}${BOTS_CSS}</style></head><body>
<header><div class="brand">Perch<small>bots · ${esc(host)}</small></div>
<nav class="machines"><a href="${esc(basePath)}/">Sessions</a><a class="here" href="${esc(basePath)}/bots">Bots</a></nav></header>
<div id="perch-bots-root"><div class="empty">Loading bots…</div></div>
<template id="perch-bird">${birdSvg}</template>
<script>(${botsClient.toString()})(${esc.toString()});</script>
</body></html>`;
}

/** Bots-lens additions to PERCH_CSS — same variables, same shapes, no crow styling. */
const BOTS_CSS = `
.perch.bot{padding-bottom:0}
.badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{font:11px/1 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;
padding:5px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.badge.chan{background:var(--teal-soft);border-color:transparent;color:var(--teal)}
a.badge.board{text-decoration:none;color:var(--attn);border-color:var(--attn)}
.badge.live{color:var(--alive);border-color:var(--alive)}
.sessions{margin:0 -16px;border-top:1px solid var(--line)}
.srow{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.srow .roost-main{min-width:150px}
.srow button{padding:7px 11px;font-size:13px}
.pane{border-bottom:1px solid var(--line);background:var(--sky);padding:12px 16px}
.pane:empty{display:none}
.transcript{max-height:340px;overflow:auto;display:grid;gap:9px}
.entry{display:grid;grid-template-columns:64px 1fr;gap:10px;font-size:14px}
.entry .who{font:11px/1.6 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;color:var(--dim)}
.entry.user .who{color:var(--teal)}
.entry .what{white-space:pre-wrap;word-break:break-word}
.tools{display:grid;gap:7px;margin:10px 0}
.tool{display:flex;align-items:center;gap:9px;font-size:14px}
.tool input{width:auto;padding:0}
.tool.locked{color:var(--dim);text-decoration:none}
.tool.locked .lock{color:var(--attn)}
.note{color:var(--dim);font-size:12.5px;margin-top:8px}
.chat{margin:0 -16px;border-top:1px solid var(--line);padding:13px 16px;display:grid;gap:9px}
.chat-log{display:grid;gap:9px}
.chat-log:empty{display:none}
.chat-send{display:flex;gap:8px;align-items:flex-start}
.chat-send textarea{flex:1}
.err{color:var(--attn);font-size:13.5px}
.pending{color:var(--dim)}
`;

/**
 * The bots-lens client. Serialized into the page — must stay SELF-CONTAINED
 * (no references to module scope; everything it needs arrives as an argument or
 * comes out of the DOM).
 *
 * Exported only so the tests can drive it against a stub DOM; the page ships it
 * as source, not as an import.
 *
 * @param {(s:unknown)=>string} esc the hub's escaping helper, shipped verbatim
 */
export function botsClient(esc) {
	// ── endpoints ────────────────────────────────────────────────
	// ROOT-ABSOLUTE, deliberately, all three. This page is served THROUGH the
	// gateway proxy at <gateway>/proxy/perch-hub/bots, but these routes belong to
	// the GATEWAY. A relative path would resolve under the proxy prefix instead —
	// <gateway>/proxy/perch-hub/dashboard/perch-api/bots — and be proxied into the
	// hub, which has no such route, so every call would 404. Keep the leading slash.
	const API = "/dashboard/perch-api";
	const BOARD = "/dashboard/bot-board"; // deep link: the dispatching board card
	const BUILDER = "/dashboard/bot-builder"; // deep link: the single writer of the envelope

	const root = document.getElementById("perch-bots-root");
	const BIRD = document.getElementById("perch-bird").innerHTML;

	const bots = new Map(); // botId → bot record
	const sessions = new Map(); // botId → session rows
	const chatThread = new Map(); // botId → perch sessionId the chat card is continuing

	// ── plumbing ─────────────────────────────────────────────────

	function csrfToken() {
		// Crow's double-submit rail: cookie crow_csrf, echoed in X-Crow-Csrf.
		const m = /(?:^|;\s*)crow_csrf=([^;]*)/.exec(document.cookie || "");
		return m ? decodeURIComponent(m[1]) : "";
	}

	async function settle(res) {
		let data = null;
		try {
			data = await res.json();
		} catch (_) {
			/* a non-JSON body is itself the diagnosis; status carries it */
		}
		if (!res.ok) {
			// The server's own words plus the status — both are diagnosis.
			const err = new Error(data && data.error ? data.error + " (HTTP " + res.status + ")" : "HTTP " + res.status);
			err.status = res.status;
			err.payload = data;
			throw err;
		}
		return data || {};
	}

	function getJson(url) {
		// Every request is time-bounded: an unreachable gateway must produce an
		// honest error state, never a spinner that never resolves.
		return fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }).then(settle);
	}

	function postJson(url, body) {
		return fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", "X-Crow-Csrf": csrfToken() },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20000),
		}).then(settle);
	}

	const reason = (err) => (err && err.name === "TimeoutError" ? "timed out" : String((err && err.message) || err));
	const bird = (cls) => '<span class="bird ' + cls + '">' + BIRD + "</span>";
	const q = (s) => encodeURIComponent(String(s));

	// ── shell states ─────────────────────────────────────────────

	function gatewayDownHtml(err) {
		// The APIs arrive with the crow gateway; outside it (or with the gateway
		// down) the lens says so plainly and offers a retry.
		return (
			'<div class="perch">' +
			bird("attn") +
			'<div class="perch-head"><div><div class="title">Cannot reach the Crow gateway</div>' +
			'<div class="meta">GET ' +
			esc(API + "/bots") +
			" — " +
			esc(reason(err)) +
			"</div></div>" +
			'<div class="state attn">offline</div></div>' +
			'<div class="row-actions"><button data-act="retry">Try again</button></div>' +
			'<div class="databar"><span>the bots lens reads its data from Crow, not from Perch</span>' +
			'<span class="mono-dim">perch-api</span></div></div>'
		);
	}

	function noBotsHtml() {
		return (
			'<div class="perch">' +
			bird("idle") +
			'<div class="perch-head"><div><div class="title">No bots yet</div>' +
			'<div class="meta">Bot Builder creates them; Perch watches them.</div></div>' +
			'<div class="state idle">empty</div></div>' +
			'<div class="row-actions"><a class="btn" href="' +
			BUILDER +
			'">Open Bot Builder</a></div>' +
			'<div class="databar"><span>observation is free for every bot</span>' +
			'<span class="mono-dim">0 bots</span></div></div>'
		);
	}

	// ── bot cards ────────────────────────────────────────────────

	function botCardHtml(bot) {
		const id = String(bot.id);
		const engine = (bot.engine && bot.engine.state) || "unknown";
		const ready = engine === "ready";
		const attached = !!bot.perch_attached;
		const cls = !ready ? "attn" : attached ? "" : "idle";
		const state = attached ? "attached" : "observing";
		const meta = "engine " + engine + " · runtime " + (bot.runtime_on ? "on" : "off");
		return (
			'<div class="perch bot" data-bot="' +
			esc(id) +
			'">' +
			bird(cls) +
			'<div class="perch-head"><div><div class="title">' +
			esc(bot.name || "bot " + id) +
			'</div><div class="meta">' +
			esc(meta) +
			"</div></div>" +
			'<div class="state ' +
			(attached ? "" : "idle") +
			'">' +
			esc(state) +
			"</div></div>" +
			'<div class="sessions" data-sessions="' +
			esc(id) +
			'"><div class="empty">Loading sessions…</div></div>' +
			(attached ? chatHtml(bot) : "") +
			'<div class="databar"><span>' +
			(attached ? "message this bot below" : "observing — attach the perch gateway in Bot Builder to talk") +
			'</span><span class="mono-dim" data-count="' +
			esc(id) +
			'">bot ' +
			esc(id) +
			"</span></div></div>"
		);
	}

	function chatHtml(bot) {
		return (
			'<form class="chat" data-act="send" data-bot="' +
			esc(String(bot.id)) +
			'"><div class="chat-log"></div>' +
			'<div class="chat-send"><textarea rows="2" name="message" placeholder="Message ' +
			esc(bot.name || "this bot") +
			'"></textarea>' +
			'<button class="primary">Send</button></div></form>'
		);
	}

	function sessionRowsHtml(botId, rows) {
		if (!rows.length) return '<div class="empty">No sessions yet — this bot has never been messaged on any channel.</div>';
		return rows
			.map(function (s) {
				const thread = s.gateway_thread_id == null ? "" : String(s.gateway_thread_id);
				const badges = [];
				// Channel badge keys off gateway_type — `kind` is only reliable for perch rows.
				badges.push('<span class="badge chan">' + esc(s.gateway_type || "unknown") + "</span>");
				if (s.card_id != null) {
					badges.push('<a class="badge board" href="' + BOARD + "?card=" + q(s.card_id) + '">card ' + esc(s.card_id) + "</a>");
				}
				if (s.live) badges.push('<span class="badge live">live</span>');
				const when = [s.status || "", s.updated_at || "", thread ? thread.slice(0, 24) : "no thread id"].filter(Boolean).join(" · ");
				const paneKey = esc(botId) + "-" + esc(String(s.id));
				const acts = thread
					? '<button class="quiet" data-act="transcript" data-bot="' +
						esc(botId) +
						'" data-thread="' +
						esc(thread) +
						'" data-pane="t-' +
						paneKey +
						'">Transcript</button>' +
						'<button class="quiet" data-act="controls" data-bot="' +
						esc(botId) +
						'" data-thread="' +
						esc(thread) +
						'" data-pane="c-' +
						paneKey +
						'">Controls</button>'
					: '<span class="badge">no thread id</span>';
				return (
					'<div class="srow"><span class="roost-dot"></span>' +
					'<div class="roost-main"><div class="roost-cwd">' +
					esc(s.plan_path || s.kind || "session " + s.id) +
					'</div><div class="roost-when">' +
					esc(when) +
					"</div></div>" +
					'<div class="badges">' +
					badges.join("") +
					"</div>" +
					acts +
					"</div>" +
					'<div class="pane" id="t-' +
					paneKey +
					'"></div><div class="pane" id="c-' +
					paneKey +
					'"></div>'
				);
			})
			.join("");
	}

	// ── transcript pane ──────────────────────────────────────────

	function messageText(message) {
		const content = message && message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map(function (block) {
					if (!block) return "";
					if (typeof block.text === "string") return block.text;
					return block.type ? "[" + block.type + "]" : "";
				})
				.filter(Boolean)
				.join("\n");
		}
		if (typeof (message && message.text) === "string") return message.text;
		return "";
	}

	function transcriptHtml(payload) {
		// Forward-compatible on purpose: pi session files are a type-discriminated
		// union (session / model_change / thinking_level_change / message / …).
		// Render `message`, ignore everything else rather than guessing.
		const entries = (payload.events || []).filter(function (e) {
			return e && e.type === "message";
		});
		if (!entries.length) return '<div class="empty">Nothing rendered yet — this session has no messages on disk.</div>';
		const head = payload.truncated ? '<div class="note">Showing the latest turns · ' + esc(payload.omitted || 0) + " earlier entries omitted.</div>" : "";
		return (
			head +
			'<div class="transcript">' +
			entries
				.map(function (e) {
					const message = e.message || {};
					const role = String(message.role || "?");
					return (
						'<div class="entry ' +
						(role === "user" ? "user" : "bot") +
						'"><div class="who">' +
						esc(role) +
						'</div><div class="what">' +
						esc(messageText(message)) +
						"</div></div>"
					);
				})
				.join("") +
			"</div>"
		);
	}

	// ── controls (envelope) pane ─────────────────────────────────

	function controlsHtml(botId, threadId, envelope, saved) {
		const allowed = envelope.tools || [];
		const denied = envelope.denied || [];
		const disabled = saved instanceof Set ? saved : new Set();
		const rows = allowed.map(function (t) {
			return (
				'<label class="tool"><input type="checkbox" data-act="narrow" data-bot="' +
				esc(botId) +
				'" data-thread="' +
				esc(threadId) +
				'" data-tool="' +
				esc(t.id) +
				'"' +
				(disabled.has(String(t.id)) ? "" : " checked") +
				"> " +
				esc(t.label || t.id) +
				"</label>"
			);
		});
		const locked = denied.map(function (t) {
			// Denied by the def: Perch never widens — it deep-links to the writer.
			return (
				'<a class="tool locked" href="' +
				BUILDER +
				"?bot=" +
				q(botId) +
				'"><span class="lock">&#128274;</span> ' +
				esc(t.label || t.id) +
				" — locked in Bot Builder</a>"
			);
		});
		const head =
			'<div class="meta">model ' +
			esc(envelope.model || "unset") +
			((envelope.skills || []).length ? " · skills " + esc((envelope.skills || []).join(", ")) : "") +
			"</div>";
		const note = saved
			? '<div class="note">Unchecking narrows this session only, from the next turn on.</div>'
			: '<div class="note">Unchecking narrows this session only, from the next turn on. This Crow build does not report the saved narrowing, so the boxes start from the bot\'s full envelope.</div>';
		return (
			head +
			'<div class="tools">' +
			(rows.join("") || '<div class="empty">This bot grants no tools.</div>') +
			locked.join("") +
			"</div>" +
			note +
			'<div class="narrow-msg"></div>'
		);
	}

	/** Saved narrowing, IF this Crow reports it on the session row (forward-compatible). */
	function savedNarrowing(row) {
		if (!row || row.narrowed_tools == null) return null;
		let list = row.narrowed_tools;
		if (typeof list === "string") {
			try {
				list = JSON.parse(list);
			} catch (_) {
				return null;
			}
		}
		return Array.isArray(list) ? new Set(list.map(String)) : null;
	}

	function sessionRow(botId, threadId) {
		return (sessions.get(String(botId)) || []).find(function (s) {
			return String(s.gateway_thread_id) === String(threadId);
		});
	}

	// ── loading ──────────────────────────────────────────────────

	async function loadSessions(botId) {
		const host = root.querySelector('[data-sessions="' + CSS.escape(botId) + '"]');
		if (!host) return;
		try {
			const data = await getJson(API + "/bots/" + q(botId) + "/sessions");
			const rows = data.sessions || [];
			sessions.set(String(botId), rows);
			host.innerHTML = sessionRowsHtml(botId, rows);
			const count = root.querySelector('[data-count="' + CSS.escape(botId) + '"]');
			if (count) count.textContent = rows.length + (rows.length === 1 ? " session" : " sessions");
		} catch (err) {
			host.innerHTML = '<div class="empty err">Sessions unavailable — ' + esc(reason(err)) + "</div>";
		}
	}

	async function load() {
		root.innerHTML = '<div class="empty pending">Loading bots…</div>';
		let data;
		try {
			data = await getJson(API + "/bots");
		} catch (err) {
			root.innerHTML = gatewayDownHtml(err);
			return;
		}
		bots.clear();
		for (const bot of data.bots || []) bots.set(String(bot.id), bot);
		if (!bots.size) {
			root.innerHTML = noBotsHtml();
			return;
		}
		root.innerHTML =
			'<h2>Bots — ' +
			bots.size +
			" on this instance</h2>" +
			[...bots.values()].map(botCardHtml).join("") +
			'<div class="row-actions"><button data-act="retry" class="quiet">Refresh</button></div>';
		await Promise.all([...bots.keys()].map(loadSessions));
	}

	// ── turns ────────────────────────────────────────────────────

	function logLine(cls, who, text) {
		return '<div class="entry ' + cls + '"><div class="who">' + esc(who) + '</div><div class="what">' + esc(text) + "</div></div>";
	}

	function streamTurn(turnId, log, pending) {
		// Terminal event is `reply` or `error`; `log` is progress noise.
		const es = new EventSource(API + "/turns/" + q(turnId) + "/events");
		let watchdog = 0;
		const finish = function (html) {
			clearTimeout(watchdog);
			pending.outerHTML = html;
			es.close();
		};
		// A turn may legitimately run for minutes (the bridge's own timeout is 600s),
		// so there is no short client cap — but a stream that dies silently must not
		// leave a card pending forever either. This matches the gateway's turn GC.
		watchdog = setTimeout(function () {
			finish(logLine("bot err", "error", "no reply after 15 minutes — reload to see whether the turn landed in the transcript"));
		}, 900000);
		es.addEventListener("reply", function (e) {
			let text = e.data;
			try {
				text = JSON.parse(e.data).text;
			} catch (_) {
				/* a plain-text payload is fine too */
			}
			finish(logLine("bot", "bot", text));
		});
		es.addEventListener("log", function (e) {
			pending.querySelector(".what").textContent = String(e.data || "").slice(0, 300);
		});
		es.addEventListener("error", function (e) {
			// EventSource fires "error" for BOTH a server-sent `event: error` (which
			// carries data) and a transport failure (which does not). Tell them apart.
			if (e && e.data) {
				let text = e.data;
				try {
					text = JSON.parse(e.data).text;
				} catch (_) {
					/* plain text */
				}
				finish(logLine("bot err", "error", text));
			} else if (es.readyState === EventSource.CLOSED) {
				finish(logLine("bot err", "error", "the reply stream closed before the bot answered"));
			}
		});
		log.appendChild(pending);
	}

	async function send(form) {
		const botId = form.dataset.bot;
		const box = form.querySelector("textarea");
		const message = String(box.value || "").trim();
		if (!message) return;
		const log = form.querySelector(".chat-log");
		log.insertAdjacentHTML("beforeend", logLine("user", "you", message));
		box.value = "";
		const pending = document.createElement("div");
		pending.className = "entry bot pending";
		pending.innerHTML = '<div class="who">bot</div><div class="what">…</div>';
		log.appendChild(pending);
		try {
			const body = { message: message };
			const thread = chatThread.get(String(botId));
			if (thread) body.sessionId = thread;
			const res = await postJson(API + "/bots/" + q(botId) + "/turn", body);
			if (res.sessionId) chatThread.set(String(botId), res.sessionId);
			streamTurn(res.turnId, log, pending);
		} catch (err) {
			// Honest failure, in the bot's own voice slot — never a silent drop.
			const detail =
				err.status === 403
					? "this bot has no perch gateway attached — attach it in Bot Builder"
					: err.status === 409 && err.payload && err.payload.error === "engine_required"
						? "the bot engine is not ready on this instance"
						: reason(err);
			pending.outerHTML = logLine("bot err", "error", detail);
		}
	}

	// ── panes + narrowing ────────────────────────────────────────

	async function togglePane(btn, fill) {
		const pane = document.getElementById(btn.dataset.pane);
		if (!pane) return;
		if (pane.innerHTML) {
			pane.innerHTML = "";
			return;
		}
		pane.innerHTML = '<div class="empty pending">Loading…</div>';
		try {
			pane.innerHTML = await fill();
		} catch (err) {
			pane.innerHTML = '<div class="empty err">' + esc(reason(err)) + "</div>";
		}
	}

	async function narrow(input) {
		const pane = input.closest(".pane");
		const msg = pane.querySelector(".narrow-msg");
		const boxes = [...pane.querySelectorAll('input[data-act="narrow"]')];
		const disabled = boxes.filter((b) => !b.checked).map((b) => b.dataset.tool);
		msg.className = "narrow-msg note";
		msg.textContent = "Saving…";
		try {
			await postJson(API + "/bots/" + q(input.dataset.bot) + "/sessions/" + q(input.dataset.thread) + "/narrow", { disabled_tools: disabled });
			msg.textContent = disabled.length ? "Narrowed to " + (boxes.length - disabled.length) + " of " + boxes.length + " tools." : "Full envelope restored.";
		} catch (err) {
			input.checked = !input.checked; // the server refused; the UI must not lie
			msg.className = "narrow-msg err";
			msg.textContent =
				err.payload && err.payload.error === "widening_rejected"
					? "Rejected: Perch can only narrow (" + String((err.payload.offending || []).join(", ")) + ")"
					: "Not saved — " + reason(err);
		}
	}

	// ── wiring ───────────────────────────────────────────────────

	root.addEventListener("click", function (event) {
		const el = event.target.closest("[data-act]");
		if (!el || el.tagName === "FORM") return;
		const act = el.dataset.act;
		if (act === "retry") {
			event.preventDefault();
			load();
		} else if (act === "transcript") {
			event.preventDefault();
			togglePane(el, async function () {
				return transcriptHtml(await getJson(API + "/bots/" + q(el.dataset.bot) + "/sessions/" + q(el.dataset.thread) + "/transcript"));
			});
		} else if (act === "controls") {
			event.preventDefault();
			togglePane(el, async function () {
				const envelope = await getJson(API + "/bots/" + q(el.dataset.bot) + "/envelope");
				return controlsHtml(el.dataset.bot, el.dataset.thread, envelope, savedNarrowing(sessionRow(el.dataset.bot, el.dataset.thread)));
			});
		}
	});

	root.addEventListener("change", function (event) {
		const el = event.target;
		if (el && el.dataset && el.dataset.act === "narrow") narrow(el);
	});

	root.addEventListener("submit", function (event) {
		const form = event.target.closest('form[data-act="send"]');
		if (!form) return;
		event.preventDefault();
		send(form);
	});

	load();
}
