// Sharepane — background script.
//
// Owns: the native-messaging connection to the local Sharepane host, tab
// tracking, the popup's allow/revoke actions, and injecting the capture
// pipeline (console-hook.js + content-script.js) into allowed tabs.
//
// Firefox itself launches the host when connectNative() is called, and only
// for this extension (the host manifest's allowed_extensions). There is no
// port, no pairing token and nothing on the network. An open native port
// also keeps this event page alive, so no keep-alive tricks are needed (see
// prototypes/native-messaging/FINDINGS.md).

const NATIVE_HOST_NAME = "sharepane";
// Retries if the host exits unexpectedly. "Host not installed" isn't retried
// on a timer (it won't fix itself); opening the popup retries it instead.
const RECONNECT_DELAY_MS = 5000;

let port = null;
let browserSessionId = null;
// "connecting" | "connected" | "host_missing" (native host not installed) |
// "host_error" (the host refused to start, see hostError) | "disconnected"
// (the host exited unexpectedly; retrying).
let connectionState = "connecting";
let hostError = null; // { code, message } from a host_error message
// MCP apps connected through `sharepane mcp` right now, by client name
// (e.g. "claude-code"), as the host reports them. Drives the onboarding
// page's "Claude connected" item.
let mcpClients = [];
// Console logs and network requests are sensitive enough (page-internal state,
// request/response headers) that capturing them is opt-in and off by default,
// unlike page content/screenshots which only ever happen on an explicit
// per-tab/per-request basis anyway. Toggled from the options page; see
// saveCaptureSettings() below.
let captureConsoleLogs = false;
let captureNetworkRequests = false;
// Screenshots need tabs.captureTab, which Firefox only exposes once the user
// grants all-sites access (verified in Firefox 160: with per-site or
// activeTab permissions the function doesn't exist at all). So this isn't a
// stored setting: it mirrors whether that permission is granted right now.
// Granted/removed from the options page; see the permissions listeners below.
let captureScreenshots = false;
const ALL_SITES = { origins: ["<all_urls>"] };
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
  const stored = await browser.storage.local.get(["captureConsoleLogs", "captureNetworkRequests"]);
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
  // storage.session is also cleared when the extension reloads itself (see
  // reloadKeepingSession), which is not a browser restart. Pick up the id
  // that reload carried over, if it's fresh.
  const { carriedSessionId } = await browser.storage.local.get("carriedSessionId");
  await browser.storage.local.remove("carriedSessionId");
  const carried =
    carriedSessionId && Date.now() - carriedSessionId.at < CARRIED_SESSION_MAX_AGE_MS ? carriedSessionId.id : null;
  const id = carried || crypto.randomUUID();
  await browser.storage.session.set({ browserSessionId: id });
  return id;
}

const CARRIED_SESSION_MAX_AGE_MS = 30_000;

/** runtime.reload() wipes storage.session, which would look like a browser
 * restart and expire every manual grant. Carry the session id across. */
async function reloadKeepingSession() {
  const id = browserSessionId || (await browser.storage.session.get("browserSessionId")).browserSessionId;
  if (id) await browser.storage.local.set({ carriedSessionId: { id, at: Date.now() } });
  browser.runtime.reload();
}

// ---- host connection ----

function updateBadge() {
  const text = connectionState === "connected" ? "" : connectionState === "connecting" ? "…" : "!";
  const color =
    connectionState === "connected"
      ? "#2ea043"
      : connectionState === "connecting"
        ? "#9e6a03"
        : connectionState === "host_missing" || connectionState === "host_error"
          ? "#cf222e"
          : "#8b949e";
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color });
  void refreshAllTabBadges();
}

// Per-tab badge: a green "ON" on the toolbar icon whenever Claude can read
// the tab you're looking at. Only while connected; otherwise the tab badge
// is cleared so the global "!" / "…" connection badge shows through.
async function updateTabBadge(tabId) {
  const shared = connectionState === "connected" && allowedTabIds.has(tabId);
  try {
    await browser.action.setBadgeText({ tabId, text: shared ? "ON" : null });
    if (shared) await browser.action.setBadgeBackgroundColor({ tabId, color: "#2ea043" });
    await browser.action.setTitle({ tabId, title: shared ? "Sharepane: Claude can read this tab" : null });
  } catch {
    // tab closed in the meantime
  }
}

async function refreshAllTabBadges() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map((t) => updateTabBadge(t.id)));
}

let reconnectTimer = null;

async function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  connectionState = "connecting";
  hostError = null;
  updateBadge();

  // Bound to a local const so a late event from an old port can't clobber
  // state belonging to a newer one.
  const p = browser.runtime.connectNative(NATIVE_HOST_NAME);
  port = p;

  p.onMessage.addListener((msg) => {
    if (port !== p) return;
    handleDaemonMessage(msg);
  });

  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    port = null;
    if (pendingTrustedPortsUpdate) {
      clearTimeout(pendingTrustedPortsUpdate.timer);
      pendingTrustedPortsUpdate.resolve({ ok: false, reason: "not_connected" });
      pendingTrustedPortsUpdate = null;
    }
    // Firefox reports a missing host manifest as "No such native
    // application". That needs the user to run the installer, so it gets
    // its own state and no timer retry.
    const error = p.error?.message || "";
    if (/no such native application/i.test(error)) {
      connectionState = "host_missing";
    } else if (hostError) {
      connectionState = "host_error";
    } else {
      connectionState = "disconnected";
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
    updateBadge();
  });

  browserSessionId = await getBrowserSessionId();
  await refreshScreenshotPermission();
  sendRaw({ type: "hello", browserSessionId, capture: currentCaptureSettings() });
}

function sendRaw(message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // The port is going away; onDisconnect handles the state change.
  }
}

// Console/network entries produced before the host has acknowledged hello are held here instead of dropped, and
// flushed once the daemon has the tab list again — see resyncAllTabs(). This
// only helps while this script stays alive; a killed event page loses them.
const MAX_QUEUED_CAPTURE_MESSAGES = 500;
let queuedCaptureMessages = [];

function sendCapture(message) {
  if (connectionState === "connected") {
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
  return { consoleLogs: captureConsoleLogs, networkRequests: captureNetworkRequests, screenshots: captureScreenshots };
}

// ---- host permissions ----
//
// Install asks only for localhost/127.0.0.1 (trusted dev ports). Every other
// site is requested one origin at a time, from the popup's Allow click, and
// handed back on revoke. Match patterns can't carry a port, so a grant for
// https://staging.example.com covers every port on that host.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
// Exactly the manifest's host_permissions. Granted at install, but the user
// can remove them in about:addons, which silently breaks trusted dev ports;
// the onboarding page checks for that and offers to re-grant.
const LOCAL_ACCESS = { origins: browser.runtime.getManifest().host_permissions };

function originPattern(rawUrl) {
  const u = new URL(rawUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

async function hasOriginPermission(rawUrl) {
  try {
    return await browser.permissions.contains({ origins: [originPattern(rawUrl)] });
  } catch {
    return false;
  }
}

async function refreshScreenshotPermission() {
  captureScreenshots =
    typeof browser.tabs.captureTab === "function" && (await browser.permissions.contains(ALL_SITES));
}

/** Drops grants whose host permission the user has taken away (about:addons
 * → Permissions), locally and on the host. Without this a grant would look
 * valid to Claude while every read of it failed. */
async function reconcileGrantsWithPermissions() {
  const lost = [];
  for (const origin of grantedOrigins) {
    if (!(await hasOriginPermission(origin))) lost.push(origin);
  }
  for (const origin of lost) {
    grantedOrigins.delete(origin);
    sendRaw({ type: "revoke_origin", origin });
  }
  if (lost.length > 0) {
    void updateEarlyCaptureRegistration();
    await syncAllTabsAllowState();
  }
}

browser.permissions.onAdded.addListener(async (permissions) => {
  if (!permissions.origins?.includes("<all_urls>")) return;
  if (typeof browser.tabs.captureTab !== "function") {
    // Granted mid-session, but this context was set up without the API.
    // Reloading re-runs the background script with captureTab available.
    await reloadKeepingSession();
    return;
  }
  await refreshScreenshotPermission();
  sendRaw({ type: "capture_settings_updated", capture: currentCaptureSettings() });
});

browser.permissions.onRemoved.addListener(async (permissions) => {
  await refreshScreenshotPermission();
  sendRaw({ type: "capture_settings_updated", capture: currentCaptureSettings() });
  await reconcileGrantsWithPermissions();
});

async function handleDaemonMessage(msg) {
  switch (msg.type) {
    case "mcp_clients": {
      mcpClients = msg.clients || [];
      break;
    }
    case "host_error": {
      // Sent just before the host exits; onDisconnect reads it.
      hostError = { code: msg.code, message: msg.message };
      break;
    }
    case "hello_ack": {
      connectionState = "connected";
      trustedPorts = msg.trustedPorts || [];
      grantedOrigins = new Set(msg.grantedOrigins || []);
      mcpClients = msg.mcpClients || [];
      allowStateKnown = true;
      for (const notify of allowStateWaiters.splice(0)) notify();
      updateBadge();
      await reconcileGrantsWithPermissions();
      void updateEarlyCaptureRegistration();
      await resyncAllTabs();
      await reportActiveTab();
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
  // This script context may be a fresh load with an empty allowedTabIds, and already-open tabs won't fire a new onUpdated event —
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
    void updateTabBadge(tab.id);
    return;
  }
  allowedTabIds.add(tab.id);
  void updateTabBadge(tab.id);
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

// The tab the user is looking at, so Claude's tools can default to it. Uses
// the last-focused window, which stays put while the user is off in a
// terminal talking to Claude. Private windows report nothing.
async function reportActiveTab() {
  if (connectionState !== "connected") return;
  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    tab = undefined;
  }
  sendRaw({ type: "active_tab", tabId: tab && !tab.incognito ? tab.id : null });
}

browser.tabs.onActivated.addListener(() => void reportActiveTab());
browser.windows.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE means Firefox itself lost focus: keep the last tab.
  if (windowId !== browser.windows.WINDOW_ID_NONE) void reportActiveTab();
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
      console.warn("Sharepane: content script injection failed", err);
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
      console.warn("Sharepane: console hook injection failed", err);
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

const EARLY_CAPTURE_SCRIPT_IDS = ["sharepane-early-content-script", "sharepane-early-console-hook"];
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
      console.warn("Sharepane: couldn't register document_start capture scripts", err);
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
  if (typeof browser.tabs.captureTab !== "function") {
    // The host checks captureScreenshots first; this covers a race with
    // the permission being removed.
    sendRaw({ type: "screenshot_response", requestId: msg.requestId, tabId: msg.tabId, error: "screenshots_disabled" });
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
  // over the native-messaging pipe to the local host; nothing here leaves
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
  // Opening the popup or settings is a natural moment to retry, e.g. right
  // after the user ran the installer.
  if (!port) void connect();
  const tabs = await browser.tabs.query({});
  return {
    connectionState,
    hostError,
    captureConsoleLogs,
    captureNetworkRequests,
    captureScreenshots,
    localAccess: await browser.permissions.contains(LOCAL_ACCESS).catch(() => false),
    mcpClients: connectionState === "connected" ? mcpClients : [],
    trustedPorts,
    tabs: tabs
      .filter((t) => t.url && /^https?:/.test(t.url) && !t.incognito)
      .map((t) => ({
        tabId: t.id,
        title: t.title,
        url: t.url,
        favIconUrl: t.favIconUrl,
        allowed: allowedTabIds.has(t.id),
        // Trusted-port tabs are shared by Settings, not by a click, so the
        // popup shows them as locked on.
        source: !allowedTabIds.has(t.id) ? null : matchesTrustedPort(t.url) ? "trusted-port" : "shared",
      })),
  };
}

async function allowTab(tabId) {
  // Grants and revokes live on the daemon; sending one while disconnected
  // would be silently dropped while the popup claimed success.
  if (connectionState !== "connected") return { ok: false, reason: "not_connected" };
  const tab = await browser.tabs.get(tabId);
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!isTrackableTab(tab)) return { ok: false, reason: "invalid_url" };
  // The popup asks Firefox for this origin (permissions.request has to run
  // in its click handler, not here). Refuse rather than record a grant the
  // extension couldn't act on.
  if (!(await hasOriginPermission(tab.url))) return { ok: false, reason: "permission_denied" };

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
  void updateTabBadge(tabId);
  sendRaw({ type: "revoke_access", tabId });
  pushCaptureState(tabId);
  if (tab?.url) {
    // Mirrors the daemon: the origin's grant goes away for every tab at it;
    // other tabs still allowed via a trusted port stay allowed. The revoked
    // tab itself stays un-allowed until its next navigation, as on the daemon.
    try {
      const revoked = new URL(tab.url);
      grantedOrigins.delete(revoked.origin);
      // Hand the site's permission back, unless it's localhost (granted at
      // install, can't be removed) or another granted origin on the same
      // host still needs it (patterns are per host, not per port).
      const pattern = originPattern(tab.url);
      const stillNeeded = [...grantedOrigins].some((o) => originPattern(o) === pattern);
      if (!LOCAL_HOSTNAMES.has(revoked.hostname) && !stillNeeded) {
        void browser.permissions.remove({ origins: [pattern] }).catch(() => {});
      }
    } catch {
      // not a parseable URL — nothing was granted for it
    }
    void updateEarlyCaptureRegistration();
    await syncAllTabsAllowState(tabId);
  }
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

browser.runtime.onInstalled.addListener(({ reason, temporary }) => {
  // First install opens the setup checklist. Temporary installs (web-ext,
  // about:debugging) reinstall on every load, so they'd open it every time.
  if (reason === "install" && !temporary) {
    void browser.tabs.create({ url: browser.runtime.getURL("onboarding/onboarding.html") });
  }
});

connect();
