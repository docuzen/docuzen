import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Sidebar toggles, harness/model badge, topbar clarity. These modules do
// module-scope
// `document.querySelector` (see each file's own header), so — per the repo's
// established pattern (see e.g. harness-settings.test.ts, agent-retry-ux.test.ts) —
// these are source-pin assertions rather than jsdom-driven behavioral tests.
const shellSource = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
const surfaceSource = readFileSync(new URL("./surface.ts", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("./editor.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("sidebar toggle shortcuts", () => {
  it("binds ⌘⇧L / ⌘⇧R in shell.ts, mirroring chat.ts's ⌘⇧D resolve shortcut shape", () => {
    expect(shellSource).toContain('(e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "l" || e.key === "L")');
    expect(shellSource).toContain('(e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "r" || e.key === "R")');
    expect(chatSource).toContain('(e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "d" || e.key === "D")');
  });

  it("does not collide with ⌘F search or the ⌘Z undo chord", () => {
    // ⌘F/⌘Z handlers never gate on e.shiftKey being true, so a shift-held combo
    // never reaches them; ⌘⇧L/⌘⇧R's handler requires e.shiftKey, so the two
    // families are mutually exclusive by construction.
    expect(surfaceSource).toContain('e.key === "f" || e.key === "F"');
    expect(surfaceSource).toContain('e.key === "z" || e.key === "Z"');
  });

  it("documents the new shortcuts in the Keyboard shortcuts modal", () => {
    expect(htmlSource).toContain("<kbd>⌘⇧L</kbd>");
    expect(htmlSource).toContain("<kbd>⌘⇧R</kbd>");
  });

  it("gives both toggle buttons a tooltip that includes the shortcut", () => {
    expect(htmlSource).toMatch(/id="toggleLeftBtn"[^>]*title="[^"]*⌘⇧L/);
    expect(htmlSource).toMatch(/id="toggleRightBtn"[^>]*title="[^"]*⌘⇧R/);
  });
});

describe("sidebar collapse persistence", () => {
  it("uses a dedicated, per-app (not per-doc) localStorage key distinct from the tab session key", () => {
    expect(shellSource).toContain('const SIDEBAR_STATE_KEY = "docuzen:sidebars:v1";');
    expect(shellSource).toContain('const TAB_SESSION_KEY = "docuzen:tabs:v1";');
    expect(shellSource).toContain("localStorage.getItem(SIDEBAR_STATE_KEY)");
    expect(shellSource).toContain("localStorage.setItem(SIDEBAR_STATE_KEY,");
  });

  it("collapsing sets a `.collapsed` class rather than removing the pane from the DOM", () => {
    const applySource = sourceBetween(
      shellSource,
      "function applySidebarState(): void {",
      "applySidebarState(); // apply the restored",
    );
    expect(applySource).toContain('chatPaneEl.classList.toggle("collapsed", sidebarState.left)');
    expect(applySource).toContain('panelEl.classList.toggle("collapsed", sidebarState.right)');
  });
});

describe("sidebar un-collapse exceptions (NO magic beyond these two)", () => {
  it("un-collapses the left pane wherever a conversation is opened (activateChatPane + openThreadById)", () => {
    const activateChatPaneSource = sourceBetween(
      chatSource,
      "function activateChatPane(id: string, quoted: string): void {",
      "async function promoteToChat(id: string): Promise<void> {",
    );
    expect(activateChatPaneSource).toContain("deps.uncollapseLeftPane();");

    const openThreadByIdSource = sourceBetween(
      chatSource,
      "async function openThreadById(id: string, title: string): Promise<void> {",
      "async function jumpToAnnotation(id: string): Promise<void> {",
    );
    expect(openThreadByIdSource).toContain("deps.uncollapseLeftPane();");
  });

  it("un-collapses the right rail from every card-creating user action, not from persisted-annotation replay", () => {
    const commentBtnSource = sourceBetween(
      surfaceSource,
      'commentBtn.addEventListener("click", async () => {',
      "popTop.appendChild(commentBtn);",
    );
    expect(commentBtnSource).toContain("deps.uncollapseRightRail();");

    // The popover Quick Actions (Improve/Visualize/Brainstorm/Discuss) also create a
    // comment card via annotateActive — same rule applies to their shared handler.
    const quickActionSource = sourceBetween(
      surfaceSource,
      "for (const qa of QUICK_ACTIONS) {",
      "popover.appendChild(popActions);",
    );
    expect(quickActionSource).toContain("deps.uncollapseRightRail();");

    // renderLoadedHtml replays PERSISTED annotations on tab activation — a data-load
    // path, not a live user action — and must stay silent on the layout state.
    const renderLoadedHtmlSource = sourceBetween(
      surfaceSource,
      "function renderLoadedHtml(annotations: LoadedAnno[]): void {",
      "async function onHtmlReady(): Promise<void> {",
    );
    expect(renderLoadedHtmlSource).not.toContain("uncollapseRightRail");

    // editor.ts's markdown-surface analogue (renderLoaded) never even sees the dep.
    expect(editorSource).not.toContain("uncollapseRightRail");
  });

  it("wires both exceptions through deps (no cross-module import), per the plan's established pattern", () => {
    expect(chatSource).toContain("uncollapseLeftPane: () => void;");
    expect(surfaceSource).toContain("uncollapseRightRail: () => void;");
    expect(mainSource).toContain("uncollapseLeftPane: () => shell.uncollapseLeftPane(),");
    expect(mainSource).toContain("uncollapseRightRail: shell.uncollapseRightRail,");
  });
});

describe("harness/model badge", () => {
  it("resolves the default model's display name through chat.ts's cache (deps.modelName), not this module's own lazy configuredModels", () => {
    const badgeSource = sourceBetween(
      shellSource,
      "function renderHarnessBadge(",
      "async function refreshHarnessBadge(): Promise<void> {",
    );
    expect(badgeSource).toContain("deps.modelName(modelKey)");
    expect(badgeSource).not.toContain("configuredModels");
  });

  it("uses established app vocabulary for the two 'no user-facing model name' cases", () => {
    const badgeSource = sourceBetween(
      shellSource,
      "function renderHarnessBadge(",
      "async function refreshHarnessBadge(): Promise<void> {",
    );
    expect(badgeSource).toContain('"harness-managed"'); // matches this file's own "Model: harness-managed" capchip
    expect(badgeSource).toContain('"sidecar default"'); // matches refreshModels' "— sidecar default —" option
  });

  it("notes in its tooltip that it reflects defaults, not per-thread overrides", () => {
    const badgeSource = sourceBetween(
      shellSource,
      "function renderHarnessBadge(",
      "async function refreshHarnessBadge(): Promise<void> {",
    );
    expect(badgeSource).toContain("Defaults — per-thread overrides show in the chat pane.");
    expect(badgeSource).toContain("Change in Settings (⌘,).");
  });

  it("threads chat.ts's modelName getter through ShellDeps/main.ts, not a re-fetch of its own", () => {
    expect(shellSource).toContain("modelName: (key: string) => string;");
    expect(mainSource).toContain("modelName: chat.modelName,");
  });

  it("refreshes on boot and after saveSettings, and NOT on every tab switch", () => {
    expect(mainSource).toContain("await shell.refreshHarnessBadge();");

    const saveSettingsSource = sourceBetween(
      shellSource,
      "async function saveSettings(): Promise<void> {",
      "setScopeEl.addEventListener",
    );
    expect(saveSettingsSource).toContain("void refreshHarnessBadge();");

    const activateTabSource = sourceBetween(
      shellSource,
      "async function activateTab(idx: number): Promise<void> {",
      "/** Read the per-doc default model key",
    );
    expect(activateTabSource).not.toContain("refreshHarnessBadge");
  });
});

describe("reading area widens when a pane is hidden (bugfix: freed space stayed empty margin)", () => {
  // These are pure source pins on styles.css, matching the established pattern
  // for CSS-behavior regressions in this repo (see code-block-style.test.ts).
  function sourceBetweenStyles(start: string, end: string): string {
    return sourceBetween(stylesSource, start, end);
  }

  it("keys the widened tiers off .layout:has(...) — the only reachable hook, since .doc sits between .chatpane and .panel and CSS has no previous-sibling combinator", () => {
    expect(stylesSource).toContain(".layout:has(.chatpane.collapsed) .editor,");
    expect(stylesSource).toContain(".layout:has(.panel.collapsed) .editor {");
    expect(stylesSource).toContain(".layout:has(.chatpane.collapsed):has(.panel.collapsed) .editor {");
    expect(stylesSource).toContain(".layout:has(.chatpane.collapsed) .htmlhost,");
    expect(stylesSource).toContain(".layout:has(.panel.collapsed) .htmlhost {");
    expect(stylesSource).toContain(".layout:has(.chatpane.collapsed):has(.panel.collapsed) .htmlhost {");
  });

  it("leaves the default (both panes visible) measure untouched — no :has() rule matches that state", () => {
    expect(stylesSource).toContain(".editor {\n  max-width: min(850px, 100%);");
    expect(stylesSource).toContain(".htmlhost {\n  max-width: min(1100px, 100%);");
  });

  it("widens further with both panes hidden than with just one — applies to both the markdown editor AND the HTML iframe host", () => {
    const oneEditor = sourceBetweenStyles(
      ".layout:has(.chatpane.collapsed) .editor,\n.layout:has(.panel.collapsed) .editor {",
      "}",
    );
    const bothEditor = sourceBetweenStyles(
      ".layout:has(.chatpane.collapsed):has(.panel.collapsed) .editor {",
      "}",
    );
    expect(oneEditor).toContain("max-width: min(1100px, 100%);");
    expect(bothEditor).toContain("max-width: min(1400px, 92%);");

    const oneHost = sourceBetweenStyles(
      ".layout:has(.chatpane.collapsed) .htmlhost,\n.layout:has(.panel.collapsed) .htmlhost {",
      "}",
    );
    const bothHost = sourceBetweenStyles(
      ".layout:has(.chatpane.collapsed):has(.panel.collapsed) .htmlhost {",
      "}",
    );
    expect(oneHost).toContain("max-width: min(1300px, 100%);");
    expect(bothHost).toContain("max-width: min(1600px, 92%);");
  });

  it("transitions max-width smoothly (~150-200ms) so toggling a pane doesn't jar", () => {
    const transitionRule = sourceBetweenStyles(
      ".editor,\n.htmlhost {\n  transition:",
      "}",
    );
    expect(transitionRule).toMatch(/transition: max-width 1[5-9]\dms/);
  });
});

describe("topbar clarity", () => {
  it("demotes the dev-facing engine badge out of the topbar into Diagnostics", () => {
    const topbarSource = sourceBetween(htmlSource, '<header class="topbar">', "</header>");
    expect(topbarSource).not.toContain('id="engine"');

    const diagnosticsSource = sourceBetween(htmlSource, '<details class="diagnostics">', "</details>");
    expect(diagnosticsSource).toContain('id="engine"');
  });

  it("keeps only navigation/actions chrome in the topbar: wordmark+badge, view controls (Search/Agents/pane toggles) — the status cluster (zoom/badge/docd dot) moved to the bottom status bar", () => {
    const topbarSource = sourceBetween(htmlSource, '<header class="topbar">', "</header>");
    expect(topbarSource).toContain('<div class="brandblock">');
    expect(topbarSource).toContain("live review canvas");

    const viewControls = sourceBetween(topbarSource, '<div class="viewcontrols">', "</div>");
    expect(viewControls).toContain('id="searchBtn"');
    expect(viewControls).toContain('id="agentsBtn"');
    expect(viewControls).toContain('id="toggleLeftBtn"');
    expect(viewControls).toContain('id="toggleRightBtn"');

    // The status cluster no longer lives anywhere inside the topbar.
    expect(topbarSource).not.toContain('class="statuscluster"');
    expect(topbarSource).not.toContain('id="docZoomControl"');
    expect(topbarSource).not.toContain('id="harnessBadge"');
    expect(topbarSource).not.toContain('id="connStatus"');
  });

  it("gives every topbar control a tooltip", () => {
    for (const id of ["htmlEditToggle", "searchBtn", "agentsBtn", "toggleLeftBtn", "toggleRightBtn"]) {
      expect(htmlSource).toMatch(new RegExp(`id="${id}"[^>]*title="`));
    }
  });
});

describe("bottom status bar (moved out of the topbar)", () => {
  it("hosts the status cluster — zoom control, harness/model badge, docd connection dot — in a dedicated <footer>, a sibling of `.topbar`/`.layout` (not nested inside either) so it spans the full window width", () => {
    expect(htmlSource).toContain('<footer class="statusbar">');
    const statusbarSource = sourceBetween(htmlSource, '<footer class="statusbar">', "</footer>");
    expect(statusbarSource).toContain('<div class="statuscluster">');
    expect(statusbarSource).toContain('id="docZoomControl"');
    expect(statusbarSource).toContain('id="harnessBadge"');
    expect(statusbarSource).toContain('id="connStatus"');

    // Sits after `.layout` closes, not inside it — full-width below both sidebars.
    const layoutEnd = htmlSource.indexOf("</div>", htmlSource.lastIndexOf('<div id="engine"'));
    const statusbarStart = htmlSource.indexOf('<footer class="statusbar">');
    expect(statusbarStart).toBeGreaterThan(layoutEnd);
  });

  it("gives every status-bar control a tooltip", () => {
    for (const id of ["connStatus", "docZoomControl"]) {
      expect(htmlSource).toMatch(new RegExp(`id="${id}"[^>]*title="`));
    }
    expect(htmlSource).toMatch(/id="harnessBadge"[^>]*title="/);
  });

  it("uses editorial-paper chrome: hairline TOP border (not bottom, since it's the last thing on screen), quiet paper surface, small mono text — same tokens the topbar uses", () => {
    const statusbarRule = sourceBetween(stylesSource, ".statusbar {", "\n}");
    expect(statusbarRule).toContain("border-top: 1px solid var(--line");
    expect(statusbarRule).toContain("background: var(--paper");
    expect(statusbarRule).toMatch(/font:.*ui-monospace/);
  });

  it("is a flex-shrink:0 body-level child, not squeezed by `.layout`'s flex:1 doc area", () => {
    const statusbarRule = sourceBetween(stylesSource, ".statusbar {", "\n}");
    expect(statusbarRule).toContain("flex-shrink: 0");
  });
});
