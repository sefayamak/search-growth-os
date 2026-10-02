// Performans katmani denetimi (sprint-lighthouse): PSI v5 sekli, CLS birimi, esik provenance, anahtar sizintisi,
// URL izolasyonu, butce, timeout. Ag YOK: fetcher/fetchImpl enjekte edilir. Canlı PSI yaniti ile dogrulanmadi
// (NOT_LIVE_VALIDATED) — fixture'lar belgelenmis sekle gore yazilmis sentetik govdelerdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, type SiteEntry } from "../src/registry.ts";
import {
  CWV_THRESHOLDS, THRESHOLDS, VALIDATION_STATUS, UNIT_ASSUMPTIONS, rate, assertThresholds, cruxClsFromPercentile, parsePsiResponse,
  planUrls, RequestBudget, detectRegressions, runPerformance, reportMarkdown, HISTORY_SCHEMA, HISTORY_MAX_RECORDS,
  type PerfRecord, type HistoryFile, type ThresholdConfig,
} from "../src/performance.ts";
import { createPsiFetcher, redactKey, PSI_ENV, PsiFetchError, type PsiFetcher } from "../src/performance-psi.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITES = loadRegistry(join(ROOT, "config/sites.yaml")).registry!.sites;
const site = (id: string): SiteEntry => SITES.find((s) => s.id === id)!;
const CTX = { site: "pamistanbul", url: "https://pamistanbul.com/", strategy: "mobile" as const, measuredAt: "2026-10-02T07:00:00.000Z" };
const DAY = (n: number) => new Date(Date.UTC(2026, 9, n, 7, 0, 0));
const parse = (b: unknown, status = 200, ctx: Parameters<typeof parsePsiResponse>[2] = CTX) => parsePsiResponse(status, b, ctx);
const crux = (metrics: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ loadingExperience: { metrics, ...extra } });

// --- (1) PSI v5 sekli ----------------------------------------------------------------------------------------

test("PSI sekli: percentile + category okunur; category bizim siniflamamizdan AYRI tutulur", () => {
  const r = parse(crux({
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3000, category: "AVERAGE" },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 30, category: "AVERAGE" },
    INTERACTION_TO_NEXT_PAINT: { percentile: 100, category: "BOGUS" },
  }));
  assert.deepEqual([r.lcp_ms, r.cls, r.inp_ms], [3000, 0.3, 100]);
  assert.deepEqual(r.field_category, { lcp_ms: "AVERAGE", cls: "AVERAGE" }); // gecersiz kategori yok sayilir
  assert.equal(r.ratings.values.cls, "POOR", "esik INFERENCE'i CrUX category'sinden bagimsiz");
});

test("PSI sekli: originLoadingExperience URL kaydina geri-dusus OLARAK okunmaz", () => {
  const r = parse({
    loadingExperience: { metrics: {} },
    originLoadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 9000, category: "SLOW" } } },
    lighthouseResult: { audits: { "largest-contentful-paint": { numericValue: 2000 } } },
  });
  assert.equal(r.source, "lab"); assert.equal(r.lcp_ms, 2000); assert.equal(r.field_scope, null);
});

test("PSI sekli: TTFB yeni/eski ad; yeniden adlandirilmis/bilinmeyen/ekstra alanlar tolere edilir, eksik 0 olmaz", () => {
  assert.equal(parse(crux({ TIME_TO_FIRST_BYTE: { percentile: 400 } })).ttfb_ms, 400);
  assert.equal(parse(crux({ EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 500 }, TIME_TO_FIRST_BYTE: { percentile: 400 } })).ttfb_ms, 500);
  const r = parse(crux({ FIRST_INPUT_DELAY_MS: { percentile: 50 }, NEW_UNKNOWN_METRIC: { percentile: 1 }, LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000, distributions: [], future: true } }, { overall_category: "FAST", extra: 1 }));
  assert.equal(r.lcp_ms, 2000); assert.equal(r.inp_ms, null, "FID INP yerine gecmez");
  // metrik nesnesi var ama percentile yok / yanlis tipte
  const bad = parse(crux({ LARGEST_CONTENTFUL_PAINT_MS: { category: "FAST" }, INTERACTION_TO_NEXT_PAINT: { percentile: null }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: {} } }));
  assert.equal(bad.state, "UNKNOWN"); assert.equal(bad.source, "none");
  assert.equal(parse({ loadingExperience: "x", lighthouseResult: [] }).state, "UNKNOWN");
  assert.equal(parse([], 200).error_code, "BAD_RESPONSE");
});

test("PSI sekli: lab INP denetimi varsa okunur, yoksa null; error/notApplicable denetimi sayi tasisa da yok sayilir", () => {
  const lab = (audits: Record<string, unknown>) => parse({ lighthouseResult: { audits, categories: { performance: { score: 0.5 } } } });
  assert.equal(lab({ "interaction-to-next-paint": { numericValue: 240 }, "largest-contentful-paint": { numericValue: 2000 } }).inp_ms, 240);
  assert.equal(lab({ "largest-contentful-paint": { numericValue: 2000 } }).inp_ms, null);
  const e = lab({ "largest-contentful-paint": { numericValue: 5000, scoreDisplayMode: "error" }, "cumulative-layout-shift": { scoreDisplayMode: "notApplicable", numericValue: 0 } });
  assert.equal(e.lcp_ms, null); assert.equal(e.cls, null); assert.equal(e.source, "lab"); assert.equal(e.perf_score, 50); // yalniz skor var
  assert.equal(e.ratings.confidence, "UNKNOWN");
});

test("PSI sekli: perf_score 0-1 -> 0-100; sinirlar, yuvarlama, null/dizge/NaN/zaten-100-olcekli", () => {
  const sc = (v: unknown) => parse({ lighthouseResult: { categories: { performance: { score: v } }, audits: { "largest-contentful-paint": { numericValue: 1000 } } } }).perf_score;
  assert.deepEqual([sc(0), sc(1), sc(0.9), sc(0.895), sc(0.004)], [0, 100, 90, 90, 0]);
  assert.deepEqual([sc(null), sc("0.9"), sc(Number.NaN), sc(91), sc(-0.1), sc(undefined)], [null, null, null, null, null, null]);
});

// --- (8) birimler -------------------------------------------------------------------------------------------

test("CrUX CLS birimi: tamsayi x100, ondalik/dizge birimsiz; acik kurallar (varsayim canli dogrulanmadi)", () => {
  assert.equal(cruxClsFromPercentile(5), 0.05);
  assert.equal(cruxClsFromPercentile("5"), 0.05);
  assert.equal(cruxClsFromPercentile("0.05"), 0.05);
  assert.equal(cruxClsFromPercentile(0.05), 0.05);
  assert.equal(cruxClsFromPercentile(0), 0);       // gercek sifir kayma olcumdur, null degil
  assert.equal(cruxClsFromPercentile("0"), 0);
  assert.equal(cruxClsFromPercentile(25), 0.25);
  assert.equal(cruxClsFromPercentile("0.25"), 0.25);
  for (const bad of ["", " ", "abc", "5%", null, undefined, -1, "-3", Number.NaN, Infinity, {}, []]) assert.equal(cruxClsFromPercentile(bad), null, String(bad));
  // uctan uca: iki yuk bicimi ayni sinifi verir (yanlis x100 yorumu 0.05'i 5 -> POOR yapardi)
  const a = parse(crux({ CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 } }));
  const b = parse(crux({ CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: "0.05" } }));
  assert.equal(a.cls, b.cls); assert.equal(a.ratings.values.cls, "GOOD"); assert.equal(b.ratings.values.cls, "GOOD");
});

test("birimler: LCP/INP/TTFB ms dizge de kabul, bozuk dizge null; lab CLS birimsiz oldugu gibi; varsayimlar isaretli", () => {
  const r = parse(crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: "2500" }, INTERACTION_TO_NEXT_PAINT: { percentile: "" }, EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: "12ms" } }));
  assert.equal(r.lcp_ms, 2500); assert.equal(r.inp_ms, null); assert.equal(r.ttfb_ms, null);
  assert.equal(parse({ lighthouseResult: { audits: { "cumulative-layout-shift": { numericValue: 0.05 }, "largest-contentful-paint": { numericValue: 1800.4 } } } }).cls, 0.05);
  assert.match(UNIT_ASSUMPTIONS.cls, /VARSAYIM/);
  assert.equal(VALIDATION_STATUS.crux_cls_percentile_unit, "NOT_LIVE_VALIDATED");
});

// --- (9) esik provenance ------------------------------------------------------------------------------------

test("esikler: CWV_THRESHOLDS provenance erisimi iddia ETMEZ; THRESHOLDS ayni sayilar", () => {
  assert.deepEqual(CWV_THRESHOLDS.provenance, { source: "web.dev/vitals", accessed: "NOT_RETRIEVED_THIS_SESSION", status: "DOCUMENTED_ASSUMPTION" });
  assert.equal(THRESHOLDS, CWV_THRESHOLDS.metrics);
});

test("esikler: her ratings ciktisi provenance'a referans verir; INFERENCE/CANDIDATE kalir (hata kaydinda da)", () => {
  const r = parse(crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000 } }));
  assert.deepEqual(r.ratings.thresholds_ref, CWV_THRESHOLDS.provenance);
  assert.equal(r.ratings.label, "INFERENCE"); assert.equal(r.ratings.confidence, "CANDIDATE");
  const e = parse({}, 500); assert.deepEqual(e.ratings.thresholds_ref, CWV_THRESHOLDS.provenance); assert.equal(e.ratings.confidence, "UNKNOWN");
});

const STRICT: ThresholdConfig = { provenance: { source: "test-override", accessed: "2026-10-02", status: "VERIFIED_AGAINST_SOURCE" }, metrics: { lcp_ms: { good: 1000, poor: 2000 }, inp_ms: { good: 100, poor: 300 }, cls: { good: 0.05, poor: 0.1 }, ttfb_ms: { good: 400, poor: 900 } } };

test("esikler: parametreyle degistirilebilir; sonuc ve referans override'i izler, varsayilan kirlenmez", () => {
  assert.equal(rate("lcp_ms", 2000), "GOOD"); assert.equal(rate("lcp_ms", 2000, STRICT), "NEEDS_IMPROVEMENT");
  const r = parse(crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2500 } }), 200, { ...CTX, thresholds: STRICT });
  assert.equal(r.ratings.values.lcp_ms, "POOR"); assert.equal(r.ratings.thresholds_ref.source, "test-override");
  assert.equal(r.ratings.confidence, "CANDIDATE", "override olculen degeri FACT yapmaz, siniflama INFERENCE kalir");
  assert.equal(CWV_THRESHOLDS.metrics.lcp_ms.good, 2500);
});

test("esikler: gecersiz override fail-closed (NaN, good>=poor, provenance yok)", () => {
  assert.throws(() => assertThresholds({ ...STRICT, metrics: { ...STRICT.metrics, lcp_ms: { good: Number.NaN, poor: 2 } } }));
  assert.throws(() => assertThresholds({ ...STRICT, metrics: { ...STRICT.metrics, cls: { good: 0.3, poor: 0.1 } } }));
  assert.throws(() => assertThresholds({ ...STRICT, provenance: { source: "", accessed: "", status: "DOCUMENTED_ASSUMPTION" } }));
  assert.equal(assertThresholds(CWV_THRESHOLDS), CWV_THRESHOLDS);
});

test("esikler: runPerformance override'i kayda, rapora ve regresyon siniflamasina tasir; rapor validation_status tasir", async () => {
  const f: PsiFetcher = async () => ({ status: 200, body: crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2500 } }) });
  const r = await runPerformance({ sites: [site("pamistanbul")], fetcher: f, now: DAY(2), thresholds: STRICT });
  assert.equal(r.sites[0].records[0].ratings.values.lcp_ms, "POOR");
  assert.equal(r.thresholds_ref.source, "test-override");
  const d = await runPerformance({ sites: [site("pamistanbul")], fetcher: f, now: DAY(2) });
  assert.equal(d.thresholds_ref.status, "DOCUMENTED_ASSUMPTION"); assert.equal(d.validation_status.psi_response_shape, "NOT_LIVE_VALIDATED");
  assert.equal(d.validation_status.psi_quota_behaviour, "NOT_LIVE_VALIDATED"); assert.equal(d.validation_status.crux_availability_7_sites, "NOT_LIVE_VALIDATED");
  const md = reportMarkdown(d);
  assert.match(md, /NOT_RETRIEVED_THIS_SESSION/); assert.match(md, /DOCUMENTED_ASSUMPTION/); assert.match(md, /NOT_LIVE_VALIDATED/);
  await assert.rejects(() => runPerformance({ sites: [site("pamistanbul")], fetcher: f, now: DAY(2), thresholds: { ...STRICT, metrics: { ...STRICT.metrics, inp_ms: { good: 5, poor: 1 } } } }));
});

test("regresyon: perf_score adayi HER ZAMAN lab etiketli (kayit field olsa da); esik override regresyonu etkiler", () => {
  const mk = (date: string, lcp: number, score: number): PerfRecord => ({ ...parse(crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: lcp } }), 200, { ...CTX, measuredAt: `${date}T07:00:00.000Z` }), perf_score: score });
  const h: HistoryFile = { schema: HISTORY_SCHEMA, site: "pamistanbul", max_records: HISTORY_MAX_RECORDS, records: [mk("2026-10-01", 2000, 90)] };
  const out = detectRegressions(mk("2026-10-02", 2000, 70), h, true);
  const g = out.find((x) => x.metric === "perf_score")!;
  assert.equal(g.source, "lab"); assert.equal(g.causal_claim, "NONE");
  // STRICT'te 2000 -> 2300 GOOD->NI/POOR sinir degisimi; varsayilanda GOOD->GOOD alarm degil
  assert.equal(detectRegressions(mk("2026-10-02", 2300, 90), h, true).length, 0);
  assert.equal(detectRegressions(mk("2026-10-02", 2300, 90), h, true, STRICT).filter((x) => x.metric === "lcp_ms").length, 1);
});

// --- (2) field/lab, origin ----------------------------------------------------------------------------------

test("origin_fallback kaydi URL duzeyi baza karsi regresyon hesaplamaz (ve tersi)", () => {
  const mk = (date: string, lcp: number, origin: boolean): PerfRecord => parse(crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: lcp } }, { origin_fallback: origin }), 200, { ...CTX, measuredAt: `${date}T07:00:00.000Z` });
  const urlBase: HistoryFile = { schema: HISTORY_SCHEMA, site: "pamistanbul", max_records: HISTORY_MAX_RECORDS, records: [mk("2026-10-01", 1500, false)] };
  assert.equal(detectRegressions(mk("2026-10-02", 6000, true), urlBase, true).length, 0);
  const originBase: HistoryFile = { ...urlBase, records: [mk("2026-10-01", 1500, true)] };
  assert.equal(detectRegressions(mk("2026-10-02", 6000, false), originBase, true).length, 0);
  assert.equal(detectRegressions(mk("2026-10-02", 6000, true), originBase, true).length, 1, "ayni kapsam kiyaslanir");
});

// --- (4) butce ----------------------------------------------------------------------------------------------

test("butce: NaN/Infinity/sayi-disi limit SINIRSIZ degil, 0 (fail-closed)", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, "5" as unknown as number, undefined as unknown as number]) assert.equal(new RequestBudget(bad).tryTake(), false, String(bad));
  assert.equal(new RequestBudget(2.9).limit, 2);
});

test("butce: her strateji ayri birim; hata/timeout da kota tuketir; ALREADY_MEASURED_TODAY butce harcamaz", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perfa-")); const calls: string[] = [];
  const f: PsiFetcher = async (q) => { calls.push(q.strategy); return { status: 200, body: crux({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000 } }) }; };
  const o = { sites: [site("pamistanbul")], urlsBySite: { pamistanbul: ["https://pamistanbul.com/", "https://pamistanbul.com/b"] }, strategies: ["mobile", "desktop"] as ("mobile" | "desktop")[], fetcher: f, historyDir: dir };
  const r1 = await runPerformance({ ...o, now: DAY(2), maxRequests: 3 });
  assert.equal(r1.budget.used, 3); assert.equal(calls.length, 3);
  assert.deepEqual(r1.sites[0].skipped.map((x) => x.reason), ["BUDGET_EXHAUSTED"]);
  const r2 = await runPerformance({ ...o, now: DAY(2), maxRequests: 10 }); // ayni gun: 3 olcum zaten var, yalniz 1 istek
  assert.equal(r2.budget.used, 1); assert.equal(r2.sites[0].skipped.filter((x) => x.reason === "ALREADY_MEASURED_TODAY").length, 3);
  const bad: PsiFetcher = async () => { throw new PsiFetchError("TIMEOUT", "x"); };
  const r3 = await runPerformance({ ...o, fetcher: bad, now: DAY(3), maxRequests: 10 });
  assert.equal(r3.budget.used, 4, "basarisiz istek de butceden duser"); assert.ok(r3.sites[0].records.every((x) => x.error_code === "FETCH_TIMEOUT"));
});

// --- (5) retry + timeout ------------------------------------------------------------------------------------

test("retry yok: 5xx ve ag hatasinda TEK istek; timeout FETCH_TIMEOUT kodu alir (fetchImpl sinyale uyar)", async () => {
  let n = 0;
  const f5 = createPsiFetcher({ [PSI_ENV]: "K" }, (async () => { n++; return new Response("{}", { status: 503 }); }) as unknown as typeof fetch)!;
  assert.equal((await f5({ url: "https://pamistanbul.com/", strategy: "mobile" })).status, 503); assert.equal(n, 1);
  const hang = ((_u: string, init: { signal: AbortSignal }) => { n++; return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))); }) as unknown as typeof fetch;
  const ft = createPsiFetcher({ [PSI_ENV]: "K" }, hang, 20)!;
  const keep = setInterval(() => {}, 10); // AbortSignal.timeout zamanlayicisi unref'tir; sahte fetch soket tutmaz, dongu canli kalmali
  const r = await runPerformance({ sites: [site("pamistanbul")], fetcher: ft, now: DAY(2) }).finally(() => clearInterval(keep));
  assert.equal(n, 2); assert.equal(r.sites[0].records[0].error_code, "FETCH_TIMEOUT"); assert.equal(r.sites[0].records[0].state, "ERROR");
  const net = createPsiFetcher({ [PSI_ENV]: "K" }, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)!;
  assert.equal((await runPerformance({ sites: [site("pamistanbul")], fetcher: net, now: DAY(2) })).sites[0].records[0].error_code, "FETCH_FAILED");
});

// --- (6) anahtar --------------------------------------------------------------------------------------------

test("anahtar yok: NOT_CONNECTED, fetchImpl HIC cagrilmaz", async () => {
  let n = 0; const spy = (async () => { n++; return new Response("{}"); }) as unknown as typeof fetch;
  assert.equal(createPsiFetcher({}, spy), null);
  const r = await runPerformance({ sites: [site("pamistanbul")], env: {}, now: DAY(2) });
  assert.equal(r.sites[0].action, "NOT_CONNECTED"); assert.equal(r.budget.used, 0); assert.equal(n, 0);
  assert.ok(r.sites[0].records.every((x) => x.state === "NOT_CONNECTED" && x.lcp_ms === null));
});

test("anahtar sizintisi: hata metni anahtari ham/%-kodlu/+/key= bicimlerinde tasisa da rapor, kayit, markdown, hata temiz", async () => {
  const KEYS = ["AIza-SECRET-KEY-123", "AIza SECRET!'()*&=+/key 9", "  padded-KEY-777  "];
  for (const KEY of KEYS) {
    const k = KEY.trim();
    const enc = encodeURIComponent(k); const qsForm = new URLSearchParams({ k }).toString().slice(2);
    const text = `request failed: https://www.googleapis.com/x?url=a&key=${qsForm}&q=1 raw=${k} enc=${enc} pct=${qsForm}`;
    const failing = (async (_u: string) => { throw new Error(text); }) as unknown as typeof fetch;
    const f = createPsiFetcher({ [PSI_ENV]: KEY }, failing)!;
    let caught: Error | null = null;
    try { await f({ url: "https://pamistanbul.com/", strategy: "mobile" }); } catch (e) { caught = e as Error; }
    assert.ok(caught instanceof PsiFetchError); assert.equal(caught.code, "NETWORK");
    for (const form of [k, enc, qsForm]) assert.ok(!caught.message.includes(form) && !String(caught.stack).includes(`key=${form}`), `hata metni sizdirdi: ${form}`);
    assert.match(caught.message, /REDACTED/);
    // tum koşu: hata mesaji hicbir yerde tasinmaz
    const r = await runPerformance({ sites: [site("pamistanbul")], fetcher: f, now: DAY(2) });
    const dump = JSON.stringify(r) + reportMarkdown(r);
    for (const form of [k, enc, qsForm]) assert.ok(!dump.includes(form), `rapor sizdirdi: ${form}`);
    assert.equal(r.sites[0].records[0].error_code, "FETCH_FAILED");
    // fetcher istegi anahtar tasimaz
    let seenReq = ""; const spy: PsiFetcher = async (q) => { seenReq = JSON.stringify(q); return { status: 200, body: {} }; };
    await runPerformance({ sites: [site("pamistanbul")], fetcher: spy, now: DAY(2) });
    assert.ok(!seenReq.includes(k));
  }
  assert.equal(redactKey("a?key=ZZZ&b=1", "other"), "a?key=[REDACTED]&b=1");
});

test("anahtar sizintisi: saglayici error.message govdesi (anahtar yansitir) kayda girmez", () => {
  const r = parse({ error: { code: 400, message: "API key not valid. key=AIza-SECRET" } }, 400);
  assert.equal(r.error_code, "PSI_400"); assert.ok(!JSON.stringify(r).includes("AIza-SECRET"));
});

// --- (7) URL izolasyonu -------------------------------------------------------------------------------------

test("URL izolasyonu: lookalike / @ / port / IDN / kimlik bilgisi / sema / uzunluk hileleri her sitede reddedilir", () => {
  for (const s of SITES) {
    const own = s.canonical_hostname; const other = SITES.find((x) => x.id !== s.id)!.canonical_hostname;
    const tricks = [
      `https://${own}.evil.com/`, `https://evil.com/${own}`, `https://evil.com/?u=${own}`, `https://evil-${own}/`, `https://x${own}/`,
      `https://${own}@evil.com/`, `https://evil.com\\@${own}/`, `https://evil.com#@${own}/`, `https://${other}/`,
      `https://${own}:8443/`, `https://user:pw@${own}/`, `https://${own}@${own}/`,
      `https://${own.replace(/[aeo]/, (c) => ({ a: "а", e: "е", o: "о" })[c]!)}/`, // Kiril a/e/o homograf -> xn-- (her host'ta en az bir ünlü var)
      `ftp://${own}/`, `javascript:alert(1)//${own}`, `//${own}/`, `${own}/path`, "", `https://${own}/${"a".repeat(2100)}`,
    ].filter((t) => t !== `https://${own}.evil.com/` || true);
    const p = planUrls(s, tricks);
    // Tek istisna: `https://${own}@${own}/` kimlik bilgisi tasir -> reddedilir; `https://evil.com#@own/` host evil.com -> reddedilir.
    assert.deepEqual(p.urls, [], `${s.id} kabul etti: ${p.urls.join(", ")}`);
    assert.equal(p.rejected.length, tricks.length, s.id);
  }
});

test("URL izolasyonu: kabul edilenler normallestirilir (fragment atilir, buyuk/kucuk host, www, varsayilan port)", () => {
  const s = site("pamistanbul");
  const p = planUrls(s, ["HTTPS://PamIstanbul.COM/Yol#frag", "https://www.pamistanbul.com:443/x", "http://pamistanbul.com/y?a=1", "https://pamistanbul.com", "https://pamistanbul.com/#z"]);
  assert.deepEqual(p.urls, ["https://pamistanbul.com/Yol", "https://www.pamistanbul.com/x", "http://pamistanbul.com/y?a=1", "https://pamistanbul.com/"]);
  assert.equal(p.rejected.length, 0);
  // rightlisted: canonical www, production apex; ikisi de kendi sitesi, baska sitenin apex'i degil
  const r = planUrls(site("rightlisted"), ["https://rightlisted.com/a", "https://www.rightlisted.com/b", "https://rightlisted.com.evil.com/"]);
  assert.equal(r.urls.length, 2); assert.equal(r.rejected.length, 1);
});

test("URL izolasyonu: reddedilen URL icin PSI istegi YOK; reddedilen URL kaydi uzun diziyi kisaltir", async () => {
  const calls: string[] = []; const f: PsiFetcher = async (q) => { calls.push(q.url); return { status: 200, body: {} }; };
  const long = `https://pamistanbul.com/${"a".repeat(3000)}`;
  const r = await runPerformance({ sites: [site("pamistanbul"), site("spryhand")], urlsBySite: { pamistanbul: ["https://spryhand.com/", "https://pamistanbul.com@evil.com/", long], spryhand: ["https://spryhand.com/"] }, fetcher: f, now: DAY(2) });
  assert.deepEqual(calls, ["https://spryhand.com/"]);
  assert.equal(r.sites[0].rejected_urls.length, 3); assert.ok(r.sites[0].rejected_urls.every((x) => x.url.length <= 200));
  assert.equal(r.sites[0].records.length, 0);
});
