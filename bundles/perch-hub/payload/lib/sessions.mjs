/**
 * sessions.mjs — shared pi session enumeration / spawn / teleport logic.
 *
 * Plain ESM with no pi imports so BOTH pi extensions (extensions/session-web)
 * and the standalone pi-hub daemon (hub/server.mjs) can use it.
 *
 * pi stores sessions at ~/.pi/agent/sessions/<cwd-encoded>--/<ts>_<uuid>.jsonl;
 * line 1 is {"type":"session","version":3,"id","timestamp","cwd"}.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
const META_PATH = path.join(os.homedir(), ".pi", "agent", "pi-lab-session-meta.json");

/** cwd substrings that mark bot/bundle workspaces — hidden from listings by default. */
export const DEFAULT_EXCLUDE_CWD_PATTERNS = ["/.crow-mpa/"];

// ── Session metadata sidecar (archive flags) ─────────────────
// pi has no archive concept, so we keep { "<sessionId>": { archived: true } }
// next to its settings. Names are NOT stored here — those live in the session
// file itself as pi-native session_info entries (pi.setSessionName).

/** @returns {Record<string, {archived?: boolean}>} */
export function readSessionMeta() {
	try {
		return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
	} catch {
		return {};
	}
}

export function setSessionArchived(sessionId, archived) {
	if (!sessionId) throw new Error("sessionId required");
	const meta = readSessionMeta();
	if (archived) {
		meta[sessionId] = { ...(meta[sessionId] ?? {}), archived: true };
	} else if (meta[sessionId]) {
		delete meta[sessionId].archived;
		if (Object.keys(meta[sessionId]).length === 0) delete meta[sessionId];
	}
	const tmp = `${META_PATH}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(meta, null, "\t"));
	fs.renameSync(tmp, META_PATH);
}

// ── Session names (pi-native session_info entries) ───────────

/** file → { mtimeMs, sizeBytes, name } — avoids rescanning unchanged files. */
const nameCache = new Map();

/**
 * Latest session_info name in a session file (undefined = never named or
 * explicitly cleared). Scans backwards from the end; results are cached by
 * (mtime, size) so steady-state listings only re-read files that changed.
 */
function sessionNameFromFile(file, mtimeMs, sizeBytes) {
	const hit = nameCache.get(file);
	if (hit && hit.mtimeMs === mtimeMs && hit.sizeBytes === sizeBytes) return hit.name;
	let name;
	try {
		const text = fs.readFileSync(file, "utf8");
		let at = text.length;
		let found = false;
		while (!found && (at = text.lastIndexOf('"type":"session_info"', at - 1)) > 0) {
			const start = text.lastIndexOf("\n", at) + 1;
			const end = text.indexOf("\n", at);
			try {
				const entry = JSON.parse(text.slice(start, end === -1 ? text.length : end));
				// The marker can also appear inside message text — only a real
				// session_info entry counts. The LATEST one wins even when it
				// clears the name, so stop at the first genuine hit.
				if (entry?.type === "session_info") {
					found = true;
					name = entry.name?.trim() || undefined;
				}
			} catch {
				// mid-line match inside a message body — keep walking back
			}
			at = start;
		}
	} catch {
		// unreadable — treat as unnamed
	}
	nameCache.set(file, { mtimeMs, sizeBytes, name });
	return name;
}

function firstLine(filePath) {
	// Sessions can be large; read just enough for line 1.
	const fd = fs.openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(4096);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const text = buf.slice(0, n).toString("utf8");
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(0, nl);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Enumerate on-disk sessions, newest first. Archived sessions are hidden
 * unless includeArchived is set. `name` (pi session_info) is resolved only
 * for the returned page, not every file on disk.
 * @returns [{ id, cwd, file, mtimeMs, sizeBytes, startedAt, name, archived }]
 */
export function listSessions({ limit = 50, excludeCwdPatterns = DEFAULT_EXCLUDE_CWD_PATTERNS, includeArchived = false } = {}) {
	const meta = readSessionMeta();
	const out = [];
	let dirs = [];
	try {
		dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
	} catch {
		return out;
	}
	for (const dir of dirs) {
		const dirPath = path.join(SESSIONS_DIR, dir.name);
		let files = [];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(dirPath, f);
			try {
				const stat = fs.statSync(file);
				const header = JSON.parse(firstLine(file));
				if (header?.type !== "session" || !header.cwd) continue;
				const cwd = header.cwd;
				if (excludeCwdPatterns.some((p) => cwd.includes(p))) continue;
				const archived = meta[header.id]?.archived === true;
				if (archived && !includeArchived) continue;
				out.push({
					id: header.id ?? "",
					cwd,
					file,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					startedAt: header.timestamp ?? null,
					archived,
				});
			} catch {
				// unreadable/corrupt session file — skip
			}
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const page = out.slice(0, limit);
	for (const s of page) s.name = sessionNameFromFile(s.file, s.mtimeMs, s.sizeBytes) ?? null;
	return page;
}

/** The shell command a human runs to teleport into a session from any terminal. */
export function teleportCommand(session) {
	return `cd '${session.cwd.replace(/'/g, "'\\''")}' && pi --session '${session.file.replace(/'/g, "'\\''")}'`;
}

/** tmux session name for a pi session id (or fresh spawn). */
function tmuxName(seed) {
	return `pi-${String(seed).replace(/[^\w-]+/g, "").slice(0, 12) || Math.floor(performance.now() * 1000).toString(36)}`;
}

function execFileP(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, opts, (err, stdout, stderr) => {
			if (err) reject(Object.assign(err, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
	});
}

/**
 * Absolute path to the pi CLI. The hub daemon runs under systemd with a
 * minimal PATH, and the tmux server it starts inherits that — a bare `pi`
 * dies instantly inside the spawned session. The pi shim lives next to the
 * node binary (nvm layout), so prefer process.execPath's sibling.
 */
function piBinary() {
	const sibling = path.join(path.dirname(process.execPath), "pi");
	if (fs.existsSync(sibling)) return sibling;
	return "pi"; // PATH fallback for non-nvm layouts
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn a pi session inside a detached tmux session (survives the caller,
 * attachable from any terminal, fires extension lifecycle events — unlike -p).
 * @returns { tmuxSession, command }
 */
export async function spawnSession({ cwd, prompt, resumeFile, model }) {
	if (!cwd || !fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
	// Argument-injection hardening: these values arrive from the (authenticated)
	// web API; none of them may smuggle extra pi flags.
	if (model && /^-/.test(model)) throw new Error("invalid model");
	if (prompt && /^-/.test(prompt.trim())) throw new Error("prompt must not start with '-'");
	if (resumeFile) {
		const real = fs.realpathSync(resumeFile);
		if (!real.startsWith(SESSIONS_DIR + path.sep) || !real.endsWith(".jsonl")) {
			throw new Error("resumeFile must be a session .jsonl under the pi sessions dir");
		}
		resumeFile = real;
	}
	const name = tmuxName(resumeFile ? path.basename(resumeFile).slice(0, 8) : Date.now().toString(36));
	// Prepend node's own dir to PATH for the whole session: the pi shim's
	// `#!/usr/bin/env node` shebang — and every pi subprocess it spawns —
	// must resolve even when the tmux server inherited systemd's bare PATH.
	const pathEnv = `PATH=${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`;
	const piArgs = ["env", pathEnv, piBinary()];
	if (resumeFile) piArgs.push("--session", resumeFile);
	if (model) piArgs.push("--model", model);
	if (prompt) piArgs.push(prompt);
	// tmux new-session -d -s <name> -c <cwd> env PATH=... pi [args...] — argv form, no shell string.
	await execFileP("tmux", ["new-session", "-d", "-s", name, "-c", cwd, ...piArgs]);
	// A session that dies within a second means pi crashed on startup — report
	// that instead of a false success (the tmux session vanishes with it).
	await sleep(1200);
	try {
		await execFileP("tmux", ["has-session", "-t", name]);
	} catch {
		throw new Error("session exited immediately after spawn — pi failed to start in that directory");
	}
	return { tmuxSession: name, command: `tmux attach -t ${name}` };
}

/** Running tmux sessions that look like pi sessions (pi-*). */
export async function listTmuxPiSessions() {
	try {
		const { stdout } = await execFileP("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{pane_current_path}"]);
		return stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [name, created, cwd] = line.split("\t");
				return { name, createdAt: Number(created) * 1000 || null, cwd: cwd ?? "" };
			})
			.filter((s) => s.name.startsWith("pi-"));
	} catch {
		return []; // no tmux server running
	}
}
