// Scorecard testleri: eksik/bayat/yabanci girdi asla OK olmaz; tek skor yok; izolasyon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScorecard, buildPortfolio, loadInputs, scorecardToMarkdown, dimensionInvariantProblems, DIMENSIONS, SCHEMA_IDS, parseWhen, type Dimension, type SiteScorecard } from "../src/scorecard.ts";

const NOW = new Date("2026-10-02T12:00:00Z");
const S = "pamistanbul";
const SITES = ["pamistanbul", "pamaistudio", "spryhand", "decideplan", "rightlisted", "untitledportraits", "myhappymade"];
const rec = (o: Record<string, unknown> = {}) => ({
  site_id: S, date: "2026-10-02", measured_at: "2026-10-02T07:25:40.570Z", measurement_state: "MEASURED", confidence: "CONFIRMED", rows_complete: true, is_zero: false, usable: true,
  friction: { dead_click_count: 0, rage_click_count: 0, script_error_count: 0, error_click_count: 0, excessive_scroll: 0, quickback_click: 0 }, friction_total: 0,
  sessions: { real: 117, bot: 65, total: 182, bot_pct: 35.7 }, ...o,
});
const clarity = (records: unknown[], site = S) => ({ schema: SCHEMA_IDS.clarity, site_id: site, max_records: 120, records });
const get = (c: SiteScorecard, d: string): Dimension => c.dimensions.find((x) => x.dimension === d)!;
const perf = (o: Record<string, unknown> = {}, site = S) => ({ schema: SCHEMA_IDS.performance, site_id: site, records: [{ date: "2026-09-29", measurement_state: "MEASURED", lcp_ms: 2000, cls: 0.05, inp_ms: 150, ...o }] });
const idx = (o: Record<string, unknown> = {}, site = S) => ({ schema: SCHEMA_IDS.index, site_id: site, records: [{ date: "2026-10-01", measurement_state: "MEASURED", sample_size: 20, not_indexed_count: 0, ...o }] });
const depl = (events: unknown[], generated = "2026-10-01") => ({ generated_at: generated, events });
const ev = (o: Record<string, unknown> = {}) => ({ schema: SCHEMA_IDS.deployment, site_id: S, deployed_at: "2026-09-28T10:00:00Z", verification_state: "VERIFIED", ...o });
const meas = (e: Record<string, unknown> = {}, site = S) => ({ schema: SCHEMA_IDS.measure, generated_at: "2026-09-29", sites: { [site]: { gsc_state: "CONNECTED", opportunity_count: 0, ...e } } });

test("girdi yok: altisi UNKNOWN, hicbiri OK degil, tek skor alani yok", () => {
  const c = buildScorecard({ site_id: S }, NOW);
  assert.deepEqual(c.dimensions.map((d) => d.dimension), [...DIMENSIONS]);
  for (const d of c.dimensions) { assert.equal(d.state, "UNKNOWN"); assert.equal(d.confidence, "UNKNOWN"); assert.equal(d.as_of, null); }
  assert.deepEqual(Object.keys(c).sort(), ["counts", "dimensions", "generated_at", "onboarding_status", "schema", "site_id"]);
});

test("measurement_health: taze basarili olcum OK/FACT/CONFIRMED; basarisiz olcum ATTENTION", () => {
  const ok = get(buildScorecard({ site_id: S, clarity: clarity([rec()]) }, NOW), "measurement_health");
  assert.deepEqual([ok.state, ok.evidence_label, ok.confidence], ["OK", "FACT", "CONFIRMED"]);
  const failed = rec({ measurement_state: "ERROR", confidence: "UNKNOWN", rows_complete: "UNKNOWN", usable: false, error_code: "HTTP_429" });
  const bad = get(buildScorecard({ site_id: S, clarity: clarity([failed]) }, NOW), "measurement_health");
  assert.equal(bad.state, "ATTENTION"); assert.match(bad.basis, /HTTP_429/);
});

test("bayat girdi UNKNOWN-STALE (FN: eski yesil olcum OK'e donmez)", () => {
  const old = clarity([rec({ date: "2026-09-20", measured_at: "2026-09-20T07:00:00Z" })]);
  const c = buildScorecard({ site_id: S, clarity: old }, NOW);
  assert.equal(get(c, "measurement_health").state, "UNKNOWN-STALE");
  assert.equal(get(c, "ux_friction").state, "UNKNOWN-STALE");
  assert.equal(get(c, "measurement_health").as_of, "2026-09-20T07:00:00.000Z");
  assert.equal(get(buildScorecard({ site_id: S, clarity: old }, NOW, { measurement_health: 30 }), "measurement_health").state, "OK");
});

test("gelecek tarihli kayit bayatlik testini kandirmaz", () => {
  assert.equal(parseWhen("2027-01-01", NOW), null);
  const c = clarity([rec({ measured_at: "2027-01-01T00:00:00Z", date: "2027-01-01" })]);
  assert.equal(get(buildScorecard({ site_id: S, clarity: c }, NOW), "measurement_health").state, "UNKNOWN");
});

test("NOT_CONNECTED sifir degil, ayri durum", () => {
  const nc = rec({ measurement_state: "NOT_CONNECTED", confidence: "UNKNOWN", rows_complete: false, usable: false });
  const c = buildScorecard({ site_id: S, clarity: clarity([nc]), measure: meas({ gsc_state: "NOT_CONNECTED" }) }, NOW);
  assert.equal(get(c, "measurement_health").state, "NOT_CONNECTED");
  assert.equal(get(c, "ux_friction").state, "NOT_CONNECTED");
  assert.equal(get(c, "search_opportunity").state, "NOT_CONNECTED");
});

test("ux_friction: rage click ATTENTION INFERENCE/CANDIDATE; sifir friction OK ama onaylanmis degil", () => {
  const f4 = { dead_click_count: 0, rage_click_count: 4, script_error_count: 0, error_click_count: 0 };
  const hot = get(buildScorecard({ site_id: S, clarity: clarity([rec({ friction: f4 })]) }, NOW), "ux_friction");
  assert.deepEqual([hot.state, hot.evidence_label, hot.confidence], ["ATTENTION", "INFERENCE", "CANDIDATE"]);
  const ok = get(buildScorecard({ site_id: S, clarity: clarity([rec()]) }, NOW), "ux_friction");
  assert.deepEqual([ok.state, ok.evidence_label, ok.confidence], ["OK", "INFERENCE", "CANDIDATE"]);
  assert.match(ok.basis, /bakilan/);
});

test("ux_friction FP: taban cizgisiz tek olu tik ATTENTION uretmez ama basis'te gorunur", () => {
  const d = get(buildScorecard({ site_id: S, clarity: clarity([rec({ friction: { dead_click_count: 1, rage_click_count: 0, script_error_count: 0, error_click_count: 0 } })]) }, NOW), "ux_friction");
  assert.equal(d.state, "OK"); assert.match(d.basis, /dead_click=1/);
});

test("ux_friction FN korumalari: az oturum, sifir gun, basarisiz gun, UNKNOWN metrik OK olmaz", () => {
  const f = (r: Record<string, unknown>) => get(buildScorecard({ site_id: S, clarity: clarity([rec(r)]) }, NOW), "ux_friction");
  assert.equal(f({ sessions: { real: 2, bot: 0, total: 2, bot_pct: 0 } }).state, "UNKNOWN");
  assert.equal(f({ is_zero: true, usable: false }).state, "UNKNOWN");
  assert.equal(f({ measurement_state: "ERROR", usable: false }).state, "UNKNOWN");
  assert.equal(f({ friction: { dead_click_count: "UNKNOWN", rage_click_count: 0, script_error_count: 0, error_click_count: 0 } }).state, "UNKNOWN");
  assert.equal(f({ sessions: { real: "UNKNOWN", bot: 0, total: 0, bot_pct: 0 } }).state, "UNKNOWN");
});

test("ux_friction: en yeni basarisiz gun varken onceki usable gun kullanilir ve as_of o gundur", () => {
  const c = clarity([rec({ date: "2026-10-01", measured_at: "2026-10-01T07:00:00Z" }), rec({ measurement_state: "ERROR", usable: false })]);
  const d = get(buildScorecard({ site_id: S, clarity: c }, NOW), "ux_friction");
  assert.equal(d.state, "OK"); assert.equal(d.as_of?.slice(0, 10), "2026-10-01");
});

test("performance: esik asimi ATTENTION/INFERENCE/CANDIDATE; eksik metrik OK vermez; bayat/NOT_CONNECTED", () => {
  const p = (o: Record<string, unknown>) => get(buildScorecard({ site_id: S, performance: perf(o) }, NOW), "performance");
  assert.equal(p({}).state, "OK");
  const bad = p({ lcp_ms: 4100 }); assert.deepEqual([bad.state, bad.evidence_label, bad.confidence], ["ATTENTION", "INFERENCE", "CANDIDATE"]);
  assert.equal(p({ cls: undefined }).state, "UNKNOWN");
  assert.equal(p({ lcp_ms: undefined, cls: undefined, inp_ms: undefined }).state, "UNKNOWN");
  assert.equal(p({ date: "2026-09-01" }).state, "UNKNOWN-STALE");
  assert.equal(p({ measurement_state: "NOT_CONNECTED" }).state, "NOT_CONNECTED");
  assert.equal(p({ measurement_state: "ERROR" }).state, "UNKNOWN");
});

test("index_health: ornekleme, orneklem disi iddia yok; ERROR indexli degil demek degil", () => {
  const i = (o: Record<string, unknown>) => get(buildScorecard({ site_id: S, index: idx(o) }, NOW), "index_health");
  const ok = i({}); assert.equal(ok.state, "OK"); assert.match(ok.basis, /ORNEKLEM/); assert.equal(ok.confidence, "CANDIDATE");
  assert.equal(i({ not_indexed_count: 3 }).state, "ATTENTION");
  assert.equal(i({ sample_size: 0 }).state, "UNKNOWN");
  assert.equal(i({ measurement_state: "ERROR" }).state, "UNKNOWN");
  assert.equal(i({ date: "2026-09-10" }).state, "UNKNOWN-STALE");
});

test("deployment_change: olaysiz taze cizelge OK/INFERENCE; dogrulanmamis deploy ATTENTION; damgasiz cizelge UNKNOWN", () => {
  const d = (x: unknown) => get(buildScorecard({ site_id: S, deployments: x }, NOW), "deployment_change");
  const none = d(depl([])); assert.deepEqual([none.state, none.evidence_label, none.confidence], ["OK", "INFERENCE", "CANDIDATE"]);
  assert.equal(d(depl([ev({ verification_state: "FAILED" })])).state, "ATTENTION");
  assert.equal(d(depl([ev({ verification_state: undefined })])).state, "ATTENTION");
  assert.equal(d({ events: [] }).state, "UNKNOWN");
  assert.equal(d(depl([], "2026-09-01")).state, "UNKNOWN-STALE");
  assert.equal(d({ generated_at: "2026-10-01" }).state, "UNKNOWN");
});

test("search_opportunity: firsat ATTENTION/INFERENCE; sayi yoksa UNKNOWN; baska site girdisi okunmaz", () => {
  const s = (m: unknown) => get(buildScorecard({ site_id: S, measure: m }, NOW), "search_opportunity");
  assert.equal(s(meas({ opportunity_count: 3 })).state, "ATTENTION");
  assert.equal(s(meas({ opportunity_count: 3 })).confidence, "CANDIDATE");
  assert.equal(s(meas({ opportunity_count: undefined })).state, "UNKNOWN");
  assert.equal(s(meas({}, "spryhand")).state, "UNKNOWN");
  const old = { schema: SCHEMA_IDS.measure, generated_at: "2026-08-01", sites: { [S]: { gsc_state: "CONNECTED", opportunity_count: 0 } } };
  assert.equal(s(old).state, "UNKNOWN-STALE");
});

test("izolasyon: baska sitenin dosyasi hicbir boyuta girmez (7 site, 42 cift)", () => {
  for (const s of SITES) for (const other of SITES.filter((x) => x !== s)) {
    const c = buildScorecard({ site_id: s, clarity: clarity([rec({ site_id: other })], other), performance: perf({}, other), index: idx({}, other), deployments: depl([ev({ site_id: other })]), measure: meas({}, other) }, NOW);
    for (const d of c.dimensions) assert.ok(d.state === "UNKNOWN" || (d.dimension === "deployment_change" && d.state === "OK"), `${s}<-${other} ${d.dimension}=${d.state}`);
    assert.match(get(c, "deployment_change").basis, /yok sayildi/);
  }
});

test("yanlis sema kimligi UNKNOWN", () => {
  const c = buildScorecard({ site_id: S, clarity: { ...clarity([rec()]), schema: "baska.v1" } }, NOW);
  assert.match(get(c, "measurement_health").basis, /sema beklenen/);
});

test("evidence ontolojisi: yalniz 6 etiket + gecerli guven; degismezler tum senaryolarda tutar", () => {
  const six = new Set(["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"]);
  const confs = new Set(["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"]);
  const full = buildScorecard({ site_id: S, clarity: clarity([rec()]), performance: perf({ lcp_ms: 9000 }), index: idx({ not_indexed_count: 2 }), deployments: depl([ev()]), measure: meas({ opportunity_count: 2 }) }, NOW);
  for (const c of [full, buildScorecard({ site_id: S }, NOW)]) for (const d of c.dimensions) {
    assert.ok(six.has(d.evidence_label)); assert.ok(confs.has(d.confidence)); assert.deepEqual(dimensionInvariantProblems(d), []);
  }
  const bad: Dimension = { dimension: "performance", state: "ATTENTION", evidence_label: "INFERENCE", confidence: "CONFIRMED", basis: "x", as_of: "2026-10-01" };
  assert.equal(dimensionInvariantProblems(bad).length, 1);
  assert.equal(dimensionInvariantProblems({ ...bad, state: "UNKNOWN", evidence_label: "FACT", confidence: "CONFIRMED" }).length, 1);
});

test("sayim ortalama degil: karma sonuc tek 'iyi' durumuna indirgenmez", () => {
  const c = buildScorecard({ site_id: S, clarity: clarity([rec()]), performance: perf({ lcp_ms: 9000 }) }, NOW);
  assert.equal(Object.values(c.counts).reduce((a, b) => a + b, 0), 6);
  assert.ok(c.counts.OK >= 1 && c.counts.ATTENTION >= 1 && c.counts.UNKNOWN >= 1);
});

test("loadInputs: eksik ve bozuk dosya istisna firlatmaz, UNKNOWN uretir; dolu dosya okunur", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-"));
  mkdirSync(join(dir, "clarity")); mkdirSync(join(dir, "perf"));
  writeFileSync(join(dir, "clarity", `${S}.json`), JSON.stringify(clarity([rec()])));
  writeFileSync(join(dir, "perf", `${S}.json`), "{bozuk json");
  const c = buildScorecard(loadInputs({ clarityDir: join(dir, "clarity"), performanceDir: join(dir, "perf"), indexDir: join(dir, "yok"), measureFile: join(dir, "yok.json") }, S, "pilot_onboarding"), NOW);
  assert.equal(get(c, "measurement_health").state, "OK");
  assert.equal(get(c, "performance").state, "UNKNOWN");
  assert.equal(get(c, "index_health").state, "UNKNOWN");
  assert.equal(c.onboarding_status, "pilot_onboarding");
});

test("gercek data/clarity-history: 7 site okunur, degismezler tutar, clarity disi boyutlar OK olamaz", () => {
  const dir = new URL("../data/clarity-history/", import.meta.url).pathname;
  const p = buildPortfolio(SITES.map((s) => loadInputs({ clarityDir: dir }, s)), NOW);
  assert.equal(p.sites.length, 7);
  for (const s of p.sites) {
    for (const d of s.dimensions) assert.deepEqual(dimensionInvariantProblems(d), []);
    for (const k of ["index_health", "performance", "search_opportunity", "deployment_change"]) assert.equal(get(s, k).state, "UNKNOWN");
  }
});

test("markdown: tum boyutlar, tek-skor-yok notu ve onboard edilmemis site notu", () => {
  const p = buildPortfolio([{ site_id: S }, { site_id: "spryhand", onboarding_status: "registered_not_onboarded" }], NOW);
  const md = scorecardToMarkdown(p);
  for (const d of DIMENSIONS) assert.ok(md.includes(d));
  assert.match(md, /tavsiye uretilmez/);
  assert.match(md, /Tek skor yok/);
  assert.equal(p.schema, "sgos.scorecard-portfolio.v1");
});
