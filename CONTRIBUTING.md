# Contributing to Tab Bridge

Thanks for considering it. This is a small, personal-scale open-source tool
(see `tab-bridge-blueprint.md` for the full design reasoning), so the bar
here is "reasonable and tested," not "enterprise process."

## Getting set up

```bash
just install
just check
```

(`just check` runs `typecheck`, `test`, and `lint:extension` — the same
three individual recipes are available on their own, plus `just build` and
`just uninstall` to remove the global `tab-bridge` link and clean build
output. Run `just` with no arguments to list all recipes, or use the
underlying npm commands directly: `npm install`, `npm run typecheck`,
`npm test`, `npm run lint:extension`.)

All of the above should pass before you open a PR. See the README's Development
section for what the automated tests do and don't cover — extension-side
behavior (DOM capture, screenshots, the console hook) needs a manual smoke
test in real Firefox, since there's no headless-Firefox story in this repo's
CI yet.

## Where things live

- `packages/daemon` — the local daemon: allow-list, WebSocket server, MCP
  tool server. Start here for anything about matching logic, redaction, or
  the tool surface itself.
- `packages/mcp-stdio` — the thin stdio forwarder for Claude Desktop. Should
  stay thin; if you're adding real logic here, it probably belongs in the
  daemon instead.
- `extension/` — the Firefox extension. `background.js` owns the daemon
  connection and tab tracking; `content-script.js` and `console-hook.js` are
  injected only into allowed tabs.

## Security-sensitive changes

Changes to `packages/daemon/src/allowlist.ts` or `redact.ts` are the ones
most worth a careful look before merging — a bug there means either "Claude
can't see a tab it should" (annoying) or "Claude can see a tab it shouldn't"
(the actual risk this project exists to avoid). Please include a test with
any change to either file, not just a description of the fix.

## Commit style

Small, focused commits with a plain-English summary of *why*, not just
*what*, are appreciated but not required. Squash-merge is fine.

## Reporting a security issue

If you find something that would let Tab Bridge read a tab it shouldn't, or
leak captured data somewhere it shouldn't go, please open an issue — there's
no dedicated security contact yet since this is a small personal project,
but that kind of report will get priority attention.
