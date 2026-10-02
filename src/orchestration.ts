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
}

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
    writes: ["reports/ (commit, main)", "artifact:measure-<run_id>"], depends_on: [], note: "GSC + GA4; commit adimi yalniz schedule veya commit_report ile." },
  { id: "search-audit", loop: "weekly", cadence: "weekly", cron: "40 6 * * 1", runner: "github_actions", workflow: "search-audit.yml",
    api_calls_per_site: 0, quota_cost: null, state: "ACTIVE", writes: ["artifact:search-audit-<site>-<run_id>"], depends_on: [],
    note: "Salt-okunur HTTP taramasi (pilot site). measure ile ayni dakika: farkli havuz, bilinen ve zararsiz cakisma." },

  // ---------------- daily ----------------
  { id: "clarity-daily", loop: "daily", cadence: "daily", cron: "20 7 * * *", runner: "github_actions", workflow: "clarity-daily.yml",
    api_calls_per_site: 3, quota_cost: { pool: "clarity-project", per_site: 3 }, state: "GATED",
    gate: "vars.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'",
    writes: ["data/clarity-history/*.json (commit, main)", "artifact:clarity-daily-<run_id>"], depends_on: [],
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
    api_calls_per_site: "UNKNOWN", quota_cost: null, state: "PLANNED", writes: ["data/performance-history/*.json"], depends_on: [],
    note: "Planli saat oneri; workflow olusunca model guncellenir." },
  { id: "index-alarms-daily", loop: "daily", cadence: "daily", cron: "40 7 * * *", runner: "github_actions", workflow: "index-alarms.yml",
    api_calls_per_site: "UNKNOWN", quota_cost: { pool: "gsc-url-inspection", per_site: "UNKNOWN" }, state: "PLANNED",
    writes: ["data/index-history/*.json"], depends_on: [], note: "Kota kullanimi olculene kadar UNKNOWN." },
  { id: "deployment-verifier", loop: "on_demand", cadence: "event", runner: "github_actions", workflow: "deployment-verifier.yml",
    api_calls_per_site: 0, quota_cost: null, state: "PLANNED", writes: ["data/deployment-timeline/*.json"], depends_on: [],
    note: "Deploy olayinda tetiklenir; cron'u yok." },
  { id: "scorecard-weekly", loop: "weekly", cadence: "weekly", cron: "10 8 * * 1", runner: "github_actions", workflow: "scorecard.yml",
    api_calls_per_site: 0, quota_cost: null, state: "PLANNED", writes: ["reports/scorecard-<tarih>.{json,md}"],
    depends_on: ["measure", "clarity-daily", "lighthouse-weekly", "index-alarms-daily", "deployment-verifier"],
    note: "Yalniz artifact dosyalarini okur; ag yok. Monthly dongude henuz is tanimli degil (uydurma is eklenmedi)." },
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
  | "DUPLICATE_SCHEDULER" | "QUOTA_OVERBOOKED" | "QUOTA_NEAR_LIMIT" | "SCHEDULE_COLLISION" | "LOOP_MISMATCH";

export interface Issue { severity: "ERROR" | "WARN" | "INFO"; code: IssueCode; jobs: string[]; message: string }

/** Takvimde kendiliginden kosan is: ACTIVE ya da GATED (bayrak acilinca kosacak) ve cron'u var. */
const isScheduledLive = (j: Job) => (j.state === "ACTIVE" || j.state === "GATED") && !!j.cron;
/** Kotayi harcayabilen is: DISABLED/PLANNED harcamaz; dispatch isleri elle de olsa harcar. */
const canSpend = (j: Job) => j.state === "ACTIVE" || j.state === "GATED";

export function validateModel(jobs: Job[] = JOBS, pools: QuotaPool[] = QUOTA_POOLS): Issue[] {
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
    add(samePool || sameRunnerHost ? "WARN" : "INFO", "SCHEDULE_COLLISION", [A.id, B.id],
      `${A.id} ve ${B.id} ayni dakikada tetikleniyor (${shared[0]}${shared.length > 1 ? ` +${shared.length - 1}` : ""})${samePool ? "; ayni kota havuzu" : sameRunnerHost ? "; ayni runner" : "; farkli kaynaklar, zararsiz"}`);
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

export interface DriftIssue { workflow: string; kind: "SCHEDULE_NOT_IN_MODEL" | "MODEL_CRON_NOT_IN_WORKFLOW" | "WORKFLOW_NOT_IN_MODEL" | "GATE_NOT_IN_WORKFLOW"; detail: string }

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
    for (const j of mj) {
      if (j.state !== "PLANNED" && j.cron && !wfCrons.has(j.cron)) out.push({ workflow: wf, kind: "MODEL_CRON_NOT_IN_WORKFLOW", detail: `${j.id}: model cron "${j.cron}" workflow'da yok` });
      if (j.state === "GATED" && j.gate && j.runner === "github_actions" && !text.includes(j.gate)) out.push({ workflow: wf, kind: "GATE_NOT_IN_WORKFLOW", detail: `${j.id}: kapi "${j.gate}" workflow'da yok` });
    }
  }
  return out;
}

export function modelToMarkdown(jobs: Job[] = JOBS, issues: Issue[] = validateModel(jobs)): string {
  const L = ["# Orkestrasyon modeli", "", "| Dongu | Is | Cadence/cron (UTC) | Runner | Durum | Kota | Yazar |", "|---|---|---|---|---|---|---|"];
  for (const j of jobs) L.push(`| ${j.loop} | ${j.id} | ${j.cron ?? j.cadence} | ${j.runner}${j.workflow ? `:${j.workflow}` : ""} | ${j.state} | ${j.quota_cost ? `${j.quota_cost.pool} ${j.quota_cost.per_site}/site` : "-"} | ${j.writes.join("; ") || "salt-okunur"} |`);
  L.push("", "## Dogrulayici bulgulari", "");
  if (!issues.length) L.push("Bulgu yok.");
  for (const i of issues) L.push(`- **${i.severity}** \`${i.code}\` (${i.jobs.join(", ")}): ${i.message}`);
  return L.join("\n") + "\n";
}
