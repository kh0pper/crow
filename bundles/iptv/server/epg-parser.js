/**
 * IPTV Bundle — XMLTV EPG Parser
 *
 * Simple regex-based parser for XMLTV programme data.
 * No XML library dependency — parses the essential fields with regex.
 */

/**
 * Parse XMLTV content into EPG programme objects.
 * @param {string} xmlContent - Raw XMLTV XML content
 * @returns {Array<{ channelTvgId: string, title: string, description: string|null, startTime: string, endTime: string, category: string|null, iconUrl: string|null }>}
 */
export function parseXMLTV(xmlContent) {
  if (!xmlContent || typeof xmlContent !== "string") return [];

  const programmes = [];
  const progRegex = /<programme\s+[^>]*>[\s\S]*?<\/programme>/gi;
  let match;

  while ((match = progRegex.exec(xmlContent)) !== null) {
    const block = match[0];
    const prog = parseProgramme(block);
    if (prog) programmes.push(prog);
  }

  return programmes;
}

/**
 * Parse a single programme block.
 */
function parseProgramme(block) {
  const startRaw = extractTagAttr(block, "programme", "start");
  const stopRaw = extractTagAttr(block, "programme", "stop");
  const channelId = extractTagAttr(block, "programme", "channel");

  if (!startRaw || !stopRaw || !channelId) return null;

  const title = extractElementText(block, "title");
  if (!title) return null;

  return {
    channelTvgId: channelId,
    title,
    description: extractElementText(block, "desc"),
    startTime: parseXmltvTimestamp(startRaw),
    endTime: parseXmltvTimestamp(stopRaw),
    category: extractElementText(block, "category"),
    iconUrl: extractIconSrc(block),
  };
}

/**
 * Extract an attribute value from the opening tag of an element.
 */
function extractTagAttr(block, tagName, attrName) {
  const regex = new RegExp("<" + tagName + "\\s+[^>]*" + attrName + '="([^"]*)"', "i");
  const match = block.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract text content of a simple element (first occurrence).
 */
function extractElementText(block, tagName) {
  const regex = new RegExp("<" + tagName + '(?:\\s[^>]*)?>([^<]*)</' + tagName + ">", "i");
  const match = block.match(regex);
  return match ? match[1].trim() || null : null;
}

/**
 * Extract the src attribute from an icon element.
 */
function extractIconSrc(block) {
  const match = block.match(/<icon\s+[^>]*src="([^"]*)"/i);
  return match ? match[1] : null;
}

/**
 * Parse XMLTV timestamp format to ISO 8601.
 * Input: "20260321180000 +0000" or "20260321180000"
 * Output: "2026-03-21T18:00:00Z" (or with offset)
 */
function parseXmltvTimestamp(raw) {
  if (!raw || raw.length < 14) return raw;

  const dateStr = raw.replace(/\s+[+-]\d{4}$/, "").trim();
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  const hour = dateStr.substring(8, 10);
  const min = dateStr.substring(10, 12);
  const sec = dateStr.substring(12, 14);

  const tzMatch = raw.match(/\s+([+-]\d{2})(\d{2})$/);
  if (tzMatch) {
    const tzHour = tzMatch[1];
    const tzMin = tzMatch[2];
    if (tzHour === "+00" && tzMin === "00") {
      return year + "-" + month + "-" + day + "T" + hour + ":" + min + ":" + sec + "Z";
    }
    return year + "-" + month + "-" + day + "T" + hour + ":" + min + ":" + sec + tzHour + ":" + tzMin;
  }

  return year + "-" + month + "-" + day + "T" + hour + ":" + min + ":" + sec + "Z";
}
