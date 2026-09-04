# Tab Bridge

Lets Claude Code (or Claude Desktop, for a quick look) read the HTML,
console logs, network requests, and screenshots of specific Firefox tabs you
explicitly allow — plus any tab on a trusted local dev server (VS Code Live
Server, by default) — without a manual click every time.

**The trust story, up front, because this extension asks for broad tab-read
permissions and that deserves a straight answer:**

- **Nothing leaves your machine.** The daemon binds to `127.0.0.1` only. The
  extension declares `data_collection_permissions: { required: ["none"] }`
  in its manifest — this isn't just a README claim, it's a manifest-level
  assertion Firefox itself surfaces to you at install time.
- **Read-only, always.** There is no tool that lets Claude grant itself
  access to a new tab. Only your click in the popup, or a tab already being
  on a trusted local dev port, does that.
- **The extension holds `<all_urls>` host permission** — Firefox shows this
  as "access your data for all websites" at install. That's required by
  `tabs.captureTab` (screenshotting a tab that isn't even the active one),
  which needs it regardless of which sites you've actually allowed. It
  doesn't widen what Claude can read: every capture (HTML, console,
  network, screenshot) is still gated behind the daemon's allow-list on
  every single tool call, the same as before this permission existed.
- **A manual "allow" lasts until you restart your browser**, not
  indefinitely — see [How allow-listing works](#how-allow-listing-works).
- **`Authorization`/`Cookie`/`Set-Cookie` headers are always redacted** in
  captured network requests. This is fixed behavior, not a setting you can
  accidentally turn off.
- **Captured logs live in memory only.** Nothing is written to disk unless
  you explicitly turn on the (separate, not-yet-built — see
  [Roadmap](#roadmap)) recording feature.

The full design reasoning lives in `tab-bridge-blueprint.md` at the repo
root — this README covers setup and usage; that doc covers *why* each of
these defaults was chosen.

## How it works

```
Firefox extension  <-- WebSocket, token-authed -->  daemon  <-- MCP (http) --  Claude Code
                                                        ^
                                                        |  MCP (stdio, via a thin shim)
                                                        |
                                                  Claude Desktop
```

One long-running local process (`tab-bridge start`) is both the WebSocket
server the extension talks to and the MCP server your MCP client talks to.
Claude Code connects to it directly over `http`. Claude Desktop's local MCP
support is stdio-only, so it instead launches `tab-bridge-mcp-stdio`, a thin
process that forwards calls to the same daemon — same allow-list, same
tools, one extra hop only for Desktop.

## Setup

### 1. Build the daemon

```bash
just install   # npm install + build + `npm link` to put `tab-bridge` on PATH
```

(No `just`? The underlying steps are `npm install`, `npm run build`, then
`cd packages/daemon && npm link && cd ../..`. `just uninstall` reverses
this — it removes the global link and cleans build output.)

Then either leave it running continuously:

```bash
tab-bridge start
# ...later, when you're done:
tab-bridge stop
```

...or manage it on demand — see [Running the daemon on demand](#running-the-daemon-on-demand)
below for a skill that starts it only when needed and stops it afterward,
the same shape as a skill that spins up a headless browser for one task.
Either way, `tab-bridge start` prints the port it's listening on and its
pairing token (also written to `~/.tab-bridge/config.json`) — you'll need
that token in a moment. `tab-bridge status` prints the same token if the
daemon is already running and you missed it the first time.

### 2. Load the extension in Firefox

This repo isn't signed/published yet (see [Roadmap](#roadmap)), so load it
as a temporary add-on for now:

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension/manifest.json`.
3. Click the Tab Bridge toolbar icon → **Settings**, paste in the pairing
   token `tab-bridge start` printed to the terminal (also in
   `~/.tab-bridge/config.json`), confirm the daemon port matches what it
   printed, and save.

(A temporary add-on unloads when Firefox restarts — you'll reload it each
session until it's signed. `npm run lint:extension` runs the same
`web-ext lint` check used before packaging a real build.)

If the popup's status badge says **wrong token** instead of **not
connected**, the daemon is running and reachable but rejected the pairing
token — re-check it against what `tab-bridge status` prints. **Not
connected** means the daemon itself isn't reachable on the configured port
(most likely `tab-bridge start` isn't running).

### 3. Point your MCP client at the daemon

**Claude Code** — `tab-bridge start` (and `tab-bridge status`) writes/refreshes
the `tab-bridge` entry in `.mcp.json` in whatever directory you ran it from,
automatically — no copy-pasting the port/token by hand. Run it from your
project root (wherever you'll launch Claude Code) and you're done; it
preserves any other `mcpServers` entries already in the file, and adds
`.mcp.json` to `.gitignore` if one exists there and doesn't already exclude
it (the file holds a live bearer token). If you'd rather wire it up by hand,
or the daemon is running from somewhere other than your project directory,
this is what it writes:

```json
{
  "mcpServers": {
    "tab-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token printed by tab-bridge start/status>" }
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tab-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/tab-bridge/packages/mcp-stdio/dist/index.js"],
      "env": {
        "TAB_BRIDGE_TOKEN": "<token printed by tab-bridge start/status>",
        "TAB_BRIDGE_URL": "http://127.0.0.1:8765/mcp"
      }
    }
  }
}
```

### 4. Allow a tab

Open the site you're working on. If it's already on a trusted local dev
port (`http://127.0.0.1:5500`/`5501` by default — VS Code Live Server's
ports), it's allowed automatically; otherwise click the Tab Bridge icon and
hit **Allow** next to the tab. Then just ask Claude about it.

Running Vite, webpack-dev-server, or Live Server on a different port? Add it
from **Settings → Trusted local dev ports** — no daemon restart or manual
JSON editing needed.

## How allow-listing works

- **Manual grants** are origin-scoped (`https://staging.example.com`, not a
  single tab) and expire the moment Firefox restarts. This is enforced by
  `browser.storage.session` — a Firefox API that's cleared by the browser
  itself on close, not by a timer the daemon has to get right.
- **Live-Server auto-approval** only ever matches an actual
  `127.0.0.1`/`localhost` origin on a port in the trusted list — a remote
  page can't claim to be "port 5500" to get in.
- A manual grant on the same origin as a trusted port **wins** over
  auto-approval, if you ever want to be more deliberate about it.
- The trusted-port list itself is edited from the extension's **Settings**
  page (add/remove ports, no daemon restart) — see [Allow a
  tab](#4-allow-a-tab).

## The five tools

All read-only: `list_allowed_tabs`, `get_page_content`, `screenshot_tab`,
`get_console_logs`, `get_network_requests`. `screenshot_tab` returns the
image as a real MCP `type: "image"` content block (plus a small text block
with `width`/`height`/`capturedAt`) — that's what makes it something Claude
actually *sees*, not just bytes it's holding; a JSON blob with a base64
string buried inside it wouldn't render as a picture to the model at all.
See `tab-bridge-blueprint.md` Section 3 for exact input/output shapes and
the standard error format (`TAB_NOT_ALLOWED`, `TAB_NOT_FOUND`, `EXTENSION_DISCONNECTED`,
`CAPTURE_FAILED`, `UNAUTHORIZED`).

## Running the daemon on demand

`tab-bridge start` and `tab-bridge status` both print the pairing token to
the terminal, so a skill or user checking on the daemon on demand can see it
immediately instead of opening `~/.tab-bridge/config.json`.

`tab-bridge stop` and PID tracking (`~/.tab-bridge/daemon.pid`) exist so the
daemon doesn't have to be a thing you remember to leave running: `skill/tab-bridge/SKILL.md`
is a Claude Code skill that checks `tab-bridge status`, starts the daemon
only if it isn't already up, does the actual tool calls, and stops it again
afterward — but only if this invocation was the one that started it, so it
never kills a daemon you (or an earlier turn) deliberately left running.
Copy `skill/tab-bridge/` into `~/.claude/skills/tab-bridge/` (available in
every project) or a project's own `.claude/skills/tab-bridge/`.

Two honest limitations, not glossed over in the skill's own instructions
either:

- **`get_console_logs`/`get_network_requests` only ever show activity
  captured while the daemon was running.** Starting it on demand means you
  get logs from that point forward, not retroactively — if you're chasing
  an error that already happened, the daemon needs to have been running
  *before* it happened. For continuous log capture, leave it running (or
  set it up as an OS autostart entry) instead of using the on-demand skill.
- **Claude Code doesn't reliably do a lazy/retry connection for HTTP MCP
  servers that weren't up at session start** (this is a known, open
  limitation, not a Tab Bridge bug). If `tab-bridge`'s tools don't show up
  right after the skill starts the daemon, run `/mcp` to reconnect. Claude
  Desktop's stdio transport is worse on this front — it won't reconnect a
  failed stdio server without the app itself relaunching it — so the
  on-demand model is really a Claude Code pattern; for Desktop, just leave
  the daemon running.

## Development

```bash
just install
just typecheck   # tsc --noEmit across the daemon and shim
just test        # vitest — unit + integration tests, no real browser needed
just lint        # web-ext lint against extension/
# or just `just check` to run all three
just uninstall   # removes the global `tab-bridge` link and cleans build output
```

The MCP integration tests spin up a real daemon and a real `ws` WebSocket
client standing in for the Firefox extension, then drive the actual MCP
tools over `http` with the official MCP TypeScript SDK client — see
`packages/daemon/test/mcpServer.integration.test.ts` for the primary-journey
test (list → get_page_content → screenshot_tab against a real allowed tab)
and the `TAB_NOT_ALLOWED`/redaction tests. What these tests can't cover —
because there's no real Firefox in CI — is the extension side: DOM capture,
`tabs.captureTab`, and the MAIN-world console hook. Those need a manual
smoke test in real Firefox after any change to `extension/`.

## Roadmap

Not built yet, on purpose — see the blueprint's MVP Build Order for the
reasoning:

- **Opt-in recording mode** (persisting a tab's captured logs to disk across
  a daemon restart, or for exporting a bug report) — deliberately built
  after the in-memory-only default is solid, not before.
- **AMO signing/publishing, npm publish, CI running for real** — this repo
  is ready for all three, but they need your own Mozilla/npm/GitHub
  accounts to actually execute.
- Cowork/cloud reachability, native-messaging transport, a DevTools-panel
  UI — explicitly out of scope for this first build.

## License

MIT — see `LICENSE`. Contributions welcome; see `CONTRIBUTING.md`.
