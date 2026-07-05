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

tmp_cli="$(mktemp "$BINDIR/.docuzen.XXXXXX")" || { echo "docuzen: cannot create a temp file in $BINDIR" >&2; exit 1; }
curl -fsSL "$RAW_BASE/installer/docuzen" -o "$tmp_cli" \
  || { echo "docuzen: failed to download the CLI" >&2; rm -f "$tmp_cli"; exit 1; }
chmod +x "$tmp_cli"
mv -f "$tmp_cli" "$BINDIR/docuzen"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *)
    # $PATH is intentionally literal so the user's shell expands it at paste time.
    # shellcheck disable=SC2016
    printf 'Note: add %s to your PATH:\n  export PATH="%s:$PATH"\n' "$BINDIR" "$BINDIR" ;;
esac

exec "$BINDIR/docuzen" update
