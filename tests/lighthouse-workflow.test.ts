// lighthouse.yml <-> orchestration.ts (lighthouse-weekly ACTIVE) sozlesmesi. Workflow'u CALISTIRMAZ;
// metni statik olarak okur. Amac: secret'in hicbir sekilde yazdirilmamasi, tek-yazici/izin-listesi,
// cron/concurrency/dispatch degismezlerinin, 7-site canonical registry kullaniminin ve Option B
// (persisted-SHA dogrulama) deseninin clarity-daily.yml'den tutarli kopyalandiginin kilitlenmesi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractPersistCalls, extractWorkflowCrons, JOBS, diffWorkflows } from "../src/orchestration.ts";

const WF = readFileSync(".github/workflows/lighthouse.yml", "utf8");
const SCRIPT = readFileSync("scripts/persist-history.sh", "utf8");
const code = WF.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const allowed = (() => {
  const m = /^ALLOWED=\((.*)\)\s*$/m.exec(SCRIPT);
  assert.ok(m, "ALLOWED dizisi betikte bulunamadi");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();
const isAllowed = (p: string) => !!p && !p.startsWith("/") && !p.includes("..") && allowed.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a));

test("degismezler: cron, izinler, concurrency, tetikleyiciler", () => {
  assert.equal(extractWorkflowCrons(WF).join("|"), "10 7 * * 1");
  assert.equal(extractWorkflowCrons(WF)[0], JOBS.find((j) => j.id === "lighthouse-weekly")!.cron);
  assert.match(code, /permissions:\n {2}contents: write[^\n]*\n/);
  assert.doesNotMatch(code, /^\s+(issues|pull-requests|actions|id-token|packages):/m);
  assert.match(code, /concurrency:\n {2}group: main-writes\n {2}cancel-in-progress: false\n/);
  assert.match(code, /^on:\n {2}workflow_dispatch:/m);
  assert.equal((code.match(/^ {2}(schedule|workflow_dispatch|push|pull_request\w*|workflow_run):/gm) ?? []).length, 2, "yalniz schedule + workflow_dispatch");
  assert.doesNotMatch(code, /pull_request|workflow_run|repository_dispatch/);
});

test("secret: yalniz secrets.PAGESPEED_API_KEY -> env; hicbir adimda echo/log/CLI-argumani/artifact YOK", () => {
  assert.match(code, /PAGESPEED_API_KEY:\s*\$\{\{\s*secrets\.PAGESPEED_API_KEY\s*\}\}/);
  assert.equal((code.match(/secrets\.PAGESPEED_API_KEY/g) ?? []).length, 1, "secret tam bir yerde kullanilir");
  assert.doesNotMatch(code, /echo.*PAGESPEED_API_KEY/i);
  assert.doesNotMatch(code, /--key|--token|--secret/);
  // CLI'in kendisi de --key/--token/--secret seklinde bir argumani reddeder (src/cli.ts); burada ayrica hic verilmedigini de dogruluyoruz.
  assert.doesNotMatch(code, /performance-measure[^\n]*key/i);
});

test("tek yazici: tam bir persist-history.sh cagrisi, yolu izin listesinde, satir ici git push/commit YOK", () => {
  const calls = extractPersistCalls(WF);
  assert.equal(calls.length, 1);
  assert.equal((code.match(/persist-history\.sh/g) ?? []).length, 1);
  for (const p of calls[0]) assert.ok(isAllowed(p), `izin listesi disi yol: ${p} (ALLOWED=${allowed.join(",")})`);
  assert.ok(calls[0].includes("data/performance-history/"), "performans gecmisi yolu persist cagrisinda");
  assert.doesNotMatch(code, /\bgit (push|commit|add)\b/, "satir ici git yazimi yok");
});

test("canonical registry: ikinci bir 7-site listesi yok, config/sites.yaml kullanilir", () => {
  assert.match(code, /registry config\/sites\.yaml/);
  assert.match(code, /performance-measure config\/sites\.yaml/);
  // Workflow kendi icinde site id listesi (hard-code) tasimamali.
  assert.doesNotMatch(code, /pamaistudio|spryhand|decideplan|rightlisted|untitledportraits|myhappymade/);
});

test("Option B: persisted_sha cikisi var, verify-persistence tests-reusable.yml'i persisted_sha ile cagirir (github.sha DEGIL)", () => {
  assert.match(code, /outputs:\n {6}persisted_sha: \$\{\{ steps\.persist\.outputs\.persisted_sha \}\}/);
  assert.match(code, /uses: \.\/\.github\/workflows\/tests-reusable\.yml/);
  assert.match(code, /ref: \$\{\{ needs\.lighthouse-weekly\.outputs\.persisted_sha \}\}/);
  assert.doesNotMatch(code, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(code, /if: needs\.lighthouse-weekly\.outputs\.persisted_sha != ''/);
});

test("artifact adlandirmasi modelle eslesir: lighthouse-<run_id>", () => {
  assert.match(code, /name: lighthouse-\$\{\{ github\.run_id \}\}/);
});

test("model <-> workflow drift yok (diffWorkflows tam modelin bir parcasi olarak dogrular)", () => {
  const workflows: Record<string, string> = { "lighthouse.yml": WF };
  const issues = diffWorkflows(workflows).filter((i) => i.workflow === "lighthouse.yml");
  assert.deepEqual(issues, []);
});
