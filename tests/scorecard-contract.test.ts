// Scorecard <-> URETICI sozlesme testleri (#32 deployment-timeline, #34 index-alarms, #36 performance).
//
// Uc katman:
//  A) tests/fixtures/scorecard-contracts/*.json = ureticilerin GERCEK kurucularindan uretilmis cikti (modul yokken de kosar);
//  B) CONSUMED_PRODUCER_FIELDS listesi fixture'larda ve docs/scorecard-contracts.md'de aranir (alan drift'i);
//  C) uretici modul repoda VARSA gercek round-trip: kurucular tekrar kosulur, cikti fixture ile birebir ve scorecard ayni boyutu verir.
//     Modul YOKSA test FAIL degil SKIP (neden yazili): uretici PR'lari main'e girince otomatik devreye girer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildScorecard, CONSUMED_PRODUCER_FIELDS, SCHEMA_IDS, dimensionInvariantProblems, type Dimension } from "../src/scorecard.ts";
import { GEN_NOW, FIXTURE_FILES, SITE, buildIndex, buildPerformance, buildDeployment, buildMeasure, type ContractFixtures } from "./scorecard-contract-builders.ts";

const NOW = new Date("2026-10-02T12:00:00Z");
const FX = new URL("./fixtures/scorecard-contracts/", import.meta.url);
const load = (k: keyof ContractFixtures): any => JSON.parse(readFileSync(new URL(FIXTURE_FILES[k], FX), "utf8"));
const get = (c: { dimensions: Dimension[] }, d: string) => c.dimensions.find((x) => x.dimension === d)!;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---- B) alan listesi ----------------------------------------------------------------------------------------------

/** "a[].b.c" yolu: dizi segmentinde TUM elemanlarda (en az 1 eleman) kalan yol bulunmali; anahtar varligi yeter (null gecerli). */
function hasPath(v: unknown, path: string): boolean {
  if (path === "") return true;
  const m = path.match(/^([^.[\]]+)(\[\])?(?:\.(.*))?$/);
  if (!m || typeof v !== "object" || v === null || !(m[1] in (v as object))) return false;
  const child = (v as Record<string, unknown>)[m[1]];
  const rest = m[3] ?? "";
  if (m[2]) return Array.isArray(child) && child.length > 0 && child.every((x) => hasPath(x, rest));
  return hasPath(child, rest);
}
const FIXTURE_OF: Record<string, keyof ContractFixtures> = {
  "sgos.performance-history.v1": "performanceHistory", "sgos.performance-report.v1": "performanceReport", "sgos.index-history.v1": "indexHistory",
  "index-alarms-report": "indexReport", "sgos.deployment-timeline.v1": "deploymentTimeline", "sgos.deployment-event.v1": "deploymentTimeline", "sgos.measure-report.v1": "measureReport",
};

test("sozlesme: okunan her uretici alani uretici-sekilli fixture'da VAR (alan yeniden adlandirilirsa kirilir)", () => {
  assert.deepEqual(Object.keys(CONSUMED_PRODUCER_FIELDS).sort(), Object.keys(FIXTURE_OF).sort());
  for (const [group, paths] of Object.entries(CONSUMED_PRODUCER_FIELDS)) for (const p of paths) {
    assert.ok(hasPath(load(FIXTURE_OF[group]), p.replace("{site}", SITE)), `${group}: '${p}' fixture'da yok`);
  }
});

test("sozlesme: fixture sema kimlikleri scorecard'in bekledigiyle ayni", () => {
  assert.equal(load("performanceHistory").schema, SCHEMA_IDS.performance);
  assert.equal(load("performanceHistory").records[0].schema, SCHEMA_IDS.performanceRecord);
  assert.equal(load("performanceReport").schema, SCHEMA_IDS.performanceReport);
  assert.equal(load("indexHistory").schema, SCHEMA_IDS.index);
  assert.equal(load("deploymentTimeline").schema, SCHEMA_IDS.deploymentTimeline);
  assert.equal(load("deploymentTimeline").events[0].schema, SCHEMA_IDS.deployment);
  for (const k of Object.keys(FIXTURE_FILES) as (keyof ContractFixtures)[]) {
    const f = load(k); assert.ok(f.site === SITE || f.sites?.[0]?.site === SITE || f.sites?.[SITE]?.site_id === SITE, `${k}: site=${SITE} degil`);
  }
});

test("sozlesme: docs/scorecard-contracts.md okunan HER alani adiyla listeler (belgelenmemis alan okunamaz)", () => {
  const doc = readFileSync(new URL("../docs/scorecard-contracts.md", import.meta.url), "utf8");
  for (const [group, paths] of Object.entries(CONSUMED_PRODUCER_FIELDS)) {
    assert.ok(doc.includes(group), `docs: ${group} yok`);
    for (const p of paths) assert.ok(doc.includes(`\`${p}\``), `docs: ${group} '${p}' belgelenmemis`);
  }
});

// ---- A) fixture'dan uc boyut -------------------------------------------------------------------------------------

test("fixture/performance: uretici gecmisi -> ATTENTION (field LCP 2900); ayni gunun kotu lab kaydi karistirilmaz; rapor regresyonu yazilir", () => {
  const hist = load("performanceHistory");
  assert.equal(hist.records.length, 3);
  const d = get(buildScorecard({ site_id: SITE, performance: hist }, NOW), "performance");
  assert.deepEqual([d.state, d.evidence_label, d.confidence], ["ATTENTION", "INFERENCE", "CANDIDATE"]);
  assert.match(d.basis, /lcp_ms=2900/); assert.match(d.basis, /karistirilmadi/);
  assert.equal(d.as_of, "2026-10-01T06:00:00.000Z");
  const withRep = get(buildScorecard({ site_id: SITE, performance: hist, performance_report: load("performanceReport") }, NOW), "performance");
  assert.match(withRep.basis, /1 regresyon adayi \(lcp_ms\)/);
  // FP: sorun giderilince (field LCP 2000) ayni yapi OK olur; lab 3300 hala orada ama field varken sayilmaz.
  const fixed = clone(hist); fixed.records[1].lcp_ms = 2000;
  assert.equal(get(buildScorecard({ site_id: SITE, performance: fixed }, NOW), "performance").state, "OK");
  // FN: ayni gunun field kaydi silinirse yalniz lab kalir ve lab LCP 3300 ATTENTION verir (lab maskeleme yok)
  const labOnly = clone(hist); labOnly.records = [labOnly.records[2]];
  assert.equal(get(buildScorecard({ site_id: SITE, performance: labOnly }, NOW), "performance").state, "ATTENTION");
});

test("fixture/index: uretici gecmisi + alarm raporu -> ATTENTION; NEUTRAL(uygunsuz) ve ERROR URL OK'i bozmaz/saymaz; rapor yoksa da NOT_INDEXED ATTENTION", () => {
  const hist = load("indexHistory"), rep = load("indexReport");
  assert.equal(rep.index_alarms.status, "ALARMS");
  const d = get(buildScorecard({ site_id: SITE, index: hist, index_report: rep }, NOW), "index_health");
  assert.deepEqual([d.state, d.evidence_label, d.confidence], ["ATTENTION", "INFERENCE", "CANDIDATE"]);
  assert.match(d.basis, /ORNEKLEM 3 URL/); assert.match(d.basis, /1 alarm/); assert.match(d.basis, /1 ERROR URL gozlem sayilmadi/);
  assert.equal(get(buildScorecard({ site_id: SITE, index: hist }, NOW), "index_health").state, "ATTENTION");
  // FP: /a duzelince (INDEXED) yalniz uygunsuz NEUTRAL (/c) kalir -> OK degil UNKNOWN
  const fixed = clone(hist); for (const s of fixed.snapshots) for (const e of s.entries) if (e.url.endsWith("/a")) e.verdict = "INDEXED";
  const f = get(buildScorecard({ site_id: SITE, index: fixed }, NOW), "index_health");
  assert.equal(f.state, "UNKNOWN"); assert.match(f.basis, /OK denmedi/);
});

test("fixture/deployment: uretici cizelgesi -> OK/FACT/CONFIRMED (VERIFIED production); preview ve eski production sayilmaz; MISMATCH ATTENTION", () => {
  const tl = load("deploymentTimeline");
  assert.equal(tl.events.length, 3);
  const d = get(buildScorecard({ site_id: SITE, deployments: tl }, NOW), "deployment_change");
  assert.deepEqual([d.state, d.evidence_label, d.confidence], ["OK", "FACT", "CONFIRMED"]);
  assert.match(d.basis, /1 dogrulanmis \(VERIFIED\)/); assert.equal(d.as_of, "2026-10-01T06:30:00.000Z");
  const mm = clone(tl); mm.events.find((e: any) => e.environment === "production" && e.deployed_at.startsWith("2026-09-29")).verification_state = "MISMATCH";
  assert.equal(get(buildScorecard({ site_id: SITE, deployments: mm }, NOW), "deployment_change").state, "ATTENTION");
  const un = clone(tl); un.events.find((e: any) => e.deployed_at.startsWith("2026-09-29")).verification_state = "UNVERIFIED";
  assert.equal(get(buildScorecard({ site_id: SITE, deployments: un }, NOW), "deployment_change").state, "UNKNOWN");
});

test("fixture: uc uretici dosyasi birlikte; tum boyut degismezleri tutar; baska site icin ayni dosyalar UNKNOWN", () => {
  const inputs = { performance: load("performanceHistory"), performance_report: load("performanceReport"), index: load("indexHistory"), index_report: load("indexReport"), deployments: load("deploymentTimeline") };
  for (const d of buildScorecard({ site_id: SITE, ...inputs }, NOW).dimensions) assert.deepEqual(dimensionInvariantProblems(d), []);
  const other = buildScorecard({ site_id: "spryhand", ...inputs }, NOW);
  for (const k of ["performance", "index_health", "deployment_change"]) assert.equal(get(other, k).state, "UNKNOWN", k);
});

test("fixture/search_opportunity (#41): uretici raporu -> ATTENTION/INFERENCE/CANDIDATE (2 aday); FP/FN: sifir, kesilme, yabanci girdi, bayat, bagli degil, sema", () => {
  const rep = load("measureReport");
  assert.equal(rep.schema, SCHEMA_IDS.measure);
  const so = (m: unknown, site = SITE, now = NOW) => get(buildScorecard({ site_id: site, measure: m }, now), "search_opportunity");
  const d = so(rep);
  assert.deepEqual([d.state, d.evidence_label, d.confidence], ["ATTENTION", "INFERENCE", "CANDIDATE"]);
  assert.match(d.basis, /2 firsat adayi/); assert.match(d.basis, /2026-09-04\.\.2026-10-01/); assert.equal(d.as_of, "2026-10-02T09:00:00.000Z");
  assert.deepEqual(dimensionInvariantProblems(d), []);
  // FP: gercek olculmus 0 (aday yok) -> OK, ama UNKNOWN degil ve ATTENTION degil
  const zero = clone(rep); const z = zero.sites[SITE]; z.opportunity_count = 0; z.search_opportunity_inputs.opportunity_count = 0; z.search_opportunity_inputs.candidates = [];
  const zd = so(zero); assert.equal(zd.state, "OK"); assert.match(zd.basis, /gercek sifir/);
  // FN: sayi 0 ama aday listesi dolu (uretici sekli bozuk) -> UNKNOWN; sayi>0 ama aday yok -> UNKNOWN
  const lie = clone(rep); lie.sites[SITE].opportunity_count = 0; assert.equal(so(lie).state, "UNKNOWN");
  const lie2 = clone(rep); lie2.sites[SITE].search_opportunity_inputs.candidates = []; assert.equal(so(lie2).state, "UNKNOWN");
  // FN: sifir ama satir butunlugu dogrulanamadi -> OK degil UNKNOWN (eksik veri sifiri kanitlamaz)
  const zi = clone(zero); zi.sites[SITE].gsc.rows_complete = false; assert.equal(so(zi).state, "UNKNOWN");
  const zn = clone(zero); zn.sites[SITE].gsc.rows_complete = null; assert.equal(so(zn).state, "UNKNOWN");
  // Kesilmis tablo: durum olculen veriden hesaplanir (sayi tablodan bagimsiz), uyari basis'te, etiket yukselmez
  const tr = clone(rep); Object.assign(tr.sites[SITE].gsc.coverage, { queries_truncated: true, query_rows_total: 900, query_rows_returned: 500 });
  const td = so(tr); assert.equal(td.state, "ATTENTION"); assert.match(td.basis, /kesildi \(500\/900/); assert.equal(td.confidence, "CANDIDATE");
  const ic = clone(rep); ic.sites[SITE].gsc.rows_complete = false;
  const id = so(ic); assert.equal(id.state, "ATTENTION"); assert.match(id.basis, /TAMAMLANMADI/); assert.equal(id.evidence_label, "INFERENCE");
  // Yabanci site: anahtar dogru ama icerik baska siteyi gosteriyor / baska sitenin girdisi istenen anahtarda degil
  const foreignBody = clone(rep); foreignBody.sites[SITE].site_id = "spryhand"; assert.equal(so(foreignBody).state, "UNKNOWN");
  const noId = clone(rep); delete noId.sites[SITE].site_id; assert.equal(so(noId).state, "UNKNOWN");
  assert.equal(so(rep, "spryhand").state, "UNKNOWN");
  assert.equal(so(rep, "constructor").state, "UNKNOWN");
  // Bayat (> 10 gun)
  assert.equal(so(rep, SITE, new Date("2026-10-20T00:00:00Z")).state, "UNKNOWN-STALE");
  // Bagli degil / hata / bilinmiyor: asla OK, asla 0
  const nc = clone(rep); Object.assign(nc.sites[SITE], { gsc_state: "NOT_CONNECTED", opportunity_count: null }); nc.sites[SITE].gsc.state = "NOT_CONNECTED";
  assert.equal(so(nc).state, "NOT_CONNECTED");
  for (const st of ["ERROR", "UNKNOWN"]) { const e = clone(rep); Object.assign(e.sites[SITE], { gsc_state: st, opportunity_count: null }); e.sites[SITE].gsc.state = st; assert.equal(so(e).state, "UNKNOWN", st); }
  // gsc_state ile gsc.state celisirse (alias CONNECTED ama gsc ERROR) -> UNKNOWN
  const mix = clone(rep); mix.sites[SITE].gsc.state = "ERROR"; assert.equal(so(mix).state, "UNKNOWN");
  // Sema uyumsuzlugu / site anahtari yok / gsc blogu yok
  assert.equal(so({ ...rep, schema: "sgos.measure-report.v2" }).state, "UNKNOWN");
  assert.equal(so({ ...rep, sites: [rep.sites[SITE]] }).state, "UNKNOWN");
  const nogsc = clone(rep); delete nogsc.sites[SITE].gsc; assert.equal(so(nogsc).state, "UNKNOWN");
  assert.equal(so(undefined).state, "UNKNOWN");
});

// ---- C) gercek round-trip (modul varsa) ---------------------------------------------------------------------------

/** Modul dosyasi yoksa null; VARSA import hatasi gercek hatadir (yutulmaz). */
async function tryImport(rel: string): Promise<any | null> {
  if (!existsSync(new URL(rel, import.meta.url))) return null;
  try { return await import(new URL(rel, import.meta.url).href); } catch (e) {
    if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND" && String((e as Error).message).includes(rel.replace("../", ""))) return null;
    throw e;
  }
}
const perfMod = await tryImport("../src/performance.ts");
const indexMod = await tryImport("../src/index-alarms.ts");
const deployMod = await tryImport("../src/deployment-timeline.ts");
const skip = (name: string, mod: unknown, pr: string) => (mod ? false : `uretici modul yok (${name}; ${pr} main'e girince bu test otomatik calisir)`);

test("round-trip/performance (#36): gercek runPerformance cikti == fixture; gercek parseHistory fixture'i kabul eder; scorecard ayni", { skip: skip("src/performance.ts", perfMod, "PR #36") }, async () => {
  const built = await buildPerformance(perfMod);
  assert.deepEqual(built.history, load("performanceHistory"));
  assert.deepEqual(built.report, load("performanceReport"));
  assert.doesNotThrow(() => perfMod.parseHistory(JSON.stringify(load("performanceHistory")), SITE));
  const d = get(buildScorecard({ site_id: SITE, performance: built.history, performance_report: built.report }, NOW), "performance");
  assert.equal(d.state, "ATTENTION");
});

test("round-trip/index (#34): gercek appendSnapshot/buildReport cikti == fixture; gercek parseHistory kabul eder; scorecard ayni", { skip: skip("src/index-alarms.ts", indexMod, "PR #34") }, () => {
  const built = buildIndex(indexMod);
  assert.deepEqual(built.history, load("indexHistory"));
  assert.deepEqual(built.report, load("indexReport"));
  assert.doesNotThrow(() => indexMod.parseHistory(load("indexHistory"), SITE));
  assert.equal(get(buildScorecard({ site_id: SITE, index: built.history, index_report: built.report }, NOW), "index_health").state, "ATTENTION");
});

test("round-trip/deployment (#32): gercek parse/verify/append cikti == fixture; gercek parseTimeline kabul eder; scorecard ayni", { skip: skip("src/deployment-timeline.ts", deployMod, "PR #32") }, async () => {
  const built = await buildDeployment(deployMod);
  assert.deepEqual(built, load("deploymentTimeline"));
  assert.doesNotThrow(() => deployMod.parseTimeline(load("deploymentTimeline")));
  assert.equal(get(buildScorecard({ site_id: SITE, deployments: built }, NOW), "deployment_change").state, "OK");
});

test("round-trip FN: uretici bozuk cizelgeyi reddeder -> scorecard de UNKNOWN verir (iki taraf ayni karari verir)", { skip: skip("src/deployment-timeline.ts", deployMod, "PR #32") }, () => {
  const bad = clone(load("deploymentTimeline")); bad.events[0].commit_sha = "abc123";
  assert.throws(() => deployMod.parseTimeline(bad));
  assert.equal(get(buildScorecard({ site_id: SITE, deployments: bad }, NOW), "deployment_change").state, "UNKNOWN");
});

const measureMod = await tryImport("../src/measure-report.ts");
test("round-trip/measure (#41): gercek buildMeasureReport cikti == fixture; scorecard ayni boyutu verir; yabanci site UNKNOWN", { skip: skip("src/measure-report.ts", measureMod, "PR #41") }, () => {
  const built = buildMeasure(measureMod);
  assert.deepEqual(built, load("measureReport"));
  const d = get(buildScorecard({ site_id: SITE, measure: built }, NOW), "search_opportunity");
  assert.equal(d.state, "ATTENTION"); assert.match(d.basis, /2 firsat adayi/);
  assert.equal(get(buildScorecard({ site_id: "spryhand", measure: built }, NOW), "search_opportunity").state, "UNKNOWN");
});

test("round-trip/measure FN: uretici NOT_CONNECTED/ERROR ciktisi -> scorecard asla OK/0 vermez; gercek sifir OK kalir", { skip: skip("src/measure-report.ts", measureMod, "PR #41") }, () => {
  const mk = (outcome: unknown) => measureMod.buildMeasureReport([{ siteId: SITE, gscProperty: "sc-domain:pamistanbul.com", ga4Property: "NOT_CONNECTED", patterns: ["pamistanbul"], outcome, ga4Status: { state: "NOT_CONNECTED", note: "x" } }],
    { now: new Date(GEN_NOW), current: { label: "c", start: "2026-09-04", end: "2026-10-01" }, yearAgo: { label: "y", start: "2025-09-05", end: "2025-10-02" }, toolVersion: "0.1.0" });
  const st = (o: unknown) => get(buildScorecard({ site_id: SITE, measure: JSON.parse(JSON.stringify(mk(o))) }, NOW), "search_opportunity").state;
  assert.equal(st({ kind: "not_connected", reason: "token yok" }), "NOT_CONNECTED");
  assert.equal(st({ kind: "error", message: "HTTP 500" }), "UNKNOWN");
  // API 200 + satir yok = dogrulanmis sifir: scorecard OK (UNKNOWN'a dusmez)
  assert.equal(st({ kind: "ok", current: [], yearAgo: null, currentTotal: [], yearAgoTotal: null }), "OK");
});
