import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/ui/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/ui/app.css", ["app.css", "text/css; charset=utf-8"]],
]);
export function serveBrowserAsset(path: string, response: ServerResponse): boolean {
  const asset = assets.get(path);
  if (!asset) return false;
  const bytes = readFileSync(new URL(`../web/${asset[0]}`, import.meta.url));
  response.writeHead(200, { "content-type": asset[1]!, "content-length": bytes.length, "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  response.end(bytes);
  return true;
}
