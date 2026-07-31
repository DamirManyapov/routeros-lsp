import { test } from "node:test";
import assert from "node:assert/strict";

import { contextAt, sectionAt, splitPath, tokenize } from "./parse.js";

test("splits both path spellings", () => {
  assert.deepEqual(splitPath("/ip firewall filter"), ["ip", "firewall", "filter"]);
  assert.deepEqual(splitPath("/ip/firewall/filter"), ["ip", "firewall", "filter"]);
});

test("keeps quoted strings whole", () => {
  assert.deepEqual(tokenize('add comment="hello world" name=x'), [
    "add",
    'comment="hello world"',
    "name=x",
  ]);
});

test("finds the section header above a command", () => {
  const lines = ["/ip firewall filter", "add chain=input", "add chain=forward"];
  assert.deepEqual(sectionAt(lines, 2), ["ip", "firewall", "filter"]);
});

test("an inline command does not become the section", () => {
  const lines = ["/ip firewall filter", "/tool fetch url=x", "add chain=input"];
  assert.deepEqual(sectionAt(lines, 1), ["ip", "firewall", "filter"]);
});

test("completing a path", () => {
  const ctx = contextAt("/interface/wire", []);
  assert.equal(ctx.kind, "path");
  if (ctx.kind !== "path") return;
  assert.deepEqual(ctx.segments, ["interface"]);
  assert.equal(ctx.prefix, "wire");
});

test("completing a path after a trailing slash", () => {
  const ctx = contextAt("/interface/wireguard/", []);
  assert.equal(ctx.kind, "path");
  if (ctx.kind !== "path") return;
  assert.deepEqual(ctx.segments, ["interface", "wireguard"]);
  assert.equal(ctx.prefix, "");
});

test("completing properties of an inline command", () => {
  const ctx = contextAt("/interface/wireguard/add ", []);
  assert.equal(ctx.kind, "command");
});

test("completing properties under a section header", () => {
  const ctx = contextAt("add ", ["interface", "wireguard"]);
  assert.equal(ctx.kind, "property");
  if (ctx.kind !== "property") return;
  assert.deepEqual(ctx.path, ["interface", "wireguard"]);
  assert.equal(ctx.command, "add");
});

test("a partly typed property keeps its prefix", () => {
  const ctx = contextAt("add mt", ["interface", "wireguard"]);
  assert.equal(ctx.kind, "property");
  if (ctx.kind !== "property") return;
  assert.equal(ctx.prefix, "mt");
});

test("inside a value", () => {
  const ctx = contextAt("add mtu=14", ["interface", "wireguard"]);
  assert.equal(ctx.kind, "value");
  if (ctx.kind !== "value") return;
  assert.equal(ctx.property, "mtu");
});

test("no section and no path yields nothing", () => {
  assert.equal(contextAt("add ", []).kind, "none");
});
