/**
 * Model Catalog — the Box schedule section (the one box calendar, the
 * private engineering notes §6.3).
 *
 * The Models panel is where people see who has the box: the active hold
 * (model window, manual hold, render/video job, the nightly audit) and the
 * coming bookings on one timeline, with Approve / Decline on a pending row
 * and Cancel on a booked one. It reads the same two layers the API in
 * `routes/box-schedule.js` serves — `readScheduleRange()` — so the panel and
 * the routes can never disagree about what the calendar says.
 *
 * Server-rendered from data loaded in the panel handler: the initial HTML is
 * the real calendar. A read that fails degrades to a notice (and an empty
 * list) — a broken calendar file must never take the Models page down with
 * it. Every dynamic string (owner, kind, mode, status, reason) is escaped
 * with escapeHtml, and every visible label goes through t() with `boxSched.`
 * keys.
 *
 * The buttons POST to `/api/box/bookings/:id/{approve,decline,cancel}` with
 * the `X-Crow-Csrf` echo exactly as `model-catalog-registered.js` does, then
 * reload the page so the section is re-rendered from the calendar itself —
 * never from a value the client guessed.
 *
 * ABSOLUTE RULE: the client <script> at the bottom is built inside a
 * template literal and must never contain a literal backtick. Browser
 * strings are single/double quoted; the only `${…}` sequences are the
 * translations and JSON this file interpolates on purpose.
 */
import { t, tJs, fill } from "../shared/i18n.js";
import { escapeHtml, button } from "../shared/components.js";
import { readScheduleRange } from "../../routes/box-schedule.js";

/** The section shows the coming 48 hours, matching the route's default range. */
const HORIZON_MS = 48 * 60 * 60 * 1000;

const KIND_KEYS = {
  window: "boxSched.kind.window",
  "gpu-job": "boxSched.kind.gpuJob",
  manual: "boxSched.kind.manual",
  audit: "boxSched.kind.audit",
};
const MODE_KEYS = {
  exclusive: "boxSched.mode.exclusive",
  beside: "boxSched.mode.beside",
};
const STATUS_KEYS = {
  booked: "boxSched.status.booked",
  active: "boxSched.status.active",
  done: "boxSched.status.done",
  cancelled: "boxSched.status.cancelled",
  lapsed: "boxSched.status.lapsed",
};
const APPROVAL_KEYS = {
  not_needed: "boxSched.approval.notNeeded",
  pending: "boxSched.approval.pending",
  approved: "boxSched.approval.approved",
  declined: "boxSched.approval.declined",
};

/** The translated label for an enum value, or the raw value if it is unknown. */
function enumLabel(value, keys, lang) {
  if (value == null || value === "") return t("boxSched.valueMissing", lang);
  const key = keys[value];
  return key ? t(key, lang) : String(value);
}

/** Local `YYYY-MM-DD HH:MM` for an ISO string or epoch ms; "?" when unreadable. */
export function formatWhen(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value == null ? "" : value));
  if (!Number.isFinite(ms)) return "?";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The active hold and the next 48 hours of bookings, for the panel handler.
 * Never throws: a failed read is reported as `error: "load_failed"` so the
 * handler can render the notice instead of the whole page failing.
 *
 * @param {{now?: number, readRangeFn?: Function}} [options] `readRangeFn` is
 *   the test seam; production uses the real API helper.
 */
export function loadBoxScheduleView({ now = Date.now(), readRangeFn = readScheduleRange } = {}) {
  try {
    return readRangeFn({ from: now, to: now + HORIZON_MS, now });
  } catch {
    return { active: null, bookings: [], corrupt: false, error: "load_failed" };
  }
}

function boxScheduleStyles() {
  return `<style>
.boxsched {
  background:var(--crow-bg-surface); border:1px solid var(--crow-border);
  border-left:3px solid var(--crow-accent);
  border-radius:var(--crow-radius-card, 12px);
  padding:1rem 1.25rem; margin-bottom:1.5rem;
  min-width:0; max-width:100%; box-sizing:border-box;
}
.boxsched__title { font-family:var(--crow-body-font); font-weight:600; font-size:1rem; color:var(--crow-text-primary); margin-bottom:0.35rem; }
.boxsched__intro { font-size:0.82rem; color:var(--crow-text-secondary); line-height:1.5; margin-bottom:0.6rem; }
.boxsched__subhead { font-family:var(--crow-body-font); font-weight:600; font-size:0.88rem; color:var(--crow-text-primary); margin:0.9rem 0 0.4rem; }
.boxsched__line { font-size:0.85rem; color:var(--crow-text-secondary); line-height:1.5; }
.boxsched__line--free { color:var(--crow-success); }
.boxsched__notice { font-size:0.78rem; color:var(--crow-text-muted); background:var(--crow-bg-deep); border-radius:8px; padding:0.5rem 0.75rem; margin:0.45rem 0; }
.boxsched__table { width:100%; border-collapse:collapse; font-size:0.82rem; }
.boxsched__table th { text-align:left; font-weight:600; color:var(--crow-text-muted); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.03em; padding:0.4rem 0.5rem; border-bottom:1px solid var(--crow-border); }
.boxsched__table td { padding:0.5rem; border-bottom:1px solid var(--crow-border); vertical-align:top; color:var(--crow-text-secondary); min-width:0; overflow-wrap:anywhere; }
.boxsched__table tr:last-child td { border-bottom:none; }
.boxsched__when { font-family:'JetBrains Mono',monospace; color:var(--crow-text-primary); white-space:nowrap; }
.boxsched__reason { font-size:0.75rem; color:var(--crow-text-muted); margin-top:0.2rem; }
.boxsched__owner { color:var(--crow-text-primary); }
.boxsched__actions { display:flex; gap:0.35rem; flex-wrap:wrap; }
.boxsched__msg { font-size:0.78rem; color:var(--crow-text-muted); min-height:1.1em; margin-top:0.5rem; }
@media (max-width:640px) {
  .boxsched { padding:0.85rem 0.9rem; }
  .boxsched__table, .boxsched__table tbody, .boxsched__table tr, .boxsched__table td { display:block; width:100%; box-sizing:border-box; }
  .boxsched__table thead { display:none; }
  .boxsched__table tr { border-bottom:1px solid var(--crow-border); padding:0.4rem 0; }
  .boxsched__table td { border-bottom:none; padding:0.2rem 0; }
  .boxsched__table td[data-label]::before { content:attr(data-label); display:block; font-size:0.66rem; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--crow-text-muted); }
}
</style>`;
}

function actionButtons(row, approvalState, status, lang) {
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) return "";
  const attrs = (action) => `data-box-action="${action}" data-box-id="${escapeHtml(id)}"`;
  const out = [];
  if (approvalState === "pending") {
    out.push(button(t("boxSched.actionApprove", lang), { variant: "primary", size: "sm", attrs: attrs("approve") }));
    out.push(button(t("boxSched.actionDecline", lang), { variant: "secondary", size: "sm", attrs: attrs("decline") }));
  } else if (status === "booked") {
    out.push(button(t("boxSched.actionCancel", lang), { variant: "danger", size: "sm", attrs: attrs("cancel") }));
  }
  return out.join("");
}

function bookingRow(row, lang) {
  const id = typeof row.id === "string" ? row.id : "";
  const approval = row.approval && typeof row.approval === "object" ? row.approval : null;
  const approvalState = approval && typeof approval.state === "string" ? approval.state : "not_needed";
  const status = typeof row.status === "string" ? row.status : "booked";
  const reason = typeof row.reason === "string" && row.reason.trim() !== "" ? row.reason : "";
  const when = row.end ? `${formatWhen(row.start)} – ${formatWhen(row.end)}` : formatWhen(row.start);
  const cell = (key) => ` data-label="${escapeHtml(t(key, lang))}"`;
  return `<tr class="boxsched__row" data-box-row="${escapeHtml(id)}" data-box-status="${escapeHtml(status)}">
      <td${cell("boxSched.colWhen")}><span class="boxsched__when">${escapeHtml(when)}</span>${
        reason ? `<div class="boxsched__reason">${escapeHtml(reason)}</div>` : ""
      }</td>
      <td${cell("boxSched.colOwner")}><span class="boxsched__owner">${escapeHtml(row.owner || "?")}</span></td>
      <td${cell("boxSched.colKind")}>${escapeHtml(enumLabel(row.kind, KIND_KEYS, lang))}</td>
      <td${cell("boxSched.colMode")}>${escapeHtml(enumLabel(row.mode, MODE_KEYS, lang))}</td>
      <td${cell("boxSched.colStatus")}>${escapeHtml(enumLabel(status, STATUS_KEYS, lang))}</td>
      <td${cell("boxSched.colApproval")}>${escapeHtml(enumLabel(approvalState, APPROVAL_KEYS, lang))}</td>
      <td${cell("boxSched.colActions")}><div class="boxsched__actions">${actionButtons(row, approvalState, status, lang)}</div></td>
    </tr>`;
}

/**
 * The section's initial HTML: heading, the active hold (or the free state),
 * then the next 48 hours of bookings with their actions.
 *
 * @param {{active?: object|null, bookings?: object[], corrupt?: boolean, error?: string}} schedule
 * @param {string} lang
 */
export function renderBoxScheduleSection(schedule, lang) {
  const data = schedule && typeof schedule === "object" ? schedule : {};
  const label = (key) => escapeHtml(t(key, lang));
  const active = data.active && typeof data.active === "object" ? data.active : null;
  const bookings = Array.isArray(data.bookings) ? data.bookings : [];

  const notices = [];
  if (data.error) notices.push(`<div class="boxsched__notice">${label("boxSched.loadFailed")}</div>`);
  else if (data.corrupt) notices.push(`<div class="boxsched__notice">${label("boxSched.corrupt")}</div>`);

  let activeHtml;
  if (active && active.corrupt) {
    activeHtml = `<div class="boxsched__notice">${label("boxSched.activeCorrupt")}</div>`;
  } else if (active) {
    const line = fill(t("boxSched.activeLine", lang), {
      owner: active.owner || "?",
      kind: enumLabel(active.kind, KIND_KEYS, lang),
      mode: enumLabel(active.mode, MODE_KEYS, lang),
      until: formatWhen(active.expires_at),
    });
    activeHtml = `<div class="boxsched__line">${escapeHtml(line)}</div>`;
  } else {
    activeHtml = `<div class="boxsched__line boxsched__line--free">${label("boxSched.free")}</div>`;
  }

  const body = bookings.length === 0
    ? `<tr><td colspan="7">${label("boxSched.emptyRange")}</td></tr>`
    : bookings.map((row) => bookingRow(row && typeof row === "object" ? row : {}, lang)).join("");

  const head = [
    "boxSched.colWhen", "boxSched.colOwner", "boxSched.colKind",
    "boxSched.colMode", "boxSched.colStatus", "boxSched.colApproval", "boxSched.colActions",
  ].map((key) => `<th>${label(key)}</th>`).join("");

  return `${boxScheduleStyles()}<section class="boxsched" id="boxsched">
    <div class="boxsched__title">${label("boxSched.heading")}</div>
    <div class="boxsched__intro">${label("boxSched.intro")}</div>
    ${notices.join("")}
    <div class="boxsched__line"><strong>${label("boxSched.activeHeading")}</strong></div>
    ${activeHtml}
    <div class="boxsched__subhead">${label("boxSched.listHeading")}</div>
    <div class="table-scroll"><table class="boxsched__table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="boxsched__msg" id="boxsched-msg"></div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Client script — NO BACKTICKS below, inside the returned template literal.
// ---------------------------------------------------------------------------

export function boxScheduleClientJS(lang) {
  return `
    <script>
      (function () {
        var API = "/api/box";
        var T = {
          failed: '${tJs("boxSched.failed", lang)}',
          approving: '${tJs("boxSched.approving", lang)}',
          declining: '${tJs("boxSched.declining", lang)}',
          cancelling: '${tJs("boxSched.cancelling", lang)}'
        };
        var RUNNING = { approve: T.approving, decline: T.declining, cancel: T.cancelling };

        function csrf() {
          var m = (document.cookie || "").match(/(?:^|;\\s*)crow_csrf=([^;]*)/);
          return m ? decodeURIComponent(m[1]) : "";
        }
        function call(method, path) {
          var headers = { "Content-Type": "application/json" };
          if (method !== "GET") headers["X-Crow-Csrf"] = csrf();
          return fetch(API + path, { method: method, headers: headers }).then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d || {} }; },
              function () { return { ok: r.ok, status: r.status, data: {} }; });
          });
        }
        function show(text) {
          var el = document.getElementById("boxsched-msg");
          if (el) el.textContent = text;
        }
        function errText(d) {
          d = d || {};
          return (d.code ? d.code + ": " : "") + (d.error || T.failed);
        }

        // One delegated listener: a row's buttons are server-rendered, so
        // nothing is bound per row. The page reloads after a successful POST
        // so the section is re-rendered from the calendar the server just
        // wrote, never from a value guessed here.
        document.addEventListener("click", function (e) {
          var b = e.target && e.target.closest ? e.target.closest("[data-box-action]") : null;
          if (!b) return;
          var action = b.getAttribute("data-box-action");
          var id = b.getAttribute("data-box-id");
          if (!action || !id || !RUNNING[action]) return;
          b.disabled = true;
          show(RUNNING[action]);
          call("POST", "/bookings/" + encodeURIComponent(id) + "/" + action).then(function (res) {
            if (res.ok) { location.reload(); return; }
            show(errText(res.data));
            b.disabled = false;
          }).catch(function () {
            show(T.failed);
            b.disabled = false;
          });
        });
      })();
    </script>`;
}