#!/usr/bin/env python3
"""Shrink the merged schema so it is cheap to ship and to load.

Two thirds of the raw file is per-node version lists. Almost every node exists
in a contiguous span of releases — introduced once, still present — so the
lists collapse into ranges. Node kinds are folded into a single-character tag.
"""

import json
import os

KIND = {"dir": "d", "cmd": "c", "arg": "a"}


def to_ranges(indices):
    out = []
    start = prev = indices[0]
    for i in indices[1:]:
        if i == prev + 1:
            prev = i
            continue
        out.append(start if start == prev else [start, prev])
        start = prev = i
    out.append(start if start == prev else [start, prev])
    return out


def convert(node, total, out):
    for key, child in node.items():
        if key.startswith("_"):
            continue
        entry = {}
        kind = KIND.get(child.get("_t"))
        if kind:
            entry["k"] = kind
        vs = child.get("_v")
        if vs is not None and len(vs) != total:
            entry["v"] = to_ranges(vs)
        kids = {}
        convert(child, total, kids)
        if kids:
            entry["c"] = kids
        out[key] = entry


def main():
    src = json.load(open("schema/routeros-schema.json"))
    total = len(src["versions"])
    tree = {}
    convert(src["tree"], total, tree)
    out = {"versions": src["versions"], "tree": tree}
    with open("schema/schema.json", "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)
    print("schema/schema.json  %.2f MB" % (os.path.getsize("schema/schema.json") / 1048576))


if __name__ == "__main__":
    main()
