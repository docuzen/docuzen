// @vitest-environment happy-dom
//
// Behavioural test of shell.ts's tab lifecycle against a real DOM (index.html's markup).
// Most of this package's shell/chat tests assert on source TEXT, which is why three real
// bugs here shipped with green tests: an approved edit on an HTML doc being overwritten by
// the iframe's stale DOM, closing a tab writing one document's HTML into another, and a
// close switching the user to the wrong tab. These tests drive the actual functions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: vi.fn(async () => {}) }) }));

import { initShell, type ShellDeps } from "./shell.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

/** Stand-in for the iframe surface: `load` sets what it shows, `edit` simulates in-iframe typing. */
function fakeHtmlSurface() {
  let shown = "";
  return {
    load: (html: string) => {
      shown = html;
    },
    getHtml: () => shown,
    edit: (html: string) => {
      shown = html;
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
  return { shell: initShell(deps), surface, disk };
}

const tabNames = () => [...document.querySelectorAll("#tabs .tab .tname")].map((n) => n.textContent);
const activeTabName = () => document.querySelector("#tabs .tab.active .tname")?.textContent;

beforeEach(() => {
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
});
