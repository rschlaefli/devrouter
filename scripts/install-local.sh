#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/bin"
TARGET="$BIN_DIR/dev"

mkdir -p "$BIN_DIR"

cat > "$TARGET" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$ROOT_DIR"
ENTRY="\$ROOT_DIR/dist/dev.js"

if [ ! -f "\$ENTRY" ]; then
  echo "devrouter is not built yet. Run: cd \"\$ROOT_DIR\" && pnpm build" >&2
  exit 1
fi

exec node "\$ENTRY" "\$@"
SCRIPT

chmod +x "$TARGET"

echo "Installed dev to $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "Add $BIN_DIR to your PATH if needed:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
