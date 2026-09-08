/**
 * contact-display — the ONE rule for a contact's name and picture on screen
 * (spec 2026-09-08 §4.5, decision D5), used by the Contacts panel, the
 * Messages list, the contacts tool and mirrored inline by the Ramble bundle
 * (bundles/ramble/server/delivery.js — a bundle server file cannot import
 * core statically).
 *
 *   name:    what the user typed (display_name) unless it is a placeholder
 *            (null, "", "crow:…", "req:…" — the same rule as
 *            contact-promote.js's isPlaceholderName, mirrored here so this
 *            module stays import-light) → what the peer told us
 *            (peer_display_name) → the caller's fallback (crow_id by default).
 *   picture: the first INLINE picture validateAvatar accepts, local first —
 *            a legacy https: avatar_url cannot render under the dashboard CSP,
 *            so it falls through to the peer's picture instead of blanking it.
 */
import { validateAvatar } from "./avatar.js";

export function isPlaceholderName(name) {
  return name == null || name === "" || String(name).startsWith("req:") || String(name).startsWith("crow:");
}

export function contactName(row, { fallback } = {}) {
  const r = row || {};
  if (!isPlaceholderName(r.display_name)) return String(r.display_name);
  if (typeof r.peer_display_name === "string" && r.peer_display_name.length > 0) return r.peer_display_name;
  if (fallback !== undefined) return fallback;
  return r.crow_id ? String(r.crow_id) : null;
}

export function contactAvatar(row) {
  const r = row || {};
  return validateAvatar(r.avatar_url) || validateAvatar(r.peer_avatar) || null;
}
