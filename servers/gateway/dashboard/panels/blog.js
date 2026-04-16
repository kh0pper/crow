/**
 * Blog Panel — List, create, edit, preview, publish posts
 */

import { escapeHtml, dataTable, section, formField, badge, actionBar, formatDate } from "../shared/components.js";
import { ICON_DEPLOY } from "../shared/empty-state-icons.js";
import { t, tJs } from "../shared/i18n.js";

export default {
  id: "blog",
  name: "Blog",
  icon: "edit",
  route: "/dashboard/blog",
  navOrder: 20,
  category: "content",

  async handler(req, res, { db, layout, lang }) {
    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "create") {
        const { title, content, tags, visibility, cover_image_key } = req.body;
        if (!title || !content) {
          return layout({
            title: t("blog.pageTitle", lang),
            content: `<div class="alert alert-error">${t("blog.titleAndContentRequired", lang)}</div>`,
          });
        }
        const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
        await db.execute({
          sql: "INSERT INTO blog_posts (slug, title, content, visibility, tags, cover_image_key) VALUES (?, ?, ?, ?, ?, ?)",
          args: [slug, title, content, visibility || "private", tags || null, cover_image_key || null],
        });
        res.redirectAfterPost("/dashboard/blog");
        return;
      }

      if (action === "publish") {
        await db.execute({
          sql: "UPDATE blog_posts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          args: [req.body.id],
        });
        res.redirectAfterPost("/dashboard/blog");
        return;
      }

      if (action === "unpublish") {
        await db.execute({
          sql: "UPDATE blog_posts SET status = 'draft', updated_at = datetime('now') WHERE id = ?",
          args: [req.body.id],
        });
        res.redirectAfterPost("/dashboard/blog");
        return;
      }

      if (action === "delete") {
        await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [req.body.id] });
        res.redirectAfterPost("/dashboard/blog");
        return;
      }

      if (action === "toggle_songbook_index") {
        const current = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_songbook_on_index'", args: [] });
        const newVal = (current.rows[0]?.value === "false") ? "true" : "false";
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('blog_songbook_on_index', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [newVal, newVal],
        });
        res.redirectAfterPost("/dashboard/blog");
        return;
      }

      if (action === "edit") {
        const { id, title, content, tags, visibility, cover_image_key } = req.body;
        if (!id || !title || !content) {
          return res.redirectAfterPost("/dashboard/blog");
        }
        const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
        await db.execute({
          sql: "UPDATE blog_posts SET title = ?, slug = ?, content = ?, tags = ?, visibility = ?, cover_image_key = ?, updated_at = datetime('now') WHERE id = ?",
          args: [title, slug, content, tags || null, visibility || "private", cover_image_key || null, id],
        });
        res.redirectAfterPost("/dashboard/blog");
        return;
      }
    }

    // GET — show post list
    // Check if editing a post
    let editPost = null;
    const editId = req.query.edit;
    if (editId) {
      const { rows } = await db.execute({
        sql: "SELECT * FROM blog_posts WHERE id = ?",
        args: [parseInt(editId, 10)],
      });
      editPost = rows[0] || null;
    }

    // Songbook index setting
    const songbookSettingResult = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_songbook_on_index'", args: [] });
    const songbookOnIndex = songbookSettingResult.rows[0]?.value !== "false";

    // Live blog link
    const publicUrl = process.env.CROW_GATEWAY_URL || "";
    const blogBaseUrl = publicUrl ? `${publicUrl}/blog/` : `/blog/`;
    const blogLink = `<div style="background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
      <span style="font-weight:600;color:var(--crow-text)">${t("blog.liveBlog", lang)}</span>
      <a href="${escapeHtml(blogBaseUrl)}" target="_blank" style="flex:1;min-width:200px;font-size:0.85rem;word-break:break-all">${escapeHtml(blogBaseUrl)}</a>
      <a href="${escapeHtml(blogBaseUrl)}songbook" target="_blank" class="btn btn-sm btn-secondary">Songbook</a>
      <a href="${escapeHtml(blogBaseUrl)}feed.xml" target="_blank" class="btn btn-sm btn-secondary">${t("blog.rss", lang)}</a>
      <a href="${escapeHtml(blogBaseUrl)}feed.atom" target="_blank" class="btn btn-sm btn-secondary">${t("blog.atom", lang)}</a>
      <form method="POST" style="margin:0;display:inline-flex;align-items:center;gap:0.5rem">
        <input type="hidden" name="action" value="toggle_songbook_index">
        <label style="font-size:0.8rem;color:var(--crow-text-muted);cursor:pointer;display:inline-flex;align-items:center;gap:0.35rem">
          <input type="checkbox" ${songbookOnIndex ? "checked" : ""} onchange="this.form.submit()" style="cursor:pointer">
          Songs on blog index
        </label>
      </form>
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
        <h3>${t("blog.noPostsYet", lang)}</h3>
        <p>${t("blog.createFirstPost", lang)}</p>
      </div>`;
    } else {
      const rows = posts.rows.map((p) => {
        const statusBadge = badge(p.status, p.status === "published" ? "published" : "draft");
        const visBadge = p.visibility !== "private" ? ` ${badge(p.visibility, "connected")}` : "";
        const actions = p.status === "published"
          ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="unpublish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-secondary" type="submit">${t("blog.unpublish", lang)}</button></form>`
          : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="publish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-primary" type="submit">${t("blog.publish", lang)}</button></form>`;
        const editBtn = `<a href="?edit=${p.id}" class="btn btn-sm btn-secondary">${t("blog.edit", lang)}</a>`;
        const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('${tJs("blog.deleteConfirm", lang)}')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-danger" type="submit">${t("blog.delete", lang)}</button></form>`;

        const thumb = p.cover_image_key
          ? `<img src="/blog/media/${escapeHtml(p.cover_image_key)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:0.5rem">`
          : "";
        return [
          `${thumb}<a href="?edit=${p.id}" style="color:var(--crow-text-primary);text-decoration:none">${escapeHtml(p.title)}</a>`,
          `${statusBadge}${visBadge}`,
          `<span class="mono">${escapeHtml(p.slug)}</span>`,
          `<span class="mono">${formatDate(p.published_at || p.created_at, lang)}</span>`,
          `${editBtn} ${actions} ${deleteBtn}`,
        ];
      });
      postTable = dataTable([t("blog.tableTitle", lang), t("blog.tableStatus", lang), t("blog.tableSlug", lang), t("blog.tableDate", lang), t("blog.tableActions", lang)], rows);
    }

    // Post form (create or edit)
    const isEdit = !!editPost;
    const formTitle = isEdit ? `${t("blog.editPrefix", lang)} ${escapeHtml(editPost.title)}` : t("blog.newPost", lang);
    const formAction = isEdit ? "edit" : "create";
    const submitLabel = isEdit ? t("blog.saveChanges", lang) : t("blog.createDraft", lang);
    const cancelLink = isEdit ? ` <a href="/dashboard/blog" class="btn btn-secondary" style="margin-left:0.5rem">${t("common.cancel", lang)}</a>` : "";

    const postForm = `<form method="POST" id="create-post-form">
      <input type="hidden" name="action" value="${formAction}">
      ${isEdit ? `<input type="hidden" name="id" value="${editPost.id}">` : ""}
      <input type="hidden" name="cover_image_key" id="cover-image-key" value="${isEdit && editPost.cover_image_key ? escapeHtml(editPost.cover_image_key) : ""}">
      ${formField(t("blog.titleLabel", lang), "title", { required: true, placeholder: t("blog.titlePlaceholder", lang), value: isEdit ? editPost.title : "" })}
      <style>
        .md-toolbar { display:flex;gap:2px;padding:4px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-bottom:none;border-radius:8px 8px 0 0;flex-wrap:wrap; }
        .md-btn { background:transparent;border:1px solid transparent;color:var(--crow-text-secondary);padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.85rem;font-family:'DM Sans',sans-serif; }
        .md-btn:hover { background:var(--crow-bg-surface);border-color:var(--crow-border);color:var(--crow-text-primary); }
        .md-sep { width:1px;background:var(--crow-border);margin:2px 4px; }
        #create-post-form textarea[name="content"] { border-radius:0 0 8px 8px !important; }
      </style>
      <div class="md-toolbar">
        <button type="button" onclick="mdWrap('**','**')" title="${t("blog.boldTitle", lang)}" class="md-btn"><b>B</b></button>
        <button type="button" onclick="mdWrap('*','*')" title="${t("blog.italicTitle", lang)}" class="md-btn"><i>I</i></button>
        <button type="button" onclick="mdPrefix('## ')" title="${t("blog.heading2Title", lang)}" class="md-btn">H2</button>
        <button type="button" onclick="mdPrefix('### ')" title="${t("blog.heading3Title", lang)}" class="md-btn">H3</button>
        <span class="md-sep"></span>
        <button type="button" onclick="mdLink()" title="${t("blog.linkTitle", lang)}" class="md-btn">Link</button>
        <button type="button" onclick="mdImage()" title="${t("blog.imageTitle", lang)}" class="md-btn">Img</button>
        <span class="md-sep"></span>
        <button type="button" onclick="mdPrefix('- ')" title="${t("blog.bulletListTitle", lang)}" class="md-btn">UL</button>
        <button type="button" onclick="mdPrefix('1. ')" title="${t("blog.numberedListTitle", lang)}" class="md-btn">OL</button>
        <button type="button" onclick="mdPrefix('> ')" title="${t("blog.quoteTitle", lang)}" class="md-btn">&gt;</button>
        <span class="md-sep"></span>
        <button type="button" onclick="mdWrap('\\\`','\\\`')" title="${t("blog.inlineCodeTitle", lang)}" class="md-btn">&lt;/&gt;</button>
        <button type="button" onclick="mdCodeBlock()" title="${t("blog.codeBlockTitle", lang)}" class="md-btn">\`\`\`</button>
        <button type="button" onclick="mdInsert('\\n---\\n')" title="${t("blog.horizontalRuleTitle", lang)}" class="md-btn">HR</button>
      </div>
      ${formField(t("blog.contentLabel", lang), "content", { type: "textarea", required: true, placeholder: t("blog.contentPlaceholder", lang), rows: 10, value: isEdit ? editPost.content : "" })}
      <div style="margin:-0.5rem 0 0.75rem;display:flex;gap:0.5rem;align-items:center">
        <button type="button" class="btn btn-sm btn-secondary" onclick="togglePreview()">${t("blog.togglePreview", lang)}</button>
        <span id="preview-label" style="font-size:0.8rem;color:var(--crow-text-muted);display:none">${t("blog.previewLabel", lang)}</span>
      </div>
      <div id="markdown-preview" style="display:none;border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:1rem;background:var(--crow-bg-elevated);min-height:100px;max-height:400px;overflow:auto"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        ${formField(t("blog.tagsLabel", lang), "tags", { placeholder: t("blog.tagsPlaceholder", lang), value: isEdit ? (editPost.tags || "") : "" })}
        ${formField(t("blog.visibilityLabel", lang), "visibility", { type: "select", value: isEdit ? editPost.visibility : "private", options: [
          { value: "private", label: t("blog.visibilityPrivate", lang) },
          { value: "public", label: t("blog.visibilityPublic", lang) },
          { value: "peers", label: t("blog.visibilityPeers", lang) },
        ]})}
      </div>
      <div style="margin-top:1rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">${t("blog.coverImage", lang)}</label>
        <input type="file" name="cover_image" accept="image/*" id="cover-image-input" style="padding:0.4rem">
        <div id="cover-preview" style="margin-top:0.5rem;display:none">
          <img id="cover-preview-img" style="max-height:150px;border-radius:8px;border:1px solid var(--crow-border)">
        </div>
      </div>
      <div style="margin-top:1rem">
        <button type="submit" class="btn btn-primary">${submitLabel}</button>${cancelLink}
      </div>
    </form>`;

    const content = `
      ${blogLink}
      ${section(t("blog.postsSection", lang), postTable, { delay: 150 })}
      ${section(formTitle, postForm, { delay: 200 })}
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
                submitBtn.textContent = '${tJs("blog.createDraft", lang)}';
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
              submitBtn.textContent = '${tJs("blog.createDraft", lang)}';
            }
          });
        }
      })();

      // Markdown preview toggle — server renders and sanitizes HTML via sanitize-html
      var _previewVisible = false;
      var _previewTimer = null;
      function togglePreview() {
        var previewEl = document.getElementById('markdown-preview');
        var label = document.getElementById('preview-label');
        _previewVisible = !_previewVisible;
        previewEl.style.display = _previewVisible ? 'block' : 'none';
        label.style.display = _previewVisible ? 'inline' : 'none';
        if (_previewVisible) {
          updatePreview();
          var textarea = document.querySelector('textarea[name="content"]');
          if (textarea) textarea.addEventListener('input', debouncePreview);
        }
      }
      function debouncePreview() {
        clearTimeout(_previewTimer);
        _previewTimer = setTimeout(updatePreview, 500);
      }
      async function updatePreview() {
        var textarea = document.querySelector('textarea[name="content"]');
        var previewEl = document.getElementById('markdown-preview');
        if (!textarea || !previewEl) return;
        var md = textarea.value;
        if (!md.trim()) { previewEl.textContent = '${tJs("blog.startTypingPreview", lang)}'; return; }
        try {
          var res = await fetch('/blog/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdown: md }),
          });
          var data = await res.json();
          if (data.html) {
            // Safe: HTML is sanitized server-side by sanitize-html in renderer.js
            previewEl.replaceChildren();
            var wrapper = document.createElement('div');
            wrapper.insertAdjacentHTML('afterbegin', data.html);
            previewEl.appendChild(wrapper);
          } else {
            previewEl.textContent = data.error || '${tJs("blog.previewFailed", lang)}';
          }
        } catch (e) {
          previewEl.textContent = 'Preview error: ' + e.message;
        }
      }

      // Markdown toolbar helpers
      function _ta() { return document.querySelector('textarea[name="content"]'); }

      function mdWrap(before, after) {
        var ta = _ta(); if (!ta) return;
        var start = ta.selectionStart, end = ta.selectionEnd;
        var selected = ta.value.substring(start, end);
        var replacement = before + (selected || 'text') + after;
        ta.setRangeText(replacement, start, end, 'end');
        if (!selected) { ta.selectionStart = start + before.length; ta.selectionEnd = start + before.length + 4; }
        ta.focus();
      }

      function mdPrefix(prefix) {
        var ta = _ta(); if (!ta) return;
        var start = ta.selectionStart;
        var lineStart = ta.value.lastIndexOf('\\n', start - 1) + 1;
        ta.setRangeText(prefix, lineStart, lineStart, 'end');
        ta.focus();
      }

      function mdInsert(text) {
        var ta = _ta(); if (!ta) return;
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
        ta.focus();
      }

      function mdLink() {
        var ta = _ta(); if (!ta) return;
        var selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
        var text = selected || 'link text';
        ta.setRangeText('[' + text + '](url)', ta.selectionStart, ta.selectionEnd, 'end');
        ta.focus();
      }

      function mdImage() {
        var ta = _ta(); if (!ta) return;
        ta.setRangeText('![alt](url)', ta.selectionStart, ta.selectionEnd, 'end');
        ta.focus();
      }

      function mdCodeBlock() {
        var ta = _ta(); if (!ta) return;
        var selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
        ta.setRangeText('\\n\`\`\`\\n' + (selected || 'code') + '\\n\`\`\`\\n', ta.selectionStart, ta.selectionEnd, 'end');
        ta.focus();
      }
      <\/script>
    `;

    return layout({ title: t("blog.pageTitle", lang), content });
  },
};
