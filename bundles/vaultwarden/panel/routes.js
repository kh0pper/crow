/**
 * Vaultwarden panel routes — status and backup info only. No secret access.
 */

import { Router } from "express";
import { statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const VAULTWARDEN_URL = () => (process.env.VAULTWARDEN_URL || "http://localhost:8097").replace(/\/+$/, "");

function resolveDataDir() {
  const env = process.env.VAULTWARDEN_DATA_DIR;
  if (env) return env.replace(/^~/, homedir());
  return join(homedir(), ".crow/vaultwarden/data");
}

function dirSize(dir) {
  if (!existsSync(dir)) return { size: null, newest: null };
  let total = 0;
  let newest = 0;
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const s = statSync(p);
        if (e.isDirectory()) walk(p);
        else { total += s.size; if (s.mtimeMs > newest) newest = s.mtimeMs; }
      } catch { /* skip */ }
    }
  }
  walk(dir);
  return { size: total, newest };
}

export default function vaultwardenRouter(authMiddleware) {
  const router = Router();

  router.get("/api/vaultwarden/status", authMiddleware, async (req, res) => {
    const url = VAULTWARDEN_URL();
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${url}/alive`, { signal: controller.signal });
      clearTimeout(t);
      res.json({ url, reachable: resp.ok });
    } catch (err) {
      res.json({ url, reachable: false, error: err.message });
    }
  });

  router.get("/api/vaultwarden/backup", authMiddleware, async (req, res) => {
    try {
      const dir = resolveDataDir();
      const { size, newest } = dirSize(dir);
      if (size === null) {
        return res.json({ data_dir: dir, exists: false });
      }
      res.json({
        data_dir: dir,
        exists: true,
        total_bytes: size,
        last_modified: newest ? new Date(newest).toISOString() : null,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
