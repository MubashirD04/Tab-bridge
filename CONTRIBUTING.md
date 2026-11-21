# Contributing to Sharepane

Thanks for considering it. This is a small open-source tool, so the bar is
"reasonable and tested," not enterprise process.

## Getting set up

You need Node.js 18 or later and Firefox 140 or later. The recipes below use
[`just`](https://github.com/casey/just); each one is a line or two of npm
commands you can also run directly (see the [`justfile`](justfile)).

```bash
just install    # npm install, then build
just check      # everything CI checks
```

To try your changes in Firefox:

1. **Point the helper at your build:** `just setup`. This builds the CLI and
   runs its setup, which copies the build to `~/.sharepane/bin/` and
   registers it with Firefox and Claude. Run it again after changing
   anything in `packages/daemon/`.
2. **Load the extension:** open `about:debugging#/runtime/this-firefox`,
   click **Load Temporary Add-on…** and choose `extension/manifest.json`.
   After changing anything in `extension/`, click **Reload** there.
   Temporary add-ons disappear when Firefox quits.
3. **Restart Claude Code or Claude Desktop** after the first setup, then
   share a tab and ask Claude about it. `just doctor` checks every piece.

If you've installed the released extension from addons.mozilla.org, disable
it while testing the temporary one: they share an ID.

## What `just check` covers

- **Types and tests** for the helper. The integration tests run the real
  helper with a fake extension in place of Firefox and drive the MCP tools
  through the official MCP client, so no browser is needed.
- **Extension lint** with `web-ext`.
- **Versions:** the extension, npm package and plugin must all be at the
  same version (`node scripts/version.mjs set <version>` changes all three).
- **The plugin:** its MCP server must start and list its tools.

CI also fails if `plugins/sharepane/bin/sharepane.mjs` doesn't match a fresh
build, because the plugin ships that file straight from the repo. Run
`just build` and commit it with any change to `packages/daemon/`.

Nothing automated runs the extension in a real Firefox, so changes to
`extension/` need a manual check there: sharing and unsharing a tab, page
content, screenshots, console and network capture, and the popup's states.

## Where things live

- [`extension/`](extension/): the Firefox extension. `background.js` owns
  the connection to the helper, tab tracking and permissions;
  `content-script.js` and `console-hook.js` run only in shared tabs.
- [`packages/daemon/src/`](packages/daemon/src/): the `sharepane` CLI and
  helper.
  - `host.ts`: the native-messaging host Firefox starts. It serves MCP on
    a socket in `~/.sharepane/`.
  - `mcpProxy.ts`: `sharepane mcp`, the stdio command Claude runs; it
    forwards to the host.
  - `mcpServer.ts`: the five tools.
  - `extensionBridge.ts`, `tabSessions.ts`, `allowlist.ts`: what's shared.
  - `setup.ts`: `setup`, `doctor` and `uninstall`.
- [`plugins/sharepane/`](plugins/sharepane/): the Claude Code plugin, with
  [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) at
  the repo root.
- [`store/`](store/): the addons.mozilla.org icon and screenshots, and the
  harness that regenerates them.
- [`prototypes/native-messaging/`](prototypes/native-messaging/): the
  experiment that proved native messaging works, kept for reference.

Some code comments cite "the blueprint". That's the original design document,
since removed because it described the old WebSocket design. Git history
still has it:

```bash
git show "$(git log -1 --format=%h --diff-filter=D -- sharepane-blueprint.md)^:sharepane-blueprint.md"
```

## Security-sensitive changes

Changes to what's shared (`allowlist.ts`, `tabSessions.ts`, the permission
code in `background.js`) and to `redact.ts` deserve the closest look. A bug
there means either "Claude can't see a tab it should" (annoying) or "Claude
can see a tab it shouldn't" (the risk this project exists to avoid). Please
include a test with any change to them, and keep [TRUST.md](TRUST.md)
accurate.

## Commits and releases

Small, focused commits that say why, not just what, are appreciated.
Releases are tag-driven; see [RELEASING.md](RELEASING.md).

## Reporting a security issue

If you find a way for Sharepane to read a tab it shouldn't, or to send
captured data somewhere it shouldn't go, please
[open an issue](https://github.com/MubashirD04/sharepane/issues). There's no
private security contact yet; reports like that get priority.
