# Releasing

Releases are tag-driven from `main` on `github.com/docuzen/docuzen`:

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`.
2. Commit, then tag and push:

   ```bash
   git tag vX.Y.Z        # must equal the tauri.conf.json version
   git push && git push --tags
   ```

3. CI verifies the tag/version match, runs every suite, builds both macOS
   architectures (arm64 natively, x64 cross-compiled) with the
   checksum-verified sidecar runtime, smoke-tests each artifact, and
   publishes a GitHub Release with `.dmg`, `.app.tar.gz`, and
   `SHA256SUMS.txt`.

If a tag push does not start a run (a rare GitHub event race), trigger it
manually: Actions → release → Run workflow, selecting the tag as the ref.

Artifacts are unsigned until Apple credentials exist. On macOS 15+,
Gatekeeper reports unsigned downloads as "damaged" — clear the quarantine
flag after installing (`xattr -cr /Applications/docuzen.app`); on macOS 14
and earlier, right-click → Open suffices. To enable signing + notarization, add the
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` secrets to the repo — the
same workflow signs on the next tag, no changes required. Configure all six together — a partial set can leave notarization credentials as empty strings, which the pipeline treats as misconfiguration.

Sidecar runtime pins (Node version, ABI, SHA-256 checksums) live in
`packages/docd/sidecar.json`; bumping them requires updating the pinned
checksums from official sources.
