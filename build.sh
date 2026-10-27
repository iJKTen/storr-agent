#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_SRC="${RULES_PATH:-$SCRIPT_DIR/../storr-prompt/rules}"

if [ ! -d "$RULES_SRC" ]; then
  echo "ERROR: rules/ directory not found at $RULES_SRC"
  echo "Set RULES_PATH to the correct location."
  exit 1
fi

# Copy rules into build context so Docker can COPY them
cp -r "$RULES_SRC" "$SCRIPT_DIR/rules"

docker build -t storr-agent "$SCRIPT_DIR" "$@"

# Clean up
rm -rf "$SCRIPT_DIR/rules"

echo "Built storr-agent image. Run with:"
echo "  EVE_PATH=/path/to/hydrogen docker compose up"
