/**
 * STT Debug Endpoint — smoke test for STT profiles.
 *
 * POST /api/stt/debug
 *   multipart/form-data:
 *     file: audio file (wav/mp3/m4a/opus…)
 *     profile_id: optional — specific profile to use (defaults to the default)
 *     language: optional — ISO-639-1 code hint
 *
 * Returns: { ok, provider, text, language?, duration? } or { ok:false, error }
 *
 * Protected by dashboard session auth.
 */

import { Router } from "express";
import multer from "multer";
import { createDbClient } from "../../db.js";
import { createSttAdapter, getSttProfiles, getDefaultSttProfile } from "../ai/stt/index.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — matches OpenAI's cap
});

export default function sttDebugRouter(dashboardAuth) {
  const router = Router();
  router.use("/api/stt", dashboardAuth);

  router.post("/api/stt/debug", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio file uploaded (use `file` field)" });
    }

    const db = createDbClient();
    try {
      let profile;
      if (req.body.profile_id) {
        const profiles = await getSttProfiles(db, { includeKeys: true });
        profile = profiles.find(p => p.id === req.body.profile_id);
        if (!profile) {
          return res.status(404).json({ ok: false, error: `No STT profile with id ${req.body.profile_id}` });
        }
      } else {
        profile = await getDefaultSttProfile(db, { includeKeys: true });
        if (!profile) {
          return res.status(400).json({ ok: false, error: "No STT profiles configured" });
        }
      }

      const { adapter } = await createSttAdapter(profile);
      const started = Date.now();
      const result = await adapter.transcribe(req.file.buffer, {
        filename: req.file.originalname || "audio.wav",
        contentType: req.file.mimetype || "audio/wav",
        language: req.body.language || undefined,
      });
      const elapsedMs = Date.now() - started;

      res.json({
        ok: true,
        provider: adapter.name,
        profile_id: profile.id,
        profile_name: profile.name,
        elapsed_ms: elapsedMs,
        bytes_in: req.file.size,
        ...result,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message,
        code: err.code || "unknown",
      });
    } finally {
      db.close();
    }
  });

  return router;
}
