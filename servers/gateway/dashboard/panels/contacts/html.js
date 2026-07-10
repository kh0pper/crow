/**
 * Contacts Panel — HTML Templates
 *
 * Builder functions for contact list, profile, groups, own profile, import/export.
 * All user-visible text escaped via escapeHtml() for XSS prevention.
 */

import { escapeHtml, badge, formField } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { renderInviteShare, renderPeerInviteForms, renderShortCodeShare, renderShortCodeForms } from "../../shared/peer-invite-ui.js";
import { computeSafetyNumber } from "../../../../sharing/identity.js";

/** Color palette for contact avatars (deterministic by contact ID) */
const AVATAR_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981",
  "#06b6d4", "#f43f5e", "#84cc16", "#d946ef", "#0ea5e9",
];

function avatarColor(id) {
  return AVATAR_COLORS[(id || 0) % AVATAR_COLORS.length];
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function avatarHtml(contact, size = "small") {
  const cls = size === "large" ? "profile-avatar-large" : "contact-avatar";
  const color = avatarColor(contact.id);

  if (contact.avatar_url) {
    return `<div class="${cls}" style="background:${color}"><img src="${escapeHtml(contact.avatar_url)}" alt="" loading="lazy"></div>`;
  }
  const name = contact.display_name || contact.name || "";
  return `<div class="${cls}" style="background:${color}">${escapeHtml(initials(name))}</div>`;
}

function typeBadge(contact, lang) {
  if (contact.is_blocked) return badge(t("contacts.blocked", lang), "error");
  if (contact.contact_type === "manual") return badge(t("contacts.manual", lang), "draft");
  return badge(t("contacts.crow", lang), "connected");
}

function groupChips(contact, allGroups) {
  if (!contact.group_ids) return "";
  const ids = String(contact.group_ids).split(",").map(Number);
  return ids.map((gid) => {
    const g = allGroups.find((grp) => grp.id === gid);
    if (!g) return "";
    return `<span class="group-chip" style="background:${escapeHtml(g.color || "#6366f1")}">${escapeHtml(g.name)}</span>`;
  }).filter(Boolean).join("");
}

/**
 * Tab bar for switching between views.
 */
function renderTabs(activeView, lang) {
  const tabs = [
    { id: "all", label: t("contacts.tabAll", lang) },
    { id: "groups", label: t("contacts.tabGroups", lang) },
    { id: "profile", label: t("contacts.tabProfile", lang) },
  ];
  return `<div class="contacts-tabs">
    ${tabs.map((tab) =>
      `<a href="/dashboard/contacts?view=${tab.id}" class="contacts-tab${activeView === tab.id ? " active" : ""}">${escapeHtml(tab.label)}</a>`
    ).join("")}
  </div>`;
}

// ──────────────────────────────────────────────
// Contact List (card grid)
// ──────────────────────────────────────────────

export function renderContactList(contacts, groups, filters, lang, peerAdd = {}) {
  const { search = "", groupId = "", type = "all" } = filters;

  const toolbar = `<div class="contacts-toolbar">
    <input type="text" class="contacts-search" id="contactsSearch"
      placeholder="${escapeHtml(t("contacts.searchPlaceholder", lang))}"
      value="${escapeHtml(search)}"
      oninput="filterContactsClient(this.value)">
    <select class="contacts-filter-select" onchange="location.href='/dashboard/contacts?type='+this.value${search ? `+'&search=${encodeURIComponent(search)}'` : ""}">
      <option value="all"${type === "all" ? " selected" : ""}>${t("contacts.typeAll", lang)}</option>
      <option value="crow"${type === "crow" ? " selected" : ""}>${t("contacts.typeCrow", lang)}</option>
      <option value="manual"${type === "manual" ? " selected" : ""}>${t("contacts.typeManual", lang)}</option>
    </select>
    ${groups.length > 0 ? `
    <select class="contacts-filter-select" onchange="location.href='/dashboard/contacts?groupId='+this.value${type !== "all" ? `+'&type=${type}'` : ""}">
      <option value="">${t("contacts.allGroups", lang)}</option>
      ${groups.map((g) =>
        `<option value="${g.id}"${String(groupId) === String(g.id) ? " selected" : ""}>${escapeHtml(g.name)}</option>`
      ).join("")}
    </select>` : ""}
    <button class="btn btn-sm btn-secondary" onclick="document.getElementById('importModal').classList.add('visible')">${t("contacts.import", lang)}</button>
    <form method="POST" style="display:inline"><input type="hidden" name="action" value="export_vcard"><button type="submit" class="btn btn-sm btn-secondary">${t("contacts.export", lang)}</button></form>
  </div>`;

  // Add contact form
  const addForm = `<details style="margin-bottom:1rem">
    <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-accent);font-weight:500">${t("contacts.addManual", lang)}</summary>
    <form method="POST" style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
      <input type="hidden" name="action" value="add_manual">
      ${formField(t("contacts.fieldName", lang), "name", { required: true, placeholder: t("contacts.namePlaceholder", lang) })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
        ${formField(t("contacts.fieldEmail", lang), "email", { type: "email", placeholder: "email@example.com" })}
        ${formField(t("contacts.fieldPhone", lang), "phone", { placeholder: "+1 555 0100" })}
      </div>
      ${formField(t("contacts.fieldNotes", lang), "notes", { type: "textarea", rows: 2 })}
      <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("contacts.addContact", lang)}</button>
    </form>
  </details>`;

  // Add/repair by Crow ID form (R4: recovery path for a half-completed handshake)
  const addByIdForm = `<details style="margin-bottom:1rem">
    <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-accent);font-weight:500">${t("contacts.addById", lang)}</summary>
    <form method="POST" data-turbo="false" style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
      <input type="hidden" name="action" value="add_by_id">${peerAdd.csrf || ""}
      <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0 0 0.75rem">${t("contacts.addByIdHint", lang)}</p>
      ${formField(t("contacts.fieldCrowId", lang), "crow_id", { required: true, placeholder: "crow:abcd1234" })}
      ${formField(t("contacts.fieldSecpKey", lang), "secp256k1_pubkey", { required: true, placeholder: t("contacts.secpPlaceholder", lang) })}
      ${formField(t("contacts.fieldEd25519Key", lang), "ed25519_pubkey", { placeholder: t("contacts.ed25519Placeholder", lang) })}
      ${formField(t("contacts.fieldName", lang), "name", { placeholder: t("contacts.namePlaceholder", lang) })}
      <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("contacts.addByIdButton", lang)}</button>
    </form>
  </details>`;

  const peerForms = renderPeerInviteForms({ lang, csrf: peerAdd.csrf || "" });
  const shortCodeForms = renderShortCodeForms({ lang, csrf: peerAdd.csrf || "" });
  const peerAddSection = `<details class="contacts-add-peer" style="margin-bottom:1rem"${peerAdd.inviteShare || peerAdd.inviteError || peerAdd.shortCodeShare || peerAdd.flash ? " open" : ""}>
    <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-accent);font-weight:500">${t("contacts.addPeer", lang)}</summary>
    <div style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
      <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0 0 0.75rem">${t("contacts.addPeerDesc", lang)}</p>
      ${peerAdd.flash ? `<div style="font-size:0.85rem;color:var(--crow-success,#10b981);font-weight:600;margin-bottom:0.5rem">${escapeHtml(peerAdd.flash)}</div>` : ""}
      ${peerAdd.inviteError ? `<div style="font-size:0.8rem;color:var(--crow-error);margin-bottom:0.5rem">${escapeHtml(peerAdd.inviteError)}</div>` : ""}
      ${peerAdd.inviteShare ? renderInviteShare(peerAdd.inviteShare, lang) : ""}
      ${peerAdd.shortCodeShare ? renderShortCodeShare(peerAdd.shortCodeShare, lang) : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.5rem">
        <div>${peerForms.generateForm}</div>
        <div>${peerForms.acceptForm}</div>
      </div>
      <details style="margin-top:0.75rem">
        <summary style="cursor:pointer;font-size:0.75rem;color:var(--crow-text-muted)">${t("invite.shortCodeToggle", lang)}</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-top:0.5rem">
          <div>${shortCodeForms.generateForm}</div>
          <div>${shortCodeForms.acceptForm}</div>
        </div>
      </details>
    </div>
  </details>`;

  let gridHtml;
  if (contacts.length === 0) {
    gridHtml = `<div class="contacts-empty">
      <p style="font-size:1.1rem;margin-bottom:0.5rem">${t("contacts.noContacts", lang)}</p>
      <p style="font-size:0.85rem">${t("contacts.noContactsHint", lang)}</p>
    </div>`;
  } else {
    const cards = contacts.map((c) => {
      const chips = groupChips(c, groups);
      const meta = c.contact_type === "manual"
        ? (c.email || c.phone || t("contacts.manual", lang))
        : (c.crow_id ? c.crow_id.substring(0, 20) + "..." : "");

      return `<a href="/dashboard/contacts?view=contact&contact=${c.id}" class="contact-card" data-name="${escapeHtml((c.display_name || "").toLowerCase())}" data-type="${escapeHtml(c.contact_type || "crow")}">
        <div class="contact-card-header">
          ${avatarHtml(c)}
          <div class="contact-card-info">
            <div class="contact-card-name">${escapeHtml(c.display_name || "Unknown")}${c.verified ? ` <span class="verified-badge" title="${t("contacts.verifiedBadgeTitle", lang)}">✓</span>` : ""}</div>
            <div class="contact-card-meta">${escapeHtml(meta)}</div>
          </div>
          ${typeBadge(c, lang)}
        </div>
        ${chips ? `<div class="contact-card-groups">${chips}</div>` : ""}
      </a>`;
    }).join("");

    gridHtml = `<div class="contacts-grid" id="contactsGrid">${cards}</div>`;
  }

  // Import modal
  const importModal = renderImportModal(lang);

  return toolbar + addForm + peerAddSection + addByIdForm + gridHtml + importModal;
}

// ──────────────────────────────────────────────
// Contact Profile
// ──────────────────────────────────────────────

export function renderContactProfile(contact, activities, groups, allGroups, lang, myEd25519Pubkey = "") {
  if (!contact) {
    return `<div class="contacts-empty"><p>${t("contacts.notFound", lang)}</p></div>`;
  }

  const contactGroups = contact.group_ids
    ? String(contact.group_ids).split(",").map(Number)
    : [];

  const header = `<div class="contact-profile-header">
    ${avatarHtml(contact, "large")}
    <div class="profile-info">
      <h2>${escapeHtml(contact.display_name || "Unknown")}</h2>
      <span class="type-badge">${escapeHtml(contact.contact_type === "manual" ? t("contacts.manual", lang) : t("contacts.crow", lang))}</span>
    </div>
  </div>`;

  // Details section
  const details = [];
  if (contact.crow_id && contact.contact_type !== "manual") {
    details.push({ label: "Crow ID", value: contact.crow_id.substring(0, 32) + "..." });
  }
  if (contact.email) details.push({ label: t("contacts.fieldEmail", lang), value: contact.email });
  if (contact.phone) details.push({ label: t("contacts.fieldPhone", lang), value: contact.phone });
  if (contact.last_seen) details.push({ label: t("contacts.lastSeen", lang), value: new Date(contact.last_seen).toLocaleString() });
  if (contact.created_at) details.push({ label: t("contacts.joined", lang), value: new Date(contact.created_at).toLocaleDateString() });

  const detailsHtml = details.length > 0
    ? `<div class="profile-section">
        <div class="profile-section-title">${t("contacts.details", lang)}</div>
        ${details.map((d) => `<div class="profile-field"><span class="profile-field-label">${escapeHtml(d.label)}</span><span class="profile-field-value">${escapeHtml(d.value)}</span></div>`).join("")}
      </div>`
    : "";

  // Trust / safety-number verification (crow contacts only, when we can compute it).
  let verifyHtml = "";
  if (myEd25519Pubkey && contact.ed25519_pubkey && contact.contact_type !== "manual") {
    const safety = computeSafetyNumber(myEd25519Pubkey, contact.ed25519_pubkey);
    const isVerified = !!contact.verified;
    const toggle = isVerified
      ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="set_verified"><input type="hidden" name="contact_id" value="${contact.id}"><input type="hidden" name="verified" value="0"><button type="submit" class="btn btn-sm btn-secondary">${t("contacts.unverify", lang)}</button></form>`
      : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="set_verified"><input type="hidden" name="contact_id" value="${contact.id}"><input type="hidden" name="verified" value="1"><button type="submit" class="btn btn-sm btn-primary">${t("contacts.markVerified", lang)}</button></form>`;
    verifyHtml = `<div class="profile-section">
      <div class="profile-section-title">${t("contacts.verification", lang)}${isVerified ? ` <span class="verified-badge" title="${t("contacts.verifiedBadgeTitle", lang)}">✓ ${t("contacts.verified", lang)}</span>` : ""}</div>
      <p style="font-size:0.8rem;color:var(--crow-text-secondary)">${t("contacts.safetyNumberHelp", lang)}</p>
      <div class="profile-field"><span class="profile-field-label">${t("contacts.safetyNumber", lang)}</span><span class="profile-field-value" style="font-family:monospace;letter-spacing:0.05em">${escapeHtml(safety)}</span></div>
      <div style="margin-top:0.5rem">${toggle}</div>
    </div>`;
  }

  // Notes / bio
  const notesHtml = (contact.notes || contact.bio)
    ? `<div class="profile-section">
        <div class="profile-section-title">${t("contacts.fieldNotes", lang)}</div>
        <p style="font-size:0.85rem;color:var(--crow-text-secondary);white-space:pre-wrap">${escapeHtml(contact.notes || contact.bio || "")}</p>
      </div>`
    : "";

  // Groups
  const groupsSection = `<div class="profile-section">
    <div class="profile-section-title">${t("contacts.tabGroups", lang)}</div>
    <div style="display:flex;gap:0.35rem;flex-wrap:wrap;margin-bottom:0.5rem">
      ${contactGroups.map((gid) => {
        const g = allGroups.find((grp) => grp.id === gid);
        if (!g) return "";
        return `<span class="group-chip" style="background:${escapeHtml(g.color || "#6366f1")}">${escapeHtml(g.name)}
          <form method="POST" style="display:inline;margin-left:4px">
            <input type="hidden" name="action" value="remove_from_group">
            <input type="hidden" name="group_id" value="${g.id}">
            <input type="hidden" name="contact_id" value="${contact.id}">
            <input type="hidden" name="return_view" value="contact">
            <button type="submit" style="background:none;border:none;color:#fff;cursor:pointer;font-size:0.7rem;padding:0">&times;</button>
          </form>
        </span>`;
      }).filter(Boolean).join("")}
    </div>
    ${allGroups.length > 0 ? `
    <form method="POST" style="display:flex;gap:0.5rem;align-items:center">
      <input type="hidden" name="action" value="add_to_group">
      <input type="hidden" name="contact_id" value="${contact.id}">
      <input type="hidden" name="return_view" value="contact">
      <select name="group_id" class="contacts-filter-select" style="font-size:0.8rem">
        ${allGroups.filter((g) => !contactGroups.includes(g.id)).map((g) =>
          `<option value="${g.id}">${escapeHtml(g.name)}</option>`
        ).join("")}
      </select>
      <button type="submit" class="btn btn-sm btn-secondary">${t("contacts.addToGroup", lang)}</button>
    </form>` : `<p style="font-size:0.8rem;color:var(--crow-text-muted)">${t("contacts.noGroups", lang)}</p>`}
  </div>`;

  // Activity feed
  let activityHtml = "";
  if (activities.length > 0) {
    const items = activities.map((a) => {
      const icon = a.activity_type === "message" ? "M" : "S";
      const detail = a.activity_type === "message"
        ? escapeHtml((a.detail || "").substring(0, 80))
        : `${escapeHtml(a.detail || "")} (${escapeHtml(a.direction || "")})`;
      const time = a.created_at ? new Date(a.created_at).toLocaleDateString() : "";
      return `<div class="activity-item">
        <div class="activity-icon">${icon}</div>
        <div class="activity-detail">${detail}</div>
        <div class="activity-time">${escapeHtml(time)}</div>
      </div>`;
    }).join("");

    activityHtml = `<div class="profile-section">
      <div class="profile-section-title">${t("contacts.activity", lang)}</div>
      ${items}
    </div>`;
  }

  // Edit form (collapsible)
  const editForm = `<details style="margin-top:1rem">
    <summary style="cursor:pointer;font-size:0.85rem;color:var(--crow-accent);font-weight:500">${t("contacts.editContact", lang)}</summary>
    <form method="POST" style="margin-top:0.75rem;padding:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px">
      <input type="hidden" name="action" value="edit_contact">
      <input type="hidden" name="contact_id" value="${contact.id}">
      ${formField(t("contacts.fieldName", lang), "display_name", { value: contact.display_name || "" })}
      ${formField(t("contacts.fieldEmail", lang), "email", { type: "email", value: contact.email || "" })}
      ${formField(t("contacts.fieldPhone", lang), "phone", { value: contact.phone || "" })}
      ${formField(t("contacts.fieldAvatar", lang), "avatar_url", { value: contact.avatar_url || "", placeholder: "https://..." })}
      ${formField(t("contacts.fieldNotes", lang), "notes", { type: "textarea", value: contact.notes || "", rows: 3 })}
      <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("common.save", lang)}</button>
    </form>
  </details>`;

  // Actions
  const blockAction = contact.is_blocked
    ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="unblock"><input type="hidden" name="contact_id" value="${contact.id}"><button type="submit" class="btn btn-sm btn-secondary">${t("contacts.unblock", lang)}</button></form>`
    : `<form method="POST" style="display:inline" onsubmit="return confirm('${t("contacts.blockConfirm", lang)}')"><input type="hidden" name="action" value="block"><input type="hidden" name="contact_id" value="${contact.id}"><button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)">${t("contacts.block", lang)}</button></form>`;

  // Delete is a two-step flow (design §4.2): this control is a GET link to the
  // side-effect-free confirmation interstitial, never a direct destructive POST.
  // Shown for every contact except local-bot rows (this instance recreates those
  // at boot, so deleting one is refused).
  const deleteAction = contact.origin === "local-bot"
    ? ""
    : `<a href="/dashboard/contacts?view=contact&contact=${contact.id}&confirm=delete" class="btn btn-sm btn-secondary" style="color:var(--crow-error)">${t("common.delete", lang)}</a>`;

  const actions = `<div class="profile-actions">
    <a href="/dashboard/contacts" class="btn btn-sm btn-secondary">${t("common.back", lang)}</a>
    ${blockAction}
    ${deleteAction}
  </div>`;

  return `<div class="contact-profile">
    ${header}${detailsHtml}${verifyHtml}${notesHtml}${groupsSection}${activityHtml}${editForm}${actions}
  </div>`;
}

// ──────────────────────────────────────────────
// Delete confirmation interstitial (F-CONTACT-1, design §4.2)
// ──────────────────────────────────────────────

/**
 * Side-effect-free GET interstitial that discloses the exact blast radius before
 * a contact is deleted. The only destructive control is the Delete form, which
 * POSTs `delete_contact&confirm=1` through csrfMiddleware. Block is offered as the
 * reversible alternative; Cancel returns to the contact. All rendered text is
 * escaped via escapeHtml — no innerHTML, no interpolation into an attribute.
 *
 * @param {object} contact the contact row (needs id, display_name, origin)
 * @param {{messages:number, sharedItems:number, groups:number, projectsOwned:number, projectMemberships:number}} preview
 * @param {string} lang
 * @param {string} csrf a `<input type=hidden name=_csrf>` string for the POST forms
 */
export function renderDeleteConfirm(contact, preview, lang, csrf = "") {
  if (!contact) {
    return `<div class="contacts-empty"><p>${t("contacts.notFound", lang)}</p></div>`;
  }

  const header = `<div class="contact-profile-header">
    ${avatarHtml(contact, "large")}
    <div class="profile-info">
      <h2>${escapeHtml(contact.display_name || "Unknown")}</h2>
      <span class="type-badge">${escapeHtml(contact.contact_type === "manual" ? t("contacts.manual", lang) : t("contacts.crow", lang))}</span>
    </div>
  </div>`;

  // Only non-zero categories are listed; the messages line names the permanent
  // deletion. When nothing cascades, a single reassuring line is shown instead.
  const lines = [
    [preview.messages, "contacts.deleteMessages"],
    [preview.sharedItems, "contacts.deleteSharedItems"],
    [preview.groups, "contacts.deleteGroups"],
    [preview.projectsOwned, "contacts.deleteProjectsOwned"],
    [preview.projectMemberships, "contacts.deleteProjectMemberships"],
  ].filter(([n]) => Number(n) > 0);

  const cascadeHtml = lines.length > 0
    ? `<p>${t("contacts.deleteWhatHappens", lang)}</p>
       <ul style="margin:0.5rem 0 0;padding-left:1.25rem;font-size:0.9rem;color:var(--crow-text-secondary)">
         ${lines.map(([n, key]) => `<li><strong>${Number(n)}</strong> ${t(key, lang)}</li>`).join("")}
       </ul>`
    : `<p style="font-size:0.9rem;color:var(--crow-text-secondary)">${t("contacts.deleteNothing", lang)}</p>`;

  const body = `<div class="profile-section">
    <div class="profile-section-title" style="color:var(--crow-error)">${t("contacts.deleteTitle", lang)}</div>
    <p style="font-size:0.9rem;color:var(--crow-text-secondary)">${t("contacts.deleteIntro", lang)}</p>
    ${cascadeHtml}
    <p style="font-size:0.9rem;margin-top:0.75rem"><strong>${t("contacts.deleteAllCrows", lang)}</strong></p>
    <p style="font-size:0.85rem;color:var(--crow-text-muted)">${t("contacts.deleteBlockHint", lang)}</p>
  </div>`;

  const blockForm = `<form method="POST" style="display:inline">
    ${csrf}
    <input type="hidden" name="action" value="block">
    <input type="hidden" name="contact_id" value="${contact.id}">
    <button type="submit" class="btn btn-sm btn-secondary">${t("contacts.block", lang)}</button>
  </form>`;

  const cancelLink = `<a href="/dashboard/contacts?view=contact&contact=${contact.id}" class="btn btn-sm btn-secondary">${t("common.cancel", lang)}</a>`;

  const deleteForm = `<form method="POST" style="display:inline">
    ${csrf}
    <input type="hidden" name="action" value="delete_contact">
    <input type="hidden" name="contact_id" value="${contact.id}">
    <input type="hidden" name="confirm" value="1">
    <button type="submit" class="btn btn-sm btn-primary" style="background:var(--crow-error);border-color:var(--crow-error)">${t("common.delete", lang)}</button>
  </form>`;

  const actions = `<div class="profile-actions">${blockForm}${cancelLink}${deleteForm}</div>`;

  return `<div class="contact-profile">${header}${body}${actions}</div>`;
}

// ──────────────────────────────────────────────
// Group Manager
// ──────────────────────────────────────────────

export function renderGroupManager(groups, contacts, lang) {
  const createForm = `<form method="POST" style="display:flex;gap:0.5rem;align-items:flex-end;margin-bottom:1.25rem;flex-wrap:wrap">
    <input type="hidden" name="action" value="create_group">
    <div style="flex:1;min-width:160px">
      <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${t("contacts.groupName", lang)}</label>
      <input type="text" name="group_name" required placeholder="${escapeHtml(t("contacts.groupNamePlaceholder", lang))}" style="width:100%;padding:0.5rem 0.75rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font-size:0.85rem">
    </div>
    <div>
      <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${t("contacts.groupColor", lang)}</label>
      <input type="color" name="group_color" value="#6366f1" style="width:40px;height:36px;border:1px solid var(--crow-border);border-radius:6px;cursor:pointer;background:var(--crow-bg-deep)">
    </div>
    <button type="submit" class="btn btn-primary">${t("contacts.createGroup", lang)}</button>
  </form>`;

  if (groups.length === 0) {
    return createForm + `<div class="contacts-empty"><p>${t("contacts.noGroupsYet", lang)}</p></div>`;
  }

  const groupItems = groups.map((g) => {
    // Members in this group
    const memberIds = contacts
      .filter((c) => c.group_ids && String(c.group_ids).split(",").map(Number).includes(g.id))
      .slice(0, 8);

    const memberAvatars = memberIds.map((c) =>
      `<a href="/dashboard/contacts?view=contact&contact=${c.id}" title="${escapeHtml(c.display_name || "")}" style="text-decoration:none">${avatarHtml(c)}</a>`
    ).join("");

    return `<div class="group-item">
      <div class="group-item-header">
        <div class="group-item-name">
          <div class="group-color-dot" style="background:${escapeHtml(g.color || "#6366f1")}"></div>
          ${escapeHtml(g.name)}
          <span class="group-member-count">(${g.member_count || 0})</span>
        </div>
        <div class="group-actions">
          <form method="POST" style="display:inline">
            <input type="hidden" name="action" value="delete_group">
            <input type="hidden" name="group_id" value="${g.id}">
            <button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error);font-size:0.75rem" onclick="return confirm('${t("contacts.deleteGroupConfirm", lang)}')">${t("common.delete", lang)}</button>
          </form>
        </div>
      </div>
      <div style="display:flex;gap:0.35rem;flex-wrap:wrap">${memberAvatars || `<span style="font-size:0.8rem;color:var(--crow-text-muted)">${t("contacts.noMembers", lang)}</span>`}</div>
    </div>`;
  }).join("");

  return createForm + `<div class="group-list">${groupItems}</div>`;
}

// ──────────────────────────────────────────────
// My Profile
// ──────────────────────────────────────────────

export function renderMyProfile(profile, lang) {
  const name = profile.display_name || "";
  const avatarUrl = profile.avatar_url || "";
  const bio = profile.bio || "";

  const preview = `<div class="my-profile-preview">
    <div class="profile-avatar-large" style="background:var(--crow-accent)">
      ${avatarUrl
        ? `<img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy">`
        : `<span style="font-size:1.5rem;font-weight:700">${escapeHtml(initials(name || "Me"))}</span>`}
    </div>
    <div>
      <div style="font-weight:600;font-size:1.1rem;color:var(--crow-text-primary)">${escapeHtml(name || t("contacts.profileNotSet", lang))}</div>
      ${bio ? `<div style="font-size:0.85rem;color:var(--crow-text-secondary);margin-top:0.25rem">${escapeHtml(bio)}</div>` : ""}
    </div>
  </div>`;

  const form = `<form method="POST" class="my-profile-form">
    <input type="hidden" name="action" value="save_profile">
    ${formField(t("contacts.profileName", lang), "display_name", { value: name, placeholder: t("contacts.profileNamePlaceholder", lang) })}
    ${formField(t("contacts.fieldAvatar", lang), "avatar_url", { value: avatarUrl, placeholder: "https://..." })}
    ${formField(t("contacts.profileBio", lang), "bio", { type: "textarea", value: bio, rows: 3, placeholder: t("contacts.profileBioPlaceholder", lang) })}
    <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("common.save", lang)}</button>
  </form>`;

  return preview + form;
}

// ──────────────────────────────────────────────
// Import Modal
// ──────────────────────────────────────────────

function renderImportModal(lang) {
  return `<div class="import-modal-backdrop" id="importModal" onclick="if(event.target===this)this.classList.remove('visible')">
    <div class="import-modal">
      <h3>${t("contacts.importTitle", lang)}</h3>
      <form method="POST">
        <input type="hidden" name="action" value="import_contacts">
        <div style="margin-bottom:1rem">
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${t("contacts.importFormat", lang)}</label>
          <select name="import_format" class="contacts-filter-select" style="width:100%">
            <option value="vcard">vCard (.vcf)</option>
            <option value="csv">CSV</option>
          </select>
        </div>
        <div style="margin-bottom:1rem">
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${t("contacts.importFile", lang)}</label>
          <input type="file" accept=".vcf,.csv,.txt" id="importFileInput" onchange="readImportFile(this)" style="font-size:0.85rem;color:var(--crow-text-secondary)">
        </div>
        <div style="margin-bottom:1rem">
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${t("contacts.importPaste", lang)}</label>
          <textarea name="import_content" id="importContent" rows="6" placeholder="${escapeHtml(t("contacts.importPastePlaceholder", lang))}" style="width:100%;padding:0.5rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font-size:0.8rem;font-family:monospace;resize:vertical"></textarea>
        </div>
        <div style="display:flex;gap:0.5rem;justify-content:flex-end">
          <button type="button" class="btn btn-secondary" onclick="document.getElementById('importModal').classList.remove('visible')">${t("common.cancel", lang)}</button>
          <button type="submit" class="btn btn-primary">${t("contacts.importButton", lang)}</button>
        </div>
      </form>
    </div>
  </div>`;
}
