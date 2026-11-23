// docdPort() precedence: injected __DOCD_PORT__ (packaged app) > ?docdPort=
// query > VITE_DOCD_PORT > 8137. docdToken() resolves the same way: injected
// __DOCD_TOKEN__ > ?docdToken= > VITE_DOCD_TOKEN > none. No jsdom here (repo
// convention) — location is stubbed with a plain object.
import { afterEach, expect, test } from "vitest";
import { docdPort, docdToken } from "./rpc.js";

const g = globalThis as { __DOCD_PORT__?: number; __DOCD_TOKEN__?: string; location?: { search: string } };

afterEach(() => {
  delete g.__DOCD_PORT__;
  delete g.__DOCD_TOKEN__;
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

test("injected __DOCD_TOKEN__ wins over the query", () => {
  g.location = { search: "?docdToken=from-query" };
  g.__DOCD_TOKEN__ = "from-shell";
  expect(docdToken()).toBe("from-shell");
});

test("the ?docdToken= query param is used when nothing is injected", () => {
  g.location = { search: "?docdPort=9999&docdToken=abc%2Bdef" };
  expect(docdToken()).toBe("abc+def");
});

test("no token anywhere reads as empty (and never throws without a location)", () => {
  g.location = { search: "" };
  expect(docdToken()).toBe("");
  delete g.location;
  expect(docdToken()).toBe("");
});
