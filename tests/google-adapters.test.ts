// GSC/GA4 istemcileri — canli kimlik OLMADAN kanitlanabilen her sey.
//
// Buradaki testlerin isi "Google dogru cevap veriyor mu" degil (bunu ancak
// gercek kimlikle smokeTest() soyler). Isi, kimligin YOKLUGUNDA sistemin
// durust kalmasi ve VARLIGINDA dogru istegi kurmasi. Ikisi de sessizce
// bozulabilecek seyler: null yerine 0 donen bir adapter "trafik sifirlandi"
// diye okunur, sayfalanmayan bir istek ise kuyrugu hic gostermeden keser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { loadServiceAccount, signJwt, _resetTokenCache } from "../src/adapters/google-auth.ts";
import * as gsc from "../src/adapters/gsc.ts";
import * as ga4 from "../src/adapters/ga4.ts";
import { searchConsole, ga4 as ga4Adapter, allStatuses } from "../src/adapters/index.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA = JSON.stringify({ client_email: "bot@proje.iam.gserviceaccount.com", private_key: PEM, token_uri: "https://oauth2.googleapis.com/token" });

/** Ortam degiskenini gecici olarak kur; test sonrasi eski haline dondur. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** Async surum. Senkron withEnv'i async bir geri cagirimla kullanmak, env'i
 *  await'lerden ONCE geri alir ve testi sessizce anlamsizlastirir. */
async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("kimlik yoksa adapter null doner — 0 DEGIL", async () => {
  await withEnvAsync({ SEARCH_GROWTH_GSC_CREDENTIALS_JSON: undefined, SEARCH_GROWTH_GA4_CREDENTIALS_JSON: undefined }, async () => {
    // Bu ayrim olcumun tamami: null "bilmiyorum", 0 ise "olctum ve sifir".
    assert.equal(await searchConsole.searchAnalytics("sc-domain:x.com", { start: "2026-01-01", end: "2026-01-07" }, ["date"]), null);
    assert.equal(await searchConsole.sitemaps("sc-domain:x.com"), null);
    assert.equal(await ga4Adapter.landingPages("properties/1", { start: "2026-01-01", end: "2026-01-07" }), null);
    assert.equal(await ga4Adapter.aiReferrals("properties/1", { start: "2026-01-01", end: "2026-01-07" }), null);
  });
});

test("kimlik yoksa durum NOT_CONNECTED, varsa UNKNOWN", () => {
  withEnv({ SEARCH_GROWTH_GSC_CREDENTIALS_JSON: undefined }, () => {
    assert.equal(searchConsole.status().state, "NOT_CONNECTED");
  });
  withEnv({ SEARCH_GROWTH_GSC_CREDENTIALS_JSON: SA }, () => {
    const s = searchConsole.status();
    assert.equal(s.state, "UNKNOWN");
    // Eski not "client not implemented" diyordu; artik yalan olurdu.
    assert.ok(!/not implemented/.test(s.note), s.note);
  });
});

test("allStatuses her adapter icin env adi tasir", () => {
  for (const s of allStatuses()) assert.match(s.envVar, /^SEARCH_GROWTH_/);
});

test("loadServiceAccount: yok -> null, bozuk JSON ve eksik alan -> hata", () => {
  withEnv({ X: undefined }, () => assert.equal(loadServiceAccount("X"), null));
  withEnv({ X: "   " }, () => assert.equal(loadServiceAccount("X"), null));
  withEnv({ X: "{bozuk" }, () => assert.throws(() => loadServiceAccount("X"), /JSON ayristirilamadi/));
  withEnv({ X: '{"client_email":"a@b"}' }, () => assert.throws(() => loadServiceAccount("X"), /private_key/));
});

test("hata mesaji gizli anahtari TASIMAZ", () => {
  // Bir kimlik bilgisinin hata metnine, log'a ya da artifact'a dusmesi
  // yasak; bu kural bu projenin en bastan beri tasidigi sozlesme.
  withEnv({ X: `{"client_email":"a@b","private_key":""}` }, () => {
    try { loadServiceAccount("X"); assert.fail("hata bekleniyordu"); }
    catch (e) { assert.ok(!(e as Error).message.includes("BEGIN"), (e as Error).message); }
  });
});

test("signJwt gercekten RS256 imzali ve iddialari dogru", () => {
  const sa = loadServiceAccount("X") ?? withEnv({ X: SA }, () => loadServiceAccount("X"))!;
  const jwt = signJwt(sa, ["https://www.googleapis.com/auth/webmasters.readonly"], 1_700_000_000);
  const [h, p, sig] = jwt.split(".");
  const dec = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  const claims = dec(p);
  assert.equal(claims.iss, "bot@proje.iam.gserviceaccount.com");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.exp - claims.iat, 3600, "exp 1 saati asamaz");
  assert.equal(claims.sub, undefined, "delegation istenmediyse sub yazilmamali");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")), "imza dogrulanmali");
});

test("signJwt: subject verilirse sub yazilir (domain-wide delegation)", () => {
  const sa = withEnv({ X: SA }, () => loadServiceAccount("X"))!;
  const claims = JSON.parse(Buffer.from(signJwt(sa, ["s"], 1, "sefa@pamistanbul.com").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  assert.equal(claims.sub, "sefa@pamistanbul.com");
});

// --- istek kurulumu: sahte fetch ile --------------------------------------

type Call = { url: string; body: unknown };
function stubFetch(handler: (c: Call) => unknown): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const call: Call = { url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return new Response(JSON.stringify(handler(call)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; _resetTokenCache(); } };
}

test("searchAnalytics 25000 satir sinirinda SAYFALAR", async () => {
  // Sayfalama olmadan kuyruk sessizce kesilir ve marka/marka-disi ayrimi
  // yanlis cikar — ustelik hicbir hata vermeden.
  const PAGE = 25000;
  const f = stubFetch(({ body }) => {
    const start = (body as { startRow: number }).startRow;
    const n = start === 0 ? PAGE : 3;
    return { rows: Array.from({ length: n }, (_, i) => ({ keys: [`q${start + i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 3 })) };
  });
  try {
    const rows = await withEnv({ SEARCH_GROWTH_GSC_CREDENTIALS_JSON: SA }, () =>
      gsc.searchAnalytics("sc-domain:pamistanbul.com", { start: "2026-01-01", end: "2026-01-31" }, ["query"]));
    assert.equal(rows!.length, PAGE + 3);
    assert.equal(f.calls.length, 2);
    assert.equal((f.calls[1].body as { startRow: number }).startRow, PAGE);
    assert.equal(rows![0].query, "q0");
    assert.equal(rows![PAGE].query, `q${PAGE}`);
  } finally { f.restore(); }
});

test("property adi URL'de kodlanir (sc-domain: ve '/' kirmamali)", async () => {
  const f = stubFetch(() => ({ rows: [] }));
  try {
    await withEnv({ SEARCH_GROWTH_GSC_CREDENTIALS_JSON: SA }, () => gsc.sitemaps("sc-domain:pamistanbul.com"));
    assert.ok(f.calls[0].url.includes("sc-domain%3Apamistanbul.com"), f.calls[0].url);
  } finally { f.restore(); }
});

test("GA4 AI referans filtresi SUNUCU tarafinda kurulur", async () => {
  const f = stubFetch(() => ({ rows: [] }));
  try {
    await withEnv({ SEARCH_GROWTH_GA4_CREDENTIALS_JSON: SA }, () =>
      ga4.aiReferrals("properties/123", { start: "2026-01-01", end: "2026-01-07" }));
    const body = f.calls[0].body as { dimensionFilter?: { orGroup?: { expressions: unknown[] } } };
    assert.ok(body.dimensionFilter?.orGroup, "filtre sunucuya gitmeli, yerelde elenmemeli");
    assert.equal(body.dimensionFilter.orGroup.expressions.length, ga4.AI_REFERRERS.length);
    assert.ok(ga4.AI_REFERRERS.includes("chatgpt.com"));
  } finally { f.restore(); }
});

test("GA4 property 'properties/' onekini iki yazimda da kabul eder", async () => {
  const f = stubFetch(() => ({ rows: [] }));
  try {
    await withEnvAsync({ SEARCH_GROWTH_GA4_CREDENTIALS_JSON: SA }, async () => {
      await ga4.landingPages("123", { start: "2026-01-01", end: "2026-01-02" });
      await ga4.landingPages("properties/123", { start: "2026-01-01", end: "2026-01-02" });
    });
    assert.equal(f.calls[0].url, f.calls[1].url);
    assert.ok(f.calls[0].url.endsWith("/properties/123:runReport"), f.calls[0].url);
  } finally { f.restore(); }
});

test("GA4 satirlari basliklardan okunur, kolon sirasina GUVENMEZ", async () => {
  // Google metrikleri istenen sirada dondurmek zorunda degil; sirayla okumak
  // oturum sayisini gelire yazacak turden sessiz bir hatadir.
  const f = stubFetch(() => ({
    dimensionHeaders: [{ name: "date" }, { name: "landingPagePlusQueryString" }],
    metricHeaders: [{ name: "totalRevenue" }, { name: "sessions" }, { name: "engagedSessions" }, { name: "conversions" }],
    rows: [{ dimensionValues: [{ value: "20260105" }, { value: "/tr/" }], metricValues: [{ value: "99.5" }, { value: "7" }, { value: "4" }, { value: "1" }] }],
  }));
  try {
    const rows = await withEnv({ SEARCH_GROWTH_GA4_CREDENTIALS_JSON: SA }, () =>
      ga4.landingPages("properties/1", { start: "2026-01-01", end: "2026-01-07" }));
    assert.equal(rows![0].sessions, 7);
    assert.equal(rows![0].revenue, 99.5);
    assert.equal(rows![0].landingPage, "/tr/");
  } finally { f.restore(); }
});

test("smokeTest kimlik yokken sebep bildirir, patlamaz", async () => {
  await withEnvAsync({ SEARCH_GROWTH_GSC_CREDENTIALS_JSON: undefined, SEARCH_GROWTH_GA4_CREDENTIALS_JSON: undefined }, async () => {
    assert.deepEqual(await gsc.smokeTest("sc-domain:x.com"), { ok: false, reason: "SEARCH_GROWTH_GSC_CREDENTIALS_JSON tanimli degil" });
    assert.equal((await ga4.smokeTest("properties/1")).ok, false);
  });
});
