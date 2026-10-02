// measure.yml <-> sgos.measure-report.v1 sozlesmesi. Workflow'u CALISTIRMAZ; metni okur ve ayni komutu sahte Google ile kosar.
// Amac: JSON eklenirken tek-yazici/izin-listesi/cron/izin degismezlerinin ve Markdown yolunun bozulmadigini kilitlemek.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPersistCalls } from "../src/orchestration.ts";
import { buildScorecard, searchOpportunity } from "../src/scorecard.ts";

const WF = readFileSync(".github/workflows/measure.yml", "utf8");
const SCRIPT = readFileSync("scripts/persist-history.sh", "utf8");
const FX = "tests/fixtures/measure-report";
const LATEST = "reports/measure-report-latest.json";
const code = WF.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const allowed = (() => {
  const m = /^ALLOWED=\((.*)\)\s*$/m.exec(SCRIPT);
  assert.ok(m, "ALLOWED dizisi betikte bulunamadi");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();
const isAllowed = (p: string) => !!p && !p.startsWith("/") && !p.includes("..") && allowed.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a));

test("degismezler: cron, izinler, concurrency, tetikleyiciler", () => {
  assert.equal([...code.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]).join("|"), "40 6 * * 1");
  assert.match(code, /permissions:\n {2}contents: write[^\n]*\n/);
  assert.doesNotMatch(code, /^\s+(issues|pull-requests|actions|id-token|packages):/m);
  assert.match(code, /concurrency:\n {2}group: measure\n {2}cancel-in-progress: false\n/);
  assert.match(code, /^on:\n {2}workflow_dispatch:/m);
  assert.equal((code.match(/^ {2}(schedule|workflow_dispatch|push|pull_request\w*|workflow_run):/gm) ?? []).length, 2, "yalniz schedule + workflow_dispatch");
  assert.doesNotMatch(code, /pull_request|workflow_run|repository_dispatch/);
});

test("tek yazici: tam bir persist-history.sh cagrisi, yollari izin listesinde, satir ici git push/commit YOK", () => {
  const calls = extractPersistCalls(WF);
  assert.equal(calls.length, 1);
  assert.equal((code.match(/persist-history\.sh/g) ?? []).length, 1);
  for (const p of calls[0]) assert.ok(isAllowed(p), `izin listesi disi yol: ${p} (ALLOWED=${allowed.join(",")})`);
  assert.ok(calls[0].includes(LATEST), "JSON canonical yolu persist cagrisinda");
  assert.ok(calls[0].includes("reports/measure-latest.md") && calls[0].includes("reports/runs/") && calls[0].includes("content/topic-ledger.json"), "mevcut yollar korunur");
  assert.doesNotMatch(code, /\bgit (push|commit|add)\b/, "satir ici git yazimi yok");
  assert.equal((code.match(/GITHUB_TOKEN|git remote|gh (pr|api)/g) ?? []).length, 0);
});

test("JSON adimi fail-safe: continue-on-error, sessiz degil (warning + step summary), yalniz --out ile uretir", () => {
  const i = WF.indexOf("id: measure_json");
  assert.ok(i > 0);
  const block = WF.slice(i, WF.indexOf("      # Gelir siteleri", i));
  assert.match(block, /continue-on-error: true/);
  assert.match(block, /measure config\/sites\.yaml --out measure-json/);
  assert.match(code, /steps\.measure_json\.outcome/);
  assert.match(code, /::warning::sgos\.measure-report\.v1 JSON üretilemedi/);
  assert.match(code, /UYARI: sgos\.measure-report\.v1 JSON üretilemedi[^\n]*GITHUB_STEP_SUMMARY/);
  // Basarisizlikta mevcut latest'e dokunulmaz (cp yalniz success dalinda).
  const place = WF.slice(WF.indexOf("- name: Ölçüm JSON'unu yerleştir"), WF.indexOf("- name: Özet"));
  assert.ok(place.indexOf("cp measure-json") < place.indexOf("else"), "cp yalniz basari dalinda");
  assert.ok(!place.slice(place.indexOf("else")).includes("cp "), "basarisizlik dalinda cp yok");
  // Karar: rolling snapshot. Tarihli JSON kopyasi (append-only gecmis) YOK; tek canonical yol yazilir.
  assert.equal((place.match(/\bcp /g) ?? []).length, 1);
  assert.doesNotMatch(code, /runs\/\S*measure-report/);
});

test("artifact listesi JSON'u icerir", () => {
  const art = WF.slice(WF.indexOf("name: Artifact"));
  assert.match(art, /^\s+reports\/measure-report-latest\.json$/m);
  assert.match(art, /^\s+measure-json\/measure-report\.json$/m);
  assert.match(art, /if: always\(\)/);
});

test("Markdown adimlari dokunulmamis: Olcum adimi ayni komut, rapor derleme ayni cikti", () => {
  assert.match(WF, /      - name: Ölçüm\n        env:\n(?:.*\n){2}        run: \|\n          set -o pipefail\n          node --experimental-strip-types src\/cli\.ts measure config\/sites\.yaml \| tee measure\.txt\n/);
  for (const s of [
    "} > reports/measure-latest.md",
    `cp reports/measure-latest.md "reports/runs/$(date -u +%Y-%m-%d)-measure.md"`,
    "cat measure.txt",
    "cat smoke.txt 2>/dev/null",
    "cat detail.txt 2>/dev/null",
    "cat topics.txt 2>/dev/null",
    `echo "# Ölçüm — $(date -u +%Y-%m-%d)"`,
    `cat reports/measure-latest.md >> "$GITHUB_STEP_SUMMARY"`,
    `-m "ölçüm: $(date -u +%Y-%m-%d) (otomatik)"`,
    "if: github.event_name == 'schedule' || inputs.commit_report",
  ]) assert.ok(WF.includes(s), `eksik: ${s}`);
  // Markdown'a JSON girmez: rapor derleme blogu JSON dosyasina referans vermez.
  const build = WF.slice(WF.indexOf("name: Raporu derle"), WF.indexOf("- name: Ölçüm JSON'unu yerleştir"));
  assert.doesNotMatch(build, /measure-report|measure-json/);
});

// ---- Sozlesme: workflow'un yazacagi dosya, skorkartin okudugu dosya ----------------------------------------------
function sa() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({ client_email: "b@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
}
function runLikeWorkflow(outDir: string, gsc: string | undefined) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SEARCH_GROWTH_GA4_CREDENTIALS_JSON: "" };
  delete env.GITHUB_SHA; delete env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON;
  if (gsc !== undefined) env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON = gsc;
  // Workflow'daki komutla ayni; yalniz registry fixture (sahte Google) ve mock yukleyici farkli.
  execFileSync("node", ["--import", `./${FX}/mock-google.mjs`, "--experimental-strip-types", "src/cli.ts", "measure", `${FX}/sites.fixture.json`, "--out", outDir], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const repoLike = mkdtempSync(join(tmpdir(), "measure-wf-"));
const outDir = join(repoLike, "measure-json");
runLikeWorkflow(outDir, sa());
// "Yerlestir" adiminin birebir kopyasi (cp measure-json/measure-report.json reports/measure-report-latest.json)
mkdirSync(join(repoLike, "reports"), { recursive: true });
copyFileSync(join(outDir, "measure-report.json"), join(repoLike, LATEST));

test("sozlesme: --out measure-json/ canonical yola kopyalaninca skorkart ayni dosyayi okur", () => {
  assert.ok(existsSync(join(outDir, "measure-report.json")));
  assert.ok(isAllowed(LATEST));
  const raw = JSON.parse(readFileSync(join(repoLike, LATEST), "utf8"));
  assert.equal(raw.schema, "sgos.measure-report.v1");
  assert.ok(Object.keys(raw.sites).includes("pamistanbul"));
  const card = buildScorecard({ site_id: "pamistanbul", onboarding_status: "pilot_onboarding", measure: raw }, new Date());
  const dim = card.dimensions.find((d) => d.dimension === "search_opportunity")!;
  assert.ok(["OK", "ATTENTION"].includes(dim.state), `olculmus rapor UNKNOWN okunmamali: ${dim.state} / ${dim.basis}`);
  assert.equal(dim.evidence_label, "INFERENCE");
  assert.equal(dim.confidence, "CANDIDATE");
});

test("sozlesme: tazelik (10 gun) — bayat olunca UNKNOWN-STALE, dosya yokken UNKNOWN, asla OK", () => {
  const raw = JSON.parse(readFileSync(join(repoLike, LATEST), "utf8"));
  const later = new Date(Date.now() + 11 * 86400_000);
  assert.equal(searchOpportunity(raw, "pamistanbul", later).state, "UNKNOWN-STALE");
  assert.equal(searchOpportunity(undefined, "pamistanbul", new Date()).state, "UNKNOWN");
});

test("sozlesme: kimlik yokken de JSON uretilir ve NOT_CONNECTED der (sifir degil)", () => {
  const d = mkdtempSync(join(tmpdir(), "measure-wf-nc-"));
  runLikeWorkflow(join(d, "measure-json"), undefined);
  const raw = JSON.parse(readFileSync(join(d, "measure-json", "measure-report.json"), "utf8"));
  assert.equal(searchOpportunity(raw, "pamistanbul", new Date()).state, "NOT_CONNECTED");
});
