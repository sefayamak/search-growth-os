// sgos.measure-report.v1 — `measure` komutunun makine-okunur çıktısı.
//
// NEDEN VAR: `measure` yalnız stdout'a metin basıyordu (workflow onu measure.txt ->
// reports/measure-latest.md olarak sarıyor). Skorkart gibi bir tüketici, düz metni
// regex'le okumak zorunda kalırdı; regex bir satır biçimi değişince sessizce yanlış
// sayı üretir. Bu dosya AYNI bellek-içi sonuçlardan (CLI'nin Markdown'ı basarken
// kullandığı satırlar) yapılandırılmış bir kayıt çıkarır. Markdown'a dokunmaz.
//
// DEĞİŞMEZ KURAL — UNKNOWN ASLA 0 OLMAZ: ölçülmeyen, bağlı olmayan ya da hata veren
// bir metrik `null` + açıklayıcı `state` olarak serileşir. 0 yalnızca "API cevap
// verdi ve gerçekten sıfır" demektir ve o zaman state MEASURED'dır.
//
// Bu dosya VERİ ÇEKMEZ; ağ, dosya ya da env okumaz (commit için çağıran verir).
import type { SearchAnalyticsRow } from "./adapters/index.ts";
import { classifyQuery, splitByBrand, topicOpportunities, type Period, type Totals } from "./measure.ts";

export const MEASURE_REPORT_SCHEMA = "sgos.measure-report.v1" as const;
export const DEFAULT_MAX_QUERY_ROWS = 500;

/** Rapor ölçüm durumu. CONNECTED'ın karşılığı burada MEASURED: "bağlı" ile "ölçtüm" ayrı şeylerdir. */
export type MeasureState = "MEASURED" | "NOT_CONNECTED" | "UNKNOWN" | "ERROR";
/** Yalnız altı etiket (policies/evidence-labels.md). */
export type EvidenceLabel = "FACT" | "INFERENCE" | "HYPOTHESIS" | "RECOMMENDATION" | "IMPLEMENTED_CHANGE" | "VERIFIED_RESULT";
export type Confidence = "CONFIRMED" | "CANDIDATE" | "FALSE_POSITIVE" | "UNKNOWN";

export interface ReportTotals { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }
export interface Delta { abs: number | null; pct: number | null }

export interface QueryRow {
  query: string | null; clicks: number; impressions: number; ctr: number; position: number;
  /** INFERENCE/CANDIDATE: registry marka desenlerine göre kural-tabanlı sınıf. Ham metrikler FACT. */
  brand_class: "brand" | "non_brand";
}

export interface Gsc {
  state: MeasureState;
  state_reason: string | null;
  confidence: Confidence;
  evidence_label: EvidenceLabel;
  retrieved_at: string | null;
  source: { system: "google_search_console"; property: string | null; api: "searchAnalytics.query"; search_type: "web"; data_state: "final" };
  totals: ReportTotals;
  /** "api_total_row": boyutsuz çağrının satırı. "api_empty_response": API 200 döndü, satır yok (doğrulanmış sıfır). null: ölçülmedi. */
  totals_source: "api_total_row" | "api_empty_response" | null;
  comparison: {
    state: MeasureState; state_reason: string | null;
    confidence: Confidence; evidence_label: EvidenceLabel;
    totals: ReportTotals;
    delta: { clicks: Delta; impressions: Delta; position_abs: number | null; evidence_label: EvidenceLabel; confidence: Confidence };
  };
  /** Sayfalama tükendi mi (adapter 25000'lik sayfaları sonuna kadar çeker). null: ölçülmedi. */
  rows_complete: boolean | null;
  coverage: {
    query_rows_total: number | null;
    query_rows_returned: number | null;
    max_query_rows: number;
    queries_truncated: boolean | null;
    /** Boyutsuz toplam − sorgu satırı toplamı: GSC'nin anonimleştirdiği düşük-hacimli kuyruk. Negatifse 0'a kırpılmaz, null bırakılır. */
    anonymized_tail_impressions: number | null;
  };
  brand_split: null | {
    state: MeasureState; evidence_label: EvidenceLabel; confidence: Confidence;
    patterns: string[];
    brand: BrandTotals; non_brand: BrandTotals;
    comparison: null | { brand: BrandTotals; non_brand: BrandTotals };
  };
  queries: QueryRow[];
  /** `measure` sayfa boyutunu ÇAĞIRMIYOR (yalnız `detail` çağırıyor); uydurulmaz. */
  pages: { state: "NOT_MEASURED"; rows: null; reason: string };
}
export interface BrandTotals { clicks: number; impressions: number; ctr: number; position: number | null; queries: number }

export interface Ga4 {
  state: MeasureState;
  state_reason: string | null;
  confidence: Confidence;
  evidence_label: EvidenceLabel;
  retrieved_at: string | null;
  source: { system: "google_analytics_4"; property: string | null };
  metrics: { sessions: number | null; engaged_sessions: number | null; conversions: number | null; revenue: number | null };
}

export interface OpportunityCandidate { query: string; impressions: number; clicks: number; position: number; score: number }
export interface SearchOpportunityInputs {
  state: MeasureState;
  state_reason: string | null;
  /** Adaylar kural-tabanlı çıkarımdır: asla FACT/CONFIRMED değil. */
  evidence_label: EvidenceLabel;
  confidence: Confidence;
  opportunity_count: number | null;
  criteria: { excludes_brand: true; min_impressions: number; min_position: number; max_position: number; score: "impressions / position"; top: number };
  candidates: OpportunityCandidate[];
  /** Sorgu×sayfa kırılımı mevcut ölçümde YOK. */
  query_page_rows: { state: "NOT_MEASURED"; rows: null; reason: string };
}

export interface SiteReport {
  site_id: string;
  generated_at: string;
  /** Skorkartın okuduğu alan adları (src/scorecard.ts searchOpportunity): CONNECTED | NOT_CONNECTED | ERROR | UNKNOWN. */
  gsc_state: "CONNECTED" | "NOT_CONNECTED" | "ERROR" | "UNKNOWN";
  opportunity_count: number | null;
  period: { label: string; start: string; end: string };
  comparison_period: { label: string; kind: "year_over_year"; start: string; end: string };
  gsc: Gsc;
  ga4: Ga4;
  search_opportunity_inputs: SearchOpportunityInputs;
}

export interface MeasureReport {
  schema: typeof MEASURE_REPORT_SCHEMA;
  generated_at: string;
  provenance: { tool: "search-growth-os"; command: "measure"; tool_version: string; commit: string | null; registry_path: string | null; notes: string[] };
  semantics: { unknown_is_never_zero: true; states: Record<MeasureState, string> };
  /** Site kimliğiyle anahtarlı; her giriş kendi içinde tamdır, başka siteye referans vermez. */
  sites: Record<string, SiteReport>;
}

export type SiteOutcome =
  | { kind: "ok"; current: SearchAnalyticsRow[]; yearAgo: SearchAnalyticsRow[] | null; currentTotal: SearchAnalyticsRow[]; yearAgoTotal: SearchAnalyticsRow[] | null }
  | { kind: "not_connected"; reason: string }
  | { kind: "error"; message: string };

export interface SiteMeasureInput {
  siteId: string;
  gscProperty: string;
  ga4Property: string;
  patterns: string[];
  outcome: SiteOutcome;
  /** adapters.ga4.status() — `measure` GA4'ü çağırmaz; durum yalnızca kimlik varlığını söyler. */
  ga4Status: { state: "CONNECTED" | "NOT_CONNECTED" | "UNKNOWN" | "ERROR"; note: string };
}

export interface BuildOptions {
  now: Date;
  current: Period;
  yearAgo: Period;
  toolVersion: string;
  commit?: string | null;
  registryPath?: string | null;
  maxQueryRows?: number;
}

const SENTINELS = new Set(["", "NOT_CONNECTED", "UNKNOWN", "undefined", "null"]);
const OPP = { min_impressions: 20, min_position: 5, max_position: 30, top: 15 };
const NO_TOTALS: ReportTotals = { clicks: null, impressions: null, ctr: null, position: null };
const NA_DELTA: Delta = { abs: null, pct: null };

/** Boyutsuz GSC satırı -> toplam. Satır yoksa API 200 dönmüştür ve sonuç gerçek sıfırdır; pozisyon ise tanımsızdır (null). */
function totalsFrom(rows: SearchAnalyticsRow[]): { totals: ReportTotals; source: "api_total_row" | "api_empty_response" } {
  const r = rows[0];
  if (!r) return { totals: { clicks: 0, impressions: 0, ctr: 0, position: null }, source: "api_empty_response" };
  return { totals: { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.impressions === 0 ? null : r.position }, source: "api_total_row" };
}

const brandTotals = (t: Totals): BrandTotals => ({ clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.impressions === 0 ? null : t.position, queries: t.queries });

// Yüzde değişim yalnız önceki dönem sıfır DEĞİLSE tanımlıdır (markdown'daki "(yeni)" / "(=)" ile aynı kural).
const delta = (cur: number | null, prev: number | null): Delta =>
  cur === null || prev === null ? NA_DELTA : { abs: cur - prev, pct: prev === 0 ? null : ((cur - prev) / prev) * 100 };

function unmeasuredGsc(state: Exclude<MeasureState, "MEASURED">, reason: string, property: string | null, max: number): Gsc {
  return {
    state, state_reason: reason, confidence: "UNKNOWN", evidence_label: "FACT", retrieved_at: null,
    source: { system: "google_search_console", property, api: "searchAnalytics.query", search_type: "web", data_state: "final" },
    totals: { ...NO_TOTALS }, totals_source: null,
    comparison: { state, state_reason: reason, confidence: "UNKNOWN", evidence_label: "INFERENCE", totals: { ...NO_TOTALS },
      delta: { clicks: NA_DELTA, impressions: NA_DELTA, position_abs: null, evidence_label: "INFERENCE", confidence: "UNKNOWN" } },
    rows_complete: null,
    coverage: { query_rows_total: null, query_rows_returned: null, max_query_rows: max, queries_truncated: null, anonymized_tail_impressions: null },
    brand_split: null, queries: [],
    pages: { state: "NOT_MEASURED", rows: null, reason: "measure komutu sayfa boyutunu çağırmıyor (yalnız detail)" },
  };
}

export function buildSiteReport(input: SiteMeasureInput, o: BuildOptions): SiteReport {
  const max = o.maxQueryRows ?? DEFAULT_MAX_QUERY_ROWS;
  const generated_at = o.now.toISOString();
  const prop = SENTINELS.has(input.gscProperty) ? null : input.gscProperty;
  const ga4Prop = SENTINELS.has(input.ga4Property) ? null : input.ga4Property;
  const oc = input.outcome;

  let gsc: Gsc;
  let opp: SearchOpportunityInputs;

  if (oc.kind === "not_connected" || oc.kind === "error") {
    const state = oc.kind === "error" ? "ERROR" : "NOT_CONNECTED";
    const reason = oc.kind === "error" ? oc.message : oc.reason;
    gsc = unmeasuredGsc(state, reason, prop, max);
    opp = {
      state, state_reason: reason, evidence_label: "INFERENCE", confidence: "UNKNOWN", opportunity_count: null,
      criteria: { excludes_brand: true, ...OPP, score: "impressions / position" }, candidates: [],
      query_page_rows: { state: "NOT_MEASURED", rows: null, reason: "sorgu×sayfa kırılımı mevcut ölçümde yok" },
    };
  } else {
    const cur = totalsFrom(oc.currentTotal);
    const prev = oc.yearAgoTotal ? totalsFrom(oc.yearAgoTotal) : null;
    const split = splitByBrand(oc.current, input.patterns);
    const prevSplit = oc.yearAgo ? splitByBrand(oc.yearAgo, input.patterns) : null;
    const sorted = [...oc.current].sort((a, b) => b.impressions - a.impressions || String(a.query).localeCompare(String(b.query)));
    const shown = sorted.slice(0, max);
    const queries: QueryRow[] = shown.map((r) => ({
      query: r.query ?? null, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
      brand_class: r.query && classifyQuery(r.query, input.patterns) === "brand" ? "brand" : "non_brand",
    }));
    const tail = cur.totals.impressions! - split.all.impressions;
    const compState: MeasureState = prev ? "MEASURED" : "UNKNOWN";
    gsc = {
      state: "MEASURED", state_reason: null, confidence: "CONFIRMED", evidence_label: "FACT", retrieved_at: o.now.toISOString(),
      source: { system: "google_search_console", property: prop, api: "searchAnalytics.query", search_type: "web", data_state: "final" },
      totals: cur.totals, totals_source: cur.source,
      comparison: {
        state: compState, state_reason: prev ? null : "karşılaştırma dönemi için GSC yanıtı alınamadı",
        confidence: prev ? "CONFIRMED" : "UNKNOWN", evidence_label: "FACT",
        totals: prev ? prev.totals : { ...NO_TOTALS },
        // Delta bir yorumdur: iki ölçümün farkı. FACT'e terfi etmez.
        delta: prev
          ? { clicks: delta(cur.totals.clicks, prev.totals.clicks), impressions: delta(cur.totals.impressions, prev.totals.impressions),
              position_abs: cur.totals.position !== null && prev.totals.position !== null ? cur.totals.position - prev.totals.position : null,
              evidence_label: "INFERENCE", confidence: "CANDIDATE" }
          : { clicks: NA_DELTA, impressions: NA_DELTA, position_abs: null, evidence_label: "INFERENCE", confidence: "UNKNOWN" },
      },
      rows_complete: true,
      coverage: {
        query_rows_total: sorted.length, query_rows_returned: queries.length, max_query_rows: max,
        queries_truncated: sorted.length > queries.length,
        anonymized_tail_impressions: tail >= 0 ? tail : null,
      },
      brand_split: {
        state: "MEASURED", evidence_label: "INFERENCE", confidence: "CANDIDATE", patterns: input.patterns,
        brand: brandTotals(split.brand), non_brand: brandTotals(split.nonBrand),
        comparison: prevSplit ? { brand: brandTotals(prevSplit.brand), non_brand: brandTotals(prevSplit.nonBrand) } : null,
      },
      queries,
      pages: { state: "NOT_MEASURED", rows: null, reason: "measure komutu sayfa boyutunu çağırmıyor (yalnız detail)" },
    };
    const all = topicOpportunities(oc.current, input.patterns, { top: Number.MAX_SAFE_INTEGER });
    opp = {
      state: "MEASURED", state_reason: null, evidence_label: "INFERENCE", confidence: "CANDIDATE",
      opportunity_count: all.length,
      criteria: { excludes_brand: true, ...OPP, score: "impressions / position" },
      candidates: all.slice(0, OPP.top),
      query_page_rows: { state: "NOT_MEASURED", rows: null, reason: "sorgu×sayfa kırılımı mevcut ölçümde yok" },
    };
  }

  // GA4: `measure` hiç çağırmaz. Kimlik yoksa NOT_CONNECTED; varsa "çağrılmadı" => UNKNOWN. Metrik 0 DEĞİL, null.
  const ga4State: MeasureState = ga4Prop === null || input.ga4Status.state === "NOT_CONNECTED" ? "NOT_CONNECTED" : "UNKNOWN";
  const ga4: Ga4 = {
    state: ga4State,
    state_reason: ga4Prop === null ? "registry'de ga4_property yok" : input.ga4Status.state === "NOT_CONNECTED" ? input.ga4Status.note : "kimlik var ama `measure` GA4'ü çağırmıyor (yalnız smoke testi çağırır); metrik ölçülmedi",
    confidence: "UNKNOWN", evidence_label: "FACT", retrieved_at: null,
    source: { system: "google_analytics_4", property: ga4Prop },
    metrics: { sessions: null, engaged_sessions: null, conversions: null, revenue: null },
  };

  return {
    site_id: input.siteId, generated_at,
    gsc_state: gsc.state === "MEASURED" ? "CONNECTED" : gsc.state,
    opportunity_count: opp.opportunity_count,
    period: { label: o.current.label, start: o.current.start, end: o.current.end },
    comparison_period: { label: o.yearAgo.label, kind: "year_over_year", start: o.yearAgo.start, end: o.yearAgo.end },
    gsc, ga4, search_opportunity_inputs: opp,
  };
}

export function buildMeasureReport(inputs: SiteMeasureInput[], o: BuildOptions): MeasureReport {
  const sites: Record<string, SiteReport> = {};
  for (const i of inputs) sites[i.siteId] = buildSiteReport(i, o);
  return {
    schema: MEASURE_REPORT_SCHEMA,
    generated_at: o.now.toISOString(),
    provenance: {
      tool: "search-growth-os", command: "measure", tool_version: o.toolVersion, commit: o.commit ?? null, registry_path: o.registryPath ?? null,
      notes: [
        "GSC: searchAnalytics.query (web, dataState final), sorgu boyutu + boyutsuz site toplamı; dönem karşılaştırması yıl-yıl.",
        "GA4: measure komutu çağırmaz; metrikler null ve state UNKNOWN/NOT_CONNECTED.",
        "Marka/marka-dışı: registry brand_entities/people_entities/domain desenleriyle kural-tabanlı sınıflama (INFERENCE/CANDIDATE).",
      ],
    },
    semantics: {
      unknown_is_never_zero: true,
      states: {
        MEASURED: "Canlı çağrı yanıt verdi; değerler ham ölçümdür (0 gerçek sıfırdır).",
        NOT_CONNECTED: "Kimlik ya da registry property'si yok; değerler null.",
        UNKNOWN: "Ölçüm denenmedi/yapılamadı; değerler null.",
        ERROR: "Çağrı hata verdi; değerler null, sebep state_reason'da.",
      },
    },
    sites,
  };
}
