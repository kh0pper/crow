/**
 * PM Workspace — digest HTML/plain-text renderer.
 *
 * Inline-CSS email HTML modeled on canvas-companion's digest
 * _format_html: header, per-adapter sections (lists/tables), footer link
 * to the PM Workspace panel. Email clients ignore <style> blocks
 * inconsistently, so every element carries inline styles.
 *
 * Section shape (produced by adapters):
 *   { title: string,
 *     available: boolean,
 *     reason?: string,              // when unavailable
 *     items?: [{ label, detail?, meta?, urgent? }],
 *     table?: { headers: [...], rows: [[...], ...] },
 *     note?: string }
 */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const S = {
  body: "font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.6;max-width:640px;margin:0 auto;padding:20px;color:#2c3e50;",
  h1: "color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px;margin:0 0 6px;font-size:1.5em;",
  date: "color:#666;font-style:italic;margin:0 0 18px;",
  h2: "color:#34495e;margin:25px 0 8px;font-size:1.15em;",
  item: "background:#f8f9fa;padding:10px;margin:5px 0;border-radius:4px;",
  urgent: "background:#fee;border-left:4px solid #e74c3c;padding:10px;margin:10px 0;border-radius:4px;",
  meta: "color:#666;font-size:0.85em;",
  unavailable: "color:#999;font-style:italic;font-size:0.9em;",
  table: "width:100%;border-collapse:collapse;margin:8px 0;font-size:0.9em;",
  th: "text-align:left;padding:6px 8px;border-bottom:2px solid #ddd;color:#34495e;",
  td: "padding:6px 8px;border-bottom:1px solid #eee;",
  footer: "margin-top:30px;padding-top:15px;border-top:1px solid #ddd;color:#666;font-size:0.9em;",
};

function renderSectionHtml(section) {
  const out = [`<h2 style="${S.h2}">${escapeHtml(section.title)}</h2>`];

  if (!section.available) {
    out.push(`<p style="${S.unavailable}">${escapeHtml(section.reason || "Unavailable")}</p>`);
    return out.join("\n");
  }

  if (section.table && section.table.rows?.length) {
    out.push(`<table style="${S.table}"><thead><tr>`);
    for (const h of section.table.headers || []) {
      out.push(`<th style="${S.th}">${escapeHtml(h)}</th>`);
    }
    out.push("</tr></thead><tbody>");
    for (const row of section.table.rows) {
      out.push("<tr>" + row.map((c) => `<td style="${S.td}">${escapeHtml(c)}</td>`).join("") + "</tr>");
    }
    out.push("</tbody></table>");
  }

  if (section.items?.length) {
    for (const item of section.items) {
      out.push(`<div style="${item.urgent ? S.urgent : S.item}">`);
      out.push(`<strong>${escapeHtml(item.label)}</strong>`);
      if (item.detail) out.push(`<br>${escapeHtml(item.detail)}`);
      if (item.meta) out.push(`<br><span style="${S.meta}">${escapeHtml(item.meta)}</span>`);
      out.push("</div>");
    }
  }

  if (!section.table?.rows?.length && !section.items?.length) {
    out.push(`<p style="${S.meta}">${escapeHtml(section.note || "Nothing to report.")}</p>`);
  } else if (section.note) {
    out.push(`<p style="${S.meta}">${escapeHtml(section.note)}</p>`);
  }

  return out.join("\n");
}

/**
 * Render the full digest.
 * @param {{date:string, sections:Array}} digest
 * @param {object} config loadConfig() result (for CROW_GATEWAY_URL)
 * @returns {{html:string, text:string, summary:string}}
 */
export function renderDigest(digest, config = {}) {
  const gatewayUrl = (config.CROW_GATEWAY_URL || "").replace(/\/+$/, "");
  const panelUrl = gatewayUrl ? `${gatewayUrl}/dashboard/pm-workspace` : "/dashboard/pm-workspace";

  const html = [
    "<!DOCTYPE html>",
    `<html><body style="${S.body}">`,
    `<h1 style="${S.h1}">PM Workspace</h1>`,
    `<p style="${S.date}">Daily Digest — ${escapeHtml(digest.date)}</p>`,
    ...digest.sections.map(renderSectionHtml),
    `<div style="${S.footer}"><a href="${escapeHtml(panelUrl)}" style="color:#3498db">Open PM Workspace</a></div>`,
    "</body></html>",
  ].join("\n");

  // Plain-text variant
  const text = [];
  text.push(`PM WORKSPACE — Daily Digest — ${digest.date}`);
  text.push("=".repeat(50));
  for (const section of digest.sections) {
    text.push("");
    text.push(section.title.toUpperCase());
    text.push("-".repeat(section.title.length));
    if (!section.available) {
      text.push(`  (${section.reason || "unavailable"})`);
      continue;
    }
    if (section.table?.rows?.length) {
      for (const row of section.table.rows) text.push("  " + row.join(" | "));
    }
    if (section.items?.length) {
      for (const item of section.items) {
        text.push(`  ${item.urgent ? "[!] " : "- "}${item.label}${item.detail ? " — " + item.detail : ""}`);
        if (item.meta) text.push(`      ${item.meta}`);
      }
    }
    if (!section.table?.rows?.length && !section.items?.length) {
      text.push(`  ${section.note || "Nothing to report."}`);
    } else if (section.note) {
      text.push(`  ${section.note}`);
    }
  }
  text.push("");
  text.push(`Open PM Workspace: ${panelUrl}`);

  // Short summary line (for ntfy + pm_digests.summary)
  const parts = [];
  for (const section of digest.sections) {
    if (!section.available) continue;
    const n = (section.items?.length || 0) + (section.table?.rows?.length || 0);
    if (n > 0) parts.push(`${section.title}: ${n}`);
  }
  const summary = parts.length ? parts.join(" · ") : "Nothing to report today.";

  return { html, text: text.join("\n"), summary };
}
