// Serves examples/web (the demo order-management site) on localhost.
//
//   node src/demo-site.ts [port]     (default 8787)

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../examples/web/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function startDemoSite(port = 8787): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actual}/` });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await startDemoSite(Number(process.argv[2] ?? 8787));
  console.log(`式神商事のデモサイト: ${url}  (Ctrl+C で終了)`);
}
