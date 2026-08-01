#!/usr/bin/env node
/**
 * Summarises what a schema rebuild changed, for the body of an update PR.
 *
 * A diff of a minified 1 MB JSON file tells a reviewer nothing. What matters
 * is which RouterOS releases appeared and which commands came or went, so that
 * is what this prints — as Markdown, ready to paste.
 *
 * Usage: node schema/describe-changes.mjs old.json new.json
 */

import { readFileSync } from "node:fs";

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) {
  console.error("usage: node schema/describe-changes.mjs <old> <new>");
  process.exit(1);
}

function load(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const paths = new Set();

  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node)) {
      const here = prefix ? `${prefix}/${name}` : name;
      paths.add(here);
      if (child.c) walk(child.c, here);
    }
  };
  walk(raw.tree, "");

  return { versions: raw.versions, paths };
}

const before = load(oldPath);
const after = load(newPath);

const addedVersions = after.versions.filter((v) => !before.versions.includes(v));
const addedPaths = [...after.paths].filter((p) => !before.paths.has(p));
const removedPaths = [...before.paths].filter((p) => !after.paths.has(p));

const lines = [];

if (addedVersions.length) {
  lines.push(`Adds ${addedVersions.map((v) => `\`${v}\``).join(", ")}.`);
  lines.push("");
}

lines.push(
  `| | |`,
  `|---|---|`,
  `| Releases covered | ${before.versions.length} → ${after.versions.length} |`,
  `| Tree nodes | ${before.paths.size} → ${after.paths.size} |`,
  `| Added | ${addedPaths.length} |`,
  `| Removed | ${removedPaths.length} |`,
);

/** Groups paths by their top two segments, so a menu is one line not fifty. */
function summarise(paths, limit = 12) {
  const groups = new Map();
  for (const path of paths) {
    const key = path.split("/").slice(0, 2).join("/");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => `- \`/${key}\` — ${count}`);
}

if (addedPaths.length) {
  lines.push("", "<details><summary>Added, by menu</summary>", "");
  lines.push(...summarise(addedPaths));
  lines.push("", "</details>");
}

if (removedPaths.length) {
  lines.push("", "<details><summary>Removed, by menu</summary>", "");
  lines.push(...summarise(removedPaths));
  lines.push("", "</details>");
}

// A removal is worth a reviewer's attention: it means completion stops
// offering something, which is how a bad upstream scrape would show up.
if (removedPaths.length > addedPaths.length) {
  lines.push(
    "",
    "> More was removed than added. Worth checking upstream before merging.",
  );
}

console.log(lines.join("\n"));
