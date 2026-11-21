// Deliberately has NO keep-alive tricks (no alarms, no heartbeats), so the
// prototype measures whether an open native port by itself keeps the event
// page — and therefore the host process — alive.
const backgroundLoadedAt = new Date().toISOString();
let port = null;

function connect(reason) {
  port = browser.runtime.connectNative("tab_bridge_proto");
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "request") return;
    if (msg.cmd === "list_tabs") {
      const tabs = await browser.tabs.query({});
      port.postMessage({
        type: "response",
        id: msg.id,
        result: { backgroundLoadedAt, tabs: tabs.map((t) => ({ id: t.id, url: t.url })) },
      });
    }
  });
  port.onDisconnect.addListener((p) => {
    console.warn("native port disconnected", p.error?.message);
    port = null;
  });
  port.postMessage({ type: "hello", reason });
}

connect("background_loaded");
