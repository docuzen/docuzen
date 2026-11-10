// One version, five manifests. tauri.conf.json is what the release tag is checked against
// and what users see; the others drifted for nine releases because nothing compared them.
//
//   node tools/version.mjs check        # exit 1 if any manifest disagrees (runs in `npm test`)
//   node tools/version.mjs set 0.2.0    # write one version everywhere
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MANIFESTS = [
  "apps/desktop/src-tauri/tauri.conf.json", // source of truth: the release workflow compares the tag to this
  "apps/desktop/package.json",
  "packages/cli/package.json",
  "packages/docd/package.json",
];
const CARGO_TOML = "apps/desktop/src-tauri/Cargo.toml";
const CARGO_LOCK = "apps/desktop/src-tauri/Cargo.lock";
const CARGO_TOML_RE = /(\[package\]\nname = "docuzen"\nversion = ")([^"]+)(")/;
const CARGO_LOCK_RE = /(\[\[package\]\]\nname = "docuzen"\nversion = ")([^"]+)(")/;

const read = (rel) => readFileSync(resolve(root, rel), "utf8");

export function readVersions() {
  const out = {};
  for (const rel of JSON_MANIFESTS) out[rel] = JSON.parse(read(rel)).version;
  out[CARGO_TOML] = CARGO_TOML_RE.exec(read(CARGO_TOML))?.[2];
  out[CARGO_LOCK] = CARGO_LOCK_RE.exec(read(CARGO_LOCK))?.[2];
  return out;
}

function check() {
  const versions = readVersions();
  const expected = versions[JSON_MANIFESTS[0]];
  const bad = Object.entries(versions).filter(([, v]) => v !== expected);
  if (bad.length) {
    console.error(`version mismatch — ${JSON_MANIFESTS[0]} says ${expected}, but:`);
    for (const [rel, v] of bad) console.error(`  ${rel}: ${v ?? "(not found)"}`);
    console.error("fix with: node tools/version.mjs set <version>");
    process.exit(1);
  }
  console.log(`versions OK (${expected})`);
}

function set(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    console.error("usage: node tools/version.mjs set <major.minor.patch>");
    process.exit(2);
  }
  for (const rel of JSON_MANIFESTS) {
    // Textual replace of the first "version" key keeps each file's formatting intact.
    const text = read(rel);
    const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
    if (next === text && JSON.parse(text).version !== version) throw new Error(`no version field in ${rel}`);
    writeFileSync(resolve(root, rel), next);
  }
  for (const [rel, re] of [[CARGO_TOML, CARGO_TOML_RE], [CARGO_LOCK, CARGO_LOCK_RE]]) {
    const text = read(rel);
    if (!re.test(text)) throw new Error(`no docuzen package version in ${rel}`);
    writeFileSync(resolve(root, rel), text.replace(re, `$1${version}$3`));
  }
  console.log(`set version ${version} in ${JSON_MANIFESTS.length + 2} files`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "check") check();
else if (cmd === "set") set(arg);
else {
  console.error("usage: node tools/version.mjs check | set <version>");
  process.exit(2);
}
