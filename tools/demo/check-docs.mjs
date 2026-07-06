// Fails if committed docs still describe the pre-relocation `.had`-beside-the-doc
// storage model or the stale "repository is named ai-native-doc" framing.
// `@ai-native-doc/docd` (the npm package name) is explicitly allowed.
import { readFileSync } from "node:fs";

const FILES = ["README.md", "docs/install.md", "docs/architecture.md"];
// Patterns that indicate the OLD storage model or stale repo framing.
const BAD = [
  /sibling\s+`?\.[^`\s]*\.had/i,          // "sibling .plan.md.had/"
  /beside (each|the) document/i,
  /naming convention/i,
  /\.had\/settings\.json/i,
  /repository is named `?ai-native-doc/i,
];
// Allow the real package name to contain "ai-native-doc".
const allow = (line) => /@ai-native-doc\/docd/.test(line);

let bad = 0;
for (const f of FILES) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    if (allow(line)) return;
    for (const rx of BAD) {
      if (rx.test(line)) { console.error(`${f}:${i + 1}: stale — ${line.trim()}`); bad++; }
    }
  });
}
// Also require README to reference the demo GIF (Task 4 satisfies this).
const readme = readFileSync("README.md", "utf8");
if (!readme.includes("docs/media/demo.gif")) { console.error("README.md: missing docs/media/demo.gif reference"); bad++; }

if (bad) { console.error(`\n${bad} stale/missing reference(s).`); process.exit(1); }
console.log("docs check OK");
