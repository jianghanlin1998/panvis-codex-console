import { Server } from "node:net";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, sep, extname } from "node:path";
import { pathToFileURL } from "node:url";

// Some platforms inject additional process variables after fork; keep the application environment exact.
for (const name of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "NODE_ENV", "LANG"].includes(name)) delete process.env[name];

// Preview code runs in a disposable result snapshot. No Console cookie, token or provider environment.
process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
  const callback = typeof args.at(-1) === "function" ? args.at(-1) as () => void : undefined;
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") process.send?.({ type: "ready", port: address.port });
  });
  // Each preview gets an OS-selected loopback port, regardless of the app's ordinary deployment port.
  return originalListen.call(this, { host: "127.0.0.1", port: 0 }, callback);
} as typeof Server.prototype.listen;

async function main() {
  const entry = process.argv[2];
  if (entry === "server/index.mjs") { await import(pathToFileURL(resolve(entry)).href); return; }
  if (entry !== "index.html") throw new Error("PREVIEW_UNSUPPORTED");
  const directory = process.cwd();
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const path = resolve(directory, `.${pathname === "/" ? "/index.html" : pathname}`);
      const child = relative(directory, path);
      if (!child || child.startsWith(`..${sep}`) || child === ".." || child.split(sep).some(part => part.startsWith(".")) || !statSync(path).isFile()) throw new Error();
      const content = readFileSync(path);
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
      response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "content-length": content.length, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
}
void main().catch(() => { process.send?.({ type: "failed" }); process.exitCode = 1; process.disconnect?.(); });
