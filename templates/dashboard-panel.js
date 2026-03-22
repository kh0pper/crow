/**
 * Example Crow's Nest Panel — Starter template for add-on panels
 *
 * Place this file in ~/.crow/panels/ and add the panel ID to ~/.crow/panels.json
 * to enable it. See docs/developers/creating-panels.md for the full guide.
 *
 * IMPORTANT: Use dynamic imports with appRoot (not static ESM imports).
 * Panels are copied to ~/.crow/panels/ when installed — relative imports
 * from the repo tree will break. See skills/extension-dev.md for details.
 *
 * Panel manifest fields:
 *   id        — Unique panel identifier (used in URL: /dashboard/:id)
 *   name      — Display name in Crow's Nest sidebar navigation
 *   icon      — Icon key: messages, edit, files, settings, extensions, or default
 *   route     — Full route path (must match /dashboard/:id)
 *   navOrder  — Sort order in sidebar (lower = higher)
 *   handler   — Async function(req, res, { db, layout, lang, appRoot }) => HTML string
 */

export default {
  id: "my-panel",
  name: "My Panel",
  icon: "default",
  route: "/dashboard/my-panel",
  navOrder: 50,

  async handler(req, res, { db, layout, lang, appRoot }) {
    // Dynamic imports — resolve shared components via appRoot
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, dataTable, section, formField, badge, formatDate } = await import(pathToFileURL(componentsPath).href);

    // Handle form submissions
    if (req.method === "POST") {
      const { action } = req.body;
      // Handle actions here
      res.redirect("/dashboard/my-panel");
      return;
    }

    // Build page content using shared components
    const tableContent = dataTable(
      ["Name", "Status", "Date"],
      [] // Your data rows here
    );

    const content = `
      ${section("Data", tableContent, { delay: 100 })}
    `;

    // Return the HTML wrapped in the Crow's Nest layout
    return layout({ title: "My Panel", content });
  },
};
