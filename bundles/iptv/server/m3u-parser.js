/**
 * IPTV Bundle — M3U/M3U8 Playlist Parser
 *
 * Parses #EXTINF lines with tvg-* attributes and extracts channel info.
 */

/**
 * Parse M3U/M3U8 playlist content into channel objects.
 * @param {string} content - Raw M3U file content
 * @returns {Array<{ name: string, streamUrl: string, logoUrl: string|null, groupTitle: string|null, tvgId: string|null, tvgName: string|null }>}
 */
export function parseM3U(content) {
  if (!content || typeof content !== "string") return [];

  const lines = content.split(/\r?\n/);
  const channels = [];
  let currentAttrs = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines, #EXTM3U header, and HLS directives
    if (!line || line === "#EXTM3U" || line.startsWith("#EXT-X-")) continue;

    if (line.startsWith("#EXTINF:")) {
      // Parse attributes from #EXTINF line
      currentAttrs = parseExtinfLine(line);
      continue;
    }

    // Skip other comment/directive lines
    if (line.startsWith("#")) continue;

    // This is a URL line — pair it with the previous #EXTINF
    if (currentAttrs) {
      channels.push({
        name: currentAttrs.name,
        streamUrl: line,
        logoUrl: currentAttrs.logoUrl || null,
        groupTitle: currentAttrs.groupTitle || null,
        tvgId: currentAttrs.tvgId || null,
        tvgName: currentAttrs.tvgName || null,
      });
      currentAttrs = null;
    }
  }

  return channels;
}

/**
 * Parse a single #EXTINF line.
 * Format: #EXTINF:-1 tvg-id="id" tvg-name="name" tvg-logo="url" group-title="group",Display Name
 */
function parseExtinfLine(line) {
  const attrs = {
    name: "",
    logoUrl: null,
    groupTitle: null,
    tvgId: null,
    tvgName: null,
  };

  // Extract the display name (everything after the last comma)
  const commaIdx = line.lastIndexOf(",");
  if (commaIdx !== -1) {
    attrs.name = line.substring(commaIdx + 1).trim();
  }

  // Extract quoted attributes
  attrs.tvgId = extractAttr(line, "tvg-id");
  attrs.tvgName = extractAttr(line, "tvg-name");
  attrs.logoUrl = extractAttr(line, "tvg-logo");
  attrs.groupTitle = extractAttr(line, "group-title");

  return attrs;
}

/**
 * Extract a quoted attribute value from an EXTINF line.
 * Matches: attr="value"
 */
function extractAttr(line, attrName) {
  const regex = new RegExp(`${attrName}="([^"]*)"`, "i");
  const match = line.match(regex);
  return match ? match[1] : null;
}
