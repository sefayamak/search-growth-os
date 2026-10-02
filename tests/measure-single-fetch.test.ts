// measure: TEK GSC fetch -> Markdown + sgos.measure-report.v1 + (mevcut) topics. Canli ag YOK: tum Google yanitlari
// tests/fixtures/measure-report/*.mjs preload'lariyla sahte; saat sabit (2026-10-02T06:40Z).
// Bu dosya workflow'un gercek bash adimlarini (measure.yml'den cikarilip) sahte `node` ile calistirir: hata semantigi
// metin taramasiyla degil, davranisla kanitlanir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildMeasureReport, buildSiteReport, type MeasureReport, type SiteMeasureInput } from "../src/measure-report.ts";
import { extractPersistCalls } from "../src/orchestration.ts";
import { buildScorecard, searchOpportunity } from "../src/scorecard.ts";

const ROOT = resolve(".");
const FX = join(ROOT, "tests/fixtures/measure-report");
const REG = join(FX, "sites.fixture.json");
const WF = readFileSync(join(ROOT, ".github/workflows/measure.yml"), "utf8");
const GOLDEN = readFileSync(join(FX, "measure-stdout.golden.txt"), "utf8");
const NODE = process.execPath;

function saJson() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({ client_email: "b@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
}
const CREDS = saJson();

function cleanEnv(extra: Record<string, string> = {}, withCreds = true): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), SEARCH_GROWTH_GA4_CREDENTIALS_JSON: "", ...extra };
  delete e.GITHUB_SHA; delete e.SEARCH_GROWTH_GSC_CREDENTIALS_JSON;
  if (withCreds) e.SEARCH_GROWTH_GSC_CREDENTIALS_JSON = CREDS;
  return e;
}

function runCli(args: string[], o: { imports?: string[]; log?: string; withCreds?: boolean; registry?: string } = {}) {
  const imports = ["mock-google.mjs", ...(o.log ? ["count-gsc.mjs"] : []), ...(o.imports ?? [])].flatMap((f) => ["--import", join(FX, f)]);
  const r = spawnSync(NODE, [...imports, "--experimental-strip-types", join(ROOT, "src/cli.ts"), "measure", o.registry ?? REG, ...args], {
    cwd: ROOT, encoding: "utf8", env: cleanEnv(o.log ? { MOCK_GSC_LOG: o.log } : {}, o.withCreds ?? true),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const callsOf = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const perProp = (lines: string[]) => lines.reduce<Record<string, string[]>>((a, l) => { const [p, d] = l.split("\t"); (a[p] ??= []).push(d); return a; }, {});

// ---- ortak kosu: --out ile TEK kosu -----------------------------------------------------------------------------
const logOut = join(tmp("sf-log-"), "calls.log");
const outDir = join(tmp("sf-out-"), "measure-json");
const withOut = runCli(["--out", outDir], { log: logOut });
const report: MeasureReport = JSON.parse(readFileSync(join(outDir, "measure-report.json"), "utf8"));
const logPlain = join(tmp("sf-log2-"), "calls.log");
const plain = runCli([], { log: logPlain });

// A ---------------------------------------------------------------------------------------------------------------
test("A: GSC cagri sayisi — saglikli site basina TAM 4 (2 sorgu + 2 toplam), --out ile/siz AYNI; JSON ek cagri uretmez", () => {
  assert.equal(withOut.code, 0, withOut.stderr);
  const a = perProp(callsOf(logOut)); const b = perProp(callsOf(logPlain));
  for (const prop of ["pamistanbul", "pamaistudio", "rightlisted", "untitledportraits", "myhappymade"].map((s) => `sc-domain:${s}.test`)) {
    assert.deepEqual([...a[prop]].sort(), ["(total)", "(total)", "query", "query"], `${prop} (--out ile)`);
    assert.deepEqual([...b[prop]].sort(), [...a[prop]].sort(), `${prop}: --out cagri sayisini degistirmemeli`);
  }
  // 403 site (spryhand): --out ile/siz ayni sayida istek.
  assert.deepEqual(a["sc-domain:spryhand.test"], b["sc-domain:spryhand.test"]);
});

test("A2: eski #45 tasarimi (measure'u IKI kez kosmak) ayni site icin 8 cagri uretirdi — bu yuzden tek kosu zorunlu", () => {
  const log = join(tmp("sf-log3-"), "calls.log");
  runCli([], { log }); runCli(["--out", tmp("sf-x-")], { log });
  assert.equal(perProp(callsOf(log))["sc-domain:pamistanbul.test"].length, 8);
  assert.equal((WF.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").match(/src\/cli\.ts measure\b/g) ?? []).length, 1, "workflow'da tek measure cagrisi");
});

// B ---------------------------------------------------------------------------------------------------------------
test("B: Markdown (stdout) --out ile ve --out'suz BAYT-BAYT eski golden", () => {
  assert.equal(plain.stdout, GOLDEN);
  assert.equal(withOut.stdout, GOLDEN);
});

// C / D ------------------------------------------------------------------------------------------------------------
test("C: JSON donemleri Markdown'daki donemlerle ayni (tek saat, tek hesap)", () => {
  const m = [...withOut.stdout.matchAll(/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/g)].map((x) => [x[1], x[2]]);
  assert.equal(m.length >= 3, true);
  for (const s of Object.values(report.sites)) {
    assert.deepEqual([s.period.start, s.period.end], m[0]);
    assert.deepEqual([s.comparison_period.start, s.comparison_period.end], m[2]); // m[1] = onceki 28 gun (JSON'da yok)
  }
});

test("D: tek zaman damgasi — generated_at, site generated_at ve olculen sitelerin retrieved_at'i ayni", () => {
  const t = report.generated_at;
  assert.equal(t, "2026-10-02T06:40:00.000Z");
  for (const s of Object.values(report.sites)) {
    assert.equal(s.generated_at, t);
    if (s.gsc.state === "MEASURED") assert.equal(s.gsc.retrieved_at, t);
    else assert.equal(s.gsc.retrieved_at, null, "olculmeyen sitede retrieved_at uydurulmaz");
  }
});

// E / F / P / Q / M ------------------------------------------------------------------------------------------------
const card = (site: string, r: unknown = report) => buildScorecard({ site_id: site, onboarding_status: "active", measure: r }, new Date(report.generated_at)).dimensions.find((d) => d.dimension === "search_opportunity")!;

test("E+P: olculmus TAM sifir 0 KALIR (MEASURED, pozisyon null) ve skorkartta OK — UNKNOWN degil", () => {
  const z = report.sites.pamaistudio;
  assert.equal(z.gsc.state, "MEASURED");
  assert.deepEqual([z.gsc.totals.clicks, z.gsc.totals.impressions], [0, 0]);
  assert.equal(z.gsc.totals.position, null);
  assert.equal(z.gsc.totals_source, "api_empty_response");
  assert.equal(z.gsc.rows_complete, true);
  assert.equal(z.opportunity_count, 0);
  const d = card("pamaistudio");
  assert.equal(d.state, "OK"); assert.equal(d.evidence_label, "INFERENCE");
});

test("F: UNKNOWN/ERROR korunur — spryhand(403): tum metrikler null, tablo bos, firsat sayisi null, GA4 null; skorkart UNKNOWN", () => {
  const s = report.sites.spryhand;
  assert.equal(s.gsc.state, "ERROR");
  assert.deepEqual(Object.values(s.gsc.totals), [null, null, null, null]);
  assert.deepEqual(s.gsc.queries, []);
  assert.equal(s.opportunity_count, null);
  assert.equal(s.gsc.rows_complete, null);
  assert.ok(Object.values(s.ga4.metrics).every((v) => v === null));
  assert.equal(card("spryhand").state, "UNKNOWN");
});

test("Q+M: opportunity_count>0 -> ATTENTION/INFERENCE/CANDIDATE; skorkart uretilen dosyayi okur", () => {
  const s = report.sites.pamistanbul;
  assert.ok(s.opportunity_count! > 0);
  const d = card("pamistanbul");
  assert.equal(d.state, "ATTENTION"); assert.equal(d.evidence_label, "INFERENCE"); assert.equal(d.confidence, "CANDIDATE");
});

test("N: bayat rapor UNKNOWN-STALE (11 gun), asla OK/ATTENTION", () => {
  const later = new Date(new Date(report.generated_at).getTime() + 11 * 86400_000);
  for (const site of ["pamistanbul", "pamaistudio"]) assert.equal(searchOpportunity(report, site, later).state, "UNKNOWN-STALE");
});

test("O: tamamlanmamis/dogrulanmamis sifir UNKNOWN — 0 kanit sayilmaz", () => {
  for (const rc of [false, null]) {
    const raw = JSON.parse(JSON.stringify(report));
    raw.sites.pamaistudio.gsc.rows_complete = rc;
    assert.equal(card("pamaistudio", raw).state, "UNKNOWN", `rows_complete=${rc}`);
  }
});

// G ----------------------------------------------------------------------------------------------------------------
test("G: marka / marka-disi — JSON, Markdown'daki satirlarla ayni sayilar", () => {
  const block = withOut.stdout.split(/\n(?=[a-z]+\n  GSC property)/).find((b) => b.startsWith("pamistanbul\n"))!;
  const grab = (label: string) => { const m = new RegExp(`\\n  ${label}\\s*: (\\d+) tık · (\\d+) gösterim · ort\\. ([\\d.]+) · (\\d+) sorgu`).exec(block); assert.ok(m, label); return m!.slice(1); };
  const bs = report.sites.pamistanbul.gsc.brand_split!;
  const [bc, bi, bp, bq] = grab("marka"); const [nc, ni, np, nq] = grab("marka dışı");
  assert.deepEqual([bs.brand.clicks, bs.brand.impressions, bs.brand.position!.toFixed(1), bs.brand.queries], [Number(bc), Number(bi), bp, Number(bq)]);
  assert.deepEqual([bs.non_brand.clicks, bs.non_brand.impressions, bs.non_brand.position!.toFixed(1), bs.non_brand.queries], [Number(nc), Number(ni), np, Number(nq)]);
  for (const q of report.sites.pamistanbul.gsc.queries) assert.equal(q.brand_class, q.query === "pam istanbul" ? "brand" : "non_brand");
});

// H ----------------------------------------------------------------------------------------------------------------
test("H: sorgu satirlari sinirli (500) ama toplamlar/marka ayrimi TUM satirlardan; kesme bayragi dogru", () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ query: `q${i}`, clicks: 1, impressions: 100 + i, ctr: 0.01, position: 8 }));
  const input: SiteMeasureInput = { siteId: "x", gscProperty: "sc-domain:x.test", ga4Property: "1", patterns: ["zzz"], ga4Status: { state: "NOT_CONNECTED", note: "n" },
    outcome: { kind: "ok", current: rows, yearAgo: null, currentTotal: [{ clicks: 600, impressions: 99999, ctr: 0, position: 8 }], yearAgoTotal: null } };
  const s = buildSiteReport(input, { now: new Date("2026-10-02T06:40:00Z"), current: { label: "a", start: "2026-09-01", end: "2026-09-28" }, yearAgo: { label: "b", start: "2025-09-02", end: "2025-09-29" }, toolVersion: "t" });
  assert.equal(s.gsc.queries.length, 500);
  assert.deepEqual([s.gsc.coverage.query_rows_total, s.gsc.coverage.query_rows_returned, s.gsc.coverage.queries_truncated], [600, 500, true]);
  assert.equal(s.gsc.brand_split!.non_brand.queries, 600);
  assert.equal(s.opportunity_count, 600);
});

// I ----------------------------------------------------------------------------------------------------------------
test("I: yanlis site imkansiz — anahtar=site_id, property sitenin kendi property'si, baska sitenin girdisi okunmaz", () => {
  const reg = JSON.parse(readFileSync(REG, "utf8")) as { sites: Array<{ id: string; google_search_console_property: string }> };
  assert.deepEqual(Object.keys(report.sites).sort(), reg.sites.map((s) => s.id).sort());
  for (const s of reg.sites) {
    const r = report.sites[s.id];
    assert.equal(r.site_id, s.id);
    // Registry'de property yoksa sentinel (NOT_CONNECTED/UNKNOWN) JSON'da null olur; baska sitenin property'si asla yazilmaz.
    assert.equal(r.gsc.source.property, ["NOT_CONNECTED", "UNKNOWN", ""].includes(s.google_search_console_property) ? null : s.google_search_console_property);
  }
  const swapped = JSON.parse(JSON.stringify(report));
  swapped.sites.rightlisted = swapped.sites.pamistanbul; // baska sitenin girdisi yanlis anahtarda
  assert.equal(card("rightlisted", swapped).state, "UNKNOWN");
});

// J ----------------------------------------------------------------------------------------------------------------
test("J: bozuk upstream fail-closed — yalniz o site ERROR (null + sebep), Markdown'da HATA, diger siteler birebir ayni", () => {
  const out2 = join(tmp("sf-bad-"), "measure-json");
  const bad = runCli(["--out", out2], { imports: ["mock-google-malformed.mjs"] });
  assert.equal(bad.code, 0, bad.stderr);
  const r: MeasureReport = JSON.parse(readFileSync(join(out2, "measure-report.json"), "utf8"));
  const s = r.sites.pamistanbul;
  assert.equal(s.gsc.state, "ERROR");
  assert.match(s.gsc.state_reason!, /beklenmeyen GSC yaniti/);
  assert.deepEqual(Object.values(s.gsc.totals), [null, null, null, null]);
  assert.equal(s.opportunity_count, null);
  assert.match(bad.stdout, /pamistanbul\n(?:.*\n)*?  veri         : HATA — beklenmeyen GSC yaniti/);
  assert.doesNotMatch(bad.stdout, /NaN/);
  for (const id of Object.keys(report.sites).filter((x) => x !== "pamistanbul")) assert.deepEqual(r.sites[id], report.sites[id], `${id} etkilenmemeli`);
  assert.equal(card("pamistanbul", r).state, "UNKNOWN");
});

test("J2: normalizasyon patlarsa (NaN) tek site ERROR olur, rapor ve diger siteler saglam", () => {
  const ok = (id: string): SiteMeasureInput => ({ siteId: id, gscProperty: `sc-domain:${id}.test`, ga4Property: "1", patterns: [], ga4Status: { state: "NOT_CONNECTED", note: "n" },
    outcome: { kind: "ok", current: [{ query: "a", clicks: 1, impressions: 10, ctr: 0.1, position: 3 }], yearAgo: null, currentTotal: [{ clicks: 1, impressions: 10, ctr: 0.1, position: 3 }], yearAgoTotal: null } });
  const broken = ok("b"); (broken.outcome as { current: unknown[] }).current = [{ query: "a", clicks: 1, ctr: 0.1, position: 3 }];
  const r = buildMeasureReport([ok("a"), broken, ok("c")], { now: new Date("2026-10-02T06:40:00Z"), current: { label: "a", start: "2026-09-01", end: "2026-09-28" }, yearAgo: { label: "b", start: "2025-09-02", end: "2025-09-29" }, toolVersion: "t" });
  assert.equal(r.sites.a.gsc.state, "MEASURED"); assert.equal(r.sites.c.gsc.state, "MEASURED");
  assert.equal(r.sites.b.gsc.state, "ERROR");
  assert.equal(JSON.stringify(r).includes("NaN"), false);
});

// ---- Workflow adimlarini GERCEK bash ile calistir ---------------------------------------------------------------
function stepRun(name: string): string {
  const lines = WF.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, name);
  const r = lines.findIndex((l, k) => k > i && l.trim() === "run: |");
  const out: string[] = [];
  for (let k = r + 1; k < lines.length && (lines[k].startsWith("          ") || lines[k].trim() === ""); k++) out.push(lines[k].slice(10));
  return out.join("\n");
}

/** Sahte `node`: workflow'un `node --experimental-strip-types src/cli.ts measure config/sites.yaml ...` satirini fixture
 *  registry + sahte Google ile calistirir; FAIL_JSON=1 ise JSON hedefini DIZIN yapip yazimi basarisiz kilar. */
function shim(dir: string) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  const sh = join(bin, "node");
  writeFileSync(sh, `#!/bin/bash
args=("$@")
for i in "\${!args[@]}"; do
  case "\${args[$i]}" in
    config/sites.yaml) args[$i]="\${SHIM_REGISTRY}";;
    src/cli.ts) args[$i]="${ROOT}/src/cli.ts";;
  esac
done
if [ "\${FAIL_JSON:-}" = "1" ]; then mkdir -p measure-json/measure-report.json; fi
exec "${NODE}" --import ${FX}/mock-google.mjs "\${args[@]}"
`);
  chmodSync(sh, 0o755);
  return bin;
}
function runStep(name: string, cwd: string, bin: string, env: Record<string, string> = {}, subst: Record<string, string> = {}) {
  let script = stepRun(name);
  for (const [k, v] of Object.entries(subst)) script = script.split(k).join(v);
  const out = join(cwd, "gh-output"); const summary = join(cwd, "gh-summary");
  writeFileSync(out, existsSync(out) ? readFileSync(out) : ""); writeFileSync(summary, existsSync(summary) ? readFileSync(summary) : "");
  const r = spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8", env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, SHIM_REGISTRY: REG, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ghOutput: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
}
const JF = "${{ steps.measure.outputs.json_failed }}";

test("K1: workflow 'Ölçüm' adimi (gercek bash) — basari: Markdown golden, JSON var, json_failed yok, adim 0", () => {
  const d = tmp("sf-wf-ok-"); const bin = shim(d);
  const r = runStep("Ölçüm", d, bin);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(d, "measure.txt"), "utf8"), GOLDEN);
  assert.ok(existsSync(join(d, "measure-json/measure-report.json")));
  assert.doesNotMatch(r.ghOutput, /json_failed/);
});

test("K2: JSON yazimi basarisiz — adim 0 (Markdown + devam), json_failed=true, ::warning::, measure.txt tam; JSON dosyasi yok, tmp artigi yok", () => {
  const d = tmp("sf-wf-jf-"); const bin = shim(d);
  const r = runStep("Ölçüm", d, bin, { FAIL_JSON: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.ghOutput, /json_failed=true/);
  assert.match(r.stdout, /::warning::sgos\.measure-report\.v1 JSON üretilemedi/);
  assert.equal(readFileSync(join(d, "measure.txt"), "utf8"), GOLDEN, "Markdown KAYBOLMADI");
  assert.ok(existsSync(join(d, "measure-json/measure-report.error.txt")));
  assert.ok(!readdirSync(join(d, "measure-json")).some((f) => f.endsWith(".tmp")));
});

test("K3: olcum cokmesi (registry okunamadi) — isaret YOK -> adim ayni kodla KIRMIZI (gizlenmez)", () => {
  const d = tmp("sf-wf-crash-"); const bin = shim(d);
  const r = runStep("Ölçüm", d, bin, { SHIM_REGISTRY: join(d, "yok.yaml") });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.ghOutput, /json_failed/);
});

test("K4: yerlestir adimi — basari: canonical dosya yazilir; JSON basarisiz: ESKI dosyaya dokunulmaz, uyari ozeti", () => {
  const d = tmp("sf-wf-place-"); const bin = shim(d);
  runStep("Ölçüm", d, bin);
  const okR = runStep("Ölçüm JSON'unu yerleştir", d, bin, {}, { [JF]: "" });
  assert.equal(okR.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "reports/measure-report-latest.json"), "utf8")), report);
  assert.match(okR.summary, /yazıldı/);
  // basarisiz kosu: eski latest korunur
  const d2 = tmp("sf-wf-place2-"); const bin2 = shim(d2);
  mkdirSync(join(d2, "reports")); writeFileSync(join(d2, "reports/measure-report-latest.json"), '{"old":true}\n');
  runStep("Ölçüm", d2, bin2, { FAIL_JSON: "1" });
  const failR = runStep("Ölçüm JSON'unu yerleştir", d2, bin2, {}, { [JF]: "true" });
  assert.equal(failR.code, 0);
  assert.equal(readFileSync(join(d2, "reports/measure-report-latest.json"), "utf8"), '{"old":true}\n');
  assert.match(failR.summary, /UYARI: sgos\.measure-report\.v1 JSON üretilemedi/);
});

test("K5: kapi — JSON basariliysa 0; json_failed ya da dosya yoksa KIRMIZI (hata mesajiyla)", () => {
  const d = tmp("sf-wf-gate-"); const bin = shim(d);
  runStep("Ölçüm", d, bin);
  assert.equal(runStep("Ölçüm JSON kapısı", d, bin, {}, { [JF]: "" }).code, 0);
  const d2 = tmp("sf-wf-gate2-"); const bin2 = shim(d2);
  runStep("Ölçüm", d2, bin2, { FAIL_JSON: "1" });
  const g = runStep("Ölçüm JSON kapısı", d2, bin2, {}, { [JF]: "true" });
  assert.equal(g.code, 1);
  assert.match(g.stdout, /::error::sgos\.measure-report\.v1 JSON anlık görüntüsü üretilemedi/);
  const g2 = runStep("Ölçüm JSON kapısı", tmp("sf-wf-gate3-"), bin, {}, { [JF]: "" }); // dosya hic yok
  assert.equal(g2.code, 1);
});

// ---- L: kalicilik — #43'te main'e giren sertlestirilmis betik --------------------------------------------------
test("L: workflow'un persist cagrisi hardened persist-history.sh'tan gecer; canonical JSON push edilir, gizli-gorunumlu dosya edilmez", () => {
  const paths = extractPersistCalls(WF)[0];
  assert.ok(paths.includes("reports/measure-report-latest.json"));
  const base = tmp("sf-persist-"); const remote = join(base, "remote.git");
  const g = (cwd: string, ...a: string[]) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  g(base, "init", "-q", "--bare", "-b", "main", remote);
  const work = join(base, "work"); g(base, "clone", "-q", `file://${remote}`, work);
  g(work, "checkout", "-q", "-B", "main"); g(work, "config", "user.name", "bot"); g(work, "config", "user.email", "b@t");
  writeFileSync(join(work, "README.md"), "x\n"); g(work, "add", "."); g(work, "commit", "-qm", "seed"); g(work, "push", "-q", "origin", "HEAD:main");
  mkdirSync(join(work, "reports/runs"), { recursive: true }); mkdirSync(join(work, "content"), { recursive: true });
  writeFileSync(join(work, "reports/measure-latest.md"), "# m\n"); writeFileSync(join(work, "reports/runs/2026-10-02-measure.md"), "# m\n");
  writeFileSync(join(work, "content/topic-ledger.json"), "{}\n");
  copyFileSync(join(outDir, "measure-report.json"), join(work, "reports/measure-report-latest.json"));
  writeFileSync(join(work, "reports/credentials.json"), '{"k":"sk-FAKE-0000000000000000000000000000dummy"}\n'); // sahte, gercek degil
  const r = spawnSync("bash", [join(ROOT, "scripts/persist-history.sh"), "-m", "ölçüm test", ...paths], { cwd: work, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PERSIST_BACKOFF_SECONDS: "0 0" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const files = g(remote, "ls-tree", "-r", "--name-only", "main").split("\n");
  for (const f of ["reports/measure-report-latest.json", "reports/measure-latest.md", "reports/runs/2026-10-02-measure.md", "content/topic-ledger.json"]) assert.ok(files.includes(f), f);
  assert.ok(!files.includes("reports/credentials.json"), "gizli-gorunumlu dosya push edilmemeli");
  assert.deepEqual(JSON.parse(g(remote, "show", "main:reports/measure-report-latest.json")), report);
});

// ---- topics/ledger: mevcut davranis ---------------------------------------------------------------------------
test("topics/ledger: workflow adimi ayni komut ve ledger yolu; measure adimina bagli degil (mevcut davranis)", () => {
  const code = WF.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(code, /src\/cli\.ts topics config\/sites\.yaml \\\n\s+--count 2 --top 10 --ledger content\/topic-ledger\.json --write-ledger \| tee topics\.txt/);
  const i = WF.indexOf("- name: Konu fırsatı");
  assert.match(WF.slice(i, i + 400), /continue-on-error: true/);
});
