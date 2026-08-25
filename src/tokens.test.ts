import { test } from "node:test";
import assert from "node:assert/strict";

import { semanticTokens, TOKEN_TYPES, TOKEN_MODIFIERS } from "./tokens.js";

/** Decodes the wire format back to something readable. */
function decode(lines: string[]) {
  const data = semanticTokens(lines);
  const out: { text: string; type: string; modifiers: string[] }[] = [];
  let line = 0;
  let column = 0;

  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    column = data[i] === 0 ? column + data[i + 1]! : data[i + 1]!;
    out.push({
      text: (lines[line] ?? "").slice(column, column + data[i + 2]!),
      type: TOKEN_TYPES[data[i + 3]!]!,
      modifiers: TOKEN_MODIFIERS.filter((_, bit) => data[i + 4]! & (1 << bit)),
    });
  }
  return out;
}

test("a declared variable is marked as defined", () => {
  const found = decode([":local counter 1;", ":put $counter"]);
  const use = found.find((t) => t.text === "$counter");
  assert.ok(use?.modifiers.includes("definition"));
});

test("an undeclared variable carries no modifier", () => {
  const found = decode([":put $missing"]);
  assert.deepEqual(found[0]?.modifiers, []);
  assert.equal(found[0]?.type, "variable");
});

test("that difference is what a theme colours on", () => {
  const found = decode([":local a 1;", ":put $a", ":put $b"]);
  const a = found.find((t) => t.text === "$a");
  const b = found.find((t) => t.text === "$b");
  assert.notDeepEqual(a?.modifiers, b?.modifiers);
});

test("a loop counter is read-only", () => {
  const found = decode([":foreach i in=[/interface find] do={ :put $i }"]);
  const binding = found.find((t) => t.text === "i");
  assert.ok(binding?.modifiers.includes("readonly"));
});

test("a global is both declared and defined", () => {
  const found = decode([":global shared 1;"]);
  assert.deepEqual(found[0]?.modifiers, ["declaration", "definition"]);
});

test("a function is typed as one, not as a variable", () => {
  const found = decode([":local fn do={ :put 1 };", "$fn"]);
  assert.equal(found.find((t) => t.text === "fn")?.type, "function");
  assert.equal(found.find((t) => t.text === "$fn")?.type, "function");
});

test("positional arguments are parameters", () => {
  const found = decode([":local fn do={ :put $1 };"]);
  const arg = found.find((t) => t.text === "$1");
  assert.equal(arg?.type, "parameter");
  assert.ok(arg?.modifiers.includes("readonly"));
});

test("scripts inside quoted values are left alone", () => {
  // Their variables belong to another script's scope.
  assert.deepEqual(decode(['add on-event="{:put \\$other}"']), []);
});

test("a config with no scripting produces nothing", () => {
  assert.deepEqual(decode(["/ip firewall filter", "add chain=input action=accept"]), []);
});

test("positions are emitted in order", () => {
  const data = semanticTokens([":local a 1;", ":local b 2;", ":put ($a + $b)"]);
  for (let i = 0; i < data.length; i += 5) {
    assert.ok(data[i]! >= 0, "line deltas must never go backwards");
  }
});
