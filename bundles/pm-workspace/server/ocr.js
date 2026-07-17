/**
 * PM Workspace — handwriting OCR via an OpenAI-style vision endpoint.
 *
 * POSTs the note's PNG (as a base64 data URL image_url part) to
 * $OCR_VISION_URL/chat/completions with model $OCR_VISION_MODEL.
 * Returns the transcribed plain text. 120s timeout — local vision
 * models can be slow on first load.
 */

import { readFileSync } from "node:fs";

const OCR_TIMEOUT_MS = 120_000;

const OCR_PROMPT =
  "Transcribe all handwriting and text in this image. " +
  "Return the transcription as plain text only — no commentary, no markdown fences. " +
  "Preserve line breaks and list structure where visible. " +
  "If the image contains no readable text, return an empty string.";

/**
 * Run OCR on a PNG file.
 * @param {string} imagePath absolute path to the PNG
 * @param {object} config    loadConfig() result
 * @returns {Promise<string>} transcribed text
 */
export async function ocrImage(imagePath, config) {
  if (!config.OCR_VISION_URL) {
    throw new Error("OCR_VISION_URL is not configured");
  }
  if (!config.OCR_VISION_MODEL) {
    throw new Error("OCR_VISION_MODEL is not configured");
  }

  const png = readFileSync(imagePath);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  const headers = { "Content-Type": "application/json" };
  const apiKey = config.OCR_VISION_API_KEY || "none";
  if (apiKey && apiKey !== "none") headers.Authorization = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model: config.OCR_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: OCR_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
  });

  const url = config.OCR_VISION_URL.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OCR endpoint HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const out = json?.choices?.[0]?.message?.content;
  if (typeof out !== "string") {
    throw new Error("OCR endpoint returned no text content");
  }
  return out.trim();
}

/**
 * OCR a note's stored PNG and persist result to pm_notes.
 * Returns the updated note row.
 */
export async function ocrNote(db, note, config) {
  if (!note?.image_path) throw new Error("Note has no image_path to OCR");
  try {
    const text = await ocrImage(note.image_path, config);
    await db.execute({
      sql: "UPDATE pm_notes SET ocr_text = ?, ocr_status = 'done', updated_at = datetime('now') WHERE id = ?",
      args: [text, note.id],
    });
    return { ok: true, text };
  } catch (err) {
    await db.execute({
      sql: "UPDATE pm_notes SET ocr_status = 'error', updated_at = datetime('now') WHERE id = ?",
      args: [note.id],
    }).catch(() => {});
    throw err;
  }
}
