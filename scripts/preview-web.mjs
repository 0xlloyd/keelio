// `pnpm run web:preview`: serves dist/web on http://localhost:4173 with the
// apps' Content-Security-Policy from dist/web/_headers, so a page that the
// policy would break on the real host breaks here first. Local use only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "web",
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".txt": "text/plain",
};
const csp = /Content-Security-Policy: (.*)/.exec(
  readFileSync(join(root, "_headers"), "utf8"),
)?.[1];
if (csp === undefined) throw new Error("no policy in dist/web/_headers");

createServer((req, res) => {
  const path = decodeURIComponent(
    new URL(req.url ?? "/", "http://localhost").pathname,
  );
  let file = join(root, path);
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, "index.html");
  }
  if (!(file + sep).startsWith(root + sep) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const headers = {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  };
  if (path.startsWith("/demo/") || path.startsWith("/dashboard/")) {
    headers["Content-Security-Policy"] = csp;
  }
  res.writeHead(200, headers).end(readFileSync(file));
}).listen(4173, "127.0.0.1");
