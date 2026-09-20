// Static fixture site for crawl/audit tests. Serves tests/fixtures/site with a
// few dynamic behaviours (redirect chain, X-Robots-Tag, soft 404, 500) that
// static files cannot express. Exported for tests; runnable standalone.
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "site");

export function startFixtureServer(port = 0): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (p === "/old-a") { res.writeHead(301, { location: "/old-b" }); return res.end(); }
    if (p === "/old-b") { res.writeHead(302, { location: "/services/" }); return res.end(); }
    if (p === "/header-noindex") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" }); return res.end("<html><head><title>Header noindex page</title></head><body><h1>Hidden by header</h1><p>Some text here to make it a page of content that matters.</p></body></html>"); }
    if (p === "/broken") { res.writeHead(500); return res.end("boom"); }
    if (p === "/soft404") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><head><title>404 Not Found</title></head><body><p>Page not found.</p></body></html>"); }
    if (p === "/admin/secret") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><head><title>Admin</title></head><body>admin</body></html>"); }
    let file = join(ROOT, p === "/" ? "index.html" : p.endsWith("/") ? p + "index.html" : p);
    if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
    if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html><head><title>Not found</title></head><body>404</body></html>"); }
    const type = file.endsWith(".xml") ? "application/xml" : file.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    // Sitemap fixtures are written against http://127.0.0.1/ ; rewrite to the live origin (random port).
    const origin = `http://${req.headers.host}`;
    res.end(file.endsWith(".xml") ? readFileSync(file, "utf8").replaceAll("http://127.0.0.1/", origin + "/") : readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ server, origin: `http://127.0.0.1:${a.port}` });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startFixtureServer(Number(process.env.PORT ?? 4321)).then(({ origin }) => console.log(`fixture site at ${origin}`));
}
