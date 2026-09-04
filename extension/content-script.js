// Isolated-world content script — injected once per allowed tab by
// background.js's ensureCapturePipeline(). Two jobs:
//   1. Relay console events posted by console-hook.js (MAIN world) up to the
//      background script, since MAIN-world code can't call browser.runtime.*.
//   2. Answer on-demand "read this tab's content" requests from the
//      background script (DOM access works fine from the isolated world —
//      unlike JS built-ins, the DOM itself is shared with the page).
//
// This file is only ever injected into a tab the daemon has already matched
// against the allow-list — see the comment on ensureCapturePipeline() in
// background.js for the two-layer enforcement this relies on.
(() => {
  if (window.__tabBridgeContentScriptLoaded) return;
  window.__tabBridgeContentScriptLoaded = true;

  const CONSOLE_MARKER = "__tab_bridge_console__";
  const MAX_CONTENT_CHARS = 500_000;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONSOLE_MARKER) return;
    try {
      browser.runtime.sendMessage({
        type: "console_log_relay",
        level: data.level,
        args: data.args,
        stackTrace: data.stackTrace,
      });
    } catch {
      // The extension context can go away mid-navigation; nothing to do.
    }
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "read_content") {
      try {
        const raw = message.mode === "text" ? document.body?.innerText ?? "" : document.documentElement.outerHTML;
        const truncated = raw.length > MAX_CONTENT_CHARS;
        sendResponse({ content: truncated ? raw.slice(0, MAX_CONTENT_CHARS) : raw, truncated });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
      return false; // synchronous response
    }
    if (message?.type === "read_dimensions") {
      sendResponse({
        width: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
        height: Math.round(window.innerHeight * (window.devicePixelRatio || 1)),
      });
      return false;
    }
    return undefined;
  });
})();
