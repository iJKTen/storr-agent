#!/bin/sh
set -e

# Install workspace dependencies if node_modules is missing.
# The hydrogen container may also do this, but the agent needs them
# for npm run typecheck to work from this container.
if [ -f "$WORKSPACE_PATH/package.json" ] && [ ! -d "$WORKSPACE_PATH/node_modules" ]; then
  echo "[entrypoint] Installing workspace dependencies..."
  cd "$WORKSPACE_PATH"
  npm ci
  cd /agent
fi

exec node /agent/dist/index.js "$@"
