#!/usr/bin/env node
/**
 * garage.toml for the File Storage (Garage) bundle.
 *
 * The file holds layout only. Every secret (rpc_secret, admin_token, metrics_token)
 * reaches Garage through its environment (GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN,
 * GARAGE_METRICS_TOKEN), never through this file.
 *
 * Paths are the container's own. Where the data really lives on the host is chosen in
 * docker-compose.yml (named volumes, or GARAGE_DATA_PATH), so one rendered file serves
 * every install and the bundle ships it as garage.toml. A refresh after a manifest
 * version bump never copies or re-renders it (docker bundles get code paths only); it
 * changes only when the bundle is installed or when this script is run on purpose.
 *
 * Pinned to Garage v2.4.1: no `public_endpoint` (that key is new in v2.5.0).
 *
 *   node scripts/render-config.mjs [out]      write garage.toml (default: next to this dir)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const META_DIR = "/var/lib/garage/meta";
export const DATA_DIR = "/var/lib/garage/data";

const quote = (s) => JSON.stringify(String(s));

/**
 * @param {object} [opts]
 * @param {Array<string|{path:string,capacity?:string,read_only?:boolean}>} [opts.dataDirs]
 *   One entry renders `data_dir = "<path>"`. Several render Garage's multi-dir form,
 *   where every writable dir needs a capacity. Capacity is only a weight: blocks are
 *   placed by hash with no free-space check, so a dir that fills fails its share of writes.
 */
export function renderGarageToml({ dataDirs = [DATA_DIR] } = {}) {
  const dirs = dataDirs.map((d) => (typeof d === "string" ? { path: d } : { ...d }));
  if (dirs.length === 0) throw new Error("at least one data dir is required");
  for (const d of dirs) {
    if (typeof d.path !== "string" || !d.path.startsWith("/")) throw new Error(`data dir path must be absolute: ${JSON.stringify(d.path)}`);
  }
  let dataLine;
  if (dirs.length === 1 && !dirs[0].read_only) {
    dataLine = `data_dir = ${quote(dirs[0].path)}`;
  } else {
    const rows = dirs.map((d) => {
      if (d.read_only) return `  { path = ${quote(d.path)}, read_only = true },`;
      if (typeof d.capacity !== "string" || !/^\d+(\.\d+)?[KMGT]?$/.test(d.capacity)) {
        throw new Error(`data dir ${d.path} needs a capacity such as "500G" when there is more than one`);
      }
      return `  { path = ${quote(d.path)}, capacity = ${quote(d.capacity)} },`;
    });
    dataLine = `data_dir = [\n${rows.join("\n")}\n]`;
  }
  return [
    "# File Storage (Garage) for Crow. Rendered by scripts/render-config.mjs; do not edit by hand.",
    "# Secrets come from the environment (GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN, GARAGE_METRICS_TOKEN).",
    `metadata_dir = ${quote(META_DIR)}`,
    dataLine,
    "",
    "# SQLite, not LMDB: LMDB can corrupt after an unclean shutdown.",
    'db_engine = "sqlite"',
    "metadata_fsync = true",
    "data_fsync = true",
    'metadata_auto_snapshot_interval = "6h"',
    "# Music, photos and video do not compress; zstd would cost CPU for nothing.",
    'compression_level = "none"',
    "",
    "# One node, no redundancy (needs --single-node). Redundancy comes from backups.",
    "replication_factor = 1",
    'rpc_bind_addr = "[::]:3901"',
    'rpc_public_addr = "127.0.0.1:3901"',
    "",
    "[s3_api]",
    'api_bind_addr = "[::]:3900"',
    's3_region = "us-east-1"',
    "",
    "[admin]",
    'api_bind_addr = "[::]:3903"',
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] || join(dirname(dirname(fileURLToPath(import.meta.url))), "garage.toml");
  writeFileSync(out, renderGarageToml());
  console.log(`wrote ${out}`);
}
