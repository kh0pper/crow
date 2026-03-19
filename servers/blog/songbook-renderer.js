/**
 * Songbook Renderer — Full HTML output for song pages
 *
 * Renders ChordPro content into a complete song page with:
 * - Hero section (album art, title, artist, metadata pills)
 * - Transpose controls (12 key buttons + step arrows)
 * - Chord diagram panel (instrument toggle, SVG grid)
 * - Chords-over-lyrics chart
 * - Audio player with waveform + download
 * - Print-friendly CSS
 */

import { parseChordPro, transposeAst, renderChordProHtml, extractChords, parseSongMeta } from "./chordpro.js";
import { getChordDiagram } from "./chord-diagrams.js";
import { parsePodcastMeta } from "./podcast-rss.js";
import { FONT_IMPORT, designTokensCss } from "../gateway/dashboard/shared/design-tokens.js";

const KEYS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch { return dateStr; }
}

/**
 * Scoped songbook CSS variables and styles.
 */
function songbookCss() {
  return `
  :root {
    --songbook-chord-color: #2997ff;
    --songbook-audio-color: #30d158;
  }

  body {
    font-family: var(--crow-body-font, 'DM Sans', sans-serif);
    background: var(--crow-bg-deep);
    color: var(--crow-text-primary);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }

  .page { max-width: 800px; margin: 0 auto; padding: 0 24px 60px; }

  /* Nav */
  .nav {
    position: sticky; top: 0; z-index: 100;
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    background: rgba(15,15,23,0.72);
    border-bottom: 0.5px solid var(--crow-border);
    padding: 12px 24px;
  }
  .nav-inner { max-width: 800px; margin: 0 auto; display: flex; align-items: center; gap: 16px; }
  .nav-brand { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; color: var(--crow-text-muted); }
  .nav-crumb { font-size: 13px; color: var(--crow-text-muted); }
  .nav-crumb a { color: var(--songbook-chord-color); text-decoration: none; }

  /* Hero */
  .hero { padding: 48px 0 40px; display: flex; gap: 32px; align-items: flex-start; }
  .album-art {
    width: 180px; height: 180px; border-radius: 12px; flex-shrink: 0;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
  }
  .album-art::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.03) 100%);
  }
  .album-art-text { font-size: 48px; opacity: 0.15; font-weight: 700; letter-spacing: -2px; }
  .album-art img { width: 100%; height: 100%; object-fit: cover; }
  .hero-info { padding-top: 8px; flex: 1; }
  .hero-info .label {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1.5px; color: var(--songbook-chord-color); margin-bottom: 6px;
  }
  .song-title {
    font-family: 'Fraunces', serif; font-size: 2.2rem; font-weight: 700;
    letter-spacing: -0.5px; line-height: 1.15; margin-bottom: 6px;
  }
  .song-artist { font-size: 1.15rem; color: var(--crow-text-secondary); margin-bottom: 20px; }
  .meta-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    background: rgba(255,255,255,0.06); backdrop-filter: blur(8px);
    border-radius: 100px; padding: 5px 14px; font-size: 13px; font-weight: 500;
    color: var(--crow-text-secondary); border: 0.5px solid rgba(255,255,255,0.08);
  }
  .pill .val { color: var(--crow-text-primary); font-weight: 600; }

  /* Transpose */
  .transpose-section { margin-bottom: 28px; }
  .transpose-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .transpose-label {
    font-size: 13px; font-weight: 500; color: var(--crow-text-muted);
    margin-right: 8px; min-width: 60px;
  }
  .key-chip {
    width: 36px; height: 32px; border-radius: 8px; border: none;
    background: rgba(255,255,255,0.06); color: var(--crow-text-muted);
    font-size: 13px; font-weight: 600; font-family: 'JetBrains Mono', monospace;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    text-decoration: none; transition: all 0.2s;
  }
  .key-chip:hover { background: rgba(255,255,255,0.1); color: var(--crow-text-primary); }
  .key-chip.active {
    background: rgba(41,151,255,0.15); color: var(--songbook-chord-color);
    box-shadow: 0 0 0 1.5px rgba(41,151,255,0.4);
  }

  /* Chord diagrams card */
  .diagrams-card {
    background: rgba(255,255,255,0.03); backdrop-filter: blur(12px);
    border-radius: 16px; border: 0.5px solid rgba(255,255,255,0.06);
    padding: 20px 24px; margin-bottom: 32px;
  }
  .diagrams-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .diagrams-header h3 {
    font-size: 13px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1px; color: var(--crow-text-muted);
  }
  .instrument-tabs {
    display: flex; background: rgba(255,255,255,0.06);
    border-radius: 8px; padding: 2px; gap: 2px;
  }
  .inst-tab {
    padding: 4px 14px; border-radius: 6px; border: none;
    background: transparent; color: var(--crow-text-muted);
    font-size: 12px; font-weight: 600; font-family: inherit;
    cursor: pointer; text-decoration: none;
  }
  .inst-tab.active { background: rgba(255,255,255,0.12); color: var(--crow-text-primary); }
  .diagrams-grid {
    display: flex; gap: 20px; flex-wrap: wrap; overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .diagram { text-align: center; flex-shrink: 0; }
  .diagram .name {
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
    font-weight: 600; color: var(--crow-text-secondary); margin-bottom: 8px;
  }
  .diagram .fretbox { width: 44px; height: 58px; margin: 0 auto; }
  .diagram .fretbox svg { width: 100%; height: 100%; }
  .diagram .pianobox { width: 84px; height: 48px; margin: 0 auto; }
  .diagram .pianobox svg { width: 100%; height: 100%; }

  /* Chart */
  .chart-section { margin-bottom: 40px; }
  .section-heading {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 2px; color: rgba(255,255,255,0.2);
    margin: 32px 0 16px; padding-bottom: 8px;
    border-bottom: 0.5px solid rgba(255,255,255,0.06);
  }
  .section-heading:first-child { margin-top: 0; }
  .chart-line { font-family: 'JetBrains Mono', monospace; font-size: 14px; line-height: 1.3; white-space: pre-wrap; }
  .chords-row { color: var(--songbook-chord-color); font-weight: 600; letter-spacing: 0.3px; margin-bottom: 1px; }
  .lyrics-row { color: var(--crow-text-secondary); font-weight: 400; margin-bottom: 16px; }
  .song-comment {
    font-style: italic; color: var(--crow-text-muted);
    margin: 8px 0; font-size: 13px;
  }

  /* Audio player */
  .player-card {
    background: rgba(255,255,255,0.03); backdrop-filter: blur(20px);
    border-radius: 16px; border: 0.5px solid rgba(255,255,255,0.06);
    padding: 24px; margin-bottom: 32px;
  }
  .player-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 2px; color: rgba(255,255,255,0.2); margin-bottom: 16px;
  }
  .player-controls { display: flex; align-items: center; gap: 16px; }
  .player-controls audio { flex: 1; height: 40px; }
  .download-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--songbook-chord-color); font-size: 13px; font-weight: 500;
    text-decoration: none; padding: 8px 16px; border-radius: 100px;
    background: rgba(41,151,255,0.08); transition: background 0.2s;
  }
  .download-link:hover { background: rgba(41,151,255,0.15); }

  /* Tags */
  .tags { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 32px; }
  .tag {
    background: rgba(255,255,255,0.04); border-radius: 100px;
    padding: 4px 12px; font-size: 12px; font-weight: 500;
    color: var(--crow-text-muted); border: 0.5px solid rgba(255,255,255,0.06);
  }

  /* Footer */
  .post-footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--crow-border); color: var(--crow-text-muted); font-size: 0.85rem; }
  .post-footer a { color: var(--songbook-chord-color); text-decoration: none; }

  /* Mobile responsive */
  @media (max-width: 640px) {
    .hero { flex-direction: column; gap: 20px; padding: 32px 0 24px; }
    .album-art { width: 120px; height: 120px; }
    .song-title { font-size: 1.6rem; }
    .transpose-row { gap: 4px; }
    .key-chip { width: 30px; height: 28px; font-size: 11px; }
    .chart-line { font-size: 12px; }
    .diagrams-grid { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 8px; }
  }

  /* Print */
  @media print {
    body { background: white; color: black; }
    .nav, .transpose-section, .player-card, .instrument-tabs, .post-footer { display: none; }
    .diagrams-card { border: 1px solid #ccc; background: white; backdrop-filter: none; }
    .album-art { display: none; }
    .hero { padding: 16px 0; }
    .song-title { color: black; }
    .song-artist { color: #333; }
    .pill { background: #f0f0f0; color: #333; border-color: #ccc; }
    .pill .val { color: black; }
    .chords-row { color: #000; font-weight: 700; }
    .lyrics-row { color: #333; }
    .section-heading { color: #666; border-color: #ccc; }
    .tag { background: #f0f0f0; color: #333; border-color: #ccc; }
    .page { max-width: 100%; }
  }`;
}

/**
 * Render a full song page HTML.
 * @param {object} post - Blog post row
 * @param {object} [options]
 * @param {string} [options.targetKey] - Transpose to this key
 * @param {string} [options.instrument] - "guitar" or "piano"
 * @param {object} [options.blogSettings] - Blog settings for header
 * @returns {string} Full HTML page
 */
export function renderSongPage(post, options = {}) {
  const { targetKey, instrument = "guitar", blogSettings = {} } = options;
  const songMeta = parseSongMeta(post.content);
  const podcastMeta = parsePodcastMeta(post.content);

  let ast = parseChordPro(post.content);
  // Merge metadata from bold-key header into AST meta
  if (!ast.meta.key && songMeta.key) ast.meta.key = songMeta.key;
  if (!ast.meta.tempo && songMeta.tempo) ast.meta.tempo = songMeta.tempo;
  if (!ast.meta.time && songMeta.time) ast.meta.time = songMeta.time;
  if (!ast.meta.capo && songMeta.capo) ast.meta.capo = songMeta.capo;
  if (!ast.meta.title) ast.meta.title = post.title;
  if (!ast.meta.subtitle && songMeta.artist) ast.meta.subtitle = songMeta.artist;

  const originalKey = ast.meta.key;
  const displayKey = targetKey || originalKey;

  // Transpose if needed
  if (targetKey && originalKey && targetKey !== originalKey) {
    ast = transposeAst(ast, targetKey);
  }

  // Extract chords and generate diagrams
  const chordNames = extractChords(ast);
  const diagrams = chordNames.map((name) => {
    const result = getChordDiagram(name, instrument);
    return { name, svg: result?.svg || "", voicing: result?.voicing };
  });

  const artist = songMeta.artist || post.author || "";
  const albumArtInitials = artist ? artist.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase() : "♪";
  const tags = (post.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

  // Audio URL
  let audioUrl = null;
  if (podcastMeta.audioUrl) {
    audioUrl = podcastMeta.audioUrl.startsWith("storage:")
      ? `/blog/media/${podcastMeta.audioUrl.replace("storage:", "")}`
      : podcastMeta.audioUrl;
  }

  const baseUrl = `/blog/songbook/${escapeHtml(post.slug)}`;

  // Build page
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(post.title)} — ${escapeHtml(blogSettings.title || "Songbook")}</title>
<meta property="og:title" content="${escapeHtml(post.title)}">
<meta property="og:type" content="music.song">
<style>
  ${FONT_IMPORT}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  ${designTokensCss()}
  ${songbookCss()}
</style>
</head>
<body>

<div class="nav">
  <div class="nav-inner">
    <span class="nav-brand">Crow</span>
    <span class="nav-crumb"><a href="/blog/songbook">Songbook</a> / ${escapeHtml(post.title)}</span>
  </div>
</div>

<div class="page">

  <!-- Hero -->
  <div class="hero">
    <div class="album-art">
      ${post.cover_image_key
        ? `<img src="/blog/media/${encodeURIComponent(post.cover_image_key)}" alt="${escapeHtml(post.title)}">`
        : `<span class="album-art-text">${escapeHtml(albumArtInitials)}</span>`}
    </div>
    <div class="hero-info">
      <div class="label">Songbook</div>
      <h1 class="song-title">${escapeHtml(post.title)}</h1>
      ${artist ? `<div class="song-artist">${escapeHtml(artist)}</div>` : ""}
      <div class="meta-pills">
        ${displayKey ? `<span class="pill">Key <span class="val">${escapeHtml(displayKey)}</span></span>` : ""}
        ${ast.meta.capo ? `<span class="pill">Capo <span class="val">${escapeHtml(ast.meta.capo)}</span></span>` : ""}
        ${ast.meta.time ? `<span class="pill">${escapeHtml(ast.meta.time)} time</span>` : ""}
        ${ast.meta.tempo ? `<span class="pill">${escapeHtml(ast.meta.tempo)} bpm</span>` : ""}
      </div>
    </div>
  </div>`;

  // Transpose controls
  if (originalKey) {
    html += `
  <div class="transpose-section">
    <div class="transpose-row">
      <span class="transpose-label">Transpose</span>
      ${KEYS.map((k) =>
        `<a href="${baseUrl}?key=${encodeURIComponent(k)}${instrument !== "guitar" ? `&instrument=${instrument}` : ""}" class="key-chip${k === displayKey ? " active" : ""}">${escapeHtml(k)}</a>`
      ).join("\n      ")}
    </div>
  </div>`;
  }

  // Chord diagrams
  if (diagrams.length > 0) {
    const diagramBoxClass = instrument === "piano" ? "pianobox" : "fretbox";
    html += `
  <div class="diagrams-card">
    <div class="diagrams-header">
      <h3>Chord Voicings</h3>
      <div class="instrument-tabs">
        <a href="${baseUrl}?instrument=guitar${displayKey ? `&key=${encodeURIComponent(displayKey)}` : ""}" class="inst-tab${instrument === "guitar" ? " active" : ""}">Guitar</a>
        <a href="${baseUrl}?instrument=piano${displayKey ? `&key=${encodeURIComponent(displayKey)}` : ""}" class="inst-tab${instrument === "piano" ? " active" : ""}">Piano</a>
      </div>
    </div>
    <div class="diagrams-grid">
      ${diagrams.map((d) => `<div class="diagram">
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="${diagramBoxClass}">${d.svg}</div>
      </div>`).join("\n      ")}
    </div>
  </div>`;
  }

  // Chord chart
  const chartHtml = renderChordProHtml(ast);
  html += `
  <div class="chart-section">
    ${chartHtml}
  </div>`;

  // Audio player
  if (audioUrl) {
    html += `
  <div class="player-card">
    <div class="player-title">Recording</div>
    <div class="player-controls">
      <audio controls preload="metadata" src="${escapeHtml(audioUrl)}"></audio>
      <a href="${escapeHtml(audioUrl)}" download class="download-link">&#8595; Download</a>
    </div>
  </div>`;
  }

  // Tags
  if (tags.length > 0) {
    html += `
  <div class="tags">
    ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("\n    ")}
  </div>`;
  }

  // Footer
  html += `
  <div class="post-footer">
    <a href="/blog/songbook">&larr; Back to Songbook</a>
    ${post.published_at ? ` &middot; ${formatDate(post.published_at)}` : ""}
  </div>

</div>
</body>
</html>`;

  return html;
}

/**
 * Render the songbook index page.
 * @param {Array} posts - Array of published songbook post rows
 * @param {object} [options]
 * @param {object} [options.blogSettings] - Blog settings
 * @returns {string} Full HTML page
 */
export function renderSongbookIndex(posts, options = {}) {
  const { blogSettings = {} } = options;

  // Collect unique tags (excluding "songbook")
  const tagCounts = {};
  for (const post of posts) {
    const tags = (post.tags || "").split(",").map((t) => t.trim()).filter((t) => t && t !== "songbook");
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const songRows = posts.map((post, i) => {
    const meta = parseSongMeta(post.content);
    const podcastMeta = parsePodcastMeta(post.content);
    const hasAudio = !!podcastMeta.audioUrl;
    const artist = meta.artist || post.author || "";
    const key = meta.key || "";

    return `<a href="/blog/songbook/${escapeHtml(post.slug)}" class="song-row">
      <span class="num">${i + 1}</span>
      <div class="info">
        <div class="name">${escapeHtml(post.title)}</div>
        <div class="artist">${escapeHtml(artist)}</div>
      </div>
      <span class="key-badge">${escapeHtml(key)}</span>
      <span class="audio-indicator">${hasAudio ? "&#9835;" : ""}</span>
    </a>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Songbook — ${escapeHtml(blogSettings.title || "Crow Blog")}</title>
<style>
  ${FONT_IMPORT}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  ${designTokensCss()}
  ${songbookCss()}

  .index-hero { padding: 48px 0 28px; }
  .index-hero h2 { font-family: 'Fraunces', serif; font-size: 2rem; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 4px; }
  .index-hero p { color: var(--crow-text-muted); font-size: 15px; }
  .filter-bar { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
  .filter-chip {
    padding: 6px 16px; border-radius: 100px; border: none;
    background: rgba(255,255,255,0.06); color: var(--crow-text-muted);
    font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit;
    text-decoration: none; transition: all 0.2s;
  }
  .filter-chip:hover { background: rgba(255,255,255,0.1); color: var(--crow-text-primary); }
  .filter-chip.active { background: rgba(41,151,255,0.12); color: var(--songbook-chord-color); }
  .song-list {
    border-radius: 12px; overflow: hidden;
    border: 0.5px solid rgba(255,255,255,0.06);
  }
  .song-row {
    display: flex; align-items: center; padding: 14px 20px;
    border-bottom: 0.5px solid rgba(255,255,255,0.04);
    transition: background 0.15s; cursor: pointer; text-decoration: none; color: inherit;
  }
  .song-row:hover { background: rgba(255,255,255,0.03); }
  .song-row:last-child { border-bottom: none; }
  .song-row .num { width: 28px; font-size: 13px; color: var(--crow-text-muted); font-weight: 500; }
  .song-row .info { flex: 1; }
  .song-row .info .name { font-size: 15px; font-weight: 500; color: var(--crow-text-primary); }
  .song-row .info .artist { font-size: 13px; color: var(--crow-text-muted); }
  .song-row .key-badge {
    font-family: 'JetBrains Mono', monospace; font-size: 13px;
    font-weight: 600; color: var(--crow-text-muted); width: 48px; text-align: center;
  }
  .song-row .audio-indicator { width: 32px; text-align: center; font-size: 13px; color: var(--songbook-audio-color); }
  .empty-state { text-align: center; padding: 4rem 1rem; color: var(--crow-text-muted); }
  .empty-state h2 { font-family: 'Fraunces', serif; font-size: 1.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>

<div class="nav">
  <div class="nav-inner">
    <span class="nav-brand">Crow</span>
    <span class="nav-crumb"><a href="/blog">Blog</a> / Songbook</span>
  </div>
</div>

<div class="page">
  <div class="index-hero">
    <h2>Songbook</h2>
    <p>A personal collection of chords, lyrics, and recordings</p>
  </div>

  ${topTags.length > 0 ? `<div class="filter-bar">
    <a href="/blog/songbook" class="filter-chip active">All</a>
    ${topTags.map(([tag]) => `<a href="/blog/tag/${encodeURIComponent(tag)}" class="filter-chip">${escapeHtml(tag)}</a>`).join("\n    ")}
  </div>` : ""}

  ${posts.length > 0
    ? `<div class="song-list">${songRows}</div>`
    : `<div class="empty-state"><h2>No songs yet</h2><p>Add songs to your songbook using the AI or Crow's Nest.</p></div>`}

  <div class="post-footer" style="margin-top:2rem">
    <a href="/blog">&larr; Back to Blog</a>
  </div>
</div>
</body>
</html>`;
}

/**
 * Render a setlist view page.
 * @param {object} setlist - Setlist row
 * @param {Array} items - Setlist items joined with blog_posts
 * @param {object} [options]
 * @returns {string} Full HTML page
 */
export function renderSetlistPage(setlist, items, options = {}) {
  const { blogSettings = {} } = options;

  const rows = items.map((item, i) => {
    const meta = parseSongMeta(item.content);
    const originalKey = meta.key || "";
    const displayKey = item.key_override || originalKey;
    const transposed = item.key_override && item.key_override !== originalKey;

    return `<a href="/blog/songbook/${escapeHtml(item.slug)}${item.key_override ? `?key=${encodeURIComponent(item.key_override)}` : ""}" class="setlist-row">
      <span class="order">${i + 1}</span>
      <span class="song-name">${escapeHtml(item.title)}</span>
      <span class="setlist-key">${transposed
        ? `<span class="transposed">${escapeHtml(displayKey)}</span> <span class="original-key">from ${escapeHtml(originalKey)}</span>`
        : escapeHtml(displayKey)}</span>
    </a>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(setlist.name)} — ${escapeHtml(blogSettings.title || "Songbook")}</title>
<style>
  ${FONT_IMPORT}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  ${designTokensCss()}
  ${songbookCss()}

  .setlist-card {
    background: rgba(255,255,255,0.02); border-radius: 16px;
    border: 0.5px solid rgba(255,255,255,0.06); padding: 24px; margin-bottom: 20px;
  }
  .setlist-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; }
  .setlist-header h2 { font-family: 'Fraunces', serif; font-size: 1.5rem; font-weight: 700; }
  .setlist-header .stats { font-size: 13px; color: var(--crow-text-muted); }
  .setlist-row {
    display: flex; align-items: center; padding: 10px 0;
    border-bottom: 0.5px solid rgba(255,255,255,0.04);
    text-decoration: none; color: inherit;
  }
  .setlist-row:last-child { border-bottom: none; }
  .setlist-row:hover { opacity: 0.85; }
  .setlist-row .order { width: 28px; font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.15); }
  .setlist-row .song-name { flex: 1; font-size: 15px; font-weight: 500; }
  .setlist-row .setlist-key {
    font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600;
    width: 100px; text-align: center;
  }
  .setlist-row .transposed { color: var(--songbook-audio-color); }
  .setlist-row .original-key { font-size: 10px; color: var(--crow-text-muted); }

  @media print {
    .setlist-row { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="nav">
  <div class="nav-inner">
    <span class="nav-brand">Crow</span>
    <span class="nav-crumb"><a href="/blog/songbook">Songbook</a> / ${escapeHtml(setlist.name)}</span>
  </div>
</div>

<div class="page">
  <div class="setlist-card" style="margin-top:32px">
    <div class="setlist-header">
      <div>
        <h2>${escapeHtml(setlist.name)}</h2>
        <div class="stats">${items.length} songs${setlist.description ? ` &middot; ${escapeHtml(setlist.description)}` : ""}</div>
      </div>
    </div>
    ${rows}
  </div>

  <div class="post-footer">
    <a href="/blog/songbook">&larr; Back to Songbook</a>
  </div>
</div>
</body>
</html>`;
}
