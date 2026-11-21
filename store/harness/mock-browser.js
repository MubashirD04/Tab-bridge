// A stand-in for the WebExtension `browser` API, so the real popup,
// onboarding and settings pages render sample data outside Firefox. The
// harness server injects it into extension pages requested with
// ?scenario=<name>. All sites, tabs and data here are made up.
(() => {
  const favicon = (color, letter) =>
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/>` +
        `<text x="8" y="12" font-family="sans-serif" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`
    );

  const checkout = {
    id: 11,
    title: "Checkout · Acme Outfitters",
    url: "http://localhost:5173/checkout",
    favIconUrl: favicon("#e8590c", "A"),
  };
  const staging = {
    id: 12,
    title: "Order history · Acme Outfitters",
    url: "https://staging.acme-outfitters.test/orders",
    favIconUrl: favicon("#e8590c", "A"),
  };
  const docs = {
    id: 13,
    title: "Payments API reference",
    url: "https://docs.example.com/payments",
    favIconUrl: favicon("#6e40c9", "D"),
  };

  const trustedPorts = [
    { port: 5000, protocol: "http", label: "Flask / Vite preview" },
    { port: 5500, protocol: "http", label: "VS Code Live Server" },
    { port: 5501, protocol: "https", label: "VS Code Live Server (HTTPS)" },
  ];

  const base = {
    connectionState: "connected",
    hostError: null,
    captureConsoleLogs: true,
    captureNetworkRequests: true,
    captureScreenshots: false,
    localAccess: true,
    mcpClients: ["claude-code"],
    trustedPorts,
  };

  const scenarios = {
    // Popup on the tab being debugged, shared, with a second shared tab.
    popup: {
      activeTab: checkout,
      status: {
        ...base,
        tabs: [
          { tabId: 11, title: checkout.title, url: checkout.url, favIconUrl: checkout.favIconUrl, allowed: true, source: "shared" },
          { tabId: 12, title: staging.title, url: staging.url, favIconUrl: staging.favIconUrl, allowed: true, source: "shared" },
          { tabId: 13, title: docs.title, url: docs.url, favIconUrl: docs.favIconUrl, allowed: false, source: null },
        ],
      },
    },
    // Popup on a tab that isn't shared.
    "popup-off": {
      activeTab: docs,
      status: {
        ...base,
        captureConsoleLogs: false,
        captureNetworkRequests: false,
        tabs: [{ tabId: 13, title: docs.title, url: docs.url, favIconUrl: docs.favIconUrl, allowed: false, source: null }],
      },
    },
    // Setup guide with every step done.
    onboarding: {
      activeTab: checkout,
      status: {
        ...base,
        mcpClients: ["claude-code", "claude-ai"],
        tabs: [{ tabId: 11, title: checkout.title, url: checkout.url, favIconUrl: checkout.favIconUrl, allowed: true, source: "shared" }],
      },
    },
    // Setup guide before the helper is installed.
    "onboarding-start": {
      activeTab: checkout,
      status: { ...base, connectionState: "host_missing", mcpClients: [], tabs: [] },
    },
    settings: {
      activeTab: checkout,
      status: { ...base, captureScreenshots: true, tabs: [] },
    },
  };

  const name = new URLSearchParams(location.search).get("scenario");
  const scenario = scenarios[name] || scenarios.popup;
  const listener = { addListener() {}, removeListener() {}, hasListener: () => false };

  window.browser = {
    runtime: {
      async sendMessage(message) {
        switch (message.type) {
          case "get_status":
            return structuredClone(scenario.status);
          case "update_trusted_ports":
            return { ok: true, trustedPorts: message.ports };
          default:
            return { ok: true };
        }
      },
      getManifest: () => ({
        version: "0.2.0",
        host_permissions: ["http://127.0.0.1/*", "http://localhost/*", "https://127.0.0.1/*", "https://localhost/*"],
      }),
      getURL: (p) => `/extension/${p}`,
      openOptionsPage: async () => {},
      onMessage: listener,
    },
    tabs: {
      query: async () => [structuredClone(scenario.activeTab)],
      create: async () => ({}),
    },
    permissions: {
      request: async () => true,
      remove: async () => true,
      contains: async () => true,
    },
  };
  // The popup closes itself after some actions; keep the frame.
  window.close = () => {};
  // Screenshots are taken the moment the page loads: skip switch animations
  // so they're captured in their final state.
  const still = document.createElement("style");
  still.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.documentElement.append(still);
})();
