// @vitest-environment happy-dom
//
// Behavioural test of shell.ts's tab lifecycle against a real DOM (index.html's markup).
// Most of this package's shell/chat tests assert on source TEXT, which is why three real
// bugs here shipped with green tests: an approved edit on an HTML doc being overwritten by
// the iframe's stale DOM, closing a tab writing one document's HTML into another, and a
// close switching the user to the wrong tab. These tests drive the actual functions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: vi.fn(async () => {}) }) }));

import { initShell, type ShellDeps } from "./shell.js";
import { LOST_CONNECTION_MESSAGE } from "./rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

/**
 * Stand-in for the iframe surface: `load` shows a document at once (tab-content.test.ts drives
 * the real, asynchronous one), `edit` simulates in-iframe typing, `unload` empties it.
 */
function fakeHtmlSurface() {
  let shown = "";
  let key: string | undefined;
  let edited = false;
  return {
    load: vi.fn((html: string, _base?: string, docKey?: string) => {
      shown = html;
      key = docKey;
      edited = false;
    }),
    unload: vi.fn(() => {
      shown = "";
      key = undefined;
      edited = false;
    }),
    getHtml: () => shown,
    editedHtmlFor: (docKey: string) => (edited && key === docKey ? shown : null),
    markEdited: (docKey: string) => void (key === docKey && (edited = true)),
    edit: (html: string) => {
      shown = html;
      edited = true;
    },
  };
}

function setup(disk: Record<string, { text: string; format: "markdown" | "html" }>) {
  const surface = fakeHtmlSurface();
  const api = new Proxy(
    {
      openDoc: vi.fn(async ({ docPath }: { docPath: string }) => ({ ...disk[docPath], annotations: [] })),
      getSettings: vi.fn(async () => ({ scope: "folder" })),
      listProposals: vi.fn(async () => []),
      listHarnesses: vi.fn(async () => []),
      listModels: vi.fn(async () => []),
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? vi.fn(async () => undefined) },
  );
  const explicit: Record<string, unknown> = {
    api,
    log: vi.fn(),
    getEditor: () => ({ action: vi.fn() }),
    getHtmlSurface: () => surface,
    rootEl: document.querySelector("#editor"),
    searchIsOpen: () => false,
    searchState: { query: "" },
    getThreadNodes: () => [],
    modelName: (k: string) => k,
  };
  // Every other dep (chat/proposal/search hooks) is a no-op for these tests.
  const deps = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = vi.fn())),
  }) as unknown as ShellDeps;
  return { shell: initShell(deps), surface, disk, api: api as Record<string, ReturnType<typeof vi.fn>>, deps: explicit };
}

const SESSION_KEY = "docuzen:tabs:v1";
const savedPaths = () =>
  (JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as { tabs: { docPath: string }[] } | null)?.tabs.map((t) => t.docPath);
function saveSession(paths: string[], activeIdx = 0): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: paths.map((docPath) => ({ docPath })), activeIdx }));
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const tabNames = () => [...document.querySelectorAll("#tabs .tab .tname")].map((n) => n.textContent);
const activeTabName = () => document.querySelector("#tabs .tab.active .tname")?.textContent;

// Each test's shell registers window listeners (beforeunload saves the session); remove them
// afterwards so a later test's beforeunload does not also run earlier tests' shells.
let windowListeners: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
let addListenerSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  addListenerSpy?.mockRestore();
  for (const [type, l, o] of windowListeners) window.removeEventListener(type, l, o);
  windowListeners = [];
});

beforeEach(() => {
  const add = window.addEventListener.bind(window);
  addListenerSpy = vi.spyOn(window, "addEventListener").mockImplementation(((type: string, l: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    windowListeners.push([type, l, o]);
    add(type, l, o);
  }) as typeof window.addEventListener);
  document.body.innerHTML = bodyHtml;
  // A fresh in-memory store per test (tab-session + sidebar state persist through it).
  // Stubbed rather than relying on the environment's: newer Node versions define their
  // own `localStorage` global, which shadows the DOM one and is unusable without a file.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

describe("tab lifecycle (behavioural)", () => {
  it("reloadActiveDoc shows the fresh on-disk HTML, not the iframe's stale copy", async () => {
    const { shell, surface, disk } = setup({ "/d/a.html": { text: "<p>old</p>", format: "html" } });
    await shell.openInTab("/d/a.html");
    expect(surface.getHtml()).toBe("<p>old</p>");

    // An approved proposal rewrote the file on disk; the iframe still shows the old doc.
    disk["/d/a.html"] = { text: "<p>new</p>", format: "html" };
    await shell.reloadActiveDoc();

    expect(surface.getHtml()).toBe("<p>new</p>");
    expect(shell.getCurrentMarkdown()).toBe("<p>new</p>");
  });

  it("switching tabs keeps unsaved in-iframe edits of the tab being left", async () => {
    const { shell, surface } = setup({
      "/d/a.html": { text: "<p>a</p>", format: "html" },
      "/d/b.html": { text: "<p>b</p>", format: "html" },
    });
    await shell.openInTab("/d/a.html");
    await shell.openInTab("/d/b.html");
    await shell.activateTab(0);
    surface.edit("<p>a edited</p>");

    await shell.activateTab(1);
    expect(surface.getHtml()).toBe("<p>b</p>");
    await shell.activateTab(0);
    expect(surface.getHtml()).toBe("<p>a edited</p>");
  });

  it("closing the active HTML tab does not write its HTML into the neighbouring tab", async () => {
    const { shell, surface } = setup({
      "/d/a.html": { text: "<p>a</p>", format: "html" },
      "/d/b.html": { text: "<p>b</p>", format: "html" },
    });
    await shell.openInTab("/d/a.html");
    await shell.openInTab("/d/b.html");
    await shell.activateTab(0); // A active, iframe shows A

    await shell.closeTab(0);

    expect(tabNames()).toEqual(["b.html"]);
    expect(shell.getDocPath()).toBe("/d/b.html");
    expect(surface.getHtml()).toBe("<p>b</p>");
    expect(shell.getCurrentMarkdown()).toBe("<p>b</p>");
  });

  it("closing a tab BEFORE the active one keeps the user on their tab, with its unsaved edits", async () => {
    const { shell, surface } = setup({
      "/d/a.md": { text: "# a", format: "markdown" },
      "/d/b.md": { text: "# b", format: "markdown" },
      "/d/c.html": { text: "<p>c</p>", format: "html" },
    });
    await shell.openInTab("/d/a.md");
    await shell.openInTab("/d/b.md");
    await shell.openInTab("/d/c.html"); // C active
    surface.edit("<p>c edited</p>");

    await shell.closeTab(0);

    expect(tabNames()).toEqual(["b.md", "c.html"]);
    expect(activeTabName()).toBe("c.html");
    expect(shell.getDocPath()).toBe("/d/c.html");
    expect(surface.getHtml()).toBe("<p>c edited</p>");
  });

  it("closing a tab AFTER the active one leaves the active tab alone", async () => {
    const { shell } = setup({
      "/d/a.md": { text: "# a", format: "markdown" },
      "/d/b.md": { text: "# b", format: "markdown" },
      "/d/c.md": { text: "# c", format: "markdown" },
    });
    await shell.openInTab("/d/a.md");
    await shell.openInTab("/d/b.md");
    await shell.openInTab("/d/c.md");
    await shell.activateTab(0);

    await shell.closeTab(2);

    expect(tabNames()).toEqual(["a.md", "b.md"]);
    expect(activeTabName()).toBe("a.md");
  });

  it("renders a hostile file name as text, never as markup", async () => {
    const evil = '/d/<img src=x onerror="window.__pwned=1">.md';
    const { shell } = setup({ [evil]: { text: "# x", format: "markdown" } });
    await shell.openInTab(evil);

    expect(document.querySelector("#tabs img")).toBeNull();
    expect(activeTabName()).toBe('<img src=x onerror="window.__pwned=1">.md');
  });

  it("closing a background tab leaves the active one alone: no reload, chat reset, or exit from its view", async () => {
    const { shell, surface, api, deps } = setup({
      "/d/b.md": { text: "# b", format: "markdown" },
      "/d/c.md": { text: "# c", format: "markdown" },
      "/d/a.html": { text: "<p>a</p>", format: "html" },
    });
    await shell.openInTab("/d/b.md");
    await shell.openInTab("/d/c.md");
    await shell.openInTab("/d/a.html"); // active
    surface.edit("<p>a edited</p>");
    const before = {
      loads: surface.load.mock.calls.length,
      resets: (deps.resetChat as ReturnType<typeof vi.fn>).mock.calls.length,
      opens: api.openDoc.mock.calls.length,
      editMode: (deps.setHtmlEditMode as ReturnType<typeof vi.fn>).mock.calls.length,
    };

    await shell.closeTab(0);

    expect(tabNames()).toEqual(["c.md", "a.html"]);
    expect(activeTabName()).toBe("a.html");
    expect(surface.load.mock.calls.length).toBe(before.loads);
    expect((deps.resetChat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before.resets);
    expect(api.openDoc.mock.calls.length).toBe(before.opens);
    expect((deps.setHtmlEditMode as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before.editMode);
    expect(shell.getCurrentMarkdown()).toBe("<p>a edited</p>");
    expect(savedPaths()).toEqual(["/d/c.md", "/d/a.html"]);
  });
});

describe("session restore keeps the saved tabs when it cannot finish", () => {
  it("a restore that cannot reach the sidecar leaves the saved session for the next launch", async () => {
    saveSession(["/d/a.md", "/d/b.md"], 1);
    const { shell, api } = setup({});
    api.openDoc.mockRejectedValue(new Error(LOST_CONNECTION_MESSAGE));

    expect(await shell.restoreTabSession()).toBe(false);
    shell.showEmptyState(); // what main.ts does next
    window.dispatchEvent(new Event("beforeunload"));

    expect(savedPaths()).toEqual(["/d/a.md", "/d/b.md"]);
    expect(api.openDoc).toHaveBeenCalledTimes(1); // gave up at the first lost connection, no 10 s wait per tab
  });

  it("closing the window in the middle of the restore keeps the whole saved session", async () => {
    saveSession(["/d/a.md", "/d/b.md", "/d/c.md"], 0);
    const { shell, api, disk } = setup({
      "/d/a.md": { text: "# a", format: "markdown" },
      "/d/b.md": { text: "# b", format: "markdown" },
      "/d/c.md": { text: "# c", format: "markdown" },
    });
    let releaseB!: () => void;
    api.openDoc.mockImplementation(async ({ docPath }: { docPath: string }) => {
      if (docPath === "/d/b.md") await new Promise<void>((r) => (releaseB = r));
      return { ...disk[docPath], annotations: [] };
    });

    const restoring = shell.restoreTabSession();
    await settle();
    window.dispatchEvent(new Event("beforeunload")); // reload / quit now
    expect(savedPaths()).toEqual(["/d/a.md", "/d/b.md", "/d/c.md"]);

    releaseB();
    expect(await restoring).toBe(true);
    expect(tabNames()).toEqual(["a.md", "b.md", "c.md"]);
    expect(activeTabName()).toBe("a.md");
  });

  it("tabs the sidecar could not be reached for stay saved; a file that is gone is dropped", async () => {
    saveSession(["/d/a.md", "/d/gone.md", "/d/b.md", "/d/c.md"], 0);
    const { shell, api } = setup({});
    api.openDoc.mockImplementation(async ({ docPath }: { docPath: string }) => {
      if (docPath === "/d/a.md") return { text: "# a", format: "markdown", annotations: [] };
      if (docPath === "/d/gone.md") throw new Error("ENOENT: no such file or directory, open '/d/gone.md'");
      throw new Error(LOST_CONNECTION_MESSAGE);
    });

    expect(await shell.restoreTabSession()).toBe(true);
    expect(tabNames()).toEqual(["a.md"]);
    expect(savedPaths()).toEqual(["/d/a.md", "/d/b.md", "/d/c.md"]);

    // Later work keeps them: opening another file, or closing the restored one.
    api.openDoc.mockImplementation(async () => ({ text: "# d", format: "markdown", annotations: [] }));
    await shell.openInTab("/d/d.md");
    expect(savedPaths()).toEqual(["/d/a.md", "/d/d.md", "/d/b.md", "/d/c.md"]);
    await shell.openInTab("/d/b.md"); // reachable again: an ordinary tab now
    await shell.closeTab(2);
    await shell.closeTab(1);
    await shell.closeTab(0);
    expect(savedPaths()).toEqual(["/d/c.md"]);
  });
});
