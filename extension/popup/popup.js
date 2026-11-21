// Toolbar popup: share the tab you're on, choose what else Claude can see,
// and see which other tabs are shared.

const $ = (id) => document.getElementById(id);
const FALLBACK_ICON = "../icons/icon.svg";

const STATUS_LABELS = {
  connected: "connected",
  connecting: "connecting…",
  host_missing: "not set up",
  host_error: "error",
  disconnected: "restarting…",
};

function hostLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl || "";
  }
}

function setFavicon(img, url) {
  img.src = url || FALLBACK_ICON;
  // A stale favIconUrl (common right after navigating) would show a broken
  // image; fall back quietly.
  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK_ICON;
  };
}

function failureText(reason) {
  switch (reason) {
    case "not_connected":
      return "Sharepane isn't connected right now, so nothing changed.";
    case "permission_denied":
      return "Firefox didn't grant access to this site, so it isn't shared.";
    case "invalid_url":
      return "This page can't be shared.";
    default:
      return "That didn't work. Try again.";
  }
}

/** Shares or stops sharing a tab. Sharing first asks Firefox for that one
 * site: permissions.request must be the first await in the click handler,
 * which is why this runs here and not in the background script. */
async function setShared(tab, share) {
  if (!share) {
    const result = await browser.runtime.sendMessage({ type: "revoke_tab", tabId: tab.tabId });
    return result?.ok ? null : failureText(result?.reason);
  }
  let permitted = false;
  try {
    const u = new URL(tab.url);
    permitted = await browser.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    permitted = false;
  }
  if (!permitted) return failureText("permission_denied");
  const result = await browser.runtime.sendMessage({ type: "allow_tab", tabId: tab.tabId });
  return result?.ok ? null : failureText(result?.reason);
}

function renderStatus(status) {
  const el = $("status");
  el.textContent = STATUS_LABELS[status.connectionState] || "not connected";
  el.dataset.state = status.connectionState;
  $("host-missing").hidden = status.connectionState !== "host_missing";
  $("host-restarting").hidden = status.connectionState !== "disconnected";
  $("host-error").hidden = status.connectionState !== "host_error";
  $("host-error").textContent = status.hostError?.message || "";
}

function renderCurrent(status, activeTab) {
  const connected = status.connectionState === "connected";
  const tab = activeTab && status.tabs.find((t) => t.tabId === activeTab.id);
  const sw = $("share-switch");
  const hint = $("share-hint");
  hint.classList.remove("hint--error");

  setFavicon($("current-favicon"), activeTab?.favIconUrl);
  $("current-title").textContent = activeTab?.title || "This tab";
  $("current-host").textContent = activeTab?.url ? hostLabel(activeTab.url) : "";

  if (!tab) {
    // about:, file:, extension pages and private windows never appear in
    // status.tabs: Sharepane doesn't track them at all.
    sw.checked = false;
    sw.disabled = true;
    hint.textContent = activeTab?.incognito
      ? "Tabs in private windows are never shared."
      : "Only web pages (http and https) can be shared.";
    return;
  }

  sw.checked = tab.allowed;
  if (tab.source === "trusted-port") {
    sw.disabled = true;
    hint.textContent = `Shared automatically: ${hostLabel(tab.url)} is a trusted dev-server port. Change that in Settings.`;
    return;
  }
  sw.disabled = !connected;
  if (!connected) {
    hint.textContent = "Connect Sharepane first to change sharing.";
  } else if (tab.allowed) {
    hint.textContent = `Claude can read every tab on ${new URL(tab.url).hostname} until Firefox restarts.`;
  } else {
    hint.textContent = "Claude can't see this tab.";
  }

  sw.onchange = async () => {
    sw.disabled = true;
    const error = await setShared(tab, sw.checked);
    if (error) {
      hint.textContent = error;
      hint.classList.add("hint--error");
      sw.checked = !sw.checked;
      sw.disabled = false;
      return;
    }
    await render();
  };
}

function renderCapture(status) {
  const connected = status.connectionState === "connected";
  const consoleSw = $("capture-console");
  const networkSw = $("capture-network");
  const shotsSw = $("capture-screenshots");
  consoleSw.checked = status.captureConsoleLogs;
  networkSw.checked = status.captureNetworkRequests;
  shotsSw.checked = status.captureScreenshots;
  for (const sw of [consoleSw, networkSw]) sw.disabled = !connected;

  const saveLogs = () =>
    browser.runtime.sendMessage({
      type: "save_capture_settings",
      captureConsoleLogs: consoleSw.checked,
      captureNetworkRequests: networkSw.checked,
    });
  consoleSw.onchange = saveLogs;
  // Network capture needs the optional webRequest permission:
  // permissions.request has to be the first await in the change handler.
  networkSw.onchange = async () => {
    try {
      if (networkSw.checked) networkSw.checked = await browser.permissions.request({ permissions: ["webRequest"] });
      else await browser.permissions.remove({ permissions: ["webRequest"] });
    } catch {
      networkSw.checked = false;
    }
    await saveLogs();
  };

  // Screenshots are a Firefox permission, not a stored setting. Granting it
  // makes the extension restart itself once (see background.js), which
  // closes this popup.
  shotsSw.onchange = async () => {
    let enabled;
    try {
      enabled = shotsSw.checked
        ? await browser.permissions.request({ origins: ["<all_urls>"] })
        : !(await browser.permissions.remove({ origins: ["<all_urls>"] }));
    } catch {
      enabled = false;
    }
    shotsSw.checked = enabled;
  };
}

function renderOthers(status, activeTab) {
  const others = status.tabs.filter((t) => t.allowed && t.tabId !== activeTab?.id);
  $("others").hidden = others.length === 0;
  const list = $("others-list");
  list.replaceChildren();
  for (const tab of others) {
    const li = document.createElement("li");
    const icon = document.createElement("img");
    icon.className = "favicon";
    icon.alt = "";
    setFavicon(icon, tab.favIconUrl);

    const meta = document.createElement("div");
    meta.className = "page-meta";
    const title = document.createElement("div");
    title.className = "page-title";
    title.textContent = tab.title || tab.url;
    title.title = tab.url;
    meta.append(title);

    li.append(icon, meta);
    if (tab.source === "trusted-port") {
      const note = document.createElement("span");
      note.className = "page-host";
      note.textContent = "dev port";
      li.append(note);
    } else {
      const stop = document.createElement("button");
      stop.className = "link";
      stop.type = "button";
      stop.textContent = "Stop";
      stop.setAttribute("aria-label", `Stop sharing ${tab.title || tab.url}`);
      stop.disabled = status.connectionState !== "connected";
      stop.onclick = async () => {
        stop.disabled = true;
        await setShared(tab, false);
        await render();
      };
      li.append(stop);
    }
    list.append(li);
  }
}

async function render() {
  const [status, [activeTab]] = await Promise.all([
    browser.runtime.sendMessage({ type: "get_status" }),
    browser.tabs.query({ active: true, currentWindow: true }),
  ]);
  renderStatus(status);
  renderCurrent(status, activeTab);
  renderCapture(status);
  renderOthers(status, activeTab);
}

for (const id of ["open-onboarding", "open-onboarding-footer"]) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL("onboarding/onboarding.html") });
    window.close();
  });
}

$("open-options-footer").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

void render();
