/**
 * Clarity takeover zinciri: OFFLINE degerlendirici. Ag yok, API yok, secret yok; yalniz commit'li
 * data/clarity-history/*.json (+ istege bagli kosu kayitlari) okunur.
 *
 * Neden ayri bir arac: takeover basarisi iki seyin birlesimidir ve history tek basina ikincisini KANITLAYAMAZ:
 *   (1) 7/7 measurement_success  -> history'den okunur (gun, site basina tek kayit);
 *   (2) bu kosuda 7/7 TAZE olcum -> yalniz kosu kaydi (fresh_measurement_success) bilir. Ayni-gun guard'i ile atlanan site
 *       onceki olcumden miras kalir ve history'de taze olandan ayirt EDILEMEZ.
 * Bu yuzden kosu kaydi yoksa tazelik UNKNOWN'dur ve FULL_TAKEOVER_SUCCESS iddia edilmez (yanlis pozitif = legacy'yi
 * erken kapatma riski; yanlis negatif sadece bir dogrulama daha demektir).
 *
 * "Ardisik" yorumu (docs/integrations/clarity-daily.md: "Iki ardisik tam takeover dogrulamasi"): belge takvim bitisikligi
 * istemez; ardisik = dogrulamalar dizisinde araya girmeyen. Iki FARKLI UTC gun gerekir (ayni gun iki kosu tek sayilir).
 * Degerlendirilen gunler arasina giren, FULL olmayan bir gun (7/7 degil, tazelik bilinmiyor ya da <7) zinciri KIRAR.
 * Veri olmayan takvim gunleri gun sayilmaz; ama zincirde bosluk varsa raporlanir.
 *
 * Owner-gated adimlar (legacy kapatma, credential rotation, bayrak, ilk zamanlanmis dogrulama) kodla ne isaretlenir ne
 * cikarimla bulunur: hep OWNER_ACTION_PENDING.
 */
import { existsSync, readFileSync } from "node:fs";
import { loadRegistry } from "./registry.ts";
import { loadHistory, measurementSuccessOf, HistoryError } from "./clarity-daily.ts";

export const STATUS_SCHEMA = "sgos.clarity-takeover-status.v1" as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RunRecord {
  date_utc: string;
  run_id: string;
  fresh_measurement_success: number;
  total_sites: number;
  measurement_success: number;
}

export type DayStatus =
  | "FULL_TAKEOVER_SUCCESS"        // 7/7 measurement_success (history) VE o kosuda 7/7 taze (kosu kaydi)
  | "COVERAGE_VALIDATION_SUCCESS"  // 7/7 measurement_success, ama taze 7/7 DEGIL ya da bilinmiyor
  | "NOT_SUCCESS"                  // 7/7 measurement_success yok
  | "INCONSISTENT";                // kosu kaydi history ile celisiyor: hicbir basari iddia edilmez
export type Freshness = "FRESH_7_OF_7" | "NOT_FULL" | "UNKNOWN";
export type ChainState = "NONE" | "FULL_TAKEOVER_1_OF_2" | "FULL_TAKEOVER_2_OF_2";

export interface DayResult {
  date: string;
  status: DayStatus;
  sites_total: number;
  measurement_success_sites: string[];
  measurement_failed_sites: { site_id: string; reason: string }[];
  freshness: Freshness;
  /** Tazelik iddiasini destekleyen kosu (yoksa null). */
  qualifying_run_id: string | null;
  run_ids: string[];
  notes: string[];
}

export const OWNER_STEPS = ["legacy_disable", "credential_rotation", "flag_set", "first_scheduled_verification"] as const;
export interface ChecklistItem { step: (typeof OWNER_STEPS)[number]; state: "OWNER_ACTION_PENDING"; what: string }

export interface TakeoverStatus {
  schema: typeof STATUS_SCHEMA;
  sites: string[];
  run_records_supplied: boolean;
  days: DayResult[];
  chain_state: ChainState;
  chain_days: string[];
  chain_notes: string[];
  site_problems: { site_id: string; problem: string }[];
  run_record_problems: string[];
  owner_checklist: ChecklistItem[];
  /** Kod bunu asla true yapmaz: owner adimlari kodla dogrulanamaz. */
  legacy_takeover_complete: false;
}

export const OWNER_CHECKLIST: ChecklistItem[] = [
  { step: "legacy_disable", state: "OWNER_ACTION_PENDING", what: "Legacy site-health-monitor CCR routine'ini kapat (owner)." },
  { step: "credential_rotation", state: "OWNER_ACTION_PENDING", what: "7 Clarity token + GSC refresh token + GSC OAuth client secret rotasyonu; yeni Clarity token'lari SEARCH_GROWTH_CLARITY_TOKENS_JSON'a (owner)." },
  { step: "flag_set", state: "OWNER_ACTION_PENDING", what: "Repo degiskeni SEARCH_GROWTH_CLARITY_DAILY_ENABLED=true (owner)." },
  { step: "first_scheduled_verification", state: "OWNER_ACTION_PENDING", what: "Bayraktan sonraki ilk ZAMANLANMIS (07:20 UTC) kosuyu dogrula: yeni gun eklendi, cift kayit yok (bayrak sonrasi)." },
];

// ---------------------------------------------------------------------------

/** Kosu kayitlarini dogrular; gecersizler atilir ve nedeni dondurulur (sessizce duzeltilmez). */
export function parseRunRecords(data: unknown, expectedSites: number): { records: RunRecord[]; problems: string[] } {
  const problems: string[] = [];
  const records: RunRecord[] = [];
  if (!Array.isArray(data)) return { records, problems: ["kosu kayitlari bir JSON listesi olmali"] };
  const seen = new Set<string>();
  data.forEach((x, i) => {
    const p = `run_records[${i}]`;
    const r = x as Partial<Record<keyof RunRecord, unknown>>;
    const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
    if (!r || typeof r !== "object") return void problems.push(`${p}: nesne degil`);
    if (typeof r.date_utc !== "string" || !DATE.test(r.date_utc)) return void problems.push(`${p}: date_utc gecersiz`);
    const id = typeof r.run_id === "number" ? String(r.run_id) : r.run_id;
    if (typeof id !== "string" || !/^\d+$/.test(id)) return void problems.push(`${p}: run_id gecersiz`);
    if (!isCount(r.fresh_measurement_success) || !isCount(r.measurement_success) || !isCount(r.total_sites)) return void problems.push(`${p}: sayilar gecersiz`);
    if (r.total_sites !== expectedSites) return void problems.push(`${p}: total_sites ${r.total_sites} != registry ${expectedSites}`);
    if (r.measurement_success > r.total_sites || r.fresh_measurement_success > r.measurement_success) return void problems.push(`${p}: sayilar tutarsiz (taze <= basarili <= toplam olmali)`);
    if (seen.has(id)) return void problems.push(`${p}: run_id tekrar (${id})`);
    seen.add(id);
    records.push({ date_utc: r.date_utc, run_id: id, fresh_measurement_success: r.fresh_measurement_success, total_sites: r.total_sites, measurement_success: r.measurement_success });
  });
  return { records, problems };
}

export interface EvalInput {
  siteIds: string[];
  /** site -> (UTC gun -> measurement_success). Gecmisi okunamayan site burada yoktur ve siteProblems'tadir. */
  successBySite: Record<string, Record<string, boolean>>;
  siteProblems?: { site_id: string; problem: string }[];
  runRecords?: RunRecord[] | null;
  runRecordProblems?: string[];
}

export function evaluateTakeover(input: EvalInput): TakeoverStatus {
  const sites = [...input.siteIds];
  const n = sites.length;
  const runs = input.runRecords ?? null;
  const dates = new Set<string>();
  for (const s of sites) for (const d of Object.keys(input.successBySite[s] ?? {})) dates.add(d);
  for (const r of runs ?? []) dates.add(r.date_utc);

  const days: DayResult[] = [...dates].sort().map((date) => {
    const ok: string[] = []; const failed: DayResult["measurement_failed_sites"] = [];
    for (const s of sites) {
      const v = input.successBySite[s]?.[date];
      if (v === true) ok.push(s);
      else failed.push({ site_id: s, reason: input.successBySite[s] === undefined ? "history okunamadi" : v === undefined ? "o gun kayit yok" : "measurement_success=false" });
    }
    const dayRuns = (runs ?? []).filter((r) => r.date_utc === date);
    const notes: string[] = [];
    const allOk = n > 0 && ok.length === n;
    // Taze 7/7 kaniti: ayni kosu hem 7/7 basarili hem 7/7 taze demeli.
    const full = dayRuns.find((r) => r.total_sites === n && r.measurement_success === n && r.fresh_measurement_success === n) ?? null;
    let freshness: Freshness = "UNKNOWN";
    if (runs !== null && dayRuns.length > 0) freshness = full ? "FRESH_7_OF_7" : "NOT_FULL";
    let status: DayStatus;
    if (!allOk) {
      status = "NOT_SUCCESS";
      if (full) { status = "INCONSISTENT"; notes.push(`kosu ${full.run_id} 7/7 taze diyor ama history'de ${ok.length}/${n} measurement_success var; basari iddia edilmedi`); }
    } else if (full) status = "FULL_TAKEOVER_SUCCESS";
    else status = "COVERAGE_VALIDATION_SUCCESS";
    if (status === "COVERAGE_VALIDATION_SUCCESS") {
      notes.push(freshness === "UNKNOWN"
        ? "tazelik UNKNOWN: history tek basina taze/miras ayrimini kanitlayamaz; kosu kaydi gerekir"
        : "7/7 measurement_success var ama hicbir kosu 7/7 taze degil (ayni-gun guard'i ile miras kalan site olabilir)");
    }
    return {
      date, status, sites_total: n, measurement_success_sites: ok, measurement_failed_sites: failed, freshness,
      qualifying_run_id: status === "FULL_TAKEOVER_SUCCESS" ? full!.run_id : null,
      run_ids: dayRuns.map((r) => r.run_id), notes,
    };
  });

  // Zincir: sondan geriye ardisik FULL gunler (FULL olmayan gun kirar). Gun basina tek giris => ayni gun iki kez sayilmaz.
  const chain: string[] = [];
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].status !== "FULL_TAKEOVER_SUCCESS") break;
    chain.unshift(days[i].date);
  }
  const chain_state: ChainState = chain.length === 0 ? "NONE" : chain.length === 1 ? "FULL_TAKEOVER_1_OF_2" : "FULL_TAKEOVER_2_OF_2";
  const chain_notes: string[] = [];
  if (runs === null) chain_notes.push("kosu kaydi verilmedi: tazelik UNKNOWN, FULL_TAKEOVER iddia edilemez");
  for (let i = 1; i < chain.length; i++) {
    const gap = (Date.parse(chain[i]) - Date.parse(chain[i - 1])) / 86400000 - 1;
    if (gap > 0) chain_notes.push(`${chain[i - 1]} ile ${chain[i]} arasinda ${gap} takvim gunu veri yok (belge takvim bitisikligi istemez; bilgi)`);
  }
  return {
    schema: STATUS_SCHEMA, sites, run_records_supplied: runs !== null, days, chain_state, chain_days: chain, chain_notes,
    site_problems: input.siteProblems ?? [], run_record_problems: input.runRecordProblems ?? [],
    owner_checklist: OWNER_CHECKLIST.map((c) => ({ ...c })), legacy_takeover_complete: false,
  };
}

/** Diskten okur (yalniz yerel dosya). Bozuk gecmis yalniz kendi sitesini dusurur; baska site etkilenmez. */
export function loadAndEvaluate(registryPath: string, historyDir: string, runRecordsPath?: string): TakeoverStatus {
  const reg = loadRegistry(registryPath);
  if (!reg.ok || !reg.registry) throw new Error(`registry gecersiz: ${reg.errors.join("; ")}`);
  const siteIds = reg.registry.sites.map((s) => s.id);
  const successBySite: Record<string, Record<string, boolean>> = {};
  const siteProblems: { site_id: string; problem: string }[] = [];
  for (const id of siteIds) {
    try {
      const h = loadHistory(historyDir, id);
      successBySite[id] = Object.fromEntries(h.records.map((r) => [r.date, measurementSuccessOf(r)]));
    } catch (e) {
      siteProblems.push({ site_id: id, problem: e instanceof HistoryError ? e.message : `okunamadi: ${(e as Error).message}` });
    }
  }
  let runRecords: RunRecord[] | null = null; let rp: string[] = [];
  if (runRecordsPath) {
    if (!existsSync(runRecordsPath)) rp = [`kosu kaydi dosyasi yok: ${runRecordsPath}`];
    else {
      try { const p = parseRunRecords(JSON.parse(readFileSync(runRecordsPath, "utf8")), siteIds.length); runRecords = p.records; rp = p.problems; }
      catch { rp = ["kosu kaydi dosyasi JSON degil"]; }
    }
  }
  return evaluateTakeover({ siteIds, successBySite, siteProblems, runRecords, runRecordProblems: rp });
}

export function statusToMarkdown(s: TakeoverStatus): string {
  const L: string[] = [];
  L.push("# Clarity takeover durumu (offline)", "");
  L.push(`**Zincir: \`${s.chain_state}\`** (gunler: ${s.chain_days.join(", ") || "-"}). Legacy takeover COMPLETE: **kodla iddia edilmez** (owner adimlari asagida).`, "");
  L.push(`Siteler (${s.sites.length}): ${s.sites.join(", ")}. Kosu kaydi: ${s.run_records_supplied ? "verildi" : "YOK (tazelik UNKNOWN)"}.`, "");
  L.push("## Gunler", "", "| UTC gun | Durum | measurement_success | Tazelik | Kosu |", "|---|---|---|---|---|");
  for (const d of s.days) L.push(`| ${d.date} | ${d.status} | ${d.measurement_success_sites.length}/${d.sites_total} | ${d.freshness} | ${d.qualifying_run_id ?? (d.run_ids.join(", ") || "-")} |`);
  const detail: string[] = [];
  for (const d of s.days) {
    for (const f of d.measurement_failed_sites) detail.push(`- ${d.date} ${f.site_id}: ${f.reason}`);
    for (const t of d.notes) detail.push(`- ${d.date}: ${t}`);
  }
  if (detail.length) L.push("", ...detail);
  if (s.chain_notes.length) L.push("", "## Zincir notlari", "", ...s.chain_notes.map((x) => `- ${x}`));
  if (s.site_problems.length) L.push("", "## Site sorunlari", "", ...s.site_problems.map((x) => `- ${x.site_id}: ${x.problem}`));
  if (s.run_record_problems.length) L.push("", "## Kosu kaydi sorunlari", "", ...s.run_record_problems.map((x) => `- ${x}`));
  L.push("", "## Owner adimlari (kod isaretlemez, cikarim yapmaz)", "", ...s.owner_checklist.map((c) => `- [ ] ${c.step}: **${c.state}** — ${c.what}`), "");
  return L.join("\n");
}
