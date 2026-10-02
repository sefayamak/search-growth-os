// Takeover durum degerlendiricisi: UCTAN UCA. Gercek giris noktasi (bin/clarity-takeover-status.ts, child process, --json) ve modul API'si.
// Fixture'lar gecici dizinde, REGISTRY'DEKI 7 gercek site icin, uretim dogrulayicisindan (parseHistory) gecirilerek yazilir.
// Ag yok, Clarity cagrisi yok, repo'nun gercek data/'si yalniz OKUNUR (son testler). Gelecekteki `clarity-takeover-status` CLI alt komutu
// ayni modulu cagiracagi icin JSON alanlari (schema, days, chain_*, site_problems, owner_checklist, legacy_takeover_complete) uzerinden dogrulanir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../src/registry.ts";
import {
  HISTORY_SCHEMA, HISTORY_MAX_RECORDS, FRICTION_KEYS, HistoryError, loadHistory, mergeRecord, parseHistory, runDaily, saveHistory,
  measurementSuccessOf, type DailyRecord, type HistoryFile,
} from "../src/clarity-daily.ts";
import { loadAndEvaluate, STATUS_SCHEMA, type TakeoverStatus } from "../src/clarity-takeover-status.ts";
import type { FetchFn } from "../src/adapters/clarity.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const REG = join(ROOT, "config/sites.yaml");
const SITES = loadRegistry(REG).registry!.sites.map((s) => s.id);
const BIN = join(ROOT, "bin/clarity-takeover-status.ts");

// --- fixture kurucu ---------------------------------------------------------------------------------------

type Kind = "OK" | "ZERO" | "PARTIAL" | "NOT_CONNECTED" | "ROWS_INCOMPLETE" | "ERROR";
interface Cell { kind?: Kind; run?: string | null; t?: string }
interface DaySpec { date: string; run: string | null; cells?: Record<string, Cell | null> }

const unk = { real: "UNKNOWN", bot: "UNKNOWN", total: "UNKNOWN", bot_pct: "UNKNOWN" } as const;
const zeroFr = Object.fromEntries(FRICTION_KEYS.map((k) => [k, 0])) as DailyRecord["friction"];
const unkFr = Object.fromEntries(FRICTION_KEYS.map((k) => [k, "UNKNOWN"])) as DailyRecord["friction"];

function record(site: string, date: string, i: number, c: Cell, run: string | null): DailyRecord {
  const kind = c.kind ?? "OK";
  const base = {
    site_id: site, date, measured_at: c.t ?? `${date}T07:20:${String(10 + i).padStart(2, "0")}.000Z`,
    row_count: 10, metric_row_count_total: 10, max_metric_row_count: 2,
  };
  const failed = { friction: unkFr, friction_total: "UNKNOWN" as const, sessions: { ...unk }, usable: false, measurement_success: false };
  let r: DailyRecord;
  if (kind === "OK") r = { ...base, measurement_state: "MEASURED", confidence: "CONFIRMED", rows_complete: true, is_zero: false, measurement_success: true, usable: true, friction: zeroFr, friction_total: 0, sessions: { real: 20, bot: 5, total: 25, bot_pct: 20 } };
  else if (kind === "ZERO") r = { ...base, row_count: 0, metric_row_count_total: 0, max_metric_row_count: 0, measurement_state: "MEASURED", confidence: "CONFIRMED", rows_complete: true, is_zero: true, measurement_success: true, usable: false, friction: zeroFr, friction_total: 0, sessions: { real: 0, bot: 0, total: 0, bot_pct: "UNKNOWN" } };
  else if (kind === "PARTIAL") r = { ...base, measurement_state: "PARTIAL", confidence: "CANDIDATE", rows_complete: false, is_zero: false, ...failed };
  else if (kind === "ROWS_INCOMPLETE") r = { ...base, measurement_state: "MEASURED", confidence: "CONFIRMED", rows_complete: false, is_zero: false, ...failed };
  else if (kind === "NOT_CONNECTED") r = { ...base, row_count: "UNKNOWN", metric_row_count_total: "UNKNOWN", max_metric_row_count: "UNKNOWN", measurement_state: "NOT_CONNECTED", confidence: "UNKNOWN", rows_complete: "UNKNOWN", is_zero: false, ...failed };
  else r = { ...base, row_count: "UNKNOWN", metric_row_count_total: "UNKNOWN", max_metric_row_count: "UNKNOWN", measurement_state: "ERROR", confidence: "UNKNOWN", rows_complete: "UNKNOWN", is_zero: false, ...failed, error_code: "FORBIDDEN" };
  if (run) r.source_run_id = run;
  return r;
}

/** Gecici history dizini yazar. Her dosya uretim parseHistory'sinden gecirilir: fixture gecersizse test fixture asamasinda patlar. */
function writeHistory(days: DaySpec[], dir = mkdtempSync(join(tmpdir(), "tk-e2e-"))): string {
  for (const [i, site] of SITES.entries()) {
    let h: HistoryFile = { schema: HISTORY_SCHEMA, site_id: site, max_records: HISTORY_MAX_RECORDS, records: [] };
    for (const d of days) {
      const c = d.cells?.[site];
      if (c === null) continue; // bu sitenin o gun kaydi yok
      h = mergeRecord(h, record(site, d.date, i, c ?? {}, c && "run" in c ? c.run ?? null : d.run)).file;
    }
    parseHistory(JSON.stringify(h), site); // uretim dogrulayicisi
    saveHistory(dir, h);
  }
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex"); } };
  walk(dir);
  return out;
}

// --- gercek giris noktasi ---------------------------------------------------------------------------------

function runBin(histDir: string, env: Record<string, string> = {}) {
  const p = spawnSync(process.execPath, ["--experimental-strip-types", BIN, REG, "--history", histDir, "--json"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(p.status, 0, `bin cikis kodu ${p.status}: ${p.stderr}`);
  return JSON.parse(p.stdout) as TakeoverStatus;
}
/** Child process JSON'u ile modul API'si ayni sonucu vermeli (gelecekteki CLI alt komutu modulu cagiracak). */
function evalBoth(dir: string): TakeoverStatus {
  const viaBin = runBin(dir);
  assert.deepEqual(viaBin, JSON.parse(JSON.stringify(loadAndEvaluate(REG, dir))));
  return viaBin;
}

function ownerPending(s: TakeoverStatus) {
  assert.equal(s.schema, STATUS_SCHEMA);
  assert.equal(s.schema, "sgos.clarity-takeover-status.v2");
  assert.deepEqual(s.owner_checklist.map((c) => c.step), ["legacy_disable", "credential_rotation", "flag_set", "first_scheduled_verification"]);
  assert.ok(s.owner_checklist.every((c) => c.state === "OWNER_ACTION_PENDING"));
  assert.equal(s.legacy_takeover_complete, false);
  assert.deepEqual(s.sites, SITES);
}
function expectDay(s: TakeoverStatus, i: number, status: string, freshness: string, chain: string) {
  ownerPending(s);
  assert.equal(s.days[i].status, status, JSON.stringify(s.days[i]));
  assert.equal(s.days[i].freshness, freshness);
  assert.equal(s.chain_state, chain);
}
const notes = (s: TakeoverStatus, i: number) => s.days[i].notes.join(" | ");

// --- Day A / Day B ----------------------------------------------------------------------------------------

test("Day A: 7/7 ayni run id, dakikalar icinde => FULL, FRESH_7_OF_7, qualifying_run_id, 1_OF_2", () => {
  const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "40000000001" }]));
  expectDay(s, 0, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_1_OF_2");
  assert.equal(s.days[0].qualifying_run_id, "40000000001");
  assert.equal(s.days[0].guard_skips_observed, 0);
  assert.equal(s.days[0].measurement_success_sites.length, 7);
  assert.deepEqual(s.days[0].runs, [{ run_id: "40000000001", sites: SITES }]);
  assert.deepEqual(s.chain_days, ["2026-10-10"]);
  assert.deepEqual(s.site_problems, []);
});

test("Day B: ertesi UTC gun, FARKLI yuksek run id => 2_OF_2, chain_days iki gun", () => {
  const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "40000000001" }, { date: "2026-10-11", run: "40000000999" }]));
  assert.deepEqual(s.days.map((d) => d.status), ["FULL_TAKEOVER_SUCCESS", "FULL_TAKEOVER_SUCCESS"]);
  expectDay(s, 1, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_2_OF_2");
  assert.equal(s.days[1].qualifying_run_id, "40000000999");
  assert.deepEqual(s.chain_days, ["2026-10-10", "2026-10-11"]);
  assert.deepEqual(s.chain_notes, []);
});

// --- tek-site arizalari: FULL iddia edilmez, neden yazilir --------------------------------------------------

const oneBad: [string, Cell | null, RegExp][] = [
  ["site history'de o gun yok", null, /o gun kayit yok/],
  ["PARTIAL", { kind: "PARTIAL" }, /measurement_success=false/],
  ["NOT_CONNECTED", { kind: "NOT_CONNECTED" }, /measurement_success=false/],
  ["rows_complete=false", { kind: "ROWS_INCOMPLETE" }, /measurement_success=false/],
  ["ERROR", { kind: "ERROR" }, /measurement_success=false/],
];
for (const [name, cell, why] of oneBad) {
  test(`ariza: ${name} => NOT_SUCCESS, FULL yok, neden raporda`, () => {
    const bad = SITES[3];
    const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "500", cells: { [bad]: cell } }]));
    expectDay(s, 0, "NOT_SUCCESS", "UNKNOWN", "NONE");
    assert.equal(s.days[0].qualifying_run_id, null);
    assert.deepEqual(s.days[0].measurement_failed_sites.map((f) => f.site_id), [bad]);
    assert.match(s.days[0].measurement_failed_sites[0].reason, why);
    assert.equal(s.days[0].measurement_success_sites.length, 6);
  });
}

test("DOGRULANMIS SIFIR: 6 sifir-olmayan + 1 confirmed-zero ayni run id => FULL; usable != measurement_success", () => {
  const z = SITES[6];
  const dir = writeHistory([{ date: "2026-10-10", run: "600", cells: { [z]: { kind: "ZERO" } } }]);
  const s = evalBoth(dir);
  expectDay(s, 0, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_1_OF_2");
  assert.ok(s.days[0].measurement_success_sites.includes(z));
  const rec = loadHistory(dir, z).records[0];
  assert.equal(rec.is_zero, true);
  assert.equal(rec.usable, false);               // analiz uygunlugu: baz olamaz
  assert.equal(measurementSuccessOf(rec), true); // takeover olcutu: basarili
  assert.ok(SITES.slice(0, 6).every((id) => { const r = loadHistory(dir, id).records[0]; return r.usable && measurementSuccessOf(r); }));
});

// --- run id kanit tutarsizliklari ---------------------------------------------------------------------------

test("karisik run id: 6 site X, 1 site Y (Y > X) => COVERAGE, NOT_FULL, guard atlama sayisi raporlanir", () => {
  const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "700", cells: { [SITES[0]]: { run: "701" } } }]));
  expectDay(s, 0, "COVERAGE_VALIDATION_SUCCESS", "NOT_FULL", "NONE");
  assert.equal(s.days[0].qualifying_run_id, null);
  assert.equal(s.days[0].latest_run_id, "701");
  // Kod: guard atlama = EN BUYUK id'yi tasimayan basarili kayit sayisi (burada 6 site 700'de kaldi).
  assert.equal(s.days[0].guard_skips_observed, 6);
  assert.deepEqual(s.days[0].runs.map((r) => [r.run_id, r.sites.length]), [["700", 6], ["701", 1]]);
  assert.match(notes(s, 0), /2 farkli kosudan/);
});

test("karisik run id (gercek 2026-10-02 sekli): 6 site yeni kosuda, 1 site eski kosudan miras => guard atlama 1", () => {
  const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "800", cells: { [SITES[0]]: { run: "799" } } }]));
  expectDay(s, 0, "COVERAGE_VALIDATION_SUCCESS", "NOT_FULL", "NONE");
  assert.equal(s.days[0].guard_skips_observed, 1);
  assert.equal(s.days[0].latest_run_id, "800");
});

test("ayni run id iki UTC gunde => her iki gun INCONSISTENT, zincir kirilir", () => {
  const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "900" }, { date: "2026-10-11", run: "900" }]));
  ownerPending(s);
  assert.deepEqual(s.days.map((d) => d.status), ["INCONSISTENT", "INCONSISTENT"]);
  assert.match(notes(s, 0), /birden fazla UTC gunde/);
  assert.match(notes(s, 0), /hicbir basari iddia edilmedi/);
  assert.equal(s.chain_state, "NONE");
  assert.deepEqual(s.chain_days, []);
  assert.ok(s.days.every((d) => d.qualifying_run_id === null));
});

test("ayni run id icinde >15 dk measured_at yayilimi => INCONSISTENT; tam 15 dk SINIRDA kabul", () => {
  const spread = (last: string) => evalBoth(writeHistory([{ date: "2026-10-10", run: "1000", cells: { [SITES[6]]: { t: last } } }]));
  const bad = spread("2026-10-10T07:36:00.000Z"); // ilk kayit 07:20:10 -> 15 dk 50 sn
  expectDay(bad, 0, "INCONSISTENT", "FRESH_7_OF_7", "NONE");
  assert.match(notes(bad, 0), /dk araliga yayilmis/);
  assert.equal(bad.days[0].qualifying_run_id, null);
  const edge = spread("2026-10-10T07:35:10.000Z"); // tam 15 dk
  expectDay(edge, 0, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_1_OF_2");
});

test("run id tarihle SAYISAL (BigInt) karsilastirilir: 99 -> 100 gecerli, 100 -> 99 INCONSISTENT, 20 haneli id", () => {
  const ok = evalBoth(writeHistory([{ date: "2026-10-10", run: "99" }, { date: "2026-10-11", run: "100" }]));
  expectDay(ok, 1, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_2_OF_2"); // metin siralamasinda "100" < "99" olurdu
  const rev = evalBoth(writeHistory([{ date: "2026-10-10", run: "100" }, { date: "2026-10-11", run: "99" }]));
  assert.deepEqual(rev.days.map((d) => d.status), ["INCONSISTENT", "INCONSISTENT"]);
  assert.match(notes(rev, 0), /run id sirasi tarihle celisiyor \(100 >= 99/);
  assert.equal(rev.chain_state, "NONE");
  // 20 hane (parseHistory siniri): Number hassasiyetini asar, BigInt farki gorur.
  const big = evalBoth(writeHistory([{ date: "2026-10-10", run: "19999999999999999998" }, { date: "2026-10-11", run: "19999999999999999999" }]));
  assert.equal(big.chain_state, "FULL_TAKEOVER_2_OF_2");
});

test("source_run_id eksik: bazi kayitlarda ya da hepsinde => tazelik UNKNOWN, en fazla COVERAGE", () => {
  const some = evalBoth(writeHistory([{ date: "2026-10-10", run: "1100", cells: { [SITES[2]]: { run: null }, [SITES[5]]: { run: null } } }]));
  expectDay(some, 0, "COVERAGE_VALIDATION_SUCCESS", "UNKNOWN", "NONE");
  assert.deepEqual(some.days[0].unattributed_sites, [SITES[2], SITES[5]]);
  assert.equal(some.days[0].guard_skips_observed, "UNKNOWN");
  assert.match(notes(some, 0), /source_run_id yok/);
  const all = evalBoth(writeHistory([{ date: "2026-10-10", run: null }, { date: "2026-10-11", run: null }]));
  expectDay(all, 1, "COVERAGE_VALIDATION_SUCCESS", "UNKNOWN", "NONE");
  assert.ok(all.days.every((d) => d.status !== "FULL_TAKEOVER_SUCCESS" && d.qualifying_run_id === null));
  assert.ok(all.chain_notes.some((n) => /UNKNOWN/.test(n)));
});

// --- GERCEK runDaily ile ayni-gun guard (first-success-wins) -------------------------------------------------

const TOK = (id: string) => `TOK-${id}-SECRET-9876543210`;
const okFetch: FetchFn = async () => ({ status: 200, text: async () => "[]" }); // dogrulanmis tam sifir = basarili olcum
const failFor = (bad: string): FetchFn => async (url, init) =>
  init.headers.Authorization === `Bearer ${TOK(bad)}` ? { status: 403, text: async () => "{}" } : okFetch(url, init);
const at = (day: number, min = 0) => () => new Date(Date.UTC(2026, 9, day, 7, 20 + min, 0));
const sleep = async () => {};
function daily(dir: string, run: string, now: () => Date, fetchFn: FetchFn, extra: { force?: boolean } = {}) {
  return runDaily({ siteIds: SITES, tokens: new Map(SITES.map((id) => [id, TOK(id)] as [string, string])), historyDir: join(dir, "h"), outDir: join(dir, "o"), fetchFn, sleep, now, sourceRunId: run, ...extra });
}

test("GERCEK runDaily: ayni gunde 2. kosu (ve --force) 1. kosunun kayitlarini DEGISTIRMEZ, gun 1. kosuya atfedilir => FULL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tk-e2e-rd-"));
  await daily(dir, "2000", at(10), okFetch);
  const before = snapshot(join(dir, "h"));
  const r2 = await daily(dir, "2001", at(10, 5), okFetch);
  assert.equal(r2.coverage.fresh_measurement_success, 0);
  assert.ok(r2.sites.every((x) => x.action === "SKIPPED_ALREADY_MEASURED_TODAY"));
  await daily(dir, "2002", at(10, 6), okFetch, { force: true });
  assert.deepEqual(snapshot(join(dir, "h")), before, "history dosyalari bayt bayt ayni kalmali");
  const s = evalBoth(join(dir, "h"));
  expectDay(s, 0, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_1_OF_2");
  assert.equal(s.days[0].qualifying_run_id, "2000");
  assert.deepEqual(s.days[0].runs.map((r) => r.run_id), ["2000"]);
});

test("GERCEK runDaily: 1. kosuda bir site hata verir, 2. kosu yalniz onu olcer => karisik id, COVERAGE, guard atlama 6; sonraki gun tek kosu FULL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tk-e2e-rd2-"));
  await daily(dir, "3000", at(10), failFor(SITES[1]));
  expectDay(evalBoth(join(dir, "h")), 0, "NOT_SUCCESS", "UNKNOWN", "NONE"); // hata kaydi basari degil
  await daily(dir, "3001", at(10, 5), okFetch);
  const s = evalBoth(join(dir, "h"));
  expectDay(s, 0, "COVERAGE_VALIDATION_SUCCESS", "NOT_FULL", "NONE");
  assert.equal(s.days[0].latest_run_id, "3001");
  assert.equal(s.days[0].guard_skips_observed, 6);
  await daily(dir, "3002", at(11), okFetch);
  const t = evalBoth(join(dir, "h"));
  expectDay(t, 1, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_1_OF_2");
  assert.deepEqual(t.chain_days, ["2026-10-11"]);
});

// --- zincir semantigi ----------------------------------------------------------------------------------------

test("zincir: iki FULL gun + FULL olmayan gun => sondan geriye sayilir, NONE (kod = belge)", () => {
  const s = evalBoth(writeHistory([
    { date: "2026-10-10", run: "4000" }, { date: "2026-10-11", run: "4001" },
    { date: "2026-10-12", run: "4003", cells: { [SITES[0]]: { run: "4002" } } }, // 1 site miras => COVERAGE
  ]));
  assert.deepEqual(s.days.map((d) => d.status), ["FULL_TAKEOVER_SUCCESS", "FULL_TAKEOVER_SUCCESS", "COVERAGE_VALIDATION_SUCCESS"]);
  assert.equal(s.chain_state, "NONE");
  assert.deepEqual(s.chain_days, []);
  ownerPending(s);
});

test("zincir: FULL, FULL-degil, FULL => araya giren gun zinciri kirar, 1_OF_2 (yalniz son gun)", () => {
  const s = evalBoth(writeHistory([
    { date: "2026-10-10", run: "4100" },
    { date: "2026-10-11", run: "4102", cells: { [SITES[0]]: { run: "4101" } } },
    { date: "2026-10-12", run: "4103" },
  ]));
  assert.deepEqual(s.days.map((d) => d.status), ["FULL_TAKEOVER_SUCCESS", "COVERAGE_VALIDATION_SUCCESS", "FULL_TAKEOVER_SUCCESS"]);
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
  assert.deepEqual(s.chain_days, ["2026-10-12"]);
});

test("zincir: takvim bosluklu iki FULL gun (veri yok) => 2_OF_2, bosluk chain_notes'ta bilgi olarak (belge: takvim bitisikligi istemez)", () => {
  const s = evalBoth(writeHistory([{ date: "2026-10-10", run: "4200" }, { date: "2026-10-13", run: "4300" }]));
  expectDay(s, 1, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_2_OF_2");
  assert.equal(s.days.length, 2); // veri olmayan gunler gun sayilmaz
  assert.equal(s.chain_notes.length, 1);
  assert.match(s.chain_notes[0], /2026-10-10 ile 2026-10-13 arasinda 2 takvim gunu veri yok/);
});

// --- bozuk / gecersiz history, ek dosyalar, bos dizin ----------------------------------------------------------

test("bozuk history dosyasi (1 site): yalniz o site site_problems'ta, FULL yok, dosya DEGISMEZ, diger 6 site basarili okunur", () => {
  const dir = writeHistory([{ date: "2026-10-10", run: "5000" }]);
  const bad = SITES[2];
  writeFileSync(join(dir, `${bad}.json`), "{bozuk");
  const before = snapshot(dir);
  const s = evalBoth(dir);
  expectDay(s, 0, "NOT_SUCCESS", "UNKNOWN", "NONE");
  assert.deepEqual(s.site_problems.map((p) => p.site_id), [bad]);
  assert.match(s.site_problems[0].problem, /JSON degil/);
  assert.deepEqual(s.days[0].measurement_failed_sites, [{ site_id: bad, reason: "history okunamadi" }]);
  assert.equal(s.days[0].measurement_success_sites.length, 6);
  assert.deepEqual(snapshot(dir), before);
});

test("gecersiz source_run_id ('abc', '12.5', '', 21 hane): parseHistory HistoryError => bin'de yalniz o site site_problems, FULL yok", () => {
  for (const bad of ["abc", "12.5", "", "123456789012345678901"]) {
    const dir = writeHistory([{ date: "2026-10-10", run: "5100" }]);
    const site = SITES[4];
    const h = JSON.parse(readFileSync(join(dir, `${site}.json`), "utf8")) as HistoryFile;
    h.records[0].source_run_id = bad;
    assert.throws(() => parseHistory(JSON.stringify(h), site), (e: unknown) => e instanceof HistoryError && /source_run_id gecersiz/.test((e as Error).message), `id=${JSON.stringify(bad)}`);
    writeFileSync(join(dir, `${site}.json`), JSON.stringify(h));
    const s = evalBoth(dir);
    expectDay(s, 0, "NOT_SUCCESS", "UNKNOWN", "NONE");
    assert.deepEqual(s.site_problems.map((p) => p.site_id), [site], `id=${JSON.stringify(bad)}`);
    assert.match(s.site_problems[0].problem, /source_run_id gecersiz/);
  }
});

test("fazladan bilinmeyen site dosyalari history dizininde: SESSIZCE YOKSAYILIR (registry'deki 7 site okunur; ne rapor ne hata)", () => {
  const dir = writeHistory([{ date: "2026-10-10", run: "5200" }]);
  const clean = evalBoth(dir);
  writeFileSync(join(dir, "unknownsite.json"), JSON.stringify({ schema: HISTORY_SCHEMA, site_id: "unknownsite", max_records: 120, records: [] }));
  writeFileSync(join(dir, "corrupt-extra.json"), "{bozuk");
  writeFileSync(join(dir, "README.md"), "x");
  const s = evalBoth(dir);
  assert.deepEqual(s, clean);
  assert.deepEqual(s.site_problems, []);
  assert.equal(s.days[0].status, "FULL_TAKEOVER_SUCCESS");
  assert.equal(s.sites.length, 7);
});

test("bos history dizini => gun yok, chain NONE, 7 site 'history okunamadi' DEGIL (dosya yok = bos gecmis), owner adimlari PENDING", () => {
  const s = evalBoth(mkdtempSync(join(tmpdir(), "tk-e2e-empty-")));
  ownerPending(s);
  assert.deepEqual(s.days, []);
  assert.equal(s.chain_state, "NONE");
  assert.deepEqual(s.chain_days, []);
  assert.deepEqual(s.site_problems, []);
});

test("commit'li gercek history (data/clarity-history, YALNIZ OKUNUR) => COVERAGE_VALIDATION_SUCCESS, chain NONE; dosyalar degismez", () => {
  const real = join(ROOT, "data/clarity-history");
  const before = snapshot(real);
  const s = evalBoth(real);
  ownerPending(s);
  const d = s.days.find((x) => x.date === "2026-10-02")!;
  assert.equal(d.status, "COVERAGE_VALIDATION_SUCCESS");
  assert.notEqual(d.freshness, "FRESH_7_OF_7");
  assert.ok(s.days.every((x) => x.status !== "FULL_TAKEOVER_SUCCESS"));
  assert.equal(s.chain_state, "NONE");
  assert.deepEqual(s.site_problems, []);
  assert.deepEqual(snapshot(real), before);
});

// --- yan etki yok / ag yok -----------------------------------------------------------------------------------

test("bin hicbir sey yazmaz: gecici dizin (ve cwd'deki repo data/) once/sonra ayni; stderr bos", () => {
  const dir = writeHistory([{ date: "2026-10-10", run: "6000" }, { date: "2026-10-11", run: "6001" }]);
  const before = snapshot(dir);
  const beforeRepo = snapshot(join(ROOT, "data"));
  const p = spawnSync(process.execPath, ["--experimental-strip-types", BIN, REG, "--history", dir, "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(p.status, 0);
  assert.equal(p.stderr.trim(), "");
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(snapshot(join(ROOT, "data")), beforeRepo);
  const md = spawnSync(process.execPath, ["--experimental-strip-types", BIN, REG, "--history", dir], { cwd: ROOT, encoding: "utf8" }); // markdown yolu da yazmaz
  assert.equal(md.status, 0);
  assert.match(md.stdout, /FULL_TAKEOVER_2_OF_2/);
  assert.equal((md.stdout.match(/OWNER_ACTION_PENDING/g) ?? []).length, 4);
  assert.deepEqual(snapshot(dir), before);
});

test("ag gerektirmez: HTTPS_PROXY/HTTP_PROXY/ALL_PROXY kapali porta (127.0.0.1:1) isaret ederken ayni sonuc", () => {
  const dir = writeHistory([{ date: "2026-10-10", run: "7000" }]);
  const proxied = runBin(dir, { HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "" });
  expectDay(proxied, 0, "FULL_TAKEOVER_SUCCESS", "FRESH_7_OF_7", "FULL_TAKEOVER_1_OF_2");
  assert.deepEqual(proxied, runBin(dir));
});
