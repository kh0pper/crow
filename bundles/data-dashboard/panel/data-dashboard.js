/**
 * Data Dashboard — Crow's Nest Panel
 *
 * 4-tab interface: Schema Explorer, SQL Editor, Charts, Case Studies.
 * Bundle-compatible: uses dynamic imports with appRoot so it works
 * both from the repo and when installed to ~/.crow/panels/.
 */

export default {
  id: "data-dashboard",
  name: "Data Dashboard",
  icon: "media",
  route: "/dashboard/data-dashboard",
  navOrder: 16,

  async handler(req, res, { db, layout, lang, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, section, badge, dataTable, formField, formatDate } = await import(pathToFileURL(componentsPath).href);

    // Resolve bundle server directory (installed vs repo)
    const installedServerDir = join(process.env.HOME || "", ".crow", "bundles", "data-dashboard", "server");
    const repoServerDir = join(appRoot, "bundles", "data-dashboard", "server");
    const bundleServerDir = existsSync(installedServerDir) ? installedServerDir : repoServerDir;

    async function importBundleModule(name) {
      return import(pathToFileURL(join(bundleServerDir, name)).href);
    }
    const tab = req.query.tab || "schema";
    const backendId = req.query.backend_id ? parseInt(req.query.backend_id) : null;

    // --- POST Actions ---
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "run_query" && req.body.backend_id && req.body.sql) {
        // Execute query and show results
        const bid = parseInt(req.body.backend_id);
        const sql = req.body.sql;
        return res.redirectAfterPost(`/dashboard/data-dashboard?tab=sql&backend_id=${bid}&q=${encodeURIComponent(sql)}`);
      }
    }

    // Fetch available databases
    let databases = [];
    try {
      const { rows } = await db.execute(
        "SELECT db.id, db.name, db.project_id, p.name as project_name, db.connection_ref FROM data_backends db LEFT JOIN research_projects p ON db.project_id = p.id WHERE db.backend_type = 'sqlite' ORDER BY db.name"
      );
      databases = rows;
    } catch {}

    // Tab navigation
    const tabs = [
      { id: "schema", label: "Schema", icon: "📋" },
      { id: "sql", label: "SQL Editor", icon: "⚡" },
      { id: "charts", label: "Charts", icon: "📊" },
      { id: "cases", label: "Case Studies", icon: "📄" },
    ];

    const tabNav = `<div style="display:flex;gap:0;border-bottom:1px solid var(--crow-border);margin-bottom:1rem">
      ${tabs.map(t => {
        const active = t.id === tab;
        return `<a href="/dashboard/data-dashboard?tab=${t.id}${backendId ? `&backend_id=${backendId}` : ""}"
          style="padding:0.6rem 1rem;text-decoration:none;font-size:0.85rem;font-weight:${active ? "600" : "400"};
          color:${active ? "var(--crow-accent)" : "var(--crow-text-secondary)"};
          border-bottom:2px solid ${active ? "var(--crow-accent)" : "transparent"};
          transition:all 0.15s">${t.icon} ${t.label}</a>`;
      }).join("")}
    </div>`;

    // Database selector
    const dbSelector = databases.length > 0 ? `<div style="margin-bottom:1rem;display:flex;gap:0.5rem;align-items:center">
      <label style="font-size:0.8rem;color:var(--crow-text-secondary)">Database:</label>
      <select onchange="location.href='/dashboard/data-dashboard?tab=${tab}&backend_id='+this.value"
        style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);font-size:0.85rem">
        <option value="">Select a database</option>
        ${databases.map(d => `<option value="${d.id}"${d.id === backendId ? " selected" : ""}>${escapeHtml(d.name)}${d.project_name ? ` (${escapeHtml(d.project_name)})` : ""}</option>`).join("")}
      </select>
    </div>` : `<div style="padding:1rem;text-align:center;color:var(--crow-text-muted)">
      No SQLite databases registered. Use <code>crow_data_create_database</code> to create one.
    </div>`;

    const ctx = { escapeHtml, section, badge, dataTable, formatDate, importBundleModule };

    // Render active tab
    let tabContent = "";
    switch (tab) {
      case "schema":
        tabContent = await renderSchemaTab(db, backendId, lang, ctx);
        break;
      case "sql":
        tabContent = await renderSqlTab(db, backendId, req.query.q, lang, ctx);
        break;
      case "charts":
        tabContent = renderChartsTab(lang);
        break;
      case "cases":
        tabContent = await renderCasesTab(db, lang, ctx);
        break;
    }

    const content = `${tabNav}${dbSelector}${tabContent}`;
    return layout({ title: "Data Dashboard", content });
  },
};

async function renderSchemaTab(db, backendId, lang, { escapeHtml, section, badge, dataTable, importBundleModule }) {
  if (!backendId) {
    return `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">Select a database to explore its schema.</div>`;
  }

  // Get backend info
  const { rows: backends } = await db.execute({
    sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
    args: [backendId],
  });

  if (backends.length === 0) {
    return `<div style="color:var(--crow-error)">Backend #${backendId} not found.</div>`;
  }

  const ref = JSON.parse(backends[0].connection_ref);
  const dbPath = ref.path;

  try {
    const { getSchema } = await importBundleModule("query-engine.js");
    const schema = await getSchema(dbPath);

    if (schema.tables.length === 0) {
      return section("Schema", `<p style="color:var(--crow-text-muted)">Database is empty — no tables found.</p>`);
    }

    const tablesHtml = schema.tables.map((tbl, i) => {
      const colRows = tbl.columns.map(c => [
        escapeHtml(c.name),
        badge(c.type || "TEXT", "info"),
        c.pk ? badge("PK", "connected") : "",
        c.notnull ? "NOT NULL" : "",
        c.default_value ? escapeHtml(String(c.default_value)) : "",
      ]);

      return section(`${escapeHtml(tbl.name)} (${tbl.rowCount} rows)`,
        dataTable(["Column", "Type", "Key", "Nullable", "Default"], colRows) +
        (tbl.indexes.length > 0 ? `<div style="margin-top:0.5rem;font-size:0.75rem;color:var(--crow-text-muted)">Indexes: ${tbl.indexes.map(idx => escapeHtml(idx)).join(", ")}</div>` : "") +
        `<a href="/dashboard/data-dashboard?tab=sql&backend_id=${backendId}&q=${encodeURIComponent(`SELECT * FROM "${tbl.name}" LIMIT 10`)}" style="font-size:0.8rem;color:var(--crow-accent);margin-top:0.5rem;display:inline-block">Preview →</a>`,
        { delay: i * 50 }
      );
    }).join("");

    return tablesHtml;
  } catch (err) {
    return `<div style="color:var(--crow-error)">Error reading schema: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderSqlTab(db, backendId, queryParam, lang, { escapeHtml, dataTable, importBundleModule }) {
  if (!backendId) {
    return `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">Select a database to run queries.</div>`;
  }

  const sql = queryParam ? decodeURIComponent(queryParam) : "";

  // Execute query if provided
  let resultHtml = "";
  if (sql) {
    try {
      const { rows: backends } = await db.execute({
        sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
        args: [backendId],
      });
      if (backends.length === 0) throw new Error("Backend not found");

      const ref = JSON.parse(backends[0].connection_ref);
      const { executeReadQuery } = await importBundleModule("query-engine.js");
      const result = await executeReadQuery(ref.path, sql, 100);

      if (result.rowCount === 0) {
        resultHtml = `<div style="padding:1rem;color:var(--crow-text-muted)">Query returned 0 rows (${result.executionMs}ms)</div>`;
      } else {
        const headers = result.columns;
        const rows = result.rows.map(r =>
          headers.map(h => {
            const val = escapeHtml(String(r[h] ?? "NULL"));
            return val.length > 80 ? val.substring(0, 77) + "..." : val;
          })
        );
        resultHtml = `<div style="margin-top:0.5rem;font-size:0.75rem;color:var(--crow-text-muted)">${result.rowCount} rows · ${result.executionMs}ms</div>` +
          `<div style="overflow-x:auto">${dataTable(headers, rows)}</div>`;
      }
    } catch (err) {
      resultHtml = `<div style="padding:1rem;color:var(--crow-error)">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  return `
    <form method="POST" style="display:flex;flex-direction:column;gap:0.5rem">
      <input type="hidden" name="action" value="run_query">
      <input type="hidden" name="backend_id" value="${backendId}">
      <textarea name="sql" rows="5" placeholder="SELECT * FROM table_name LIMIT 10"
        style="width:100%;padding:0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.85rem;
        background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);
        color:var(--crow-text-primary);resize:vertical">${escapeHtml(sql)}</textarea>
      <div style="display:flex;gap:0.5rem">
        <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:white;cursor:pointer;font-size:0.85rem">Run Query</button>
      </div>
    </form>
    ${resultHtml}
  `;
}

function renderChartsTab(lang) {
  return `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">
    <p>Chart visualizations are created via AI tools.</p>
    <p style="font-size:0.85rem;margin-top:0.5rem">Use <code>crow_data_save_query</code> with <code>item_type: "chart"</code> to save chart configurations, then view them here.</p>
  </div>`;
}

async function renderCasesTab(db, lang, { escapeHtml, badge, formatDate }) {
  let studies = [];
  try {
    const { rows } = await db.execute(
      "SELECT cs.*, (SELECT COUNT(*) FROM data_case_study_sections WHERE case_study_id = cs.id) as section_count FROM data_case_studies cs ORDER BY cs.updated_at DESC LIMIT 50"
    );
    studies = rows;
  } catch {}

  if (studies.length === 0) {
    return `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">
      <p>No case studies yet.</p>
      <p style="font-size:0.85rem;margin-top:0.5rem">Use <code>crow_data_case_study_create</code> to create one.</p>
    </div>`;
  }

  const cards = studies.map((s, i) => {
    const published = s.blog_post_id ? badge("published", "published") : badge("draft", "draft");
    return `<div class="project-card" style="animation:fadeInUp 0.3s ease-out ${i * 30}ms both">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div style="font-weight:600">${escapeHtml(s.title)}</div>
        ${published}
      </div>
      ${s.description ? `<div style="font-size:0.8rem;color:var(--crow-text-secondary);margin-top:0.25rem">${escapeHtml(s.description.substring(0, 100))}</div>` : ""}
      <div style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.5rem">${s.section_count} sections · ${formatDate(s.updated_at, lang)}</div>
    </div>`;
  }).join("");

  return `<style>.project-card{display:block;padding:1rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);margin-bottom:0.5rem}@keyframes fadeInUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}</style>${cards}`;
}
