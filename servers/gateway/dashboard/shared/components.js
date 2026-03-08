/**
 * Dashboard Components — Reusable HTML template functions
 */

export function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Stat card with label and value.
 */
export function statCard(label, value, opts = {}) {
  const delay = opts.delay || 0;
  return `<div class="stat-card" style="animation: fadeInUp 0.4s ease-out ${delay}ms both">
  <div class="label">${escapeHtml(label)}</div>
  <div class="value">${escapeHtml(String(value))}</div>
</div>`;
}

/**
 * Stat card grid.
 */
export function statGrid(cards) {
  return `<div class="card-grid" style="margin-bottom:1.5rem">${cards.join("")}</div>`;
}

/**
 * Data table.
 * @param {string[]} headers
 * @param {string[][]} rows - Each row is array of cell HTML (not escaped)
 */
export function dataTable(headers, rows) {
  if (rows.length === 0) {
    return `<div class="empty-state"><h3>No data</h3></div>`;
  }
  const ths = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const trs = rows.map((cells) =>
    `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`
  ).join("");
  return `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

/**
 * Form field.
 */
export function formField(label, name, opts = {}) {
  const { type = "text", value = "", placeholder = "", required = false, rows = 0 } = opts;
  const req = required ? "required" : "";
  const id = `field-${name}`;

  let input;
  if (type === "textarea") {
    input = `<textarea name="${name}" id="${id}" placeholder="${escapeHtml(placeholder)}" ${req} rows="${rows || 4}">${escapeHtml(value)}</textarea>`;
  } else if (type === "select") {
    const options = (opts.options || []).map((o) => {
      const sel = o.value === value ? "selected" : "";
      return `<option value="${escapeHtml(o.value)}" ${sel}>${escapeHtml(o.label)}</option>`;
    }).join("");
    input = `<select name="${name}" id="${id}" ${req}>${options}</select>`;
  } else {
    input = `<input type="${type}" name="${name}" id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${req}>`;
  }

  return `<div style="margin-bottom:1rem">
  <label for="${id}" style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(label)}</label>
  ${input}
</div>`;
}

/**
 * Status badge.
 */
export function badge(text, type = "draft") {
  return `<span class="badge badge-${type}">${escapeHtml(text)}</span>`;
}

/**
 * Action bar with buttons.
 * @param {string[]} buttons - Array of button HTML strings
 */
export function actionBar(buttons) {
  return `<div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap">${buttons.join("")}</div>`;
}

/**
 * Section with heading.
 */
export function section(title, content, opts = {}) {
  const delay = opts.delay || 0;
  return `<div class="card" style="margin-bottom:1.5rem;animation-delay:${delay}ms">
  <h3 style="font-family:'Fraunces',serif;font-size:1.1rem;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid var(--crow-border)">${escapeHtml(title)}</h3>
  ${content}
</div>`;
}

/**
 * Format a date string for display.
 */
export function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

/**
 * Format bytes to human-readable.
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
