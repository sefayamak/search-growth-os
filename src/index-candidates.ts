/**
 * index-probe aday havuzu — sitemap + GSC tabanli, segmentli, stateless ornekleme.
 *
 * Neden segment: Phase 1 adaylari yalniz son 28 gunde GSC'de gozlenen URL'lerdi.
 * Bu, Google'in zaten gosterdigi sayfalari iyi temsil eder ama sitemap'te olup bu
 * pencerede hic gozlenmeyen URL'leri temsil etmez; 5/5 INDEXED bu yuzden "site
 * saglikli" demek degildi.
 *
 * Bu modul YALNIZ saf mantik icerir (ag yok): hangi URL hangi segmente girer,
 * her segmentten bugun hangileri secilir. Segment ADLARI iddia tasir; bu yuzden
 * dikkatle secildi:
 *   - SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW: "GSC'de yok" DEGIL. 28 gunluk page
 *     dataset'inde gozlenmedi. Bir hata degildir; yalniz daha az gozlenmis, daha
 *     yuksek inceleme oncelikli bir havuzdur.
 *   - HOST_VARIANT_RISK: canonical/redirect hatasi IDDIA ETMEZ. Henuz hicbir sayfa
 *     fetch edilmiyor; yalniz GSC'de uretim origin'inden farkli scheme/host ile
 *     gorunen URL'lerdir. (CANONICAL_OR_REDIRECT_RISK fetch kaniti ister: Phase 1.5b.)
 *
 * URL ESITLIGI: yalnizca parse/normalize + fragment atma (normalizeUrl). Sondaki "/"
 * SILINMEZ: `/a` ve `/a/` canonical ya da redirect kaniti olmadikca iki ayri URL'dir.
 * Tahminle birlestirme yok ilkesi burada da gecerli.
 */
import { createHash } from "node:crypto";
import { normalizeUrl } from "./url-inventory.ts";
import { hostAllowed, HARD_LIMIT } from "./index-probe.ts";

/** Siralama ayni zamanda oncelik ve bos slot aktarim sirasidir. */
export const SEGMENTS = [
  "SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW",
  "HOST_VARIANT_RISK",
  "GSC_NOT_IN_SITEMAP",
  "SITEMAP_AND_GSC",
] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Toplam 20. Baska bir limit istendiginde oranla olceklenir. */
export const BASE_QUOTA: Record<Segment, number> = {
  SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW: 10,
  HOST_VARIANT_RISK: 5,
  GSC_NOT_IN_SITEMAP: 2,
  SITEMAP_AND_GSC: 3,
};
const BASE_TOTAL = SEGMENTS.reduce((s, k) => s + BASE_QUOTA[k], 0);

/** Bir kaynak ya olculdu ya olculemedi. Olculemeyen kaynak BOS KUME DEGILDIR. */
export type UrlSource = { state: "MEASURED"; urls: string[] } | { state: "UNKNOWN"; reason: string };

export type SegmentPool = { state: "COMPUTED"; urls: string[] } | { state: "UNKNOWN"; reason: string };

export interface CandidateBuild {
  pools: Record<Segment, SegmentPool>;
  rejected: { url: string; reason: string }[];
}

/** GSC'de uretim origin'inden (scheme + host) farkli gorunen URL mi? */
export function isHostVariant(url: string, canonicalOrigin: string): boolean {
  return new URL(url).origin !== new URL(canonicalOrigin).origin;
}

function prepare(source: UrlSource, productionDomain: string, label: string, rejected: CandidateBuild["rejected"]): Set<string> | null {
  if (source.state === "UNKNOWN") return null;
  const out = new Set<string>();
  for (const raw of source.urls) {
    const n = normalizeUrl(raw);
    if (!n) { rejected.push({ url: raw, reason: `${label}: gecersiz URL` }); continue; }
    if (!hostAllowed(n, productionDomain)) { rejected.push({ url: raw, reason: `${label}: host ${productionDomain} (apex/www) disinda` }); continue; }
    out.add(n);
  }
  return out;
}

/**
 * Kaynaklardan segment havuzlarini kur. Havuzlar AYRIKTIR: bir URL tek segmente girer
 * (GSC'de gozlenen her URL once D, B ya da C'ye; geri kalan sitemap URL'leri A'ya).
 *
 * Kaynak durumu kurallari (yanlis negatif korumasi):
 *  - GSC UNKNOWN  -> hicbir segment hesaplanmaz. Sitemap'in tamami "GSC'de gozlenmedi"
 *    diye A'ya doldurulmaz.
 *  - sitemap UNKNOWN -> A, B, C hesaplanmaz. GSC URL'lerinin tamami "sitemap'te yok"
 *    diye B'ye doldurulmaz. D yalniz GSC + uretim origin'ine bagli oldugu icin hesaplanir.
 */
export function segmentCandidates(i: { sitemap: UrlSource; gsc: UrlSource; canonicalOrigin: string; productionDomain: string }): CandidateBuild {
  const rejected: CandidateBuild["rejected"] = [];
  const gsc = prepare(i.gsc, i.productionDomain, "GSC", rejected);
  const sm = prepare(i.sitemap, i.productionDomain, "sitemap", rejected);

  const unknown = (reason: string): SegmentPool => ({ state: "UNKNOWN", reason });
  if (!gsc) {
    const reason = `GSC 28 gunluk page dataset'i okunamadi (${(i.gsc as { reason: string }).reason}); hicbir segment hesaplanmadi`;
    return { rejected, pools: Object.fromEntries(SEGMENTS.map((s) => [s, unknown(reason)])) as Record<Segment, SegmentPool> };
  }

  const D: string[] = [], B: string[] = [], C: string[] = [], A: string[] = [];
  for (const u of gsc) {
    if (isHostVariant(u, i.canonicalOrigin)) D.push(u);
    else if (sm?.has(u)) C.push(u);
    else if (sm) B.push(u);
  }
  if (sm) for (const u of sm) if (!gsc.has(u)) A.push(u);

  const smReason = sm ? "" : `sitemap evreni okunamadi (${(i.sitemap as { reason: string }).reason})`;
  return {
    rejected,
    pools: {
      SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW: sm ? { state: "COMPUTED", urls: A } : unknown(smReason),
      HOST_VARIANT_RISK: { state: "COMPUTED", urls: D },
      GSC_NOT_IN_SITEMAP: sm ? { state: "COMPUTED", urls: B } : unknown(smReason),
      SITEMAP_AND_GSC: sm ? { state: "COMPUTED", urls: C } : unknown(smReason),
    },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** SHA-256 sirasi: kaynak sirasindan bagimsiz, kararli. */
export function hashSorted(urls: string[]): string[] {
  return [...urls].map((u) => [sha(u), u] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
}

/**
 * Stateless gunluk rotasyon: hash-sirali listede, baslangic = (gun * q) mod n,
 * dongusel q ardisik URL. Ayni gun + ayni veri = ayni secim. n gun icinde degisirse
 * pencere kayar; bu YAKLASIK bir turdur, tam tur garantisi verilmez.
 */
export function rotate(urls: string[], q: number, dayIndex: number): string[] {
  const sorted = hashSorted(urls);
  const n = sorted.length;
  if (q <= 0 || n === 0) return [];
  if (q >= n) return sorted;
  const start = (dayIndex * q) % n;
  return Array.from({ length: q }, (_, k) => sorted[(start + k) % n]);
}

/** Taban kotalari limite oranla (en buyuk kalan yontemi; esitlikte oncelik sirasi). */
export function scaleQuota(limit: number): Record<Segment, number> {
  const raw = SEGMENTS.map((s) => (limit * BASE_QUOTA[s]) / BASE_TOTAL);
  const q = raw.map(Math.floor);
  let left = limit - q.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) { if (left <= 0) break; q[o.i]++; left--; }
  return Object.fromEntries(SEGMENTS.map((s, i) => [s, q[i]])) as Record<Segment, number>;
}

/**
 * Kota dagitimi. Havuzu kotasindan kucuk (ya da UNKNOWN) segmentin bos slotlari,
 * oncelik sirasiyla (A, D, B, C) BIRER BIRER, havuzunda hala URL'si olan segmentlere
 * aktarilir; ayni URL ile asla doldurulmaz. Havuzlarin toplami limitten azsa daha az
 * probe yapilir. Hicbir durumda toplam limit ya da HARD_LIMIT'i asmaz.
 */
export function allocate(pools: Record<Segment, SegmentPool>, limit: number): Record<Segment, number> {
  const cap = Math.max(0, Math.min(Math.floor(limit), HARD_LIMIT));
  const size = (s: Segment) => (pools[s].state === "COMPUTED" ? (pools[s] as { urls: string[] }).urls.length : 0);
  const base = scaleQuota(cap);
  const quota = Object.fromEntries(SEGMENTS.map((s) => [s, Math.min(base[s], size(s))])) as Record<Segment, number>;
  let free = cap - SEGMENTS.reduce((a, s) => a + quota[s], 0);
  while (free > 0) {
    let moved = false;
    for (const s of SEGMENTS) {
      if (free > 0 && quota[s] < size(s)) { quota[s]++; free--; moved = true; }
    }
    if (!moved) break;
  }
  return quota;
}

export interface SegmentSelection {
  day_index: number;
  /** Her zaman "stateless": raporda yaklasik tur oldugunu acik tutmak icin tasinir. */
  rotation: "stateless_approximate";
  segments: Record<Segment, { state: "COMPUTED" | "UNKNOWN"; reason?: string; pool: number | null; quota: number }>;
  /** Calistirma sirasi: A, D, B, C. */
  order: { url: string; segment: Segment }[];
}

export function selectSegmented(i: { pools: Record<Segment, SegmentPool>; limit: number; dayIndex: number }): SegmentSelection {
  const quota = allocate(i.pools, i.limit);
  const seen = new Set<string>();
  const order: SegmentSelection["order"] = [];
  const segments = {} as SegmentSelection["segments"];
  for (const s of SEGMENTS) {
    const p = i.pools[s];
    if (p.state === "UNKNOWN") { segments[s] = { state: "UNKNOWN", reason: p.reason, pool: null, quota: 0 }; continue; }
    segments[s] = { state: "COMPUTED", pool: p.urls.length, quota: quota[s] };
    for (const u of rotate(p.urls, quota[s], i.dayIndex)) {
      if (seen.has(u)) continue; // havuzlar ayrik; yine de savunma
      seen.add(u);
      order.push({ url: u, segment: s });
    }
  }
  return { day_index: i.dayIndex, rotation: "stateless_approximate", segments, order };
}
