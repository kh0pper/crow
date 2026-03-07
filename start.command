#!/bin/bash

# Crow AI Platform — macOS Launcher
# Double-click this file to start the setup wizard.

cd "$(dirname "$0")"

echo ""
echo "================================================="
echo "   Crow AI Platform"
echo "================================================="
echo ""

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "  Node.js is required but not installed."
  echo ""
  echo "  Opening the Node.js download page..."
  echo "  Install Node.js, then double-click this file again."
  echo ""
  open "https://nodejs.org"
  echo "  Press any key to exit."
  read -n 1
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "  Node.js $(node -v) is too old. Need version 18 or newer."
  echo "  Opening the Node.js download page..."
  open "https://nodejs.org"
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
echo "  Opening setup wizard in your browser..."
echo "  If it doesn't open, go to: http://localhost:3456"
echo ""
echo "  Press Ctrl+C when you're done with setup."
echo ""

open "http://localhost:3456" 2>/dev/null &
node scripts/wizard-web.js
