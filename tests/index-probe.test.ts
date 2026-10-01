// inspect-index: pamistanbul'a kilitli, salt-okunur, kota korumali ORNEKLEM.
// Buradaki testlerin cogu NE YAPILMAMASI gerektigi hakkinda: 403/429'u "indekslenmemis"
// diye okumak, baska bir siteyi sorgulamak, kota bitince devam etmek, Indexing API'ye
// yazmak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PROBE_SITE_ID, DEFAULT_LIMIT, HARD_LIMIT, MAX_CONSECUTIVE_ERRORS, assertProbeSite, hostAllowed, resolveLimit, classifyInspection,
  classifyError, runProbe, summarizeSitemaps, usedOn, recordUsage, probeToMarkdown,
} from "../src/index-probe.ts";
import { googleJson } from "../src/adapters/google-auth.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = { id: "pamistanbul", production_domain: "pamistanbul.com" };
const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://pamistanbul.com/sayfa-${i}`);
const PASS = { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: "https://pamistanbul.com/x" } };

function opts(over: Partial<Parameters<typeof runProbe>[0]> = {}) {
  const calls: string[] = [];
  const o = { site: SITE, urls: urls(5), candidateSource: "test", limit: 10, delayMs: 0, connected: true, sleep: async () => {}, inspect: async (u: string) => { calls.push(u); return PASS; }, ...over };
  return { o, calls };
}

// --- kilit: yalniz pamistanbul, yalniz kendi host'lari --------------------------

test("yalnizca pamistanbul: baska site kimligi reddedilir", () => {
  assert.doesNotThrow(() => assertProbeSite(PROBE_SITE_ID));
  for (const id of ["spryhand", "pamaistudio", "decideplan", "", "PAMISTANBUL"]) assert.throws(() => assertProbeSite(id), /yalnizca 'pamistanbul'/);
});

test("runProbe baska site icin tek bir cagri yapmadan reddeder", async () => {
  const { o, calls } = opts({ site: { id: "spryhand", production_domain: "spryhand.com" } });
  await assert.rejects(runProbe(o), /yalnizca/);
  assert.equal(calls.length, 0);
});

test("cli: --site spryhand cikis kodu 1 ve hicbir cagri/yazma yok", () => {
  const r = spawnSync("node", ["--experimental-strip-types", join(ROOT, "src/cli.ts"), "inspect-index", join(ROOT, "config/sites.yaml"), "--site", "spryhand"], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "ip-")) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /yalnizca 'pamistanbul'/);
});

test("hostAllowed: apex ve www kabul; taklitci/baska host ret", () => {
  assert.ok(hostAllowed("https://pamistanbul.com/a", "pamistanbul.com"));
  assert.ok(hostAllowed("http://www.pamistanbul.com/", "pamistanbul.com"));
  for (const bad of ["https://pamistanbul.com.evil.com/", "https://notpamistanbul.com/", "https://spryhand.com/", "https://blog.pamistanbul.com/", "ftp://pamistanbul.com/", "nonsense"]) {
    assert.equal(hostAllowed(bad, "pamistanbul.com"), false, bad);
  }
});

test("baska hosttaki URL aday listesinden atilir ve API'ye gitmez", async () => {
  const { o, calls } = opts({ urls: ["https://pamistanbul.com/a", "https://spryhand.com/a", "https://pamistanbul.com/a#x"] });
  const r = await runProbe(o);
  assert.deepEqual(calls, ["https://pamistanbul.com/a"], "spryhand URL'si ve tekrar sorgulanmadi");
  assert.equal(r.skipped.length, 2);
});

// --- kimlik yok -> sifir cagri -------------------------------------------------

test("kimlik yoksa NOT_CONNECTED ve sifir cagri", async () => {
  const { o, calls } = opts({ connected: false });
  const r = await runProbe(o);
  assert.equal(r.stopped, "not_connected");
  assert.equal(calls.length, 0);
  assert.equal(r.results.length, 0);
});

test("cli: kimlik yokken NOT_CONNECTED yazar, cikis 0, dosya yazmaz", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ip-"));
  const f = join(cwd, "urls.txt"); writeFileSync(f, "https://pamistanbul.com/\n");
  const env = { ...process.env }; delete env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON;
  const out = execFileSync("node", ["--experimental-strip-types", join(ROOT, "src/cli.ts"), "inspect-index", join(ROOT, "config/sites.yaml"), "--urls", f], { cwd, env, encoding: "utf8" });
  assert.match(out, /NOT_CONNECTED/);
  assert.match(out, /TAM COVERAGE DEĞİL/);
  assert.deepEqual(readdirSync(cwd), ["urls.txt"]);
});

// --- kota / limit ----------------------------------------------------------------

test("varsayilan limit dusuk; sert tavan asilamaz; bugunku kullanim dusulur", () => {
  assert.equal(DEFAULT_LIMIT, 20);
  assert.ok(DEFAULT_LIMIT <= 20 && HARD_LIMIT <= 100, "Google'in 2000/gun kotasinin cok altinda");
  assert.equal(resolveLimit(undefined).limit, DEFAULT_LIMIT);
  assert.equal(resolveLimit(NaN).limit, DEFAULT_LIMIT);
  assert.equal(resolveLimit(-5).limit, DEFAULT_LIMIT);
  assert.deepEqual(resolveLimit(5000), { limit: HARD_LIMIT, clampedFrom: 5000 });
  assert.equal(resolveLimit(50, HARD_LIMIT - 10).limit, 10);
  assert.equal(resolveLimit(50, HARD_LIMIT).limit, 0);
  assert.equal(resolveLimit(5).limit, 5);
});

test("limit asilmaz: 5 aday, limit 2 -> tam 2 cagri, limit_reached", async () => {
  const { o, calls } = opts({ limit: 2 });
  const r = await runProbe(o);
  assert.equal(calls.length, 2);
  assert.equal(r.stopped, "limit_reached");
  assert.equal(r.candidates, 5);
});

test("limit 0 (gunluk tavan dolu) -> sifir cagri", async () => {
  const { o, calls } = opts({ limit: 0 });
  await runProbe(o);
  assert.equal(calls.length, 0);
});

test("cagrilar arasi gecikme uygulanir (rate limit korumasi)", async () => {
  const slept: number[] = [];
  const { o } = opts({ limit: 3, delayMs: 1500, sleep: async (ms: number) => { slept.push(ms); } });
  await runProbe(o);
  assert.deepEqual(slept, [1500, 1500], "ilk cagridan once beklenmez, sonrakilerden once beklenir");
});

test("kota defteri: kullanim birikir, baska gune tasmaz", () => {
  let l = recordUsage({}, "2026-10-01", 7);
  l = recordUsage(l, "2026-10-01", 3);
  assert.equal(usedOn(l, "2026-10-01"), 10);
  assert.equal(usedOn(l, "2026-10-02"), 0);
});

// --- 403 / 429 = ERROR, asla "indekslenmemis" -----------------------------------

for (const code of [403, 429]) {
  test(`HTTP ${code} -> ERROR, kosu DURUR, 'NOT_INDEXED' denmez`, async () => {
    let n = 0;
    const { o } = opts({ inspect: async () => { n++; throw new Error(`HTTP ${code} https://searchconsole.googleapis.com/v1/urlInspection/index:inspect — quota`); } });
    const r = await runProbe(o);
    assert.equal(n, 1, "ilk fatal hatadan sonra tek cagri daha yapilmaz");
    assert.equal(r.stopped, code === 429 ? "rate_limited_429" : "forbidden_403");
    assert.equal(r.results.length, 1);
    const s = r.results[0].summary;
    assert.equal(s.state, "ERROR");
    assert.notEqual(s.index_verdict, "NOT_INDEXED");
    assert.equal(s.index_verdict, "UNKNOWN");
    assert.match(s.error!, new RegExp(`HTTP ${code}`));
    assert.match(probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01"), /erken durdu/);
  });
}

test("fatal olmayan hatalar: ardisik 3'te durur; arada basari sayaci sifirlar", async () => {
  let n = 0;
  const { o: stopO } = opts({ urls: urls(10), inspect: async () => { n++; throw new Error("HTTP 500 x"); } });
  const stopped = await runProbe(stopO);
  assert.equal(n, MAX_CONSECUTIVE_ERRORS);
  assert.equal(stopped.stopped, "consecutive_errors");

  const seq = ["err", "err", "ok", "err", "err", "ok"]; let i = 0;
  const { o: okO } = opts({ urls: urls(6), inspect: async () => { if (seq[i++] === "err") throw new Error("HTTP 500 x"); return PASS; } });
  const r = await runProbe(okO);
  assert.equal(r.stopped, null);
  assert.equal(r.results.length, 6);
});

test("classifyError: kod yoksa da ERROR; mesaj kisaltilir", () => {
  const { summary, fatal, code } = classifyError(new Error("fetch failed"));
  assert.equal(summary.state, "ERROR"); assert.equal(fatal, false); assert.equal(code, null);
  assert.ok(classifyError(new Error("HTTP 400 " + "x".repeat(1000))).summary.error!.length < 200);
});

test("urlInspection tekrar DENEMEZ: 429'da tek fetch (kota yanmaz)", async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("quota", { status: 429 }); }) as typeof fetch;
  try {
    await assert.rejects(googleJson("https://x.test/v1/urlInspection/index:inspect", "t", { method: "POST", body: {} }, 0, 0), /HTTP 429/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});

// --- eksik alan = UNKNOWN ---------------------------------------------------------

test("eksik API alani = UNKNOWN (bos indexStatusResult)", () => {
  const s = classifyInspection({ indexStatusResult: {} });
  assert.equal(s.state, "INSPECTED");
  assert.equal(s.index_verdict, "UNKNOWN");
  assert.equal(s.confidence, "UNKNOWN");
  for (const k of ["coverage_state", "indexing_state", "page_fetch_state", "robots_txt_state", "google_canonical", "user_canonical", "last_crawl_time"] as const) assert.equal(s[k], "UNKNOWN", k);
});

test("indexStatusResult hic yoksa hicbir sey cikarilmaz; VERDICT_UNSPECIFIED de UNKNOWN", () => {
  assert.equal(classifyInspection({ inspectionResultLink: "x" }).state, "UNKNOWN");
  assert.equal(classifyInspection(null).index_verdict, "UNKNOWN");
  assert.equal(classifyInspection({ indexStatusResult: { verdict: "VERDICT_UNSPECIFIED" } }).index_verdict, "UNKNOWN");
});

test("Google'in kendi karari tasinir: PASS->INDEXED, FAIL->NOT_INDEXED, NEUTRAL ham kalir", () => {
  assert.equal(classifyInspection(PASS).index_verdict, "INDEXED");
  assert.equal(classifyInspection(PASS).confidence, "CONFIRMED");
  const fail = classifyInspection({ indexStatusResult: { verdict: "FAIL", coverageState: "Crawled - currently not indexed" } });
  assert.equal(fail.index_verdict, "NOT_INDEXED");
  assert.equal(fail.coverage_state, "Crawled - currently not indexed");
  assert.equal(classifyInspection({ indexStatusResult: { verdict: "NEUTRAL" } }).index_verdict, "NEUTRAL");
});

test("kosu ortasinda null (kimlik dustu) -> not_connected, uydurma sonuc yok", async () => {
  const { o } = opts({ inspect: async () => null });
  const r = await runProbe(o);
  assert.equal(r.stopped, "not_connected");
  assert.equal(r.results.length, 0);
  assert.equal(r.attempted, 0);
});

// --- raporda SAMPLE / TAM COVERAGE DEGIL ------------------------------------------

test("rapor ve JSON her zaman SAMPLE / TAM COVERAGE DEGIL der ve secim yanliligini soyler", async () => {
  const { o } = opts();
  const r = await runProbe(o);
  assert.equal(r.mode, "SAMPLE");
  assert.match(r.coverage_notice, /ÖRNEKLEM \(SAMPLE\) — TAM COVERAGE DEĞİL/);
  assert.match(r.coverage_notice, /TEMSİL EDİLMEZ/);
  const md = probeToMarkdown(r, summarizeSitemaps(null), "2026-10-01");
  assert.match(md, /TAM COVERAGE DEĞİL/);
  assert.match(md, /Indexing API yok/);
  const empty = await runProbe(opts({ connected: false }).o);
  assert.match(empty.coverage_notice, /TAM COVERAGE DEĞİL/, "hic cagri yapilmasa da");
});

// --- sitemap entegrasyonu ---------------------------------------------------------

test("sitemaps: null=NOT_CONNECTED, []=bos olculmus liste, eksik alan UNKNOWN (0 degil)", () => {
  assert.equal(summarizeSitemaps(null).state, "NOT_CONNECTED");
  assert.deepEqual(summarizeSitemaps([]), { state: "MEASURED", items: [] });
  const [x] = summarizeSitemaps([{ path: "https://pamistanbul.com/sitemap.xml" }]).items;
  assert.equal(x.path, "https://pamistanbul.com/sitemap.xml");
  assert.equal(x.errors, "UNKNOWN");
  assert.equal(x.warnings, "UNKNOWN");
  assert.equal(x.last_downloaded, "UNKNOWN");
  assert.equal(x.is_pending, "UNKNOWN");
});

// --- Indexing API publish ucu HICBIR kod yolunda yok ------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === ".git") continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test("Indexing API'nin yazma ucu kod, hook ve workflow'larda YOK (compliance dedektoru haric)", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "hooks")), ...walk(join(ROOT, ".github"))];
  const offenders = files.filter((f) => /indexing\.googleapis\.com|urlNotifications|\/v3\/urlNotifications|:publish\b/i.test(readFileSync(f, "utf8")));
  // src/compliance.ts bu desenleri REDDETMEK icin regex olarak tasir; yazma yapmaz.
  assert.deepEqual(offenders.map((f) => relative(ROOT, f)), ["src/compliance.ts"]);
  const gsc = readFileSync(join(ROOT, "src/adapters/gsc.ts"), "utf8");
  assert.match(gsc, /urlInspection\/index:inspect/);
  assert.ok(!/method:\s*"(PUT|DELETE|PATCH)"/.test(gsc), "GSC adapter'inda yazma metodu yok");
});

test("gsc.urlInspection GERCEK yolu: 429'da tek istek atar (retries=0), token istegi haric", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { urlInspection } = await import("../src/adapters/gsc.ts");
  const { _resetTokenCache } = await import("../src/adapters/google-auth.ts");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const old = process.env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON; const realFetch = globalThis.fetch;
  process.env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON = JSON.stringify({ client_email: "b@p.iam.gserviceaccount.com", private_key: pem });
  _resetTokenCache();
  const hits: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u); hits.push(url);
    if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    return new Response("quota", { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(urlInspection("sc-domain:pamistanbul.com", "https://pamistanbul.com/"), /HTTP 429/);
    assert.equal(hits.filter((h) => h.includes("urlInspection")).length, 1, "429 yeniden denenmez");
    assert.ok(hits.every((h) => !/urlNotifications|indexing\.googleapis/.test(h)));
  } finally {
    globalThis.fetch = realFetch; _resetTokenCache();
    if (old === undefined) delete process.env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON; else process.env.SEARCH_GROWTH_GSC_CREDENTIALS_JSON = old;
  }
});
