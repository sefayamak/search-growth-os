// Cadence tests lock the three ways this measurement goes confidently wrong:
// a build-stamped sitemap read as publish dates, a service URL mistaken for an article,
// and a "days since publish" number invented where no date exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  parseDate, daysBetween, discoverContentSection, lastmodIsInformative,
  publishSignalFromHtml, cadenceToMarkdown, assessCadence, assessPortfolio,
  DEFAULT_CADENCE_DAYS, type CadenceResult,
} from "../src/cadence.ts";

const NOW = new Date("2026-09-20T12:00:00Z");

test("parseDate refuses garbage, prehistory and the future", () => {
  assert.equal(parseDate("2026-09-10", NOW), "2026-09-10");
  assert.equal(parseDate("2026-09-10T08:30:00+03:00", NOW), "2026-09-10");
  assert.equal(parseDate("yakında", NOW), null);
  assert.equal(parseDate("", NOW), null);
  assert.equal(parseDate(undefined, NOW), null);
  assert.equal(parseDate("1970-01-01", NOW), null, "epoch default is a data error, not a publish date");
  // A future stamp is a CMS mistake. Accepting it would report a stale site as fresh.
  assert.equal(parseDate("2027-01-01", NOW), null);
});

test("daysBetween counts whole days back", () => {
  assert.equal(daysBetween("2026-09-10", NOW), 10);
  assert.equal(daysBetween("2026-09-20", NOW), 0);
});

test("content section is found by path segment, never substring", () => {
  const found = discoverContentSection([
    "https://x.com/blog/seo-rehberi",
    "https://x.com/blog/aeo-nedir",
    "https://x.com/hizmetler/fotograf",
  ]);
  assert.deepEqual(found, { pattern: "blog", urlCount: 2 });

  // The failure this prevents: a service page whose slug merely contains a section word
  // being counted as an article, which would make a dormant site look active.
  assert.equal(discoverContentSection([
    "https://x.com/kurumsal-blogger-paketi",
    "https://x.com/haberler-hakkinda",
    "https://x.com/newsletter",
  ]), null);

  // A bare section index is not an article.
  assert.equal(discoverContentSection(["https://x.com/blog/"]), null);

  // Most-populated pattern wins so one stray URL cannot pick the section.
  assert.equal(discoverContentSection([
    "https://x.com/news/one",
    "https://x.com/makale/a", "https://x.com/makale/b", "https://x.com/makale/c",
  ])!.pattern, "makale");
});

test("uniform sitemap lastmod is rejected as evidence", () => {
  const uniform = Array.from({ length: 30 }, (_, i) => ({ loc: `https://x.com/blog/${i}`, lastmod: "2026-09-19" }));
  assert.equal(lastmodIsInformative(uniform), false, "a build stamp must not read as 30 fresh posts");

  const real = [
    { loc: "https://x.com/blog/a", lastmod: "2026-09-01" },
    { loc: "https://x.com/blog/b", lastmod: "2026-07-14" },
    { loc: "https://x.com/blog/c", lastmod: "2025-11-02" },
  ];
  assert.equal(lastmodIsInformative(real), true);

  assert.equal(lastmodIsInformative([{ loc: "https://x.com/blog/a" }]), false, "no lastmod is not evidence either");
});

test("publish signal prefers what the page states about itself", () => {
  const jsonLd = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"BlogPosting","datePublished":"2026-09-05","dateModified":"2026-09-18"}
  </script></head><body>x</body></html>`;
  const a = publishSignalFromHtml(jsonLd, "https://x.com/blog/a", NOW)!;
  assert.equal(a.date, "2026-09-05", "datePublished outranks dateModified");
  assert.equal(a.source, "jsonld_datePublished");
  assert.equal(a.confidence, "CONFIRMED");

  // dateModified alone proves the page changed, not that anything new was published.
  const modOnly = `<html><head><script type="application/ld+json">
    {"@type":"Article","dateModified":"2026-09-18"}</script></head><body>x</body></html>`;
  const b = publishSignalFromHtml(modOnly, "https://x.com/blog/b", NOW)!;
  assert.equal(b.source, "jsonld_dateModified");
  assert.equal(b.confidence, "CANDIDATE", "a modification date can never be CONFIRMED freshness");

  const meta = `<html><head><meta property="article:published_time" content="2026-08-30T10:00:00Z"></head><body>x</body></html>`;
  assert.equal(publishSignalFromHtml(meta, "https://x.com/blog/c", NOW)!.date, "2026-08-30");

  const timeEl = `<html><body><time datetime="2026-08-01">1 Ağustos</time></body></html>`;
  assert.equal(publishSignalFromHtml(timeEl, "https://x.com/blog/d", NOW)!.source, "time_element");

  // Nothing stated means nothing claimed.
  assert.equal(publishSignalFromHtml(`<html><body><p>metin</p></body></html>`, "https://x.com/blog/e", NOW), null);
});

test("@graph nesting is still read", () => {
  const graph = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"BlogPosting","datePublished":"2026-09-02"}]}
  </script>`;
  assert.equal(publishSignalFromHtml(graph, "https://x.com/blog/g", NOW)!.date, "2026-09-02");
});

const result = (over: Partial<CadenceResult>): CadenceResult => ({
  siteId: "s", domain: "s.com", onboardingStatus: "active", contentSection: null, sitemapUrls: 0,
  latestPublish: null, daysSincePublish: null, expectedCadenceDays: DEFAULT_CADENCE_DAYS,
  expectedSource: "default", verdict: "UNKNOWN", label: "FACT", notes: [], recentContent: [], ...over,
});

test("markdown reports UNKNOWN as UNKNOWN and never as zero", () => {
  const md = cadenceToMarkdown([result({ siteId: "quiet", verdict: "UNKNOWN", notes: ["no publish date stated"] })], NOW);
  assert.match(md, /\| UNKNOWN \|/);
  assert.doesNotMatch(md, /\| 0 \|/, "a missing measurement must never render as a zero-day gap");
  assert.match(md, /no publish date stated/);
});

test("markdown sorts the worst first", () => {
  const md = cadenceToMarkdown([
    result({ siteId: "fine", verdict: "OK", daysSincePublish: 2 }),
    result({ siteId: "late", verdict: "OVERDUE", daysSincePublish: 40 }),
    result({ siteId: "due", verdict: "DUE", daysSincePublish: 16 }),
  ], NOW);
  const order = ["late", "due", "fine"].map((id) => md.indexOf(`| ${id} |`));
  assert.ok(order[0] < order[1] && order[1] < order[2], "OVERDUE must lead the table");
});

test("the default cadence is disclosed as a default, not presented as the site's norm", () => {
  const md = cadenceToMarkdown([result({ siteId: "s", verdict: "DUE", daysSincePublish: 20 })], NOW);
  assert.match(md, /14d \(default\)/);
  assert.match(md, /INFERENCE/, "the report must say the verdict is inferred");
});

// ── End-to-end against a controlled site ───────────────────────────────────────
// A purpose-built fixture, separate from the audit fixture, so the cadence scenarios
// (a dormant blog, a build-stamped sitemap, a site with no blog at all) can be
// expressed exactly without disturbing the crawl tests.

interface FixtureSpec {
  /** sitemap entries: [path, lastmod?] */
  urls: [string, string?][];
  /** path -> HTML */
  pages: Record<string, string>;
  robots?: string;
}

function startSite(spec: FixtureSpec): Promise<{ server: Server; origin: string; host: string }> {
  const server = createServer((req, res) => {
    const host = `http://${req.headers.host}`;
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(spec.robots ?? `User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n`);
    }
    if (p === "/sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
        + spec.urls.map(([u, lm]) => `<url><loc>${host}${u}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`).join("")
        + `</urlset>`;
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(body);
    }
    const html = spec.pages[p];
    if (!html) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html><body>404</body></html>"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ server, origin: `http://127.0.0.1:${a.port}`, host: `http://127.0.0.1:${a.port}` });
  }));
}

const post = (date: string, title: string) =>
  `<html><head><title>${title}</title><script type="application/ld+json">`
  + `{"@context":"https://schema.org","@type":"BlogPosting","headline":"${title}","datePublished":"${date}"}`
  + `</script></head><body><h1>${title}</h1><p>İçerik.</p></body></html>`;

test("end to end: a dormant blog is measured, not guessed", async () => {
  const site = await startSite({
    urls: [["/", "2026-09-19"], ["/blog/a", "2026-09-05"], ["/blog/b", "2026-07-02"], ["/blog/c", "2025-12-01"]],
    pages: {
      "/": "<html><head><title>Ana sayfa</title></head><body>x</body></html>",
      "/blog/a": post("2026-09-05", "AEO nedir"),
      "/blog/b": post("2026-07-02", "Ürün çekimi"),
      "/blog/c": post("2025-12-01", "Eski yazı"),
    },
  });
  try {
    const r = await assessCadence(
      { id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [], cadenceDays: 10 },
      { now: NOW, delayMs: 0, samplePages: 4 },
    );
    assert.equal(r.contentSection?.pattern, "blog");
    assert.equal(r.contentSection?.urlCount, 3);
    assert.equal(r.latestPublish?.date, "2026-09-05");
    assert.equal(r.latestPublish?.source, "jsonld_datePublished", "the page's own claim beats the sitemap's");
    assert.equal(r.daysSincePublish, 15);
    assert.equal(r.verdict, "DUE", "15 days against a 10-day cadence is due, not yet double");
    assert.equal(r.expectedSource, "registry");
    assert.equal(r.label, "INFERENCE", "the verdict compares a measurement to a threshold");
    assert.equal(r.recentContent[0].date, "2026-09-05", "recent content is newest first");
  } finally { site.server.close(); }
});

test("end to end: double the cadence reads OVERDUE", async () => {
  const site = await startSite({
    urls: [["/blog/old"]],
    pages: { "/blog/old": post("2026-07-01", "Tek yazı") },
  });
  try {
    const r = await assessCadence(
      { id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [], cadenceDays: 10 },
      { now: NOW, delayMs: 0 },
    );
    assert.equal(r.daysSincePublish, 81);
    assert.equal(r.verdict, "OVERDUE");
  } finally { site.server.close(); }
});

test("end to end: a site with no editorial section is not called late", async () => {
  const site = await startSite({
    urls: [["/"], ["/hizmetler/fotograf"], ["/iletisim"]],
    pages: {
      "/": "<html><head><title>Ana</title></head><body>x</body></html>",
      "/hizmetler/fotograf": "<html><head><title>Fotoğraf</title></head><body>x</body></html>",
      "/iletisim": "<html><head><title>İletişim</title></head><body>x</body></html>",
    },
  });
  try {
    const r = await assessCadence({ id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [] }, { now: NOW, delayMs: 0 });
    assert.equal(r.verdict, "NO_CONTENT_SECTION");
    assert.equal(r.daysSincePublish, null, "a site that never blogged has no gap to report");
  } finally { site.server.close(); }
});

test("end to end: a build-stamped sitemap cannot fake freshness", async () => {
  // Every URL carries today's date and no page states a publish date. A naive reader
  // would announce "published today". The honest answer is UNKNOWN.
  const urls: [string, string?][] = Array.from({ length: 8 }, (_, i) => [`/blog/p${i}`, "2026-09-20"]);
  const pages: Record<string, string> = {};
  for (const [u] of urls) pages[u] = `<html><head><title>Yazı</title></head><body><p>Tarihsiz.</p></body></html>`;
  const site = await startSite({ urls, pages });
  try {
    const r = await assessCadence({ id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [], cadenceDays: 10 }, { now: NOW, delayMs: 0 });
    assert.equal(r.verdict, "UNKNOWN");
    assert.equal(r.daysSincePublish, null);
    assert.ok(r.notes.some((n) => /build stamp/.test(n)), "the report must say why the dates were discarded");
    assert.ok(r.notes.some((n) => /datePublished/.test(n)), "and must say what would make it measurable");
  } finally { site.server.close(); }
});

test("end to end: robots-disallowed content is not opened", async () => {
  const site = await startSite({
    urls: [["/blog/open"], ["/blog/private/x"]],
    pages: { "/blog/open": post("2026-09-01", "Açık"), "/blog/private/x": post("2026-09-18", "Gizli") },
    robots: "User-agent: *\nDisallow: /blog/private/\n",
  });
  try {
    const r = await assessCadence({ id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [] }, { now: NOW, delayMs: 0 });
    assert.equal(r.latestPublish?.date, "2026-09-01", "the disallowed newer post must not be fetched");
    assert.ok(r.recentContent.every((c) => !c.url.includes("/private/")));
  } finally { site.server.close(); }
});

test("an unreachable host is an error, never a clean result", async () => {
  // Port 1 on loopback refuses instantly.
  const results = await assessPortfolio(
    [{ id: "dead", domain: "http://127.0.0.1:1", onboardingStatus: "active", sitemaps: [] }],
    { now: NOW, delayMs: 0, timeoutMs: 2000 },
  );
  assert.equal(results[0].verdict, "UNKNOWN");
  assert.ok(results[0].error, "the failure must be carried, so the run can exit non-zero");
  assert.equal(results[0].daysSincePublish, null);
});

test("a NO_CONTENT_SECTION verdict shows the site's real structure", async () => {
  // Without this, "no blog found" is indistinguishable from "our pattern list is missing
  // this site's word for a blog" — the difference between a finding and a blind spot.
  const site = await startSite({
    urls: [["/"], ["/hizmetler/a"], ["/hizmetler/b"], ["/projeler/x"]],
    pages: {
      "/": "<html><head><title>A</title></head><body>x</body></html>",
      "/hizmetler/a": "<html><head><title>A</title></head><body>x</body></html>",
      "/hizmetler/b": "<html><head><title>B</title></head><body>x</body></html>",
      "/projeler/x": "<html><head><title>X</title></head><body>x</body></html>",
    },
  });
  try {
    const r = await assessCadence({ id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [] }, { now: NOW, delayMs: 0 });
    assert.equal(r.verdict, "NO_CONTENT_SECTION");
    const structure = r.notes.find((n) => n.startsWith("the site's own top-level structure"));
    assert.ok(structure, "the report must show what the site does have");
    assert.match(structure!, /hizmetler \(2\)/);
    assert.match(structure!, /projeler \(1\)/);
  } finally { site.server.close(); }
});

test("a registry-declared section is found where no generic word would match", async () => {
  // The real failure this fixes: pamistanbul.com publishes under /pamlab/, and the generic
  // word list reported it as having no content line at all across 726 URLs. A false
  // negative is quieter than a false positive and therefore worse — it hides real work.
  const site = await startSite({
    urls: [["/"], ["/pamlab/aeo-nedir"], ["/pamlab/ai-video"], ["/hizmetler/x"]],
    pages: {
      "/": "<html><head><title>Ana</title></head><body>x</body></html>",
      "/pamlab/aeo-nedir": post("2026-09-03", "AEO nedir"),
      "/pamlab/ai-video": post("2026-08-14", "AI video"),
      "/hizmetler/x": "<html><head><title>H</title></head><body>x</body></html>",
    },
  });
  try {
    const undeclared = await assessCadence(
      { id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [], cadenceDays: 10 },
      { now: NOW, delayMs: 0 },
    );
    assert.equal(undeclared.verdict, "NO_CONTENT_SECTION", "without a declaration the brand word is invisible");

    const declared = await assessCadence(
      { id: "t", domain: site.host, onboardingStatus: "active", sitemaps: [], cadenceDays: 10, contentSections: ["pamlab"] },
      { now: NOW, delayMs: 0 },
    );
    assert.equal(declared.contentSection?.pattern, "pamlab");
    assert.equal(declared.latestPublish?.date, "2026-09-03");
    assert.equal(declared.daysSincePublish, 17);
    assert.equal(declared.verdict, "DUE");
  } finally { site.server.close(); }
});

test("a declared section is normalised and cannot be outvoted by a generic one", () => {
  // Slashes and case are forgiving; the declaration still competes on URL count.
  assert.equal(discoverContentSection(["https://x.com/pamlab/a"], ["/PamLab/"])!.pattern, "pamlab");
  assert.equal(discoverContentSection([
    "https://x.com/pamlab/a",
    "https://x.com/blog/a", "https://x.com/blog/b", "https://x.com/blog/c",
  ], ["pamlab"])!.pattern, "blog", "declaring a section does not force it to win");
});
