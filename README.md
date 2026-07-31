# routeros-lsp

An **offline** language server for MikroTik RouterOS `.rsc` files.

Completion and path validation come from a schema bundled with the server, so
it works with no router, no network and no credentials — on a laptop, on a
plane, against a config you were emailed.

## Features

- **Path completion** — `/interface/wire` → `wireguard`, `wireless`
- **Parameter completion** — `/interface/wireguard/add ` → `mtu=`, `private-key=`, `vrf=`
- **Unknown path diagnostics** — `/interface/wi` is flagged as an unknown segment
- **Version hints** — completion notes when a parameter is newer than most releases (`vrf` · `7.21+`)
- **Hover** — tells a menu from a command from a parameter

Works with both spellings: `/ip firewall filter` on one line with commands
below (how exports are written) and `/ip/firewall/filter add ...` inline (how
scripts are written).

## The schema

Built by merging every per-version schema published by
[`tikoci/restraml`](https://github.com/tikoci/restraml) — 60 RouterOS releases
from 7.9 to 7.24 — into one tree, with each node tagged by the versions it
appears in. Merging rather than pinning means completion still works on a
release the schema was never generated for, and on packages a given device
happens to lack.

Coverage check: of 101 distinct section paths taken from three real-world
router exports, the merged schema knows 100. A single version knows 91.

Regenerate with:

```bash
npm run schema     # requires python3; re-downloads and re-merges
```

### Known limits

The upstream schema carries no value types or ranges, so this server does not
validate values. `mtu=78000` is accepted; a diagnostic saying "expected 'auto'
or integer 0..65536" would need type data scraped separately from a live
device.

Diagnostics are deliberately conservative: a path is only flagged when its
parent menu is known, so a package missing from the schema stays silent rather
than lighting up a working config.

## Install

```bash
npm install -g @damirmanyapov/routeros-lsp
```

Then point your editor at `routeros-lsp --stdio`. For Zed, install the
[RouterOS extension](https://github.com/DamirManyapov/zed-routeros), which
handles this for you.

### Neovim

```lua
vim.lsp.config.routeros = {
  cmd = { 'routeros-lsp', '--stdio' },
  filetypes = { 'routeros' },
  root_markers = { '.git' },
}
vim.lsp.enable('routeros')
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
