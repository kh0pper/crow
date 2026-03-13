#!/usr/bin/env node

/**
 * Crow Data Directory Migration
 *
 * Migrates data from ./data/ (repo-local) to ~/.crow/data/ (home directory).
 * Creates a symlink from ./data/ → ~/.crow/data/ for backward compatibility.
 *
 * Safe to run multiple times — skips if already migrated.
 */

import { existsSync, mkdirSync, copyFileSync, symlinkSync, lstatSync, readdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OLD_DATA_DIR = resolve(ROOT, "data");
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const NEW_DATA_DIR = resolve(HOME, ".crow", "data");

function log(msg) {
  console.log(`  ${msg}`);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function migrate() {
  if (!HOME) {
    log("Cannot determine home directory. Skipping migration.");
    return;
  }

  // Already migrated — ./data/ is a symlink to ~/.crow/data/
  if (isSymlink(OLD_DATA_DIR)) {
    log("Data directory already migrated (symlink exists).");
    return;
  }

  // Check if old data directory has files to migrate
  const hasOldData = existsSync(OLD_DATA_DIR) && !isSymlink(OLD_DATA_DIR);
  const oldFiles = hasOldData ? readdirSync(OLD_DATA_DIR).filter(f => !f.startsWith(".")) : [];

  // Create ~/.crow/data/ if it doesn't exist
  mkdirSync(NEW_DATA_DIR, { recursive: true });

  if (oldFiles.length > 0) {
    log(`Migrating ${oldFiles.length} file(s) from ./data/ to ~/.crow/data/...`);

    for (const file of oldFiles) {
      const src = resolve(OLD_DATA_DIR, file);
      const dest = resolve(NEW_DATA_DIR, file);

      // Don't overwrite existing files in destination
      if (existsSync(dest)) {
        log(`  Skipped ${file} (already exists in ~/.crow/data/)`);
        continue;
      }

      try {
        copyFileSync(src, dest);
        log(`  Copied ${file}`);
      } catch (err) {
        log(`  Warning: Failed to copy ${file}: ${err.message}`);
      }
    }

    // Remove old directory and create symlink
    try {
      rmSync(OLD_DATA_DIR, { recursive: true });
    } catch (err) {
      log(`Warning: Could not remove old data directory: ${err.message}`);
      log("Symlink creation skipped — remove ./data/ manually and re-run.");
      return;
    }
  }

  // Create symlink ./data/ → ~/.crow/data/ for backward compatibility
  if (!existsSync(OLD_DATA_DIR)) {
    try {
      symlinkSync(NEW_DATA_DIR, OLD_DATA_DIR);
      log(`Created symlink: ./data/ → ~/.crow/data/`);
    } catch (err) {
      log(`Warning: Could not create symlink: ${err.message}`);
      log("This is fine — Crow will use ~/.crow/data/ directly.");
    }
  }

  log("Migration complete.");
}

migrate();
