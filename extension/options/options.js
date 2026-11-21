let currentTrustedPorts = [];
let currentlyConnected = false;

function renderTrustedPortsTable(ports) {
  const container = document.getElementById("trusted-ports");
  container.textContent = "";

  if (ports.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No trusted ports — add one below, or rely on manual Allow clicks in the popup.";
    container.appendChild(hint);
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Port", "Protocol", "Label", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  ports.forEach((p, index) => {
    const row = document.createElement("tr");
    for (const value of [p.port, p.protocol, p.label]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      row.appendChild(td);
    }
    const actionTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-port";
    removeBtn.textContent = "Remove";
    removeBtn.disabled = !currentlyConnected;
    removeBtn.addEventListener("click", () => removePort(index));
    actionTd.appendChild(removeBtn);
    row.appendChild(actionTd);
    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  container.appendChild(table);
}

function setTrustedPortsError(message) {
  document.getElementById("trusted-ports-error").textContent = message || "";
}

async function submitTrustedPorts(nextPorts) {
  setTrustedPortsError("");
  const result = await browser.runtime.sendMessage({ type: "update_trusted_ports", ports: nextPorts });
  if (!result?.ok) {
    const reason =
      result?.reason === "not_connected"
        ? "Not connected to the Sharepane helper right now — open the toolbar popup to see why."
        : result?.reason === "timeout"
          ? "The Sharepane helper didn't respond in time. Try again in a moment."
          : "Couldn't save the change.";
    setTrustedPortsError(reason);
    return false;
  }
  currentTrustedPorts = result.trustedPorts;
  renderTrustedPortsTable(currentTrustedPorts);
  return true;
}

function removePort(index) {
  const next = currentTrustedPorts.filter((_, i) => i !== index);
  submitTrustedPorts(next);
}

async function load() {
  const status = await browser.runtime.sendMessage({ type: "get_status" });
  currentlyConnected = status.connectionState === "connected";
  currentTrustedPorts = status.trustedPorts || [];
  document.getElementById("capture-console-logs").checked = Boolean(status.captureConsoleLogs);
  document.getElementById("capture-network-requests").checked = Boolean(status.captureNetworkRequests);
  document.getElementById("capture-screenshots").checked = Boolean(status.captureScreenshots);

  const addButton = document.querySelector("#trusted-ports-form button[type=submit]");
  addButton.disabled = !currentlyConnected;

  if (!currentlyConnected) {
    setTrustedPortsError(
      status.connectionState === "host_missing"
        ? "Sharepane's helper isn't installed — see the setup guide (toolbar icon → Setup guide)."
        : "Not connected to the Sharepane helper — the list below may be out of date, and edits are disabled until it reconnects."
    );
  } else {
    setTrustedPortsError("");
  }

  renderTrustedPortsTable(currentTrustedPorts);
}

document.getElementById("trusted-ports-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const portInput = document.getElementById("tp-port");
  const labelInput = document.getElementById("tp-label");
  const protocolInput = document.getElementById("tp-protocol");

  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    setTrustedPortsError("Enter a valid port number (1-65535).");
    return;
  }
  if (currentTrustedPorts.some((p) => p.port === port && p.protocol === protocolInput.value)) {
    setTrustedPortsError(`Port ${port} (${protocolInput.value}) is already in the list.`);
    return;
  }

  const next = [
    ...currentTrustedPorts,
    { port, protocol: protocolInput.value, label: labelInput.value.trim() || `Port ${port}` },
  ];
  const ok = await submitTrustedPorts(next);
  if (ok) {
    portInput.value = "";
    labelInput.value = "";
  }
});

let captureStatusTimer = null;
async function saveCaptureSettings() {
  const captureConsoleLogs = document.getElementById("capture-console-logs").checked;
  const captureNetworkRequests = document.getElementById("capture-network-requests").checked;
  await browser.runtime.sendMessage({ type: "save_capture_settings", captureConsoleLogs, captureNetworkRequests });

  const statusEl = document.getElementById("capture-status");
  statusEl.textContent = "Saved.";
  clearTimeout(captureStatusTimer);
  captureStatusTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 1500);
}

document.getElementById("capture-console-logs").addEventListener("change", saveCaptureSettings);
document.getElementById("capture-network-requests").addEventListener("change", saveCaptureSettings);

// Screenshots are a Firefox permission, not a stored setting: granting
// <all_urls> is what turns them on (background.js listens for the change).
// permissions.request must be the first await in a user-action handler.
document.getElementById("capture-screenshots").addEventListener("change", async (e) => {
  const checkbox = e.target;
  const statusEl = document.getElementById("capture-status");
  let enabled;
  try {
    enabled = checkbox.checked
      ? await browser.permissions.request({ origins: ["<all_urls>"] })
      : !(await browser.permissions.remove({ origins: ["<all_urls>"] }));
  } catch (err) {
    enabled = false;
    console.warn("Sharepane: screenshot permission change failed", err);
  }
  checkbox.checked = enabled;
  statusEl.textContent = enabled ? "Screenshots on." : "Screenshots off.";
  clearTimeout(captureStatusTimer);
  captureStatusTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 2000);
});

load();
