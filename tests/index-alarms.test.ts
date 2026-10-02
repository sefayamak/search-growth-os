// index-alarms: her kontrol icin yanlis pozitif (haksiz alarm) VE yanlis negatif (kacan alarm) testi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHistory, emptyHistory, appendSnapshot, snapshotFromProbe, computeIndexAlarms, MAX_SNAPSHOTS,
  emptyBacklog, parseBacklog, updateBacklog, buildReport, reportToMarkdown, ageBucket, loadHistory, saveHistory, historyPath,
  type Snapshot, type HistoryEntry, type IndexHistory, type Verdict,
} from "../src/index-alarms.ts";
import { runProbe } from "../src/index-probe.ts";
import { classifyCanonicalRelations } from "../src/canonical-relations.ts";

const SITE = "pamistanbul";
const U = "https://pamistanbul.com/a";
const T0 = "2026-10-01T08:00:00.000Z", T1 = "2026-10-02T09:00:00.000Z", T_SHORT = "2026-10-01T20:00:00.000Z";

const entry = (url: string, verdict: Verdict, over: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ url, state: "INSPECTED", verdict, in_sitemap: true, fetch_ok: true, canonical_self: true, indexable: true, ...over });
const snap = (at: string, entries: HistoryEntry[], site = SITE): Snapshot =>
  ({ taken_at: at, site, sample_size: entries.filter((e) => e.state === "INSPECTED").length, universe_size: "UNKNOWN", stopped: null, entries });
const hist = (...s: Snapshot[]): IndexHistory => ({ ...emptyHistory(SITE), snapshots: s });
const NOW = "2026-10-02T10:00:00.000Z";

// --- gecmis: parse / izolasyon / kirpma --------------------------------------

test("parse: bozuk dosya fail-closed (schema, site, zaman sirasi, tri alan)", () => {
  assert.throws(() => parseHistory(null, SITE));
  assert.throws(() => parseHistory({ ...emptyHistory(SITE), schema: "v0" }, SITE));
  assert.throws(() => parseHistory(emptyHistory("spryhand"), SITE), /uyusmuyor/);
  assert.throws(() => parseHistory(hist(snap(T1, []), snap(T0, [])), SITE), /zaman/);
  assert.throws(() => parseHistory(hist(snap(T0, [entry(U, "INDEXED", { indexable: "maybe" as never })])), SITE));
  assert.doesNotThrow(() => parseHistory(hist(snap(T0, [entry(U, "INDEXED")])), SITE));
});

test("izolasyon: baska sitenin snapshot'i eklenemez", () => {
  assert.throws(() => appendSnapshot(emptyHistory(SITE), snap(T0, [], "spryhand")), /izolasyonu/);
});

test("kirpma: en fazla 120 snapshot, en yeniler kalir; girdi degismez", () => {
  let h = emptyHistory(SITE);
  const base = Date.parse(T0);
  for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) h = appendSnapshot(h, snap(new Date(base + i * 3_600_000).toISOString(), []));
  assert.equal(h.snapshots.length, MAX_SNAPSHOTS);
  assert.equal(h.snapshots[0].taken_at, new Date(base + 5 * 3_600_000).toISOString());
  const before = JSON.stringify(h);
  appendSnapshot(h, snap(new Date(base + 999 * 3_600_000).toISOString(), []));
  assert.equal(JSON.stringify(h), before);
});

test("dosya G/C: dosya yoksa bos; bozuksa atar (bos gecmise dusmez)", () => {
  const root = mkdtempSync(join(tmpdir(), "ia-"));
  assert.equal(loadHistory(SITE, root).snapshots.length, 0);
  saveHistory(hist(snap(T0, [entry(U, "INDEXED")])), root);
  assert.equal(loadHistory(SITE, root).snapshots.length, 1);
  mkdirSync(join(root, "index-history"), { recursive: true });
  writeFileSync(historyPath(SITE, root), "{bozuk");
  assert.throws(() => loadHistory(SITE, root));
});

test("snapshotFromProbe: probe FACT alanlarindan uygunluk; eksik alan UNKNOWN; hata ERROR", async () => {
  const ok = { indexStatusResult: { verdict: "FAIL", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", robotsTxtState: "ALLOWED", googleCanonical: U, userCanonical: U } };
  const p = await runProbe({
    site: { id: SITE, production_domain: "pamistanbul.com" }, candidates: [{ url: U, segment: "SITEMAP_AND_GSC" }, { url: "https://pamistanbul.com/b", segment: "HOST_VARIANT_RISK" }, { url: "https://pamistanbul.com/c", segment: "SITEMAP_AND_GSC" }],
    candidateSource: "test", limit: 5, delayMs: 0, connected: true, sleep: async () => {},
    inspect: async (u) => { if (u.endsWith("/c")) throw new Error("HTTP 500 x"); return u.endsWith("/b") ? { indexStatusResult: { verdict: "FAIL" } } : ok; },
  });
  const s = snapshotFromProbe(p, T0);
  assert.deepEqual(s.entries[0], entry(U, "NOT_INDEXED"));
  assert.equal(s.entries[1].in_sitemap, "UNKNOWN");
  assert.equal(s.entries[1].fetch_ok, "UNKNOWN");
  assert.equal(s.entries[2].state, "ERROR");
  assert.equal(s.sample_size, 2);
});

// --- alarm: yanlis pozitif ----------------------------------------------------

test("FP: >24s ama INDEXED -> alarm yok", () => {
  const r = computeIndexAlarms(hist(snap(T0, [entry(U, "INDEXED")]), snap(T1, [entry(U, "INDEXED")])), NOW);
  assert.equal(r.status, "NO_ALARM_IN_SAMPLE");
  assert.equal(r.alarms.length, 0);
});

test("FP: indekste degil ama <=24s -> alarm yok", () => {
  const r = computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap(T_SHORT, [entry(U, "NOT_INDEXED")])), NOW);
  assert.equal(r.alarms.length, 0);
});

test("FP: 24 saatin tam sinirinda (==24s) alarm yok", () => {
  const r = computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap("2026-10-02T08:00:00.000Z", [entry(U, "NOT_INDEXED")])), NOW);
  assert.equal(r.alarms.length, 0);
});

test("FP: URL indekslenmemesi BEKLENEN turdeyse (noindex / sitemap'te degil / canonical baska / fetch hatasi) alarm yok", () => {
  for (const over of [{ indexable: false }, { in_sitemap: false }, { canonical_self: false }, { fetch_ok: false }] as Partial<HistoryEntry>[]) {
    const r = computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED", over)]), snap(T1, [entry(U, "NOT_INDEXED", over)])), NOW);
    assert.equal(r.alarms.length, 0, JSON.stringify(over));
  }
});

test("FP: araya INDEXED girdiyse seri kesilir; ERROR gozlem seriyi ne uzatir ne keser", () => {
  const broken = hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap("2026-10-01T20:00:00.000Z", [entry(U, "INDEXED")]), snap(T1, [entry(U, "NOT_INDEXED")]));
  assert.equal(computeIndexAlarms(broken, NOW).alarms.length, 0);
  // ERROR tek basina "indekslenmemis" gozlemi degildir: iki gozlemin biri ERROR ise seri 1 uzunlugundadir.
  const err = hist(snap(T0, [entry(U, "UNKNOWN", { state: "ERROR" })]), snap(T1, [entry(U, "NOT_INDEXED")]));
  assert.equal(computeIndexAlarms(err, NOW).alarms.length, 0);
});

// --- alarm: yanlis negatif ----------------------------------------------------

test("FN: >24s, iki gozlem, uygun URL, NOT_INDEXED -> INFERENCE/CANDIDATE/REVIEW_REQUIRED alarm + onaylayan test", () => {
  const r = computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap(T1, [entry(U, "NOT_INDEXED")])), NOW);
  assert.equal(r.status, "ALARMS");
  const a = r.alarms[0];
  assert.deepEqual([a.evidence_label, a.confidence, a.review_status], ["INFERENCE", "CANDIDATE", "REVIEW_REQUIRED"]);
  assert.match(a.confirming_test, /URL Inspection/);
  assert.equal(a.observations, 2);
});

test("FN: UNKNOWN karar ve NEUTRAL de 'indekste dogrulanmadi' sayilir", () => {
  for (const v of ["UNKNOWN", "NEUTRAL"] as Verdict[]) {
    const r = computeIndexAlarms(hist(snap(T0, [entry(U, v)]), snap(T1, [entry(U, v)])), NOW);
    assert.equal(r.alarms.length, 1, v);
  }
});

test("FN: URL araya hic ornege girmese de (donen ornekleme) iki gozlem >24s ise alarm", () => {
  const r = computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap("2026-10-01T20:00:00.000Z", [entry("https://pamistanbul.com/z", "INDEXED")]), snap(T1, [entry(U, "NOT_INDEXED")])), NOW);
  assert.equal(r.alarms.length, 1);
});

// --- ornekleme durustlugu -----------------------------------------------------

test("ornek yok -> UNKNOWN (ok degil): bos gecmis, tek snapshot, bos ornek", () => {
  assert.equal(computeIndexAlarms(emptyHistory(SITE), NOW).status, "UNKNOWN");
  assert.equal(computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED")])), NOW).status, "UNKNOWN");
  const empty = computeIndexAlarms(hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap(T1, [])), NOW);
  assert.equal(empty.status, "UNKNOWN");
  assert.equal(empty.coverage.sample_size, 0);
});

test("degerlendirilemeyen URL'ler sayilir: 'alarm yok' sessiz kalmaz", () => {
  const e = entry(U, "NOT_INDEXED", { canonical_self: "UNKNOWN" });
  const r = computeIndexAlarms(hist(snap(T0, [e]), snap(T1, [e])), NOW);
  assert.equal(r.status, "NO_ALARM_IN_SAMPLE");
  assert.equal(r.unassessed_in_latest, 1);
});

test("her cikti coverage_basis:'sample' + ornek boyu + evren boyu tasir; hicbir yerde yuzde yok", () => {
  const h = hist(snap(T0, [entry(U, "NOT_INDEXED")]), { ...snap(T1, [entry(U, "NOT_INDEXED")]), universe_size: 420 });
  const rep = buildReport(h, emptyBacklog(SITE), NOW);
  assert.equal(rep.index_alarms.coverage.coverage_basis, "sample");
  assert.equal(rep.index_alarms.coverage.sample_size, 1);
  assert.equal(rep.index_alarms.coverage.universe_size, 420);
  assert.equal(rep.canonical_backlog.coverage_basis, "sample");
  const text = JSON.stringify(rep) + reportToMarkdown(rep);
  assert.ok(!/%/.test(text), "yuzde isareti yok");
  assert.ok(!/\bcoverage\b[^\n]{0,40}\d/i.test(reportToMarkdown(rep).replace(/coverage_basis: sample/g, "")), "coverage yanina sayi/oran yazilmaz");
  assert.ok(!/"coverage_(pct|percent|ratio|rate)"/.test(text));
  // universe bilinmiyorsa UNKNOWN yazilir, sayi uydurulmaz.
  assert.equal(buildReport(hist(snap(T0, []), snap(T1, [])), emptyBacklog(SITE), NOW).index_alarms.coverage.universe_size, "UNKNOWN");
});

test("markdown: alarm varsa onaylayan test ve etiketler yazilir", () => {
  const md = reportToMarkdown(buildReport(hist(snap(T0, [entry(U, "NOT_INDEXED")]), snap(T1, [entry(U, "NOT_INDEXED")])), emptyBacklog(SITE), NOW));
  assert.match(md, /INFERENCE \/ CANDIDATE \/ REVIEW_REQUIRED/);
  assert.match(md, /Onaylayan test/);
  assert.match(md, /TAM KAPSAM DEĞİL/);
});

test("buildReport: farkli site gecmisi ve backlog'u birlestirilemez", () => {
  assert.throws(() => buildReport(emptyHistory(SITE), emptyBacklog("spryhand"), NOW), /izolasyonu/);
});

// --- (3) canonical backlog ----------------------------------------------------

const CONFLICT = "https://pamistanbul.com/bath-loofah-lifestyle";
const CROSS = { inspected: CONFLICT, google: CONFLICT, user: "https://pamaistudio.com/bath-loofah-lifestyle" };
const CONVERGE = { inspected: "https://www.pamistanbul.com/x.html", google: "https://pamistanbul.com/x", user: "https://pamistanbul.com/x" };
const item = (c: { inspected: string; google: string; user: string }) => ({ url: c.inspected, canonical_relations: classifyCanonicalRelations(c.inspected, c.google, c.user) });
const D1 = "2026-09-01T00:00:00.000Z", D2 = "2026-09-20T00:00:00.000Z", D3 = "2026-10-02T00:00:00.000Z";

test("backlog: conflict (cross-domain dahil) ve convergence kaydolur; ALIGNED kaydolmaz", () => {
  const aligned = item({ inspected: "https://pamistanbul.com/ok", google: "https://pamistanbul.com/ok", user: "https://pamistanbul.com/ok" });
  const b = updateBacklog(emptyBacklog(SITE), [item(CROSS), item(CONVERGE), aligned], D1);
  assert.equal(b.entries.length, 2);
  const c = b.entries.find((e) => e.url === CONFLICT)!;
  assert.equal(c.pattern, "DECLARED_GOOGLE_CONFLICT");
  assert.equal(c.cross_domain, true);
  assert.equal(c.first_seen, D1);
  assert.equal(c.owner_status, null);
  assert.equal(b.entries.find((e) => e.url === CONVERGE.inspected)!.pattern, "GOOGLE_USER_CONVERGE_ON_OTHER_URL");
});

test("backlog: first_seen korunur, last_seen ilerler", () => {
  const b1 = updateBacklog(emptyBacklog(SITE), [item(CROSS)], D1);
  const b2 = updateBacklog(b1, [item(CROSS)], D2);
  assert.equal(b2.entries[0].first_seen, D1);
  assert.equal(b2.entries[0].last_seen, D2);
});

test("FN koruma: kayit sonraki taramada yoksa NOT_OBSERVED olur, RESOLVED degil; neden ayrilir", () => {
  const b1 = updateBacklog(emptyBacklog(SITE), [item(CROSS), item(CONVERGE)], D1);
  const fixed = item({ ...CROSS, user: CROSS.google }); // denetlendi, artik celiski yok
  const other = item({ inspected: "https://pamistanbul.com/baska", google: "https://pamistanbul.com/baska", user: "https://pamistanbul.com/baska" });
  const b2 = updateBacklog(b1, [fixed, other], D2);
  const c = b2.entries.find((e) => e.url === CONFLICT)!, v = b2.entries.find((e) => e.url === CONVERGE.inspected)!;
  assert.equal(c.observation, "NOT_OBSERVED");
  assert.equal(c.not_observed_reason, "INSPECTED_NO_LONGER_MATCHING");
  assert.equal(v.not_observed_reason, "NOT_INSPECTED_IN_SAMPLE");
  for (const e of [c, v]) { assert.equal(e.owner_status, null); assert.equal(buildReport(hist(snap(T0, []), snap(T1, [])), b2, NOW).canonical_backlog.items.find((i) => i.url === e.url)!.status, "OPEN"); }
});

test("INCOMPLETE denetim 'duzeldi' sayilmaz (NOT_INSPECTED_IN_SAMPLE)", () => {
  const b1 = updateBacklog(emptyBacklog(SITE), [item(CROSS)], D1);
  const b2 = updateBacklog(b1, [{ url: CONFLICT, canonical_relations: classifyCanonicalRelations(CONFLICT, "UNKNOWN", "UNKNOWN") }], D2);
  assert.equal(b2.entries[0].not_observed_reason, "NOT_INSPECTED_IN_SAMPLE");
});

test("bos tarama (NOT_CONNECTED/erken durma) kayitlari degistirmez", () => {
  const b1 = updateBacklog(emptyBacklog(SITE), [item(CROSS)], D1);
  assert.deepEqual(updateBacklog(b1, [], D2), b1);
});

test("kod hicbir zaman RESOLVED_BY_OWNER/ACKNOWLEDGED yazmaz; sahip alanlari birebir korunur", () => {
  const b1 = updateBacklog(emptyBacklog(SITE), [item(CROSS), item(CONVERGE)], D1);
  b1.entries[0].owner_status = "ACKNOWLEDGED"; b1.entries[0].owner_by = "sefa"; b1.entries[0].owner_note = "bakiliyor";
  b1.entries[1].owner_status = "RESOLVED_BY_OWNER"; b1.entries[1].owner_at = D1;
  const owner = JSON.stringify(b1.entries.map((e) => [e.url, e.owner_status, e.owner_by, e.owner_at, e.owner_note]));
  const b2 = updateBacklog(updateBacklog(b1, [], D2), [item(CROSS)], D3);
  assert.equal(JSON.stringify(b2.entries.map((e) => [e.url, e.owner_status, e.owner_by, e.owner_at, e.owner_note])), owner);
  // Hic sahip yazmayan kayit hicbir yolla RESOLVED olmaz.
  const fresh = updateBacklog(updateBacklog(updateBacklog(emptyBacklog(SITE), [item(CROSS)], D1), [], D2), [item({ ...CROSS, user: CROSS.google })], D3);
  assert.equal(fresh.entries[0].owner_status, null);
});

test("sahip RESOLVED yazdiktan sonra yeniden gozlenirse isaretlenir (kapanis dogrulanamadi)", () => {
  const b1 = updateBacklog(emptyBacklog(SITE), [item(CROSS)], D1);
  b1.entries[0].owner_status = "RESOLVED_BY_OWNER";
  const b2 = updateBacklog(b1, [item(CROSS)], D2);
  assert.equal(b2.entries[0].reobserved_after_resolution, true);
  assert.equal(b2.entries[0].owner_status, "RESOLVED_BY_OWNER");
});

test("canonical-relations ciktisi YALNIZ okunur: dondurulmus girdi atmaz, siniflandirma ayni kalir", () => {
  const frozen = item(CROSS);
  Object.freeze(frozen.canonical_relations); Object.freeze(frozen.canonical_relations.reasons); Object.freeze(frozen);
  const before = JSON.stringify(frozen);
  const b = updateBacklog(emptyBacklog(SITE), [frozen], D1);
  assert.equal(JSON.stringify(frozen), before);
  assert.equal(b.entries[0].pattern, frozen.canonical_relations.canonical_pattern);
  // relations verilmezse mevcut siniflandirici cagrilir (kendi kural kopyamiz yok): ayni sonuc.
  const viaSummary = updateBacklog(emptyBacklog(SITE), [{ url: CROSS.inspected, summary: { google_canonical: CROSS.google, user_canonical: CROSS.user } }], D1);
  assert.equal(viaSummary.entries[0].pattern, b.entries[0].pattern);
});

test("yaslanma kovalari ve rapor: kapanmamis sayilir, RESOLVED_BY_OWNER yaslanmaya girmez", () => {
  assert.equal(ageBucket(D3, D3), "0-7d");
  assert.equal(ageBucket("2026-09-20T00:00:00Z", D3), "8-30d");
  assert.equal(ageBucket("2026-08-01T00:00:00Z", D3), "31-90d");
  assert.equal(ageBucket("2026-01-01T00:00:00Z", D3), ">90d");
  const b = updateBacklog(emptyBacklog(SITE), [item(CROSS), item(CONVERGE)], D1);
  b.entries[1].owner_status = "RESOLVED_BY_OWNER";
  const r = buildReport(hist(snap(T0, []), snap(T1, [])), b, D3).canonical_backlog;
  assert.deepEqual(r.by_status, { OPEN: 1, ACKNOWLEDGED: 0, RESOLVED_BY_OWNER: 1 });
  assert.equal(r.aging_open["31-90d"], 1);
  assert.equal(Object.values(r.aging_open).reduce((a, c) => a + c, 0), 1);
  assert.match(reportToMarkdown(buildReport(hist(snap(T0, []), snap(T1, [])), b, D3)), /NOT_OBSERVED|OBSERVED/);
});

test("backlog parse: fail-closed + site izolasyonu + tekrar", () => {
  const b = updateBacklog(emptyBacklog(SITE), [item(CROSS)], D1);
  assert.throws(() => parseBacklog(b, "spryhand"));
  assert.throws(() => parseBacklog({ ...b, entries: [...b.entries, ...b.entries] }, SITE), /tekrar/);
  assert.throws(() => parseBacklog({ ...b, entries: [{ ...b.entries[0], owner_status: "FIXED" }] }, SITE));
  assert.doesNotThrow(() => parseBacklog(b, SITE));
});
