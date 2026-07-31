import { test } from "node:test";
import assert from "node:assert/strict";

import { checkValue, type ValueType } from "./types.js";

const MTU: ValueType = {
  spec: "auto | Num",
  kind: "integer",
  min: 0,
  max: 65536,
  literals: ["auto"],
};
const DISTANCE: ValueType = { spec: "Num", kind: "integer", min: 1, max: 255 };
const ADDRESS: ValueType = { spec: "A.B.C.D    (IP address)", kind: "ip" };

test("a value in range passes", () => {
  assert.equal(checkValue(MTU, "1420"), null);
});

test("a value above the maximum is reported", () => {
  assert.match(checkValue(MTU, "78000") ?? "", /0\.\.65536/);
});

test("a negative value is reported", () => {
  assert.match(checkValue(MTU, "-5") ?? "", /0\.\.65536/);
});

test("a word where a number belongs is reported", () => {
  assert.match(checkValue(MTU, "hello") ?? "", /expected 'auto' or integer/);
});

test("a declared literal passes", () => {
  assert.equal(checkValue(MTU, "auto"), null);
});

test("distance respects its own range", () => {
  assert.equal(checkValue(DISTANCE, "1"), null);
  assert.equal(checkValue(DISTANCE, "255"), null);
  assert.notEqual(checkValue(DISTANCE, "300"), null);
  assert.notEqual(checkValue(DISTANCE, "0"), null);
});

test("a computed value is left alone", () => {
  assert.equal(checkValue(MTU, "$mtu"), null);
  assert.equal(checkValue(MTU, "[/interface get x mtu]"), null);
  assert.equal(checkValue(MTU, "($a + 1)"), null);
});

test("a quoted value is left alone", () => {
  assert.equal(checkValue(MTU, '"1420"'), null);
});

test("lists are left alone", () => {
  assert.equal(checkValue(MTU, "1420,1500"), null);
});

test("hex is accepted for integers", () => {
  assert.equal(checkValue(MTU, "0x1A"), null);
});

test("an IP address is checked", () => {
  assert.equal(checkValue(ADDRESS, "192.168.1.1"), null);
  assert.equal(checkValue(ADDRESS, "192.168.1.1/24"), null);
  assert.notEqual(checkValue(ADDRESS, "999.1.1.1"), null);
});

test("an interface name under an address parameter is left alone", () => {
  // RouterOS accepts either under several parameters.
  assert.equal(checkValue(ADDRESS, "ether1"), null);
});
