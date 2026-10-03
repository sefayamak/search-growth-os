// Tarihce sahipligi + main'e yazma yarisi testleri (docs/history-ownership.md).
// Kural: olcum modulu -> makine-okunur cikti -> tarihce sahibi -> kalicilik -> scorecard tuketimi; her yolun TEK yazari.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  JOBS, HISTORY_OWNERS, REQUIRED_HISTORY_PATHS, TARGET_COMMIT_GROUP, QUOTA_POOLS, validateModel, diffWorkflows, extractConcurrencyGroup, extractPushStrategy,
  extractGitAddPaths, extractPersistCalls, effectiveJobs, migrationPending, repoPathOf, pathsOverlap, modelToMarkdown, type Job, type HistoryOwner, type IssueCode,
} from "../src/orchestration.ts";

const WF_DIR = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(readdirSync(WF_DIR).filter((f) => f.endsWith(".yml")).map((f) => [f, readFileSync(new URL(f, WF_DIR), "utf8")]));
const cj = (): Job[] => JSON.parse(JSON.stringify(JOBS));
const co = (): HistoryOwner[] => JSON.parse(JSON.stringify(HISTORY_OWNERS));
const job = (j: Job[], id: string) => j.find((x) => x.id === id)!;
const issues = (j: Job[] = JOBS, o: HistoryOwner[] = HISTORY_OWNERS) => validateModel(j, QUOTA_POOLS, o);
const has = (j: Job[], code: IssueCode, o: HistoryOwner[] = HISTORY_OWNERS) => issues(j, o).some((i) => i.code === code);
const OWNERSHIP_CODES: IssueCode[] = ["MULTI_WRITER", "HISTORY_PATH_REQUIRED_MISSING", "HISTORY_DUPLICATE_PATH", "HISTORY_OWNER_UNKNOWN_JOB", "HISTORY_OWNER_NOT_WRITER", "HISTORY_WRITER_NOT_OWNER",
  "HISTORY_UNREGISTERED_WRITE", "HISTORY_CHAIN_INCOMPLETE", "HISTORY_CONSUMER_WRITES", "HISTORY_CONSUMER_NOT_DEPENDENT", "HISTORY_PERSISTENCE_MISMATCH", "COMMIT_POLICY_MISSING"];

// ---- tohum model ---------------------------------------------------------------------------------------------------

test("tohum: bes tarihce yolunun HER BIRININ tam bir sahibi ve (modelden bagimsiz sayilan) tam bir yazari var", () => {
  assert.deepEqual([...REQUIRED_HISTORY_PATHS].sort(), ["data/canonical-backlog/", "data/clarity-history/", "data/deployment-timeline/", "data/index-history/", "data/performance-history/"]);
  for (const path of REQUIRED_HISTORY_PATHS) {
    assert.equal(HISTORY_OWNERS.filter((o) => o.path === path).length, 1, `${path}: sahip kaydi sayisi`);
    // dogrulayiciya guvenmeden: JOBS.writes'i dogrudan tara
    const writers = JOBS.filter((j) => j.state !== "DISABLED" && j.writes.some((w) => w.startsWith(path)));
    assert.equal(writers.length, 1, `${path}: yazar sayisi (${writers.map((w) => w.id).join(",")})`);
    assert.equal(writers[0].id, HISTORY_OWNERS.find((o) => o.path === path)!.owner_job);
  }
});

test("tohum: sahiplik/commit-politikasi kodlarindan hicbiri tetiklenmez; scorecard salt-okunur (depoya yazmaz, commit etmez)", () => {
  assert.deepEqual(issues().filter((i) => (OWNERSHIP_CODES as string[]).includes(i.code)), []);
  const sc = JOBS.find((j) => j.id === "scorecard-weekly")!;
  assert.deepEqual(sc.writes, ["artifact:scorecard-<run_id>"]);
  assert.ok(!sc.commits_to_main);
  assert.ok(sc.writes.every((w) => repoPathOf(w) === null));
  // scorecard her tarihce sahibine bagli ve dort boyutu bes yoldan okur
  for (const o of HISTORY_OWNERS.filter((x) => x.consumers.length)) { assert.deepEqual(o.consumers, ["scorecard-weekly"]); assert.ok(sc.depends_on.includes(o.owner_job)); }
  assert.deepEqual(HISTORY_OWNERS.flatMap((o) => o.scorecard_dimensions).sort(), ["deployment_change", "index_health", "measurement_health", "performance", "ux_friction"]);
});

test("tohum: zincir halkalari dolu; sema kimlikleri uretici semalariyla ayni; ayni is iki DIZINE yazabilir (yol bazli kural)", () => {
  const ids = Object.fromEntries(HISTORY_OWNERS.map((o) => [o.path, o.schema]));
  assert.deepEqual(ids, { "data/clarity-history/": "sgos.clarity-history.v1", "data/performance-history/": "sgos.performance-history.v1", "data/index-history/": "sgos.index-history.v1",
    "data/canonical-backlog/": "sgos.canonical-backlog.v1", "data/deployment-timeline/": "sgos.deployment-timeline.v1" });
  for (const o of HISTORY_OWNERS) for (const k of ["measurement_module", "schema", "owner_job", "producer_ref"] as const) assert.ok(o[k].trim(), `${o.path}.${k}`);
  assert.equal(HISTORY_OWNERS.filter((o) => o.owner_job === "index-alarms-daily").length, 2);
});

test("tohum: model PLANNED/GATED kalir ve PLANNED isler icin workflow dosyasi YOK (hicbir schedule acilmadi)", () => {
  for (const id of ["index-alarms-daily", "deployment-verifier", "scorecard-weekly"]) {
    const j = JOBS.find((x) => x.id === id)!;
    assert.equal(j.state, "PLANNED");
    assert.ok(!existsSync(new URL(j.workflow!, WF_DIR)), `${j.workflow} olusturulmamali`);
  }
  // lighthouse-weekly: PLANNED -> ACTIVE (bu PR), workflow dosyasi artik var.
  const lh = JOBS.find((x) => x.id === "lighthouse-weekly")!;
  assert.equal(lh.state, "ACTIVE");
  assert.ok(existsSync(new URL(lh.workflow!, WF_DIR)), `${lh.workflow} olusmali`);
  assert.equal(JOBS.find((j) => j.id === "clarity-daily")!.state, "GATED");
});

// ---- tek yazar: yanlis negatif / yanlis pozitif -----------------------------------------------------------------------

test("FN: iki is ayni tarihce yoluna yazarsa MULTI_WRITER (+ sahip olmayan yazar HISTORY_WRITER_NOT_OWNER)", () => {
  const j = cj(); job(j, "lighthouse-weekly").writes.push("data/index-history/pamistanbul.json (commit, main)");
  const found = issues(j).filter((i) => i.code === "MULTI_WRITER");
  assert.equal(found.length, 1); assert.equal(found[0].severity, "ERROR"); assert.deepEqual([...found[0].jobs].sort(), ["index-alarms-daily", "lighthouse-weekly"]);
  assert.ok(has(j, "HISTORY_WRITER_NOT_OWNER"));
});

test("FN: dizin onek cakismasi da yakalanir (reports/ ile reports/scorecard-*)", () => {
  const j = cj(); job(j, "scorecard-weekly").writes = ["reports/scorecard-<tarih>.md (commit, main)"];
  assert.ok(issues(j).some((i) => i.code === "MULTI_WRITER" && i.jobs.includes("measure") && i.jobs.includes("scorecard-weekly")));
  assert.ok(has(j, "HISTORY_CONSUMER_WRITES"));
});

test("FN: PLANNED is de sayilir; DISABLED is sayilmaz (FP)", () => {
  const j = cj(); job(j, "deployment-verifier").writes.push("data/clarity-history/x.json");
  assert.ok(has(j, "MULTI_WRITER"));
  job(j, "deployment-verifier").state = "DISABLED";
  assert.ok(!has(j, "MULTI_WRITER"));
});

test("FP: ayni is iki farkli dizine yazabilir; artifact: yazimlari ve benzer-onekli dizinler cakismaz", () => {
  assert.ok(!has(cj(), "MULTI_WRITER"));
  const j = cj(); job(j, "brain").writes.push("artifact:index-alarms-<run_id>"); // baska isin artifact adi: depo yolu degil
  assert.ok(!has(j, "MULTI_WRITER"));
  assert.equal(pathsOverlap("data/index-history/", "data/index-history-old/"), false);
  assert.equal(pathsOverlap("data/a/", "data/a/b.json"), true);
  assert.equal(pathsOverlap("data/a/b.json", "data/a/b.json"), true);
  assert.equal(pathsOverlap("reports/", "content/topic-ledger.json"), false);
});

test("repoPathOf: glob'u keser, artifact/serbest metni yok sayar", () => {
  assert.equal(repoPathOf("data/clarity-history/*.json (commit, main)"), "data/clarity-history/");
  assert.equal(repoPathOf("reports/ (commit, main)"), "reports/");
  assert.equal(repoPathOf("reports/scorecard-<tarih>.{json,md}"), "reports/");
  assert.equal(repoPathOf("content/topic-ledger.json (commit, main)"), "content/topic-ledger.json");
  assert.equal(repoPathOf("artifact:clarity-daily-<run_id>"), null);
  assert.equal(repoPathOf("site-health-monitor snapshot (kendi deposu)"), null);
  assert.equal(repoPathOf("src/x.ts"), null);
});

test("sahip kaydi bozulursa dogrulayici yakalar (her kod icin FN)", () => {
  const o = co().filter((x) => x.path !== "data/performance-history/");
  assert.ok(has(cj(), "HISTORY_PATH_REQUIRED_MISSING", o));
  const o2 = co(); o2[1].owner_job = "yok-is"; assert.ok(has(cj(), "HISTORY_OWNER_UNKNOWN_JOB", o2));
  const o3 = co(); o3[1].owner_job = "measure"; assert.ok(has(cj(), "HISTORY_OWNER_NOT_WRITER", o3));
  const o4 = [...co(), co()[0]]; assert.ok(has(cj(), "HISTORY_DUPLICATE_PATH", o4));
  const o5 = co(); o5[0].measurement_module = " "; assert.ok(has(cj(), "HISTORY_CHAIN_INCOMPLETE", o5));
  const o6 = co(); o6[0].scorecard_dimensions = []; assert.ok(has(cj(), "HISTORY_CHAIN_INCOMPLETE", o6));
  const o7 = co(); o7[3].scorecard_dimensions = ["index_health"]; assert.ok(has(cj(), "HISTORY_CHAIN_INCOMPLETE", o7)); // tuketicisiz boyut
  const o8 = co(); o8[0].persistence = "artifact_only"; assert.ok(has(cj(), "HISTORY_PERSISTENCE_MISMATCH", o8));
  const o9 = co(); o9[0].consumers = ["yok-is"]; assert.ok(has(cj(), "HISTORY_OWNER_UNKNOWN_JOB", o9));
});

test("tuketici kurallari: sahibine bagli olmali; yazamaz; yeni data/ dizini kayitsiz yazilamaz", () => {
  const j = cj(); job(j, "scorecard-weekly").depends_on = job(j, "scorecard-weekly").depends_on.filter((d) => d !== "lighthouse-weekly");
  assert.ok(has(j, "HISTORY_CONSUMER_NOT_DEPENDENT"));
  const w = cj(); job(w, "scorecard-weekly").commits_to_main = true; assert.ok(has(w, "HISTORY_CONSUMER_WRITES"));
  const u = cj(); job(u, "tests-ci").writes.push("data/yeni-gecmis/x.json"); assert.ok(has(u, "HISTORY_UNREGISTERED_WRITE"));
});

// ---- main'e yazma yarisi ---------------------------------------------------------------------------------------------

// IKI DUNYA: (a) #40 merge OLMADAN: workflow'lar satir ici git komutlari kullanir; (b) #40 merge SONRASI: `bash scripts/persist-history.sh`.
// Gercek dosyalardan hangisinde oldugumuz tespit edilir; beklenti dunyaya gore degisir, test ikisinde de gecer.
const scriptForm = (f: string) => extractPushStrategy(workflows[f]) === "rebase_retry_bounded";
const BOTH_MIGRATED = scriptForm("measure.yml") && scriptForm("clarity-daily.yml");

test("gercek duzen (iki dunya): measure/clarity-daily FARKLI gruplarla main'e yaziyor; betik varsa MAIN_COMMIT_RACE INFO + PUSH_WITHOUT_REBASE yok, yoksa WARN'lar gercegi soyler", () => {
  const ij = issues(effectiveJobs(workflows));
  const race = ij.find((i) => i.code === "MAIN_COMMIT_RACE" && i.jobs.includes("measure") && i.jobs.includes("clarity-daily"));
  const push = ij.find((i) => i.code === "PUSH_WITHOUT_REBASE" && i.jobs[0] === "measure");
  if (BOTH_MIGRATED) {
    assert.ok(race && race.severity === "INFO" && /rebase_retry_bounded/.test(race.message));
    assert.ok(!push);
  } else {
    assert.ok(race && race.severity === "WARN");
    if (!scriptForm("measure.yml")) assert.ok(push && push.severity === "WARN"); else assert.ok(!push);
  }
  // Beyan edilen model (workflow'suz) betik sozlesmesini soyler: duz-push uyarisi yok, yaris korumali INFO.
  assert.ok(!issues().some((i) => i.code === "PUSH_WITHOUT_REBASE"));
  assert.equal(issues().find((i) => i.code === "MAIN_COMMIT_RACE" && i.jobs.includes("measure") && i.jobs.includes("clarity-daily"))?.severity, "INFO");
  // planli isler ortak grupta ve rebase'li: aralarinda yaris yok
  const planned = ["index-alarms-daily", "deployment-verifier"];
  for (const id of planned) { assert.equal(job(cj(), id).commit_group, TARGET_COMMIT_GROUP); assert.equal(job(cj(), id).push_strategy, "rebase_then_push"); }
  // lighthouse-weekly artik ACTIVE: ayni ortak grupta ama betik formu (rebase_retry_bounded) kullanir.
  assert.equal(job(cj(), "lighthouse-weekly").commit_group, TARGET_COMMIT_GROUP);
  assert.equal(job(cj(), "lighthouse-weekly").push_strategy, "rebase_retry_bounded");
  const grouped = [...planned, "lighthouse-weekly"];
  assert.ok(!issues().some((i) => i.code === "MAIN_COMMIT_RACE" && i.jobs.every((x) => grouped.includes(x))));
});

test("FP: ortak commit grubu yarisi kaldirir; tek commit eden plain_push is sorun degildir; rebase'li is PUSH_WITHOUT_REBASE uretmez", () => {
  const j = cj(); job(j, "measure").commit_group = "clarity"; job(j, "measure").push_strategy = "rebase_then_push";
  assert.ok(!issues(j).some((i) => i.code === "MAIN_COMMIT_RACE" && i.jobs.includes("measure") && i.jobs.includes("clarity-daily")));
  assert.ok(!issues(j).some((i) => i.code === "PUSH_WITHOUT_REBASE"));
  const solo = cj().map((x) => (x.id === "measure" || !x.commits_to_main ? x : { ...x, state: "DISABLED" as const }));
  assert.ok(!issues(solo).some((i) => i.code === "PUSH_WITHOUT_REBASE" || i.code === "MAIN_COMMIT_RACE"));
});

test("MAIN_COMMIT_RACE/PUSH_WITHOUT_REBASE betik korumasi: FP (korumali + ayrik yol -> INFO) ve FN (yol kesisir / biri korumasiz -> WARN, sessizce dusmez)", () => {
  const race = (j: Job[]) => issues(j).find((i) => i.code === "MAIN_COMMIT_RACE" && i.jobs.includes("measure") && i.jobs.includes("clarity-daily"));
  assert.equal(race(cj())?.severity, "INFO");
  const overlap = cj(); job(overlap, "measure").writes.push("data/clarity-history/x.json (commit, main)");
  assert.equal(race(overlap)?.severity, "WARN"); // ayni yola iki yazar: rebase catisabilir, koruma yetmez
  const oneUnsafe = cj(); job(oneUnsafe, "measure").push_strategy = "plain_push";
  assert.equal(race(oneUnsafe)?.severity, "WARN");
  assert.equal(issues(oneUnsafe).find((i) => i.code === "PUSH_WITHOUT_REBASE" && i.jobs[0] === "measure")?.severity, "WARN");
  const singleAttempt = cj(); job(singleAttempt, "clarity-daily").push_strategy = "rebase_then_push"; // tek deneme betik degil
  assert.equal(race(singleAttempt)?.severity, "WARN");
});

test("FN: PLANNED is plain_push ise ERROR (tasarim asamasinda yakalanir); live ise WARN", () => {
  const j = cj(); job(j, "index-alarms-daily").push_strategy = "plain_push";
  const p = issues(j).find((i) => i.code === "PUSH_WITHOUT_REBASE" && i.jobs[0] === "index-alarms-daily");
  assert.ok(p && p.severity === "ERROR");
  // lighthouse-weekly artik ACTIVE (live): ayni durum WARN uretir, ERROR degil.
  const j2 = cj(); job(j2, "lighthouse-weekly").push_strategy = "plain_push";
  const p2 = issues(j2).find((i) => i.code === "PUSH_WITHOUT_REBASE" && i.jobs[0] === "lighthouse-weekly");
  assert.ok(p2 && p2.severity === "WARN");
});

test("commit politikasi: commit eden isin grup+push stratejisi zorunlu; 'writes (commit, main)' bayraksiz olamaz; depo yolu olmadan commit olmaz", () => {
  const a = cj(); delete job(a, "lighthouse-weekly").commit_group; assert.ok(has(a, "COMMIT_POLICY_MISSING"));
  const b = cj(); delete job(b, "lighthouse-weekly").push_strategy; assert.ok(has(b, "COMMIT_POLICY_MISSING"));
  const c = cj(); delete job(c, "lighthouse-weekly").commits_to_main; assert.ok(has(c, "COMMIT_POLICY_MISSING"));
  const d = cj(); job(d, "scorecard-weekly").commits_to_main = true; job(d, "scorecard-weekly").commit_group = "g"; job(d, "scorecard-weekly").push_strategy = "rebase_then_push";
  assert.ok(has(d, "COMMIT_POLICY_MISSING")); // yalniz artifact yazan is commit etmez
});

test("ayni dakikada iki commit eden is farkli gruptaysa SCHEDULE_COLLISION WARN (FP: ayni grupta INFO/zararsiz kalir)", () => {
  const j = cj(); job(j, "clarity-daily").cron = "40 6 * * *"; // measure ile Pzt 06:40'ta ayni dakika (ikisi de canli: ACTIVE/GATED)
  const hit = issues(j).find((i) => i.code === "SCHEDULE_COLLISION" && i.jobs.includes("clarity-daily") && i.jobs.includes("measure"));
  assert.ok(hit && hit.severity === "WARN" && /push yarisi/.test(hit.message));
  job(j, "clarity-daily").commit_group = "measure";
  const same = issues(j).find((i) => i.code === "SCHEDULE_COLLISION" && i.jobs.includes("clarity-daily") && i.jobs.includes("measure"));
  assert.ok(same && same.severity === "INFO");
});

// ---- workflow <-> model drift (yazma tarafi) ---------------------------------------------------------------------------

// Sentetik workflow'lar: iki formu da DUNYADAN BAGIMSIZ sinar (gercek dosyalar hangi formdaysa o ayrica test edilir).
const wf = (group: string, run: string) => `on:\n  schedule:\n    - cron: "40 6 * * 1"\nconcurrency:\n  group: ${group}\n  cancel-in-progress: false\njobs:\n  m:\n    steps:\n      - name: Raporu depoya yaz\n        run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`;
const LEGACY_MEASURE = wf("measure", 'git add reports/measure-latest.md reports/runs/\n[ -f content/topic-ledger.json ] && git add content/topic-ledger.json\ngit commit -m "olcum"\ngit push');
const SCRIPT_MEASURE = wf("measure", 'bash scripts/persist-history.sh -m "ölçüm: $(date -u +%Y-%m-%d) (otomatik)" \\\n  reports/measure-latest.md reports/runs/ content/topic-ledger.json');
const dm = (t: string, name = "measure.yml") => diffWorkflows({ [name]: t });
const kinds = (t: string, name = "measure.yml") => dm(t, name).map((d) => d.kind);

test("gercek workflow'lar (iki dunya): commit/push/concurrency/git-add modelle uyumlu; hangi formdaysa o gorunur, bekleyen gecis drift sayilmaz", () => {
  assert.deepEqual(diffWorkflows(workflows), []);
  const want = (f: string, legacy: string) => (scriptForm(f) ? "rebase_retry_bounded" : legacy);
  assert.equal(extractPushStrategy(workflows["measure.yml"]), want("measure.yml", "plain_push"));
  assert.equal(extractPushStrategy(workflows["clarity-daily.yml"]), want("clarity-daily.yml", "rebase_then_push"));
  assert.equal(extractConcurrencyGroup(workflows["measure.yml"]), "measure");
  assert.equal(extractConcurrencyGroup(workflows["clarity-daily.yml"]), "clarity");
  assert.deepEqual(Object.entries(workflows).filter(([, t]) => extractPushStrategy(t)).map(([f]) => f).sort(), ["clarity-daily.yml", "lighthouse.yml", "measure.yml"]);
  // Betik formunda git add kumesi = betik argumanlari: gercek yollar modelde (reports/, ledger, clarity-history) ve baska yol yok.
  const adds = (f: string) => extractGitAddPaths(workflows[f]);
  assert.ok(adds("clarity-daily.yml").includes("data/clarity-history/") || adds("clarity-daily.yml").some((p) => p.startsWith("data/clarity-history")));
  assert.ok(adds("measure.yml").every((p) => /^(reports\/|content\/topic-ledger\.json)/.test(p)), adds("measure.yml").join(","));
  const pend = migrationPending(workflows);
  assert.deepEqual(pend.map((p) => p.job).sort(), ["clarity-daily", "measure"].filter((id) => !scriptForm(id === "measure" ? "measure.yml" : "clarity-daily.yml")));
});

test("drift (satir ici ESKI form): model betik diyor, workflow hala duz git push -> drift DEGIL ama migrationPending; add/commit/grup drift'i hala yakalanir", () => {
  assert.deepEqual(dm(LEGACY_MEASURE), []);
  assert.equal(extractPushStrategy(LEGACY_MEASURE), "plain_push");
  assert.deepEqual(extractGitAddPaths(LEGACY_MEASURE), ["reports/measure-latest.md", "reports/runs/", "content/topic-ledger.json"]);
  assert.equal(migrationPending({ "measure.yml": LEGACY_MEASURE }).length, 1);
  // FN: beyan edilmemis bir satir ici strateji (rebase'li ama modelin legacy'si plain_push) drift'tir
  assert.ok(kinds(LEGACY_MEASURE.replace("git push", "git pull --rebase origin main\n          git push")).includes("PUSH_STRATEGY_DRIFT"));
  assert.ok(kinds(LEGACY_MEASURE.replace("group: measure", "group: main-writes")).includes("CONCURRENCY_NOT_IN_WORKFLOW"));
  assert.ok(kinds(LEGACY_MEASURE.replace("reports/runs/\n", "reports/runs/ data/yeni-gecmis/\n")).includes("GIT_ADD_NOT_IN_MODEL"));
  assert.ok(kinds(LEGACY_MEASURE.replace("git push", "echo atla")).includes("MODEL_COMMIT_NOT_IN_WORKFLOW"));
  assert.ok(kinds(wf("measure", "echo x\ngit push"), "portfolio-check.yml").includes("COMMIT_NOT_IN_MODEL"));
});

test("drift (BETIK formu): persist-history.sh cagrisi = push (rebase_retry_bounded) ve yol argumanlari = git add kumesi; drift yok", () => {
  assert.deepEqual(dm(SCRIPT_MEASURE), []);
  assert.equal(extractPushStrategy(SCRIPT_MEASURE), "rebase_retry_bounded");
  assert.deepEqual(extractGitAddPaths(SCRIPT_MEASURE), ["reports/measure-latest.md", "reports/runs/", "content/topic-ledger.json"]);
  assert.deepEqual(migrationPending({ "measure.yml": SCRIPT_MEASURE }), []);
  assert.deepEqual(effectiveJobs({ "measure.yml": SCRIPT_MEASURE }).find((j) => j.id === "measure")!.push_strategy, "rebase_retry_bounded");
  assert.equal(effectiveJobs({ "measure.yml": LEGACY_MEASURE }).find((j) => j.id === "measure")!.push_strategy, "plain_push");
  // FN: modelde olmayan yol betige arguman olarak verilirse (betik izin listesi ayri bir kapidir) GIT_ADD_NOT_IN_MODEL
  assert.ok(kinds(SCRIPT_MEASURE.replace("reports/runs/", "reports/runs/ data/yeni-gecmis/")).includes("GIT_ADD_NOT_IN_MODEL"));
  // FN: tek-yazar: measure baska iscinin dizinini (clarity-history) betige verirse yakalanir
  assert.ok(dm(SCRIPT_MEASURE.replace("reports/runs/", "reports/runs/ data/clarity-history/")).some((d) => d.kind === "GIT_ADD_NOT_IN_MODEL" && /clarity-history/.test(d.detail)));
  assert.ok(kinds(SCRIPT_MEASURE.replace("group: measure", "group: main-writes")).includes("CONCURRENCY_NOT_IN_WORKFLOW"));
  // FN: betik cagrisi kalkarsa model commit diyor ama workflow yazmiyor
  assert.ok(kinds(wf("measure", "echo yok")).includes("MODEL_COMMIT_NOT_IN_WORKFLOW"));
  // FN: modelde commit eden isi olmayan workflow betik cagirirsa
  assert.ok(kinds(SCRIPT_MEASURE, "portfolio-check.yml").includes("COMMIT_NOT_IN_MODEL"));
  // FN (maskeleme): betik cagrisinin YANINA korumasiz satir ici git push eklenirse betik formu sayilmaz -> PUSH_STRATEGY_DRIFT
  const mixed = SCRIPT_MEASURE.replace("          reports/measure-latest.md", "          reports/measure-latest.md\n          git push");
  assert.equal(extractPushStrategy(mixed), "plain_push");
  assert.ok(kinds(mixed).includes("PUSH_STRATEGY_DRIFT"));
  assert.deepEqual(migrationPending({ "measure.yml": mixed }), []);
});

test("extractPersistCalls: devam satiri, tirnakli mesaj, --, sondaki yorum; FP: yorum / echo / git add scripts/ / baska betik", () => {
  assert.deepEqual(extractPersistCalls('bash scripts/persist-history.sh -m "a b (c) $(date +%F)" \\\n  data/clarity-history/'), [["data/clarity-history/"]]);
  assert.deepEqual(extractPersistCalls("bash scripts/persist-history.sh -m msg -- reports/ content/topic-ledger.json # not"), [["reports/", "content/topic-ledger.json"]]);
  assert.deepEqual(extractPersistCalls("run: ./scripts/persist-history.sh -m 'x y' reports/"), [["reports/"]]);
  assert.deepEqual(extractPersistCalls("bash scripts/persist-history.sh -m 'x' reports/ && echo reports/yok/"), [["reports/"]]);
  assert.deepEqual(extractPersistCalls("# bash scripts/persist-history.sh -m x reports/\n"), []);
  assert.deepEqual(extractPersistCalls("echo bash scripts/persist-history.sh -m x reports/\n"), []);
  assert.deepEqual(extractPersistCalls("git add scripts/persist-history.sh\n"), []);
  assert.deepEqual(extractPersistCalls("bash scripts/other.sh reports/\n"), []);
  assert.equal(extractPushStrategy("# bash scripts/persist-history.sh -m x reports/\n"), null);
  assert.deepEqual(extractGitAddPaths("git add scripts/persist-history.sh\n"), ["scripts/persist-history.sh"]); // gercek git add: yol sayilir (modelde yoksa drift)
});

test("drift FP: yorumdaki git push / git add / concurrency sayilmaz", () => {
  assert.equal(extractPushStrategy("# git push\n  # git pull --rebase\n"), null);
  assert.equal(extractPushStrategy("run: |\n  git pull --rebase origin main\n  git push\n"), "rebase_then_push");
  assert.equal(extractPushStrategy("run: |\n  git push\n  # git pull --rebase\n"), "plain_push");
  assert.deepEqual(extractGitAddPaths("  # git add data/x/\n  git add -A reports/ content/a.json\n  [ -f x ] && git add y/\n"), ["reports/", "content/a.json", "y/"]);
  assert.equal(extractConcurrencyGroup("# concurrency:\n#   group: x\n"), null);
  assert.equal(extractConcurrencyGroup('concurrency:\n  group: "g-${{ inputs.site }}"\n  cancel-in-progress: false\n'), "g-${{ inputs.site }}");
  // git add -A bayragi bir yol sayilmaz
  assert.ok(!extractGitAddPaths("git add -A").length);
});

test("markdown: tarihce sahipligi tablosu ve ortak grup bulgusu gorunur", () => {
  const md = modelToMarkdown();
  assert.match(md, /Tarihce sahipligi/); assert.match(md, /data\/deployment-timeline\//); assert.match(md, /MAIN_COMMIT_RACE/); assert.match(md, /\(okunmuyor\)/);
});

test("docs/history-ownership.md modeldeki her yolu, her sahibi ve her yeni kodu adiyla anar (belge/kod drift'i)", () => {
  const doc = readFileSync(new URL("../docs/history-ownership.md", import.meta.url), "utf8");
  for (const o of HISTORY_OWNERS) { assert.ok(doc.includes(o.path), `docs: ${o.path}`); assert.ok(doc.includes(o.owner_job), `docs: ${o.owner_job}`); assert.ok(doc.includes(o.schema), `docs: ${o.schema}`); }
  for (const c of [...OWNERSHIP_CODES, "MAIN_COMMIT_RACE", "PUSH_WITHOUT_REBASE"]) assert.ok(doc.includes(c), `docs: ${c}`);
  assert.ok(doc.includes(TARGET_COMMIT_GROUP));
});
