/**
 * Design System gallery — a read-only QA surface that renders every token and
 * primitive with the real layout + tokens. The living reference for F6b/F6c
 * and theme work.
 */
import { section, badge, statCard, statGrid, dataTable, formField,
  button, codeBlock, callout, stepper, tabs } from "../shared/components.js";

// Spacing/type tokens are [name, fullVarRef] tuples so each token reference is a
// complete literal in source. If a token var() were built by interpolating an
// index into the middle of the name, the token-completeness test would capture a
// truncated, undefined token name and fail. (The COLORS swatch list below does
// interpolate the trailing segment, which is safe: the scanner regex cannot
// capture a partial when the interpolation immediately follows the crow- prefix,
// and every color name resolves to a defined token.)
const SPACES = [
  ["1",  "var(--crow-space-1)"],
  ["2",  "var(--crow-space-2)"],
  ["3",  "var(--crow-space-3)"],
  ["4",  "var(--crow-space-4)"],
  ["5",  "var(--crow-space-5)"],
  ["6",  "var(--crow-space-6)"],
  ["8",  "var(--crow-space-8)"],
  ["10", "var(--crow-space-10)"],
];
const SIZES = [
  ["xs",  "var(--crow-text-xs)"],
  ["sm",  "var(--crow-text-sm)"],
  ["base","var(--crow-text-base)"],
  ["md",  "var(--crow-text-md)"],
  ["lg",  "var(--crow-text-lg)"],
  ["xl",  "var(--crow-text-xl)"],
  ["2xl", "var(--crow-text-2xl)"],
  ["3xl", "var(--crow-text-3xl)"],
];
const COLORS = ["bg-deep", "bg-surface", "bg-elevated", "border", "text-primary",
  "text-secondary", "text-tertiary", "text-muted", "accent", "brand-gold",
  "success", "error", "warning", "info"];

function swatches() {
  return `<div style="display:flex;flex-wrap:wrap;gap:var(--crow-space-3)">` +
    COLORS.map((c) => `<div style="text-align:center;font-size:var(--crow-text-xs)">
      <div style="width:56px;height:56px;border-radius:var(--crow-radius-card);border:1px solid var(--crow-border);background:var(--crow-${c})"></div>
      <div style="margin-top:var(--crow-space-1);color:var(--crow-text-muted)">${c}</div></div>`).join("") +
    `</div>`;
}

function spacingScale() {
  return SPACES.map(([name, token]) => `<div style="display:flex;align-items:center;gap:var(--crow-space-3);margin-bottom:var(--crow-space-1)">
    <code style="width:7ch;font-size:var(--crow-text-xs)">space-${name}</code>
    <div style="height:12px;width:${token};background:var(--crow-accent);border-radius:2px"></div></div>`).join("");
}

function typeScale() {
  return SIZES.map(([name, token]) => `<div style="font-size:${token};line-height:var(--crow-leading-normal)">text-${name} — The quick brown crow</div>`).join("");
}

export default {
  id: "design-system",
  name: "Design System",
  icon: "skills",
  route: "/dashboard/design-system",
  navOrder: 95,
  category: "tools",
  hidden: true, // QA/reference surface — reachable by URL, not shown in every user's sidebar

  async handler(req, res, { layout }) {
    const content =
      section("Colors", swatches()) +
      section("Spacing scale", spacingScale()) +
      section("Type scale", typeScale()) +
      section("Buttons", [
        button("Primary", { variant: "primary" }),
        button("Secondary", { variant: "secondary" }),
        button("Danger", { variant: "danger" }),
        button("Ghost", { variant: "ghost" }),
        button("Small", { variant: "primary", size: "sm" }),
        button("Link", { href: "#", variant: "secondary" }),
      ].join(" ")) +
      section("Callouts",
        callout("Informational notice.", "info") +
        callout("Success — it worked.", "success") +
        callout("Warning — check this.", "warning") +
        callout("Error — something failed.", "error")) +
      section("Code block", codeBlock('{\n  "mcpServers": { "crow": { "url": "https://crow.example/router/mcp" } }\n}', { lang: "json" })) +
      section("Stepper", stepper([{ label: "Welcome" }, { label: "Integrations" }, { label: "Connect" }, { label: "Done" }], 1)) +
      section("Tabs", tabs([
        { id: "cc", label: "Claude Code", content: codeBlock("claude mcp add crow ...", { lang: "sh" }) },
        { id: "web", label: "claude.ai", content: callout("Connect via Settings → Connectors.", "info") },
        { id: "oc", label: "opencode", content: "<p>opencode config snippet.</p>" },
      ])) +
      section("Existing primitives",
        statGrid([statCard("Memories", "128"), statCard("Bots", "4")]) +
        `<div style="margin:var(--crow-space-4) 0">${badge("active", "active")} ${badge("draft", "draft")}</div>` +
        dataTable(["Name", "Type"], [["alpha", "bundle"], ["beta", "mcp-server"]]) +
        `<div style="margin-top:var(--crow-space-4)">${formField("Example field", "demo", { placeholder: "type here" })}</div>`);

    return layout({ title: "Design System", content });
  },
};
