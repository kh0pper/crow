/**
 * Settings Section: Sharing between Crows (Other Crows group).
 *
 * One page for what a paired Crow may do here. It composes the three Remote-*
 * sections (tool exposure, tool invocation, bot management), which stay
 * registered (hidden, deep-linkable) so their forms, POST actions and old links
 * keep working. Only shown in the menu once a trusted second Crow is paired.
 */
import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";
import remoteExposure from "./remote-exposure.js";
import remoteInvocation from "./remote-invocation.js";
import remoteBotManagement from "./remote-bot-management.js";

const PARTS = [remoteExposure, remoteInvocation, remoteBotManagement];
const BACK = "/dashboard/settings?section=other-crows-sharing";

export default {
  id: "other-crows-sharing",
  group: "otherCrows",
  hiddenUnless: "peer",
  icon: remoteExposure.icon,
  labelKey: "settings.section.otherCrowsSharing",
  navOrder: 20,

  async getPreview(ctx) {
    try { return await remoteExposure.getPreview(ctx); } catch { return ""; }
  },

  async render(ctx) {
    let html = "";
    for (const part of PARTS) {
      html += `<section style="margin-bottom:2rem">
        <h3 style="font-size:1rem;margin:0 0 0.75rem">${escapeHtml(t(part.labelKey, ctx.lang))}</h3>
        ${await part.render(ctx)}
      </section>`;
    }
    return html;
  },

  async handleAction(ctx) {
    // The parts redirect to their own page after saving; keep the user here.
    const res = ctx.res && typeof ctx.res.redirectAfterPost === "function"
      ? Object.create(ctx.res, { redirectAfterPost: { value: () => ctx.res.redirectAfterPost(BACK) } })
      : ctx.res;
    for (const part of PARTS) {
      const handled = await part.handleAction({ ...ctx, res });
      if (handled) return handled;
    }
    return false;
  },
};
