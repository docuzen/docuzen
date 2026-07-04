// Compares main vs candidate feature reports. Details must be deeply equal;
// step order and ok-ness must match. Screenshot files are artifacts for
// human review, not compared programmatically (font rendering jitters).
import { deepStrictEqual } from "node:assert";

export function compareReports(mainReports, candidateReports) {
  const failures = [];
  for (const scenario of Object.keys(mainReports)) {
    const a = mainReports[scenario];
    const b = candidateReports[scenario];
    if (!b) { failures.push(`${scenario}: missing on candidate`); continue; }

    // Symmetric-failure guard: "equal" isn't the same as "passing". Without
    // this, a main step that's broken and a candidate step that fails the
    // exact same way would compare as a match and get reported as OK.
    for (const s of a.steps) {
      if (!s.ok) failures.push(`${scenario}/${s.name}: main step failed: ${JSON.stringify(s.details)}`);
    }

    const names = a.steps.map((s) => s.name).join(",");
    const bNames = b.steps.map((s) => s.name).join(",");
    if (names !== bNames) { failures.push(`${scenario}: step lists differ (${names} vs ${bNames})`); continue; }
    for (let i = 0; i < a.steps.length; i++) {
      const sa = a.steps[i], sb = b.steps[i];
      if (sa.ok !== sb.ok) { failures.push(`${scenario}/${sa.name}: ok ${sa.ok} vs ${sb.ok}`); continue; }
      try { deepStrictEqual(sb.details, sa.details); }
      catch { failures.push(`${scenario}/${sa.name}: details differ: ${JSON.stringify(sa.details)} vs ${JSON.stringify(sb.details)}`); }
    }
  }
  return failures;
}
