// Takeover zinciri degerlendiricisi: OFFLINE, ag yok. Odak: yanlis pozitif (taze kaniti olmadan FULL) ve yanlis negatif
// (gercek 7/7 taze kosuyu COVERAGE'a dusurmek), zincirin ayni gunu iki kez saymamasi, owner adimlarinin hep PENDING kalmasi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateTakeover, parseRunRecords, loadAndEvaluate, statusToMarkdown, type RunRecord } from "../src/clarity-takeover-status.ts";

const SITES = ["a", "b", "c", "d", "e", "f", "g"];
const allOk = (dates: string[], bad: Record<string, string[]> = {}) =>
  Object.fromEntries(SITES.map((s) => [s, Object.fromEntries(dates.map((d) => [d, !(bad[d] ?? []).includes(s)]))]));
const run = (date_utc: string, run_id: string, ms = 7, fresh = 7, total = 7): RunRecord => ({ date_utc, run_id, measurement_success: ms, fresh_measurement_success: fresh, total_sites: total });
const ev = (dates: string[], runs: RunRecord[] | null, bad: Record<string, string[]> = {}) => evaluateTakeover({ siteIds: SITES, successBySite: allOk(dates, bad), runRecords: runs });

test("kosu kaydi yok: 7/7 history COVERAGE olur, tazelik UNKNOWN, FULL iddia edilmez (yanlis pozitif)", () => {
  const s = ev(["2026-10-02", "2026-10-03"], null);
  assert.deepEqual(s.days.map((d) => d.status), ["COVERAGE_VALIDATION_SUCCESS", "COVERAGE_VALIDATION_SUCCESS"]);
  assert.ok(s.days.every((d) => d.freshness === "UNKNOWN"));
  assert.equal(s.chain_state, "NONE");
  assert.match(s.chain_notes.join(" "), /UNKNOWN/);
});

test("7/7 measurement + 7/7 taze kosu = FULL_TAKEOVER_SUCCESS (yanlis negatif olmasin)", () => {
  const s = ev(["2026-10-02"], [run("2026-10-02", "100")]);
  assert.equal(s.days[0].status, "FULL_TAKEOVER_SUCCESS");
  assert.equal(s.days[0].qualifying_run_id, "100");
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
});

test("7/7 measurement ama taze 6/7 (miras) = COVERAGE, FULL degil", () => {
  const s = ev(["2026-10-02"], [run("2026-10-02", "100", 7, 6)]);
  assert.equal(s.days[0].status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(s.days[0].freshness, "NOT_FULL");
  assert.equal(s.chain_state, "NONE");
});

test("ayni gun iki FULL kosu tek gun sayilir: 1_OF_2, 2_OF_2 degil", () => {
  const s = ev(["2026-10-02"], [run("2026-10-02", "100"), run("2026-10-02", "101")]);
  assert.equal(s.days.length, 1);
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
});

test("iki FARKLI UTC gun FULL = 2_OF_2", () => {
  const s = ev(["2026-10-02", "2026-10-03"], [run("2026-10-02", "100"), run("2026-10-03", "101")]);
  assert.equal(s.chain_state, "FULL_TAKEOVER_2_OF_2");
  assert.deepEqual(s.chain_days, ["2026-10-02", "2026-10-03"]);
});

test("arada FULL olmayan gun zinciri kirar; sonraki tek FULL 1_OF_2", () => {
  const s = ev(["2026-10-02", "2026-10-03", "2026-10-04"], [run("2026-10-02", "1"), run("2026-10-03", "2", 7, 5), run("2026-10-04", "3")]);
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
  assert.deepEqual(s.chain_days, ["2026-10-04"]);
});

test("son gun FULL degilse zincir NONE (onceki FULL gun yetmez)", () => {
  const s = ev(["2026-10-02", "2026-10-03"], [run("2026-10-02", "1"), run("2026-10-03", "2", 7, 3)]);
  assert.equal(s.chain_state, "NONE");
});

test("veri olmayan takvim gunu zinciri kirmaz ama not dusulur", () => {
  const s = ev(["2026-10-02", "2026-10-05"], [run("2026-10-02", "1"), run("2026-10-05", "2")]);
  assert.equal(s.chain_state, "FULL_TAKEOVER_2_OF_2");
  assert.match(s.chain_notes.join(" "), /2 takvim gunu/);
});

test("bir site measurement_success=false: NOT_SUCCESS; kosu 7/7 taze dese bile INCONSISTENT, basari yok", () => {
  const plain = ev(["2026-10-02"], null, { "2026-10-02": ["c"] });
  assert.equal(plain.days[0].status, "NOT_SUCCESS");
  assert.equal(plain.days[0].measurement_failed_sites[0].site_id, "c");
  const liar = ev(["2026-10-02"], [run("2026-10-02", "9")], { "2026-10-02": ["c"] });
  assert.equal(liar.days[0].status, "INCONSISTENT");
  assert.equal(liar.chain_state, "NONE");
});

test("sitenin o gun kaydi yok = basari sayilmaz (7/7 degil)", () => {
  const ok = allOk(["2026-10-02"]); delete ok.g["2026-10-02"];
  const s = evaluateTakeover({ siteIds: SITES, successBySite: ok, runRecords: [run("2026-10-02", "1")] });
  assert.equal(s.days[0].status, "INCONSISTENT");
  assert.match(s.days[0].measurement_failed_sites[0].reason, /kayit yok/);
});

test("kosu kaydi dogrulamasi: yanlis total_sites, tutarsiz sayilar, tekrar run_id atilir", () => {
  const p = parseRunRecords([
    run("2026-10-02", "1"), run("2026-10-02", "2", 7, 7, 6), run("2026-10-02", "3", 5, 6), run("2026-10-02", "1"),
    { date_utc: "x", run_id: "4", measurement_success: 7, fresh_measurement_success: 7, total_sites: 7 },
  ], 7);
  assert.equal(p.records.length, 1);
  assert.equal(p.problems.length, 4);
  assert.equal(parseRunRecords({}, 7).problems.length, 1);
});

test("owner adimlari her durumda OWNER_ACTION_PENDING; legacy_takeover_complete asla true", () => {
  for (const s of [ev(["2026-10-02", "2026-10-03"], [run("2026-10-02", "1"), run("2026-10-03", "2")]), ev([], null)]) {
    assert.deepEqual(s.owner_checklist.map((c) => c.step), ["legacy_disable", "credential_rotation", "flag_set", "first_scheduled_verification"]);
    assert.ok(s.owner_checklist.every((c) => c.state === "OWNER_ACTION_PENDING"));
    assert.equal(s.legacy_takeover_complete, false);
    assert.equal((statusToMarkdown(s).match(/OWNER_ACTION_PENDING/g) ?? []).length, 4);
  }
});

test("disk: bozuk bir site gecmisi yalniz o siteyi dusurur, digerleri etkilenmez; kayit dosyasi yoksa raporlanir", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeover-"));
  const reg = "config/sites.yaml"; // gercek registry (sema siki; sahte registry yazmak yerine)
  const hist = join(dir, "h");
  mkdirSync(hist);
  writeFileSync(join(hist, "pamistanbul.json"), "{bozuk");
  writeFileSync(join(hist, "spryhand.json"), JSON.stringify({ schema: "sgos.clarity-history.v1", site_id: "pamistanbul", max_records: 120, records: [] })); // site_id uyusmuyor
  const s = loadAndEvaluate(reg, hist);
  assert.deepEqual(s.site_problems.map((p) => p.site_id).sort(), ["pamistanbul", "spryhand"]);
  assert.equal(s.sites.length, 7);
  assert.equal(s.chain_state, "NONE");
  assert.equal(loadAndEvaluate(reg, hist, join(dir, "yok.json")).run_record_problems.length, 1);
});

test("gercek commit'li history (7 site): kosu kaydi yok => FULL asla; checklist PENDING", () => {
  const s = loadAndEvaluate("config/sites.yaml", "data/clarity-history");
  assert.equal(s.sites.length, 7);
  assert.ok(s.days.every((d) => d.status !== "FULL_TAKEOVER_SUCCESS"));
  assert.equal(s.chain_state, "NONE");
  assert.equal(s.run_records_supplied, false);
});
