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

# --- 4. reinstall clean, then uninstall keeps ~/.docuzen without --purge ---
# restore an untampered tarball + its checksum (case 3 corrupted it)
tar -czf "$rel/$tarball" -C "$stage" docuzen.app
( cd "$rel" && shasum -a 256 "$tarball" > SHA256SUMS.txt )
fresh_cli                                  # uninstall will delete the CLI copy
run update >/dev/null
home="$work/home"; mkdir -p "$home/.docuzen"; echo x > "$home/.docuzen/config.toml"
HOME="$home" run uninstall < /dev/null     # no tty -> default "no" on the ~/.docuzen prompt
[ -e "$appdir/docuzen.app" ] && { echo "FAIL: uninstall left the app"; exit 1; }
[ -f "$home/.docuzen/config.toml" ] || { echo "FAIL: uninstall removed ~/.docuzen without --purge"; exit 1; }
echo "ok: uninstall removes app, keeps ~/.docuzen"

# --- 5. --purge also removes ~/.docuzen ---
fresh_cli                                  # re-copy: case 4's uninstall deleted it
run update >/dev/null
HOME="$home" run uninstall --purge
[ -e "$home/.docuzen" ] && { echo "FAIL: --purge kept ~/.docuzen"; exit 1; }
echo "ok: uninstall --purge removes ~/.docuzen"

echo "ALL HERMETIC TESTS PASSED"
