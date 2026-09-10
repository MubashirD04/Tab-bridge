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
    sendRaw({ type: "hello", token: pairingToken, browserSessionId });
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

async function handleDaemonMessage(msg) {
  switch (msg.type) {
    case "hello_ack": {
      connectionState = "connected";
      trustedPorts = msg.trustedPorts || [];
      grantedOrigins = new Set(msg.grantedOrigins || []);
      updateBadge();
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
  for (const tab of tabs) {
    reportTab(tab);
    // A reconnect means this script context is a fresh reload — allowedTabIds
    // came back empty, so a trusted-port or manually-granted tab that was
    // already open (and thus won't fire a fresh tabs.onUpdated "complete"
    // event) would otherwise stay locally un-allowed, silently failing
    // get_page_content/screenshot_tab with "tab_closed" until it next
    // navigates, even though the daemon (which just rebuilt its own
    // tabRegistry from the reportTab calls above, and reported grantedOrigins
    // in hello_ack) still lists it via list_allowed_tabs. Re-checking here
    // mirrors the onUpdated listener below for tabs that were never new.
    if (tab.id !== undefined && shouldAutoAllow(tab.url) && !allowedTabIds.has(tab.id)) {
      allowedTabIds.add(tab.id);
      await ensureCapturePipeline(tab.id);
    }
  }
}

function reportTab(tab) {
  if (!tab.url || tab.incognito) return; // never track private-browsing tabs
  if (!/^https?:/.test(tab.url)) return; // skip about:, file:, moz-extension:, etc.
  sendRaw({ type: "tab_updated", tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || tab.url });
}

browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) reportTab(tab);
});

browser.tabs.onRemoved.addListener((tabId) => {
  sendRaw({ type: "tab_removed", tabId });
  allowedTabIds.delete(tabId);
  contentScriptInjected.delete(tabId);
  consoleHookInjected.delete(tabId);
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
  // capture (see captureConsoleLogs) — gated again at the relay listener
  // below so toggling the setting off takes effect immediately even for a
  // tab where the hook is already running.
  if (captureConsoleLogs && !consoleHookInjected.has(tabId)) {
    consoleHookInjected.add(tabId);
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["console-hook.js"], world: "MAIN" });
    } catch (err) {
      consoleHookInjected.delete(tabId);
      console.warn("Tab Bridge: console hook injection failed", err);
    }
  }
}

async function handleContentRequest(msg) {
  if (!allowedTabIds.has(msg.tabId)) {
    sendRaw({ type: "get_content_response", requestId: msg.requestId, tabId: msg.tabId, error: "tab_closed" });
    return;
  }
  try {
    await ensureCapturePipeline(msg.tabId);
    const response = await browser.tabs.sendMessage(msg.tabId, { type: "read_content", mode: msg.mode });
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

// ---- console log relay (from content-script.js, which relays MAIN-world console-hook.js) ----

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "console_log_relay") return undefined;
  if (!captureConsoleLogs) return undefined; // opt-in permission — see options page
  const tabId = sender.tab?.id;
  if (tabId === undefined || !allowedTabIds.has(tabId)) return undefined; // extension-side allow check too
  sendRaw({
    type: "console_log",
    entry: {
      tabId,
      timestamp: new Date().toISOString(),
      level: message.level,
      args: message.args,
      stackTrace: message.stackTrace,
    },
  });
  return undefined;
});

// ---- network request capture (observe-only; no "blocking", so no elevated permission needed) ----

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!captureNetworkRequests) return; // opt-in permission — see options page
    if (!allowedTabIds.has(details.tabId)) return;
    pendingNetworkRequests.set(details.requestId, {
      tabId: details.tabId,
      requestId: details.requestId,
      timestamp: new Date().toISOString(),
      method: details.method,
      url: details.url,
      type: details.type,
      requestHeaders: headersToObject(details.requestHeaders),
      startedAt: Date.now(),
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

browser.webRequest.onCompleted.addListener(
  (details) => {
    const pending = pendingNetworkRequests.get(details.requestId);
    if (!pending) return;
    pendingNetworkRequests.delete(details.requestId);
    if (!captureNetworkRequests) return; // opt-in permission — see options page
    if (!allowedTabIds.has(details.tabId)) return;
    sendRaw({
      type: "network_request",
      entry: {
        tabId: pending.tabId,
        requestId: pending.requestId,
        timestamp: pending.timestamp,
        method: pending.method,
        url: pending.url,
        type: pending.type,
        statusCode: details.statusCode,
        requestHeaders: pending.requestHeaders,
        responseHeaders: headersToObject(details.responseHeaders),
        timingMs: Date.now() - pending.startedAt,
      },
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.webRequest.onErrorOccurred.addListener((details) => pendingNetworkRequests.delete(details.requestId), {
  urls: ["<all_urls>"],
});

function headersToObject(headers) {
  const out = {};
  for (const h of headers || []) {
    out[h.name] = h.value ?? "";
  }
  return out;
  // Note: redaction of Authorization/Cookie/Set-Cookie happens daemon-side
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
  // Retroactively inject console-hook.js into already-allowed tabs so
  // turning the setting on takes effect immediately, without needing a
  // reload. Turning it off is enforced at the relay listener instead (see
  // above) — the hook itself is harmless left running, since nothing
  // downstream of it forwards data once the flag is false.
  if (captureConsoleLogs) {
    for (const tabId of allowedTabIds) {
      await ensureCapturePipeline(tabId);
    }
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
  const tab = await browser.tabs.get(tabId);
  // host_permissions grants <all_urls> unconditionally at install (needed
  // for tabs.captureTab — see manifest.json) — every origin already has host
  // access, so there's nothing left to request/confirm here the way there
  // was back when only 127.0.0.1/localhost were pre-granted. This is just an
  // URL-sanity check now.
  try {
    new URL(tab.url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  allowedTabIds.add(tabId);
  sendRaw({ type: "grant_access", tabId, url: tab.url, label: tab.title });
  await ensureCapturePipeline(tabId);
  return { ok: true };
}

async function revokeTab(tabId) {
  allowedTabIds.delete(tabId);
  sendRaw({ type: "revoke_access", tabId });
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

// ---- also mark a tab allowed locally the moment it matches the daemon's
// trusted-port list (as reported in hello_ack), so the UI and console/
// network capture activate immediately for Live-Server tabs without a
// manual click or a round trip per navigation. Mirrors allowlist.ts's
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

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  if (shouldAutoAllow(tab.url) && !allowedTabIds.has(tabId)) {
    allowedTabIds.add(tabId);
    await ensureCapturePipeline(tabId);
  }
});

connect();
