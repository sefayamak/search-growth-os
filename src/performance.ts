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

export interface ThresholdProvenance {
  source: string;
  /** Erisim tarihi YALNIZ gercekten erisildiyse yazilir; erisilemediyse NOT_RETRIEVED_THIS_SESSION. */
  accessed: string;
  status: "DOCUMENTED_ASSUMPTION" | "VERIFIED_AGAINST_SOURCE";
}
export interface ThresholdConfig {
  provenance: ThresholdProvenance;
  /** iyi <= good, zayif > poor. Birim: LCP/INP/TTFB ms, CLS birimsiz. */
  metrics: Record<MetricKey, { good: number; poor: number }>;
}
/** Esikler bilgiden yazildi; web.dev bu oturumda ULASILAMADI, bu yuzden FACT degil DOCUMENTED_ASSUMPTION.
 *  Her ratings ciktisi bu kayda referans verir (`thresholds_ref`); parametreyle degistirilebilir.
 *  TTFB 800/1800 ms web.dev'de CWV degil, yardimci metriktir. */
export const CWV_THRESHOLDS: ThresholdConfig = {
  provenance: { source: "web.dev/vitals", accessed: "NOT_RETRIEVED_THIS_SESSION", status: "DOCUMENTED_ASSUMPTION" },
  metrics: {
    lcp_ms: { good: 2500, poor: 4000 },
    inp_ms: { good: 200, poor: 500 },
    cls: { good: 0.1, poor: 0.25 },
    ttfb_ms: { good: 800, poor: 1800 },
  },
};
/** Geriye uyumluluk: yalniz sayilar. Kaynak bilgisi icin CWV_THRESHOLDS kullan. */
export const THRESHOLDS = CWV_THRESHOLDS.metrics;

/** Gecersiz (NaN, good>=poor, <=0) esik ayari sessizce her seyi GOOD/POOR yapardi: fail-closed. */
export function assertThresholds(c: ThresholdConfig): ThresholdConfig {
  for (const m of ["lcp_ms", "inp_ms", "cls", "ttfb_ms"] as const) {
    const t = c?.metrics?.[m];
    if (!t || !Number.isFinite(t.good) || !Number.isFinite(t.poor) || t.good <= 0 || t.poor <= t.good) throw new Error(`gecersiz esik: ${m}`);
  }
  if (!c.provenance?.source || !c.provenance.accessed || !c.provenance.status) throw new Error("esik provenance eksik");
  return c;
}

/** Hicbir sey canli dogrulanmadi (ag yok). Rapor ve dokuman bu listeyi tasir; "dogrulandi" iddiasi yoktur. */
export const VALIDATION_STATUS = {
  psi_response_shape: "NOT_LIVE_VALIDATED",
  psi_quota_behaviour: "NOT_LIVE_VALIDATED",
  crux_availability_7_sites: "NOT_LIVE_VALIDATED",
  crux_cls_percentile_unit: "NOT_LIVE_VALIDATED",
  lab_inp_audit_presence: "NOT_LIVE_VALIDATED",
  cwv_thresholds: "DOCUMENTED_ASSUMPTION",
} as const;

/** Birim varsayimlari (canli yanitla dogrulanmadi). */
export const UNIT_ASSUMPTIONS = {
  lcp_ms: "ms (CrUX percentile ve lab numericValue)",
  inp_ms: "ms (CrUX percentile)",
  ttfb_ms: "ms (CrUX percentile ve lab server-response-time numericValue)",
  cls: "birimsiz. CrUX percentile: tamsayi ise x100 (10 -> 0.10) VARSAYIMI; ondalikli sayi/dizge ise zaten birimsiz. Lab numericValue birimsiz.",
} as const;
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
  /** CrUX `category` (FAST/AVERAGE/SLOW) saglayicinin kendi sinifidir; bizim INFERENCE'imizden ayri tutulur, esik girdisi degildir. */
  field_category?: Partial<Record<MetricKey, "FAST" | "AVERAGE" | "SLOW">>;
  /** INFERENCE: esik siniflandirmasi. `thresholds_ref` hangi esik kaynagina/durumuna dayandigini soyler. */
  ratings: { label: "INFERENCE"; confidence: "CANDIDATE" | "UNKNOWN"; values: Record<MetricKey, Rating>; thresholds_ref: ThresholdProvenance };
}

// --- siniflandirma ----------------------------------------------------------------------------------------

export function rate(metric: MetricKey, v: number | null, cfg: ThresholdConfig = CWV_THRESHOLDS): Rating {
  if (v === null) return "UNKNOWN";
  const t = cfg.metrics[metric];
  return v <= t.good ? "GOOD" : v <= t.poor ? "NEEDS_IMPROVEMENT" : "POOR";
}
const RANK: Record<Rating, number> = { GOOD: 0, NEEDS_IMPROVEMENT: 1, POOR: 2, UNKNOWN: -1 };

/** Gecerli sayi degilse null. Sifir/negatif sure "olcum yok" demektir (sifir LCP fiziksel olarak yok);
 *  CLS icin 0 gecerli ve en iyi degerdir. Sayisal DIZGE ("2500") kabul edilir (bazi CrUX yuklerinde percentile dizge);
 *  "", "abc", "1e3x", "Infinity" null olur — bos dizge 0 sayilmaz. */
function num(v: unknown, metric: MetricKey): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  else return null;
  if (!Number.isFinite(n)) return null;
  if (metric === "cls") return n >= 0 ? n : null;
  return n > 0 ? n : null;
}

/** CrUX CLS percentile birimi (VARSAYIM, canli dogrulanmadi): PSI v5 belgesi tamsayi x100 verir (10 -> 0.10).
 *  Bazi yuklerde dizge gelir. Kural, tahmin yerine acik ve testli:
 *   - tamsayi (sayi ya da "5") -> /100;
 *   - ondalikli ("0.05" ya da 0.05) -> zaten birimsiz, oldugu gibi.
 *  Belirsiz tek durum: tamsayi 0 (iki yorumda da 0) ve 1 ("1" = 0.01 mi, 1.0 mi?) -> x100 yorumu esas alinir. */
export function cruxClsFromPercentile(p: unknown): number | null {
  const n = num(p, "cls");
  if (n === null) return null;
  const decimalText = typeof p === "string" ? /\./.test(p) : !Number.isInteger(p as number);
  return decimalText ? n : n / 100;
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// --- PSI ayristirma ---------------------------------------------------------------------------------------

export interface ParseCtx { site: string; url: string; strategy: Strategy; measuredAt: string; thresholds?: ThresholdConfig }

function base(ctx: ParseCtx): PerfRecord {
  return {
    schema: RECORD_SCHEMA, site: ctx.site, url: ctx.url, strategy: ctx.strategy, measured_at: ctx.measuredAt, date: ctx.measuredAt.slice(0, 10),
    lcp_ms: null, inp_ms: null, cls: null, ttfb_ms: null, perf_score: null, source: "none", field_scope: null,
    state: "UNKNOWN", evidence: "FACT", confidence: "UNKNOWN", provider: "PageSpeed Insights API v5",
    ratings: { label: "INFERENCE", confidence: "UNKNOWN", values: { lcp_ms: "UNKNOWN", inp_ms: "UNKNOWN", cls: "UNKNOWN", ttfb_ms: "UNKNOWN" }, thresholds_ref: (ctx.thresholds ?? CWV_THRESHOLDS).provenance },
  };
}

function finish(r: PerfRecord, cfg: ThresholdConfig = CWV_THRESHOLDS): PerfRecord {
  const vals = {} as Record<MetricKey, Rating>;
  for (const m of ALL_METRICS) vals[m] = rate(m, r[m], cfg);
  const any = ALL_METRICS.some((m) => r[m] !== null) || r.perf_score !== null;
  r.ratings = { label: "INFERENCE", confidence: ALL_METRICS.some((m) => r[m] !== null) ? "CANDIDATE" : "UNKNOWN", values: vals, thresholds_ref: cfg.provenance };
  if (r.state !== "ERROR" && r.state !== "NOT_CONNECTED") { r.state = any ? "MEASURED" : "UNKNOWN"; r.confidence = any ? "CONFIRMED" : "UNKNOWN"; }
  r.source = ALL_METRICS.some((m) => r[m] !== null) ? r.source : (r.perf_score !== null ? "lab" : "none");
  return r;
}

export function errorRecord(ctx: ParseCtx, code: string, state: "ERROR" | "NOT_CONNECTED" = "ERROR"): PerfRecord {
  const r = base(ctx); r.state = state; r.confidence = "UNKNOWN"; r.error_code = code.slice(0, 60); return finish(r, ctx.thresholds);
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
  //    `loadingExperience` URL duzeyidir (veri yoksa PSI ayni alana origin verip origin_fallback:true yazar).
  //    `originLoadingExperience` BILEREK okunmaz: onu URL kaydina geri-dusus olarak koymak olcumsuz bir sayfaya
  //    site ortalamasi yazmak olur; scope'u yalniz saglayicinin kendi origin_fallback bayragi belirler.
  const le = obj(b.loadingExperience);
  const fm = obj(le?.metrics);
  if (fm) {
    const mo = (...keys: string[]): Record<string, unknown> | null => { for (const k of keys) { const o = obj(fm[k]); if (o) return o; } return null; };
    const SRC: Record<MetricKey, Record<string, unknown> | null> = {
      lcp_ms: mo("LARGEST_CONTENTFUL_PAINT_MS"),
      inp_ms: mo("INTERACTION_TO_NEXT_PAINT"),
      cls: mo("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
      // Yeni adlandirma TIME_TO_FIRST_BYTE olabilir; ikisi de kabul, "EXPERIMENTAL_" onceligi eski sozlesme.
      ttfb_ms: mo("EXPERIMENTAL_TIME_TO_FIRST_BYTE", "TIME_TO_FIRST_BYTE"),
    };
    const f = {
      lcp_ms: num(SRC.lcp_ms?.percentile, "lcp_ms"),
      inp_ms: num(SRC.inp_ms?.percentile, "inp_ms"),
      cls: cruxClsFromPercentile(SRC.cls?.percentile),
      ttfb_ms: num(SRC.ttfb_ms?.percentile, "ttfb_ms"),
    };
    if (ALL_METRICS.some((m) => f[m] !== null)) {
      Object.assign(r, f); r.source = "field"; r.field_scope = le?.origin_fallback === true ? "origin" : "url";
      const cat: NonNullable<PerfRecord["field_category"]> = {};
      for (const m of ALL_METRICS) { const c = SRC[m]?.category; if (f[m] !== null && (c === "FAST" || c === "AVERAGE" || c === "SLOW")) cat[m] = c; }
      if (Object.keys(cat).length) r.field_category = cat;
    }
  }
  // 2) Lab yalniz field yoksa metrik kaynagidir. Denetim "error"/"notApplicable"/"manual" ise numericValue guvenilmez
  //    (Lighthouse bazen yine de bir sayi tasir): yok sayilir, 0'a cevrilmez.
  const audits = obj(lh?.audits);
  if (r.source !== "field" && audits) {
    const av = (id: string): unknown => {
      const a = obj(audits[id]); if (!a) return undefined;
      const mode = a.scoreDisplayMode;
      if (mode === "error" || mode === "notApplicable" || mode === "manual") return undefined;
      return a.numericValue;
    };
    // Lab INP: navigation kosusunda genelde YOK (timespan denetimi); varsa okunur, yoksa null.
    const l = { lcp_ms: num(av("largest-contentful-paint"), "lcp_ms"), inp_ms: num(av("interaction-to-next-paint"), "inp_ms"), cls: num(av("cumulative-layout-shift"), "cls"), ttfb_ms: num(av("server-response-time"), "ttfb_ms") };
    if (ALL_METRICS.some((m) => l[m] !== null)) { Object.assign(r, l); r.source = "lab"; }
  }
  // 3) perf_score her zaman lab kategorisinden; 0-1 -> 0-100. Sinir disi (ornegin zaten 0-100 gelmis 91) yok sayilir:
  //    91 -> 9100 yazmaktansa null.
  const sc = obj(obj(lh?.categories)?.performance)?.score;
  if (typeof sc === "number" && Number.isFinite(sc) && sc >= 0 && sc <= 1) r.perf_score = Math.round(sc * 100);
  return finish(r, ctx.thresholds);
}

// --- URL planlama + butce ---------------------------------------------------------------------------------

export interface UrlPlan { urls: string[]; rejected: { url: string; reason: string }[]; truncated: string[] }

const hostOf = (u: string): string | null => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.hostname.toLowerCase() : null; } catch { return null; } };
const stripWww = (h: string) => h.replace(/^www\./, "");
export const MAX_URL_LENGTH = 2048;

/** Host eslesmesi tek basina yetmez: `user:pw@` (kimlik bilgisi PSI'ye ve kayda sizar), varsayilan disi port
 *  (baska bir servis) ve asiri uzun URL de reddedilir. `new URL` IDN'i punycode'a, `evil.com\\@site` ve
 *  `site@evil.com` kaliplarini gercek host'a cevirir; karar ayristirilmis host uzerinden verilir, dizge uzerinden degil. */
function urlProblem(raw: string, own: Set<string>): { href?: string; reason?: string } {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return { reason: "gecersiz URL" };
  let x: URL;
  try { x = new URL(raw); } catch { return { reason: "gecersiz URL" }; }
  if (x.protocol !== "https:" && x.protocol !== "http:") return { reason: "gecersiz URL" };
  const h = x.hostname.toLowerCase();
  if (!own.has(stripWww(h))) return { reason: `host ${h} bu sitenin degil (izolasyon)` };
  if (x.username || x.password) return { reason: "URL kimlik bilgisi (user:pass@) tasiyor" };
  if (x.port) return { reason: `varsayilan disi port :${x.port}` };
  x.hash = "";
  return { href: x.href };
}

/** Izolasyon: URL yalniz bu sitenin canonical/production host'unda (www varyanti dahil). Baska site ya da
 *  ucuncu parti URL reddedilir — "ayni kisinin sitesi" gerekce degildir. */
export function planUrls(site: SiteEntry, requested: string[] | undefined, perSite = DEFAULT_URLS_PER_SITE): UrlPlan {
  const cap = Math.max(1, Math.min(Math.floor(perSite) || DEFAULT_URLS_PER_SITE, HARD_URL_CAP));
  const own = new Set([stripWww(site.canonical_hostname.toLowerCase()), stripWww(site.production_domain.toLowerCase())]);
  const input = requested && requested.length ? requested : [`https://${site.canonical_hostname}/`];
  const urls: string[] = []; const rejected: UrlPlan["rejected"] = []; const truncated: string[] = []; const seen = new Set<string>();
  for (const raw of input) {
    const chk = urlProblem(raw, own);
    if (!chk.href) { rejected.push({ url: typeof raw === "string" ? raw.slice(0, 200) : String(raw), reason: chk.reason! }); continue; }
    const key = chk.href;
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
  // NaN/Infinity/sayi-disi: Math.max(0, NaN) NaN verir ve `used >= NaN` hep false -> SINIRSIZ butce. Fail-closed: 0.
  constructor(limit: number) { this.limit = typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0; }
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

export function detectRegressions(cur: PerfRecord, h: { records: PerfRecord[] }, onboarded: boolean, cfg: ThresholdConfig = CWV_THRESHOLDS): Regression[] {
  if (cur.state !== "MEASURED" || (cur.source !== "field" && cur.source !== "lab")) return [];
  const out: Regression[] = [];
  const action = onboarded ? "REVIEW_REQUIRED" : "OBSERVE_ONLY";
  const src = cur.source;
  for (const m of ALL_METRICS) {
    const now = cur[m]; if (now === null) continue;
    const b = selectBaseline(h, cur, m); if (!b) continue;
    const was = b[m] as number;
    const rel = (now - was) / Math.max(was, FLOOR[m]);
    const rb = rate(m, was, cfg), rc = rate(m, now, cfg);
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
        label: "INFERENCE", confidence: "CANDIDATE", action, site: cur.site, url: cur.url, strategy: cur.strategy, metric: "perf_score", source: "lab", // perf_score HER ZAMAN lab; kayit field olsa da "field" yazmak yanlis etiket olurdu
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
  /** Esik ayari (varsayilan CWV_THRESHOLDS = DOCUMENTED_ASSUMPTION). Gecersizse atar. */
  thresholds?: ThresholdConfig;
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
  /** Esiklerin kaynagi/durumu: raporu okuyan, siniflarin neye dayandigini gorur. */
  thresholds_ref: ThresholdProvenance;
  validation_status: typeof VALIDATION_STATUS;
  unit_assumptions: typeof UNIT_ASSUMPTIONS;
  sites: SiteOutcome[];
}

export async function runPerformance(o: RunOptions): Promise<PerfReport> {
  const now = o.now ?? new Date(); const at = now.toISOString();
  const strategies = o.strategies?.length ? o.strategies : (["mobile"] as Strategy[]);
  const fetcher = o.fetcher !== undefined ? o.fetcher : createPsiFetcher(o.env ?? process.env);
  const budget = new RequestBudget(o.maxRequests ?? DEFAULT_MAX_REQUESTS);
  const cfg = assertThresholds(o.thresholds ?? CWV_THRESHOLDS);
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
      const ctx: ParseCtx = { site: s.id, url, strategy, measuredAt: at, thresholds: cfg };
      if (!fetcher) { out.records.push(errorRecord(ctx, "NOT_CONNECTED", "NOT_CONNECTED")); out.action = "NOT_CONNECTED"; continue; }
      if (hist && hasMeasuredFor(hist, at.slice(0, 10), url, strategy)) { out.skipped.push({ url, strategy, reason: "ALREADY_MEASURED_TODAY" }); continue; }
      if (!budget.tryTake()) { out.skipped.push({ url, strategy, reason: "BUDGET_EXHAUSTED" }); continue; }
      let rec: PerfRecord;
      try { const res = await fetcher({ url, strategy }); rec = parsePsiResponse(res.status, res.body, ctx); }
      catch (e) {
        // Mesaj tasinmaz (anahtar sizma riski); yalniz beyaz-listeli kod: timeout ag hatasindan ayrilir.
        rec = errorRecord(ctx, (e as { code?: unknown })?.code === "TIMEOUT" ? "FETCH_TIMEOUT" : "FETCH_FAILED");
      }
      out.records.push(rec);
      if (rec.state === "MEASURED" && hist) {
        out.regressions.push(...detectRegressions(rec, hist, onboarded, cfg)); // merge'den ONCE: bugun baz olamaz
        const m = mergeRecord(hist, rec); hist = m.file; out.history_actions.push(m.action);
      }
    }
    if (hist && o.writeHistory !== false && o.historyDir && out.history_actions.includes("ADDED")) saveHistory(o.historyDir, hist);
    sites.push(out);
  }
  return { schema: REPORT_SCHEMA, generated_at: at, budget: { limit: budget.limit, used: budget.used, unit: "psi_requests" }, thresholds_ref: cfg.provenance, validation_status: VALIDATION_STATUS, unit_assumptions: UNIT_ASSUMPTIONS, sites };
}

// --- markdown ---------------------------------------------------------------------------------------------

const cell = (v: number | null, unit = ""): string => (v === null ? "UNKNOWN" : `${v}${unit}`);
export function reportMarkdown(r: PerfReport): string {
  const L: string[] = [];
  L.push("# Performans / Core Web Vitals", "", `Üretim: ${r.generated_at} · PSI isteği: ${r.budget.used}/${r.budget.limit}`, "");
  L.push("Ölçülen değerler FACT'tir (saglayici: PageSpeed Insights). Eşik sınıfları ve regresyonlar INFERENCE / CANDIDATE'tir; neden iddiası yoktur.", "");
  L.push(`Eşik kaynağı: ${r.thresholds_ref.source} · erişim: ${r.thresholds_ref.accessed} · durum: ${r.thresholds_ref.status}.`, "");
  L.push(`Doğrulama durumu: gerçek PSI yanıt şekli ${r.validation_status.psi_response_shape}; kota davranışı ${r.validation_status.psi_quota_behaviour}; 7 site için CrUX varlığı ${r.validation_status.crux_availability_7_sites}.`, "");
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
