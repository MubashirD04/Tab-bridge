# Trust & permissions

The full trust story, because this extension asks for broad tab-read
permissions and that deserves a straight answer.

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
  indefinitely — see [DETAILS.md § How allow-listing works](DETAILS.md#how-allow-listing-works).
- **Credential headers are always redacted** in captured network requests:
  `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`,
  `X-API-Key`, `X-Auth-Token`, `X-Access-Token`, `X-CSRF-Token`,
  `X-XSRF-Token` and `X-Amz-Security-Token`. This is fixed behavior, not a
  setting you can accidentally turn off.
- **Captured logs live in memory only.** Nothing is written to disk unless
  you explicitly turn on the (separate, not-yet-built — see
  [Roadmap](DETAILS.md#roadmap)) recording feature.
- **Console logs and network requests are opt-in and off by default.**
  `get_console_logs`/`get_network_requests` return a `CAPTURE_DISABLED`
  error for a tab until you turn on the matching toggle in the extension's
  **Settings → Capture permissions** — allowing a tab only ever grants page
  content/screenshot access on its own. See
  [DETAILS.md § Capture permissions](DETAILS.md#capture-permissions).

The full design reasoning lives in `tab-bridge-blueprint.md` at the repo
root — this covers *what* the defaults are; that doc covers *why* each one
was chosen.
