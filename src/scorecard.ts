// Site basina scorecard: ARTIFACT DOSYALARINDAN okur, hicbir sey olcmez, hicbir sey yazmaz.
//
// NEDEN TEK SKOR YOK: alti boyutu tek sayiya ortalamak, bir boyutun "bilmiyoruz"unu digerlerinin
// "iyi"si ile seyreltir ve sahte bir 82/100 uretir (CLAUDE.md kural 1 ve 4). Burada her boyut kendi
// durumunu, kanit etiketini, guvenini, dayanagini ve tarihini tasir; ozet yalniz SAYIM'dir.
//
// NEDEN YANLIS NEGATIF KORKUTUCU: eksik girdi "OK" gorunurse gercek olcum hic yapilmaz (kural 6).
// Bu yuzden: girdi yok -> UNKNOWN; girdi bayat -> UNKNOWN-STALE; dosya baska siteye ait -> UNKNOWN.
// OK, yalnizca taze + o siteye ait + okunabilir bir olcumun kendisi OK dediginde verilir ve
// basis alani NEYE baktigimizi yazar (bir sey bulunmadiginda neye baktigimiz da gorunsun).
//
// Diger ajanlarin birlestirilmemis modullerini IMPORT ETMEZ; yalniz JSON'u belgelenmis sema
// kimligiyle okur: sgos.clarity-history.v1, sgos.performance-history.v1, sgos.index-history.v1,
// sgos.deployment-timeline.v1 (olaylar sgos.deployment-event.v1), sgos.measure-report.v1.
// Performance/index/deployment URETICININ gercek alanlarini okur (adaptor katmani asagida; docs/scorecard-contracts.md).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Confidence, EvidenceLabel } from "./types.ts";

export const SCORECARD_SCHEMA = "sgos.scorecard.v1" as const;
export const SCHEMA_IDS = {
  clarity: "sgos.clarity-history.v1",
  performance: "sgos.performance-history.v1",
  index: "sgos.index-history.v1",
  deployment: "sgos.deployment-event.v1",
  deploymentTimeline: "sgos.deployment-timeline.v1",
  performanceRecord: "sgos.performance.v1",
  performanceReport: "sgos.performance-report.v1",
  measure: "sgos.measure-report.v1",
} as const;

export const DIMENSIONS = ["measurement_health", "index_health", "search_opportunity", "ux_friction", "performance", "deployment_change"] as const;
export type DimensionId = (typeof DIMENSIONS)[number];
export type DimState = "OK" | "ATTENTION" | "UNKNOWN" | "UNKNOWN-STALE" | "NOT_CONNECTED";

export interface Dimension {
  dimension: DimensionId;
  state: DimState;
  evidence_label: EvidenceLabel;
  confidence: Confidence;
  basis: string;
  /** Verinin ait oldugu an (ISO). Girdi yoksa null: tarih uydurulmaz. */
  as_of: string | null;
}

export interface SiteScorecard {
  schema: typeof SCORECARD_SCHEMA;
  site_id: string;
  generated_at: string;
  onboarding_status: string | "UNKNOWN";
  dimensions: Dimension[];
  /** Yalniz sayim. Agirlikli/ortalama skor BILEREK yok. */
  counts: Record<DimState, number>;
}

/** Dimension basina azami veri yasi (gun). Clarity/index gunluk kosar; performans/olcum haftalik + payi. */
export const DEFAULT_MAX_AGE_DAYS: Record<DimensionId, number> = {
  measurement_health: 3, ux_friction: 3, index_health: 3, performance: 10, search_opportunity: 10, deployment_change: 10,
};

/** Clarity-daily ile ayni esikler (src/clarity-daily.ts): tekrar tanimlamak yerine kopyalandi cunku o modul
 *  I/O iceriyor; degerler degisirse test (scorecard.test.ts) farki yakalar. */
export const MIN_REAL_SESSIONS = 5;
/** web.dev "good" esikleri (Core Web Vitals "good" esikleri; kaynak notu docs/scorecard-orchestration.md). */
export const CWV_GOOD = { lcp_ms: 2500, cls: 0.1, inp_ms: 200 } as const;

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Tarih ayristirma: cop, tarih-oncesi ve gelecegi reddeder (gelecek tarih = bayatlik testini kandirirdi). */
export function parseWhen(v: unknown, now: Date): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > now.getTime() + DAY_MS) return null;
  return d;
}
const ageDays = (d: Date, now: Date) => Math.floor((now.getTime() - d.getTime()) / DAY_MS);

function dim(dimension: DimensionId, state: DimState, evidence_label: EvidenceLabel, confidence: Confidence, basis: string, as_of: string | null): Dimension {
  return { dimension, state, evidence_label, confidence, basis, as_of };
}
const unknown = (d: DimensionId, basis: string, as_of: string | null = null) => dim(d, "UNKNOWN", "FACT", "UNKNOWN", basis, as_of);
const stale = (d: DimensionId, asOf: Date, age: number, max: number) =>
  dim(d, "UNKNOWN-STALE", "FACT", "UNKNOWN", `son veri ${age} gun once (${asOf.toISOString().slice(0, 10)}), sinir ${max} gun; bayat veri "OK" sayilmaz`, asOf.toISOString());

type Gate = { ok: true; payload: Record<string, unknown> } | { ok: false; dim: Dimension };

/** Ortak kapi: dosya var mi, dogru sema mi, dogru site mi. Her biri ayri UNKNOWN nedeni. */
function gate(d: DimensionId, raw: unknown, schema: string, siteId: string): Gate {
  if (raw === undefined || raw === null) return { ok: false, dim: unknown(d, `girdi yok (${schema} dosyasi verilmedi/bulunamadi)`) };
  if (!isObj(raw)) return { ok: false, dim: unknown(d, `${schema}: JSON nesne degil`) };
  if (raw.schema !== schema) return { ok: false, dim: unknown(d, `sema beklenen ${schema}, gelen ${String(raw.schema)}`) };
  // Izolasyon: baska sitenin dosyasi bu sitenin skoruna girmez (kural 3).
  if (raw.site_id !== undefined && raw.site_id !== siteId) return { ok: false, dim: unknown(d, `site_id uyusmuyor (${String(raw.site_id)} != ${siteId}); izolasyon geregi kullanilmadi`) };
  return { ok: true, payload: raw };
}

interface ClarityRec { date: string; measured_at?: string; measurement_state?: string; confidence?: string; rows_complete?: unknown; is_zero?: boolean; usable?: boolean; measurement_success?: boolean; friction?: Record<string, unknown>; friction_total?: unknown; sessions?: Record<string, unknown>; error_code?: string; site_id?: string }

function clarityRecords(p: Record<string, unknown>, siteId: string): ClarityRec[] {
  if (!Array.isArray(p.records)) return [];
  return p.records.filter((r): r is ClarityRec => isObj(r) && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (r.site_id === undefined || r.site_id === siteId))
    .sort((a, b) => a.date.localeCompare(b.date));
}
/** clarity-daily.measurementSuccessOf ile ayni kural; kayitta acik alan varsa o, yoksa turetilir. */
const clarityOk = (r: ClarityRec) => typeof r.measurement_success === "boolean" ? r.measurement_success : r.measurement_state === "MEASURED" && r.confidence === "CONFIRMED" && r.rows_complete === true;

// ---------------------------------------------------------------------------
// Boyutlar
// ---------------------------------------------------------------------------

export function measurementHealth(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.measurement_health): Dimension {
  const D = "measurement_health" as const;
  const g = gate(D, raw, SCHEMA_IDS.clarity, siteId); if (!g.ok) return g.dim;
  const recs = clarityRecords(g.payload, siteId);
  if (!recs.length) return unknown(D, "gecmis dosyasi var ama kayit yok");
  const last = recs[recs.length - 1];
  const when = parseWhen(last.measured_at ?? last.date, now);
  if (!when) return unknown(D, `son kayit tarihi gecersiz/gelecek (${String(last.measured_at ?? last.date)})`);
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  if (last.measurement_state === "NOT_CONNECTED") return dim(D, "NOT_CONNECTED", "FACT", "CONFIRMED", "Clarity bu site icin bagli degil (token yok); sifir degil", asOf);
  if (clarityOk(last)) {
    // Son 7 kayittaki basarisiz gunleri de yaz: tek yesil gun, gecmisteki dalgalanmayi gizlemesin.
    const recent = recs.slice(-7), failed = recent.filter((r) => !clarityOk(r) && r.measurement_state !== "NOT_CONNECTED").length;
    return dim(D, "OK", "FACT", "CONFIRMED", `son olcum ${last.date} MEASURED+CONFIRMED+rows_complete; son ${recent.length} kayitta ${failed} basarisiz`, asOf);
  }
  return dim(D, "ATTENTION", "FACT", "CONFIRMED", `son olcum ${last.date} basarisiz: state=${last.measurement_state} confidence=${last.confidence} rows_complete=${String(last.rows_complete)}${last.error_code ? ` error=${last.error_code}` : ""}`, asOf);
}

export function uxFriction(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.ux_friction): Dimension {
  const D = "ux_friction" as const;
  const g = gate(D, raw, SCHEMA_IDS.clarity, siteId); if (!g.ok) return g.dim;
  const recs = clarityRecords(g.payload, siteId);
  if (!recs.length) return unknown(D, "gecmis dosyasi var ama kayit yok");
  const latest = recs[recs.length - 1];
  if (latest.measurement_state === "NOT_CONNECTED") { const w = parseWhen(latest.measured_at ?? latest.date, now); return dim(D, "NOT_CONNECTED", "FACT", "CONFIRMED", "Clarity bagli degil", w ? w.toISOString() : null); }
  // Yalniz KULLANILABILIR kayit friction icin dayanaktir: basarisiz gun "sifir friction" degildir.
  const usable = [...recs].reverse().find((r) => r.usable === true);
  if (!usable) return unknown(D, "kullanilabilir (usable) Clarity kaydi yok; hata/sifir/eksik gunler friction=0 sayilmaz");
  const when = parseWhen(usable.measured_at ?? usable.date, now);
  if (!when) return unknown(D, "kullanilabilir kaydin tarihi gecersiz");
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  const real = usable.sessions?.real;
  if (!isNum(real)) return unknown(D, `${usable.date}: gercek oturum sayisi UNKNOWN`, asOf);
  // Az oturumda "friction yok" bir olcum degil, ornek yetersizligi (yanlis negatif korumasi).
  if (real < MIN_REAL_SESSIONS) return unknown(D, `${usable.date}: yalniz ${real} gercek oturum (< ${MIN_REAL_SESSIONS}); friction hakkinda karar verilmez`, asOf);
  const f = usable.friction ?? {};
  const keys = ["rage_click_count", "script_error_count", "error_click_count", "dead_click_count"] as const;
  // dead_click ESIK DEGIL: taban cizgisi olmadan tek bir olu tik sinyal sayilmaz (gercek veride 1 gorulur). Yalniz
  // basis'e yazilir; trend/baz karsilastirmasi clarity-daily alert'inin isi.
  const hot = keys.filter((k) => k !== "dead_click_count" && isNum(f[k]) && (f[k] as number) > 0);
  const unk = keys.filter((k) => !isNum(f[k]));
  const checked = `bakilan: ${keys.join(", ")} (dead_click bilgi amacli, esik degil; dead_click=${String(f.dead_click_count)}); gercek oturum ${real}`;
  // Sayilar FACT, "sorun var" yorumu INFERENCE: birkac dead click kusur kaniti degildir -> CANDIDATE.
  if (hot.length) return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${usable.date}: ${hot.map((k) => `${k}=${String(f[k])}`).join(", ")}; ${checked}${unk.length ? `; UNKNOWN: ${unk.join(",")}` : ""}`, asOf);
  if (unk.length) return unknown(D, `${usable.date}: ${unk.join(", ")} UNKNOWN; sifir sayilmadi`, asOf);
  return dim(D, "OK", "INFERENCE", "CANDIDATE", `${usable.date}: rage/script_error/error_click 0; ${checked}. Tek gunluk olcum, kesin "sorun yok" degil`, asOf);
}

// ---------------------------------------------------------------------------
// URETICI ADAPTOR KATMANI (performance / index / deployment)
//
// NEDEN: bu uc boyutun ilk surumu KENDI uydurdugu alan adlarini okuyordu (site_id, records[].measurement_state,
// not_indexed_count, {events,generated_at}). Gercek ureticiler (#36 performance, #34 index-alarms, #32 deployment-timeline)
// baska sekil yaziyor; bu yuzden hepsi sessizce UNKNOWN'a dusecekti ya da -- daha kotusu -- site_id alani
// olmadigi icin IZOLASYON KONTROLU atlanacakti. Ilke: ureticinin gercek semasi KANONIKTIR; scorecard ikinci bir
// veri modeli kurmaz, yalniz asagidaki okuyucularla uretici alanlarini kendi boyut durumuna cevirir.
// Okunan alanlarin tam listesi: docs/scorecard-contracts.md. Taninmayan sekil = UNKNOWN (asla OK, asla 0).
// ---------------------------------------------------------------------------

/** Scorecard'in URETICI dosyalarindan okudugu alanlarin TAM listesi (tek dogruluk kaynagi). `[]` = dizi elemani.
 *  Test (tests/scorecard-contract.test.ts) bu listeyi (a) uretici-sekilli fixture'larda, (b) docs/scorecard-contracts.md'de arar:
 *  listeye alan eklenip belgelenmez ya da uretici alani yeniden adlandirilirsa test kirilir. Listede olmayan alan OKUNMAZ. */
export const CONSUMED_PRODUCER_FIELDS: Record<string, string[]> = {
  "sgos.performance-history.v1": ["schema", "site", "records[].schema", "records[].site", "records[].state", "records[].source", "records[].date", "records[].measured_at", "records[].url", "records[].strategy", "records[].lcp_ms", "records[].inp_ms", "records[].cls"],
  "sgos.performance-report.v1": ["schema", "generated_at", "sites[].site", "sites[].regressions[].label", "sites[].regressions[].site", "sites[].regressions[].metric"],
  "sgos.index-history.v1": ["schema", "site", "snapshots[].site", "snapshots[].taken_at", "snapshots[].sample_size", "snapshots[].universe_size", "snapshots[].stopped", "snapshots[].entries[].state", "snapshots[].entries[].verdict", "snapshots[].entries[].in_sitemap", "snapshots[].entries[].fetch_ok", "snapshots[].entries[].canonical_self", "snapshots[].entries[].indexable"],
  "index-alarms-report": ["site", "generated_at", "index_alarms.status", "index_alarms.alarms"],
  "sgos.deployment-timeline.v1": ["schema", "site", "events"],
  // Anahtarli nesne: `{site}` = istenen site kimligi (test fixture'in sitesiyle degistirir). Yalniz bu alanlar okunur.
  "sgos.measure-report.v1": ["schema", "generated_at", "sites.{site}.site_id", "sites.{site}.generated_at", "sites.{site}.gsc_state", "sites.{site}.opportunity_count", "sites.{site}.period.start", "sites.{site}.period.end", "sites.{site}.gsc.state", "sites.{site}.gsc.state_reason", "sites.{site}.gsc.rows_complete", "sites.{site}.gsc.coverage.queries_truncated", "sites.{site}.gsc.coverage.query_rows_total", "sites.{site}.gsc.coverage.query_rows_returned", "sites.{site}.search_opportunity_inputs.state", "sites.{site}.search_opportunity_inputs.candidates"],
  "sgos.deployment-event.v1": ["events[].schema", "events[].site", "events[].environment", "events[].commit_sha", "events[].deployed_at", "events[].verification_state", "events[].provenance.retrieved_at"],
};

const ISO_Z =/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Ureticiler sitenin kimligini `site` alaninda yazar (`site_id` degil). Alan YOKSA UNKNOWN: izolasyon dogrulanamadi,
 *  "baska siteye ait degil" varsayilmaz (kural 3 + 6). */
function producerGate(d: DimensionId, raw: unknown, schema: string, siteId: string): Gate {
  if (raw === undefined || raw === null) return { ok: false, dim: unknown(d, `girdi yok (${schema} dosyasi verilmedi/bulunamadi)`) };
  if (!isObj(raw)) return { ok: false, dim: unknown(d, `${schema}: JSON nesne degil`) };
  if (raw.schema !== schema) return { ok: false, dim: unknown(d, `sema beklenen ${schema}, gelen ${String(raw.schema)}`) };
  if (typeof raw.site !== "string") return { ok: false, dim: unknown(d, `${schema}: uretici 'site' alani yok; izolasyon dogrulanamadi, kullanilmadi`) };
  if (raw.site !== siteId) return { ok: false, dim: unknown(d, `site uyusmuyor (${raw.site} != ${siteId}); izolasyon geregi kullanilmadi`) };
  return { ok: true, payload: raw };
}

// ---- performance (#36: sgos.performance-history.v1, kayit sgos.performance.v1) ------------------------------------

const metricValue = (r: Record<string, unknown>, k: "lcp_ms" | "inp_ms" | "cls"): number | null => {
  const v = r[k];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Uretici ayni kurali koyar: lcp/inp 0 = "olcum yok" (null olmali); yalniz CLS=0 gecerli ve en iyi degerdir.
  return k === "cls" ? (v >= 0 ? v : null) : v > 0 ? v : null;
};

function perfRegressions(report: unknown, siteId: string, now: Date, max: number): { count: number; metrics: string[]; generated: string } | { skipped: string } | null {
  if (report === undefined || report === null) return null;
  if (!isObj(report) || report.schema !== SCHEMA_IDS.performanceReport) return { skipped: "performans raporu taninmadi (sema)" };
  const when = parseWhen(report.generated_at, now);
  if (!when) return { skipped: "performans raporunun generated_at'i gecersiz" };
  if (ageDays(when, now) > max) return { skipped: `performans raporu bayat (${ageDays(when, now)} gun)` };
  // Rapor tum siteleri tasir: yalniz bu sitenin satirina bakilir, digerleri hic dokunulmaz.
  const mine = Array.isArray(report.sites) ? report.sites.filter(isObj).filter((s) => s.site === siteId) : [];
  if (mine.length !== 1) return { skipped: `raporda ${siteId} icin ${mine.length} satir (1 beklenir)` };
  const regs = Array.isArray(mine[0].regressions) ? mine[0].regressions.filter(isObj).filter((x) => x.site === siteId && x.label === "INFERENCE") : [];
  return { count: regs.length, metrics: [...new Set(regs.map((x) => String(x.metric)))], generated: when.toISOString().slice(0, 10) };
}

export function performance(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.performance, report?: unknown): Dimension {
  const D = "performance" as const;
  const g = producerGate(D, raw, SCHEMA_IDS.performance, siteId); if (!g.ok) return g.dim;
  const all = g.payload.records;
  if (!Array.isArray(all)) return unknown(D, "records dizi degil");
  if (!all.length) return unknown(D, "performans gecmisi var ama kayit yok");
  if (all.some((r) => isObj(r) && typeof r.site === "string" && r.site !== siteId)) return unknown(D, "gecmiste baska siteye ait kayit var; izolasyon geregi dosya kullanilmadi");
  // Gecmis yalniz MEASURED + source field|lab tutar (uretici recordProblem); digerleri gecersiz sayilir, sifir sayilmaz.
  const valid = all.filter(isObj).filter((r) => r.schema === SCHEMA_IDS.performanceRecord && r.site === siteId && r.state === "MEASURED" && (r.source === "field" || r.source === "lab")
    && typeof r.date === "string" && DATE_ONLY.test(r.date) && typeof r.measured_at === "string" && r.measured_at.slice(0, 10) === r.date && parseWhen(r.measured_at, now) !== null);
  if (!valid.length) return unknown(D, `${all.length} kayit var ama hicbiri gecerli MEASURED uretici kaydi degil (schema/site/state/source/tarih)`);
  // Uretici GUNDE URL x strateji kadar kayit yazar: "son kayit" degil, son GUNUN tum kayitlari degerlendirilir.
  const latestDate = valid.map((r) => r.date as string).sort().at(-1)!;
  const day = valid.filter((r) => r.date === latestDate);
  const when = day.map((r) => parseWhen(r.measured_at, now)!).sort((a, b) => b.getTime() - a.getTime())[0];
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  // Field (CrUX, gercek kullanici) ile lab (tek sentetik kosu) KARISTIRILMAZ (uretici de karistirmaz): field varsa yalniz field.
  const useField = day.some((r) => r.source === "field");
  const sel = day.filter((r) => r.source === (useField ? "field" : "lab"));
  const ignored = day.length - sel.length;
  const required: Array<"lcp_ms" | "inp_ms" | "cls"> = useField ? ["lcp_ms", "inp_ms", "cls"] : ["lcp_ms", "cls"]; // lab'de INP yoktur (uretici semasi)
  const worst: Partial<Record<"lcp_ms" | "inp_ms" | "cls", number>> = {};
  for (const k of ["lcp_ms", "inp_ms", "cls"] as const) {
    const vs = sel.map((r) => metricValue(r, k)).filter((v): v is number => v !== null);
    if (vs.length) worst[k] = Math.max(...vs);
  }
  const src = useField ? "field (CrUX, gercek kullanici)" : "lab (tek sentetik kosu; saha verisi degil)";
  const checked = `bakilan: ${latestDate} ${src} ${sel.length} kayit (${new Set(sel.map((r) => `${String(r.url)}#${String(r.strategy)}`)).size} URL x strateji); en kotu degerler ${(["lcp_ms", "inp_ms", "cls"] as const).map((k) => `${k}=${worst[k] ?? "UNKNOWN"}`).join(", ")}; esikler LCP<=${CWV_GOOD.lcp_ms}ms CLS<=${CWV_GOOD.cls} INP<=${CWV_GOOD.inp_ms}ms${ignored ? `; ayni gunun ${ignored} ${useField ? "lab" : "field"} kaydi karistirilmadi` : ""}${all.length - valid.length ? `; ${all.length - valid.length} gecersiz kayit yok sayildi` : ""}`;
  const over = (["lcp_ms", "inp_ms", "cls"] as const).filter((k) => (worst[k] ?? -1) > CWV_GOOD[k]);
  const missing = required.filter((k) => worst[k] === undefined);
  let d: Dimension;
  // Olculen sayi FACT'tir ama esik siniflandirmasi bir INFERENCE'tir (uretici de ratings.label=INFERENCE yazar).
  if (over.length) d = dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${over.map((k) => `${k}=${worst[k]}`).join(", ")} esigi asti; ${checked}`, asOf);
  else if (missing.length) d = unknown(D, `${missing.join(", ")} eksik (null); mevcutlar esigin altinda ama tam degerlendirme yok; ${checked}`, asOf);
  else d = dim(D, "OK", "INFERENCE", "CANDIDATE", `${checked}${useField ? "" : ". INP lab'de olculmez; yalniz LCP/CLS degerlendirildi"}`, asOf);
  // Regresyon adayi (uretici raporu): yalniz YUKSELTIR (OK -> ATTENTION); hicbir zaman ATTENTION'i dusurmez.
  const reg = perfRegressions(report, siteId, now, max);
  if (reg && "skipped" in reg) return { ...d, basis: `${d.basis}; regresyon raporu kullanilmadi: ${reg.skipped}` };
  if (reg && reg.count > 0) {
    const note = `uretici raporu (${reg.generated}): ${reg.count} regresyon adayi (${reg.metrics.join(", ")}); neden iddiasi yok`;
    if (d.state === "OK") return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${note}; ${d.basis}`, asOf);
    return { ...d, basis: `${d.basis}; ${note}` };
  }
  return reg ? { ...d, basis: `${d.basis}; uretici raporunda ${siteId} icin regresyon adayi yok (${reg.generated})` } : d;
}

// ---- index (#34: sgos.index-history.v1 + CombinedReport) -----------------------------------------------------------

export function indexHealth(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.index_health, report?: unknown): Dimension {
  const D = "index_health" as const;
  const g = producerGate(D, raw, SCHEMA_IDS.index, siteId); if (!g.ok) return g.dim;
  const snaps = g.payload.snapshots;
  if (!Array.isArray(snaps)) return unknown(D, "snapshots dizi degil");
  if (!snaps.length) return unknown(D, "index gecmisi var ama snapshot yok");
  if (snaps.some((s) => isObj(s) && typeof s.site === "string" && s.site !== siteId)) return unknown(D, "gecmiste baska siteye ait snapshot var; izolasyon geregi dosya kullanilmadi");
  const valid = snaps.filter(isObj).filter((s) => s.site === siteId && parseWhen(s.taken_at, now) !== null && Array.isArray(s.entries) && Number.isInteger(s.sample_size) && (s.sample_size as number) >= 0);
  if (!valid.length) return unknown(D, `${snaps.length} snapshot var ama hicbiri gecerli degil (site/taken_at/entries/sample_size)`);
  valid.sort((a, b) => Date.parse(String(a.taken_at)) - Date.parse(String(b.taken_at)));
  const last = valid[valid.length - 1];
  const when = parseWhen(last.taken_at, now)!;
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  const entries = (last.entries as unknown[]).filter(isObj);
  // ERROR bir gozlem degildir: "indekslenmemis" demek de degildir (uretici ayni ayrimi yapar).
  const inspected = entries.filter((e) => e.state === "INSPECTED");
  if (last.sample_size === 0 || inspected.length === 0) return unknown(D, `son snapshot'ta denetlenen URL yok (sample_size=${String(last.sample_size)}, stopped=${String(last.stopped)}); "hepsi indexli" denemez`, asOf);
  if (last.sample_size !== inspected.length) return unknown(D, `sample_size=${String(last.sample_size)} ama INSPECTED entries=${inspected.length}; tutarsiz snapshot kullanilmadi`, asOf);
  const eligible = (e: Record<string, unknown>) => e.in_sitemap === true && e.fetch_ok === true && e.canonical_self === true && e.indexable === true;
  const notIndexed = inspected.filter((e) => e.verdict === "NOT_INDEXED");
  const neutralEligible = inspected.filter((e) => e.verdict === "NEUTRAL" && eligible(e));
  const unresolved = inspected.filter((e) => (e.verdict === "NEUTRAL" || e.verdict === "UNKNOWN") && !neutralEligible.includes(e));
  const scope = `ORNEKLEM ${inspected.length} URL (tam coverage degil; universe_size=${String(last.universe_size)}; snapshot ${asOf.slice(0, 10)}, toplam ${valid.length} snapshot)`;
  const errCount = entries.length - inspected.length;
  const tail = `${errCount ? `; ${errCount} ERROR URL gozlem sayilmadi` : ""}${valid.length < 2 ? "; tek snapshot: >24 saat alarm hesabi icin en az iki gozlem gerekir" : ""}`;
  // Alarm: uretici raporu (zaman farki hesabi onun isidir; scorecard yeniden hesaplamaz).
  let alarmN = 0, reportNote = "";
  if (report !== undefined && report !== null) {
    const ia = isObj(report) ? report.index_alarms : undefined;
    const rw = isObj(report) ? parseWhen(report.generated_at, now) : null;
    if (!isObj(report) || report.site !== siteId || !isObj(ia) || !rw) reportNote = "; alarm raporu kullanilmadi (site/sema/tarih uyusmuyor)";
    else if (ageDays(rw, now) > max || rw.getTime() < when.getTime()) reportNote = "; alarm raporu bayat/snapshot'tan eski, kullanilmadi";
    else if (ia.status === "ALARMS" && Array.isArray(ia.alarms)) { alarmN = ia.alarms.length; reportNote = `; uretici alarm raporu ${rw.toISOString().slice(0, 10)}: ${alarmN} alarm`; }
    else reportNote = `; uretici alarm raporu: status=${String(ia.status)}`;
  }
  const bad = notIndexed.length + neutralEligible.length;
  // Indekslenmemis URL Google'in cevabidir (FACT); "bu bir sorun" yorumu INFERENCE: bilincli noindex/canonical olabilir.
  if (bad > 0 || alarmN > 0) return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${scope}: ${notIndexed.length} NOT_INDEXED, ${neutralEligible.length} indekslenmesi beklenen URL NEUTRAL${alarmN ? `, ${alarmN} alarm` : ""}; nedeni dogrulanmadi (bilincli noindex/canonical olabilir)${reportNote}${tail}`, asOf);
  // NEUTRAL/UNKNOWN karari "indexli" degildir; "hepsi indexli" denmez (yanlis negatif korumasi).
  if (unresolved.length) return unknown(D, `${scope}: ${unresolved.length} URL karari NEUTRAL/UNKNOWN (indekslenmesi beklenen kosullar saglanmiyor ya da bilinmiyor); OK denmedi${reportNote}${tail}`, asOf);
  return dim(D, "OK", "INFERENCE", "CANDIDATE", `${scope}: denetlenen hepsi INDEXED. Ornek disindaki URL'ler hakkinda bilgi yok${reportNote}${tail}`, asOf);
}

// ---- deployment (#32: sgos.deployment-timeline.v1, olay sgos.deployment-event.v1) ----------------------------------

/** Uretici validateEvent ile ayni cekirdek kural; baska sitenin olayi ya da bozuk alan = sorun. */
function deployEventProblem(e: unknown, site: string, now: Date): string | null {
  if (!isObj(e)) return "olay nesne degil";
  if (e.schema !== SCHEMA_IDS.deployment) return "olay schema'si hatali";
  if (e.site !== site) return `olay baska siteye ait (${String(e.site)})`;
  if (e.environment !== "production" && e.environment !== "preview" && e.environment !== "unknown") return "environment gecersiz";
  if (typeof e.commit_sha !== "string" || !SHA40.test(e.commit_sha)) return "commit_sha 40 haneli kucuk hex degil";
  if (typeof e.deployed_at !== "string" || !ISO_Z.test(e.deployed_at) || !parseWhen(e.deployed_at, now)) return "deployed_at ISO UTC degil/gelecek";
  if (!["VERIFIED", "UNVERIFIED", "MISMATCH", "UNKNOWN"].includes(String(e.verification_state))) return "verification_state gecersiz";
  if (!isObj(e.provenance) || typeof e.provenance.retrieved_at !== "string" || !ISO_Z.test(e.provenance.retrieved_at) || !parseWhen(e.provenance.retrieved_at, now)) return "provenance.retrieved_at gecersiz";
  return null;
}

export function deploymentChange(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.deployment_change): Dimension {
  const D = "deployment_change" as const;
  const g = producerGate(D, raw, SCHEMA_IDS.deploymentTimeline, siteId); if (!g.ok) return g.dim;
  const events = g.payload.events;
  if (!Array.isArray(events)) return unknown(D, "zaman cizelgesi events dizisi icermiyor");
  // Uretici parseTimeline fail-closed: tek bozuk olay tum cizelgeyi reddeder. Yarim cizelge yanlis "deploy yok" uretirdi.
  for (const [i, e] of events.entries()) { const p = deployEventProblem(e, siteId, now); if (p) return unknown(D, `olay ${i}: ${p}; cizelge fail-closed reddedildi`); }
  if (!events.length) return unknown(D, "cizelge bos: tazelik bilinmiyor (bos cizelge 'deploy yok' kaniti degildir; kolektor kosmus olabilir ya da hic kosmamis)");
  const ev = events as Array<Record<string, any>>;
  // Cizelgenin kendi 'generated_at'i YOK; en yeni provenance.retrieved_at = saglayicinin/dogrulayicinin son sorgulandigi an.
  const fresh = ev.map((e) => parseWhen(e.provenance.retrieved_at, now)!).sort((a, b) => b.getTime() - a.getTime())[0];
  const age = ageDays(fresh, now);
  if (age > max) return stale(D, fresh, age, max);
  const asOf = fresh.toISOString();
  const prod = ev.filter((e) => e.environment === "production");
  const nonProd = ev.length - prod.length;
  const windowStart = now.getTime() - 14 * DAY_MS;
  const recent = prod.filter((e) => parseWhen(e.deployed_at, now)!.getTime() >= windowStart);
  const scope = `cizelge ${ev.length} olay (${prod.length} production, ${nonProd} preview/unknown: aramada gorunmez, sayilmadi); son sorgu ${asOf.slice(0, 10)}`;
  if (!recent.length) return dim(D, "OK", "INFERENCE", "CANDIDATE", `son 14 gunde ${siteId} icin production deploy olayi yok (${scope}); cizelgenin tum deploylari gordugu dogrulanmadi`, asOf);
  const mismatch = recent.filter((e) => e.verification_state === "MISMATCH");
  if (mismatch.length) return dim(D, "ATTENTION", "FACT", "CONFIRMED", `son 14 gunde ${recent.length} production deploy, ${mismatch.length} tanesi MISMATCH (canli SHA beklenenle uyusmuyor: ${mismatch.map((e) => String(e.commit_sha).slice(0, 7)).join(",")}); ${scope}`, asOf);
  const unver = recent.filter((e) => e.verification_state !== "VERIFIED");
  // UNVERIFIED = saglayici "deploy ettim" dedi, canli dogrulanmadi (uretici parser'lari hep UNVERIFIED uretir): bilmiyoruz.
  if (unver.length) return unknown(D, `son 14 gunde ${recent.length} production deploy, ${unver.length} tanesi canli dogrulanmadi (${[...new Set(unver.map((e) => String(e.verification_state)))].join(",")}); deploy gercekten canli mi bilinmiyor; ${scope}`, asOf);
  return dim(D, "OK", "FACT", "CONFIRMED", `son 14 gunde ${recent.length} dogrulanmis (VERIFIED) production deploy: metrik degisiklikleri bu pencerede degisiklikle karisabilir (nedensellik iddiasi yok); ${scope}`, asOf);
}


/** sgos.measure-report.v1 (#41) okuyucusu. Uretici sekli: `sites[siteId]` ANAHTARLI NESNE; her girdi kendi `site_id`'sini tasir.
 *  NEDEN `gsc_state` takma adi tek basina yetmez: `gsc.state` asil olcum durumudur (MEASURED/NOT_CONNECTED/UNKNOWN/ERROR), `gsc_state`
 *  onun CONNECTED/... takma adi. Ikisi celisirse (ya da `gsc` blogu hic yoksa) sema kaymis demektir: UNKNOWN, asla OK/0.
 *  Anlam: opportunity_count>0 bir ARIZA degil FIRSAT sinyalidir; boyutun mevcut sozlesmesi (ATTENTION = insan bakmali) korunur,
 *  etiket her zaman INFERENCE/CANDIDATE (aday kural-tabanli cikarimdir, FACT/CONFIRMED asla). Gercek olculmus 0 gecerli bir OK'tur
 *  (MEASURED + sayi 0 + aday listesi bos); UNKNOWN/null ise 0'a CEVRILMEZ. */
export function searchOpportunity(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.search_opportunity): Dimension {
  const D = "search_opportunity" as const;
  if (raw === undefined || raw === null) return unknown(D, `girdi yok (${SCHEMA_IDS.measure} olcum raporu verilmedi/bulunamadi)`);
  if (!isObj(raw) || raw.schema !== SCHEMA_IDS.measure) return unknown(D, `sema beklenen ${SCHEMA_IDS.measure}, gelen ${isObj(raw) ? String(raw.schema) : "nesne degil"}`);
  const sites = raw.sites;
  // Izolasyon: yalniz istenen sitenin girdisi okunur; diger siteler hic dokunulmaz. hasOwn: "constructor" gibi anahtarlar prototipten gelmesin.
  const entry = isObj(sites) && Object.hasOwn(sites, siteId) ? sites[siteId] : undefined;
  if (!isObj(entry)) return unknown(D, `raporda ${siteId} girdisi yok`);
  // Girdi kendi kimligini tasir; anahtar ile icerik ayni siteyi gostermiyorsa (ya da kimlik yoksa) izolasyon dogrulanamadi (kural 3 + 6).
  if (entry.site_id !== siteId) return unknown(D, `girdi site_id=${String(entry.site_id)} (beklenen ${siteId}); izolasyon dogrulanamadi`);
  const when = parseWhen(entry.generated_at ?? raw.generated_at, now);
  if (!when) return unknown(D, "rapor tarihi yok/gecersiz");
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  const gsc = entry.gsc;
  if (!isObj(gsc)) return unknown(D, "gsc blogu yok (sema kaymasi); durum dogrulanamadi", asOf);
  // Ureticinin iki alani celisemez: CONNECTED <=> gsc.state MEASURED; digerleri birebir.
  const alias = gsc.state === "MEASURED" ? "CONNECTED" : gsc.state;
  if (entry.gsc_state !== alias) return unknown(D, `gsc_state=${String(entry.gsc_state)} ile gsc.state=${String(gsc.state)} celisiyor; durum dogrulanamadi`, asOf);
  if (gsc.state === "NOT_CONNECTED") return dim(D, "NOT_CONNECTED", "FACT", "CONFIRMED", "GSC bu site icin bagli degil; firsat olculemez (0 degil)", asOf);
  if (gsc.state !== "MEASURED") return unknown(D, `gsc.state=${String(gsc.state)}${typeof gsc.state_reason === "string" ? ` (${gsc.state_reason})` : ""}; olculmedi, firsat sayisi uydurulmadi`, asOf);
  const c = entry.opportunity_count;
  if (!isNum(c) || !Number.isInteger(c)) return unknown(D, "opportunity_count yok/sayi degil; sayi uydurulmadi", asOf);
  const inp = entry.search_opportunity_inputs;
  if (!isObj(inp) || inp.state !== "MEASURED" || !Array.isArray(inp.candidates)) return unknown(D, "search_opportunity_inputs olculmus degil/aday listesi yok; sayi tek basina yeterli sayilmadi", asOf);
  // Tutarlilik: sayi 0 iken aday var ya da sayi>0 iken aday yok = uretici sekli bozuk; hangisine inanacagimizi bilmiyoruz.
  if ((c === 0) !== (inp.candidates.length === 0) || inp.candidates.length > c) return unknown(D, `opportunity_count=${c} ile aday sayisi (${inp.candidates.length}) tutarsiz; dogrulanamadi`, asOf);
  const cov = isObj(gsc.coverage) ? gsc.coverage : {};
  const trunc = cov.queries_truncated === true;
  const incomplete = gsc.rows_complete === false;
  const completenessUnknown = gsc.rows_complete !== true && !incomplete; // null/yok: sayfalama sonu dogrulanmadi
  const per = isObj(entry.period) && typeof entry.period.start === "string" && typeof entry.period.end === "string" ? ` donem ${entry.period.start}..${entry.period.end};` : "";
  const caveats = [
    incomplete ? "GSC satirlari TAMAMLANMADI (rows_complete=false): sayi alt sinirdir" : "",
    completenessUnknown ? "rows_complete dogrulanmadi" : "",
    trunc ? `sorgu tablosu kesildi (${String(cov.query_rows_returned)}/${String(cov.query_rows_total)} satir; sayi tablodan bagimsiz, adaylar tam liste degil)` : "",
  ].filter(Boolean);
  const cav = caveats.length ? ` UYARI: ${caveats.join("; ")}.` : "";
  // Eksik veriden "0 firsat" cikarilamaz: tamamlanmamis satirlarda sifir, sifir kanitlamaz (yanlis negatif, kural 6).
  if (c === 0 && (incomplete || completenessUnknown)) return unknown(D, `olculen 0 firsat ama GSC satir butunlugu dogrulanmadi;${per} 0 kanit sayilmadi.${cav}`, asOf);
  // Firsat bir oneri adayidir (RECOMMENDATION degil: onboarding'e ve insan kararina bagli), talep olculmus olsa da cikarimdir.
  if (c > 0) return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${c} firsat adayi (marka disi, sira 5-30, GSC olculmus);${per} inceleme gerekir, uygulama onerisi degil.${cav}`, asOf);
  return dim(D, "OK", "INFERENCE", "CANDIDATE", `GSC olculdu (MEASURED), rapor doneminde firsat adayi 0;${per} gercek sifir, UNKNOWN degil.${cav}`, asOf);
}

// ---------------------------------------------------------------------------
// Birlestirme
// ---------------------------------------------------------------------------

export interface ScorecardInputs {
  site_id: string;
  onboarding_status?: string;
  clarity?: unknown; performance?: unknown; index?: unknown; deployments?: unknown; measure?: unknown;
  /** Opsiyonel uretici raporlari (regresyon adaylari / alarmlar). Yoksa boyut yalniz gecmis dosyasindan hesaplanir. */
  performance_report?: unknown; index_report?: unknown;
}

export function buildScorecard(i: ScorecardInputs, now: Date = new Date(), maxAge: Partial<Record<DimensionId, number>> = {}): SiteScorecard {
  const a = { ...DEFAULT_MAX_AGE_DAYS, ...maxAge };
  const s = i.site_id;
  const dimensions = [
    measurementHealth(i.clarity, s, now, a.measurement_health),
    indexHealth(i.index, s, now, a.index_health, i.index_report),
    searchOpportunity(i.measure, s, now, a.search_opportunity),
    uxFriction(i.clarity, s, now, a.ux_friction),
    performance(i.performance, s, now, a.performance, i.performance_report),
    deploymentChange(i.deployments, s, now, a.deployment_change),
  ];
  const counts: Record<DimState, number> = { OK: 0, ATTENTION: 0, UNKNOWN: 0, "UNKNOWN-STALE": 0, NOT_CONNECTED: 0 };
  for (const d of dimensions) counts[d.state]++;
  return { schema: SCORECARD_SCHEMA, site_id: s, generated_at: now.toISOString(), onboarding_status: i.onboarding_status ?? "UNKNOWN", dimensions, counts };
}

/** Kural: cikarim onayli gibi raporlanamaz; OK/ATTENTION kanitsiz olamaz; UNKNOWN guvenle onaylanamaz. Testler cagirir. */
export function dimensionInvariantProblems(d: Dimension): string[] {
  const p: string[] = [];
  if (d.evidence_label === "INFERENCE" && d.confidence === "CONFIRMED") p.push(`${d.dimension}: INFERENCE CONFIRMED olamaz`);
  if ((d.state === "UNKNOWN" || d.state === "UNKNOWN-STALE") && d.confidence !== "UNKNOWN") p.push(`${d.dimension}: ${d.state} icin confidence UNKNOWN olmali`);
  if ((d.state === "OK" || d.state === "ATTENTION") && (d.confidence === "UNKNOWN" || d.confidence === "FALSE_POSITIVE")) p.push(`${d.dimension}: ${d.state} icin gecerli bir guven gerekir`);
  if ((d.state === "OK" || d.state === "ATTENTION") && !d.as_of) p.push(`${d.dimension}: ${d.state} as_of'suz olamaz`);
  if (!d.basis.trim()) p.push(`${d.dimension}: basis bos`);
  return p;
}

// ---------------------------------------------------------------------------
// Dosyadan yukleme (yalniz okuma; yok/bozuk dosya = undefined, istisna yok)
// ---------------------------------------------------------------------------

export interface ArtifactPaths { clarityDir?: string; performanceDir?: string; indexDir?: string; deploymentDir?: string; measureFile?: string; performanceReportFile?: string; indexReportDir?: string }

function readJson(path: string | undefined): unknown {
  if (!path || !existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Beklenen duzen: <dir>/<site_id>.json. Bozuk JSON "yok" gibi okunur ve boyut UNKNOWN olur; sifir/OK'e donmez. */
export function loadInputs(p: ArtifactPaths, siteId: string, onboardingStatus?: string): ScorecardInputs {
  const f = (dir?: string) => (dir ? join(dir, `${siteId}.json`) : undefined);
  return { site_id: siteId, onboarding_status: onboardingStatus, clarity: readJson(f(p.clarityDir)), performance: readJson(f(p.performanceDir)), index: readJson(f(p.indexDir)), deployments: readJson(f(p.deploymentDir)), measure: readJson(p.measureFile), performance_report: readJson(p.performanceReportFile), index_report: readJson(f(p.indexReportDir)) };
}

// ---------------------------------------------------------------------------
// Cikti
// ---------------------------------------------------------------------------

export interface PortfolioScorecard { schema: "sgos.scorecard-portfolio.v1"; generated_at: string; sites: SiteScorecard[] }

export function buildPortfolio(sites: ScorecardInputs[], now: Date = new Date()): PortfolioScorecard {
  return { schema: "sgos.scorecard-portfolio.v1", generated_at: now.toISOString(), sites: sites.map((s) => buildScorecard(s, now)) };
}

export function scorecardToMarkdown(p: PortfolioScorecard | SiteScorecard): string {
  const sites = "sites" in p ? p.sites : [p];
  const L = [`# Scorecard (${("generated_at" in p ? p.generated_at : "").slice(0, 10)})`, "",
    "Tek skor yok: her boyut kendi durumunu, kanit etiketini ve guvenini tasir. UNKNOWN / UNKNOWN-STALE = bilmiyoruz (iyi demek degil).", ""];
  for (const s of sites) {
    L.push(`## ${s.site_id} (${s.onboarding_status})`, "");
    if (s.onboarding_status === "registered_not_onboarded") L.push("> Kayitli ama onboard edilmemis: olcum gosterilebilir, tavsiye uretilmez.", "");
    L.push("| Boyut | Durum | Etiket | Guven | Dayanak | as_of |", "|---|---|---|---|---|---|");
    for (const d of s.dimensions) L.push(`| ${d.dimension} | ${d.state} | ${d.evidence_label} | ${d.confidence} | ${d.basis.replace(/\|/g, "/")} | ${d.as_of?.slice(0, 10) ?? "-"} |`);
    L.push("", `Sayim: ${(Object.entries(s.counts) as [string, number][]).map(([k, v]) => `${k}=${v}`).join(", ")}`, "");
  }
  return L.join("\n");
}
