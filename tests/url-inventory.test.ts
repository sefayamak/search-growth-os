// URL envanteri: her alan UNKNOWN olabilir ve hicbir URL tahminle baska bir URL'ye
// birlestirilmez. Iki dilli siteyi (/en/ ve TR) ve www/http varyantlarini sessizce
// ezmek, "temiz" gorunen ama yarisi eksik bir envanter uretir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildInventory, normalizeUrl, type UrlInventoryRecord } from "../src/url-inventory.ts";
import { classifyInspection } from "../src/index-probe.ts";
import type { CrawlRecord } from "../src/types.ts";

const SCHEMA = JSON.parse(readFileSync(new URL("../schemas/url-inventory.schema.json", import.meta.url), "utf8"));

function crawled(url: string, o: { status?: number; canonical?: string | null; robots?: string[]; finalUrl?: string; xRobots?: string[] } = {}): CrawlRecord {
  return {
    page: { url, finalUrl: o.finalUrl ?? url, status: o.status ?? 200, redirectChain: [], headers: {}, contentType: "text/html", body: "", bytes: 1, fetchMs: 1 },
    html: { title: "T", metaDescription: "D", metaRobots: o.robots ?? [], metaGooglebot: [], canonical: o.canonical === undefined ? null : o.canonical, canonicalCount: 1, hreflang: [], jsonLd: [{ raw: "", parsed: null, types: ["Article"] }] } as never,
    xRobots: o.xRobots ?? [], depth: 0, discoveredFrom: null, contentHash: "h",
  };
}

test("sitemap'te olup crawl'da olmayan URL sessizce dusmez: kayit durur, crawl alanlari UNKNOWN", () => {
  const { records } = buildInventory({ site: "pamistanbul", sitemapEntries: ["https://pamistanbul.com/a", "https://pamistanbul.com/b"], crawl: { records: [crawled("https://pamistanbul.com/a")] } });
  const b = records.find((r) => r.url === "https://pamistanbul.com/b")!;
  assert.deepEqual(b.sources, ["sitemap"]);
  assert.equal(b.in_sitemap, true);
  assert.equal(b.http_status, "UNKNOWN");
  assert.equal(b.indexable, "UNKNOWN");
  assert.equal(b.title, "UNKNOWN");
});

test("sitemap bilgisi YOKSA in_sitemap UNKNOWN; sitemap OKUNDU ve URL yoksa false", () => {
  const c = { records: [crawled("https://pamistanbul.com/a")] };
  assert.equal(buildInventory({ site: "pamistanbul", sitemapEntries: null, crawl: c }).records[0].in_sitemap, "UNKNOWN");
  assert.equal(buildInventory({ site: "pamistanbul", sitemapEntries: [], crawl: c }).records[0].in_sitemap, false);
});

test("www/http varyantlari AYRI kayit; beyan yoksa hicbiri baska birine baglanmaz", () => {
  const { records } = buildInventory({ site: "pamistanbul", sitemapEntries: null, crawl: { records: [crawled("http://www.pamistanbul.com/"), crawled("https://pamistanbul.com/")] } });
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.variant_of === null), "tahminle birlestirme yok");
});

test("variant_of YALNIZCA sayfanin kendi canonical beyaniyla ve hedef envanterdeyse", () => {
  const withDecl = buildInventory({ site: "pamistanbul", sitemapEntries: null, crawl: { records: [
    crawled("http://www.pamistanbul.com/", { canonical: "https://pamistanbul.com/", finalUrl: "http://www.pamistanbul.com/" }),
    crawled("https://pamistanbul.com/", { canonical: "https://pamistanbul.com/" }),
  ] } }).records;
  assert.equal(withDecl.find((r) => r.url.startsWith("http://www"))!.variant_of, "https://pamistanbul.com/");
  assert.equal(withDecl.find((r) => r.url === "https://pamistanbul.com/")!.variant_of, null, "kendine canonical = varyant degil");
  // Hedef envanterde yoksa baglanmaz (bagli olmayan bir URL'ye iddia kurmayiz).
  const orphan = buildInventory({ site: "pamistanbul", sitemapEntries: null, crawl: { records: [crawled("http://www.pamistanbul.com/", { canonical: "https://pamistanbul.com/" })] } }).records;
  assert.equal(orphan[0].variant_of, null);
});

test("iki dilli URL'ler (/en/ ve TR) birbirini ezmez", () => {
  const { records } = buildInventory({ site: "pamistanbul", sitemapEntries: ["https://pamistanbul.com/pamlab/x", "https://pamistanbul.com/en/pamlab/x"] });
  assert.equal(records.length, 2);
});

test("normalizeUrl: fragment atilir; sondaki egik cizgi ve sorgu KORUNUR; http disi reddedilir", () => {
  assert.equal(normalizeUrl("https://pamistanbul.com/a#bolum"), "https://pamistanbul.com/a");
  assert.notEqual(normalizeUrl("https://pamistanbul.com/a/"), normalizeUrl("https://pamistanbul.com/a"));
  assert.equal(normalizeUrl("https://pamistanbul.com/a?x=1"), "https://pamistanbul.com/a?x=1");
  assert.equal(normalizeUrl("mailto:x@y.com"), null);
  assert.equal(normalizeUrl("bu bir url degil"), null);
});

test("gecersiz URL envantere girmez ama gorunur kalir", () => {
  const { records, invalid } = buildInventory({ site: "pamistanbul", sitemapEntries: ["https://pamistanbul.com/a", "::::"] });
  assert.equal(records.length, 1);
  assert.deepEqual(invalid, ["::::"]);
});

test("indexable TURETILMISTIR ve oyle isaretlenir; noindex ve 404 false verir, 200 true", () => {
  const { records } = buildInventory({ site: "pamistanbul", sitemapEntries: null, crawl: { records: [
    crawled("https://pamistanbul.com/ok"),
    crawled("https://pamistanbul.com/ni", { robots: ["noindex"] }),
    crawled("https://pamistanbul.com/hdr", { xRobots: ["noindex, nofollow"] }),
    crawled("https://pamistanbul.com/gone", { status: 404 }),
  ] } });
  const by = (u: string) => records.find((r) => r.url.endsWith(u))!;
  assert.equal(by("/ok").indexable, true);
  assert.equal(by("/ni").indexable, false);
  assert.equal(by("/hdr").indexable, false);
  assert.equal(by("/gone").indexable, false);
  assert.deepEqual(by("/ok").derived_fields, ["indexable"]);
});

test("inspection olan ama crawl'da olmayan URL de kayit olur; denetlenmeyen URL'nin inspection'i null", () => {
  const insp = classifyInspection({ indexStatusResult: { verdict: "PASS" } });
  const { records } = buildInventory({ site: "pamistanbul", sitemapEntries: ["https://pamistanbul.com/a"], inspections: { "https://pamistanbul.com/z": insp } });
  assert.equal(records.find((r) => r.url.endsWith("/z"))!.inspection!.index_verdict, "INDEXED");
  assert.equal(records.find((r) => r.url.endsWith("/a"))!.inspection, null);
});

test("kayit anahtarlari semayla birebir uyumlu (sema ile kod ayrismasin)", () => {
  const { records } = buildInventory({ site: "pamistanbul", sitemapEntries: ["https://pamistanbul.com/a"], inspections: { "https://pamistanbul.com/a": classifyInspection(null) } });
  const r: UrlInventoryRecord = records[0];
  assert.deepEqual(Object.keys(r).sort(), Object.keys(SCHEMA.properties).sort());
  assert.deepEqual([...SCHEMA.required].sort(), Object.keys(SCHEMA.properties).sort());
  assert.deepEqual(Object.keys(r.inspection!).filter((k) => k !== "error").sort(), SCHEMA.$defs.inspection.required.slice().sort());
  assert.equal(SCHEMA.additionalProperties, false);
});

test("sema 'indekslenmemis'i yalnizca Google'in cevabina baglar; evidence label'i FACT'e sabit", () => {
  const v = SCHEMA.$defs.inspection.properties;
  assert.deepEqual(v.index_verdict.enum, ["INDEXED", "NOT_INDEXED", "NEUTRAL", "UNKNOWN"]);
  assert.equal(v.label.const, "FACT");
  assert.deepEqual(v.confidence.enum, ["CONFIRMED", "UNKNOWN"]);
});
