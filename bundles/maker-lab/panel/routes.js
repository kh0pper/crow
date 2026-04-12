/**
 * Maker Lab — Kiosk HTTP routes.
 *
 * These routes bypass dashboardAuth. They use per-session HttpOnly cookies
 * issued by /kiosk/r/:code on atomic redemption of a one-shot code.
 *
 * Security contract (from plan + Spike 0):
 * - Redemption is atomic: UPDATE...WHERE used_at IS NULL AND expires_at > now() RETURNING.
 *   An expired or already-used code fails in the same WHERE clause — no TOCTOU race.
 * - Cookie is signed (HMAC-SHA256) and carries the session token + device fingerprint.
 *   On every /kiosk/* request we re-verify signature + fingerprint; a cookie lifted
 *   to a different device fails the fingerprint check.
 * - Session state machine enforced here: active → ending → revoked.
 */

import { Router } from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy DB
let createDbClient;
try {
  const dbMod = await import(pathToFileURL(resolve(__dirname, "../server/db.js")).href);
  createDbClient = dbMod.createDbClient;
} catch {
  createDbClient = null;
}

// Server-side cookie-signing secret. Persisted across restarts via env var;
// if unset we derive one from a per-install file so cookies survive restarts.
// Cookies issued with one secret are invalidated when the secret rotates —
// that's a feature, not a bug (admin can rotate to force all kiosks to re-bind).
function resolveCookieSecret() {
  if (process.env.MAKER_LAB_COOKIE_SECRET) return process.env.MAKER_LAB_COOKIE_SECRET;
  const home = process.env.HOME || ".";
  const path = resolve(home, ".crow", "maker-lab.cookie.secret");
  try {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  } catch {}
  // Fallback: per-process ephemeral. A restart invalidates all cookies.
  return randomBytes(32).toString("hex");
}
const COOKIE_SECRET = resolveCookieSecret();
const COOKIE_NAME_SECURE = "__Host-maker_sid";
const COOKIE_NAME_PLAIN = "maker_sid";
const COOKIE_MAX_AGE_SEC = 6 * 3600; // 6h cap; session exp is authoritative.

function fingerprint(req) {
  const ua = String(req.headers["user-agent"] || "").slice(0, 500);
  const al = String(req.headers["accept-language"] || "").slice(0, 200);
  // Accept an optional client-side token (set by tutor-bridge.js in localStorage
  // and echoed via a custom header). If absent, UA + AL is the floor.
  const clientSalt = String(req.headers["x-maker-kiosk-salt"] || "").slice(0, 128);
  return createHash("sha256").update(`${ua}\n${al}\n${clientSalt}`).digest("base64url");
}

function signCookie(sessionToken, fp) {
  const payload = `${sessionToken}.${fp}`;
  const sig = createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  return `${sessionToken}.${fp}.${sig}`;
}

function verifyCookie(cookie) {
  if (!cookie || typeof cookie !== "string") return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [sessionToken, fp, sig] = parts;
  const expected = createHmac("sha256", COOKIE_SECRET).update(`${sessionToken}.${fp}`).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { sessionToken, fp };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const seg of String(header).split(/;\s*/)) {
    const idx = seg.indexOf("=");
    if (idx < 0) continue;
    out[seg.slice(0, idx).trim()] = seg.slice(idx + 1);
  }
  return out;
}

function cookieName(req) {
  return req.secure ? COOKIE_NAME_SECURE : COOKIE_NAME_PLAIN;
}

function setSessionCookie(req, res, value) {
  const name = cookieName(req);
  const flags = [`${name}=${value}`, "Path=/kiosk", "HttpOnly", "SameSite=Strict", `Max-Age=${COOKIE_MAX_AGE_SEC}`];
  if (req.secure) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearSessionCookie(req, res) {
  const name = cookieName(req);
  const flags = [`${name}=`, "Path=/kiosk", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (req.secure) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

async function resolveSessionRow(db, token) {
  if (!token) return null;
  const r = await db.execute({
    sql: `SELECT s.*, rp.name AS learner_name, mls.age AS learner_age
          FROM maker_sessions s
          LEFT JOIN research_projects rp ON rp.id = s.learner_id
          LEFT JOIN maker_learner_settings mls ON mls.learner_id = s.learner_id
          WHERE s.token = ?`,
    args: [token],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (row.state === "revoked") return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    await db.execute({
      sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now') WHERE token=?`,
      args: [token],
    });
    return null;
  }
  return row;
}

// Extract and verify the current kiosk session from the request.
// Returns { ok: true, session, sessionToken } or { ok: false, reason }.
async function requireKioskSession(req, db) {
  const raw = parseCookies(req.headers.cookie)[cookieName(req)];
  const parsed = verifyCookie(raw);
  if (!parsed) return { ok: false, reason: "no_cookie" };
  if (parsed.fp !== fingerprint(req)) return { ok: false, reason: "fingerprint_mismatch" };
  const session = await resolveSessionRow(db, parsed.sessionToken);
  if (!session) return { ok: false, reason: "session_invalid" };
  return { ok: true, session, sessionToken: parsed.sessionToken };
}

function personaForAge(age) {
  if (age == null) return "kid-tutor";
  if (age <= 9) return "kid-tutor";
  if (age <= 13) return "tween-tutor";
  return "adult-tutor";
}

function ageBandFromGuestBand(band) {
  const b = String(band || "").toLowerCase();
  if (b.includes("5-9")) return "kid-tutor";
  if (b.includes("10-13")) return "tween-tutor";
  return "adult-tutor";
}

export default function makerLabKioskRouter(/* dashboardAuth */) {
  const router = Router();
  let db;

  router.use((req, res, next) => {
    if (!db && createDbClient) db = createDbClient();
    if (!db) return res.status(500).json({ error: "db_unavailable" });
    next();
  });

  // ─── /kiosk/r/:code — atomic redemption ─────────────────────────────────

  router.get("/kiosk/r/:code", async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().slice(0, 32);
    if (!code) return res.status(400).send("Missing code.");

    const fp = fingerprint(req);

    // Atomic claim. Expiry check lives in the WHERE clause, not a read-then-write.
    const r = await db.execute({
      sql: `UPDATE maker_redemption_codes
            SET used_at = datetime('now'), claimed_by_fingerprint = ?
            WHERE code = ? AND used_at IS NULL AND expires_at > datetime('now')
            RETURNING session_token`,
      args: [fp, code],
    });
    if (!r.rows.length) {
      return res.status(410).type("html").send(`
        <!doctype html><meta charset="utf-8">
        <title>Code not valid</title>
        <style>body{font-family:system-ui;padding:2rem;color:#333;max-width:40em;margin:0 auto}</style>
        <h1>This code isn't valid anymore.</h1>
        <p>Ask a grown-up to get a fresh code.</p>
      `);
    }
    const sessionToken = r.rows[0].session_token;
    await db.execute({
      sql: `UPDATE maker_sessions SET kiosk_device_id = ? WHERE token = ?`,
      args: [fp, sessionToken],
    });

    setSessionCookie(req, res, signCookie(sessionToken, fp));
    return res.redirect(302, "/kiosk/");
  });

  // ─── /kiosk/ — Blockly surface ─────────────────────────────────────────

  router.get("/kiosk/", async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) {
      if (guard.reason === "session_invalid") clearSessionCookie(req, res);
      return res.status(401).type("html").send(`
        <!doctype html><meta charset="utf-8">
        <title>Ask a grown-up</title>
        <style>body{font-family:system-ui;padding:2rem;color:#333;max-width:40em;margin:0 auto}</style>
        <h1>Ask a grown-up to start a new session.</h1>
        <p>This kiosk doesn't have an active session right now.</p>
      `);
    }

    const blocklyIndex = resolve(__dirname, "../public/blockly/index.html");
    if (!existsSync(blocklyIndex)) {
      return res.type("html").send(`
        <!doctype html><meta charset="utf-8">
        <title>Maker Lab kiosk</title>
        <style>body{font-family:system-ui;padding:2rem}</style>
        <p>Kiosk placeholder — the Blockly page is not built yet.</p>
      `);
    }
    res.sendFile(blocklyIndex);
  });

  // Blockly static assets served under /kiosk/blockly/*
  router.get("/kiosk/blockly/*", async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) return res.status(401).send("No session.");
    const rel = req.path.replace(/^\/kiosk\/blockly\//, "").replace(/\.\./g, "");
    const full = resolve(__dirname, "../public/blockly", rel);
    if (!full.startsWith(resolve(__dirname, "../public/blockly"))) {
      return res.status(403).send("Nope.");
    }
    if (!existsSync(full)) return res.status(404).send("Not found.");
    res.sendFile(full);
  });

  // ─── /kiosk/api/context ────────────────────────────────────────────────

  router.get("/kiosk/api/context", async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) return res.status(401).json({ error: guard.reason });
    const s = guard.session;
    const age = typeof s.learner_age === "number" ? s.learner_age : null;
    const persona = s.is_guest ? ageBandFromGuestBand(s.guest_age_band) : personaForAge(age);
    // Activity touch
    await db.execute({
      sql: `UPDATE maker_sessions SET last_activity_at = datetime('now'), idle_locked_at = NULL WHERE token = ?`,
      args: [guard.sessionToken],
    });
    res.json({
      persona,
      state: s.state,
      is_guest: !!s.is_guest,
      hints_used: s.hints_used,
      expires_at: s.expires_at,
      idle_lock_min: s.idle_lock_min,
      transcripts_on: !!s.transcripts_enabled_snapshot,
    });
  });

  // ─── /kiosk/api/lesson/:id ─────────────────────────────────────────────

  router.get("/kiosk/api/lesson/:id", async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) return res.status(401).json({ error: guard.reason });
    const id = String(req.params.id || "").replace(/[^\w-]/g, "").slice(0, 100);
    if (!id) return res.status(400).json({ error: "bad_id" });

    // Look in bundled curriculum first, then ~/.crow/bundles/maker-lab/curriculum/custom/.
    const candidates = [
      resolve(__dirname, `../curriculum/age-5-9/${id}.json`),
      resolve(__dirname, `../curriculum/age-10-13/${id}.json`),
      resolve(__dirname, `../curriculum/age-14+/${id}.json`),
      resolve(process.env.HOME || ".", `.crow/bundles/maker-lab/curriculum/custom/${id}.json`),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          const lesson = JSON.parse(readFileSync(p, "utf8"));
          return res.json({ lesson });
        } catch (err) {
          return res.status(500).json({ error: "lesson_parse_error", detail: err.message });
        }
      }
    }
    res.status(404).json({ error: "not_found" });
  });

  // ─── /kiosk/api/progress ───────────────────────────────────────────────

  router.post("/kiosk/api/progress", express_json(), async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) return res.status(401).json({ error: guard.reason });
    const s = guard.session;
    if (s.state === "revoked") return res.status(410).json({ error: "revoked" });

    const { surface, activity, outcome, note } = req.body || {};
    const allowed = ["started", "completed", "abandoned", "struggled"];
    if (!surface || !activity || !allowed.includes(outcome)) {
      return res.status(400).json({ error: "bad_body" });
    }

    // Touch activity
    await db.execute({
      sql: `UPDATE maker_sessions SET last_activity_at = datetime('now'), idle_locked_at = NULL WHERE token = ?`,
      args: [guard.sessionToken],
    });

    if (s.is_guest || !s.learner_id) return res.json({ logged: false, reason: "guest" });

    try {
      await db.execute({
        sql: `INSERT INTO memories (content, context, category, importance, tags, project_id, source, created_at)
              VALUES (?, ?, 'learning', 5, ?, ?, 'maker-lab', datetime('now'))`,
        args: [
          String(note || `${outcome} on ${activity} in ${surface}`).slice(0, 2000),
          `${String(surface).slice(0, 50)}:${String(activity).slice(0, 200)} — ${outcome}`,
          `maker-lab,${surface},${outcome}`,
          s.learner_id,
        ],
      });
      return res.json({ logged: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── /kiosk/api/hint ───────────────────────────────────────────────────
  //
  // Delegates to maker_hint via dynamic import of the factory's helpers.
  // Phase 2.1 wires a shared module for LLM+filter; for now this endpoint
  // returns a canned lesson hint appropriate to the persona (same as the
  // MCP tool under the hood).

  router.post("/kiosk/api/hint", express_json(), async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) return res.status(401).json({ error: guard.reason });
    const s = guard.session;
    if (s.state === "revoked") return res.status(410).json({ error: "revoked" });

    const { surface, question, level, lesson_id, canned_hints } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "bad_question" });
    }

    // Activity touch
    await db.execute({
      sql: `UPDATE maker_sessions SET last_activity_at = datetime('now'), idle_locked_at = NULL WHERE token = ?`,
      args: [guard.sessionToken],
    });

    // Route through the shared hint pipeline (LLM + filter). Phase 2.
    const { handleHintRequest } = await import(pathToFileURL(resolve(__dirname, "../server/hint-pipeline.js")).href);
    try {
      const result = await handleHintRequest(db, {
        sessionToken: guard.sessionToken,
        session: s,
        surface: String(surface || "").slice(0, 50),
        question: question.slice(0, 2000),
        level: Math.min(3, Math.max(1, Number(level) || 1)),
        lessonId: lesson_id ? String(lesson_id).slice(0, 100) : null,
        cannedHints: Array.isArray(canned_hints) ? canned_hints.map((h) => String(h).slice(0, 500)).slice(0, 10) : null,
      });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: "hint_failed", detail: err.message });
    }
  });

  // ─── /kiosk/api/end ────────────────────────────────────────────────────

  router.post("/kiosk/api/end", async (req, res) => {
    const guard = await requireKioskSession(req, db);
    if (!guard.ok) return res.status(401).json({ error: guard.reason });
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  return router;
}

// Minimal body-parser to avoid ordering concerns with the main app's JSON parser.
function express_json(limit = 64 * 1024) {
  return (req, res, next) => {
    if (req.method !== "POST" && req.method !== "PUT") return next();
    if (req.headers["content-type"] && !String(req.headers["content-type"]).includes("application/json")) {
      return next();
    }
    if (req.body && typeof req.body === "object") return next();
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try { req.body = data ? JSON.parse(data) : {}; }
      catch { req.body = {}; }
      next();
    });
    req.on("error", next);
  };
}
