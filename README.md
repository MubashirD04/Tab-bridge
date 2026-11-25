# Sharepane

Let Claude read the Firefox tabs you choose, so it can debug the page you're
working on. Claude Code or Claude Desktop gets read-only access to a shared
tab's HTML, screenshots, console logs and network requests.



https://github.com/user-attachments/assets/e66aecee-9070-42e2-8595-d681328c67a4



You decide what's shared: a tab is visible to Claude only after you turn on
**Share with Claude** in the toolbar popup. Claude can't click, type or
navigate. Sharepane sends nothing to the internet itself, but what Claude
reads from a shared tab goes to Claude, which runs on Anthropic's servers.
[TRUST.md](TRUST.md) has the details.

## Install

You need Firefox 140 or later, Node.js 18 or later, and Claude Code or Claude
Desktop, on macOS or Linux.

1. **Install the extension** from
   [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/sharepane/)
   (in Mozilla's review for its first release; until then, load it from this
   repo as described in [CONTRIBUTING.md](CONTRIBUTING.md)). Its setup page
   opens and walks you through the rest.
2. **Connect it to Claude** by running this once in a terminal:

   ```bash
   npx sharepane setup
   ```

   It registers a small helper that Firefox starts by itself, and adds the
   `sharepane` MCP server to Claude Code (for all projects) and to Claude
   Desktop if it's installed. Run it again any time to update. Add
   `--dry-run` to see what it would change first.
3. **Restart Claude Code or Claude Desktop** so it picks up the new server.

Then open the page you're working on, click the Sharepane icon and turn on
**Share with Claude**. Ask Claude about it, for example: "Why does the
checkout button do nothing when I click it?"

### Using the Claude Code plugin instead

The plugin bundles the same helper, so it needs no npm install:

```text
/plugin marketplace add MubashirD04/sharepane
/plugin install sharepane@sharepane
/sharepane:setup
```

## What Claude can do

Five read-only tools. Each one defaults to the shared tab you're looking at,
so you rarely need to name a tab.

| Tool | Returns |
| --- | --- |
| `list_allowed_tabs` | The tabs you've shared, and which one you're looking at. |
| `get_page_content` | The page's live HTML (`mode: "html"`) or its visible text (`mode: "text"`). |
| `screenshot_tab` | A screenshot of the tab, even if it isn't the active one. PNG or JPEG. |
| `get_console_logs` | Recent console output, uncaught errors, rejected promises and failed resource loads. Filter by `since` and `levels`. |
| `get_network_requests` | Recent requests with status, timing and headers, including failures and redirects. Filter by `since` and `urlFilter`. |

**Console logs, network requests and screenshots are each off** until you
turn them on in the popup or in Settings. Until then their tools say they're
turned off, so an empty result always means nothing happened, never that
capture was off. Logs and requests are kept in memory for the last 5 minutes
or 500 entries per tab, whichever is smaller.

**Tabs on local dev-server ports are shared automatically.** Out of the box
that's `localhost` and `127.0.0.1` on ports 5500 and 5501, VS Code Live
Server's. Change the list in the extension's Settings, or remove
them all to share every tab by hand.

When something goes wrong, the tools return an error with a code and a
message saying what to do:

| Code | Means |
| --- | --- |
| `EXTENSION_DISCONNECTED` | Firefox isn't running, or the extension isn't installed. |
| `TAB_NOT_ALLOWED` | That tab isn't shared, or no tab is shared yet. |
| `TAB_REQUIRED` | Several tabs are shared and you aren't looking at any of them; the message lists them. |
| `TAB_NOT_FOUND` | The tab was closed. |
| `CAPTURE_DISABLED` | Console logs, network requests or screenshots are turned off. |
| `CAPTURE_FAILED` | Firefox couldn't read the page or take the screenshot, or the page didn't answer in time. |

## Troubleshooting

Run this to check every piece and get a fix for anything that's broken:

```bash
npx sharepane doctor
```

The extension's toolbar popup also says when it can't reach the helper, and
its **Setup guide** link reopens the setup checklist.

- **The popup says the helper isn't installed.** Run `npx sharepane setup`,
  then click the toolbar icon again.
- **Claude doesn't list the Sharepane tools.** Restart Claude Code or Claude
  Desktop after setup. In Claude Code, `/mcp` shows whether `sharepane` is
  connected.
- **You moved or upgraded Node.js.** Run setup again; it points Firefox at
  the Node.js you run it with.
- **You use two Firefox profiles.** Only one can be connected at a time; the
  second one's popup says so.

## Uninstall

```bash
npx sharepane uninstall
```

That removes the helper and the Claude Code and Claude Desktop entries. Your
trusted-port list in `~/.sharepane` is kept; delete that folder too if you
want everything gone. Then remove the extension from Firefox's Add-ons page.

## Development

The extension is in [`extension/`](extension/), the helper and MCP server in
[`packages/daemon/`](packages/daemon/), and the Claude Code plugin in
[`plugins/sharepane/`](plugins/sharepane/).
[CONTRIBUTING.md](CONTRIBUTING.md) covers working on it, and
[RELEASING.md](RELEASING.md) covers releases.

## License

MIT. See [LICENSE](LICENSE). Sharepane isn't made by or affiliated with
Anthropic or Mozilla.
