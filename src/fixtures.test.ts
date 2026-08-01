import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findDuplicateProperties, findMalformedPaths, findUndeclaredVariables } from "./analyze.js";

/**
 * Every fixture is valid RouterOS, so any diagnostic raised against one is a
 * false positive. That is the failure this guards against: warning on a
 * working config costs a user far more than missing a typo, and both bugs
 * caught during development were of exactly this kind.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");

/**
 * RouterOS sets `$action`, `$keepUsers` and similar before running a device's
 * configuration script, so the factory fixtures read names nothing declares.
 * Whether such a name is supplied or misspelled cannot be told from one file;
 * these are the ones the shipped configuration genuinely relies on.
 */
const SUPPLIED_BY_SYSTEM = new Set([
  "action",
  "keepUsers",
  "defconfWpsPassword",
]);

for (const name of readdirSync(fixtures).filter((f) => f.endsWith(".rsc"))) {
  test(`${name} raises no diagnostics`, () => {
    const lines = readFileSync(join(fixtures, name), "utf8").split(/\r?\n/);
    const found = [
      ...findDuplicateProperties(lines),
      ...findUndeclaredVariables(lines).filter((f) => {
        const variable = /'\$([A-Za-z0-9_-]+)'/.exec(f.message)?.[1] ?? "";
        return !SUPPLIED_BY_SYSTEM.has(variable);
      }),
      ...findMalformedPaths(lines),
    ];

    const report = found
      .map((f) => `  line ${f.line + 1}: ${f.message}\n    > ${lines[f.line]?.trim()}`)
      .join("\n");
    assert.equal(found.length, 0, `unexpected diagnostics in ${name}:\n${report}`);
  });
}
