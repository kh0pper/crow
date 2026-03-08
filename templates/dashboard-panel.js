/**
 * Example Dashboard Panel — Starter template for add-on panels
 *
 * Place this file in ~/.crow/panels/ and add the panel ID to ~/.crow/panels.json
 * to enable it. See docs/developers/creating-panels.md for the full guide.
 *
 * Panel manifest fields:
 *   id        — Unique panel identifier (used in URL: /dashboard/:id)
 *   name      — Display name in sidebar navigation
 *   icon      — Icon key: messages, edit, files, settings, extensions, or default
 *   route     — Full route path (must match /dashboard/:id)
 *   navOrder  — Sort order in sidebar (lower = higher)
 *   handler   — Async function(req, res, { db, layout }) => HTML string
 */

import {
  escapeHtml,
  statCard,
  statGrid,
  dataTable,
  section,
  formField,
  badge,
  formatDate,
} from "../servers/gateway/dashboard/shared/components.js";

export default {
  id: "my-panel",
  name: "My Panel",
  icon: "default",
  route: "/dashboard/my-panel",
  navOrder: 50,

  async handler(req, res, { db, layout }) {
    // Handle form submissions
    if (req.method === "POST") {
      const { action } = req.body;
      // Handle actions here
      res.redirect("/dashboard/my-panel");
      return;
    }

    // Build page content using shared components
    const stats = statGrid([
      statCard("Items", "0", { delay: 0 }),
      statCard("Status", "Active", { delay: 50 }),
    ]);

    const tableContent = dataTable(
      ["Name", "Status", "Date"],
      [] // Your data rows here
    );

    const content = `
      ${stats}
      ${section("Data", tableContent, { delay: 100 })}
    `;

    // Return the HTML wrapped in the dashboard layout
    return layout({ title: "My Panel", content });
  },
};
