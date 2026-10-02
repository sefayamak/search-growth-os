// Clarity gunluk toplama + gecmis + alert. Testlerin cogu NE YAPILMAMASI gerektigi hakkinda: hatayi sifir saymak,
// ayni gunun ikinci kosusunu baz yapmak, UNKNOWN gunu baz almak, bir sitenin hatasiyla digerini bozmak,
// 429'u yeniden denemek, token'i yazmak. Ag YOK: fetch enjekte edilir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../src/registry.ts";
import { CLARITY_ENV, MAX_HTTP_ATTEMPTS_PER_SITE, type FetchFn } from "../src/adapters/clarity.ts";
import {
  HISTORY_SCHEMA, HISTORY_MAX_RECORDS, FRICTION_KEYS, runDaily, toRecord, mergeRecord, selectBaseline, evaluateAlerts, parseHistory,
  loadHistory, hasUsableForDate, HistoryError, dailyMarkdown, type DailyRecord, type HistoryFile, type FrictionKey, type Num,
} from "../src/clarity-daily.ts";
import { measureSite } from "../src/adapters/clarity.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITES = loadRegistry(join(ROOT, "config/sites.yaml")).registry!.sites.map((s) => s.id);
const TOK = (id: string) => `TOK-${id}-SECRET-9876543210`;
const DAY = (n: number) => new Date(Date.UTC(2026, 9, n, 7, 20, 0)); // 2026-10-<n> 07:20Z

// --- sahte Clarity ----------------------------------------------------------------------------------------

interface Spec { dead?: number; rage?: number; script?: number; errorClick?: number; excessive?: number; quickback?: number; traffic?: [number, number]; omit?: string[]; big?: boolean }
const FR: Record<string, keyof Spec> = { DeadClickCount: "dead", RageClickCount: "rage", ScriptErrorCount: "script", ErrorClickCount: "errorClick", ExcessiveScroll: "excessive", QuickbackClick: "quickback" };

function body(kind: string, s: Spec): unknown {
  const out: unknown[] = [];
  const dim = kind === "URL" ? { Url: "https://pamistanbul.com/p/a?email=a@b.co&x=1#frag" } : kind === "Source" ? { Source: "google", Medium: "organic" } : { Device: "PC" };
  const dim2 = kind === "URL" ? { Url: "https://pamistanbul.com/p/b?token=zzz" } : dim;
  for (const name of ["DeadClickCount", "RageClickCount", "ScriptErrorCount", "ErrorClickCount", "ExcessiveScroll", "QuickbackClick"]) {
    if (s.omit?.includes(name)) continue;
    const n = (s[FR[name]] as number | undefined) ?? 0;
    const rows = [{ ...dim, sessionsCount: 3, subTotal: Math.ceil(n / 2) }, { ...dim2, sessionsCount: 2, subTotal: Math.floor(n / 2) }];
    if (s.big && name === "DeadClickCount") for (let i = 0; i < 1000; i++) rows.push({ ...dim, sessionsCount: 1, subTotal: 0 });
    out.push({ metricName: name, information: rows });
  }
  const [real, bot] = s.traffic ?? [20, 5];
  if (!s.omit?.includes("Traffic")) out.push({ metricName: "Traffic", information: [{ ...dim, totalSessionCount: real, totalBotSessionCount: bot, distinctUserCount: 3, pagesPerSessionPercentage: 1 }] });
  out.push({ metricName: "EngagementTime", information: [{ ...dim, totalTime: 10 }] });
  return out;
}

type Behavior = Spec | { status: number };
function fakeFetch(bySite: Record<string, Behavior>) {
  const calls: { site: string; kind: string }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const tok = init.headers.Authorization.replace("Bearer ", "");
    const site = SITES.find((id) => TOK(id) === tok) ?? "?";
    const kind = new URL(url).searchParams.get("dimension1") ?? "?";
    calls.push({ site, kind });
    const b = bySite[site];
    if (b && "status" in b) return { status: b.status, text: async () => "{}" };
    return { status: 200, text: async () => JSON.stringify(body(kind, (b as Spec) ?? {})) };
  };
  return { fetchFn, calls };
}
const tokensFor = (ids: string[]) => new Map(ids.map((id) => [id, TOK(id)] as [string, string]));
const sleep = async () => {};

function dirs() { const r = mkdtempSync(join(tmpdir(), "clrd-")); return { historyDir: join(r, "hist"), outDir: join(r, "out"), root: r }; }

async function daily(d: ReturnType<typeof dirs>, day: number, bySite: Record<string, Behavior>, ids = SITES, extra: Record<string, unknown> = {}) {
  const f = fakeFetch(bySite);
  const out = await runDaily({ siteIds: ids, tokens: tokensFor(Object.keys(bySite).length ? Object.keys(bySite) : ids), historyDir: d.historyDir, outDir: d.outDir, fetchFn: f.fetchFn, sleep, now: () => DAY(day), ...extra });
  return { out, calls: f.calls };
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; });
}
const hist = (d: ReturnType<typeof dirs>, id: string): HistoryFile => loadHistory(d.historyDir, id);

// --- kayit yardimcilari (birim) -------------------------------------------------------------------------

type RecOver = Omit<Partial<DailyRecord>, "friction"> & { friction?: Partial<Record<FrictionKey, Num>> };
function rec(date: string, over: RecOver = {}): DailyRecord {
  const friction = Object.fromEntries(FRICTION_KEYS.map((k) => [k, 0])) as DailyRecord["friction"];
  Object.assign(friction, over.friction ?? {});
  const { friction: _f, ...rest } = over;
  return {
    site_id: "pamistanbul", date, measured_at: `${date}T07:20:00.000Z`, measurement_state: "MEASURED", confidence: "CONFIRMED",
    row_count: 10, metric_row_count_total: 10, max_metric_row_count: 2, rows_complete: true, is_zero: false, usable: true,
    friction, friction_total: 0, sessions: { real: 20, bot: 5, total: 25, bot_pct: 20 }, ...rest,
  };
}
const unusable = (date: string, over: RecOver = {}) => rec(date, {
  measurement_state: "ERROR", confidence: "UNKNOWN", usable: false, rows_complete: "UNKNOWN", row_count: "UNKNOWN", metric_row_count_total: "UNKNOWN", max_metric_row_count: "UNKNOWN",
  friction: Object.fromEntries(FRICTION_KEYS.map((k) => [k, "UNKNOWN"])) as never, friction_total: "UNKNOWN", sessions: { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" }, error_code: "FORBIDDEN", ...over,
});
const H = (records: DailyRecord[]): HistoryFile => ({ schema: HISTORY_SCHEMA, site_id: "pamistanbul", max_records: HISTORY_MAX_RECORDS, records });

// --- 1-3: 7 site, MEASURED, eksik token -------------------------------------------------------------------

test("1) registry'deki 7 site deterministik sirayla islenir; her site 3 istek, hepsi MEASURED + kullanilabilir", async () => {
  assert.equal(SITES.length, 7);
  const d = dirs();
  const { out, calls } = await daily(d, 5, Object.fromEntries(SITES.map((s) => [s, {} as Spec])));
  assert.deepEqual(out.sites.map((s) => s.site_id), SITES);
  assert.equal(calls.length, 21);
  for (const id of SITES) assert.equal(calls.filter((c) => c.site === id).length, 3);
  assert.ok(out.sites.every((s) => s.action === "MEASURED" && s.measurement_state === "MEASURED" && s.record!.usable));
  assert.equal(out.http_attempts, 21);
});

test("2) yapilandirilmis site MEASURED: oturum ve friction gercek yanittan toplanir (toplam = gercek + bot, legacy ile ayni)", async () => {
  const d = dirs();
  const { out } = await daily(d, 5, { pamistanbul: { dead: 7, rage: 2, script: 1, errorClick: 4, excessive: 3, quickback: 9, traffic: [12, 8] } }, ["pamistanbul"]);
  const r = out.sites[0].record!;
  assert.equal(r.measurement_state, "MEASURED"); assert.equal(r.confidence, "CONFIRMED"); assert.equal(r.usable, true);
  assert.deepEqual(r.friction, { dead_click_count: 7, rage_click_count: 2, script_error_count: 1, error_click_count: 4, excessive_scroll: 3, quickback_click: 9 });
  assert.equal(r.friction_total, 26);
  assert.deepEqual(r.sessions, { real: 12, bot: 8, total: 20, bot_pct: 40 });
  assert.equal(r.date, "2026-10-05");
});

test("3) token yok -> NOT_CONNECTED: cagri yok, sayilar UNKNOWN (sifir DEGIL), kullanilamaz, baz olamaz", async () => {
  const d = dirs();
  const f = fakeFetch({});
  const out = await runDaily({ siteIds: ["pamistanbul", "spryhand"], tokens: tokensFor(["pamistanbul"]), historyDir: d.historyDir, outDir: d.outDir, fetchFn: f.fetchFn, sleep, now: () => DAY(5) });
  const s = out.sites.find((x) => x.site_id === "spryhand")!;
  assert.equal(s.measurement_state, "NOT_CONNECTED");
  assert.equal(f.calls.filter((c) => c.site === "spryhand").length, 0);
  const r = s.record!;
  assert.equal(r.usable, false); assert.equal(r.friction_total, "UNKNOWN"); assert.equal(r.sessions.real, "UNKNOWN");
  assert.ok(FRICTION_KEYS.every((k) => r.friction[k] === "UNKNOWN"));
  assert.equal(selectBaseline(hist(d, "spryhand"), "2026-10-06"), null);
  assert.deepEqual(out.evaluations.find((e) => e.site_id === "spryhand")!.status, "NOT_EVALUATED");
});

// --- 4-8: hata semantigi ve guvenlik ------------------------------------------------------------------------

test("4) API hatasi sifir degildir: ERROR kaydi UNKNOWN tasir, kullanilamaz, alert yok", async () => {
  const d = dirs();
  const { out } = await daily(d, 5, { pamistanbul: { status: 403 } }, ["pamistanbul"]);
  const r = out.sites[0].record!;
  assert.equal(r.measurement_state, "ERROR"); assert.equal(r.error_code, "FORBIDDEN");
  assert.equal(r.usable, false); assert.equal(r.friction_total, "UNKNOWN"); assert.equal(r.sessions.bot_pct, "UNKNOWN");
  assert.equal(out.alerts.length, 0);
});

test("5) 429 YENIDEN DENENMEZ: ilk istekte durur, kalan istekler atlanir (kota korunur)", async () => {
  const d = dirs();
  const { out, calls } = await daily(d, 5, { pamistanbul: { status: 429 } }, ["pamistanbul"]);
  assert.equal(calls.length, 1);
  assert.equal(out.sites[0].record!.error_code, "RATE_LIMITED");
  assert.equal(out.http_attempts, 1);
});

test("6) 5xx SINIRLI yeniden deneme: tek yeniden deneme, site basina toplam deneme tavani asilmaz", async () => {
  const d = dirs();
  let n = 0;
  const calls: number[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(++n);
    return n === 1 ? { status: 503, text: async () => "{}" } : { status: 200, text: async () => JSON.stringify(body(new URL(url).searchParams.get("dimension1")!, {})) };
  };
  const out = await runDaily({ siteIds: ["pamistanbul"], tokens: tokensFor(["pamistanbul"]), historyDir: d.historyDir, outDir: d.outDir, fetchFn, sleep, now: () => DAY(5) });
  assert.equal(calls.length, 4); assert.ok(calls.length <= MAX_HTTP_ATTEMPTS_PER_SITE);
  assert.equal(out.sites[0].measurement_state, "MEASURED");
  // surekli 5xx: tavan asilmaz
  const d2 = dirs(); let m = 0;
  const bad: FetchFn = async () => { m++; return { status: 500, text: async () => "{}" }; };
  await runDaily({ siteIds: ["pamistanbul"], tokens: tokensFor(["pamistanbul"]), historyDir: d2.historyDir, outDir: d2.outDir, fetchFn: bad, sleep, now: () => DAY(5) });
  assert.ok(m <= MAX_HTTP_ATTEMPTS_PER_SITE);
});

test("7) URL sanitizasyonu: yazilan hicbir dosyada sorgu dizesi, fragment ya da e-posta yok", async () => {
  const d = dirs();
  await daily(d, 5, { pamistanbul: { dead: 3 } }, ["pamistanbul"]);
  const files = allFiles(d.outDir).concat(allFiles(d.historyDir));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    assert.ok(!/a@b\.co|token=zzz|email=|#frag|\?x=1/.test(t), f);
  }
  assert.ok(readFileSync(join(d.outDir, "clarity-pamistanbul.json"), "utf8").includes("https://pamistanbul.com/p/a\""));
});

test("8) secret redaction: hicbir cikti/gecmis/rapor dosyasi token icermez; konsol ozeti de icermez", async () => {
  const d = dirs();
  const { out } = await daily(d, 5, Object.fromEntries(SITES.map((s) => [s, s === "spryhand" ? { status: 401 } : {}])) as Record<string, Behavior>);
  const all = [...allFiles(d.outDir), ...allFiles(d.historyDir)].map((f) => readFileSync(f, "utf8")).join("\n") + dailyMarkdown(out);
  for (const id of SITES) assert.ok(!all.includes(TOK(id)), id);
  assert.ok(!/Bearer/.test(all));
});

// --- 9-10: gecmis yazma ve ayni-gun --------------------------------------------------------------------------

test("9) gunluk gecmis yazilir: site basina tek dosya, sema, tek kayit, yalniz o sitenin kaydi", async () => {
  const d = dirs();
  await daily(d, 5, Object.fromEntries(SITES.map((s) => [s, {} as Spec])));
  assert.deepEqual(readdirSync(d.historyDir).sort(), SITES.map((s) => `${s}.json`).sort());
  for (const id of SITES) {
    const h = hist(d, id);
    assert.equal(h.schema, HISTORY_SCHEMA); assert.equal(h.site_id, id); assert.equal(h.records.length, 1);
    assert.equal(h.records[0].site_id, id); assert.equal(h.records[0].date, "2026-10-05");
  }
  const r = hist(d, "pamistanbul").records[0];
  for (const k of ["measurement_state", "confidence", "row_count", "metric_row_count_total", "max_metric_row_count", "rows_complete", "is_zero", "friction", "friction_total", "sessions"]) assert.ok(k in r, k);
});

test("10) ayni UTC gun tekrar kosusu: kullanilabilir kayit varsa API cagrisi YOK ve dosya bayt-bayt ayni; --force da kaydi ezmez", async () => {
  const d = dirs();
  const spec = { pamistanbul: { dead: 5 } };
  await daily(d, 5, spec, ["pamistanbul"]);
  const before = readFileSync(join(d.historyDir, "pamistanbul.json"), "utf8");
  const second = await daily(d, 5, { pamistanbul: { dead: 99 } }, ["pamistanbul"]);
  assert.equal(second.calls.length, 0);
  assert.equal(second.out.sites[0].action, "SKIPPED_ALREADY_MEASURED_TODAY");
  assert.equal(readFileSync(join(d.historyDir, "pamistanbul.json"), "utf8"), before);
  const forced = await daily(d, 5, { pamistanbul: { dead: 99 } }, ["pamistanbul"], { force: true });
  assert.equal(forced.calls.length, 3);
  assert.equal(forced.out.sites[0].history_action, "KEPT_EXISTING");
  assert.equal(readFileSync(join(d.historyDir, "pamistanbul.json"), "utf8"), before, "ikinci olcum ilk guvenilir kaydi degistiremez");
});

test("10b) ayni-gun birlestirme kurali: kullanilabilir kullanilamazi ezer; kullanilamaz kullanilabiliri ASLA ezmez; iki hata -> yeni", () => {
  const a = mergeRecord(H([unusable("2026-10-05")]), rec("2026-10-05", { friction: { dead_click_count: 3 } }));
  assert.equal(a.action, "REPLACED"); assert.equal(a.file.records.length, 1); assert.equal(a.file.records[0].usable, true);
  const b = mergeRecord(H([rec("2026-10-05")]), unusable("2026-10-05"));
  assert.equal(b.action, "KEPT_EXISTING"); assert.equal(b.file.records[0].usable, true);
  const c = mergeRecord(H([unusable("2026-10-05", { error_code: "FORBIDDEN" })]), unusable("2026-10-05", { error_code: "RATE_LIMITED" }));
  assert.equal(c.action, "REPLACED"); assert.equal(c.file.records[0].error_code, "RATE_LIMITED");
  const e = mergeRecord(H([rec("2026-10-04")]), rec("2026-10-06"));
  assert.deepEqual(e.file.records.map((r) => r.date), ["2026-10-04", "2026-10-06"]);
  assert.throws(() => mergeRecord(H([]), { ...rec("2026-10-05"), site_id: "spryhand" }), /izolasyon/);
});

test("10c) gecmis SINIRLI: 120 kayittan fazlasi en eski gunden duser", () => {
  let h = H([]);
  for (let i = 0; i < 130; i++) h = mergeRecord(h, rec(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))).file;
  assert.equal(h.records.length, HISTORY_MAX_RECORDS);
  assert.equal(h.records[0].date, new Date(Date.UTC(2026, 0, 11)).toISOString().slice(0, 10));
});

// --- 11-13: baz secimi ---------------------------------------------------------------------------------------

test("11) onceki kullanilabilir olcum secilir: kullanilamaz gunler atlanir, ayni gunun kaydi baz OLAMAZ, gelecek gun baz olamaz", () => {
  const h = H([rec("2026-10-01"), unusable("2026-10-02"), rec("2026-10-03"), rec("2026-10-04")]);
  assert.equal(selectBaseline(h, "2026-10-04")!.date, "2026-10-03");
  assert.equal(selectBaseline(h, "2026-10-05")!.date, "2026-10-04");
  const h2 = H([rec("2026-10-01"), unusable("2026-10-02"), unusable("2026-10-03")]);
  assert.equal(selectBaseline(h2, "2026-10-04")!.date, "2026-10-01");
  assert.equal(selectBaseline(H([rec("2026-10-04")]), "2026-10-04"), null);
  assert.equal(selectBaseline(H([rec("2026-10-09")]), "2026-10-04"), null);
});

test("12) UNKNOWN baz OLAMAZ: hata gunu 0 sayilsaydi alert cikardi, cikmaz; baz son GUVENILIR gun", () => {
  const h = H([rec("2026-10-01", { friction: { dead_click_count: 5 } }), unusable("2026-10-02")]);
  const cur = rec("2026-10-03", { friction: { dead_click_count: 3 } });
  const { alerts, evaluation } = evaluateAlerts(cur, h);
  assert.equal(alerts.length, 0, "3 > 5 degil; UNKNOWN->0 sayilsaydi 3 > 0 alert olurdu");
  assert.equal(evaluation.baseline_date, "2026-10-01");
  // sadece UNKNOWN gun varsa baz yok -> friction karsilastirilmaz
  const e2 = evaluateAlerts(cur, H([unusable("2026-10-02")]));
  assert.equal(e2.alerts.length, 0); assert.match(e2.evaluation.reasons.join(), /NO_BASELINE/);
});

test("13) eksik/kesik/kismi olcum alert URETMEZ ve DEGERLENDIRILMEZ", async () => {
  const h = H([rec("2026-10-01")]);
  for (const bad of [
    rec("2026-10-02", { usable: false, rows_complete: false, confidence: "CANDIDATE", friction: { dead_click_count: 50 } }),
    rec("2026-10-02", { usable: false, measurement_state: "PARTIAL", confidence: "CANDIDATE", friction: { dead_click_count: 50 } }),
    rec("2026-10-02", { usable: false, is_zero: true }),
    unusable("2026-10-02"),
  ]) {
    const r = evaluateAlerts(bad, h);
    assert.equal(r.alerts.length, 0); assert.equal(r.evaluation.status, "NOT_EVALUATED");
  }
  // gercek akis: bir metrik 1000 satira ulasir -> rows_complete=false -> kullanilamaz, friction UNKNOWN, alert yok
  const d = dirs();
  await daily(d, 5, { pamistanbul: { dead: 1 } }, ["pamistanbul"]);
  const { out } = await daily(d, 6, { pamistanbul: { dead: 40, big: true, traffic: [1, 9] } }, ["pamistanbul"]);
  const r = out.sites[0].record!;
  assert.equal(r.rows_complete, false); assert.equal(r.usable, false); assert.equal(r.friction.dead_click_count, "UNKNOWN");
  assert.equal(out.alerts.length, 0);
});

// --- 14-18: alert esikleri -----------------------------------------------------------------------------------

test("14) friction artisi alert verir: onceki -> simdiki, baz tarihi, FACT/CONFIRMED/REVIEW_REQUIRED, kok neden iddiasi yok", () => {
  const h = H([rec("2026-10-04", { friction: { dead_click_count: 2 } })]);
  const { alerts } = evaluateAlerts(rec("2026-10-05", { friction: { dead_click_count: 5 } }), h);
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.kind, "FRICTION_INCREASE"); assert.equal(a.metric, "dead_click_count");
  assert.equal(a.previous, 2); assert.equal(a.current, 5); assert.equal(a.baseline_date, "2026-10-04");
  assert.equal(a.evidence_label, "FACT"); assert.equal(a.confidence, "CONFIRMED"); assert.equal(a.review, "REVIEW_REQUIRED");
  assert.match(a.note, /kok neden iddia etmez/);
});

test("15) friction negatif durumlar: esit, azalis, sifir, alert-disi metrik (quickback/excessive) artisi alert vermez", () => {
  const h = H([rec("2026-10-04", { friction: { dead_click_count: 5, rage_click_count: 3 } })]);
  for (const f of [{ dead_click_count: 5 }, { dead_click_count: 4 }, { dead_click_count: 0, rage_click_count: 0 }, { quickback_click: 50, excessive_scroll: 50 }] as Partial<Record<FrictionKey, number>>[]) {
    assert.equal(evaluateAlerts(rec("2026-10-05", { friction: { ...f } }), h).alerts.length, 0, JSON.stringify(f));
  }
  // dort alert metriginin hepsi ayri ayri tetiklenir
  const up = evaluateAlerts(rec("2026-10-05", { friction: { dead_click_count: 6, rage_click_count: 4, script_error_count: 1, error_click_count: 1 } }), H([rec("2026-10-04", { friction: { dead_click_count: 5, rage_click_count: 3 } })]));
  assert.deepEqual(up.alerts.map((a) => a.metric).sort(), ["dead_click_count", "error_click_count", "rage_click_count", "script_error_count"]);
});

test("15b) tek metrik UNKNOWN ise yalniz o metrik elenir, digerleri degerlendirilir", () => {
  const h = H([rec("2026-10-04", { friction: { dead_click_count: 1, rage_click_count: 1 } })]);
  const cur = rec("2026-10-05", { friction: { dead_click_count: "UNKNOWN", rage_click_count: 4 } });
  const r = evaluateAlerts(cur, h);
  assert.deepEqual(r.alerts.map((a) => a.metric), ["rage_click_count"]);
  assert.match(r.evaluation.reasons.join(), /FRICTION_UNKNOWN:dead_click_count/);
});

test("15c) metrik yanitta HIC donmediyse sifir degil UNKNOWN (canli yanitlarda 9 metrik hep doner)", async () => {
  const d = dirs();
  const { out } = await daily(d, 5, { pamistanbul: { dead: 9, omit: ["DeadClickCount", "Traffic"] } }, ["pamistanbul"]);
  const r = out.sites[0].record!;
  assert.equal(r.friction.dead_click_count, "UNKNOWN"); assert.equal(r.friction_total, "UNKNOWN");
  assert.equal(r.friction.rage_click_count, 0);
  assert.deepEqual(r.sessions, { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" });
});

test("16) bot orani > %50 ve >= 5 oturum alert verir (baz GEREKTIRMEZ)", () => {
  const { alerts } = evaluateAlerts(rec("2026-10-05", { sessions: { real: 2, bot: 4, total: 6, bot_pct: 66.7 } }), H([]));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "BOT_RATIO_HIGH"); assert.equal(alerts[0].current, 66.7); assert.equal(alerts[0].total_sessions, 6);
});

test("17) bot orani <= %50 alert vermez: tam %50 sinir degeri dahil (kesin buyuk)", () => {
  assert.equal(evaluateAlerts(rec("2026-10-05", { sessions: { real: 5, bot: 5, total: 10, bot_pct: 50 } }), H([])).alerts.length, 0);
  assert.equal(evaluateAlerts(rec("2026-10-05", { sessions: { real: 9, bot: 1, total: 10, bot_pct: 10 } }), H([])).alerts.length, 0);
});

test("18) yetersiz oturum (< 5) alert vermez; tam 5 sinirinda verir; oturum UNKNOWN ise degerlendirilmez", () => {
  assert.equal(evaluateAlerts(rec("2026-10-05", { sessions: { real: 1, bot: 3, total: 4, bot_pct: 75 } }), H([])).alerts.length, 0);
  assert.equal(evaluateAlerts(rec("2026-10-05", { sessions: { real: 2, bot: 3, total: 5, bot_pct: 60 } }), H([])).alerts.length, 1);
  const u = evaluateAlerts(rec("2026-10-05", { sessions: { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" } }), H([]));
  assert.equal(u.alerts.length, 0); assert.match(u.evaluation.reasons.join(), /SESSIONS_UNKNOWN/);
});

test("18b) baz yokken friction icin 'ilk kez gorulen' alert'i URETILMEZ (bilincli fark), bot mutlak kontrol calisir", async () => {
  const d = dirs();
  const { out } = await daily(d, 5, { pamistanbul: { dead: 40, traffic: [1, 9] } }, ["pamistanbul"]);
  assert.deepEqual(out.alerts.map((a) => a.kind), ["BOT_RATIO_HIGH"]);
  assert.match(out.evaluations[0].reasons.join(), /NO_BASELINE/);
});

// --- 19: izolasyon ------------------------------------------------------------------------------------------

test("19) bir sitenin hatasi digerlerini ZEHIRLEMEZ: A 403, B ve C gercek olcum; A'nin kaydi UNKNOWN", async () => {
  const d = dirs();
  const { out } = await daily(d, 5, { pamistanbul: { status: 403 }, spryhand: { dead: 4, traffic: [10, 2] }, decideplan: { rage: 1 } }, ["pamistanbul", "spryhand", "decideplan"]);
  const by = Object.fromEntries(out.sites.map((s) => [s.site_id, s.record!]));
  assert.equal(by.pamistanbul.measurement_state, "ERROR");
  assert.equal(by.spryhand.usable, true); assert.equal(by.spryhand.friction.dead_click_count, 4); assert.deepEqual(by.spryhand.sessions.real, 10);
  assert.equal(by.decideplan.friction.rage_click_count, 1);
  assert.equal(hist(d, "spryhand").records[0].site_id, "spryhand");
});

test("19b) bozuk gecmis dosyasi yalniz KENDI sitesini durdurur: kota harcanmaz, ustune yazilmaz; digerleri olculur", async () => {
  const d = dirs();
  await daily(d, 4, { pamistanbul: {}, spryhand: {} }, ["pamistanbul", "spryhand"]);
  writeFileSync(join(d.historyDir, "pamistanbul.json"), "{bozuk");
  const { out, calls } = await daily(d, 5, { pamistanbul: {}, spryhand: {} }, ["pamistanbul", "spryhand"]);
  assert.equal(out.sites.find((s) => s.site_id === "pamistanbul")!.action, "HISTORY_ERROR");
  assert.equal(calls.filter((c) => c.site === "pamistanbul").length, 0);
  assert.equal(readFileSync(join(d.historyDir, "pamistanbul.json"), "utf8"), "{bozuk");
  assert.equal(out.sites.find((s) => s.site_id === "spryhand")!.action, "MEASURED");
  assert.equal(hist(d, "spryhand").records.length, 2);
});

test("19c) gecmis dogrulama fail-closed: yanlis site, yinelenen gun, sirasiz kayit, tutarsiz usable, bozuk sema", () => {
  const j = (x: unknown) => JSON.stringify(x);
  assert.doesNotThrow(() => parseHistory(j(H([rec("2026-10-01"), rec("2026-10-02")])), "pamistanbul"));
  const bad: [string, string][] = [
    ["yanlis site", j({ ...H([]), site_id: "spryhand" })],
    ["yinelenen gun", j(H([rec("2026-10-01"), rec("2026-10-01")]))],
    ["sirasiz", j(H([rec("2026-10-02"), rec("2026-10-01")]))],
    ["usable ama eksik", j(H([rec("2026-10-01", { rows_complete: false })]))],
    ["yabanci kayit", j(H([{ ...rec("2026-10-01"), site_id: "spryhand" }]))],
    ["sema", j({ schema: "x", site_id: "pamistanbul", records: [] })],
    ["negatif sayi", j(H([rec("2026-10-01", { friction: { dead_click_count: -1 as never } })]))],
  ];
  for (const [name, text] of bad) assert.throws(() => parseHistory(text, "pamistanbul"), HistoryError, name);
});

// --- 20-22: cikti, workflow, concurrency ----------------------------------------------------------------------

test("20) alert makine-okunur: clarity-alerts.json semasi, alertler, degerlendirme kapsami; kayitta ham yanit yok", async () => {
  const d = dirs();
  await daily(d, 5, { pamistanbul: { dead: 1 } }, ["pamistanbul"]);
  await daily(d, 6, { pamistanbul: { dead: 6, traffic: [1, 9] } }, ["pamistanbul"]);
  const j = JSON.parse(readFileSync(join(d.outDir, "clarity-alerts.json"), "utf8"));
  assert.equal(j.schema, "sgos.clarity.alerts.v1"); assert.equal(j.date, "2026-10-06");
  assert.deepEqual(j.alerts.map((a: { kind: string }) => a.kind).sort(), ["BOT_RATIO_HIGH", "FRICTION_INCREASE"]);
  assert.equal(j.evaluations[0].baseline_date, "2026-10-05");
  assert.ok(j.alerts.every((a: { evidence_label: string; confidence: string; review: string }) => a.evidence_label === "FACT" && a.confidence === "CONFIRMED" && a.review === "REVIEW_REQUIRED"));
  assert.ok(!("results" in j) && !("metrics" in j));
  assert.ok(readFileSync(join(d.historyDir, "pamistanbul.json"), "utf8").length < 6000);
});

test("21) workflow summary: clarity-daily.md alert + kapsam + HTTP sayisi yazar ve workflow bunu GITHUB_STEP_SUMMARY'ye ekler", async () => {
  const d = dirs();
  await daily(d, 5, { pamistanbul: { dead: 1 } }, ["pamistanbul"]);
  const { out } = await daily(d, 6, { pamistanbul: { dead: 6 }, spryhand: { status: 403 } }, ["pamistanbul", "spryhand"]);
  const md = readFileSync(join(d.outDir, "clarity-daily.md"), "utf8");
  assert.match(md, /# Clarity günlük toplama — 2026-10-06/);
  assert.match(md, /FRICTION_INCREASE/); assert.match(md, /REVIEW_REQUIRED/); assert.match(md, /NOT_EVALUATED/); assert.match(md, /HTTP denemesi: /);
  assert.equal(md, dailyMarkdown(out));
  const wf = readFileSync(join(ROOT, ".github/workflows/clarity-daily.yml"), "utf8");
  assert.match(wf, /cat clarity-out\/clarity-daily\.md[^\n]*\n?[^\n]*>> "\$GITHUB_STEP_SUMMARY"/);
});

const WF = readFileSync(join(ROOT, ".github/workflows/clarity-daily.yml"), "utf8");
const WFC = WF.replace(/^\s*#.*$/gm, "");

test("22) concurrency/cift-kosu guvenligi: clarity.yml ile AYNI grup, iptal yok; zamanlanmis koşu cutover bayragina bagli, elle kosu degil", () => {
  assert.match(WFC, /concurrency:\s*\n\s*group: clarity\s*\n\s*cancel-in-progress: false/);
  assert.match(readFileSync(join(ROOT, ".github/workflows/clarity.yml"), "utf8"), /concurrency:\s*\n\s*group: clarity\s*\n\s*cancel-in-progress: false/);
  assert.match(WFC, /schedule:\s*\n\s*#?[^\n]*\n?\s*- cron: "20 7 \* \* \*"/);
  assert.match(WFC, /if: github\.event_name == 'workflow_dispatch' \|\| vars\.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'/);
  assert.match(WFC, /FORCE_FLAG="--force"/);
  assert.match(WFC, /force:[\s\S]*default: false/);
});

test("22b) workflow guvenligi: secret yalniz env, inputs run'a yorumsuz girmez, yazma yalniz data/clarity-history, yalniz main, production/Vercel yok", () => {
  assert.match(WFC, /SEARCH_GROWTH_CLARITY_TOKENS_JSON: \$\{\{ secrets\.SEARCH_GROWTH_CLARITY_TOKENS_JSON \}\}/);
  for (const line of WFC.split("\n").filter((l) => l.includes("${{ inputs."))) assert.match(line, /^\s+[A-Z_]+: \$\{\{ inputs\.\w+ \}\}$/, line);
  assert.match(WFC, /persist-history\.sh -m .*\\\n\s+data\/clarity-history\/\n/); // yazma yolu artik ortak betige arguman (docs/persistence-safety.md)
  assert.ok(!/git add (-A|\.|--all)/.test(WFC));
  assert.match(WFC, /github\.ref == 'refs\/heads\/main'/);
  assert.ok(!/git push/.test(WFC)); // fetch+rebase+retry+push artik scripts/persist-history.sh icinde (tests/persist-history.test.ts)
  assert.ok(!/curl\b|vercel|-X\s*(POST|PUT|DELETE|PATCH)|gh\s+(pr|api)|--token|set -x|echo .*TOKEN|ANTHROPIC|brain-run/i.test(WFC));
  assert.match(WFC, /permissions:\s*\n\s*contents: write/);
  assert.match(WFC, /retention-days: 30/);
  // eski clarity.yml degismedi: hala yalniz elle, salt-okunur
  const old = readFileSync(join(ROOT, ".github/workflows/clarity.yml"), "utf8");
  assert.ok(!/schedule:|cron:/.test(old.split(/^permissions:/m)[0])); assert.match(old, /permissions:\s*\n\s*contents: read/);
});

test("22c) gunluk modul eski sisteme baglanmaz (yorumsuz kod): eski env, repo adi, script adi yok; ag/fetch dogrudan yok", () => {
  const code = readFileSync(join(ROOT, "src/clarity-daily.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of [/(?<!SEARCH_GROWTH_)CLARITY_TOKENS_JSON/, /site-health-monitor/i, /daily_health_check/, /\bfetch\(/, /process\.env/, /Authorization/]) assert.ok(!bad.test(code), String(bad));
  const wf = WFC;
  for (const bad of [/(?<!SEARCH_GROWTH_)CLARITY_TOKENS_JSON/, /site-health-monitor/i, /daily_health_check/]) assert.ok(!bad.test(wf), String(bad));
});

// --- CLI (yalniz cevrimdisi yollar) -----------------------------------------------------------------------

function cli(cwd: string, env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "src/cli.ts"), ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
}

test("CLI) token yok: 7 site NOT_CONNECTED, ag yok, cikis 0, kayitlar UNKNOWN; token argumani reddedilir ve yankilanmaz", () => {
  const d = dirs();
  const r = cli(d.root, {}, "clarity-daily", join(ROOT, "config/sites.yaml"), "--out", d.outDir, "--history", d.historyDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/NOT_CONNECTED/g) ?? []).length, 7);
  assert.match(r.stdout, /HTTP denemesi 0/);
  for (const id of SITES) { const h = JSON.parse(readFileSync(join(d.historyDir, `${id}.json`), "utf8")); assert.equal(h.records[0].usable, false); assert.equal(h.records[0].sessions.real, "UNKNOWN"); }
  const bad = cli(d.root, {}, "clarity-daily", join(ROOT, "config/sites.yaml"), "--token", "SUPER-SECRET-VALUE-123");
  assert.equal(bad.status, 1); assert.ok(!(bad.stdout + bad.stderr).includes("SUPER-SECRET-VALUE-123"));
  assert.equal(cli(d.root, {}, "clarity-daily", join(ROOT, "config/sites.yaml"), "--site", "yok").status, 1);
  const noWrite = mkdtempSync(join(tmpdir(), "clrn-"));
  assert.equal(cli(d.root, {}, "clarity-daily", join(ROOT, "config/sites.yaml"), "--out", join(noWrite, "o"), "--history", join(noWrite, "h"), "--no-write-history", "--site", "spryhand").status, 0);
  assert.ok(!existsSync(join(noWrite, "h")));
});

test("CLI) ayni UTC gun ikinci kosu: eski env adi OKUNMAZ; gunluk komut yalniz kanonik secret'i kullanir", () => {
  const d = dirs();
  const r = cli(d.root, { CLARITY_TOKENS_JSON: JSON.stringify({ pamistanbul: "TOK-LEGACY-SECRET-123456" }) }, "clarity-daily", join(ROOT, "config/sites.yaml"), "--out", d.outDir, "--history", d.historyDir, "--site", "pamistanbul");
  assert.match(r.stdout, /NOT_CONNECTED pamistanbul/);
  assert.ok(!(r.stdout + r.stderr).includes("TOK-LEGACY-SECRET-123456"));
  assert.equal(CLARITY_ENV, "SEARCH_GROWTH_CLARITY_TOKENS_JSON");
});

test("hasUsableForDate + toRecord: gercek measureSite sonucundan kayit; is_zero gercek sifir gunu kullanilamaz (baz olmaz)", async () => {
  const fetchFn: FetchFn = async () => ({ status: 200, text: async () => "[]" });
  const r = await measureSite("pamistanbul", TOK("pamistanbul"), { fetchFn, sleep, now: () => DAY(5) });
  const record = toRecord(r, "12345");
  assert.equal(r.is_zero, true);
  assert.equal(record.usable, false); assert.equal(record.source_run_id, "12345");
  assert.equal(hasUsableForDate(H([record]), "2026-10-05"), false);
  assert.equal(toRecord(r, "bozuk-id").source_run_id, undefined);
});
