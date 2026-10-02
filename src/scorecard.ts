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
// sgos.deployment-event.v1, sgos.measure-report.v1 (docs/scorecard-orchestration.md: beklenen alanlar).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Confidence, EvidenceLabel } from "./types.ts";

export const SCORECARD_SCHEMA = "sgos.scorecard.v1" as const;
export const SCHEMA_IDS = {
  clarity: "sgos.clarity-history.v1",
  performance: "sgos.performance-history.v1",
  index: "sgos.index-history.v1",
  deployment: "sgos.deployment-event.v1",
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

export function performance(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.performance): Dimension {
  const D = "performance" as const;
  const g = gate(D, raw, SCHEMA_IDS.performance, siteId); if (!g.ok) return g.dim;
  const recs = (Array.isArray(g.payload.records) ? g.payload.records : []).filter(isObj).filter((r) => r.site_id === undefined || r.site_id === siteId)
    .sort((a, b) => String(a.date ?? a.measured_at).localeCompare(String(b.date ?? b.measured_at)));
  if (!recs.length) return unknown(D, "performans gecmisi var ama kayit yok");
  const last = recs[recs.length - 1];
  const when = parseWhen(last.measured_at ?? last.date, now);
  if (!when) return unknown(D, "son performans kaydinin tarihi gecersiz");
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  if (last.measurement_state === "NOT_CONNECTED") return dim(D, "NOT_CONNECTED", "FACT", "CONFIRMED", "performans olcumu bagli degil", asOf);
  if (last.measurement_state !== undefined && last.measurement_state !== "MEASURED") return unknown(D, `son kayit state=${String(last.measurement_state)} (MEASURED degil); degerler kullanilmadi`, asOf);
  const m: Array<[string, unknown, number]> = [["lcp_ms", last.lcp_ms, CWV_GOOD.lcp_ms], ["cls", last.cls, CWV_GOOD.cls], ["inp_ms", last.inp_ms, CWV_GOOD.inp_ms]];
  const present = m.filter(([, v]) => isNum(v));
  if (!present.length) return unknown(D, "kayitta lcp_ms/cls/inp_ms yok; skor tahmin edilmedi", asOf);
  const over = present.filter(([, v, lim]) => (v as number) > lim);
  const checked = `bakilan: ${present.map(([k, v]) => `${k}=${String(v)}`).join(", ")}; esikler LCP<=${CWV_GOOD.lcp_ms}ms CLS<=${CWV_GOOD.cls} INP<=${CWV_GOOD.inp_ms}ms`;
  const missing = m.filter(([, v]) => !isNum(v)).map(([k]) => k);
  const lab = typeof last.source === "string" ? ` kaynak=${last.source}` : "";
  if (over.length) return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${over.map(([k]) => k).join(", ")} esigi asti; ${checked}${lab}. Lab olcumu olabilir, saha verisi degil`, asOf);
  // Eksik metrik varken "OK" demek yarim bakistir: bunu ATTENTION degil, UNKNOWN'a yakin ama OK-sinirli yaziyoruz.
  if (missing.length) return unknown(D, `${missing.join(", ")} eksik; mevcutlar esigin altinda ama tam degerlendirme yok (${checked})`, asOf);
  return dim(D, "OK", "INFERENCE", "CANDIDATE", `${checked}${lab}`, asOf);
}

export function indexHealth(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.index_health): Dimension {
  const D = "index_health" as const;
  const g = gate(D, raw, SCHEMA_IDS.index, siteId); if (!g.ok) return g.dim;
  const recs = (Array.isArray(g.payload.records) ? g.payload.records : []).filter(isObj).filter((r) => r.site_id === undefined || r.site_id === siteId)
    .sort((a, b) => String(a.date ?? a.measured_at).localeCompare(String(b.date ?? b.measured_at)));
  if (!recs.length) return unknown(D, "index gecmisi var ama kayit yok");
  const last = recs[recs.length - 1];
  const when = parseWhen(last.measured_at ?? last.date, now);
  if (!when) return unknown(D, "son index kaydinin tarihi gecersiz");
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  if (last.measurement_state === "NOT_CONNECTED") return dim(D, "NOT_CONNECTED", "FACT", "CONFIRMED", "URL Inspection bagli degil", asOf);
  if (last.measurement_state !== undefined && last.measurement_state !== "MEASURED") return unknown(D, `son kayit state=${String(last.measurement_state)}; ERROR/PARTIAL "indexli degil" demek degildir`, asOf);
  const n = last.sample_size, bad = last.not_indexed_count;
  if (!isNum(n) || n === 0 || !isNum(bad)) return unknown(D, "sample_size/not_indexed_count yok ya da 0; orneklem olmadan karar verilmez", asOf);
  const scope = `ORNEKLEM ${n} URL (tam coverage degil)`;
  // Indekslenmemis URL bir FACT (Google'in cevabi); "bu bir sorun" yorumu INFERENCE: bilerek indexlenmemis olabilir.
  if (bad > 0) return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${scope}: ${bad} URL indexli degil; nedeni dogrulanmadi (bilincli noindex/canonical olabilir)`, asOf);
  return dim(D, "OK", "INFERENCE", "CANDIDATE", `${scope}: hepsi indexli. Ornek disindaki URL'ler hakkinda bilgi yok`, asOf);
}

export function deploymentChange(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.deployment_change): Dimension {
  const D = "deployment_change" as const;
  if (raw === undefined || raw === null) return unknown(D, `girdi yok (${SCHEMA_IDS.deployment} zaman cizelgesi verilmedi/bulunamadi)`);
  // Zaman cizelgesi ya {events:[...]} ya da dogrudan olay dizisi olabilir; her olay kendi sema kimligini tasir.
  const events = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.events) ? raw.events : null;
  if (!events) return unknown(D, "zaman cizelgesi events dizisi icermiyor");
  const generated = isObj(raw) ? parseWhen(raw.generated_at ?? raw.as_of, now) : null;
  const mine = events.filter(isObj).filter((e) => e.schema === SCHEMA_IDS.deployment && e.site_id === siteId);
  const foreign = events.filter(isObj).filter((e) => e.site_id !== undefined && e.site_id !== siteId).length;
  // Tazelik: olay yoklugu bayatlik degil (site deploy etmemis olabilir); bu yuzden dosyanin kendi damgasina bakilir.
  const lastEvt = mine.map((e) => parseWhen(e.deployed_at, now)).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const fresh = generated ?? null;
  if (!fresh) return unknown(D, `zaman cizelgesinin generated_at/as_of damgasi yok; tazelik bilinmiyor${foreign ? ` (${foreign} baska site olayi yok sayildi)` : ""}`, lastEvt ? lastEvt.toISOString() : null);
  const age = ageDays(fresh, now);
  if (age > max) return stale(D, fresh, age, max);
  const asOf = fresh.toISOString();
  const iso = foreign ? `; ${foreign} baska site olayi izolasyon geregi yok sayildi` : "";
  const windowStart = now.getTime() - 14 * DAY_MS;
  const recent = mine.filter((e) => { const d = parseWhen(e.deployed_at, now); return d && d.getTime() >= windowStart; });
  if (!recent.length) return dim(D, "OK", "INFERENCE", "CANDIDATE", `son 14 gunde ${siteId} icin deploy olayi yok (cizelge ${asOf.slice(0, 10)}); cizelgenin tum deploylari gordugu dogrulanmadi${iso}`, asOf);
  const notVerified = recent.filter((e) => e.verification_state !== "VERIFIED");
  if (notVerified.length) return dim(D, "ATTENTION", "FACT", "CONFIRMED", `son 14 gunde ${recent.length} deploy, ${notVerified.length} tanesi VERIFIED degil (${notVerified.map((e) => String(e.verification_state ?? "UNKNOWN")).join(",")})${iso}`, asOf);
  return dim(D, "OK", "FACT", "CONFIRMED", `son 14 gunde ${recent.length} dogrulanmis deploy: metrik degisiklikleri bu pencerede degisiklikle karisabilir (nedensellik iddiasi yok)${iso}`, asOf);
}

export function searchOpportunity(raw: unknown, siteId: string, now: Date, max = DEFAULT_MAX_AGE_DAYS.search_opportunity): Dimension {
  const D = "search_opportunity" as const;
  if (raw === undefined || raw === null) return unknown(D, `girdi yok (${SCHEMA_IDS.measure} olcum raporu verilmedi/bulunamadi)`);
  if (!isObj(raw) || raw.schema !== SCHEMA_IDS.measure) return unknown(D, `sema beklenen ${SCHEMA_IDS.measure}, gelen ${isObj(raw) ? String(raw.schema) : "nesne degil"}`);
  const sites = raw.sites;
  // Izolasyon: yalniz istenen sitenin girdisi okunur; diger siteler hic dokunulmaz.
  const entry = isObj(sites) ? sites[siteId] : undefined;
  if (!isObj(entry)) return unknown(D, `raporda ${siteId} girdisi yok`);
  const when = parseWhen(entry.generated_at ?? raw.generated_at, now);
  if (!when) return unknown(D, "rapor tarihi yok/gecersiz");
  const age = ageDays(when, now);
  if (age > max) return stale(D, when, age, max);
  const asOf = when.toISOString();
  if (entry.gsc_state === "NOT_CONNECTED") return dim(D, "NOT_CONNECTED", "FACT", "CONFIRMED", "GSC bu site icin bagli degil; firsat olculemez", asOf);
  if (entry.gsc_state !== "CONNECTED") return unknown(D, `gsc_state=${String(entry.gsc_state)}`, asOf);
  const c = entry.opportunity_count;
  if (!isNum(c)) return unknown(D, "opportunity_count yok; sayi uydurulmadi", asOf);
  // Firsat bir oneri adayidir (RECOMMENDATION degil: onboarding'e ve insan kararina bagli), talep olculmus olsa da cikarimdir.
  if (c > 0) return dim(D, "ATTENTION", "INFERENCE", "CANDIDATE", `${c} firsat adayi (GSC kanitli); inceleme gerekir, uygulama onerisi degil`, asOf);
  return dim(D, "OK", "INFERENCE", "CANDIDATE", "GSC bagli, rapor doneminde firsat adayi 0", asOf);
}

// ---------------------------------------------------------------------------
// Birlestirme
// ---------------------------------------------------------------------------

export interface ScorecardInputs {
  site_id: string;
  onboarding_status?: string;
  clarity?: unknown; performance?: unknown; index?: unknown; deployments?: unknown; measure?: unknown;
}

export function buildScorecard(i: ScorecardInputs, now: Date = new Date(), maxAge: Partial<Record<DimensionId, number>> = {}): SiteScorecard {
  const a = { ...DEFAULT_MAX_AGE_DAYS, ...maxAge };
  const s = i.site_id;
  const dimensions = [
    measurementHealth(i.clarity, s, now, a.measurement_health),
    indexHealth(i.index, s, now, a.index_health),
    searchOpportunity(i.measure, s, now, a.search_opportunity),
    uxFriction(i.clarity, s, now, a.ux_friction),
    performance(i.performance, s, now, a.performance),
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

export interface ArtifactPaths { clarityDir?: string; performanceDir?: string; indexDir?: string; deploymentDir?: string; measureFile?: string }

function readJson(path: string | undefined): unknown {
  if (!path || !existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Beklenen duzen: <dir>/<site_id>.json. Bozuk JSON "yok" gibi okunur ve boyut UNKNOWN olur; sifir/OK'e donmez. */
export function loadInputs(p: ArtifactPaths, siteId: string, onboardingStatus?: string): ScorecardInputs {
  const f = (dir?: string) => (dir ? join(dir, `${siteId}.json`) : undefined);
  return { site_id: siteId, onboarding_status: onboardingStatus, clarity: readJson(f(p.clarityDir)), performance: readJson(f(p.performanceDir)), index: readJson(f(p.indexDir)), deployments: readJson(f(p.deploymentDir)), measure: readJson(p.measureFile) };
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
