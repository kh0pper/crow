/**
 * Crow's Nest Panel — Contacts
 *
 * Full-featured contact management: card grid, profiles, groups,
 * manual contacts, vCard import/export, own-profile editing.
 *
 * Orchestrator: imports modular CSS, HTML, client JS, data queries, and POST handlers.
 */

import { contactsCss } from "./contacts/css.js";
import { renderContactList, renderContactProfile, renderGroupManager, renderMyProfile } from "./contacts/html.js";
import { contactsClientJs } from "./contacts/client.js";
import { getContacts, getContact, getContactActivity, getGroups, getMyProfile } from "./contacts/data-queries.js";
import { handleContactAction } from "./contacts/api-handlers.js";
import { section } from "../shared/components.js";
import { t } from "../shared/i18n.js";

export default {
  id: "contacts",
  name: "Contacts",
  icon: "contacts",
  route: "/dashboard/contacts",
  navOrder: 12,
  category: "core",

  async handler(req, res, { db, layout, lang }) {
    // --- Handle POST actions ---
    if (req.method === "POST") {
      const result = await handleContactAction(req, db);
      if (result?.redirect) return res.redirectAfterPost(result.redirect);
      if (result?.download) {
        res.setHeader("Content-Type", "text/vcard; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=contacts.vcf");
        return res.send(result.download);
      }
    }

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

    if (view === "contact" && contactId) {
      // --- Contact Profile ---
      const contact = await getContact(db, contactId);
      const activities = contact ? await getContactActivity(db, contact.id) : [];
      bodyHtml = renderContactProfile(contact, activities, groups, groups, lang);
    } else if (view === "groups") {
      // --- Group Manager ---
      const contacts = await getContacts(db, { limit: 500 });
      bodyHtml = renderGroupManager(groups, contacts, lang);
    } else if (view === "profile") {
      // --- My Profile ---
      const profile = await getMyProfile(db);
      bodyHtml = renderMyProfile(profile, lang);
    } else {
      // --- All Contacts (default) ---
      const filters = {
        search: req.query.search || "",
        groupId: req.query.groupId || "",
        type: req.query.type || "all",
      };
      const contacts = await getContacts(db, filters);
      bodyHtml = renderContactList(contacts, groups, filters, lang);
    }

    // Build tabs HTML
    let tabsHtml = "";
    if (showTabs) {
      const tabs = [
        { id: "all", label: t("contacts.tabAll", lang) },
        { id: "groups", label: t("contacts.tabGroups", lang) },
        { id: "profile", label: t("contacts.tabProfile", lang) },
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
