import { describe, expect, it } from "vitest";
import { buildVersionPickerModel } from "./version-picker-tree.js";

describe("version picker graph model", () => {
  it("includes every revision as selectable graph rows from latest to oldest", () => {
    const model = buildVersionPickerModel(
      [
        { id: "v0001", cause: "manual-save", timestamp: "2026-06-01T10:00:00.000Z" },
        { id: "v0002", cause: "turn-base", thread: "c0001", timestamp: "2026-06-01T10:01:00.000Z" },
        { id: "v0003", cause: "manual-save", timestamp: "2026-06-01T10:02:00.000Z" },
        { id: "v0004", cause: "agent-edit", thread: "c0002", timestamp: "2026-06-01T10:03:00.000Z" },
      ],
      [
        {
          id: "c0001",
          title: "Root discussion",
          turnCount: 3,
          status: "open",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "c0003",
          parent: "c0002",
          branchFromTurn: 2,
          baseVersion: "v0004",
          baseDoc: "latest",
          title: "Nested branch",
          turnCount: 2,
          status: "open",
          createdAt: "2026-06-03T00:00:00.000Z",
        },
        {
          id: "c0002",
          parent: "c0001",
          branchFromTurn: 1,
          baseVersion: "v0002",
          baseDoc: "at-turn",
          title: "First branch",
          turnCount: 4,
          status: "open",
          createdAt: "2026-06-02T00:00:00.000Z",
        },
      ],
    );

    expect(model.graphRows.map((row) => row.id)).toEqual(["v0004", "v0003", "v0002", "v0001"]);
    expect(model.graphRows.map((row) => row.id).sort()).toEqual(["v0001", "v0002", "v0003", "v0004"]);
    expect(model.unthreadedVersions).toEqual([]);
  });

  it("keeps thread and branch divergence metadata on graph rows", () => {
    const model = buildVersionPickerModel(
      [
        { id: "v0001", cause: "manual-save", timestamp: "2026-06-01T10:00:00.000Z" },
        { id: "v0002", cause: "turn-base", thread: "c0001", timestamp: "2026-06-01T10:01:00.000Z" },
        { id: "v0003", cause: "manual-save", timestamp: "2026-06-01T10:02:00.000Z" },
        { id: "v0004", cause: "agent-edit", thread: "c0002", timestamp: "2026-06-01T10:03:00.000Z" },
      ],
      [
        {
          id: "c0001",
          title: "Root discussion",
          turnCount: 3,
          status: "open",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "c0002",
          parent: "c0001",
          branchFromTurn: 1,
          baseVersion: "v0002",
          baseDoc: "at-turn",
          title: "First branch",
          turnCount: 4,
          status: "open",
          createdAt: "2026-06-02T00:00:00.000Z",
        },
      ],
    );

    expect(model.graphRows.find((row) => row.id === "v0004")).toMatchObject({
      lane: 1,
      thread: "c0002",
      parent: "c0001",
      branchFromTurn: 1,
      baseDoc: "at-turn",
      title: "First branch",
      turnCount: 4,
      status: "open",
      parentVersionIds: ["v0002"],
    });
    expect(model.graphRows.find((row) => row.id === "v0002")).toMatchObject({
      lane: 0,
      thread: "c0001",
      branchTargets: [
        expect.objectContaining({
          id: "c0002",
          parent: "c0001",
          lane: 1,
          baseVersionId: "v0002",
          branchFromTurn: 1,
          baseDoc: "at-turn",
        }),
      ],
    });
  });

  it("infers graph lanes and connectors from chronological order plus thread base metadata", () => {
    const model = buildVersionPickerModel(
      [
        { id: "v0001", cause: "manual-save", timestamp: "2026-06-01T10:00:00.000Z" },
        { id: "v0002", cause: "turn-base", thread: "c0001", timestamp: "2026-06-01T10:01:00.000Z" },
        { id: "v0003", cause: "agent-edit", thread: "c0002", timestamp: "2026-06-01T10:02:00.000Z" },
        { id: "v0004", cause: "agent-edit", thread: "c0002", timestamp: "2026-06-01T10:03:00.000Z" },
        { id: "v0005", cause: "agent-edit", thread: "c0003", timestamp: "2026-06-01T10:04:00.000Z" },
      ],
      [
        {
          id: "c0001",
          title: "Root discussion",
          turnCount: 3,
          status: "open",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "c0002",
          parent: "c0001",
          branchFromTurn: 1,
          baseVersion: "v0002",
          baseDoc: "at-turn",
          title: "First branch",
          turnCount: 4,
          status: "open",
          createdAt: "2026-06-02T00:00:00.000Z",
        },
        {
          id: "c0003",
          parent: "c0002",
          branchFromTurn: 2,
          baseVersion: "v0004",
          baseDoc: "latest",
          title: "Nested branch",
          turnCount: 2,
          status: "open",
          createdAt: "2026-06-03T00:00:00.000Z",
        },
      ],
    );

    expect(model.graphRows.map((row) => [row.id, row.lane])).toEqual([
      ["v0005", 2],
      ["v0004", 1],
      ["v0003", 1],
      ["v0002", 0],
      ["v0001", 0],
    ]);
    expect(model.graphRows.find((row) => row.id === "v0004")).toMatchObject({
      parentVersionIds: ["v0003"],
      branchTargets: [expect.objectContaining({ id: "c0003", lane: 2, baseVersionId: "v0004" })],
    });
    expect(model.graphRows.find((row) => row.id === "v0003")).toMatchObject({
      parentVersionIds: ["v0002"],
    });
    expect(model.graphRows.find((row) => row.id === "v0002")?.graphCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 0, hasNode: true, branchToLanes: [1] }),
        expect.objectContaining({ lane: 1, hasLine: true }),
      ]),
    );
    expect(model.graphRows.find((row) => row.id === "v0005")?.graphCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 2, hasNode: true, incomingFromLane: 1 }),
      ]),
    );
  });
});
