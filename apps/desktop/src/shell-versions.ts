// The two version modals: the read-only preview of the document at a version (with
// "Edit from here"), and the picker Save/Export use to choose between the working copy
// and any saved revision, drawn as a branch graph. Split out of shell.ts; loading a
// version into a tab is the tab owner's job, reached through `deps.onEditFromVersion`.
import type { ShellDeps } from "./shell.js";
import { wireModal, reportError } from "./ui.js";
import {
  buildVersionPickerModel,
  type VersionPickerGraphCell,
  type VersionPickerGraphRow,
  type VersionPickerVersion,
} from "./version-picker-tree.js";

export interface VersionsDeps extends Pick<ShellDeps, "api" | "getThreadNodes" | "log" | "refreshThreadTree" | "stripFrontmatter" | "truncTitle"> {
  hasActiveDoc: () => boolean;
  /** Replace the active tab's working copy with a version's body (not yet on disk). */
  onEditFromVersion: (versionId: string, body: string) => Promise<void>;
}

export interface VersionsApi {
  openVersionPreview: (versionId: string) => Promise<void>;
  /** Resolves to "current", a version id, or null when cancelled. */
  openVersionPicker: (confirmLabel: string) => Promise<string | null>;
  /** Exposed so main.ts's shared Escape-key handler can also close it. */
  versionModal: HTMLDivElement;
}

export function initVersions(deps: VersionsDeps): VersionsApi {
  // --- Version preview modal (read-only doc-at-version + "Edit from here") ---
  const versionModal = document.querySelector<HTMLDivElement>("#versionModal")!;
  const versionModalTitle = document.querySelector<HTMLHeadingElement>("#versionModalTitle")!;
  const versionModalBody = document.querySelector<HTMLPreElement>("#versionModalBody")!;
  const versionEditBtn = document.querySelector<HTMLButtonElement>("#versionEditBtn")!;
  document.querySelector("#versionClose")!.addEventListener("click", () => {
    versionModal.hidden = true;
  });
  wireModal(versionModal); // click backdrop to close

  /**
   * Open the read-only version-preview modal for `versionId`. Fetches the full
   * version file via `readVersion`, strips its frontmatter, and shows the body in a
   * `<pre>` (via textContent — no innerHTML of version data). The footer's
   * "✎ Edit from here" loads that body into the current editor (revert-then-edit).
   */
  async function openVersionPreview(versionId: string): Promise<void> {
    if (!deps.hasActiveDoc()) return;
    try {
      const { content } = await deps.api.readVersion({ versionId });
      const body = deps.stripFrontmatter(content);
      versionModalTitle.textContent = `📄 Document @ ${versionId}`;
      versionModalBody.textContent = body; // read-only, textContent (no XSS)
      versionEditBtn.onclick = () => {
        versionModal.hidden = true;
        void deps.onEditFromVersion(versionId, body);
      };
      versionModal.hidden = false;
    } catch (e) {
      deps.log(`preview ${versionId} failed: ${String(e)}`);
    }
  }

  // --- Version picker modal (Save → restore, Export → bundle a version) ---
  const versionPickerModal = document.querySelector<HTMLDivElement>("#versionPickerModal")!;
  const versionPickerList = document.querySelector<HTMLDivElement>("#versionPickerList")!;
  const versionPickerConfirm = document.querySelector<HTMLButtonElement>("#versionPickerConfirm")!;

  // Resolves to "current", a version id, or null (cancel). Only one picker open at a time.
  let versionPickerResolve: ((v: string | null) => void) | null = null;

  function pickerSection(title: string, hint?: string): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "vpick-section";

    const header = document.createElement("div");
    header.className = "vpick-section-title";
    header.textContent = title;
    section.appendChild(header);

    if (hint) {
      const help = document.createElement("div");
      help.className = "vpick-section-hint";
      help.textContent = hint;
      section.appendChild(help);
    }

    return section;
  }

  function pickerRadio(value: string, checked = false): HTMLInputElement {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "vpick";
    radio.value = value;
    radio.checked = checked;
    return radio;
  }

  function appendVersionCopy(
    parent: HTMLElement,
    version: VersionPickerVersion,
    title = version.id,
  ): void {
    const copy = document.createElement("span");
    copy.className = "vpick-copy";

    const line = document.createElement("span");
    line.className = "vpick-titleline";

    const id = document.createElement("span");
    id.className = "vpick-versionid";
    id.textContent = title;
    line.appendChild(id);

    const cause = document.createElement("span");
    cause.className = "vpick-cause";
    cause.textContent = version.cause;
    line.appendChild(cause);

    copy.appendChild(line);
    parent.appendChild(copy);
  }

  function threadRowMeta(row: VersionPickerGraphRow): string {
    const parts: string[] = [];
    if (row.title) parts.push(deps.truncTitle(row.title, 64));
    if (row.thread) parts.push(`thread ${row.thread}`);
    if (row.turnCount !== undefined) parts.push(`${row.turnCount} turn${row.turnCount === 1 ? "" : "s"}`);
    if (row.branchFromTurn !== undefined) parts.push(`fork after turn ${row.branchFromTurn + 1}`);
    if (row.baseDoc) parts.push(row.baseDoc === "at-turn" ? "anchored at turn" : "anchored to latest");
    if (row.status && row.status !== "open") parts.push(row.status);
    if (row.baseVersion) parts.push(`based on ${row.baseVersion.id}`);
    else if (row.missingBaseVersion) parts.push(`based on missing ${row.missingBaseVersion}`);
    if (row.branchTargets.length) {
      const branches = row.branchTargets
        .map((target) => {
          const turn = target.branchFromTurn !== undefined ? ` after turn ${target.branchFromTurn + 1}` : "";
          return `${deps.truncTitle(target.title, 28)}${turn}`;
        })
        .join(", ");
      parts.push(`branches: ${branches}`);
    }
    return parts.join(" · ");
  }

  function appendRevisionGraphCell(parent: HTMLElement, cell: VersionPickerGraphCell): void {
    const lane = document.createElement("span");
    lane.className = "vpick-lane";
    if (cell.hasLine) lane.classList.add("line");
    if (cell.hasHorizontal) lane.classList.add("hline");
    if (cell.hasNode) lane.classList.add("node");
    if (cell.branchToLanes.length > 0) lane.classList.add("fork");
    if (cell.incomingFromLane !== undefined) lane.classList.add("incoming");
    lane.dataset.lane = String(cell.lane + 1);
    if (cell.branchToLanes.length > 0) {
      lane.title = `Branches to lane${cell.branchToLanes.length === 1 ? "" : "s"} ${cell.branchToLanes
        .map((targetLane) => targetLane + 1)
        .join(", ")}`;
    } else if (cell.incomingFromLane !== undefined) {
      lane.title = `Forked from lane ${cell.incomingFromLane + 1}`;
    }
    lane.appendChild(document.createElement("span")).className = "vpick-line-v";
    lane.appendChild(document.createElement("span")).className = "vpick-line-h";
    lane.appendChild(document.createElement("span")).className = "vpick-dot";
    parent.appendChild(lane);
  }

  function appendRevisionPickerRow(section: HTMLElement, row: VersionPickerGraphRow): void {
    const shell = document.createElement("label");
    shell.className = "vpick-row vpick-graph-row";
    shell.appendChild(pickerRadio(row.id));

    const graph = document.createElement("span");
    graph.className = "vpick-graph";
    graph.style.setProperty("--vpick-lanes", String(row.laneCount));
    graph.setAttribute("aria-hidden", "true");
    for (const cell of row.graphCells) appendRevisionGraphCell(graph, cell);
    shell.appendChild(graph);

    const copy = document.createElement("span");
    copy.className = "vpick-copy";

    const titleLine = document.createElement("span");
    titleLine.className = "vpick-titleline";

    const title = document.createElement("span");
    title.className = "vpick-versionid";
    title.textContent = row.version.id;
    titleLine.appendChild(title);

    const cause = document.createElement("span");
    cause.className = "vpick-cause";
    cause.textContent = row.version.cause;
    titleLine.appendChild(cause);

    copy.appendChild(titleLine);

    const meta = document.createElement("span");
    meta.className = "vpick-meta";
    meta.textContent = threadRowMeta(row);
    if (meta.textContent) copy.appendChild(meta);

    shell.appendChild(copy);
    section.appendChild(shell);
  }

  function renderVersionPicker(versions: VersionPickerVersion[]): void {
    versionPickerList.replaceChildren();

    const current = pickerSection("Current");
    const currentRow = document.createElement("label");
    currentRow.className = "vpick-row vpick-current";
    currentRow.appendChild(pickerRadio("current", true));
    appendVersionCopy(currentRow, { id: "Current working copy", cause: "unsaved editor contents" });
    current.appendChild(currentRow);
    versionPickerList.appendChild(current);

    const model = buildVersionPickerModel(versions, deps.getThreadNodes());
    if (model.graphRows.length > 0) {
      const revisions = pickerSection(
        "Revisions",
        "Newest first. Every saved revision is selectable; lanes and connectors show inferred branch divergence where available.",
      );
      for (const row of model.graphRows) appendRevisionPickerRow(revisions, row);
      versionPickerList.appendChild(revisions);
    }
  }

  async function openVersionPicker(confirmLabel: string): Promise<string | null> {
    if (!deps.hasActiveDoc()) return null;
    let versions: VersionPickerVersion[] = [];
    try {
      versions = await deps.api.listVersions({});
    } catch (e) {
      reportError("versions", e, deps.log);
      return null;
    }
    await deps.refreshThreadTree();
    renderVersionPicker(versions);
    versionPickerConfirm.textContent = confirmLabel;
    versionPickerModal.hidden = false;
    return new Promise((resolve) => {
      versionPickerResolve = resolve;
    });
  }
  function closeVersionPicker(result: string | null): void {
    versionPickerModal.hidden = true;
    const r = versionPickerResolve;
    versionPickerResolve = null;
    r?.(result);
  }
  versionPickerConfirm.addEventListener("click", () => {
    const sel =
      versionPickerList.querySelector<HTMLInputElement>('input[name="vpick"]:checked')?.value ??
      "current";
    closeVersionPicker(sel);
  });
  document
    .querySelector("#versionPickerCancel")!
    .addEventListener("click", () => closeVersionPicker(null));
  versionPickerModal.addEventListener("click", (e) => {
    if (e.target === versionPickerModal) closeVersionPicker(null);
  });

  return { openVersionPreview, openVersionPicker, versionModal };
}
