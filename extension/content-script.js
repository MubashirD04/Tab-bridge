// Isolated-world content script — injected into allowed tabs by
// background.js, either at document_start via a registered content script
// or into an already-loaded page by ensureCapturePipeline(). Two jobs:
//   1. Relay console events from console-hook.js (MAIN world) up to the
//      background script, since MAIN-world code can't call browser.runtime.*,
//      and tell the hook whether capture is active for this tab.
//   2. Answer on-demand "read this tab's content" requests from the
//      background script (DOM access works fine from the isolated world —
//      unlike JS built-ins, the DOM itself is shared with the page).
//
// The background script is the authority on whether anything is captured:
// it answers capture_state_request and re-checks the allow-list on every
// batch it receives.
(() => {
  if (window.__tabBridgeContentScriptLoaded) return;
  window.__tabBridgeContentScriptLoaded = true;

  const FROM_HOOK_EVENT = "tab-bridge:console";
  const TO_HOOK_EVENT = "tab-bridge:control";
  const MAX_CONTENT_CHARS = 500_000;
  const MAX_DETAIL_CHARS = 64_000;
  const MAX_ARGS = 10;
  const MAX_ARG_CHARS = 2100; // hook's cap plus its "…[truncated]" marker
  const MAX_STACK_CHARS = 4100;
  const BATCH_SIZE = 50;
  const BATCH_DELAY_MS = 100;
  const LEVELS = new Set(["log", "warn", "error", "info", "debug"]);
  const KINDS = new Set(["console", "uncaught", "unhandledrejection", "resource"]);

  // null until the background script has answered; only `true` forwards.
  let captureActive = null;
  let batch = [];
  let flushTimer = null;

  function tellHook() {
    if (captureActive === null) return;
    window.dispatchEvent(new CustomEvent(TO_HOOK_EVENT, { detail: JSON.stringify({ active: captureActive }) }));
  }

  function setCaptureActive(active) {
    captureActive = active;
    if (!active) batch = [];
    tellHook();
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (batch.length === 0) return;
    const entries = batch;
    batch = [];
    // The extension context can go away mid-navigation; nothing to do then.
    browser.runtime.sendMessage({ type: "console_log_batch", entries }).catch(() => {});
  }

  // The page can dispatch this event too, so treat the payload as untrusted.
  function sanitizeEntry(data) {
    if (!data || typeof data !== "object") return undefined;
    if (!LEVELS.has(data.level) || !Array.isArray(data.args)) return undefined;
    return {
      level: data.level,
      kind: KINDS.has(data.kind) ? data.kind : "console",
      time: typeof data.time === "number" ? data.time : undefined,
      args: data.args.slice(0, MAX_ARGS).map((a) => String(a).slice(0, MAX_ARG_CHARS)),
      stackTrace: typeof data.stackTrace === "string" ? data.stackTrace.slice(0, MAX_STACK_CHARS) : undefined,
    };
  }

  window.addEventListener(FROM_HOOK_EVENT, (event) => {
    const detail = event.detail;
    if (typeof detail !== "string" || detail.length > MAX_DETAIL_CHARS) return;
    let data;
    try {
      data = JSON.parse(detail);
    } catch {
      return;
    }
    if (data?.ready === true) {
      tellHook(); // the hook loaded after we already knew the state
      return;
    }
    if (captureActive !== true) return;
    const entry = sanitizeEntry(data);
    if (!entry) return;
    batch.push(entry);
    if (batch.length >= BATCH_SIZE) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DELAY_MS);
  });

  window.addEventListener("pagehide", flush);

  browser.runtime
    .sendMessage({ type: "capture_state_request" })
    .then((state) => {
      // A push from the background may already have set this more recently.
      if (captureActive === null) setCaptureActive(state?.consoleLogs === true);
    })
    .catch(() => {});

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "capture_state") {
      setCaptureActive(message.consoleLogs === true);
      return false;
    }
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
