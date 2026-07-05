# Review-state storage

Guidance for anyone (human or agent) changing where/how docuzen persists
review state. Technical only.

## Location
- Review state lives in `<repo-root>/.docuzen/<relpath>.had/` when the document
  is inside a git repo, else `<doc-dir>/.docuzen/<basename>.had/`. Computed by
  `resolveHadDir` (packages/docd/src/had/resolve.ts); every `hadPaths` caller
  goes through it. Do not reintroduce per-file sibling `.had` dirs.

## Invariants (do not break)
- **Never inject metadata into the user's document.** docuzen must not write a
  `had:` pointer (or any unsolicited content) into a document on open. The
  editing surface (save, approve a proposal, Improve, direct-edit, resolve
  directives) writes the document only in response to an explicit user action —
  that is expected and separate from this rule.
- **Never touch a repo's `.git/`.** `.docuzen/` is hidden via the user's GLOBAL
  git excludes file (`core.excludesFile`, default `~/.config/git/ignore`) — see
  `ensureDocuzenHidden` (packages/docd/src/had/hide.ts). Do not write to
  `.git/info/exclude` and do not add a committed `.gitignore` for `.docuzen/`.

## Versioning: NO `.git` inside `.docuzen/`
Review-state versioning history is NEVER stored in a directory named `.git`
inside `.docuzen/`. A `.git` directory IS a git repository; nesting one inside
the user's repo creates embedded-submodule fragility and can entangle the user's
outer repo. When git-backed versioning is added (a separate future design), the
git database MUST live in a directory NOT named `.git` (e.g. `.docuzen/.gitstore/`)
and be addressed only via an explicit `--git-dir` / isomorphic-git separate
git-dir, so no tool sees a nested-repo boundary and the user's outer `.git` is
never touched. The current `versions/` snapshot store remains the versioning
mechanism until then.
