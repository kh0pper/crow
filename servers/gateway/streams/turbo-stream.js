/**
 * Turbo Stream framing helpers.
 *
 * ## Escape-by-default contract
 *
 * Every Turbo Stream HTML body MUST be produced by the `html` tag
 * function in this module, OR explicitly wrapped with `raw()`. This is
 * enforced by convention — there is no runtime check — so code review
 * for any new emit site MUST grep for `turboStream` and `sseTurbo` and
 * verify each call site's body comes from `html\`\`` or a reviewed
 * `raw()` (e.g. markdown that has already passed through
 * `sanitize-html`).
 *
 * A bare `${userInput}` interpolation into `turboStream()` IS an XSS
 * bug. Do not do it. `html\`<span>${userInput}</span>\`` is correct.
 *
 * ## Multi-line SSE framing
 *
 * `sseTurbo()` splits multi-line frames into multiple `data:` records.
 * This is required by the SSE spec (consumers join with `\n`) and
 * preserves content newlines. An earlier draft used
 * `frame.replace(/\n/g, "")` which silently ate content-level newlines
 * — a data-loss bug caught in the Phase C plan's Round 2 review.
 */

/** Minimal HTML escaper. */
export function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Marker for pre-escaped HTML fragments. Bypasses `html\`\``'s default
 * escaping. Use only for content that has already been sanitized
 * upstream (blog markdown post-`sanitize-html`, template snippets).
 */
export function raw(s) {
  return { __crowRaw: true, html: String(s) };
}

/**
 * Tagged template: auto-escapes every interpolant unless wrapped in
 * `raw()`. This is the primary way to build Turbo Stream bodies.
 *
 *   html`<span class="badge">${unreadCount}</span>`
 *   html`<div>${raw(preSanitizedMarkdown)}</div>`
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out +=
      v && typeof v === "object" && v.__crowRaw
        ? v.html
        : escapeHtml(v);
    out += strings[i + 1];
  }
  return out;
}

/**
 * Build a `<turbo-stream action="..." target="...">` frame.
 *
 * `action` and `target` are always escaped defensively. `body` is
 * treated as trusted HTML — you MUST feed it from `html\`\`` (or a
 * reviewed `raw()`).
 */
export function turboStream(action, target, body) {
  return `<turbo-stream action="${escapeHtml(action)}" target="${escapeHtml(
    target,
  )}"><template>${body}</template></turbo-stream>`;
}

/**
 * Frame a turbo-stream for SSE transport. Multi-line bodies are
 * preserved by emitting each line as its own `data:` record.
 */
export function sseTurbo(sendRaw, action, target, body) {
  const frame = turboStream(action, target, body);
  const dataLines = frame
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  sendRaw(`${dataLines}\n\n`);
}
