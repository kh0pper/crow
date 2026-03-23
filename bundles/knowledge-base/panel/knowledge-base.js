/**
 * Crow's Nest Panel — Knowledge Base
 *
 * Tabs: Articles, Categories, Flagged, Collections, Import
 * Bundle-compatible: uses dynamic imports with appRoot.
 */

export default {
  id: "knowledge-base",
  name: "Knowledge Base",
  icon: "book-open",
  route: "/dashboard/knowledge-base",
  navOrder: 35,
  category: "content",

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    // Resolve the public-facing base URL for KB links
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    // Use the gateway URL for public collections, relative path for LAN
    function kbPublicUrl(slug, visibility) {
      if (visibility === "public" && gatewayUrl) {
        return `${gatewayUrl}/kb/${slug}`;
      }
      return `/kb/${slug}`;
    }

    // Load markdown renderer for article preview
    let renderMarkdown;
    try {
      const rendererPath = join(appRoot, "servers/blog/renderer.js");
      const mod = await import(pathToFileURL(rendererPath).href);
      renderMarkdown = mod.renderMarkdown;
    } catch {
      renderMarkdown = (md) => `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
    }

    // Handle POST actions (collection visibility updates)
    if (req.method === "POST" && req.body?.action === "update_collection") {
      const { collection_id, visibility, lan_enabled } = req.body;
      if (collection_id) {
        await db.execute({
          sql: "UPDATE kb_collections SET visibility = ?, lan_enabled = ?, updated_at = datetime('now') WHERE id = ?",
          args: [visibility || "private", lan_enabled === "1" ? 1 : 0, Number(collection_id)],
        });
      }
      return res.redirect(`/dashboard/knowledge-base?tab=collections`);
    }

    const tab = req.query.tab || "articles";
    const collectionId = req.query.collection_id || "";

    // Get collections for dropdown
    const collectionsResult = await db.execute({ sql: "SELECT id, slug, name, visibility, lan_enabled, languages FROM kb_collections ORDER BY name", args: [] });
    const collections = collectionsResult.rows;

    // If no collection selected and there's only one, auto-select it
    const activeCollectionId = collectionId || (collections.length === 1 ? String(collections[0].id) : "");

    let tabContent = "";

    // ─── ARTICLES TAB ───
    if (tab === "articles") {
      let articles = [];
      if (activeCollectionId) {
        const result = await db.execute({
          sql: `SELECT a.id, a.title, a.slug, a.language, a.status, a.pair_id, a.tags,
                a.updated_at, a.published_at, a.last_verified_at,
                c.name AS collection_name
                FROM kb_articles a JOIN kb_collections c ON a.collection_id = c.id
                WHERE a.collection_id = ?
                ORDER BY a.pair_id, a.language`,
          args: [Number(activeCollectionId)],
        });
        articles = result.rows;
      }

      // Group by pair_id for display
      const pairs = new Map();
      for (const a of articles) {
        if (!pairs.has(a.pair_id)) pairs.set(a.pair_id, []);
        pairs.get(a.pair_id).push(a);
      }

      const rows = [...pairs.values()].map(group => {
        const primary = group[0];
        const langBadges = group.map(a => {
          const color = a.status === "published" ? "var(--crow-success)" : "var(--crow-text-muted)";
          return `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:0.7rem;background:${color};color:#fff;margin-right:2px">${escapeHtml(a.language.toUpperCase())}</span>`;
        }).join("");
        const statusPill = primary.status === "published"
          ? '<span style="color:var(--crow-success);font-size:0.8rem">Published</span>'
          : '<span style="color:var(--crow-text-muted);font-size:0.8rem">Draft</span>';
        return `
          <tr>
            <td><a href="/dashboard/knowledge-base?tab=edit&id=${primary.id}" style="color:var(--crow-text-primary)">${escapeHtml(primary.title)}</a></td>
            <td>${langBadges}</td>
            <td>${statusPill}</td>
            <td style="font-size:0.8rem;color:var(--crow-text-muted)">${primary.updated_at ? primary.updated_at.slice(0, 10) : ""}</td>
            <td style="font-size:0.8rem;color:var(--crow-text-muted)">${primary.last_verified_at ? primary.last_verified_at.slice(0, 10) : "—"}</td>
          </tr>`;
      }).join("");

      tabContent = `
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--crow-border);text-align:left">
              <th style="padding:0.5rem 0.75rem">Title</th>
              <th style="padding:0.5rem 0.75rem">Languages</th>
              <th style="padding:0.5rem 0.75rem">Status</th>
              <th style="padding:0.5rem 0.75rem">Updated</th>
              <th style="padding:0.5rem 0.75rem">Verified</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5" style="padding:2rem;text-align:center;color:var(--crow-text-muted)">No articles yet. Use your AI to create knowledge base articles.</td></tr>'}</tbody>
        </table>`;
    }

    // ─── EDIT TAB ───
    if (tab === "edit") {
      const articleId = req.query.id;
      if (articleId) {
        const result = await db.execute({
          sql: `SELECT a.*, c.name AS collection_name FROM kb_articles a
                JOIN kb_collections c ON a.collection_id = c.id WHERE a.id = ?`,
          args: [Number(articleId)],
        });
        if (result.rows.length > 0) {
          const a = result.rows[0];
          // Get paired translations
          const translations = await db.execute({
            sql: "SELECT id, language, title FROM kb_articles WHERE pair_id = ? AND id != ?",
            args: [a.pair_id, a.id],
          });
          // Get resources
          const resources = await db.execute({
            sql: "SELECT * FROM kb_resources WHERE article_id = ? ORDER BY sort_order, id",
            args: [Number(articleId)],
          });

          const transLinks = translations.rows.map(t =>
            `<a href="/dashboard/knowledge-base?tab=edit&id=${t.id}" style="margin-right:0.5rem;padding:0.2rem 0.5rem;background:var(--crow-bg-elevated);border-radius:4px;font-size:0.8rem">${escapeHtml(t.language.toUpperCase())}: ${escapeHtml(t.title)}</a>`
          ).join("");

          const resourceRows = resources.rows.map(r => {
            const flagIcon = r.flagged ? '⚠️ ' : '';
            return `
              <tr style="border-bottom:1px solid var(--crow-border)">
                <td style="padding:0.5rem">${flagIcon}${escapeHtml(r.name)}</td>
                <td style="padding:0.5rem;font-size:0.85rem">${r.phone ? escapeHtml(r.phone) : "—"}</td>
                <td style="padding:0.5rem;font-size:0.85rem">${r.website ? `<a href="${escapeHtml(r.website)}" target="_blank" rel="noopener">${escapeHtml(r.website.replace(/^https?:\/\//, "").slice(0, 30))}</a>` : "—"}</td>
                <td style="padding:0.5rem;font-size:0.8rem;color:var(--crow-text-muted)">${r.last_verified_at ? r.last_verified_at.slice(0, 10) : "Never"}</td>
              </tr>`;
          }).join("");

          tabContent = `
            <div style="margin-bottom:1rem">
              <a href="/dashboard/knowledge-base?tab=articles${activeCollectionId ? `&collection_id=${activeCollectionId}` : ""}" style="font-size:0.85rem;color:var(--crow-accent)">← Back to articles</a>
            </div>
            <h2 style="font-family:'Fraunces',serif;margin-bottom:0.25rem">${escapeHtml(a.title)}</h2>
            <div style="font-size:0.85rem;color:var(--crow-text-muted);margin-bottom:1rem">
              ${a.language.toUpperCase()} · ${a.status} · ${a.collection_name}
              ${transLinks ? ` · Translations: ${transLinks}` : ""}
            </div>
            <div style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:8px;padding:1.25rem;margin-bottom:1.5rem;max-height:500px;overflow-y:auto;font-size:0.9rem;line-height:1.7">
              <style>
                .kb-preview table { width:100%; border-collapse:collapse; margin:0.75rem 0; font-size:0.85rem; }
                .kb-preview th, .kb-preview td { padding:0.5rem 0.6rem; border:1px solid var(--crow-border); text-align:left; vertical-align:top; }
                .kb-preview th { background:var(--crow-bg-elevated); font-weight:600; }
                .kb-preview h1,.kb-preview h2,.kb-preview h3 { margin-top:1.25rem; margin-bottom:0.5rem; }
                .kb-preview h2 { font-size:1.15rem; border-bottom:1px solid var(--crow-border); padding-bottom:0.3rem; }
                .kb-preview h3 { font-size:1rem; }
                .kb-preview p { margin-bottom:0.75rem; }
                .kb-preview ul,.kb-preview ol { margin:0.25rem 0 0.75rem 1.25rem; }
                .kb-preview a { color:var(--crow-accent); }
                .kb-preview img { max-width:100%; height:auto; border-radius:4px; }
                .kb-preview blockquote { border-left:3px solid var(--crow-accent); padding:0.4rem 0.75rem; margin:0.5rem 0; background:var(--crow-bg-elevated); border-radius:0 6px 6px 0; }
              </style>
              <div class="kb-preview">${renderMarkdown(a.content)}</div>
            </div>
            ${resources.rows.length > 0 ? `
              <h3 style="margin-bottom:0.5rem">Structured Resources (${resources.rows.length})</h3>
              <table style="width:100%;border-collapse:collapse;margin-bottom:1rem">
                <thead><tr style="border-bottom:1px solid var(--crow-border);text-align:left">
                  <th style="padding:0.5rem">Name</th>
                  <th style="padding:0.5rem">Phone</th>
                  <th style="padding:0.5rem">Website</th>
                  <th style="padding:0.5rem">Verified</th>
                </tr></thead>
                <tbody>${resourceRows}</tbody>
              </table>` : ""}
            <p style="font-size:0.85rem;color:var(--crow-text-muted)">Use your AI to edit articles, manage resources, and publish. The AI has full access to all KB tools.</p>`;
        } else {
          tabContent = '<p style="color:var(--crow-text-muted)">Article not found.</p>';
        }
      }
    }

    // ─── CATEGORIES TAB ───
    if (tab === "categories") {
      let categories = [];
      if (activeCollectionId) {
        const result = await db.execute({
          sql: `SELECT c.id, c.slug, c.sort_order, c.icon,
                GROUP_CONCAT(n.language || ':' || n.name, '|') AS names
                FROM kb_categories c
                LEFT JOIN kb_category_names n ON c.id = n.category_id
                WHERE c.collection_id = ?
                GROUP BY c.id ORDER BY c.sort_order, c.slug`,
          args: [Number(activeCollectionId)],
        });
        categories = result.rows;
      }

      const rows = categories.map(c => {
        const names = (c.names || "").split("|").filter(Boolean).map(n => {
          const [lang, name] = n.split(":");
          return `<span style="margin-right:0.5rem">${escapeHtml(lang?.toUpperCase() || "?")}: ${escapeHtml(name || "")}</span>`;
        }).join("");
        return `
          <tr style="border-bottom:1px solid var(--crow-border)">
            <td style="padding:0.5rem 0.75rem">${escapeHtml(c.slug)}</td>
            <td style="padding:0.5rem 0.75rem;font-size:0.85rem">${names}</td>
            <td style="padding:0.5rem 0.75rem;font-size:0.85rem;color:var(--crow-text-muted)">${c.sort_order}</td>
          </tr>`;
      }).join("");

      tabContent = `
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--crow-border);text-align:left">
            <th style="padding:0.5rem 0.75rem">Slug</th>
            <th style="padding:0.5rem 0.75rem">Names</th>
            <th style="padding:0.5rem 0.75rem">Order</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="3" style="padding:2rem;text-align:center;color:var(--crow-text-muted)">No categories. Use your AI to create categories.</td></tr>'}</tbody>
        </table>`;
    }

    // ─── FLAGGED TAB ───
    if (tab === "flagged") {
      const result = await db.execute({
        sql: `SELECT r.id, r.name, r.phone, r.flag_reason, r.flagged_at,
              a.title AS article_title, a.language, c.name AS collection_name
              FROM kb_resources r
              JOIN kb_articles a ON r.article_id = a.id
              JOIN kb_collections c ON a.collection_id = c.id
              WHERE r.flagged = 1
              ORDER BY r.flagged_at DESC LIMIT 100`,
        args: [],
      });

      if (result.rows.length === 0) {
        tabContent = '<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">No flagged resources. All clear!</div>';
      } else {
        const rows = result.rows.map(r => `
          <div style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:0.75rem">
            <div style="font-weight:600">${escapeHtml(r.name)}</div>
            <div style="font-size:0.85rem;color:var(--crow-text-muted);margin-bottom:0.5rem">
              ${escapeHtml(r.article_title)} (${r.language.toUpperCase()}) · ${escapeHtml(r.collection_name)}
            </div>
            <div style="font-size:0.9rem;color:var(--crow-error);margin-bottom:0.5rem">${escapeHtml(r.flag_reason)}</div>
            <div style="font-size:0.8rem;color:var(--crow-text-muted)">${r.phone ? `Phone: ${escapeHtml(r.phone)}` : ""}</div>
            <div style="margin-top:0.5rem">
              <button onclick="resolveFlag(${r.id}, 'verify')" style="padding:0.3rem 0.7rem;background:var(--crow-success);color:#fff;border:none;border-radius:4px;cursor:pointer;margin-right:0.5rem;font-size:0.8rem">Verify</button>
              <button onclick="resolveFlag(${r.id}, 'dismiss')" style="padding:0.3rem 0.7rem;background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border);border-radius:4px;cursor:pointer;font-size:0.8rem">Dismiss</button>
            </div>
          </div>`).join("");
        tabContent = rows;
      }
    }

    // ─── COLLECTIONS TAB ───
    if (tab === "collections") {
      if (collections.length === 0) {
        tabContent = '<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">No collections. Use your AI to create a knowledge base collection.</div>';
      } else {
        // Get article counts per collection
        const articleCounts = {};
        for (const c of collections) {
          const cnt = await db.execute({ sql: "SELECT COUNT(*) as cnt FROM kb_articles WHERE collection_id = ? AND status = 'published'", args: [c.id] });
          articleCounts[c.id] = cnt.rows[0]?.cnt || 0;
        }

        const rows = collections.map(c => {
          const visOptions = ["private", "public", "lan"].map(v => {
            const labels = { private: "🔒 Private — only you", public: "🌐 Public — anyone on the web", lan: "🏢 LAN — anyone on your network" };
            const selected = c.visibility === v ? "selected" : "";
            return `<option value="${v}" ${selected}>${labels[v]}</option>`;
          }).join("");

          const lanChecked = c.lan_enabled ? "checked" : "";
          const showLink = c.visibility === "public" || c.visibility === "lan";

          return `
            <div style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:12px;padding:1.25rem;margin-bottom:1rem">
              <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.75rem">
                <div>
                  <div style="font-weight:600;font-size:1.1rem">${escapeHtml(c.name)}</div>
                  <div style="font-size:0.85rem;color:var(--crow-text-muted);margin-top:0.15rem">
                    ${articleCounts[c.id]} published articles · Languages: ${escapeHtml(c.languages || "en")}
                  </div>
                </div>
                ${showLink ? `<a href="${escapeHtml(kbPublicUrl(c.slug, c.visibility))}" target="_blank" style="font-size:0.85rem;color:var(--crow-accent);white-space:nowrap">View public page →</a>` : ""}
              </div>

              <form method="POST" action="/dashboard/knowledge-base" style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:end">
                <input type="hidden" name="action" value="update_collection">
                <input type="hidden" name="collection_id" value="${c.id}">

                <div style="flex:1;min-width:200px">
                  <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">Sharing</label>
                  <select name="visibility" style="width:100%;padding:0.4rem 0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font-size:0.85rem">
                    ${visOptions}
                  </select>
                </div>

                <div style="display:flex;align-items:center;gap:0.4rem">
                  <input type="checkbox" name="lan_enabled" value="1" id="lan-${c.id}" ${lanChecked} style="accent-color:var(--crow-accent)">
                  <label for="lan-${c.id}" style="font-size:0.8rem;color:var(--crow-text-secondary);cursor:pointer" title="Advertise this KB on your local network via mDNS so devices can discover it automatically">mDNS discovery</label>
                </div>

                <button type="submit" style="padding:0.4rem 1rem;background:var(--crow-accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:500">Save</button>
              </form>
            </div>`;
        }).join("");

        tabContent = `
          <div style="background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-secondary)">
            <strong>Sharing modes:</strong>
            🔒 <strong>Private</strong> — only visible here in the Crow's Nest.
            🌐 <strong>Public</strong> — accessible to anyone at <code>/kb/your-collection</code>.
            🏢 <strong>LAN</strong> — only accessible from your local network (intranet).
            Enable <strong>mDNS</strong> to let devices on the network discover your KB automatically.
          </div>
          ${rows}`;
      }
    }

    // ─── IMPORT TAB ───
    if (tab === "import") {
      tabContent = `
        <div style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:8px;padding:1.5rem">
          <h3 style="margin-bottom:1rem">Import Guide</h3>
          <p style="color:var(--crow-text-secondary);margin-bottom:1rem;font-size:0.9rem">
            To import content into your knowledge base, use your AI assistant. Paste your guide content
            into the conversation and ask the AI to import it. The AI will:
          </p>
          <ul style="color:var(--crow-text-secondary);font-size:0.9rem;margin-left:1.5rem;margin-bottom:1rem">
            <li>Parse the content and structure it as a KB article</li>
            <li>Extract structured resource data (organizations, phone numbers, addresses)</li>
            <li>Create paired translations if you provide bilingual content</li>
            <li>Assign to a category you specify</li>
          </ul>
          <p style="color:var(--crow-text-muted);font-size:0.85rem">
            Example: "Import this housing guide into my Project Help knowledge base under the Housing category"
          </p>
        </div>`;
    }

    // ─── Tab navigation ───
    const tabs = [
      { id: "articles", label: "Articles", icon: "📄" },
      { id: "categories", label: "Categories", icon: "📁" },
      { id: "flagged", label: "Flagged", icon: "⚠️" },
      { id: "collections", label: "Collections", icon: "📚" },
      { id: "import", label: "Import", icon: "📥" },
    ];

    const tabNav = tabs.map(t => {
      const active = t.id === tab;
      const style = active
        ? "background:var(--crow-accent);color:#fff"
        : "background:var(--crow-bg-surface);color:var(--crow-text-secondary);border:1px solid var(--crow-border)";
      return `<a href="/dashboard/knowledge-base?tab=${t.id}${activeCollectionId ? `&collection_id=${activeCollectionId}` : ""}"
        style="padding:0.4rem 0.9rem;border-radius:6px;text-decoration:none;font-size:0.85rem;${style};display:inline-flex;align-items:center;gap:0.3rem"
        ${active ? 'aria-current="true"' : ""}>${t.icon} ${t.label}</a>`;
    }).join("\n");

    // Collection selector (for articles and categories tabs)
    const collectionSelector = (tab === "articles" || tab === "categories") && collections.length > 1 ? `
      <div style="margin-bottom:1rem">
        <label for="collection-select" style="font-size:0.85rem;color:var(--crow-text-muted);margin-right:0.5rem">Collection:</label>
        <select id="collection-select" onchange="location.href='/dashboard/knowledge-base?tab=${tab}&collection_id='+this.value"
          style="padding:0.3rem 0.5rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-primary);font-size:0.85rem">
          <option value="">All</option>
          ${collections.map(c => `<option value="${c.id}" ${String(c.id) === activeCollectionId ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
        </select>
      </div>` : "";

    const content = `
      <style>
        .kb-tabs { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.5rem; }
      </style>
      <nav class="kb-tabs" aria-label="Knowledge Base sections">${tabNav}</nav>
      ${collectionSelector}
      ${tabContent}
      <script>
        async function resolveFlag(id, action) {
          try {
            const res = await fetch('/dashboard/knowledge-base/api/kb/flags/' + id + '/resolve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action }),
            });
            if (res.ok) location.reload();
            else alert('Failed to resolve flag');
          } catch (e) { alert('Error: ' + e.message); }
        }
      </script>`;

    res.send(layout({ title: "Knowledge Base", content }));
  },
};
