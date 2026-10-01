/**
 * Digest adapter — Google Calendar + Drive.
 *
 * Reads a Google OAuth2 "authorized_user" token JSON from
 * $GOOGLE_TOKEN_FILE ({ token?, refresh_token, client_id, client_secret,
 * ... } — the format google-workspace-mcp persists). Mints a fresh
 * access token via the refresh grant IN MEMORY (never written back),
 * then fetches today's primary-calendar events and Drive files modified
 * in the last 24 hours. Any failure marks the section unavailable.
 *
 *   DRIVE_IGNORE — optional; `;`-separated case-insensitive patterns
 *                  (regex or plain text) matched against each file's name
 *                  and its owners' email addresses. Matches are dropped from
 *                  the Drive section (folders shared in from elsewhere, etc.).
 */

import { existsSync, readFileSync } from "node:fs";
import { parseMailIgnore as parseIgnore } from "./outlook.js";

const DRIVE_LIMIT = 10; // files shown in the section
const DRIVE_PAGE_SIZE = 100; // over-fetch per page when a filter is active
const DRIVE_MAX_PAGES = 5; // bound on the over-fetch

const HTTP_TIMEOUT_MS = 15_000;

async function mintAccessToken(tokenFile) {
  const raw = JSON.parse(readFileSync(tokenFile, "utf8"));
  if (!raw.refresh_token || !raw.client_id || !raw.client_secret) {
    // Fall back to a still-valid access token if present.
    if (raw.token) return raw.token;
    throw new Error("token file missing refresh_token/client_id/client_secret");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: raw.client_id,
      client_secret: raw.client_secret,
      refresh_token: raw.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token refresh HTTP ${res.status}`);
  const json = await res.json();
  if (!json.access_token) throw new Error("refresh grant returned no access_token");
  return json.access_token;
}

async function apiGet(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google API HTTP ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

/** Drop files whose name or any owner email matches an ignore pattern. */
export function filterDriveFiles(files, patterns) {
  if (!patterns || patterns.length === 0) return files;
  return files.filter((f) => {
    const hay = [f && f.name, ...((f && f.owners) || []).map((o) => o && o.emailAddress)].filter(
      (v) => typeof v === "string"
    );
    return !patterns.some((re) => hay.some((h) => re.test(h)));
  });
}

/**
 * Newest-first files that survive the ignore patterns, at most `limit`.
 * `fetchPage(pageToken)` resolves to { files, nextPageToken }. With a filter
 * active, pages are followed (up to `maxPages`) until `limit` files are kept,
 * so ignored files cannot crowd the kept ones out of the section.
 */
export async function collectDriveFiles(fetchPage, patterns, limit = DRIVE_LIMIT, maxPages = DRIVE_MAX_PAGES) {
  const kept = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const data = (await fetchPage(pageToken)) || {};
    kept.push(...filterDriveFiles(data.files || [], patterns));
    pageToken = data.nextPageToken;
    if (kept.length >= limit || !pageToken) break;
  }
  return kept.slice(0, limit);
}

export async function googleSections(config) {
  const calSection = { title: "Calendar (today)", available: false, items: [] };
  const driveSection = { title: "Drive (last 24h)", available: false, items: [] };

  const tokenFile = config.GOOGLE_TOKEN_FILE;
  if (!tokenFile || !existsSync(tokenFile)) {
    calSection.reason = "GOOGLE_TOKEN_FILE not configured";
    driveSection.reason = "GOOGLE_TOKEN_FILE not configured";
    return [calSection, driveSection];
  }

  let accessToken;
  try {
    accessToken = await mintAccessToken(tokenFile);
  } catch (err) {
    calSection.reason = `Google auth failed: ${err.message}`;
    driveSection.reason = `Google auth failed: ${err.message}`;
    return [calSection, driveSection];
  }

  // Calendar: today's events on the primary calendar
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const url =
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
      new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "15",
      });
    const data = await apiGet(url, accessToken);
    calSection.available = true;
    for (const ev of data.items || []) {
      const when = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "all day";
      calSection.items.push({
        label: ev.summary || "(no title)",
        detail: when + (ev.location ? ` · ${ev.location}` : ""),
      });
    }
    if (calSection.items.length === 0) calSection.note = "No events today.";
  } catch (err) {
    calSection.available = false;
    calSection.reason = `calendar unavailable: ${err.message}`;
  }

  // Drive: files modified in the last 24 hours
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const patterns = parseIgnore(config.DRIVE_IGNORE);
    const fetchPage = (pageToken) => {
      const params = {
        q: `modifiedTime > '${since}' and trashed = false`,
        orderBy: "modifiedTime desc",
        pageSize: String(patterns.length ? DRIVE_PAGE_SIZE : DRIVE_LIMIT),
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))",
      };
      if (pageToken) params.pageToken = pageToken;
      return apiGet("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams(params), accessToken);
    };
    // No filter: one page of DRIVE_LIMIT, as before.
    const files = await collectDriveFiles(fetchPage, patterns, DRIVE_LIMIT, patterns.length ? DRIVE_MAX_PAGES : 1);
    driveSection.available = true;
    for (const f of files) {
      driveSection.items.push({
        label: f.name,
        meta: `modified ${String(f.modifiedTime).slice(0, 16).replace("T", " ")}`,
      });
    }
    if (driveSection.items.length === 0) driveSection.note = "No files modified in the last 24h.";
  } catch (err) {
    driveSection.available = false;
    driveSection.reason = `drive unavailable: ${err.message}`;
  }

  return [calSection, driveSection];
}
