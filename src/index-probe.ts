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
import type { Segment } from "./index-candidates.ts";
import { classifyCanonicalRelations, type CanonicalRelations } from "./canonical-relations.ts";

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
  results: { url: string; summary: UrlInspectionSummary; segment?: Segment; canonical_relations?: CanonicalRelations }[];
  skipped: { url: string; reason: string }[];
  /** REVIEW_REQUIRED canonical iliskisi gozlenen URL sayisi. Bir HATA sayisi degil: insan incelemesi adayi. */
  canonical_candidate_count?: number;
  /** canonical_pattern = DECLARED_GOOGLE_CONFLICT sayisi (insan incelemesi adayi, hata degil). */
  canonical_conflict_count?: number;
  /** canonical_pattern = GOOGLE_USER_CONVERGE_ON_OTHER_URL sayisi (gozlenen uzlasma, celiski degil). */
  canonical_convergence_count?: number;
  /** Yalniz segmentli stratejide dolu. Eski (gsc) cikti bu alanlar olmadan ayni kalir. */
  strategy?: "gsc" | "segmented";
  segments?: SegmentReportRow[];
}

export interface SegmentReportRow {
  segment: Segment;
  state: "COMPUTED" | "UNKNOWN";
  reason?: string;
  pool: number | null;
  quota: number;
  probed: number;
  /** INDEXED / NOT_INDEXED / NEUTRAL / UNKNOWN (Google'in karari) ve ERROR (cagri hatasi). */
  verdicts: Record<string, number>;
  canonical_candidate_count?: number;
  canonical_conflict_count?: number;
  canonical_convergence_count?: number;
}

/** Segmentli stratejide secim ozeti (runProbe'a CLI'dan gelir). */
export interface SegmentInfo {
  segments: Record<Segment, { state: "COMPUTED" | "UNKNOWN"; reason?: string; pool: number | null; quota: number }>;
  day_index: number;
}

export interface ProbeOptions {
  site: Pick<SiteEntry, "id" | "production_domain">;
  /** Duz URL listesi (strategy=gsc, Phase 1 davranisi). `candidates` verilirse kullanilmaz. */
  urls?: string[];
  /** Segment etiketli, calistirma sirasina gore dizili adaylar (strategy=segmented). */
  candidates?: { url: string; segment: Segment }[];
  segmentInfo?: SegmentInfo;
  /** Aday kurulurken elenenler (gecersiz / host disi); rapora eklenir. */
  skippedInput?: { url: string; reason: string }[];
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
  const skipped: ProbeResult["skipped"] = [...(o.skippedInput ?? [])];
  const seen = new Set<string>();
  const segmented = !!o.candidates;
  const candidates: { url: string; segment?: Segment }[] = [];
  const input: { raw: string; segment?: Segment }[] = o.candidates ? o.candidates.map((c) => ({ raw: c.url, segment: c.segment })) : (o.urls ?? []).map((raw) => ({ raw }));
  for (const { raw, segment } of input) {
    const n = normalizeUrl(raw);
    if (!n) { skipped.push({ url: raw, reason: "gecersiz URL" }); continue; }
    if (!hostAllowed(n, o.site.production_domain)) { skipped.push({ url: raw, reason: `host ${o.site.production_domain} (apex/www) disinda` }); continue; }
    if (seen.has(n)) { skipped.push({ url: raw, reason: "tekrar" }); continue; }
    seen.add(n);
    candidates.push({ url: n, segment });
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
    for (const { url, segment } of candidates) {
      if (res.attempted >= o.limit) { res.stopped = "limit_reached"; break; }
      if (res.attempted > 0 && o.delayMs > 0) await sleep(o.delayMs);
      res.attempted++;
      try {
        const raw = await o.inspect(url);
        if (raw === null) { res.attempted--; res.stopped = "not_connected"; break; }
        res.results.push({ url, summary: classifyInspection(raw), ...(segment ? { segment } : {}) });
        consecutive = 0;
      } catch (e) {
        const { summary, fatal, code } = classifyError(e);
        res.results.push({ url, summary, ...(segment ? { segment } : {}) });
        if (fatal) { res.stopped = code === 429 ? "rate_limited_429" : "forbidden_403"; break; }
        if (++consecutive >= MAX_CONSECUTIVE_ERRORS) { res.stopped = "consecutive_errors"; break; }
      }
    }
  }
  // Canonical iliskileri: yalniz URL alanlarindan (coverageState metni kullanilmaz).
  for (const r of res.results) r.canonical_relations = classifyCanonicalRelations(r.url, r.summary.google_canonical, r.summary.user_canonical);
  res.canonical_candidate_count = res.results.filter((r) => r.canonical_relations?.review_required).length;
  res.canonical_conflict_count = res.results.filter((r) => r.canonical_relations?.canonical_pattern === "DECLARED_GOOGLE_CONFLICT").length;
  res.canonical_convergence_count = res.results.filter((r) => r.canonical_relations?.canonical_pattern === "GOOGLE_USER_CONVERGE_ON_OTHER_URL").length;

  const examined = res.results.length;
  // Durdurulduysa kalan adaylar NOT_INSPECTED'dir; "sorunsuz" diye okunmamali.
  res.coverage_notice = segmented
    ? `ÖRNEKLEM (SAMPLE) — TAM COVERAGE DEĞİL. ${candidates.length} aday URL'den ${examined} tanesi denetlendi; ` +
      `sitedeki toplam URL sayısı bu ölçümde BİLİNMİYOR. Adaylar sitemap evreni ile son 28 günlük GSC page dataset'inden ` +
      `segmentlere ayrılarak seçildi ("${o.candidateSource}"); ikisinde de bulunmayan URL'ler TEMSİL EDİLMEZ. ` +
      `Seçim stateless ve deterministik bir günlük rotasyondur: YAKLAŞIK bir turdur, segment boyu değişirse pencere kayar ve tam tur garantisi yoktur.`
    : `ÖRNEKLEM (SAMPLE) — TAM COVERAGE DEĞİL. ${candidates.length} aday URL'den ${examined} tanesi denetlendi; ` +
      `sitedeki toplam URL sayısı bu ölçümde BİLİNMİYOR. Adaylar "${o.candidateSource}" kaynağından geldi: ` +
      `kaynakta hiç yer almayan URL'ler (ör. hiç gösterimi olmayan sayfalar) bu örneklemde TEMSİL EDİLMEZ.`;
  if (segmented && o.segmentInfo) {
    res.strategy = "segmented";
    res.segments = (Object.keys(o.segmentInfo.segments) as Segment[]).map((segment) => {
      const info = o.segmentInfo!.segments[segment];
      const mine = res.results.filter((r) => r.segment === segment);
      const verdicts: Record<string, number> = {};
      for (const r of mine) { const k = r.summary.state === "ERROR" ? "ERROR" : r.summary.index_verdict; verdicts[k] = (verdicts[k] ?? 0) + 1; }
      return { segment, ...info, probed: mine.length, verdicts, canonical_candidate_count: mine.filter((r) => r.canonical_relations?.review_required).length,
        canonical_conflict_count: mine.filter((r) => r.canonical_relations?.canonical_pattern === "DECLARED_GOOGLE_CONFLICT").length,
        canonical_convergence_count: mine.filter((r) => r.canonical_relations?.canonical_pattern === "GOOGLE_USER_CONVERGE_ON_OTHER_URL").length };
    });
  } else if (segmented) res.strategy = "segmented";
  else res.strategy = "gsc";
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
  if (p.segments) {
    L.push("## Segmentler", "",
      "Segment adları iddia taşır: **SITEMAP_NOT_OBSERVED_IN_GSC_WINDOW** = sitemap evreninde var, son 28 günlük GSC page dataset'inde gözlenmedi. Bu bir HATA değildir; daha az gözlenmiş, daha yüksek inceleme öncelikli aday havuzudur. **HOST_VARIANT_RISK** = GSC'de üretim origin'inden farklı scheme/host ile görünen URL; canonical/redirect hatası İDDİA ETMEZ (sayfalar fetch edilmedi).", "",
      "| segment | havuz | kota | denetlenen | dağılım | canonical adayı | conflict | convergence |", "|---|---|---|---|---|---|---|---|");
    for (const r of p.segments) {
      const dist = Object.entries(r.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
      L.push(`| ${r.segment} | ${r.state === "COMPUTED" ? r.pool : `UNKNOWN (${r.reason})`} | ${r.quota} | ${r.probed} | ${dist} | ${r.canonical_candidate_count ?? 0} | ${r.canonical_conflict_count ?? 0} | ${r.canonical_convergence_count ?? 0} |`);
    }
    L.push("");
  }
  L.push(p.segments ? "| URL | segment | durum | karar | coverage | Google canonical |" : "| URL | durum | karar | coverage | Google canonical |", p.segments ? "|---|---|---|---|---|---|" : "|---|---|---|---|---|");
  for (const r of p.results) {
    const s = r.summary;
    L.push(`| ${r.url} | ${p.segments ? `${r.segment ?? "—"} | ` : ""}${s.state}${s.error ? ` (${s.error})` : ""} | ${s.index_verdict} | ${s.coverage_state} | ${s.google_canonical} |`);
  }
  const cands = p.results.filter((r) => r.canonical_relations?.review_required);
  if (cands.length) {
    const HEAD = ["| URL | segment | inspected↔google | user↔google | user↔inspected | user cross-domain | google cross-domain | Google canonical | user canonical | nedenler |", "|---|---|---|---|---|---|---|---|---|---|"];
    const row = (r: (typeof cands)[number]) => {
      const c = r.canonical_relations!;
      return `| ${r.url} | ${r.segment ?? "—"} | ${c.inspected_vs_google} | ${c.user_vs_google} | ${c.user_vs_inspected} | ${c.user_cross_domain} | ${c.google_cross_domain} | ${r.summary.google_canonical} | ${r.summary.user_canonical} | ${c.reasons.join(", ")} |`;
    };
    const of = (pattern: string) => cands.filter((r) => r.canonical_relations!.canonical_pattern === pattern);
    const conflicts = of("DECLARED_GOOGLE_CONFLICT"), converge = of("GOOGLE_USER_CONVERGE_ON_OTHER_URL");
    const incomplete = cands.filter((r) => !["DECLARED_GOOGLE_CONFLICT", "GOOGLE_USER_CONVERGE_ON_OTHER_URL"].includes(r.canonical_relations!.canonical_pattern));
    L.push("", "## Canonical candidates", "",
      "Satırlar Google'ın URL Inspection yanıtındaki üç URL alanının (denetlenen URL, googleCanonical, userCanonical) karşılaştırmasıdır (FACT). Hata değildir, SEO hatası olarak etiketlenmez, düzeltme önerisi içermez. `cross-domain` tam hostname farkıdır: `www` ile apex FARKLI sayılır. coverageState metni karar için kullanılmaz. Gruplama `canonical_pattern` ile yapılır.", "",
      `### Declared vs Google conflicts (${conflicts.length})`, "",
      "**CANDIDATE / REVIEW_REQUIRED** — sayfanın bildirdiği canonical ile Google'ın seçtiği canonical uyuşmuyor (`DECLARED_GOOGLE_CONFLICT`). İnsan incelemesi adayıdır; otomatik SEO hatası değildir.", "",
      ...(conflicts.length ? [...HEAD, ...conflicts.map(row)] : ["Yok."]), "",
      `### Google/user convergence on another URL (${converge.length})`, "",
      "**INFO / OBSERVED_CONVERGENCE** — Google canonical ile bildirilen canonical aynı hedefte uzlaşıyor. Bu, denetlenen URL'nin başka bir URL varyantı olduğuna dair FACT'tir; doğru HTTP redirect/canonical uygulaması olduğu henüz doğrulanmamıştır. Desen: `GOOGLE_USER_CONVERGE_ON_OTHER_URL`.", "",
      ...(converge.length ? [...HEAD, ...converge.map(row)] : ["Yok."]));
    if (incomplete.length) L.push("", `### Incomplete canonical data (${incomplete.length})`, "",
      "**CANDIDATE / REVIEW_REQUIRED** — bir tetikleyici gözlendi ama gerekli alan eksik olduğu için güvenilir bir desen çıkarılamadı (`INCOMPLETE`). Eksik alan UNKNOWN'dur, tahmin edilmedi.", "", ...HEAD, ...incomplete.map(row));
  }
  L.push("", "## Sitemap'ler (GSC)", "");
  if (sitemaps.state === "NOT_CONNECTED") L.push("NOT_CONNECTED");
  else if (sitemaps.state === "ERROR") L.push(`ERROR — ${sitemaps.error}`);
  else if (!sitemaps.items.length) L.push("GSC'de gönderilmiş sitemap görünmüyor.");
  else for (const i of sitemaps.items) L.push(`- ${i.path} — son indirme ${i.last_downloaded}, uyarı ${i.warnings}, hata ${i.errors}`);
  if (p.skipped.length) L.push("", `Atlanan ${p.skipped.length} URL: ${[...new Set(p.skipped.map((s) => s.reason))].join("; ")}`);
  return L.join("\n") + "\n";
}
