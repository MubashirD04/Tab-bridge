// Injected into the MAIN world (the page's own JS realm) of an allowed tab —
// either at document_start via a registered content script (so logs and
// errors during page load are caught), or into an already-loaded page by
// background.js's ensureCapturePipeline().
//
// This has to run in the MAIN world specifically: an isolated-world content
// script gets its own separate `console` object (the two JS realms don't
// share built-ins, only the DOM), so overriding console.* from an isolated
// content script would never see the page's own console calls. MAIN-world
// injection needs Firefox 128+ (see manifest.json strict_min_version and
// https://bugzilla.mozilla.org/show_bug.cgi?id=1736575).
//
// This script can't call browser.runtime.* directly (that API isn't exposed
// in the MAIN world). It talks to content-script.js (isolated world) through
// two custom DOM events carrying JSON strings — not window.postMessage,
// which every `message` listener on the page would also receive (and a page
// that logs its messages would loop forever).
//
// The registered script can run on pages that turn out not to be allowed
// (match patterns can't express ports), so it starts "pending": entries are
// held locally until content-script.js reports whether capture is active
// for this tab. "inactive" puts the page's console back the way it was.
(() => {
  if (window.__tabBridgeConsoleHooked) return;
  window.__tabBridgeConsoleHooked = true;

  const TO_CONTENT_EVENT = "tab-bridge:console";
  const FROM_CONTENT_EVENT = "tab-bridge:control";
  const MAX_ARG_CHARS = 2000;
  const MAX_ARGS = 10;
  const MAX_DEPTH = 4;
  const MAX_STACK_CHARS = 4000;
  const MAX_PENDING = 200;
  const LEVELS = ["log", "warn", "error", "info", "debug"];

  let state = "pending"; // "pending" | "active" | "inactive"
  let pending = [];
  let dispatching = false;

  function truncate(str, max) {
    return str.length > max ? str.slice(0, max) + "…[truncated]" : str;
  }

  function describeNode(node) {
    if (node.nodeType === 1) {
      const id = node.id ? `#${node.id}` : "";
      const cls = typeof node.className === "string" && node.className.trim()
        ? "." + node.className.trim().split(/\s+/).join(".")
        : "";
      return `<${node.localName}${id}${cls}>`;
    }
    if (node.nodeType === 3) return `#text ${JSON.stringify(truncate(node.textContent || "", 100))}`;
    return node.nodeName;
  }

  // Stops walking as soon as the output budget is spent, so logging a huge
  // object doesn't serialize all of it only to throw most away.
  function serialize(value) {
    if (typeof value === "string") return truncate(value, MAX_ARG_CHARS);
    let out = "";
    let full = false;
    const seen = new WeakSet();

    const write = (s) => {
      if (full) return;
      if (out.length + s.length > MAX_ARG_CHARS) {
        out += s.slice(0, MAX_ARG_CHARS - out.length);
        full = true;
      } else {
        out += s;
      }
    };

    const walk = (v, depth) => {
      if (full) return;
      switch (typeof v) {
        case "string":
          write(JSON.stringify(v.length > MAX_ARG_CHARS ? v.slice(0, MAX_ARG_CHARS) : v));
          return;
        case "number":
        case "boolean":
          write(String(v));
          return;
        case "bigint":
          write(`${v}n`);
          return;
        case "undefined":
          write("undefined");
          return;
        case "symbol":
          write(v.toString());
          return;
        case "function":
          write(`[Function: ${v.name || "anonymous"}]`);
          return;
      }
      if (v === null) {
        write("null");
        return;
      }
      try {
        if (seen.has(v)) {
          write("[Circular]");
          return;
        }
        if (v instanceof Error) {
          write(`${v.name}: ${v.message}`);
          if (depth === 0 && v.stack) write(`\n${v.stack}`);
          return;
        }
        if (v instanceof Date) {
          write(Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString());
          return;
        }
        if (v instanceof RegExp) {
          write(String(v));
          return;
        }
        if (typeof Node !== "undefined" && v instanceof Node) {
          write(describeNode(v));
          return;
        }
        if (depth >= MAX_DEPTH) {
          write(Array.isArray(v) ? "[Array]" : "[Object]");
          return;
        }
        seen.add(v);
        if (Array.isArray(v)) {
          write("[");
          for (let i = 0; i < v.length && !full; i++) {
            if (i) write(", ");
            walk(v[i], depth + 1);
          }
          write("]");
          return;
        }
        if (v instanceof Map || v instanceof Set) {
          write(`${v instanceof Map ? "Map" : "Set"}(${v.size}) {`);
          let i = 0;
          for (const item of v) {
            if (full) break;
            if (i++) write(", ");
            if (v instanceof Map) {
              walk(item[0], depth + 1);
              write(" => ");
              walk(item[1], depth + 1);
            } else {
              walk(item, depth + 1);
            }
          }
          write("}");
          return;
        }
        const ctorName = v.constructor && v.constructor !== Object ? v.constructor.name : "";
        write(ctorName ? `${ctorName} {` : "{");
        let i = 0;
        for (const key in v) {
          if (full) break;
          if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
          if (i++) write(", ");
          write(`${key}: `);
          let child;
          try {
            child = v[key];
          } catch {
            write("[getter threw]");
            continue;
          }
          walk(child, depth + 1);
        }
        write("}");
      } catch {
        write("[unserializable value]");
      }
    };

    walk(value, 0);
    return full ? out + "…[truncated]" : out;
  }

  function send(entry) {
    if (dispatching) return; // a page listener on our event that logs must not recurse
    dispatching = true;
    try {
      window.dispatchEvent(new CustomEvent(TO_CONTENT_EVENT, { detail: JSON.stringify(entry) }));
    } catch {
      // Never let capture break the page.
    } finally {
      dispatching = false;
    }
  }

  function emit(level, kind, args, stackTrace) {
    if (state === "inactive") return;
    const entry = {
      level,
      kind,
      time: Date.now(),
      args,
      stackTrace: typeof stackTrace === "string" ? truncate(stackTrace, MAX_STACK_CHARS) : undefined,
    };
    if (state === "active") {
      send(entry);
    } else {
      pending.push(entry);
      if (pending.length > MAX_PENDING) pending.shift();
    }
  }

  function callerStack() {
    // Drop this helper's frame and the console wrapper's frame.
    const stack = new Error().stack || "";
    return stack.split("\n").slice(2).join("\n");
  }

  const originals = {};
  const wrappers = {};
  for (const level of LEVELS) {
    const original = console[level];
    if (typeof original !== "function") continue;
    originals[level] = original;
    wrappers[level] = function (...args) {
      if (state !== "inactive") {
        try {
          emit(
            level,
            "console",
            args.slice(0, MAX_ARGS).map(serialize),
            level === "error" ? callerStack() : undefined
          );
        } catch {
          // Never let capture break the page's own logging.
        }
      }
      return original.apply(this, args);
    };
  }
  if (typeof console.assert === "function") {
    const original = console.assert;
    originals.assert = original;
    wrappers.assert = function (condition, ...args) {
      if (!condition && state !== "inactive") {
        try {
          emit("error", "console", ["Assertion failed:", ...args.slice(0, MAX_ARGS - 1).map(serialize)], callerStack());
        } catch {
          // ignore
        }
      }
      return original.apply(this, [condition, ...args]);
    };
  }

  // Uncaught exceptions and failed resource loads never go through console.*.
  // Capture phase on window sees resource errors, which don't bubble.
  function onError(event) {
    try {
      if (!(event instanceof ErrorEvent)) {
        const el = event.target;
        if (!el || el === window) return;
        const src = el.currentSrc || el.src || el.href || "";
        emit("error", "resource", [`Failed to load <${el.localName}>${src ? ` ${src}` : ""}`]);
        return;
      }
      const err = event.error;
      const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
      const message = err instanceof Error ? `${err.name}: ${err.message}` : event.message || serialize(err);
      emit("error", "uncaught", [`Uncaught ${message}${where}`], err instanceof Error ? err.stack : undefined);
    } catch {
      // ignore
    }
  }

  function onUnhandledRejection(event) {
    try {
      const reason = event.reason;
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : serialize(reason);
      emit(
        "error",
        "unhandledrejection",
        [`Uncaught (in promise) ${message}`],
        reason instanceof Error ? reason.stack : undefined
      );
    } catch {
      // ignore
    }
  }

  let installed = false;

  function install() {
    if (installed) return;
    installed = true;
    for (const key of Object.keys(wrappers)) console[key] = wrappers[key];
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    for (const key of Object.keys(wrappers)) {
      // Only undo our own wrapper — if something wrapped console after us,
      // restoring would clobber it; our wrapper then just passes through.
      if (console[key] === wrappers[key]) console[key] = originals[key];
    }
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }

  window.addEventListener(FROM_CONTENT_EVENT, (event) => {
    let active;
    try {
      active = JSON.parse(event.detail).active === true;
    } catch {
      return;
    }
    if (active) {
      install();
      state = "active";
      const queued = pending;
      pending = [];
      for (const entry of queued) send(entry);
    } else {
      state = "inactive";
      pending = [];
      uninstall();
    }
  });

  install();
  // Lets content-script.js re-send its state if it loaded before we did.
  send({ ready: true });
})();
