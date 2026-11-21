# Native-messaging prototype: findings (rebuild step 1)

Tested 2026-11-21 on macOS, Firefox via `web-ext run` with
`extensions.background.idle.timeout=5000` (5s instead of the default 30s).
The extension has no keep-alive code: no alarms, no heartbeats.

| Question | Result |
| --- | --- |
| Does Firefox launch the host itself on `connectNative()`? | Yes. The host started about 0.5s after the background page loaded. |
| Does an open native port keep the event page alive? | Yes. 13 requests 10s apart (each gap twice the idle timeout) over 2 minutes all hit the **same** background page and the **same** host PID. |
| Can a separate process reach the extension without a port or token? | Yes. A Unix socket (`~/.tab-bridge/*.sock`, mode 0600 in a 0700 directory) round trip took 1–5ms. |
| Does the host shut down with the browser? | Yes. Firefox sends SIGTERM on quit, and the host exited cleanly and removed its socket. |

## What this means for the rebuild

- The three-alarm keep-alive workaround in `extension/background.js` and
  the WebSocket reconnect logic can be removed.
- Console and network logs can be captured for as long as Firefox is open,
  so the on-demand-daemon trade-off goes away.
- The pairing token, port config and "wrong token" state can all be
  removed. File permissions on the socket replace the bearer token.

## Gotchas to carry forward

- **Absolute node path.** Firefox started from the Dock gets only the
  minimal GUI PATH, so the host manifest must point at a wrapper that
  `exec`s an absolute node binary. `install.mjs` does this, and
  `tab-bridge setup` must too.
- **The host only exists while Firefox is open.** The MCP server must
  give a clear error ("open Firefox") when the socket is missing,
  instead of hanging.
- **One host per Firefox profile.** If two profiles both run the
  extension, both spawn hosts that fight over the same socket path. The
  real host should include a profile or instance id in the socket name,
  or refuse to start if the socket is live.
- Not tested yet: Linux paths (handled in `install.mjs`, untested),
  Windows (manifest goes in the registry), and a 30+ minute soak.

## Reproduce

```bash
node prototypes/native-messaging/install.mjs
npx web-ext run --source-dir=prototypes/native-messaging/extension --pref=extensions.background.idle.timeout=5000
node prototypes/native-messaging/client.mjs 13 10
node prototypes/native-messaging/install.mjs --uninstall
```
