// Performans/CWV katmani. Testlerin cogu NE YAPILMAMASI gerektigi hakkinda: eksik metrigi 0 yazmak,
// field ile lab'i karistirmak, bugunu baz almak, bir sitenin gecmisine digerinin kaydini yazmak,
// anahtari sizdirmak, butceyi asmak. Ag YOK: fetcher enjekte edilir; env'e dokunulmaz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, type SiteEntry } from "../src/registry.ts";
import {
  RECORD_SCHEMA, HISTORY_SCHEMA, HISTORY_MAX_RECORDS, HARD_URL_CAP, THRESHOLDS, rate, parsePsiResponse, errorRecord, planUrls,
  RequestBudget, parseHistory, loadHistory, mergeRecord, selectBaseline, detectRegressions, runPerformance, reportMarkdown,
  PerfHistoryError, type PerfRecord, type HistoryFile,
} from "../src/performance.ts";
import { createPsiFetcher, hasPsiKey, PSI_ENV, type PsiFetcher } from "../src/performance-psi.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITES = loadRegistry(join(ROOT, "config/sites.yaml")).registry!.sites;
const site = (id: string): SiteEntry => SITES.find((s) => s.id === id)!;
const CTX = { site: "pamistanbul", url: "https://pamistanbul.com/", strategy: "mobile" as const, measuredAt: "2026-10-02T07:00:00.000Z" };
const DAY = (n: number) => new Date(Date.UTC(2026, 9, n, 7, 0, 0));

// --- fixture'lar (PSI v5 govdesinin kirpilmis, gercek sekilli hali) --------------------------------------------

const fieldBody = (o: { lcp?: number; inp?: number; cls?: number; ttfb?: number; origin?: boolean; score?: number } = {}) => ({
  loadingExperience: {
    origin_fallback: o.origin,
    metrics: {
      ...(o.lcp !== undefined && { LARGEST_CONTENTFUL_PAINT_MS: { percentile: o.lcp } }),
      ...(o.inp !== undefined && { INTERACTION_TO_NEXT_PAINT: { percentile: o.inp } }),
      ...(o.cls !== undefined && { CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: o.cls } }),
      ...(o.ttfb !== undefined && { EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: o.ttfb } }),
    },
  },
  lighthouseResult: {
    categories: { performance: { score: o.score ?? 0.9 } },
    audits: { "largest-contentful-paint": { numericValue: 9999 }, "cumulative-layout-shift": { numericValue: 0.9 }, "server-response-time": { numericValue: 9999 } },
  },
});
const labBody = (o: { lcp?: number; cls?: number; ttfb?: number; score?: number } = {}) => ({
  loadingExperience: { metrics: {} },
  lighthouseResult: {
    categories: { performance: { score: o.score ?? 0.7 } },
    audits: {
      ...(o.lcp !== undefined && { "largest-contentful-paint": { numericValue: o.lcp } }),
      ...(o.cls !== undefined && { "cumulative-layout-shift": { numericValue: o.cls } }),
      ...(o.ttfb !== undefined && { "server-response-time": { numericValue: o.ttfb } }),
    },
  },
});
const parse = (b: unknown, status = 200, ctx = CTX) => parsePsiResponse(status, b, ctx);
const rec = (over: Partial<PerfRecord> & { date?: string }): PerfRecord => {
  const date = over.date ?? "2026-10-01";
  return { ...parse(fieldBody({ lcp: 2000, inp: 150, cls: 5, ttfb: 500 }), 200, { ...CTX, measuredAt: `${date}T07:00:00.000Z` }), ...over, date } as PerfRecord;
};
const hist = (records: PerfRecord[], s = "pamistanbul"): HistoryFile => ({ schema: HISTORY_SCHEMA, site: s, max_records: HISTORY_MAX_RECORDS, records });

// --- ayristirma: field / lab -------------------------------------------------------------------------------

test("field: CrUX metrikleri FACT olarak okunur; CLS percentile/100; lab degerleri karismaz", () => {
  const r = parse(fieldBody({ lcp: 2100, inp: 180, cls: 5, ttfb: 600, score: 0.91 }));
  assert.equal(r.schema, RECORD_SCHEMA);
  assert.deepEqual([r.lcp_ms, r.inp_ms, r.cls, r.ttfb_ms, r.perf_score], [2100, 180, 0.05, 600, 91]);
  assert.equal(r.source, "field"); assert.equal(r.field_scope, "url");
  assert.equal(r.state, "MEASURED"); assert.equal(r.evidence, "FACT"); assert.equal(r.confidence, "CONFIRMED");
  assert.notEqual(r.lcp_ms, 9999, "lab LCP (9999) field kaydina sizmamali");
});

test("lab: field yokken lab kullanilir, INP null (lab'de yok) ve UNKNOWN", () => {
  const r = parse(labBody({ lcp: 4200.5, cls: 0, ttfb: 350, score: 0.62 }));
  assert.equal(r.source, "lab"); assert.equal(r.inp_ms, null);
  assert.equal(r.ratings.values.inp_ms, "UNKNOWN");
  assert.equal(r.lcp_ms, 4200.5); assert.equal(r.perf_score, 62);
});

test("YANLIS-POZITIF: gercek CLS=0 (lab) bir olcumdur, null'a cevrilmez", () => {
  const r = parse(labBody({ lcp: 1500, cls: 0 }));
  assert.equal(r.cls, 0); assert.equal(r.ratings.values.cls, "GOOD");
});

test("YANLIS-NEGATIF: eksik metrik 0 DEGIL null+UNKNOWN; olcum olmayan LCP asla 0 olmaz", () => {
  const r = parse(fieldBody({ lcp: 2000 })); // inp/cls/ttfb yok
  assert.equal(r.inp_ms, null); assert.equal(r.cls, null); assert.equal(r.ttfb_ms, null);
  assert.equal(r.ratings.values.inp_ms, "UNKNOWN"); assert.equal(r.ratings.values.cls, "UNKNOWN");
  const z = parse(labBody({ lcp: 0, cls: 0.05 })); // 0 ms LCP fiziksel degil -> yok say
  assert.equal(z.lcp_ms, null);
  const neg = parse({ loadingExperience: fieldBody({ lcp: -5, inp: Number.NaN as number, cls: -1 }).loadingExperience });
  assert.equal(neg.lcp_ms, null); assert.equal(neg.inp_ms, null); assert.equal(neg.cls, null);
});

test("hic veri yok -> state UNKNOWN, source none, hicbir sayi uydurulmaz", () => {
  const r = parse({ loadingExperience: { metrics: {} }, lighthouseResult: { audits: {}, categories: {} } });
  assert.equal(r.state, "UNKNOWN"); assert.equal(r.source, "none"); assert.equal(r.confidence, "UNKNOWN");
  assert.ok([r.lcp_ms, r.inp_ms, r.cls, r.ttfb_ms, r.perf_score].every((v) => v === null));
});

test("origin geri-dususu isaretlenir (url ile ayni sey degil)", () => {
  assert.equal(parse(fieldBody({ lcp: 3000, origin: true })).field_scope, "origin");
});

test("hata govdeleri: PSI error, 429, 5xx, bozuk govde, Lighthouse runtimeError -> ERROR; mesaj saklanmaz", () => {
  const e = parse({ error: { code: 429, message: "Quota exceeded for key=SECRET-KEY-123" } }, 429);
  assert.equal(e.state, "ERROR"); assert.equal(e.error_code, "HTTP_429");
  assert.ok(!JSON.stringify(e).includes("SECRET-KEY-123"));
  assert.equal(parse({ error: { code: 400, message: "x" } }, 400).error_code, "PSI_400");
  assert.equal(parse({}, 503).error_code, "HTTP_503");
  assert.equal(parse("<html>", 200).error_code, "BAD_RESPONSE");
  assert.equal(parse(null, 200).state, "ERROR");
  assert.equal(parse({ lighthouseResult: { runtimeError: { code: "FAILED_DOCUMENT_REQUEST" }, audits: { "largest-contentful-paint": { numericValue: 100 } } } }).state, "ERROR");
  assert.equal(parse({ lighthouseResult: { runtimeError: {} } }).lcp_ms, null);
});

test("perf_score sinir disi (>1) yok sayilir", () => {
  assert.equal(parse(labBody({ lcp: 2000, score: 91 })).perf_score, null);
});

// --- esikler (INFERENCE) -----------------------------------------------------------------------------------

test("CWV esikleri web.dev ile birebir; sinir degerler iyi tarafta", () => {
  assert.deepEqual([THRESHOLDS.lcp_ms.good, THRESHOLDS.lcp_ms.poor, THRESHOLDS.inp_ms.good, THRESHOLDS.inp_ms.poor, THRESHOLDS.cls.good, THRESHOLDS.cls.poor], [2500, 4000, 200, 500, 0.1, 0.25]);
  assert.equal(rate("lcp_ms", 2500), "GOOD"); assert.equal(rate("lcp_ms", 2501), "NEEDS_IMPROVEMENT");
  assert.equal(rate("lcp_ms", 4000), "NEEDS_IMPROVEMENT"); assert.equal(rate("lcp_ms", 4001), "POOR");
  assert.equal(rate("inp_ms", 200), "GOOD"); assert.equal(rate("inp_ms", 501), "POOR");
  assert.equal(rate("cls", 0.1), "GOOD"); assert.equal(rate("cls", 0.25), "NEEDS_IMPROVEMENT"); assert.equal(rate("cls", 0.26), "POOR");
  assert.equal(rate("cls", null), "UNKNOWN");
});

test("siniflandirma INFERENCE etiketi tasir, olculen deger FACT kalir", () => {
  const r = parse(fieldBody({ lcp: 5000, inp: 100, cls: 20 }));
  assert.equal(r.ratings.label, "INFERENCE"); assert.equal(r.ratings.confidence, "CANDIDATE");
  assert.equal(r.ratings.values.lcp_ms, "POOR"); assert.equal(r.ratings.values.inp_ms, "GOOD"); assert.equal(r.ratings.values.cls, "NEEDS_IMPROVEMENT");
  assert.equal(r.evidence, "FACT");
  assert.equal(parse({}, 500).ratings.confidence, "UNKNOWN");
});

// --- URL plani + butce -------------------------------------------------------------------------------------

test("URL plani: varsayilan ana sayfa, 5 URL tavani, sert tavan 10, tekrar atilir", () => {
  const s = site("pamistanbul");
  assert.deepEqual(planUrls(s, undefined).urls, ["https://pamistanbul.com/"]);
  const many = Array.from({ length: 30 }, (_, i) => `https://pamistanbul.com/p${i}`);
  const d = planUrls(s, many); assert.equal(d.urls.length, 5); assert.equal(d.truncated.length, 25);
  assert.equal(planUrls(s, many, 999).urls.length, HARD_URL_CAP);
  assert.equal(planUrls(s, many, 0).urls.length, 5);
  assert.equal(planUrls(s, ["https://pamistanbul.com/a", "https://pamistanbul.com/a#x"]).urls.length, 1);
});

test("izolasyon: baska sitenin / ucuncu parti URL reddedilir; www varyanti kabul", () => {
  const p = planUrls(site("pamistanbul"), ["https://spryhand.com/", "https://evil.example/", "https://www.pamistanbul.com/x", "not a url", "ftp://pamistanbul.com/"]);
  assert.deepEqual(p.urls, ["https://www.pamistanbul.com/x"]);
  assert.equal(p.rejected.length, 4);
  assert.deepEqual(planUrls(site("rightlisted"), ["https://rightlisted.com/a"]).urls, ["https://rightlisted.com/a"]); // canonical www, istek apex
  assert.deepEqual(planUrls(site("rightlisted"), undefined).urls, ["https://www.rightlisted.com/"]);
});

test("RequestBudget tavanda durur", () => {
  const b = new RequestBudget(2);
  assert.deepEqual([b.tryTake(), b.tryTake(), b.tryTake()], [true, true, false]);
  assert.equal(b.used, 2); assert.equal(b.remaining, 0);
  assert.equal(new RequestBudget(-3).tryTake(), false);
});

// --- gecmis ------------------------------------------------------------------------------------------------

test("gecmis: ayni gun+url+strateji icin ILK basarili kazanir; farkli strateji/url ayri kayit", () => {
  const a = rec({ lcp_ms: 2000 });
  const h1 = mergeRecord(hist([]), a);
  assert.equal(h1.action, "ADDED");
  const later = rec({ lcp_ms: 9000 }); // ayni gun, ayni anahtar
  const h2 = mergeRecord(h1.file, later);
  assert.equal(h2.action, "KEPT_EXISTING"); assert.equal(h2.file.records[0].lcp_ms, 2000);
  assert.equal(mergeRecord(h2.file, rec({ strategy: "desktop" })).action, "ADDED");
  assert.equal(mergeRecord(h2.file, rec({ url: "https://pamistanbul.com/b" })).action, "ADDED");
});

test("gecmis: ERROR/UNKNOWN/NOT_CONNECTED yazilmaz ve basarili kaydi ezmez", () => {
  const h = mergeRecord(hist([]), rec({})).file;
  for (const bad of [errorRecord(CTX, "HTTP_500"), errorRecord(CTX, "NOT_CONNECTED", "NOT_CONNECTED"), parse({})]) {
    const m = mergeRecord(h, bad); assert.equal(m.action, "NOT_STORED"); assert.deepEqual(m.file, h);
  }
});

test("gecmis: 120 kayit siniri, en eski dusar", () => {
  let h = hist([]);
  for (let i = 0; i < 130; i++) h = mergeRecord(h, rec({ url: `https://pamistanbul.com/u${i}`, date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}` })).file;
  assert.equal(h.records.length, HISTORY_MAX_RECORDS);
  assert.ok(!h.records.some((r) => r.url.endsWith("/u0")));
  assert.ok(h.records.some((r) => r.url.endsWith("/u129")));
});

test("izolasyon: baska sitenin kaydi gecmise yazilamaz", () => {
  assert.throws(() => mergeRecord(hist([], "spryhand"), rec({})), /izolasyon/);
});

test("parseHistory fail-closed: bozuk her sey PerfHistoryError", () => {
  const ok = JSON.stringify(hist([rec({})]));
  assert.equal(parseHistory(ok, "pamistanbul").records.length, 1);
  const bad = (mut: (h: any) => void) => { const h = JSON.parse(ok); mut(h); return JSON.stringify(h); };
  const cases: Record<string, string> = {
    "json degil": "{nope",
    "sema": bad((h) => { h.schema = "x"; }),
    "site": bad((h) => { h.site = "spryhand"; }),
    "kayit sitesi": bad((h) => { h.records[0].site = "spryhand"; }),
    "ERROR kayit": bad((h) => { h.records[0].state = "ERROR"; }),
    "lcp=0": bad((h) => { h.records[0].lcp_ms = 0; }),
    "negatif": bad((h) => { h.records[0].cls = -1; }),
    "tarih uyusmaz": bad((h) => { h.records[0].date = "2026-09-01"; }),
    "strateji": bad((h) => { h.records[0].strategy = "tablet"; }),
    "cift anahtar": bad((h) => { h.records.push({ ...h.records[0] }); }),
    "sira": bad((h) => { const b = { ...h.records[0], date: "2026-09-01", measured_at: "2026-09-01T00:00:00Z", url: "https://pamistanbul.com/z" }; h.records.push(b); }),
    "hepsi null": bad((h) => { for (const k of ["lcp_ms", "inp_ms", "cls", "ttfb_ms"]) h.records[0][k] = null; h.records[0].perf_score = null; }),
    "120 ustu": bad((h) => { h.records = Array.from({ length: 121 }, (_, i) => ({ ...h.records[0], url: `https://pamistanbul.com/${i}` })); }),
  };
  for (const [n, t] of Object.entries(cases)) assert.throws(() => parseHistory(t, "pamistanbul"), PerfHistoryError, n);
});

test("loadHistory: dosya yoksa bos; path traversal reddedilir", () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-"));
  assert.equal(loadHistory(dir, "pamistanbul").records.length, 0);
  assert.throws(() => loadHistory(dir, "../etc"), /gecersiz site/);
});

// --- regresyon ---------------------------------------------------------------------------------------------

const cur = (over: Partial<PerfRecord> = {}) => rec({ date: "2026-10-02", ...over });

test("regresyon: GOOD->POOR LCP field'da CANDIDATE/REVIEW_REQUIRED, neden iddiasi YOK", () => {
  const g = detectRegressions(cur({ lcp_ms: 4500 }), hist([rec({ lcp_ms: 2000 })]), true);
  assert.equal(g.length, 1);
  const x = g[0];
  assert.equal(x.metric, "lcp_ms"); assert.equal(x.label, "INFERENCE"); assert.equal(x.confidence, "CANDIDATE");
  assert.equal(x.action, "REVIEW_REQUIRED"); assert.equal(x.causal_claim, "NONE");
  assert.equal(x.baseline_rating, "GOOD"); assert.equal(x.current_rating, "POOR");
  assert.ok(!/neden:|cunku|sebep/i.test(x.note.replace("Neden bilinmiyor", "")));
});

test("YANLIS-POZITIF: esigi sinirda gecen kucuk degisim (%0.8) regresyon degil", () => {
  assert.deepEqual(detectRegressions(cur({ lcp_ms: 2510 }), hist([rec({ lcp_ms: 2490 })]), true), []);
});
test("YANLIS-POZITIF: iyilesme ve ayni bucket icinde kotulesme alarm uretmez", () => {
  assert.deepEqual(detectRegressions(cur({ lcp_ms: 1000 }), hist([rec({ lcp_ms: 2000 })]), true), []);
  assert.deepEqual(detectRegressions(cur({ lcp_ms: 2400 }), hist([rec({ lcp_ms: 1500 })]), true), []); // GOOD -> GOOD
});
test("YANLIS-NEGATIF: bucket degisti ve %>=10 -> yakalanir; zaten POOR olan %25 kotulesince yakalanir", () => {
  assert.equal(detectRegressions(cur({ lcp_ms: 3000 }), hist([rec({ lcp_ms: 2400 })]), true).length, 1); // +25%, GOOD->NI
  assert.equal(detectRegressions(cur({ lcp_ms: 7000 }), hist([rec({ lcp_ms: 5000 })]), true).length, 1); // POOR icinde +40%
  assert.equal(detectRegressions(cur({ lcp_ms: 5200 }), hist([rec({ lcp_ms: 5000 })]), true).length, 0); // POOR icinde +4%
});
test("CLS 0 tabanindan kotulesme sifira bolmeden yakalanir", () => {
  const g = detectRegressions(cur({ cls: 0.3 }), hist([rec({ cls: 0 })]), true);
  assert.equal(g.length, 1); assert.ok(Number.isFinite(g[0].relative_change!));
});
test("lab esigi daha yuksek: field'da yakalanan %15 lab'de alarm degil", () => {
  const b = hist([{ ...rec({}), ...parse(labBody({ lcp: 2300 }), 200, { ...CTX, measuredAt: "2026-10-01T07:00:00.000Z" }) } as PerfRecord]);
  assert.equal(detectRegressions({ ...parse(labBody({ lcp: 2650 })), date: "2026-10-02" } as PerfRecord, b, true).filter((r) => r.metric === "lcp_ms").length, 0);
  assert.equal(detectRegressions({ ...parse(labBody({ lcp: 2900 })), date: "2026-10-02" } as PerfRecord, b, true).filter((r) => r.metric === "lcp_ms").length, 1);
});
test("baz kurallari: bugun baz olamaz; field baz lab'e karsi kullanilmaz; origin url'ye karsi kullanilmaz; farkli url/strateji baz degil", () => {
  const c = cur({ lcp_ms: 5000 });
  assert.equal(selectBaseline(hist([rec({ date: "2026-10-02", lcp_ms: 1000 })]), c, "lcp_ms"), null);
  const lab = { ...rec({}), source: "lab" as const };
  assert.equal(selectBaseline(hist([lab]), c, "lcp_ms"), null);
  assert.equal(selectBaseline(hist([rec({ field_scope: "origin" })]), c, "lcp_ms"), null);
  assert.equal(selectBaseline(hist([rec({ url: "https://pamistanbul.com/baska" })]), c, "lcp_ms"), null);
  assert.equal(selectBaseline(hist([rec({ strategy: "desktop" })]), c, "lcp_ms"), null);
  assert.deepEqual(detectRegressions(c, hist([lab]), true), []);
});
test("baz: en yeni onceki gun secilir; metrigi null olan gun atlanir (0 sayilmaz)", () => {
  const old = rec({ date: "2026-09-20", lcp_ms: 2000 });
  const mid = rec({ date: "2026-09-30", lcp_ms: null }); // LCP olculmemis
  const b = selectBaseline(hist([old, mid]), cur({ lcp_ms: 5000 }), "lcp_ms");
  assert.equal(b!.date, "2026-09-20");
  assert.equal(detectRegressions(cur({ lcp_ms: 5000 }), hist([mid]), true).length, 0, "null baz regresyon uretmez");
});
test("perf_score dususu >=10 puan aday; <10 degil", () => {
  assert.equal(detectRegressions(cur({ perf_score: 70 }), hist([rec({ perf_score: 85 })]), true).filter((r) => r.metric === "perf_score").length, 1);
  assert.equal(detectRegressions(cur({ perf_score: 80 }), hist([rec({ perf_score: 85 })]), true).filter((r) => r.metric === "perf_score").length, 0);
});
test("MEASURED olmayan guncel kayit regresyon uretmez", () => {
  assert.deepEqual(detectRegressions(errorRecord(CTX, "HTTP_500"), hist([rec({})]), true), []);
});
test("onboard edilmemis site: regresyon OBSERVE_ONLY (olcum var, tavsiye yok)", () => {
  assert.equal(detectRegressions(cur({ lcp_ms: 5000 }), hist([rec({ lcp_ms: 2000 })]), false)[0].action, "OBSERVE_ONLY");
});

// --- PSI istemcisi: anahtar -------------------------------------------------------------------------------

test("anahtar yoksa fetcher kurulmaz (NOT_CONNECTED), bosluk anahtar sayilmaz", () => {
  assert.equal(createPsiFetcher({}), null);
  assert.equal(createPsiFetcher({ [PSI_ENV]: "   " }), null);
  assert.equal(hasPsiKey({ [PSI_ENV]: "k" }), true);
});
test("istemci: anahtar yalniz sorguda; fetcher istegi anahtar tasimaz; hata anahtari sizdirmaz; 429 yeniden denenmez", async () => {
  const KEY = "AIza-SECRET-KEY-123"; let calls = 0; let seen = "";
  const f = createPsiFetcher({ [PSI_ENV]: KEY }, (async (u: string) => { calls++; seen = u; return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 }); }) as unknown as typeof fetch)!;
  const res = await f({ url: "https://pamistanbul.com/", strategy: "mobile" });
  assert.equal(res.status, 429); assert.equal(calls, 1);
  assert.ok(seen.includes(`key=${KEY}`) && seen.includes("strategy=mobile"));
  assert.ok(!JSON.stringify(res).includes(KEY));
  const boom = createPsiFetcher({ [PSI_ENV]: KEY }, (async (u: string) => { throw new Error(`fail key=${KEY} ${u.length}`); }) as unknown as typeof fetch)!;
  await assert.rejects(() => boom({ url: "https://pamistanbul.com/", strategy: "mobile" }), (e: Error) => !e.message.includes(KEY) && /REDACTED/.test(e.message));
});

// --- kosu --------------------------------------------------------------------------------------------------

const okFetcher = (body: unknown = fieldBody({ lcp: 2000, inp: 150, cls: 5, ttfb: 500 }), log: string[] = []): PsiFetcher => async (r) => { log.push(`${r.strategy} ${r.url}`); return { status: 200, body }; };

test("kosu: anahtar yok -> NOT_CONNECTED, istek yok, sayi yok, gecmis yazilmaz", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-"));
  const r = await runPerformance({ sites: [site("pamistanbul")], env: {}, now: DAY(2), historyDir: dir });
  const s = r.sites[0];
  assert.equal(s.action, "NOT_CONNECTED"); assert.equal(s.records[0].state, "NOT_CONNECTED");
  assert.equal(s.records[0].lcp_ms, null); assert.equal(r.budget.used, 0);
  assert.equal(existsSync(join(dir, "pamistanbul.json")), false);
});

test("kosu: 7 site, her site yalniz kendi URL'sini ve kendi gecmisini kullanir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-")); const log: string[] = [];
  const r = await runPerformance({ sites: SITES, fetcher: okFetcher(undefined, log), now: DAY(2), historyDir: dir, strategies: ["mobile", "desktop"] });
  assert.equal(r.sites.length, 7); assert.equal(r.budget.used, 14);
  for (const s of r.sites) {
    const h = JSON.parse(readFileSync(join(dir, `${s.site}.json`), "utf8")) as HistoryFile;
    assert.equal(h.schema, HISTORY_SCHEMA);
    assert.ok(h.records.every((x) => x.site === s.site));
    const host = site(s.site).canonical_hostname.replace(/^www\./, "");
    assert.ok(h.records.every((x) => new URL(x.url).hostname.replace(/^www\./, "") === host));
  }
});

test("kosu: onboard edilmemis site olculur ama regresyon OBSERVE_ONLY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-"));
  const ghost: SiteEntry = { ...site("spryhand"), onboarding_status: "registered_not_onboarded" };
  await runPerformance({ sites: [ghost], fetcher: okFetcher(), now: DAY(1), historyDir: dir });
  const r = await runPerformance({ sites: [ghost], fetcher: okFetcher(fieldBody({ lcp: 6000, inp: 150, cls: 5, ttfb: 500 })), now: DAY(2), historyDir: dir });
  assert.equal(r.sites[0].records[0].state, "MEASURED");
  assert.ok(r.sites[0].regressions.length >= 1);
  assert.ok(r.sites[0].regressions.every((x) => x.action === "OBSERVE_ONLY"));
});

test("kosu: ikinci gun regresyon yakalar; bugun baz degil; ayni gun tekrar kosu istek harcamaz ve gecmisi degistirmez", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-"));
  const s = [site("pamistanbul")];
  await runPerformance({ sites: s, fetcher: okFetcher(), now: DAY(1), historyDir: dir });
  const d2 = await runPerformance({ sites: s, fetcher: okFetcher(fieldBody({ lcp: 5000, inp: 150, cls: 5, ttfb: 500 })), now: DAY(2), historyDir: dir });
  assert.equal(d2.sites[0].regressions.filter((x) => x.metric === "lcp_ms").length, 1);
  assert.equal(d2.sites[0].regressions[0].action, "REVIEW_REQUIRED");
  const before = readFileSync(join(dir, "pamistanbul.json"), "utf8");
  const again = await runPerformance({ sites: s, fetcher: okFetcher(fieldBody({ lcp: 9000 })), now: DAY(2), historyDir: dir });
  assert.equal(again.budget.used, 0); assert.equal(again.sites[0].skipped[0].reason, "ALREADY_MEASURED_TODAY");
  assert.equal(readFileSync(join(dir, "pamistanbul.json"), "utf8"), before);
});

test("kosu: butce asilmaz, kalanlar BUDGET_EXHAUSTED olarak yazilir (sessiz yarim kalmaz)", async () => {
  const log: string[] = [];
  const urls = Array.from({ length: 5 }, (_, i) => `https://pamistanbul.com/p${i}`);
  const r = await runPerformance({ sites: [site("pamistanbul")], urlsBySite: { pamistanbul: urls }, fetcher: okFetcher(undefined, log), now: DAY(2), maxRequests: 3 });
  assert.equal(log.length, 3); assert.equal(r.budget.used, 3);
  assert.equal(r.sites[0].skipped.filter((x) => x.reason === "BUDGET_EXHAUSTED").length, 2);
  assert.equal(r.sites[0].records.length, 3);
});

test("kosu: URL tavani ve izolasyon reddi raporlanir; reddedilen URL icin istek yok", async () => {
  const log: string[] = [];
  const urls = [...Array.from({ length: 8 }, (_, i) => `https://pamistanbul.com/p${i}`), "https://spryhand.com/"];
  const r = await runPerformance({ sites: [site("pamistanbul")], urlsBySite: { pamistanbul: urls }, fetcher: okFetcher(undefined, log), now: DAY(2) });
  assert.equal(log.length, 5); assert.equal(r.sites[0].truncated_urls.length, 3); assert.equal(r.sites[0].rejected_urls.length, 1);
  assert.ok(!log.some((l) => l.includes("spryhand")));
});

test("kosu: fetcher hatasi/429 -> ERROR kaydi, gecmise yazilmaz, diger URL devam eder; hata metni saklanmaz", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-")); let n = 0;
  const f: PsiFetcher = async () => { n++; if (n === 1) throw new Error("boom key=SECRET"); if (n === 2) return { status: 429, body: {} }; return { status: 200, body: fieldBody({ lcp: 2000 }) }; };
  const urls = ["https://pamistanbul.com/a", "https://pamistanbul.com/b", "https://pamistanbul.com/c"];
  const r = await runPerformance({ sites: [site("pamistanbul")], urlsBySite: { pamistanbul: urls }, fetcher: f, now: DAY(2), historyDir: dir });
  assert.deepEqual(r.sites[0].records.map((x) => x.state), ["ERROR", "ERROR", "MEASURED"]);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(JSON.parse(readFileSync(join(dir, "pamistanbul.json"), "utf8")).records.length, 1);
});

test("kosu: bozuk gecmis o siteyi atlar (istek yok, uzerine yazma yok); diger site etkilenmez", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-")); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pamistanbul.json"), "{bozuk");
  const log: string[] = [];
  const r = await runPerformance({ sites: [site("pamistanbul"), site("spryhand")], fetcher: okFetcher(undefined, log), now: DAY(2), historyDir: dir });
  assert.equal(r.sites[0].action, "HISTORY_CORRUPT"); assert.equal(r.sites[1].action, "MEASURED");
  assert.equal(log.length, 1); assert.ok(log[0].includes("spryhand"));
  assert.equal(readFileSync(join(dir, "pamistanbul.json"), "utf8"), "{bozuk");
});

test("kosu: siteFilter ve writeHistory=false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-"));
  const r = await runPerformance({ sites: SITES, siteFilter: ["decideplan"], fetcher: okFetcher(), now: DAY(2), historyDir: dir, writeHistory: false });
  assert.deepEqual(r.sites.map((s) => s.site), ["decideplan"]);
  assert.equal(existsSync(join(dir, "decideplan.json")), false);
});

test("rapor JSON'u makine-okunur, anahtar/ortam degeri icermez; markdown UNKNOWN'u 0 yazmaz", async () => {
  const r = await runPerformance({ sites: [site("pamistanbul")], fetcher: okFetcher(fieldBody({ lcp: 2000 })), now: DAY(2), env: { [PSI_ENV]: "TOPSECRET" } });
  assert.ok(!JSON.stringify(r).includes("TOPSECRET"));
  assert.equal(JSON.parse(JSON.stringify(r)).schema, "sgos.performance-report.v1");
  const md = reportMarkdown(r);
  assert.match(md, /UNKNOWN/); assert.match(md, /INFERENCE/);
  assert.ok(!/\| 0 \|/.test(md.split("\n").filter((l) => l.startsWith("| https")).join("\n")));
  const nc = reportMarkdown(await runPerformance({ sites: [site("pamistanbul")], env: {}, now: DAY(2) }));
  assert.match(nc, /NOT_CONNECTED/);
});
