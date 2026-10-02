// measurement_success (takeover olcutu) ile usable (yalniz analiz uygunlugu) ayrimi.
// Test odagi: dogrulanmis TAM SIFIR bir olcum basarisizlik degildir, UNKNOWN degildir, ama baz ve alert da uretmez;
// ayni gun tekrar API cagrisi yaptirmaz; sonradan gelen basarisiz kayit onu ezmez. Ag YOK: fetch enjekte edilir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureSite, type FetchFn } from "../src/adapters/clarity.ts";
import {
  HISTORY_SCHEMA, HISTORY_MAX_RECORDS, FRICTION_KEYS, runDaily, toRecord, mergeRecord, selectBaseline, evaluateAlerts, parseHistory,
  loadHistory, hasMeasurementSuccessForDate, hasUsableForDate, measurementSuccessOf, HistoryError, type DailyRecord, type HistoryFile, type FrictionKey, type Num,
} from "../src/clarity-daily.ts";

const SITE = "pamistanbul";
const TOKEN = "TOK-pamistanbul-SECRET-9876543210";
const DAY = (n: number) => new Date(Date.UTC(2026, 9, n, 7, 20, 0));
const sleep = async () => {};

// --- sahte Clarity -----------------------------------------------------------------------------------------

type Mode = "data" | "zero" | "traffic-zero-rows" | "403" | "partial" | "big";
const NAMES = ["DeadClickCount", "RageClickCount", "ScriptErrorCount", "ErrorClickCount", "ExcessiveScroll", "QuickbackClick"];

function body(kind: string, mode: Mode, dead = 0, traffic: [number, number] = [20, 5]): unknown {
  if (mode === "zero") return [];
  const dim = kind === "URL" ? { Url: "https://pamistanbul.com/p/a" } : kind === "Source" ? { Source: "google", Medium: "organic" } : { Device: "PC" };
  const out: unknown[] = [];
  for (const n of NAMES) {
    const rows: Record<string, unknown>[] = [{ ...dim, sessionsCount: 3, subTotal: n === "DeadClickCount" ? dead : 0 }];
    if (mode === "big" && n === "DeadClickCount") for (let i = 0; i < 1000; i++) rows.push({ ...dim, sessionsCount: 1, subTotal: 0 });
    out.push({ metricName: n, information: rows });
  }
  const [real, bot] = mode === "traffic-zero-rows" ? [0, 0] : traffic;
  out.push({ metricName: "Traffic", information: [{ ...dim, totalSessionCount: real, totalBotSessionCount: bot }] });
  return out;
}

function fake(mode: Mode | ((n: number, kind: string) => Mode), opts: { dead?: number; traffic?: [number, number] } = {}) {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    const kind = new URL(url).searchParams.get("dimension1") ?? "?";
    calls.push(kind);
    const m = typeof mode === "function" ? mode(calls.length, kind) : mode;
    if (m === "403") return { status: 403, text: async () => "{}" };
    if (m === "partial") return kind === "URL" ? { status: 500, text: async () => "{}" } : { status: 200, text: async () => JSON.stringify(body(kind, "data", opts.dead, opts.traffic)) };
    return { status: 200, text: async () => JSON.stringify(body(kind, m, opts.dead, opts.traffic)) };
  };
  return { fetchFn, calls };
}

function dirs() { const r = mkdtempSync(join(tmpdir(), "clrms-")); return { historyDir: join(r, "hist"), outDir: join(r, "out") }; }
const tokens = new Map([[SITE, TOKEN]]);
async function run(d: ReturnType<typeof dirs>, day: number, f: ReturnType<typeof fake>, over: Record<string, unknown> = {}) {
  return runDaily({ siteIds: [SITE], tokens, historyDir: d.historyDir, outDir: d.outDir, fetchFn: f.fetchFn, sleep, now: () => DAY(day), ...over });
}
const measure = (f: ReturnType<typeof fake>, token: string | undefined = TOKEN) => measureSite(SITE, token, { fetchFn: f.fetchFn, sleep, now: () => DAY(5) });

// --- kayit yardimcilari ------------------------------------------------------------------------------------

type RecOver = Omit<Partial<DailyRecord>, "friction"> & { friction?: Partial<Record<FrictionKey, Num>> };
function rec(date: string, over: RecOver = {}): DailyRecord {
  const friction = Object.fromEntries(FRICTION_KEYS.map((k) => [k, 0])) as DailyRecord["friction"];
  Object.assign(friction, over.friction ?? {});
  const { friction: _f, ...rest } = over;
  return {
    site_id: SITE, date, measured_at: `${date}T07:20:00.000Z`, measurement_state: "MEASURED", confidence: "CONFIRMED",
    row_count: 10, metric_row_count_total: 10, max_metric_row_count: 2, rows_complete: true, is_zero: false, usable: true,
    friction, friction_total: 0, sessions: { real: 20, bot: 5, total: 25, bot_pct: 20 }, ...rest,
  };
}
const zeroRec = (date: string, over: RecOver = {}) => rec(date, {
  row_count: 0, metric_row_count_total: 0, max_metric_row_count: 0, is_zero: true, usable: false, measurement_success: true,
  sessions: { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" }, ...over,
});
const failRec = (date: string, state: DailyRecord["measurement_state"], over: RecOver = {}) => rec(date, {
  measurement_state: state, confidence: "UNKNOWN", usable: false, measurement_success: false, rows_complete: "UNKNOWN", row_count: "UNKNOWN", metric_row_count_total: "UNKNOWN", max_metric_row_count: "UNKNOWN",
  friction: Object.fromEntries(FRICTION_KEYS.map((k) => [k, "UNKNOWN"])) as never, friction_total: "UNKNOWN", sessions: { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" }, ...over,
});
const H = (records: DailyRecord[]): HistoryFile => ({ schema: HISTORY_SCHEMA, site_id: SITE, max_records: HISTORY_MAX_RECORDS, records });

// --- 1-2: anlamsal tablo -----------------------------------------------------------------------------------

test("1) MEASURED + CONFIRMED + complete + sifir degil => measurement_success=true, usable=true", async () => {
  const r = toRecord(await measure(fake("data", { dead: 3 })));
  assert.equal(r.measurement_state, "MEASURED"); assert.equal(r.confidence, "CONFIRMED"); assert.equal(r.rows_complete, true);
  assert.equal(r.measurement_success, true); assert.equal(r.usable, true); assert.equal(r.is_zero, false);
});

test("2) MEASURED + CONFIRMED + complete + SIFIR => measurement_success=true, usable=false, is_zero=true (basarisizlik de UNKNOWN da degil)", async () => {
  const res = await measure(fake("zero"));
  const r = toRecord(res);
  assert.equal(res.measurement_state, "MEASURED"); assert.equal(res.confidence, "CONFIRMED"); assert.equal(res.rows_complete, true);
  assert.equal(r.measurement_success, true); assert.equal(r.usable, false); assert.equal(r.is_zero, true);
  assert.equal(r.row_count, 0, "sifir sayisi UNKNOWN degil, gercek 0");
  assert.equal(measurementSuccessOf(r), true);
});

// --- 3: ayni-gun guard (sifir dahil) ------------------------------------------------------------------------

test("3) dogrulanmis sifir + ayni UTC gun ikinci kosu => ek HTTP istegi 0; sifir kaydi korunur; kapsam measurement_success'e bakar", async () => {
  const d = dirs();
  const first = fake("zero");
  const a = await run(d, 5, first);
  assert.equal(first.calls.length, 3);
  assert.equal(a.sites[0].history_action, "ADDED");
  const before = readFileSync(join(d.historyDir, `${SITE}.json`), "utf8");
  const second = fake("data", { dead: 99 });
  const b = await run(d, 5, second);
  assert.equal(second.calls.length, 0, "ek HTTP yok");
  assert.equal(b.http_attempts, 0);
  assert.equal(b.sites[0].action, "SKIPPED_ALREADY_MEASURED_TODAY");
  assert.equal(readFileSync(join(d.historyDir, `${SITE}.json`), "utf8"), before, "dosya bayt-bayt ayni");
  assert.deepEqual(b.coverage, { total_sites: 1, measurement_success: 1, usable: 0, fresh_measurement_success: 0 });
  assert.ok(hasMeasurementSuccessForDate(loadHistory(d.historyDir, SITE), "2026-10-05"));
  assert.ok(!hasUsableForDate(loadHistory(d.historyDir, SITE), "2026-10-05"), "guard usable'a bakmaz; usable sifirda yine false");
});

test("3b) --force dogrulanmis sifiri ezmez: yeni olcum yazilmaz, KEPT_EXISTING", async () => {
  const d = dirs();
  await run(d, 5, fake("zero"));
  const before = readFileSync(join(d.historyDir, `${SITE}.json`), "utf8");
  const forced = await run(d, 5, fake("data", { dead: 7 }), { force: true });
  assert.equal(forced.sites[0].history_action, "KEPT_EXISTING");
  assert.equal(readFileSync(join(d.historyDir, `${SITE}.json`), "utf8"), before);
  assert.equal(forced.sites[0].fresh, true, "bu kosuda gercekten olculdu");
  assert.equal(forced.coverage.measurement_success, 1);
});

// --- 4-6: basarisiz durumlar ayni gun retry'i ENGELLEMEZ -----------------------------------------------------

test("4) NOT_CONNECTED + ayni gun retry => izin verilir, basarili olcum kaydi alir", async () => {
  const d = dirs();
  const a = await run(d, 5, fake("data"), { tokens: new Map() });
  assert.equal(a.sites[0].measurement_state, "NOT_CONNECTED");
  assert.equal(a.sites[0].record!.measurement_success, false);
  assert.equal(a.coverage.measurement_success, 0);
  const f = fake("data", { dead: 2 });
  const b = await run(d, 5, f);
  assert.equal(f.calls.length, 3, "retry gercekten API'ye gitti");
  assert.equal(b.sites[0].history_action, "REPLACED");
  assert.equal(b.sites[0].record!.measurement_success, true);
  assert.equal(b.coverage.measurement_success, 1);
});

test("5) ERROR + ayni gun retry => izin verilir", async () => {
  const d = dirs();
  const a = await run(d, 5, fake("403"));
  assert.equal(a.sites[0].measurement_state, "ERROR");
  assert.equal(a.sites[0].record!.measurement_success, false);
  assert.equal(a.sites[0].record!.usable, false);
  const f = fake("data");
  const b = await run(d, 5, f);
  assert.equal(f.calls.length, 3);
  assert.equal(b.sites[0].record!.measurement_success, true);
});

test("6) PARTIAL ve rows_complete=false => measurement_success=false, usable=false; ayni gun retry engellenmez", async () => {
  const d = dirs();
  const p = await run(d, 5, fake("partial"));
  assert.equal(p.sites[0].measurement_state, "PARTIAL");
  assert.equal(p.sites[0].record!.measurement_success, false);
  assert.equal(p.sites[0].record!.usable, false);
  const big = measure(fake("big"));
  const br = toRecord(await big);
  assert.equal(br.rows_complete, false);
  assert.equal(br.measurement_success, false); assert.equal(br.usable, false);
  const f = fake("data");
  const again = await run(d, 5, f);
  assert.equal(f.calls.length, 3, "PARTIAL sonrasi ayni gun retry calisir");
  assert.equal(again.sites[0].record!.measurement_success, true);
});

test("6b) tutarsiz girdi (CONFIRMED ama rows_complete=false) bile measurement_success=false: kural rows_complete'i ayrica arar", async () => {
  const base = await measure(fake("data"));
  for (const rc of [false, "UNKNOWN"] as const) {
    const r = toRecord({ ...base, rows_complete: rc });
    assert.equal(r.measurement_success, false, String(rc)); assert.equal(r.usable, false);
  }
  assert.equal(toRecord({ ...base, confidence: "CANDIDATE" }).measurement_success, false);
  assert.equal(toRecord({ ...base, measurement_state: "PARTIAL" }).measurement_success, false);
});

// --- 7-9: sifir baz/alert uretmez ---------------------------------------------------------------------------

test("7) dogrulanmis sifir baz OLAMAZ: onceki guvenilir (sifir-olmayan) gun baz kalir", () => {
  const h = H([rec("2026-10-01", { friction: { dead_click_count: 5 } }), zeroRec("2026-10-02"), zeroRec("2026-10-03")]);
  assert.equal(selectBaseline(h, "2026-10-04")!.date, "2026-10-01");
  assert.equal(selectBaseline(H([zeroRec("2026-10-02")]), "2026-10-03"), null);
});

test("8) dogrulanmis sifir friction alert uretmez (basari: NOT_EVALUATED/CONFIRMED_ZERO, hata degil)", () => {
  const h = H([rec("2026-10-01", { friction: { dead_click_count: 1 } })]);
  const z = zeroRec("2026-10-02", { friction: { dead_click_count: 9 } }); // imkansiz ama usable=false oldugu icin alert uretilmemeli
  const r = evaluateAlerts(z, h);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.evaluation.status, "NOT_EVALUATED");
  assert.match(r.evaluation.reasons.join(), /CONFIRMED_ZERO/);
  assert.equal(measurementSuccessOf(z), true);
});

test("9) sifir oturum => bot_pct UNKNOWN, bot alert yok (hem bos yanit hem sifir-satirli Traffic)", async () => {
  const a = toRecord(await measure(fake("zero")));
  assert.equal(a.sessions.bot_pct, "UNKNOWN"); assert.equal(a.sessions.total, "UNKNOWN");
  assert.equal(evaluateAlerts(a, H([])).alerts.length, 0);
  const b = toRecord(await measure(fake("traffic-zero-rows")));
  assert.deepEqual(b.sessions, { real: 0, bot: 0, total: 0, bot_pct: "UNKNOWN" });
  assert.equal(b.measurement_success, true);
  assert.equal(evaluateAlerts(b, H([])).alerts.filter((x) => x.kind === "BOT_RATIO_HIGH").length, 0);
});

// --- 10: gecmis koruma --------------------------------------------------------------------------------------

test("10) dogrulanmis sifir, sonradan gelen basarisiz/kullanilamaz sonucla EZILEMEZ (ilk basarili olcum kazanir)", () => {
  const z = H([zeroRec("2026-10-05")]);
  for (const bad of [failRec("2026-10-05", "NOT_CONNECTED"), failRec("2026-10-05", "ERROR", { error_code: "FORBIDDEN" }), failRec("2026-10-05", "PARTIAL"), rec("2026-10-05", { usable: false, rows_complete: false, confidence: "CANDIDATE", measurement_success: false })]) {
    const m = mergeRecord(z, bad);
    assert.equal(m.action, "KEPT_EXISTING");
    assert.equal(m.file.records[0].is_zero, true); assert.equal(m.file.records[0].measurement_success, true);
  }
  // basarili sifir, ayni gun gelen baska bir basarili olcumle de degismez (ilk basarili olcum kazanir)
  assert.equal(mergeRecord(z, rec("2026-10-05")).action, "KEPT_EXISTING");
  // ama basarisiz kayit basarili kayitla degisir
  assert.equal(mergeRecord(H([failRec("2026-10-05", "NOT_CONNECTED")]), zeroRec("2026-10-05")).action, "REPLACED");
});

test("10b) gercek akis: --force + basarisiz fetch dogrulanmis sifir kaydini degistirmez", async () => {
  const d = dirs();
  await run(d, 5, fake("zero"));
  const before = readFileSync(join(d.historyDir, `${SITE}.json`), "utf8");
  const out = await run(d, 5, fake("403"), { force: true });
  assert.equal(out.sites[0].measurement_state, "ERROR");
  assert.equal(out.sites[0].history_action, "KEPT_EXISTING");
  assert.equal(readFileSync(join(d.historyDir, `${SITE}.json`), "utf8"), before);
  assert.equal(out.sites[0].record!.is_zero, true, "etkin kayit hala dogrulanmis sifir");
  assert.equal(out.coverage.measurement_success, 1);
  assert.equal(out.coverage.fresh_measurement_success, 0, "bu kosuda taze basari yok (ERROR)");
});

// --- 11: geriye uyumluluk ----------------------------------------------------------------------------------

test("11) measurement_success alani olmayan eski kayitlar dogru yorumlanir; guard eski sifir kaydini da tanir", async () => {
  // 2026-10-02 oncesi bicim: alan YOK (main'deki gercek kayit sekilleri)
  const legacyUsable = rec("2026-10-02");
  const legacyZero = rec("2026-10-02", { row_count: 0, metric_row_count_total: 0, max_metric_row_count: 0, is_zero: true, usable: false, sessions: { real: 0, bot: 0, total: 0, bot_pct: "UNKNOWN" } });
  const legacyNotConnected: DailyRecord = failRec("2026-10-02", "NOT_CONNECTED");
  delete (legacyNotConnected as { measurement_success?: boolean }).measurement_success;
  for (const r of [legacyUsable, legacyZero, legacyNotConnected]) assert.ok(!("measurement_success" in r), "eski bicim: alan yok");
  assert.equal(measurementSuccessOf(legacyUsable), true);
  assert.equal(measurementSuccessOf(legacyZero), true, "eski sifir kaydi da basarili olcum");
  assert.equal(measurementSuccessOf(legacyNotConnected), false);
  assert.doesNotThrow(() => parseHistory(JSON.stringify(H([legacyZero])), SITE));
  // eski dosyadaki sifir kaydi guard'i tetikler
  const d = dirs();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(d.historyDir, { recursive: true });
  writeFileSync(join(d.historyDir, `${SITE}.json`), JSON.stringify(H([{ ...legacyZero, date: "2026-10-05", measured_at: "2026-10-05T07:00:00.000Z" }])));
  const f = fake("data");
  const out = await run(d, 5, f);
  assert.equal(f.calls.length, 0);
  assert.equal(out.sites[0].action, "SKIPPED_ALREADY_MEASURED_TODAY");
  assert.equal(out.coverage.measurement_success, 1);
  // eski basarisiz kayit retry'i engellemez
  writeFileSync(join(d.historyDir, `${SITE}.json`), JSON.stringify(H([{ ...legacyNotConnected, date: "2026-10-05", measured_at: "2026-10-05T07:00:00.000Z" }])));
  const g = fake("data");
  const out2 = await run(d, 5, g);
  assert.equal(g.calls.length, 3);
  assert.equal(out2.sites[0].record!.measurement_success, true);
});

test("11b) acik measurement_success kuraldan turetilenle UYUSMAZSA gecmis bozuk sayilir (fail-closed)", () => {
  const j = (x: unknown) => JSON.stringify(H([x as DailyRecord]));
  assert.doesNotThrow(() => parseHistory(j(rec("2026-10-01", { measurement_success: true })), SITE));
  assert.doesNotThrow(() => parseHistory(j(zeroRec("2026-10-01")), SITE));
  const bad: [string, unknown][] = [
    ["ERROR ama true", failRec("2026-10-01", "ERROR", { measurement_success: true })],
    ["basarili ama false", rec("2026-10-01", { measurement_success: false })],
    ["boolean degil", rec("2026-10-01", { measurement_success: "evet" as never })],
    ["usable ama basarisiz", rec("2026-10-01", { rows_complete: false, measurement_success: false, usable: true })],
    ["usable ve sifir", rec("2026-10-01", { is_zero: true, usable: true, measurement_success: true })],
  ];
  for (const [name, r] of bad) assert.throws(() => parseHistory(j(r), SITE), HistoryError, name);
});

// --- cikti -------------------------------------------------------------------------------------------------

test("12) kapsam ciktisi: JSON'da coverage + site basina measurement_success/usable/is_zero; markdown takeover olcutunu measurement_success yazar", async () => {
  const d = dirs();
  // 3 site: PAM zaten basarili (atlanir), B sifir, C hata
  const siteIds = [SITE, "spryhand", "decideplan"];
  await runDaily({ siteIds: [SITE], tokens, historyDir: d.historyDir, outDir: d.outDir, fetchFn: fake("data", { dead: 1 }).fetchFn, sleep, now: () => DAY(5) });
  const f: FetchFn = async (url, init) => {
    const t = init.headers.Authorization;
    const kind = new URL(url).searchParams.get("dimension1") ?? "?";
    if (t.includes("spryhand")) return { status: 200, text: async () => "[]" };
    if (t.includes("decideplan")) return { status: 403, text: async () => "{}" };
    return { status: 200, text: async () => JSON.stringify(body(kind, "data")) };
  };
  const out = await runDaily({ siteIds, tokens: new Map([[SITE, TOKEN], ["spryhand", "TOK-spryhand-SECRET-1111111"], ["decideplan", "TOK-decideplan-SECRET-2222222"]]), historyDir: d.historyDir, outDir: d.outDir, fetchFn: f, sleep, now: () => DAY(5) });
  assert.deepEqual(out.coverage, { total_sites: 3, measurement_success: 2, usable: 1, fresh_measurement_success: 1 });
  const j = JSON.parse(readFileSync(join(d.outDir, "clarity-alerts.json"), "utf8"));
  assert.deepEqual(j.coverage, out.coverage);
  const by = Object.fromEntries(j.sites.map((s: { site_id: string }) => [s.site_id, s]));
  assert.deepEqual([by[SITE].measurement_success, by[SITE].usable, by[SITE].is_zero], [true, true, false]);
  assert.deepEqual([by.spryhand.measurement_success, by.spryhand.usable, by.spryhand.is_zero], [true, false, true]);
  assert.deepEqual([by.decideplan.measurement_success, by.decideplan.usable, by.decideplan.is_zero], [false, false, false]);
  const md = readFileSync(join(d.outDir, "clarity-daily.md"), "utf8");
  assert.match(md, /Takeover ölçütü = ölçüm başarısı \(measurement_success\)\*\*: 2\/3/);
  assert.match(md, /usable, baz\/alert için; takeover ölçütü DEĞİL\): 1\/3/);
});

test("13) belge: takeover = gozlenebilirlik kapsami; dogrulanmis sifir basarili; usable takeover olcutu degil; 7/7 measurement_success", () => {
  const doc = readFileSync(new URL("../docs/integrations/clarity-daily.md", import.meta.url), "utf8");
  assert.match(doc, /observability coverage, not traffic volume/);
  assert.match(doc, /Confirmed complete zero response counts as a successful measurement/);
  assert.match(doc, /`usable` is an analysis\/baseline eligibility concept, not a migration success criterion/);
  assert.match(doc, /7\/7 `measurement_success=true`/);
});
