function buildTabRow(tab) {
  const li = document.createElement("li");

  const favicon = document.createElement("img");
  favicon.className = "tab-favicon";
  favicon.src = tab.favIconUrl || "../icons/icon.svg";
  favicon.alt = "";
  // A stale/broken favIconUrl (common right after a tab navigates) shouldn't
  // leave a broken-image glyph in a 340px-wide popup — fall back quietly.
  favicon.addEventListener("error", () => {
    favicon.src = "../icons/icon.svg";
  });

  const meta = document.createElement("div");
  meta.className = "tab-meta";

  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url;

  const url = document.createElement("div");
  url.className = "tab-url";
  url.textContent = tab.url;

  meta.append(title, url);

  const button = document.createElement("button");
  button.className = `toggle${tab.allowed ? " allowed" : ""}`;
  button.dataset.tabId = String(tab.tabId);
  button.dataset.allowed = String(tab.allowed);
  button.textContent = tab.allowed ? "Allowed" : "Allow";

  li.append(favicon, meta, button);

  const showFailure = (result) => {
    button.disabled = false;
    button.textContent =
      result?.reason === "not_connected"
        ? "Not connected"
        : result?.reason === "invalid_url"
          ? "Invalid URL"
          : tab.allowed
            ? "Couldn't revoke"
            : "Couldn't allow";
    setTimeout(() => render(), 1500);
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    if (tab.allowed) {
      const result = await browser.runtime.sendMessage({ type: "revoke_tab", tabId: tab.tabId });
      if (!result?.ok) {
        showFailure(result);
        return;
      }
      await render();
      return;
    }

    // host_permissions grants <all_urls> unconditionally at install (needed
    // for tabs.captureTab — see manifest.json), so there's no per-origin
    // browser.permissions.request() to do here anymore — every origin
    // already has host access. background.js's allowTab() still does an
    // URL-sanity check; surface that specifically if it's what failed.
    const result = await browser.runtime.sendMessage({ type: "allow_tab", tabId: tab.tabId });
    if (!result?.ok) {
      showFailure(result);
      return;
    }
    await render();
  });

  return li;
}

async function render() {
  const status = await browser.runtime.sendMessage({ type: "get_status" });

  const statusEl = document.getElementById("status");
  const statusLabels = {
    connected: "connected",
    connecting: "connecting…",
    unauthorized: "wrong token",
    disconnected: "not connected",
  };
  statusEl.textContent = statusLabels[status.connectionState] || "not connected";
  statusEl.className = `status status--${status.connectionState}`;

  // Three mutually exclusive "why isn't this working" notices, most
  // specific cause first: no token saved yet, daemon rejected the token, or
  // the daemon just isn't reachable on the configured port.
  const noTokenYet = !status.hasPairingToken;
  const unauthorized = status.hasPairingToken && status.connectionState === "unauthorized";
  const unreachable = status.hasPairingToken && status.connectionState === "disconnected";

  document.getElementById("unpaired").hidden = !noTokenYet;
  document.getElementById("unauthorized").hidden = !unauthorized;
  document.getElementById("unreachable").hidden = !unreachable;
  if (unreachable) {
    document.getElementById("unreachable-port").textContent = String(status.daemonPort);
  }

  const list = document.getElementById("tab-list");
  list.innerHTML = "";

  if (status.tabs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No browser tabs to show.";
    list.appendChild(li);
    return;
  }

  for (const tab of status.tabs) {
    list.appendChild(buildTabRow(tab));
  }
}

for (const id of ["open-options", "open-options-footer", "open-options-unauthorized", "open-options-unreachable"]) {
  document.getElementById(id).addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
}

render();
