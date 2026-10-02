// Orkestrasyon modeli testleri: gercek workflow dosyalarini okuyup modelle karsilastirir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { JOBS, QUOTA_POOLS, parseCron, fireSlots, validateModel, diffWorkflows, extractWorkflowCrons, modelToMarkdown, type Job } from "../src/orchestration.ts";

const WF_DIR = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(readdirSync(WF_DIR).filter((f) => f.endsWith(".yml")).map((f) => [f, readFileSync(new URL(f, WF_DIR), "utf8")]));
const clone = (): Job[] => JSON.parse(JSON.stringify(JOBS));
const codes = (jobs: Job[]): string[] => validateModel(jobs, QUOTA_POOLS).map((i) => i.code);
const job = (j: Job[], id: string) => j.find((x) => x.id === id)!;

test("gercek workflow'lar: modelde olmayan schedule yok, modeldeki cron workflow'da var, her workflow modelde", () => {
  assert.ok(Object.keys(workflows).length >= 8);
  assert.deepEqual(diffWorkflows(workflows), []);
});

test("drift yakalanir (FN): workflow'a yeni cron eklenirse ve model degismezse test kirilir", () => {
  const w = { ...workflows, "measure.yml": workflows["measure.yml"].replace('"40 6 * * 1"', '"40 6 * * 1"\n    - cron: "0 3 * * *"') };
  assert.ok(diffWorkflows(w).some((x) => x.kind === "SCHEDULE_NOT_IN_MODEL" && x.detail.includes("0 3 * * *")));
  assert.ok(diffWorkflows({ ...workflows, "yeni.yml": 'on:\n  schedule:\n    - cron: "1 1 * * *"\n' }).some((x) => x.kind === "WORKFLOW_NOT_IN_MODEL"));
});

test("drift FP: yorumdaki ornek cron schedule sayilmaz", () => {
  assert.deepEqual(extractWorkflowCrons('# - cron: "5 5 * * *"\n  schedule:\n    - cron: "1 2 * * 3"\n'), ["1 2 * * 3"]);
});

test("model, workflow'da degisen cron'u ve kaybolan kapiyi da yakalar", () => {
  const moved = { ...workflows, "clarity-daily.yml": workflows["clarity-daily.yml"].replace('"20 7 * * *"', '"21 7 * * *"') };
  assert.ok(diffWorkflows(moved).some((x) => x.kind === "MODEL_CRON_NOT_IN_WORKFLOW"));
  const noGate = { ...workflows, "clarity-daily.yml": workflows["clarity-daily.yml"].replaceAll("SEARCH_GROWTH_CLARITY_DAILY_ENABLED", "X") };
  assert.ok(diffWorkflows(noGate).some((x) => x.kind === "GATE_NOT_IN_WORKFLOW"));
});

test("tohum model: ayni Clarity havuzunda kopya zamanlayici isaretlenir (legacy + clarity-daily)", () => {
  const issues = validateModel();
  const dup = issues.find((i) => i.code === "DUPLICATE_SCHEDULER");
  assert.ok(dup && dup.severity === "ERROR");
  assert.deepEqual([...dup.jobs].sort(), ["clarity-daily", "legacy-site-health-monitor"]);
  const near = issues.find((i) => i.code === "QUOTA_NEAR_LIMIT");
  assert.ok(near && near.message.includes("9/10"), "legacy 3 + clarity.yml 3 + daily 3 = 9/10");
});

test("FP: legacy kapaninca kopya zamanlayici ve yakin-tavan uyarisi kalkar", () => {
  const j = clone(); job(j, "legacy-site-health-monitor").state = "DISABLED";
  assert.ok(!codes(j).includes("DUPLICATE_SCHEDULER"));
  assert.ok(!codes(j).includes("QUOTA_NEAR_LIMIT"));
});

test("FP: PLANNED is kotayi tuketmez", () => {
  const j = clone(); job(j, "clarity-daily").state = "PLANNED";
  assert.ok(!codes(j).includes("DUPLICATE_SCHEDULER"));
});

test("kota tavani asilirsa ERROR", () => {
  const j = clone(); const m = job(j, "clarity-manual"); m.api_calls_per_site = 5; m.quota_cost!.per_site = 5;
  assert.ok(validateModel(j).some((i) => i.code === "QUOTA_OVERBOOKED" && i.severity === "ERROR"));
});

test("UNKNOWN maliyet toplama sayilmaz ve tavan asildi iddiasi uydurmaz", () => {
  assert.ok(!codes(clone()).includes("QUOTA_OVERBOOKED"));
});

test("cakisma: measure+search-audit ayni dakika ama farkli kaynak -> INFO; ayni havuz -> WARN", () => {
  const ms = validateModel().find((i) => i.code === "SCHEDULE_COLLISION" && i.jobs.includes("measure") && i.jobs.includes("search-audit"));
  assert.ok(ms && ms.severity === "INFO");
  const j = clone(); job(j, "clarity-daily").cron = "10 6 * * *"; // legacy ile ayni dakika, ayni havuz
  const w = validateModel(j).find((i) => i.code === "SCHEDULE_COLLISION" && i.jobs.includes("clarity-daily") && i.jobs.includes("legacy-site-health-monitor"));
  assert.ok(w && w.severity === "WARN");
});

test("cakisma FN: gunluk cron haftalik cron ile pazartesi dakikasinda carpisir", () => {
  assert.ok(validateModel().some((i) => i.code === "SCHEDULE_COLLISION" && i.jobs.includes("legacy-site-health-monitor") && i.jobs.includes("portfolio-check")));
});

test("cron ayristirma: gecerli/gecersiz", () => {
  assert.ok(parseCron("20 7 * * *")); assert.ok(parseCron("*/15 0-6 * * 1,3")); assert.ok(parseCron("0 0 * * 7"));
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "a b c d e", "*/0 * * * *", "5-2 * * * *", "* * 0 * *", "1 2 3 4 5 6"]) assert.equal(parseCron(bad), null, bad);
  assert.equal(fireSlots("20 7 * * *").size, 7);
  assert.deepEqual([...fireSlots("40 6 * * 1")], ["1@06:40"]);
  assert.equal(fireSlots("bozuk").size, 0);
});

test("dogrulayici sema hatalari yakalanir", () => {
  const j = clone();
  job(j, "measure").cron = "99 * * * *";
  delete job(j, "portfolio-check").cron;
  delete job(j, "clarity-daily").gate;
  job(j, "brain").depends_on = ["yok"];
  job(j, "index-probe").quota_cost!.pool = "yok-havuz";
  job(j, "tests-ci").loop = "daily";
  j.push({ ...j[0] });
  const c = codes(j);
  for (const k of ["BAD_CRON", "MISSING_CRON", "GATE_REQUIRED", "UNKNOWN_DEPENDENCY", "UNKNOWN_POOL", "DUPLICATE_ID", "LOOP_MISMATCH"]) assert.ok(c.includes(k), k);
});

test("model: yeni katmanlar PLANNED, event isi cron tasimaz, legacy ccr_routine", () => {
  for (const id of ["lighthouse-weekly", "index-alarms-daily", "deployment-verifier", "scorecard-weekly"]) assert.equal(JOBS.find((j) => j.id === id)?.state, "PLANNED");
  assert.equal(JOBS.find((j) => j.id === "deployment-verifier")!.cadence, "event");
  assert.equal(JOBS.find((j) => j.id === "legacy-site-health-monitor")!.runner, "ccr_routine");
  assert.equal(JOBS.find((j) => j.id === "legacy-site-health-monitor")!.cron, "10 6 * * *");
});

test("markdown cikti bulgulari icerir", () => {
  const md = modelToMarkdown();
  assert.match(md, /DUPLICATE_SCHEDULER/); assert.match(md, /clarity-daily/);
});
