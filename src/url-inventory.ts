/**
 * URL envanteri — her URL icin tek kayit, her alan UNKNOWN olabilir.
 *
 * Tasarim kurali: bir URL'yi baska bir URL'ye "birlestirmeyiz". `http://www.x/` ile
 * `https://x/` iki ayri URL'dir; aralarindaki iliski yalnizca sayfanin KENDI
 * `rel=canonical` beyani varsa `variant_of` ile baglanir. Tahminle birlestirmek
 * (www'yu sil, /en/'i at) iki dilli bir sitenin yarisini sessizce yok eder.
 */
import type { CrawlRecord } from "./types.ts";

export type Unk<T> = T | "UNKNOWN";
export type InspectionState = "INSPECTED" | "NOT_INSPECTED" | "ERROR" | "UNKNOWN";
/** NEUTRAL, Google'in kendi sozcugudur; "indekslenmedi" demek oldugunu dogrulamadik
 *  (developers.google.com bu sandbox'tan erisilemez), o yuzden ham haliyle tasinir. */
export type IndexVerdict = "INDEXED" | "NOT_INDEXED" | "NEUTRAL" | "UNKNOWN";

export interface UrlInspectionSummary {
  state: InspectionState;
  index_verdict: IndexVerdict;
  coverage_state: Unk<string>;
  indexing_state: Unk<string>;
  page_fetch_state: Unk<string>;
  robots_txt_state: Unk<string>;
  google_canonical: Unk<string>;
  user_canonical: Unk<string>;
  last_crawl_time: Unk<string>;
  /** state=ERROR ise HTTP kodu + kisa neden. "indekslenmemis" DEGILDIR. */
  error?: string;
  label: "FACT";
  confidence: "CONFIRMED" | "UNKNOWN";
}

export type InventorySource = "sitemap" | "crawl" | "inspection";

export interface UrlInventoryRecord {
  site: string;
  url: string;
  sources: InventorySource[];
  in_sitemap: Unk<boolean>;          // sitemap hic verilmediyse UNKNOWN; verilip URL yoksa false
  http_status: Unk<number>;
  final_url: Unk<string>;
  /** TURETILMIS (INFERENCE): 200 + noindex yok. Inspection'in cevabi degil. */
  indexable: Unk<boolean>;
  canonical: Unk<string | null>;     // null = sayfa canonical beyan etmiyor
  variant_of: string | null;         // yalnizca sayfanin kendi canonical beyaniyla
  hreflang_count: Unk<number>;
  title: Unk<string | null>;
  meta_description: Unk<string | null>;
  json_ld_types: Unk<string[]>;
  last_crawled_at: Unk<string>;
  inspection: UrlInspectionSummary | null;   // null = hic denetlenmedi (NOT_INSPECTED)
  derived_fields: string[];
}

export interface InventoryInput {
  site: string;
  /** null = sitemap bilgisi yok (in_sitemap UNKNOWN). [] = sitemap okundu ve bos. */
  sitemapEntries: string[] | null;
  crawl?: { records: CrawlRecord[]; finishedAt?: string } | null;
  inspections?: Record<string, UrlInspectionSummary>;
}

/** Fragment atilir, host kucuk harf, varsayilan port atilir (URL bunu yapar). Yol, sorgu ve
 *  sondaki egik cizgi OLDUGU GIBI kalir: bunlar farkli URL'dir. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

const noindex = (r: CrawlRecord) =>
  [...(r.html?.metaRobots ?? []), ...(r.html?.metaGooglebot ?? []), ...r.xRobots].some((d) => d.toLowerCase().includes("noindex"));

export function buildInventory(input: InventoryInput): { records: UrlInventoryRecord[]; invalid: string[] } {
  const invalid: string[] = [];
  const map = new Map<string, UrlInventoryRecord>();
  const sitemapSet = input.sitemapEntries ? new Set(input.sitemapEntries.map(normalizeUrl).filter((x): x is string => !!x)) : null;

  const ensure = (url: string): UrlInventoryRecord => {
    let r = map.get(url);
    if (!r) {
      r = {
        site: input.site, url, sources: [], in_sitemap: sitemapSet ? sitemapSet.has(url) : "UNKNOWN",
        http_status: "UNKNOWN", final_url: "UNKNOWN", indexable: "UNKNOWN", canonical: "UNKNOWN", variant_of: null,
        hreflang_count: "UNKNOWN", title: "UNKNOWN", meta_description: "UNKNOWN", json_ld_types: "UNKNOWN",
        last_crawled_at: "UNKNOWN", inspection: null, derived_fields: [],
      };
      map.set(url, r);
    }
    return r;
  };
  const addSource = (r: UrlInventoryRecord, s: InventorySource) => { if (!r.sources.includes(s)) r.sources.push(s); };

  // Sitemap-only URL'ler sessizce dusmez: crawl alanlari UNKNOWN kalir, kayit durur.
  for (const raw of input.sitemapEntries ?? []) {
    const u = normalizeUrl(raw);
    if (!u) { invalid.push(raw); continue; }
    addSource(ensure(u), "sitemap");
  }

  for (const c of input.crawl?.records ?? []) {
    const u = normalizeUrl(c.page.url);
    if (!u) { invalid.push(c.page.url); continue; }
    const r = ensure(u);
    addSource(r, "crawl");
    r.http_status = c.page.status;
    r.final_url = normalizeUrl(c.page.finalUrl) ?? c.page.finalUrl;
    r.last_crawled_at = input.crawl?.finishedAt ?? "UNKNOWN";
    if (c.html) {
      r.canonical = c.html.canonical;
      r.hreflang_count = c.html.hreflang.length;
      r.title = c.html.title;
      r.meta_description = c.html.metaDescription;
      r.json_ld_types = [...new Set(c.html.jsonLd.flatMap((b) => b.types))].sort();
      r.indexable = c.page.status === 200 && !noindex(c);
      r.derived_fields = ["indexable"];
    } else if (c.page.status !== 200) {
      // HTML yok ama yanit durumu biliniyor: 200 degilse indekslenebilir degil.
      r.indexable = false;
      r.derived_fields = ["indexable"];
    }
  }

  for (const [raw, summary] of Object.entries(input.inspections ?? {})) {
    const u = normalizeUrl(raw);
    if (!u) { invalid.push(raw); continue; }
    const r = ensure(u);
    addSource(r, "inspection");
    r.inspection = summary;
  }

  // variant_of: yalnizca sayfanin KENDI canonical beyani, hedef de envanterdeyse.
  for (const r of map.values()) {
    if (typeof r.canonical !== "string") continue;
    const target = normalizeUrl(r.canonical);
    const self = typeof r.final_url === "string" ? r.final_url : r.url;
    if (target && target !== self && target !== r.url && map.has(target)) r.variant_of = target;
  }

  return { records: [...map.values()].sort((a, b) => a.url.localeCompare(b.url)), invalid };
}
