// Pre-deploy mode: audit a local build in its PRODUCTION URL space.
//
// The point of the alias is that only the transport changes. If the URLs themselves were
// rewritten to localhost, every absolute canonical on the site would read as a cross-host
// defect and the real ones would be buried — which is exactly what the guard below pins.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { crawl, transportUrl, productionUrl, fetchPage } from "../src/crawler.ts";
import { runAudit } from "../src/audit.ts";

const PROD = "https://example.com";
let server: Server;
let local = "";

const html = (path: string) => `<!doctype html><html lang="en"><head><title>Page ${path}</title>
  <link rel="canonical" href="${PROD}${path}"/><meta name="viewport" content="width=device-width"/></head>
  <body><h1>Page</h1><p>${"word ".repeat(200)}</p><a href="/b">b</a></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`User-agent: *\nAllow: /\nSitemap: ${PROD}/sitemap.xml\n`); }
    if (path === "/sitemap.xml") { res.writeHead(200, { "content-type": "application/xml" }); return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PROD}/</loc></url><url><loc>${PROD}/b</loc></url></urlset>`); }
    // A local-origin Location header: the crawl must come back to production space.
    if (path === "/old") { res.writeHead(308, { location: `${local}/b` }); return res.end(); }
    if (path === "/" || path === "/b") { res.writeHead(200, { "content-type": "text/html" }); return res.end(html(path)); }
    res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>not found</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

test("origin mapping is a pure swap in both directions", () => {
  const a = { from: PROD, to: "http://127.0.0.1:9" };
  assert.equal(transportUrl(`${PROD}/x`, a), "http://127.0.0.1:9/x");
  assert.equal(productionUrl("http://127.0.0.1:9/x", a), `${PROD}/x`);
  // A same-prefix but different host must not be swapped.
  assert.equal(transportUrl("https://example.com.evil.test/x", a), "https://example.com.evil.test/x");
  assert.equal(transportUrl(`${PROD}/x`, undefined), `${PROD}/x`);
});

test("a local-origin redirect target is brought back into production space", async () => {
  const p = await fetchPage(`${PROD}/old`, { userAgent: "t", timeoutMs: 5000, originAlias: { from: PROD, to: local } });
  assert.equal(p.status, 200);
  assert.equal(p.finalUrl, `${PROD}/b`, "redirect dragged the crawl into localhost space");
});

test("the audit sees production URLs, so self-canonicals do not read as cross-host", async () => {
  const result = await crawl({ startUrl: `${PROD}/`, fromSitemap: true, maxPages: 10, maxDepth: 2, delayMs: 0, timeoutMs: 5000, originAlias: { from: PROD, to: local } });
  assert.ok(result.records.length >= 2, `fetched ${result.records.length} pages`);
  assert.ok(result.records.every((r) => r.page.url.startsWith(PROD)), "records left production URL space");
  const ids = runAudit(result).map((f) => f.id);
  assert.ok(!ids.includes("canonical.cross_host"), "self-canonical misread as cross-host");
  assert.ok(!ids.includes("canonical.missing"));
});
