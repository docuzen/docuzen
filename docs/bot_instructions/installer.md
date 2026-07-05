# Maintaining the installer

Guidance for anyone (human or agent) changing the install code. Technical only.

## Architecture
- `installer/docuzen` is the single source of ALL install logic. `install.sh`
  is a thin bootstrap: pick a bin dir, fetch `installer/docuzen`, hand off to
  `docuzen update`. Never duplicate download/verify/install logic into
  `install.sh`.

## Invariants (do not break)
- **Verify before install.** The app is extracted into `/Applications` only
  after the tarball's `shasum -a 256` matches its line in `SHA256SUMS.txt`.
  Never move the extract step before the checksum check.
- **No `jq`** (absent on stock macOS) and **no `sudo`**. Parse the GitHub API
  JSON with `grep`/`sed`. Bin dir is `/usr/local/bin` if writable else
  `~/.local/bin`.
- **Public URL contract.** Users paste
  `raw.githubusercontent.com/docuzen/docuzen/main/install.sh`. Do not move or
  rename `install.sh`, and keep `installer/docuzen` fetchable at its raw path.

## Release-pipeline contract
The installer depends on the exact asset names
`docuzen-<version>-<arch>.app.tar.gz` and `SHA256SUMS.txt`, with
`arch ∈ {arm64, x64}`. If `.github/workflows/release.yml` changes asset naming
or architectures, change the installer in the same commit and re-run the tests.

## Test overrides
`installer/test/hermetic.sh` drives the CLI against local `file://` fixtures
using these env overrides — keep them working:
- `DOCUZEN_RELEASES_API` — the releases-API URL (fixture JSON with `file://`
  asset URLs).
- `DOCUZEN_APP_DIR` — install dir (default `/Applications`); the test points it
  at a temp dir so it never touches the real one.
- `DOCUZEN_CONFIG_DIR` — the `~/.docuzen` data dir (uninstall prompt/purge).
- `DOCUZEN_RAW_BASE` — where `install.sh` fetches the CLI from.

## How to verify a change
`shellcheck install.sh installer/docuzen installer/test/*.sh` and
`bash installer/test/hermetic.sh` (both run in CI). For user-visible changes,
also do the manual macOS E2E: pipe-install → `docuzen` launches → `docuzen
update` says up-to-date → `docuzen uninstall`.

## Gatekeeper / xattr
`docuzen update` runs `xattr -cr` on the installed app to clear the macOS 15+
quarantine that makes unsigned downloads report "damaged". When
signing/notarization lands this becomes unnecessary but harmless — remove it
only after confirming notarized artifacts install cleanly without it.
