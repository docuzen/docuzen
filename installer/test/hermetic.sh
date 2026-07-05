#!/usr/bin/env bash
# Hermetic installer test: builds a fake release served over file:// and drives
# installer/docuzen against it with an overridable install dir. No network, no
# real /Applications. Runs on Linux (uses the XML-plist version fallback) and macOS.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"        # installer/
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Run against a DISPOSABLE copy of the CLI: `docuzen uninstall` removes its own
# $0, which must never be the source file under test. Re-copy before each case
# that may delete it.
bin="$work/bin"; mkdir -p "$bin"; cli="$bin/docuzen"
fresh_cli() { cp "$here/docuzen" "$cli"; chmod +x "$cli"; }
fresh_cli

arch="$(uname -m)"; case "$arch" in arm64) a=arm64;; x86_64) a=x64;; *) a=x64;; esac
appdir="$work/Applications"; mkdir -p "$appdir"
rel="$work/release"; mkdir -p "$rel"

# --- build a fake docuzen.app tarball (version 9.9.9) + SHA256SUMS + API JSON ---
stage="$work/stage"; mkdir -p "$stage/docuzen.app/Contents"
cat > "$stage/docuzen.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>9.9.9</string>
</dict></plist>
PLIST
tarball="docuzen-9.9.9-$a.app.tar.gz"
tar -czf "$rel/$tarball" -C "$stage" docuzen.app
( cd "$rel" && shasum -a 256 "$tarball" > SHA256SUMS.txt )
cat > "$rel/latest.json" <<JSON
{"tag_name":"v9.9.9","assets":[
{"name":"$tarball","browser_download_url":"file://$rel/$tarball"},
{"name":"SHA256SUMS.txt","browser_download_url":"file://$rel/SHA256SUMS.txt"}]}
JSON

run() { DOCUZEN_APP_DIR="$appdir" DOCUZEN_RELEASES_API="file://$rel/latest.json" "$cli" "$@"; }

# --- 1. fresh install: verify passes, app lands ---
run update
[ -f "$appdir/docuzen.app/Contents/Info.plist" ] || { echo "FAIL: app not installed"; exit 1; }
echo "ok: fresh install"

# --- 2. already up to date: second update is a no-op success ---
out="$(run update)"; echo "$out" | grep -qi "already" || { echo "FAIL: expected already-latest, got: $out"; exit 1; }
echo "ok: up-to-date no-op"

# --- 3. checksum mismatch: corrupt the tarball, wipe install, expect failure + no install ---
rm -rf "$appdir/docuzen.app"; echo "tampered" >> "$rel/$tarball"
if run update >/dev/null 2>&1; then echo "FAIL: corrupt tarball installed"; exit 1; fi
[ -e "$appdir/docuzen.app" ] && { echo "FAIL: app installed despite bad checksum"; exit 1; }
echo "ok: checksum mismatch blocks install"

echo "ALL HERMETIC TESTS PASSED"
