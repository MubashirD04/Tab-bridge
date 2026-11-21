---
name: sharepane
description: Use when the user wants Claude to look at a page open in their Firefox — its HTML or text, a screenshot, console errors, or network requests — for example "why does the button on my page look off?", "what's erroring in the console?", or "is the API call failing?". Uses the Sharepane MCP tools (list_allowed_tabs, get_page_content, screenshot_tab, get_console_logs, get_network_requests).
---

# Sharepane

Sharepane lets you read Firefox tabs the user has chosen to share. Everything
is read-only and local. The user controls which tabs are shared, from the
Sharepane toolbar icon (**Share with Claude**); tabs on a trusted local
dev-server port (VS Code Live Server's 5500 by default) are shared
automatically. You can't share a tab yourself, and shouldn't try to work
around that.

## Using the tools

- **You usually don't need a `tabId`.** Every tool defaults to the shared tab
  the user is looking at (or the only shared tab), and every result says
  which tab it used. Call `list_allowed_tabs` when you need to choose between
  several, or when a call returns `TAB_REQUIRED` — that error lists the
  choices.
- Start with `get_page_content` (`mode: "text"` for what the user reads,
  `"html"` for structure and styling questions). Use `screenshot_tab` for
  anything visual: layout, alignment, colours, overflow.
- `get_console_logs` and `get_network_requests` only contain activity
  captured since Firefox started (or since capture was turned on). If the
  user asks about something that happened earlier and you find nothing, say
  so and ask them to reproduce it, rather than reporting "no errors".

## Errors and what to tell the user

| Error | Meaning | Tell the user |
| --- | --- | --- |
| `CAPTURE_DISABLED` | Console logs, network requests or screenshots are switched off (they all start off). It does **not** mean "no errors". | Turn it on under "Claude can also see" in the Sharepane toolbar popup, then reproduce the issue. Screenshots ask Firefox for access to all sites, which is why they're separate. |
| `TAB_NOT_ALLOWED` | The tab isn't shared, or nothing is shared yet. | Open the page and turn on **Share with Claude** from the Sharepane toolbar icon. |
| `TAB_REQUIRED` | Several tabs are shared and the one in front isn't one of them. | Nothing — pick a `tabId` from the error's list, or ask which tab they mean. |
| `EXTENSION_DISCONNECTED` | Firefox isn't open, or Sharepane isn't set up. | Open Firefox. If it's open, run `/sharepane:setup` (or `npx sharepane setup`). |

Never invent tool output. If the tools aren't available at all, suggest
`/sharepane:setup`.
