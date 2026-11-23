// @vitest-environment happy-dom
//
// What text each tab holds, driven against the real surfaces: the real HtmlSurface iframe (with
// browser-like asynchronous navigation, see iframe-navigation.test-support.ts) and a real
// Milkdown editor with its 200 ms debounced markdown listener and its undo history. The fakes in
// tabs-lifecycle.test.ts cannot show these bugs: they swap content synchronously and have no
// history. Also the boot order of session restore versus files opened from Finder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const events = vi.hoisted(() => ({ handlers: new Map<string, (e: { payload: string }) => void>() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: string }) => void) => {
    events.handlers.set(event, cb);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: vi.fn(async () => {}) }) }));

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { history, undoCommand } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { PluginKey } from "@milkdown/kit/prose/state";
import { callCommand, getMarkdown } from "@milkdown/kit/utils";
import { initShell, type ShellApi, type ShellDeps } from "./shell.js";
import { HtmlSurface } from "./html-surface.js";
import { deferIframeNavigation, type DeferredNavigation } from "./iframe-navigation.test-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

const A = "<!doctype html><html><head><title>A</title></head><body><p>alpha</p></body></html>";
const B = "<!doctype html><html><head><title>B</title></head><body><p>beta</p></body></html>";
const SESSION_KEY = "docuzen:tabs:v1";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fire = (event: string, payload = "") => events.handlers.get(event)?.({ payload });
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const tabNames = () => [...document.querySelectorAll("#tabs .tab .tname")].map((n) => n.textContent);

function saveSession(paths: string[], activeIdx = 0): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: paths.map((docPath) => ({ docPath })), activeIdx }));
}

async function makeEditor(root: HTMLElement, onUpdated: (md: string, prev: string) => void): Promise<Editor> {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, "");
      ctx.get(listenerCtx).markdownUpdated((_c, md, prev) => onUpdated(md, prev));
    })
    .use(commonmark)
    .use(history)
    .use(listener)
    .create();
}

/** Type at the end of the document's last block, as a keystroke would. */
function typeInEditor(editor: Editor, text: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.insertText(text, view.state.doc.content.size - 1));
  });
}

let nav: DeferredNavigation;
let shell: ShellApi;

async function setup(disk: Record<string, string>, opts: { realEditor?: boolean } = {}) {
  const host = $<HTMLDivElement>("#htmlHost");
  nav = deferIframeNavigation(host);
  const surface = new HtmlSurface(host, { onEdit: () => shell.markActiveHtmlTabDirty() });
  const saves: { docPath?: string; text: string }[] = [];
  const api = {
    openDoc: vi.fn(async ({ docPath }: { docPath: string }) => {
      if (!(docPath in disk)) throw new Error(`ENOENT: no such file or directory, open '${docPath}'`);
      return { text: disk[docPath], format: docPath.endsWith(".html") ? "html" : "markdown", annotations: [] };
    }),
    saveDoc: vi.fn(async (p: { docPath?: string; text: string }) => {
      saves.push(p);
      return { saved: true, version: "v0002" };
    }),
    getSettings: vi.fn(async () => ({ scope: "folder" })),
    listProposals: vi.fn(async () => []),
    listVersions: vi.fn(async () => []),
    listHarnesses: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
  };
  let editor: Editor | null = null;
  if (opts.realEditor) editor = await makeEditor($("#editor"), (md, prev) => shell.onEditorMarkdownUpdated(md, prev));
  const fakeEditor = { action: () => undefined };
  const explicit: Record<string, unknown> = {
    api: new Proxy(api as Record<string, unknown>, { get: (t, p: string) => t[p] ?? vi.fn(async () => undefined) }),
    log: vi.fn(),
    getEditor: () => editor ?? fakeEditor,
    getHtmlSurface: () => surface,
    rootEl: $("#editor"),
    searchIsOpen: () => false,
    searchState: { query: "" },
    getThreadNodes: () => [],
    refreshThreadTree: vi.fn(async () => {}),
    modelName: (k: string) => k,
    truncTitle: (s: string) => s,
    annoKey: new PluginKey("test-anno"),
    proposalKey: new PluginKey("test-proposal"),
    searchKey: new PluginKey("test-search"),
    showHtmlSurface: () => surface.show(),
    showMarkdownSurface: () => surface.hide(),
    setHtmlEditMode: (on: boolean) => surface.setEditable(on),
  };
  const deps = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = vi.fn())),
  }) as unknown as ShellDeps;
  shell = initShell(deps);
  shell.wireMenu();
  return { shell, api, surface, saves, editor: editor!, deps: explicit };
}

const frameDoc = () => $<HTMLIFrameElement>("#htmlHost iframe").contentDocument!;
async function saveWorkingCopy(): Promise<void> {
  fire("menu-action", "save");
  await settle();
  $<HTMLButtonElement>("#versionPickerConfirm").click(); // "Current working copy" is preselected
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
  events.handlers.clear();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});
afterEach(() => {
  nav?.restore();
  delete (window as { __TAURI__?: unknown }).__TAURI__;
});

describe("HTML tabs on the real iframe surface", () => {
  it("restoring two HTML tabs and switching fast never stores about:blank or the other tab's HTML; Save and Review write each tab's own text", async () => {
    saveSession(["/d/a.html", "/d/b.html"], 0);
    const { api, saves } = await setup({ "/d/a.html": A, "/d/b.html": B });
    await shell.restoreTabSession();
    expect(api.openDoc).toHaveBeenCalledTimes(2);
    // Nothing has finished loading yet, and the user flips between the two tabs.
    await shell.activateTab(1);
    await shell.activateTab(0);
    await nav.commit(); // A shows
    await shell.activateTab(1); // B starts loading; the iframe still holds A
    await shell.activateTab(0); // ...and back before B arrives
    await shell.activateTab(1);
    await nav.commit();
    expect(frameDoc().body.textContent).toBe("beta");

    await saveWorkingCopy();
    expect(saves.at(-1)).toEqual({ docPath: "/d/b.html", text: B });

    await shell.activateTab(0); // A is loading again: Review / Resolve directives sync first
    await shell.syncActiveDocToDisk();
    expect(saves.at(-1)).toEqual({ docPath: "/d/a.html", text: A });
    await nav.commit();
    expect(frameDoc().body.textContent).toBe("alpha");
  });

  it("in review mode the page's own script changes are never captured or saved as the document", async () => {
    const { saves } = await setup({ "/d/a.html": A, "/d/b.html": B });
    await shell.openInTab("/d/a.html");
    await nav.commit();
    frameDoc().body.querySelector("p")!.append(" [clock 12:00]"); // the page's script updates itself
    await shell.syncActiveDocToDisk();
    expect(saves.at(-1)!.text).toBe(A);
    await shell.openInTab("/d/b.html");
    await nav.commit();
    await shell.activateTab(0);
    await nav.commit();
    expect(shell.getCurrentMarkdown()).toBe(A);
  });

  it("an edit typed in Edit mode survives switching tabs at once, and is what Save writes", async () => {
    const { surface, saves } = await setup({ "/d/a.html": A, "/d/b.html": B });
    await shell.openInTab("/d/a.html");
    await nav.commit();
    surface.setEditable(true);
    frameDoc().body.querySelector("p")!.append(" typed");
    frameDoc().body.dispatchEvent(new Event("input", { bubbles: true }));
    await shell.openInTab("/d/b.html"); // within the 200 ms edit debounce
    await nav.commit();
    await wait(250);
    expect(shell.getCurrentMarkdown()).toBe(B); // the stray debounce did not touch B
    await shell.activateTab(0);
    await nav.commit();
    expect(frameDoc().body.textContent?.trim()).toBe("alpha typed");
    await saveWorkingCopy();
    expect(saves.at(-1)!.docPath).toBe("/d/a.html");
    expect(saves.at(-1)!.text).toContain("<p>alpha typed</p>");
  });

  it("switching to a markdown tab or closing the last tab unloads the HTML page", async () => {
    await setup({ "/d/a.html": A, "/d/n.md": "# notes\n" });
    await shell.openInTab("/d/a.html");
    await nav.commit();
    await shell.openInTab("/d/n.md");
    await nav.commit();
    expect(frameDoc().body?.textContent ?? "").toBe("");
    await shell.activateTab(0);
    await nav.commit();
    expect(frameDoc().body.textContent).toBe("alpha");
    await shell.closeTab(1);
    await shell.closeTab(0);
    await nav.commit();
    expect(frameDoc().body?.textContent ?? "").toBe("");
  });
});

describe("markdown tabs on the real editor", () => {
  const disk = { "/d/a.md": "# A\n", "/d/b.md": "# B\n" };
  const md = (editor: Editor) => editor.action(getMarkdown());

  it("text typed just before a tab switch is kept (no 200 ms window), and the late listener never writes it into the other tab", async () => {
    const { editor } = await setup(disk, { realEditor: true });
    await shell.openInTab("/d/a.md");
    await shell.openInTab("/d/b.md");
    await shell.activateTab(0);
    typeInEditor(editor, " typed");
    await shell.activateTab(1); // at once
    expect(md(editor)).toBe("# B\n");
    await wait(300); // the listener's debounce has fired by now
    expect(shell.getCurrentMarkdown()).toBe("# B\n");
    await shell.activateTab(0);
    expect(md(editor)).toBe("# A typed\n");
  });

  it("⌘S right after typing saves what was typed", async () => {
    const { editor, saves } = await setup(disk, { realEditor: true });
    await shell.openInTab("/d/a.md");
    typeInEditor(editor, " typed");
    await saveWorkingCopy();
    expect(saves.at(-1)).toEqual({ docPath: "/d/a.md", text: "# A typed\n" });
  });

  it("⌘Z right after switching tabs never brings back the other tab's text", async () => {
    const { editor } = await setup(disk, { realEditor: true });
    await shell.openInTab("/d/a.md");
    typeInEditor(editor, " typed");
    await shell.openInTab("/d/b.md");
    editor.action(callCommand(undoCommand.key));
    expect(md(editor)).toBe("# B\n");
    await wait(300);
    expect(shell.getCurrentMarkdown()).toBe("# B\n");
    await shell.activateTab(0);
    expect(md(editor)).toBe("# A typed\n");
    editor.action(callCommand(undoCommand.key)); // nor the tab before it
    expect(md(editor)).toBe("# A typed\n");
  });

  it("⌘Z in the empty state does not bring back the closed document", async () => {
    const { editor } = await setup(disk, { realEditor: true });
    await shell.openInTab("/d/a.md");
    await shell.closeTab(0);
    const placeholder = md(editor);
    expect(placeholder).toContain("No document open");
    editor.action(callCommand(undoCommand.key));
    expect(md(editor)).toBe(placeholder);
  });
});

describe("boot order", () => {
  it("a file opened from Finder while the session restores opens once and ends up focused", async () => {
    saveSession(["/d/a.md", "/d/b.md"], 0);
    const pendingOpens: string[] = [];
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: async (cmd: string) => (cmd === "take_pending_opens" ? pendingOpens.splice(0) : undefined) },
    };
    const { api } = await setup({ "/d/a.md": "# A\n", "/d/b.md": "# B\n", "/d/finder.md": "# F\n" });
    let releaseB!: () => void;
    const openDoc = api.openDoc.getMockImplementation()!;
    api.openDoc.mockImplementation(async (p: { docPath: string }) => {
      if (p.docPath === "/d/b.md") await new Promise<void>((r) => (releaseB = r));
      return openDoc(p);
    });

    const restoring = shell.restoreTabSession();
    await settle();
    pendingOpens.push("/d/finder.md");
    fire("open-pending"); // the OS hands over a file mid-restore
    await settle();
    releaseB();
    await restoring;
    await shell.drainExternalOpens({ boot: true }); // main.ts's boot drain, right after restore

    expect(tabNames()).toEqual(["a.md", "b.md", "finder.md"]);
    expect(shell.getDocPath()).toBe("/d/finder.md");
  });

  it("opening the same file twice at once makes one tab", async () => {
    await setup({ "/d/a.md": "# A\n" });
    await Promise.all([shell.openInTab("/d/a.md"), shell.openInTab("/d/a.md")]);
    expect(tabNames()).toEqual(["a.md"]);
  });
});
