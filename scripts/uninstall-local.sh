#!/usr/bin/env bash
set -euo pipefail

TARGET="$HOME/.local/bin/dev"

if [ -f "$TARGET" ]; then
  rm "$TARGET"
  echo "Removed $TARGET"
else
  echo "No local install found at $TARGET"
fi
