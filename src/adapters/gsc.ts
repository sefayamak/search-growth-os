/**
 * Google Search Console istemcisi — Phase 1 stub'larinin yerine gercek cagri.
 *
 * Sozlesme degismedi: kimlik yoksa `null` doner ve cagiran NOT_CONNECTED
 * raporlar. Sayi UYDURULMAZ. Fark su: kimlik VARSA artik gercekten olculur.
 *
 * Kapsam bilerek salt-okunur (`webmasters.readonly`). Sitemap gonderme,
 * URL kaldirma gibi yazma islemleri bu katmanda YOK; bunlar production'a
 * dokunan eylemler ve degisiklik yonetimi yolundan gecer.
 */
import type { DateRange, SearchAnalyticsRow } from "./index.ts";
import { accessToken, googleJson, loadServiceAccount, type ServiceAccount } from "./google-auth.ts";

export const GSC_ENV = "SEARCH_GROWTH_GSC_CREDENTIALS_JSON";
export const GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
const API = "https://searchconsole.googleapis.com";

/** Property adi URL'de gecerken kodlanmali: `sc-domain:x.com` ve URL-prefix
 *  property'lerin ikisi de ':' ve '/' iceriyor. */
const prop = (property: string) => encodeURIComponent(property);

function creds(): ServiceAccount | null {
  return loadServiceAccount(GSC_ENV);
}

async function token(sa: ServiceAccount): Promise<string> {
  // Delegation yalnizca acikca istendiginde; bkz. google-auth.ts.
  return accessToken(sa, GSC_SCOPES, process.env.SEARCH_GROWTH_GSC_SUBJECT || undefined);
}

type ApiRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };

/**
 * Search Analytics — TUM satirlar.
 *
 * API tek cagrida en fazla 25000 satir doner ve sessizce keser. Sayfalama
 * yapilmazsa "marka disi trafik" gibi bir olcum, kesilen kuyrugu hic gormeden
 * hesaplanir ve YANLIS cikar — ustelik hata vermez. (Ayni sinifin hatasi mail
 * alimi tarafinda bir kez yasanmisti: sayfalama yok, 300 mesaj sinirinda
 * sessiz kayip.)
 */
export async function searchAnalytics(
  property: string,
  range: DateRange,
  dimensions: ("date" | "page" | "query" | "country" | "device" | "searchAppearance")[],
): Promise<SearchAnalyticsRow[] | null> {
  const sa = creds();
  if (!sa) return null;
  const tok = await token(sa);
  const url = `${API}/webmasters/v3/sites/${prop(property)}/searchAnalytics/query`;
  const PAGE = 25000;
  const out: SearchAnalyticsRow[] = [];
  for (let startRow = 0; ; startRow += PAGE) {
    const body = {
      startDate: range.start,
      endDate: range.end,
      dimensions,
      rowLimit: PAGE,
      startRow,
      // `dataState: "all"` taze ama kismi veriyi de getirir; varsayilan
      // "final" birakiliyor cunku donem karsilastirmasi yapiyoruz ve kismi
      // son gunler dususmus gibi gorunurdu.
      type: "web",
    };
    const res = await googleJson<{ rows?: ApiRow[] }>(url, tok, { method: "POST", body });
    const rows = res.rows ?? [];
    for (const r of rows) {
      const row: SearchAnalyticsRow = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
      dimensions.forEach((d, i) => { (row as unknown as Record<string, unknown>)[d] = r.keys?.[i]; });
      out.push(row);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** URL Inspection — Google'in SECTIGI canonical ve indeks durumu.
 *  Gunluk kota dar (property basina 2000, dakikada 600): tek tek cagrilir,
 *  toplu tarama icin degildir. */
export async function urlInspection(property: string, url: string): Promise<Record<string, unknown> | null> {
  const sa = creds();
  if (!sa) return null;
  const tok = await token(sa);
  const res = await googleJson<{ inspectionResult?: Record<string, unknown> }>(
    `${API}/v1/urlInspection/index:inspect`,
    tok,
    { method: "POST", body: { inspectionUrl: url, siteUrl: property, languageCode: "tr-TR" } },
  );
  return res.inspectionResult ?? null;
}

/** Sitemaps API — gonderilmis sitemap'ler, son indirme ve hata sayilari. */
export async function sitemaps(property: string): Promise<Record<string, unknown>[] | null> {
  const sa = creds();
  if (!sa) return null;
  const tok = await token(sa);
  const res = await googleJson<{ sitemap?: Record<string, unknown>[] }>(`${API}/webmasters/v3/sites/${prop(property)}/sitemaps`, tok);
  return res.sitemap ?? [];
}

/**
 * Salt-okunur duman testi: kimlik gercekten CALISIYOR mu?
 *
 * "Env dolu" ile "API cevap veriyor" ayri seylerdir. Servis hesabi
 * property'ye eklenmemisse 403 doner ve bu, kimligin var olmasiyla
 * gizlenmemeli — o yuzden durum UNKNOWN degil, sebebiyle raporlanir.
 */
export async function smokeTest(property: string): Promise<{ ok: boolean; reason: string }> {
  const sa = creds();
  if (!sa) return { ok: false, reason: `${GSC_ENV} tanimli degil` };
  try {
    const rows = await searchAnalytics(property, { start: isoDaysAgo(9), end: isoDaysAgo(2) }, ["date"]);
    if (rows === null) return { ok: false, reason: "kimlik okunamadi" };
    return { ok: true, reason: `${rows.length} gunluk satir` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}
