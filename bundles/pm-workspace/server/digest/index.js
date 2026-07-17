/**
 * PM Workspace — digest orchestrator.
 *
 * runDigest(): run all adapters, render, insert a pm_digests row for
 * today (local date), email via SMTP when configured, and optionally
 * push a short summary to ntfy.
 *
 * preview(): same assembly/rendering with NO side effects (no DB row,
 * no email, no ntfy).
 */

import { boardsSections } from "./adapters/boards.js";
import { googleSections } from "./adapters/google.js";
import { mondayLocalSection } from "./adapters/monday-local.js";
import { boxSection } from "./adapters/box.js";
import { outlookSections } from "./adapters/outlook.js";
import { renderDigest } from "./render.js";
import { send as sendMail, smtpConfigured } from "../mailer.js";

const NTFY_TIMEOUT_MS = 10_000;

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Assemble sections from every adapter. Adapters degrade internally. */
export async function assembleDigest(db, config) {
  const sections = [];
  const push = (result) => {
    if (Array.isArray(result)) sections.push(...result);
    else if (result) sections.push(result);
  };

  // Each adapter is individually guarded; a hard throw in one must not
  // take down the whole digest.
  const guarded = async (fn, title) => {
    try {
      return await fn();
    } catch (err) {
      return { title, available: false, reason: `adapter error: ${err.message}` };
    }
  };

  push(await guarded(() => boardsSections(db, config), "Boards"));
  push(await guarded(() => mondayLocalSection(db), "Monday sync"));
  push(await guarded(() => googleSections(config), "Google"));
  push(await guarded(() => boxSection(config), "Box"));
  push(await guarded(() => outlookSections(config), "Outlook"));

  return { date: localDate(), sections };
}

/** Render-only preview — no DB writes, no sends. */
export async function preview(db, config) {
  const digest = await assembleDigest(db, config);
  const rendered = renderDigest(digest, config);
  return { date: digest.date, sections: digest.sections, ...rendered };
}

async function notifyNtfy(config, summary, date) {
  if (!config.NTFY_TOPIC) return { sent: false, reason: "NTFY_TOPIC unset" };
  try {
    const base = (config.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const res = await fetch(`${base}/${config.NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: `PM Digest ${date}` },
      body: summary,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    return { sent: res.ok, reason: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/**
 * Run the digest for today: assemble, render, persist, send.
 * @param {object} opts { force }: force re-run even if today's row exists
 */
export async function runDigest(db, config, { force = false } = {}) {
  const date = localDate();

  const existing = await db.execute({
    sql: "SELECT id, sent_at FROM pm_digests WHERE digest_date = ?",
    args: [date],
  });
  if (existing.rows.length > 0 && !force) {
    return { ok: true, skipped: true, reason: `digest for ${date} already exists (id ${existing.rows[0].id})` };
  }

  const digest = await assembleDigest(db, config);
  const rendered = renderDigest(digest, config);
  const sourcesJson = JSON.stringify(
    digest.sections.map((s) => ({ title: s.title, available: s.available, reason: s.reason || null }))
  );

  let sentAt = null;
  let sentVia = null;
  let sendError = null;

  if (smtpConfigured(config)) {
    try {
      await sendMail(
        { subject: `PM Workspace Digest — ${date}`, html: rendered.html, text: rendered.text },
        config
      );
      sentAt = new Date().toISOString();
      sentVia = "smtp";
    } catch (err) {
      sendError = err.message;
      console.warn(`[pm-workspace digest] email send failed: ${err.message}`);
    }
  }

  const ntfy = await notifyNtfy(config, rendered.summary, date);
  if (ntfy.sent) sentVia = sentVia ? `${sentVia}+ntfy` : "ntfy";

  if (existing.rows.length > 0) {
    await db.execute({
      sql: `UPDATE pm_digests SET html = ?, summary = ?, sources_json = ?, sent_at = ?, sent_via = ? WHERE digest_date = ?`,
      args: [rendered.html, rendered.summary, sourcesJson, sentAt, sentVia, date],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO pm_digests (digest_date, html, summary, sources_json, sent_at, sent_via)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [date, rendered.html, rendered.summary, sourcesJson, sentAt, sentVia],
    });
  }

  return {
    ok: true,
    date,
    summary: rendered.summary,
    emailed: sentVia?.includes("smtp") || false,
    ntfy: ntfy.sent,
    send_error: sendError,
  };
}
