#!/usr/bin/env node
/**
 * crow vault restore — decrypt a crow-vault/v1 backup with NO running Crow: no gateway, no DB, no
 * network, and no dependency outside Node's built-ins (spec §12.4, the out-of-band restore).
 *
 *   node scripts/vault-restore.mjs --file <f.vault> --date <YYYY-MM-DD> \
 *        --keychain-export <export.json> --out <path>
 *
 * The off-site backup key is read straight out of a keychain export file, so the export the owner
 * keeps offline is the single recovery root. The export's passphrase is read from STDIN — never
 * from argv or the environment, which other processes on the box can read.
 *
 * Prints one short line (backup date, bytes written, "verified"). Never the key, never the
 * passphrase.
 *
 * Exit codes: 0 ok · 2 usage · 3 the export or its passphrase did not work · 4 the vault file was
 * refused (the refusal code is in the message).
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { openExport } from "../servers/gateway/keychain/export.js";
import { decryptVault, offsiteKeyFromEntries, VaultError } from "../servers/shared/crow-vault.js";

const USAGE = "usage: node scripts/vault-restore.mjs --file <f.vault> --date <YYYY-MM-DD> --keychain-export <export.json> --out <path>";
const OPTIONS = ["file", "date", "keychain-export", "out"];

function failure(exitCode, message) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (!arg.startsWith("--")) throw failure(2, `unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!OPTIONS.includes(name)) throw failure(2, `unknown option --${name}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (typeof value !== "string" || value === "") throw failure(2, `--${name} needs a value`);
    opts[name] = value;
  }
  for (const name of OPTIONS) if (!opts[name]) throw failure(2, `--${name} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !Number.isFinite(Date.parse(`${opts.date}T00:00:00Z`))) {
    throw failure(2, "--date must be YYYY-MM-DD");
  }
  return opts;
}

/** The passphrase, from stdin only. Silent when stdin is a pipe (the way a script calls it). */
async function readPassphrase() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
    return text.split("\n")[0].replace(/\r$/, "");
  }
  process.stderr.write("Keychain export passphrase: ");
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const finish = (code) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
      if (code !== undefined) process.exit(code);
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(2); // Ctrl-C: leave without a stack trace
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return err.exitCode || 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    if (!existsSync(opts.file)) throw failure(2, `cannot read ${opts.file}`);
    if (!existsSync(opts["keychain-export"])) throw failure(3, `cannot read ${opts["keychain-export"]}`);
    // Never overwrite: the point of the restore is to keep the old database around.
    if (existsSync(opts.out)) throw failure(2, `refusing to overwrite ${opts.out}: move it aside or choose another --out`);
    if (!existsSync(dirname(opts.out))) throw failure(2, `the directory for ${opts.out} does not exist`);

    const passphrase = await readPassphrase();
    if (!passphrase) throw failure(3, "no passphrase was given on stdin");

    let file;
    try {
      file = JSON.parse(await readFile(opts["keychain-export"], "utf8"));
    } catch {
      throw failure(3, "that keychain export file cannot be read");
    }
    const entries = await openExport(file, passphrase);
    if (!entries) throw failure(3, "that passphrase does not open this export, or it is not a Crow keychain export");

    const key = offsiteKeyFromEntries(entries);
    if (!key) throw failure(3, "this export holds no off-site backup key (offsite-backup / CROW_OFFSITE_BACKUP_KEY)");

    let header;
    try {
      header = await decryptVault({ file: opts.file, out: opts.out, key, date: opts.date });
    } catch (err) {
      if (err instanceof VaultError) throw failure(4, `the vault file was refused (${err.code}): ${err.message}`);
      if (err && (err.code === "ENOENT" || err.code === "EACCES")) throw failure(2, `cannot read ${opts.file}`);
      throw failure(4, `the vault file could not be restored (${err?.code || err?.message || "unknown error"})`);
    }
    const bytes = statSync(opts.out).size;
    process.stdout.write(`restored backup ${header.backup_date}: ${bytes} bytes written to ${opts.out}, verified\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return err.exitCode || 1;
  }
}

main().then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`${err?.message || "restore failed"}\n`);
  process.exitCode = err?.exitCode || 1;
});