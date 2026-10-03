// project-status: GitHub-first devir denetimi. Hepsi YEREL fixture git deposu + yerel bare remote; gerçek GitHub'a erişim/yazma YOK.
// Remote yolu, beklenen depo adıyla biten yerel bir dizin (…/sefayamak/search-growth-os.git) olduğundan kimlik kontrolünden geçer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { inspect, repoSlug, redactUrl, findSecretLikeValues, validateHandoffState, reportToText, HANDOFF_SCHEMA, STATE_JSON, STATE_MD } from "../src/project-status.ts";

const ROOT = resolve(".");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function g(cwd: string, ...a: string[]) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const w = (c: string, p: string, s: string) => { mkdirSync(dirname(join(c, p)), { recursive: true }); writeFileSync(join(c, p), s); };

interface Fx { base: string; remote: string; clone: (name: string) => string; push: (clone: string, msg?: string) => void }
/** Beklenen depo adıyla biten bare remote + tohum commit. */
function fixture(repoName = "search-growth-os"): Fx {
  const base = mkdtempSync(join(tmpdir(), "ps-"));
  const remote = join(base, "sefayamak", `${repoName}.git`);
  mkdirSync(dirname(remote), { recursive: true });
  g(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  g(base, "clone", "-q", remote, seed);
  g(seed, "checkout", "-q", "-B", "main");
  w(seed, "README.md", "x\n"); w(seed, "src/a.ts", "export {};\n");
  g(seed, "add", "."); g(seed, "commit", "-qm", "seed"); g(seed, "push", "-q", "origin", "HEAD:main");
  return {
    base, remote,
    clone: (name) => { const c = join(base, name); g(base, "clone", "-q", remote, c); return c; },
    push: (c, msg = "m") => { g(c, "add", "."); g(c, "commit", "-qm", msg); g(c, "push", "-q", "origin", "HEAD:main"); },
  };
}
const insp = (cwd: string, remote = true) => inspect({ cwd, remote, gh: false });
const snapshot = (c: string) => ({ head: g(c, "rev-parse", "HEAD"), refs: g(c, "for-each-ref", "--format=%(refname) %(objectname)"), status: g(c, "status", "--porcelain"), branch: g(c, "rev-parse", "--abbrev-ref", "HEAD") });

// ---- A–H ---------------------------------------------------------------------------------------------------------
test("A: yeni clone, main == remote -> CLEAN_SYNCED (uzak doğrulandı)", () => {
  const f = fixture(); const c = f.clone("a");
  const r = insp(c);
  assert.equal(r.status, "CLEAN_SYNCED"); assert.equal(r.stop, false);
  assert.equal(r.remote.verified, true); assert.equal(r.remote.basis, "FETCHED_LIVE");
  assert.deepEqual([r.relation.ahead, r.relation.behind], [0, 0]);
  assert.equal(r.repository.matches, true);
});

test("A2: varsayılan mod yalnız yerel — uzak DOĞRULANMADI uyarısı; ağ/fetch yok (uzak ilerlese de yerel ref değişmez)", () => {
  const f = fixture(); const c = f.clone("a2"); const other = f.clone("other");
  w(other, "src/new.ts", "1\n"); f.push(other);
  const before = snapshot(c);
  const r = insp(c, false);
  assert.equal(r.status, "CLEAN_SYNCED", "yerel izleme ref'ine göre senkron görünür...");
  assert.ok(r.conditions.includes("REMOTE_NOT_VERIFIED"), "...ama DOĞRULANMADI diye işaretlenir");
  assert.equal(r.remote.verified, false); assert.equal(r.remote.basis, "LOCAL_TRACKING_REF");
  assert.match(reportToText(r), /DOĞRULANMADI/);
  assert.deepEqual(snapshot(c), before, "varsayılan mod hiçbir ref'i değiştirmez");
});

test("B: eski laptop 5 commit geride -> BEHIND_REMOTE; otomatik reset/pull YOK, yerel HEAD değişmez", () => {
  const f = fixture(); const old = f.clone("laptop"); const dev = f.clone("dev");
  for (let i = 0; i < 5; i++) { w(dev, `src/f${i}.ts`, `${i}\n`); f.push(dev, `c${i}`); }
  const headBefore = g(old, "rev-parse", "HEAD");
  const r = insp(old);
  assert.equal(r.status, "BEHIND_REMOTE"); assert.equal(r.relation.behind, 5); assert.equal(r.relation.ahead, 0);
  assert.match(r.next_safe_action, /fetch|güncelleme|pull --ff-only|taze clone/i);
  assert.match(r.next_safe_action, /reset\/merge\/rebase YOK/);
  assert.equal(g(old, "rev-parse", "HEAD"), headBefore, "HEAD değişmedi");
  assert.equal(existsSync(join(old, "src/f0.ts")), false, "çalışma ağacı güncellenmedi (pull yok)");
});

test("AHEAD: push edilmemiş yerel commit -> AHEAD_REMOTE (silme/reset yok)", () => {
  const f = fixture(); const c = f.clone("ahead");
  w(c, "src/local.ts", "1\n"); g(c, "add", "."); g(c, "commit", "-qm", "local");
  const r = insp(c);
  assert.equal(r.status, "AHEAD_REMOTE"); assert.equal(r.relation.ahead, 1);
  assert.match(r.next_safe_action, /Silme\/reset YOK/);
});

test("C: commit edilmemiş değişiklik -> DIRTY, çalışma KORUNUR (içerik/untracked aynen)", () => {
  const f = fixture(); const c = f.clone("dirty");
  w(c, "README.md", "değişti\n"); w(c, "notlar.txt", "izlenmeyen\n");
  const r = insp(c);
  assert.equal(r.status, "DIRTY"); assert.equal(r.working_tree.modified, 1); assert.equal(r.working_tree.untracked, 1);
  assert.match(r.next_safe_action, /Silme\/reset\/checkout\/clean YOK/);
  assert.equal(readFileSync(join(c, "README.md"), "utf8"), "değişti\n");
  assert.equal(readFileSync(join(c, "notlar.txt"), "utf8"), "izlenmeyen\n");
});

test("C2: çakışmalı (unmerged) çalışma ağacı da DIRTY + UNMERGED_PATHS — otomatik temizlik yok", () => {
  const f = fixture(); const c = f.clone("conf"); const dev = f.clone("dev2");
  w(dev, "README.md", "remote\n"); f.push(dev);
  w(c, "README.md", "local\n"); g(c, "add", "."); g(c, "commit", "-qm", "local");
  spawnSync("git", ["merge", "origin/main"], { cwd: c, env: ENV }); // çakışma bırakır (fixture; araç merge YAPMAZ)
  g(c, "fetch", "-q", "origin", "main");
  spawnSync("git", ["merge", "origin/main"], { cwd: c, env: ENV });
  const r = insp(c);
  assert.equal(r.status, "DIRTY"); assert.ok(r.conditions.includes("UNMERGED_PATHS")); assert.ok(r.working_tree.unmerged >= 1);
  assert.match(readFileSync(join(c, "README.md"), "utf8"), /<<<<<<</, "çakışma işaretleri korunur");
});

test("D: yanlış (feature) dal -> WRONG_BRANCH; dal adı ve canonical gösterilir, otomatik checkout YOK", () => {
  const f = fixture(); const c = f.clone("fb");
  g(c, "checkout", "-q", "-b", "claude/feature-x");
  const r = insp(c);
  assert.equal(r.status, "WRONG_BRANCH");
  assert.equal(r.branch.current, "claude/feature-x"); assert.equal(r.branch.canonical, "main");
  assert.match(reportToText(r), /claude\/feature-x/); assert.match(r.next_safe_action, /checkout YOK/);
  assert.equal(g(c, "rev-parse", "--abbrev-ref", "HEAD"), "claude/feature-x", "dal değişmedi");
});

test("D2: detached HEAD de WRONG_BRANCH", () => {
  const f = fixture(); const c = f.clone("det"); g(c, "checkout", "-q", "--detach");
  const r = insp(c);
  assert.equal(r.status, "WRONG_BRANCH"); assert.equal(r.branch.current, null);
  assert.match(reportToText(r), /detached HEAD/);
});

test("E: yerel ve uzak ayrışmış -> DIVERGED; merge/rebase YOK, ağaç aynı", () => {
  const f = fixture(); const c = f.clone("div"); const dev = f.clone("dev3");
  w(dev, "src/remote.ts", "r\n"); f.push(dev);
  w(c, "src/local.ts", "l\n"); g(c, "add", "."); g(c, "commit", "-qm", "local");
  const head = g(c, "rev-parse", "HEAD");
  const r = insp(c);
  assert.equal(r.status, "DIVERGED"); assert.deepEqual([r.relation.ahead, r.relation.behind], [1, 1]);
  assert.match(r.next_safe_action, /merge\/rebase\/reset YOK/);
  assert.equal(g(c, "rev-parse", "HEAD"), head);
  assert.equal(g(c, "status", "--porcelain"), "");
});

test("F: yanlış repo -> WRONG_REPOSITORY, STOP; kimlik uyuşmazlığı başka hiçbir kontrole geçmez", () => {
  const f = fixture("pam-crm"); const c = f.clone("wrong");
  const r = insp(c);
  assert.equal(r.status, "WRONG_REPOSITORY"); assert.equal(r.stop, true);
  assert.match(r.reasons.join(" "), /pam-crm/); assert.match(r.next_safe_action, /DUR/);
  assert.match(r.next_safe_action, /pam-crm|ST10|service_role/);
  assert.equal(r.state_file, null, "yanlış depoda devir dosyası okunmaz");
});

test("F2: origin URL biçimleri ve kimlik bilgisi maskesi", () => {
  for (const u of ["https://github.com/sefayamak/search-growth-os", "https://github.com/sefayamak/search-growth-os.git", "git@github.com:sefayamak/search-growth-os.git", "http://local_proxy@127.0.0.1:41999/git/sefayamak/search-growth-os"])
    assert.equal(repoSlug(u), "sefayamak/search-growth-os", u);
  assert.equal(repoSlug("https://github.com/sefayamak/pam-crm.git"), "sefayamak/pam-crm");
  assert.equal(repoSlug("https://github.com/someone-else/search-growth-os.git"), "someone-else/search-growth-os");
  const red = redactUrl("https://user:hunter2secret@github.com/o/r.git");
  assert.doesNotMatch(red, /hunter2secret|user/); assert.match(red, /\/\/\*\*\*@github\.com/);
});

test("F3: origin yok / git deposu değil -> STOP", () => {
  const d = mkdtempSync(join(tmpdir(), "ps-nogit-"));
  assert.equal(inspect({ cwd: d, remote: false, gh: false }).status, "UNKNOWN");
  const base = mkdtempSync(join(tmpdir(), "ps-noorigin-")); g(base, "init", "-q", "-b", "main", base);
  assert.equal(inspect({ cwd: base, remote: false, gh: false }).status, "WRONG_REPOSITORY");
});

test("G: bozuk git nesnesi -> GIT_OBJECT_ERROR, STOP; pull/merge/rebase/reset uyarısı; otomatik onarım YOK", () => {
  const base = mkdtempSync(join(tmpdir(), "ps-corrupt-"));
  const remote = join(base, "sefayamak", "search-growth-os.git"); mkdirSync(dirname(remote), { recursive: true });
  g(base, "init", "-q", "--bare", "-b", "main", remote);
  const c = join(base, "c"); g(base, "init", "-q", "-b", "main", c);
  g(c, "remote", "add", "origin", remote);
  w(c, "README.md", "x\n"); g(c, "add", "."); g(c, "commit", "-qm", "seed"); g(c, "push", "-q", "origin", "HEAD:main");
  const head = g(c, "rev-parse", "HEAD");
  const obj = join(c, ".git/objects", head.slice(0, 2), head.slice(2));
  assert.ok(existsSync(obj), "gevşek nesne bekleniyor");
  chmodSync(obj, 0o644); writeFileSync(obj, "bozuk-nesne");
  const sizeBefore = statSync(obj).size;
  const r = insp(c);
  assert.equal(r.status, "GIT_OBJECT_ERROR"); assert.equal(r.stop, true); assert.equal(r.git_health.ok, false);
  for (const s of ["DO NOT pull", "DO NOT merge", "DO NOT rebase", "DO NOT reset"]) assert.match(r.next_safe_action, new RegExp(s));
  assert.equal(statSync(obj).size, sizeBefore, "otomatik onarım yok: bozuk nesne olduğu gibi");
  assert.equal(r.remote.main_sha, null, "bozuk depoda uzağa gidilmez");
});

test("H: GitHub erişilemiyor -> REMOTE_UNREACHABLE, STOP; yerel durum otorite gibi sunulmaz", () => {
  const f = fixture(); const c = f.clone("unr");
  g(c, "remote", "set-url", "origin", join(f.base, "yok", "sefayamak", "search-growth-os.git"));
  const r = insp(c);
  assert.equal(r.status, "REMOTE_UNREACHABLE"); assert.equal(r.stop, true); assert.equal(r.remote.verified, false);
  assert.match(r.next_safe_action, /otorite DEĞİL/);
  assert.match(reportToText(r), /DUR/);
});

// ---- devir dosyaları -------------------------------------------------------------------------------------------
const REAL_STATE = JSON.parse(readFileSync(join(ROOT, STATE_JSON), "utf8"));

test("devir dosyaları: gerçek current-state.json şemaya uyar; CURRENT_STATE.md var; schema sabiti", () => {
  assert.equal(REAL_STATE.schema, HANDOFF_SCHEMA);
  assert.deepEqual(validateHandoffState(REAL_STATE), []);
  assert.ok(existsSync(join(ROOT, STATE_MD)));
  assert.equal(REAL_STATE.repository, "sefayamak/search-growth-os");
  assert.deepEqual(REAL_STATE.hold_prs, [45]);
  assert.equal(REAL_STATE.migration.clarity.full_takeover.completed, 0);
  assert.equal(REAL_STATE.migration.legacy.status, "ENABLED");
  assert.equal(REAL_STATE.schedules.find((s: { workflow: string }) => s.workflow === "clarity-daily.yml").gate_live_value, "UNKNOWN");
  for (const k of ["last_known_main_sha"]) assert.equal(k in REAL_STATE, false, "alan adı state_based_on_main_sha");
  const schemaFile = JSON.parse(readFileSync(join(ROOT, "schemas/handoff-state.schema.json"), "utf8"));
  assert.deepEqual([...schemaFile.required].sort(), Object.keys(REAL_STATE).sort());
});

test("doğrulayıcı gerçekten reddeder: sha, credential değeri alanı, secret benzeri değer, eksik alan", () => {
  const bad = (mut: (s: Record<string, any>) => void) => { const s = JSON.parse(JSON.stringify(REAL_STATE)); mut(s); return validateHandoffState(s); };
  assert.ok(bad((s) => { s.state_based_on_main_sha = "abc"; }).some((e) => /sha/.test(e)));
  assert.ok(bad((s) => { delete s.next_action; }).length > 0);
  assert.ok(bad((s) => { s.credentials.clarity_canonical.value = "x"; }).some((e) => /izinli değil/.test(e)));
  assert.ok(bad((s) => { s.credentials.gsc.configured = "maybe"; }).some((e) => /configured/.test(e)));
  assert.ok(bad((s) => { s.known_risks.push("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"); }).some((e) => /secret benzeri/.test(e)));
});

test("STALE_STATE_FILE: state sha ≠ uzak main ve devir-dışı dosya değişti -> uyarı; yalnız devir dosyaları değiştiyse FRESH_HANDOFF_ONLY", () => {
  const f = fixture(); const c = f.clone("stale"); const dev = f.clone("dev4");
  const sha0 = g(c, "rev-parse", "HEAD");
  const state = { ...REAL_STATE, state_based_on_main_sha: sha0 };
  w(c, STATE_JSON, JSON.stringify(state, null, 2) + "\n"); w(c, STATE_MD, "# s\n");
  g(c, "add", "."); g(c, "commit", "-qm", "state"); g(c, "push", "-q", "origin", "HEAD:main");
  let r = insp(c);
  assert.equal(r.status, "CLEAN_SYNCED");
  assert.equal(r.state_file!.freshness, "FRESH_HANDOFF_ONLY", "devir commit'i kendi sha'sını yazamaz: kendine referans bayat sayılmaz");
  assert.ok(!r.conditions.includes("STALE_STATE_FILE"));
  // uzakta devir-dışı bir değişiklik -> bayat
  g(dev, "pull", "-q", "origin", "main"); w(dev, "src/new.ts", "n\n"); f.push(dev, "feature");
  r = insp(c);
  assert.equal(r.status, "BEHIND_REMOTE");
  assert.equal(r.state_file!.freshness, "STALE_STATE_FILE");
  assert.ok(r.conditions.includes("STALE_STATE_FILE")); assert.match(r.reasons.join(" "), /STALE_STATE_FILE/);
  // state sha yerelde tanınmıyorsa da bayat
  const s2 = { ...REAL_STATE, state_based_on_main_sha: "0".repeat(40) };
  w(c, STATE_JSON, JSON.stringify(s2, null, 2) + "\n");
  assert.equal(insp(c).state_file!.freshness, "STALE_STATE_FILE");
});

test("devir dosyası eksik/bozuk: koşul olarak bildirilir, çökmez; bozuk dosya içeriği ECHO edilmez", () => {
  const f = fixture(); const c = f.clone("nosf");
  let r = insp(c);
  assert.ok(r.conditions.includes("STATE_FILE_MISSING")); assert.equal(r.status, "CLEAN_SYNCED");
  w(c, STATE_JSON, "{ bozuk");
  r = insp(c);
  assert.equal(r.state_file!.json, "INVALID"); assert.ok(r.conditions.includes("STATE_FILE_INVALID"));
});

test("açık PR özeti: gh yoksa UNKNOWN (0 değil); gh varsa (sahte, salt-okunur) özetlenir", () => {
  const f = fixture(); const c = f.clone("pr");
  const none = inspect({ cwd: c, remote: true, gh: false });
  assert.equal(none.pull_requests.state, "UNKNOWN"); assert.equal(none.pull_requests.prs, undefined);
  const bin = mkdtempSync(join(tmpdir(), "ps-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 9\necho '[{"number":45,"title":"t","isDraft":true,"headRefName":"claude/x","baseRefName":"main"}]'\n`); chmodSync(join(bin, "gh"), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try {
    const r = inspect({ cwd: c, remote: true, gh: true });
    assert.equal(r.pull_requests.state, "OK"); assert.deepEqual(r.pull_requests.prs, [{ number: 45, title: "t", draft: true, head: "claude/x", base: "main" }]);
  } finally { process.env.PATH = old; }
});

// ---- read-only garantisi ---------------------------------------------------------------------------------------
test("read-only: kaynak kodu yazan/mutasyon yapan git alt komutları ve dispatch içermez", () => {
  for (const file of ["src/project-status.ts", "bin/project-status.ts", "scripts/project-status.sh"]) {
    const src = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => !/^\s*(\/\/|#)/.test(l)).join("\n");
    assert.doesNotMatch(src, /["'`](pull|merge|rebase|reset|checkout|clean|stash|push|commit|add|rm|mv|restore|switch|gc|prune|repack|am|cherry-pick|revert|tag|branch)["'`]\s*[,\]]/, `${file}: mutasyon alt komutu`);
    assert.doesNotMatch(src, /workflow\s+run|actions_run_trigger|gh\s+(pr\s+(merge|create|close)|issue|api)/, `${file}: GitHub yazma`);
    assert.doesNotMatch(src, /writeFileSync|rmSync|unlinkSync|renameSync|appendFileSync/, `${file}: dosya yazma`);
  }
});

test("read-only (davranış): çalıştırmadan önce/sonra HEAD, dal, tüm ref'ler ve çalışma ağacı aynı (varsayılan mod)", () => {
  const f = fixture(); const c = f.clone("ro"); w(c, "x.txt", "kirli\n");
  const before = snapshot(c); const idx = readFileSync(join(c, ".git/index"));
  const r = spawnSync("node", ["--experimental-strip-types", join(ROOT, "bin/project-status.ts")], { cwd: c, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DURUM: DIRTY/);
  assert.deepEqual(snapshot(c), before);
  assert.deepEqual(readFileSync(join(c, ".git/index")), idx, "indeks yeniden yazılmadı");
});

test("--remote: yalnız refs/remotes/origin/main güncellenir; HEAD/dal/çalışma ağacı/diğer ref'ler aynı", () => {
  const f = fixture(); const c = f.clone("rr"); const dev = f.clone("dev5");
  w(dev, "src/z.ts", "z\n"); f.push(dev);
  const before = snapshot(c);
  const r = spawnSync("node", ["--experimental-strip-types", join(ROOT, "bin/project-status.ts"), "--remote", "--no-gh"], { cwd: c, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DURUM: BEHIND_REMOTE/);
  const after = snapshot(c);
  assert.equal(after.head, before.head); assert.equal(after.branch, before.branch); assert.equal(after.status, before.status);
  const diff = (s: string) => new Map(s.split("\n").map((l) => l.split(" ") as [string, string]));
  const a = diff(after.refs), b = diff(before.refs);
  // refs/remotes/origin/HEAD, origin/main'e sembolik takma addir (ayri bir ref degil); origin/main ile birlikte hareket eder.
  const changed = [...a].filter(([k, v]) => b.get(k) !== v && k !== "refs/remotes/origin/HEAD").map(([k]) => k);
  assert.deepEqual(changed, ["refs/remotes/origin/main"]);
});

test("CLI çıkış kodları: STOP durumlarında 1, bilgi durumlarında 0; bilinmeyen argüman 1; --json geçerli", () => {
  const f = fixture("pam-crm"); const c = f.clone("w");
  const run = (cwd: string, ...a: string[]) => spawnSync("node", ["--experimental-strip-types", join(ROOT, "bin/project-status.ts"), ...a], { cwd, encoding: "utf8", env: ENV });
  assert.equal(run(c).status, 1);
  const f2 = fixture(); const c2 = f2.clone("ok");
  const ok = run(c2, "--json"); assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).status, "CLEAN_SYNCED");
  assert.equal(run(c2, "--merge").status, 1);
  const wrapper = spawnSync("bash", [join(ROOT, "scripts/project-status.sh"), "--json"], { cwd: ROOT, encoding: "utf8", env: ENV });
  assert.ok([0, 1].includes(wrapper.status ?? 9), wrapper.stderr); assert.ok(JSON.parse(wrapper.stdout).status);
});

// ---- gerçek depo + secret taraması -----------------------------------------------------------------------------
test("bu depo: gerçek checkout'ta inceleme çalışır, kimlik doğru, devir dosyaları geçerli (yerel mod, ağ yok)", () => {
  const r = inspect({ cwd: ROOT, remote: false, gh: false, fsck: false });
  assert.ok(r.repository.matches || r.status === "WRONG_REPOSITORY" || r.status === "UNKNOWN", "CI'da origin farklı olabilir; çökmemeli");
  if (r.state_file) assert.equal(r.state_file.json === "INVALID", false, r.state_file.json_errors.join("; "));
  assert.ok(r.workflows.some((x) => x.file === "clarity-daily.yml"));
});

test("SECRET TARAMASI: devir dosyaları, CLAUDE.md, script'ler ve bu test dosyası credential DEĞERİ içermez", () => {
  const files = [STATE_MD, STATE_JSON, "CLAUDE.md", "src/project-status.ts", "bin/project-status.ts", "scripts/project-status.sh", "schemas/handoff-state.schema.json", "tests/project-status.test.ts", "docs/operations/CURRENT_STATE.md"];
  for (const f of files) {
    const t = readFileSync(join(ROOT, f), "utf8");
    // tarayıcının kendi kural metni (src) ve bu testin sahte örnekleri kural İFADESİ içerir; DEĞER taraması bunları ayıklar.
    const scan = t.split("\n").filter((l) => !/findSecretLikeValues|rules: Array|\["JWT"|\["GitHub token"|\["sk- anahtar"|\["Google API|\["PEM|\["JSON refresh|\["URL içinde|\["DB parolası|eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxMjM0NTY3ODkwIn0|hunter2secret|sk-FAKE|\(user:pass@|redactUrl/.test(l)).join("\n");
    assert.deepEqual(findSecretLikeValues(scan), [], `${f}: secret benzeri değer`);
  }
  // Yalnız İSİM serbest:
  assert.match(readFileSync(join(ROOT, STATE_MD), "utf8"), /SEARCH_GROWTH_CLARITY_TOKENS_JSON/);
  assert.deepEqual(findSecretLikeValues("SEARCH_GROWTH_CLARITY_TOKENS_JSON, service_role, refresh token"), []);
  // Tarayıcı gerçekten yakalar:
  const fake = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijk"].join(".");
  assert.ok(findSecretLikeValues(`jwt ${fake}`).includes("JWT"));
  assert.ok(findSecretLikeValues('{"refresh_token": "1//0gAbCdEfGhIjKlMnOp"}').length > 0);
  assert.ok(findSecretLikeValues("postgres://admin:S3cretPassw0rd@db.example/x").length > 0);
  assert.ok(findSecretLikeValues(["-----BEGIN", "PRIVATE KEY-----"].join(" RSA ")).length > 0);
});

test("CLAUDE.md başlangıç protokolü: tetikleyici cümle, kimlik, PAM CRM/ST10 izolasyonu, dokunma kuralları", () => {
  const t = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  const head = t.slice(0, t.indexOf("**Bu depoyu açtıysan"));
  assert.match(head, /GitHub'a bak ve devam et/);
  assert.match(head, /bin\/project-status\.ts --remote/);
  assert.match(head, /current-state\.json/); assert.match(head, /CURRENT_STATE\.md/);
  assert.match(head, /sefayamak\/search-growth-os/);
  assert.match(head, /PAM CRM|ST10/); assert.match(head, /service_role/);
  assert.match(head, /silme\/sıfırlama/);
  assert.match(head, /Owner-gated eylem yapma/);
});

test("#47 (handoff protokolü) yalnız ops dosyaları ekledi, workflow dizinine dokunmadı — sabit tarihsel commit, CALISAN DAL DEGIL", () => {
  // DIKKAT: bilerek origin/main...HEAD (calisan dal) DEGIL, #47'nin kendi sabit commit'i test edilir.
  // Eski surum "su an hangi dal calisiyor" diye dinamik kontrol ediyordu; bu da workflow'a MESRU ve
  // KASITLI dokunan her gelecekteki PR'i (#45 gibi) yanlislikla kirardi — oyle bir dal #47 degil, #47'nin
  // "ops-only" sozunu hic vermemisti. Dogru/degismez invariant: #47'nin KENDI commit'i hic workflow eklemedi.
  const HANDOFF_COMMIT = "e96d4ebc0578779ed05f03e369aba97b68e5215f"; // Ops: GitHub-first cross-PC handoff protocol (#47)
  const r = spawnSync("git", ["diff", "--name-only", `${HANDOFF_COMMIT}^`, HANDOFF_COMMIT, "--", ".github"], { cwd: ROOT, encoding: "utf8", env: ENV });
  // Bu commit'in ataları yerel repoda yoksa (orn. shallow clone) atla; mevcutsa fark BOS olmali.
  if (r.status === 0) assert.equal(r.stdout.trim(), "");
});
