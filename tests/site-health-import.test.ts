// site-health snapshot importu — tek gercek riski: "veri yok" ile "sifir"in karismasi.
//
// Fixture'lar GERCEK: izleme rutininin 2026-09-28 calismasindan alinmis dosyalar
// (tests/fixtures/site-health). O gun Clarity'ye 7 sitenin 7'sinde ag izni verilmedi
// (cache'te status:null) ve rutin yine de history'ye sifir satir yazdi. Burada o satirin
// sifir olarak ICERI ALINMADIGI kanitlaniyor — ve bunun tersi: gercek bir sifirin da
// "veri yok"a cevrilmedigi (yanlis pozitif).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../src/registry.ts";
import {
  importSnapshot, classifyClarityRow, classifyGscRow, readCacheEvidence, mergeRecords, writeSiteStore, GSC_ROW_LIMIT,
  type HealthRecord,
} from "../src/adapters/site-health-import.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const REGISTRY_PATH = join(ROOT, "config/sites.yaml");
const FIXTURE = join(ROOT, "tests/fixtures/site-health");
const reg = loadRegistry(REGISTRY_PATH).registry!;

/** Gecici snapshot dizini kur: { "history/gsc/x.com.jsonl": "satirlar", "cache/...": {obj} } */
function snap(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "shm-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
const jl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const ZERO = { date: "2026-09-28", real_sessions: 0, bot_sessions: 0, bot_pct: null, friction: {} };
const OK200 = { status: 200, params: {}, data: [] };
const FAIL = { status: null, params: {}, data: { error: "<urlopen error Tunnel connection failed: 403 Forbidden>" } };

// --- veri yok != sifir (yanlis negatif tarafi: ASIL risk) ---------------------

test("GERCEK fixture: Clarity ag hatasi + sifir satir -> UNKNOWN, sifir sayilmaz", () => {
  const cache = readCacheEvidence(FIXTURE, "clarity", "spryhand.com", "2026-09-28");
  assert.equal(cache.present, true);
  assert.ok(cache.failures.length > 0, "gercek cache'te status:null var");
  const r = classifyClarityRow(ZERO, cache);
  assert.equal(r.state, "UNKNOWN");
  assert.equal(r.metrics, null, "UNKNOWN kayitta metrik yok — sifir bile degil");
  assert.match(r.reason!, /basarisiz/);
  assert.equal(r.confidence, "UNKNOWN");
});

test("hata cache'i varken satir SIFIR OLMASA bile guvenilmez: UNKNOWN", () => {
  const cache = { present: true, allOk: false, failures: ["A_device.json: status yok"] };
  const r = classifyClarityRow({ date: "2026-09-28", real_sessions: 116, bot_sessions: 86, friction: { DeadClickCount: 6 } }, cache);
  assert.equal(r.state, "UNKNOWN");
});

test("tamami sifir satir + kanitlayan cache yok -> UNKNOWN", () => {
  const dir = snap({ "history/clarity/pamistanbul.com.jsonl": jl(ZERO) });
  const res = importSnapshot(dir, reg);
  const rec = res.bySite.pamistanbul.find((x) => x.source === "clarity")!;
  assert.equal(rec.state, "UNKNOWN");
  assert.match(rec.reason!, /cache/);
  assert.equal(rec.metrics, null);
});

test("GSC: tamami sifir satir + cache yok -> UNKNOWN; GSC hata cache'i -> UNKNOWN", () => {
  const z = { date: "2026-09-28", window_start: "2026-09-20", window_end: "2026-09-26", total_clicks: 0, total_impressions: 0, zero_click_suspect_count: 0 };
  assert.equal(classifyGscRow(z, { present: false, allOk: false, failures: [] }).state, "UNKNOWN");
  assert.equal(classifyGscRow({ ...z, total_clicks: 5, total_impressions: 90 }, { present: true, allOk: false, failures: ["pages.json: status 403"] }).state, "UNKNOWN");
});

// --- yanlis pozitif tarafi: gercek sifir "veri yok"a cevrilmemeli --------------

test("GERCEK sifir korunur: tum cagrilar 200 ve bos -> MEASURED, sifir, CONFIRMED", () => {
  const dir = snap({
    "history/clarity/pamistanbul.com.jsonl": jl(ZERO),
    "cache/clarity/pamistanbul.com/2026-09-28/A_device.json": OK200,
    "cache/clarity/pamistanbul.com/2026-09-28/B_acquisition.json": OK200,
    "cache/clarity/pamistanbul.com/2026-09-28/C_content.json": OK200,
  });
  const rec = importSnapshot(dir, reg).bySite.pamistanbul[0];
  assert.equal(rec.state, "MEASURED");
  assert.equal((rec.metrics as { real_sessions: number }).real_sessions, 0);
  assert.equal(rec.confidence, "CONFIRMED");
});

test("sifir olmayan satir cache'siz de MEASURED ama CONFIRMED degil (INFERENCE-benzeri terfi yok)", () => {
  const dir = snap({ "history/clarity/pamistanbul.com.jsonl": jl({ date: "2026-09-28", real_sessions: 116, bot_sessions: 86, bot_pct: 42.6, friction: { DeadClickCount: 6 } }) });
  const rec = importSnapshot(dir, reg).bySite.pamistanbul[0];
  assert.equal(rec.state, "MEASURED");
  assert.equal(rec.confidence, "CANDIDATE", "tek basina history satiri kanitlanmis degil");
  assert.ok(rec.notes.some((n) => /cache/.test(n)));
});

test("her kayit FACT etiketi tasir; UNKNOWN kayit asla CONFIRMED olmaz", () => {
  const res = importSnapshot(FIXTURE, reg);
  const all = Object.values(res.bySite).flat();
  assert.ok(all.length >= 4);
  for (const r of all) {
    assert.equal(r.label, "FACT");
    if (r.state === "UNKNOWN") assert.notEqual(r.confidence, "CONFIRMED");
  }
});

// --- duplicate-date / idempotency ----------------------------------------------

test("GERCEK fixture: ayni tarih icin FARKLI iki Clarity satiri -> hicbiri secilmez, UNKNOWN", () => {
  // pamistanbul 2026-09-28: bir satir 116 oturum, ikincisi sifir. Hangisi dogru? Bilmiyoruz.
  const res = importSnapshot(FIXTURE, reg);
  const rec = res.bySite.pamistanbul.find((x) => x.source === "clarity" && x.date === "2026-09-28")!;
  assert.equal(rec.state, "UNKNOWN");
  assert.match(rec.reason!, /FARKLI/);
  assert.equal(rec.metrics, null);
});

test("GERCEK fixture: ayni tarih icin AYNI iki GSC satiri tek kayda iner", () => {
  const res = importSnapshot(FIXTURE, reg);
  const gsc = res.bySite.spryhand.filter((x) => x.source === "gsc");
  assert.equal(gsc.length, 1, "iki ayni satir -> tek kayit");
  assert.equal(gsc[0].duplicates_collapsed, 1);
  assert.equal(gsc[0].state, "MEASURED");
  assert.equal(gsc[0].confidence, "CONFIRMED");
  assert.equal((gsc[0].metrics as { totals_complete: unknown }).totals_complete, true);
});

test("anahtar sirasi farkli ama ayni icerik: cakisma SAYILMAZ", () => {
  const a = { date: "2026-09-28", total_clicks: 3, total_impressions: 50, window_start: "2026-09-20", window_end: "2026-09-26", zero_click_suspect_count: 0 };
  const b = { zero_click_suspect_count: 0, window_end: "2026-09-26", window_start: "2026-09-20", total_impressions: 50, total_clicks: 3, date: "2026-09-28" };
  const dir = snap({ "history/gsc/pamistanbul.com.jsonl": jl(a, b), "cache/gsc/pamistanbul.com/2026-09-28/pages.json": { status: 200, data: { rows: [] } } });
  const recs = importSnapshot(dir, reg).bySite.pamistanbul;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, "MEASURED");
});

test("GERCEK fixture: 200 satira ulasan GSC yaniti kesilmis sayilir -> toplam alt sinir, CONFIRMED degil", () => {
  const rec = importSnapshot(FIXTURE, reg).bySite.pamistanbul.find((x) => x.source === "gsc")!;
  assert.equal(rec.state, "MEASURED");
  assert.equal((rec.metrics as { totals_complete: unknown }).totals_complete, false);
  assert.equal(rec.confidence, "CANDIDATE");
  assert.ok(rec.notes.some((n) => n.includes(String(GSC_ROW_LIMIT))));
});

test("GSC 200'den az satir: kesilmis DEGIL (yanlis pozitif yok)", () => {
  const rows = Array.from({ length: GSC_ROW_LIMIT - 1 }, (_, i) => ({ keys: [`https://pamistanbul.com/${i}`], clicks: 1, impressions: 2 }));
  const dir = snap({
    "history/gsc/pamistanbul.com.jsonl": jl({ date: "2026-09-28", total_clicks: 199, total_impressions: 398, zero_click_suspect_count: 0 }),
    "cache/gsc/pamistanbul.com/2026-09-28/pages.json": { status: 200, data: { rows } },
  });
  const rec = importSnapshot(dir, reg).bySite.pamistanbul[0];
  assert.equal((rec.metrics as { totals_complete: unknown }).totals_complete, true);
  assert.equal(rec.confidence, "CONFIRMED");
});

function rec(over: Partial<HealthRecord>): HealthRecord {
  return { site: "pamistanbul", domain: "pamistanbul.com", source: "gsc", date: "2026-09-28", state: "MEASURED", label: "FACT", confidence: "CONFIRMED", duplicates_collapsed: 0, metrics: { total_clicks: 1 }, notes: [], ...over };
}

test("mergeRecords idempotent: ayni girdiyi ikinci kez almak hicbir sey degistirmez", () => {
  const incoming = importSnapshot(FIXTURE, reg).bySite.pamistanbul;
  const first = mergeRecords([], incoming);
  const second = mergeRecords(first.merged, incoming);
  assert.equal(second.added.length, 0);
  assert.equal(second.unchanged.length, incoming.length);
  assert.deepEqual(second.merged, first.merged);
});

test("mergeRecords: olcum asla 'olcemedim'e dusurulmez; iki farkli olcum ustune yazilmaz", () => {
  const measured = rec({});
  const unknown = rec({ state: "UNKNOWN", confidence: "UNKNOWN", metrics: null, reason: "x" });
  assert.equal(mergeRecords([measured], [unknown]).refusedDowngrade.length, 1);
  assert.equal(mergeRecords([measured], [unknown]).merged[0].state, "MEASURED");
  assert.equal(mergeRecords([unknown], [measured]).upgraded.length, 1);
  const other = rec({ metrics: { total_clicks: 999 } });
  const c = mergeRecords([measured], [other]);
  assert.equal(c.conflicts.length, 1);
  assert.deepEqual(c.merged[0].metrics, { total_clicks: 1 }, "eski olcum korunur, insan bakar");
});

// --- site izolasyonu ---------------------------------------------------------

test("kayitsiz domain HIC acilmaz ve hicbir kayda karismaz", () => {
  const dir = snap({
    "history/gsc/evil.example.jsonl": jl({ date: "2026-09-28", total_clicks: 9999, total_impressions: 9999 }),
    "history/gsc/pamistanbul.com.jsonl": jl({ date: "2026-09-28", total_clicks: 2, total_impressions: 40 }),
    "cache/gsc/pamistanbul.com/2026-09-28/pages.json": { status: 200, data: { rows: [] } },
  });
  const res = importSnapshot(dir, reg);
  assert.deepEqual(res.rejectedDomains, ["evil.example"]);
  assert.deepEqual(Object.keys(res.bySite), ["pamistanbul"]);
  assert.ok(!JSON.stringify(res).includes("9999"));
});

test("her site yalnizca kendi domain'inin verisini alir (GERCEK fixture, iki site)", () => {
  const res = importSnapshot(FIXTURE, reg);
  assert.deepEqual(Object.keys(res.bySite).sort(), ["pamistanbul", "spryhand"]);
  for (const [site, recs] of Object.entries(res.bySite)) {
    const domain = reg.sites.find((s) => s.id === site)!.production_domain;
    for (const r of recs) { assert.equal(r.site, site); assert.equal(r.domain, domain); }
  }
  // spryhand'in 140 gosterimi pamistanbul'un kaydinda gorunmemeli.
  const pam = JSON.stringify(res.bySite.pamistanbul);
  assert.ok(!pam.includes('"total_impressions":140'));
});

test("--site filtresi diger sitelerin dosyasini hic okumaz", () => {
  const res = importSnapshot(FIXTURE, reg, "spryhand");
  assert.deepEqual(Object.keys(res.bySite), ["spryhand"]);
});

test("writeSiteStore baska sitenin kaydini reddeder", () => {
  const dir = mkdtempSync(join(tmpdir(), "shm-store-"));
  assert.throws(() => writeSiteStore(dir, "spryhand", [rec({ site: "pamistanbul" })]), /izolasyon/);
  assert.ok(!existsSync(join(dir, "sites")), "reddedilince hicbir sey yazilmaz");
});

test("bozuk satir ve gecersiz tarih reddedilir, kosu cokmez", () => {
  const dir = snap({ "history/gsc/pamistanbul.com.jsonl": "not json\n" + jl({ total_clicks: 1, total_impressions: 1 }) });
  const res = importSnapshot(dir, reg);
  assert.ok(res.rejected.some((r) => /JSON degil/.test(r.reason)));
  assert.ok(res.rejected.some((r) => /date/.test(r.reason)));
});

// --- runtime bagimliligi yok -------------------------------------------------

test("importer ag, git, token ve belirli bir repo'ya baglanmaz (yalnizca yerel dizin)", () => {
  const src = readFileSync(join(ROOT, "src/adapters/site-health-import.ts"), "utf8");
  for (const bad of [/github\.com/i, /\bfetch\s*\(/, /child_process/, /process\.env/, /https?:\/\//, /node:(https?|net|tls)/]) {
    assert.ok(!bad.test(src), `site-health-import.ts icinde yasak desen: ${bad}`);
  }
});

// --- CLI: --write verilmezse yazmaz; verilince idempotent ----------------------

function runCli(cwd: string, ...a: string[]) {
  return execFileSync("node", ["--experimental-strip-types", join(ROOT, "src/cli.ts"), ...a], { cwd, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
}

test("cli import-health: --write yoksa hicbir dosya yazilmaz", () => {
  const cwd = mkdtempSync(join(tmpdir(), "shm-cli-"));
  const out = runCli(cwd, "import-health", FIXTURE, "--registry", REGISTRY_PATH);
  assert.match(out, /hicbir dosya yazilmadi/);
  assert.deepEqual(readdirSync(cwd), []);
});

test("cli import-health --write: yalniz ilgili sitelerin dosyasi, ikinci kosu bayt-bayt ayni", () => {
  const cwd = mkdtempSync(join(tmpdir(), "shm-cli-"));
  runCli(cwd, "import-health", FIXTURE, "--registry", REGISTRY_PATH, "--write");
  assert.deepEqual(readdirSync(join(cwd, "sites")).sort(), ["pamistanbul", "spryhand"]);
  const before = readFileSync(join(cwd, "sites/pamistanbul/health-import.json"), "utf8");
  const out2 = runCli(cwd, "import-health", FIXTURE, "--registry", REGISTRY_PATH, "--write");
  assert.equal(readFileSync(join(cwd, "sites/pamistanbul/health-import.json"), "utf8"), before);
  assert.match(out2, /\+0 yeni/);
});
