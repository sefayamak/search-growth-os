/**
 * index-probe — pamistanbul icin salt-okunur URL Inspection ornekleme.
 *
 * Bu bir "tam coverage" olcumu DEGILDIR. URL Inspection API sayfa basina tek URL
 * cevaplar; GSC'nin toplu Pages raporu API'de yok. Burada yapilan: kucuk, kota
 * korumali bir ORNEKLEM. Her cikti bunu basligina yazar.
 *
 * Guvenlik sozlesmesi (testlerle zorlanir):
 *   - yalnizca PROBE_SITE_ID; baska site kimligi reddedilir
 *   - yalnizca production domain'in apex/www hostlari; baska host atlanir
 *   - varsayilan dusuk limit, sert tavan; kota dolunca durur
 *   - 403/429 = ERROR ve kosu durur; "indekslenmemis" DEGILDIR
 *   - eksik API alani = UNKNOWN
 *   - Google Indexing API'nin publish ucu bu kod tabaninda HICBIR yerde yok
 *     (inspection bir OKUMA cagrisidir; Indexing API'nin bildirim ucu bir YAZMA'dir)
 */
import type { SiteEntry } from "./registry.ts";
import { normalizeUrl, type UrlInspectionSummary, type IndexVerdict } from "./url-inventory.ts";

export const PROBE_SITE_ID = "pamistanbul";
export const DEFAULT_LIMIT = 20;
/** Google property basina gunluk 2000 inspection izin veriyor; biz bunun ~%5'inde durariz. */
export const HARD_LIMIT = 100;
export const DEFAULT_DELAY_MS = 1500;
export const MAX_CONSECUTIVE_ERRORS = 3;

export function assertProbeSite(siteId: string): void {
  if (siteId !== PROBE_SITE_ID) {
    throw new Error(`inspect-index yalnizca '${PROBE_SITE_ID}' icin calisir (istenen: '${siteId}'). Phase 1 kapsami bilerek dar.`);
  }
}

/** URL, sitenin production domain'inin apex'i ya da www'su mu? */
export function hostAllowed(url: string, productionDomain: string): boolean {
  const n = normalizeUrl(url);
  if (!n) return false;
  const h = new URL(n).hostname;
  return h === productionDomain || h === `www.${productionDomain}`;
}

/** Istenen limiti sert tavana ve bugun zaten kullanilana gore kisitla. */
export function resolveLimit(requested: number | undefined, usedToday = 0): { limit: number; clampedFrom?: number } {
  const want = Number.isFinite(requested) && (requested as number) > 0 ? Math.floor(requested as number) : DEFAULT_LIMIT;
  const capped = Math.min(want, HARD_LIMIT);
  const limit = Math.max(0, Math.min(capped, HARD_LIMIT - usedToday));
  return limit === want ? { limit } : { limit, clampedFrom: want };
}

const str = (v: unknown): string | "UNKNOWN" => (typeof v === "string" && v ? v : "UNKNOWN");

/** API yaniti -> ozet. Eksik alan UNKNOWN; indexStatusResult yoksa hicbir sey cikarilmaz. */
export function classifyInspection(result: Record<string, unknown> | null): UrlInspectionSummary {
  const base: UrlInspectionSummary = {
    state: "UNKNOWN", index_verdict: "UNKNOWN", coverage_state: "UNKNOWN", indexing_state: "UNKNOWN", page_fetch_state: "UNKNOWN",
    robots_txt_state: "UNKNOWN", google_canonical: "UNKNOWN", user_canonical: "UNKNOWN", last_crawl_time: "UNKNOWN",
    label: "FACT", confidence: "UNKNOWN",
  };
  const isr = result?.indexStatusResult;
  if (!isr || typeof isr !== "object") return base;
  const r = isr as Record<string, unknown>;
  const verdictRaw = r.verdict;
  // PASS/FAIL/NEUTRAL Google'in kendi cevabi; VERDICT_UNSPECIFIED ya da eksik = bilmiyoruz.
  const verdict: IndexVerdict = verdictRaw === "PASS" ? "INDEXED" : verdictRaw === "FAIL" ? "NOT_INDEXED" : verdictRaw === "NEUTRAL" ? "NEUTRAL" : "UNKNOWN";
  return {
    ...base,
    state: "INSPECTED",
    index_verdict: verdict,
    coverage_state: str(r.coverageState), indexing_state: str(r.indexingState), page_fetch_state: str(r.pageFetchState),
    robots_txt_state: str(r.robotsTxtState), google_canonical: str(r.googleCanonical), user_canonical: str(r.userCanonical),
    last_crawl_time: str(r.lastCrawlTime),
    confidence: verdict === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED",
  };
}

/** Hata -> ERROR ozeti. 403/429 `fatal`: tekrar denemek ya da devam etmek zarar verir. */
export function classifyError(err: unknown): { summary: UrlInspectionSummary; fatal: boolean; code: number | null } {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /HTTP (\d{3})/.exec(msg);
  const code = m ? Number(m[1]) : null;
  const fatal = code === 403 || code === 429;
  const short = msg.replace(/[\r\n]+/g, " ").slice(0, 160);
  const summary = classifyInspection(null);
  summary.state = "ERROR";
  summary.error = code ? `HTTP ${code}: ${short}` : short;
  return { summary, fatal, code };
}

export type StopReason = null | "limit_reached" | "rate_limited_429" | "forbidden_403" | "consecutive_errors" | "not_connected";

export interface ProbeResult {
  site: string;
  mode: "SAMPLE";
  /** Rapora aynen basilir. */
  coverage_notice: string;
  candidate_source: string;
  candidates: number;
  attempted: number;
  limit: number;
  stopped: StopReason;
  results: { url: string; summary: UrlInspectionSummary }[];
  skipped: { url: string; reason: string }[];
}

export interface ProbeOptions {
  site: Pick<SiteEntry, "id" | "production_domain">;
  urls: string[];
  candidateSource: string;
  limit: number;
  delayMs: number;
  /** false => hicbir cagri yapilmaz. */
  connected: boolean;
  inspect: (url: string) => Promise<Record<string, unknown> | null>;
  sleep?: (ms: number) => Promise<void>;
}

export async function runProbe(o: ProbeOptions): Promise<ProbeResult> {
  assertProbeSite(o.site.id);
  const skipped: ProbeResult["skipped"] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of o.urls) {
    const n = normalizeUrl(raw);
    if (!n) { skipped.push({ url: raw, reason: "gecersiz URL" }); continue; }
    if (!hostAllowed(n, o.site.production_domain)) { skipped.push({ url: raw, reason: `host ${o.site.production_domain} (apex/www) disinda` }); continue; }
    if (seen.has(n)) { skipped.push({ url: raw, reason: "tekrar" }); continue; }
    seen.add(n);
    candidates.push(n);
  }

  const res: ProbeResult = {
    site: o.site.id, mode: "SAMPLE", candidate_source: o.candidateSource, candidates: candidates.length, attempted: 0,
    limit: o.limit, stopped: null, results: [], skipped,
    coverage_notice: "",
  };
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!o.connected) {
    res.stopped = "not_connected";
  } else {
    let consecutive = 0;
    for (const url of candidates) {
      if (res.attempted >= o.limit) { res.stopped = "limit_reached"; break; }
      if (res.attempted > 0 && o.delayMs > 0) await sleep(o.delayMs);
      res.attempted++;
      try {
        const raw = await o.inspect(url);
        if (raw === null) { res.attempted--; res.stopped = "not_connected"; break; }
        res.results.push({ url, summary: classifyInspection(raw) });
        consecutive = 0;
      } catch (e) {
        const { summary, fatal, code } = classifyError(e);
        res.results.push({ url, summary });
        if (fatal) { res.stopped = code === 429 ? "rate_limited_429" : "forbidden_403"; break; }
        if (++consecutive >= MAX_CONSECUTIVE_ERRORS) { res.stopped = "consecutive_errors"; break; }
      }
    }
  }
  const examined = res.results.length;
  // Durdurulduysa kalan adaylar NOT_INSPECTED'dir; "sorunsuz" diye okunmamali.
  res.coverage_notice =
    `ÖRNEKLEM (SAMPLE) — TAM COVERAGE DEĞİL. ${candidates.length} aday URL'den ${examined} tanesi denetlendi; ` +
    `sitedeki toplam URL sayısı bu ölçümde BİLİNMİYOR. Adaylar "${o.candidateSource}" kaynağından geldi: ` +
    `kaynakta hiç yer almayan URL'ler (ör. hiç gösterimi olmayan sayfalar) bu örneklemde TEMSİL EDİLMEZ.`;
  return res;
}

// ---------------------------------------------------------------------------
// Sitemaps (GSC) — ayni salt-okunur katman
// ---------------------------------------------------------------------------

export interface SitemapSummary {
  path: Unk<string>; last_submitted: Unk<string>; last_downloaded: Unk<string>; is_pending: Unk<boolean>;
  is_sitemaps_index: Unk<boolean>; warnings: Unk<string>; errors: Unk<string>;
}
type Unk<T> = T | "UNKNOWN";

/** GSC Sitemaps API satirlari -> ozet. `null` (kimlik yok) NOT_CONNECTED; bos liste "sitemap gonderilmemis". */
export function summarizeSitemaps(raw: Record<string, unknown>[] | null): { state: "NOT_CONNECTED" | "MEASURED"; items: SitemapSummary[] } {
  if (raw === null) return { state: "NOT_CONNECTED", items: [] };
  const s = (v: unknown): Unk<string> => (typeof v === "string" && v ? v : "UNKNOWN");
  const b = (v: unknown): Unk<boolean> => (typeof v === "boolean" ? v : "UNKNOWN");
  // GSC warnings/errors'u dize olarak doner; yoksa alan eksiktir = sayi bilinmiyor, 0 degil.
  return {
    state: "MEASURED",
    items: raw.map((x) => ({
      path: s(x.path), last_submitted: s(x.lastSubmitted), last_downloaded: s(x.lastDownloaded), is_pending: b(x.isPending),
      is_sitemaps_index: b(x.isSitemapsIndex), warnings: s(x.warnings), errors: s(x.errors),
    })),
  };
}

// ---------------------------------------------------------------------------
// Gunluk kota defteri (yerel dosya)
// ---------------------------------------------------------------------------

export type QuotaLedger = Record<string, number>;
export const usedOn = (l: QuotaLedger, date: string) => l[date] ?? 0;
export const recordUsage = (l: QuotaLedger, date: string, n: number): QuotaLedger => ({ ...l, [date]: usedOn(l, date) + n });

export function probeToMarkdown(p: ProbeResult, sitemaps: ReturnType<typeof summarizeSitemaps> | { state: "ERROR"; error: string }, date: string): string {
  const L: string[] = [
    `# index-probe — ${p.site} — ${date}`, "",
    `> **${p.coverage_notice}**`, "",
    "Salt-okunur. Hiçbir site değiştirilmedi, hiçbir URL indeksleme talebi gönderilmedi (Indexing API yok).", "",
    `limit ${p.limit} · aday ${p.candidates} · denetlenen ${p.results.length} · durma nedeni: ${p.stopped ?? "yok (aday listesi bitti)"}`, "",
  ];
  if (p.stopped === "not_connected") L.push("**NOT_CONNECTED** — kimlik yok, hiçbir API çağrısı yapılmadı.", "");
  if (p.stopped && p.stopped !== "limit_reached" && p.stopped !== "not_connected") L.push(`**Koşu erken durdu (${p.stopped}).** Kalan aday URL'ler NOT_INSPECTED'dır; "sorunsuz" anlamına gelmez.`, "");
  L.push("| URL | durum | karar | coverage | Google canonical |", "|---|---|---|---|---|");
  for (const r of p.results) {
    const s = r.summary;
    L.push(`| ${r.url} | ${s.state}${s.error ? ` (${s.error})` : ""} | ${s.index_verdict} | ${s.coverage_state} | ${s.google_canonical} |`);
  }
  L.push("", "## Sitemap'ler (GSC)", "");
  if (sitemaps.state === "NOT_CONNECTED") L.push("NOT_CONNECTED");
  else if (sitemaps.state === "ERROR") L.push(`ERROR — ${sitemaps.error}`);
  else if (!sitemaps.items.length) L.push("GSC'de gönderilmiş sitemap görünmüyor.");
  else for (const i of sitemaps.items) L.push(`- ${i.path} — son indirme ${i.last_downloaded}, uyarı ${i.warnings}, hata ${i.errors}`);
  if (p.skipped.length) L.push("", `Atlanan ${p.skipped.length} URL: ${[...new Set(p.skipped.map((s) => s.reason))].join("; ")}`);
  return L.join("\n") + "\n";
}
