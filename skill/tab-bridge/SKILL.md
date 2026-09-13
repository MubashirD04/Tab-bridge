---
name: tab-bridge
description: Use when the user wants Claude to look at a specific Firefox tab they're developing in (its HTML, a screenshot, console errors, or network requests) via the Tab Bridge MCP tools (list_allowed_tabs, get_page_content, screenshot_tab, get_console_logs, get_network_requests). Starts the local tab-bridge daemon on demand if it isn't already running, and stops it afterward if this skill was the one that started it — the daemon doesn't need to be running ahead of time.
---

# Tab Bridge

Tab Bridge's five MCP tools only work while its local daemon is up and the
Firefox extension is connected to it. This skill manages that lifecycle for
you — start it, do the work, stop it — the same shape as a skill that spins
up a headless browser for one task and closes it afterward. It does **not**
manage the allow-list itself: which tabs are readable is still entirely up
to the user, via the extension's popup or a trusted local dev port. See
`tab-bridge-blueprint.md` and `README.md` in this repo for the full design.

## Prerequisites (one-time, not part of this skill's per-call flow)

- `npm install && npm run build` has been run in the tab-bridge repo.
- `cd packages/daemon && npm link` has been run once, so `tab-bridge` is on
  `PATH`. If it isn't, fall back to `node <repo>/packages/daemon/dist/cli.js`
  in every command below.
- `tab-bridge`'s MCP server is registered in `.mcp.json` (Claude Code). This
  now happens automatically — `tab-bridge start`/`status` writes/refreshes
  the `tab-bridge` entry in `.mcp.json` in the directory it's run from, which
  step 2 below does for you the first time it starts the daemon. See the
  README's Setup section for the manual alternative.

## Steps

**1. Check whether the daemon is already running.**

```bash
tab-bridge status
```

If it says the daemon is running, **do not start or stop it yourself** —
someone (the user, an OS autostart entry, or an earlier turn in this same
conversation) is already relying on it, possibly for continuous console/
network log capture. Skip straight to step 3, and skip step 5 entirely at
the end (never stop a daemon this skill invocation didn't start).

**2. If it's not running, start it detached and remember that you did.**

```bash
nohup tab-bridge start > /tmp/tab-bridge-skill.log 2>&1 &
disown
```

Then poll `tab-bridge status` (or `curl -s http://127.0.0.1:8765/health`,
adjusting the port if the user's config uses a different one) every second
for up to ~10 seconds, until it reports the daemon running. Note internally
that *this skill invocation* started it — that's what step 5 checks.

Starting the daemon from the project root also writes/refreshes the
`tab-bridge` entry in `.mcp.json` there — if this is the very first time it's
run in this project, that file is new, and step 3's "tools aren't showing up
yet" note is the expected reason (`/mcp` hasn't picked up a server that
didn't exist at session start).

**3. If the tab-bridge MCP tools don't appear in your tool list, or a system
reminder reports the `tab-bridge` server failed to connect (e.g.
`ConnectionRefused`), it connected before the daemon existed.** In this
environment that connection does not retry itself in the background — it
stays failed for the rest of the session until the server is reconnected.
So once the daemon is confirmed healthy (step 2), tell the user plainly:
*"tab-bridge is running now, but Claude Code tried to connect to it before
it was up. Please run `/mcp` and confirm the `tab-bridge` server shows as
connected, then let me know."* Don't guess or fabricate tool output, and
don't retry the tool call yourself expecting it to start working — wait for
the user to reconnect it via `/mcp` and confirm before proceeding.

**4. Do the actual work** — call `list_allowed_tabs` first to see what's
available, then whichever of `get_page_content` / `screenshot_tab` /
`get_console_logs` / `get_network_requests` the user's question needs.

One honest limitation to set expectations on: if you just started the
daemon in step 2, `get_console_logs` and `get_network_requests` will be
**empty or near-empty** — those tools only ever show activity captured
*while the daemon was running*, and it just started. If the user is asking
about an error that already happened, say so plainly rather than reporting
"no errors found" as if that were conclusive — offer to leave the daemon
running and have them reproduce the issue, so the next call actually has
something to show.

If either of those tools returns a `CAPTURE_DISABLED` error, the user hasn't
turned that kind of capture on. Don't treat it as "no errors" or "no
requests". Tell them to enable it in the extension's **Settings → Capture
permissions**, then reproduce the issue.

**5. When you're done, stop the daemon — but only if you started it.**

```bash
tab-bridge stop
```

Skip this if: (a) step 1 found it already running, or (b) the user seems to
be in an active back-and-forth debugging session where you'll likely be
asked about the same tab again shortly — in that case, say you're leaving
it running for now rather than silently doing so, and stop it at the actual
end of the task instead of after every single question.

## Claude Desktop note

This on-demand lifecycle is really a Claude Code pattern. Claude Desktop's
MCP support for `tab-bridge-mcp-stdio` is stdio-only, and Claude Code Desktop
does not reconnect a stdio server that failed at launch without the app
itself relaunching it — so starting/stopping the daemon mid-conversation
from Desktop is unlikely to help mid-session. For Desktop, it's more
reliable to just leave the daemon running (or set it up as an OS autostart
entry) than to manage its lifecycle per question.
