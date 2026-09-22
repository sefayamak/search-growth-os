/**
 * GA4 Data API istemcisi (runReport). Sozlesme GSC ile ayni: kimlik yoksa
 * `null`, sayi uydurma yok, kapsam salt-okunur (`analytics.readonly`).
 */
import type { DateRange, Ga4Row } from "./index.ts";
import { accessToken, googleJson, loadServiceAccount, type ServiceAccount } from "./google-auth.ts";

export const GA4_ENV = "SEARCH_GROWTH_GA4_CREDENTIALS_JSON";
export const GA4_SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];
const API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * AI referans kaynaklari. Registry'den gelir, kod icine GOMULMEZ — marka
 * kaliplarinda oldugu gibi. Ortam degiskeni yoksa bilinen liste varsayilan
 * olur; yeni bir asistan cikinca kod degistirmeden eklenebilsin.
 */
export const AI_REFERRERS = (process.env.SEARCH_GROWTH_AI_REFERRERS ?? "chatgpt.com,perplexity.ai,copilot.microsoft.com,gemini.google.com,claude.ai,you.com,bing.com/chat")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);


/**
 * Gozlenen durum. "Kimlik var" ile "API cevap verdi" ayri seylerdir ve rapor
 * ikisini karistirmamali: 14 satir OK yazarken baslikta UNKNOWN gormek,
 * kendiyle celisen bir rapordur. Bu bayragi YALNIZCA gercek bir 200 yanit
 * kaldirir; tahmin etmez.
 */
let observed: "CONNECTED" | "ERROR" | null = null;
export const observedState = () => observed;
export const _resetObserved = () => { observed = null; };

function creds(): ServiceAccount | null { return loadServiceAccount(GA4_ENV); }
const token = (sa: ServiceAccount) => accessToken(sa, GA4_SCOPES, process.env.SEARCH_GROWTH_GA4_SUBJECT || undefined);

/** `properties/123456789` ya da duz `123456789` — ikisi de kabul. */
const propPath = (property: string) => (property.startsWith("properties/") ? property : `properties/${property}`);

interface ReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
}

const METRICS = ["sessions", "engagedSessions", "conversions", "totalRevenue"];

/** Tek rapor cagrisi + sayfalama. GA4 varsayilani 10000 satir; GSC'deki ayni
 *  sessiz kesme riski burada da var. */
async function runReport(
  property: string, range: DateRange, dimensions: string[],
  dimensionFilter?: Record<string, unknown>,
  metrics: string[] = METRICS,
): Promise<Ga4Row[] | null> {
  const sa = creds();
  if (!sa) return null;
  const tok = await token(sa);
  const url = `${API}/${propPath(property)}:runReport`;
  const LIMIT = 10000;
  const out: Ga4Row[] = [];
  for (let offset = 0; ; offset += LIMIT) {
    let res: ReportResponse;
    try { res = await googleJson<ReportResponse>(url, tok, {
      method: "POST",
      body: {
        dateRanges: [{ startDate: range.start, endDate: range.end }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        ...(dimensionFilter ? { dimensionFilter } : {}),
        limit: LIMIT, offset,
      },
    }); } catch (e) { observed = "ERROR"; throw e; }
    observed = "CONNECTED";
    const rows = res.rows ?? [];
    const dims = res.dimensionHeaders?.map((h) => h.name) ?? dimensions;
    const mets = res.metricHeaders?.map((h) => h.name) ?? metrics;
    for (const r of rows) {
      const get = (n: string) => Number(r.metricValues?.[mets.indexOf(n)]?.value ?? 0);
      const dim = (n: string) => r.dimensionValues?.[dims.indexOf(n)]?.value;
      out.push({
        date: dim("date"), landingPage: dim("landingPagePlusQueryString") ?? dim("pagePath"),
        source: dim("sessionSource"), medium: dim("sessionMedium"), eventName: dim("eventName"),
        sessions: get("sessions"), engagedSessions: get("engagedSessions"),
        conversions: get("conversions"), revenue: get("totalRevenue"),
      });
    }
    if (rows.length < LIMIT) break;
  }
  return out;
}

export const landingPages = (p: string, r: DateRange) => runReport(p, r, ["date", "landingPagePlusQueryString"]);

/** Organik arama edinimi — kanal degil KAYNAK/ARAC ile: "Organic Search"
 *  kanal grubu AI asistanlarini da yutabiliyor ve ikisini ayirmak istiyoruz. */
export const organicAcquisition = (p: string, r: DateRange) =>
  runReport(p, r, ["date", "sessionSource", "sessionMedium"], {
    filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "organic" } },
  });

/** AI asistanlarindan gelen referanslar. Filtre sunucu tarafinda: tum
 *  kaynaklari cekip yerelde elemek, buyuk mulklerde sayfalama sinirina
 *  carpar ve kuyrugu sessizce kaybeder. */
export const aiReferrals = (p: string, r: DateRange) =>
  runReport(p, r, ["date", "sessionSource", "sessionMedium"], {
    orGroup: { expressions: AI_REFERRERS.map((host) => ({ filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: host, caseSensitive: false } } })) },
  });

export const conversions = (p: string, r: DateRange, events: string[]) =>
  runReport(p, r, ["date", "eventName"], events.length
    ? { filter: { fieldName: "eventName", inListFilter: { values: events } } }
    : undefined, ["sessions", "engagedSessions", "conversions", "totalRevenue", "eventCount"]);

export async function smokeTest(property: string): Promise<{ ok: boolean; reason: string }> {
  const sa = creds();
  if (!sa) return { ok: false, reason: `${GA4_ENV} tanimli degil` };
  try {
    const d = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    const rows = await runReport(property, { start: d(9), end: d(2) }, ["date"]);
    if (rows === null) return { ok: false, reason: "kimlik okunamadi" };
    return { ok: true, reason: `${rows.length} gunluk satir` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
