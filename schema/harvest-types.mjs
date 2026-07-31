#!/usr/bin/env node
/**
 * Harvests value types for every command parameter from a live RouterOS device.
 *
 * The bundled command tree carries parameter names but no types, so this fills
 * that gap once, at build time. Users never talk to a router.
 *
 * The device answers `/console/inspect request=syntax` with a type definition
 * when the input names a parameter:
 *
 *   /interface/wireguard/add mtu=1   ->  Mtu = "auto | Num"
 *                                        Num = "0..65536  (integer number)"
 *
 * Usage:
 *   ROUTER=http://192.168.88.1 USER=lsp PASS=secret \
 *     node schema/harvest-types.mjs [--out types.json] [--limit N]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROUTER = process.env.ROUTER ?? "http://192.168.188.1";
const USER = process.env.USER_NAME ?? process.env.ROUTER_USER ?? "lsp";
const PASS = process.env.PASS ?? process.env.ROUTER_PASS ?? "";

const args = process.argv.slice(2);
const outPath = valueOf("--out") ?? "schema/types.json";
const limit = Number(valueOf("--limit") ?? Infinity);
const concurrency = Number(valueOf("--concurrency") ?? 8);

function valueOf(flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

/**
 * A placeholder value per parameter, since the device parses the whole input.
 *
 * The value only has to be plausible enough for the parser to reach the
 * parameter; when it is rejected the device answers with the command's whole
 * parameter list instead of a type, which `toType` discards. Several samples
 * are tried in order.
 */
function samplesFor(name) {
  if (/(^|-)(port|priority|distance|mtu|l2mtu|weight|cost|limit|count|size)$/.test(name))
    return ["1", "x"];
  if (/(^|-)address(es)?$/.test(name)) return ["1.2.3.4", "x"];
  if (/(^|-)(time|timeout|interval|lease-time|period)$/.test(name)) return ["1h", "1", "x"];
  if (/(^|-)(mac|mac-address)$/.test(name)) return ["00:00:00:00:00:01", "x"];
  return ["x", "1", "yes"];
}

async function inspect(input, attempt = 0) {
  try {
    const response = await fetch(`${ROUTER}/rest/console/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ request: "syntax", input }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // The device drops connections under load; back off and retry twice.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return inspect(input, attempt + 1);
    }
    return null;
  }
}

/**
 * Folds the device's definition list into one type record.
 *
 * The reply names the parameter first, then defines each symbol it refers to:
 *   [{symbol: "Mtu", text: "auto | Num"}, {symbol: "Num", text: "0..65536 …"}]
 */
function toType(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // When the device does not accept the sample value it falls back to listing
  // every parameter of the command. Those replies carry no type information.
  const looksLikeParameterList =
    entries.length > 3 &&
    entries.filter((e) => /^[a-z][a-z0-9-]*$/.test(e.symbol ?? "")).length >= 3;
  if (looksLikeParameterList) return null;

  // A simple parameter comes back as one "explanation" ("time interval"); a
  // composite one as "definition" entries that reference each other.
  const definitions = entries.filter(
    (e) => e["symbol-type"] === "definition" || e["symbol-type"] === "explanation",
  );
  if (definitions.length === 0) return null;

  const head = definitions[0];
  const spec = (head.text ?? "").trim();
  if (!spec) return null;

  const record = { spec };

  // Named sub-definitions, e.g. Num = "0..65536    (integer number)"
  for (const entry of definitions.slice(1)) {
    const text = (entry.text ?? "").trim();
    const range = /^(-?\d+)\.\.(-?\d+)/.exec(text);
    if (range) {
      record.min = Number(range[1]);
      record.max = Number(range[2]);
    }
    if (/integer number/.test(text)) record.kind = "integer";
    else if (/IP address/i.test(text)) record.kind = "ip";
    else if (/time interval/i.test(text)) record.kind = "duration";
  }

  // Literal alternatives: "auto | Num" or "yes | no"
  const literals = spec
    .split("|")
    .map((part) => part.trim())
    .filter((part) => /^[a-z][a-z0-9-]*$/.test(part));
  if (literals.length) record.literals = literals;

  // The head entry may carry the type itself rather than naming a sub-symbol.
  const range = /^(-?\d+)\.\.(-?\d+)/.exec(spec);
  if (range && record.min === undefined) {
    record.min = Number(range[1]);
    record.max = Number(range[2]);
  }

  if (!record.kind) {
    if (/string value/i.test(spec)) record.kind = "string";
    else if (/A\.B\.C\.D/.test(spec)) record.kind = "ip";
    else if (/time interval/i.test(spec)) record.kind = "duration";
    else if (/integer number/i.test(spec)) record.kind = "integer";
    else if (/MAC address/i.test(spec)) record.kind = "mac";
    else if (record.min !== undefined) record.kind = "integer";
  }

  return record;
}

async function main() {
  const schema = JSON.parse(readFileSync("schema/schema.json", "utf8"));

  // Every (command path, parameter) pair in the tree.
  const targets = [];
  const walk = (node, path) => {
    for (const [name, child] of Object.entries(node)) {
      const here = [...path, name];
      if (child.k === "c") {
        for (const [param, sub] of Object.entries(child.c ?? {})) {
          if (sub.k === "a") targets.push([here, param]);
        }
      }
      if (child.c) walk(child.c, here);
    }
  };
  walk(schema.tree, []);

  const planned = targets.slice(0, limit);
  console.error(`${planned.length} parameters to inspect`);

  const results = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : {};
  let done = 0;
  let found = 0;

  const queue = planned.filter(([path, param]) => !(`${path.join("/")}|${param}` in results));
  console.error(`${planned.length - queue.length} already known, ${queue.length} to fetch`);

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [path, param] = next;
      const key = `${path.join("/")}|${param}`;

      let type = null;
      for (const sample of samplesFor(param)) {
        const reply = await inspect(`/${path.join("/")} ${param}=${sample}`);
        type = toType(reply);
        if (type) break;
      }
      // Remember misses too, so a rerun does not repeat them.
      results[key] = type;
      if (type) found++;

      done++;
      if (done % 250 === 0) {
        console.error(`  ${done}/${planned.length} — ${found} typed`);
        writeFileSync(outPath, JSON.stringify(results));
      }
    }
  });

  await Promise.all(workers);
  writeFileSync(outPath, JSON.stringify(results));
  console.error(`done: ${found} typed of ${done} inspected -> ${outPath}`);
}

main();
