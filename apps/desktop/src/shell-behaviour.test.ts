// @vitest-environment happy-dom
//
// Behavioural tests for the app shell beyond tabs (see tabs-lifecycle.test.ts): the
// Settings modal + model manager, the topbar harness badge, and the Save / version-picker
// / version-preview flows. Driven through index.html's real markup, the native-menu event
// the Rust shell emits, and a scripted sidecar.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const menu = vi.hoisted(() => ({ fire: (_action: string) => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: string }) => void) => {
    if (event === "menu-action") menu.fire = (action) => cb({ payload: action });
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: vi.fn(async () => {}) }) }));

import { initShell, type ShellDeps } from "./shell.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

const PI = {
  id: "pi", label: "Pi", available: true,
  capabilities: { proposeEdits: true, directEdit: true, reviewFindings: true, webSearch: "docuzen-managed", documentTools: "docuzen-managed", thinking: true, cancel: true, multiModelPanel: true },
};
const CODEX = {
  id: "codex", label: "Codex", available: false, unavailableReason: "codex not found on PATH",
  capabilities: { proposeEdits: true, directEdit: false, reviewFindings: false, webSearch: "harness-managed", documentTools: "none", thinking: false, cancel: true, multiModelPanel: false },
};
const MODEL = { key: "litellm/opus", name: "Opus", provider: "litellm", modelId: "opus", baseUrl: "http://x/v1", hasKey: true };

function setup(opts: { settings?: Record<string, unknown>; versions?: unknown[] } = {}) {
  let settings: Record<string, unknown> = { scope: "folder", harness: "pi", agentEdit: "propose", webSearch: { enabled: true, provider: "ddg" }, ...opts.settings };
  let models: Record<string, unknown>[] = [MODEL];
  const api = {
    openDoc: vi.fn(async () => ({ text: "# doc on disk\n", format: "markdown", annotations: [] })),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async ({ settings: s }: { settings: Record<string, unknown> }) => {
      settings = s;
      return { ok: true };
    }),
    listHarnesses: vi.fn(async () => [PI, CODEX]),
    listModels: vi.fn(async () => models),
    saveModels: vi.fn(async ({ models: m }: { models: Record<string, unknown>[] }) => {
      models = m.map((x) => ({ ...x, hasKey: true, apiKey: undefined }));
      return { ok: true };
    }),
    listProposals: vi.fn(async () => []),
    listVersions: vi.fn(async () => opts.versions ?? []),
    readVersion: vi.fn(async ({ versionId }: { versionId: string }) => ({ content: `---\ntitle: x\n---\nbody of ${versionId}\n` })),
    saveDoc: vi.fn(async () => ({ saved: true, version: "v0009" })),
    restoreVersion: vi.fn(async () => ({ restored: true, version: "v0001" })),
  };
  const log: string[] = [];
  const editorActions: unknown[] = [];
  const explicit: Record<string, unknown> = {
    api: new Proxy(api as Record<string, unknown>, { get: (t, p: string) => t[p] ?? vi.fn(async () => undefined) }),
    log: (l: string) => void log.push(l),
    getEditor: () => ({ action: (a: unknown) => void editorActions.push(a) }),
    getHtmlSurface: () => null,
    rootEl: document.querySelector("#editor"),
    searchIsOpen: () => false,
    searchState: { query: "" },
    getThreadNodes: () => [],
    refreshThreadTree: vi.fn(async () => {}),
    refreshThreadModels: vi.fn(async () => {}),
    setDefaultModelKey: vi.fn(),
    modelName: (k: string) => (k === "litellm/opus" ? "Opus" : k),
    truncTitle: (s: string) => s,
    stripFrontmatter: (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, ""),
  };
  const deps = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = vi.fn())),
  }) as unknown as ShellDeps;
  const shell = initShell(deps);
  shell.wireMenu();
  return { shell, api, log, deps: explicit };
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const all = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
function change(sel: string, value: string) {
  const elx = $<HTMLSelectElement>(sel);
  elx.value = value;
  elx.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal("confirm", () => true);
});

describe("Settings modal", () => {
  it("refuses to open with no document, since settings are per document", async () => {
    const { log } = setup();
    menu.fire("settings");
    await settle();
    expect($("#settingsModal").hidden).toBe(true);
    expect(log.join("\n")).toContain("open a document first");
  });

  it("opens with the document's saved settings and the harness capabilities", async () => {
    const { shell } = setup({ settings: { scope: "repo", agentEdit: "direct", model: "litellm/opus", instructions: "British spelling" } });
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();

    expect($("#settingsModal").hidden).toBe(false);
    expect($<HTMLSelectElement>("#setScope").value).toBe("repo");
    expect($<HTMLSelectElement>("#setAgentEdit").value).toBe("direct");
    expect($<HTMLSelectElement>("#setDefaultModel").value).toBe("litellm/opus");
    expect($<HTMLTextAreaElement>("#setInstructions").value).toBe("British spelling");
    expect(all<HTMLOptionElement>("#setHarness option").map((o) => o.value)).toEqual(["pi", "codex"]);
    expect(all("#modelList .modelrow .mname").map((n) => n.textContent)).toEqual(["Opus"]);
    expect($("#harnessCaps").textContent).toContain("Web: Docuzen");
  });

  it("switching to Editing mode saves it with the rest of the document's settings", async () => {
    const { shell, api } = setup({ settings: { instructions: "keep it short" } });
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();

    change("#setAgentEdit", "direct");
    await settle();

    expect(api.setSettings).toHaveBeenCalledTimes(1);
    expect(api.setSettings.mock.calls[0][0].settings).toMatchObject({
      scope: "folder",
      harness: "pi",
      agentEdit: "direct",
      instructions: "keep it short",
      webSearch: { enabled: true, provider: "ddg" },
    });
  });

  it("choosing a default model updates the thread pickers' default and the topbar badge", async () => {
    const { shell, deps } = setup();
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    change("#setDefaultModel", "litellm/opus");
    await settle();
    expect(deps.setDefaultModelKey).toHaveBeenLastCalledWith("litellm/opus");
    expect($("#harnessBadge").textContent).toContain("Opus");
  });

  it("picking a harness that manages web search itself disables Docuzen's web-search controls", async () => {
    const { shell } = setup();
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    expect($<HTMLInputElement>("#setWebSearch").disabled).toBe(false);
    change("#setHarness", "codex");
    await settle();
    expect($<HTMLInputElement>("#setWebSearch").disabled).toBe(true);
    expect($("#setWebSearchHint").textContent).toContain("manages web search itself");
    expect($("#harnessCaps").textContent).toContain("codex not found on PATH");
  });
});

describe("model manager", () => {
  async function openManager() {
    const ctx = setup();
    await ctx.shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    return ctx;
  }
  const fill = (id: string, v: string) => void ($<HTMLInputElement>(id).value = v);

  it("adds a model without ever re-sending the other models' stored keys", async () => {
    const { api, deps } = await openManager();
    $<HTMLButtonElement>("#modelAddBtn").click();
    expect($("#modelForm").hidden).toBe(false);
    fill("#mfName", "Haiku");
    fill("#mfProvider", "litellm");
    fill("#mfModelId", "haiku");
    fill("#mfApiKey", "sk-new");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();

    const sent = api.saveModels.mock.calls[0][0].models;
    expect(sent.map((m) => m.key)).toEqual(["litellm/opus", "litellm/haiku"]);
    expect(sent[0]).not.toHaveProperty("apiKey"); // existing key is kept server-side, not echoed
    expect(sent[1]).toMatchObject({ name: "Haiku", apiKey: "sk-new" });
    expect($("#modelForm").hidden).toBe(true);
    expect(all("#modelList .modelrow .mname").map((n) => n.textContent)).toEqual(["Opus", "Haiku"]);
    expect(deps.refreshThreadModels).toHaveBeenCalled(); // the chat/card pickers pick it up
  });

  it("editing a model with the key field left blank keeps its stored key", async () => {
    const { api } = await openManager();
    all<HTMLButtonElement>("#modelList .modelrow button")[0].click(); // Edit
    expect($<HTMLInputElement>("#mfName").value).toBe("Opus");
    expect($<HTMLInputElement>("#mfApiKey").value).toBe(""); // never shown
    fill("#mfName", "Opus (renamed)");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();
    const sent = api.saveModels.mock.calls[0][0].models;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ key: "litellm/opus", name: "Opus (renamed)" });
    expect(sent[0]).not.toHaveProperty("apiKey");
  });

  it("requires name, provider and model id", async () => {
    const { api, log } = await openManager();
    $<HTMLButtonElement>("#modelAddBtn").click();
    fill("#mfName", "Nameless provider");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();
    expect(api.saveModels).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain("name, provider and model id are required");
  });

  it("removes a model after confirmation", async () => {
    const { api } = await openManager();
    all<HTMLButtonElement>("#modelList .modelrow button")[1].click(); // Remove
    await settle();
    expect(api.saveModels.mock.calls[0][0].models).toEqual([]);
    expect(all("#modelList .modelrow")).toHaveLength(0);
  });
});

describe("topbar harness badge", () => {
  it("names the harness and model a turn on this document would use", async () => {
    const { shell } = setup({ settings: { model: "litellm/opus" } });
    await shell.openInTab("/d/a.md");
    await shell.refreshHarnessBadge();
    expect($("#harnessBadge").textContent).toContain("Pi");
    expect($("#harnessBadge").textContent).toContain("Opus");
  });
});

describe("Save and versions", () => {
  const versions = [
    { id: "v0001", timestamp: "2026-01-01T00:00:00Z", cause: "manual-save" },
    { id: "v0002", timestamp: "2026-01-02T00:00:00Z", cause: "agent-edit", thread: "c0001" },
  ];

  it("Save asks which version to keep; choosing the working copy saves the editor's text", async () => {
    const { shell, api, log } = setup({ versions });
    await shell.openInTab("/d/a.md");
    shell.setActiveTabMarkdown("# edited in the editor\n");
    menu.fire("save");
    await settle();

    expect($("#versionPickerModal").hidden).toBe(false);
    expect($("#versionPickerConfirm").textContent).toBe("Save selected");
    expect(all<HTMLInputElement>('#versionPickerList input[name="vpick"]').map((i) => i.value)).toEqual(["current", "v0002", "v0001"]);

    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    expect(api.saveDoc).toHaveBeenCalledWith({ text: "# edited in the editor\n" });
    expect(api.restoreVersion).not.toHaveBeenCalled();
    expect($("#versionPickerModal").hidden).toBe(true);
    expect(log.join("\n")).toContain("saved");
  });

  it("choosing an older version restores it and reloads the document from disk", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    menu.fire("save");
    await settle();
    shell.setActiveTabMarkdown("# unsaved edits\n");
    const opensBefore = api.openDoc.mock.calls.length;
    all<HTMLInputElement>('#versionPickerList input[name="vpick"]').find((i) => i.value === "v0001")!.checked = true;
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();

    expect(api.restoreVersion).toHaveBeenCalledWith({ versionId: "v0001" });
    expect(api.saveDoc).not.toHaveBeenCalled();
    expect(api.openDoc.mock.calls.length).toBeGreaterThan(opensBefore); // re-read from disk
    expect(shell.getCurrentMarkdown()).toBe("# doc on disk\n");
  });

  it("Cancel leaves everything untouched", async () => {
    const { shell, api, log } = setup({ versions });
    await shell.openInTab("/d/a.md");
    menu.fire("save");
    await settle();
    $<HTMLButtonElement>("#versionPickerCancel").click();
    await settle();
    expect(api.saveDoc).not.toHaveBeenCalled();
    expect(api.restoreVersion).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain("save canceled");
  });

  it("previewing a version shows its body without frontmatter; Edit from here loads it as the working copy", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    await shell.openVersionPreview("v0002");

    expect(shell.versionModal.hidden).toBe(false);
    expect($("#versionModalBody").textContent).toBe("body of v0002\n");
    $<HTMLButtonElement>("#versionEditBtn").click();
    await settle();
    expect(shell.versionModal.hidden).toBe(true);
    expect(shell.getCurrentMarkdown()).toBe("body of v0002\n");
    expect(api.saveDoc).not.toHaveBeenCalled(); // working copy only — disk changes on Save
  });
});
