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
// URETICI-SEKILLI yardimcilar (docs/scorecard-contracts.md): `site` alani, sgos.performance.v1 kayitlari, snapshots[], timeline{events[]}.
const prec = (o: Record<string, unknown> = {}) => ({
  schema: SCHEMA_IDS.performanceRecord, site: S, url: "https://www.pamistanbul.com/", strategy: "mobile", measured_at: "2026-09-29T06:00:00.000Z", date: "2026-09-29",
  lcp_ms: 2000, inp_ms: 150, cls: 0.05, ttfb_ms: 500, perf_score: 90, source: "field", field_scope: "url", state: "MEASURED", evidence: "FACT", confidence: "CONFIRMED", provider: "PageSpeed Insights API v5", ...o,
});
const perf = (records: unknown[] = [prec()], site = S) => ({ schema: SCHEMA_IDS.performance, site, max_records: 120, records });
const ient = (url: string, o: Record<string, unknown> = {}) => ({ url, state: "INSPECTED", verdict: "INDEXED", in_sitemap: true, fetch_ok: true, canonical_self: true, indexable: true, ...o });
const isnap = (entries: unknown[], o: Record<string, unknown> = {}) => ({ taken_at: "2026-10-01T07:00:00.000Z", site: S, sample_size: (entries as { state: string }[]).filter((e) => e.state === "INSPECTED").length, universe_size: "UNKNOWN", stopped: null, entries, ...o });
const idx = (snaps: unknown[] = [isnap([ient("https://www.pamistanbul.com/a"), ient("https://www.pamistanbul.com/b")])], site = S) => ({ schema: SCHEMA_IDS.index, site, snapshots: snaps });
const ev = (o: Record<string, unknown> = {}) => ({ schema: SCHEMA_IDS.deployment, site: S, environment: "production", commit_sha: "a".repeat(40), deployed_at: "2026-09-28T10:00:00Z", verification_state: "VERIFIED", provenance: { source: "github_deployments", retrieved_at: "2026-10-01T06:00:00Z", ref: "github-deployment-1" }, evidence: "FACT", ...o });
const depl = (events: unknown[] = [ev()], site = S) => ({ schema: SCHEMA_IDS.deploymentTimeline, site, events });
// #41 uretici sekli: girdi site_id tasir; gsc.state asil durum, gsc_state takma ad; aday listesi sayiyla tutarli (sayi>0 => en az 1 aday).
const meas = (e: Record<string, unknown> = {}, site = S) => {
  const n = "opportunity_count" in e ? e.opportunity_count : 0;
  const alias = (e.gsc_state as string | undefined) ?? "CONNECTED";
  const measured = alias === "CONNECTED";
  return { schema: SCHEMA_IDS.measure, generated_at: "2026-09-29T06:00:00.000Z", sites: { [site]: {
    site_id: site, generated_at: "2026-09-29T06:00:00.000Z", gsc_state: "CONNECTED", opportunity_count: 0,
    period: { label: "son 28 gun", start: "2026-08-31", end: "2026-09-27" },
    gsc: { state: measured ? "MEASURED" : alias, state_reason: measured ? null : "test", rows_complete: measured ? true : null, coverage: { query_rows_total: 10, query_rows_returned: 10, queries_truncated: measured ? false : null } },
    search_opportunity_inputs: { state: measured ? "MEASURED" : alias, candidates: typeof n === "number" && n > 0 ? [{ query: "q", impressions: 100, clicks: 1, position: 9, score: 11 }] : [] },
    ...e } } };
};

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

test("performance: field kaydi esik altinda OK/INFERENCE/CANDIDATE; esik asimi ATTENTION; basis neye baktigini yazar", () => {
  const p = (r: unknown[]) => get(buildScorecard({ site_id: S, performance: perf(r) }, NOW), "performance");
  const ok = p([prec()]);
  assert.deepEqual([ok.state, ok.evidence_label, ok.confidence], ["OK", "INFERENCE", "CANDIDATE"]);
  assert.match(ok.basis, /field/); assert.match(ok.basis, /bakilan/); assert.equal(ok.as_of, "2026-09-29T06:00:00.000Z");
  const bad = p([prec({ lcp_ms: 4100 })]); assert.deepEqual([bad.state, bad.evidence_label, bad.confidence], ["ATTENTION", "INFERENCE", "CANDIDATE"]);
  assert.equal(p([prec({ cls: 0.3 })]).state, "ATTENTION");
  assert.equal(p([prec({ inp_ms: 600 })]).state, "ATTENTION");
});

test("performance FN: gunde birden cok kayit -> son kayit degil EN KOTU deger; yalniz son gun degerlendirilir", () => {
  const poorFirst = [prec({ url: "https://www.pamistanbul.com/a", lcp_ms: 5000 }), prec({ url: "https://www.pamistanbul.com/b", lcp_ms: 1500 })];
  assert.equal(get(buildScorecard({ site_id: S, performance: perf(poorFirst) }, NOW), "performance").state, "ATTENTION");
  // FP: eski gunun kotu kaydi, yeni gunun iyi kaydini ezmez
  const old = [prec({ date: "2026-09-20", measured_at: "2026-09-20T06:00:00.000Z", lcp_ms: 9000 }), prec()];
  assert.equal(get(buildScorecard({ site_id: S, performance: perf(old) }, NOW), "performance").state, "OK");
});

test("performance: field ile lab karistirilmaz (FP: field varken kotu lab ATTENTION uretmez; FN: kotu field iyi lab ile maskelenmez)", () => {
  const lab = (o: Record<string, unknown> = {}) => prec({ strategy: "desktop", source: "lab", field_scope: null, inp_ms: null, ...o });
  const a = get(buildScorecard({ site_id: S, performance: perf([prec(), lab({ lcp_ms: 3300 })]) }, NOW), "performance");
  assert.equal(a.state, "OK"); assert.match(a.basis, /karistirilmadi/);
  const b = get(buildScorecard({ site_id: S, performance: perf([prec({ lcp_ms: 2900 }), lab({ lcp_ms: 1200 })]) }, NOW), "performance");
  assert.equal(b.state, "ATTENTION");
});

test("performance: lab-only kayit INP'siz de degerlendirilir ama basis 'saha degil' der; lab kotuyse ATTENTION", () => {
  const lab = (o: Record<string, unknown> = {}) => prec({ source: "lab", field_scope: null, inp_ms: null, ...o });
  const ok = get(buildScorecard({ site_id: S, performance: perf([lab()]) }, NOW), "performance");
  assert.equal(ok.state, "OK"); assert.match(ok.basis, /lab/); assert.match(ok.basis, /INP lab'de olcul/);
  assert.equal(get(buildScorecard({ site_id: S, performance: perf([lab({ lcp_ms: 3300 })]) }, NOW), "performance").state, "ATTENTION");
});

test("performance FN: null metrik OK vermez; lcp=0 'mukemmel' sayilmaz; cls=0 gecerli", () => {
  const p = (o: Record<string, unknown>) => get(buildScorecard({ site_id: S, performance: perf([prec(o)]) }, NOW), "performance");
  assert.equal(p({ inp_ms: null }).state, "UNKNOWN");           // field'da INP yok: tam degerlendirme yok
  assert.equal(p({ lcp_ms: 0 }).state, "UNKNOWN");              // 0 = olcum yok, iyi degil
  assert.equal(p({ lcp_ms: null, inp_ms: null, cls: null }).state, "UNKNOWN");
  assert.equal(p({ cls: 0 }).state, "OK");
  assert.equal(p({ lcp_ms: null, cls: null, inp_ms: null, perf_score: 95 }).state, "UNKNOWN"); // yalniz perf_score CWV degil
});

test("performance: bayat UNKNOWN-STALE; MEASURED olmayan/yanlis sema/yabanci kayit OK'e donmez", () => {
  const p = (r: unknown[], f = perf(r)) => get(buildScorecard({ site_id: S, performance: f }, NOW), "performance");
  assert.equal(p([prec({ date: "2026-09-01", measured_at: "2026-09-01T06:00:00.000Z" })]).state, "UNKNOWN-STALE");
  assert.equal(p([prec({ state: "ERROR", confidence: "UNKNOWN" })]).state, "UNKNOWN");
  assert.equal(p([prec({ state: "NOT_CONNECTED" })]).state, "UNKNOWN");
  assert.equal(p([prec({ schema: "baska.v1" })]).state, "UNKNOWN");
  assert.equal(p([prec({ source: "none" })]).state, "UNKNOWN");
  assert.equal(p([prec({ measured_at: "2026-09-28T06:00:00.000Z" })]).state, "UNKNOWN"); // measured_at.slice != date
  assert.equal(p([prec(), prec({ site: "spryhand" })]).state, "UNKNOWN");                // gecmise yabanci kayit
  assert.equal(p([]).state, "UNKNOWN");
  // eski (uydurma) sekil artik kabul edilmez: kanonik olan uretici semasi
  assert.equal(p([], { schema: SCHEMA_IDS.performance, site_id: S, records: [{ date: "2026-09-29", measurement_state: "MEASURED", lcp_ms: 2000, cls: 0.05, inp_ms: 150 }] } as never).state, "UNKNOWN");
  assert.equal(p([], { ...perf(), site: undefined } as never).state, "UNKNOWN"); // site alani yok: izolasyon dogrulanamaz
});

test("performance: uretici regresyon raporu OK'i ATTENTION'a yukseltir; baska site/bayat/yok rapor degistirmez (FP)", () => {
  const rep = (o: Record<string, unknown> = {}, site = S) => ({ schema: SCHEMA_IDS.performanceReport, generated_at: "2026-10-01T06:00:00.000Z", sites: [{ site, regressions: [{ label: "INFERENCE", site, metric: "lcp_ms" }], ...o }] });
  const run = (r: unknown) => get(buildScorecard({ site_id: S, performance: perf(), performance_report: r }, NOW), "performance");
  const hit = run(rep()); assert.equal(hit.state, "ATTENTION"); assert.equal(hit.confidence, "CANDIDATE"); assert.match(hit.basis, /regresyon adayi \(lcp_ms\)/);
  assert.equal(run(undefined).state, "OK");
  assert.equal(run(rep({}, "spryhand")).state, "OK");                                       // yalniz kendi satiri
  assert.equal(run({ ...rep(), generated_at: "2026-08-01T00:00:00.000Z" }).state, "OK");   // bayat rapor
  assert.match(run({ ...rep(), generated_at: "2026-08-01T00:00:00.000Z" }).basis, /kullanilmadi/);
  assert.equal(run(rep({ regressions: [] })).state, "OK");
  assert.equal(run({ ...rep(), schema: "x" }).state, "OK");
});

const i = (snaps: unknown[], report?: unknown) => get(buildScorecard({ site_id: S, index: idx(snaps), index_report: report }, NOW), "index_health");
const U = (n: string) => `https://www.pamistanbul.com/${n}`;

test("index_health: ornekleme, orneklem disi iddia yok; hepsi INDEXED OK/INFERENCE/CANDIDATE", () => {
  const ok = i([isnap([ient(U("a")), ient(U("b"))])]);
  assert.deepEqual([ok.state, ok.evidence_label, ok.confidence], ["OK", "INFERENCE", "CANDIDATE"]);
  assert.match(ok.basis, /ORNEKLEM 2 URL/); assert.match(ok.basis, /tek snapshot/); assert.equal(ok.as_of, "2026-10-01T07:00:00.000Z");
});

test("index_health: NOT_INDEXED ATTENTION; indekslenmesi beklenen NEUTRAL de ATTENTION (FN); beklenmeyen NEUTRAL OK vermez", () => {
  assert.equal(i([isnap([ient(U("a"), { verdict: "NOT_INDEXED" }), ient(U("b"))])]).state, "ATTENTION");
  assert.equal(i([isnap([ient(U("a"), { verdict: "NEUTRAL" }), ient(U("b"))])]).state, "ATTENTION");
  const unres = i([isnap([ient(U("a"), { verdict: "NEUTRAL", canonical_self: false }), ient(U("b"))])]);
  assert.equal(unres.state, "UNKNOWN"); assert.equal(unres.confidence, "UNKNOWN"); assert.match(unres.basis, /OK denmedi/);
  assert.equal(i([isnap([ient(U("a"), { verdict: "UNKNOWN", fetch_ok: "UNKNOWN" }), ient(U("b"))])]).state, "UNKNOWN");
});

test("index_health FP/FN: ERROR 'indexli degil' degildir ve gozlem sayilmaz; bos ornek asla OK", () => {
  const err = ient(U("e"), { state: "ERROR", verdict: "UNKNOWN", in_sitemap: "UNKNOWN", fetch_ok: "UNKNOWN", canonical_self: "UNKNOWN", indexable: "UNKNOWN" });
  const a = i([isnap([ient(U("a")), err])]); assert.equal(a.state, "OK"); assert.match(a.basis, /1 ERROR URL gozlem sayilmadi/);
  assert.equal(i([isnap([err])]).state, "UNKNOWN");                          // hepsi ERROR: ornek bos
  assert.equal(i([isnap([], { stopped: "quota" })]).state, "UNKNOWN");
  assert.match(i([isnap([], { stopped: "quota" })]).basis, /stopped=quota/);
  assert.equal(i([isnap([ient(U("a"))], { sample_size: 5 })]).state, "UNKNOWN"); // sample_size/entries tutarsiz
});

test("index_health: yalniz EN YENI snapshot; sira karisik olsa da; bayat UNKNOWN-STALE", () => {
  const good = isnap([ient(U("a"))]), badOld = isnap([ient(U("a"), { verdict: "NOT_INDEXED" })], { taken_at: "2026-09-30T07:00:00.000Z" });
  assert.equal(i([good, badOld]).state, "OK");                              // karisik sira, FP: eski kotu yeniyi ezmez
  assert.equal(i([badOld, isnap([ient(U("a"), { verdict: "NOT_INDEXED" })])]).state, "ATTENTION"); // FN: yeni kotu
  assert.doesNotMatch(i([badOld, good]).basis, /tek snapshot/);
  assert.equal(i([isnap([ient(U("a"))], { taken_at: "2026-09-10T00:00:00.000Z" })]).state, "UNKNOWN-STALE");
  assert.equal(i([isnap([ient(U("a"))], { taken_at: "2027-01-01T00:00:00.000Z" })]).state, "UNKNOWN"); // gelecek
});

test("index_health: uretici alarm raporu ATTENTION'a yukseltir; ALARMS degil/baska site/eski rapor yukseltmez (FP)", () => {
  const rep = (o: Record<string, unknown> = {}) => ({ site: S, generated_at: "2026-10-02T09:00:00.000Z", index_alarms: { status: "ALARMS", alarms: [{ url: U("a") }] }, canonical_backlog: {}, ...o });
  const snaps = [isnap([ient(U("a")), ient(U("b"))])];
  const hit = i(snaps, rep()); assert.equal(hit.state, "ATTENTION"); assert.match(hit.basis, /1 alarm/);
  assert.equal(i(snaps, rep({ index_alarms: { status: "NO_ALARM_IN_SAMPLE", alarms: [] } })).state, "OK");
  assert.equal(i(snaps, rep({ index_alarms: { status: "UNKNOWN", alarms: [] } })).state, "OK");
  assert.equal(i(snaps, rep({ site: "spryhand" })).state, "OK");
  assert.equal(i(snaps, rep({ generated_at: "2026-09-30T00:00:00.000Z" })).state, "OK"); // snapshot'tan eski
  assert.match(i(snaps, rep({ site: "spryhand" })).basis, /kullanilmadi/);
});

test("index_health: site alani yok / yabanci snapshot / eski uydurma sekil UNKNOWN", () => {
  const f = (x: unknown) => get(buildScorecard({ site_id: S, index: x }, NOW), "index_health");
  assert.equal(f({ ...idx(), site: undefined }).state, "UNKNOWN");
  assert.equal(f(idx([isnap([ient(U("a"))], { site: "spryhand" })])).state, "UNKNOWN");
  assert.equal(f({ schema: SCHEMA_IDS.index, site_id: S, records: [{ date: "2026-10-01", measurement_state: "MEASURED", sample_size: 20, not_indexed_count: 0 }] }).state, "UNKNOWN");
  assert.equal(f(idx([])).state, "UNKNOWN");
});

test("deployment_change: dogrulanmis son deploy OK/FACT/CONFIRMED; 14 gunde production deploy yok OK/INFERENCE", () => {
  const d = (x: unknown) => get(buildScorecard({ site_id: S, deployments: x }, NOW), "deployment_change");
  const ok = d(depl([ev()])); assert.deepEqual([ok.state, ok.evidence_label, ok.confidence], ["OK", "FACT", "CONFIRMED"]); assert.match(ok.basis, /nedensellik iddiasi yok/);
  const none = d(depl([ev({ deployed_at: "2026-08-15T10:00:00Z", verification_state: "UNVERIFIED" })]));
  assert.deepEqual([none.state, none.evidence_label, none.confidence], ["OK", "INFERENCE", "CANDIDATE"]);
  assert.equal(ok.as_of, "2026-10-01T06:00:00.000Z"); // en yeni provenance.retrieved_at
});

test("deployment_change: MISMATCH ATTENTION/FACT; UNVERIFIED/UNKNOWN 'bilmiyoruz' (ne OK ne ATTENTION); preview sayilmaz", () => {
  const d = (e: unknown[]) => get(buildScorecard({ site_id: S, deployments: depl(e) }, NOW), "deployment_change");
  const mm = d([ev({ verification_state: "MISMATCH" })]); assert.deepEqual([mm.state, mm.evidence_label, mm.confidence], ["ATTENTION", "FACT", "CONFIRMED"]);
  const un = d([ev({ verification_state: "UNVERIFIED" })]); assert.deepEqual([un.state, un.confidence], ["UNKNOWN", "UNKNOWN"]); assert.match(un.basis, /dogrulanmadi/);
  assert.equal(d([ev({ verification_state: "UNKNOWN" })]).state, "UNKNOWN");
  assert.equal(d([ev({ verification_state: "MISMATCH" }), ev({ commit_sha: "b".repeat(40), verification_state: "VERIFIED" })]).state, "ATTENTION"); // FN: biri VERIFIED digerini maskelemez
  assert.equal(d([ev({ environment: "preview", verification_state: "MISMATCH" })]).state, "OK");        // FP: preview aramada gorunmez
  assert.match(d([ev({ environment: "preview", verification_state: "MISMATCH" })]).basis, /1 preview\/unknown/);
});

test("deployment_change: bos cizelge UNKNOWN; bayat UNKNOWN-STALE; bozuk/yabanci olay tum cizelgeyi reddeder; eski sekil kabul edilmez", () => {
  const d = (x: unknown) => get(buildScorecard({ site_id: S, deployments: x }, NOW), "deployment_change");
  assert.equal(d(depl([])).state, "UNKNOWN");
  assert.match(d(depl([])).basis, /tazelik bilinmiyor/);
  assert.equal(d(depl([ev({ provenance: { source: "vercel", retrieved_at: "2026-09-01T00:00:00Z", ref: "x" } })])).state, "UNKNOWN-STALE");
  assert.equal(d(depl([ev(), ev({ commit_sha: "abc123" })])).state, "UNKNOWN");              // kisa SHA: tek bozuk olay hepsini reddeder
  assert.equal(d(depl([ev(), ev({ site: "spryhand", commit_sha: "b".repeat(40) })])).state, "UNKNOWN");
  assert.equal(d(depl([ev({ environment: "staging" })])).state, "UNKNOWN");
  assert.equal(d(depl([ev({ deployed_at: "2026-09-28" })])).state, "UNKNOWN");               // ISO UTC 'Z' zorunlu
  assert.equal(d(depl([ev()], "spryhand")).state, "UNKNOWN");
  assert.equal(d({ ...depl(), site: undefined }).state, "UNKNOWN");
  assert.equal(d({ generated_at: "2026-10-01", events: [{ schema: SCHEMA_IDS.deployment, site_id: S, deployed_at: "2026-09-28T10:00:00Z", verification_state: "VERIFIED" }] }).state, "UNKNOWN"); // eski uydurma sekil
  assert.equal(d([ev()]).state, "UNKNOWN");                                                  // ciplak dizi uretici sekli degil
});


test("search_opportunity: firsat ATTENTION/INFERENCE; sayi yoksa UNKNOWN; baska site girdisi okunmaz", () => {
  const s = (m: unknown) => get(buildScorecard({ site_id: S, measure: m }, NOW), "search_opportunity");
  assert.equal(s(meas({ opportunity_count: 3 })).state, "ATTENTION");
  assert.equal(s(meas({ opportunity_count: 3 })).confidence, "CANDIDATE");
  assert.equal(s(meas({ opportunity_count: undefined })).state, "UNKNOWN");
  assert.equal(s(meas({}, "spryhand")).state, "UNKNOWN");
  const old = meas({ generated_at: "2026-08-01T00:00:00.000Z" });
  assert.equal(s(old).state, "UNKNOWN-STALE");
});

test("izolasyon: baska sitenin dosyasi hicbir boyuta girmez (7 site, 42 cift)", () => {
  for (const s of SITES) for (const other of SITES.filter((x) => x !== s)) {
    const c = buildScorecard({ site_id: s, clarity: clarity([rec({ site_id: other })], other), performance: perf([prec({ site: other })], other), index: idx(undefined, other), deployments: depl([ev({ site: other })], other), measure: meas({}, other) }, NOW);
    for (const d of c.dimensions) assert.equal(d.state, "UNKNOWN", `${s}<-${other} ${d.dimension}=${d.state}`);
  }
});

test("yanlis sema kimligi UNKNOWN", () => {
  const c = buildScorecard({ site_id: S, clarity: { ...clarity([rec()]), schema: "baska.v1" } }, NOW);
  assert.match(get(c, "measurement_health").basis, /sema beklenen/);
});

test("evidence ontolojisi: yalniz 6 etiket + gecerli guven; degismezler tum senaryolarda tutar", () => {
  const six = new Set(["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"]);
  const confs = new Set(["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"]);
  const full = buildScorecard({ site_id: S, clarity: clarity([rec()]), performance: perf([prec({ lcp_ms: 9000 })]), index: idx([isnap([ient("https://www.pamistanbul.com/x", { verdict: "NOT_INDEXED" })])]), deployments: depl([ev()]), measure: meas({ opportunity_count: 2 }) }, NOW);
  for (const c of [full, buildScorecard({ site_id: S }, NOW)]) for (const d of c.dimensions) {
    assert.ok(six.has(d.evidence_label)); assert.ok(confs.has(d.confidence)); assert.deepEqual(dimensionInvariantProblems(d), []);
  }
  const bad: Dimension = { dimension: "performance", state: "ATTENTION", evidence_label: "INFERENCE", confidence: "CONFIRMED", basis: "x", as_of: "2026-10-01" };
  assert.equal(dimensionInvariantProblems(bad).length, 1);
  assert.equal(dimensionInvariantProblems({ ...bad, state: "UNKNOWN", evidence_label: "FACT", confidence: "CONFIRMED" }).length, 1);
});

test("sayim ortalama degil: karma sonuc tek 'iyi' durumuna indirgenmez", () => {
  const c = buildScorecard({ site_id: S, clarity: clarity([rec()]), performance: perf([prec({ lcp_ms: 9000 })]) }, NOW);
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
