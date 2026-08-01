import { test } from "node:test";
import assert from "node:assert/strict";

import { findDuplicateProperties, findMalformedPaths, findUndeclaredVariables } from "./analyze.js";

const duplicates = (lines: string[]) =>
  findDuplicateProperties(lines).map((f) => f.message);
const undeclared = (lines: string[]) =>
  findUndeclaredVariables(lines).map((f) => f.message.match(/'\$[^']+'/)?.[0]);

test("a property given twice is reported", () => {
  assert.equal(duplicates(["/ip route add distance=1 distance=2"]).length, 1);
});

test("distinct properties are fine", () => {
  assert.deepEqual(duplicates(["/ip route add distance=1 gateway=1.1.1.1"]), []);
});

test("properties of a nested command are not duplicates of the outer one", () => {
  assert.deepEqual(
    duplicates([
      ":foreach i in=[/interface find] do={ :for j from=1 to=3 do={ :put $i } }",
    ]),
    [],
  );
});

test("nested groups address different sub-objects", () => {
  assert.deepEqual(
    duplicates(["set [ find ] channel.frequency=5180 configuration.mode=ap"]),
    [],
  );
});

test("repeatable properties are allowed twice", () => {
  assert.deepEqual(
    duplicates(["/ip firewall filter add comment=a comment=b"]),
    [],
  );
});

test("a variable with no declaration is reported", () => {
  assert.deepEqual(undeclared([":put $nope"]), ["'$nope'"]);
});

test(":local then use is clean", () => {
  assert.deepEqual(undeclared([":local a 1;", ":put $a"]), []);
});

test(":global then use is clean", () => {
  assert.deepEqual(undeclared([":global g 1;", ":put $g"]), []);
});

test("a loop variable is declared by the loop", () => {
  assert.deepEqual(
    undeclared([":foreach i in=[/interface find] do={ :put $i }"]),
    [],
  );
});

test("nested loops declare both variables", () => {
  assert.deepEqual(
    undeclared([
      ":for x from=1 to=2 do={ :for y from=1 to=2 do={ :put ($x + $y) } }",
    ]),
    [],
  );
});

test("a block sees the enclosing scope", () => {
  assert.deepEqual(undeclared([":local a 1;", ":if ($a > 0) do={ :put $a }"]), []);
});

test("a function stays callable after its body closes", () => {
  assert.deepEqual(undeclared([":local f do={ :put 1 };", "$f"]), []);
});

test("positional arguments are bound inside a function body", () => {
  assert.deepEqual(undeclared([":local f do={ :put $1 };", "$f"]), []);
});

test("a function body does not see the caller's locals", () => {
  assert.deepEqual(
    undeclared([":local a 1;", ":local f do={ :put $a };", "$f"]),
    ["'$a'"],
  );
});

test("scripts stored in a quoted value are left alone", () => {
  // Their variables are declared in another script entirely.
  assert.deepEqual(
    undeclared([
      '/system scheduler add name=x on-event="{:if ([:len \\$newips] > 0) do={',
      ':log info \\"hi\\";}}"',
    ]),
    [],
  );
});

test("a doubled separator is reported", () => {
  const found = findMalformedPaths(["/ip // address /add chain=firewall"]);
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /empty path segment/);
});

test("a slash inside a value is not a path error", () => {
  assert.deepEqual(findMalformedPaths(["add address=0.0.0.0/8 list=BOGONS"]), []);
});

test("a normal path is left alone", () => {
  assert.deepEqual(findMalformedPaths(["/ip firewall filter", "/ip/route/add gateway=1.2.3.4"]), []);
});

test("an assignment with no property name is reported", () => {
  const found = findMalformedPaths(["/ip route add =1.2.3.4"]);
  assert.match(found[0]?.message ?? "", /missing property name/);
});

test("a doubled equals is reported", () => {
  const found = findMalformedPaths(["/ip route add gateway==1.2.3.4"]);
  assert.match(found[0]?.message ?? "", /single '='/);
});

test("scripts in quoted values are left alone", () => {
  assert.deepEqual(
    findMalformedPaths(['add on-event="{:log info \\"a//b\\";}"']),
    [],
  );
});
