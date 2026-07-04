// Pure routing for OS-delivered file opens (macOS Open With / double-click).
// The drain/event wiring is exercised by the packaged-app E2E; this covers
// the dispatch logic with the repo's mocked-deps pattern (no jsdom).
import { expect, test, vi } from "vitest";
import { routeExternalPath, filterOpenablePaths, type ExternalOpenIo } from "./shell.js";

function io(overrides: Partial<ExternalOpenIo> = {}): ExternalOpenIo {
  return {
    importHadz: vi.fn(async () => ({ docPath: "/unpacked/doc.md" })),
    openInTab: vi.fn(async () => {}),
    log: vi.fn(),
    reportError: vi.fn(),
    ...overrides,
  };
}

test("markdown and html paths open directly in a tab", async () => {
  const deps = io();
  await routeExternalPath("/notes/plan.md", deps);
  await routeExternalPath("/site/page.html", deps);
  expect(deps.openInTab).toHaveBeenNthCalledWith(1, "/notes/plan.md");
  expect(deps.openInTab).toHaveBeenNthCalledWith(2, "/site/page.html");
  expect(deps.importHadz).not.toHaveBeenCalled();
});

test("hadz bundles import first, then open the unpacked doc", async () => {
  const deps = io();
  await routeExternalPath("/bundles/review.hadz", deps);
  expect(deps.importHadz).toHaveBeenCalledWith({ hadzPath: "/bundles/review.hadz" });
  expect(deps.openInTab).toHaveBeenCalledWith("/unpacked/doc.md");
});

test("hadz detection is case-insensitive", async () => {
  const deps = io();
  await routeExternalPath("/bundles/REVIEW.HADZ", deps);
  expect(deps.importHadz).toHaveBeenCalled();
});

test("hadz import failure reports and does not open a tab", async () => {
  const deps = io({ importHadz: vi.fn(async () => { throw new Error("corrupt"); }) });
  await routeExternalPath("/bad.hadz", deps);
  expect(deps.reportError).toHaveBeenCalledWith("import .hadz", expect.any(Error));
  expect(deps.openInTab).not.toHaveBeenCalled();
});

test("unsupported extensions are logged and skipped, case-insensitively", () => {
  const log = vi.fn();
  const out = filterOpenablePaths(["/a.md", "/b.pdf", "/c.HADZ", "/d.txt", "/e.markdown"], log);
  expect(out).toEqual(["/a.md", "/c.HADZ", "/e.markdown"]);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith("ignoring unsupported file from OS open: /b.pdf");
});
