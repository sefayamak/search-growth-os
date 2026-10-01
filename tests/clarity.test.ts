// Native Clarity adapter. Testlerin cogu NE YAPILMAMASI gerektigi hakkinda: hatayi sifir saymak,
// 429'u yeniden denemek, baska sitenin token'ini kullanmak, token'i bir yere yazmak, eski
// site-health-monitor'a baglanmak. Ag YOK: fetch enjekte edilir; CLI testleri yalnizca cevrimdisi yollari kullanir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLARITY_ENV, CLARITY_ENDPOINT, PROFILE, PROFILE_REQUESTS_PER_SITE, MAX_HTTP_ATTEMPTS_PER_SITE, OFFICIAL_DAILY_LIMIT_PER_PROJECT,
  RESPONSE_ROW_LIMIT, buildUrl, validateProfile, parseClarityTokens, redact, sanitizeUrl, measureSite, measureSites, assertResultSite,
  summaryLine, resultsToMarkdown, clarityStatus, type FetchFn, type ProfileRequest,
} from "../src/adapters/clarity.ts";
import { allStatuses } from "../src/adapters/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const TOKEN = "TOK-pamistanbul-SECRET-1234567890";
const NOW = () => new Date("2026-10-01T09:00:00Z");

interface Call { url: string; auth: string | undefined }
type Reply = { status: number; body?: unknown } | Error;

/** Sirayla yanit veren sahte fetch. Fonksiyon verilirse her cagri icin hesaplanir. */
function fake(replies: Reply[] | ((n: number, call: Call) => Reply)): { fetchFn: FetchFn; calls: Call[]; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const calls: Call[] = []; const sleeps: number[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const call = { url, auth: init.headers.Authorization };
    calls.push(call);
    const r = typeof replies === "function" ? replies(calls.length, call) : (replies[calls.length - 1] ?? replies[replies.length - 1]);
    if (r instanceof Error) throw r;
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? []);
    return { status: r.status, text: async () => text };
  };
  return { fetchFn, calls, sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}
const run = (f: ReturnType<typeof fake>, token: string | undefined = TOKEN, site = "pamistanbul") => measureSite(site, token, { fetchFn: f.fetchFn, sleep: f.sleep, now: NOW });

const TRAFFIC = [{ metricName: "Traffic", information: [{ Device: "Desktop", totalSessionCount: 12, totalBotSessionCount: 3 }] }];
const rowsOf = (n: number) => [{ metricName: "Popular Pages", information: Array.from({ length: n }, (_, i) => ({ Url: `https://pamistanbul.com/p-${i}`, visitsCount: 1 })) }];

// --- durumlar -----------------------------------------------------------------------------

test("1) token yok -> NOT_CONNECTED, hicbir cagri yok, sayi yok", async () => {
  const f = fake([{ status: 200, body: TRAFFIC }]);
  const r = await run(f, "");
  assert.equal(r.measurement_state, "NOT_CONNECTED");
  assert.equal(f.calls.length, 0);
  assert.equal(r.row_count, "UNKNOWN");
  assert.equal(r.is_zero, false);
  assert.deepEqual(r.requests, []);
});

test("2) 200 + veri -> MEASURED, normalize metrik, CONFIRMED", async () => {
  const f = fake([{ status: 200, body: TRAFFIC }]);
  const r = await run(f);
  assert.equal(r.measurement_state, "MEASURED");
  assert.equal(r.confidence, "CONFIRMED");
  assert.equal(r.requests.length, 3);
  assert.ok(r.requests.every((q) => q.state === "MEASURED" && q.http_status === 200));
  assert.equal(r.row_count, 3);
  assert.equal(r.is_zero, false);
  assert.equal(r.metrics[0].metric_key, "traffic");
  assert.equal(r.rows_complete, true);
  assert.equal(summaryLine(r), "OK pamistanbul — 3/3 request, MEASURED");
});

test("3) 200 + GERCEK sifir -> MEASURED, row_count 0, is_zero (olculdu, sifir)", async () => {
  for (const body of [[], [{ metricName: "Traffic", information: [] }]]) {
    const r = await run(fake([{ status: 200, body }]));
    assert.equal(r.measurement_state, "MEASURED");
    assert.equal(r.row_count, 0);
    assert.equal(r.is_zero, true);
    assert.equal(r.rows_complete, true);
    assert.match(summaryLine(r), /olculdu, sifir/);
  }
});

for (const [status, code] of [[401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [400, "INVALID_REQUEST"]] as const) {
  test(`${status}) -> ERROR ${code}${status === 400 ? " (yalniz o istek; digerleri devam)" : ", kalan istekler ATLANIR"}`, async () => {
    const f = fake(status === 400 ? (n) => (n === 1 ? { status: 400 } : { status: 200, body: TRAFFIC }) : [{ status }]);
    const r = await run(f);
    if (status === 400) {
      assert.equal(r.measurement_state, "PARTIAL");
      assert.equal(r.requests[0].error_code, code);
      assert.equal(f.calls.length, 3);
    } else {
      assert.equal(r.measurement_state, "ERROR");
      assert.equal(r.error_code, code);
      assert.equal(f.calls.length, 1, "401/403 sonrasi kalan istekler atilir");
      assert.deepEqual(r.requests.map((q) => q.state), ["ERROR", "SKIPPED", "SKIPPED"]);
      assert.equal(summaryLine(r), `ERROR pamistanbul — ${code}`);
    }
    assert.equal(r.requests[0].row_count, "UNKNOWN");
  });
}

test("429 -> ERROR RATE_LIMITED, YENIDEN DENEME YOK (tek HTTP cagrisi), kalanlar atlanir", async () => {
  const f = fake([{ status: 429 }, { status: 200, body: TRAFFIC }]);
  const r = await run(f);
  assert.equal(r.measurement_state, "ERROR");
  assert.equal(r.error_code, "RATE_LIMITED");
  assert.equal(f.calls.length, 1);
  assert.equal(f.sleeps.length, 0, "429'da bekleyip tekrar denenmez");
  assert.deepEqual(r.requests.map((q) => q.attempts), [1, 0, 0]);
});

test("500: sinirli yeniden deneme (istek basina 1, toplam tavan), kalici 500 ERROR; 429 gibi durdurma yok ama butce tavani var", async () => {
  const one = fake((n) => (n === 1 ? { status: 500 } : { status: 200, body: TRAFFIC }));
  const r1 = await run(one);
  assert.equal(r1.measurement_state, "MEASURED", "ilk istek yeniden denemede basardi");
  assert.equal(r1.requests[0].attempts, 2);
  assert.deepEqual(one.sleeps, [1000]);
  assert.equal(one.calls.length, 4);

  const all = fake([{ status: 500 }]);
  const r2 = await run(all);
  assert.equal(r2.measurement_state, "ERROR");
  assert.equal(r2.error_code, "SERVER_ERROR");
  assert.equal(all.calls.length, MAX_HTTP_ATTEMPTS_PER_SITE, "toplam HTTP denemesi tavani asilmaz");
  assert.equal(r2.requests[2].error_code, "BUDGET_EXHAUSTED");
  assert.ok(r2.requests.every((q) => q.row_count === "UNKNOWN"));
});

test("8) gecersiz JSON ve beklenmeyen sekil -> ERROR INVALID_RESPONSE (sifir DEGIL)", async () => {
  for (const body of ["<html>oops</html>", "not json", { not: "an array" }, [{ metricName: 5 }], [{ metricName: "Traffic", information: "x" }]]) {
    const r = await run(fake([{ status: 200, body }]));
    assert.equal(r.measurement_state, "ERROR", JSON.stringify(body));
    assert.equal(r.error_code, "INVALID_RESPONSE");
    assert.equal(r.row_count, "UNKNOWN");
    assert.equal(r.is_zero, false);
  }
});

test("zaman asimi / ag hatasi -> ERROR TIMEOUT / NETWORK_ERROR; mesaj tasinmaz", async () => {
  const abort = Object.assign(new Error(`aborted ${TOKEN}`), { name: "AbortError" });
  const r1 = await run(fake([abort]));
  assert.equal(r1.error_code, "TIMEOUT");
  const r2 = await run(fake([new Error(`connect failed with ${TOKEN}`)]));
  assert.equal(r2.error_code, "NETWORK_ERROR");
  assert.ok(!JSON.stringify([r1, r2]).includes(TOKEN));
});

// --- 1000 satir -----------------------------------------------------------------------------

test("9) 1000 satir -> rows_complete false, CANDIDATE (tam veri DEGIL); 999 -> true", async () => {
  const full = await run(fake([{ status: 200, body: rowsOf(RESPONSE_ROW_LIMIT) }]));
  assert.equal(full.measurement_state, "MEASURED");
  assert.equal(full.rows_complete, false);
  assert.equal(full.confidence, "CANDIDATE");
  assert.equal(full.requests[0].rows_complete, false);
  assert.match(summaryLine(full), /KESILMIS/);
  const under = await run(fake([{ status: 200, body: rowsOf(RESPONSE_ROW_LIMIT - 1) }]));
  assert.equal(under.rows_complete, true);
  assert.equal(under.confidence, "CONFIRMED");
});

test("satir siniri metrikler TOPLAMI uzerinden: iki metrik 500+500 -> kesilmis", async () => {
  const body = [{ metricName: "A", information: Array.from({ length: 500 }, () => ({ x: 1 })) }, { metricName: "B", information: Array.from({ length: 500 }, () => ({ x: 1 })) }];
  assert.equal((await run(fake([{ status: 200, body }]))).rows_complete, false);
});

// --- site izolasyonu ---------------------------------------------------------------------------

test("10) site izolasyonu: her site YALNIZ kendi token'iyla cagirir; sonuclar karismaz", async () => {
  const f = fake([{ status: 200, body: TRAFFIC }]);
  const tokens = new Map([["pamistanbul", "TOK-A-111111"], ["pamaistudio", "TOK-B-222222"], ["baska", "TOK-X-999999"]]);
  const { results, ignoredTokenSites } = await measureSites(["pamistanbul", "pamaistudio"], tokens, { fetchFn: f.fetchFn, sleep: f.sleep, now: NOW });
  assert.deepEqual(f.calls.map((c) => c.auth), [...Array(3).fill("Bearer TOK-A-111111"), ...Array(3).fill("Bearer TOK-B-222222")]);
  assert.deepEqual(ignoredTokenSites, ["baska"]);
  assert.ok(!f.calls.some((c) => c.auth!.includes("TOK-X")), "registry'de olmayan site'in token'i kullanilmaz");
  const [a, b] = results;
  assert.equal(a.site_id, "pamistanbul"); assert.equal(b.site_id, "pamaistudio");
  for (const [r, other] of [[a, "TOK-B"], [b, "TOK-A"]] as const) assert.ok(!JSON.stringify(r).includes(other));
});

test("assertResultSite: bir sitenin sonucu baska sitenin kaydina yazilamaz", async () => {
  const a = await run(fake([{ status: 200, body: TRAFFIC }]), TOKEN, "pamistanbul");
  assert.doesNotThrow(() => assertResultSite(a, "pamistanbul"));
  assert.throws(() => assertResultSite(a, "pamaistudio"), /izolasyon/);
});

test("17) bir sitenin hatasi digerlerini ZEHIRLEMEZ (403, istisna, token yok, basarili)", async () => {
  const tokens = new Map([["a", "TOK-A-111111"], ["b", "TOK-B-222222"], ["d", "TOK-D-444444"]]);
  const f = fake((_n, call) => {
    if (call.auth === "Bearer TOK-A-111111") return { status: 403 };
    if (call.auth === "Bearer TOK-D-444444") return new Error("socket hang up");
    return { status: 200, body: TRAFFIC };
  });
  const { results } = await measureSites(["a", "b", "c", "d"], tokens, { fetchFn: f.fetchFn, sleep: f.sleep, now: NOW });
  const by = Object.fromEntries(results.map((r) => [r.site_id, r]));
  assert.equal(by.a.error_code, "FORBIDDEN");
  assert.equal(by.b.measurement_state, "MEASURED");
  assert.equal(by.b.row_count, 3, "b'nin verisi a'nin hatasindan etkilenmedi");
  assert.equal(by.c.measurement_state, "NOT_CONNECTED");
  assert.equal(by.d.measurement_state, "ERROR");
});

// --- gizlilik -------------------------------------------------------------------------------------

test("11) token cikti, rapor, artifact JSON'u ve hata durumunda SIZMAZ (yanit govdesi ve istisna mesaji dahil)", async () => {
  const leaky = (n: number): Reply => (n === 1 ? { status: 500, body: `server said token ${TOKEN}` } : n === 2 ? { status: 401, body: `bad bearer ${TOKEN}` } : new Error(`x ${TOKEN}`));
  const tokens = new Map([["pamistanbul", TOKEN]]);
  const f = fake((n) => leaky(n));
  const { results, ignoredTokenSites } = await measureSites(["pamistanbul"], tokens, { fetchFn: f.fetchFn, sleep: f.sleep, now: NOW });
  const dump = JSON.stringify(results) + resultsToMarkdown(results, ignoredTokenSites) + results.map(summaryLine).join("\n");
  assert.ok(!dump.includes(TOKEN));
  assert.ok(!dump.includes("Bearer"));
  assert.ok(!dump.includes("server said"), "yanit govdesi hata durumunda tasinmaz");
});

test("redact + parseClarityTokens: bozuk JSON degeri yankilamaz; token degerleri sorun listesine girmez", () => {
  assert.equal(redact(`a ${TOKEN} b`, [TOKEN]), "a [REDACTED] b");
  const bad = parseClarityTokens(`{"pamistanbul": "${TOKEN}",`);
  assert.equal(bad.tokens.size, 0);
  assert.ok(!bad.problems.join(" ").includes(TOKEN));
  const mixed = parseClarityTokens(JSON.stringify({ pamistanbul: TOKEN, bos: "  ", sayi: 5 }));
  assert.deepEqual([...mixed.tokens.keys()], ["pamistanbul"]);
  assert.equal(mixed.problems.length, 2);
  assert.ok(!mixed.problems.join(" ").includes(TOKEN));
  assert.equal(parseClarityTokens(undefined).tokens.size, 0);
  assert.equal(parseClarityTokens("[]").tokens.size, 0);
});

test("kisisel veri: e-posta/IP/kullanici-oturum-cerez alanlari dusurulur; URL'den sorgu ve fragment atilir", async () => {
  const body = [{ metricName: "Popular Pages", information: [{ Url: "https://pamistanbul.com/p?email=a@b.com&x=1#frag", visitsCount: 4, userId: "u1", IPAddress: "1.2.3.4", Email: "a@b.com", sessionId: "s1", cookie: "c", totalSessionCount: 9 }] }];
  const r = await run(fake([{ status: 200, body }]));
  const row = r.metrics[0].rows[0];
  assert.equal(row.Url, "https://pamistanbul.com/p");
  assert.equal(row.visitsCount, 4);
  assert.equal(row.totalSessionCount, 9, "gecerli metrik alani korunur");
  for (const k of ["userId", "IPAddress", "Email", "sessionId", "cookie"]) assert.ok(!(k in row), k);
  assert.equal(sanitizeUrl("https://x.com/a?b=1#c"), "https://x.com/a");
});

test("12) token CLI argumani degil: --token / --tokens / --token=... reddedilir ve DEGERI yankilanmaz", () => {
  const cwd = mkdtempSync(join(tmpdir(), "clr-"));
  for (const a of [["--token", "SECRETVALUE9"], ["--tokens", "SECRETVALUE9"], ["--token=SECRETVALUE9"], ["--clarity-token", "SECRETVALUE9"]]) {
    for (const cmd of ["clarity-measure", "clarity-smoke"]) {
      const r = spawnSync("node", ["--experimental-strip-types", join(ROOT, "src/cli.ts"), cmd, join(ROOT, "config/sites.yaml"), ...a], { cwd, encoding: "utf8", env: { ...process.env, [CLARITY_ENV]: "" } });
      assert.equal(r.status, 1, `${cmd} ${a[0]}`);
      assert.ok(!(r.stdout + r.stderr).includes("SECRETVALUE9"));
      assert.match(r.stderr, /CLI argumani olarak kabul edilmez/);
    }
  }
  assert.deepEqual(readdirSync(cwd), [], "reddedilince hicbir dosya yazilmaz");
});

test("kaynak taramasi: console/log yok, uc nokta koda gomulu ve ortam degiskeniyle degistirilemez", () => {
  const src = readFileSync(join(ROOT, "src/adapters/clarity.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/console\./.test(code));
  assert.equal(CLARITY_ENDPOINT, "https://www.clarity.ms/export-data/api/v1/project-live-insights");
  assert.ok(!/ENDPOINT|BASE_URL/.test(code.replace(/CLARITY_ENDPOINT/g, "")), "baska bir uc nokta/baz URL ortam degiskeni yok");
  assert.equal([...code.matchAll(/process\.env/g)].length, 1, "ortam yalniz clarityStatus varsayilan argumaninda okunur");
});

// --- butce ------------------------------------------------------------------------------------------

test("13) en fazla 3 istek/site/kosu: hepsi 200 -> tam 3; profil 3, 4. istek profil olarak kurulamaz", async () => {
  const f = fake([{ status: 200, body: TRAFFIC }]);
  await run(f);
  assert.equal(f.calls.length, PROFILE_REQUESTS_PER_SITE);
  assert.equal(PROFILE.length, 3);
  assert.ok(PROFILE_REQUESTS_PER_SITE * 3 <= OFFICIAL_DAILY_LIMIT_PER_PROJECT, "bir gun 3 elle kosu resmi limite sigar");
  assert.equal(OFFICIAL_DAILY_LIMIT_PER_PROJECT, 10);
  const four: ProfileRequest[] = [...PROFILE, { id: "device", numOfDays: 1, dimensions: ["Browser"] }];
  assert.throws(() => validateProfile(four), /en fazla 3 istek/);
  assert.rejects(measureSite("x", TOKEN, { profile: four, fetchFn: fake([]).fetchFn }), /en fazla 3 istek/);
});

test("14) numOfDays HER ZAMAN 1 ve boyut sayisi 1-3; baska deger istegi kurulamaz", async () => {
  const f = fake([{ status: 200, body: TRAFFIC }]);
  await run(f);
  for (const c of f.calls) {
    const u = new URL(c.url);
    assert.equal(u.origin + u.pathname, CLARITY_ENDPOINT);
    assert.equal(u.searchParams.get("numOfDays"), "1");
    assert.ok(!c.url.includes(TOKEN) && !/token/i.test(u.search), "token URL'de degil");
  }
  assert.deepEqual(f.calls.map((c) => [...new URL(c.url).searchParams.keys()].filter((k) => k.startsWith("dimension")).length), [1, 2, 1]);
  assert.throws(() => buildUrl({ id: "device", numOfDays: 2 as 1, dimensions: ["Device"] }), /numOfDays=1/);
  assert.throws(() => buildUrl({ id: "device", numOfDays: 1, dimensions: ["a", "b", "c", "d"] }), /1-3 boyut/);
  assert.throws(() => buildUrl({ id: "device", numOfDays: 1, dimensions: [] }), /1-3 boyut/);
});

test("istek yalniz Authorization basligiyla kimlik dogrular", async () => {
  const f = fake([{ status: 200, body: TRAFFIC }]);
  await run(f);
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

// --- normalizasyon ----------------------------------------------------------------------------------

test("15) bilinmeyen metrik SESSIZCE atilmaz: ham ad korunur, metric_key null; bilinenler normalize", async () => {
  const body = [
    { metricName: "BrandNewMetric", information: [{ Device: "Mobile", foo: 1 }] },
    { metricName: "Dead Click Count", information: [{ Url: "https://pamistanbul.com/a", subTotal: 6 }] },
    { metricName: "RageClickCount", information: [] },
    { metricName: "Engagement Time", information: [{ x: 1 }] },
    { metricName: "ScrollDepth", information: [{ x: 1 }] },
    { metricName: "QuickbackClick", information: [] }, { metricName: "ExcessiveScroll", information: [] },
    { metricName: "ScriptErrorCount", information: [] }, { metricName: "ErrorClickCount", information: [] },
  ];
  const r = await run(fake([{ status: 200, body }]));
  const m = r.metrics.filter((x) => x.request_id === "device");
  const byName = Object.fromEntries(m.map((x) => [x.metric_name, x]));
  assert.equal(byName.BrandNewMetric.metric_key, null);
  assert.deepEqual(byName.BrandNewMetric.rows, [{ Device: "Mobile", foo: 1 }]);
  assert.equal(byName["Dead Click Count"].metric_key, "dead_click_count");
  assert.deepEqual(m.map((x) => x.metric_key), [null, "dead_click_count", "rage_click_count", "engagement_time", "scroll_depth", "quickback_click", "excessive_scroll", "script_error_count", "error_click_count"]);
  assert.match(resultsToMarkdown([r], []), /BrandNewMetric \(bilinmeyen, normalize edilmedi\)/);
});

test("16) hata sifir DEGIL: ayni sifir gorunumlu alanlar hata durumunda UNKNOWN, gercek sifirda 0", async () => {
  const err = await run(fake([{ status: 403 }]));
  const zero = await run(fake([{ status: 200, body: [] }]));
  assert.equal(err.row_count, "UNKNOWN"); assert.equal(err.is_zero, false); assert.equal(err.rows_complete, "UNKNOWN"); assert.equal(err.confidence, "UNKNOWN");
  assert.equal(zero.row_count, 0); assert.equal(zero.is_zero, true);
  assert.notDeepEqual([err.row_count, err.is_zero], [zero.row_count, zero.is_zero]);
});

test("kismi veri: PARTIAL + CANDIDATE, hangi istegin dustugu yazilir", async () => {
  const f = fake((n) => (n === 2 ? { status: 400 } : { status: 200, body: TRAFFIC }));
  const r = await run(f);
  assert.equal(r.measurement_state, "PARTIAL");
  assert.equal(r.confidence, "CANDIDATE");
  assert.equal(r.rows_complete, "UNKNOWN", "eksik sonuc 'tam' denmez");
  assert.match(r.note!, /acquisition: INVALID_REQUEST/);
  assert.match(summaryLine(r), /^PARTIAL pamistanbul — 2\/3 request, PARTIAL/);
});

test("brain sozlesmesi: kaynak/provenans alanlari, evidence_label FACT, EDITORIAL yok, UTC zaman", async () => {
  const r = await run(fake([{ status: 200, body: TRAFFIC }]));
  assert.equal(r.schema, "sgos.clarity.v1");
  assert.equal(r.source, "microsoft_clarity_data_export_api");
  assert.equal(r.evidence_label, "FACT");
  assert.equal(r.site_id, "pamistanbul");
  assert.equal(r.measured_at, "2026-10-01T09:00:00.000Z");
  assert.equal(r.window_days, 1);
  for (const k of ["measurement_state", "requests", "metrics", "row_count", "rows_complete", "confidence"]) assert.ok(k in r, k);
  assert.ok(r.requests.every((q) => Array.isArray(q.dimensions) && q.window_days === 1));
  assert.ok(!JSON.stringify(r).includes("EDITORIAL"));
  const policy = readFileSync(join(ROOT, "policies/evidence-labels.md"), "utf8");
  assert.deepEqual([...policy.matchAll(/^\| ([A-Z_]+) \|/gm)].map((m) => m[1]), ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"]);
});

// --- entegrasyon durumu -------------------------------------------------------------------------------

test("clarityStatus cagri yapmaz: token yok NOT_CONNECTED, token var UNKNOWN (CONNECTED DEGIL); allStatuses'ta Clarity var, env adi SEARCH_GROWTH_*", () => {
  assert.equal(clarityStatus({}).state, "NOT_CONNECTED");
  assert.equal(clarityStatus({ [CLARITY_ENV]: JSON.stringify({ pamistanbul: TOKEN }) }).state, "UNKNOWN");
  assert.ok(!clarityStatus({ [CLARITY_ENV]: JSON.stringify({ pamistanbul: TOKEN }) }).note.includes(TOKEN));
  const c = allStatuses().find((s) => s.name === "Microsoft Clarity")!;
  assert.equal(c.envVar, CLARITY_ENV);
  assert.match(c.envVar, /^SEARCH_GROWTH_/);
});

// --- CLI (cevrimdisi yollar) ----------------------------------------------------------------------------

const cli = (cwd: string, env: Record<string, string>, ...a: string[]) =>
  spawnSync("node", ["--experimental-strip-types", join(ROOT, "src/cli.ts"), ...a], { cwd, encoding: "utf8", env: { ...process.env, [CLARITY_ENV]: "", CLARITY_TOKENS_JSON: "", ...env } });

test("clarity-smoke OFFLINE: token degerini yazmaz, kayitsiz site uyarisi, butce satiri, API cagrisi yok", () => {
  const cwd = mkdtempSync(join(tmpdir(), "clr-"));
  const r = cli(cwd, { [CLARITY_ENV]: JSON.stringify({ pamistanbul: TOKEN, bilinmeyen: "TOK-ZZZZZZ-1" }) }, "clarity-smoke", join(ROOT, "config/sites.yaml"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /TOKEN_PRESENT\s+pamistanbul/);
  assert.match(r.stdout, /NOT_CONNECTED\s+pamaistudio/);
  assert.match(r.stdout, /registry'de olmayan site kimligi \(kullanilmaz\): bilinmeyen/);
  assert.match(r.stdout, /API cagrisi YOK/);
  assert.match(r.stdout, /3 istek\/site\/kosu/);
  assert.match(r.stdout, /10\/proje\/gun/);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN) && !r.stdout.includes("TOK-ZZZZZZ"));
  assert.deepEqual(readdirSync(cwd), []);
  const bad = cli(cwd, { [CLARITY_ENV]: `{"pamistanbul": "${TOKEN}",` }, "clarity-smoke", join(ROOT, "config/sites.yaml"));
  assert.equal(bad.status, 1);
  assert.ok(!(bad.stdout + bad.stderr).includes(TOKEN));
});

test("clarity-measure token YOKKEN: 7 site NOT_CONNECTED, hicbir ag cagrisi, JSON yazilir, cikis 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), "clr-"));
  const r = cli(cwd, {}, "clarity-measure", join(ROOT, "config/sites.yaml"));
  assert.equal(r.status, 0);
  assert.equal((r.stdout.match(/^NOT_CONNECTED /gm) ?? []).length, 7);
  const files = readdirSync(join(cwd, "clarity-out")).sort();
  assert.equal(files.length, 8);
  const j = JSON.parse(readFileSync(join(cwd, "clarity-out/clarity-pamistanbul.json"), "utf8"));
  assert.equal(j.measurement_state, "NOT_CONNECTED");
  assert.equal(j.row_count, "UNKNOWN");
  assert.equal(j.evidence_label, "FACT");
  const one = cli(cwd, {}, "clarity-measure", join(ROOT, "config/sites.yaml"), "--site", "spryhand", "--out", "tek");
  assert.equal(one.status, 0);
  assert.deepEqual(readdirSync(join(cwd, "tek")).sort(), ["clarity-spryhand.json", "clarity-summary.md"]);
  assert.equal(cli(cwd, {}, "clarity-measure", join(ROOT, "config/sites.yaml"), "--site", "yok").status, 1);
});

// --- workflow ve eski sistem ------------------------------------------------------------------------------

const WF = readFileSync(join(ROOT, ".github/workflows/clarity.yml"), "utf8");
const onBlock = WF.split(/^on:/m)[1].split(/^permissions:/m)[0];

test("18) workflow yalniz workflow_dispatch: schedule YOK, push/pull_request tetikleyicisi YOK", () => {
  assert.match(onBlock, /workflow_dispatch:/);
  assert.ok(!/schedule:|cron:|push:|pull_request/.test(onBlock));
});

test("19) workflow production'a yazmaz ve depoya commit atmaz: contents read, yazma komutu yok, artifact 30 gun, secret yalniz env", () => {
  assert.match(WF, /permissions:\s*\n\s*contents: read/);
  assert.ok(!/contents:\s*write|git (push|commit|add)|curl\b|vercel|-X\s*(POST|PUT|DELETE|PATCH)|gh\s+(pr|api)/i.test(WF.replace(/^\s*#.*$/gm, "")));
  assert.match(WF, /retention-days: 30/);
  assert.match(WF, /SEARCH_GROWTH_CLARITY_TOKENS_JSON: \$\{\{ secrets\.SEARCH_GROWTH_CLARITY_TOKENS_JSON \}\}/);
  assert.ok(!/--token|echo .*TOKEN|set -x/.test(WF.replace(/^\s*#.*$/gm, "")));
  assert.match(WF, /clarity-smoke/); assert.match(WF, /clarity-measure/);
  assert.match(WF, /ubuntu-latest/);
});

test("20) eski site-health-monitor'a runtime bagimliligi YOK: eski env, repo adi, script adi, ortak yol yok; yalniz eski env varken NOT_CONNECTED", () => {
  const code = readFileSync(join(ROOT, "src/adapters/clarity.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of [/(?<!SEARCH_GROWTH_)CLARITY_TOKENS_JSON/, /site-health-monitor/i, /daily_health_check/, /history\/clarity/, /cache\/clarity/, /import .*site-health/]) assert.ok(!bad.test(code), String(bad));
  const wf = WF.replace(/^\s*#.*$/gm, "");
  for (const bad of [/(?<!SEARCH_GROWTH_)CLARITY_TOKENS_JSON/, /site-health-monitor/i, /daily_health_check/]) assert.ok(!bad.test(wf), String(bad));
  const cwd = mkdtempSync(join(tmpdir(), "clr-"));
  const r = cli(cwd, { CLARITY_TOKENS_JSON: JSON.stringify({ "pamistanbul.com": TOKEN, pamistanbul: TOKEN }) }, "clarity-smoke", join(ROOT, "config/sites.yaml"));
  assert.equal((r.stdout.match(/NOT_CONNECTED/g) ?? []).length, 7, "eski secret adi OKUNMAZ");
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
});

test("GSC/GA4 dosyalari ve index-probe bu fazda degismedi: adapter kaynaklari clarity'ye bagimli degil", () => {
  for (const f of ["src/adapters/gsc.ts", "src/adapters/ga4.ts", "src/index-probe.ts", "src/index-candidates.ts"]) {
    assert.ok(!/clarity/i.test(readFileSync(join(ROOT, f), "utf8")), f);
  }
});
