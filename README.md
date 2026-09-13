# Tab Bridge

Lets Claude Code (or Claude Desktop) read the HTML, console logs, network
requests, and screenshots of specific Firefox tabs you explicitly allow —
without a manual click every time.

**Trust, in brief:** nothing leaves your machine (daemon binds to
`127.0.0.1` only), everything is read-only, and console/network capture is
off by default until you opt in per-tab. Full details in
[TRUST.md](TRUST.md).

## How it works

```
Firefox extension  <-- WebSocket, token-authed -->  daemon  <-- MCP -- Claude Code / Desktop
```

One local process (`tab-bridge start`) talks to the extension and to your
MCP client.

## Setup

**1. Build and start the daemon**

```bash
just install     # npm install + build + link `tab-bridge` onto PATH
tab-bridge start # prints a port and pairing token
```

**2. Load the extension in Firefox**

Not signed/published yet, so load it temporarily:

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `extension/manifest.json`.
3. Click the toolbar icon → **Settings** → paste in the pairing token
   printed above, confirm the port, save.

**3. Point your MCP client at the daemon**

Claude Code: run `tab-bridge start` from your project root — it writes the
`tab-bridge` entry into `.mcp.json` for you automatically.

Claude Desktop: add an entry to `claude_desktop_config.json` pointing at
`packages/mcp-stdio/dist/index.js` with the token/URL as env vars. See
[SETUP.md](SETUP.md) for the exact JSON.

**4. Allow a tab**

Open the site, click the Tab Bridge icon, hit **Allow**. Tabs on a trusted
local dev port (e.g. VS Code Live Server on `127.0.0.1:5500`) are allowed
automatically. Then just ask Claude about it.

## The tools

Five read-only MCP tools: `list_allowed_tabs`, `get_page_content`,
`screenshot_tab`, `get_console_logs`, `get_network_requests`. The last two
need a separate opt-in from the extension's **Settings → Capture
permissions** — see [DETAILS.md](DETAILS.md).

## Development

```bash
just check   # typecheck + test + lint
```

See [DETAILS.md](DETAILS.md) for test coverage notes, and
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## More info

- [TRUST.md](TRUST.md) — the full trust/permissions story
- [SETUP.md](SETUP.md) — detailed setup, on-demand daemon usage, troubleshooting
- [DETAILS.md](DETAILS.md) — allow-listing internals, capture permission internals, tool schemas, test coverage
- [tab-bridge-blueprint.md](tab-bridge-blueprint.md) — design reasoning behind these defaults
- [Roadmap](DETAILS.md#roadmap)

## License

MIT — see `LICENSE`. Contributions welcome; see `CONTRIBUTING.md`.
