import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/html.ts";
import { parseRobots, isAllowed } from "../src/robots.ts";
import { parseSitemap } from "../src/sitemap.ts";

test("parseHtml extracts core signals", () => {
  const p = parseHtml(`<html lang="en"><head><title>T &amp; U</title><meta name="robots" content="NOINDEX, nofollow"><link rel="canonical" href="/x"><link rel="alternate" hreflang="en" href="/x"><script type="application/ld+json">{"@type":"WebPage","name":"T"}</script></head><body><h1>Hi</h1><a href="/a" rel="nofollow">A</a><a href="https://other.com/">B</a><img src="/i.png" alt=""><img src="/j.png"></body></html>`, "https://site.test/p");
  assert.equal(p.title, "T & U");
  assert.deepEqual(p.metaRobots, ["noindex", "nofollow"]);
  assert.equal(p.canonical, "https://site.test/x");
  assert.equal(p.hreflang[0].href, "https://site.test/x");
  assert.equal(p.links.length, 2);
  assert.equal(p.links[0].internal, true);
  assert.deepEqual(p.links[0].rel, ["nofollow"]);
  assert.equal(p.links[1].internal, false);
  assert.equal(p.images[0].alt, "");
  assert.equal(p.images[1].alt, null);
  assert.deepEqual(p.jsonLd[0].types, ["WebPage"]);
});

test("robots.txt longest-match and group selection", () => {
  const r = parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/public\n\nUser-agent: Googlebot\nDisallow: /g/\nSitemap: https://s/sm.xml", 200, true);
  assert.equal(isAllowed(r, "SearchGrowthOS", "https://s/private/x"), false);
  assert.equal(isAllowed(r, "SearchGrowthOS", "https://s/private/public/x"), true);
  assert.equal(isAllowed(r, "Googlebot", "https://s/private/x"), true); // Googlebot group overrides *
  assert.equal(isAllowed(r, "Googlebot", "https://s/g/x"), false);
  assert.deepEqual(r.sitemaps, ["https://s/sm.xml"]);
  assert.equal(isAllowed(parseRobots("", 503, true), "Googlebot", "https://s/"), false);
  assert.equal(isAllowed(parseRobots("", 404, true), "Googlebot", "https://s/"), true);
});

test("sitemap index and urlset", () => {
  const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://s/a.xml</loc></sitemap></sitemapindex>`);
  assert.deepEqual(idx.children, ["https://s/a.xml"]);
  const set = parseSitemap(`<urlset><url><loc> https://s/p </loc><lastmod>2026-01-01</lastmod></url></urlset>`);
  assert.deepEqual(set.entries, [{ loc: "https://s/p", lastmod: "2026-01-01" }]);
});
