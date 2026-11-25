// Renders the real extension pages (popup, setup guide, settings) with the
// store harness's mock `browser` API and saves them as 2x PNGs in public/ui/.
// Run from store/demo-video: node capture/capture.mjs
// Needs a Chromium; set CHROME to its path if it isn't /usr/bin/chromium.
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const out = path.resolve(here, "../public/ui");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

// Extra scenario for the video: the checkout tab before it's shared.
const EXTRA = `
    "popup-checkout-off": {
      activeTab: checkout,
      status: {
        ...base,
        tabs: [
          { tabId: 11, title: checkout.title, url: checkout.url, favIconUrl: checkout.favIconUrl, allowed: false, source: null },
          { tabId: 13, title: docs.title, url: docs.url, favIconUrl: docs.favIconUrl, allowed: false, source: null },
        ],
      },
    },
    "popup-checkout-on": {
      activeTab: checkout,
      status: {
        ...base,
        tabs: [
          { tabId: 11, title: checkout.title, url: checkout.url, favIconUrl: checkout.favIconUrl, allowed: true, source: "shared" },
          { tabId: 13, title: docs.title, url: docs.url, favIconUrl: docs.favIconUrl, allowed: false, source: null },
        ],
      },
    },
    "popup-off": {`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const file = path.join(repo, decodeURIComponent(url.pathname));
  if (!file.startsWith(repo)) return res.writeHead(403).end();
  try {
    let body = await readFile(file);
    if (url.pathname === "/store/harness/mock-browser.js") {
      body = body.toString().replace('"popup-off": {', EXTRA);
    }
    if (url.pathname.startsWith("/extension/") && file.endsWith(".html") && url.searchParams.has("scenario")) {
      body = body.toString().replace("<head>", '<head>\n<script src="/store/harness/mock-browser.js"></script>');
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/extension`;

const shots = [
  { name: "popup-off", page: "popup/popup.html?scenario=popup-checkout-off", width: 340, fit: true },
  { name: "popup-on", page: "popup/popup.html?scenario=popup-checkout-on", width: 340, fit: true },
  { name: "onboarding-start", page: "onboarding/onboarding.html?scenario=onboarding-start", width: 1200, height: 900 },
  { name: "onboarding-done", page: "onboarding/onboarding.html?scenario=onboarding", width: 1200, height: 900 },
  { name: "settings", page: "options/options.html?scenario=settings", width: 1200, height: 900 },
];

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/chromium",
  args: ["--force-color-profile=srgb", "--hide-scrollbars"],
});
try {
  for (const s of shots) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    // Fitted pages start short so the measured height is the content's, not the viewport's.
    await page.setViewport({ width: s.width, height: s.height || 100, deviceScaleFactor: 2 });
    await page.goto(`${base}/${s.page}`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 300));
    if (s.fit) {
      const h = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom));
      await page.setViewport({ width: s.width, height: h, deviceScaleFactor: 2 });
    }
    await page.screenshot({ path: path.join(out, `${s.name}.png`) });
    console.log(`public/ui/${s.name}.png`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
