# sharepane

Let Claude read the Firefox tabs you choose: page HTML, screenshots, console
logs and network requests. Read-only. Sharepane itself sends nothing to the
internet; what you share goes to Claude, which runs on Anthropic's servers.

This package is the local half of [Sharepane](https://github.com/MubashirD04/sharepane).
You also need the Sharepane Firefox extension.

## Set up

```bash
npx sharepane setup
```

That registers a small helper that Firefox starts by itself, and adds the
`sharepane` MCP server to Claude Code (and Claude Desktop, if installed).
Run it again any time to update. Requires Node.js 18 or later.

Then, in Firefox, click the Sharepane toolbar icon and turn on
**Share with Claude** for the tab you're working on.

Using the Claude Code plugin instead? Run `/sharepane:setup` in Claude.

## Commands

| Command | What it does |
| --- | --- |
| `npx sharepane setup` | Connect Firefox and Claude. `--dry-run` shows what it would change. |
| `npx sharepane doctor` | Check every piece and say how to fix what's broken. |
| `npx sharepane uninstall` | Undo setup. Your allow-list is kept. |

## Tools Claude gets

`list_allowed_tabs`, `get_page_content`, `screenshot_tab`, `get_console_logs`,
`get_network_requests`. They default to the shared tab you're looking at.
Console logs, network requests and screenshots are each off until you turn
them on in the extension.

MIT licensed.
