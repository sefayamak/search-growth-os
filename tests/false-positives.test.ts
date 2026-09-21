// Regression guard for a detector defect, not for a site defect.
//
// The first portfolio-wide run reported 256 "hreflang set lacks a self-reference"
// findings across two bilingual sites whose markup was correct. Every one of them was a
// query-string variant (?category=tote) that canonicalizes to the clean URL. hreflang is
// read on the canonical URL, so a variant is not a member of the set and must not list
// itself. Acting on those findings would have added self-references to non-canonical URLs
// — pushing correct sites towards a real defect on the authority of a broken instrument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/html.ts";
import { runAudit } from "../src/audit.ts";
import type { CrawlResult, CrawlRecord } from "../src/types.ts";

const SET = `
  <link rel="alternate" hreflang="en" href="https://example.com/en/shop"/>
  <link rel="alternate" hreflang="tr" href="https://example.com/tr/magaza"/>
  <link rel="alternate" hreflang="x-default" href="https://example.com/en/shop"/>`;

const page = (url: string, canonical: string): CrawlRecord => {
  const body = `<!doctype html><html lang="en"><head><title>Shop — Example</title>
    <link rel="canonical" href="${canonical}"/>${SET}</head>
    <body><h1>Shop</h1><p>${"word ".repeat(200)}</p></body></html>`;
  return {
    page: { url, finalUrl: url, status: 200, redirectChain: [], headers: {}, contentType: "text/html", body, bytes: body.length, fetchMs: 1 },
    html: parseHtml(body, url), xRobots: [], depth: 0, discoveredFrom: null, contentHash: url,
  };
};

const result = (records: CrawlRecord[]): CrawlResult => ({
  site: "https://example.com", startedAt: "", finishedAt: "", durationMs: 1,
  options: { startUrl: "https://example.com/", fromSitemap: false, maxPages: 10, maxDepth: 2, delayMs: 0, userAgent: "t", respectRobots: true, timeoutMs: 1000, sameHostOnly: true },
  robots: { raw: "", status: 200, fetched: true, groups: [], sitemaps: [] },
  sitemapUrls: [], sitemapEntries: [], records, skippedByRobots: [], crawlerAccess: [],
} as unknown as CrawlResult);

const noSelf = (r: CrawlResult) => runAudit(r).filter((f) => f.id === "i18n.hreflang_no_self");

test("a parameter variant that canonicalizes elsewhere is not judged against the hreflang set", () => {
  const variants = ["tote", "crossbody", "clutch"].map((c) =>
    page(`https://example.com/en/shop?category=${c}`, "https://example.com/en/shop"));
  assert.deepEqual(noSelf(result(variants)).map((f) => f.url), []);
});

test("the canonical URL itself is still judged, and a genuinely missing self-reference is reported", () => {
  // Canonical == crawled URL, and the set lists only the other language.
  const body = `<!doctype html><html lang="tr"><head><title>Mağaza</title>
    <link rel="canonical" href="https://example.com/tr/magaza"/>
    <link rel="alternate" hreflang="en" href="https://example.com/en/shop"/></head>
    <body><h1>Mağaza</h1><p>${"kelime ".repeat(200)}</p></body></html>`;
  const rec: CrawlRecord = {
    page: { url: "https://example.com/tr/magaza", finalUrl: "https://example.com/tr/magaza", status: 200, redirectChain: [], headers: {}, contentType: "text/html", body, bytes: body.length, fetchMs: 1 },
    html: parseHtml(body, "https://example.com/tr/magaza"), xRobots: [], depth: 0, discoveredFrom: null, contentHash: "x",
  };
  assert.deepEqual(noSelf(result([rec])).map((f) => f.url), ["https://example.com/tr/magaza"]);
});

test("a self-referencing canonical page with a complete set is clean", () => {
  assert.deepEqual(noSelf(result([page("https://example.com/en/shop", "https://example.com/en/shop")])), []);
});

// ── Same root cause, two more detectors ──────────────────────────────────────
// Duplicate-signal checks must reason about the canonical URL set. Counting parameter
// variants (which Google consolidates) and counting one final URL twice (normal when a
// sitemap entry and a redirect land on the same page) both invent duplicates that the
// site does not have: 9 duplicate-title and 7 duplicate-text findings on the live
// portfolio, every one of them against correct markup.
import { crawl } from "../src/crawler.ts";
import { createServer } from "node:http";

test("parameter variants are not counted as duplicate titles or duplicate text", () => {
  const pages = [
    page("https://example.com/en/shop", "https://example.com/en/shop"),
    ...["tote", "clutch"].map((c) => page(`https://example.com/en/shop?category=${c}`, "https://example.com/en/shop")),
  ];
  const ids = runAudit(result(pages)).map((f) => f.id);
  assert.ok(!ids.includes("meta.title_duplicate"), "variant counted as a duplicate title");
  assert.ok(!ids.includes("content.duplicate_text"), "variant counted as duplicate text");
});

test("two distinct canonical pages sharing a title are still reported", () => {
  const a = page("https://example.com/en/shop", "https://example.com/en/shop");
  const b = page("https://example.com/en/store", "https://example.com/en/store");
  const dup = runAudit(result([a, b])).filter((f) => f.id === "meta.title_duplicate");
  assert.equal(dup.length, 1, "a real duplicate title was suppressed");
});

test("one final URL reached twice is one page", async () => {
  const body = `<!doctype html><html lang="en"><head><title>Home — Example</title>
    <link rel="canonical" href="https://example.com/en"/><meta name="viewport" content="width=device-width"/></head>
    <body><h1>Home</h1><p>${"word ".repeat(200)}</p></body></html>`;
  const srv = createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    if (p === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nAllow: /\n"); }
    // The sitemap lists /en; the start URL / redirects onto it. Same page, two request URLs.
    if (p === "/sitemap.xml") { res.writeHead(200, { "content-type": "application/xml" }); return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/en</loc></url></urlset>`); }
    if (p === "/") { res.writeHead(307, { location: "/en" }); return res.end(); }
    if (p === "/en") { res.writeHead(200, { "content-type": "text/html" }); return res.end(body); }
    res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>gone</body></html>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const r = await crawl({ startUrl: "https://example.com/", fromSitemap: true, maxPages: 10, maxDepth: 2, delayMs: 0, timeoutMs: 5000, originAlias: { from: "https://example.com", to: local } });
    const ids = runAudit(r).map((f) => f.id);
    assert.ok(!ids.includes("meta.title_duplicate"), "one page reached twice reported as two duplicate-title pages");
    assert.ok(!ids.includes("content.duplicate_text"), "one page reached twice reported as duplicate text");
  } finally { srv.close(); }
});

test("a real series named \"404 Magni\" is not a soft 404, an empty not-found page is", () => {
  const rich = `<!doctype html><html lang="en"><head><title>Yusuf Dikeç · 404 Magni — Commercial</title>
    <link rel="canonical" href="https://example.com/en/commercial/yusuf-dikec"/></head>
    <body><h1>404 Magni</h1><p>${"word ".repeat(200)}</p></body></html>`;
  const empty = `<!doctype html><html lang="en"><head><title>404 — Not Found</title>
    <link rel="canonical" href="https://example.com/en/gone"/></head><body><h1>Not found</h1></body></html>`;
  const rec = (u: string, b: string) => ({
    page: { url: u, finalUrl: u, status: 200, redirectChain: [], headers: {}, contentType: "text/html", body: b, bytes: b.length, fetchMs: 1 },
    html: parseHtml(b, u), xRobots: [], depth: 0, discoveredFrom: null, contentHash: u,
  } as CrawlRecord);
  const soft = runAudit(result([rec("https://example.com/en/commercial/yusuf-dikec", rich), rec("https://example.com/en/gone", empty)]))
    .filter((f) => f.id === "indexability.soft_404").map((f) => f.url);
  assert.deepEqual(soft, ["https://example.com/en/gone"]);
});

test("the entity graph is not judged against page copy; content markup still is", () => {
  // A founder Person node with @id/sameAs belongs on every page of a site. It is entity
  // data, not a claim about what this page is about, and removing it would weaken exactly
  // the signal that ties the brand to a named human.
  const graph = `<!doctype html><html lang="tr"><head><title>Ana sayfa</title>
    <link rel="canonical" href="https://example.com/"/>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","@id":"https://example.com/#founder","name":"Sefa Yamak","jobTitle":"Kurucu","sameAs":["https://www.linkedin.com/in/x"]}</script>
    </head><body><h1>Prodüksiyon</h1><p>${"kelime ".repeat(200)}</p></body></html>`;
  // A Product whose name appears nowhere on the page is the case the rule is FOR.
  const product = `<!doctype html><html lang="tr"><head><title>Ürün</title>
    <link rel="canonical" href="https://example.com/p"/>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Zirconia Kompozit Panel"}</script>
    </head><body><h1>Başlık</h1><p>${"kelime ".repeat(200)}</p></body></html>`;
  const rec = (u: string, b: string) => ({
    page: { url: u, finalUrl: u, status: 200, redirectChain: [], headers: {}, contentType: "text/html", body: b, bytes: b.length, fetchMs: 1 },
    html: parseHtml(b, u), xRobots: [], depth: 0, discoveredFrom: null, contentHash: u,
  } as CrawlRecord);
  const hits = runAudit(result([rec("https://example.com/", graph), rec("https://example.com/p", product)]))
    .filter((f) => f.id === "schema.not_in_visible_content").map((f) => f.url);
  assert.deepEqual(hits, ["https://example.com/p"]);
});

test("an image whose box CSS already reserves is not a CLS finding; a bare <img> still is", () => {
  const body = `<!doctype html><html lang="en"><head><title>Gallery — Example</title>
    <link rel="canonical" href="https://example.com/g"/></head><body><h1>Gallery</h1>
    <img alt="a" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0"/>
    <img alt="b" style="position:absolute;width:100%;height:100%"/>
    <img alt="c" src="/p.jpg" style="width:100%;aspect-ratio:0.8;object-fit:cover"/>
    <p>${"word ".repeat(200)}</p></body></html>`;
  const withBare = body.replace("</body>", `<img src="/c.jpg" alt="c"/></body>`);
  const rec = (u: string, b: string) => ({
    page: { url: u, finalUrl: u, status: 200, redirectChain: [], headers: {}, contentType: "text/html", body: b, bytes: b.length, fetchMs: 1 },
    html: parseHtml(b, u), xRobots: [], depth: 0, discoveredFrom: null, contentHash: u,
  } as CrawlRecord);
  const hits = runAudit(result([rec("https://example.com/g", body), rec("https://example.com/h", withBare)]))
    .filter((fd) => fd.id === "media.dimensions_missing");
  assert.deepEqual(hits.map((h) => h.url), ["https://example.com/h"]);
  assert.equal(hits[0].evidence.noDims, 1, "the two fill images were counted as well");
});

test("hreflang alternates sharing a title are one page in two languages, not duplicates", () => {
  // A series named after a place keeps that name in both languages.
  const mk = (url: string, other: string) => {
    const b = `<!doctype html><html><head><title>Nepal | Untitled Portraits</title>
      <link rel="canonical" href="${url}"/>
      <link rel="alternate" hreflang="en" href="${url.includes("/en/") ? url : other}"/>
      <link rel="alternate" hreflang="tr" href="${url.includes("/tr/") ? url : other}"/></head>
      <body><h1>Nepal</h1><p>${"word ".repeat(200)}</p></body></html>`;
    return { page: { url, finalUrl: url, status: 200, redirectChain: [], headers: {}, contentType: "text/html", body: b, bytes: b.length, fetchMs: 1 },
      html: parseHtml(b, url), xRobots: [], depth: 0, discoveredFrom: null, contentHash: url } as CrawlRecord;
  };
  const en = "https://example.com/en/series/nepal", tr = "https://example.com/tr/seriler/nepal";
  assert.deepEqual(runAudit(result([mk(en, tr), mk(tr, en)])).filter((fd) => fd.id === "meta.title_duplicate"), []);

  // Two same-language pages sharing a title, with no alternate link between them, still count.
  const plain = (u: string) => page(u, u);
  assert.equal(runAudit(result([plain("https://example.com/en/shop"), plain("https://example.com/en/store")]))
    .filter((fd) => fd.id === "meta.title_duplicate").length, 1);
});

test("an image link's anchor text is the image alt; a truly empty link still counts", () => {
  const body = `<!doctype html><html lang="en"><head><title>Shop grid — Example</title>
    <link rel="canonical" href="https://example.com/s"/></head><body><h1>Shop</h1>
    ${[1, 2, 3, 4].map((n) => `<a href="/p/${n}"><img alt="Green crochet crossbody bag ${n}" data-nimg="fill" style="position:absolute;width:100%;height:100%"/></a>`).join("")}
    <a href="/x"><span></span></a><a href="/y"><img alt="" src="/d.png"/></a>
    <p>${"word ".repeat(200)}</p></body></html>`;
  const rec = {
    page: { url: "https://example.com/s", finalUrl: "https://example.com/s", status: 200, redirectChain: [], headers: {}, contentType: "text/html", body, bytes: body.length, fetchMs: 1 },
    html: parseHtml(body, "https://example.com/s"), xRobots: [], depth: 0, discoveredFrom: null, contentHash: "s",
  } as CrawlRecord;
  assert.equal(rec.html!.links.filter((l) => !l.text).length, 2, "alt text was not read as anchor text");
  assert.equal(rec.html!.links.find((l) => l.href.endsWith("/p/1"))!.text, "Green crochet crossbody bag 1");
  // Two empty links is under the threshold the check uses, so nothing is reported.
  assert.deepEqual(runAudit(result([rec])).filter((fd) => fd.id === "links.empty_anchor_text"), []);
});
