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
.badge.state-awake{color:var(--alive);border-color:var(--alive)}
.badge.state-waking{color:var(--teal);border-color:var(--teal)}
.badge.state-hibernating{color:var(--dim)}
.badge.state-stopped{color:var(--dim)}
.badge.state-error{color:var(--attn);border-color:var(--attn)}
.interactive{margin:0 -16px;border-top:1px solid var(--line);padding:13px 16px;display:grid;gap:10px}
.interactive:empty{display:none}
.i-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.i-actions{display:flex;gap:8px}
.i-transcript{max-height:340px;overflow:auto;display:grid;gap:9px}
.i-ask{display:grid;gap:8px}
.i-ask:empty{display:none}
.i-send{display:flex;gap:8px;align-items:flex-start}
.i-send textarea{flex:1}
.ask-card{border:1px solid var(--line);border-radius:10px;padding:11px 12px;display:grid;gap:8px;background:var(--sky)}
.ask-card .title{font-weight:600}
.ask-card .ask-message{white-space:pre-wrap}
.ask-opts{display:flex;flex-wrap:wrap;gap:6px}
.answered{color:var(--dim);font-size:13px}
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
	const interactive = new Map(); // sessionId → { botId, state, turnInFlight, pendingUi } for the interactive card
	const mountedSid = new Map(); // botId → the sid whose interactive card currently owns the container (fix round 2)

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
		// "Spawn as bot" needs BOTH flags the chat card implicitly relies on: a
		// perch gateway attached (or there is nothing to spawn against) and the
		// engine actually armed (or spawn would just 409 engine_required).
		const canSpawn = attached && ready;
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
			(canSpawn
				? '<div class="row-actions"><button class="quiet" data-act="spawn" data-bot="' + esc(id) + '">Spawn as bot</button></div>'
				: "") +
			// Container for the interactive session card. Empty (and so hidden by
			// `.interactive:empty`) until spawnInteractive()/resumeInteractive() fill
			// it — present whenever the bot is attached, so a resumed perch-live
			// session has somewhere to land even on a load where the engine happens
			// to be reported not-ready.
			(attached ? '<div class="interactive" id="interactive-' + esc(id) + '"></div>' : "") +
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
		const id = String(bot.id);
		return (
			'<form class="chat" data-act="send" data-bot="' +
			esc(id) +
			'"><div class="chat-log" data-chatlog="' +
			esc(id) +
			'"></div>' +
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
				const isPerchLive = s.kind === "perch-live";
				const badges = [];
				// Channel badge keys off gateway_type — `kind` is only reliable for perch rows.
				badges.push('<span class="badge chan">' + esc(s.gateway_type || "unknown") + "</span>");
				if (s.card_id != null) {
					badges.push('<a class="badge board" href="' + BOARD + "?card=" + q(s.card_id) + '">card ' + esc(s.card_id) + "</a>");
				}
				// BADGE CONTRACT (P2 C-15): a kind='perch-live' row carries `state`
				// (awake|hibernating|stopped) — badge from THAT, and ignore `live`
				// entirely for these rows (the flag reads false for an awake-idle
				// interactive session, which would otherwise mislabel it as dead).
				// Every other kind keeps the P1 `live` badge unchanged.
				if (isPerchLive) {
					const liveState = s.state || "hibernating";
					badges.push('<span class="badge state-' + esc(liveState) + '">' + esc(liveState) + "</span>");
				} else if (s.live) {
					badges.push('<span class="badge live">live</span>');
				}
				const when = [s.status || "", s.updated_at || "", thread ? thread.slice(0, 24) : "no thread id"].filter(Boolean).join(" · ");
				const paneKey = esc(botId) + "-" + esc(String(s.id));
				// Transcript is a READ — observation is free on every channel.
				// Controls WRITE the session's tool envelope, and narrowing is a
				// perch-session concept in P1: the gateway refuses a narrow on a
				// non-perch row (400 not_a_perch_session), and offering the
				// affordance anyway would invite an operator to strip a tool from
				// a production gmail thread from a surface Bot Builder — the
				// single writer of the envelope — cannot see. A kind='perch-live'
				// row is ALSO gateway_type='perch' but is the interactive engine's,
				// not a per-turn session's, and the gateway refuses to narrow it
				// too (400 not_a_perch_session) — so it is excluded here as well.
				const canNarrow = String(s.gateway_type || "") === "perch" && !isPerchLive;
				const acts = thread
					? '<button class="quiet" data-act="transcript" data-bot="' +
						esc(botId) +
						'" data-thread="' +
						esc(thread) +
						'" data-pane="t-' +
						paneKey +
						'">Transcript</button>' +
						(canNarrow
							? '<button class="quiet" data-act="controls" data-bot="' +
								esc(botId) +
								'" data-thread="' +
								esc(thread) +
								'" data-pane="c-' +
								paneKey +
								'">Controls</button>'
							: "")
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
		// `omitted` is a number only when Crow read the whole file. Once the byte
		// cap bites, the head is never read and the count is genuinely unknown —
		// so the notice drops the number rather than inventing "0 omitted".
		const head = payload.truncated
			? '<div class="note">Showing the latest turns · ' +
				(typeof payload.omitted === "number" && payload.omitted > 0
					? esc(payload.omitted) + " earlier entries omitted."
					: "earlier entries omitted.") +
				"</div>"
			: "";
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
		// Three states, not two. "No narrowing saved yet" is the ORDINARY case
		// for a fresh session and must not be reported as a missing feature —
		// telling an operator their Crow cannot report something it reported
		// correctly (as null) sends them hunting for a bug that isn't there.
		// savedNarrowing() distinguishes them: a Set is a real narrowing, null
		// is "reported, nothing narrowed", undefined is "not reported at all".
		const note =
			saved instanceof Set
				? '<div class="note">Unchecking narrows this session only, from the next turn on.</div>'
				: saved === null
					? '<div class="note">Unchecking narrows this session only, from the next turn on. Nothing is narrowed in this session yet, so the boxes start from the bot\'s full envelope.</div>'
					: '<div class="note">Unchecking narrows this session only, from the next turn on. This Crow build did not report a saved narrowing for this session, so the boxes start from the bot\'s full envelope.</div>';
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

	/**
	 * Saved narrowing for a session row, as a TRI-state (forward-compatible):
	 *
	 *   Set       — this Crow reported a narrowing and it parsed
	 *   null      — reported, but nothing is narrowed in this session yet
	 *               (a fresh session: the field is present and SQL NULL)
	 *   undefined — not reported at all: the row is unknown here, or the
	 *               build predates the field, or what it sent was unusable
	 *
	 * Collapsing the middle case into "not reported" is what made the pane
	 * blame the Crow build for an empty session (acceptance finding D4).
	 */
	function savedNarrowing(row) {
		if (!row || !Object.prototype.hasOwnProperty.call(row, "narrowed_tools")) return undefined;
		let list = row.narrowed_tools;
		if (list == null) return null;
		if (typeof list === "string") {
			try {
				list = JSON.parse(list);
			} catch (_) {
				return undefined;
			}
		}
		return Array.isArray(list) ? new Set(list.map(String)) : undefined;
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
			// Crow caps this list (bot_sessions only grows — one row per thread,
			// duplicates tolerated by design). Presenting a capped page as the
			// complete history would quietly hide older threads.
			if (count) {
				count.textContent = data.truncated
					? "showing the " + rows.length + " most recent sessions"
					: rows.length + (rows.length === 1 ? " session" : " sessions");
			}
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
		await Promise.all([...bots.keys()].map(resumeThreads));
	}

	// ── thread resume ────────────────────────────────────────────
	// Kills the old "chatThread starts blank, gets filled on first send" idiom:
	// on every load, each attached bot's chat card resumes the newest per-turn
	// (kind='perch') thread instead of starting empty, and its newest
	// kind='perch-live' session (if any) reopens its own card with a live SSE
	// connection — the counterpart to the per-turn resume, one interactive
	// session at a time per bot (mirroring "newest thread", not "every thread
	// this bot ever spawned").

	/** Fill an empty log — but NEVER clobber one that already has content (fix
	 * I-1). The chat form is live before the resume's transcript fetch resolves,
	 * so a message sent in that window already put its optimistic entry and its
	 * pending "…" node in the log — and streamTurn's finish() writes to that
	 * node BY REFERENCE. Replacing innerHTML would detach it, and the reply
	 * would vanish silently even though the turn completed server-side. Resumed
	 * history slots in ABOVE whatever the operator already produced instead. */
	function prependOrFill(log, html) {
		if (log.innerHTML) log.insertAdjacentHTML("afterbegin", html);
		else log.innerHTML = html;
	}

	/** Prefill the chat card's log from the newest perch-turn thread's transcript. */
	async function resumeChat(botId, row) {
		const thread = String(row.gateway_thread_id);
		chatThread.set(String(botId), thread);
		const log = root.querySelector('[data-chatlog="' + CSS.escape(botId) + '"]');
		if (!log) return;
		try {
			const payload = await getJson(API + "/bots/" + q(botId) + "/sessions/" + q(thread) + "/transcript");
			const entries = (payload.events || []).filter(function (e) {
				return e && e.type === "message";
			});
			prependOrFill(
				log,
				entries
					.map(function (e) {
						const message = e.message || {};
						const role = String(message.role || "?");
						return logLine(role === "user" ? "user" : "bot", role, messageText(message));
					})
					.join("")
			);
		} catch (err) {
			prependOrFill(log, logLine("bot err", "error", "could not resume the last conversation — " + reason(err)));
		}
	}

	/** For one bot: resume its newest perch-turn thread and its newest interactive session, if either exists. */
	async function resumeThreads(botId) {
		const bot = bots.get(String(botId));
		if (!bot || !bot.perch_attached) return;
		const rows = sessions.get(String(botId)) || [];
		const chatRow = rows.find(function (s) {
			return s.kind === "perch" && s.gateway_thread_id != null;
		});
		if (chatRow) await resumeChat(botId, chatRow);
		const liveRow = rows.find(function (s) {
			return s.kind === "perch-live" && s.gateway_thread_id != null;
		});
		// Other half of the double-mount guard (fix I-2): if the operator spawned
		// an interactive session for this bot while this resume was in flight,
		// that card and its live EventSource are the newest action — auto-reopening
		// the older row would stomp them (mountInteractive would close the fresh
		// stream and display a session the operator did not ask for).
		const alreadyMounted = [...interactive.values()].some(function (s) {
			return String(s.botId) === String(botId) && s.es;
		});
		if (liveRow && !alreadyMounted) await resumeInteractive(botId, liveRow);
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

	// ── interactive sessions (spawn-as-bot) ─────────────────────
	//
	// Where the chat card is one `handleInbound()` per message, an interactive
	// session is a long-lived pi child the interactive engine owns end to end:
	// spawn once, then stream state/text/tool/log/ask_user/reply/error over one
	// persistent EventSource for as long as the card is open. `interactive` (see
	// top of file) is this card's client-side memory — sessionId is the same
	// string as gateway_thread_id (CARRIED HANDOFF: "one identity"), so every
	// lookup below is keyed on that one id.

	function stateBadgeHtml(sid, state) {
		return '<span class="badge state-' + esc(state) + '" data-role="i-state" data-sid="' + esc(sid) + '">' + esc(state) + "</span>";
	}

	/** The card's static shell: badge, abort/stop, transcript pane, ask-user pane, send form.
	 * Rendered ONCE per session (mountInteractive) — later updates touch pieces of
	 * it directly (setInteractiveState, appendInteractiveEntry, renderAskUser)
	 * rather than re-rendering the whole card, so an in-progress transcript is
	 * never wiped out from under the operator. */
	function interactiveShellHtml(botId, sid, state) {
		return (
			'<div class="i-head">' +
			stateBadgeHtml(sid, state) +
			'<div class="i-actions">' +
			'<button class="quiet" data-act="i-abort" data-sid="' +
			esc(sid) +
			'" hidden>Abort</button>' +
			'<button class="quiet" data-act="i-stop" data-sid="' +
			esc(sid) +
			'">Stop</button></div></div>' +
			'<div class="i-transcript" id="i-transcript-' +
			esc(sid) +
			'"></div>' +
			'<div class="i-ask" id="i-ask-' +
			esc(sid) +
			'"></div>' +
			'<form class="i-send" data-act="i-send" data-sid="' +
			esc(sid) +
			'" data-bot="' +
			esc(botId) +
			'"><textarea rows="2" name="message" placeholder="Message this interactive session"></textarea>' +
			'<button class="primary">Send</button></form>'
		);
	}

	/** Fill (or refill) the bot's `#interactive-<botId>` container with a fresh
	 * card shell for `sid`, and hide the now-redundant "Spawn as bot" button —
	 * one interactive session shown at a time per bot, matching the one-card
	 * container the page ships. */
	function mountInteractive(botId, sid, state) {
		const host = document.getElementById("interactive-" + botId);
		if (!host) return null;
		// One card, one connection (fix I-2): a re-mount (re-spawn, or a spawn
		// and a resume racing) replaces the card's DOM wholesale, so any
		// EventSource a previous mount opened would keep streaming into detached
		// nodes forever. Close it BEFORE the container is overwritten, and drop
		// superseded sessions from the client-side map so it cannot accumulate.
		for (const [oldSid, sess] of interactive) {
			if (String(sess.botId) !== String(botId)) continue;
			if (sess.es) {
				sess.es.close();
				sess.es = null;
			}
			if (oldSid !== sid) interactive.delete(oldSid);
		}
		mountedSid.set(String(botId), String(sid));
		host.innerHTML = interactiveShellHtml(botId, sid, state);
		const spawnBtn = root.querySelector('[data-act="spawn"][data-bot="' + CSS.escape(botId) + '"]');
		if (spawnBtn) spawnBtn.hidden = true;
		return host;
	}

	function setInteractiveState(sid, state) {
		const sess = interactive.get(sid);
		if (sess) sess.state = state;
		const badge = root.querySelector('[data-role="i-state"][data-sid="' + CSS.escape(sid) + '"]');
		if (badge) {
			badge.className = "badge state-" + state;
			badge.textContent = state;
		}
	}

	/** Toggle the abort affordance and disable the send box while a turn runs. */
	function setTurnInFlight(sid, flight) {
		const sess = interactive.get(sid);
		if (sess) sess.turnInFlight = flight;
		const abortBtn = root.querySelector('[data-act="i-abort"][data-sid="' + CSS.escape(sid) + '"]');
		if (abortBtn) abortBtn.hidden = !flight;
		const box = root.querySelector('form[data-act="i-send"][data-sid="' + CSS.escape(sid) + '"] textarea');
		if (box) box.disabled = flight;
	}

	function appendInteractiveEntry(sid, cls, who, text) {
		const pane = document.getElementById("i-transcript-" + sid);
		if (pane) pane.insertAdjacentHTML("beforeend", logLine(cls, who, text));
	}

	/** Pre-populate the transcript pane from the P1 transcript endpoint — works
	 * for a kind='perch-live' row exactly like a kind='perch' one (CARRIED
	 * HANDOFF: sessionId === gateway_thread_id, one identity). */
	async function loadInteractiveTranscript(botId, sid) {
		const pane = document.getElementById("i-transcript-" + sid);
		if (!pane) return;
		try {
			const payload = await getJson(API + "/bots/" + q(botId) + "/sessions/" + q(sid) + "/transcript");
			const entries = (payload.events || []).filter(function (e) {
				return e && e.type === "message";
			});
			// Same I-1 rule as the chat log: a message the operator sent while this
			// fetch was in flight is already appended here — history goes above it.
			prependOrFill(
				pane,
				entries
					.map(function (e) {
						const message = e.message || {};
						const role = String(message.role || "?");
						return logLine(role === "user" ? "user" : "bot", role, messageText(message));
					})
					.join("")
			);
		} catch (err) {
			prependOrFill(pane, logLine("bot err", "error", "transcript unavailable — " + reason(err)));
		}
	}

	/**
	 * Render (or replace) the pending ask_user card.
	 *
	 * CARRIED HANDOFF (binding): `select` options are PRE-RENDERED row strings
	 * ("[x] …" toggles, "Other…", "── done … ──") matched back by EXACT string —
	 * every option is rendered VERBATIM as a button and echoed untouched on
	 * click; never parsed or re-composed. Each pick in a multiSelect triggers a
	 * fresh ask_user event, so the card naturally re-renders per pick — this
	 * function needs no multiSelect-specific branch, only a fresh call per event.
	 * `requestId` is kept in `interactive.get(sid).pendingUi`, never round-tripped
	 * through a DOM attribute, so it is echoed back exactly as received.
	 */
	function renderAskUser(sid, card) {
		const sess = interactive.get(sid);
		if (sess) sess.pendingUi = card;
		const pane = document.getElementById("i-ask-" + sid);
		if (!pane) return;
		if (!card) {
			pane.innerHTML = "";
			return;
		}
		const title = '<div class="title">' + esc(card.title || "") + "</div>";
		let body = "";
		if (card.method === "select") {
			body =
				'<div class="ask-opts">' +
				(card.options || [])
					.map(function (opt, i) {
						return '<button class="quiet" data-act="i-opt" data-sid="' + esc(sid) + '" data-idx="' + i + '">' + esc(opt) + "</button>";
					})
					.join("") +
				"</div>";
		} else if (card.method === "input") {
			body =
				'<form class="i-answer" data-act="i-answer-input" data-sid="' +
				esc(sid) +
				'"><input type="text" name="value" placeholder="' +
				esc(card.placeholder || "") +
				'"><button class="primary">Send</button></form>';
		} else if (card.method === "confirm") {
			body =
				'<div class="ask-message">' +
				esc(card.message || "") +
				'</div><div class="ask-opts">' +
				'<button class="primary" data-act="i-confirm" data-sid="' +
				esc(sid) +
				'" data-value="1">Confirm</button>' +
				'<button class="quiet" data-act="i-confirm" data-sid="' +
				esc(sid) +
				'" data-value="0">Deny</button></div>';
		} else if (card.method === "editor") {
			body =
				'<form class="i-answer" data-act="i-answer-editor" data-sid="' +
				esc(sid) +
				'"><textarea name="value" rows="3">' +
				esc(card.prefill || "") +
				'</textarea><button class="primary">Send</button></form>';
		}
		const cancel = '<button class="quiet" data-act="i-cancel" data-sid="' + esc(sid) + '">Cancel</button>';
		pane.innerHTML = '<div class="ask-card">' + title + body + cancel + "</div>";
	}

	/** The answered card collapses to its chosen value rather than vanishing —
	 * an operator scrolling back should see what was answered, not a gap. */
	function collapseAskUser(sid, label) {
		const pane = document.getElementById("i-ask-" + sid);
		if (pane) pane.innerHTML = '<div class="answered">Answered: ' + esc(label) + "</div>";
		const sess = interactive.get(sid);
		if (sess) sess.pendingUi = null;
	}

	async function answerAskUser(sid, value, label) {
		const sess = interactive.get(sid);
		const card = sess && sess.pendingUi;
		if (!card) return;
		try {
			await postJson(API + "/interactive/" + q(sid) + "/answer", Object.assign({ requestId: card.requestId }, value));
			collapseAskUser(sid, label);
		} catch (err) {
			const pane = document.getElementById("i-ask-" + sid);
			if (pane) pane.insertAdjacentHTML("beforeend", '<div class="err">' + esc(reason(err)) + "</div>");
		}
	}

	/**
	 * Wire the persistent SSE connection for one session.
	 *
	 * P1 discriminator idiom, restated here for the long-lived stream: an
	 * `error` EVENT with `.data` is a server-sent `event: error` frame (a real
	 * diagnosis); transport death is signalled ONLY by `readyState === CLOSED`
	 * with no data. `new EventSource` itself is guarded — this function must
	 * survive an environment with no EventSource global without taking the rest
	 * of resumeThreads()/load() down with it.
	 */
	function openInteractiveEvents(botId, sid) {
		// Fix round 2 (residual I-2 leak): this can run long after its own mount
		// was superseded — resumeInteractive awaits the transcript between mount
		// and open, and a competing spawn's mount can land inside that window,
		// overwrite the container, and delete this sid from `interactive`. The
		// old `interactive.get(sid) || { botId }` fallback would then RESURRECT
		// the deleted entry with a live EventSource whose card DOM no longer
		// exists. Only the currently-mounted session for the bot may install
		// itself; a superseded caller gets nothing opened and nothing mapped.
		if (mountedSid.get(String(botId)) !== String(sid)) return null;
		let es;
		try {
			es = new EventSource(API + "/interactive/" + q(sid) + "/events");
		} catch (err) {
			appendInteractiveEntry(sid, "bot err", "error", "could not open the live connection — " + reason(err));
			setInteractiveState(sid, "error");
			return null;
		}
		const sess = interactive.get(sid) || { botId: botId };
		sess.es = es;
		interactive.set(sid, sess);

		function parsed(e) {
			try {
				return JSON.parse(e.data);
			} catch (_) {
				return {};
			}
		}
		es.addEventListener("state", function (e) {
			const d = parsed(e);
			setInteractiveState(sid, d.state || "hibernating");
			if (d.state === "stopped") setTurnInFlight(sid, false);
		});
		es.addEventListener("text", function (e) {
			appendInteractiveEntry(sid, "bot", "bot", parsed(e).text || "");
		});
		es.addEventListener("tool", function (e) {
			const d = parsed(e);
			appendInteractiveEntry(sid, "bot tool", "tool", (d.name || "tool") + " " + (d.phase || "") + (d.isError ? " (error)" : ""));
		});
		es.addEventListener("log", function (e) {
			appendInteractiveEntry(sid, "bot log", "log", parsed(e).text || "");
		});
		es.addEventListener("reply", function (e) {
			appendInteractiveEntry(sid, "bot", "bot", parsed(e).text || "");
			setTurnInFlight(sid, false);
		});
		es.addEventListener("ask_user", function (e) {
			renderAskUser(sid, parsed(e));
		});
		es.addEventListener("error", function (e) {
			if (e && e.data) {
				appendInteractiveEntry(sid, "bot err", "error", parsed(e).text || "error");
			} else if (es.readyState === EventSource.CLOSED) {
				appendInteractiveEntry(sid, "bot err", "error", "the live connection to this session closed");
				setInteractiveState(sid, "error");
			}
		});
		return es;
	}

	async function spawnInteractive(botId) {
		// Double-mount guard (fix I-2): the button is live from first paint —
		// including the whole resumeThreads() window — and each successful click
		// spawns a REAL engine session with only one card to show it. Disable on
		// the way in; the affordance comes back only if the spawn failed (a
		// successful mount hides the button anyway).
		const spawnBtn = root.querySelector('[data-act="spawn"][data-bot="' + CSS.escape(botId) + '"]');
		if (spawnBtn) {
			if (spawnBtn.disabled) return;
			spawnBtn.disabled = true;
		}
		try {
			const res = await postJson(API + "/bots/" + q(botId) + "/interactive", {});
			interactive.set(res.sessionId, { botId: botId, state: res.state || "awake", turnInFlight: false, pendingUi: null });
			mountInteractive(botId, res.sessionId, res.state || "awake");
			openInteractiveEvents(botId, res.sessionId);
		} catch (err) {
			if (spawnBtn) spawnBtn.disabled = false;
			const host = document.getElementById("interactive-" + botId);
			if (host) {
				host.innerHTML =
					'<div class="err">Could not spawn an interactive session — ' +
					esc(
						err.status === 403
							? "this bot has no perch gateway attached"
							: err.status === 409 && err.payload && err.payload.error === "engine_required"
								? "the bot engine is not ready on this instance"
								: reason(err)
					) +
					"</div>";
			}
		}
	}

	/** Reopen an EXISTING kind='perch-live' row's card — no spawn call, just
	 * transcript + a live SSE connection onto the session the engine already
	 * knows (or can adopt from its DB row). */
	async function resumeInteractive(botId, row) {
		const sid = String(row.gateway_thread_id);
		interactive.set(sid, { botId: botId, state: row.state || "hibernating", turnInFlight: false, pendingUi: null });
		mountInteractive(botId, sid, row.state || "hibernating");
		await loadInteractiveTranscript(botId, sid);
		openInteractiveEvents(botId, sid);
	}

	async function sendInteractive(form) {
		const sid = form.dataset.sid;
		const box = form.querySelector("textarea");
		const message = String(box.value || "").trim();
		if (!message) return;
		const sess = interactive.get(sid);
		const wasAwake = !!(sess && sess.state === "awake");
		appendInteractiveEntry(sid, "user", "you", message);
		box.value = "";
		// "waking" is client-local (CARRIED HANDOFF): the engine never broadcasts
		// its own internal `waking` reservation over SSE, so this optimistic badge
		// is the only signal an operator gets between "sent" and the real `state`
		// event a successful wake (or send-to-an-already-awake-session) emits.
		if (!wasAwake) setInteractiveState(sid, "waking");
		setTurnInFlight(sid, true);
		try {
			await postJson(API + "/interactive/" + q(sid) + "/message", { message: message });
		} catch (err) {
			setTurnInFlight(sid, false);
			setInteractiveState(sid, err.status === 410 ? "stopped" : wasAwake ? "awake" : "hibernating");
			appendInteractiveEntry(
				sid,
				"bot err",
				"error",
				err.status === 410 ? "this session is stopped — spawn a new one" : reason(err)
			);
		}
	}

	async function abortInteractive(sid) {
		try {
			await postJson(API + "/interactive/" + q(sid) + "/abort", {});
			setTurnInFlight(sid, false);
		} catch (err) {
			appendInteractiveEntry(sid, "bot err", "error", "abort failed — " + reason(err));
		}
	}

	async function stopInteractive(sid) {
		try {
			await postJson(API + "/interactive/" + q(sid) + "/stop", {});
			setInteractiveState(sid, "stopped");
			setTurnInFlight(sid, false);
			// The stream dies with the session (fix I-2): a stopped card must not
			// hold its SSE connection open — the browser would reconnect-loop
			// against a gone session, and the transport-error handler would then
			// relabel the deliberate stop as an error.
			const sess = interactive.get(sid);
			if (sess && sess.es) {
				sess.es.close();
				sess.es = null;
			}
		} catch (err) {
			appendInteractiveEntry(sid, "bot err", "error", "stop failed — " + reason(err));
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
		} else if (act === "spawn") {
			event.preventDefault();
			spawnInteractive(el.dataset.bot);
		} else if (act === "i-abort") {
			event.preventDefault();
			abortInteractive(el.dataset.sid);
		} else if (act === "i-stop") {
			event.preventDefault();
			stopInteractive(el.dataset.sid);
		} else if (act === "i-opt") {
			event.preventDefault();
			const sess = interactive.get(el.dataset.sid);
			const options = sess && sess.pendingUi && sess.pendingUi.options;
			const opt = options ? options[Number(el.dataset.idx)] : null;
			if (opt != null) answerAskUser(el.dataset.sid, { value: opt }, opt);
		} else if (act === "i-confirm") {
			event.preventDefault();
			const confirmed = el.dataset.value === "1";
			answerAskUser(el.dataset.sid, { confirmed: confirmed }, confirmed ? "Confirmed" : "Denied");
		} else if (act === "i-cancel") {
			event.preventDefault();
			answerAskUser(el.dataset.sid, { cancelled: true }, "Cancelled");
		}
	});

	root.addEventListener("change", function (event) {
		const el = event.target;
		if (el && el.dataset && el.dataset.act === "narrow") narrow(el);
	});

	root.addEventListener("submit", function (event) {
		const form = event.target.closest("form[data-act]");
		if (!form) return;
		const act = form.dataset.act;
		if (act === "send") {
			event.preventDefault();
			send(form);
		} else if (act === "i-send") {
			event.preventDefault();
			sendInteractive(form);
		} else if (act === "i-answer-input") {
			event.preventDefault();
			const input = form.querySelector('input[name="value"]');
			const value = String((input && input.value) || "");
			answerAskUser(form.dataset.sid, { value: value }, value);
			if (input) input.value = "";
		} else if (act === "i-answer-editor") {
			event.preventDefault();
			const ta = form.querySelector('textarea[name="value"]');
			const value = String((ta && ta.value) || "");
			answerAskUser(form.dataset.sid, { value: value }, value);
		}
	});

	load();
}
