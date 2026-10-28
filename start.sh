#!/bin/bash

# Crow — Linux Launcher
# Make executable: chmod +x start.sh
# Then double-click or run: ./start.sh

cd "$(dirname "$0")"

echo ""
echo "================================================="
echo "   Crow"
echo "================================================="
echo ""

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "  Node.js is required but not installed."
  echo ""
  echo "  Install Node.js from https://nodejs.org"
  echo "  Or run: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo ""
  # Try to open browser
  xdg-open "https://nodejs.org" 2>/dev/null || true
  echo "  Press any key to exit."
  read -n 1
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 24 ]; then
  echo "  Node.js $(node -v) is too old. Need version 24 or newer."
  echo "  Install from https://nodejs.org"
  xdg-open "https://nodejs.org" 2>/dev/null || true
  echo "  Press any key to exit."
  read -n 1
  exit 1
fi

echo "  Node.js $(node -v) — OK"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies (first run only)..."
  npm install --silent
fi

# Initialize database if needed
if [ ! -f "data/crow.db" ]; then
  echo "  Initializing database..."
  node scripts/init-db.js
fi

# Open the setup wizard
echo ""
echo "  Starting the setup wizard..."
echo "  It prints a one-time link. Open that link in your browser if it doesn't open by itself."
echo ""
echo "  Press Ctrl+C when you're done with setup."
echo ""

node scripts/wizard-web.js
