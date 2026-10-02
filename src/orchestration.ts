// Tek kanonik orkestrasyon modeli: hangi is, nerede, ne zaman, hangi kotayi yer, neye yazar.
//
// NEDEN VERI OLARAK: orkestrasyon bilgisi simdiye kadar workflow yorumlarinda, DEVAM.md'de ve
// owner'in kafasinda dagiliydi. "Eski rutin + clarity.yml + clarity-daily = 9/10 Clarity kotasi"
// gibi cakismalar ancak biri yanip gectikten sonra fark ediliyordu. Burada her is tek satir,
// dogrulayici da bu satirlari tarar. Model GERCEK .github/workflows dosyalarindan tohumlandi ve
// tests/orchestration.test.ts onlari dosyadan tekrar okuyup modelle karsilastirir: workflow'a
// modelde olmayan bir schedule eklenirse test kirilir (sessiz drift yok).
//
// Bu modul HICBIR SEY CALISTIRMAZ ve ag/dosya yazimi yapmaz; yalniz tanimlar ve dogrular.
// Olculmeyen sayi yazilmaz: bilinmeyen kota "UNKNOWN" kalir (CLAUDE.md kural 1).

export type Cadence = "daily" | "weekly" | "monthly" | "event" | "manual";
/** loop = hangi ritim dongusune ait; event/manual isler "on_demand". */
export type Loop = "daily" | "weekly" | "monthly" | "on_demand";
export type Runner = "github_actions" | "owner_mac" | "ccr_routine";
export type JobState = "ACTIVE" | "GATED" | "DISABLED" | "PLANNED";

export interface Job {
  id: string;
  loop: Loop;
  cadence: Cadence;
  /** 5 alanli cron, UTC. Yalniz zamanlanmis (schedule) isler tasir. */
  cron?: string;
  runner: Runner;
  /** github_actions icin .github/workflows altindaki dosya adi. */
  workflow?: string;
  /** Site basina dis API istegi. Dis API yoksa 0; bilinmiyorsa "UNKNOWN" (tahmin yok). */
  api_calls_per_site: number | "UNKNOWN";
  /** Hangi kota havuzunu yer (or. "clarity-project"). Kotasiz is icin null. */
  quota_cost: { pool: string; per_site: number | "UNKNOWN" } | null;
  state: JobState;
  /** GATED ise: isi acan kosul (workflow'daki tam ifade ya da owner eylemi). */
  gate?: string;
  /** Yazdigi yerler. Bos = salt-okunur. */
  writes: string[];
  depends_on: string[];
  note?: string;
  /** main'e commit/push eder mi? `writes`teki "(commit, main)" metni aciklamadir; dogrulayici BU alana bakar. */
  commits_to_main?: boolean;
  /** Commit adimini koruyan concurrency grubu. Iki ayri grup = iki is ayni anda main'e push edebilir (yaris). */
  commit_group?: string;
  /** push oncesi pull --rebase var mi. plain_push + baska commit eden is = non-fast-forward reddi riski. */
  push_strategy?: "rebase_then_push" | "plain_push";
}

/** Onerilen TEK ortak grup: main'e yazan her workflow'un commit adimi (ayri `persist` job'i) bu grupta kosar. */
export const TARGET_COMMIT_GROUP = "main-writes";

// ---------------------------------------------------------------------------
// Tarihce sahipligi: olcum modulu -> makine-okunur cikti -> tarihce sahibi -> kalicilik -> scorecard tuketimi
// ---------------------------------------------------------------------------
//
// NEDEN ZINCIR: data/*-history dosyalari ARTIMLI durumdur (bugunku dosya dunku dosyaya eklenir). Iki is ayni dosyaya
// yazarsa ikincisi birincinin ekini sessizce ezer ya da rebase catismasi uretir; ikisi de "veri yok" gibi gorunur ve
// scorecard'i yanlis UNKNOWN/OK'e iter. Bu yuzden her tarihce yolunun TEK yazari vardir; digerleri (scorecard dahil) YALNIZ OKUR.
// Zincirin halkalari bos birakilamaz (dogrulayici HISTORY_CHAIN_INCOMPLETE).
export interface HistoryOwner {
  /** Dizin, sonunda "/". Tek yazar kurali bu yol uzerindendir. */
  path: string;
  /** 1) Olcumu yapan modul. */
  measurement_module: string;
  /** 2) Modulun makine-okunur cikti sema kimligi. */
  schema: string;
  /** 3) Tarihce sahibi: bu yola yazan TEK is (Job.id). */
  owner_job: string;
  /** 4) Kalicilik: main'e commit mi, yalniz artifact mi. */
  persistence: "commit_main" | "artifact_only";
  /** 5) Salt-okunur tuketiciler (Job.id) ve besledikleri scorecard boyutlari. */
  consumers: string[];
  scorecard_dimensions: string[];
  /** Uretici durumu (kural 5: kaynak): "main" ya da acik PR. */
  producer_ref: string;
}

/** Tarihce dosyalari: bu bes yolun hepsinin sahibi olmak ZORUNDA (eksik = HISTORY_PATH_REQUIRED_MISSING). */
export const REQUIRED_HISTORY_PATHS = ["data/clarity-history/", "data/performance-history/", "data/index-history/", "data/canonical-backlog/", "data/deployment-timeline/"];

export const HISTORY_OWNERS: HistoryOwner[] = [
  { path: "data/clarity-history/", measurement_module: "src/clarity-daily.ts", schema: "sgos.clarity-history.v1", owner_job: "clarity-daily", persistence: "commit_main",
    consumers: ["scorecard-weekly"], scorecard_dimensions: ["measurement_health", "ux_friction"], producer_ref: "main" },
  { path: "data/performance-history/", measurement_module: "src/performance.ts", schema: "sgos.performance-history.v1", owner_job: "lighthouse-weekly", persistence: "commit_main",
    consumers: ["scorecard-weekly"], scorecard_dimensions: ["performance"], producer_ref: "PR #36 (claude/sprint-lighthouse)" },
  { path: "data/index-history/", measurement_module: "src/index-alarms.ts", schema: "sgos.index-history.v1", owner_job: "index-alarms-daily", persistence: "commit_main",
    consumers: ["scorecard-weekly"], scorecard_dimensions: ["index_health"], producer_ref: "PR #34 (claude/sprint-index-alarms)" },
  // Ayni is (index-alarms-daily) iki DIZINE yazar: tek-yazar kurali yol bazlidir, is bazli degil.
  // Not: owner_status alanlarini insan PR ile yazar; bot onlari korur (updateBacklog) ama rebase catismasi gercek bir riskdir (docs/history-ownership.md).
  { path: "data/canonical-backlog/", measurement_module: "src/index-alarms.ts", schema: "sgos.canonical-backlog.v1", owner_job: "index-alarms-daily", persistence: "commit_main",
    consumers: [], scorecard_dimensions: [], producer_ref: "PR #34 (claude/sprint-index-alarms); scorecard bunu henuz OKUMAZ" },
  { path: "data/deployment-timeline/", measurement_module: "src/deployment-timeline.ts", schema: "sgos.deployment-timeline.v1", owner_job: "deployment-verifier", persistence: "commit_main",
    consumers: ["scorecard-weekly"], scorecard_dimensions: ["deployment_change"], producer_ref: "PR #32 (claude/sprint-deployment-verifier)" },
];

export interface QuotaPool {
  id: string;
  /** Saglayicinin gunluk tavani; belgelenmemisse "UNKNOWN". */
  daily_limit: number | "UNKNOWN";
  unit: string;
  /** Tavanin kaynagi (kural 5: kaynak ve not). */
  source: string;
}

export const QUOTA_POOLS: QuotaPool[] = [
  { id: "clarity-project", daily_limit: 10, unit: "istek/gun/proje", source: "docs/integrations/clarity-daily.md (Microsoft Clarity data export limiti)" },
  { id: "gsc-url-inspection", daily_limit: 2000, unit: "inspection/gun/property", source: "src/index-probe.ts yorumu (Google belgesi); biz ~%5'te duruyoruz" },
  { id: "gsc-ga4-measure", daily_limit: "UNKNOWN", unit: "UNKNOWN", source: "bu depoda belgelenmemis; tahmin yazilmaz" },
];

const WF = ".github/workflows";

export const JOBS: Job[] = [
  // ---------------- weekly (gercek workflow'lar) ----------------
  { id: "portfolio-check", loop: "weekly", cadence: "weekly", cron: "10 6 * * 1", runner: "github_actions", workflow: "portfolio-check.yml",
    api_calls_per_site: 0, quota_cost: null, state: "ACTIVE", writes: ["artifact:portfolio-check-<run_id>"], depends_on: [],
    note: "Icerik ritmi, 7 site, secret yok." },
  { id: "measure", loop: "weekly", cadence: "weekly", cron: "40 6 * * 1", runner: "github_actions", workflow: "measure.yml",
    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "gsc-ga4-measure", per_site: "UNKNOWN" }, state: "ACTIVE",
    writes: ["reports/ (commit, main)", "content/topic-ledger.json (commit, main)", "artifact:measure-<run_id>"], depends_on: [],
    commits_to_main: true, commit_group: "measure", push_strategy: "plain_push",
    note: "GSC + GA4; commit adimi yalniz schedule veya commit_report ile. DIKKAT: push oncesi pull --rebase YOK (measure.yml)." },
  { id: "search-audit", loop: "weekly", cadence: "weekly", cron: "40 6 * * 1", runner: "github_actions", workflow: "search-audit.yml",
    api_calls_per_site: 0, quota_cost: null, state: "ACTIVE", writes: ["artifact:search-audit-<site>-<run_id>"], depends_on: [],
    note: "Salt-okunur HTTP taramasi (pilot site). measure ile ayni dakika: farkli havuz, bilinen ve zararsiz cakisma." },

  // ---------------- daily ----------------
  { id: "clarity-daily", loop: "daily", cadence: "daily", cron: "20 7 * * *", runner: "github_actions", workflow: "clarity-daily.yml",
    api_calls_per_site: 3, quota_cost: { pool: "clarity-project", per_site: 3 }, state: "GATED",
    gate: "vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'",
    writes: ["data/clarity-history/*.json (commit, main)", "artifact:clarity-daily-<run_id>"], depends_on: [],
    commits_to_main: true, commit_group: "clarity", push_strategy: "rebase_then_push",
    note: "Cutover bayragi yokken schedule atlanir. Dispatch bayraga bagli degil (insan eylemi)." },
  { id: "legacy-site-health-monitor", loop: "daily", cadence: "daily", cron: "10 6 * * *", runner: "ccr_routine",
    api_calls_per_site: 3, quota_cost: { pool: "clarity-project", per_site: 3 }, state: "ACTIVE",
    gate: "owner kapatana kadar ACTIVE (sefayamak/site-health-monitor; cron 06:10Z)",
    writes: ["site-health-monitor snapshot (kendi deposu)"], depends_on: [],
    note: "Eski rutin. Cutover dogrulamasindan sonra owner kapatir; bu depo dokunmaz." },

  // ---------------- on_demand (yalniz dispatch / event) ----------------
  { id: "clarity-manual", loop: "on_demand", cadence: "manual", runner: "github_actions", workflow: "clarity.yml",
    api_calls_per_site: 3, quota_cost: { pool: "clarity-project", per_site: 3 }, state: "ACTIVE",
    writes: ["artifact:clarity-<run_id>"], depends_on: [], note: "schedule YOK; elle canli dogrulama. Ayni gun kota harcar." },
  { id: "index-probe", loop: "on_demand", cadence: "manual", runner: "github_actions", workflow: "index-probe.yml",
    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "gsc-url-inspection", per_site: "UNKNOWN" }, state: "ACTIVE",
    writes: ["artifact:index-probe-<run_id>"], depends_on: [], note: "Yalniz pamistanbul, ORNEKLEM (varsayilan 20, tavan 100)." },
  { id: "brain", loop: "on_demand", cadence: "manual", runner: "github_actions", workflow: "brain.yml",
    api_calls_per_site: "UNKNOWN", quota_cost: null, state: "ACTIVE",
    writes: ["artifact:brain-evidence-<run_id>", "artifact:brain-run-<run_id>"], depends_on: ["clarity-manual"],
    note: "clarity-<run_id> artifact'ini tuketir; LLM maliyeti bu modelde olculmedi (UNKNOWN)." },
  { id: "tests-ci", loop: "on_demand", cadence: "event", runner: "github_actions", workflow: "tests.yml",
    api_calls_per_site: 0, quota_cost: null, state: "ACTIVE", writes: [], depends_on: [], note: "pull_request / push; schedule yok." },

  // ---------------- PLANNED (yeni katmanlar; henuz kod/workflow yok) ----------------
  { id: "lighthouse-weekly", loop: "weekly", cadence: "weekly", cron: "10 7 * * 1", runner: "github_actions", workflow: "lighthouse.yml",
    api_calls_per_site: "UNKNOWN", quota_cost: null, state: "PLANNED", writes: ["data/performance-history/*.json (commit, main)", "artifact:lighthouse-<run_id>"], depends_on: [],
    commits_to_main: true, commit_group: TARGET_COMMIT_GROUP, push_strategy: "rebase_then_push",
    note: "Planli saat oneri; workflow olusunca model guncellenir." },
  { id: "index-alarms-daily", loop: "daily", cadence: "daily", cron: "40 7 * * *", runner: "github_actions", workflow: "index-alarms.yml",
    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "gsc-url-inspection", per_site: "UNKNOWN" }, state: "PLANNED",
    writes: ["data/index-history/*.json (commit, main)", "data/canonical-backlog/*.json (commit, main)", "artifact:index-alarms-<run_id>"], depends_on: [],
    commits_to_main: true, commit_group: TARGET_COMMIT_GROUP, push_strategy: "rebase_then_push", note: "Kota kullanimi olculene kadar UNKNOWN. Iki dizinin TEK yazari (index-probe yalniz artifact yazar)." },
  { id: "deployment-verifier", loop: "on_demand", cadence: "event", runner: "github_actions", workflow: "deployment-verifier.yml",
    api_calls_per_site: 0, quota_cost: null, state: "PLANNED", writes: ["data/deployment-timeline/*.json (commit, main)", "artifact:deployment-verifier-<run_id>"], depends_on: [],
    commits_to_main: true, commit_group: TARGET_COMMIT_GROUP, push_strategy: "rebase_then_push",
    note: "Deploy olayinda tetiklenir; cron'u yok. Her kosu TUM deploy listesini ceker (idempotent): ortak grupta bekleyen fazla kosu iptal olsa da veri kaybolmaz." },
  { id: "scorecard-weekly", loop: "weekly", cadence: "weekly", cron: "10 8 * * 1", runner: "github_actions", workflow: "scorecard.yml",
    api_calls_per_site: 0, quota_cost: null, state: "PLANNED", writes: ["artifact:scorecard-<run_id>"],
    depends_on: ["measure", "clarity-daily", "lighthouse-weekly", "index-alarms-daily", "deployment-verifier"],
    commits_to_main: false,
    note: "SALT-OKUNUR tuketici: data/ ve reports/ altina HICBIR sey yazmaz, commit etmez (docs/history-ownership.md); cikti yalniz artifact. Ag yok. Monthly dongude henuz is tanimli degil (uydurma is eklenmedi)." },
];

// ---------------------------------------------------------------------------
// Cron: yalniz kullandigimiz alt kume (*, sayi, a-b, */n, a-b/n, liste). Baska bir sey = hata.
// ---------------------------------------------------------------------------

export interface CronFields { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const RANGES: Array<[string, number, number]> = [["minute", 0, 59], ["hour", 0, 23], ["dom", 1, 31], ["month", 1, 12], ["dow", 0, 7]];

function parseField(src: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let a: number, b: number;
    if (m[1] === "*") { a = lo; b = hi; }
    else if (m[1].includes("-")) { [a, b] = m[1].split("-").map(Number); }
    else { a = Number(m[1]); b = m[2] === undefined ? a : hi; }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Gecersiz cron icin null doner (istisna firlatmaz): dogrulayici bunu issue'ya cevirir. */
export function parseCron(expr: string): CronFields | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(f[i], RANGES[i][1], RANGES[i][2]);
    if (!s || s.size === 0) return null;
    sets.push(s);
  }
  const dow = new Set([...sets[4]].map((d) => d % 7)); // 7 == pazar == 0
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow, domStar: f[2] === "*", dowStar: f[4] === "*" };
}

/** Referans haftada (2026-10-05 Pzt .. 2026-10-11 Paz, UTC) cron'un tetiklendigi dakikalar: "dow@HH:MM".
 *  Neden bir hafta: tum cron'larimiz gunluk/haftalik; aylik tetikler icin bu eleme eksik kalir ve
 *  sinirlama burada acikca yazili (kapsam disi: ay/dom kisitli cron'lar haftada hic eslesmeyebilir). */
export function fireSlots(expr: string): Set<string> {
  const c = parseCron(expr);
  const slots = new Set<string>();
  if (!c) return slots;
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.UTC(2026, 9, 5 + d));
    const dow = date.getUTCDay(), dom = date.getUTCDate(), month = date.getUTCMonth() + 1;
    if (!c.month.has(month)) continue;
    // POSIX: dom ve dow ikisi de kisitliysa VEYA; biri * ise yalniz digeri.
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? c.dow.has(dow) : c.dowStar ? c.dom.has(dom) : c.dom.has(dom) || c.dow.has(dow);
    if (!dayOk) continue;
    for (const h of c.hour) for (const m of c.minute) slots.add(`${dow}@${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Dogrulayici
// ---------------------------------------------------------------------------

export type IssueCode =
  | "DUPLICATE_ID" | "BAD_CRON" | "MISSING_CRON" | "UNEXPECTED_CRON" | "MISSING_WORKFLOW" | "GATE_REQUIRED"
  | "UNKNOWN_DEPENDENCY" | "DEPENDENCY_NOT_LIVE" | "UNKNOWN_POOL" | "QUOTA_MISMATCH"
  | "DUPLICATE_SCHEDULER" | "QUOTA_OVERBOOKED" | "QUOTA_NEAR_LIMIT" | "SCHEDULE_COLLISION" | "LOOP_MISMATCH"
  // tarihce sahipligi + main'e yazma yarisi
  | "MULTI_WRITER" | "HISTORY_PATH_REQUIRED_MISSING" | "HISTORY_DUPLICATE_PATH" | "HISTORY_OWNER_UNKNOWN_JOB" | "HISTORY_OWNER_NOT_WRITER"
  | "HISTORY_WRITER_NOT_OWNER" | "HISTORY_UNREGISTERED_WRITE" | "HISTORY_CHAIN_INCOMPLETE" | "HISTORY_CONSUMER_WRITES" | "HISTORY_CONSUMER_NOT_DEPENDENT"
  | "HISTORY_PERSISTENCE_MISMATCH" | "COMMIT_POLICY_MISSING" | "MAIN_COMMIT_RACE" | "PUSH_WITHOUT_REBASE";

export interface Issue { severity: "ERROR" | "WARN" | "INFO"; code: IssueCode; jobs: string[]; message: string }

/** Takvimde kendiliginden kosan is: ACTIVE ya da GATED (bayrak acilinca kosacak) ve cron'u var. */
const isScheduledLive = (j: Job) => (j.state === "ACTIVE" || j.state === "GATED") && !!j.cron;
/** Kotayi harcayabilen is: DISABLED/PLANNED harcamaz; dispatch isleri elle de olsa harcar. */
const canSpend = (j: Job) => j.state === "ACTIVE" || j.state === "GATED";

/** Bir `writes` girdisinden depo yolunu cikarir: "data/x/*.json (commit, main)" -> "data/x/". artifact:/serbest metin -> null.
 *  Glob (`*`, `<`, `{`) ilk goruldugu yerde yolu keser ve dizin sayar. Yalniz data/, reports/, content/ depo yolu sayilir. */
export function repoPathOf(entry: string): string | null {
  const tok = entry.trim().split(/\s+/)[0] ?? "";
  if (!/^(data|reports|content)\//.test(tok)) return null;
  const parts = tok.split("/").filter(Boolean);
  const k = parts.findIndex((x) => /[*<{]/.test(x));
  const keep = k === -1 ? parts : parts.slice(0, k);
  return keep.join("/") + (k !== -1 || tok.endsWith("/") ? "/" : "");
}
/** Iki yol cakisir mi: ayni yol ya da biri digerinin dizin oneki. */
export const pathsOverlap = (a: string, b: string): boolean => a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
const repoPathsOf = (j: Job): string[] => j.writes.map(repoPathOf).filter((x): x is string => !!x);

export function validateModel(jobs: Job[] = JOBS, pools: QuotaPool[] = QUOTA_POOLS, owners: HistoryOwner[] = HISTORY_OWNERS, requiredHistory: string[] = REQUIRED_HISTORY_PATHS): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], code: IssueCode, ids: string[], message: string) => issues.push({ severity, code, jobs: ids, message });
  const byId = new Map<string, Job>();
  for (const j of jobs) {
    if (byId.has(j.id)) add("ERROR", "DUPLICATE_ID", [j.id], `id tekrar ediyor: ${j.id}`);
    byId.set(j.id, j);
  }
  const poolById = new Map(pools.map((p) => [p.id, p]));

  for (const j of jobs) {
    const scheduled = j.cadence === "daily" || j.cadence === "weekly" || j.cadence === "monthly";
    if (scheduled && !j.cron) add("ERROR", "MISSING_CRON", [j.id], `${j.id}: cadence=${j.cadence} ama cron yok`);
    if (!scheduled && j.cron) add("ERROR", "UNEXPECTED_CRON", [j.id], `${j.id}: cadence=${j.cadence} ama cron var; event/manual isin schedule'u olmaz`);
    if (j.cron && !parseCron(j.cron)) add("ERROR", "BAD_CRON", [j.id], `${j.id}: cron ayristirilamadi: "${j.cron}"`);
    if (j.runner === "github_actions" && !j.workflow) add("ERROR", "MISSING_WORKFLOW", [j.id], `${j.id}: github_actions isi workflow dosyasi adi istiyor`);
    if (j.state === "GATED" && !j.gate) add("ERROR", "GATE_REQUIRED", [j.id], `${j.id}: GATED is kapiyi (gate) yazmali`);
    const expectedLoop: Loop = scheduled ? (j.cadence as Loop) : "on_demand";
    if (j.loop !== expectedLoop) add("ERROR", "LOOP_MISMATCH", [j.id], `${j.id}: loop=${j.loop} ama cadence=${j.cadence} ${expectedLoop} gerektirir`);
    for (const d of j.depends_on) {
      const dep = byId.get(d);
      if (!dep) add("ERROR", "UNKNOWN_DEPENDENCY", [j.id], `${j.id}: bilinmeyen bagimlilik ${d}`);
      // Canli bir is, hic kosmayacak bir ise bagliysa girdisi hep eksik olur; PLANNED->PLANNED serbest.
      else if ((j.state === "ACTIVE") && (dep.state === "PLANNED" || dep.state === "DISABLED"))
        add("WARN", "DEPENDENCY_NOT_LIVE", [j.id, d], `${j.id} ACTIVE ama ${d} ${dep.state}`);
    }
    if (j.quota_cost) {
      if (!poolById.has(j.quota_cost.pool)) add("ERROR", "UNKNOWN_POOL", [j.id], `${j.id}: tanimsiz kota havuzu ${j.quota_cost.pool}`);
      if (j.quota_cost.per_site !== j.api_calls_per_site) add("ERROR", "QUOTA_MISMATCH", [j.id], `${j.id}: quota_cost.per_site ile api_calls_per_site ayni olmali (tek gercek)`);
    }
  }

  // Havuz bazli: kopya zamanlayici + toplam butce.
  for (const p of pools) {
    const users = jobs.filter((j) => j.quota_cost?.pool === p.id && canSpend(j));
    const scheduledUsers = users.filter((j) => isScheduledLive(j) && j.cadence === "daily");
    if (scheduledUsers.length >= 2) {
      add("ERROR", "DUPLICATE_SCHEDULER", scheduledUsers.map((j) => j.id),
        `${p.id}: ${scheduledUsers.length} gunluk zamanlayici ayni havuzu tuketiyor (${scheduledUsers.map((j) => `${j.id}[${j.state}]`).join(", ")}); cutover bitince biri kapanmali`);
    }
    // Toplam: yalniz sayisi bilinen maliyetler toplanir. UNKNOWN varsa toplam "en az" olur ve
    // bu, tavan asildi demek icin yeterli kanittir ama "tavanin altinda" demek icin DEGILDIR.
    let known = 0, unknownCount = 0;
    for (const j of users) { const v = j.quota_cost!.per_site; if (typeof v === "number") known += v; else unknownCount++; }
    if (typeof p.daily_limit === "number") {
      if (known > p.daily_limit) add("ERROR", "QUOTA_OVERBOOKED", users.map((j) => j.id), `${p.id}: en kotu gun ${known} > ${p.daily_limit} ${p.unit}`);
      else if (known >= p.daily_limit * 0.8 && users.length > 1)
        add("WARN", "QUOTA_NEAR_LIMIT", users.map((j) => j.id), `${p.id}: en kotu gun ${known}/${p.daily_limit} ${p.unit}${unknownCount ? ` (+${unknownCount} maliyeti UNKNOWN is; gercek toplam daha yuksek olabilir)` : ""}`);
    }
  }

  // Cakisma: ayni dakika. Ayni havuz/ayni runner ise WARN, aksi INFO (FP onleme: farkli kaynaklar
  // ayni dakikada sorunsuz kosar; yine de gorunur kalsin).
  const live = jobs.filter(isScheduledLive).filter((j) => parseCron(j.cron!));
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
    const A = live[a], B = live[b];
    const sa = fireSlots(A.cron!), shared = [...fireSlots(B.cron!)].filter((s) => sa.has(s));
    if (!shared.length) continue;
    const samePool = !!A.quota_cost && A.quota_cost.pool === B.quota_cost?.pool;
    const sameRunnerHost = A.runner !== "github_actions" && A.runner === B.runner;
    // Ikisi de main'e commit ediyorsa ve gruplari farkliysa ayni dakikada push yarisi gercektir (zararsiz degil).
    const commitRace = !!A.commits_to_main && !!B.commits_to_main && A.commit_group !== B.commit_group;
    add(samePool || sameRunnerHost || commitRace ? "WARN" : "INFO", "SCHEDULE_COLLISION", [A.id, B.id],
      `${A.id} ve ${B.id} ayni dakikada tetikleniyor (${shared[0]}${shared.length > 1 ? ` +${shared.length - 1}` : ""})${samePool ? "; ayni kota havuzu" : sameRunnerHost ? "; ayni runner" : commitRace ? "; ikisi de main'e commit ediyor, commit gruplari farkli (push yarisi)" : "; farkli kaynaklar, zararsiz"}`);
  }

  // ---- Tarihce sahipligi: TEK yazar + zincir bütünlüğü ------------------------------------------------------------
  const writers = jobs.filter((j) => j.state !== "DISABLED"); // PLANNED dahil: tasarim asamasinda yakalamak ucuz, sonradan pahali
  for (let a = 0; a < writers.length; a++) for (let b = a + 1; b < writers.length; b++) {
    const hit = repoPathsOf(writers[a]).flatMap((pa) => repoPathsOf(writers[b]).filter((pb) => pathsOverlap(pa, pb)).map((pb) => (pa.length >= pb.length ? pa : pb)));
    if (hit.length) add("ERROR", "MULTI_WRITER", [writers[a].id, writers[b].id], `${[...new Set(hit)].join(", ")}: iki is ayni yola yazamaz (${writers[a].id}, ${writers[b].id}); tek yazar, digerleri salt-okunur tuketici olmali`);
  }
  const ownerByPath = new Map<string, HistoryOwner>();
  for (const o of owners) {
    if (ownerByPath.has(o.path)) add("ERROR", "HISTORY_DUPLICATE_PATH", [o.owner_job, ownerByPath.get(o.path)!.owner_job], `${o.path}: iki sahip kaydi var; tarihce yolunun tek sahibi olur`);
    ownerByPath.set(o.path, o);
    if (!o.measurement_module.trim() || !o.schema.trim() || !o.owner_job.trim() || !o.producer_ref.trim())
      add("ERROR", "HISTORY_CHAIN_INCOMPLETE", [o.owner_job], `${o.path}: zincir halkasi bos (olcum modulu -> cikti sema -> sahip -> kalicilik -> tuketim)`);
    if (o.consumers.length === 0 && o.scorecard_dimensions.length > 0) add("ERROR", "HISTORY_CHAIN_INCOMPLETE", [o.owner_job], `${o.path}: scorecard boyutu var ama tuketici is yok`);
    if (o.consumers.length > 0 && o.scorecard_dimensions.length === 0) add("ERROR", "HISTORY_CHAIN_INCOMPLETE", [o.owner_job], `${o.path}: tuketici var ama hangi scorecard boyutunu besledigi yazili degil`);
    const owner = byId.get(o.owner_job);
    if (!owner) { add("ERROR", "HISTORY_OWNER_UNKNOWN_JOB", [o.owner_job], `${o.path}: sahip is modelde yok (${o.owner_job})`); continue; }
    if (!repoPathsOf(owner).some((w) => pathsOverlap(w, o.path))) add("ERROR", "HISTORY_OWNER_NOT_WRITER", [owner.id], `${o.path}: sahip ${owner.id} bu yolu writes'inda tasimiyor`);
    if (o.persistence === "commit_main" && !owner.commits_to_main) add("ERROR", "HISTORY_PERSISTENCE_MISMATCH", [owner.id], `${o.path}: kalicilik commit_main ama ${owner.id} commits_to_main degil`);
    if (o.persistence === "artifact_only" && owner.commits_to_main) add("ERROR", "HISTORY_PERSISTENCE_MISMATCH", [owner.id], `${o.path}: kalicilik artifact_only ama ${owner.id} main'e commit ediyor`);
    for (const c of o.consumers) {
      const cj = byId.get(c);
      if (!cj) { add("ERROR", "HISTORY_OWNER_UNKNOWN_JOB", [c], `${o.path}: tuketici is modelde yok (${c})`); continue; }
      // Tuketici hicbir depo yoluna yazmaz ve commit etmez: aksi halde "salt-okunur tuketici" iddiasi bos kalir.
      if (repoPathsOf(cj).length || cj.commits_to_main) add("ERROR", "HISTORY_CONSUMER_WRITES", [c, owner.id], `${c}: ${o.path} tuketicisi depoya yazamaz/commit edemez (yazdigi: ${repoPathsOf(cj).join(", ") || "commits_to_main"})`);
      if (!cj.depends_on.includes(o.owner_job)) add("ERROR", "HISTORY_CONSUMER_NOT_DEPENDENT", [c, o.owner_job], `${c}: ${o.path} tuketicisi sahibine (${o.owner_job}) depends_on ile baglanmali`);
    }
  }
  for (const r of requiredHistory) if (!ownerByPath.has(r)) add("ERROR", "HISTORY_PATH_REQUIRED_MISSING", [], `${r}: tarihce yolunun sahip kaydi yok`);
  for (const j of writers) for (const w of repoPathsOf(j)) {
    const hitOwner = owners.find((o) => pathsOverlap(o.path, w));
    if (w.startsWith("data/") && !hitOwner) add("ERROR", "HISTORY_UNREGISTERED_WRITE", [j.id], `${j.id}: ${w} data/ altina yaziyor ama HISTORY_OWNERS kaydi yok`);
    else if (hitOwner && hitOwner.owner_job !== j.id) add("ERROR", "HISTORY_WRITER_NOT_OWNER", [j.id, hitOwner.owner_job], `${j.id}: ${hitOwner.path} yolunun sahibi ${hitOwner.owner_job}; ${j.id} yazamaz`);
  }

  // ---- main'e yazma: commit politikasi + yaris ---------------------------------------------------------------------
  for (const j of jobs) {
    const saysCommit = j.writes.some((w) => /\(commit, main\)/.test(w));
    if (saysCommit && !j.commits_to_main) add("ERROR", "COMMIT_POLICY_MISSING", [j.id], `${j.id}: writes "(commit, main)" diyor ama commits_to_main isaretli degil`);
    if (j.commits_to_main && (!j.commit_group || !j.push_strategy)) add("ERROR", "COMMIT_POLICY_MISSING", [j.id], `${j.id}: commits_to_main ise commit_group ve push_strategy zorunlu`);
    if (j.commits_to_main && !repoPathsOf(j).length) add("ERROR", "COMMIT_POLICY_MISSING", [j.id], `${j.id}: commits_to_main ama writes'ta depo yolu yok`);
  }
  const committers = jobs.filter((j) => j.state !== "DISABLED" && j.commits_to_main && j.commit_group);
  const isLive = (j: Job) => j.state === "ACTIVE" || j.state === "GATED";
  for (let a = 0; a < committers.length; a++) for (let b = a + 1; b < committers.length; b++) {
    const A = committers[a], B = committers[b];
    if (A.commit_group === B.commit_group) continue;
    add(isLive(A) && isLive(B) ? "WARN" : "INFO", "MAIN_COMMIT_RACE", [A.id, B.id],
      `${A.id} (grup ${A.commit_group}) ve ${B.id} (grup ${B.commit_group}) main'e farkli concurrency gruplariyla commit ediyor; ayni anda push yarisi olabilir. Oneri: commit adimlari ortak "${TARGET_COMMIT_GROUP}" grubunda`);
  }
  for (const j of committers) {
    if (j.push_strategy !== "plain_push") continue;
    const others = committers.filter((o) => o.id !== j.id);
    if (!others.length) continue;
    add(isLive(j) ? "WARN" : "ERROR", "PUSH_WITHOUT_REBASE", [j.id, ...others.map((o) => o.id)],
      `${j.id}: push oncesi pull --rebase yok; baska commit eden is (${others.map((o) => o.id).join(", ")}) arada main'e yazarsa push non-fast-forward ile reddedilir ve rapor/tarihce kaybolur`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Workflow dosyasi <-> model uzlasmasi (test bunu gercek dosyalarla cagirir)
// ---------------------------------------------------------------------------

/** YAML ayristirici yok (sifir bagimlilik). Yalniz `on:` blogunun `schedule:` altindaki `- cron: "..."` satirlari
 *  okunur; yorum satirlari atlanir cunku yorumdaki ornek cron'u gercek sanmak yanlis alarm olurdu. */
export function extractWorkflowCrons(yaml: string): string[] {
  const out: string[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "");
    const m = line.match(/^\s*-?\s*cron:\s*["']([^"']+)["']/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export interface DriftIssue {
  workflow: string;
  kind: "SCHEDULE_NOT_IN_MODEL" | "MODEL_CRON_NOT_IN_WORKFLOW" | "WORKFLOW_NOT_IN_MODEL" | "GATE_NOT_IN_WORKFLOW"
    | "COMMIT_NOT_IN_MODEL" | "MODEL_COMMIT_NOT_IN_WORKFLOW" | "PUSH_STRATEGY_DRIFT" | "CONCURRENCY_NOT_IN_WORKFLOW" | "GIT_ADD_NOT_IN_MODEL";
  detail: string;
}

const codeLines = (yaml: string): string[] => yaml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
/** Workflow'un ust duzey `concurrency:` blogundaki group degeri (yoksa null). */
export function extractConcurrencyGroup(yaml: string): string | null {
  const m = codeLines(yaml).join("\n").match(/^concurrency:\s*\n\s+group:\s*([^\n]+)/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}
/** Ilk push'tan ONCE pull --rebase var mi. push yoksa null (workflow main'e yazmiyor). Yorum satirlari sayilmaz. */
export function extractPushStrategy(yaml: string): "rebase_then_push" | "plain_push" | null {
  const L = codeLines(yaml);
  const push = L.findIndex((l) => /\bgit push\b/.test(l));
  if (push === -1) return null;
  const rebase = L.findIndex((l) => /\bgit pull\s+--rebase\b/.test(l));
  return rebase !== -1 && rebase <= push ? "rebase_then_push" : "plain_push";
}
/** `git add <yollar>` ile stage edilen depo yollari (bayraklar atlanir). */
export function extractGitAddPaths(yaml: string): string[] {
  const out: string[] = [];
  for (const l of codeLines(yaml)) for (const m of l.matchAll(/\bgit add\s+([^;&|\n]+)/g)) for (const t of m[1].trim().split(/\s+/)) if (t && !t.startsWith("-")) out.push(t);
  return out;
}

/** workflows: dosya adi -> icerik. Model ACTIVE/GATED github_actions islerini karsilastirir.
 *  PLANNED isler workflow'da olmak zorunda degil; DISABLED isin cron'u workflow'da kalabilir (ayri karar). */
export function diffWorkflows(workflows: Record<string, string>, jobs: Job[] = JOBS): DriftIssue[] {
  const out: DriftIssue[] = [];
  const modelFor = (wf: string) => jobs.filter((j) => j.runner === "github_actions" && j.workflow === wf);
  for (const [wf, text] of Object.entries(workflows)) {
    const mj = modelFor(wf);
    if (!mj.length) { out.push({ workflow: wf, kind: "WORKFLOW_NOT_IN_MODEL", detail: "workflow dosyasinin modelde isi yok" }); continue; }
    const modelCrons = new Set(mj.filter((j) => j.cron).map((j) => j.cron!));
    for (const c of extractWorkflowCrons(text)) if (!modelCrons.has(c)) out.push({ workflow: wf, kind: "SCHEDULE_NOT_IN_MODEL", detail: `cron "${c}" modelde yok` });
    const wfCrons = new Set(extractWorkflowCrons(text));
    // Yazma drift'i: workflow'un commit/stage ettigi yer modelde yoksa tek-yazar kaydi gercegi yansitmiyor demektir.
    const live = mj.filter((j) => j.state !== "PLANNED");
    const push = extractPushStrategy(text);
    const committers = live.filter((j) => j.commits_to_main);
    if (push && !committers.length) out.push({ workflow: wf, kind: "COMMIT_NOT_IN_MODEL", detail: "workflow git push ediyor ama modelde commits_to_main isi yok" });
    if (!push && committers.length) out.push({ workflow: wf, kind: "MODEL_COMMIT_NOT_IN_WORKFLOW", detail: `${committers.map((j) => j.id).join(", ")}: model main'e commit ediyor diyor, workflow'da git push yok` });
    const group = extractConcurrencyGroup(text);
    for (const j of committers) {
      if (push && j.push_strategy !== push) out.push({ workflow: wf, kind: "PUSH_STRATEGY_DRIFT", detail: `${j.id}: model ${String(j.push_strategy)}, workflow ${push}` });
      if (j.commit_group !== group) out.push({ workflow: wf, kind: "CONCURRENCY_NOT_IN_WORKFLOW", detail: `${j.id}: model commit_group "${String(j.commit_group)}", workflow "${String(group)}"` });
    }
    const modelPaths = live.flatMap(repoPathsOf);
    for (const a of extractGitAddPaths(text)) {
      const ap = repoPathOf(a) ?? (a.includes("/") || a.includes(".") ? a : null);
      if (ap && !modelPaths.some((m) => pathsOverlap(m, ap))) out.push({ workflow: wf, kind: "GIT_ADD_NOT_IN_MODEL", detail: `git add ${a}: modelde bu yola yazan is yok` });
    }
    for (const j of mj) {
      if (j.state !== "PLANNED" && j.cron && !wfCrons.has(j.cron)) out.push({ workflow: wf, kind: "MODEL_CRON_NOT_IN_WORKFLOW", detail: `${j.id}: model cron "${j.cron}" workflow'da yok` });
      if (j.state === "GATED" && j.gate && j.runner === "github_actions" && !text.includes(j.gate)) out.push({ workflow: wf, kind: "GATE_NOT_IN_WORKFLOW", detail: `${j.id}: kapi "${j.gate}" workflow'da yok` });
    }
  }
  return out;
}

export function modelToMarkdown(jobs: Job[] = JOBS, issues: Issue[] = validateModel(jobs), owners: HistoryOwner[] = HISTORY_OWNERS): string {
  const L = ["# Orkestrasyon modeli", "", "| Dongu | Is | Cadence/cron (UTC) | Runner | Durum | Kota | Yazar |", "|---|---|---|---|---|---|---|"];
  for (const j of jobs) L.push(`| ${j.loop} | ${j.id} | ${j.cron ?? j.cadence} | ${j.runner}${j.workflow ? `:${j.workflow}` : ""} | ${j.state} | ${j.quota_cost ? `${j.quota_cost.pool} ${j.quota_cost.per_site}/site` : "-"} | ${j.writes.join("; ") || "salt-okunur"} |`);
  L.push("", "## Tarihce sahipligi (olcum modulu -> cikti -> sahip -> kalicilik -> scorecard)", "",
    "| Yol | Olcum modulu | Cikti sema | TEK yazar | Kalicilik | Tuketici -> boyut | Uretici |", "|---|---|---|---|---|---|---|");
  for (const o of owners) L.push(`| ${o.path} | ${o.measurement_module} | ${o.schema} | ${o.owner_job} | ${o.persistence} | ${o.consumers.length ? `${o.consumers.join(",")} -> ${o.scorecard_dimensions.join(",")}` : "(okunmuyor)"} | ${o.producer_ref} |`);
  L.push("", "## Dogrulayici bulgulari", "");
  if (!issues.length) L.push("Bulgu yok.");
  for (const i of issues) L.push(`- **${i.severity}** \`${i.code}\` (${i.jobs.join(", ")}): ${i.message}`);
  return L.join("\n") + "\n";
}
