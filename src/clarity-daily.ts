/**
 * Clarity gunluk toplama + kalici gecmis + minimum alert (legacy site-health-monitor cikis PR'i).
 *
 * Kapsam KASITLI olarak dar: legacy rutinin Clarity tarafinda gercekten urettigi uc sey —
 * (1) gunluk toplama, (2) gun-uzeri-gun gecmis, (3) iki sinyalli alert (friction artisi, bot orani) —
 * ve yalniz bunlar. Model/LLM yok, bildirim yok, Brain'e/Index'e dokunulmaz.
 *
 * Legacy'nin ayni sinyallerdeki HATALARI tasinmaz (audit, 2026-10-02):
 *   - hata/erisilemeyen gun history'ye SIFIR olarak yaziliyordu -> burada UNKNOWN ve baz OLAMAZ;
 *   - ayni gun iki koşu iki satir yaziyordu -> burada (site, UTC gun) basina TEK kayit, deterministik birlesim;
 *   - her gun ayri dala push ediliyordu, gecmis zincirlenmiyordu -> burada tek dosya, main'e commit (workflow).
 *
 * Esik anlamlari legacy `daily_health_check.py`'den KODDAN dogrulanip tasindi:
 *   friction: RageClick/ScriptError/ErrorClick/DeadClick icin `bugun > 0 ve bugun > onceki` (kesin artis);
 *   bot: `bot_pct > 50 ve (gercek+bot oturum) >= 5`. Toplam = gercek + bot (legacy ile ayni tanim).
 *
 * IKI AYRI KAVRAM (owner karari, 2026-10-02; karistirilmaz):
 *   measurement_success = MEASURED + CONFIRMED + rows_complete. Gozlenebilirlik kapsami: takeover/migrasyon basarisi BUNA bakar.
 *     Dogrulanmis TAM SIFIR yanit basarili bir olcumdur (is_zero bunu degistirmez); basarisizlik de UNKNOWN da degildir.
 *   usable = measurement_success && !is_zero. YALNIZ analiz uygunlugu: baz, trend, friction alert. Takeover olcutu DEGILDIR.
 * Bilincli fark: onceki guvenilir olcum YOKSA friction icin "ilk kez gorulen deger" alert'i uretilmez
 *   (NO_BASELINE); bot kontrolu mutlak oldugu icin baz gerektirmez.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  measureSites, resultsToMarkdown, assertResultSite,
  type ClaritySiteResult, type MeasureOptions,
} from "./adapters/clarity.ts";

export const HISTORY_SCHEMA = "sgos.clarity-history.v1" as const;
export const ALERTS_SCHEMA = "sgos.clarity.alerts.v1" as const;
/** Site basina en fazla bu kadar gunluk kayit tutulur (sinirli buyume; en eski gun duser). */
export const HISTORY_MAX_RECORDS = 120;
export const BOT_PCT_THRESHOLD = 50;
export const BOT_MIN_SESSIONS = 5;

export const FRICTION_KEYS = [
  "dead_click_count", "rage_click_count", "script_error_count", "error_click_count", "excessive_scroll", "quickback_click",
] as const;
export type FrictionKey = (typeof FRICTION_KEYS)[number];
/** Legacy yalniz bu dort metrik icin alert uretiyordu (ExcessiveScroll/QuickbackClick yalniz toplama girer). */
export const ALERT_FRICTION_KEYS: readonly FrictionKey[] = ["rage_click_count", "script_error_count", "error_click_count", "dead_click_count"];

export type Num = number | "UNKNOWN";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const SITE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyRecord {
  site_id: string;
  /** UTC takvim gunu (measured_at'tan). */
  date: string;
  measured_at: string;
  measurement_state: ClaritySiteResult["measurement_state"];
  confidence: ClaritySiteResult["confidence"];
  row_count: Num;
  metric_row_count_total: Num;
  max_metric_row_count: Num;
  rows_complete: boolean | "UNKNOWN";
  is_zero: boolean;
  /** Takeover olcutu: MEASURED + CONFIRMED + rows_complete. is_zero bunu DEGISTIRMEZ. Eski kayitlarda yoktur: measurementSuccessOf() turetir. */
  measurement_success?: boolean;
  /** YALNIZ analiz uygunlugu (baz / trend / friction alert): measurement_success && !is_zero. Takeover olcutu DEGILDIR. */
  usable: boolean;
  friction: Record<FrictionKey, Num>;
  friction_total: Num;
  sessions: { real: Num; bot: Num; total: Num; bot_pct: Num };
  error_code?: string;
  source_run_id?: string;
}

// ---------------------------------------------------------------------------
// Toplama (yalniz olculmus, eksiksiz yanittan; yoksa UNKNOWN — uydurma yok)
// ---------------------------------------------------------------------------

/**
 * Friction, legacy gibi `content` isteginden (URL boyutu) toplanir. Canli yanitlarda 9 metrik HER ZAMAN
 * doner (sifir satirlariyla). Bir metrigin hic donmemesi "sifir" demek DEGILDIR -> UNKNOWN.
 */
export function computeFriction(r: ClaritySiteResult): { friction: Record<FrictionKey, Num>; total: Num } {
  const content = r.requests.find((q) => q.id === "content");
  const usable = content?.state === "MEASURED" && content.rows_complete === true;
  const friction = {} as Record<FrictionKey, Num>;
  for (const k of FRICTION_KEYS) {
    friction[k] = "UNKNOWN";
    if (!usable) continue;
    const ms = r.metrics.filter((m) => m.request_id === "content" && m.metric_key === k);
    if (ms.length !== 1) continue;               // yok ya da belirsiz (birden fazla)
    const m = ms[0];
    if (m.rows.length !== m.row_count) continue; // bozuk satir atilmis: toplam eksik olurdu
    let sum = 0; let ok = true;
    for (const row of m.rows) { const v = (row as Record<string, unknown>).subTotal; if (!isNum(v)) { ok = false; break; } sum += v; }
    if (ok) friction[k] = sum;
  }
  const vals = FRICTION_KEYS.map((k) => friction[k]);
  return { friction, total: vals.every(isNum) ? (vals as number[]).reduce((a, b) => a + b, 0) : "UNKNOWN" };
}

/** Oturumlar `device` isteginin Traffic metriginden. Toplam = gercek + bot (legacy ile ayni). */
export function computeSessions(r: ClaritySiteResult): DailyRecord["sessions"] {
  const unk = { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" } as const;
  const dev = r.requests.find((q) => q.id === "device");
  if (!(dev?.state === "MEASURED" && dev.rows_complete === true)) return { ...unk };
  const ms = r.metrics.filter((m) => m.request_id === "device" && m.metric_key === "traffic");
  if (ms.length !== 1 || ms[0].rows.length !== ms[0].row_count) return { ...unk };
  let real = 0; let bot = 0;
  for (const row of ms[0].rows as Record<string, unknown>[]) {
    if (!isNum(row.totalSessionCount) || !isNum(row.totalBotSessionCount)) return { ...unk };
    real += row.totalSessionCount; bot += row.totalBotSessionCount;
  }
  const total = real + bot;
  return { real, bot, total, bot_pct: total > 0 ? Math.round((1000 * bot) / total) / 10 : "UNKNOWN" };
}

/** Tek kaynak: acik alan varsa o, yoksa (2026-10-02 oncesi kayitlar) ayni kuraldan turetilir. parseHistory ikisinin tutarliligini zorlar. */
export function measurementSuccessOf(r: Pick<DailyRecord, "measurement_state" | "confidence" | "rows_complete"> & { measurement_success?: boolean }): boolean {
  if (typeof r.measurement_success === "boolean") return r.measurement_success;
  return r.measurement_state === "MEASURED" && r.confidence === "CONFIRMED" && r.rows_complete === true;
}

export function toRecord(r: ClaritySiteResult, sourceRunId?: string): DailyRecord {
  const { friction, total } = computeFriction(r);
  const success = r.measurement_state === "MEASURED" && r.confidence === "CONFIRMED" && r.rows_complete === true;
  const rec: DailyRecord = {
    site_id: r.site_id,
    date: r.measured_at.slice(0, 10),
    measured_at: r.measured_at,
    measurement_state: r.measurement_state,
    confidence: r.confidence,
    row_count: r.row_count,
    metric_row_count_total: r.metric_row_count_total,
    max_metric_row_count: r.max_metric_row_count,
    rows_complete: r.rows_complete,
    is_zero: r.is_zero,
    measurement_success: success,
    usable: success && !r.is_zero,
    friction, friction_total: total,
    sessions: computeSessions(r),
  };
  if (r.error_code) rec.error_code = r.error_code;
  if (sourceRunId && /^\d+$/.test(sourceRunId)) rec.source_run_id = sourceRunId;
  return rec;
}

// ---------------------------------------------------------------------------
// Gecmis: site basina tek dosya, (site, UTC gun) basina tek kayit
// ---------------------------------------------------------------------------

export interface HistoryFile { schema: typeof HISTORY_SCHEMA; site_id: string; max_records: number; records: DailyRecord[] }

const STATES = new Set(["MEASURED", "PARTIAL", "ERROR", "NOT_CONNECTED"]);
function recordProblem(r: unknown, siteId: string): string | null {
  if (!r || typeof r !== "object") return "kayit nesne degil";
  const x = r as Partial<DailyRecord>;
  if (x.site_id !== siteId) return `site_id uyusmuyor (${String(x.site_id)} != ${siteId})`;
  if (typeof x.date !== "string" || !DATE.test(x.date)) return "date gecersiz";
  if (typeof x.measured_at !== "string" || x.measured_at.slice(0, 10) !== x.date) return "measured_at date ile uyusmuyor";
  if (typeof x.measurement_state !== "string" || !STATES.has(x.measurement_state)) return "measurement_state gecersiz";
  if (typeof x.usable !== "boolean") return "usable gecersiz";
  if (!x.friction || typeof x.friction !== "object") return "friction yok";
  for (const k of FRICTION_KEYS) { const v = (x.friction as Record<string, unknown>)[k]; if (v !== "UNKNOWN" && !isNum(v)) return `friction.${k} gecersiz`; }
  const s = x.sessions as DailyRecord["sessions"] | undefined;
  if (!s) return "sessions yok";
  for (const k of ["real", "bot", "total", "bot_pct"] as const) if (s[k] !== "UNKNOWN" && !isNum(s[k])) return `sessions.${k} gecersiz`;
  // source_run_id istege bagli (eski kayitlarda yok); varsa Actions run id'si gibi yalniz rakam olmali. Takeover tazelik kaniti buna dayanir.
  if (x.source_run_id !== undefined && (typeof x.source_run_id !== "string" || !/^\d{1,20}$/.test(x.source_run_id))) return "source_run_id gecersiz";
  // measurement_success acik yazildiysa kuraldan turetilenle BIREBIR ayni olmali (usable ile karistirilmasin diye).
  if (x.measurement_success !== undefined) {
    if (typeof x.measurement_success !== "boolean") return "measurement_success gecersiz";
    const derived = x.measurement_state === "MEASURED" && x.confidence === "CONFIRMED" && x.rows_complete === true;
    if (x.measurement_success !== derived) return "measurement_success kuraldan turetilenle uyusmuyor";
  }
  // usable bayragi olcum durumuyla tutarli olmali; tek tek UNKNOWN metrikler alert'te metrik bazinda elenir.
  if (x.usable && (x.measurement_state !== "MEASURED" || x.confidence !== "CONFIRMED" || x.rows_complete !== true || x.is_zero)) return "usable=true ama olcum eksiksiz degil";
  return null;
}

export class HistoryError extends Error {
  code: "HISTORY_CORRUPT";
  constructor(code: "HISTORY_CORRUPT", msg: string) { super(msg); this.code = code; }
}

/** Bozuk dosya sessizce duzeltilmez ve ustune YAZILMAZ: HistoryError. */
export function parseHistory(text: string, siteId: string): HistoryFile {
  let d: unknown;
  try { d = JSON.parse(text); } catch { throw new HistoryError("HISTORY_CORRUPT", `${siteId}: gecmis dosyasi JSON degil`); }
  const h = d as Partial<HistoryFile>;
  if (!h || h.schema !== HISTORY_SCHEMA || h.site_id !== siteId || !Array.isArray(h.records)) throw new HistoryError("HISTORY_CORRUPT", `${siteId}: gecmis semasi/site_id gecersiz`);
  const seen = new Set<string>(); let last = "";
  for (const r of h.records) {
    const p = recordProblem(r, siteId);
    if (p) throw new HistoryError("HISTORY_CORRUPT", `${siteId}: ${p}`);
    if (seen.has(r.date)) throw new HistoryError("HISTORY_CORRUPT", `${siteId}: ayni gun iki kayit (${r.date})`);
    if (r.date < last) throw new HistoryError("HISTORY_CORRUPT", `${siteId}: kayitlar tarih sirasinda degil`);
    seen.add(r.date); last = r.date;
  }
  return h as HistoryFile;
}

export function historyPath(dir: string, siteId: string): string {
  if (!SITE_ID.test(siteId)) throw new Error(`gecersiz site kimligi: ${siteId}`);
  return join(dir, `${siteId}.json`);
}

export function loadHistory(dir: string, siteId: string): HistoryFile {
  const p = historyPath(dir, siteId);
  if (!existsSync(p)) return { schema: HISTORY_SCHEMA, site_id: siteId, max_records: HISTORY_MAX_RECORDS, records: [] };
  return parseHistory(readFileSync(p, "utf8"), siteId);
}

export function saveHistory(dir: string, h: HistoryFile): void {
  mkdirSync(dir, { recursive: true });
  const p = historyPath(dir, h.site_id);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n");
  renameSync(tmp, p);
}

export type MergeAction = "ADDED" | "REPLACED" | "KEPT_EXISTING";

/**
 * Ayni (site, UTC gun) icin deterministik kural:
 *   - gun yoksa ekle;
 *   - mevcut kayit BASARILI bir olcumse (measurement_success; dogrulanmis sifir dahil) DOKUNMA
 *     (ilk basarili olcum kazanir; ayni gunun ikinci kosusu gecmisi oynatamaz);
 *   - mevcut kayit basarisizsa (NOT_CONNECTED / ERROR / PARTIAL / kesik) yeni kayit yerini alir.
 * Basarisiz ya da analiz-disi kayit basarili kaydi ASLA ezmez. Dogrulanmis sifir gunu olgusal bir olcumdur ve korunur.
 */
export function mergeRecord(h: HistoryFile, rec: DailyRecord): { file: HistoryFile; action: MergeAction } {
  if (rec.site_id !== h.site_id) throw new Error(`izolasyon ihlali: ${h.site_id} gecmisine ${rec.site_id} kaydi yazilamaz`);
  const i = h.records.findIndex((r) => r.date === rec.date);
  let records: DailyRecord[]; let action: MergeAction;
  if (i < 0) { records = [...h.records, rec]; action = "ADDED"; }
  else if (measurementSuccessOf(h.records[i])) { return { file: h, action: "KEPT_EXISTING" }; }
  else { records = h.records.map((r, j) => (j === i ? rec : r)); action = "REPLACED"; }
  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { file: { ...h, max_records: HISTORY_MAX_RECORDS, records: records.slice(-HISTORY_MAX_RECORDS) }, action };
}

/** Ayni-gun guard'i: tamamlanmis dogrulanmis olcum (sifir dahil) varsa o gun icin tekrar API cagrisi YAPILMAZ. */
export const hasMeasurementSuccessForDate = (h: HistoryFile, date: string): boolean => h.records.some((r) => r.date === date && measurementSuccessOf(r));
/** Analiz uygunlugu (baz/alert) icin; guard icin KULLANILMAZ. */
export const hasUsableForDate = (h: HistoryFile, date: string): boolean => h.records.some((r) => r.date === date && r.usable);

/** Baz: guncelden ESKI gunlerin en yenisi, kullanilabilir olan. Ayni gunun kaydi baz olamaz. */
export function selectBaseline(h: { records: DailyRecord[] }, currentDate: string): DailyRecord | null {
  let best: DailyRecord | null = null;
  for (const r of h.records) if (r.usable && r.date < currentDate && (!best || r.date > best.date)) best = r;
  return best;
}

// ---------------------------------------------------------------------------
// Alert (deterministik; LLM yok)
// ---------------------------------------------------------------------------

export interface Alert {
  site_id: string;
  date: string;
  kind: "FRICTION_INCREASE" | "BOT_RATIO_HIGH";
  metric?: FrictionKey;
  previous?: number;
  current: number;
  baseline_date?: string;
  /** Yalniz BOT_RATIO_HIGH. */
  total_sessions?: number;
  /** Olculen iki sayinin karsilastirmasi (FACT). Kok neden iddia etmez; insan incelemesi gerekir. */
  evidence_label: "FACT";
  confidence: "CONFIRMED";
  review: "REVIEW_REQUIRED";
  note: string;
}

export interface Evaluation {
  site_id: string;
  status: "EVALUATED" | "NOT_EVALUATED";
  /** NOT_EVALUATED sebepleri ya da eksik baz notu. */
  reasons: string[];
  baseline_date: string | null;
}

export function evaluateAlerts(current: DailyRecord, history: { records: DailyRecord[] }): { evaluation: Evaluation; alerts: Alert[] } {
  const ev: Evaluation = { site_id: current.site_id, status: "NOT_EVALUATED", reasons: [], baseline_date: null };
  if (!current.usable) {
    if (measurementSuccessOf(current) && current.is_zero) ev.reasons.push("CONFIRMED_ZERO: olcum basarili, analiz uygun degil (baz/friction/bot alert yok)");
    ev.reasons.push(`CURRENT_NOT_USABLE:${current.measurement_state}${current.error_code ? `/${current.error_code}` : ""}${current.is_zero ? "/is_zero" : ""}${current.rows_complete !== true ? `/rows_complete=${String(current.rows_complete)}` : ""}`);
    return { evaluation: ev, alerts: [] };
  }
  ev.status = "EVALUATED";
  const alerts: Alert[] = [];
  const base = selectBaseline(history, current.date);
  if (!base) ev.reasons.push("NO_BASELINE: onceki guvenilir olcum yok, friction karsilastirilmadi");
  else {
    ev.baseline_date = base.date;
    for (const k of ALERT_FRICTION_KEYS) {
      const cur = current.friction[k]; const prev = base.friction[k];
      if (!isNum(cur) || !isNum(prev)) { ev.reasons.push(`FRICTION_UNKNOWN:${k}`); continue; }
      if (cur > 0 && cur > prev) alerts.push({ site_id: current.site_id, date: current.date, kind: "FRICTION_INCREASE", metric: k, previous: prev, current: cur, baseline_date: base.date, evidence_label: "FACT", confidence: "CONFIRMED", review: "REVIEW_REQUIRED", note: `${k}: ${prev} (${base.date}) -> ${cur} (${current.date}); sapma bildirimidir, kok neden iddia etmez` });
    }
  }
  const s = current.sessions;
  if (!isNum(s.total) || !isNum(s.bot_pct)) ev.reasons.push("SESSIONS_UNKNOWN: bot orani degerlendirilmedi");
  else if (s.total >= BOT_MIN_SESSIONS && s.bot_pct > BOT_PCT_THRESHOLD) alerts.push({ site_id: current.site_id, date: current.date, kind: "BOT_RATIO_HIGH", current: s.bot_pct, total_sessions: s.total, evidence_label: "FACT", confidence: "CONFIRMED", review: "REVIEW_REQUIRED", note: `bot orani %${s.bot_pct} (> %${BOT_PCT_THRESHOLD}, ${s.total} oturum >= ${BOT_MIN_SESSIONS}); sapma bildirimidir, kok neden iddia etmez` });
  return { evaluation: ev, alerts };
}

// ---------------------------------------------------------------------------
// Gunluk kosu
// ---------------------------------------------------------------------------

export interface DailyOptions extends MeasureOptions {
  siteIds: string[];
  tokens: Map<string, string>;
  historyDir: string;
  outDir: string;
  /** true: ayni UTC gunde kullanilabilir kayit olsa bile yeniden olc (kota harcar). */
  force?: boolean;
  writeHistory?: boolean;
  sourceRunId?: string;
}

export interface SiteOutcome {
  site_id: string;
  action: "MEASURED" | "SKIPPED_ALREADY_MEASURED_TODAY" | "HISTORY_ERROR";
  measurement_state?: ClaritySiteResult["measurement_state"];
  history_action?: MergeAction | "NOT_WRITTEN";
  /** Bugunun (UTC) gecerli kaydi: bu kosuda yazilan ya da (atlanan sitede) onceden var olan. */
  record?: DailyRecord;
  /** true: bu kosuda gercekten API ile olculdu; atlanan site false (onceki olcumden miras). */
  fresh?: boolean;
  note?: string;
}

/** Takeover olcutu measurement_success'tir; usable yalniz analiz uygunlugudur. */
export interface Coverage { total_sites: number; measurement_success: number; usable: number; fresh_measurement_success: number }

export interface DailyOutcome {
  schema: typeof ALERTS_SCHEMA;
  date: string;
  generated_at: string;
  sites: SiteOutcome[];
  coverage: Coverage;
  evaluations: Evaluation[];
  alerts: Alert[];
  http_attempts: number;
  ignored_token_sites: string[];
  results: ClaritySiteResult[];
}

export async function runDaily(o: DailyOptions): Promise<DailyOutcome> {
  const nowDate = (o.now ?? (() => new Date()))();
  const date = nowDate.toISOString().slice(0, 10);
  const writeHistory = o.writeHistory !== false;
  const histories = new Map<string, HistoryFile>();
  const sites: SiteOutcome[] = [];
  const toMeasure: string[] = [];

  // Bozuk gecmis yalniz KENDI sitesini durdurur (kota harcanmaz, baska site etkilenmez).
  for (const id of o.siteIds) {
    try {
      const h = loadHistory(o.historyDir, id);
      histories.set(id, h);
      if (!o.force && hasMeasurementSuccessForDate(h, date)) {
        const today = h.records.find((r) => r.date === date && measurementSuccessOf(r));
        sites.push({ site_id: id, action: "SKIPPED_ALREADY_MEASURED_TODAY", record: today, fresh: false, note: "ayni UTC gun icin basarili olcum (measurement_success) var; API cagrisi YOK (--force ile asilir)" });
      }
      else toMeasure.push(id);
    } catch (e) {
      if (!(e instanceof HistoryError)) throw e;
      sites.push({ site_id: id, action: "HISTORY_ERROR", note: e.message });
    }
  }

  const { results, ignoredTokenSites } = await measureSites(toMeasure, o.tokens, o);
  const alerts: Alert[] = []; const evaluations: Evaluation[] = [];
  mkdirSync(o.outDir, { recursive: true });
  for (const r of results) {
    assertResultSite(r, r.site_id);
    const h = histories.get(r.site_id)!;
    const rec = toRecord(r, o.sourceRunId);
    const { evaluation, alerts: a } = evaluateAlerts(rec, h);
    evaluations.push(evaluation); alerts.push(...a);
    let historyAction: SiteOutcome["history_action"] = "NOT_WRITTEN";
    let effective = rec;
    if (writeHistory) {
      const m = mergeRecord(h, rec); saveHistory(o.historyDir, m.file); historyAction = m.action;
      effective = m.file.records.find((x) => x.date === rec.date) ?? rec;
    }
    sites.push({ site_id: r.site_id, action: "MEASURED", measurement_state: r.measurement_state, history_action: historyAction, record: effective, fresh: measurementSuccessOf(rec), note: effective !== rec ? "bugunun daha once yazilmis basarili olcumu korundu" : undefined });
    writeFileSync(join(o.outDir, `clarity-${r.site_id}.json`), JSON.stringify(r, null, 2) + "\n");
  }
  sites.sort((a, b) => o.siteIds.indexOf(a.site_id) - o.siteIds.indexOf(b.site_id));

  const coverage: Coverage = {
    total_sites: o.siteIds.length,
    measurement_success: sites.filter((x) => x.record && measurementSuccessOf(x.record)).length,
    usable: sites.filter((x) => x.record?.usable).length,
    fresh_measurement_success: sites.filter((x) => x.fresh === true).length,
  };
  const outcome: DailyOutcome = {
    schema: ALERTS_SCHEMA, date, generated_at: nowDate.toISOString(), sites, coverage, evaluations, alerts,
    http_attempts: results.reduce((n, r) => n + r.requests.reduce((m, q) => m + q.attempts, 0), 0),
    ignored_token_sites: ignoredTokenSites, results,
  };
  // Ham site sonuclari zaten clarity-<site>.json'da; alert dosyasi yalniz karar ozeti tasir.
  const publishable = { schema: outcome.schema, date, generated_at: outcome.generated_at, sites: outcome.sites.map(({ record: _r, ...s }) => ({ ...s, measurement_success: _r ? measurementSuccessOf(_r) : false, usable: _r?.usable ?? false, is_zero: _r?.is_zero ?? false })), coverage, evaluations, alerts, http_attempts: outcome.http_attempts, ignored_token_sites: ignoredTokenSites };
  writeFileSync(join(o.outDir, "clarity-alerts.json"), JSON.stringify(publishable, null, 2) + "\n");
  writeFileSync(join(o.outDir, "clarity-summary.md"), resultsToMarkdown(results, ignoredTokenSites));
  writeFileSync(join(o.outDir, "clarity-daily.md"), dailyMarkdown(outcome));
  return outcome;
}

// ---------------------------------------------------------------------------
// Rapor
// ---------------------------------------------------------------------------

const cell = (v: unknown) => (v === undefined ? "–" : String(v));

export function dailyMarkdown(o: DailyOutcome): string {
  const L: string[] = [`# Clarity günlük toplama — ${o.date} (UTC)`, "",
    "Salt-okunur. `UNKNOWN` = ölçülemedi, **sıfır DEĞİLDİR**. Hatalı/eksik ölçüm baz olamaz ve alert üretmez. Alert bir **sapma bildirimidir**: kök neden iddia etmez, `REVIEW_REQUIRED`.", "",
    `HTTP denemesi: ${o.http_attempts} (site başına en fazla 4; Microsoft limiti proje başına 10/gün).`, "",
    `**Takeover ölçütü = ölçüm başarısı (measurement_success)**: ${o.coverage.measurement_success}/${o.coverage.total_sites} site (bu koşuda taze: ${o.coverage.fresh_measurement_success}). Analiz uygunluğu (usable, baz/alert için; takeover ölçütü DEĞİL): ${o.coverage.usable}/${o.coverage.total_sites}.`, "",
    "| site | eylem | durum | ölçüm başarısı | sıfır | analiz uygun (usable) | gerçek / bot oturum | bot % | friction toplamı | geçmiş |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const s of o.sites) {
    const r = s.record;
    L.push(`| ${s.site_id} | ${s.action} | ${cell(s.measurement_state ?? r?.measurement_state)} | ${r ? (measurementSuccessOf(r) ? "evet" : "hayır") : "–"} | ${r ? (r.is_zero ? "evet" : "hayır") : "–"} | ${r ? (r.usable ? "evet" : "hayır") : "–"} | ${r ? `${r.sessions.real} / ${r.sessions.bot}` : "–"} | ${r ? r.sessions.bot_pct : "–"} | ${r ? r.friction_total : "–"} | ${cell(s.history_action)} |`);
  }
  L.push("", "## Alertler", "");
  if (!o.alerts.length) L.push("Alert yok (yalnız değerlendirilen siteler için; aşağıya bak).");
  for (const a of o.alerts) L.push(`- **${a.site_id}** · ${a.kind} · ${a.note} · FACT/CONFIRMED · REVIEW_REQUIRED`);
  L.push("", "## Değerlendirme kapsamı", "");
  for (const e of o.evaluations) L.push(`- ${e.site_id}: ${e.status}${e.baseline_date ? ` (baz ${e.baseline_date})` : ""}${e.reasons.length ? ` — ${e.reasons.join("; ")}` : ""}`);
  for (const s of o.sites) if (s.action !== "MEASURED") L.push(`- ${s.site_id}: ${s.action}${s.note ? ` — ${s.note}` : ""}`);
  if (o.ignored_token_sites.length) L.push("", `Registry'de olmayan site kimliği (token KULLANILMADI): ${o.ignored_token_sites.join(", ")}`);
  return L.join("\n") + "\n";
}
