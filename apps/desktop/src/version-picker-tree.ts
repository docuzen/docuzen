export interface VersionPickerVersion {
  id: string;
  cause: string;
  timestamp?: string;
  thread?: string;
  note?: string;
}

export interface VersionPickerThreadNode {
  id: string;
  parent?: string;
  branchFromTurn?: number;
  baseVersion?: string;
  baseDoc?: "latest" | "at-turn";
  title: string;
  turnCount: number;
  status: string;
  createdAt: string;
}

export interface VersionPickerBranchTarget {
  id: string;
  parent?: string;
  lane: number;
  baseVersionId?: string;
  branchFromTurn?: number;
  baseDoc?: "latest" | "at-turn";
  title: string;
  turnCount: number;
  status: string;
  createdAt: string;
}

export interface VersionPickerGraphCell {
  lane: number;
  hasLine: boolean;
  hasNode: boolean;
  hasHorizontal: boolean;
  branchToLanes: number[];
  incomingFromLane?: number;
}

export interface VersionPickerGraphRow {
  id: string;
  version: VersionPickerVersion;
  thread?: string;
  parent?: string;
  lane: number;
  laneCount: number;
  title?: string;
  turnCount?: number;
  status?: string;
  branchFromTurn?: number;
  baseDoc?: "latest" | "at-turn";
  baseVersion?: VersionPickerVersion;
  missingBaseVersion?: string;
  parentVersionIds: string[];
  childCount: number;
  branchTargets: VersionPickerBranchTarget[];
  graphCells: VersionPickerGraphCell[];
}

export interface VersionPickerTimelineRow {
  version: VersionPickerVersion;
}

export interface VersionPickerModel {
  graphRows: VersionPickerGraphRow[];
  unthreadedVersions: VersionPickerTimelineRow[];
}

const byCreated = (a: VersionPickerThreadNode, b: VersionPickerThreadNode): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const byCreatedDesc = (a: VersionPickerThreadNode, b: VersionPickerThreadNode): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

const versionNumber = (id: string): number => {
  const match = /^v(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.NaN;
};

const byVersionNewestFirst = (a: VersionPickerVersion, b: VersionPickerVersion): number => {
  if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return b.timestamp.localeCompare(a.timestamp);
  if (a.timestamp && !b.timestamp) return -1;
  if (!a.timestamp && b.timestamp) return 1;

  const an = versionNumber(a.id);
  const bn = versionNumber(b.id);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return bn - an;
  return b.id.localeCompare(a.id);
};

interface Edge {
  newerId: string;
  olderId: string;
  lane: number;
  kind: "chronological" | "branch";
  fromLane?: number;
}

type DraftGraphRow = Omit<VersionPickerGraphRow, "graphCells" | "laneCount"> & {
  directThread?: string;
};

const uniqueSortedNumbers = (values: Iterable<number>): number[] =>
  [...new Set(values)].sort((a, b) => a - b);

const pushUnique = <T>(arr: T[], value: T): void => {
  if (!arr.includes(value)) arr.push(value);
};

/**
 * Builds the save/export picker view model from independent version snapshots
 * and discussion-thread lineage. Every saved revision is returned as a
 * selectable graph row, newest first; lanes and connectors are inferred from
 * chronological order plus thread/base-version metadata.
 */
export function buildVersionPickerModel(
  versions: VersionPickerVersion[],
  threads: VersionPickerThreadNode[],
): VersionPickerModel {
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const children = new Map<string, VersionPickerThreadNode[]>();

  for (const thread of threads) {
    if (thread.parent && thread.parent !== thread.id && threadsById.has(thread.parent)) {
      const siblings = children.get(thread.parent) ?? [];
      siblings.push(thread);
      children.set(thread.parent, siblings);
    }
  }

  for (const siblings of children.values()) siblings.sort(byCreated);

  const threadLane = new Map<string, number>();
  let nextLane = 0;
  const assignLane = (thread: VersionPickerThreadNode, ancestors = new Set<string>()): void => {
    if (threadLane.has(thread.id) || ancestors.has(thread.id)) return;
    threadLane.set(thread.id, nextLane++);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(thread.id);
    for (const child of children.get(thread.id) ?? []) assignLane(child, nextAncestors);
  };

  const roots = threads
    .filter((thread) => !thread.parent || !threadsById.has(thread.parent) || thread.parent === thread.id)
    .sort(byCreated);
  for (const root of roots) assignLane(root);
  for (const thread of [...threads].sort(byCreated)) assignLane(thread);

  const branchTargetsByVersion = new Map<string, VersionPickerThreadNode[]>();
  for (const thread of threads) {
    if (!thread.baseVersion) continue;
    const targets = branchTargetsByVersion.get(thread.baseVersion) ?? [];
    targets.push(thread);
    branchTargetsByVersion.set(thread.baseVersion, targets);
  }
  for (const targets of branchTargetsByVersion.values()) targets.sort(byCreatedDesc);

  const contextFor = (version: VersionPickerVersion): VersionPickerThreadNode | undefined => {
    if (version.thread) {
      const direct = threadsById.get(version.thread);
      if (direct) return direct;
    }
    const target = branchTargetsByVersion
      .get(version.id)
      ?.find((thread) => thread.parent && threadsById.has(thread.parent));
    if (target?.parent) return threadsById.get(target.parent);
    return branchTargetsByVersion.get(version.id)?.[0];
  };

  const branchTargetFor = (thread: VersionPickerThreadNode): VersionPickerBranchTarget => {
    return {
      id: thread.id,
      ...(thread.parent ? { parent: thread.parent } : {}),
      lane: threadLane.get(thread.id) ?? 0,
      ...(thread.baseVersion ? { baseVersionId: thread.baseVersion } : {}),
      ...(thread.branchFromTurn !== undefined ? { branchFromTurn: thread.branchFromTurn } : {}),
      ...(thread.baseDoc ? { baseDoc: thread.baseDoc } : {}),
      title: thread.title,
      turnCount: thread.turnCount,
      status: thread.status,
      createdAt: thread.createdAt,
    };
  };

  const draftRows: DraftGraphRow[] = [...versions].sort(byVersionNewestFirst).map((version) => {
    const context = contextFor(version);
    const directThread = version.thread && threadsById.has(version.thread) ? version.thread : undefined;
    const lane = context ? (threadLane.get(context.id) ?? 0) : 0;
    const baseVersion = context?.baseVersion ? versionsById.get(context.baseVersion) : undefined;
    const targets = branchTargetsByVersion.get(version.id) ?? [];

    return {
      id: version.id,
      version,
      ...(context ? { thread: context.id } : {}),
      ...(context?.parent ? { parent: context.parent } : {}),
      lane,
      ...(context ? { title: context.title, turnCount: context.turnCount, status: context.status } : {}),
      ...(context?.branchFromTurn !== undefined ? { branchFromTurn: context.branchFromTurn } : {}),
      ...(context?.baseDoc ? { baseDoc: context.baseDoc } : {}),
      ...(baseVersion ? { baseVersion } : {}),
      ...(context?.baseVersion && !baseVersion ? { missingBaseVersion: context.baseVersion } : {}),
      parentVersionIds: [],
      childCount: context ? (children.get(context.id)?.length ?? 0) : 0,
      branchTargets: targets.map(branchTargetFor),
      ...(directThread ? { directThread } : {}),
    };
  });

  const rowById = new Map(draftRows.map((row) => [row.id, row]));
  const rowIndex = new Map(draftRows.map((row, index) => [row.id, index]));
  const edges: Edge[] = [];

  const addEdge = (edge: Edge): void => {
    const newer = rowById.get(edge.newerId);
    if (!newer || !rowById.has(edge.olderId)) return;
    if (edges.some((existing) => existing.newerId === edge.newerId && existing.olderId === edge.olderId)) return;
    pushUnique(newer.parentVersionIds, edge.olderId);
    edges.push(edge);
  };

  const rowsByLane = new Map<number, DraftGraphRow[]>();
  for (const row of draftRows) {
    const laneRows = rowsByLane.get(row.lane) ?? [];
    laneRows.push(row);
    rowsByLane.set(row.lane, laneRows);
  }
  for (const [lane, laneRows] of rowsByLane) {
    const ordered = laneRows.sort((a, b) => (rowIndex.get(a.id) ?? 0) - (rowIndex.get(b.id) ?? 0));
    for (let i = 0; i < ordered.length - 1; i++) {
      addEdge({ newerId: ordered[i].id, olderId: ordered[i + 1].id, lane, kind: "chronological" });
    }
  }

  for (const thread of threads) {
    if (!thread.baseVersion || !versionsById.has(thread.baseVersion)) continue;
    const branchRows = draftRows
      .filter((row) => row.directThread === thread.id)
      .sort((a, b) => (rowIndex.get(a.id) ?? 0) - (rowIndex.get(b.id) ?? 0));
    const oldestBranchRow = branchRows[branchRows.length - 1];
    const baseRow = rowById.get(thread.baseVersion);
    if (!oldestBranchRow || !baseRow) continue;
    addEdge({
      newerId: oldestBranchRow.id,
      olderId: baseRow.id,
      lane: threadLane.get(thread.id) ?? oldestBranchRow.lane,
      kind: "branch",
      fromLane: baseRow.lane,
    });
  }

  const lineLanesByRow = new Map<string, Set<number>>();
  const branchConnectorsByRow = new Map<string, Array<{ fromLane: number; toLane: number }>>();
  const incomingLaneByRow = new Map<string, number>();
  for (const edge of edges) {
    const fromIndex = rowIndex.get(edge.newerId);
    const toIndex = rowIndex.get(edge.olderId);
    if (fromIndex === undefined || toIndex === undefined) continue;
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    for (let i = start; i <= end; i++) {
      const row = draftRows[i];
      const lanes = lineLanesByRow.get(row.id) ?? new Set<number>();
      lanes.add(edge.lane);
      lineLanesByRow.set(row.id, lanes);
    }
    if (edge.kind === "branch" && edge.fromLane !== undefined && edge.fromLane !== edge.lane) {
      const olderRow = rowById.get(edge.olderId);
      if (olderRow) {
        const connectors = branchConnectorsByRow.get(olderRow.id) ?? [];
        connectors.push({ fromLane: edge.fromLane, toLane: edge.lane });
        branchConnectorsByRow.set(olderRow.id, connectors);
      }
      incomingLaneByRow.set(edge.newerId, edge.fromLane);
    }
  }

  const maxRowLane = draftRows.reduce((max, row) => Math.max(max, row.lane), 0);
  const maxThreadLane = [...threadLane.values()].reduce((max, lane) => Math.max(max, lane), 0);
  const laneCount = Math.max(1, maxRowLane + 1, maxThreadLane + 1);

  const graphRows: VersionPickerGraphRow[] = draftRows.map(({ directThread: _directThread, ...row }) => {
    const lineLanes = lineLanesByRow.get(row.id) ?? new Set<number>();
    const connectors = branchConnectorsByRow.get(row.id) ?? [];
    const graphCells: VersionPickerGraphCell[] = [];
    for (let lane = 0; lane < laneCount; lane++) {
      const outgoing = uniqueSortedNumbers(
        connectors.filter((connector) => connector.fromLane === lane).map((connector) => connector.toLane),
      );
      const hasHorizontal = connectors.some((connector) => {
        const min = Math.min(connector.fromLane, connector.toLane);
        const max = Math.max(connector.fromLane, connector.toLane);
        return lane >= min && lane <= max;
      });
      const incomingFromLane = row.lane === lane ? incomingLaneByRow.get(row.id) : undefined;
      graphCells.push({
        lane,
        hasLine: lineLanes.has(lane),
        hasNode: row.lane === lane,
        hasHorizontal,
        branchToLanes: outgoing,
        ...(incomingFromLane !== undefined ? { incomingFromLane } : {}),
      });
    }
    return { ...row, laneCount, graphCells };
  });

  return {
    graphRows,
    unthreadedVersions: [],
  };
}
