// docdPort() precedence: injected __DOCD_PORT__ (packaged app) > ?docdPort=
// query > VITE_DOCD_PORT > 8137. No jsdom here (repo convention) — location
// is stubbed with a plain object.
import { afterEach, expect, test } from "vitest";
import { docdPort } from "./rpc.js";

const g = globalThis as { __DOCD_PORT__?: number; location?: { search: string } };

afterEach(() => {
  delete g.__DOCD_PORT__;
  delete g.location;
});

test("injected __DOCD_PORT__ wins", () => {
  g.location = { search: "" };
  g.__DOCD_PORT__ = 4321;
  expect(docdPort()).toBe(4321);
});

test("falls back to the default port without injection", () => {
  g.location = { search: "" };
  expect(docdPort()).toBe(8137);
});

test("query param still works when nothing is injected", () => {
  g.location = { search: "?docdPort=9999" };
  expect(docdPort()).toBe(9999);
});
