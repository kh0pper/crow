/** Reader — pure HTML renderers for the Read view (no Express, testable). */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tableHtml(md) {
  const lines = md.split("\n").filter((l) => l.trim().startsWith("|"));
  const rows = lines
    .filter((l) => !/^\|[\s\-:|]+\|$/.test(l.trim()))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  if (!rows.length) return `<pre>${escapeHtml(md)}</pre>`;
  const [head, ...body] = rows;
  const th = head.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const trs = body.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="er-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

export function renderParagraph(raw, index) {
  if (raw.startsWith("[TABLE]\n")) {
    return `<div class="er-para er-table" data-para="${index}">${tableHtml(raw.slice(8))}</div>`;
  }
  return `<div class="er-para" data-para="${index}">${escapeHtml(raw)}</div>`;
}

export function readerPage({ document, section, sections, paragraphs, progress }) {
  const data = JSON.stringify({
    documentId: Number(document.id),
    sectionNumber: Number(section.section_number),
    totalParagraphs: paragraphs.length,
    resumeParagraph: progress ? Number(progress.paragraph) : 0,
  }).replace(/</g, "\\u003c");

  const sectionNav = sections.length > 1
    ? `<nav class="er-sections">${sections.map((s) =>
        `<a href="/reader-app/${Number(document.id)}?section=${s.section_number}"
           class="${s.section_number === Number(section.section_number) ? "active" : ""}">
           ${escapeHtml(s.title || `Part ${s.section_number}`)}</a>`).join("")}</nav>`
    : "";

  const body = paragraphs.map((p, i) => renderParagraph(p, i)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="turbo-visit-control" content="reload">
<title>${escapeHtml(document.title || "Reader")}</title>
<link rel="stylesheet" href="/reader/static/reader.css">
</head>
<body>
<header class="er-header">
  <a class="er-back" href="/dashboard/reader">&larr; Library</a>
  <h1>${escapeHtml(document.title || "Untitled")}</h1>
  ${document.extraction_status !== "ok"
    ? `<span class="er-status er-status-${escapeHtml(document.extraction_status)}">${escapeHtml(document.extraction_status)}</span>`
    : ""}
</header>
${sectionNav}
<main id="er-reading-pane" class="er-reading-pane">
<div id="er-content">
${body}
</div>
</main>
<script type="application/json" id="reader-data">${data}</script>
<script src="/reader/static/reader.js" type="module"></script>
</body>
</html>`;
}
