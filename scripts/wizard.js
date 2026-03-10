#!/usr/bin/env node

/**
 * Crow — Setup Wizard Launcher
 *
 * Launches the web-based wizard by default (opens in browser).
 * Falls back to terminal mode with --terminal flag.
 *
 * Usage:
 *   node scripts/wizard.js           # Opens web UI in browser
 *   node scripts/wizard.js --terminal # Terminal-only mode (no browser needed)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--terminal") || args.includes("-t")) {
  // Terminal-mode fallback
  const { default: runTerminalWizard } = await import("./wizard-terminal.js");
} else {
  // Web wizard (default)
  await import("./wizard-web.js");
}
