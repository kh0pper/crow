/**
 * history-view.js — the History pages' renderer: one item's versions, the Jobs
 * page and the Trash page.
 *
 * Pure HTML in, HTML out. Every read is the panel's (panels/history.js +
 * panels/history/data.js); every POST is a plain form the panel handles. Nothing
 * here writes, and nothing here talks to a database, so the same functions can
 * render a page for a test with no store at all.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP:
 *
 *   NO GIT WORDS IN ANY USER-FACING STRING (the version history design §3.1).
 *   The words are History, Version, Restore, Undo this job, Trash and Erased.
 *   A reader is a person, not a developer: "what changed" is shown as Added and
 *   Removed lines, never as a "diff", and nothing here says branch, commit,
 *   repository or revert — not in the copy, not in a class name, not in a title.
 *
 *   EVERY DOCUMENT-DERIVED STRING IS ESCAPED. A memory's content, a blog post's
 *   title, a context section's name, a bot's display name, a paired machine's
 *   name, an item id, a job id: all of it came from content other people (and
 *   bots) wrote. All of it goes through escapeHtml, and a version's stored
 *   snapshot is never inserted as markup. The job/page labels built from a job id
 *   are ours; the id inside one is the document's and is escaped.
 *
 *   A CHANGE IS DESCRIBED, NOT WINNED. The change view says what a version did
 *   to the item — added lines, removed lines, a value that changed — so a
 *   non-technical owner can read it. It never claims which of two versions is
 *   "better", and it never hides the fact that a restore adds a version rather
 *   than rewriting the list.
 *
 * The banners at the top of the pages are one honest sentence the design
 * requires: until bot containment ships, a bot with raw database access could
 * still alter history (the private engineering notes, audit N1b-4). The panel
 * decides whether to show it (botContainmentGapOpen in panels/history/data.js);
 * this file only renders it.
 */
import { escapeHtml, section } from "./components.js";
import { fill, t } from "./i18n.js";
import { diffVersions } from "../../../shared/history/api.js";

/** How much of a value a change view shows (the rest is counted, never dumped). */
const MAX_DIFF_LINES = 40;
/** A single changed line is cut here; a 200 KB memory must not become a 200 KB row. */
const MAX_LINE_CHARS = 400;
/** A preview of an item in the Trash or a job list is cut here. */
const MAX_PREVIEW_CHARS = 160;

/** The posting path of one item's page (also the restores' form action). */
export function itemHistoryPath(itemType, itemId) {
  return `/dashboard/history/${encodeURIComponent(String(itemType))}/${encodeURIComponent(String(itemId))}`;
}

export const JOBS_PATH = "/dashboard/history/jobs";
export const TRASH_PATH = "/dashboard/history/trash";

/** A plain, local date-and-time. Never throws on junk; returns the raw text then. */
export function formatWhen(value, lang = "en") {
  if (!value) return "";
  try {
    const locale = lang === "es" ? "es-ES" : "en-US";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(value);
  }
}

/** Cut a string to `max` characters with an ellipsis (no markup, no newlines). */
function clip(text, max) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** The covered item type as a person reads it ("memory" → "Memory"). */
export function typeWord(itemType, lang = "en") {
  // The types that HAVE a History page of their own (COVERED's, plus the two
  // read-through stores, plus the Studio song an undo result can name). A type
  // outside this list renders as its raw name, which is the honest fallback.
  const known = [
    "memory",
    "blog_post",
    "context_section",
    "research_note",
    "research_source",
    "kb_article",
    "bot_def",
    "card",
    "artifact",
    "studio_song",
  ];
  if (known.includes(itemType)) return t(`history.type.${itemType}`, lang);
  return String(itemType == null ? "" : itemType);
}

/**
 * The one-line label of an item, from its snapshot: a memory's content, a blog
 * post's title, a context section's title (or its key), a note's title or text,
 * a research source's title (else its URL, else its citation — a source a person
 * added by URL alone still has to be recognisable), a KB article's title, a bot's
 * display name, a card's title, an artifact's title. Untrusted by definition —
 * callers must escape it (this returns the RAW string on purpose, because the
 * Trash and job lists clip it before escaping and the caller may want a full
 * version elsewhere).
 */
export function itemLabel(itemType, snapshot) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (itemType === "memory") return clip(s.content ?? "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "blog_post") return clip(s.title ?? "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "context_section") return clip(s.section_title || s.section_key || "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "research_note") return clip(s.title || s.content || "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "research_source") {
    return clip(s.title || s.url || s.citation_apa || "", MAX_PREVIEW_CHARS) || "—";
  }
  if (itemType === "kb_article") return clip(s.title ?? "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "bot_def") return clip(s.display_name ?? "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "card") return clip(s.title ?? "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "artifact") return clip(s.title ?? "", MAX_PREVIEW_CHARS) || "—";
  if (itemType === "studio_song") return clip(s.title || s.label || "", MAX_PREVIEW_CHARS) || "—";
  return "—";
}

/** Where an item's own page lives (the History page's way back). */
function backHref(itemType) {
  if (itemType === "memory") return { href: "/dashboard/memory", key: "history.back.memory" };
  if (itemType === "blog_post") return { href: "/dashboard/blog", key: "history.back.blog" };
  if (itemType === "context_section") return { href: "/dashboard/settings?section=shared-context", key: "history.back.context" };
  if (itemType === "card") return { href: "/dashboard/board", key: "history.back.card" };
  if (itemType === "bot_def") return { href: "/dashboard/bot-builder", key: "history.back.bot" };
  if (itemType === "artifact") return { href: "/dashboard/artifacts", key: "history.back.artifact" };
  if (itemType === "kb_article") return { href: "/dashboard/knowledge-base", key: "history.back.kb" };
  return null;
}

/** The word for a version's op. */
export function opWord(op, lang = "en") {
  if (op === "insert") return t("history.op.insert", lang);
  if (op === "delete") return t("history.op.delete", lang);
  return t("history.op.update", lang);
}

/**
 * Who made a version: "You", a bot's display name, a paired machine's name,
 * "Unattributed" or "System" (the design's fixed labels). `who` is
 * `{ bots: Map(botId → display name), machines: Map(instanceId → name) }`; a
 * name that is missing falls back to a plain phrase, never to a raw id.
 */
export function whoLabel(version, who = {}, lang = "en") {
  const kind = version && version.authorKind;
  if (kind === "owner") return t("history.who.you", lang);
  if (kind === "system") return t("history.who.system", lang);
  if (kind === "bot") {
    const name = who.bots instanceof Map ? who.bots.get(String(version.authorId ?? "")) : null;
    return name ? String(name) : t("history.who.botUnknown", lang);
  }
  if (kind === "peer") {
    const name = who.machines instanceof Map ? who.machines.get(String(version.authorId ?? "")) : null;
    return name ? String(name) : t("history.who.peerUnknown", lang);
  }
  return t("history.who.unattributed", lang);
}

/** A tracked field's human name, with the raw column name as the honest fallback. */
export function fieldLabel(field, lang = "en") {
  const key = `history.field.${field}`;
  const label = t(key, lang);
  return label === key ? String(field) : label;
}

/** The notice/banner blocks. `notice` is { tone, heading?, lines[] } or null. */
export function renderNotice(notice) {
  if (!notice || !Array.isArray(notice.lines) || notice.lines.length === 0) return notice && notice.heading
    ? `<div class="hv-notice hv-notice-${escapeHtml(notice.tone || "info")}"><div class="hv-notice-head">${escapeHtml(notice.heading)}</div></div>`
    : "";
  const cls = notice.tone === "error" ? "hv-notice-error" : notice.tone === "ok" ? "hv-notice-ok" : "hv-notice-info";
  const heading = notice.heading ? `<div class="hv-notice-head">${escapeHtml(notice.heading)}</div>` : "";
  const lines = notice.lines.map((line) => `<div class="hv-notice-line">${escapeHtml(line)}</div>`).join("");
  return `<div class="hv-notice ${cls}" role="status">${heading}${lines}</div>`;
}

/** The containment caveat, shown while a bot could still reach the database. */
export function renderContainmentBanner(lang = "en") {
  return `<div class="hv-banner" role="note">${escapeHtml(t("history.banner", lang))}</div>`;
}

/** A hidden CSRF field, for the classic form posts every mutation on these pages uses. */
export function csrfField(csrf) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrf || "")}">`;
}

/** The strip that ties the three pages together. */
function navStrip(active, lang) {
  const link = (href, key, isActive) =>
    isActive
      ? `<span class="hv-tab hv-tab-active">${escapeHtml(t(key, lang))}</span>`
      : `<a class="hv-tab" href="${escapeHtml(href)}">${escapeHtml(t(key, lang))}</a>`;
  return `<div class="hv-tabs">${link(JOBS_PATH, "history.jobsTitle", active === "jobs")}${link(
    TRASH_PATH,
    "history.trashTitle",
    active === "trash",
  )}</div>`;
}

const CSS = `
<style>
  .hv-banner { border:1px solid var(--crow-warning,#8f5606); background:var(--crow-bg-elevated); color:var(--crow-text-secondary); border-radius:8px; padding:0.6rem 0.75rem; font-size:0.82rem; line-height:1.45; margin-bottom:1rem }
  .hv-tabs { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap }
  .hv-tab { border:1px solid var(--crow-border); border-radius:999px; padding:0.3rem 0.8rem; font-size:0.85rem; color:var(--crow-text-secondary); text-decoration:none }
  .hv-tab-active { background:var(--crow-accent-muted); color:var(--crow-text-primary); border-color:var(--crow-accent) }
  .hv-row { border-bottom:1px solid var(--crow-border); padding:0.75rem 0; display:grid; gap:0.35rem }
  .hv-row:last-child { border-bottom:none }
  .hv-meta { font-size:0.82rem; color:var(--crow-text-muted); display:flex; gap:0.5rem; flex-wrap:wrap; align-items:baseline }
  .hv-who { color:var(--crow-text-primary); font-weight:600 }
  .hv-label { font-weight:600; color:var(--crow-text-primary); overflow-wrap:anywhere }
  .hv-sub { font-size:0.8rem; color:var(--crow-text-muted); overflow-wrap:anywhere }
  .hv-change { margin:0.4rem 0 0; font-size:0.85rem }
  .hv-change > summary { cursor:pointer; color:var(--crow-text-secondary) }
  .hv-lines { margin:0.4rem 0 0; padding:0.5rem 0.6rem; background:var(--crow-bg-elevated); border-radius:6px; font-family:'JetBrains Mono',monospace; font-size:0.78rem; line-height:1.45; overflow-x:auto }
  .hv-line { white-space:pre-wrap; overflow-wrap:anywhere }
  .hv-mark { display:inline-block; width:1.1em; color:var(--crow-text-muted) }
  .hv-rem { color:var(--crow-error) }
  .hv-add { color:var(--crow-success) }
  .hv-values { margin:0.4rem 0 0; font-size:0.85rem; overflow-wrap:anywhere }
  .hv-value { font-family:'JetBrains Mono',monospace; font-size:0.78rem; background:var(--crow-bg-elevated); border-radius:4px; padding:0.05rem 0.3rem }
  .hv-notice { border-radius:8px; padding:0.7rem 0.85rem; margin-bottom:1rem; font-size:0.88rem; line-height:1.5 }
  .hv-notice-ok { background:var(--crow-accent-muted); color:var(--crow-text-primary) }
  .hv-notice-error { border:1px solid var(--crow-error); color:var(--crow-text-primary) }
  .hv-notice-info { background:var(--crow-bg-elevated); color:var(--crow-text-primary) }
  .hv-notice-head { font-weight:600; margin-bottom:0.25rem }
  .hv-actions { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.5rem }
  .hv-pager { display:flex; gap:0.75rem; justify-content:center; margin-top:1rem; font-size:0.85rem; color:var(--crow-text-muted) }
  .hv-empty { color:var(--crow-text-muted); font-size:0.88rem; margin:0 }
</style>`;

/* --------------------------------------------------------- the change view */

/** One stored value as text (a blob is shown as its byte length, not as bytes). */
function showValue(value) {
  if (value === null || value === undefined) return "—";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[${Buffer.isBuffer(value) ? value.length : value.byteLength} bytes]`;
  }
  if (typeof value === "object") {
    try {
      return clip(JSON.stringify(value), MAX_LINE_CHARS);
    } catch {
      return "[value]";
    }
  }
  return clip(String(value), MAX_LINE_CHARS);
}

/** A text field's changed lines, neutral words and no context padding. */
function renderLines(change, lang) {
  const changed = (change.lines || []).filter((line) => line.op === "+" || line.op === "-");
  const shown = changed.slice(0, MAX_DIFF_LINES);
  const rows = shown
    .map((line) => {
      const isAdd = line.op === "+";
      return `<div class="hv-line ${isAdd ? "hv-add" : "hv-rem"}"><span class="hv-mark">${isAdd ? "+" : "−"}</span>${escapeHtml(
        clip(line.text ?? "", MAX_LINE_CHARS),
      )}</div>`;
    })
    .join("");
  const more = changed.length > shown.length ? `<div class="hv-sub" style="margin-top:0.3rem">${escapeHtml(fill(t("history.lineMore", lang), { n: changed.length - shown.length }))}</div>` : "";
  return `<div class="hv-lines">${rows}${more}</div>`;
}

/** One field's change: a line view for text, before → after for anything else. */
function renderFieldChange(change, lang) {
  const summary =
    change.kind === "text"
      ? fill(t("history.changeCounts", lang), { added: Number(change.added) || 0, removed: Number(change.removed) || 0 })
      : t("history.changedValues", lang);
  const body =
    change.kind === "text"
      ? renderLines(change, lang)
      : `<div class="hv-values"><span class="hv-sub">${escapeHtml(t("history.before", lang))}</span> <span class="hv-value">${escapeHtml(
          showValue(change.before),
        )}</span> <span class="hv-sub">${escapeHtml(t("history.after", lang))}</span> <span class="hv-value">${escapeHtml(showValue(change.after))}</span></div>`;
  return `<details class="hv-change"><summary>${escapeHtml(`${fieldLabel(change.field, lang)}: ${summary}`)}</summary>${body}</details>`;
}

/**
 * What a version changed, against the version before it.
 *
 * `older` is the next-older version in the list (null for the oldest version on
 * the page, which has nothing to compare with). A `delete` version is shown as
 * what it removed. Both sides are the versions' stored snapshots; diffVersions
 * (servers/shared/history/api.js) decides which fields actually differ.
 */
export function renderChanges(older, newer, lang = "en") {
  if (!newer) return "";
  if (!older) {
    if (newer.op === "insert") return `<div class="hv-sub" style="margin-top:0.35rem">${escapeHtml(t("history.op.insert", lang))}</div>`;
    return `<div class="hv-sub" style="margin-top:0.35rem">${escapeHtml(t("history.noOlderVersion", lang))}</div>`;
  }
  let changes;
  try {
    changes = diffVersions(older, newer);
  } catch {
    return "";
  }
  if (changes.length === 0) return `<div class="hv-sub" style="margin-top:0.35rem">${escapeHtml(t("history.noChange", lang))}</div>`;
  return changes.map((change) => renderFieldChange(change, lang)).join("");
}

/* ---------------------------------------------------------- the item page */

/**
 * One item's versions, newest first, with the change each made and a Restore
 * button per version.
 *
 * @param {object} page
 * @param {string} page.itemType covered item type
 * @param {string} page.itemId
 * @param {object[]} page.versions listVersions rows, newest first, WITH the one
 *   extra row that is the next-older version of the last one shown (or none)
 * @param {number} page.shown how many of `versions` to display
 * @param {boolean} page.hasMore whether older versions exist than this page shows
 * @param {string|null} page.before the cursor of this page, for the "newer" link
 * @param {{bots: Map, machines: Map}} page.who
 * @param {string} page.csrf
 */
export function renderVersionList({ itemType, itemId, versions = [], shown = versions.length, hasMore = false, before = null, who = {}, csrf = "", lang = "en" } = {}) {
  const visible = versions.slice(0, shown);
  if (visible.length === 0) return `<p class="hv-empty">${escapeHtml(t("history.noVersions", lang))}</p>`;

  const path = itemHistoryPath(itemType, itemId);
  const rows = visible
    .map((version, i) => {
      const older = versions[i + 1] || null;
      const restore = `<form method="POST" data-turbo="false" action="${escapeHtml(path)}" class="hv-actions">${csrfField(csrf)}
        <input type="hidden" name="action" value="restore">
        <input type="hidden" name="version_id" value="${escapeHtml(String(version.id))}">
        <button type="submit" class="btn btn-sm btn-secondary">${escapeHtml(t("history.restoreVersion", lang))}</button>
      </form>`;
      return `<div class="hv-row" id="version-${escapeHtml(String(version.id))}">
        <div class="hv-meta"><span class="hv-who">${escapeHtml(whoLabel(version, who, lang))}</span>
          <span>${escapeHtml(formatWhen(version.createdAt, lang))}</span>
          <span>${escapeHtml(opWord(version.op, lang))}</span>
          ${version.redacted ? `<span>${escapeHtml(t("history.redactedBadge", lang))}</span>` : ""}</div>
        ${renderChanges(older, version, lang)}
        ${restore}
      </div>`;
    })
    .join("");

  const olderLink = hasMore
    ? `<a href="${escapeHtml(`${path}?before=${encodeURIComponent(String(visible[visible.length - 1].id))}`)}">${escapeHtml(t("history.olderLink", lang))}</a>`
    : "";
  const newerLink = before
    ? `<a href="${escapeHtml(path)}">${escapeHtml(t("history.newerLink", lang))}</a>`
    : "";
  const pager = olderLink || newerLink ? `<div class="hv-pager">${newerLink}${olderLink}</div>` : "";
  return `${rows}${pager}`;
}

/** The item page as a whole (layout is the caller's: the panel wraps it). */
export function renderItemPage({
  itemType,
  itemId,
  versions = [],
  shown,
  hasMore = false,
  before = null,
  who = {},
  csrf = "",
  notice = null,
  banner = false,
  lang = "en",
} = {}) {
  const label = itemLabel(itemType, versions[0] && versions[0].snapshot);
  const back = backHref(itemType);
  const backLink = back ? `<p style="margin:0.75rem 0 0"><a href="${escapeHtml(back.href)}">${escapeHtml(t(back.key, lang))}</a></p>` : "";
  const body = renderVersionList({ itemType, itemId, versions, shown, hasMore, before, who, csrf, lang }) + backLink;
  return `<div data-hv-item="${escapeHtml(String(itemType))}">
    ${CSS}
    ${banner ? renderContainmentBanner(lang) : ""}
    ${navStrip("item", lang)}
    ${renderNotice(notice)}
    ${section(t("history.versionsTitle", lang), `<p class="hv-label" style="margin:0 0 0.5rem">${escapeHtml(typeWord(itemType, lang))}: ${escapeHtml(
      label,
    )}</p>${body}`)}
  </div>`;
}

/* ---------------------------------------------------------- the jobs page */

/** The plain label of a job id (`session:abcd1234`, `card:7`, …). */
export function jobLabel(jobId, lang = "en") {
  const id = String(jobId == null ? "" : jobId);
  const [kind, ...rest] = id.split(":");
  const ref = rest.join(":");
  if (kind === "session") return t("history.job.session", lang);
  if (kind === "card") return fill(t("history.job.card", lang), { id: ref });
  if (kind === "handoff") return fill(t("history.job.handoff", lang), { id: ref });
  if (kind === "turn") return fill(t("history.job.turn", lang), { id: ref });
  if (kind === "schedule") return fill(t("history.job.schedule", lang), { id: ref });
  if (kind === "undo") return t("history.job.undo", lang);
  return fill(t("history.job.other", lang), { id });
}

/** Skip reasons in plain words (`edited_after` is the design's named one). */
export function reasonText(reason, lang = "en") {
  const key = `history.reason.${String(reason == null ? "" : reason)}`;
  const text = t(key, lang);
  return text === key ? t("history.reason.failed", lang) : text;
}

/** Is this a job the Jobs page offers to undo? (An undo of a job is not.) */
export function jobCanBeUndone(jobId) {
  return !String(jobId == null ? "" : jobId).startsWith("undo:");
}

/**
 * The Jobs page: recent jobs newest first, each with its items and an
 * "Undo this job" button.
 *
 * @param {object} page
 * @param {Array<{jobId: string, authorKind: string, authorId: string|null, at: string,
 *   items: Array<{itemType: string, itemId: string, label: string}>}>} page.jobs
 */
export function renderJobsList({ jobs = [], hasMore = false, before = null, who = {}, csrf = "", lang = "en" } = {}) {
  if (jobs.length === 0) return `<p class="hv-empty">${escapeHtml(t("history.noJobs", lang))}</p>`;
  const rows = jobs
    .map((job) => {
      const n = Number(job.itemCount) > 0 ? Number(job.itemCount) : job.items.length;
      const count = n === 1 ? t("history.jobSummaryOne", lang) : fill(t("history.jobSummary", lang), { n });
      const items = job.items
        .map((item) => {
          const href = itemHistoryPath(item.itemType, item.itemId);
          return `<li><a href="${escapeHtml(href)}">${escapeHtml(typeWord(item.itemType, lang))}</a>: ${escapeHtml(item.label)}</li>`;
        })
        .join("");
      const undo = jobCanBeUndone(job.jobId)
        ? `<form method="POST" data-turbo="false" action="${escapeHtml(JOBS_PATH)}" class="hv-actions">${csrfField(csrf)}
            <input type="hidden" name="action" value="undo_job">
            <input type="hidden" name="job_id" value="${escapeHtml(String(job.jobId))}">
            <button type="submit" class="btn btn-sm btn-secondary">${escapeHtml(t("history.undoJob", lang))}</button>
          </form>`
        : "";
      return `<div class="hv-row">
        <div class="hv-label">${escapeHtml(jobLabel(job.jobId, lang))}</div>
        <div class="hv-meta"><span class="hv-who">${escapeHtml(whoLabel(job, who, lang))}</span>
          <span>${escapeHtml(formatWhen(job.at, lang))}</span><span>${escapeHtml(count)}</span></div>
        <ul class="hv-sub" style="margin:0.25rem 0 0;padding-left:1.2rem">${items}</ul>
        ${undo}
      </div>`;
    })
    .join("");
  const older = hasMore
    ? `<a href="${escapeHtml(`${JOBS_PATH}?before=${encodeURIComponent(String(jobs[jobs.length - 1].lastId))}`)}">${escapeHtml(t("history.olderJobs", lang))}</a>`
    : "";
  const newer = before ? `<a href="${escapeHtml(JOBS_PATH)}">${escapeHtml(t("history.newerJobs", lang))}</a>` : "";
  return `${rows}${older || newer ? `<div class="hv-pager">${newer}${older}</div>` : ""}`;
}

/** The Jobs page as a whole. */
export function renderJobsPage({ jobs = [], hasMore = false, before = null, who = {}, csrf = "", notice = null, banner = false, lang = "en" } = {}) {
  return `<div data-hv-page="jobs">
    ${CSS}
    ${banner ? renderContainmentBanner(lang) : ""}
    ${navStrip("jobs", lang)}
    ${renderNotice(notice)}
    ${section(t("history.jobsTitle", lang), `<p class="hv-sub" style="margin:0 0 0.75rem">${escapeHtml(
      t("history.jobsIntro", lang),
    )}</p>${renderJobsList({ jobs, hasMore, before, who, csrf, lang })}`)}
  </div>`;
}

/* --------------------------------------------------------- the Trash page */

/**
 * The Trash: one row per deleted item, with its type, a short preview, when and
 * by whom it was deleted, a Restore button, and the note with the configured
 * number of days.
 */
export function renderTrashList({ items = [], csrf = "", lang = "en" } = {}) {
  if (items.length === 0) return `<p class="hv-empty">${escapeHtml(t("history.trashEmpty", lang))}</p>`;
  return items
    .map((item) => {
      const label = itemLabel(item.itemType, item.snapshot);
      const who = whoLabel({ authorKind: item.deletedBy?.authorKind, authorId: item.deletedBy?.authorId }, item.who || {}, lang);
      return `<div class="hv-row">
        <div class="hv-label">${escapeHtml(typeWord(item.itemType, lang))}: ${escapeHtml(label)}</div>
        <div class="hv-sub">${escapeHtml(fill(t("history.deletedLine", lang), { when: formatWhen(item.deletedAt, lang), who }))}</div>
        <form method="POST" data-turbo="false" action="${escapeHtml(TRASH_PATH)}" class="hv-actions">${csrfField(csrf)}
          <input type="hidden" name="action" value="trash_restore">
          <input type="hidden" name="item_type" value="${escapeHtml(String(item.itemType))}">
          <input type="hidden" name="item_id" value="${escapeHtml(String(item.itemId))}">
          <button type="submit" class="btn btn-sm btn-secondary">${escapeHtml(t("history.restore", lang))}</button>
        </form>
      </div>`;
    })
    .join("");
}

/**
 * The Trash page as a whole. `confirming` renders the in-page confirm step for
 * Empty Trash (two buttons in one POST-less step — no script, no dialog).
 */
export function renderTrashPage({ items = [], trashDays = 30, csrf = "", notice = null, banner = false, confirming = false, lang = "en" } = {}) {
  const note = `<p class="hv-sub" style="margin:0 0 0.75rem">${escapeHtml(fill(t("history.trashNote", lang), { n: trashDays }))}</p>`;
  const confirm = confirming
    ? `<div class="hv-notice hv-notice-error">
        <div class="hv-notice-head">${escapeHtml(t("history.emptyTrashAsk", lang))}</div>
        <form method="POST" data-turbo="false" action="${escapeHtml(TRASH_PATH)}" class="hv-actions">${csrfField(csrf)}
          <input type="hidden" name="action" value="empty_trash">
          <input type="hidden" name="confirm" value="1">
          <button type="submit" class="btn btn-sm btn-danger">${escapeHtml(t("history.emptyTrashYes", lang))}</button>
          <a class="btn btn-sm btn-secondary" href="${escapeHtml(TRASH_PATH)}">${escapeHtml(t("history.emptyTrashNo", lang))}</a>
        </form>
      </div>`
    : `<form method="POST" data-turbo="false" action="${escapeHtml(TRASH_PATH)}" class="hv-actions">${csrfField(csrf)}
        <input type="hidden" name="action" value="empty_trash">
        <button type="submit" class="btn btn-sm btn-secondary"${items.length === 0 ? " disabled" : ""}>${escapeHtml(
          t("history.emptyTrash", lang),
        )}</button>
      </form>`;
  return `<div data-hv-page="trash">
    ${CSS}
    ${banner ? renderContainmentBanner(lang) : ""}
    ${navStrip("trash", lang)}
    ${renderNotice(notice)}
    ${section(t("history.trashTitle", lang), `${note}${confirm}${renderTrashList({ items, csrf, lang })}`)}
  </div>`;
}

/* ---------------------------------------------------------------- the index */

/** `/dashboard/history` itself: the two pages that have no item of their own. */
export function renderHistoryIndex({ banner = false, lang = "en" } = {}) {
  const card = (href, titleKey, introKey) =>
    `<div class="hv-row"><div class="hv-label"><a href="${escapeHtml(href)}">${escapeHtml(t(titleKey, lang))}</a></div>
      <div class="hv-sub">${escapeHtml(t(introKey, lang))}</div></div>`;
  return `<div data-hv-page="index">
    ${CSS}
    ${banner ? renderContainmentBanner(lang) : ""}
    ${section(
      t("history.pageTitle", lang),
      `<p class="hv-sub" style="margin:0 0 0.75rem">${escapeHtml(t("history.indexIntro", lang))}</p>
       ${card(JOBS_PATH, "history.jobsTitle", "history.jobsIntro")}
       ${card(TRASH_PATH, "history.trashTitle", "history.indexTrashIntro")}`,
    )}
  </div>`;
}

/** A refusal page: no data read, one sentence saying why. */
export function renderRefusal(message, lang = "en") {
  return `${CSS}<div class="hv-notice hv-notice-error" role="alert">${escapeHtml(message)}</div>`;
}

/** A plain "not here" page (an unknown item type, a malformed id). */
export function renderNotFound(lang = "en") {
  return `${CSS}<div class="hv-notice hv-notice-info">${escapeHtml(t("history.notFound", lang))}</div>`;
}