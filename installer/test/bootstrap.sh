#!/usr/bin/env bash
# install.sh is macOS-only (real install runs on the user's Mac, covered by the
# manual E2E). On Linux CI we assert its OS guard rejects non-Darwin cleanly.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root
if [ "$(uname -s)" = "Darwin" ]; then
  echo "skip: bootstrap happy-path is covered by manual macOS E2E"; exit 0
fi
if sh "$here/install.sh" >/dev/null 2>&1; then
  echo "FAIL: install.sh should reject non-macOS"; exit 1
fi
echo "ok: install.sh rejects non-macOS"
