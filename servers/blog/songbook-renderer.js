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
import { LEGACY_FONT_IMPORT as FONT_IMPORT, legacyDesignTokensCss as designTokensCss } from "../gateway/dashboard/shared/design-tokens-legacy.js";

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
 * Scoped songbook CSS — uses design tokens, no hardcoded colors.
 */
function songbookCss() {
  return `
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
    background: var(--crow-bg-deep);
    border-bottom: 0.5px solid var(--crow-border);
    padding: 12px 24px;
  }
  .nav-inner { max-width: 800px; margin: 0 auto; display: flex; align-items: center; gap: 16px; }
  .nav-brand { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; color: var(--crow-text-muted); }
  .nav-crumb { font-size: 13px; color: var(--crow-text-muted); }
  .nav-crumb a { color: var(--crow-accent); text-decoration: none; }

  /* Hero */
  .hero { padding: 48px 0 40px; display: flex; gap: 32px; align-items: flex-start; }
  .album-art {
    width: 180px; height: 180px; border-radius: var(--crow-radius-card); flex-shrink: 0;
    background: linear-gradient(135deg, var(--crow-bg-surface) 0%, var(--crow-bg-elevated) 100%);
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
    letter-spacing: 1.5px; color: var(--crow-accent); margin-bottom: 6px;
  }
  .song-title {
    font-family: 'Fraunces', serif; font-size: 2.2rem; font-weight: 700;
    letter-spacing: -0.5px; line-height: 1.15; margin-bottom: 6px;
  }
  .song-artist { font-size: 1.15rem; color: var(--crow-text-secondary); margin-bottom: 20px; }
  .meta-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--crow-bg-elevated); border-radius: var(--crow-radius-pill);
    padding: 5px 14px; font-size: 13px; font-weight: 500;
    color: var(--crow-text-secondary); border: 0.5px solid var(--crow-border);
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
    background: var(--crow-bg-elevated); color: var(--crow-text-muted);
    font-size: 13px; font-weight: 600; font-family: 'JetBrains Mono', monospace;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    text-decoration: none; transition: all 0.2s;
  }
  .key-chip:hover { background: var(--crow-bg-elevated); color: var(--crow-text-primary); opacity: 0.8; }
  .key-chip.active {
    background: var(--crow-accent-muted); color: var(--crow-accent);
    box-shadow: 0 0 0 1.5px var(--crow-accent);
  }

  /* Chord diagrams card */
  .diagrams-card {
    background: var(--crow-bg-surface); border-radius: var(--crow-radius-card);
    border: 0.5px solid var(--crow-border);
    padding: 20px 24px; margin-bottom: 32px;
  }
  .diagrams-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .diagrams-header h3 {
    font-size: 13px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1px; color: var(--crow-text-muted);
  }
  .instrument-tabs {
    display: flex; background: var(--crow-bg-elevated);
    border-radius: 8px; padding: 2px; gap: 2px;
  }
  .inst-tab {
    padding: 4px 14px; border-radius: 6px; border: none;
    background: transparent; color: var(--crow-text-muted);
    font-size: 12px; font-weight: 600; font-family: inherit;
    cursor: pointer; text-decoration: none;
  }
  .inst-tab.active { background: var(--crow-bg-elevated); color: var(--crow-text-primary); }
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
    letter-spacing: 2px; color: var(--crow-text-muted);
    margin: 32px 0 16px; padding-bottom: 8px;
    border-bottom: 0.5px solid var(--crow-border);
  }
  .section-heading:first-child { margin-top: 0; }
  .chart-line { font-family: 'JetBrains Mono', monospace; font-size: 14px; line-height: 1.3; white-space: pre-wrap; }
  .chords-row { color: var(--crow-accent); font-weight: 600; letter-spacing: 0.3px; margin-bottom: 1px; }
  .lyrics-row { color: var(--crow-text-secondary); font-weight: 400; margin-bottom: 16px; }
  .song-comment {
    font-style: italic; color: var(--crow-text-muted);
    margin: 8px 0; font-size: 13px;
  }

  /* Audio player */
  .player-card {
    background: var(--crow-bg-surface); border-radius: var(--crow-radius-card);
    border: 0.5px solid var(--crow-border);
    padding: 24px; margin-bottom: 32px;
  }
  .player-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 2px; color: var(--crow-text-muted); margin-bottom: 16px;
  }
  .player-controls { display: flex; align-items: center; gap: 16px; }
  .player-controls audio { flex: 1; height: 40px; }
  .download-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--crow-accent); font-size: 13px; font-weight: 500;
    text-decoration: none; padding: 8px 16px; border-radius: var(--crow-radius-pill);
    background: var(--crow-accent-muted); transition: background 0.2s;
  }
  .download-link:hover { opacity: 0.85; }

  /* Tags */
  .tags { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 32px; }
  .tag {
    background: var(--crow-bg-elevated); border-radius: var(--crow-radius-pill);
    padding: 4px 12px; font-size: 12px; font-weight: 500;
    color: var(--crow-text-muted); border: 0.5px solid var(--crow-border);
  }

  /* Footer */
  .post-footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--crow-border); color: var(--crow-text-muted); font-size: 0.85rem; }
  .post-footer a { color: var(--crow-accent); text-decoration: none; }

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

  // SunVox backing track (interactive player). Only storage-backed keys are
  // supported: the blog CSP's connect-src 'self' blocks cross-origin fetches.
  let sunvoxUrl = null;
  if (songMeta.sunvox) {
    const svRaw = songMeta.sunvox;
    if (svRaw.startsWith("storage:") || !/^https?:\/\//i.test(svRaw)) {
      sunvoxUrl = `/blog/media/${encodeURIComponent(svRaw.replace("storage:", ""))}`;
    }
  }

  const baseUrl = `/blog/songbook/${escapeHtml(post.slug)}`;

  // Compute theme classes from blog settings
  const effectiveMode = blogSettings.themeBlogMode || blogSettings.themeMode || "dark";
  const bodyClasses = [
    effectiveMode === "light" ? "theme-light" : "",
    blogSettings.themeSerif ? "theme-serif" : "",
  ].filter(Boolean).join(" ");

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
<body class="${bodyClasses}">

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
        ${sunvoxUrl && targetKey && originalKey && targetKey !== originalKey
          ? `<span class="pill pill-warn" title="The SunVox backing track always plays in its recorded key">Track stays in ${escapeHtml(originalKey)}</span>`
          : ""}
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

  // SunVox interactive backing-track player (engine loads lazily on first Play)
  if (sunvoxUrl) {
    html += renderSunvoxPlayer(sunvoxUrl);
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

  // Compute theme classes
  const effectiveMode = blogSettings.themeBlogMode || blogSettings.themeMode || "dark";
  const bodyClasses = [
    effectiveMode === "light" ? "theme-light" : "",
    blogSettings.themeSerif ? "theme-serif" : "",
  ].filter(Boolean).join(" ");

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
    padding: 6px 16px; border-radius: var(--crow-radius-pill); border: none;
    background: var(--crow-bg-elevated); color: var(--crow-text-muted);
    font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit;
    text-decoration: none; transition: all 0.2s;
  }
  .filter-chip:hover { opacity: 0.8; color: var(--crow-text-primary); }
  .filter-chip.active { background: var(--crow-accent-muted); color: var(--crow-accent); }
  .song-list {
    border-radius: var(--crow-radius-card); overflow: hidden;
    border: 0.5px solid var(--crow-border);
  }
  .song-row {
    display: flex; align-items: center; padding: 14px 20px;
    border-bottom: 0.5px solid var(--crow-border);
    transition: background 0.15s; cursor: pointer; text-decoration: none; color: inherit;
  }
  .song-row:hover { background: var(--crow-bg-surface); }
  .song-row:last-child { border-bottom: none; }
  .song-row .num { width: 28px; font-size: 13px; color: var(--crow-text-muted); font-weight: 500; }
  .song-row .info { flex: 1; }
  .song-row .info .name { font-size: 15px; font-weight: 500; color: var(--crow-text-primary); }
  .song-row .info .artist { font-size: 13px; color: var(--crow-text-muted); }
  .song-row .key-badge {
    font-family: 'JetBrains Mono', monospace; font-size: 13px;
    font-weight: 600; color: var(--crow-text-muted); width: 48px; text-align: center;
  }
  .song-row .audio-indicator { width: 32px; text-align: center; font-size: 13px; color: var(--crow-success); }
  .empty-state { text-align: center; padding: 4rem 1rem; color: var(--crow-text-muted); }
  .empty-state h2 { font-family: 'Fraunces', serif; font-size: 1.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body class="${bodyClasses}">

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

  // Compute theme classes
  const effectiveMode = blogSettings.themeBlogMode || blogSettings.themeMode || "dark";
  const bodyClasses = [
    effectiveMode === "light" ? "theme-light" : "",
    blogSettings.themeSerif ? "theme-serif" : "",
  ].filter(Boolean).join(" ");

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
    background: var(--crow-bg-surface); border-radius: var(--crow-radius-card);
    border: 0.5px solid var(--crow-border); padding: 24px; margin-bottom: 20px;
  }
  .setlist-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; }
  .setlist-header h2 { font-family: 'Fraunces', serif; font-size: 1.5rem; font-weight: 700; }
  .setlist-header .stats { font-size: 13px; color: var(--crow-text-muted); }
  .setlist-row {
    display: flex; align-items: center; padding: 10px 0;
    border-bottom: 0.5px solid var(--crow-border);
    text-decoration: none; color: inherit;
  }
  .setlist-row:last-child { border-bottom: none; }
  .setlist-row:hover { opacity: 0.85; }
  .setlist-row .order { width: 28px; font-size: 14px; font-weight: 600; color: var(--crow-text-muted); }
  .setlist-row .song-name { flex: 1; font-size: 15px; font-weight: 500; }
  .setlist-row .setlist-key {
    font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600;
    width: 100px; text-align: center;
  }
  .setlist-row .transposed { color: var(--crow-success); }
  .setlist-row .original-key { font-size: 10px; color: var(--crow-text-muted); }

  @media print {
    .setlist-row { page-break-inside: avoid; }
  }
</style>
</head>
<body class="${bodyClasses}">

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

/**
 * SunVox interactive backing-track player card.
 *
 * The engine (~800KB JS+WASM, MIT-licensed libsunvox 2.1.4d pinned in
 * bundles/songbook/web/sunvox/) loads LAZILY on the first Play press, from
 * /blog/songbook/lib/*. Song pages carry a path-scoped 'wasm-unsafe-eval'
 * CSP carve-out in the gateway for the WASM compile.
 *
 * Practice features: transport (play/pause/stop), volume, line position,
 * A/B section loop (sv_rewind on a timer). The track loops endlessly
 * (autostop off) until stopped — it is a practice backing track.
 * The inline script deliberately avoids backticks/`${` so it can live in
 * this template-literal file.
 */
export function renderSunvoxPlayer(url) {
  const safeUrl = escapeHtml(url);
  return `
  <style>
  .sv-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }
  .sv-btn { background: var(--crow-surface-2, #2a2a35); color: var(--crow-text, #eee); border: 1px solid var(--crow-border, #444); border-radius: 8px; padding: 7px 14px; font-size: 14px; cursor: pointer; }
  .sv-btn:hover:not(:disabled) { border-color: var(--crow-accent, #7aa2f7); }
  .sv-btn:disabled { opacity: 0.4; cursor: default; }
  .sv-btn.sv-active { border-color: var(--crow-accent, #7aa2f7); color: var(--crow-accent, #7aa2f7); }
  .sv-vol { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--crow-text-dim, #aaa); }
  .sv-vol input { width: 90px; }
  .sv-pos { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--crow-text-dim, #aaa); min-width: 80px; }
  .sv-meta { font-size: 12px; font-weight: normal; color: var(--crow-text-dim, #aaa); margin-left: 8px; }
  .sv-status { margin-top: 8px; font-size: 13px; color: var(--crow-text-dim, #aaa); }
  .sv-loopgroup { display: flex; gap: 6px; align-items: center; border-left: 1px solid var(--crow-border, #444); padding-left: 12px; }
  .sv-looplabel { font-size: 12px; color: var(--crow-text-dim, #aaa); }
  .sv-credit { margin-top: 8px; font-size: 11px; color: var(--crow-text-dim, #aaa); }
  .sv-credit a { color: inherit; }
  .pill-warn { border-color: #d9a03f !important; color: #d9a03f !important; }
  </style>
  <div class="player-card" id="svPlayer" data-src="${safeUrl}">
    <div class="player-title">SunVox Backing Track<span class="sv-meta" id="svMeta"></span></div>
    <div class="sv-controls">
      <button type="button" class="sv-btn" id="svPlay">&#9654; Play</button>
      <button type="button" class="sv-btn" id="svStop" disabled>&#9632; Stop</button>
      <label class="sv-vol">Vol <input type="range" id="svVol" min="0" max="256" value="220"></label>
      <span class="sv-pos" id="svPos">&ndash; / &ndash;</span>
      <span class="sv-loopgroup">
        <span class="sv-looplabel">Loop</span>
        <button type="button" class="sv-btn" id="svLoopA" disabled>A</button>
        <button type="button" class="sv-btn" id="svLoopB" disabled>B</button>
        <button type="button" class="sv-btn" id="svLoopClear" disabled>&#10005;</button>
      </span>
    </div>
    <div class="sv-status" id="svStatus">Press Play to load the engine (~800KB, once per visit).</div>
    <a href="${safeUrl}" download class="download-link" style="margin-top:8px;display:inline-block">&#8595; Download project</a>
    <div class="sv-credit">Powered by <a href="https://warmplace.ru/soft/sunvox/" rel="noopener">SunVox</a> (modular synth &amp; tracker), &copy; Alexander Zolotov, WarmPlace.ru &middot; <a href="/blog/songbook/lib/THIRD-PARTY-NOTICES.txt">licences</a></div>
  </div>
  <script>
  (function () {
    var card = document.getElementById("svPlayer");
    if (!card) return;
    var src = card.getAttribute("data-src");
    var LIB = "/blog/songbook/lib/";
    var $ = function (id) { return document.getElementById(id); };
    var statusEl = $("svStatus"), playBtn = $("svPlay"), stopBtn = $("svStop"), volEl = $("svVol"),
        posEl = $("svPos"), metaEl = $("svMeta"), aBtn = $("svLoopA"), bBtn = $("svLoopB"), clrBtn = $("svLoopClear");
    var ready = false, loading = null, timer = null, loopA = null, loopB = null, totalLines = 0, started = false;

    function setStatus(s) { statusEl.textContent = s; }
    function loadScript(u) {
      return new Promise(function (res, rej) {
        var s = document.createElement("script");
        s.src = u; s.onload = res; s.onerror = function () { rej(new Error("cannot load " + u)); };
        document.head.appendChild(s);
      });
    }
    function boot() {
      if (loading) return loading;
      playBtn.disabled = true; /* while the engine loads; re-enabled on ready or failure */
      setStatus("Loading engine\u2026");
      loading = loadScript(LIB + "sunvox.js")
        .then(function () { return loadScript(LIB + "sunvox_lib_loader.js"); })
        .then(function () { return svlib; })
        .then(function (Module) {
          svlib = Module;
          var ver = sv_init(null, 44100, 2, 0);
          if (ver < 0) throw new Error("sv_init " + ver);
          if (sv_open_slot(0) < 0) throw new Error("sv_open_slot failed");
          return fetch(src).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status + " fetching the track");
            return r.arrayBuffer();
          });
        })
        .then(function (ab) {
          var rc = sv_load_from_memory(0, new Uint8Array(ab));
          if (rc !== 0) throw new Error("load failed (rc " + rc + ")");
          sv_set_autostop(0, 0); /* practice track: loop endlessly */
          sv_volume(0, Number(volEl.value));
          totalLines = sv_get_song_length_lines(0);
          var name = sv_get_song_name(0) || "";
          metaEl.textContent = (name ? name + " \u00b7 " : "") + sv_get_song_bpm(0) + " BPM \u00b7 " + totalLines + " lines";
          ready = true;
          playBtn.disabled = false; aBtn.disabled = false; bBtn.disabled = false;
          setStatus("Ready \u2014 loops until stopped. Set A/B around a section to practice it.");
        })
        .catch(function (err) {
          loading = null;
          playBtn.disabled = false;
          setStatus("Player failed: " + err.message + " \u2014 use the download link instead.");
        });
      return loading;
    }
    function tick() {
      var cur = sv_get_current_line(0);
      posEl.textContent = (cur + 1) + " / " + totalLines;
      if (loopA !== null && loopB !== null && loopB > loopA && cur >= loopB) sv_rewind(0, loopA);
    }
    function startTimer() { if (!timer) timer = setInterval(tick, 80); }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    playBtn.addEventListener("click", function () {
      boot().then(function () {
        if (!ready) return;
        if (playBtn.getAttribute("data-mode") === "playing") {
          sv_pause(0); playBtn.setAttribute("data-mode", "paused");
          playBtn.innerHTML = "&#9654; Play"; stopTimer();
        } else {
          if (!started) { sv_play_from_beginning(0); started = true; } else { sv_resume(0); }
          playBtn.setAttribute("data-mode", "playing");
          playBtn.innerHTML = "&#10074;&#10074; Pause"; stopBtn.disabled = false; startTimer();
        }
      });
    });
    stopBtn.addEventListener("click", function () {
      if (!ready) return;
      sv_stop(0); started = false; stopBtn.disabled = true;
      playBtn.setAttribute("data-mode", "stopped"); playBtn.innerHTML = "&#9654; Play";
      stopTimer(); posEl.textContent = "\u2013 / " + totalLines;
    });
    volEl.addEventListener("input", function () { if (ready) sv_volume(0, Number(volEl.value)); });
    aBtn.addEventListener("click", function () {
      if (!ready) return;
      loopA = sv_get_current_line(0); aBtn.classList.add("sv-active"); aBtn.textContent = "A:" + loopA;
      clrBtn.disabled = false;
    });
    bBtn.addEventListener("click", function () {
      if (!ready) return;
      var b = sv_get_current_line(0);
      if (loopA === null || b <= loopA) { setStatus("Set A first, then B after it (B must be later than A)."); return; }
      loopB = b; bBtn.classList.add("sv-active"); bBtn.textContent = "B:" + loopB;
      clrBtn.disabled = false; setStatus("Looping lines " + loopA + "\u2013" + loopB + ".");
    });
    clrBtn.addEventListener("click", function () {
      loopA = loopB = null; clrBtn.disabled = true;
      aBtn.classList.remove("sv-active"); bBtn.classList.remove("sv-active");
      aBtn.textContent = "A"; bBtn.textContent = "B";
      if (ready) setStatus("Loop cleared.");
    });
  })();
  </script>`;
}
