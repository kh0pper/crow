/**
 * Crow's Nest Panel — Contacts
 *
 * Full-featured contact management: card grid, profiles, groups,
 * manual contacts, vCard import/export, own-profile editing.
 *
 * Orchestrator: imports modular CSS, HTML, client JS, data queries, and POST handlers.
 */

import { contactsCss } from "./contacts/css.js";
import { renderContactList, renderContactProfile, renderDeleteConfirm, renderGroupManager, renderMyProfile } from "./contacts/html.js";
import { contactsClientJs } from "./contacts/client.js";
import { getContacts, getContact, getContactActivity, getGroups, getMyProfile } from "./contacts/data-queries.js";
import { handleContactAction } from "./contacts/api-handlers.js";
import { section } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { buildInviteShare, parseShortCodeResult } from "../shared/peer-invite-ui.js";
import { csrfInput } from "../shared/csrf.js";

export default {
  id: "contacts",
  name: "Contacts",
  icon: "contacts",
  route: "/dashboard/contacts",
  navOrder: 12,
  category: "core",

  async handler(req, res, { db, layout, lang }) {
    // --- Handle POST actions ---
    let peerAdd = {};
    if (req.method === "POST") {
      const result = await handleContactAction(req, db);
      if (result?.redirect) return res.redirectAfterPost(result.redirect);
      if (result?.download) {
        res.setHeader("Content-Type", "text/vcard; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=contacts.vcf");
        return res.send(result.download);
      }
      if (result?.inviteResult) {
        try { peerAdd.inviteShare = await buildInviteShare(result.inviteResult); } catch {}
        if (!peerAdd.inviteShare) peerAdd.inviteError = "Invite generated but could not be rendered — use the Messages panel.";
      }
      if (result?.shortCodeResult) {
        try { peerAdd.shortCodeShare = parseShortCodeResult(result.shortCodeResult); } catch {}
        if (!peerAdd.shortCodeShare) peerAdd.inviteError = "Short code generated but could not be rendered — try again.";
      }
      if (result?.inviteError) peerAdd.inviteError = result.inviteError;
    }
    peerAdd.csrf = csrfInput(req);
    // F-UI-3: whitelisted post-redirect success flash (?flash=peer_added).
    if (req.query.flash === "peer_added") peerAdd.flash = t("contacts.peerAddedFlash", lang);

    // --- Determine view ---
    const view = req.query.view || "all";
    const contactId = req.query.contact ? parseInt(req.query.contact) : null;

    // --- Fetch common data ---
    const groups = await getGroups(db);

    let bodyHtml = "";
    const css = contactsCss();
    const js = contactsClientJs();

    // Tab bar (not shown on contact detail view)
    const showTabs = view !== "contact";

    if (view === "contact" && contactId && req.query.confirm === "delete") {
      // --- Delete confirmation interstitial (F-CONTACT-1, design §4.2) ---
      // GET only; strictly side-effect-free (csrfMiddleware guards the POST, not
      // this GET). Reads the blast-radius counts and renders Block/Cancel/Delete.
      const contact = await getContact(db, contactId);
      const { deleteContactCascadePreview } = await import("../../../sharing/contact-delete.js");
      const preview = contact
        ? await deleteContactCascadePreview(db, contact.id)
        : { messages: 0, sharedItems: 0, groups: 0, projectsOwned: 0, projectMemberships: 0 };
      bodyHtml = renderDeleteConfirm(contact, preview, lang, peerAdd.csrf);
    } else if (view === "contact" && contactId) {
      // --- Contact Profile ---
      const contact = await getContact(db, contactId);
      const activities = contact ? await getContactActivity(db, contact.id) : [];
      const { loadOrCreateIdentity } = await import("../../../sharing/identity.js");
      let myEd = "";
      try { myEd = loadOrCreateIdentity().ed25519Pubkey || ""; } catch {}
      bodyHtml = renderContactProfile(contact, activities, groups, groups, lang, myEd);
    } else if (view === "groups") {
      // --- Group Manager ---
      const contacts = await getContacts(db, { limit: 500 });
      bodyHtml = renderGroupManager(groups, contacts, lang);
    } else if (view === "profile") {
      // --- My Profile ---
      const profile = await getMyProfile(db);
      bodyHtml = renderMyProfile(profile, lang);
    } else if (view === "bots") {
      // --- Browse Crow Bots Directory ---
      const { getBotDirectory } = await import("./messages/data-queries.js");
      const { buildBotDirectory } = await import("../shared/bot-directory.js");
      const { csrfInput } = await import("../shared/csrf.js");
      // A RENDER — one of only two call sites that opt into the stale-contact prune.
      const dir = await getBotDirectory(db, { prune: true })
        .catch(() => ({ groups: [], total: 0, notAddedCount: 0, perInstance: new Map() }));
      bodyHtml = buildBotDirectory({ groups: dir.groups, context: "contacts", csrf: csrfInput(req), lang });
    } else {
      // --- All Contacts (default) ---
      const filters = {
        search: req.query.search || "",
        groupId: req.query.groupId || "",
        type: req.query.type || "all",
      };
      const contacts = await getContacts(db, filters);
      bodyHtml = renderContactList(contacts, groups, filters, lang, peerAdd);
    }

    // Build tabs HTML
    let tabsHtml = "";
    if (showTabs) {
      const tabs = [
        { id: "all", label: t("contacts.tabAll", lang) },
        { id: "groups", label: t("contacts.tabGroups", lang) },
        { id: "profile", label: t("contacts.tabProfile", lang) },
        { id: "bots", label: t("contacts.browseBots", lang) },
      ];
      tabsHtml = `<div class="contacts-tabs">
        ${tabs.map((tab) =>
          `<a href="/dashboard/contacts?view=${tab.id}" class="contacts-tab${view === tab.id ? " active" : ""}">${tab.label}</a>`
        ).join("")}
      </div>`;
    }

    const content = css + tabsHtml + bodyHtml + js;

    return layout({ title: t("nav.contacts", lang), content });
  },
};
