/**
 * The "Needs attention" group of the new shell's mascot sheet (R1.2, spec §13).
 *
 * attentionGroupHtml(issues, lang, back) renders the issues
 * collectHealthSignals produced (no logic copied): a heading, then one row per
 * issue with the severity dot, the label and its one action. The backup issue
 * keeps its POST form (as nest/html.js buildHealthStrip does); an issue that
 * carries `ack` gets a "This is expected" button posting to
 * POST /dashboard/health/ack. `back` is where that POST returns (a /dashboard
 * path; the attention route reopens the sheet). The hidden _csrf is filled by
 * the shell client's capture-phase submit listener, like every shell form.
 * Everything that reaches the markup is escaped.
 */

import { escapeHtml } from "../shared/components.js";
import { t } from "../shared/i18n.js";

const BACKUP_HREF = "/dashboard/nest?action=backup";

function actionHtml(issue) {
  if (!issue.actionLabel || !issue.actionHref) return "";
  const label = escapeHtml(issue.actionLabel);
  if (issue.actionHref === BACKUP_HREF) {
    return `<form class="shell-attn-form" method="POST" action="/dashboard/nest/backup"><input type="hidden" name="_csrf" value=""><button class="shell-attn-btn" type="submit">${label}</button></form>`;
  }
  return `<a class="shell-attn-action" href="${escapeHtml(issue.actionHref)}">${label}</a>`;
}

function ackHtml(issue, lang, back) {
  const ack = issue.ack;
  if (!ack || typeof ack.kind !== "string" || typeof ack.key !== "string") return "";
  return `<form class="shell-attn-form" method="POST" action="/dashboard/health/ack"><input type="hidden" name="_csrf" value=""><input type="hidden" name="kind" value="${escapeHtml(ack.kind)}"><input type="hidden" name="key" value="${escapeHtml(ack.key)}"><input type="hidden" name="back" value="${escapeHtml(back)}"><button class="shell-attn-btn shell-attn-btn--quiet" type="submit">${escapeHtml(t("signals.ack.expected", lang))}</button></form>`;
}

export function attentionGroupHtml(issues, lang, back = "/dashboard/attention") {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  const rows = issues.map((issue) => {
    const dot = issue.severity === "warn" ? "warn" : "info";
    const acts = actionHtml(issue) + ackHtml(issue, lang, back);
    return `<li class="shell-attn-row"><span class="shell-attn-dot shell-attn-dot--${dot}" aria-hidden="true"></span><span class="shell-attn-text">${escapeHtml(issue.label)}</span>${acts ? `<span class="shell-attn-acts">${acts}</span>` : ""}</li>`;
  }).join("");
  return `<h3 class="shell-heading shell-attn-heading">${escapeHtml(t("shell.attention", lang))}</h3><ul class="shell-attn-list">${rows}</ul><hr class="shell-crow-sep">`;
}
