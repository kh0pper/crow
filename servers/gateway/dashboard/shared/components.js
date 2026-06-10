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
 * @param {string[]|string} buttons - Array of button HTML strings, OR a
 *   single pre-built button-HTML string. Tolerant of both: bot-builder.js
 *   (the only caller) has always passed a bare string, which previously
 *   threw `buttons.join is not a function` on every authed render. Arrays
 *   keep their exact prior behavior (backward-compatible).
 */
export function actionBar(buttons) {
  const arr = Array.isArray(buttons) ? buttons : [buttons == null ? "" : buttons];
  return `<div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap">${arr.join("")}</div>`;
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
export function formatDate(dateStr, lang = "en") {
  if (!dateStr) return "";
  try {
    const locale = lang === "es" ? "es-ES" : "en-US";
    return new Date(dateStr).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
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

/**
 * Button. Renders <button> by default, or <a class="btn"> when opts.href is set.
 * @param {string} label
 * @param {{variant?: "primary"|"secondary"|"danger"|"ghost", size?: "sm"|"md",
 *   href?: string, type?: string, name?: string, value?: string, attrs?: string}} [opts]
 */
export function button(label, opts = {}) {
  const variant = opts.variant || "primary";
  const size = opts.size || "md";
  const cls = `btn btn-${variant} btn-${size}`;
  const extra = opts.attrs ? " " + opts.attrs : "";
  if (opts.href) {
    return `<a class="${cls}" href="${escapeHtml(opts.href)}"${extra}>${escapeHtml(label)}</a>`;
  }
  const type = opts.type || "button";
  const name = opts.name ? ` name="${escapeHtml(opts.name)}"` : "";
  const value = opts.value != null ? ` value="${escapeHtml(String(opts.value))}"` : "";
  return `<button class="${cls}" type="${escapeHtml(type)}"${name}${value}${extra}>${escapeHtml(label)}</button>`;
}

/**
 * Code block with a copy-to-clipboard button. Text is escaped.
 * @param {string} text
 * @param {{lang?: string}} [opts]
 */
export function codeBlock(text, opts = {}) {
  const raw = String(text == null ? "" : text);
  const langLabel = opts.lang ? `<span class="code-lang">${escapeHtml(opts.lang)}</span>` : "";
  // data-copy carries the raw text (escaped as an attribute) for the delegated
  // copy handler in componentsJs(); the visible <code> is escaped for display.
  return `<div class="code-block">
  <div class="code-block-bar">${langLabel}<button type="button" class="code-copy" data-copy="${escapeHtml(raw)}">Copy</button></div>
  <pre><code>${escapeHtml(raw)}</code></pre>
</div>`;
}

/**
 * Callout / notice. content is caller-supplied HTML (not escaped — matches
 * section()/dataTable() convention; callers escape user data).
 * @param {string} content
 * @param {"info"|"success"|"warning"|"error"} [type="info"]
 */
export function callout(content, type = "info") {
  const t = ["info", "success", "warning", "error"].includes(type) ? type : "info";
  return `<div class="callout callout-${t}">${content}</div>`;
}

/**
 * Stepper (display-only). 0-based current index.
 * @param {{label: string}[]} steps
 * @param {number} current
 */
export function stepper(steps, current = 0) {
  const items = (steps || []).map((s, i) => {
    const state = i < current ? "step-done" : i === current ? "step-active" : "step-upcoming";
    return `<li class="step ${state}"><span class="step-num">${i + 1}</span><span class="step-label">${escapeHtml(s.label || "")}</span></li>`;
  }).join("");
  return `<ol class="stepper">${items}</ol>`;
}

/**
 * Tabs. Switching handled by the delegated handler in componentsJs().
 * @param {{id: string, label: string, content: string}[]} items - content is HTML (caller-escaped)
 * @param {{active?: number}} [opts]
 */
export function tabs(items, opts = {}) {
  const list = items || [];
  const active = opts.active || 0;
  const triggers = list.map((it, i) =>
    `<button type="button" class="tab-trigger ${i === active ? "tab-active" : ""}" data-tab="${escapeHtml(it.id)}">${escapeHtml(it.label)}</button>`
  ).join("");
  const panels = list.map((it, i) =>
    `<div class="tab-panel ${i === active ? "tab-active" : ""}" data-tab-panel="${escapeHtml(it.id)}">${it.content}</div>`
  ).join("");
  return `<div class="tabs"><div class="tab-list">${triggers}</div><div class="tab-panels">${panels}</div></div>`;
}
