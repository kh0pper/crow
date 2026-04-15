/**
 * Shared vision-model helper used by bot-chat, meta-glasses, and any future
 * vision-consumer. Performs one OpenAI-compatible /chat/completions call with
 * the image encoded as a data URL.
 *
 * Returns the text description. Throws on timeout or non-2xx. Callers pick
 * their own prompt (describe-for-voice, caption-for-library, OCR, etc.).
 */

import { readFile } from "node:fs/promises";

/**
 * @param {object} opts
 * @param {{ baseUrl: string, apiKey?: string, model: string }} opts.providerConfig
 * @param {string} opts.prompt              — User-visible instruction to the vision model.
 * @param {Buffer|Uint8Array} [opts.imageBytes] — Raw bytes.
 * @param {string} [opts.imagePath]         — Path on disk (alternative to imageBytes).
 * @param {string} opts.mime                — e.g. "image/jpeg".
 * @param {number} [opts.timeoutMs=10000]
 * @param {number} [opts.maxTokens=1000]
 * @returns {Promise<{ description: string }>}
 */
export async function analyzeImage({
  providerConfig,
  prompt,
  imageBytes,
  imagePath,
  mime,
  timeoutMs = 10_000,
  maxTokens = 1000,
}) {
  if (!providerConfig?.baseUrl || !providerConfig?.model) {
    throw new Error("analyzeImage: providerConfig.baseUrl and .model required");
  }
  let bytes = imageBytes;
  if (!bytes && imagePath) bytes = await readFile(imagePath);
  if (!bytes) throw new Error("analyzeImage: imageBytes or imagePath required");
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

  const headers = { "Content-Type": "application/json" };
  if (providerConfig.apiKey && providerConfig.apiKey !== "none") {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const resp = await fetch(`${providerConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: providerConfig.model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: prompt },
        ],
      }],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Vision API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = await resp.json();
  const description = json.choices?.[0]?.message?.content || "";
  return { description };
}
