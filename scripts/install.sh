#!/usr/bin/env bash

# Crow AI Platform — One-Line Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USER/crow/main/scripts/install.sh | bash
#
# Or if you've already cloned the repo:
#   bash scripts/install.sh

set -e

REPO_URL="https://github.com/YOUR_USER/crow.git"
INSTALL_DIR="${CROW_INSTALL_DIR:-$HOME/crow}"

echo ""
echo "================================================="
echo "   Crow AI Platform — Installer"
echo "================================================="
echo ""

# Step 1: Check for Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 18 ]; then
    echo "  Node.js $(node -v) — OK"
  else
    echo "  Node.js $(node -v) is too old. Need 18+."
    echo "  Install via: https://nodejs.org or nvm"
    exit 1
  fi
else
  echo "  Node.js not found. Installing via nvm..."
  if ! command -v nvm &>/dev/null; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  fi
  nvm install --lts
  nvm use --lts
  echo "  Node.js $(node -v) installed via nvm"
fi

# Step 2: Clone or update repo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Found existing installation at $INSTALL_DIR"
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || echo "  (using existing version)"
else
  if [ -f "package.json" ] && grep -q "crow-ai-platform" package.json 2>/dev/null; then
    echo "  Running from existing crow directory"
    INSTALL_DIR="$(pwd)"
  else
    echo "  Cloning Crow AI Platform to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"

# Step 3: Install dependencies
echo "  Installing dependencies..."
npm install --silent

# Step 4: Initialize database
echo "  Initializing database..."
node scripts/init-db.js

# Step 5: Launch the setup wizard
echo ""
echo "  Opening the setup wizard in your browser..."
echo "  (If it doesn't open, go to http://localhost:3456)"
echo ""

# Use web wizard if we have a display, terminal fallback otherwise
if [ -n "$DISPLAY" ] || [ "$(uname)" = "Darwin" ] || [ -n "$BROWSER" ]; then
  node scripts/wizard-web.js &
  WIZARD_PID=$!
  echo ""
  echo "  The setup wizard is running at http://localhost:3456"
  echo "  Configure your integrations in the browser, then press Ctrl+C here when done."
  echo ""
  wait $WIZARD_PID 2>/dev/null || true
else
  echo "  No display detected — using terminal wizard."
  node scripts/wizard.js --terminal
fi

echo ""
echo "  Installation complete!"
echo "  Run 'claude' in $INSTALL_DIR to start."
echo ""
