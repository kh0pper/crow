/**
 * Matrix-Dendrite panel API routes — status, joined rooms, federation health.
 */

import { Router } from "express";

const URL_BASE = () => (process.env.MATRIX_URL || "http://dendrite:8008").replace(/\/+$/, "");
const TOKEN = () => process.env.MATRIX_ACCESS_TOKEN || "";
const SERVER_NAME = () => process.env.MATRIX_SERVER_NAME || "";
const TIMEOUT = 15_000;

async function mx(path, { noAuth } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const headers = {};
    if (!noAuth && TOKEN()) headers.Authorization = `Bearer ${TOKEN()}`;
    const r = await fetch(`${URL_BASE()}${path}`, { signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

export default function matrixDendriteRouter(authMiddleware) {
  const router = Router();

  router.get("/api/matrix-dendrite/status", authMiddleware, async (_req, res) => {
    try {
      const versions = await mx("/_matrix/client/versions", { noAuth: true }).catch(() => null);
      const who = TOKEN() ? await mx("/_matrix/client/v3/account/whoami").catch(() => null) : null;
      res.json({
        server_name: SERVER_NAME(),
        url: URL_BASE(),
        versions: versions?.versions?.slice(-3) || null,
        has_token: Boolean(TOKEN()),
        whoami: who,
      });
    } catch (err) {
      res.json({ error: `Cannot reach Dendrite: ${err.message}` });
    }
  });

  router.get("/api/matrix-dendrite/rooms", authMiddleware, async (_req, res) => {
    try {
      if (!TOKEN()) return res.json({ error: "MATRIX_ACCESS_TOKEN not set" });
      const { joined_rooms = [] } = await mx("/_matrix/client/v3/joined_rooms");
      const withNames = [];
      for (const rid of joined_rooms.slice(0, 50)) {
        const name = await mx(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/state/m.room.name`).catch(() => null);
        const alias = await mx(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/state/m.room.canonical_alias`).catch(() => null);
        withNames.push({ room_id: rid, name: name?.name || null, alias: alias?.alias || null });
      }
      res.json({ count: joined_rooms.length, rooms: withNames });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/matrix-dendrite/federation-health", authMiddleware, async (_req, res) => {
    try {
      const target = SERVER_NAME();
      if (!target) return res.json({ error: "MATRIX_SERVER_NAME not set" });
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30_000);
      try {
        const r = await fetch(`https://federationtester.matrix.org/api/report?server_name=${encodeURIComponent(target)}`, { signal: ctl.signal });
        const json = await r.json();
        res.json({
          server_name: target,
          federation_ok: json.FederationOK,
          well_known: json.WellKnownResult?.["m.server"] || null,
          errors: (json.Errors || []).slice(0, 10),
          warnings: (json.Warnings || []).slice(0, 10),
        });
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
