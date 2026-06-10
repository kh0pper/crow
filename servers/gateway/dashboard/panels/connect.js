/**
 * Connect a client — a hidden, server-rendered wizard with per-client, copy-paste
 * MCP config. Covers the two connection styles that work today with no token:
 * local stdio (npm run mcp-config) and remote HTTP via OAuth. Cloud web clients
 * (claude.ai, ChatGPT) get an honest reachability warning, because a private Crow
 * is Tailnet-only and exposing MCP publicly is blocked by the network-exposure
 * invariant. Token surfacing + server-side validation are deferred to F6c-2.
 * No client JS beyond the shared tabs/copy handlers in componentsJs().
 */
import { section, tabs, codeBlock, callout, button, escapeHtml } from "../shared/components.js";
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { generateLocalToken, revokeLocalToken, getLocalTokenMeta } from "../../local-token.js";

/**
 * Resolve language cookie-first. The dispatcher-provided lang derives from the DB
 * "language" setting, which a brand-new user has not set, so it would default to
 * English even for a user who chose Spanish on the setup/login pages (which persist
 * the choice in crow_lang). Matches onboarding.js / help-setup.js.
 */
function resolveLang(req) {
  const lang = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

const P_STYLE = "font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-2)";
const H_STYLE = "font-size:var(--crow-text-md);margin:var(--crow-space-4) 0 var(--crow-space-2)";

/**
 * One labelled config block: optional sub-heading, lead text, code snippet, note
 * callout. Each client's steps are folded into a single lead sentence ("run X,
 * then restart Y") rather than a numbered <ol>: the steps are one or two actions,
 * so a sentence reads cleaner and needs fewer i18n keys. (This is a deliberate
 * simplification of the spec's "numbered sequence" wording; see the spec note.)
 *
 * heading/lead/note are trusted HTML (here always t() output, never user input);
 * escape before passing any user-derived text, matching the callout()/section()
 * convention in components.js.
 */
function block({ heading, lead, code, codeLang, note, noteType = "info" }) {
  return (heading ? `<h4 style="${H_STYLE}">${heading}</h4>` : "")
    + (lead ? `<p style="${P_STYLE}">${lead}</p>` : "")
    + (code ? codeBlock(code, codeLang ? { lang: codeLang } : {}) : "")
    + (note ? callout(note, noteType) : "");
}

// Remote-HTTP config for a header-capable client. `token` is either the raw
// token (one-time reveal) or the literal "<YOUR-TOKEN>" placeholder.
function tokenConfig(endpoint, token) {
  return `{\n  "mcpServers": {\n    "crow": {\n      "type": "http",\n      "url": "${endpoint}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`;
}

function tokenForm(action, label, variant, csrf) {
  return `<form method="POST" action="/dashboard/connect" style="display:inline-block;margin:0">`
    + `<input type="hidden" name="_csrf" value="${escapeHtml(csrf || "")}">`
    + `<input type="hidden" name="action" value="${escapeHtml(action)}">`
    + button(label, { variant, type: "submit" })
    + `</form>`;
}

function tokenActions({ lang, present, csrf }) {
  const wrap = (inner) => `<div style="display:flex;gap:var(--crow-space-3);flex-wrap:wrap;margin-top:var(--crow-space-3)">${inner}</div>`;
  if (!present) {
    return wrap(tokenForm("generate_token", t("connect.token.generate", lang), "primary", csrf));
  }
  return wrap(
    tokenForm("rotate_token", t("connect.token.rotate", lang), "secondary", csrf)
    + tokenForm("revoke_token", t("connect.token.revoke", lang), "secondary", csrf),
  );
}

// Returns the token section BODY only (no heading element). The caller wraps it
// in section(t("connect.token.heading", lang), ...), so the section title is the
// single heading; the body adds no heading of its own (avoids a double label).
// `reveal` is the raw token immediately after generate/rotate (show once);
// otherwise null. `meta` is getLocalTokenMeta() output.
function tokenSection({ endpoint, lang, meta, reveal, csrf }) {
  if (reveal) {
    return callout(`<strong>${t("connect.token.revealHeading", lang)}</strong><br>${t("connect.token.revealWarning", lang)}`, "warning")
      + codeBlock(reveal)
      + `<p style="${P_STYLE}">${t("connect.token.configLead", lang)}</p>`
      + codeBlock(tokenConfig(endpoint, reveal), { lang: "json" })
      + tokenActions({ lang, present: true, csrf });
  }
  if (meta.present) {
    return `<p style="${P_STYLE}">${t("connect.token.activeSince", lang)} ${escapeHtml(meta.createdAt || "")}</p>`
      + callout(t("connect.token.placeholderNote", lang), "info")
      + codeBlock(tokenConfig(endpoint, "<YOUR-TOKEN>"), { lang: "json" })
      + tokenActions({ lang, present: true, csrf });
  }
  return `<p style="${P_STYLE}">${t("connect.token.intro", lang)}</p>`
    + tokenActions({ lang, present: false, csrf });
}

function clientTabs(baseUrl, lang) {
  const endpoint = `${baseUrl}/router/mcp`;
  const ccHttp = `{\n  "mcpServers": {\n    "crow": { "type": "http", "url": "${endpoint}" }\n  }\n}`;
  const cursorCfg = `{\n  "mcpServers": {\n    "crow": { "url": "${endpoint}" }\n  }\n}`;

  return tabs([
    {
      id: "claude-code", label: "Claude Code",
      content:
        block({ heading: t("connect.localStdioHeading", lang), lead: t("connect.cc.stdioLead", lang),
          code: "npm run mcp-config", codeLang: "sh", note: t("connect.stdioNote", lang) })
        + block({ heading: t("connect.remoteHttpHeading", lang), lead: t("connect.cc.remoteLead", lang),
          code: ccHttp, codeLang: "json", note: t("connect.oauthNote", lang) }),
    },
    {
      id: "cursor", label: "Cursor",
      content: block({ lead: t("connect.cursor.lead", lang), code: cursorCfg, codeLang: "json",
        note: t("connect.oauthNote", lang) }),
    },
    {
      id: "cline", label: "Cline",
      content: block({ lead: t("connect.cline.lead", lang), code: endpoint,
        note: t("connect.oauthNote", lang) }),
    },
    {
      id: "gemini", label: "Gemini CLI",
      content: block({ lead: t("connect.gemini.lead", lang), code: endpoint,
        note: t("connect.oauthNote", lang) }),
    },
    {
      id: "claude-desktop", label: "Claude Desktop",
      content: block({ lead: t("connect.desktop.lead", lang), code: "npm run mcp-config", codeLang: "sh",
        note: t("connect.stdioNote", lang) }),
    },
    {
      id: "cloud", label: "claude.ai / ChatGPT",
      content: callout(t("connect.cloud.warning", lang), "warning"),
    },
  ], { active: 0 });
}

// The wizard is the self-contained source of truth for client setup, so "More"
// only links back to the raw-URL reference. We deliberately do NOT re-link the
// external maestro.press per-platform docs here (Task 5 de-emphasizes that list
// in Help & Setup; re-linking its parent page would be inconsistent and the page
// is not verified live). Token surfacing lands in F6c-2.
function moreLinks(lang) {
  return `<p style="${P_STYLE}">${t("connect.settingsPointer", lang)}</p>`
    + `<div style="display:flex;gap:var(--crow-space-3);flex-wrap:wrap;margin-top:var(--crow-space-3)">`
    + button(t("connect.openConnections", lang), { variant: "secondary", href: "/dashboard/settings?section=connections" })
    + `</div>`;
}

export default {
  id: "connect",
  name: "Connect a client",  // literal; never shown (hidden panel)
  icon: "skills",            // unused while hidden; present for registry shape parity
  route: "/dashboard/connect",
  navOrder: 97,
  category: "tools",
  hidden: true,              // reachable by URL + deep-link, not in the sidebar

  async handler(req, res, ctx) {
    const { layout, db } = ctx;
    const lang = resolveLang(req);
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    let meta = { present: false, createdAt: null };
    let reveal = null;
    if (req.method === "POST" && db) {
      const action = req.body?.action;
      try {
        if (action === "generate_token" || action === "rotate_token") {
          reveal = await generateLocalToken(db);
          meta = await getLocalTokenMeta(db);
        } else if (action === "revoke_token") {
          await revokeLocalToken(db);
        } else {
          meta = await getLocalTokenMeta(db);
        }
      } catch (err) {
        console.warn("[connect] token action failed:", err.message);
      }
    } else if (db) {
      try { meta = await getLocalTokenMeta(db); } catch { /* treat as no token */ }
    }

    const content =
      // Intro deliberately uses space-4 (more breathing room) vs P_STYLE's space-2 mid-block leads.
      `<p style="font-size:var(--crow-text-base);line-height:var(--crow-leading-relaxed);color:var(--crow-text-secondary);margin-bottom:var(--crow-space-4)">${t("connect.intro", lang)}</p>` +
      section(t("connect.title", lang), clientTabs(baseUrl, lang)) +
      section(t("connect.token.heading", lang), tokenSection({ endpoint: `${baseUrl}/router/mcp`, lang, meta, reveal, csrf: req.csrfToken })) +
      section(t("connect.moreHeading", lang), moreLinks(lang));
    return layout({ title: t("connect.title", lang), content });
  },
};
