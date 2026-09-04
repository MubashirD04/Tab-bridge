// Injected into the MAIN world (the page's own JS realm) of an allowed tab,
// once, by background.js — see ensureCapturePipeline().
//
// This has to run in the MAIN world specifically: an isolated-world content
// script gets its own separate `console` object (the two JS realms don't
// share built-ins, only the DOM), so overriding console.* from an isolated
// content script would never see the page's own console calls. MAIN-world
// injection via scripting.executeScript needs Firefox 128+ (see manifest.json
// strict_min_version and https://bugzilla.mozilla.org/show_bug.cgi?id=1736575).
//
// This script can't call browser.runtime.* directly (that API isn't exposed
// in the MAIN world) — it posts to window instead, and content-script.js
// (running in the isolated world, listening below) relays validated
// messages on to the background script.
(() => {
  if (window.__tabBridgeConsoleHooked) return;
  window.__tabBridgeConsoleHooked = true;

  const MARKER = "__tab_bridge_console__";
  const MAX_ARG_CHARS = 2000;
  const MAX_ARGS = 10;

  function safeStringify(value, depth = 0) {
    if (depth > 4) return "[max depth]";
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
      if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
      if (typeof value === "undefined") return "undefined";
      const str = JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return v.toString() + "n";
        return v;
      });
      return str === undefined ? String(value) : str;
    } catch {
      try {
        return String(value);
      } catch {
        return "[unserializable value]";
      }
    }
  }

  function truncate(str) {
    return str.length > MAX_ARG_CHARS ? str.slice(0, MAX_ARG_CHARS) + "…[truncated]" : str;
  }

  const levels = ["log", "warn", "error", "info", "debug"];
  const original = {};
  for (const level of levels) {
    original[level] = console[level]?.bind ? console[level].bind(console) : console[level];
  }

  for (const level of levels) {
    console[level] = (...args) => {
      try {
        const safeArgs = args.slice(0, MAX_ARGS).map((a) => truncate(safeStringify(a)));
        window.postMessage(
          {
            source: MARKER,
            level,
            args: safeArgs,
            stackTrace: level === "error" ? new Error().stack : undefined,
          },
          "*"
        );
      } catch {
        // Never let capture break the page's own logging.
      }
      try {
        original[level]?.(...args);
      } catch {
        // ignore
      }
    };
  }
})();
