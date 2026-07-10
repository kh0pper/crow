import { Router, json } from "express";
import { execFile } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const WORKSPACES = () =>
  (process.env.ROOKERY_WORKSPACES_DIR || join(os.homedir(), ".crow/data/rookery/workspaces"))
    .replace(/^~(?=\/)/, os.homedir());
// Root-origin serving (plan deviation 4): the reviewer is NOT behind /proxy/<id>/.
const REVIEWER_URL = () => process.env.ROOKERY_REVIEWER_URL || "http://127.0.0.1:3061/";
const BUNDLE_DIR = () => join(os.homedir(), ".crow/bundles/rookery");
const UV = () => join(os.homedir(), ".local/bin/uv");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export default function rookeryRouter(authMiddleware) {
  const router = Router();
  router.use("/api/rookery", json());

  router.get("/api/rookery/workspaces", authMiddleware, (req, res) => {
    const root = WORKSPACES();
    if (!existsSync(root)) return res.json({ workspaces: [], reviewerUrl: REVIEWER_URL() });
    const workspaces = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = join(root, d.name);
        return {
          name: d.name,
          mtime: statSync(p).mtimeMs,
          hasManifest: existsSync(join(p, "_script_manifest.jsonl")),
          containerPath: `/workspaces/${d.name}`,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ workspaces, reviewerUrl: REVIEWER_URL() });
  });

  router.post("/api/rookery/assemble", authMiddleware, (req, res) => {
    const { report, dataDir, phases, name } = req.body || {};
    if (typeof report !== "string" || typeof dataDir !== "string" || !report || !dataDir)
      return res.status(400).json({ error: "report and dataDir are required" });
    if (!Array.isArray(phases) || phases.length === 0 || !phases.every((p) => typeof p === "string" && p))
      return res.status(400).json({ error: "phases must be a non-empty string array" });
    if (typeof name !== "string" || !NAME_RE.test(name))
      return res.status(400).json({ error: "name must be a plain directory name" });

    const workspace = join(WORKSPACES(), name);
    const args = ["run", "--quiet", "rookery-manifest", "exp",
      "--report", report, "--data-dir", dataDir,
      ...phases.flatMap((p) => ["--phase", p]),
      "--workspace", workspace];
    execFile(UV(), args, { cwd: BUNDLE_DIR(), timeout: 60_000 }, (err, stdout, stderr) => {
      if (err)
        return res.status(400).json({ error: (stderr || err.message).trim().slice(0, 500) });
      res.json({ workspace, containerPath: `/workspaces/${name}`, reviewerUrl: REVIEWER_URL() });
    });
  });

  return router;
}
