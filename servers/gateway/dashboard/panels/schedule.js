/**
 * Schedule panel — every Crow schedule in one agenda: reminders, bot routines and the News
 * briefing, each once at its next run, with a problems strip on top (each problem with its fix)
 * and one detail pane (next 3 runs, last 10 runs, controls).
 *
 * The model is servers/gateway/schedule-catalog.js; the buttons are schedule-actions.js. Writes
 * are plain POST forms (CSRF field + Turbo's header, 303 after POST), refused unless the request
 * is the owner's own password session at this Crow (never a peer sign-in or a signed peer call). Delete takes two POSTs: the first only opens the confirm.
 * The briefing's controls are links to News → Briefings, which owns that row.
 *
 * Read-only sources (schedule-sources/: the box hold, the box ledger, the machines' timers) are
 * shown with no controls. Every POST names a Crow schedule by its numeric id, so a read-only
 * ref (box:…, timer:…) is refused with 400 before any action runs. Only the owner's own session
 * (the rule writes use) sees these sources at all; a peer's sign-in sees Crow's schedules only.
 */
import { t } from "../shared/i18n.js";
import { escapeHtml, section } from "../shared/components.js";
import { buildScheduleModel, scheduleOfRun } from "../../schedule-catalog.js";
import { createReminder, previewWhen, pauseSchedule, resumeSchedule, runScheduleNow, deleteScheduleRow, ackRun, claimRun, releaseRun } from "../../schedule-actions.js";
import { isLocalPasswordSession } from "../local-session.js";
import { engineStatus } from "../../bot-engine-status.js";
import { botRuntimeActive } from "./bot-runtime-flag.js";
import { getPanel } from "../panel-registry.js";
import { renderSchedulePage } from "./schedule/html.js";
import { SCHEDULE_CSS } from "./schedule/css.js";
import { scheduleClientJs } from "./schedule/client.js";

const ROUTE = "/dashboard/schedule";
const FIELDS = ["action", "id", "run", "confirm", "text", "when", "cron", "tz", "type", "_csrf"];

/** A request field as a string, or null when absent / repeated / not a string. */
const one = (v) => (typeof v === "string" ? v : null);
const intOf = (v) => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null);

/**
 * Writes are the owner's at this machine's own dashboard: a local password session only. A
 * session a peer sign-in minted (scopes 'dashboard sso') and a signed peer call both read only.
 */
export const isOwnerRequest = (req) => isLocalPasswordSession(req);

/** Whether bots run here at all: the engine is installed and the bot runtime is on. */
const BOT_GATE = {
  engine: () => { try { return engineStatus().state; } catch { return "ready"; } },
  runtimeOn: (db) => botRuntimeActive(db),
};
let botGate = BOT_GATE;
/** Test seam: replace the bot engine / runtime probes ({engine, runtimeOn}); null restores them. */
export function _setBotGateForTest(gate) { botGate = gate ? { ...BOT_GATE, ...gate } : BOT_GATE; }

const DONE = {
  created: "schedule.toast.created", paused: "schedule.toast.paused", resumed: "schedule.toast.resumed", ran: "schedule.toast.ran",
  queued: "schedule.toast.queued", "already-queued": "schedule.toast.alreadyQueued", deleted: "schedule.toast.deleted", dismissed: "schedule.toast.dismissed",
  "already-done": "schedule.toast.alreadyDone",
};
const ERRORS = {
  "not-found": "schedule.err.notFound", owned: "schedule.err.owned", "not-runnable": "schedule.err.notRunnable", "once-passed": "schedule.err.oncePassed",
  "bad-cron": "schedule.err.badCron", "cant-run": "schedule.err.cantRun", "delivery-failed": "schedule.err.deliveryFailed", "bad-request": "schedule.err.badRequest",
};

/** GET /dashboard/schedule/preview?when=&cron=&tz=&lang= → the read-back as JSON (session-gated by the dashboard router). */
export async function schedulePreview(req, res, db) {
  const q = req.query || {};
  const lang = one(q.lang) === "es" ? "es" : "en";
  const when = (one(q.when) ?? "").slice(0, 4000);
  const cron = (one(q.cron) ?? "").slice(0, 200);
  const p = await previewWhen(db, { when, cron, tz: one(q.tz), lang });
  res.set("Cache-Control", "no-store");
  res.json(p.ok ? { ok: true, summary: p.summary, next3: p.next3, zone: p.zone } : { ok: false, code: p.code, hint: p.hint });
}

export default {
  id: "schedule",
  name: "Schedule",
  icon: "schedule",
  route: ROUTE,
  // The first free value after Skills' 35 (36–40 are taken by core and bundle panels).
  navOrder: 41,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    const page = (status, content) => { if (status) res.status(status); return layout({ title: t("schedule.pageTitle", lang), content }); };
    const refuse = (status, key) => page(status, section(t("schedule.pageTitle", lang), `<p>${escapeHtml(t(key, lang))}</p><a href="${ROUTE}" class="btn btn-secondary">${escapeHtml(t("schedule.back", lang))}</a>`));
    let create = null;

    if (req.method === "POST") {
      if (!(await isOwnerRequest(req))) return refuse(403, "schedule.err.ownerOnly");
      const body = req.body || {};
      // A repeated field arrives as an array: refuse it rather than guess.
      for (const k of FIELDS) if (body[k] !== undefined && typeof body[k] !== "string") return refuse(400, "schedule.err.badRequest");
      const action = one(body.action);
      const id = intOf(body.id);
      const to = (sid, params) => {
        const q = new URLSearchParams();
        if (sid) q.set("id", `crow:${sid}`);
        for (const [k, v] of Object.entries(params || {})) q.set(k, v);
        const s = q.toString();
        res.redirectAfterPost(ROUTE + (s ? "?" + s : "") + (sid ? `#sc-${sid}` : ""));
      };
      const result = (sid, r, done) => (r.ok ? to(sid, { done }) : to(r.code === "not-found" ? null : sid, { error: r.code }));

      if (action === "create" || action === "preview") {
        const typed = { text: one(body.text) ?? "", when: one(body.when) ?? "", cron: one(body.cron) ?? "", tz: one(body.tz) ?? "" };
        if (action === "preview") {
          // The no-JS preview: the sheet again, filled in, with the read-back (422 so Turbo renders it).
          const p = await previewWhen(db, { when: typed.when, cron: typed.cron, tz: typed.tz, lang });
          create = { typed, preview: p, focus: "when" };
          res.status(422);
        } else {
          const r = await createReminder(db, { text: typed.text, when: typed.when, cron: typed.cron, tz: typed.tz, lang });
          if (r.ok) { to(r.id, { done: "created" }); return; }
          const msg = r.code === "empty-text" ? t("schedule.err.emptyText", lang)
            : r.code === "text-too-long" ? t("schedule.err.textTooLong", lang)
              : r.code === "bad-text" ? t("schedule.err.badText", lang)
                : r.code === "too-frequent" ? t("schedule.err.tooFrequent", lang)
                  : r.hint || t("schedule.previewBad", lang);
          create = { typed, error: msg, preview: r.words || null, focus: /text/.test(r.code) ? "text" : "when" };
          res.status(422);
        }
      } else if (action === "ack-run") {
        const r = await ackRun(db, intOf(body.run));
        return result(r.ok ? r.scheduleId : null, r, "dismissed");
      } else if (id === null) {
        return refuse(400, "schedule.err.badRequest");
      } else if (action === "pause") {
        return result(id, await pauseSchedule(db, id), "paused");
      } else if (action === "resume" || action === "run-now") {
        // A fix from the strip names its run: claim (dismiss) it first, so the problem leaves the
        // strip and a second click finds it claimed and sends nothing; undo the claim on failure.
        const runId = one(body.run) === null ? null : intOf(body.run);
        if (one(body.run) !== null && runId === null) return refuse(400, "schedule.err.badRequest");
        if (runId !== null && !(await claimRun(db, runId, id))) return to(id, { done: "already-done" });
        const botReady = async () => botGate.engine() !== "absent" && (await botGate.runtimeOn(db));
        const r = action === "resume" ? await resumeSchedule(db, id) : await runScheduleNow(db, id, { botReady });
        if (!r.ok && runId !== null) await releaseRun(db, runId);
        return result(id, r, action === "resume" ? "resumed" : r.kind === "bot_routine" ? (r.already ? "already-queued" : "queued") : "ran");
      } else if (action === "delete") {
        // Step one only opens the confirm (real page text, no window.confirm); step two deletes.
        if (one(body.confirm) !== "1") return to(id, { confirm: "delete" });
        const r = await deleteScheduleRow(db, id);
        return r.ok ? to(null, { done: "deleted" }) : to(id, { error: r.code });
      } else {
        return refuse(400, "schedule.err.badRequest");
      }
    }

    const query = create ? {} : (req.query || {});
    let selected = null;
    const idParam = one(query.id);
    if (idParam && /^crow:\d{1,12}$/.test(idParam)) selected = Number(idParam.slice(5));
    const runParam = intOf(one(query.run));
    if (selected === null && runParam !== null) selected = await scheduleOfRun(db, runParam);

    const show = one(query.show);
    const model = await buildScheduleModel(db, {
      lang, selected, show: show || "all",
      // Only the owner's own session sees the box and machine data (the same rule as writes).
      readOnly: await isOwnerRequest(req),
      engine: () => botGate.engine(),
      runtimeOn: () => botGate.runtimeOn(db),
    });
    // An id that is not (or no longer) a schedule: the plain page.
    // An id or run that is not (or no longer) a schedule's: the plain page, saying so.
    if (!model.detail && (idParam || runParam !== null) && !one(query.error) && !one(query.done)) { res.redirect(ROUTE + "?error=not-found"); return; }

    const done = DONE[one(query.done)] ? t(DONE[one(query.done)], lang) : null;
    const errKey = ERRORS[one(query.error)];
    const notice = errKey ? { kind: "err", text: t(errKey, lang) } : done && model.detail ? { kind: "ok", text: done } : null;
    const content = SCHEDULE_CSS + renderSchedulePage({
      ...model,
      lang,
      csrf: req.csrfToken || "",
      toast: done && !model.detail ? done : null,
      notice: model.detail ? notice : null,
      pageNotice: !model.detail ? (errKey ? notice : null) : null,
      confirmDelete: !!model.detail && one(query.confirm) === "delete" && !model.detail.item.owned,
      create,
      createOpen: one(query.new) === "1",
      mediaInstalled: !!getPanel("media"),
      sources: model.sources,
      filter: model.filter,
    }) + scheduleClientJs();
    return page(0, content);
  },
};
