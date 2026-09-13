// Tab Bridge — background script.
//
// Owns: the WebSocket connection to the local daemon, tab tracking, the
// popup's allow/revoke actions, and injecting the capture pipeline
// (console-hook.js + content-script.js) into allowed tabs. See
// tab-bridge-blueprint.md for the full design and wire protocol.
//
// Nothing in this file talks to anything other than 127.0.0.1 — see the
// blueprint's Security section ("No cloud relay").

const RECONNECT_DELAY_MS = 3000;
const RECONNECT_ALARM_PREFIX = "tab-bridge-reconnect-";
// Measured live against real Firefox (see daemon.log analysis): an idle event
// page here gets killed roughly 30s after its last qualifying activity, even
// with an open WebSocket that's actively exchanging messages — producing a
// metronomic ~30s-connected/~30s-disconnected cycle, since the single
// 60s-clamped alarm below was the only thing reviving it. 3 alarms, staggered
// 20s apart (see below), land under that ~30s threshold.
const RECONNECT_ALARM_COUNT = 3;
const RECONNECT_ALARM_STAGGER_MS = 20_000;
const DEFAULT_DAEMON_PORT = 8765;

// A Firefox event page can be unloaded whenever it's idle — an open
// WebSocket does *not* keep it alive, only a visible view (popup/options)
// does. setTimeout() is discarded along with everything else on unload, so
// a setTimeout-scheduled reconnect can silently vanish and never fire. The
// alarms API is built to survive that: it wakes the page back up (re-running
// this whole script) specifically to dispatch the alarm. Must be registered
// at top level, unconditionally, so it's wired up again on every such wake.
//
// Firefox also clamps any alarm delay under 1 minute up to exactly 1 minute
// (undocumented on MDN, confirmed empirically — a 3s delayInMinutes just
// silently became a 60s one). A *single* such alarm is used as a backstop,
// not the primary path — see the close handler below, which also fires a
// quick setTimeout() that wins whenever the page is still warm — but on its
// own it leaves the page idle (and thus killable) for up to a minute at a
// time, which live testing showed Firefox actually does about half of every
// cycle (see the constants above). Firing an alarm's onAlarm listener is the
// one mechanism confirmed, by the very fact reconnects happen at all, to
// wake/reset an idled page — so registering several 60s-period alarms, each
// *created* ~20s apart in real time, makes each start its own 60s cycle from
// its own creation moment: once all are established, one of them fires
// roughly every ~20s instead of every ~60s, without any single alarm ever
// going below Firefox's per-alarm minimum. That ~20s cadence keeps poking the
// page well inside the ~30s idle window, so it should never go idle long
// enough to be killed at all while any of these alarms are live — turning
// this from "the primary reconnect backstop" into "the thing that mostly
// prevents needing to reconnect in the first place."
//
// Each alarm is checked for existence (via alarms.get) before being created,
// rather than being blindly (re)created on every wake — alarms.create()
// with an existing name resets that alarm's own period to start counting
// from *now*, which would keep re-phasing all three relative to whatever
// wake happens to be running this script, fighting the very stagger this
// sets up. Once established, each of the three alarms' schedule lives at the
// browser level, independent of this script's own liveness, so it survives
// being re-registered as a no-op on every subsequent wake.
for (let i = 0; i < RECONNECT_ALARM_COUNT; i++) {
  const name = `${RECONNECT_ALARM_PREFIX}${i}`;
  setTimeout(async () => {
    const existing = await browser.alarms.get(name);
    if (!existing) browser.alarms.create(name, { periodInMinutes: 1 });
  }, i * RECONNECT_ALARM_STAGGER_MS);
}
browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RECONNECT_ALARM_PREFIX)) return;
  // Also skip "unauthorized" — a bad token won't fix itself, and retrying it
  // every minute forever would just spam the daemon's auth-rejected log.
  // saveSettings() already calls connect() directly once the token changes.
  if (connectionState === "connected" || connectionState === "connecting" || connectionState === "unauthorized") return;
  connect();
});

let socket = null;
let browserSessionId = null;
let daemonPort = DEFAULT_DAEMON_PORT;
let pairingToken = null;
// "disconnected" | "connecting" | "connected" | "unauthorized" (daemon is
// reachable but rejected the pairing token — distinguished from a plain
// "disconnected" so the popup/options page can tell "daemon isn't running"
// apart from "daemon's running but the token's wrong," which need different
// fixes from a less-technical user's point of view.
let connectionState = "disconnected";
// Console logs and network requests are sensitive enough (page-internal state,
// request/response headers) that capturing them is opt-in and off by default,
// unlike page content/screenshots which only ever happen on an explicit
// per-tab/per-request basis anyway. Toggled from the options page; see
// saveCaptureSettings() below.
let captureConsoleLogs = false;
let captureNetworkRequests = false;
let trustedPorts = []; // [{port, label, protocol}] — as reported by the daemon in hello_ack
let pendingTrustedPortsUpdate = null; // {resolve, timer} — see updateTrustedPorts()
// Origins with a still-valid manual grant in this browser session, as
// reported by the daemon in hello_ack (see matchesGrantedOrigin() below). A
// manual grant is origin-scoped on the daemon side (AllowlistEntry has no
// tabId, only an originPattern), so this is what lets a reconnect — which
// always wipes allowedTabIds, since it's a fresh script context — restore
// local access to a tab that was already manually allowed before the drop,
// without the user having to click "Allow" again in the popup.
let grantedOrigins = new Set();

// Tabs the daemon has been told about and that currently match the
// allow-list, as far as the extension knows locally. This is a local mirror
// for UI/gating purposes only — the daemon's own allow-list check on every
// MCP tool call is the actual authority (see mcpServer.ts requireAllowed()).
const allowedTabIds = new Set();
// Split so console-hook.js injection can be gated on captureConsoleLogs
// independently of content-script.js, which is always needed (it answers
// get_page_content/screenshot_tab's read_content/read_dimensions requests).
const contentScriptInjected = new Set();
const consoleHookInjected = new Set();
const pendingNetworkRequests = new Map(); // requestId -> partial entry

// ---- settings & session id ----

async function loadSettings() {
  const stored = await browser.storage.local.get([
    "daemonPort",
    "pairingToken",
    "captureConsoleLogs",
    "captureNetworkRequests",
  ]);
  daemonPort = stored.daemonPort || DEFAULT_DAEMON_PORT;
  pairingToken = stored.pairingToken || null;
  captureConsoleLogs = Boolean(stored.captureConsoleLogs);
  captureNetworkRequests = Boolean(stored.captureNetworkRequests);
}

// Kicked off immediately, not just from connect(), so capture listeners that
// fire right after this event page wakes up can wait for the real toggle
// values instead of treating capture as off until storage has been read.
const settingsReady = loadSettings();
let settingsLoaded = false;
void settingsReady.then(() => {
  settingsLoaded = true;
});

// trustedPorts/grantedOrigins are empty in a freshly woken script until
// hello_ack arrives. A console hook asking "is capture on for me?" at
// document_start in that window would wrongly be told no, so give the
// handshake a short while to land first.
const ALLOW_STATE_WAIT_MS = 3000;
let allowStateKnown = false;
let allowStateWaiters = [];

function waitForAllowState() {
  if (allowStateKnown) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ALLOW_STATE_WAIT_MS);
    allowStateWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function getBrowserSessionId() {
  // browser.storage.session is cleared by Firefox itself when the browser
  // closes. That's the actual mechanism behind "a manual grant lasts until
  // browser restart" — see allowlist.ts's pruneExpired() on the daemon side,
  // which compares against whatever session id we report in `hello`.
  const stored = await browser.storage.session.get("browserSessionId");
  if (stored.browserSessionId) return stored.browserSessionId;
  const id = crypto.randomUUID();
  await browser.storage.session.set({ browserSessionId: id });
  return id;
}

// ---- daemon connection ----

function updateBadge() {
  const text = connectionState === "connected" ? "" : connectionState === "connecting" ? "…" : "!";
  const color =
    connectionState === "connected"
      ? "#2ea043"
      : connectionState === "connecting"
        ? "#9e6a03"
        : connectionState === "unauthorized"
          ? "#cf222e"
          : "#8b949e";
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color });
}

async function connect() {
  await loadSettings();
  if (!pairingToken) {
    connectionState = "disconnected";
    updateBadge();
    return;
  }
  connectionState = "connecting";
  updateBadge();

  // Bound to a local const so each handler below can tell whether *it's*
  // still the active connection by the time its event fires. `socket` (the
  // module-level pointer) gets reassigned every time connect() runs, so
  // without this check a stale, already-superseded socket's close handler
  // would schedule its own redundant reconnect — and since every closed
  // socket does the same thing, two such chains end up perpetually
  // superseding (WS close code 4002) and re-scheduling each other forever.
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/ext`);
  socket = ws;

  ws.addEventListener("open", async () => {
    if (socket !== ws) return;
    browserSessionId = await getBrowserSessionId();
    sendRaw({ type: "hello", token: pairingToken, browserSessionId, capture: currentCaptureSettings() });
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleDaemonMessage(msg);
  });

  ws.addEventListener("close", (event) => {
    if (socket !== ws) return; // already superseded — the newer connection owns reconnect duty
    if (pendingTrustedPortsUpdate) {
      clearTimeout(pendingTrustedPortsUpdate.timer);
      pendingTrustedPortsUpdate.resolve({ ok: false, reason: "not_connected" });
      pendingTrustedPortsUpdate = null;
    }
    // Code 4001 is the daemon's own "unauthorized" close (see wsServer.ts
    // handleConnection) — surface that distinctly rather than lumping it in
    // with "daemon isn't running," since the fix is different (recheck the
    // token vs. start the daemon) and retrying a known-bad token every 3s
    // would just spam the daemon's auth-rejected log for no benefit.
    if (event.code === 4001) {
      connectionState = "unauthorized";
      updateBadge();
      return;
    }
    connectionState = "disconnected";
    updateBadge();
    // Fast path — usually wins, since the page is normally still warm right
    // after a close event actually fires. The recurring heartbeat alarm
    // registered at top level is the backstop for when it isn't (or when
    // the page was killed before this handler ever got to run at all).
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      // already closing
    }
  });
}

function sendRaw(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

// Console/network entries produced while the socket is down (e.g. during the
// few seconds a reconnect takes) are held here instead of dropped, and
// flushed once the daemon has the tab list again — see resyncAllTabs(). This
// only helps while this script stays alive; a killed event page loses them.
const MAX_QUEUED_CAPTURE_MESSAGES = 500;
let queuedCaptureMessages = [];

function sendCapture(message) {
  if (connectionState === "connected" && socket?.readyState === WebSocket.OPEN) {
    sendRaw(message);
    return;
  }
  queuedCaptureMessages.push(message);
  if (queuedCaptureMessages.length > MAX_QUEUED_CAPTURE_MESSAGES) queuedCaptureMessages.shift();
}

function flushQueuedCaptureMessages() {
  const queued = queuedCaptureMessages;
  queuedCaptureMessages = [];
  for (const message of queued) sendRaw(message);
}

function currentCaptureSettings() {
  return { consoleLogs: captureConsoleLogs, networkRequests: captureNetworkRequests };
}

async function handleDaemonMessage(msg) {
  switch (msg.type) {
    case "hello_ack": {
      connectionState = "connected";
      trustedPorts = msg.trustedPorts || [];
      grantedOrigins = new Set(msg.grantedOrigins || []);
      allowStateKnown = true;
      for (const notify of allowStateWaiters.splice(0)) notify();
      updateBadge();
      void updateEarlyCaptureRegistration();
      await resyncAllTabs();
      break;
    }
    case "get_content_request": {
      await handleContentRequest(msg);
      break;
    }
    case "screenshot_request": {
      await handleScreenshotRequest(msg);
      break;
    }
    case "trusted_ports_updated": {
      trustedPorts = msg.trustedPorts || [];
      // The daemon re-checks open tabs against the new list; mirror that.
      void syncAllTabsAllowState();
      void updateEarlyCaptureRegistration();
      if (pendingTrustedPortsUpdate) {
        clearTimeout(pendingTrustedPortsUpdate.timer);
        pendingTrustedPortsUpdate.resolve({ ok: true, trustedPorts });
        pendingTrustedPortsUpdate = null;
      }
      break;
    }
  }
}

// ---- tab tracking ----

async function resyncAllTabs() {
  const tabs = await browser.tabs.query({});
  // Report every tab first, synchronously, so the daemon has rebuilt its
  // sessions before any queued console/network entries reach it (it drops
  // entries for tabs it doesn't consider allowed).
  for (const tab of tabs) reportTab(tab);
  flushQueuedCaptureMessages();
  // A reconnect may mean this script context is a fresh reload with an empty
  // allowedTabIds, and already-open tabs won't fire a new onUpdated event —
  // so re-derive local allow state (and injection) for all of them here.
  await Promise.all(tabs.map(syncTabAllowState));
}

function isTrackableTab(tab) {
  if (!tab.url || tab.incognito) return false; // never track private-browsing tabs
  return /^https?:/.test(tab.url); // skip about:, file:, moz-extension:, etc.
}

function reportTab(tab) {
  if (!isTrackableTab(tab)) return;
  sendRaw({ type: "tab_updated", tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || tab.url });
}

/** Brings one tab's local allow state in line with what the daemon would
 * decide (trusted port or granted origin — see shouldAutoAllow()), in both
 * directions: a tab that navigates away from an allowed origin stops being
 * captured, not just one that newly matches. Injects the capture pipeline
 * once the tab's document has finished loading. */
async function syncTabAllowState(tab) {
  if (tab.id === undefined) return;
  if (!isTrackableTab(tab) || !shouldAutoAllow(tab.url)) {
    if (allowedTabIds.delete(tab.id)) pushCaptureState(tab.id); // detach its console hook
    return;
  }
  allowedTabIds.add(tab.id);
  if (tab.status === "complete") await ensureCapturePipeline(tab.id);
}

async function syncAllTabsAllowState(exceptTabId) {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.filter((t) => t.id !== exceptTabId).map(syncTabAllowState));
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    // A reload or cross-document navigation discards everything injected
    // into the old document. Without forgetting it here, the capture
    // pipeline would never be re-injected — console capture (and
    // get_page_content) silently stopped after a tab's first reload, which
    // Live Server triggers on every save. Re-injecting into a document that
    // still has the scripts is harmless: both guard against running twice.
    contentScriptInjected.delete(tabId);
    consoleHookInjected.delete(tabId);
  }
  if (changeInfo.status === "complete" || changeInfo.url) {
    reportTab(tab);
    await syncTabAllowState(tab);
  } else if (changeInfo.title) {
    reportTab(tab); // keeps list_allowed_tabs titles current for single-page apps
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  sendRaw({ type: "tab_removed", tabId });
  allowedTabIds.delete(tabId);
  contentScriptInjected.delete(tabId);
  consoleHookInjected.delete(tabId);
  for (const [requestId, pending] of pendingNetworkRequests) {
    if (pending.tabId === tabId) pendingNetworkRequests.delete(requestId);
  }
});

// ---- capture pipeline (only ever injected into allowed tabs) ----

async function ensureCapturePipeline(tabId) {
  if (!contentScriptInjected.has(tabId)) {
    contentScriptInjected.add(tabId);
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    } catch (err) {
      // Injection can legitimately fail (e.g. a browser-internal page slipped
      // through, or the tab navigated away mid-injection) — don't crash the
      // background script over it.
      contentScriptInjected.delete(tabId);
      console.warn("Tab Bridge: content script injection failed", err);
    }
  }
  // console-hook.js is only injected when the user has opted into console
  // capture (see captureConsoleLogs). It may already be there from the
  // document_start registration (see updateEarlyCaptureRegistration()), in
  // which case this is a no-op guarded inside the script itself.
  if (captureConsoleLogs && !consoleHookInjected.has(tabId)) {
    consoleHookInjected.add(tabId);
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["console-hook.js"], world: "MAIN" });
    } catch (err) {
      consoleHookInjected.delete(tabId);
      console.warn("Tab Bridge: console hook injection failed", err);
    }
  }
  pushCaptureState(tabId);
}

/** Tells a tab's content script (and through it, the console hook) whether
 * console capture is active for it right now. An inactive hook restores the
 * page's original console methods, so a page stops paying for capture as
 * soon as it's switched off or the tab stops being allowed. */
function pushCaptureState(tabId) {
  const consoleLogs = captureConsoleLogs && allowedTabIds.has(tabId);
  browser.tabs.sendMessage(tabId, { type: "capture_state", consoleLogs }).catch(() => {
    // No content script in that tab — nothing to tell.
  });
}

// ---- document_start registration, so logs/errors during page load are caught ----

const EARLY_CAPTURE_SCRIPT_IDS = ["tab-bridge-early-content-script", "tab-bridge-early-console-hook"];
let registrationChain = Promise.resolve();

/** Match patterns can't express ports, so these are host-wide: a trusted
 * port on localhost registers for every localhost page. That's why the hook
 * starts out holding entries back and asks before sending anything — see
 * getCaptureStateFor(). */
function earlyCaptureMatchPatterns() {
  const patterns = new Set();
  for (const origin of grantedOrigins) {
    try {
      const url = new URL(origin);
      patterns.add(`${url.protocol}//${url.hostname}/*`);
    } catch {
      // not a parseable origin — nothing to register
    }
  }
  for (const p of trustedPorts) {
    patterns.add(`${p.protocol}://127.0.0.1/*`);
    patterns.add(`${p.protocol}://localhost/*`);
  }
  return Array.from(patterns);
}

/** Re-registers the document_start scripts for the current allow-list and
 * console toggle. Serialized, since unregister+register isn't atomic. */
function updateEarlyCaptureRegistration() {
  registrationChain = registrationChain.then(async () => {
    try {
      const existing = await browser.scripting.getRegisteredContentScripts({ ids: EARLY_CAPTURE_SCRIPT_IDS });
      if (existing.length > 0) {
        await browser.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
      }
      const matches = earlyCaptureMatchPatterns();
      if (!captureConsoleLogs || matches.length === 0) return;
      await browser.scripting.registerContentScripts([
        {
          id: EARLY_CAPTURE_SCRIPT_IDS[0],
          js: ["content-script.js"],
          matches,
          runAt: "document_start",
          persistAcrossSessions: false,
        },
        {
          id: EARLY_CAPTURE_SCRIPT_IDS[1],
          js: ["console-hook.js"],
          matches,
          runAt: "document_start",
          world: "MAIN",
          persistAcrossSessions: false,
        },
      ]);
    } catch (err) {
      // Capture still works without this, just from page load completion on
      // (ensureCapturePipeline()).
      console.warn("Tab Bridge: couldn't register document_start capture scripts", err);
    }
  });
  return registrationChain;
}

async function handleContentRequest(msg) {
  if (!allowedTabIds.has(msg.tabId)) {
    sendRaw({ type: "get_content_response", requestId: msg.requestId, tabId: msg.tabId, error: "tab_closed" });
    return;
  }
  try {
    await ensureCapturePipeline(msg.tabId);
    let response;
    try {
      response = await browser.tabs.sendMessage(msg.tabId, { type: "read_content", mode: msg.mode });
    } catch (err) {
      if (!isNoReceiverError(err)) throw err;
      // The content script is gone even though we believed it injected (a
      // navigation we didn't see as "loading") — re-inject once and retry.
      contentScriptInjected.delete(msg.tabId);
      await ensureCapturePipeline(msg.tabId);
      response = await browser.tabs.sendMessage(msg.tabId, { type: "read_content", mode: msg.mode });
    }
    if (response?.error) {
      sendRaw({ type: "get_content_response", requestId: msg.requestId, tabId: msg.tabId, error: response.error });
    } else {
      sendRaw({
        type: "get_content_response",
        requestId: msg.requestId,
        tabId: msg.tabId,
        content: response.content,
        truncated: response.truncated,
      });
    }
  } catch (err) {
    sendRaw({
      type: "get_content_response",
      requestId: msg.requestId,
      tabId: msg.tabId,
      error: isTabGoneError(err) ? "tab_closed" : String(err),
    });
  }
}

async function handleScreenshotRequest(msg) {
  if (!allowedTabIds.has(msg.tabId)) {
    sendRaw({ type: "screenshot_response", requestId: msg.requestId, tabId: msg.tabId, error: "tab_closed" });
    return;
  }
  try {
    const tab = await browser.tabs.get(msg.tabId);
    const dataUrl = await browser.tabs.captureTab(msg.tabId, { format: msg.format || "png" });
    const imageBase64 = dataUrl.split(",")[1] || "";
    // captureTab returns a data: URL; getting exact bitmap pixel dimensions
    // back out of it needs decoding, which isn't reliably available from a
    // background context across Firefox versions. The tab's CSS viewport
    // size (from the already-injected content script, if present) is a
    // reasonable, always-available approximation instead.
    let width;
    let height;
    try {
      const dims = await browser.tabs.sendMessage(msg.tabId, { type: "read_dimensions" });
      width = dims?.width;
      height = dims?.height;
    } catch {
      width = tab.width;
      height = tab.height;
    }
    sendRaw({ type: "screenshot_response", requestId: msg.requestId, tabId: msg.tabId, imageBase64, width, height });
  } catch (err) {
    sendRaw({
      type: "screenshot_response",
      requestId: msg.requestId,
      tabId: msg.tabId,
      error: isTabGoneError(err) ? "tab_closed" : String(err),
    });
  }
}

function isTabGoneError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /no tab with id|invalid tab id/i.test(message);
}

function isNoReceiverError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /receiving end does not exist|could not establish connection/i.test(message);
}

// ---- console log relay (from content-script.js, which relays MAIN-world console-hook.js) ----

/** A URL-only allow decision, for moments when allowedTabIds may not have
 * caught up yet (a new document at document_start, a main-frame request). */
function isUrlAllowed(url, incognito) {
  return isTrackableTab({ url, incognito }) && shouldAutoAllow(url);
}

async function getCaptureStateFor(sender) {
  await settingsReady;
  await waitForAllowState();
  const tab = sender.tab;
  if (!captureConsoleLogs || !tab || tab.id === undefined || sender.frameId !== 0) return { consoleLogs: false };
  // Judge by the document's own URL: at document_start the tab may not have
  // reported its navigation yet, so allowedTabIds can be stale either way.
  if (!isUrlAllowed(sender.url, tab.incognito)) return { consoleLogs: false };
  if (!allowedTabIds.has(tab.id)) {
    allowedTabIds.add(tab.id);
    sendRaw({ type: "tab_updated", tabId: tab.id, windowId: tab.windowId, url: sender.url, title: tab.title || sender.url });
  }
  return { consoleLogs: true };
}

// Hook timestamps come from the page; fall back to now if one is implausible.
function hookTimestamp(time) {
  const now = Date.now();
  return new Date(Number.isFinite(time) && Math.abs(now - time) < 10 * 60_000 ? time : now).toISOString();
}

async function relayConsoleBatch(entries, sender) {
  await settingsReady;
  if (!captureConsoleLogs || !Array.isArray(entries)) return; // opt-in permission — see options page
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !allowedTabIds.has(tabId)) return; // extension-side allow check too
  for (const e of entries) {
    sendCapture({
      type: "console_log",
      entry: {
        tabId,
        timestamp: hookTimestamp(e.time),
        level: e.level,
        kind: e.kind,
        args: e.args,
        stackTrace: e.stackTrace,
      },
    });
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "capture_state_request") return getCaptureStateFor(sender);
  if (message?.type === "console_log_batch") void relayConsoleBatch(message.entries, sender);
  return undefined;
});

// ---- network request capture (observe-only; no "blocking", so no elevated permission needed) ----

const MAX_PENDING_NETWORK_REQUESTS = 1000;

function shouldCaptureRequest(details) {
  if (!captureNetworkRequests) return false; // opt-in permission — see options page
  // A top-level navigation belongs to the page it's loading, not the one the
  // tab is leaving, so judge it by its own URL.
  if (details.type === "main_frame") return isUrlAllowed(details.url, details.incognito);
  return allowedTabIds.has(details.tabId);
}

// These handlers must record synchronously. Firefox can deliver a fast
// request's start and finish events back to back without running promise
// callbacks in between, so an `await` here let onCompleted/onErrorOccurred
// run before the request was recorded — quick 404s, WebSocket upgrades and
// refused connections silently went missing. Deferring is only acceptable
// in the brief window before settings have loaded after a wake-up.
function startNetworkRequest(details) {
  if (!shouldCaptureRequest(details)) return;
  if (pendingNetworkRequests.size >= MAX_PENDING_NETWORK_REQUESTS) {
    // Oldest first (Map keeps insertion order) — requests that never finished.
    pendingNetworkRequests.delete(pendingNetworkRequests.keys().next().value);
  }
  pendingNetworkRequests.set(details.requestId, {
    tabId: details.tabId,
    requestId: details.requestId,
    method: details.method,
    url: details.url,
    type: details.type,
    requestHeaders: {},
    startedAt: details.timeStamp,
  });
}

function recordRequestHeaders(details) {
  const pending = pendingNetworkRequests.get(details.requestId);
  if (pending) pending.requestHeaders = headersToObject(details.requestHeaders);
}

// onBeforeRequest rather than onBeforeSendHeaders: requests served from cache
// never send headers, but still start and complete.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (settingsLoaded) startNetworkRequest(details);
    else void settingsReady.then(() => startNetworkRequest(details));
  },
  { urls: ["<all_urls>"] }
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (settingsLoaded) recordRequestHeaders(details);
    else void settingsReady.then(() => recordRequestHeaders(details));
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

function finishNetworkRequest(details, extra) {
  const pending = pendingNetworkRequests.get(details.requestId);
  if (!pending) return;
  pendingNetworkRequests.delete(details.requestId);
  if (!shouldCaptureRequest(details)) return;
  sendCapture({
    type: "network_request",
    entry: {
      tabId: pending.tabId,
      requestId: pending.requestId,
      timestamp: new Date(pending.startedAt).toISOString(),
      method: pending.method,
      url: pending.url,
      type: pending.type,
      requestHeaders: pending.requestHeaders,
      responseHeaders: headersToObject(details.responseHeaders),
      timingMs: Math.max(0, Math.round(details.timeStamp - pending.startedAt)),
      ...extra,
    },
  });
}

browser.webRequest.onCompleted.addListener(
  (details) => finishNetworkRequest(details, { statusCode: details.statusCode, fromCache: details.fromCache }),
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Each redirect hop is its own entry; the follow-up request fires
// onBeforeRequest again under the same requestId.
browser.webRequest.onBeforeRedirect.addListener(
  (details) => finishNetworkRequest(details, { statusCode: details.statusCode, redirectUrl: details.redirectUrl }),
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Failed requests (CORS, DNS, refused connections, blocked) are often the
// ones worth seeing, so they're recorded rather than dropped.
browser.webRequest.onErrorOccurred.addListener(
  (details) => finishNetworkRequest(details, { error: details.error }),
  { urls: ["<all_urls>"] }
);

function headersToObject(headers) {
  const out = {};
  for (const h of headers || []) {
    out[h.name] = h.value ?? "";
  }
  return out;
  // Note: redaction of credential headers (Authorization, Cookie, ...) happens daemon-side
  // (redact.ts), unconditionally, before these ever land in a ring buffer —
  // see the blueprint's Security section. The extension sends raw headers
  // over the already-token-authed localhost WebSocket; nothing here leaves
  // the machine unredacted.
}

// ---- popup / options messaging ----

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "get_status") {
    return Promise.resolve(getStatus());
  }
  if (message?.type === "allow_tab") {
    return allowTab(message.tabId);
  }
  if (message?.type === "revoke_tab") {
    return revokeTab(message.tabId);
  }
  if (message?.type === "save_settings") {
    return saveSettings(message.daemonPort, message.pairingToken);
  }
  if (message?.type === "update_trusted_ports") {
    return updateTrustedPorts(message.ports);
  }
  if (message?.type === "save_capture_settings") {
    return saveCaptureSettings(message.captureConsoleLogs, message.captureNetworkRequests);
  }
  return undefined;
});

const TRUSTED_PORTS_UPDATE_TIMEOUT_MS = 4000;

function updateTrustedPorts(ports) {
  if (connectionState !== "connected") {
    return Promise.resolve({ ok: false, reason: "not_connected" });
  }
  // Only one edit in flight at a time — the options page disables its form
  // while a save is pending, so this is a safety net, not the primary guard.
  if (pendingTrustedPortsUpdate) {
    clearTimeout(pendingTrustedPortsUpdate.timer);
    pendingTrustedPortsUpdate.resolve({ ok: false, reason: "superseded" });
  }
  return new Promise((resolve) => {
    pendingTrustedPortsUpdate = {
      resolve,
      timer: setTimeout(() => {
        pendingTrustedPortsUpdate = null;
        resolve({ ok: false, reason: "timeout" });
      }, TRUSTED_PORTS_UPDATE_TIMEOUT_MS),
    };
    sendRaw({ type: "set_trusted_ports", ports });
  });
}

async function saveCaptureSettings(newCaptureConsoleLogs, newCaptureNetworkRequests) {
  await browser.storage.local.set({
    captureConsoleLogs: Boolean(newCaptureConsoleLogs),
    captureNetworkRequests: Boolean(newCaptureNetworkRequests),
  });
  captureConsoleLogs = Boolean(newCaptureConsoleLogs);
  captureNetworkRequests = Boolean(newCaptureNetworkRequests);
  // Don't let entries captured before a toggle was turned off reach the
  // daemon later via the reconnect queue.
  queuedCaptureMessages = queuedCaptureMessages.filter(
    (m) => (m.type === "console_log" && captureConsoleLogs) || (m.type === "network_request" && captureNetworkRequests)
  );
  // The daemon uses this to report "capture is off" from its tools and to
  // discard already-captured data for a toggle that was turned off. If we're
  // not connected, the next hello carries the current values instead.
  sendRaw({ type: "capture_settings_updated", capture: currentCaptureSettings() });
  await updateEarlyCaptureRegistration();
  // Turning console capture on injects the hook into already-allowed tabs
  // right away (no reload needed); turning it off tells every hook to detach.
  if (captureConsoleLogs) {
    await Promise.all(Array.from(allowedTabIds, (tabId) => ensureCapturePipeline(tabId)));
  } else {
    for (const tabId of contentScriptInjected) pushCaptureState(tabId);
    consoleHookInjected.clear(); // a detached hook re-attaches on the next injection
  }
  return { ok: true };
}

async function getStatus() {
  const tabs = await browser.tabs.query({});
  return {
    connectionState,
    daemonPort,
    hasPairingToken: Boolean(pairingToken),
    captureConsoleLogs,
    captureNetworkRequests,
    trustedPorts,
    tabs: tabs
      .filter((t) => t.url && /^https?:/.test(t.url) && !t.incognito)
      .map((t) => ({
        tabId: t.id,
        title: t.title,
        url: t.url,
        favIconUrl: t.favIconUrl,
        allowed: allowedTabIds.has(t.id),
      })),
  };
}

async function allowTab(tabId) {
  // Grants and revokes live on the daemon; sending one while disconnected
  // would be silently dropped while the popup claimed success.
  if (connectionState !== "connected") return { ok: false, reason: "not_connected" };
  const tab = await browser.tabs.get(tabId);
  // host_permissions grants <all_urls> unconditionally at install (needed
  // for tabs.captureTab — see manifest.json) — every origin already has host
  // access, so there's nothing left to request/confirm here the way there
  // was back when only 127.0.0.1/localhost were pre-granted. This is just an
  // URL-sanity check now.
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!isTrackableTab(tab)) return { ok: false, reason: "invalid_url" };

  sendRaw({ type: "grant_access", tabId, url: tab.url, label: tab.title });
  // The daemon grants the whole origin, so every open tab at it is allowed,
  // not only this one.
  grantedOrigins.add(origin);
  void updateEarlyCaptureRegistration();
  await syncAllTabsAllowState();
  return { ok: true };
}

async function revokeTab(tabId) {
  if (connectionState !== "connected") return { ok: false, reason: "not_connected" };
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    // Tab already gone — onRemoved has cleaned up after it.
  }
  allowedTabIds.delete(tabId);
  sendRaw({ type: "revoke_access", tabId });
  pushCaptureState(tabId);
  if (tab?.url) {
    // Mirrors the daemon: the origin's grant goes away for every tab at it;
    // other tabs still allowed via a trusted port stay allowed. The revoked
    // tab itself stays un-allowed until its next navigation, as on the daemon.
    try {
      grantedOrigins.delete(new URL(tab.url).origin);
    } catch {
      // not a parseable URL — nothing was granted for it
    }
    void updateEarlyCaptureRegistration();
    await syncAllTabsAllowState(tabId);
  }
  return { ok: true };
}

async function saveSettings(newPort, newToken) {
  await browser.storage.local.set({ daemonPort: newPort, pairingToken: newToken });
  if (socket) {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
  await connect();
  return { ok: true };
}

// ---- local allow matching, used by syncTabAllowState(): a tab is allowed
// locally the moment it matches the daemon's trusted-port list or a granted
// origin (as reported in hello_ack), so the UI and console/network capture
// activate immediately without a round trip per navigation. Mirrors allowlist.ts's
// matchTrustedPort() exactly; the daemon remains the actual authority for
// every MCP tool call regardless of what the extension believes locally. ----
function matchesTrustedPort(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const isLocalHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!isLocalHost) return false;
  const protocol = url.protocol === "https:" ? "https" : "http";
  const port = url.port ? Number(url.port) : protocol === "https" ? 443 : 80;
  return trustedPorts.some((p) => p.port === port && p.protocol === protocol);
}

// A manual grant is origin-scoped on the daemon side (grant() stores an
// origin, not a tabId — see allowlist.ts), so any tab at a granted origin is
// already allowed as far as the daemon is concerned, not just the specific
// tab that was clicked "Allow" in the popup. Matches that.
function matchesGrantedOrigin(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return grantedOrigins.has(url.origin);
}

function shouldAutoAllow(rawUrl) {
  return matchesTrustedPort(rawUrl) || matchesGrantedOrigin(rawUrl);
}

connect();
