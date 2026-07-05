#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/devrouter"

mkdir -p "$BIN_DIR"

cat > "$TARGET" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$ROOT_DIR"
ENTRY="\$ROOT_DIR/dist/devrouter.js"

if [ ! -f "\$ENTRY" ]; then
  echo "devrouter is not built yet. Run: cd \"\$ROOT_DIR\" && pnpm build" >&2
  exit 1
fi

exec node "\$ENTRY" "\$@"
SCRIPT

chmod +x "$TARGET"

echo "Installed devrouter to $TARGET"
echo "To run commands using 'dev' instead of 'devrouter', add an alias to your shell profile (e.g. ~/.zshrc):"
echo "  alias dev=devrouter"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "Add $BIN_DIR to your PATH if needed:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    echo ""
    echo "Then run 'hash -r' or open a new terminal."
    ;;
esac
