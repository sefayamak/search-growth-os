// Takeover zinciri degerlendiricisi: OFFLINE, ag yok. Kanit kaynagi: history `source_run_id`.
// Odak: yanlis pozitif (taze kaniti olmadan FULL) ve yanlis negatif (gercek 7/7 taze kosuyu COVERAGE'a dusurmek),
// zincirin ayni gunu iki kez saymamasi, tutarsiz kanitta INCONSISTENT, owner adimlarinin hep PENDING kalmasi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateTakeover, loadAndEvaluate, statusToMarkdown, type DayEvidence } from "../src/clarity-takeover-status.ts";
import { runDaily, parseHistory, loadHistory, HistoryError } from "../src/clarity-daily.ts";
import { loadRegistry } from "../src/registry.ts";
import type { FetchFn } from "../src/adapters/clarity.ts";

const SITES = ["a", "b", "c", "d", "e", "f", "g"];
type Spec = Record<string, { id?: string | null; ok?: boolean; t?: string } | undefined>;
/** Bir gunun 7 kaydi. Varsayilan: hepsi basarili, hepsi `id`, 07:20Z'den saniye araliklarla. */
const day = (date: string, id: string | null, over: Spec = {}): Record<string, DayEvidence | undefined> =>
  Object.fromEntries(SITES.map((s, i) => {
    const o = over[s];
    if (o === undefined && s in over) return [s, undefined];
    return [s, { success: o?.ok ?? true, run_id: o && "id" in o ? o.id ?? null : id, measured_at: o?.t ?? `${date}T07:20:${String(10 + i).padStart(2, "0")}.000Z` }];
  }));
const build = (days: Record<string, Record<string, DayEvidence | undefined>>) => {
  const e: Record<string, Record<string, DayEvidence>> = Object.fromEntries(SITES.map((s) => [s, {}]));
  for (const [d, m] of Object.entries(days)) for (const s of SITES) if (m[s]) e[s][d] = m[s]!;
  return e;
};
const ev = (days: Record<string, Record<string, DayEvidence | undefined>>) => evaluateTakeover({ siteIds: SITES, evidenceBySite: build(days) });

test("7/7 measurement + 7 kayit ayni run id = FULL_TAKEOVER_SUCCESS, tazelik 7/7, guard atlama 0 (yanlis negatif olmasin)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100") });
  assert.equal(s.days[0].status, "FULL_TAKEOVER_SUCCESS");
  assert.equal(s.days[0].freshness, "FRESH_7_OF_7");
  assert.equal(s.days[0].qualifying_run_id, "100");
  assert.equal(s.days[0].guard_skips_observed, 0);
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
  assert.equal(s.evidence_source, "history.source_run_id");
});

test("id'siz kayitlar: 7/7 measurement COVERAGE olur, tazelik UNKNOWN, FULL iddia edilmez (yanlis pozitif)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", null), "2026-10-03": day("2026-10-03", null) });
  assert.deepEqual(s.days.map((d) => d.status), ["COVERAGE_VALIDATION_SUCCESS", "COVERAGE_VALIDATION_SUCCESS"]);
  assert.ok(s.days.every((d) => d.freshness === "UNKNOWN" && d.guard_skips_observed === "UNKNOWN"));
  assert.equal(s.chain_state, "NONE");
  assert.match(s.days[0].notes.join(" "), /source_run_id yok/);
});

test("tek site id'siz (6 id + 1 eski kayit): FULL degil, tazelik UNKNOWN", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100", { g: { id: null } }) });
  assert.equal(s.days[0].status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(s.days[0].freshness, "UNKNOWN");
  assert.deepEqual(s.days[0].unattributed_sites, ["g"]);
});

test("gercek 2026-10-02 sekli: 6 site bir kosuda, 1 site eski kosuda = COVERAGE, NOT_FULL, guard atlama 1", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "36983089184", { a: { id: "36978486153", t: "2026-10-02T07:25:40.570Z" } }) });
  const d = s.days[0];
  assert.equal(d.status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(d.freshness, "NOT_FULL");
  assert.equal(d.guard_skips_observed, 1);
  assert.equal(d.latest_run_id, "36983089184");
  assert.deepEqual(d.runs.map((r) => [r.run_id, r.sites.length]), [["36978486153", 1], ["36983089184", 6]]);
  assert.equal(s.chain_state, "NONE");
});

test("guard atlama sayisi: son kosu 2 siteyi olctu, 5'ini atladi => 5", () => {
  const over: Spec = Object.fromEntries(SITES.slice(2).map((x) => [x, { id: "100", t: "2026-10-02T07:20:30.000Z" }]));
  const s = ev({ "2026-10-02": day("2026-10-02", "101", over) });
  assert.equal(s.days[0].guard_skips_observed, 5);
  assert.equal(s.days[0].status, "COVERAGE_VALIDATION_SUCCESS");
});

test("bir site measurement_success=false: NOT_SUCCESS, FULL asla (ayni run id'ye ragmen)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100", { c: { ok: false } }) });
  assert.equal(s.days[0].status, "NOT_SUCCESS");
  assert.equal(s.days[0].measurement_failed_sites[0].site_id, "c");
  assert.equal(s.days[0].qualifying_run_id, null);
  assert.equal(s.chain_state, "NONE");
});

test("sitenin o gun kaydi yok = basari sayilmaz (7/7 degil)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100", { g: undefined }) });
  assert.equal(s.days[0].status, "NOT_SUCCESS");
  assert.match(s.days[0].measurement_failed_sites[0].reason, /kayit yok/);
});

test("ayni gun iki kosu tek gun sayilir: 1_OF_2, 2_OF_2 degil (ikinci kosu hepsini atladiysa zaten gorunmez)", () => {
  // 100 hepsini olctu; 101 hepsini atladi => history'de 101 yok => hala tek gun/tek kosu
  const s = ev({ "2026-10-02": day("2026-10-02", "100") });
  assert.equal(s.days.length, 1);
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
});

test("iki FARKLI UTC gun, iki farkli run id = 2_OF_2", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100"), "2026-10-03": day("2026-10-03", "101") });
  assert.equal(s.chain_state, "FULL_TAKEOVER_2_OF_2");
  assert.deepEqual(s.chain_days, ["2026-10-02", "2026-10-03"]);
});

test("2_OF_2 iki FARKLI UTC gun ister: ayni run id iki gunde = INCONSISTENT, zincir NONE", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100"), "2026-10-03": day("2026-10-03", "100") });
  assert.deepEqual(s.days.map((d) => d.status), ["INCONSISTENT", "INCONSISTENT"]);
  assert.equal(s.chain_state, "NONE");
  assert.match(s.days[0].notes.join(" "), /birden fazla UTC gun/);
});

test("arada FULL olmayan gun zinciri kirar; sonraki tek FULL 1_OF_2", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "1"), "2026-10-03": day("2026-10-03", "2", { a: { id: "1" } }), "2026-10-04": day("2026-10-04", "3") });
  // 10-03'te a'nin id'si 1 (eski gun id'si) -> hem NOT_FULL hem sira ihlali; her iki durumda zincir kirilir
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
  assert.deepEqual(s.chain_days, ["2026-10-04"]);
});

test("son gun FULL degilse zincir NONE (onceki FULL gun yetmez)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "1"), "2026-10-03": day("2026-10-03", "3", { a: { id: "2", t: "2026-10-03T07:20:40.000Z" } }) });
  assert.equal(s.days[1].status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(s.chain_state, "NONE");
});

test("veri olmayan takvim gunu zinciri kirmaz ama not dusulur", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "1"), "2026-10-05": day("2026-10-05", "2") });
  assert.equal(s.chain_state, "FULL_TAKEOVER_2_OF_2");
  assert.match(s.chain_notes.join(" "), /2 takvim gunu/);
});

// --- forgery / tutarlilik capraz kontrolleri -------------------------------------------------------------

test("capraz: ayni run'in kayitlari 15 dk'dan uzun araliga yayilmis = INCONSISTENT (FULL degil)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100", { g: { t: "2026-10-02T09:00:00.000Z" } }) });
  assert.equal(s.days[0].status, "INCONSISTENT");
  assert.match(s.days[0].notes.join(" "), /dk araliga/);
  assert.equal(s.days[0].qualifying_run_id, null);
  assert.equal(s.chain_state, "NONE");
});

test("capraz yanlis pozitif yok: tam 15 dk aralik hala gecerli (FULL)", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100", { a: { t: "2026-10-02T07:05:15.000Z" }, g: { t: "2026-10-02T07:20:00.000Z" } }) });
  assert.equal(s.days[0].status, "FULL_TAKEOVER_SUCCESS");
});

test("capraz: run id tarihle ters (eski gunun id'si yeni gunden buyuk) = INCONSISTENT, zincir NONE", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "500"), "2026-10-03": day("2026-10-03", "400") });
  assert.deepEqual(s.days.map((d) => d.status), ["INCONSISTENT", "INCONSISTENT"]);
  assert.equal(s.chain_state, "NONE");
  assert.match(s.days[1].notes.join(" "), /sirasi tarihle celisiyor/);
});

test("capraz yanlis pozitif yok: id'ler gunle birlikte artiyorsa (cok basamakli, string degil sayi karsilastirmasi) sorun yok", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "99"), "2026-10-03": day("2026-10-03", "100") }); // "99" > "100" string olarak
  assert.equal(s.chain_state, "FULL_TAKEOVER_2_OF_2");
});

test("capraz tutarsizlik 7/7 olmayan gunde NOT_SUCCESS kalir (basari iddia edilmez), not dusulur", () => {
  const s = ev({ "2026-10-02": day("2026-10-02", "100", { c: { ok: false }, g: { t: "2026-10-02T11:00:00.000Z" } }) });
  assert.equal(s.days[0].status, "NOT_SUCCESS");
  assert.match(s.days[0].notes.join(" "), /tutarsizlik/);
});

test("owner adimlari her durumda OWNER_ACTION_PENDING; legacy_takeover_complete asla true", () => {
  for (const s of [ev({ "2026-10-02": day("2026-10-02", "1"), "2026-10-03": day("2026-10-03", "2") }), ev({})]) {
    assert.deepEqual(s.owner_checklist.map((c) => c.step), ["legacy_disable", "credential_rotation", "flag_set", "first_scheduled_verification"]);
    assert.ok(s.owner_checklist.every((c) => c.state === "OWNER_ACTION_PENDING"));
    assert.equal(s.legacy_takeover_complete, false);
    assert.equal((statusToMarkdown(s).match(/OWNER_ACTION_PENDING/g) ?? []).length, 4);
  }
});

// --- disk + uretici (clarity-daily) entegrasyonu ---------------------------------------------------------

const REG = "config/sites.yaml";
const REAL = loadRegistry(REG).registry!.sites.map((s) => s.id);
const TOK = (id: string) => `TOK-${id}-SECRET-9876543210`;
const zeroFetch: FetchFn = async () => ({ status: 200, text: async () => "[]" }); // dogrulanmis tam sifir = basarili olcum
const at = (d: number, sec = 0) => () => new Date(Date.UTC(2026, 9, d, 7, 20, sec));
const sleep = async () => {};

test("uretici entegrasyonu: runDaily kayda source_run_id yazar; atlanan sitenin kaydi eski id'yi tasir; degerlendirici bunu okur", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeover-int-"));
  const hist = join(dir, "h");
  const common = { tokens: new Map(REAL.map((id) => [id, TOK(id)] as [string, string])), historyDir: hist, outDir: join(dir, "o"), fetchFn: zeroFetch, sleep };
  // 1. kosu (100): 6 site (pamistanbul yok) -> 6 kayit
  await runDaily({ ...common, siteIds: REAL.slice(1), now: at(2), sourceRunId: "100" });
  // 2. kosu (101): 7 site; 6'si guard ile atlanir, 1'i taze
  const out2 = await runDaily({ ...common, siteIds: REAL, now: at(2, 30), sourceRunId: "101" });
  assert.equal(out2.coverage.fresh_measurement_success, 1);
  const s = loadAndEvaluate(REG, hist);
  assert.equal(s.days[0].status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(s.days[0].freshness, "NOT_FULL");
  assert.equal(s.days[0].guard_skips_observed, 6);
  assert.equal(s.days[0].latest_run_id, "101");
  // ayni tablo `force` ile de oynamaz: ilk-basari-kazanir id'yi korur
  await runDaily({ ...common, siteIds: REAL, now: at(2, 40), sourceRunId: "102", force: true });
  assert.equal(loadAndEvaluate(REG, hist).days[0].latest_run_id, "101");
  // 2. gun: tek kosu (103) 7 siteyi olcer -> FULL; 3. gun (104) FULL -> 2_OF_2
  await runDaily({ ...common, siteIds: REAL, now: at(3), sourceRunId: "103" });
  let t = loadAndEvaluate(REG, hist);
  assert.equal(t.days[1].status, "FULL_TAKEOVER_SUCCESS");
  assert.equal(t.chain_state, "FULL_TAKEOVER_1_OF_2");
  await runDaily({ ...common, siteIds: REAL, now: at(4), sourceRunId: "104" });
  t = loadAndEvaluate(REG, hist);
  assert.equal(t.chain_state, "FULL_TAKEOVER_2_OF_2");
  assert.deepEqual(t.chain_days, ["2026-10-03", "2026-10-04"]);
});

test("uretici: GITHUB_RUN_ID olmayan (yerel) kosu id yazmaz => tazelik UNKNOWN, FULL asla (yanlis pozitif)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeover-local-"));
  const hist = join(dir, "h");
  await runDaily({ siteIds: REAL, tokens: new Map(REAL.map((id) => [id, TOK(id)] as [string, string])), historyDir: hist, outDir: join(dir, "o"), fetchFn: zeroFetch, sleep, now: at(2) });
  const s = loadAndEvaluate(REG, hist);
  assert.equal(s.days[0].status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(s.days[0].freshness, "UNKNOWN");
  assert.equal(s.chain_state, "NONE");
});

test("geriye uyum: source_run_id'siz eski kayit parse olur; bozuk source_run_id gecmisi bozuk sayar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeover-bc-"));
  const hist = join(dir, "h");
  const id = REAL[0];
  await runDaily({ siteIds: [id], tokens: new Map([[id, TOK(id)]]), historyDir: hist, outDir: join(dir, "o"), fetchFn: zeroFetch, sleep, now: at(2), sourceRunId: "100" });
  const h = loadHistory(hist, id);
  const { source_run_id: _drop, ...legacy } = h.records[0];
  assert.doesNotThrow(() => parseHistory(JSON.stringify({ ...h, records: [legacy] }), id));
  for (const bad of ["abc", "12 34", "", 12345 as unknown as string]) {
    assert.throws(() => parseHistory(JSON.stringify({ ...h, records: [{ ...h.records[0], source_run_id: bad }] }), id), (e: unknown) => e instanceof HistoryError && /source_run_id/.test((e as Error).message));
  }
});

test("disk: bozuk bir site gecmisi yalniz o siteyi dusurur, digerleri etkilenmez", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeover-"));
  const hist = join(dir, "h");
  mkdirSync(hist);
  writeFileSync(join(hist, "pamistanbul.json"), "{bozuk");
  writeFileSync(join(hist, "spryhand.json"), JSON.stringify({ schema: "sgos.clarity-history.v1", site_id: "pamistanbul", max_records: 120, records: [] })); // site_id uyusmuyor
  const s = loadAndEvaluate(REG, hist);
  assert.deepEqual(s.site_problems.map((p) => p.site_id).sort(), ["pamistanbul", "spryhand"]);
  assert.equal(s.sites.length, 7);
  assert.equal(s.chain_state, "NONE");
});

test("gercek commit'li history: 2026-10-02 COVERAGE/NOT_FULL (pamistanbul eski kosudan), 2026-10-03 FULL_TAKEOVER_SUCCESS (Day-1) -> chain 1/2, 2/2 asla tek gunden; checklist PENDING", () => {
  const s = loadAndEvaluate(REG, "data/clarity-history");
  assert.equal(s.sites.length, 7);
  const d2 = s.days.find((x) => x.date === "2026-10-02")!;
  assert.equal(d2.status, "COVERAGE_VALIDATION_SUCCESS");
  assert.equal(d2.freshness, "NOT_FULL");
  assert.equal(d2.guard_skips_observed, 1);
  const d3 = s.days.find((x) => x.date === "2026-10-03")!;
  assert.equal(d3.status, "FULL_TAKEOVER_SUCCESS");
  assert.equal(d3.freshness, "FRESH_7_OF_7");
  assert.equal(d3.guard_skips_observed, 0);
  // Tek nitelikli gun -> 1/2; iki AYRI nitelikli UTC gunu olmadan asla 2/2.
  assert.equal(s.days.filter((d) => d.status === "FULL_TAKEOVER_SUCCESS").length, 1);
  assert.equal(s.chain_state, "FULL_TAKEOVER_1_OF_2");
  assert.deepEqual(s.chain_days, ["2026-10-03"]);
  assert.ok(s.owner_checklist.every((c) => c.state === "OWNER_ACTION_PENDING"));
});
