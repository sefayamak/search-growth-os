/**
 * Clarity takeover zinciri: OFFLINE degerlendirici. Ag yok, API yok, secret yok; yalniz commit'li
 * data/clarity-history/*.json okunur.
 *
 * TEK KANONIK KANIT KAYNAGI: history kaydindaki `source_run_id` (clarity-daily bunu zaten yazar: cli.ts GITHUB_RUN_ID ->
 * toRecord). Neden bu ve baska bir sey degil:
 *   - zaten uretiliyor ve ana kayitlarda var (workflow degisikligi GEREKMEZ; GITHUB_RUN_ID Actions'ta otomatik, secret degil);
 *   - tek yazar: clarity-daily'nin mevcut commit adimi. Ikinci bir defter/yazar yok, secret yok;
 *   - sandbox Actions artifact'i indiremez; commit'li dosya ise her yerde okunur;
 *   - ayni-gun guard'i atladigi siteye YAZMAZ: atlanan sitenin kaydi onceki kosunun run id'sini tasir. Yani "bu kosuda taze"
 *     ile "onceki olcumden miras" kayit duzeyinde ayirt edilir: bir UTC gunun 7 kaydinin HEPSI ayni run id'yi tasiyorsa
 *     o kosu 7/7 tazedir (bir kosu yalniz kendi olctugunu kendi id'siyle yazar; ilk-basari-kazanir kurali id'yi korur).
 * Reddedilen secenekler: Actions run metadata (sandbox'ta yok, elle yapistirma = tek kaynak degil), ayri defter (ikinci yazar,
 * workflow degisikligi, history ile ayrisabilir), eski "kosu kaydi JSON'u" (hicbir sey uretmiyordu).
 *
 * Forgery direnci (commit'li veri elle duzenlenebilir; bu yuzden tutarlilik caprazlari): ayni run id iki UTC gunde,
 * ayni run'in kayitlari workflow timeout'undan (15 dk) uzun aralikta, ya da run id'nin tarihe gore geri gitmesi (Actions
 * run id'leri zamanla artar) INCONSISTENT'tir ve hicbir basari iddia edilmez. Bu kanit dosyayi elle yazan birini TAM
 * engelleyemez (git gecmisi/PR incelemesi gerekir); amaci kazara/kaba tutarsizligi yakalamaktir.
 *
 * Neden ayri bir arac: takeover basarisi iki seyin birlesimidir:
 *   (1) 7/7 measurement_success  -> history'den okunur (gun, site basina tek kayit);
 *   (2) bu kosuda 7/7 TAZE olcum -> o gunun 7 kaydi ayni source_run_id'yi tasir. Eski kayitlarda id yoksa tazelik UNKNOWN'dur
 *       ve FULL_TAKEOVER_SUCCESS iddia edilmez (yanlis pozitif = legacy'yi erken kapatma riski).
 *
 * "Ardisik" yorumu (docs/integrations/clarity-daily.md: "Iki ardisik tam takeover dogrulamasi"): belge takvim bitisikligi
 * istemez; ardisik = dogrulamalar dizisinde araya girmeyen. Iki FARKLI UTC gun gerekir (ayni gun iki kosu tek sayilir).
 * Degerlendirilen gunler arasina giren, FULL olmayan bir gun zinciri KIRAR. Veri olmayan takvim gunleri gun sayilmaz;
 * zincirde bosluk varsa raporlanir.
 *
 * Owner-gated adimlar (legacy kapatma, credential rotation, bayrak, ilk zamanlanmis dogrulama) kodla ne isaretlenir ne
 * cikarimla bulunur: hep OWNER_ACTION_PENDING.
 */
import { loadRegistry } from "./registry.ts";
import { loadHistory, measurementSuccessOf, HistoryError } from "./clarity-daily.ts";

export const STATUS_SCHEMA = "sgos.clarity-takeover-status.v2" as const;
/** Workflow timeout-minutes: 15. Ayni run'in kayitlari bundan uzun aralikta olamaz (yeniden deneme / elle duzenleme belirtisi). */
export const RUN_WINDOW_MS = 15 * 60 * 1000;

/** Bir sitenin bir UTC gundeki kaydindan takeover icin gereken minimum. run_id yoksa (eski kayit / Actions disi) null. */
export interface DayEvidence { success: boolean; run_id: string | null; measured_at: string }

export type DayStatus =
  | "FULL_TAKEOVER_SUCCESS"        // 7/7 measurement_success VE 7 kaydin hepsi ayni run id'yi tasiyor (7/7 taze)
  | "COVERAGE_VALIDATION_SUCCESS"  // 7/7 measurement_success, ama taze 7/7 DEGIL ya da bilinmiyor
  | "NOT_SUCCESS"                  // 7/7 measurement_success yok
  | "INCONSISTENT";                // run id kanitlari birbiriyle celisiyor: hicbir basari iddia edilmez
export type Freshness = "FRESH_7_OF_7" | "NOT_FULL" | "UNKNOWN";
export type ChainState = "NONE" | "FULL_TAKEOVER_1_OF_2" | "FULL_TAKEOVER_2_OF_2";

export interface DayResult {
  date: string;
  status: DayStatus;
  sites_total: number;
  measurement_success_sites: string[];
  measurement_failed_sites: { site_id: string; reason: string }[];
  freshness: Freshness;
  /** FULL gunde 7 kaydin ortak run id'si (yoksa null). */
  qualifying_run_id: string | null;
  /** O gunun kayitlarini yazan kosular (run id artan) ve yazdiklari siteler. Id'siz kayit burada yoktur. */
  runs: { run_id: string; sites: string[] }[];
  latest_run_id: string | null;
  /**
   * Ayni-gun guard'i atlama SAYISI (gozlenen): en son kosu id'sini TASIMAYAN basarili kayit sayisi (o kayitlar onceki
   * kosudan miras). Alt sinirdir: hicbir kayit yazmayan (hepsini atlayan) kosu history'de gorunmez. Id'siz kayit varsa UNKNOWN.
   */
  guard_skips_observed: number | "UNKNOWN";
  /** Id'siz (eski ya da Actions disi) kayit tasiyan site sayisi. */
  unattributed_sites: string[];
  notes: string[];
}

export const OWNER_STEPS = ["legacy_disable", "credential_rotation", "flag_set", "first_scheduled_verification"] as const;
export interface ChecklistItem { step: (typeof OWNER_STEPS)[number]; state: "OWNER_ACTION_PENDING"; what: string }

export interface TakeoverStatus {
  schema: typeof STATUS_SCHEMA;
  sites: string[];
  evidence_source: "history.source_run_id";
  days: DayResult[];
  chain_state: ChainState;
  chain_days: string[];
  chain_notes: string[];
  site_problems: { site_id: string; problem: string }[];
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

export interface EvalInput {
  siteIds: string[];
  /** site -> (UTC gun -> kanit). Gecmisi okunamayan site burada yoktur ve siteProblems'tadir. */
  evidenceBySite: Record<string, Record<string, DayEvidence>>;
  siteProblems?: { site_id: string; problem: string }[];
}

const idCmp = (a: string, b: string) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

/** Run id'ler arasi capraz kontroller: tarih -> sorun listesi. Hicbir sey duzeltilmez. */
function crossChecks(sites: string[], ev: EvalInput["evidenceBySite"]): Map<string, string[]> {
  const issues = new Map<string, string[]>();
  const add = (d: string, m: string) => issues.set(d, [...(issues.get(d) ?? []), m]);
  const byRun = new Map<string, { dates: Set<string>; times: number[] }>();
  const dayIds = new Map<string, Set<string>>();
  for (const s of sites) for (const [d, e] of Object.entries(ev[s] ?? {})) {
    if (!e.run_id) continue;
    const r = byRun.get(e.run_id) ?? { dates: new Set(), times: [] };
    r.dates.add(d); r.times.push(Date.parse(e.measured_at)); byRun.set(e.run_id, r);
    dayIds.set(d, (dayIds.get(d) ?? new Set()).add(e.run_id));
  }
  for (const [id, r] of byRun) {
    if (r.dates.size > 1) for (const d of r.dates) add(d, `run ${id} birden fazla UTC gunde kayit yazmis (${[...r.dates].sort().join(", ")})`);
    const span = Math.max(...r.times) - Math.min(...r.times);
    if (!(span <= RUN_WINDOW_MS)) for (const d of r.dates) add(d, `run ${id} kayitlari ${Math.round(span / 60000)} dk araliga yayilmis (> ${RUN_WINDOW_MS / 60000} dk workflow timeout'u)`);
  }
  // Actions run id'leri zamanla artar: daha eski gunun id'si daha yeni gunun id'sinden BUYUK olamaz.
  const dates = [...dayIds.keys()].sort();
  for (let i = 1; i < dates.length; i++) {
    const prevMax = [...dayIds.get(dates[i - 1])!].sort(idCmp).at(-1)!;
    const curMin = [...dayIds.get(dates[i])!].sort(idCmp)[0];
    if (idCmp(prevMax, curMin) >= 0) { add(dates[i - 1], `run id sirasi tarihle celisiyor (${prevMax} >= ${curMin}, ${dates[i]})`); add(dates[i], `run id sirasi tarihle celisiyor (${prevMax} >= ${curMin}, ${dates[i - 1]})`); }
  }
  return issues;
}

export function evaluateTakeover(input: EvalInput): TakeoverStatus {
  const sites = [...input.siteIds];
  const n = sites.length;
  const dates = new Set<string>();
  for (const s of sites) for (const d of Object.keys(input.evidenceBySite[s] ?? {})) dates.add(d);
  const issues = crossChecks(sites, input.evidenceBySite);

  const days: DayResult[] = [...dates].sort().map((date) => {
    const ok: string[] = []; const failed: DayResult["measurement_failed_sites"] = []; const unattributed: string[] = [];
    const runMap = new Map<string, string[]>(); const okIds = new Map<string, string>();
    for (const s of sites) {
      const e = input.evidenceBySite[s]?.[date];
      if (e?.success === true) ok.push(s);
      else failed.push({ site_id: s, reason: input.evidenceBySite[s] === undefined ? "history okunamadi" : e === undefined ? "o gun kayit yok" : "measurement_success=false" });
      if (!e) continue;
      if (e.run_id) { runMap.set(e.run_id, [...(runMap.get(e.run_id) ?? []), s]); if (e.success) okIds.set(s, e.run_id); }
      else unattributed.push(s);
    }
    const runs = [...runMap.entries()].sort((a, b) => idCmp(a[0], b[0])).map(([run_id, ss]) => ({ run_id, sites: ss }));
    const latest = runs.length ? runs[runs.length - 1].run_id : null;
    const notes: string[] = [];
    const allOk = n > 0 && ok.length === n;
    const ids = new Set(okIds.values());
    // Taze 7/7: 7 basarili kaydin 7'si de id tasiyor ve hepsi AYNI id.
    const freshFull = allOk && unattributed.length === 0 && okIds.size === n && ids.size === 1;
    let freshness: Freshness = "UNKNOWN";
    if (allOk && unattributed.length === 0) freshness = freshFull ? "FRESH_7_OF_7" : "NOT_FULL";
    const skips: DayResult["guard_skips_observed"] = unattributed.length > 0 || latest === null ? "UNKNOWN" : ok.filter((s) => input.evidenceBySite[s][date].run_id !== latest).length;
    const dayIssues = issues.get(date) ?? [];
    let status: DayStatus;
    if (!allOk) { status = "NOT_SUCCESS"; if (dayIssues.length) notes.push(...dayIssues.map((x) => `tutarsizlik: ${x}`)); }
    else if (dayIssues.length) { status = "INCONSISTENT"; notes.push(...dayIssues.map((x) => `tutarsizlik: ${x}`), "hicbir basari iddia edilmedi"); }
    else if (freshFull) status = "FULL_TAKEOVER_SUCCESS";
    else status = "COVERAGE_VALIDATION_SUCCESS";
    if (status === "COVERAGE_VALIDATION_SUCCESS") {
      notes.push(freshness === "UNKNOWN"
        ? `tazelik UNKNOWN: ${unattributed.join(", ")} kaydinda source_run_id yok (eski kayit ya da Actions disi); taze/miras ayrimi kanitlanamaz`
        : `7/7 measurement_success var ama kayitlar ${ids.size} farkli kosudan (${[...ids].join(", ")}); ayni-gun guard'i ile miras kalan site var, bu kosu 7/7 taze degil`);
    }
    return {
      date, status, sites_total: n, measurement_success_sites: ok, measurement_failed_sites: failed, freshness,
      qualifying_run_id: status === "FULL_TAKEOVER_SUCCESS" ? [...ids][0] : null,
      runs, latest_run_id: latest, guard_skips_observed: skips, unattributed_sites: unattributed, notes,
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
  if (days.some((d) => d.freshness === "UNKNOWN" && d.status === "COVERAGE_VALIDATION_SUCCESS")) chain_notes.push("bazi gunlerde source_run_id yok: tazelik UNKNOWN, o gunler FULL sayilmaz");
  for (let i = 1; i < chain.length; i++) {
    const gap = (Date.parse(chain[i]) - Date.parse(chain[i - 1])) / 86400000 - 1;
    if (gap > 0) chain_notes.push(`${chain[i - 1]} ile ${chain[i]} arasinda ${gap} takvim gunu veri yok (belge takvim bitisikligi istemez; bilgi)`);
  }
  return {
    schema: STATUS_SCHEMA, sites, evidence_source: "history.source_run_id", days, chain_state, chain_days: chain, chain_notes,
    site_problems: input.siteProblems ?? [],
    owner_checklist: OWNER_CHECKLIST.map((c) => ({ ...c })), legacy_takeover_complete: false,
  };
}

/** Diskten okur (yalniz yerel dosya). Bozuk gecmis yalniz kendi sitesini dusurur; baska site etkilenmez. */
export function loadAndEvaluate(registryPath: string, historyDir: string): TakeoverStatus {
  const reg = loadRegistry(registryPath);
  if (!reg.ok || !reg.registry) throw new Error(`registry gecersiz: ${reg.errors.join("; ")}`);
  const siteIds = reg.registry.sites.map((s) => s.id);
  const evidenceBySite: EvalInput["evidenceBySite"] = {};
  const siteProblems: { site_id: string; problem: string }[] = [];
  for (const id of siteIds) {
    try {
      const h = loadHistory(historyDir, id);
      evidenceBySite[id] = Object.fromEntries(h.records.map((r) => [r.date, { success: measurementSuccessOf(r), run_id: r.source_run_id ?? null, measured_at: r.measured_at }]));
    } catch (e) {
      siteProblems.push({ site_id: id, problem: e instanceof HistoryError ? e.message : `okunamadi: ${(e as Error).message}` });
    }
  }
  return evaluateTakeover({ siteIds, evidenceBySite, siteProblems });
}

export function statusToMarkdown(s: TakeoverStatus): string {
  const L: string[] = [];
  L.push("# Clarity takeover durumu (offline)", "");
  L.push(`**Zincir: \`${s.chain_state}\`** (gunler: ${s.chain_days.join(", ") || "-"}). Legacy takeover COMPLETE: **kodla iddia edilmez** (owner adimlari asagida).`, "");
  L.push(`Siteler (${s.sites.length}): ${s.sites.join(", ")}. Kanit kaynagi: \`${s.evidence_source}\` (commit'li history).`, "");
  L.push("## Gunler", "", "| UTC gun | Durum | measurement_success | Tazelik | Guard atlama (gozlenen) | Kosu(lar): site sayisi |", "|---|---|---|---|---|---|");
  for (const d of s.days) L.push(`| ${d.date} | ${d.status} | ${d.measurement_success_sites.length}/${d.sites_total} | ${d.freshness} | ${d.guard_skips_observed} | ${d.runs.map((r) => `${r.run_id}: ${r.sites.length}`).join("; ") || "-"} |`);
  const detail: string[] = [];
  for (const d of s.days) {
    for (const f of d.measurement_failed_sites) detail.push(`- ${d.date} ${f.site_id}: ${f.reason}`);
    for (const t of d.notes) detail.push(`- ${d.date}: ${t}`);
  }
  if (detail.length) L.push("", ...detail);
  if (s.chain_notes.length) L.push("", "## Zincir notlari", "", ...s.chain_notes.map((x) => `- ${x}`));
  if (s.site_problems.length) L.push("", "## Site sorunlari", "", ...s.site_problems.map((x) => `- ${x.site_id}: ${x.problem}`));
  L.push("", "## Owner adimlari (kod isaretlemez, cikarim yapmaz)", "", ...s.owner_checklist.map((c) => `- [ ] ${c.step}: **${c.state}** — ${c.what}`), "");
  return L.join("\n");
}
