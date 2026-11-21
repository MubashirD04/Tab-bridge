# Trust and permissions

Sharepane lets an AI read your browser tabs, so here's exactly what it can
reach, what it can't, and where the data goes.

## What Claude can see

- **Only tabs you share.** A tab is visible to Claude after you turn on
  **Share with Claude** in the toolbar popup. Sharing covers every tab on
  that site (its origin, like `https://staging.example.com`) until Firefox
  restarts, or until you turn it off.
- **Tabs on trusted local dev-server ports are shared automatically.** By
  default that's `localhost` and `127.0.0.1` on ports 5500 and 5501, used by
  VS Code Live Server. The popup marks these tabs as shared by Settings, and
  you can change or empty the list there. A remote site can't qualify: it
  has to really be `localhost` or `127.0.0.1` on a listed port.
- **Never private-browsing tabs.** They're skipped entirely.
- **Read-only.** None of the tools can click, type, navigate, run code of
  Claude's choosing on the page, or share another tab. Only you can share a
  tab.
- **Console logs, network requests and screenshots are each off** until you
  turn them on. Sharing a tab on its own gives Claude the page's HTML and
  text, nothing more.
- **Credential headers are always redacted** in network requests, and you
  can't turn that off: `Authorization`, `Cookie`, `Set-Cookie`,
  `Proxy-Authorization`, `X-API-Key`, `X-Auth-Token`, `X-Access-Token`,
  `X-CSRF-Token`, `X-XSRF-Token` and `X-Amz-Security-Token`. Other headers
  and URLs are passed on as they are, so if a site puts a secret in a URL,
  Claude can see it. Request and response bodies aren't captured.

## Where the data goes

- **Sharepane sends nothing to the internet itself.** The extension talks
  only to the Sharepane helper on your computer, using Firefox's native
  messaging: Firefox starts the helper and they exchange messages over a
  pipe. There's no network port and nothing to pair.
- **The helper hands shared data to Claude Code or Claude Desktop** on your
  computer, through a socket in `~/.sharepane/` that only your user account
  can open (permissions 0600, in a 0700 folder).
- **Claude runs on Anthropic's servers**, so whatever Claude reads from a
  shared tab is sent to Anthropic, like anything else you give Claude. Share
  only what you'd be comfortable pasting into a chat.
- **No analytics or telemetry**, from the extension or the helper.

The extension's manifest declares this to Firefox as `websiteContent` and
`browsingActivity` data collection, which Firefox shows you before you
install.

## What's stored on your computer

- **Captured console logs and network requests stay in memory**: the last 5
  minutes or 500 entries per tab, whichever is smaller. They're gone when
  Firefox closes.
- **`~/.sharepane/allowlist.json`** holds your trusted-port list and the
  sites you've shared, each tied to the Firefox session you shared it in.
  A share from an earlier session no longer counts.
- **`~/.sharepane/daemon.log`** records events such as "tab shared" or
  "helper started", with tab numbers but no URLs or page content.
- The extension stores your capture switches in Firefox's own extension
  storage.

## Permissions the extension asks for

Required at install:

| Permission | Why |
| --- | --- |
| `nativeMessaging` | To talk to the helper. Only Sharepane's extension ID may start it. |
| `tabs` | To know which tab you're on and show the per-tab "ON" badge. |
| `scripting` | To read a shared page's HTML and, if you turn it on, its console. |
| `storage` | To remember your capture switches. |
| Access to `localhost` and `127.0.0.1` | For trusted dev-server ports. |

Optional, asked for only when you turn on the feature, and given back when
you turn it off:

| Permission | Asked for when |
| --- | --- |
| Access to one site | You share a tab on that site. Firefox asks you to confirm. |
| Access to all sites | You turn on screenshots. Firefox's screenshot API (`tabs.captureTab`) only works with it. Claude still sees only the tabs you share. |
| `webRequest` | You turn on network requests. |

## Checking it yourself

Everything here is in this repository: the extension in
[`extension/`](extension/) (not minified or bundled), the helper in
[`packages/daemon/`](packages/daemon/). Redaction is in
[`redact.ts`](packages/daemon/src/redact.ts) and the sharing rules in
[`allowlist.ts`](packages/daemon/src/allowlist.ts) and
[`tabSessions.ts`](packages/daemon/src/tabSessions.ts). If you find a way
for Sharepane to read a tab it shouldn't, please
[open an issue](https://github.com/MubashirD04/sharepane/issues).
