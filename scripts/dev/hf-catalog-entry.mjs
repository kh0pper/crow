#!/usr/bin/env node
/**
 * Dev-only helper: given a Hugging Face GGUF repo + filename, fetch the REAL
 * size and sha256 (git-LFS oid) for that file and emit a `quants[]` entry
 * shaped for `registry/model-catalog.json`.
 *
 * NOT shipped in any runtime path — this is a build-time tool a developer
 * runs by hand when curating the catalog. Nothing under servers/ imports it.
 *
 * RAM-fit formula (baseline KV-cache estimate; see spec's RAM-fit section,
 * Gitea crow-engineering specs/2026-07-18-item-g-model-catalog-design.md):
 *
 *   kv_estimate_mb = KV_STREAMS * n_layer * n_embd * BYTES_PER_ELEM * context_len / 1e6
 *   min_ram_mb     = ceil(size_mb + kv_estimate_mb + overhead_mb)
 *
 * KV_STREAMS = 2 (one K cache + one V cache per layer).
 * BYTES_PER_ELEM = 2 (fp16 KV cache, llama.cpp's default `--cache-type-k/v f16`).
 * overhead_mb = 512 by default (fixed runtime/allocator overhead), overridable.
 *
 * This is a BASELINE estimate, not exact: it uses n_embd (full hidden size)
 * rather than num_key_value_heads * head_dim, so it does NOT account for
 * grouped-query attention (GQA) shrinking the KV cache on modern models — the
 * result is deliberately conservative (an over-estimate) on any GQA model,
 * which is the honest direction to be wrong in for a RAM-fit gate. If a future
 * revision wants the exact GQA-aware term, pass --n-kv-heads and --head-dim;
 * today's formula does not consume them (documented no-op, kept for
 * forward compatibility / model-card record-keeping only).
 *
 * Usage:
 *   node scripts/dev/hf-catalog-entry.mjs <hf_repo> <filename> \
 *     --n-layer <int> --n-embd <int> [--context-len 8192] \
 *     [--quant Q4_K_M] [--min-vram-mb 0] [--overhead-mb 512] \
 *     [--kv-bytes-per-elem 2] [--n-kv-heads <int>] [--head-dim <int>] \
 *     [--hf-token <token>]
 *
 * Example:
 *   node scripts/dev/hf-catalog-entry.mjs Qwen/Qwen3-4B-GGUF Qwen3-4B-Q4_K_M.gguf \
 *     --n-layer 36 --n-embd 2560 --context-len 8192 --quant Q4_K_M --min-vram-mb 0
 *
 * Gated repos: the HF API hides `blobs` (size + sha256) for gated repos
 * unless the request is authenticated AND the account has accepted the
 * license. This script falls back to the unauthenticated `/tree/main` API,
 * which (as observed 2026-07-18 against google/gemma-3-27b-it-qat-q4_0-gguf)
 * DOES expose the real file `size` even for a gated repo, but the LFS `oid`
 * (sha256) itself is redacted. In that case the emitted quant has a REAL
 * `size_mb` and `sha256: null`, with a warning on stderr. The catalog
 * validator (Task 2) only accepts a null sha256 when the model entry is
 * `gated: true` — never invent a hash.
 */

import { parseArgs } from "node:util";

const HELP = `hf-catalog-entry.mjs — fetch a real HF GGUF file size + sha256 and emit a catalog quant entry

Usage:
  node scripts/dev/hf-catalog-entry.mjs <hf_repo> <filename> [options]

Positional:
  <hf_repo>            Hugging Face repo id, e.g. "Qwen/Qwen3-4B-GGUF"
  <filename>            GGUF filename inside that repo, e.g. "Qwen3-4B-Q4_K_M.gguf"
                        (path form "subdir/file.gguf" is allowed for multi-file repos)

Required options:
  --n-layer <int>       Number of transformer layers (num_hidden_layers in the
                        base model's config.json). Feeds the KV-cache estimate.
  --n-embd <int>        Hidden size / embedding dim (hidden_size in config.json).
                        Feeds the KV-cache estimate.

Options:
  --context-len <int>   Context length to size the KV cache at. Default 8192.
                        Use an honest deployment default, NOT the model's max
                        context (a 128K max context would wildly overstate
                        actual RAM need for a typical chat session).
  --quant <string>      Quant label to stamp on the entry (e.g. "Q4_K_M").
                        Default: inferred from <filename> (last _TOKEN before
                        ".gguf", uppercased) — override if inference is wrong.
  --min-vram-mb <int>   min_vram_mb to stamp on the entry. Default 0 (CPU-ok).
  --overhead-mb <int>   Fixed runtime/allocator overhead added on top of the
                        KV estimate. Default 512.
  --kv-bytes-per-elem <int>
                        Bytes per KV cache element. Default 2 (fp16 KV cache,
                        llama.cpp's default). Documented override for a future
                        quantized-KV-cache catalog revision.
  --n-kv-heads <int>    Informational only (GQA key/value head count) — NOT
                        consumed by today's baseline formula. Recorded so a
                        future GQA-aware revision doesn't have to re-derive it.
  --head-dim <int>      Informational only (attention head dimension) — same
                        no-op/record-keeping status as --n-kv-heads.
  --hf-token <token>    Bearer token for the HF API (gated repos you have
                        accepted the license for). Never logged. Prefer the
                        HF_TOKEN env var over passing this on the command line.
  --help, -h            Show this help and exit.

Output:
  A single JSON object on stdout, shaped for registry/model-catalog.json's
  quants[] array: { file, quant, size_mb, min_ram_mb, min_vram_mb, sha256 }.
  Diagnostics (including the gated-repo fallback warning) go to stderr, never
  stdout, so this script composes with "> entry.json" or piping into jq.

Exit codes: 0 success, 1 usage error, 2 HF API / network error, 3 file not
found in the repo's file listing.
`;

function fail(msg, code) {
  process.stderr.write(`hf-catalog-entry: ${msg}\n`);
  process.exit(code);
}

function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        "n-layer": { type: "string" },
        "n-embd": { type: "string" },
        "context-len": { type: "string", default: "8192" },
        quant: { type: "string" },
        "min-vram-mb": { type: "string", default: "0" },
        "overhead-mb": { type: "string", default: "512" },
        "kv-bytes-per-elem": { type: "string", default: "2" },
        "n-kv-heads": { type: "string" },
        "head-dim": { type: "string" },
        "hf-token": { type: "string" },
      },
    });
  } catch (err) {
    fail(`bad arguments: ${err.message}`, 1);
  }
  return parsed;
}

/** Baseline KV-cache estimate in MB. See the module doc comment for the formula's provenance and known GQA over-estimate direction. */
export function kvEstimateMb({ nLayer, nEmbd, contextLen, bytesPerElem = 2 }) {
  const KV_STREAMS = 2; // one K cache + one V cache per layer
  return (KV_STREAMS * nLayer * nEmbd * bytesPerElem * contextLen) / 1e6;
}

/** min_ram_mb = ceil(size_mb + kv_estimate_mb + overhead_mb). */
export function computeMinRamMb({ sizeMb, nLayer, nEmbd, contextLen, bytesPerElem = 2, overheadMb = 512 }) {
  const kv = kvEstimateMb({ nLayer, nEmbd, contextLen, bytesPerElem });
  return Math.ceil(sizeMb + kv + overheadMb);
}

/** Infer a quant label like "Q4_K_M" from a GGUF filename. Best-effort; callers should pass --quant if this guesses wrong. */
export function inferQuantFromFilename(filename) {
  const base = filename.replace(/\.gguf$/i, "");
  const m = base.match(/([A-Za-z]?[Qq][0-9]+(?:_[A-Za-z0-9]+)*|F16|F32|BF16)$/);
  return m ? m[1].toUpperCase() : base.toUpperCase();
}

async function hfFetchJson(url, token) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  return { res, body: res.ok ? await res.json() : null, status: res.status };
}

/**
 * Resolve size_mb + sha256 for a file in an HF repo.
 * Tries the blobs=true model API first (gives both size and LFS sha256 for
 * ungated repos, or any repo with a valid authenticated+accepted token).
 * Falls back to the unauthenticated /tree/main API, which HF has been
 * observed to still expose real `size` for on a gated repo (sha256/oid is
 * redacted there) — see module doc comment.
 */
export async function resolveFileMeta({ repo, filename, token, fetchImpl = fetch }) {
  const blobsUrl = `https://huggingface.co/api/models/${repo}?blobs=true`;
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const blobsRes = await fetchImpl(blobsUrl, { headers });
  if (blobsRes.ok) {
    const data = await blobsRes.json();
    const sib = (data.siblings || []).find((s) => s.rfilename === filename);
    if (!sib) return { found: false, gatedFallback: false };
    // The blobs=true LFS metadata has been observed keyed as either
    // `lfs.sha256` or `lfs.oid` depending on HF API version — accept either,
    // never invent one.
    const lfsSha = sib.lfs && (sib.lfs.sha256 || sib.lfs.oid);
    if (sib.size != null && lfsSha) {
      return { found: true, gatedFallback: false, sizeBytes: sib.size, sha256: lfsSha };
    }
    if (sib.size != null) {
      // Present but not an LFS pointer (small non-LFS file, unusual for a
      // GGUF) — no sha256 available from this endpoint either way.
      return { found: true, gatedFallback: false, sizeBytes: sib.size, sha256: null };
    }
    return { found: false, gatedFallback: false };
  }

  if (blobsRes.status !== 401 && blobsRes.status !== 403) {
    throw new Error(`HF API ${blobsUrl} -> HTTP ${blobsRes.status}`);
  }

  // Gated-repo fallback: unauthenticated /tree/main has been observed to
  // still return real `size` (sha256/oid redacted) for a gated repo.
  process.stderr.write(
    `hf-catalog-entry: WARNING ${repo} blobs API returned ${blobsRes.status} (gated or private) — falling back to /tree/main; sha256 will be null.\n`
  );
  const treeUrl = `https://huggingface.co/api/models/${repo}/tree/main`;
  const treeRes = await fetchImpl(treeUrl, { headers });
  if (!treeRes.ok) {
    throw new Error(`HF API ${treeUrl} -> HTTP ${treeRes.status} (gated-repo fallback also failed)`);
  }
  const entries = await treeRes.json();
  const entry = entries.find((e) => e.path === filename);
  if (!entry) return { found: false, gatedFallback: true };
  const sizeBytes = entry.lfs?.size ?? entry.size;
  return { found: true, gatedFallback: true, sizeBytes, sha256: null };
}

async function main() {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseCliArgs(argv);

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (argv.length === 0) {
    fail("usage: <hf_repo> <filename> [options] (--help for details)", 1);
  }

  const [repo, filename] = positionals;
  if (!repo || !filename) fail("usage: <hf_repo> <filename> [options] (--help for details)", 1);
  if (!values["n-layer"] || !values["n-embd"]) fail("--n-layer and --n-embd are required", 1);

  const nLayer = Number(values["n-layer"]);
  const nEmbd = Number(values["n-embd"]);
  const contextLen = Number(values["context-len"]);
  const overheadMb = Number(values["overhead-mb"]);
  const bytesPerElem = Number(values["kv-bytes-per-elem"]);
  const minVramMb = Number(values["min-vram-mb"]);
  const token = values["hf-token"] || process.env.HF_TOKEN || undefined;

  for (const [name, val] of [
    ["--n-layer", nLayer],
    ["--n-embd", nEmbd],
    ["--context-len", contextLen],
    ["--overhead-mb", overheadMb],
    ["--kv-bytes-per-elem", bytesPerElem],
    ["--min-vram-mb", minVramMb],
  ]) {
    if (!Number.isFinite(val) || val < 0) fail(`${name} must be a non-negative number, got ${val}`, 1);
  }

  let meta;
  try {
    meta = await resolveFileMeta({ repo, filename, token });
  } catch (err) {
    fail(`HF API request failed: ${err.message}`, 2);
    return;
  }

  if (!meta.found) {
    fail(`file "${filename}" not found in ${repo}'s file listing`, 3);
    return;
  }

  const sizeMb = meta.sizeBytes / 1e6;
  const minRamMb = computeMinRamMb({ sizeMb, nLayer, nEmbd, contextLen, bytesPerElem, overheadMb });
  const quant = values.quant || inferQuantFromFilename(filename);

  if (meta.gatedFallback) {
    process.stderr.write(
      `hf-catalog-entry: NOTE sha256 is null (gated repo, API hides the LFS oid without an accepted-license token). size_mb is real (from /tree/main). Set the model entry's "gated": true so the validator accepts a null sha256.\n`
    );
  }

  const entry = {
    file: filename,
    quant,
    size_mb: Math.round(sizeMb * 100) / 100,
    min_ram_mb: minRamMb,
    min_vram_mb: minVramMb,
    sha256: meta.sha256,
  };

  process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => fail(`unexpected error: ${err.stack || err.message}`, 2));
}
