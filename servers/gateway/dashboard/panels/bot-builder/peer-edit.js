/**
 * Bot Builder Panel — Peer Edit (F4a trusted-peer remote-edit branch)
 *
 * Byte-pure move of the ?peer= branch from the monolithic bot-builder.js.
 * No i18n in this module (spec rule 5 — federation boundary code, frozen EN).
 * Must be called BEFORE the notAvail gate in the orchestrator (it runs even
 * when pi_bot_defs is missing on this instance).
 */

import { escapeHtml, section } from "../../shared/components.js";
import { loadModelOptions, lines } from "./data-queries.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { fetchPeerBotDef, patchPeerBot } from "../../../bot-federation-client.js";

/**
 * Handle the ?peer= branch — remote edit of a trusted peer's bot.
 * Returns true (and sends the response) if it handled the request.
 * Returns false when ?peer= is absent so the orchestrator falls through.
 */
export async function handlePeerEdit(req, res, { db, layout }) {
  const q = req.query || {};
  const peerId = q.peer;
  if (!peerId) return false;

  const b = req.body || {};
  const botId = q.bot;

  // POST: apply a field-scoped patch to the peer
  if (req.method === "POST" && b.peer) {
    const patch = {};
    if (typeof b.display_name === "string") patch["display_name"] = b.display_name;
    if (typeof b.system_prompt === "string") patch["system_prompt"] = b.system_prompt;
    if (typeof b.model === "string" && b.model) patch["models.default"] = b.model;
    if (typeof b.skills === "string") patch["tools.skills"] = lines(b.skills);
    const r = await patchPeerBot({ db, sourceInstanceId: getOrCreateLocalInstanceId(), instanceId: peerId, botId, patch, actor: "dashboard" });
    const msg = r.ok ? "saved" : ((r.body && r.body.error) || r.error || "failed");
    res.redirectAfterPost(`/dashboard/bot-builder?peer=${encodeURIComponent(peerId)}&bot=${encodeURIComponent(botId)}&status=${encodeURIComponent(msg)}`);
    return true;
  }

  // GET: load the redacted def and render the bounded editor
  const r = await fetchPeerBotDef({ db, sourceInstanceId: getOrCreateLocalInstanceId(), instanceId: peerId, botId, actor: "dashboard" });
  if (!r.ok) {
    res.send(layout({ title: "Edit peer bot", content: section("Edit peer bot",
      `<p>Could not reach the owner instance (${escapeHtml(String(r.error || "offline"))}). Try again later.</p>
       <p><a href="/dashboard/bot-board">&larr; Back to Bot Board</a></p>`) }));
    return true;
  }
  const def = (r.body && r.body.definition) || {};
  const models = await loadModelOptions(db);
  const status = q.status ? `<div style="color:var(--crow-text-muted);margin-bottom:1rem">Status: ${escapeHtml(String(q.status))}</div>` : "";
  // disabled "•••• set" indicators for redacted gateway credentials
  const credLines = [];
  for (const gw of (Array.isArray(def.gateways) ? def.gateways : [])) {
    for (const [k, v] of Object.entries(gw || {})) {
      if (v && typeof v === "object" && v.__redacted) {
        credLines.push(`<div style="color:var(--crow-text-muted)">${escapeHtml(gw.type || "gateway")}.${escapeHtml(k)}: ${v.set ? "•••• set (edit on owner)" : "not set"}</div>`);
      }
    }
  }
  const modelOpts = (models.opts || []).map((o) =>
    `<option value="${escapeHtml(o.key)}" ${def.models && def.models.default === o.key ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  const content = `
    ${status}
    <p style="color:var(--crow-text-muted)">Editing <strong>${escapeHtml(botId)}</strong> on instance <strong>${escapeHtml(peerId)}</strong>. Non-secret fields only; this bot runs on its owner.</p>
    <form method="POST">
      <input type="hidden" name="peer" value="${escapeHtml(peerId)}">
      <input type="hidden" name="bot_id" value="${escapeHtml(botId)}">
      <label>Display name<br><input type="text" name="display_name" value="${escapeHtml(def.display_name || "")}" style="width:100%"></label>
      <label style="display:block;margin-top:1rem">Model<br><select name="model" style="width:100%"><option value="">(unchanged)</option>${modelOpts}</select></label>
      <label style="display:block;margin-top:1rem">System prompt<br><textarea name="system_prompt" rows="8" style="width:100%">${escapeHtml(def.system_prompt || "")}</textarea></label>
      <label style="display:block;margin-top:1rem">Skills (one per line)<br><textarea name="skills" rows="4" style="width:100%">${escapeHtml(((def.tools && def.tools.skills) || []).join("\n"))}</textarea></label>
      <div style="margin-top:1rem">${credLines.length ? "<strong>Gateway credentials (managed on owner):</strong>" + credLines.join("") : ""}</div>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-primary">Save to peer</button>
        <a href="/dashboard/bot-board" class="btn btn-secondary">Cancel</a></div>
    </form>`;
  res.send(layout({ title: "Edit peer bot", content: section(`Edit ${botId} @ ${peerId}`, content) }));
  return true;
}
