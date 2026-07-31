#!/usr/bin/env python3
"""Merge per-version RouterOS schemas from tikoci/restraml into one file.

The upstream repo publishes docs/<version>/inspect.json for every RouterOS
release. Bundling one of them would tie completion to a single version, so
instead every version is merged and each node records the releases it appears
in. That keeps completion useful on any device while still allowing a
version-aware hint later ("vrf was added in 7.22").

Output shape, chosen to stay small enough to ship inside an extension:

    {
      "versions": ["7.9", ...],            # index -> version string
      "tree": {
        "interface": {
          "_t": "dir",                     # dir | cmd | arg
          "_v": [0, 1, 2, ...],            # indices into "versions"
          "wireguard": { ... }
        }
      }
    }
"""

import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

RAW = "https://raw.githubusercontent.com/tikoci/restraml/main/docs/{}/inspect.json"
API = "https://api.github.com/repos/tikoci/restraml/contents/docs"

CACHE = "cache"


def version_key(v):
    """Sort 7.9 before 7.10, and betas before their release."""
    main, _, pre = v.partition("beta")
    main, _, rc = main.partition("rc")
    parts = [int(x) if x.isdigit() else 0 for x in main.split(".")]
    while len(parts) < 3:
        parts.append(0)
    # a release outranks its own prereleases
    stage = 2
    if rc:
        stage, num = 1, int(rc or 0)
    elif pre:
        stage, num = 0, int(pre or 0)
    else:
        num = 0
    return (*parts, stage, num)


def list_versions():
    with urllib.request.urlopen(API, timeout=60) as r:
        entries = json.load(r)
    return sorted(
        (e["name"] for e in entries if e["type"] == "dir"), key=version_key
    )


def fetch(version):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{version}.json")
    if os.path.exists(path):
        with open(path) as f:
            return version, json.load(f)
    try:
        with urllib.request.urlopen(RAW.format(version), timeout=120) as r:
            data = json.load(r)
    except Exception as exc:
        print(f"  skip {version}: {exc}", file=sys.stderr)
        return version, None
    with open(path, "w") as f:
        json.dump(data, f)
    return version, data


def merge(dst, src, idx):
    """Fold one version's tree into the accumulator, tagging each node."""
    for key, node in src.items():
        if key.startswith("_"):
            continue
        if not isinstance(node, dict):
            continue
        slot = dst.setdefault(key, {"_t": node.get("_type"), "_v": []})
        # A node can change kind across versions; the newest wins, and dirs
        # outrank cmds so a path that gained subcommands still completes.
        kind = node.get("_type")
        if kind == "dir" or slot.get("_t") is None:
            slot["_t"] = kind
        slot["_v"].append(idx)
        merge(slot, node, idx)


def compact(node, all_count):
    """Drop the version list where a node exists in every release."""
    for key, child in list(node.items()):
        if key.startswith("_"):
            continue
        vs = child.get("_v", [])
        if len(vs) == all_count:
            del child["_v"]
        else:
            # store as ranges to cut file size
            child["_v"] = vs
        compact(child, all_count)


def main():
    versions = list_versions()
    print(f"{len(versions)} versions", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch, versions))

    ok = [(v, d) for v, d in results if d]
    print(f"fetched {len(ok)}", file=sys.stderr)

    tree = {}
    kept = []
    for version, data in ok:
        merge(tree, data, len(kept))
        kept.append(version)

    compact(tree, len(kept))

    out = {"versions": kept, "tree": tree}
    with open("routeros-schema.json", "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)

    size = os.path.getsize("routeros-schema.json")
    print(f"wrote routeros-schema.json  {size/1024/1024:.2f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
