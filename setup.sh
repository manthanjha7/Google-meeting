#!/bin/bash
# Finrep Meeting Intelligence — server setup script (non-Docker)
set -e

echo "=== Finrep Meeting Intelligence Setup ==="

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ is required. Install from https://nodejs.org"
  exit 1
fi
echo "✓ Node.js $(node -v) detected"

# Create .env if it doesn't exist
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  .env file created from .env.example"
  echo "   Please edit .env and fill in your API keys before starting the server."
  echo ""
else
  echo "✓ .env file already exists"
fi

# Install dependencies
echo "Installing dependencies..."
npm ci --omit=dev
echo "✓ Dependencies installed"

# Create required directories
mkdir -p uploads data/db data/uploads
echo "✓ Directories created"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env and fill in all required values"
echo "  2. Start the server:  npm run server"
echo "  3. Install the Chrome extension from the 'extension/' folder"
echo ""
echo "To run in the background with auto-restart:"
echo "  npm install -g pm2"
echo "  pm2 start server/index.js --name finrep"
echo "  pm2 save && pm2 startup"
