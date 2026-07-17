/**
 * Digest adapter — Google Calendar + Drive.
 *
 * Reads a Google OAuth2 "authorized_user" token JSON from
 * $GOOGLE_TOKEN_FILE ({ token?, refresh_token, client_id, client_secret,
 * ... } — the format google-workspace-mcp persists). Mints a fresh
 * access token via the refresh grant IN MEMORY (never written back),
 * then fetches today's primary-calendar events and Drive files modified
 * in the last 24 hours. Any failure marks the section unavailable.
 */

import { existsSync, readFileSync } from "node:fs";

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
    const url =
      "https://www.googleapis.com/drive/v3/files?" +
      new URLSearchParams({
        q: `modifiedTime > '${since}' and trashed = false`,
        orderBy: "modifiedTime desc",
        pageSize: "10",
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      });
    const data = await apiGet(url, accessToken);
    driveSection.available = true;
    for (const f of data.files || []) {
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
