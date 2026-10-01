/**
 * Sitemap evreni — yalniz ORKESTRASYON. Ayristirma src/sitemap.ts'in (mevcut) parseSitemap'idir;
 * robots.txt ayristirmasi src/robots.ts'in parseRobots'udur. Burada yeni parser yok.
 *
 * Sozlesme: sonuc ya tam okunmus bir evrendir (MEASURED) ya da UNKNOWN. KISMI evren
 * donmez: bir alt sitemap okunamadiysa elimizdeki yarim liste "evren" gibi kullanilirsa
 * her eksik URL "GSC'de gozlenmedi" ya da "sitemap'te yok" diye yanlis siniflanir.
 */
import { parseSitemap } from "./sitemap.ts";
import { parseRobots } from "./robots.ts";
import { fetchPage } from "./crawler.ts";
import { normalizeUrl } from "./url-inventory.ts";
import { hostAllowed } from "./index-probe.ts";

export interface FetchedText { status: number; body: string; error?: string }
export type FetchText = (url: string) => Promise<FetchedText>;

export type UniverseResult =
  | { state: "MEASURED"; urls: string[]; sitemaps: string[]; notes: string[] }
  | { state: "UNKNOWN"; reason: string; notes: string[] };

export const MAX_DEPTH = 3;
export const MAX_URLS = 200_000;

/** Varsayilan: mevcut crawler fetch'i (durust UA, redirect'leri elle izler). */
export function defaultFetchText(userAgent = process.env.SEARCH_GROWTH_USER_AGENT ?? "SearchGrowthOS/0.1"): FetchText {
  return async (url) => {
    const p = await fetchPage(url, { userAgent, timeoutMs: 15_000 });
    return { status: p.status, body: p.body, error: p.error };
  };
}

export async function readSitemapUniverse(o: {
  /** Registry'deki dogrulanmis sitemap konumlari. */
  locations: string[];
  /** Varsa robots.txt'teki `Sitemap:` satirlari da eklenir (yoksa/okunamazsa yalniz not). */
  robotsUrl?: string;
  productionDomain: string;
  fetchText: FetchText;
  maxDepth?: number;
  maxUrls?: number;
}): Promise<UniverseResult> {
  const notes: string[] = [];
  const maxDepth = o.maxDepth ?? MAX_DEPTH;
  const maxUrls = o.maxUrls ?? MAX_URLS;
  const roots: string[] = [];
  const addRoot = (raw: string, from: string) => {
    const n = normalizeUrl(raw);
    if (!n || !hostAllowed(n, o.productionDomain)) { notes.push(`${from}: sitemap konumu yok sayildi (gecersiz ya da host disi): ${raw}`); return; }
    if (!roots.includes(n)) roots.push(n);
  };
  for (const l of o.locations) addRoot(l, "registry");

  if (o.robotsUrl) {
    try {
      const r = await o.fetchText(o.robotsUrl);
      if (r.status === 200 && !r.error) for (const s of parseRobots(r.body, r.status, true).sitemaps) addRoot(s, "robots.txt");
      else notes.push(`robots.txt okunamadi (HTTP ${r.status}${r.error ? `, ${r.error}` : ""}); yalniz registry konumlari kullanildi`);
    } catch (e) { notes.push(`robots.txt okunamadi (${(e as Error).message}); yalniz registry konumlari kullanildi`); }
  }
  if (!roots.length) return { state: "UNKNOWN", reason: "kullanilabilir sitemap konumu yok", notes };

  const urls = new Set<string>();
  const visited = new Set<string>();
  const read: string[] = [];
  const queue: { url: string; depth: number }[] = roots.map((url) => ({ url, depth: 0 }));
  while (queue.length) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    let r: FetchedText;
    try { r = await o.fetchText(url); } catch (e) { return { state: "UNKNOWN", reason: `${url} okunamadi (${(e as Error).message})`, notes }; }
    if (r.status !== 200 || r.error) return { state: "UNKNOWN", reason: `${url} okunamadi (HTTP ${r.status}${r.error ? `, ${r.error}` : ""})`, notes };
    const parsed = parseSitemap(r.body);
    // Bos / ayristirilamayan cevap (HTML hata sayfasi, gzip) "bos sitemap" diye okunmaz.
    if (!parsed.entries.length && !parsed.children.length) return { state: "UNKNOWN", reason: `${url} gecerli <url>/<sitemap> girisi icermiyor`, notes };
    read.push(url);
    for (const e of parsed.entries) {
      const n = normalizeUrl(e.loc);
      if (!n || !hostAllowed(n, o.productionDomain)) { notes.push(`sitemap girisi yok sayildi (gecersiz ya da host disi): ${e.loc}`); continue; }
      urls.add(n);
      if (urls.size > maxUrls) return { state: "UNKNOWN", reason: `evren siniri asildi (> ${maxUrls}); kismi liste kullanilmaz`, notes };
    }
    for (const child of parsed.children) {
      const c = normalizeUrl(child);
      if (!c || !hostAllowed(c, o.productionDomain)) { notes.push(`alt sitemap yok sayildi (gecersiz ya da host disi): ${child}`); continue; }
      if (depth + 1 > maxDepth) return { state: "UNKNOWN", reason: `ic ice sitemap derinligi ${maxDepth}'u asti (${c}); okunmamis alt sitemap varken evren eksik kalir`, notes };
      queue.push({ url: c, depth: depth + 1 });
    }
  }
  return { state: "MEASURED", urls: [...urls].sort(), sitemaps: read, notes };
}
