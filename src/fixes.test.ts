import { test } from "node:test";
import assert from "node:assert/strict";

import { suggestions, fixInvalidValue, fixDuplicateProperty } from "./fixes.js";

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
};

test("a shared prefix outranks a mere near miss", () => {
  const got = suggestions("wi", ["wireguard", "wireless", "vlan", "bridge", "wifi"]);
  assert.ok(got.includes("wifi"));
  assert.ok(got.includes("wireless"));
  assert.ok(!got.includes("bridge"));
});

test("a typo resolves to its correction", () => {
  assert.deepEqual(suggestions("firewal", ["firewall", "route", "address"]), ["firewall"]);
});

test("nothing is suggested when nothing is close", () => {
  assert.deepEqual(suggestions("zzzzz", ["firewall", "route"]), []);
});

test("a number past the maximum is clamped to it", () => {
  const fixes = fixInvalidValue({ range } as never, "78000", { min: 0, max: 65536 });
  const clamp = fixes.find((f) => f.preferred);
  assert.equal(clamp?.edits[0]?.newText, "65536");
});

test("a number below the minimum is clamped to it", () => {
  const fixes = fixInvalidValue({ range } as never, "-5", { min: 0, max: 65536 });
  assert.equal(fixes.find((f) => f.preferred)?.edits[0]?.newText, "0");
});

test("literal alternatives are offered", () => {
  const fixes = fixInvalidValue({ range } as never, "hello", { literals: ["auto"] });
  assert.equal(fixes[0]?.edits[0]?.newText, "auto");
});

test("the earlier assignment is the one removed", () => {
  const line = "/ip route add distance=1 distance=2";
  const fixes = fixDuplicateProperty(
    { range: { start: { line: 0, character: 25 }, end: { line: 0, character: 33 } } } as never,
    "distance",
    [line],
  );
  const edit = fixes[0]?.edits[0];
  assert.ok(edit);
  const after = line.slice(0, edit.range.start.character) + line.slice(edit.range.end.character);
  assert.equal(after, "/ip route add distance=2");
});
