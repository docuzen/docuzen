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

# --- 6..10: an update never costs the user the app they already have ---
# A previous install (1.0.0) with a marker file: any case below that fails must leave it as is.
make_app() {   # <dir> <version>
  mkdir -p "$1/docuzen.app/Contents"
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict>' \
    "<key>CFBundleShortVersionString</key><string>$2</string>" '</dict></plist>' \
    > "$1/docuzen.app/Contents/Info.plist"
}
install_old() {
  rm -rf "$appdir/docuzen.app"; make_app "$appdir" 1.0.0
  echo keep > "$appdir/docuzen.app/Contents/marker"
}
old_intact() { [ -f "$appdir/docuzen.app/Contents/marker" ] && grep -q '<string>1.0.0</string>' "$appdir/docuzen.app/Contents/Info.plist"; }
no_leftovers() { [ "$(ls -A "$appdir")" = "docuzen.app" ]; }
publish() { ( cd "$rel" && shasum -a 256 "$tarball" > SHA256SUMS.txt ); }
publish_good() { tar -czf "$rel/$tarball" -C "$stage" docuzen.app; publish; }
fail() { echo "FAIL: $1"; ls -la "$appdir" || true; exit 1; }
fresh_cli

# 6. the download is not a tarball (but its checksum matches): extract fails, old app stays
install_old
echo "not a tarball" > "$rel/$tarball"; publish
if run update >/dev/null 2>&1; then fail "a broken tarball installed"; fi
old_intact || fail "a failed extract destroyed the installed app"
no_leftovers || fail "a failed extract left staging files behind"
echo "ok: failed extract keeps the installed app"

# 7. the tarball holds no app, or an app of another version: refused, old app stays
bad="$work/bad"; rm -rf "$bad"; mkdir -p "$bad/other"; echo x > "$bad/other/file"
tar -czf "$rel/$tarball" -C "$bad" other; publish
if run update >/dev/null 2>&1; then fail "a tarball without docuzen.app installed"; fi
old_intact || fail "a tarball without an app destroyed the installed app"
rm -rf "$bad"; make_app "$bad" 8.8.8
tar -czf "$rel/$tarball" -C "$bad" docuzen.app; publish
if run update >/dev/null 2>&1; then fail "an app whose version is not the release's installed"; fi
old_intact || fail "a mismatched app destroyed the installed app"
no_leftovers || fail "a refused app left staging files behind"
echo "ok: the staged app is verified before it replaces anything"

# 8. putting the new app in place fails: the previous one is moved back
fakebin="$work/fakebin"; rm -rf "$fakebin"; mkdir -p "$fakebin"
real_mv="$(command -v mv)"; real_tar="$(command -v tar)"
# The fake's own "$1" / "$@" are meant literally.
# shellcheck disable=SC2016
printf '%s\n' '#!/bin/sh' 'case "$1" in *.docuzen-update.*) echo "mv: simulated failure" >&2; exit 1 ;; esac' \
  "exec \"$real_mv\" \"\$@\"" > "$fakebin/mv"
chmod +x "$fakebin/mv"
publish_good
if PATH="$fakebin:$PATH" run update >/dev/null 2>&1; then fail "the swap was reported as a success"; fi
old_intact || fail "a failed swap lost the installed app"
no_leftovers || fail "a failed swap left the backup or staging behind"
echo "ok: a failed swap restores the installed app"

# 9. TERM mid-update: exits 143 at once, old app intact, nothing left behind
rm -f "$fakebin/mv" "$work/tar-started"
printf '%s\n' '#!/bin/sh' "touch \"$work/tar-started\"" 'sleep 2' "exec \"$real_tar\" \"\$@\"" > "$fakebin/tar"
chmod +x "$fakebin/tar"
PATH="$fakebin:$PATH" DOCUZEN_APP_DIR="$appdir" DOCUZEN_RELEASES_API="file://$rel/latest.json" "$cli" update >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 200); do [ -e "$work/tar-started" ] && break; sleep 0.05; done
[ -e "$work/tar-started" ] || fail "the update never reached the extract"
kill -TERM "$pid"
status=0; wait "$pid" || status=$?
[ "$status" -eq 143 ] || fail "TERM should exit 143, got $status"
old_intact || fail "an interrupted update destroyed the installed app"
no_leftovers || fail "an interrupted update left staging files behind"
rm -f "$fakebin/tar"
echo "ok: TERM stops the update and keeps the installed app"

# 10. and a good release replaces it cleanly
run update >/dev/null
grep -q '<string>9.9.9</string>' "$appdir/docuzen.app/Contents/Info.plist" || fail "the update did not install 9.9.9"
[ ! -e "$appdir/docuzen.app/Contents/marker" ] || fail "the old app's files survived the update"
no_leftovers || fail "a successful update left the backup or staging behind"
echo "ok: update replaces the installed app"

# --- 11. `open` launches the app in DOCUZEN_APP_DIR, not whichever one LaunchServices picks ---
printf '%s\n' '#!/bin/sh' "printf '%s\\n' \"\$@\" > \"$work/open-args\"" > "$fakebin/open"
chmod +x "$fakebin/open"
PATH="$fakebin:$PATH" run open "$work/notes.md"
[ "$(cat "$work/open-args")" = "-a
$appdir/docuzen.app
$work/notes.md" ] || fail "open ran with: $(cat "$work/open-args")"
echo "ok: open uses the app in DOCUZEN_APP_DIR"

echo "ALL HERMETIC TESTS PASSED"
