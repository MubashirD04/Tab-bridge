// Serves the repo for the screenshot harness. Requests for extension pages
// with ?scenario=… get the mock `browser` API injected before their own
// scripts, so the real popup / onboarding / settings code renders sample data.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // POST /save?path=store/... saves a generated asset (base64 body). Limited
  // to store/ so the harness can't write anywhere else in the repo.
  if (req.method === "POST" && url.pathname === "/save") {
    const target = path.resolve(root, url.searchParams.get("path") || "");
    if (!target.startsWith(path.join(root, "store") + path.sep)) return res.writeHead(403).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(Buffer.concat(chunks).toString(), "base64"));
    return res.writeHead(200).end("saved");
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    let body = await readFile(file);
    if (url.pathname.startsWith("/extension/") && file.endsWith(".html") && url.searchParams.has("scenario")) {
      body = body.toString().replace("<head>", '<head>\n<script src="/store/harness/mock-browser.js"></script>');
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`harness on http://127.0.0.1:${port}/store/harness/`));
