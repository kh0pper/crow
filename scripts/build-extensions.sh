#!/usr/bin/env bash

# Crow — Build Desktop Extension Bundles (.mcpb)
#
# Packages crow-memory and crow-research as .mcpb files
# for one-click installation in Claude Desktop.
#
# Usage: bash scripts/build-extensions.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

mkdir -p "$DIST"

echo ""
echo "================================================="
echo "   Building Desktop Extension Bundles"
echo "================================================="
echo ""

for EXT in crow-memory crow-research; do
  EXT_DIR="$ROOT/desktop-extensions/$EXT"
  SERVER_DIR="$ROOT/servers/${EXT#crow-}"
  OUTPUT="$DIST/$EXT.mcpb"

  if [ ! -d "$EXT_DIR" ]; then
    echo "  Error: $EXT_DIR not found"
    continue
  fi

  if [ ! -d "$SERVER_DIR" ]; then
    echo "  Error: $SERVER_DIR not found"
    continue
  fi

  echo "  Building $EXT..."

  # Create a temp directory for the bundle
  TEMP_DIR=$(mktemp -d)
  trap "rm -rf $TEMP_DIR" EXIT

  # Copy manifest
  cp "$EXT_DIR/manifest.json" "$TEMP_DIR/"

  # Copy server code
  mkdir -p "$TEMP_DIR/servers/${EXT#crow-}"
  cp -r "$SERVER_DIR"/* "$TEMP_DIR/servers/${EXT#crow-}/"

  # Copy shared dependencies
  cp "$ROOT/package.json" "$TEMP_DIR/"
  if [ -d "$ROOT/node_modules" ]; then
    cp -r "$ROOT/node_modules" "$TEMP_DIR/"
  fi

  # Copy init script for database setup
  mkdir -p "$TEMP_DIR/scripts"
  cp "$ROOT/scripts/init-db.js" "$TEMP_DIR/scripts/"

  # Create the .mcpb bundle (zip format)
  (cd "$TEMP_DIR" && zip -r -q "$OUTPUT" .)

  echo "  Created: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"

  rm -rf "$TEMP_DIR"
done

echo ""
echo "  Extension bundles saved to: $DIST/"
echo "  Users can double-click .mcpb files to install in Claude Desktop."
echo ""
