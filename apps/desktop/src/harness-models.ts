import type { DocdApi } from "./session.js";
import { el } from "./ui.js";

type Choice = { key: string; name: string };
type Load = { path: string; until: number; result: Promise<Choice[]> };
const catalogues = new WeakMap<DocdApi, Map<string, Load>>();
const revisions = new WeakMap<HTMLSelectElement, number>();

function nativeCatalogue(api: DocdApi, harness: string, path: string) {
  let cache = catalogues.get(api);
  if (!cache) catalogues.set(api, cache = new Map());
  const existing = cache.get(harness);
  if (existing && existing.path === path && Date.now() < existing.until) return existing.result;
  const result = Promise.resolve().then(() => api.listHarnessModels({ harness, docPath: path }));
  const entry = { path, until: Date.now() + 30_000, result };
  cache.set(harness, entry);
  void result.catch(() => { if (cache.get(harness) === entry) cache.delete(harness); });
  return result;
}

export function supportsModelPicker(id: string) {
  return id === "pi" || id === "codex" || id === "claude-code";
}

export function modelDisplayId(key: string) {
  return key.replace(/^(?:codex|claude-code):/, "");
}

/** Settings, discussion and review use the same harness catalogue. Ignore late responses after a switch. */
export function fillHarnessModels(select: HTMLSelectElement, api: DocdApi, harness: string, path: string | undefined,
  selected: string, pi: readonly Choice[], updated?: () => void): void {
  const revision = (revisions.get(select) ?? 0) + 1;
  revisions.set(select, revision);
  const native = harness === "codex" || harness === "claude-code";
  const label = harness === "codex" ? "Codex default" : harness === "claude-code" ? "Claude Code default" : "Default";
  const legacyCodex = harness === "codex" && !/^(codex|claude-code):/.test(selected) && selected.includes("/");
  const saved = native && !selected.startsWith(harness + ":") && !legacyCodex ? "" : selected;
  function paint(rows: readonly Choice[], value: string, message?: string) {
    select.replaceChildren(el("option", { value: "", textContent: label }));
    for (const m of rows) select.append(el("option", { value: m.key, textContent: m.name }));
    if (native && value && !rows.some(m => m.key === value)) {
      select.append(el("option", { value, textContent: modelDisplayId(value) + (legacyCodex ? " (saved provider)" : " (saved)") }));
    }
    if (message) select.append(el("option", { disabled: true, textContent: message }));
    select.value = value;
    if (select.selectedIndex < 0) select.value = "";
    updated?.();
  }
  select.dataset.modelHarness = harness;
  select.disabled = !supportsModelPicker(harness);
  select.title = "Model";
  if (!native || !path) {
    paint(harness === "pi" ? pi : [], saved);
    return;
  }
  paint([], saved, "Loading models…");
  void nativeCatalogue(api, harness, path).then(rows => {
    if (revisions.get(select) !== revision) return;
    paint(rows, select.value, rows.length ? undefined : "No models reported by the harness");
  }).catch(error => {
    if (revisions.get(select) !== revision) return;
    select.title = String(error);
    paint([], select.value, "Could not load models");
  });
}
