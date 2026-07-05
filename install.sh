#!/bin/sh
# docuzen one-line installer. Bootstraps the docuzen CLI, then installs the app.
#   curl -fsSL https://raw.githubusercontent.com/docuzen/docuzen/main/install.sh | sh
set -eu

[ "$(uname -s)" = "Darwin" ] || { echo "docuzen: the packaged app is macOS-only" >&2; exit 1; }

RAW_BASE="${DOCUZEN_RAW_BASE:-https://raw.githubusercontent.com/docuzen/docuzen/main}"

if [ -w /usr/local/bin ]; then
  BINDIR=/usr/local/bin
else
  BINDIR="$HOME/.local/bin"
  mkdir -p "$BINDIR"
fi

curl -fsSL "$RAW_BASE/installer/docuzen" -o "$BINDIR/docuzen" \
  || { echo "docuzen: failed to download the CLI" >&2; exit 1; }
chmod +x "$BINDIR/docuzen"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) printf 'Note: add %s to your PATH:\n  export PATH="%s:$PATH"\n' "$BINDIR" "$BINDIR" ;;
esac

exec "$BINDIR/docuzen" update
