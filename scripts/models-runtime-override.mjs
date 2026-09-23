#!/usr/bin/env node
/**
 * models-runtime-override.mjs — inspect, set and clear the llama-server
 * runtime overrides in <data dir>/models/state.json (Strix Halo runtime
 * profile spec §2.3, D5). This is how a pi-lab pre-merge llama.cpp build
 * reaches ONE model without touching the rest of the host.
 *
 *   list                                              host + every per-model override (JSON)
 *   get   [--model <id>]                              one record (JSON) or "none"
 *   set   --bin <abs path> [--model <id>] [--label <s>]
 *   clear [--model <id>]
 *
 * Without --model a command acts on the HOST override. <id> is the provider
 * row's gpu_policy.catalogId (or the provider name for a row without one);
 * a catalogId override applies to every quant/variant row of that model.
 * `set` validates exactly like the gateway: absolute path, executable,
 * `<bin> --version` exits 0.
 *
 * Data dir: resolveDataDir() — the gateway's own helper (CROW_DATA_DIR, else
 * ~/.crow/data, else the repo's ./data). For r4:
 *   CROW_DATA_DIR=/home/kh0pp/.crow-r4/data node scripts/models-runtime-override.mjs …
 * `set`/`clear` print the data dir they wrote. The gateway reads state.json
 * on every native start, so no restart is needed; a model that is already
 * running keeps its binary until it is stopped and started again.
 *
 * Second writer: the gateway also rewrites state.json (reservations,
 * registry, liveness markers) with a whole-file load/modify/save, so a
 * gateway write can land between our write and the next read and silently
 * drop our change. Every write is therefore re-read and verified; on a
 * mismatch it is retried once, then the CLI exits 3 saying a concurrent
 * gateway write overwrote it. The read-back NARROWS the race but does not
 * close it: a gateway that loaded state.json before our write and saves
 * after our read-back still wins, silently. After a `set`/`clear`, verify
 * with `get` after the next gateway restart.
 *
 * `list`/`get` read state.json directly — they never go through
 * getRuntimeOverride(), whose CROW_LLAMA_SERVER_BIN bootstrap would WRITE
 * state from a read command. `clear` without --model writes nothing when
 * no host override is stored.
 *
 * Exit codes: 0 ok, 1 refused (binary/id validation), 2 usage,
 * 3 overwritten by a concurrent gateway write.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveDataDir } from "../servers/db.js";
import { loadState } from "../servers/gateway/models/state.js";
import {
  setRuntimeOverride,
  clearRuntimeOverride,
  setModelRuntimeOverride,
  clearModelRuntimeOverride,
  listModelRuntimeOverrides,
  RuntimeOverrideError,
} from "../servers/gateway/models/runtime-override.js";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_PATH = join(REPO, "registry", "model-catalog.json");

export const EXIT_CONCURRENT_WRITE = 3;

export const USAGE = [
  "usage: node scripts/models-runtime-override.mjs <command> [options]",
  "  list",
  "  get   [--model <id>]",
  "  set   --bin <absolute path> [--model <id>] [--label <text>]",
  "  clear [--model <id>]",
  "without --model, get/set/clear act on the host-wide override",
].join("\n");

class ConcurrentWriteError extends Error {}

function defaultCatalogIds() {
  try {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    return (catalog.models || []).map((m) => m && m.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

function knownModelIds(dir, catalogIds) {
  const ids = new Set(catalogIds);
  for (const entry of Object.values(loadState(dir).registry || {})) {
    if (entry && typeof entry.catalogId === "string") ids.add(entry.catalogId);
  }
  return ids;
}

/**
 * Run `apply()` (one library write), re-read state.json, and confirm
 * `landed(state, result)`. Retry once on a mismatch; a second mismatch
 * throws ConcurrentWriteError. Returns the result of whichever attempt
 * `landed` actually confirmed (the retry's, when the first was clobbered
 * before we could read it back) — e.g. `set`'s persisted record (its
 * `setAt` must match what's on disk) or clear's "was one set?".
 */
function writeVerified(dir, apply, landed) {
  const first = apply();
  if (landed(loadState(dir), first)) return first;
  const second = apply();
  if (landed(loadState(dir), second)) return second;
  throw new ConcurrentWriteError(
    `state.json at ${dir} did not keep the change after a retry — a concurrent gateway write overwrote it. Run the command again; if it keeps happening, check that the gateway on this data dir is current (an older gateway drops unknown state keys).`,
  );
}

const sameRecord = (stored, rec) => !!stored && stored.bin === rec.bin && stored.setAt === rec.setAt;

export async function main(argv, deps = {}) {
  const { out = (s) => console.log(s), err = (s) => console.error(s), overrideOpts = {}, env = process.env } = deps;

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: "string" },
        bin: { type: "string" },
        label: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    err(USAGE);
    return 2;
  }
  const model = values.model;
  if (model !== undefined && model.trim() === "") {
    err(`--model needs a non-empty id\n${USAGE}`);
    return 2;
  }

  const cmd = positionals[0];
  const dir = deps.dir ?? resolveDataDir();

  if (!model && (cmd === "get" || cmd === "clear") && env.CROW_LLAMA_SERVER_BIN) {
    err(`warning: CROW_LLAMA_SERVER_BIN is set (${env.CROW_LLAMA_SERVER_BIN}) in this shell; a gateway started with it re-bootstraps the host override from it whenever none is stored`);
  }

  try {
    switch (cmd) {
      case "list": {
        const state = loadState(dir);
        out(JSON.stringify({ dataDir: dir, host: state.runtimeOverride, models: listModelRuntimeOverrides(dir) }, null, 2));
        return 0;
      }
      case "get": {
        let rec;
        if (model) {
          const map = listModelRuntimeOverrides(dir);
          rec = Object.hasOwn(map, model) ? map[model] : null;
        } else {
          rec = loadState(dir).runtimeOverride;
        }
        out(rec ? JSON.stringify(rec, null, 2) : "none");
        return 0;
      }
      case "set": {
        if (!values.bin) {
          err(`set needs --bin <absolute path>\n${USAGE}`);
          return 2;
        }
        const label = values.label ?? null;
        if (model) {
          const catalogIds = deps.catalogIds ?? defaultCatalogIds();
          if (!knownModelIds(dir, catalogIds).has(model)) {
            err(`warning: "${model}" matches no catalog id or registered model; it will only apply to a provider named "${model}" whose gpu_policy has no catalogId`);
          }
          const rec = writeVerified(
            dir,
            () => setModelRuntimeOverride(dir, model, values.bin, { ...overrideOpts, label }),
            (st, r) => Object.hasOwn(st.runtimeOverrides, model) && sameRecord(st.runtimeOverrides[model], r),
          );
          out(`per-model override set for ${model}: ${rec.bin} (${rec.version}) (data dir: ${dir})`);
        } else {
          const rec = writeVerified(
            dir,
            () => setRuntimeOverride(dir, { bin: values.bin, label }, overrideOpts),
            (st, r) => sameRecord(st.runtimeOverride, r),
          );
          out(`host override set: ${rec.bin} (${rec.version}) (data dir: ${dir})`);
        }
        return 0;
      }
      case "clear": {
        const what = model ? `per-model override for ${model}` : "host override";
        let had;
        if (model) {
          had = writeVerified(
            dir,
            () => clearModelRuntimeOverride(dir, model, overrideOpts),
            (st) => !Object.hasOwn(st.runtimeOverrides, model),
          );
        } else if (loadState(dir).runtimeOverride == null) {
          had = false; // nothing stored: never create or rewrite state.json
        } else {
          had = writeVerified(
            dir,
            () => clearRuntimeOverride(dir, overrideOpts),
            (st) => st.runtimeOverride == null,
          );
        }
        out(`${had ? `cleared ${what}` : `nothing to clear (${what})`} (data dir: ${dir})`);
        return 0;
      }
      default:
        err(`unknown command "${cmd}"\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof RuntimeOverrideError) {
      err(`refused (${e.code}): ${e.message}`);
      return 1;
    }
    if (e instanceof ConcurrentWriteError) {
      err(`error: ${e.message}`);
      return EXIT_CONCURRENT_WRITE;
    }
    throw e;
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
