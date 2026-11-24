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

import * as dialog from "@tauri-apps/plugin-dialog";
import { initShell, newDocPath, type ShellDeps } from "./shell.js";
import { stripFrontmatter } from "./shell-versions.js";

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
    listHarnessModels: vi.fn(async ({ harness }: { harness: string }) => harness === "claude-code"
      ? [{ key: "claude-code:haiku", name: "Haiku" }] : [{ key: "codex:gpt-test", name: "GPT Test" }]),
    saveModels: vi.fn(async ({ models: m }: { models: Record<string, unknown>[] }) => {
      models = m.map((x) => ({ ...x, hasKey: true, apiKey: undefined }));
      return { ok: true };
    }),
    listProposals: vi.fn(async () => []),
    listVersions: vi.fn(async () => opts.versions ?? []),
    readVersion: vi.fn(async ({ versionId }: { versionId: string }) => ({ content: `---\ntitle: x\n---\nbody of ${versionId}\n` })),
    saveDoc: vi.fn(async () => ({ saved: true, version: "v0009" })),
    restoreVersion: vi.fn(async () => ({ restored: true, version: "v0001" })),
    exportHadz: vi.fn(async (p: { outPath: string }) => ({ path: p.outPath })),
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

  it("loads and saves each native harness's models, ignoring a late answer from the previous harness", async () => {
    const { shell, api } = setup();
    api.listHarnesses.mockResolvedValue([PI, { ...CODEX, available: true }, { ...CODEX, id: "claude-code", label: "Claude Code", available: true }]);
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    const late = deferred<{ key: string; name: string }[]>();
    api.listHarnessModels.mockImplementationOnce(() => late.promise);
    change("#setHarness", "claude-code");
    await settle();
    change("#setHarness", "codex");
    await settle();
    late.resolve([{ key: "claude-code:haiku", name: "Haiku" }]);
    await settle();
    const options = () => all<HTMLOptionElement>("#setDefaultModel option").map(o => o.value);
    expect(options()).toEqual(["", "codex:gpt-test"]);
    change("#setDefaultModel", "codex:gpt-test");
    expect(api.setSettings.mock.calls.at(-1)?.[0].settings.model).toBe("codex:gpt-test");
    change("#setHarness", "claude-code");
    await settle();
    expect(options()).toEqual(["", "claude-code:haiku"]);
    expect($<HTMLSelectElement>("#setDefaultModel").disabled).toBe(false);
    change("#setDefaultModel", "claude-code:haiku");
    expect(api.setSettings.mock.calls.at(-1)?.[0].settings.model).toBe("claude-code:haiku");
    $("#settingsClose").click();
    menu.fire("settings");
    await settle();
    expect($<HTMLSelectElement>("#setDefaultModel").value).toBe("claude-code:haiku");
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

describe("document harness in the status bar", () => {
  it("follows the active tab, ignores stale replies, and opens its settings with providers collapsed", async () => {
    const { shell, api } = setup();
    await shell.openInTab("/d/a.md");
    const late = deferred<Record<string, unknown>>();
    api.getSettings.mockImplementationOnce(() => late.promise);
    const oldRead = shell.refreshHarnessBadge();
    api.getSettings.mockResolvedValue({ scope: "folder", harness: "codex" });
    await shell.openInTab("/d/b.md");
    late.resolve({ scope: "folder", harness: "pi" });
    await oldRead;
    expect($("#harnessBadge").textContent).toBe("Document harness: Codex (unavailable)");
    $("#harnessBadge").click();
    await settle();
    expect($("#settingsModal").hidden).toBe(false);
    expect($<HTMLSelectElement>("#setHarness").value).toBe("codex");
    expect($<HTMLDetailsElement>("#modelProviders").open).toBe(false);
    shell.showEmptyState();
    expect($<HTMLButtonElement>("#harnessBadge").disabled).toBe(true);
  });

  it("names the harness and model a turn on this document would use", async () => {
    const { shell } = setup({ settings: { model: "litellm/opus" } });
    await shell.openInTab("/d/a.md");
    await shell.refreshHarnessBadge();
    expect($("#harnessBadge").textContent).toContain("Pi");
    expect($("#harnessBadge").textContent).toContain("Opus");
  });
});

describe("New document and Insert image", () => {
  it("File > New Document creates the file where the user chose and opens it in a tab", async () => {
    const { shell, api, deps } = setup();
    const createDoc = vi.fn(async (p: { docPath: string }) => ({ docPath: p.docPath }));
    (deps.api as Record<string, unknown>).createDoc = createDoc;
    vi.mocked(dialog.save).mockResolvedValueOnce("/d/Untitled.md");
    menu.fire("new");
    await settle();
    expect(vi.mocked(dialog.save).mock.calls.at(-1)![0]).toMatchObject({ defaultPath: "Untitled.md" });
    expect(createDoc).toHaveBeenCalledWith({ docPath: "/d/Untitled.md" });
    expect(shell.getDocPath()).toBe("/d/Untitled.md");
    expect(api.openDoc).toHaveBeenCalledWith({ docPath: "/d/Untitled.md" });
    expect(all(".tab").some((t) => t.textContent?.includes("Untitled.md"))).toBe(true);
  });

  it("defaults to markdown when the chosen name has no extension, keeps .html, and does nothing on cancel", async () => {
    expect(newDocPath("/d/notes")).toBe("/d/notes.md");
    expect(newDocPath("/d/report.html")).toBe("/d/report.html");
    expect(newDocPath("/d/v1.2 draft")).toBe("/d/v1.2 draft.md");
    const { shell, deps } = setup();
    const createDoc = vi.fn(async (p: { docPath: string }) => ({ docPath: p.docPath }));
    (deps.api as Record<string, unknown>).createDoc = createDoc;
    vi.mocked(dialog.save).mockResolvedValueOnce(null);
    menu.fire("new");
    await settle();
    expect(createDoc).not.toHaveBeenCalled();
    expect(shell.getTabCount()).toBe(0);
  });

  it("File > Insert Image hands the picked files to the image store, and needs an open document", async () => {
    const { shell, deps, log } = setup();
    menu.fire("insert-image");
    await settle();
    expect(log.join("\n")).toContain("insert image: no doc open");
    await shell.openInTab("/d/a.md");
    // A document in review mode: no file picker is opened at all.
    (deps as Record<string, unknown>).canInsertImage = () => false;
    const opens = vi.mocked(dialog.open).mock.calls.length;
    menu.fire("insert-image");
    await settle();
    expect(vi.mocked(dialog.open).mock.calls.length).toBe(opens);
    (deps as Record<string, unknown>).canInsertImage = () => true;
    vi.mocked(dialog.open).mockResolvedValueOnce(["/p/one.png", "/p/two.jpg"]);
    menu.fire("insert-image");
    await settle();
    expect(deps.addImagePaths).toHaveBeenCalledWith(["/p/one.png", "/p/two.jpg"]);
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
    shell.onEditorMarkdownUpdated("# edited in the editor\n", "# doc on disk\n"); // the editor reports an edit
    menu.fire("save");
    await settle();

    expect($("#versionPickerModal").hidden).toBe(false);
    expect($("#versionPickerConfirm").textContent).toBe("Save selected");
    expect(all<HTMLInputElement>('#versionPickerList input[name="vpick"]').map((i) => i.value)).toEqual(["current", "v0002", "v0001"]);

    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    expect(api.saveDoc).toHaveBeenCalledWith({ docPath: "/d/a.md", text: "# edited in the editor\n" });
    expect(api.restoreVersion).not.toHaveBeenCalled();
    expect($("#versionPickerModal").hidden).toBe(true);
    expect(log.join("\n")).toContain("saved");
  });

  it("choosing an older version restores it and reloads the document from disk", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    menu.fire("save");
    await settle();
    shell.onEditorMarkdownUpdated("# unsaved edits\n", "# doc on disk\n");
    const opensBefore = api.openDoc.mock.calls.length;
    all<HTMLInputElement>('#versionPickerList input[name="vpick"]').find((i) => i.value === "v0001")!.checked = true;
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();

    expect(api.restoreVersion).toHaveBeenCalledWith({ docPath: "/d/a.md", versionId: "v0001" });
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

/** A promise the test settles by hand, to hold an RPC in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Settings belong to the document they were opened for", () => {
  it("a failed settings load does not show the form (it would hold the previous document's values)", async () => {
    const { shell, api } = setup({ settings: { instructions: "rules for A" } });
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    $<HTMLButtonElement>("#settingsClose").click();
    await shell.openInTab("/d/b.md");
    api.getSettings.mockRejectedValueOnce(new Error("sidecar busy"));
    menu.fire("settings");
    await settle();
    expect($("#settingsModal").hidden).toBe(true);
    change("#setScope", "repo");
    await settle();
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("reads and saves the settings of its own document, by path", async () => {
    const { shell, api } = setup();
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    expect(api.getSettings).toHaveBeenLastCalledWith({ docPath: "/d/a.md" });
    change("#setScope", "repo");
    await settle();
    expect(api.setSettings.mock.calls[0][0]).toMatchObject({ docPath: "/d/a.md", settings: { scope: "repo" } });
  });

  it("switching tabs closes Settings; a later change cannot save the first document's values onto the second", async () => {
    const { shell, api } = setup();
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    expect($("#settingsModal").hidden).toBe(false);
    await shell.openInTab("/d/b.md");
    expect($("#settingsModal").hidden).toBe(true);
    change("#setAgentEdit", "direct");
    await settle();
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("a switch while Settings is still loading does not open it over the new document", async () => {
    const { shell, api } = setup();
    await shell.openInTab("/d/a.md");
    const slow = deferred<Record<string, unknown>>();
    api.getSettings.mockImplementationOnce(() => slow.promise);
    menu.fire("settings");
    await settle();
    await shell.openInTab("/d/b.md");
    slow.resolve({ scope: "repo" });
    await settle();
    expect($("#settingsModal").hidden).toBe(true);
  });

  it("instructions typed before a keyboard tab switch are saved to the document they were typed for", async () => {
    const { shell, api } = setup();
    await shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    const box = $<HTMLTextAreaElement>("#setInstructions");
    box.focus();
    box.value = "cite sources";
    await shell.openInTab("/d/b.md"); // ⌘O: no blur happens first
    await settle();
    expect(api.setSettings).toHaveBeenCalledTimes(1);
    expect(api.setSettings.mock.calls[0][0]).toMatchObject({ docPath: "/d/a.md", settings: { instructions: "cite sources" } });
  });
});

describe("model manager: editing a model's key", () => {
  async function openManager() {
    const ctx = setup();
    await ctx.shell.openInTab("/d/a.md");
    menu.fire("settings");
    await settle();
    return ctx;
  }
  const fill = (id: string, v: string) => void ($<HTMLInputElement>(id).value = v);

  it("changing a model's id or provider replaces its row instead of adding a second one", async () => {
    const { api } = await openManager();
    all<HTMLButtonElement>("#modelList .modelrow button")[0].click(); // Edit "litellm/opus"
    fill("#mfModelId", "opus-4");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();
    expect(api.saveModels.mock.calls[0][0].models.map((m) => m.key)).toEqual(["litellm/opus-4"]);
    expect(all("#modelList .modelrow")).toHaveLength(1);

    all<HTMLButtonElement>("#modelList .modelrow button")[0].click();
    fill("#mfProvider", "openrouter");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();
    expect(api.saveModels.mock.calls[1][0].models.map((m) => m.key)).toEqual(["openrouter/opus-4"]);
  });

  it("renaming a model onto another model's key is refused rather than silently dropping that model", async () => {
    const { api, log } = await openManager();
    $<HTMLButtonElement>("#modelAddBtn").click();
    fill("#mfName", "Haiku");
    fill("#mfProvider", "litellm");
    fill("#mfModelId", "haiku");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();
    all<HTMLButtonElement>("#modelList .modelrow button")[2].click(); // Edit Haiku
    fill("#mfModelId", "opus");
    $<HTMLButtonElement>("#mfSave").click();
    await settle();
    expect(api.saveModels).toHaveBeenCalledTimes(1);
    expect(log.join("\n")).toContain("litellm/opus already exists");
    expect($("#modelForm").hidden).toBe(false);
  });
});

describe("Save, Export and the version modals stay with their document", () => {
  const versions = [{ id: "v0001", timestamp: "2026-01-01T00:00:00Z", cause: "manual-save" }];

  it("switching tabs while the Save picker is open cancels the save", async () => {
    const { shell, api, log } = setup({ versions });
    await shell.openInTab("/d/a.md");
    await shell.openInTab("/d/b.md");
    await shell.activateTab(0);
    menu.fire("save");
    await settle();
    expect($("#versionPickerModal").hidden).toBe(false);
    await shell.activateTab(1);
    await settle();
    expect($("#versionPickerModal").hidden).toBe(true);
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    expect(api.saveDoc).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain("save canceled");
  });

  it("closing the last tab while the Export picker is open cancels the export instead of failing", async () => {
    const { shell, api, log } = setup({ versions });
    await shell.openInTab("/d/a.md");
    const errors: unknown[] = [];
    const onError = (e: PromiseRejectionEvent) => errors.push(e.reason);
    window.addEventListener("unhandledrejection", onError);
    menu.fire("export");
    await settle();
    await shell.closeTab(0);
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    window.removeEventListener("unhandledrejection", onError);
    expect(errors).toEqual([]);
    expect(api.exportHadz).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain("export canceled");
  });

  it("the picker lists the versions of the document it was opened for", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    menu.fire("save");
    await settle();
    expect(api.listVersions).toHaveBeenLastCalledWith({ docPath: "/d/a.md" });
  });

  it("a picker whose versions arrive after a switch never opens over the other document", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    const slow = deferred<unknown[]>();
    api.listVersions.mockImplementationOnce(() => slow.promise);
    menu.fire("save");
    await settle();
    await shell.openInTab("/d/b.md");
    slow.resolve(versions);
    await settle();
    expect($("#versionPickerModal").hidden).toBe(true);
  });

  it("Edit from here cannot put one document's version into another", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    await shell.openInTab("/d/b.md");
    await shell.activateTab(0);
    await shell.openVersionPreview("v0001");
    expect(shell.versionModal.hidden).toBe(false);
    expect(api.readVersion).toHaveBeenLastCalledWith({ docPath: "/d/a.md", versionId: "v0001" });
    await shell.activateTab(1);
    expect(shell.versionModal.hidden).toBe(true); // the preview closes with its document
    $<HTMLButtonElement>("#versionEditBtn").click(); // even a stale click
    await settle();
    expect(shell.getDocPath()).toBe("/d/b.md");
    expect(shell.getCurrentMarkdown()).toBe("# doc on disk\n");
  });

  it("a slow preview that finishes after a newer one does not replace it", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    const slow = deferred<{ content: string }>();
    api.readVersion.mockImplementationOnce(() => slow.promise);
    const first = shell.openVersionPreview("v0001");
    await shell.openVersionPreview("v0002");
    slow.resolve({ content: "body of v0001\n" });
    await first;
    expect($("#versionModalBody").textContent).toBe("body of v0002\n");
  });

  it("opening the picker again (⌘S twice, or ⌘S then ⇧⌘E) cancels the first request instead of leaving it hanging", async () => {
    const { shell, api, log } = setup({ versions });
    await shell.openInTab("/d/a.md");
    vi.mocked(dialog.save).mockResolvedValueOnce("/out/a.hadz");
    menu.fire("save");
    await settle();
    menu.fire("export");
    await settle();
    expect(log.join("\n")).toContain("save canceled");
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    expect(api.exportHadz).toHaveBeenCalledTimes(1);
    expect(api.saveDoc).toHaveBeenCalledTimes(1); // the export's own save of the working copy, not the cancelled Save
  });
});

describe("Export", () => {
  const versions = [{ id: "v0001", timestamp: "2026-01-01T00:00:00Z", cause: "manual-save" }];

  it("exporting the current working copy saves the editor's text first, so the bundle holds it", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    shell.onEditorMarkdownUpdated("# unsaved edits\n", "# doc on disk\n");
    vi.mocked(dialog.save).mockResolvedValueOnce("/out/a.hadz");
    menu.fire("export");
    await settle();
    expect($("#versionPickerList .vpick-current").textContent).toContain("saved, then exported");
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    expect(api.saveDoc).toHaveBeenCalledWith({ docPath: "/d/a.md", text: "# unsaved edits\n" });
    expect(api.exportHadz).toHaveBeenCalledWith({ docPath: "/d/a.md", outPath: "/out/a.hadz" });
    expect(api.saveDoc.mock.invocationCallOrder[0]).toBeLessThan(api.exportHadz.mock.invocationCallOrder[0]);
  });

  it("exporting a saved version leaves the document on disk alone", async () => {
    const { shell, api } = setup({ versions });
    await shell.openInTab("/d/a.md");
    vi.mocked(dialog.save).mockResolvedValueOnce("/out/a.hadz");
    menu.fire("export");
    await settle();
    all<HTMLInputElement>('#versionPickerList input[name="vpick"]').find((i) => i.value === "v0001")!.checked = true;
    $<HTMLButtonElement>("#versionPickerConfirm").click();
    await settle();
    expect(api.saveDoc).not.toHaveBeenCalled();
    expect(api.exportHadz).toHaveBeenCalledWith({ docPath: "/d/a.md", outPath: "/out/a.hadz", versionId: "v0001" });
  });
});

describe("version frontmatter", () => {
  it("strips a leading YAML mapping between --- lines, LF or CRLF", () => {
    expect(stripFrontmatter("---\nhad:\n  version: 1\ntags:\n- a\n---\n# Body\n")).toBe("# Body\n");
    expect(stripFrontmatter("---\r\ntitle: x\r\n# a comment\r\n\r\nauthor: \"me\"\r\n---\r\nBody\r\n")).toBe("Body\r\n");
    expect(stripFrontmatter("---\ntitle: only\n---")).toBe("");
  });

  it("keeps a document that starts with a horizontal rule", () => {
    const hr = "---\n\nIntro paragraph.\n\n---\n\nMore text.\n";
    expect(stripFrontmatter(hr)).toBe(hr);
    expect(stripFrontmatter("---\n- a list\n---\nx")).toBe("---\n- a list\n---\nx"); // a sequence, not a mapping
    expect(stripFrontmatter("---\ntitle: x\nno closing line\n")).toBe("---\ntitle: x\nno closing line\n");
    expect(stripFrontmatter("---\n---\nx")).toBe("---\n---\nx"); // empty: not a mapping
    expect(stripFrontmatter("# Title\n---\na: b\n---\n")).toBe("# Title\n---\na: b\n---\n");
  });

  it("the preview of a version that starts with a horizontal rule shows all of it", async () => {
    const { shell, api } = setup();
    await shell.openInTab("/d/a.md");
    api.readVersion.mockResolvedValueOnce({ content: "---\n\nIntro.\n\n---\n\nRest.\n" });
    await shell.openVersionPreview("v0003");
    expect($("#versionModalBody").textContent).toBe("---\n\nIntro.\n\n---\n\nRest.\n");
  });
});
