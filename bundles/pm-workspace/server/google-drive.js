/**
 * PM Workspace — minimal Google Drive REST helpers.
 *
 * Shared by the Outlook ingest adapter (read the newest drop file) and the
 * planner feed (write approved planned-events JSON for an external agent —
 * e.g. a Power Automate flow — to consume).
 *
 * Auth: a Google `authorized_user` JSON file (GOOGLE_TOKEN_FILE) whose
 * refresh token is exchanged for a short-lived access token per call burst.
 * No SDK dependency — plain fetch against the Drive v3 REST API.
 */

import { readFileSync } from "node:fs";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const HTTP_TIMEOUT_MS = 15_000;

/** Mint a Google access token from an authorized_user JSON (in memory). */
export async function mintGoogleToken(tokenFile) {
  const raw = JSON.parse(readFileSync(tokenFile, "utf8"));
  if (!raw.refresh_token || !raw.client_id || !raw.client_secret) {
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

function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
}

/** Newest non-trashed file in a folder → { id, name, modifiedTime } or null. */
export async function newestFileInFolder(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `${DRIVE}/files?q=${q}&orderBy=modifiedTime desc&pageSize=1&fields=files(id,name,modifiedTime)`;
  const res = await fetch(url, authHeaders(token));
  if (!res.ok) throw new Error(`Drive list HTTP ${res.status}`);
  const { files } = await res.json();
  return files && files.length > 0 ? files[0] : null;
}

/** Download a file's content and parse it as JSON. */
export async function downloadJson(token, fileId) {
  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, authHeaders(token));
  if (!res.ok) throw new Error(`Drive download HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("file is not valid JSON");
  }
}

/**
 * Create a JSON file in a folder (multipart upload).
 * Returns the created file's { id, name }.
 */
export async function uploadJson(token, folderId, name, obj) {
  const boundary = "pmws" + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ name, parents: [folderId], mimeType: "application/json" });
  const content = JSON.stringify(obj, null, 2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Drive upload HTTP ${res.status}`);
  return res.json();
}
