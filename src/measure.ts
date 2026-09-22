// Ölçüm katmanı: dönem karşılaştırması ve marka / marka-dışı ayrımı.
//
// Bu dosya VERİ ÇEKMEZ. Adapter'lar credential yokken `null` döner ve bu katman
// da o durumu olduğu gibi taşır: uydurulmuş satır üretmez, "tahmini" yazmaz.
// Amacı, credential geldiği gün analizin hazır olması — ve gelmediği sürece
// eksikliğin görünür kalması.
//
// Marka deseni HARDCODE EDİLMEZ. Kaynağı registry'deki `brand_entities` ve
// `people_entities`; yani her site kendi desenini config'te taşır.
import type { SearchAnalyticsRow } from "./adapters/index.ts";
import type { SiteEntry } from "./registry.ts";

export interface Period { label: string; start: string; end: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/**
 * Search Console verisi ~2 gün gecikmeli gelir; "bugün"den başlamak son iki günü
 * yarım veriyle karşılaştırmaya sokar ve her raporu yapay bir düşüşle açar.
 */
export function periods(today: Date, lagDays = 2): { current: Period; previous: Period; yearAgo: Period } {
  const end = shift(today, -lagDays);
  const start = shift(end, -27);
  const prevEnd = shift(start, -1);
  const prevStart = shift(prevEnd, -27);
  const yaEnd = shift(end, -364);      // 52 tam hafta: gün-of-week hizası korunur
  const yaStart = shift(yaEnd, -27);
  return {
    current: { label: "son 28 gün", start: iso(start), end: iso(end) },
    previous: { label: "önceki 28 gün", start: iso(prevStart), end: iso(prevEnd) },
    yearAgo: { label: "geçen yıl aynı dönem", start: iso(yaStart), end: iso(yaEnd) },
  };
}

/** Türkçe'nin noktasız ı / noktalı i farkı aramada eşleşmeyi bozar; ikisi de eşitlenir. */
export function normalizeQuery(s: string): string {
  return s.toLocaleLowerCase("tr")
    .replace(/[ıİi]/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Marka desenleri registry'den türetilir. Tek kelimelik bir marka adı
 * ("pam") başka bağlamlarda da geçer, ama Search Console sorgusu zaten
 * siteye gelen aramadır: orada "pam" marka aramasıdır. Yine de desen
 * config'te durur, burada değil — site kendi kararını verir.
 */
export function brandPatterns(site: Pick<SiteEntry, "brand_entities" | "people_entities" | "production_domain">): string[] {
  const raw = [...(site.brand_entities ?? []), ...(site.people_entities ?? []),
               site.production_domain, site.production_domain?.replace(/\..*$/, "")];
  const out = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "string") continue;
    const n = normalizeQuery(r);
    if (n) out.add(n);
  }
  return [...out].sort();
}

export type QueryClass = "brand" | "non-brand";

/** Sorgu, marka desenlerinden herhangi birini kelime olarak içeriyorsa markadır. */
export function classifyQuery(query: string, patterns: string[]): QueryClass {
  const q = ` ${normalizeQuery(query)} `;
  return patterns.some((p) => q.includes(` ${p} `)) ? "brand" : "non-brand";
}

export interface Totals { clicks: number; impressions: number; ctr: number; position: number; queries: number }
export interface BrandSplit { brand: Totals; nonBrand: Totals; all: Totals }

const empty = (): Totals => ({ clicks: 0, impressions: 0, ctr: 0, position: 0, queries: 0 });

/** Satırları markaya göre böler. CTR ve pozisyon ortalaması ağırlıklı hesaplanır. */
export function splitByBrand(rows: SearchAnalyticsRow[], patterns: string[]): BrandSplit {
  const acc = { brand: empty(), nonBrand: empty(), all: empty() };
  const posW = { brand: 0, nonBrand: 0, all: 0 };
  for (const r of rows) {
    const key = r.query ? (classifyQuery(r.query, patterns) === "brand" ? "brand" : "nonBrand") : "nonBrand";
    for (const t of [key, "all"] as const) {
      acc[t].clicks += r.clicks; acc[t].impressions += r.impressions; acc[t].queries += 1;
      posW[t] += r.position * r.impressions;     // pozisyon gösterimle ağırlıklandırılır
    }
  }
  for (const t of ["brand", "nonBrand", "all"] as const) {
    acc[t].ctr = acc[t].impressions ? acc[t].clicks / acc[t].impressions : 0;
    acc[t].position = acc[t].impressions ? posW[t] / acc[t].impressions : 0;
  }
  return acc;
}

export interface TopicOpportunity {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  score: number;
}

/**
 * İÇERİK FIRSATI — GERÇEK TALEP, UYDURULMUŞ TREND DEĞİL.
 *
 * Bu fonksiyon Google Trends, rakip analizi ya da dış bir "trend" kaynağı
 * KULLANMAZ — böyle bir bağlantı yok. Yaptığı tek şey: sitenin KENDİ Search
 * Console verisinde, insanların ZATEN arayıp siteyi ZATEN gördüğü ama
 * tıklamadığı sorguları öne çıkarmak. "Trend" değil "kanıtlanmış talep,
 * karşılıksız kalmış" — aradaki fark önemli: biri tahmin, biri ölçüm.
 *
 * Eşikler:
 *   - marka dışı sorgu (marka arayan zaten sana geliyor, konu değil)
 *   - sıra 5–30 arası: 1–4 zaten kazanılmış, 30'dan uzak sıralar için
 *     "içerik eksik" değil "otorite eksik" daha olası açıklama
 *   - gösterim ≥ eşik: tek kişilik arama bir içerik kararına temel olmaz
 *
 * score = gösterim / sıra — çok gösterim + iyi sıraya yakınlık en üstte.
 * Kesin bir formül değil, sıralama için kaba bir öncelik.
 */
export function topicOpportunities(
  rows: SearchAnalyticsRow[],
  patterns: string[],
  opts: { minImpressions?: number; minPosition?: number; maxPosition?: number; top?: number } = {},
): TopicOpportunity[] {
  const { minImpressions = 20, minPosition = 5, maxPosition = 30, top = 15 } = opts;
  const out: TopicOpportunity[] = [];
  for (const r of rows) {
    if (!r.query) continue;
    if (classifyQuery(r.query, patterns) === "brand") continue;
    if (r.impressions < minImpressions) continue;
    if (r.position < minPosition || r.position > maxPosition) continue;
    out.push({ query: r.query, impressions: r.impressions, clicks: r.clicks, position: r.position, score: r.impressions / r.position });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, top);
}

export type Measured<T> = { state: "CONNECTED"; data: T } | { state: "NOT_CONNECTED"; reason: string };

/** Adapter `null` döndüyse sonuç NOT_CONNECTED'dir — sıfır DEĞİL. Aradaki fark önemli. */
export function measured<T>(data: T | null, reason: string): Measured<T> {
  return data === null ? { state: "NOT_CONNECTED", reason } : { state: "CONNECTED", data };
}
