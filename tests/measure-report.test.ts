// sgos.measure-report.v1 testleri. Hepsi deterministik: ag YOK, sabit saat, sahte fetch
// (tests/fixtures/measure-report/mock-google.mjs). Testlerin cogu NE URETILMEMESI
// gerektigi hakkinda: bilinmeyen bir degerin 0 diye serilesmesi en tehlikeli hata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMeasureReport, buildSiteReport, MEASURE_REPORT_SCHEMA, type MeasureReport, type SiteMeasureInput, type SiteReport } from "../src/measure-report.ts";
import { periods } from "../src/measure.ts";

const FX = "tests/fixtures/measure-report";
const SCHEMA = JSON.parse(readFileSync("schemas/measure-report.schema.json", "utf8"));
const SIX = ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"];

// --- kucuk sema dogrulayici (ajv yok): type/const/enum/required/properties/items/pattern/$ref/additionalProperties
function validate(schema: any, value: any, root: any, path = "$"): string[] {
  if (schema.$ref) return validate(schema.$ref.split("/").slice(1).reduce((n: any, k: string) => n[k], root), value, root, path);
  const errs: string[] = [];
  const typeOf = (v: any) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  if ("const" in schema && value !== schema.const) errs.push(`${path}: const ${JSON.stringify(schema.const)} bekleniyordu, ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: enum disi ${JSON.stringify(value)}`);
  if (schema.type) {
    const ok = ([] as string[]).concat(schema.type).includes(typeOf(value));
    if (!ok) { errs.push(`${path}: tip ${typeOf(value)}, beklenen ${JSON.stringify(schema.type)}`); return errs; }
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern tutmadi`);
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: zorunlu alan yok: ${k}`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: bilinmeyen alan ${k}`);
      else if (typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  return errs;
}
const conforms = (r: unknown) => validate(SCHEMA, r, SCHEMA);

/** Anlamsal kurallar: semada ifade edilemeyen (duruma bagli) degismezler. */
function semanticProblems(r: MeasureReport): string[] {
  const p: string[] = [];
  if (r.schema !== MEASURE_REPORT_SCHEMA) p.push("schema");
  for (const [key, s] of Object.entries(r.sites)) {
    if (s.site_id !== key) p.push(`${key}: anahtar ile site_id farkli`);
    const unmeasured = (state: string, nums: Array<number | null>, where: string) => {
      if (state !== "MEASURED" && nums.some((n) => n !== null)) p.push(`${key}: ${where} ${state} iken null olmali`);
    };
    unmeasured(s.gsc.state, Object.values(s.gsc.totals), "gsc.totals");
    unmeasured(s.gsc.comparison.state, Object.values(s.gsc.comparison.totals), "gsc.comparison.totals");
    unmeasured(s.ga4.state, Object.values(s.ga4.metrics), "ga4.metrics");
    if (s.gsc.state !== "MEASURED" && (s.gsc.queries.length || s.gsc.brand_split || s.opportunity_count !== null)) p.push(`${key}: olculmeyen siteye tablo/sayi yazilmis`);
    if (s.gsc.state !== "MEASURED" && s.gsc.confidence !== "UNKNOWN") p.push(`${key}: olculmeyen gsc confidence UNKNOWN olmali`);
    if (s.gsc.state === "MEASURED" && (s.gsc.evidence_label !== "FACT" || s.gsc.confidence !== "CONFIRMED")) p.push(`${key}: ham olcum FACT/CONFIRMED olmali`);
    // Yorumlar (delta, marka ayrimi, firsat) hicbir zaman CONFIRMED/FACT olamaz.
    const interp = [s.gsc.comparison.delta, s.gsc.brand_split, s.search_opportunity_inputs];
    for (const i of interp) if (i && (i.evidence_label !== "INFERENCE" || i.confidence === "CONFIRMED")) p.push(`${key}: yorum INFERENCE ve CONFIRMED-degil olmali`);
    for (const l of [s.gsc.evidence_label, s.ga4.evidence_label, s.gsc.comparison.evidence_label, s.search_opportunity_inputs.evidence_label]) if (!SIX.includes(l)) p.push(`${key}: gecersiz etiket ${l}`);
    if (s.gsc.state === "MEASURED" && s.gsc.coverage.queries_truncated !== (s.gsc.coverage.query_rows_total! > s.gsc.coverage.query_rows_returned!)) p.push(`${key}: truncation bayragi tutarsiz`);
    if (s.gsc_state === "CONNECTED" && s.gsc.state !== "MEASURED") p.push(`${key}: gsc_state takma adi tutarsiz`);
  }
  return p;
}

// --- CLI'yi sahte Google ile kos
function sa() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({ client_email: "b@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
}
function runMeasure(extra: string[], gscCred: string | undefined, ga4Cred = "") {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SEARCH_GROWTH_GA4_CREDENTIALS_JSON: ga4Cred };
  delete env.GITHUB_SHA; delete env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON;
  if (gscCred !== undefined) env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON = gscCred;
  const res = execFileSync("node", ["--import", `./${FX}/mock-google.mjs`, "--experimental-strip-types", "src/cli.ts", "measure", `${FX}/sites.fixture.json`, ...extra], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return res;
}
const outDir = mkdtempSync(join(tmpdir(), "measure-report-"));
const stdoutWithoutOut = runMeasure([], sa());
const stdoutWithOut = runMeasure(["--out", outDir], sa());
const report: MeasureReport = JSON.parse(readFileSync(join(outDir, "measure-report.json"), "utf8"));

test("Markdown/stdout ciktisi byte-byte AYNI: eski koddan uretilen golden ile ve --out ile/siz", () => {
  const golden = readFileSync(`${FX}/measure-stdout.golden.txt`, "utf8");
  assert.equal(stdoutWithoutOut, golden);
  assert.equal(stdoutWithOut, golden, "--out stdout'u degistirmemeli");
});

test("--out verilmezse JSON dosyasi YAZILMAZ (varsayilan davranis degismedi)", () => {
  assert.equal(existsSync("reports/runs/measure-report.json"), false);
});

test("sema uyumu: uretilen rapor sema + anlamsal kurallardan gecer", () => {
  assert.deepEqual(conforms(report), []);
  assert.deepEqual(semanticProblems(report), []);
});

test("sema uyumu: committed ornek dosya gecerli ve uretilenle birebir (deterministik)", () => {
  const sample = JSON.parse(readFileSync("tests/fixtures/measure-report.sample.json", "utf8"));
  assert.deepEqual(conforms(sample), []);
  assert.deepEqual(semanticProblems(sample), []);
  assert.deepEqual(sample, report);
});

test("dogrulayici gercekten reddeder (kendi kendini kanitla)", () => {
  const bad = structuredClone(report) as any;
  delete bad.sites.pamistanbul.gsc.totals.clicks;
  bad.sites.pamaistudio.gsc.state = "BILINMEZ";
  bad.sites.spryhand.surprise = 1;
  const errs = conforms(bad).join("\n");
  assert.match(errs, /zorunlu alan yok: clicks/);
  assert.match(errs, /enum disi "BILINMEZ"/);
  assert.match(errs, /bilinmeyen alan surprise/);
});

test("yedi site, her biri kendi kimligiyle anahtarli", () => {
  assert.deepEqual(Object.keys(report.sites), ["pamistanbul", "pamaistudio", "spryhand", "decideplan", "rightlisted", "untitledportraits", "myhappymade"]);
});

test("UNKNOWN/NOT_CONNECTED/ERROR asla 0 olarak serilesmez", () => {
  for (const id of ["spryhand", "decideplan"]) {
    const s = report.sites[id];
    assert.notEqual(s.gsc.state, "MEASURED");
    for (const v of [...Object.values(s.gsc.totals), ...Object.values(s.gsc.comparison.totals)]) assert.equal(v, null, `${id}: null olmali, 0/sayi degil`);
    assert.equal(s.opportunity_count, null);
    assert.deepEqual(s.gsc.queries, []);
    assert.equal(s.gsc.brand_split, null);
    assert.equal(s.gsc.rows_complete, null);
    assert.equal(s.gsc.coverage.queries_truncated, null);
    assert.equal(s.gsc.confidence, "UNKNOWN");
  }
  // Ham metin duzeyinde de: bu iki sitenin blogunda "clicks": 0 gecmemeli.
  for (const id of ["spryhand", "decideplan"]) assert.doesNotMatch(JSON.stringify(report.sites[id].gsc), /"(clicks|impressions|ctr|position)":0\b/);
});

test("GA4 hicbir sitede 0 uretmez: measure GA4'u cagirmaz; metrikler null", () => {
  for (const s of Object.values(report.sites)) {
    assert.ok(s.ga4.state === "NOT_CONNECTED" || s.ga4.state === "UNKNOWN");
    assert.deepEqual(Object.values(s.ga4.metrics), [null, null, null, null]);
  }
  // Kimlik yokken NOT_CONNECTED; kimlik varken "cagrilmadi" => UNKNOWN (ERROR/MEASURED degil).
  assert.equal(report.sites.pamistanbul.ga4.state, "NOT_CONNECTED");
  const d = mkdtempSync(join(tmpdir(), "mr-ga-"));
  runMeasure(["--out", d], sa(), sa());
  const r: MeasureReport = JSON.parse(readFileSync(join(d, "measure-report.json"), "utf8"));
  assert.equal(r.sites.pamistanbul.ga4.state, "UNKNOWN");
  assert.deepEqual(Object.values(r.sites.pamistanbul.ga4.metrics), [null, null, null, null]);
  assert.equal(r.sites.rightlisted.ga4.state, "NOT_CONNECTED", "registry'de ga4_property yok");
  assert.deepEqual(semanticProblems(r), []);
});

test("gercek olculmus sifir 0 KALIR ve state MEASURED", () => {
  const s = report.sites.pamaistudio; // API 200, satir yok
  assert.equal(s.gsc.state, "MEASURED");
  assert.equal(s.gsc.totals.clicks, 0);
  assert.equal(s.gsc.totals.impressions, 0);
  assert.equal(s.gsc.totals.ctr, 0);
  assert.equal(s.gsc.totals_source, "api_empty_response");
  // Konumun 0'i anlamsiz (gosterim yok): null, "0.0" degil.
  assert.equal(s.gsc.totals.position, null);
  assert.equal(s.gsc.confidence, "CONFIRMED");
  assert.equal(s.gsc.rows_complete, true);
  assert.equal(s.opportunity_count, 0);
  assert.equal(s.gsc_state, "CONNECTED");
});

test("NOT_CONNECTED site: registry property yok -> sebep yazili, diger siteleri etkilemez", () => {
  const s = report.sites.decideplan;
  assert.equal(s.gsc.state, "NOT_CONNECTED");
  assert.equal(s.gsc_state, "NOT_CONNECTED");
  assert.match(s.gsc.state_reason!, /google_search_console_property/);
  assert.equal(s.gsc.source.property, null);
  assert.equal(report.sites.pamistanbul.gsc.state, "MEASURED");
});

test("kimlik hic yoksa 7 site de NOT_CONNECTED ve JSON yine yazilir", () => {
  const d = mkdtempSync(join(tmpdir(), "mr-nocred-"));
  runMeasure(["--out", d], undefined);
  const r: MeasureReport = JSON.parse(readFileSync(join(d, "measure-report.json"), "utf8"));
  assert.deepEqual(conforms(r), []);
  assert.deepEqual(semanticProblems(r), []);
  for (const s of Object.values(r.sites)) { assert.equal(s.gsc.state, "NOT_CONNECTED"); assert.equal(s.gsc.totals.clicks, null); }
});

test("kismi basarisizlik: GSC ok + GA4 olculmedi; GSC hata + diger siteler ok", () => {
  const ok = report.sites.pamistanbul;
  assert.equal(ok.gsc.state, "MEASURED");
  assert.notEqual(ok.ga4.state, "MEASURED");
  const err = report.sites.spryhand;
  assert.equal(err.gsc.state, "ERROR");
  assert.equal(err.gsc_state, "ERROR");
  assert.match(err.gsc.state_reason!, /HTTP 403/);
  assert.equal(report.sites.rightlisted.gsc.state, "MEASURED");
  // Registry'de ga4_property yok => sebep ayri yazilir.
  assert.match(report.sites.rightlisted.ga4.state_reason!, /ga4_property/);
});

test("ham olcum FACT/CONFIRMED, delta ve marka ayrimi ve firsat INFERENCE/CANDIDATE", () => {
  const s = report.sites.pamistanbul;
  assert.equal(s.gsc.evidence_label, "FACT");
  assert.equal(s.gsc.comparison.evidence_label, "FACT");
  assert.equal(s.gsc.comparison.delta.evidence_label, "INFERENCE");
  assert.equal(s.gsc.comparison.delta.confidence, "CANDIDATE");
  assert.equal(s.gsc.brand_split!.evidence_label, "INFERENCE");
  assert.equal(s.search_opportunity_inputs.evidence_label, "INFERENCE");
  assert.equal(s.search_opportunity_inputs.confidence, "CANDIDATE");
  assert.deepEqual(s.gsc.comparison.delta.clicks, { abs: 42, pct: 350 });
  // Markdown'daki +310% ile ayni marka satiri.
  assert.equal(s.gsc.brand_split!.brand.clicks, 41);
});

test("onceki donem sifirsa yuzde null (Markdown'daki '(yeni)'), mutlak fark yine var", () => {
  const s = report.sites.myhappymade;
  assert.equal(s.gsc.comparison.totals.clicks, 0);
  assert.deepEqual(s.gsc.comparison.delta.clicks, { abs: 4, pct: null });
});

test("anonimlestirilmis kuyruk Markdown'daki 'not' ile ayni sayi", () => {
  assert.equal(report.sites.pamistanbul.gsc.coverage.anonymized_tail_impressions, 3370);
  assert.match(stdoutWithOut, /3370 gösterimlik düşük-hacimli kuyruğu/);
});

test("firsat girdileri: marka disi, sira 5-30, gosterim >=20; marka sorgusu yok", () => {
  const o = report.sites.pamistanbul.search_opportunity_inputs;
  assert.equal(o.opportunity_count, 3);
  assert.deepEqual(o.candidates.map((c) => c.query), ["video production istanbul", "ai film maker", "fotograf cekimi fiyat"]);
  assert.equal(o.opportunity_count, report.sites.pamistanbul.opportunity_count);
  assert.deepEqual(o.query_page_rows, { state: "NOT_MEASURED", rows: null, reason: o.query_page_rows.reason });
  assert.equal(report.sites.pamistanbul.gsc.pages.state, "NOT_MEASURED");
});

// --- builder birim testleri
const P = periods(new Date("2026-10-02T06:40:00Z"));
const opts = { now: new Date("2026-10-02T06:40:00Z"), current: P.current, yearAgo: P.yearAgo, toolVersion: "t" };
const row = (query: string, clicks: number, impressions: number, position: number) => ({ query, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const tot = (clicks: number, impressions: number, position: number) => [{ clicks, impressions, ctr: impressions ? clicks / impressions : 0, position }];
const okInput = (siteId: string, patterns: string[], rows: ReturnType<typeof row>[], t = tot(10, 100, 5)): SiteMeasureInput => ({
  siteId, gscProperty: `sc-domain:${siteId}.test`, ga4Property: "123", patterns,
  outcome: { kind: "ok", current: rows, yearAgo: rows, currentTotal: t, yearAgoTotal: t }, ga4Status: { state: "UNKNOWN", note: "n" },
});

test("truncation bayragi korunur: tablo sinirlanirsa queries_truncated=true ve toplam satir sayisi dogru", () => {
  const rows = [row("a", 1, 100, 7), row("b", 1, 90, 7), row("c", 1, 80, 7)];
  const s = buildSiteReport(okInput("x", [], rows), { ...opts, maxQueryRows: 2 });
  assert.equal(s.gsc.coverage.queries_truncated, true);
  assert.equal(s.gsc.coverage.query_rows_total, 3);
  assert.equal(s.gsc.coverage.query_rows_returned, 2);
  assert.deepEqual(s.gsc.queries.map((q) => q.query), ["a", "b"]); // gosterime gore azalan
  // Firsat sayisi tabloyla kesilmez: tum satirlardan hesaplanir.
  assert.equal(s.search_opportunity_inputs.opportunity_count, 3);
  const full = buildSiteReport(okInput("x", [], rows), opts);
  assert.equal(full.gsc.coverage.queries_truncated, false);
});

test("izolasyon: bir sitenin girdisi digerinin ciktisini degistirmez; marka deseni sizmaz", () => {
  const a = okInput("alpha", ["alpha brand"], [row("alpha brand shoes", 5, 50, 2), row("shoes", 0, 300, 9)]);
  const b = okInput("beta", ["beta brand"], [row("alpha brand shoes", 1, 40, 3)]);
  const both = buildMeasureReport([a, b], opts);
  const onlyB = buildMeasureReport([b], opts);
  assert.deepEqual(both.sites.beta, onlyB.sites.beta);
  assert.equal(both.sites.beta.gsc.queries[0].brand_class, "non_brand", "alpha'nin marka deseni beta'ya tasinmamali");
  assert.equal(both.sites.alpha.gsc.queries.find((q) => q.query === "alpha brand shoes")!.brand_class, "brand");
  assert.equal(JSON.stringify(both.sites.beta).includes("alpha brand\""), false, "beta kaydinda alpha deseni yok");
  assert.deepEqual(Object.keys(onlyB.sites), ["beta"]);
});

test("onceki donem yaniti yoksa karsilastirma UNKNOWN + null (0 degil)", () => {
  const i = okInput("x", [], [row("a", 1, 100, 7)]);
  if (i.outcome.kind !== "ok") throw new Error();
  const s = buildSiteReport({ ...i, outcome: { ...i.outcome, yearAgo: null, yearAgoTotal: null } }, opts);
  assert.equal(s.gsc.state, "MEASURED");
  assert.equal(s.gsc.comparison.state, "UNKNOWN");
  assert.deepEqual(Object.values(s.gsc.comparison.totals), [null, null, null, null]);
  assert.deepEqual(s.gsc.comparison.delta.clicks, { abs: null, pct: null });
  assert.equal(s.gsc.brand_split!.comparison, null);
  assert.deepEqual(semanticProblems({ ...buildMeasureReport([], opts), sites: { x: s } }), []);
});

test("hata mesaji yalnizca state_reason'da; metrik yok", () => {
  const s = buildSiteReport({ siteId: "x", gscProperty: "sc-domain:x.test", ga4Property: "1", patterns: [], outcome: { kind: "error", message: "HTTP 500" }, ga4Status: { state: "UNKNOWN", note: "" } }, opts);
  assert.equal(s.gsc.state, "ERROR");
  assert.equal(s.gsc.state_reason, "HTTP 500");
  assert.equal(s.gsc.totals.clicks, null);
});
