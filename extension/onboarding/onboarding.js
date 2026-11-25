// Setup checklist. Polls the background script's status and turns each
// step green by itself, so the user never has to reload or guess.

// Claude Code plugin users can run /sharepane:setup instead; the page
// mentions that next to the command.
const SETUP_COMMAND = "npx sharepane setup";
const POLL_MS = 1500;

const $ = (id) => document.getElementById(id);

function setStep(id, state) {
  $(id).dataset.state = state; // done | action | waiting | error | pending
}

function renderHelper(status) {
  const text = $("helper-text");
  $("helper-command").hidden = true;
  switch (status.connectionState) {
    case "connected":
      setStep("step-helper", "done");
      text.textContent = "The helper is running.";
      return true;
    case "host_missing":
      setStep("step-helper", "action");
      text.textContent =
        "Run this once in a terminal (Node.js 18 or later). Using the Claude Code plugin? Run /sharepane:setup in Claude instead.";
      $("helper-command").hidden = false;
      return false;
    case "host_error":
      setStep("step-helper", "error");
      text.textContent = status.hostError?.message || "The helper couldn't start.";
      return false;
    case "disconnected":
      setStep("step-helper", "waiting");
      text.textContent = "The helper stopped unexpectedly. Restarting it…";
      return false;
    default:
      // Still looking for the helper. On a first run it may not be installed
      // yet, so give the command now instead of leaving the user waiting.
      setStep("step-helper", "waiting");
      text.textContent =
        "Looking for the helper… If you haven't set it up yet, run this once in a terminal (Node.js 18 or later). Using the Claude Code plugin? Run /sharepane:setup in Claude instead.";
      $("helper-command").hidden = false;
      return false;
  }
}

function renderClaude(status, helperOk) {
  const text = $("claude-text");
  if (!helperOk) {
    setStep("step-claude", "pending");
    text.textContent = "Waiting for the helper first.";
    return false;
  }
  if (status.mcpClients.length > 0) {
    setStep("step-claude", "done");
    text.textContent = `Connected: ${status.mcpClients.join(", ")}.`;
    return true;
  }
  setStep("step-claude", "waiting");
  text.textContent =
    "Restart Claude Code or Claude Desktop so it picks up Sharepane. This turns green as soon as Claude connects.";
  return false;
}

function renderTab(status, helperOk) {
  const allowed = status.tabs.filter((t) => t.allowed);
  const portsText = $("trusted-ports-text");
  const ports = (status.trustedPorts || []).map((p) => p.port);
  portsText.hidden = ports.length === 0;
  portsText.textContent =
    ports.length === 0
      ? ""
      : `Tabs on localhost port ${ports.join(", ")} are shared automatically. Change the list in Settings.`;

  if (allowed.length > 0) {
    setStep("step-tab", "done");
    $("tab-text").textContent =
      allowed.length === 1 ? `Shared: ${allowed[0].title || allowed[0].url}` : `${allowed.length} tabs shared.`;
    return true;
  }
  setStep("step-tab", helperOk ? "action" : "pending");
  const strong = document.createElement("strong");
  strong.textContent = "Share with Claude";
  $("tab-text").replaceChildren(
    "Open the site you're working on, click the Sharepane toolbar icon, and turn on ",
    strong,
    "."
  );
  return false;
}

async function refresh() {
  let status;
  try {
    status = await browser.runtime.sendMessage({ type: "get_status" });
  } catch {
    return; // background restarting; the next poll catches up
  }
  const helperOk = renderHelper(status);
  $("step-local").hidden = status.localAccess;
  if (!status.localAccess) setStep("step-local", "action");
  const claudeOk = renderClaude(status, helperOk);
  const tabOk = renderTab(status, helperOk);
  $("all-done").hidden = !(helperOk && status.localAccess && claudeOk && tabOk);
}

$("setup-command").textContent = SETUP_COMMAND;

$("copy-command").addEventListener("click", async () => {
  const button = $("copy-command");
  try {
    await navigator.clipboard.writeText(SETUP_COMMAND);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select and copy";
  }
  setTimeout(() => (button.textContent = "Copy"), 1500);
});

// permissions.request has to be the first await in a click handler.
$("grant-local").addEventListener("click", async () => {
  await browser.permissions.request({ origins: browser.runtime.getManifest().host_permissions }).catch(() => false);
  void refresh();
});

$("open-settings").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

void refresh();
setInterval(refresh, POLL_MS);
