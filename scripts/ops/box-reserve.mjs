#!/usr/bin/env node
/**
 * box-reserve — hold / release / inspect the box reservation the
 * gpu-orchestrator honors before starting any local model.
 *
 *   box-reserve hold --owner <name> --reason <text> [--minutes N=480] [--allow p1,p2] [--force]
 *   box-reserve release
 *   box-reserve status
 *
 * Writes/reads $CROW_BOX_RESERVATION_PATH (default
 * /run/user/<uid>/crow-box-reservation.json). A hold longer than 8 h needs
 * --force (Kevin decision 2, 2026-09-04). While the file exists, escalations
 * degrade to the fast resident model and non-allowed model starts are
 * refused with `box_reserved` — see docs/architecture/box-reservation.md.
 *
 * Exit codes: 0 ok · 1 refused (e.g. over the 8 h max) · 2 usage.
 */

import {
  readReservation, writeReservation, clearReservation, reservationPath,
} from "../../servers/gateway/box-reservation.js";

const USAGE = [
  "usage:",
  "  box-reserve hold --owner <name> --reason <text> [--minutes N=480] [--allow p1,p2] [--force]",
  "  box-reserve release",
  "  box-reserve status",
  "",
  `file: ${reservationPath()}  (override with CROW_BOX_RESERVATION_PATH)`,
].join("\n");

function usage(code = 2) {
  console.error(USAGE);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") { out.force = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) usage();
      out[key] = val; i++;
      continue;
    }
    out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (args.help || !cmd) usage();

if (cmd === "status") {
  const r = readReservation();
  console.log(r ? JSON.stringify(r, null, 2) : "none");
  process.exit(0);
}

if (cmd === "release") {
  const removed = clearReservation();
  console.log(removed ? `released ${reservationPath()}` : "none (nothing to release)");
  process.exit(0);
}

if (cmd === "hold") {
  if (!args.owner) usage();
  const minutes = args.minutes === undefined ? 480 : Number(args.minutes);
  const allow = args.allow ? String(args.allow).split(",").map((s) => s.trim()).filter(Boolean) : [];
  try {
    const rec = writeReservation({ owner: args.owner, reason: args.reason || "", minutes, allow, force: !!args.force });
    console.log(`held by ${rec.owner} until ${rec.expires_at} (${reservationPath()})`);
    process.exit(0);
  } catch (e) {
    console.error(`refused: ${e.message}`);
    process.exit(1);
  }
}

usage();
