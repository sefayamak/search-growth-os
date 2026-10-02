// GitHub-first devir / durum denetimi (read-only).
//
// NEDEN VAR: bu proje farklı bilgisayarlarda ve sıfır bağlamlı Claude oturumlarında sürdürülüyor. Yerel checkout hiçbir
// zaman kendiliğinden otorite değildir: eski olabilir, kirli olabilir, yanlış dalda olabilir, hatta başka bir depoya
// (ör. PAM CRM / ST10) ait olabilir. Bu modül yerel durumu uzak GitHub durumuyla karşılaştırıp SINIFLANDIRIR ve ne
// yapılmaması gerektiğini söyler. Hiçbir şeyi DEĞİŞTİRMEZ.
//
// YAPMAZ: merge, pull, reset, checkout, rebase, push, clean, stash, workflow dispatch, secret okuma, üretim çağrısı.
// Uzak doğrulama yalnız AÇIK `remote: true` ile yapılır ve yalnız `git fetch origin <canonical>` çalıştırır
// (yalnız refs/remotes/origin/<canonical> güncellenir; çalışma ağacına/dallara dokunmaz). Varsayılan: yalnız yerel inceleme.
//
// Dosya sistemi/git dışında ağ yok; `gh` yalnız `remote: true` iken ve yalnız `gh pr list` (salt-okunur) için çağrılır.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const EXPECTED_REPOSITORY = "sefayamak/search-growth-os";
export const CANONICAL_BRANCH = "main";
export const HANDOFF_SCHEMA = "sgos.handoff-state.v1" as const;
export const STATE_JSON = "docs/operations/current-state.json";
export const STATE_MD = "docs/operations/CURRENT_STATE.md";
/** state_based_on_main_sha'dan sonra YALNIZ bu yollar değiştiyse state "bayat" sayılmaz: devir dosyalarını/aracını ekleyen commit
 *  kendi sha'sını yazamaz (kendine referans); bunlar ölçüm/işlem durumunu değiştirmez. */
export const HANDOFF_PATHS = ["docs/operations/", "bin/project-status.ts", "src/project-status.ts", "scripts/project-status.sh", "schemas/handoff-state.schema.json", "tests/project-status.test.ts", "CLAUDE.md"];
const isHandoffPath = (f: string) => HANDOFF_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));

export type Status =
  | "CLEAN_SYNCED" | "BEHIND_REMOTE" | "AHEAD_REMOTE" | "DIVERGED" | "DIRTY" | "WRONG_BRANCH"
  | "WRONG_REPOSITORY" | "GIT_OBJECT_ERROR" | "REMOTE_UNREACHABLE" | "UNKNOWN";

/** Bu durumlarda otomatik devam EDİLMEZ (CLI exit 1). */
export const STOP_STATUSES: ReadonlySet<Status> = new Set<Status>(["WRONG_REPOSITORY", "GIT_OBJECT_ERROR", "REMOTE_UNREACHABLE", "UNKNOWN"]);

export type Condition =
  | "DIRTY" | "UNMERGED_PATHS" | "WRONG_BRANCH" | "DIVERGED" | "BEHIND_REMOTE" | "AHEAD_REMOTE"
  | "STALE_STATE_FILE" | "STATE_FILE_MISSING" | "STATE_FILE_INVALID" | "REMOTE_NOT_VERIFIED";

/** Her durumda geçerli yasaklar: yerel state'i sessizce "düzeltmeye" çalışan otomatik eylemler. */
export const NEVER_AUTOMATIC = [
  "git pull / merge / rebase / reset / checkout / clean / stash ile yerel durumu otomatik 'düzeltmek'",
  "kirli (uncommitted) çalışmayı silmek, sıfırlamak, üstüne yazmak",
  "Clarity/GSC/GA4/PSI/Brain/Index Probe canlı çağrısı, workflow dispatch",
  "legacy kapatma, credential rotasyonu/iptali, SEARCH_GROWTH_CLARITY_DAILY_ENABLED değişikliği, schedule açma",
  "üretim sitesine yazma; feature PR merge (owner onayı olmadan)",
] as const;

export interface PrSummary { state: "OK" | "UNKNOWN"; reason?: string; prs?: Array<{ number: number; title: string; draft: boolean; head: string; base: string }> }

export interface StateFileInfo {
  json: "OK" | "MISSING" | "INVALID";
  json_errors: string[];
  md: "OK" | "MISSING";
  freshness: "FRESH" | "FRESH_HANDOFF_ONLY" | "STALE_STATE_FILE" | "UNKNOWN";
  freshness_reason: string;
  state_based_on_main_sha: string | null;
  hold_prs: number[];
  owner_gates: string[];
  next_action: unknown;
  phase: unknown;
}

export interface StatusReport {
  status: Status;
  conditions: Condition[];
  stop: boolean;
  reasons: string[];
  repository: { expected: string; origin_url_redacted: string | null; slug: string | null; matches: boolean };
  branch: { current: string | null; canonical: string; is_canonical: boolean };
  local: { head: string | null; local_main: string | null };
  remote: { verified: boolean; basis: "FETCHED_LIVE" | "LOCAL_TRACKING_REF" | "NONE"; main_sha: string | null; error?: string };
  relation: { ahead: number | null; behind: number | null };
  working_tree: { dirty: boolean; modified: number; untracked: number; unmerged: number };
  git_health: { ok: boolean; problems: string[] };
  state_file: StateFileInfo | null;
  pull_requests: PrSummary;
  workflows: Array<{ file: string; name: string | null; cron: string[] }>;
  next_safe_action: string;
  never_automatic: readonly string[];
}

export interface InspectOptions {
  cwd: string;
  /** Açık bayrak: `git fetch origin main` + `gh pr list`. Varsayılan false (yalnız yerel). */
  remote?: boolean;
  expectedRepo?: string;
  /** git fsck çalıştır (varsayılan true). */
  fsck?: boolean;
  /** gh ile PR özeti (yalnız remote iken; varsayılan true). */
  gh?: boolean;
}

// --- yardımcılar -------------------------------------------------------------------------------------------------
function git(cwd: string, args: string[], timeoutMs = 60_000) {
  // GIT_OPTIONAL_LOCKS=0: `git status` indeksi yeniden yazmasın (salt-okunur kalsın). GIT_TERMINAL_PROMPT=0: kimlik sorma.
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  return { code: r.status ?? (r.error ? 127 : 1), out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** URL içindeki kimlik bilgisini (user:pass@ / token@) maskeler: çıktıya asla credential girmesin. */
export function redactUrl(u: string): string {
  return u.replace(/\/\/[^@/\s]*@/g, "//***@");
}

/** `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `http://x@127.0.0.1:1/git/o/r`, `/yerel/yol/o/r.git` -> `o/r`. */
export function repoSlug(url: string): string | null {
  const m = /[/:]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

/** Değer benzeri (secret) dizgeleri bulur; yalnız İSİM/referans serbest, DEĞER değil. Test ve bootstrap kendi kendini tarar. */
export function findSecretLikeValues(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
    ["sk- anahtar", /\bsk-(?!FAKE)[A-Za-z0-9]{20,}/],
    ["Google API anahtarı", /\bAIza[0-9A-Za-z_-]{30,}/],
    ["PEM özel anahtar", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["JSON refresh_token/client_secret değeri", /"(?:refresh_token|client_secret|private_key|access_token)"\s*:\s*"[^"\s]{12,}"/],
    ["URL içinde kimlik bilgisi", /\/\/[^/\s:@]+:[^/\s@]{6,}@/],
    ["DB parolası", /(?:password|passwd|pwd)\s*[=:]\s*[^\s"'<>]{8,}/i],
  ];
  const hits: string[] = [];
  for (const [label, re] of rules) if (re.test(text)) hits.push(label);
  return hits;
}

const SHA = /^[0-9a-f]{40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** sgos.handoff-state.v1 doğrulayıcısı (schemas/handoff-state.schema.json ile aynı kurallar; bağımlılık yok). */
export function validateHandoffState(raw: unknown): string[] {
  const e: string[] = [];
  if (!isObj(raw)) return ["kök nesne değil"];
  if (raw.schema !== HANDOFF_SCHEMA) e.push(`schema ${HANDOFF_SCHEMA} olmalı`);
  if (typeof raw.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(raw.repository)) e.push("repository 'owner/repo' olmalı");
  if (typeof raw.canonical_branch !== "string" || !raw.canonical_branch) e.push("canonical_branch yok");
  if (typeof raw.state_based_on_main_sha !== "string" || !SHA.test(raw.state_based_on_main_sha)) e.push("state_based_on_main_sha 40 haneli sha olmalı");
  if (typeof raw.generated_at !== "string" || Number.isNaN(Date.parse(raw.generated_at))) e.push("generated_at ISO tarih olmalı");
  for (const k of ["phase", "migration", "schedules", "credentials", "next_action"] as const) if (!isObj(raw[k]) && !(k === "schedules" && Array.isArray(raw[k]))) e.push(`${k} nesne olmalı`);
  for (const k of ["open_prs", "hold_prs", "merged_capabilities", "owner_gates", "known_risks"] as const) if (!Array.isArray(raw[k])) e.push(`${k} dizi olmalı`);
  if (Array.isArray(raw.hold_prs) && !raw.hold_prs.every((n) => Number.isInteger(n))) e.push("hold_prs tamsayı dizisi olmalı");
  if (Array.isArray(raw.open_prs)) {
    for (const p of raw.open_prs) if (!isObj(p) || !Number.isInteger(p.number) || typeof p.title !== "string" || typeof p.hold !== "boolean") e.push("open_prs girdisi {number,title,hold} içermeli");
  }
  const mig = isObj(raw.migration) ? raw.migration : {};
  if (!isObj(mig.clarity)) e.push("migration.clarity yok");
  if (!isObj(mig.legacy)) e.push("migration.legacy yok");
  const cred = isObj(raw.credentials) ? raw.credentials : {};
  for (const [name, c] of Object.entries(cred)) {
    if (!isObj(c)) { e.push(`credentials.${name} nesne olmalı`); continue; }
    if (!["true", "false", "UNKNOWN"].includes(String(c.configured))) e.push(`credentials.${name}.configured true/false/"UNKNOWN" olmalı`);
    if (typeof c.rotation_pending !== "boolean") e.push(`credentials.${name}.rotation_pending boolean olmalı`);
    // DEĞER alanı yasak: yalnız metadata.
    for (const k of Object.keys(c)) if (!["configured", "rotation_pending", "secret_names", "note", "basis"].includes(k)) e.push(`credentials.${name}.${k} izinli değil (yalnız metadata)`);
  }
  const hits = findSecretLikeValues(JSON.stringify(raw));
  if (hits.length) e.push(`secret benzeri değer bulundu: ${hits.join(", ")}`);
  return e;
}

function workflowsOf(cwd: string): StatusReport["workflows"] {
  const dir = join(cwd, ".github/workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((file) => {
    const t = readFileSync(join(dir, file), "utf8");
    const name = /^name:\s*(.+?)\s*$/m.exec(t)?.[1]?.replace(/^["']|["']$/g, "") ?? null;
    const cron = [...t.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    return { file, name, cron };
  });
}

function stateFiles(cwd: string, remoteSha: string | null): StateFileInfo {
  const jsonPath = join(cwd, STATE_JSON);
  const md: StateFileInfo["md"] = existsSync(join(cwd, STATE_MD)) ? "OK" : "MISSING";
  const base: StateFileInfo = { json: "MISSING", json_errors: [], md, freshness: "UNKNOWN", freshness_reason: "", state_based_on_main_sha: null, hold_prs: [], owner_gates: [], next_action: null, phase: null };
  if (!existsSync(jsonPath)) return { ...base, freshness_reason: `${STATE_JSON} yok` };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(jsonPath, "utf8")); } catch (x) { return { ...base, json: "INVALID", json_errors: [`JSON ayrıştırılamadı: ${(x as Error).message}`], freshness_reason: "dosya geçersiz" }; }
  const errs = validateHandoffState(raw);
  if (errs.length) return { ...base, json: "INVALID", json_errors: errs, freshness_reason: "dosya geçersiz" };
  const s = raw as Record<string, unknown>;
  const sha = s.state_based_on_main_sha as string;
  const info: StateFileInfo = {
    ...base, json: "OK", state_based_on_main_sha: sha, hold_prs: s.hold_prs as number[],
    owner_gates: (s.owner_gates as unknown[]).map((g) => (isObj(g) ? String(g.action ?? g.id ?? "") : String(g))),
    next_action: s.next_action, phase: s.phase,
  };
  if (!remoteSha) return { ...info, freshness: "UNKNOWN", freshness_reason: "uzak main sha'sı yok; tazelik karşılaştırılamadı" };
  if (sha === remoteSha) return { ...info, freshness: "FRESH", freshness_reason: "state_based_on_main_sha == uzak main" };
  // Devir dosyasını ekleyen/güncelleyen commit kendi sha'sını yazamaz (kendine referans). Bu yüzden state, main'in KENDİSİNDEN
  // sonra yalnız docs/operations/ değiştiyse taze sayılır; başka dosya değiştiyse bayat.
  const known = git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).code === 0;
  if (!known) return { ...info, freshness: "STALE_STATE_FILE", freshness_reason: `state_based_on_main_sha (${sha.slice(0, 7)}) yerelde tanınmıyor` };
  const anc = git(cwd, ["merge-base", "--is-ancestor", sha, remoteSha]).code === 0;
  if (!anc) return { ...info, freshness: "STALE_STATE_FILE", freshness_reason: `state_based_on_main_sha (${sha.slice(0, 7)}) uzak main'in atası değil` };
  const changed = git(cwd, ["diff", "--name-only", sha, remoteSha]).out.split("\n").filter(Boolean);
  const outside = changed.filter((f) => !isHandoffPath(f));
  if (outside.length === 0) return { ...info, freshness: "FRESH_HANDOFF_ONLY", freshness_reason: `main yalnız devir dosyaları/aracı kadar ilerledi (${changed.length} dosya)` };
  return { ...info, freshness: "STALE_STATE_FILE", freshness_reason: `state'ten beri ${outside.length} devir-dışı dosya değişti (ör. ${outside[0]})` };
}

function prSummary(cwd: string, expected: string, enabled: boolean): PrSummary {
  if (!enabled) return { state: "UNKNOWN", reason: "uzak doğrulama kapalı (varsayılan); --remote ile ya da GitHub MCP/arayüzü ile okuyun" };
  const r = spawnSync("gh", ["pr", "list", "--repo", expected, "--state", "open", "--json", "number,title,isDraft,headRefName,baseRefName", "--limit", "50"], { cwd, encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return { state: "UNKNOWN", reason: "gh kullanılamadı/erişilemedi; açık PR'ları GitHub MCP veya arayüzünden okuyun (UNKNOWN, 0 değil)" };
  try {
    const arr = JSON.parse(r.stdout) as Array<{ number: number; title: string; isDraft: boolean; headRefName: string; baseRefName: string }>;
    return { state: "OK", prs: arr.map((p) => ({ number: p.number, title: p.title, draft: p.isDraft, head: p.headRefName, base: p.baseRefName })) };
  } catch { return { state: "UNKNOWN", reason: "gh çıktısı ayrıştırılamadı" }; }
}

const NEXT: Record<Status, string> = {
  CLEAN_SYNCED: "Yerel main uzak main ile aynı. docs/operations/current-state.json ve CURRENT_STATE.md'yi oku, açık PR'ları oku, sonra next_action'ı uygula (owner-gated olanlar hariç).",
  BEHIND_REMOTE: "Yerel main uzak main'in GERİSİNDE. Önce çalışma ağacının temiz olduğunu doğrula; güncelleme gerekli (git pull --ff-only ya da taze clone) — bunu araç YAPMAZ, açık bir eylemle sen yap. reset/merge/rebase YOK.",
  AHEAD_REMOTE: "Yerel main uzak main'in İLERİSİNDE (push edilmemiş commit'ler). Silme/reset YOK. Commit'leri incele; push/PR yalnız sahibinin kararıyla.",
  DIVERGED: "Yerel ve uzak AYRIŞMIŞ. Otomatik merge/rebase/reset YOK. İki tarafı incele (git log --oneline --left-right origin/main...HEAD); çözümü owner'la karara bağla.",
  DIRTY: "Commit edilmemiş yerel çalışma VAR. Silme/reset/checkout/clean YOK; çalışma korunur. Önce ne olduğunu incele (git status, git diff); commit/stash kararı owner'ın.",
  WRONG_BRANCH: "Canonical dalda değilsin. Otomatik checkout YOK. Bu dal bilinçli bir iş dalı mı kontrol et; main'e dönmek için çalışmanın güvende olduğundan emin ol.",
  WRONG_REPOSITORY: "DUR. Bu dizin search-growth-os DEĞİL. Başka bir repo bağlamını (pam-crm, ST10, staging DB, Supabase service_role vb.) buraya taşıma. Doğru depoda tekrar çalıştır.",
  GIT_OBJECT_ERROR: "DUR. Git nesne/yapı hatası. DO NOT pull. DO NOT merge. DO NOT rebase. DO NOT reset. Otomatik onarım YOK; onarım ayrı bir owner eylemidir (taze clone + eski dizini yedekle).",
  REMOTE_UNREACHABLE: "DUR. GitHub'a erişilemedi; yerel durum otorite DEĞİL. Bağlantıyı düzelt ve --remote ile tekrar çalıştır; o zamana kadar uzak durumu bilinmiyor say.",
  UNKNOWN: "DUR. Durum sınıflandırılamadı (git deposu değil / origin/main yok). Uzak durumu --remote ile doğrula ya da taze clone al.",
};

export function inspect(opts: InspectOptions): StatusReport {
  const cwd = opts.cwd;
  const expected = opts.expectedRepo ?? EXPECTED_REPOSITORY;
  const remote = opts.remote ?? false;
  const reasons: string[] = [];
  const conditions: Condition[] = [];
  const empty = (status: Status, why: string, extra: Partial<StatusReport> = {}): StatusReport => ({
    status, conditions, stop: STOP_STATUSES.has(status), reasons: [why, ...reasons],
    repository: { expected, origin_url_redacted: null, slug: null, matches: false },
    branch: { current: null, canonical: CANONICAL_BRANCH, is_canonical: false },
    local: { head: null, local_main: null },
    remote: { verified: false, basis: "NONE", main_sha: null },
    relation: { ahead: null, behind: null },
    working_tree: { dirty: false, modified: 0, untracked: 0, unmerged: 0 },
    git_health: { ok: false, problems: [] },
    state_file: null, pull_requests: { state: "UNKNOWN", reason: "denetlenmedi" }, workflows: [],
    next_safe_action: NEXT[status], never_automatic: NEVER_AUTOMATIC, ...extra,
  });

  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).out !== "true") return empty("UNKNOWN", "git çalışma dizini değil");

  // 1) Kimlik: yanlış depoda hiçbir şey okunmaz/önerilmez.
  const originUrl = git(cwd, ["remote", "get-url", "origin"]);
  const url = originUrl.code === 0 ? originUrl.out : null;
  const slug = url ? repoSlug(url) : null;
  const identity = { expected, origin_url_redacted: url ? redactUrl(url) : null, slug, matches: slug === expected };
  if (!identity.matches) return empty("WRONG_REPOSITORY", url ? `origin ${redactUrl(url)} -> '${slug ?? "?"}', beklenen '${expected}'` : "origin remote tanımlı değil", { repository: identity });

  // 2) Git sağlığı: nesne hatasında HİÇBİR başka yola gidilmez.
  const problems: string[] = [];
  const head = git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) problems.push(`git rev-parse HEAD: ${head.err.split("\n")[0] || "başarısız"}`);
  else {
    if (git(cwd, ["cat-file", "-e", `${head.out}^{commit}`]).code !== 0) problems.push("git cat-file: HEAD commit nesnesi okunamadı");
    const lg = git(cwd, ["log", "-1", "--format=%H"]);
    if (lg.code !== 0) problems.push(`git log: ${lg.err.split("\n")[0] || "başarısız"}`);
  }
  if (opts.fsck !== false && problems.length === 0) {
    const f = git(cwd, ["fsck", "--no-dangling", "--no-progress"], 120_000);
    if (f.code !== 0) problems.push(`git fsck: ${(f.err || f.out).split("\n").filter(Boolean).slice(0, 3).join(" | ")}`);
  }
  if (problems.length) return empty("GIT_OBJECT_ERROR", problems.join("; "), { repository: identity, git_health: { ok: false, problems } });

  // 3) Uzak: yalnız açık --remote ile fetch; aksi halde yerel izleme ref'i (DOĞRULANMAMIŞ).
  let remoteBasis: StatusReport["remote"]["basis"] = "LOCAL_TRACKING_REF";
  let remoteError: string | undefined;
  if (remote) {
    const f = git(cwd, ["fetch", "--quiet", "origin", CANONICAL_BRANCH], 90_000);
    if (f.code !== 0) {
      remoteError = (f.err.split("\n")[0] || "git fetch başarısız");
      return empty("REMOTE_UNREACHABLE", `GitHub erişilemedi: ${redactUrl(remoteError)}`, { repository: identity, git_health: { ok: true, problems: [] }, remote: { verified: false, basis: "NONE", main_sha: null, error: redactUrl(remoteError) } });
    }
    remoteBasis = "FETCHED_LIVE";
  } else conditions.push("REMOTE_NOT_VERIFIED");
  const rm = git(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${CANONICAL_BRANCH}`]);
  const remoteSha = rm.code === 0 ? rm.out : null;

  const branchRaw = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchRaw.code === 0 ? branchRaw.out : null; // null = detached HEAD
  const localMain = git(cwd, ["rev-parse", "--verify", `refs/heads/${CANONICAL_BRANCH}`]);

  // 4) Çalışma ağacı
  const st = git(cwd, ["status", "--porcelain"]);
  const lines = st.out.split("\n").filter(Boolean);
  const unmerged = lines.filter((l) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(l)).length;
  const untracked = lines.filter((l) => l.startsWith("??")).length;
  const wt = { dirty: lines.length > 0, modified: lines.length - untracked - unmerged, untracked, unmerged };
  if (wt.dirty) conditions.push("DIRTY");
  if (unmerged) conditions.push("UNMERGED_PATHS");

  // 5) Yerel HEAD <-> uzak main
  let ahead: number | null = null, behind: number | null = null;
  if (remoteSha) {
    const c = git(cwd, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${CANONICAL_BRANCH}`]);
    if (c.code === 0) { const [a, b] = c.out.split(/\s+/).map(Number); ahead = a; behind = b; }
  }
  const onCanonical = branch === CANONICAL_BRANCH;
  if (!onCanonical) conditions.push("WRONG_BRANCH");
  if (ahead !== null && behind !== null) {
    if (ahead > 0 && behind > 0) conditions.push("DIVERGED");
    else if (behind > 0) conditions.push("BEHIND_REMOTE");
    else if (ahead > 0) conditions.push("AHEAD_REMOTE");
  }

  const sf = stateFiles(cwd, remoteSha);
  if (sf.json === "MISSING") conditions.push("STATE_FILE_MISSING");
  if (sf.json === "INVALID") conditions.push("STATE_FILE_INVALID");
  if (sf.freshness === "STALE_STATE_FILE") conditions.push("STALE_STATE_FILE");

  // 6) Birincil durum (öncelik: yerel işi kaybettirebilecek olan en tehlikeli koşul önce)
  let status: Status;
  if (!remoteSha) { status = "UNKNOWN"; reasons.push("refs/remotes/origin/main yok: yerel durum uzakla karşılaştırılamadı (--remote ile doğrula)"); }
  else if (wt.dirty) { status = "DIRTY"; reasons.push(`${wt.modified} değişen, ${wt.untracked} izlenmeyen, ${wt.unmerged} çakışmalı yol`); }
  else if (!onCanonical) { status = "WRONG_BRANCH"; reasons.push(`mevcut dal '${branch ?? "(detached HEAD)"}', canonical '${CANONICAL_BRANCH}'`); }
  else if (conditions.includes("DIVERGED")) { status = "DIVERGED"; reasons.push(`yerel ${ahead} ileride, ${behind} geride`); }
  else if (conditions.includes("BEHIND_REMOTE")) { status = "BEHIND_REMOTE"; reasons.push(`yerel main uzak main'in ${behind} commit gerisinde`); }
  else if (conditions.includes("AHEAD_REMOTE")) { status = "AHEAD_REMOTE"; reasons.push(`yerel main uzak main'in ${ahead} commit ilerisinde (push edilmemiş)`); }
  else { status = "CLEAN_SYNCED"; }
  if (status !== "CLEAN_SYNCED" && conditions.includes("DIVERGED") && status !== "DIVERGED") reasons.push("ayrıca DIVERGED (HEAD uzak main'den ayrışmış)");
  if (status !== "BEHIND_REMOTE" && conditions.includes("BEHIND_REMOTE")) reasons.push(`ayrıca HEAD uzak main'in ${behind} commit gerisinde`);
  if (conditions.includes("REMOTE_NOT_VERIFIED")) reasons.push("uzak durum DOĞRULANMADI (yerel izleme ref'i bayat olabilir); --remote ile doğrula");
  if (sf.freshness === "STALE_STATE_FILE") reasons.push(`STALE_STATE_FILE: ${sf.freshness_reason}`);

  return {
    status, conditions, stop: STOP_STATUSES.has(status), reasons,
    repository: identity,
    branch: { current: branch, canonical: CANONICAL_BRANCH, is_canonical: onCanonical },
    local: { head: head.out, local_main: localMain.code === 0 ? localMain.out : null },
    remote: { verified: remote, basis: remoteBasis, main_sha: remoteSha },
    relation: { ahead, behind },
    working_tree: wt, git_health: { ok: true, problems: [] },
    state_file: sf, pull_requests: prSummary(cwd, expected, remote && opts.gh !== false),
    workflows: workflowsOf(cwd),
    next_safe_action: NEXT[status], never_automatic: NEVER_AUTOMATIC,
  };
}

export function reportToText(r: StatusReport): string {
  const L: string[] = [];
  L.push(`DURUM: ${r.status}${r.stop ? "  (DUR — otomatik devam yok)" : ""}`);
  if (r.conditions.length) L.push(`koşullar: ${r.conditions.join(", ")}`);
  for (const x of r.reasons) L.push(`  - ${x}`);
  L.push("", `repo      : beklenen ${r.repository.expected} · origin ${r.repository.origin_url_redacted ?? "yok"} · ${r.repository.matches ? "EŞLEŞTİ" : "EŞLEŞMEDİ"}`);
  L.push(`dal       : ${r.branch.current ?? "(detached HEAD)"} (canonical: ${r.branch.canonical})`);
  L.push(`yerel HEAD: ${r.local.head ?? "?"}`);
  L.push(`uzak main : ${r.remote.main_sha ?? "?"} [${r.remote.basis}${r.remote.verified ? ", doğrulandı" : ", DOĞRULANMADI"}]${r.remote.error ? ` ${r.remote.error}` : ""}`);
  L.push(`ilişki    : ahead=${r.relation.ahead ?? "?"} behind=${r.relation.behind ?? "?"}`);
  L.push(`çalışma ağacı: ${r.working_tree.dirty ? `KİRLİ (değişen ${r.working_tree.modified}, izlenmeyen ${r.working_tree.untracked}, çakışmalı ${r.working_tree.unmerged})` : "temiz"}`);
  if (!r.git_health.ok && r.git_health.problems.length) L.push(`git sağlığı: ${r.git_health.problems.join("; ")}`);
  const s = r.state_file;
  if (s) {
    L.push(`devir dosyaları: json=${s.json} md=${s.md} tazelik=${s.freshness}${s.freshness_reason ? ` (${s.freshness_reason})` : ""}`);
    if (s.json_errors.length) L.push(`  geçersiz: ${s.json_errors.join("; ")}`);
    if (s.hold_prs.length) L.push(`HOLD PR'lar: ${s.hold_prs.map((n) => `#${n}`).join(", ")}`);
    if (s.owner_gates.length) L.push(`owner-gated: ${s.owner_gates.join(" | ")}`);
    if (s.next_action) L.push(`next_action: ${JSON.stringify(s.next_action)}`);
  }
  if (r.pull_requests.state === "OK") L.push(`açık PR'lar (gh): ${(r.pull_requests.prs ?? []).map((p) => `#${p.number}${p.draft ? " (draft)" : ""} ${p.title}`).join(" | ") || "yok"}`);
  else L.push(`açık PR'lar: UNKNOWN — ${r.pull_requests.reason}`);
  if (r.workflows.length) L.push(`workflow'lar: ${r.workflows.map((w) => `${w.file}${w.cron.length ? ` [cron ${w.cron.join(", ")}]` : ""}`).join("; ")}`);
  L.push("", `SIRADAKİ GÜVENLİ ADIM: ${r.next_safe_action}`, "", "OTOMATİK YAPILMAZ:");
  for (const n of r.never_automatic) L.push(`  - ${n}`);
  return L.join("\n");
}
