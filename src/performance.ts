// Lighthouse / Core Web Vitals katmani: PSI JSON'u (CrUX field + lab) -> site basina olcum kaydi,
// sinirli gecmis, regresyon adayi. Ag YOK burada: fetcher enjekte edilir (src/performance-psi.ts).
//
// Bu modulun neden var oldugu (testler bunu zorlar):
//   - Olmayan metrik 0 degil NULL'dir. LCP=0 "mukemmel" okunur; oysa o gun olcum yoktu. (Kural 1)
//   - Field (CrUX, gercek kullanici) ile lab (tek sentetik kosu) AYNI SEY DEGILDIR; tek kayitta
//     karistirilmaz ve birbirine karsi regresyon hesaplanmaz.
//   - Esik siniflandirmasi (good/NI/poor) bir INFERENCE'tir; olculen sayi FACT'tir.
//   - Regresyon bir ADAYDIR (CANDIDATE, REVIEW_REQUIRED): nedeni (deploy, ucuncu parti script, CrUX penceresi)
//     bilmiyoruz; neden iddiasi YAZILMAZ.
//   - Izolasyon: bir sitenin gecmisine baska sitenin kaydi yazilamaz; URL'ler sitenin kendi host'unda olmali.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Confidence } from "./types.ts";
import type { SiteEntry } from "./registry.ts";
import { createPsiFetcher, type PsiFetcher, type Strategy } from "./performance-psi.ts";

export const RECORD_SCHEMA = "sgos.performance.v1" as const;
export const HISTORY_SCHEMA = "sgos.performance-history.v1" as const;
export const REPORT_SCHEMA = "sgos.performance-report.v1" as const;
export const HISTORY_MAX_RECORDS = 120;
export const DEFAULT_URLS_PER_SITE = 5;
/** Sert tavan: cagiran daha fazla isterse bile bu asilmaz (PSI kotasi ortak ve ucretsiz). */
export const HARD_URL_CAP = 10;
export const DEFAULT_MAX_REQUESTS = 70; // 7 site x 5 URL x 2 strateji
export const STRATEGIES: readonly Strategy[] = ["mobile", "desktop"];

export type PerfSource = "field" | "lab" | "none";
export type PerfState = "MEASURED" | "UNKNOWN" | "NOT_CONNECTED" | "ERROR";
export type Rating = "GOOD" | "NEEDS_IMPROVEMENT" | "POOR" | "UNKNOWN";
export type MetricKey = "lcp_ms" | "inp_ms" | "cls" | "ttfb_ms";

/** web.dev esikleri (erisim 2026-10-02): iyi <= good, zayif > poor. TTFB icin web.dev 800/1800 ms onerir
 *  ama CWV degildir; yalnizca ek bilgi olarak siniflanir. */
export const THRESHOLDS: Record<MetricKey, { good: number; poor: number }> = {
  lcp_ms: { good: 2500, poor: 4000 },
  inp_ms: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  ttfb_ms: { good: 800, poor: 1800 },
};
export const CWV_METRICS: readonly MetricKey[] = ["lcp_ms", "inp_ms", "cls"];
const ALL_METRICS: readonly MetricKey[] = ["lcp_ms", "inp_ms", "cls", "ttfb_ms"];

export interface PerfRecord {
  schema: typeof RECORD_SCHEMA;
  site: string;
  url: string;
  strategy: Strategy;
  measured_at: string;           // ISO UTC
  date: string;                  // UTC gun, measured_at'ten turetilir
  lcp_ms: number | null;
  inp_ms: number | null;         // lab'de INP yoktur -> null
  cls: number | null;
  ttfb_ms: number | null;        // lab'de server-response-time denetimi
  perf_score: number | null;     // 0-100, Lighthouse performans kategorisi (HER ZAMAN lab)
  source: PerfSource;
  /** field: URL duzeyi mi, origin geri-dususu mu. Ikisi birbirine karsi kiyaslanmaz. */
  field_scope: "url" | "origin" | null;
  state: PerfState;
  evidence: "FACT";
  confidence: Confidence;
  provider: "PageSpeed Insights API v5";
  error_code?: string;           // yalniz kod; saglayici mesaji (anahtar yansitabilir) saklanmaz
  /** INFERENCE: esik siniflandirmasi. Olculen degerin kendisi degil, bir kuralin sonucu. */
  ratings: { label: "INFERENCE"; confidence: "CANDIDATE" | "UNKNOWN"; values: Record<MetricKey, Rating> };
}

// --- siniflandirma ----------------------------------------------------------------------------------------

export function rate(metric: MetricKey, v: number | null): Rating {
  if (v === null) return "UNKNOWN";
  const t = THRESHOLDS[metric];
  return v <= t.good ? "GOOD" : v <= t.poor ? "NEEDS_IMPROVEMENT" : "POOR";
}
const RANK: Record<Rating, number> = { GOOD: 0, NEEDS_IMPROVEMENT: 1, POOR: 2, UNKNOWN: -1 };

/** Gecerli sayi degilse null. Sifir/negatif sure "olcum yok" demektir (sifir LCP fiziksel olarak yok);
 *  CLS icin 0 gecerli ve en iyi degerdir. */
function num(v: unknown, metric: MetricKey): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (metric === "cls") return v >= 0 ? v : null;
  return v > 0 ? v : null;
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// --- PSI ayristirma ---------------------------------------------------------------------------------------

export interface ParseCtx { site: string; url: string; strategy: Strategy; measuredAt: string }

function base(ctx: ParseCtx): PerfRecord {
  return {
    schema: RECORD_SCHEMA, site: ctx.site, url: ctx.url, strategy: ctx.strategy, measured_at: ctx.measuredAt, date: ctx.measuredAt.slice(0, 10),
    lcp_ms: null, inp_ms: null, cls: null, ttfb_ms: null, perf_score: null, source: "none", field_scope: null,
    state: "UNKNOWN", evidence: "FACT", confidence: "UNKNOWN", provider: "PageSpeed Insights API v5",
    ratings: { label: "INFERENCE", confidence: "UNKNOWN", values: { lcp_ms: "UNKNOWN", inp_ms: "UNKNOWN", cls: "UNKNOWN", ttfb_ms: "UNKNOWN" } },
  };
}

function finish(r: PerfRecord): PerfRecord {
  const vals = {} as Record<MetricKey, Rating>;
  for (const m of ALL_METRICS) vals[m] = rate(m, r[m]);
  const any = ALL_METRICS.some((m) => r[m] !== null) || r.perf_score !== null;
  r.ratings = { label: "INFERENCE", confidence: ALL_METRICS.some((m) => r[m] !== null) ? "CANDIDATE" : "UNKNOWN", values: vals };
  if (r.state !== "ERROR" && r.state !== "NOT_CONNECTED") { r.state = any ? "MEASURED" : "UNKNOWN"; r.confidence = any ? "CONFIRMED" : "UNKNOWN"; }
  r.source = ALL_METRICS.some((m) => r[m] !== null) ? r.source : (r.perf_score !== null ? "lab" : "none");
  return r;
}

export function errorRecord(ctx: ParseCtx, code: string, state: "ERROR" | "NOT_CONNECTED" = "ERROR"): PerfRecord {
  const r = base(ctx); r.state = state; r.confidence = "UNKNOWN"; r.error_code = code.slice(0, 60); return finish(r);
}

/** Asla atmaz: bozuk/eksik govde ERROR ya da UNKNOWN kaydidir, sifir degil. */
export function parsePsiResponse(status: number, body: unknown, ctx: ParseCtx): PerfRecord {
  const b = obj(body);
  if (status === 429) return errorRecord(ctx, "HTTP_429");
  const apiErr = obj(b?.error);
  if (apiErr) return errorRecord(ctx, `PSI_${typeof apiErr.code === "number" ? apiErr.code : "ERROR"}`);
  if (status < 200 || status >= 300) return errorRecord(ctx, `HTTP_${status}`);
  if (!b) return errorRecord(ctx, "BAD_RESPONSE");

  const lh = obj(b.lighthouseResult);
  // Lighthouse kosu hatasi (sayfa yuklenemedi): lab sayilari anlamsiz, UNKNOWN degil ERROR.
  if (lh && obj(lh.runtimeError)) return errorRecord(ctx, "LIGHTHOUSE_RUNTIME_ERROR");

  const r = base(ctx);

  // 1) Field (CrUX). Varsa lab ile KARISTIRILMAZ: kayit field'dir.
  const le = obj(b.loadingExperience);
  const fm = obj(le?.metrics);
  if (fm) {
    const pct = (k: string): unknown => obj(fm[k])?.percentile;
    const f = {
      lcp_ms: num(pct("LARGEST_CONTENTFUL_PAINT_MS"), "lcp_ms"),
      inp_ms: num(pct("INTERACTION_TO_NEXT_PAINT"), "inp_ms"),
      // PSI CLS percentile'ini 100 ile carpilmis tamsayi verir (10 -> 0.10).
      cls: ((): number | null => { const p = pct("CUMULATIVE_LAYOUT_SHIFT_SCORE"); return typeof p === "number" && Number.isFinite(p) && p >= 0 ? p / 100 : null; })(),
      ttfb_ms: num(pct("EXPERIMENTAL_TIME_TO_FIRST_BYTE"), "ttfb_ms"),
    };
    if (ALL_METRICS.some((m) => f[m] !== null)) {
      Object.assign(r, f); r.source = "field"; r.field_scope = le?.origin_fallback === true ? "origin" : "url";
    }
  }
  // 2) Lab yalniz field yoksa metrik kaynagidir.
  const audits = obj(lh?.audits);
  if (r.source !== "field" && audits) {
    const av = (id: string): unknown => obj(audits[id])?.numericValue;
    const l = { lcp_ms: num(av("largest-contentful-paint"), "lcp_ms"), cls: num(av("cumulative-layout-shift"), "cls"), ttfb_ms: num(av("server-response-time"), "ttfb_ms") };
    if (l.lcp_ms !== null || l.cls !== null || l.ttfb_ms !== null) { Object.assign(r, l); r.source = "lab"; }
  }
  // 3) perf_score her zaman lab kategorisinden; 0-1 -> 0-100.
  const sc = obj(obj(lh?.categories)?.performance)?.score;
  if (typeof sc === "number" && Number.isFinite(sc) && sc >= 0 && sc <= 1) r.perf_score = Math.round(sc * 100);
  return finish(r);
}

// --- URL planlama + butce ---------------------------------------------------------------------------------

export interface UrlPlan { urls: string[]; rejected: { url: string; reason: string }[]; truncated: string[] }

const hostOf = (u: string): string | null => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.hostname.toLowerCase() : null; } catch { return null; } };
const stripWww = (h: string) => h.replace(/^www\./, "");

/** Izolasyon: URL yalniz bu sitenin canonical/production host'unda (www varyanti dahil). Baska site ya da
 *  ucuncu parti URL reddedilir — "ayni kisinin sitesi" gerekce degildir. */
export function planUrls(site: SiteEntry, requested: string[] | undefined, perSite = DEFAULT_URLS_PER_SITE): UrlPlan {
  const cap = Math.max(1, Math.min(Math.floor(perSite) || DEFAULT_URLS_PER_SITE, HARD_URL_CAP));
  const own = new Set([stripWww(site.canonical_hostname.toLowerCase()), stripWww(site.production_domain.toLowerCase())]);
  const input = requested && requested.length ? requested : [`https://${site.canonical_hostname}/`];
  const urls: string[] = []; const rejected: UrlPlan["rejected"] = []; const truncated: string[] = []; const seen = new Set<string>();
  for (const raw of input) {
    const h = hostOf(raw);
    if (!h) { rejected.push({ url: raw, reason: "gecersiz URL" }); continue; }
    if (!own.has(stripWww(h))) { rejected.push({ url: raw, reason: `host ${h} bu sitenin degil (izolasyon)` }); continue; }
    const key = raw.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    if (urls.length >= cap) { truncated.push(key); continue; }
    urls.push(key);
  }
  return { urls, rejected, truncated };
}

/** Her PSI cagrisi 1 birimdir (URL x strateji). Tukenince cagri YAPILMAZ; sessizce yarim kalmaz, skipped olarak yazilir. */
export class RequestBudget {
  readonly limit: number; used = 0;
  constructor(limit: number) { this.limit = Math.max(0, Math.floor(limit)); }
  tryTake(): boolean { if (this.used >= this.limit) return false; this.used++; return true; }
  get remaining(): number { return this.limit - this.used; }
}

// --- gecmis -----------------------------------------------------------------------------------------------

export interface HistoryFile { schema: typeof HISTORY_SCHEMA; site: string; max_records: number; records: PerfRecord[] }
export class PerfHistoryError extends Error {
  code: "HISTORY_CORRUPT";
  constructor(msg: string) { super(msg); this.code = "HISTORY_CORRUPT"; }
}
const SITE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const keyOf = (r: Pick<PerfRecord, "date" | "url" | "strategy">) => `${r.date}|${r.strategy}|${r.url}`;
const isNumOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function recordProblem(r: unknown, site: string): string | null {
  const x = obj(r); if (!x) return "kayit nesne degil";
  if (x.schema !== RECORD_SCHEMA) return "kayit semasi gecersiz";
  if (x.site !== site) return `site uyusmuyor (${String(x.site)} != ${site})`;
  if (typeof x.url !== "string" || !hostOf(x.url)) return "url gecersiz";
  if (x.strategy !== "mobile" && x.strategy !== "desktop") return "strategy gecersiz";
  if (typeof x.date !== "string" || !DATE.test(x.date)) return "date gecersiz";
  if (typeof x.measured_at !== "string" || x.measured_at.slice(0, 10) !== x.date) return "measured_at date ile uyusmuyor";
  // Gecmis yalniz BASARILI olcum tutar: hata/baglanti-yok satirlari 120'lik pencereyi gercek veriden doldurur.
  if (x.state !== "MEASURED") return "gecmise yalniz MEASURED kayit girer";
  if (x.evidence !== "FACT") return "evidence FACT olmali";
  if (x.source !== "field" && x.source !== "lab") return "MEASURED kayitta source field|lab olmali";
  for (const m of ALL_METRICS) { if (!isNumOrNull(x[m])) return `${m} gecersiz`; if (x[m] === 0 && m !== "cls") return `${m}=0 gecersiz (olcum yok null olmali)`; }
  if (!(x.perf_score === null || (typeof x.perf_score === "number" && x.perf_score >= 0 && x.perf_score <= 100))) return "perf_score gecersiz";
  if (!ALL_METRICS.some((m) => x[m] !== null) && x.perf_score === null) return "MEASURED ama hic deger yok";
  if (x.confidence !== "CONFIRMED") return "MEASURED kayit CONFIRMED olmali";
  return null;
}

/** Bozuk dosya sessizce duzeltilmez ve ustune YAZILMAZ: PerfHistoryError. */
export function parseHistory(text: string, site: string): HistoryFile {
  let d: unknown;
  try { d = JSON.parse(text); } catch { throw new PerfHistoryError(`${site}: gecmis dosyasi JSON degil`); }
  const h = obj(d);
  if (!h || h.schema !== HISTORY_SCHEMA || h.site !== site || !Array.isArray(h.records)) throw new PerfHistoryError(`${site}: gecmis semasi/site gecersiz`);
  if (h.records.length > HISTORY_MAX_RECORDS) throw new PerfHistoryError(`${site}: ${h.records.length} kayit > ${HISTORY_MAX_RECORDS}`);
  const seen = new Set<string>(); let last = "";
  for (const r of h.records as PerfRecord[]) {
    const p = recordProblem(r, site);
    if (p) throw new PerfHistoryError(`${site}: ${p}`);
    if (seen.has(keyOf(r))) throw new PerfHistoryError(`${site}: ayni gun+url+strateji iki kayit (${keyOf(r)})`);
    if (r.date < last) throw new PerfHistoryError(`${site}: kayitlar tarih sirasinda degil`);
    seen.add(keyOf(r)); last = r.date;
  }
  return h as unknown as HistoryFile;
}

export function historyPath(dir: string, site: string): string {
  if (!SITE_ID.test(site)) throw new Error(`gecersiz site kimligi: ${site}`);
  return join(dir, `${site}.json`);
}
export function loadHistory(dir: string, site: string): HistoryFile {
  const p = historyPath(dir, site);
  if (!existsSync(p)) return { schema: HISTORY_SCHEMA, site, max_records: HISTORY_MAX_RECORDS, records: [] };
  return parseHistory(readFileSync(p, "utf8"), site);
}
export function saveHistory(dir: string, h: HistoryFile): void {
  mkdirSync(dir, { recursive: true });
  const p = historyPath(dir, h.site); const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n");
  renameSync(tmp, p);
}

export type MergeAction = "ADDED" | "KEPT_EXISTING" | "NOT_STORED";
/** (UTC gun, url, strateji) basina ILK basarili olcum kazanir; ayni gunun ikinci kosusu gecmisi oynatamaz.
 *  MEASURED olmayan kayit hic yazilmaz (bkz. recordProblem). Pencere dolunca en eski gun duser. */
export function mergeRecord(h: HistoryFile, rec: PerfRecord): { file: HistoryFile; action: MergeAction } {
  if (rec.site !== h.site) throw new Error(`izolasyon ihlali: ${h.site} gecmisine ${rec.site} kaydi yazilamaz`);
  if (rec.state !== "MEASURED") return { file: h, action: "NOT_STORED" };
  if (h.records.some((r) => keyOf(r) === keyOf(rec))) return { file: h, action: "KEPT_EXISTING" };
  const records = [...h.records, rec].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { file: { ...h, max_records: HISTORY_MAX_RECORDS, records: records.slice(-HISTORY_MAX_RECORDS) }, action: "ADDED" };
}
export const hasMeasuredFor = (h: HistoryFile, date: string, url: string, strategy: Strategy): boolean => h.records.some((r) => r.date === date && r.url === url && r.strategy === strategy);

// --- regresyon --------------------------------------------------------------------------------------------

export interface Regression {
  label: "INFERENCE"; confidence: "CANDIDATE"; action: "REVIEW_REQUIRED" | "OBSERVE_ONLY";
  site: string; url: string; strategy: Strategy; metric: MetricKey | "perf_score";
  source: "field" | "lab"; baseline_date: string; baseline: number; current: number;
  baseline_rating: Rating | null; current_rating: Rating | null; relative_change: number | null;
  /** Neden bilinmiyor: deploy, ucuncu parti script, CrUX penceresi kaymasi, lab gurultusu. Iddia edilmez. */
  causal_claim: "NONE"; note: string;
}

/** Lab tek kosudur ve gurultuludur; esigi yukselterek yanlis alarmi azaltiriz. Field 28 gunluk pencere oldugu icin
 *  kucuk degisim de gercek kaymadir. */
export const MIN_RELATIVE_WORSENING = { field: 0.1, lab: 0.2 } as const;
export const POOR_ESCALATION = 0.25;      // zaten POOR olan metrik %25 daha kotulesirse
export const SCORE_DROP_POINTS = 10;      // perf_score dususu (lab)
const FLOOR: Record<MetricKey, number> = { lcp_ms: 1, inp_ms: 1, ttfb_ms: 1, cls: 0.01 };

/** Baz: ayni (url, strateji, source, field_scope) icin guncelden ESKI gunlerin en yenisi ve metrigi null olmayan.
 *  Ayni gunun kaydi baz olamaz; field ile lab ya da url ile origin birbirine karsi kiyaslanmaz. */
export function selectBaseline(h: { records: PerfRecord[] }, cur: PerfRecord, metric: MetricKey | "perf_score"): PerfRecord | null {
  let best: PerfRecord | null = null;
  for (const r of h.records) {
    if (r.site !== cur.site || r.url !== cur.url || r.strategy !== cur.strategy || r.date >= cur.date) continue;
    if (metric !== "perf_score" && (r.source !== cur.source || r.field_scope !== cur.field_scope)) continue;
    if (r[metric] === null) continue;
    if (!best || r.date > best.date || (r.date === best.date && r.measured_at > best.measured_at)) best = r;
  }
  return best;
}

export function detectRegressions(cur: PerfRecord, h: { records: PerfRecord[] }, onboarded: boolean): Regression[] {
  if (cur.state !== "MEASURED" || (cur.source !== "field" && cur.source !== "lab")) return [];
  const out: Regression[] = [];
  const action = onboarded ? "REVIEW_REQUIRED" : "OBSERVE_ONLY";
  const src = cur.source;
  for (const m of ALL_METRICS) {
    const now = cur[m]; if (now === null) continue;
    const b = selectBaseline(h, cur, m); if (!b) continue;
    const was = b[m] as number;
    const rel = (now - was) / Math.max(was, FLOOR[m]);
    const rb = rate(m, was), rc = rate(m, now);
    const crossed = RANK[rc] > RANK[rb] && rel >= MIN_RELATIVE_WORSENING[src];
    const escalated = rb === "POOR" && rc === "POOR" && rel >= POOR_ESCALATION;
    if (!crossed && !escalated) continue;
    out.push({
      label: "INFERENCE", confidence: "CANDIDATE", action, site: cur.site, url: cur.url, strategy: cur.strategy, metric: m, source: src,
      baseline_date: b.date, baseline: was, current: now, baseline_rating: rb, current_rating: rc, relative_change: Math.round(rel * 1000) / 1000,
      causal_claim: "NONE",
      note: `${m}: ${was} -> ${now} (${rb} -> ${rc}). Neden bilinmiyor; once ayni URL'de tekrar olcum ve son degisiklikler incelenmeli.`,
    });
  }
  // perf_score kaynaktan bagimsiz lab'dir: baz da score'u olan en yeni onceki kayit.
  if (cur.perf_score !== null) {
    const b = selectBaseline(h, cur, "perf_score");
    if (b && (b.perf_score as number) - cur.perf_score >= SCORE_DROP_POINTS) {
      out.push({
        label: "INFERENCE", confidence: "CANDIDATE", action, site: cur.site, url: cur.url, strategy: cur.strategy, metric: "perf_score", source: src,
        baseline_date: b.date, baseline: b.perf_score as number, current: cur.perf_score, baseline_rating: null, current_rating: null,
        relative_change: null, causal_claim: "NONE",
        note: `perf_score: ${b.perf_score} -> ${cur.perf_score}. Lab skoru tek kosu gurultusu icerir; nedeni bilinmiyor.`,
      });
    }
  }
  return out;
}

// --- kosu -------------------------------------------------------------------------------------------------

export interface RunOptions {
  sites: SiteEntry[];
  /** site id -> URL listesi. Yoksa yalniz ana sayfa. Baska sitenin id'si burada yok sayilmaz, host kontrolu reddeder. */
  urlsBySite?: Record<string, string[]>;
  siteFilter?: string[];
  urlsPerSite?: number;
  strategies?: Strategy[];
  maxRequests?: number;
  fetcher?: PsiFetcher | null;      // verilmezse env'den kurulur; anahtar yoksa NOT_CONNECTED
  env?: Record<string, string | undefined>;
  now?: Date;
  historyDir?: string;
  writeHistory?: boolean;
}
export interface SiteOutcome {
  site: string; onboarding_status: SiteEntry["onboarding_status"];
  action: "MEASURED" | "NOT_CONNECTED" | "HISTORY_CORRUPT";
  records: PerfRecord[]; regressions: Regression[];
  rejected_urls: UrlPlan["rejected"]; truncated_urls: string[];
  skipped: { url: string; strategy: Strategy; reason: "BUDGET_EXHAUSTED" | "ALREADY_MEASURED_TODAY" }[];
  history_actions: MergeAction[]; note?: string;
}
export interface PerfReport {
  schema: typeof REPORT_SCHEMA; generated_at: string;
  budget: { limit: number; used: number; unit: "psi_requests" };
  sites: SiteOutcome[];
}

export async function runPerformance(o: RunOptions): Promise<PerfReport> {
  const now = o.now ?? new Date(); const at = now.toISOString();
  const strategies = o.strategies?.length ? o.strategies : (["mobile"] as Strategy[]);
  const fetcher = o.fetcher !== undefined ? o.fetcher : createPsiFetcher(o.env ?? process.env);
  const budget = new RequestBudget(o.maxRequests ?? DEFAULT_MAX_REQUESTS);
  const sites: SiteOutcome[] = [];
  for (const s of o.sites) {
    if (o.siteFilter && !o.siteFilter.includes(s.id)) continue;
    const plan = planUrls(s, o.urlsBySite?.[s.id], o.urlsPerSite);
    const out: SiteOutcome = { site: s.id, onboarding_status: s.onboarding_status, action: "MEASURED", records: [], regressions: [], rejected_urls: plan.rejected, truncated_urls: plan.truncated, skipped: [], history_actions: [] };
    // Olcum her kayitli site icin serbest; tavsiye yalniz onboard edilmis icin (portfolio-isolation).
    const onboarded = s.onboarding_status !== "registered_not_onboarded";
    let hist: HistoryFile | null = null;
    if (o.historyDir) {
      try { hist = loadHistory(o.historyDir, s.id); } catch (e) {
        if (!(e instanceof PerfHistoryError)) throw e;
        // Bozuk gecmis: istek harcama, uzerine yazma; diger siteler etkilenmez.
        out.action = "HISTORY_CORRUPT"; out.note = e.message; sites.push(out); continue;
      }
    }
    for (const url of plan.urls) for (const strategy of strategies) {
      const ctx: ParseCtx = { site: s.id, url, strategy, measuredAt: at };
      if (!fetcher) { out.records.push(errorRecord(ctx, "NOT_CONNECTED", "NOT_CONNECTED")); out.action = "NOT_CONNECTED"; continue; }
      if (hist && hasMeasuredFor(hist, at.slice(0, 10), url, strategy)) { out.skipped.push({ url, strategy, reason: "ALREADY_MEASURED_TODAY" }); continue; }
      if (!budget.tryTake()) { out.skipped.push({ url, strategy, reason: "BUDGET_EXHAUSTED" }); continue; }
      let rec: PerfRecord;
      try { const res = await fetcher({ url, strategy }); rec = parsePsiResponse(res.status, res.body, ctx); }
      catch { rec = errorRecord(ctx, "FETCH_FAILED"); } // mesaj tasinmaz: anahtar sizma riski
      out.records.push(rec);
      if (rec.state === "MEASURED" && hist) {
        out.regressions.push(...detectRegressions(rec, hist, onboarded)); // merge'den ONCE: bugun baz olamaz
        const m = mergeRecord(hist, rec); hist = m.file; out.history_actions.push(m.action);
      }
    }
    if (hist && o.writeHistory !== false && o.historyDir && out.history_actions.includes("ADDED")) saveHistory(o.historyDir, hist);
    sites.push(out);
  }
  return { schema: REPORT_SCHEMA, generated_at: at, budget: { limit: budget.limit, used: budget.used, unit: "psi_requests" }, sites };
}

// --- markdown ---------------------------------------------------------------------------------------------

const cell = (v: number | null, unit = ""): string => (v === null ? "UNKNOWN" : `${v}${unit}`);
export function reportMarkdown(r: PerfReport): string {
  const L: string[] = [];
  L.push("# Performans / Core Web Vitals", "", `Üretim: ${r.generated_at} · PSI isteği: ${r.budget.used}/${r.budget.limit}`, "");
  L.push("Ölçülen değerler FACT'tir (saglayici: PageSpeed Insights). Eşik sınıfları ve regresyonlar INFERENCE / CANDIDATE'tir; neden iddiası yoktur.", "");
  for (const s of r.sites) {
    L.push(`## ${s.site} — ${s.action}`, "");
    if (s.note) L.push(`> ${s.note}`, "");
    if (s.records.length) {
      L.push("| URL | strateji | durum | kaynak | LCP ms | INP ms | CLS | TTFB ms | skor |", "|---|---|---|---|---|---|---|---|---|");
      for (const x of s.records) {
        const rt = (m: MetricKey, v: string) => (x.ratings.values[m] === "UNKNOWN" ? v : `${v} (${x.ratings.values[m]})`);
        L.push(`| ${x.url} | ${x.strategy} | ${x.state} | ${x.source}${x.field_scope === "origin" ? " (origin)" : ""} | ${rt("lcp_ms", cell(x.lcp_ms))} | ${rt("inp_ms", cell(x.inp_ms))} | ${rt("cls", cell(x.cls))} | ${rt("ttfb_ms", cell(x.ttfb_ms))} | ${cell(x.perf_score)} |`);
      }
      L.push("");
    }
    if (s.regressions.length) {
      L.push("**Regresyon adayları (INFERENCE / CANDIDATE):**", "");
      for (const g of s.regressions) L.push(`- ${g.action} · ${g.url} (${g.strategy}, ${g.source}) · ${g.note}`);
      L.push("");
    }
    if (s.rejected_urls.length) L.push(`Reddedilen URL: ${s.rejected_urls.map((x) => `${x.url} (${x.reason})`).join("; ")}`, "");
    if (s.truncated_urls.length) L.push(`Tavan nedeniyle ölçülmeyen URL: ${s.truncated_urls.length}`, "");
    if (s.skipped.length) L.push(`Atlanan: ${s.skipped.map((x) => `${x.url} ${x.strategy} (${x.reason})`).join("; ")}`, "");
  }
  return L.join("\n") + "\n";
}
