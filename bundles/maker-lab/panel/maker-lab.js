/**
 * Crow's Nest Panel — Maker Lab (Phase 2.1)
 *
 * Views by mode:
 *   solo      — "Continue learning" tile + settings
 *   family    — learner list, per-card Start session
 *   classroom — learner grid, multi-select, Bulk Start, printable batch sheet
 *   guest     — "Try it" age-picker (available from any mode)
 *
 * Session views:
 *   ?start=<learner_id>          → mint + render QR handoff page
 *   ?bulk=1 (POST)               → mint batch + render printable sheet
 *   ?batch=<batch_id>            → view + revoke batch
 *   ?guest=1                     → age picker → mint guest + QR page
 *   ?session=<token>             → live session controls (end / force end)
 *
 * Handler pattern follows bundles/knowledge-base/panel/knowledge-base.js.
 */

import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sibling surfaces surfaced in the "Add more surfaces" card. Each entry
// mirrors the bundle id in registry/add-ons.json; the install flow goes
// through the existing /bundles/api/install endpoint. webPath is used
// post-install to turn the button into an "Open ↗" launch link.
const SIBLING_SURFACES = [
  {
    id: "kolibri",
    name: "Kolibri",
    tagline: "Offline-first learning platform — content spine for Maker Lab.",
    minAge: null,
    webPath: "/dashboard/kolibri",
  },
  {
    id: "scratch-offline",
    name: "Offline Block Coding (Scratch-compatible)",
    tagline: "Self-hosted block coding for ages 8+ — a step up from Blockly.",
    minAge: 8,
    webPath: "/dashboard/scratch-offline",
  },
  {
    id: "maker-lab-advanced",
    name: "Maker Lab Advanced",
    tagline: "JupyterHub classroom for ages 9+ — Python notebooks with a kid-safe kernel.",
    minAge: 9,
    webPath: "/dashboard/maker-lab-advanced",
  },
  {
    id: "vllm",
    name: "vLLM",
    tagline: "GPU classroom inference engine — auto-wires to Maker Lab once installed.",
    minAge: null,
    webPath: "/dashboard/vllm",
  },
];

function readInstalledBundleIds() {
  try {
    const p = join(homedir(), ".crow/installed.json");
    if (!existsSync(p)) return new Set();
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...v }));
    return new Set(arr.map((e) => e.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function loadDeviceBinding() {
  return import(pathToFileURL(resolve(__dirname, "../server/device-binding.js")).href);
}

export default {
  id: "maker-lab",
  name: "Maker Lab",
  icon: "graduation-cap",
  route: "/dashboard/maker-lab",
  navOrder: 45,
  category: "education",

  async handler(req, res, { db, layout, appRoot }) {
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const sessionsMod = await import(pathToFileURL(resolve(__dirname, "../server/sessions.js")).href);
    const { mintSessionForLearner, mintGuestSession, mintBatchSessions } = sessionsMod;

    // ─── Helpers ─────────────────────────────────────────────────────────

    async function getMode() {
      const r = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'maker_lab.mode'",
        args: [],
      });
      return r.rows[0]?.value || "family";
    }

    async function setMode(mode) {
      await db.execute({
        sql: `INSERT INTO dashboard_settings (key, value) VALUES ('maker_lab.mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [mode],
      });
    }

    function publicBaseUrl() {
      // CROW_GATEWAY_URL is set by the installer to the Tailscale / LAN hostname.
      // If unset, we emit relative URLs — kiosks on the same network see the
      // gateway at whatever host they loaded the QR from.
      return (process.env.CROW_GATEWAY_URL || "").replace(/\/$/, "");
    }

    function fullKioskUrl(shortUrl) {
      const base = publicBaseUrl();
      return base ? `${base}${shortUrl}` : shortUrl;
    }

    async function renderQrSvg(url) {
      try {
        return await QRCode.toString(url, {
          type: "svg",
          errorCorrectionLevel: "M",
          margin: 1,
          width: 220,
        });
      } catch {
        return "";
      }
    }

    // ─── POST actions ────────────────────────────────────────────────────

    if (req.method === "POST") {
      const a = req.body?.action;

      if (a === "set_mode") {
        const mode = String(req.body.mode || "family");
        if (["solo", "family", "classroom"].includes(mode)) {
          if (mode === "solo") {
            const c = await db.execute({
              sql: "SELECT COUNT(*) AS n FROM research_projects WHERE type='learner_profile'",
              args: [],
            });
            if (Number(c.rows[0].n) > 1) {
              return res.redirect("/dashboard/maker-lab?err=solo_multiple_learners");
            }
          }
          await setMode(mode);
        }
        return res.redirect("/dashboard/maker-lab");
      }

      if (a === "create_learner") {
        const name = String(req.body.name || "").trim().slice(0, 100);
        const age = Number(req.body.age);
        const avatar = String(req.body.avatar || "").slice(0, 50) || null;
        const consent = req.body.consent === "1";
        if (!name || !Number.isFinite(age) || age < 3 || age > 100) {
          return res.redirect("/dashboard/maker-lab?err=create_invalid");
        }
        if (!consent) {
          return res.redirect("/dashboard/maker-lab?err=consent_required");
        }
        const ins = await db.execute({
          sql: `INSERT INTO research_projects (name, type, description, created_at, updated_at)
                VALUES (?, 'learner_profile', ?, datetime('now'), datetime('now')) RETURNING id`,
          args: [name, null],
        });
        const lid = Number(ins.rows[0].id);
        await db.execute({
          sql: `INSERT INTO maker_learner_settings (learner_id, age, avatar, consent_captured_at)
                VALUES (?, ?, ?, datetime('now'))`,
          args: [lid, age, avatar],
        });
        return res.redirect(`/dashboard/maker-lab?created=${lid}`);
      }

      if (a === "delete_learner") {
        const lid = Number(req.body.learner_id);
        if (!Number.isFinite(lid)) return res.redirect("/dashboard/maker-lab");
        if (req.body.confirm !== "DELETE") {
          return res.redirect(`/dashboard/maker-lab?pending_delete=${lid}`);
        }
        await db.execute({ sql: "DELETE FROM maker_sessions WHERE learner_id=?", args: [lid] });
        await db.execute({ sql: "DELETE FROM maker_transcripts WHERE learner_id=?", args: [lid] });
        await db.execute({ sql: "DELETE FROM maker_bound_devices WHERE learner_id=?", args: [lid] });
        await db.execute({ sql: "DELETE FROM maker_learner_settings WHERE learner_id=?", args: [lid] });
        try { await db.execute({ sql: "DELETE FROM memories WHERE project_id=?", args: [lid] }); } catch {}
        await db.execute({
          sql: "DELETE FROM research_projects WHERE id=? AND type='learner_profile'",
          args: [lid],
        });
        return res.redirect("/dashboard/maker-lab?deleted=1");
      }

      if (a === "start_session") {
        const lid = Number(req.body.learner_id);
        const duration = Math.max(5, Math.min(240, Number(req.body.duration_min) || 60));
        const idle = req.body.idle_lock_min ? Math.max(0, Math.min(240, Number(req.body.idle_lock_min))) : undefined;
        try {
          const r = await mintSessionForLearner(db, {
            learnerId: lid, durationMin: duration, idleLockMin: idle,
          });
          return res.redirect(`/dashboard/maker-lab?qr=${encodeURIComponent(r.redemptionCode)}`);
        } catch (err) {
          return res.redirect(`/dashboard/maker-lab?err=${encodeURIComponent(err.code || "mint_failed")}`);
        }
      }

      if (a === "bulk_start") {
        const raw = req.body.learner_ids;
        const ids = (Array.isArray(raw) ? raw : [raw])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return res.redirect("/dashboard/maker-lab?err=no_learners");
        const duration = Math.max(5, Math.min(240, Number(req.body.duration_min) || 60));
        const idle = req.body.idle_lock_min ? Math.max(0, Math.min(240, Number(req.body.idle_lock_min))) : undefined;
        const label = String(req.body.batch_label || "").trim().slice(0, 200) || null;
        const { batchId } = await mintBatchSessions(db, {
          learnerIds: ids, durationMin: duration, idleLockMin: idle, batchLabel: label,
        });
        return res.redirect(`/dashboard/maker-lab?batch=${encodeURIComponent(batchId)}`);
      }

      if (a === "start_guest") {
        const band = ["5-9", "10-13", "14+"].includes(String(req.body.age_band))
          ? String(req.body.age_band) : "5-9";
        const r = await mintGuestSession(db, { ageBand: band });
        return res.redirect(`/dashboard/maker-lab?qr=${encodeURIComponent(r.redemptionCode)}&guest=1`);
      }

      if (a === "end_session") {
        const token = String(req.body.session_token || "");
        if (token) {
          await db.execute({
            sql: `UPDATE maker_sessions SET state='ending', ending_started_at=datetime('now')
                  WHERE token=? AND state='active'`,
            args: [token],
          });
          setTimeout(async () => {
            try {
              await db.execute({
                sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now') WHERE token=?`,
                args: [token],
              });
            } catch {}
          }, 5000);
        }
        return res.redirect("/dashboard/maker-lab");
      }

      if (a === "force_end") {
        const token = String(req.body.session_token || "");
        const reason = String(req.body.reason || "admin_force").slice(0, 500);
        if (!token || reason.length < 3) return res.redirect("/dashboard/maker-lab?err=reason_required");
        await db.execute({
          sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now') WHERE token=?`,
          args: [token],
        });
        return res.redirect("/dashboard/maker-lab");
      }

      if (a === "update_learner") {
        const lid = Number(req.body.learner_id);
        if (!Number.isFinite(lid)) return res.redirect("/dashboard/maker-lab?err=learner_not_found");
        const name = String(req.body.name || "").trim().slice(0, 100);
        const age = Number(req.body.age);
        const avatar = String(req.body.avatar || "").slice(0, 50) || null;
        if (!name || !Number.isFinite(age) || age < 3 || age > 100) {
          return res.redirect(`/dashboard/maker-lab?edit=${lid}&err=create_invalid`);
        }
        await db.execute({
          sql: `UPDATE research_projects SET name=?, updated_at=datetime('now')
                WHERE id=? AND type='learner_profile'`,
          args: [name, lid],
        });
        const transcripts = req.body.transcripts_enabled === "1" ? 1 : 0;
        const retention = Math.max(0, Math.min(3650, Number(req.body.transcripts_retention_days) || 30));
        const idleMin = req.body.idle_lock_default_min === "" ? null
          : Math.max(0, Math.min(240, Number(req.body.idle_lock_default_min) || 0));
        const autoResume = Math.max(0, Math.min(240, Number(req.body.auto_resume_min) || 15));
        const voice = req.body.voice_input_enabled === "1" ? 1 : 0;
        await db.execute({
          sql: `UPDATE maker_learner_settings SET
                  age = ?, avatar = ?,
                  transcripts_enabled = ?, transcripts_retention_days = ?,
                  idle_lock_default_min = ?, auto_resume_min = ?,
                  voice_input_enabled = ?, updated_at = datetime('now')
                WHERE learner_id = ?`,
          args: [age, avatar, transcripts, retention, idleMin, autoResume, voice, lid],
        });
        return res.redirect(`/dashboard/maker-lab?edit=${lid}&saved=1`);
      }

      if (a === "unlock_idle") {
        const token = String(req.body.session_token || "");
        if (token) {
          await db.execute({
            sql: `UPDATE maker_sessions SET idle_locked_at=NULL, last_activity_at=datetime('now') WHERE token=?`,
            args: [token],
          });
        }
        return res.redirect("/dashboard/maker-lab");
      }

      if (a === "set_solo_lan_exposure") {
        const v = String(req.body.value || "").toLowerCase() === "on" ? "on" : "off";
        const devBinding = await loadDeviceBinding();
        await devBinding.setSoloLanExposure(db, v);
        return res.redirect("/dashboard/maker-lab?settings=1&saved=1");
      }

      if (a === "import_lesson") {
        const raw = String(req.body.lesson_json || "");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          return layout({
            title: "Import lesson — parse error",
            content: renderLessonImportResult({ errors: [`JSON parse error: ${err.message}`], raw, escapeHtml }),
          });
        }
        const { validateLesson } = await import(pathToFileURL(resolve(__dirname, "../server/lesson-validator.js")).href);
        const { valid, errors } = validateLesson(parsed);
        if (!valid) {
          return layout({
            title: "Import lesson — validation failed",
            content: renderLessonImportResult({ errors, raw, escapeHtml }),
          });
        }
        // Write to ~/.crow/bundles/maker-lab/curriculum/custom/<id>.json
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const home = process.env.HOME || ".";
        const dir = resolve(home, ".crow/bundles/maker-lab/curriculum/custom");
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${parsed.id}.json`), JSON.stringify(parsed, null, 2) + "\n");
        } catch (err) {
          return layout({
            title: "Import lesson — write failed",
            content: renderLessonImportResult({ errors: [`Failed to write: ${err.message}`], raw, escapeHtml }),
          });
        }
        return res.redirect(`/dashboard/maker-lab?lessons=1&imported=${encodeURIComponent(parsed.id)}`);
      }

      if (a === "delete_custom_lesson") {
        const id = String(req.body.lesson_id || "").replace(/[^\w-]/g, "");
        if (!id) return res.redirect("/dashboard/maker-lab?lessons=1");
        const { unlinkSync, existsSync: existsFn } = await import("node:fs");
        const home = process.env.HOME || ".";
        const path = resolve(home, ".crow/bundles/maker-lab/curriculum/custom", `${id}.json`);
        try {
          if (existsFn(path)) unlinkSync(path);
        } catch {}
        return res.redirect(`/dashboard/maker-lab?lessons=1&deleted=${encodeURIComponent(id)}`);
      }

      if (a === "unbind_device") {
        const fp = String(req.body.fingerprint || "");
        if (!fp) return res.redirect("/dashboard/maker-lab?settings=1");
        const devBinding = await loadDeviceBinding();
        await devBinding.unbindDevice(db, fp);
        return res.redirect("/dashboard/maker-lab?settings=1&unbound=1");
      }

      if (a === "revoke_batch") {
        const batchId = String(req.body.batch_id || "");
        const reason = String(req.body.reason || "").slice(0, 500);
        if (!batchId || reason.length < 3) return res.redirect("/dashboard/maker-lab?err=reason_required");
        await db.execute({
          sql: `UPDATE maker_sessions SET state='revoked', revoked_at=datetime('now')
                WHERE batch_id=? AND state != 'revoked'`,
          args: [batchId],
        });
        await db.execute({
          sql: `UPDATE maker_batches SET revoked_at=datetime('now'), revoke_reason=? WHERE batch_id=?`,
          args: [reason, batchId],
        });
        return res.redirect("/dashboard/maker-lab?revoked_batch=" + encodeURIComponent(batchId));
      }
    }

    // ─── GET: specialized views ──────────────────────────────────────────

    // QR handoff page (single session)
    if (req.query.qr) {
      const code = String(req.query.qr).toUpperCase().slice(0, 32);
      const r = await db.execute({
        sql: `SELECT c.*, s.is_guest, s.learner_id, s.expires_at AS session_expires_at,
                     rp.name AS learner_name
              FROM maker_redemption_codes c
              JOIN maker_sessions s ON s.token = c.session_token
              LEFT JOIN research_projects rp ON rp.id = s.learner_id
              WHERE c.code = ?`,
        args: [code],
      });
      if (!r.rows.length) {
        return layout({ title: "Code not found", content: `<p>That redemption code doesn't exist.</p><a href="/dashboard/maker-lab">Back</a>` });
      }
      const row = r.rows[0];
      const shortUrl = `/kiosk/r/${code}`;
      const fullUrl = fullKioskUrl(shortUrl);
      const qrSvg = await renderQrSvg(fullUrl);
      const title = row.is_guest ? "Guest session" : `Session for ${row.learner_name || "learner"}`;
      return layout({
        title,
        content: renderQrPage({ code, shortUrl, fullUrl, qrSvg, row, escapeHtml }),
      });
    }

    // Lessons view
    if (req.query.lessons) {
      const { readdirSync, readFileSync, existsSync: existsFn } = await import("node:fs");
      const home = process.env.HOME || ".";
      const customDir = resolve(home, ".crow/bundles/maker-lab/curriculum/custom");
      const bundledDirs = [
        { band: "5-9", dir: resolve(__dirname, "../curriculum/age-5-9") },
        { band: "10-13", dir: resolve(__dirname, "../curriculum/age-10-13") },
        { band: "14+", dir: resolve(__dirname, "../curriculum/age-14+") },
      ];
      const loadDir = (dir) => {
        if (!existsFn(dir)) return [];
        try {
          return readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
              try {
                const parsed = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
                return { file: f, lesson: parsed };
              } catch (err) {
                return { file: f, error: err.message };
              }
            });
        } catch { return []; }
      };
      const bundled = bundledDirs.map((b) => ({ band: b.band, items: loadDir(b.dir) }));
      const custom = loadDir(customDir);
      return layout({
        title: "Maker Lab — Lessons",
        content: renderLessonsView({
          bundled, custom,
          imported: String(req.query.imported || ""),
          deleted: String(req.query.deleted || ""),
          escapeHtml,
        }),
      });
    }

    // Settings view
    if (req.query.settings) {
      const devBinding = await loadDeviceBinding();
      const [lanExposure, devices, mode] = await Promise.all([
        devBinding.getSoloLanExposure(db),
        devBinding.listBoundDevices(db),
        getMode(),
      ]);
      return layout({
        title: "Maker Lab — Settings",
        content: renderSettingsView({
          mode, lanExposure, devices,
          saved: req.query.saved === "1",
          unbound: req.query.unbound === "1",
          escapeHtml,
        }),
      });
    }

    // Per-learner edit view
    if (req.query.edit) {
      const lid = Number(req.query.edit);
      if (!Number.isFinite(lid)) {
        return layout({ title: "Not found", content: `<a href="/dashboard/maker-lab">Back</a>` });
      }
      const r = await db.execute({
        sql: `SELECT rp.id, rp.name, rp.created_at, mls.*
              FROM research_projects rp
              LEFT JOIN maker_learner_settings mls ON mls.learner_id = rp.id
              WHERE rp.id = ? AND rp.type = 'learner_profile'`,
        args: [lid],
      });
      if (!r.rows.length) {
        return layout({ title: "Not found", content: `<p>Learner not found.</p><a href="/dashboard/maker-lab">Back</a>` });
      }
      const saved = req.query.saved === "1";
      const errKey = String(req.query.err || "");
      return layout({
        title: `Edit ${r.rows[0].name}`,
        content: renderEditView({ learner: r.rows[0], saved, errKey, escapeHtml }),
      });
    }

    // Transcripts view
    if (req.query.transcripts) {
      const lid = Number(req.query.transcripts);
      if (!Number.isFinite(lid)) {
        return layout({ title: "Not found", content: `<a href="/dashboard/maker-lab">Back</a>` });
      }
      const [learnerR, settingsR, transcriptsR] = await Promise.all([
        db.execute({ sql: "SELECT id, name FROM research_projects WHERE id=? AND type='learner_profile'", args: [lid] }),
        db.execute({ sql: "SELECT * FROM maker_learner_settings WHERE learner_id=?", args: [lid] }),
        db.execute({
          sql: `SELECT id, session_token, turn_no, role, content, created_at
                FROM maker_transcripts
                WHERE learner_id = ?
                ORDER BY created_at DESC, turn_no DESC
                LIMIT 500`,
          args: [lid],
        }),
      ]);
      if (!learnerR.rows.length) {
        return layout({ title: "Not found", content: `<a href="/dashboard/maker-lab">Back</a>` });
      }
      return layout({
        title: `Transcripts — ${learnerR.rows[0].name}`,
        content: renderTranscriptsView({
          learner: learnerR.rows[0],
          settings: settingsR.rows[0] || {},
          transcripts: transcriptsR.rows,
          escapeHtml,
        }),
      });
    }

    // Batch sheet view (printable)
    if (req.query.batch) {
      const batchId = String(req.query.batch).slice(0, 64);
      const [bRes, sRes] = await Promise.all([
        db.execute({ sql: "SELECT * FROM maker_batches WHERE batch_id=?", args: [batchId] }),
        db.execute({
          sql: `SELECT c.code, c.expires_at AS code_expires_at,
                       s.token, s.learner_id, s.expires_at AS session_expires_at, s.state,
                       rp.name AS learner_name
                FROM maker_sessions s
                JOIN maker_redemption_codes c ON c.session_token = s.token
                LEFT JOIN research_projects rp ON rp.id = s.learner_id
                WHERE s.batch_id = ?
                ORDER BY rp.name`,
          args: [batchId],
        }),
      ]);
      if (!bRes.rows.length) {
        return layout({ title: "Batch not found", content: `<a href="/dashboard/maker-lab">Back</a>` });
      }
      const batch = bRes.rows[0];
      const rows = await Promise.all(sRes.rows.map(async (r) => ({
        ...r,
        qrSvg: await renderQrSvg(fullKioskUrl(`/kiosk/r/${r.code}`)),
      })));
      return layout({
        title: `Batch: ${batch.label || batch.batch_id.slice(0, 8)}`,
        content: renderBatchSheet({ batch, rows, escapeHtml, fullKioskUrl, publicBaseUrl }),
      });
    }

    // ─── GET: main view ──────────────────────────────────────────────────

    const mode = await getMode();
    const err = String(req.query.err || "");
    const pendingDelete = req.query.pending_delete ? Number(req.query.pending_delete) : null;
    const showGuestPicker = req.query.guest === "pick";

    const learnersR = await db.execute({
      sql: `SELECT rp.id, rp.name, rp.created_at,
                   mls.age, mls.avatar,
                   mls.transcripts_enabled, mls.consent_captured_at
            FROM research_projects rp
            LEFT JOIN maker_learner_settings mls ON mls.learner_id = rp.id
            WHERE rp.type = 'learner_profile'
            ORDER BY rp.created_at DESC`,
      args: [],
    });
    const learners = learnersR.rows.map((r) => ({
      id: Number(r.id), name: r.name,
      age: r.age ?? null,
      avatar: r.avatar ?? null,
      persona: r.age == null ? "kid-tutor"
        : r.age <= 9 ? "kid-tutor"
        : r.age <= 13 ? "tween-tutor"
        : "adult-tutor",
      transcripts_enabled: !!r.transcripts_enabled,
      consent_captured_at: r.consent_captured_at,
    }));

    const activeSessionsR = await db.execute({
      sql: `SELECT s.token, s.learner_id, s.is_guest, s.guest_age_band, s.batch_id,
                   s.started_at, s.expires_at, s.state, s.hints_used,
                   s.idle_locked_at, s.last_activity_at,
                   rp.name AS learner_name
            FROM maker_sessions s
            LEFT JOIN research_projects rp ON rp.id = s.learner_id
            WHERE s.state != 'revoked' AND s.expires_at > datetime('now')
            ORDER BY s.started_at DESC LIMIT 50`,
      args: [],
    });
    const allActive = activeSessionsR.rows;
    // Pre-fetch the latest unused (or most-recent) redemption code per active
    // session so the "QR" button on live cards can link to the handoff page.
    const tokenList = allActive.map((s) => s.token);
    const codesByToken = new Map();
    if (tokenList.length) {
      const placeholders = tokenList.map(() => "?").join(",");
      const codesR = await db.execute({
        sql: `SELECT session_token, code, created_at FROM maker_redemption_codes
              WHERE session_token IN (${placeholders})
              ORDER BY created_at DESC`,
        args: tokenList,
      });
      for (const row of codesR.rows) {
        if (!codesByToken.has(row.session_token)) {
          codesByToken.set(row.session_token, row.code);
        }
      }
    }
    const activeByLearner = new Map();
    for (const s of allActive) {
      s.redemption_code = codesByToken.get(s.token) || null;
      if (s.learner_id != null) activeByLearner.set(Number(s.learner_id), s);
    }

    const batchesR = await db.execute({
      sql: `SELECT batch_id, label, created_at, revoked_at FROM maker_batches
            ORDER BY created_at DESC LIMIT 10`,
      args: [],
    });

    const installedBundleIds = readInstalledBundleIds();
    const maxLearnerAge = learners.reduce(
      (max, l) => (Number.isFinite(l.age) && l.age > max ? l.age : max),
      0,
    );

    const content = renderMainView({
      mode, err, pendingDelete, showGuestPicker,
      learners, allActive, activeByLearner, batches: batchesR.rows,
      installedBundleIds, maxLearnerAge,
      escapeHtml,
    });

    return layout({ title: `Maker Lab (${mode})`, content });
  },
};

// ─── Render: QR handoff page ──────────────────────────────────────────────

function renderQrPage({ code, shortUrl, fullUrl, qrSvg, row, escapeHtml }) {
  const subject = row.is_guest ? "Guest session" : `Session for ${row.learner_name || "learner"}`;
  return `
    <style>
      .qr-page { display: grid; grid-template-columns: 240px 1fr; gap: 2rem; padding: 1.5rem; max-width: 800px; margin: 0 auto; }
      .qr-box { padding: 1rem; background: #fff; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
      .qr-box svg { width: 100%; height: auto; max-width: 220px; }
      .code { font-size: 2.5rem; letter-spacing: 0.15em; font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
      .url { font-family: ui-monospace, Menlo, monospace; padding: 0.5rem; background: rgba(0,0,0,0.05); border-radius: 4px; word-break: break-all; margin: 0.5rem 0; }
      .meta { color: var(--muted, #888); font-size: 0.9em; }
      .btn-row { margin-top: 1rem; display: flex; gap: 0.5rem; }
      .btn { padding: 0.4rem 1rem; border: 1px solid var(--border, #333); border-radius: 4px; background: transparent; color: inherit; text-decoration: none; font-size: 0.9em; }
      @media print { .btn-row, nav, header { display: none !important; } }
    </style>
    <div class="qr-page">
      <div class="qr-box">${qrSvg || '<em>QR render failed</em>'}</div>
      <div>
        <h2 style="margin-top:0">${escapeHtml(subject)}</h2>
        <div class="code">${escapeHtml(code)}</div>
        <div class="url">${escapeHtml(fullUrl)}</div>
        <div class="meta">Code expires ${escapeHtml(row.expires_at)}. Session expires ${escapeHtml(row.session_expires_at)}.</div>
        <div class="meta">Scan the QR with any camera, or type the code at <code>/kiosk/r/CODE</code> on the kiosk.</div>
        <div class="btn-row">
          <a class="btn" href="/dashboard/maker-lab">Back</a>
          <button class="btn" onclick="window.print()">Print</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Render: printable batch sheet ────────────────────────────────────────

function renderBatchSheet({ batch, rows, escapeHtml, fullKioskUrl, publicBaseUrl }) {
  const revoked = !!batch.revoked_at;
  const cards = rows.map((r) => `
    <div class="card ${r.state === 'revoked' ? 'revoked' : ''}">
      <div class="card-qr">${r.qrSvg || ''}</div>
      <div class="card-meta">
        <div class="learner">${escapeHtml(r.learner_name || '(unknown)')}</div>
        <div class="code">${escapeHtml(r.code)}</div>
        <div class="expires">expires ${escapeHtml(r.session_expires_at)}</div>
      </div>
    </div>
  `).join("");

  return `
    <style>
      .batch-sheet { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
      .sheet-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
      .card { border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.75rem; background: var(--card, rgba(255,255,255,0.03)); }
      .card.revoked { opacity: 0.4; text-decoration: line-through; }
      .card-qr { display: flex; justify-content: center; padding: 0.5rem; background: #fff; border-radius: 4px; }
      .card-qr svg { width: 100%; height: auto; max-width: 180px; }
      .card-meta { margin-top: 0.5rem; text-align: center; }
      .learner { font-weight: 600; font-size: 1rem; }
      .code { font-family: ui-monospace, Menlo, monospace; font-size: 1.2rem; letter-spacing: 0.1em; margin: 0.25rem 0; }
      .expires { color: var(--muted, #888); font-size: 0.75em; }
      .btn { padding: 0.4rem 1rem; border: 1px solid var(--border, #333); border-radius: 4px; background: transparent; color: inherit; text-decoration: none; font-size: 0.9em; cursor: pointer; }
      .btn.danger { background: #ef4444; color: #fff; border-color: #ef4444; }
      @media print { .sheet-header button, .btn, .revoke-form { display: none !important; } }
    </style>
    <div class="batch-sheet">
      <div class="sheet-header">
        <h2 style="margin:0">${escapeHtml(batch.label || `Batch ${batch.batch_id.slice(0, 8)}`)}</h2>
        <div>
          <button class="btn" onclick="window.print()">Print</button>
          <a class="btn" href="/dashboard/maker-lab">Back</a>
        </div>
      </div>
      ${revoked ? `<div style="padding:0.5rem 0.8rem;background:rgba(239,68,68,0.15);color:#ef4444;border-radius:4px;margin-bottom:1rem;">Revoked at ${escapeHtml(batch.revoked_at)}${batch.revoke_reason ? ` — ${escapeHtml(batch.revoke_reason)}` : ''}</div>` : ''}
      <div class="grid">${cards || '<p>(no sessions in this batch)</p>'}</div>
      ${!revoked ? `
        <form method="POST" action="/dashboard/maker-lab" class="revoke-form" style="margin-top:1.5rem;display:flex;gap:0.5rem;align-items:center">
          <input type="hidden" name="action" value="revoke_batch">
          <input type="hidden" name="batch_id" value="${escapeHtml(batch.batch_id)}">
          <input name="reason" placeholder="Reason (e.g. lost the sheet)" required minlength="3" maxlength="500" style="padding:0.4rem;flex:1;background:var(--input,rgba(0,0,0,0.3));color:inherit;border:1px solid var(--border,#333);border-radius:4px">
          <button type="submit" class="btn danger">Revoke entire batch</button>
        </form>
      ` : ''}
    </div>
  `;
}

// ─── Render: main view ────────────────────────────────────────────────────

function renderSiblingSurfacesCard({ installedBundleIds, maxLearnerAge, escapeHtml }) {
  // When there are no learners yet, don't gate by age — the operator is
  // still setting up and should see all options.
  const ageFloor = maxLearnerAge > 0 ? maxLearnerAge : Infinity;
  const visible = SIBLING_SURFACES.filter((s) => s.minAge == null || ageFloor >= s.minAge);
  if (!visible.length) return "";
  const tiles = visible.map((s) => {
    const installed = installedBundleIds.has(s.id);
    const action = installed
      ? `<a class="btn small primary" href="${escapeHtml(s.webPath)}">Open ${escapeHtml(s.name.split(" ")[0])} ↗</a>`
      : `<button type="button" class="btn small primary" data-install-bundle="${escapeHtml(s.id)}">Install</button>`;
    const gateNote = s.minAge ? `<span class="meta"> · ages ${s.minAge}+</span>` : "";
    return `
      <div class="sibling-tile">
        <div class="sibling-head"><strong>${escapeHtml(s.name)}</strong>${gateNote}</div>
        <div class="sibling-body">${escapeHtml(s.tagline)}</div>
        <div class="sibling-actions">${action}</div>
      </div>
    `;
  }).join("");
  return `
    <details class="panel" open>
      <summary>Add more surfaces</summary>
      <div class="sibling-grid">${tiles}</div>
    </details>
    <script>
      document.querySelectorAll("[data-install-bundle]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-install-bundle");
          btn.disabled = true;
          btn.textContent = "Installing…";
          try {
            const res = await fetch("/bundles/api/install", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bundle_id: id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
            window.location.reload();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = "Install";
            alert("Install failed: " + e.message);
          }
        });
      });
    </script>
  `;
}

function renderMainView({ mode, err, pendingDelete, showGuestPicker, learners, allActive, activeByLearner, batches, installedBundleIds, maxLearnerAge, escapeHtml }) {
  const errMsgs = {
    create_invalid: "Name is required and age must be between 3 and 100.",
    consent_required: "Consent checkbox is required.",
    solo_multiple_learners: "Cannot downgrade to Solo mode with more than one learner.",
    reason_required: "Reason is required (at least 3 chars).",
    no_learners: "Pick at least one learner to start a batch.",
    learner_not_found: "That learner doesn't exist.",
  };
  const errBanner = err ? `<div class="banner error">${escapeHtml(errMsgs[err] || err)}</div>` : "";

  const modeTabs = ["solo", "family", "classroom"].map((m) => `
    <form method="POST" action="/dashboard/maker-lab" style="display:inline">
      <input type="hidden" name="action" value="set_mode">
      <input type="hidden" name="mode" value="${m}">
      <button type="submit" class="mode-tab ${m === mode ? 'active' : ''}">${m}</button>
    </form>
  `).join("");

  const guestSection = showGuestPicker ? `
    <div class="panel">
      <form method="POST" action="/dashboard/maker-lab">
        <input type="hidden" name="action" value="start_guest">
        <strong>Try it without saving — pick an age:</strong>
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
          <button type="submit" name="age_band" value="5-9" class="btn primary">Ages 5–9</button>
          <button type="submit" name="age_band" value="10-13" class="btn">Ages 10–13</button>
          <button type="submit" name="age_band" value="14+" class="btn">Ages 14+</button>
          <a class="btn" href="/dashboard/maker-lab">Cancel</a>
        </div>
      </form>
    </div>
  ` : `
    <a class="guest-btn" href="/dashboard/maker-lab?guest=pick">Try it without saving →</a>
  `;

  const createForm = `
    <details class="panel">
      <summary>+ Add learner</summary>
      <form method="POST" action="/dashboard/maker-lab" class="create-form">
        <input type="hidden" name="action" value="create_learner">
        <label>Name <input name="name" required maxlength="100"></label>
        <label>Age <input name="age" type="number" min="3" max="100" required></label>
        <label>Avatar <input name="avatar" placeholder="mao_pro" maxlength="50"></label>
        <label class="consent">
          <input type="checkbox" name="consent" value="1">
          I am the parent/guardian of this child, or I am the child's teacher operating under the school's consent process. (COPPA / GDPR-K)
        </label>
        <button type="submit" class="btn primary">Create learner</button>
      </form>
    </details>
  `;

  const renderLearnerCard = (l) => {
    const active = activeByLearner.get(l.id);
    const isPending = pendingDelete === l.id;
    return `
      <div class="learner-card ${active ? 'active' : ''}">
        ${mode === 'classroom' ? `<label class="pick"><input type="checkbox" name="learner_ids" value="${l.id}" form="bulkStartForm"> Pick</label>` : ''}
        <div class="meta">
          <strong>${escapeHtml(l.name)}</strong>
          <span class="age">age ${l.age ?? '—'}</span>
          <span class="persona">${escapeHtml(l.persona)}</span>
          ${l.transcripts_enabled ? '<span class="chip">transcripts on</span>' : ''}
          ${active ? `<span class="chip live">live session</span>` : ''}
        </div>
        <div class="actions">
          ${active ? `
            <form method="POST" action="/dashboard/maker-lab" style="display:inline">
              <input type="hidden" name="action" value="end_session">
              <input type="hidden" name="session_token" value="${escapeHtml(active.token)}">
              <button type="submit" class="btn">End</button>
            </form>
            ${active.redemption_code ? `<a class="btn" href="/dashboard/maker-lab?qr=${escapeHtml(active.redemption_code)}">QR</a>` : ''}
          ` : `
            <form method="POST" action="/dashboard/maker-lab" style="display:inline;display:flex;gap:0.25rem;align-items:center">
              <input type="hidden" name="action" value="start_session">
              <input type="hidden" name="learner_id" value="${l.id}">
              <input type="number" name="duration_min" value="60" min="5" max="240" style="width:4rem;padding:0.2rem;background:var(--input,rgba(0,0,0,0.3));color:inherit;border:1px solid var(--border,#333);border-radius:4px" title="minutes">
              <button type="submit" class="btn primary">Start session</button>
            </form>
          `}
          <a class="btn small" href="/dashboard/maker-lab?edit=${l.id}">Settings</a>
          ${l.transcripts_enabled ? `<a class="btn small" href="/dashboard/maker-lab?transcripts=${l.id}">Transcripts</a>` : ''}
          ${isPending ? `
            <form method="POST" action="/dashboard/maker-lab" style="display:inline">
              <input type="hidden" name="action" value="delete_learner">
              <input type="hidden" name="learner_id" value="${l.id}">
              <input type="hidden" name="confirm" value="DELETE">
              <button type="submit" class="btn danger">Confirm delete</button>
            </form>
            <a class="btn" href="/dashboard/maker-lab">Cancel</a>
          ` : `
            <form method="POST" action="/dashboard/maker-lab" style="display:inline">
              <input type="hidden" name="action" value="delete_learner">
              <input type="hidden" name="learner_id" value="${l.id}">
              <button type="submit" class="btn danger-outline">Delete</button>
            </form>
          `}
        </div>
      </div>
    `;
  };

  const learnersHtml = mode === "classroom"
    ? `<div class="classroom-grid">${learners.map(renderLearnerCard).join("")}</div>`
    : `<div class="family-list">${learners.map(renderLearnerCard).join("")}</div>`;

  const bulkForm = mode === "classroom" ? `
    <form id="bulkStartForm" method="POST" action="/dashboard/maker-lab" class="bulk-form">
      <input type="hidden" name="action" value="bulk_start">
      <strong>Start a batch for selected learners:</strong>
      <input name="batch_label" placeholder="Period 3 — Monday" maxlength="200">
      <label>Min <input name="duration_min" type="number" value="60" min="5" max="240" style="width:4rem"></label>
      <button type="submit" class="btn primary">Bulk Start</button>
    </form>
  ` : '';

  const activeList = allActive.length ? `
    <details class="panel" open>
      <summary>Active sessions (${allActive.length})</summary>
      <ul class="session-list">
        ${allActive.map((s) => `
          <li>
            <span><strong>${escapeHtml(s.learner_name || (s.is_guest ? `Guest (${s.guest_age_band})` : '?'))}</strong></span>
            <span class="chip state-${s.state}">${s.state}</span>
            <span class="meta">${s.hints_used || 0} hints · expires ${escapeHtml(s.expires_at)}</span>
            <span class="actions">
              <form method="POST" action="/dashboard/maker-lab" style="display:inline">
                <input type="hidden" name="action" value="end_session">
                <input type="hidden" name="session_token" value="${escapeHtml(s.token)}">
                <button type="submit" class="btn small">End</button>
              </form>
              ${s.idle_locked_at ? `
                <form method="POST" action="/dashboard/maker-lab" style="display:inline">
                  <input type="hidden" name="action" value="unlock_idle">
                  <input type="hidden" name="session_token" value="${escapeHtml(s.token)}">
                  <button type="submit" class="btn small">Unlock</button>
                </form>
              ` : ''}
              <form method="POST" action="/dashboard/maker-lab" style="display:inline">
                <input type="hidden" name="action" value="force_end">
                <input type="hidden" name="session_token" value="${escapeHtml(s.token)}">
                <input type="hidden" name="reason" value="admin_force">
                <button type="submit" class="btn small danger-outline">Force end</button>
              </form>
              ${s.batch_id ? `<a class="btn small" href="/dashboard/maker-lab?batch=${escapeHtml(s.batch_id)}">Batch</a>` : ''}
            </span>
          </li>
        `).join("")}
      </ul>
    </details>
  ` : '';

  const batchList = batches.length ? `
    <details class="panel">
      <summary>Recent batches (${batches.length})</summary>
      <ul class="session-list">
        ${batches.map((b) => `
          <li>
            <span><strong>${escapeHtml(b.label || b.batch_id.slice(0, 8))}</strong></span>
            <span class="meta">${escapeHtml(b.created_at)}${b.revoked_at ? ` · revoked ${escapeHtml(b.revoked_at)}` : ''}</span>
            <span class="actions"><a class="btn small" href="/dashboard/maker-lab?batch=${escapeHtml(b.batch_id)}">Open</a></span>
          </li>
        `).join("")}
      </ul>
    </details>
  ` : '';

  const modeHeadline = ({
    solo: "Solo mode — one learner, auto-start.",
    family: "Family mode — per-learner Start session.",
    classroom: "Classroom mode — multi-select learners, then Bulk Start for a printable QR sheet.",
  })[mode];

  const siblingsCard = renderSiblingSurfacesCard({ installedBundleIds, maxLearnerAge, escapeHtml });

  return `
    <div class="maker-lab">
      ${css()}
      ${errBanner}
      <div class="top-actions">
        <a class="btn small" href="/dashboard/maker-lab?settings=1">⚙ Settings</a>
        <a class="btn small" href="/dashboard/maker-lab?lessons=1">📚 Lessons</a>
      </div>
      <div class="mode-tabs">${modeTabs}${guestSection.includes('guest-btn') ? guestSection : ''}</div>
      ${guestSection.includes('guest-btn') ? '' : guestSection}
      <div class="headline">${modeHeadline}</div>
      ${createForm}
      ${bulkForm}
      ${learnersHtml || '<div class="panel">No learners yet. Add one above to get started.</div>'}
      ${activeList}
      ${batchList}
      ${siblingsCard}
    </div>
  `;
}

function css() {
  return `<style>
    .maker-lab { padding: 1rem; max-width: 1200px; margin: 0 auto; }
    .mode-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; align-items: center; }
    .mode-tab { padding: 0.4rem 1rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; cursor: pointer; border-radius: 4px; text-transform: capitalize; }
    .mode-tab.active { background: var(--accent, #84cc16); color: #000; font-weight: 600; }
    .headline { color: var(--muted, #888); font-size: 0.9em; margin-bottom: 1rem; }
    .panel { background: var(--card, rgba(255,255,255,0.03)); padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .panel summary { cursor: pointer; font-weight: 600; }
    .sibling-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; margin-top: 0.75rem; }
    .sibling-tile { padding: 0.75rem; background: rgba(255,255,255,0.04); border: 1px solid var(--border, #333); border-radius: 6px; display: flex; flex-direction: column; gap: 0.4rem; }
    .sibling-head { display: flex; align-items: baseline; gap: 0.4rem; }
    .sibling-body { color: var(--muted, #888); font-size: 0.88em; flex: 1; }
    .sibling-actions { display: flex; gap: 0.5rem; }
    .create-form { display: grid; gap: 0.5rem; margin-top: 0.75rem; max-width: 400px; }
    .create-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9em; }
    .create-form label.consent { flex-direction: row; gap: 0.5rem; align-items: flex-start; font-weight: normal; }
    .create-form input { padding: 0.4rem; background: var(--input, rgba(0,0,0,0.3)); color: inherit; border: 1px solid var(--border, #333); border-radius: 4px; }
    .bulk-form { display: flex; gap: 0.5rem; align-items: center; padding: 0.75rem 1rem; background: rgba(132,204,22,0.08); border: 1px solid rgba(132,204,22,0.3); border-radius: 6px; margin-bottom: 1rem; flex-wrap: wrap; }
    .bulk-form input { padding: 0.3rem; background: var(--input, rgba(0,0,0,0.3)); color: inherit; border: 1px solid var(--border, #333); border-radius: 4px; }
    .family-list { display: grid; gap: 0.5rem; }
    .classroom-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }
    .learner-card { border: 1px solid var(--border, #333); padding: 0.75rem; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .learner-card.active { border-color: var(--accent, #84cc16); }
    .classroom-grid .learner-card { flex-direction: column; align-items: stretch; }
    .pick { font-size: 0.85em; color: var(--muted, #888); }
    .meta { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
    .age, .persona { color: var(--muted, #888); font-size: 0.85em; }
    .chip { padding: 0.1rem 0.5rem; background: rgba(132,204,22,0.15); color: #84cc16; border-radius: 10px; font-size: 0.75em; }
    .chip.live { background: rgba(239,68,68,0.15); color: #ef4444; }
    .chip.state-ending { background: rgba(251,191,36,0.2); color: #fbbf24; }
    .chip.state-revoked { background: rgba(148,163,184,0.2); color: #94a3b8; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .btn { padding: 0.3rem 0.8rem; text-decoration: none; border: 1px solid var(--border, #333); color: inherit; border-radius: 4px; font-size: 0.85em; background: transparent; cursor: pointer; display: inline-flex; align-items: center; gap: 0.25rem; }
    .btn.small { padding: 0.2rem 0.6rem; font-size: 0.8em; }
    .btn.primary { background: var(--accent, #84cc16); color: #000; border-color: var(--accent, #84cc16); }
    .btn.danger { background: #ef4444; color: #fff; border-color: #ef4444; }
    .btn.danger-outline { color: #ef4444; border-color: #ef4444; }
    .guest-btn { display: inline-block; padding: 0.3rem 0.8rem; border: 1px dashed var(--muted, #888); border-radius: 4px; color: inherit; text-decoration: none; font-size: 0.9em; margin-left: 0.5rem; }
    .banner { padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
    .banner.error { background: rgba(239,68,68,0.15); color: #ef4444; }
    .session-list { list-style: none; padding: 0; margin: 0.75rem 0 0 0; display: grid; gap: 0.35rem; }
    .session-list li { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; padding: 0.4rem 0.6rem; background: rgba(0,0,0,0.05); border-radius: 4px; }
    .session-list li .meta { color: var(--muted, #888); font-size: 0.8em; margin-left: auto; }
    .top-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-bottom: 0.5rem; }
    .btn.small { padding: 0.2rem 0.6rem; font-size: 0.8em; }
  </style>`;
}

// ─── Render: per-learner edit view ────────────────────────────────────────

function renderEditView({ learner, saved, errKey, escapeHtml }) {
  const persona = learner.age == null ? "kid-tutor"
    : learner.age <= 9 ? "kid-tutor"
    : learner.age <= 13 ? "tween-tutor"
    : "adult-tutor";
  const errMsg = errKey === "create_invalid" ? "Name is required and age must be 3-100." : "";
  const savedBanner = saved ? `<div class="banner success">Settings saved.</div>` : "";
  const errBanner = errMsg ? `<div class="banner error">${escapeHtml(errMsg)}</div>` : "";
  return `
    <style>
      .edit-page { padding: 1.5rem; max-width: 640px; margin: 0 auto; }
      .edit-page h2 { margin-top: 0; }
      .field { display: grid; gap: 0.25rem; margin-bottom: 1rem; }
      .field > label { font-weight: 600; font-size: 0.9em; }
      .field .help { color: var(--muted, #888); font-size: 0.8em; }
      .field input[type="text"], .field input[type="number"], .field input[type="email"] { padding: 0.45rem; background: var(--input, rgba(0,0,0,0.3)); color: inherit; border: 1px solid var(--border, #333); border-radius: 4px; max-width: 300px; }
      .field.checkbox { flex-direction: row; align-items: center; gap: 0.5rem; }
      .field.checkbox label { font-weight: normal; display: flex; gap: 0.5rem; align-items: center; }
      .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: baseline; }
      .consent-note { padding: 0.5rem 0.8rem; background: rgba(59,130,246,0.08); border-left: 3px solid #3b82f6; border-radius: 4px; font-size: 0.85em; margin-bottom: 1rem; }
      .btn { padding: 0.45rem 1rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; border-radius: 4px; cursor: pointer; font-size: 0.95em; text-decoration: none; display: inline-flex; align-items: center; gap: 0.25rem; }
      .btn.primary { background: var(--accent, #84cc16); color: #000; border-color: var(--accent, #84cc16); font-weight: 600; }
      .banner { padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
      .banner.success { background: rgba(34,197,94,0.15); color: #22c55e; }
      .banner.error { background: rgba(239,68,68,0.15); color: #ef4444; }
      .persona-chip { padding: 0.15rem 0.6rem; background: rgba(132,204,22,0.15); color: #84cc16; border-radius: 999px; font-size: 0.85em; }
    </style>
    <div class="edit-page">
      <div class="row">
        <a class="btn" href="/dashboard/maker-lab">← Back</a>
        <h2 style="margin:0">Settings — ${escapeHtml(learner.name)}</h2>
        <span class="persona-chip">${persona}</span>
      </div>
      ${savedBanner}${errBanner}
      <div class="consent-note">
        Consent captured ${learner.consent_captured_at ? `on ${escapeHtml(learner.consent_captured_at)}` : "— not yet recorded"}.
        ${learner.consent_captured_at ? "" : `<strong>No consent record found.</strong> Delete and recreate the profile to capture consent.`}
      </div>
      <form method="POST" action="/dashboard/maker-lab">
        <input type="hidden" name="action" value="update_learner">
        <input type="hidden" name="learner_id" value="${learner.id}">

        <div class="field">
          <label>Name</label>
          <input type="text" name="name" required maxlength="100" value="${escapeHtml(learner.name)}">
        </div>
        <div class="field">
          <label>Age</label>
          <input type="number" name="age" required min="3" max="100" value="${learner.age ?? ""}">
          <div class="help">Drives persona: ≤9 = kid-tutor, 10-13 = tween-tutor, 14+ = adult-tutor.</div>
        </div>
        <div class="field">
          <label>Avatar</label>
          <input type="text" name="avatar" maxlength="50" placeholder="mao_pro" value="${escapeHtml(learner.avatar || "")}">
          <div class="help">Live2D model id used by the companion.</div>
        </div>

        <h3 style="margin-top:1.5rem">Privacy</h3>
        <div class="field checkbox">
          <label>
            <input type="checkbox" name="transcripts_enabled" value="1" ${learner.transcripts_enabled ? "checked" : ""}>
            Record conversation transcripts for this learner
          </label>
          <div class="help">Off by default. When on, each kid-tutor turn is stored for review. Flag is read at session start and frozen for the session's lifetime — changes take effect next session.</div>
        </div>
        <div class="field">
          <label>Transcript retention (days)</label>
          <input type="number" name="transcripts_retention_days" min="0" max="3650" value="${learner.transcripts_retention_days ?? 30}">
          <div class="help">0 = purge on session end.</div>
        </div>

        <h3 style="margin-top:1.5rem">Session behavior</h3>
        <div class="field">
          <label>Idle lock (minutes, blank = off)</label>
          <input type="number" name="idle_lock_default_min" min="0" max="240" value="${learner.idle_lock_default_min ?? ""}">
          <div class="help">Lock the kiosk after this many minutes with no tutor/lesson activity. The session token stays valid.</div>
        </div>
        <div class="field">
          <label>Auto-resume after lock (minutes)</label>
          <input type="number" name="auto_resume_min" min="0" max="240" value="${learner.auto_resume_min ?? 15}">
          <div class="help">0 = never auto-resume (admin must manually unlock).</div>
        </div>
        <div class="field checkbox">
          <label>
            <input type="checkbox" name="voice_input_enabled" value="1" ${learner.voice_input_enabled ? "checked" : ""}>
            Enable voice input (mic) for this learner
          </label>
          <div class="help"><strong>Caution:</strong> voice input is NOT filtered by the hint output guard. Appropriate for older kids only.</div>
        </div>

        <div class="row" style="margin-top:1.5rem">
          <button type="submit" class="btn primary">Save settings</button>
          <a class="btn" href="/dashboard/maker-lab">Cancel</a>
        </div>
      </form>
    </div>
  `;
}

// ─── Render: transcripts view ─────────────────────────────────────────────

function renderTranscriptsView({ learner, settings, transcripts, escapeHtml }) {
  const retention = settings.transcripts_retention_days ?? 30;
  const enabled = !!settings.transcripts_enabled;

  // Group by session_token
  const sessions = new Map();
  for (const t of transcripts) {
    if (!sessions.has(t.session_token)) sessions.set(t.session_token, []);
    sessions.get(t.session_token).push(t);
  }

  // Reverse within each session so turns are in chronological order
  for (const [k, arr] of sessions) {
    arr.sort((a, b) => a.turn_no - b.turn_no);
  }

  const sessionBlocks = [...sessions.entries()].map(([token, turns]) => {
    const first = turns[0];
    const last = turns[turns.length - 1];
    return `
      <details class="session-block">
        <summary>
          <span>Session ${escapeHtml(token.slice(0, 8))}…</span>
          <span class="meta">${escapeHtml(first.created_at)} — ${escapeHtml(last.created_at)} · ${turns.length} turns</span>
        </summary>
        <div class="turns">
          ${turns.map((t) => `
            <div class="turn role-${t.role}">
              <span class="role-chip">${t.role}</span>
              <div class="content">${escapeHtml(t.content)}</div>
              <span class="turn-meta">#${t.turn_no} · ${escapeHtml(t.created_at)}</span>
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }).join("");

  return `
    <style>
      .transcripts-page { padding: 1.5rem; max-width: 900px; margin: 0 auto; }
      .transcripts-page h2 { margin-top: 0; }
      .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: baseline; margin-bottom: 1rem; }
      .chip { padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.8em; }
      .chip.on { background: rgba(34,197,94,0.15); color: #22c55e; }
      .chip.off { background: rgba(161,161,170,0.2); color: #a1a1aa; }
      .banner { padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
      .banner.info { background: rgba(59,130,246,0.1); color: #60a5fa; }
      .session-block { margin-bottom: 0.75rem; padding: 0.75rem 1rem; background: var(--card, rgba(255,255,255,0.03)); border: 1px solid var(--border, #333); border-radius: 6px; }
      .session-block summary { cursor: pointer; display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
      .session-block .meta { color: var(--muted, #888); font-size: 0.85em; }
      .turns { margin-top: 0.75rem; display: grid; gap: 0.5rem; }
      .turn { padding: 0.6rem 0.8rem; border-radius: 6px; background: rgba(0,0,0,0.08); display: grid; grid-template-columns: 4rem 1fr auto; gap: 0.5rem; align-items: start; }
      .turn.role-kid { background: rgba(59,130,246,0.08); }
      .turn.role-tutor { background: rgba(132,204,22,0.08); }
      .role-chip { font-weight: 600; text-transform: uppercase; font-size: 0.75em; color: var(--muted, #888); }
      .turn .content { white-space: pre-wrap; }
      .turn-meta { color: var(--muted, #888); font-size: 0.75em; white-space: nowrap; }
      .btn { padding: 0.35rem 0.9rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; border-radius: 4px; text-decoration: none; font-size: 0.9em; }
    </style>
    <div class="transcripts-page">
      <div class="row">
        <a class="btn" href="/dashboard/maker-lab">← Back</a>
        <h2 style="margin:0">Transcripts — ${escapeHtml(learner.name)}</h2>
        <span class="chip ${enabled ? 'on' : 'off'}">${enabled ? 'recording on' : 'recording off'}</span>
        <a class="btn" href="/dashboard/maker-lab?edit=${learner.id}">Settings</a>
      </div>
      <div class="banner info">
        Retention: <strong>${retention === 0 ? "purge on session end" : `${retention} days`}</strong>.
        ${transcripts.length ? `Showing up to 500 most recent turns across ${sessions.size} session(s).` : `No transcripts yet.`}
      </div>
      ${sessionBlocks || '<p>(nothing to show)</p>'}
    </div>
  `;
}

// ─── Render: Settings view ────────────────────────────────────────────────

function renderSettingsView({ mode, lanExposure, devices, saved, unbound, escapeHtml }) {
  const banner = saved ? `<div class="banner success">Saved.</div>`
    : unbound ? `<div class="banner success">Device unbound.</div>`
    : "";

  const soloSection = mode === "solo" ? `
    <div class="settings-section">
      <h3>Solo mode — LAN exposure</h3>
      <p class="help">
        By default the solo kiosk is loopback-only — only browsers on the Crow host itself can use it.
        Turning this on lets you open <code>/kiosk/</code> from any device on your LAN, but every new
        device must first be "bound" by signing in to Crow's Nest on it.
      </p>
      <form method="POST" action="/dashboard/maker-lab">
        <input type="hidden" name="action" value="set_solo_lan_exposure">
        <label class="toggle">
          <input type="checkbox" name="value" value="on" ${lanExposure === "on" ? "checked" : ""}
                 onchange="this.form.submit()">
          <span>${lanExposure === "on" ? "LAN exposure: on" : "LAN exposure: off (loopback only)"}</span>
        </label>
      </form>
    </div>
  ` : `
    <div class="settings-section">
      <h3>Solo mode settings</h3>
      <p class="help">Switch to Solo mode from the main page to configure LAN exposure and bound devices.</p>
    </div>
  `;

  const devicesSection = `
    <div class="settings-section">
      <h3>Bound devices (${devices.length})</h3>
      <p class="help">
        Devices that have been bound as solo kiosks. Unbinding forces a device to re-authenticate on next use.
      </p>
      ${devices.length ? `
        <table class="device-table">
          <thead><tr><th>Fingerprint</th><th>Learner</th><th>Bound</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            ${devices.map((d) => `
              <tr>
                <td><code>${escapeHtml(d.fingerprint.slice(0, 12))}…</code></td>
                <td>${escapeHtml(d.learner_name || "(deleted)")}</td>
                <td>${escapeHtml(d.bound_at)}</td>
                <td>${escapeHtml(d.last_seen_at || "—")}</td>
                <td>
                  <form method="POST" action="/dashboard/maker-lab" style="display:inline">
                    <input type="hidden" name="action" value="unbind_device">
                    <input type="hidden" name="fingerprint" value="${escapeHtml(d.fingerprint)}">
                    <button type="submit" class="btn small danger-outline">Unbind</button>
                  </form>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<p>(no bound devices)</p>`}
    </div>
  `;

  return `
    <style>
      .settings-page { padding: 1.5rem; max-width: 800px; margin: 0 auto; }
      .settings-page h2 { margin-top: 0; }
      .row { display: flex; gap: 0.5rem; align-items: baseline; margin-bottom: 1rem; }
      .btn { padding: 0.35rem 0.9rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; border-radius: 4px; text-decoration: none; font-size: 0.9em; cursor: pointer; }
      .btn.small { padding: 0.2rem 0.6rem; font-size: 0.8em; }
      .btn.danger-outline { color: #ef4444; border-color: #ef4444; }
      .settings-section { padding: 1rem 1.25rem; background: var(--card, rgba(255,255,255,0.03)); border: 1px solid var(--border, #333); border-radius: 6px; margin-bottom: 1rem; }
      .settings-section h3 { margin: 0 0 0.5rem 0; }
      .settings-section .help { color: var(--muted, #888); font-size: 0.9em; margin-bottom: 0.75rem; }
      .toggle { display: flex; gap: 0.5rem; align-items: center; cursor: pointer; }
      .device-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
      .device-table th, .device-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border, #333); text-align: left; }
      .banner { padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
      .banner.success { background: rgba(34,197,94,0.15); color: #22c55e; }
    </style>
    <div class="settings-page">
      <div class="row">
        <a class="btn" href="/dashboard/maker-lab">← Back</a>
        <h2 style="margin:0">Settings</h2>
        <span style="color:var(--muted,#888);font-size:0.9em">mode: <strong>${escapeHtml(mode)}</strong></span>
      </div>
      ${banner}
      ${soloSection}
      ${devicesSection}
      <div class="settings-section">
        <h3>Data handling</h3>
        <p class="help">See <code>bundles/maker-lab/DATA-HANDLING.md</code> for what data Maker Lab stores, how long, and the COPPA / GDPR-K posture.</p>
      </div>
    </div>
  `;
}

// ─── Render: Lessons view ─────────────────────────────────────────────────

function renderLessonsView({ bundled, custom, imported, deleted, escapeHtml }) {
  const banner = imported
    ? `<div class="banner success">Imported lesson <code>${escapeHtml(imported)}</code>.</div>`
    : deleted
    ? `<div class="banner success">Deleted custom lesson <code>${escapeHtml(deleted)}</code>.</div>`
    : "";

  const renderItem = (item, isCustom) => {
    if (item.error) {
      return `<li class="lesson-item error"><code>${escapeHtml(item.file)}</code>: ${escapeHtml(item.error)}</li>`;
    }
    const l = item.lesson;
    return `
      <li class="lesson-item">
        <div class="lesson-meta">
          <strong>${escapeHtml(l.title || l.id)}</strong>
          <span class="chip">${escapeHtml(l.age_band || "?")}</span>
          <span class="chip">${escapeHtml(l.surface || "?")}</span>
          ${l.reading_level != null ? `<span class="chip">grade ${escapeHtml(String(l.reading_level))}</span>` : ""}
        </div>
        <div class="lesson-id"><code>${escapeHtml(l.id)}</code></div>
        ${isCustom ? `
          <form method="POST" action="/dashboard/maker-lab" style="display:inline">
            <input type="hidden" name="action" value="delete_custom_lesson">
            <input type="hidden" name="lesson_id" value="${escapeHtml(l.id)}">
            <button type="submit" class="btn small danger-outline" onclick="return confirm('Delete ${escapeHtml(l.id)}?')">Delete</button>
          </form>
        ` : `<span class="chip bundled">bundled</span>`}
      </li>
    `;
  };

  const bundledHtml = bundled
    .filter((b) => b.items.length > 0)
    .map((b) => `
      <h3>Age band ${escapeHtml(b.band)} (${b.items.length})</h3>
      <ul class="lessons">${b.items.map((x) => renderItem(x, false)).join("")}</ul>
    `).join("");

  const customHtml = `
    <h3>Custom lessons (${custom.length})</h3>
    ${custom.length
      ? `<ul class="lessons">${custom.map((x) => renderItem(x, true)).join("")}</ul>`
      : `<p class="help">No custom lessons yet. Use the form below to add one.</p>`}
  `;

  const importForm = `
    <div class="import-section">
      <h3>Import a lesson</h3>
      <p class="help">
        Paste a lesson JSON below. It will be validated against <code>bundles/maker-lab/curriculum/SCHEMA.md</code>.
        Valid lessons land in <code>~/.crow/bundles/maker-lab/curriculum/custom/&lt;id&gt;.json</code> and appear immediately — no restart.
      </p>
      <form method="POST" action="/dashboard/maker-lab">
        <input type="hidden" name="action" value="import_lesson">
        <textarea name="lesson_json" rows="14" required placeholder='{
  "id": "my-lesson",
  "title": "A New Lesson",
  "surface": "blockly",
  "age_band": "5-9",
  "reading_level": 2,
  "steps": [{ "prompt": "Drag a block." }],
  "canned_hints": ["Try the first block in the toolbox!"]
}'></textarea>
        <div class="row">
          <button type="submit" class="btn primary">Validate &amp; save</button>
          <a class="btn" href="/dashboard/maker-lab?lessons=1">Cancel</a>
        </div>
      </form>
    </div>
  `;

  return `
    <style>
      .lessons-page { padding: 1.5rem; max-width: 900px; margin: 0 auto; }
      .lessons-page h2 { margin-top: 0; }
      .row { display: flex; gap: 0.5rem; align-items: baseline; margin-bottom: 1rem; }
      .btn { padding: 0.35rem 0.9rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; border-radius: 4px; text-decoration: none; font-size: 0.9em; cursor: pointer; }
      .btn.small { padding: 0.2rem 0.6rem; font-size: 0.8em; }
      .btn.primary { background: var(--accent, #84cc16); color: #000; border-color: var(--accent, #84cc16); font-weight: 600; }
      .btn.danger-outline { color: #ef4444; border-color: #ef4444; }
      .banner { padding: 0.6rem 0.9rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
      .banner.success { background: rgba(34,197,94,0.15); color: #22c55e; }
      .banner.error { background: rgba(239,68,68,0.15); color: #ef4444; }
      .lessons { list-style: none; padding: 0; margin: 0.5rem 0 1.5rem 0; display: grid; gap: 0.5rem; }
      .lesson-item { padding: 0.7rem 1rem; background: var(--card, rgba(255,255,255,0.03)); border: 1px solid var(--border, #333); border-radius: 6px; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: space-between; }
      .lesson-item.error { border-color: #ef4444; }
      .lesson-meta { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
      .lesson-id { color: var(--muted, #888); font-size: 0.85em; }
      .chip { padding: 0.1rem 0.5rem; background: rgba(132,204,22,0.15); color: #84cc16; border-radius: 10px; font-size: 0.75em; }
      .chip.bundled { background: rgba(148,163,184,0.2); color: #94a3b8; }
      .help { color: var(--muted, #888); font-size: 0.9em; }
      textarea { width: 100%; padding: 0.6rem; background: var(--input, rgba(0,0,0,0.3)); color: inherit; border: 1px solid var(--border, #333); border-radius: 4px; font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; margin-bottom: 0.5rem; box-sizing: border-box; }
      .import-section { padding: 1rem 1.25rem; background: var(--card, rgba(255,255,255,0.03)); border: 1px solid var(--border, #333); border-radius: 6px; margin-bottom: 1rem; }
    </style>
    <div class="lessons-page">
      <div class="row">
        <a class="btn" href="/dashboard/maker-lab">← Back</a>
        <h2 style="margin:0">Lessons</h2>
      </div>
      ${banner}
      ${bundledHtml}
      ${customHtml}
      ${importForm}
    </div>
  `;
}

function renderLessonImportResult({ errors, raw, escapeHtml }) {
  return `
    <style>
      .import-err { padding: 1.5rem; max-width: 800px; margin: 0 auto; }
      .import-err .banner { padding: 0.8rem 1rem; border-radius: 4px; margin-bottom: 1rem; background: rgba(239,68,68,0.15); color: #ef4444; }
      .import-err ul { padding-left: 1.25rem; }
      .import-err pre { background: var(--input, rgba(0,0,0,0.3)); padding: 0.8rem; border-radius: 4px; overflow: auto; max-height: 40vh; font-size: 0.85em; }
      .btn { padding: 0.35rem 0.9rem; border: 1px solid var(--border, #333); background: transparent; color: inherit; border-radius: 4px; text-decoration: none; font-size: 0.9em; }
    </style>
    <div class="import-err">
      <div class="banner">
        <strong>Validation failed.</strong> Fix these and re-submit.
        <ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
      </div>
      <h3>Your input</h3>
      <pre>${escapeHtml(raw)}</pre>
      <a class="btn" href="/dashboard/maker-lab?lessons=1">← Back</a>
    </div>
  `;
}
