#!/usr/bin/env python3
"""Collects the values each parameter accepts, from upstream deep-inspect files.

`tikoci/restraml` publishes two views of a RouterOS release. The one already
used here, `inspect.json`, is the command tree: which paths and parameters
exist. The other, `extra/deep-inspect.json`, additionally records what the
console offers when completing a value — `band=` suggests `2ghz-b`, `5ghz-ax`
and so on.

That is enough to reject `band=nonsense` without asking a router anything, and
it covers packages no single device has installed: caps-man, wireless, ppp and
mpls all appear, none of which exist on the hAP the numeric ranges came from.

What it does not carry is ranges — no `0..65536` for mtu anywhere in the file.
Those still come from a live device via `harvest-types.mjs`, and the two sets
are merged at load time rather than here, so each can be rebuilt alone.

Output, keyed the same way as types.json so the server can look up either:

    {"interface/wireguard/add|mtu": ["auto"], ...}

Usage:  python3 schema/build-choices.py
"""

import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

RAW = "https://raw.githubusercontent.com/tikoci/restraml/main/docs/{}/extra/deep-inspect.json"

CACHE = "schema/cache-deep"
OUTPUT = "schema/choices.json"

# Commands whose parameters a person writes. print/export and the rest take
# flags nobody puts in a config file, and including them triples the output.
WRITING_COMMANDS = {"add", "set", "edit"}


def versions():
    """Releases already recorded in the command schema.

    Reading them from there rather than from the GitHub API keeps this script
    off a rate limit, and guarantees the two datasets describe the same set of
    releases.
    """
    with open("schema/schema.json") as f:
        return json.load(f)["versions"]


def fetch(version):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{version}.json")
    if os.path.exists(path):
        with open(path) as f:
            return version, json.load(f)

    try:
        with urllib.request.urlopen(RAW.format(version), timeout=180) as response:
            data = json.load(response)
    except Exception:
        # Only some releases have one; a missing file is normal, not a failure.
        return version, None

    with open(path, "w") as f:
        json.dump(data, f)
    return version, data


def walk(node, path, out):
    """Records the completions of every parameter under a writing command."""
    for key, child in node.items():
        if key.startswith("_") or not isinstance(child, dict):
            continue

        here = path + [key]
        if child.get("_type") == "cmd" and key in WRITING_COMMANDS:
            for name, parameter in child.items():
                if name.startswith("_") or not isinstance(parameter, dict):
                    continue
                if parameter.get("_type") != "arg":
                    continue

                completion = parameter.get("_completion")
                if not isinstance(completion, dict):
                    continue

                # Only bare words are values a person types; the console also
                # offers punctuation that starts an expression or a string.
                values = [
                    value
                    for value in completion
                    if value and value[0].isalnum() and value.strip() == value
                ]
                if not values:
                    continue

                out.setdefault("/".join(here) + "|" + name, set()).update(values)

        walk(child, here, out)


def main():
    available = versions()
    print(f"{len(available)} releases upstream", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch, available))

    found = [(v, d) for v, d in results if d]
    print(f"{len(found)} carry deep-inspect", file=sys.stderr)

    # Merged across releases: a value valid in any of them is worth offering,
    # since the file being edited may target any version.
    merged = {}
    for _, data in found:
        walk(data, [], merged)

    out = {key: sorted(values) for key, values in merged.items()}
    with open(OUTPUT, "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)

    size = os.path.getsize(OUTPUT)
    print(
        f"wrote {OUTPUT}  {len(out)} parameters  {size/1024:.0f} KB",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
