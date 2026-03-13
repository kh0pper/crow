/**
 * Blog Panel — List, create, edit, preview, publish posts
 */

import { escapeHtml, statCard, statGrid, dataTable, section, formField, badge, actionBar, formatDate } from "../shared/components.js";
import { ICON_DEPLOY } from "../shared/empty-state-icons.js";

export default {
  id: "blog",
  name: "Blog",
  icon: "edit",
  route: "/dashboard/blog",
  navOrder: 20,

  async handler(req, res, { db, layout }) {
    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "create") {
        const { title, content, tags, visibility, cover_image_key } = req.body;
        if (!title || !content) {
          return layout({
            title: "Blog",
            content: `<div class="alert alert-error">Title and content are required.</div>`,
          });
        }
        const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
        await db.execute({
          sql: "INSERT INTO blog_posts (slug, title, content, visibility, tags, cover_image_key) VALUES (?, ?, ?, ?, ?, ?)",
          args: [slug, title, content, visibility || "private", tags || null, cover_image_key || null],
        });
        res.redirect("/dashboard/blog");
        return;
      }

      if (action === "publish") {
        await db.execute({
          sql: "UPDATE blog_posts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          args: [req.body.id],
        });
        res.redirect("/dashboard/blog");
        return;
      }

      if (action === "unpublish") {
        await db.execute({
          sql: "UPDATE blog_posts SET status = 'draft', updated_at = datetime('now') WHERE id = ?",
          args: [req.body.id],
        });
        res.redirect("/dashboard/blog");
        return;
      }

      if (action === "delete") {
        await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [req.body.id] });
        res.redirect("/dashboard/blog");
        return;
      }
    }

    // GET — show post list
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM blog_posts");
    const publishedResult = await db.execute("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'published'");
    const draftResult = await db.execute("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'draft'");

    const stats = statGrid([
      statCard("Total", totalResult.rows[0]?.c || 0, { delay: 0 }),
      statCard("Published", publishedResult.rows[0]?.c || 0, { delay: 50 }),
      statCard("Drafts", draftResult.rows[0]?.c || 0, { delay: 100 }),
    ]);

    // Live blog link
    const publicUrl = process.env.CROW_GATEWAY_URL || "";
    const blogBaseUrl = publicUrl ? `${publicUrl}/blog/` : `/blog/`;
    const blogLink = `<div style="background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
      <span style="font-weight:600;color:var(--crow-text)">Live Blog</span>
      <a href="${escapeHtml(blogBaseUrl)}" target="_blank" style="flex:1;min-width:200px;font-size:0.85rem;word-break:break-all">${escapeHtml(blogBaseUrl)}</a>
      <a href="${escapeHtml(blogBaseUrl)}feed.xml" target="_blank" class="btn btn-sm btn-secondary">RSS</a>
      <a href="${escapeHtml(blogBaseUrl)}feed.atom" target="_blank" class="btn btn-sm btn-secondary">Atom</a>
    </div>`;

    // Post list
    const posts = await db.execute({
      sql: "SELECT id, slug, title, status, visibility, tags, published_at, created_at, cover_image_key FROM blog_posts ORDER BY created_at DESC LIMIT 50",
      args: [],
    });

    let postTable;
    if (posts.rows.length === 0) {
      postTable = `<div class="empty-state">
        <div style="margin-bottom:1rem">${ICON_DEPLOY}</div>
        <h3>No posts yet</h3>
        <p>Create your first post below.</p>
      </div>`;
    } else {
      const rows = posts.rows.map((p) => {
        const statusBadge = badge(p.status, p.status === "published" ? "published" : "draft");
        const visBadge = p.visibility !== "private" ? ` ${badge(p.visibility, "connected")}` : "";
        const actions = p.status === "published"
          ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="unpublish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-secondary" type="submit">Unpublish</button></form>`
          : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="publish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-primary" type="submit">Publish</button></form>`;
        const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('Delete this post?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`;

        const thumb = p.cover_image_key
          ? `<img src="/blog/media/${escapeHtml(p.cover_image_key)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:0.5rem">`
          : "";
        return [
          `${thumb}${escapeHtml(p.title)}`,
          `${statusBadge}${visBadge}`,
          `<span class="mono">${escapeHtml(p.slug)}</span>`,
          `<span class="mono">${formatDate(p.published_at || p.created_at)}</span>`,
          `${actions} ${deleteBtn}`,
        ];
      });
      postTable = dataTable(["Title", "Status", "Slug", "Date", "Actions"], rows);
    }

    // Create form
    const createForm = `<form method="POST" id="create-post-form">
      <input type="hidden" name="action" value="create">
      <input type="hidden" name="cover_image_key" id="cover-image-key">
      ${formField("Title", "title", { required: true, placeholder: "Post title" })}
      ${formField("Content", "content", { type: "textarea", required: true, placeholder: "Write in Markdown...", rows: 8 })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        ${formField("Tags", "tags", { placeholder: "tag1, tag2, tag3" })}
        ${formField("Visibility", "visibility", { type: "select", options: [
          { value: "private", label: "Private" },
          { value: "public", label: "Public" },
          { value: "peers", label: "Peers Only" },
        ]})}
      </div>
      <div style="margin-top:1rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">Cover Image</label>
        <input type="file" name="cover_image" accept="image/*" id="cover-image-input" style="padding:0.4rem">
        <div id="cover-preview" style="margin-top:0.5rem;display:none">
          <img id="cover-preview-img" style="max-height:150px;border-radius:8px;border:1px solid var(--crow-border)">
        </div>
      </div>
      <button type="submit" class="btn btn-primary">Create Draft</button>
    </form>`;

    const content = `
      ${stats}
      ${blogLink}
      ${section("Posts", postTable, { delay: 150 })}
      ${section("New Post", createForm, { delay: 200 })}
      <script>
      (function() {
        var fileInput = document.getElementById('cover-image-input');
        var preview = document.getElementById('cover-preview');
        var previewImg = document.getElementById('cover-preview-img');
        var keyInput = document.getElementById('cover-image-key');
        var form = document.getElementById('create-post-form');

        if (fileInput) {
          fileInput.addEventListener('change', function() {
            if (this.files && this.files[0]) {
              var reader = new FileReader();
              reader.onload = function(e) {
                previewImg.src = e.target.result;
                preview.style.display = 'block';
              };
              reader.readAsDataURL(this.files[0]);
            } else {
              preview.style.display = 'none';
            }
          });
        }

        if (form) {
          form.addEventListener('submit', async function(e) {
            if (!fileInput || !fileInput.files || !fileInput.files[0]) return;

            e.preventDefault();
            var submitBtn = form.querySelector('button[type="submit"]');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Uploading image...';

            try {
              var formData = new FormData();
              formData.append('file', fileInput.files[0]);
              formData.append('reference_type', 'blog_post');

              var res = await fetch('/storage/upload', {
                method: 'POST',
                body: formData,
              });

              if (!res.ok) {
                var err = await res.json().catch(function() { return {}; });
                alert('Image upload failed: ' + (err.error || 'Unknown error'));
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Draft';
                return;
              }

              var data = await res.json();
              keyInput.value = data.key;

              fileInput.disabled = true;
              submitBtn.textContent = 'Creating post...';
              form.submit();
            } catch (err) {
              alert('Upload error: ' + err.message);
              submitBtn.disabled = false;
              submitBtn.textContent = 'Create Draft';
            }
          });
        }
      })();
      <\/script>
    `;

    return layout({ title: "Blog", content });
  },
};
