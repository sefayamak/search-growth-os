// Change safety testleri. Her kontrol icin yanlis pozitif (gecmesi gerekeni engellemek) ve yanlis negatif
// (engellenmesi gerekeni gecirmek) ayri sinanir. Ag yok, yazma yok; kill-switch dosyalari gecici dizinde.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../src/registry.ts";
import {
  evaluate, advance, newRecord, readKillSwitch, parseKillSwitch, validateRollback, lintPlannedActions, splitCommands,
  DEFAULT_BUDGETS, HARD_GATED, CHANGE_CLASSES, type ChangeProposal, type LedgerEntry, type KillSwitchState, type ChangeClass,
} from "../src/change-safety.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const REG = loadRegistry(join(ROOT, "config/sites.yaml")).registry!;
const IDS = REG.sites.map((s) => s.id);
const NOW = new Date("2026-10-02T10:00:00Z");
const OPEN: KillSwitchState = { engaged: false, source: "FILE", reason: "kapali" };
const ENGAGED: KillSwitchState = { engaged: true, source: "FILE", scope: "global", reason: "test" };
const RB = { method: "git_revert", revert_ref: "commit abc1234", verification_probe: "curl -I sayfa 200 + canonical ayni" };
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function prop(over: Partial<ChangeProposal> = {}): ChangeProposal {
  return { id: "p1", site_id: "pamistanbul", change_class: "content", targets: ["https://pamistanbul.com/a"], proposed_by: "claude-session", evidence_label: "RECOMMENDATION", confidence: "CANDIDATE", rollback: RB, ...over };
}
const ev = (p: ChangeProposal, ledger: LedgerEntry[] = [], ks = OPEN, budgets?: Record<string, Partial<Record<ChangeClass, number>>>) => evaluate(p, ledger, { registry: REG, killSwitch: ks, now: NOW, budgets });
const led = (id: string, cls: ChangeClass, at: string, units = 1, site = "pamistanbul"): LedgerEntry => ({ proposal_id: id, site_id: site, change_class: cls, at, units });
const tmp = () => mkdtempSync(join(tmpdir(), "csafe-"));
const OWNER = { name: "Sefa Yamak", approved_at: "2026-10-02T09:00:00Z", channel: "github_pr_review" };

// --- butce ------------------------------------------------------------------------------------------------

test("FN: yuksek riskli siniflarin varsayilan butcesi 0 ve BLOCK_HIGH_RISK_NEEDS_OWNER", () => {
  for (const c of HARD_GATED) {
    assert.equal(DEFAULT_BUDGETS[c], 0);
    assert.equal(ev(prop({ change_class: c })).verdict, "BLOCK_HIGH_RISK_NEEDS_OWNER", c);
  }
});

test("FN: sahip override'i hard-gated sinifi acamaz (robots butcesi 99 verilse de)", () => {
  assert.equal(ev(prop({ change_class: "robots" }), [], OPEN, { pamistanbul: { robots: 99 } }).verdict, "BLOCK_HIGH_RISK_NEEDS_OWNER");
});

test("FP: butce icindeki content ALLOW_FOR_REVIEW; tum siniflar tanimli", () => {
  assert.equal(ev(prop()).verdict, "ALLOW_FOR_REVIEW");
  assert.deepEqual([...CHANGE_CLASSES].sort(), Object.keys(DEFAULT_BUDGETS).sort());
});

test("FN: tavan asimi (hedef sayisi birim sayilir), FP: tavana tam esit gecer", () => {
  const six = Array.from({ length: 6 }, (_, i) => `https://pamistanbul.com/p${i}`);
  assert.equal(ev(prop({ targets: six })).verdict, "BLOCK_OVER_BUDGET");
  assert.equal(ev(prop({ targets: six.slice(0, 5) })).verdict, "ALLOW_FOR_REVIEW");
  assert.equal(ev(prop(), [led("o", "content", ago(1), 5)]).verdict, "BLOCK_OVER_BUDGET");
  assert.equal(ev(prop(), [led("o", "content", ago(1), 4)]).verdict, "ALLOW_FOR_REVIEW");
});

test("rolling 7g: 8 gunluk kayit sayilmaz (FP), 6 gunluk sayilir (FN); bozuk/gelecek tarih sayilir", () => {
  assert.equal(ev(prop(), [led("o", "content", ago(8), 5)]).verdict, "ALLOW_FOR_REVIEW");
  assert.equal(ev(prop(), [led("o", "content", ago(6), 5)]).verdict, "BLOCK_OVER_BUDGET");
  assert.equal(ev(prop(), [led("o", "content", "bozuk-tarih", 5)]).verdict, "BLOCK_OVER_BUDGET");
  assert.equal(ev(prop(), [led("o", "content", ago(-2), 5)]).verdict, "BLOCK_OVER_BUDGET");
});

test("butce site ve sinif bazinda: baska sitenin/sinifin kullanimi sayilmaz; ayni proposal iki kez sayilmaz", () => {
  assert.equal(ev(prop(), [led("o", "content", ago(1), 5, "pamaistudio")]).verdict, "ALLOW_FOR_REVIEW");
  assert.equal(ev(prop(), [led("o", "internal_link", ago(1), 5)]).verdict, "ALLOW_FOR_REVIEW");
  assert.equal(ev(prop(), [led("p1", "content", ago(1), 5)]).verdict, "ALLOW_FOR_REVIEW"); // kendi onceki kaydi
  assert.equal(ev(prop(), [led("o", "content", ago(1), 3), led("o", "content", ago(1), 3)]).verdict, "ALLOW_FOR_REVIEW"); // ayni id tekrar
});

test("gecersiz override (negatif/NaN) sifira duser (fail-closed)", () => {
  assert.equal(ev(prop(), [], OPEN, { pamistanbul: { content: -1 } }).verdict, "BLOCK_OVER_BUDGET");
  assert.equal(ev(prop(), [], OPEN, { pamistanbul: { content: NaN } }).verdict, "BLOCK_OVER_BUDGET");
  assert.equal(ev(prop(), [], OPEN, { pamistanbul: { content: 1 } }).verdict, "ALLOW_FOR_REVIEW");
});

// --- rollback ---------------------------------------------------------------------------------------------

test("FN: rollback yok / alan eksik / dolgu deger REJECT", () => {
  assert.equal(ev(prop({ rollback: undefined })).verdict, "REJECT_INVALID_PROPOSAL");
  assert.equal(ev(prop({ rollback: { ...RB, verification_probe: "" } })).verdict, "REJECT_INVALID_PROPOSAL");
  assert.equal(ev(prop({ rollback: { ...RB, revert_ref: "TODO" } })).verdict, "REJECT_INVALID_PROPOSAL");
  assert.equal(ev(prop({ rollback: { ...RB, method: "n/a" } })).verdict, "REJECT_INVALID_PROPOSAL");
  assert.equal(validateRollback({ method: "x" }).length, 3); // 1 harf anlamli sayilmaz, diger ikisi eksik
});
test("FP: tam rollback kabul edilir", () => assert.deepEqual(validateRollback(RB), []));

test("proposal gecerliligi: RECOMMENDATION disi etiket, bilinmeyen sinif, bos hedef, onboard olmayan site", () => {
  assert.equal(ev(prop({ evidence_label: "VERIFIED_RESULT" })).verdict, "REJECT_INVALID_PROPOSAL");
  assert.equal(ev(prop({ change_class: "x" as ChangeClass })).verdict, "REJECT_INVALID_PROPOSAL");
  assert.equal(ev(prop({ targets: [] })).verdict, "REJECT_INVALID_PROPOSAL");
  const reg2 = { ...REG, sites: REG.sites.map((s) => (s.id === "spryhand" ? { ...s, onboarding_status: "registered_not_onboarded" as const } : s)) };
  const r = evaluate(prop({ site_id: "spryhand", targets: ["https://spryhand.com/a"] }), [], { registry: reg2, killSwitch: OPEN, now: NOW });
  assert.equal(r.verdict, "REJECT_INVALID_PROPOSAL");
});

// --- cross-site -------------------------------------------------------------------------------------------

test("FN: baska sitenin URL'si, lookalike host, userinfo hilesi, cift egik, alt alan, protokol BLOCK_CROSS_SITE", () => {
  for (const t of [
    "https://pamaistudio.com/a", "https://pamistanbul.com.evil.io/a", "https://evilpamistanbul.com/a", "https://pamistanbul.com@evil.com/a",
    "//spryhand.com/a", "https://blog.pamistanbul.com/a", "javascript:alert(1)", "ftp://pamistanbul.com/a", "kelime-ama-url-degil",
  ]) assert.equal(ev(prop({ targets: [t] })).verdict, "BLOCK_CROSS_SITE", t);
  assert.equal(ev(prop({ targets: ["https://pamistanbul.com/ok", "https://spryhand.com/x"] })).verdict, "BLOCK_CROSS_SITE"); // biri yeter
});

test("FP: kendi host'u, buyuk harf, sonda nokta, www kanonik host'u, goreli yol gecer", () => {
  const me = REG.sites.find((s) => s.id === "pamistanbul")!;
  for (const t of ["https://pamistanbul.com/a", "https://PAMISTANBUL.com/a", "https://pamistanbul.com./a", `https://${me.canonical_hostname}/a`, "/goreli/yol", "https://pamistanbul.com:443/a?q=1#x"])
    assert.equal(ev(prop({ targets: [t] })).verdict, "ALLOW_FOR_REVIEW", t);
});

test("varlik izolasyonu: baska sitenin marka/kisi adi engellenir; kendi varligi ve kayitsiz ad gecer", () => {
  const other = REG.sites.find((s) => s.id !== "pamistanbul" && s.brand_entities.length)!;
  assert.equal(ev(prop({ entities: [other.brand_entities[0]] })).verdict, "BLOCK_CROSS_SITE");
  assert.equal(ev(prop({ entities: [other.brand_entities[0].toUpperCase()] })).verdict, "BLOCK_CROSS_SITE");
  const mine = REG.sites.find((s) => s.id === "pamistanbul")!.brand_entities[0];
  if (mine) assert.equal(ev(prop({ entities: [mine] })).verdict, "ALLOW_FOR_REVIEW");
  assert.equal(ev(prop({ entities: ["kayitsiz bir ifade"] })).verdict, "ALLOW_FOR_REVIEW");
});

test("bilinmeyen site: BLOCK_CROSS_SITE (kayit yok = sinir yok)", () => {
  assert.equal(ev(prop({ site_id: "yok-site" })).verdict, "BLOCK_CROSS_SITE");
});

test("7 site: her sitenin kendi domain'i kendi icin gecer, digerlerinin domain'i engellenir", () => {
  for (const s of REG.sites) for (const o of REG.sites) {
    const v = ev(prop({ site_id: s.id, targets: [`https://${o.production_domain}/x`], entities: [] })).verdict;
    if (s.onboarding_status === "registered_not_onboarded") continue;
    assert.equal(v, s.id === o.id ? "ALLOW_FOR_REVIEW" : "BLOCK_CROSS_SITE", `${s.id} -> ${o.id}`);
  }
});

// --- kill-switch ------------------------------------------------------------------------------------------

test("kill-switch engaged: proposal gecerli olsa da BLOCK_KILL_SWITCH; bozuk proposal'dan once", () => {
  assert.equal(ev(prop(), [], ENGAGED).verdict, "BLOCK_KILL_SWITCH");
  assert.equal(ev(prop({ rollback: undefined }), [], ENGAGED).verdict, "BLOCK_KILL_SWITCH");
});

const ksJson = (o: unknown) => JSON.stringify(o);
const OK_FILE = { schema: "sgos.kill-switch.v1", global: { engaged: false }, sites: { spryhand: { engaged: true, reason: "deneme" } } };

test("kill-switch dosyasi: per-site sadece o siteyi, global hepsini durdurur (FP + FN)", () => {
  assert.equal(parseKillSwitch(ksJson(OK_FILE), "spryhand").engaged, true);
  assert.equal(parseKillSwitch(ksJson(OK_FILE), "spryhand").scope, "site");
  assert.equal(parseKillSwitch(ksJson(OK_FILE), "pamistanbul").engaged, false);
  const g = { ...OK_FILE, global: { engaged: true, reason: "olay" } };
  for (const id of IDS) assert.equal(parseKillSwitch(ksJson(g), id).engaged, true, id);
});

test("kill-switch fail-closed: bozuk JSON, yanlis schema, string 'false', eksik global, bilinmeyen site anahtari, dizi", () => {
  for (const t of ["{", "[]", "null", ksJson({ ...OK_FILE, schema: "v2" }), ksJson({ ...OK_FILE, global: { engaged: "false" } }), ksJson({ schema: OK_FILE.schema, sites: {} }), ksJson({ ...OK_FILE, sites: { spryhand: { engaged: 0 } } })]) {
    const s = parseKillSwitch(t, "pamistanbul");
    assert.equal(s.engaged, true, t); assert.equal(s.source, "FAIL_CLOSED");
  }
  assert.equal(parseKillSwitch(ksJson({ ...OK_FILE, sites: { spyhand: { engaged: true } } }), "pamistanbul", { knownSiteIds: IDS }).engaged, true); // yazim hatasi
});

test("kill-switch dosya IO: yok = ABSENT (engaged degil, gorunur), strict'te engaged; dizin = okunamaz = engaged", () => {
  const d = tmp();
  const a = readKillSwitch(join(d, "yok.json"), "pamistanbul");
  assert.equal(a.engaged, false); assert.equal(a.source, "ABSENT");
  assert.equal(readKillSwitch(join(d, "yok.json"), "pamistanbul", { strict: true }).engaged, true);
  assert.equal(readKillSwitch(d, "pamistanbul").engaged, true); // EISDIR
  writeFileSync(join(d, "ks.json"), ksJson(OK_FILE));
  assert.equal(readKillSwitch(join(d, "ks.json"), "spryhand", { knownSiteIds: IDS }).engaged, true);
  writeFileSync(join(d, "bad.json"), "{{");
  assert.equal(readKillSwitch(join(d, "bad.json"), "pamistanbul").source, "FAIL_CLOSED");
});

test("depoda varsayilan data/kill-switch.json sessizce uretilmemis olmali", () => {
  assert.equal(readKillSwitch(join(ROOT, "data/kill-switch.json"), "pamistanbul").source === "FILE" ? "var" : "yok", "yok");
});

// --- durum makinesi ---------------------------------------------------------------------------------------

function toApproved() {
  let r = newRecord(prop());
  const a = advance(r, "REVIEW_REQUIRED", { now: NOW, killSwitch: OPEN, evaluation: ev(prop()) });
  assert.ok(a.ok); r = a.ok ? a.record : r;
  return r;
}

test("sadece ileri, tek adim: atlama ve geri gitme yok (FN); tam yol gecer (FP)", () => {
  const r0 = newRecord(prop());
  const c = { now: NOW, killSwitch: OPEN, evaluation: ev(prop()), approver: OWNER, ref: "PR #1" };
  assert.equal(advance(r0, "OWNER_APPROVED", c).ok, false);
  assert.equal(advance(r0, "VERIFIED", c).ok, false);
  assert.equal(advance(r0, "PROPOSED", c).ok, false);
  let r = r0;
  for (const s of ["REVIEW_REQUIRED", "OWNER_APPROVED", "MERGED", "DEPLOYED", "VERIFIED"] as const) { const x = advance(r, s, c); assert.ok(x.ok, s); r = (x as { record: typeof r }).record; }
  assert.equal(r.state, "VERIFIED"); assert.equal(r.history.length, 5);
  assert.equal(advance(r, "MERGED", c).ok, false); // geri
  assert.equal(r0.state, "PROPOSED"); // girdi degismedi
});

test("REVIEW_REQUIRED yalniz uygun evaluate ile: butce asimi/cross-site/kill-switch/yok; hard-gated insan incelemesine girebilir", () => {
  const r0 = newRecord(prop());
  const go = (evaluation?: ReturnType<typeof ev>) => advance(r0, "REVIEW_REQUIRED", { now: NOW, killSwitch: OPEN, evaluation }).ok;
  assert.equal(go(undefined), false);
  assert.equal(go(ev(prop({ targets: ["https://spryhand.com/a"] }))), false);
  assert.equal(go(ev(prop({ rollback: undefined }))), false);
  assert.equal(go(ev(prop(), [led("o", "content", ago(1), 5)])), false);
  assert.equal(go(ev(prop({ change_class: "robots" }))), true);
  assert.equal(go(ev(prop())), true);
});

test("OWNER_APPROVED yalniz acik insan approver ile (FN): yok, bos, otomasyon, kendi onerisi, bozuk tarih", () => {
  const r = toApproved();
  const go = (approver?: unknown) => advance(r, "OWNER_APPROVED", { now: NOW, killSwitch: OPEN, approver: approver as never }).ok;
  assert.equal(go(undefined), false);
  assert.equal(go({}), false);
  assert.equal(go({ ...OWNER, name: "" }), false);
  assert.equal(go({ ...OWNER, name: "Claude" }), false);
  assert.equal(go({ ...OWNER, name: "github-actions[bot]" }), false);
  assert.equal(go({ ...OWNER, name: "claude-session" }), false); // proposer ayrica
  assert.equal(go({ ...OWNER, name: "release bot" }), false);
  assert.equal(go({ ...OWNER, approved_at: "dun" }), false);
  assert.equal(go({ ...OWNER, channel: "" }), false);
  assert.equal(go(OWNER), true); // FP: gercek insan gecer
  assert.equal(go({ ...OWNER, name: "Ayse Botan" }), true); // FP: "Botan" icindeki "bot" kelime degil
  assert.equal(r.state, "REVIEW_REQUIRED");
  // kod approver'i asla uretmez: gecis kaydi approver verilmeden OWNER_APPROVED'a ulasamaz
  assert.equal(advance(r, "OWNER_APPROVED", { now: NOW, killSwitch: OPEN, evaluation: ev(prop()) }).ok, false);
});

test("MERGED/DEPLOYED/VERIFIED ref ister; kill-switch acikken hicbir gecis olmaz", () => {
  let r = toApproved();
  const ap = advance(r, "OWNER_APPROVED", { now: NOW, killSwitch: OPEN, approver: OWNER }); assert.ok(ap.ok); r = (ap as { record: typeof r }).record;
  assert.equal(advance(r, "MERGED", { now: NOW, killSwitch: OPEN }).ok, false);
  assert.equal(advance(r, "MERGED", { now: NOW, killSwitch: OPEN, ref: "TBD" }).ok, false);
  assert.equal(advance(r, "MERGED", { now: NOW, killSwitch: ENGAGED, ref: "PR #7" }).ok, false);
  assert.equal(advance(r, "MERGED", { now: NOW, killSwitch: OPEN, ref: "PR #7" }).ok, true);
  assert.equal(advance(newRecord(prop()), "REVIEW_REQUIRED", { now: NOW, killSwitch: ENGAGED, evaluation: ev(prop()) }).ok, false);
});

// --- uretim mutasyonu lint'i ------------------------------------------------------------------------------

const sh = (command: string) => lintPlannedActions([{ kind: "shell", command }]);
const rules = (command: string) => sh(command).violations.map((v) => v.rule);

test("lint FN: main'e push her bicimde, deploy, merge, Indexing API, toplu indeksleme reddedilir", () => {
  for (const c of [
    "git push origin main", "git push origin HEAD:main", "git push --force origin main", "git push origin +main", "git push origin refs/heads/main",
    "git push", "git push origin", "git push --all origin", "git push --mirror", "cd x && git push origin master", "bash -c \"git push origin main\"", "sudo git push origin production",
  ]) assert.ok(rules(c).includes("push_main"), c);
  for (const c of ["vercel --prod", "vercel deploy", "npx vercel promote", "vercel", "FOO=1 vercel --prod --yes", "netlify deploy --prod", "wrangler deploy", "firebase deploy"]) assert.ok(rules(c).includes("deploy"), c);
  for (const c of ["gh pr merge 5 --squash", "gh api -X PUT repos/o/r/pulls/5/merge"]) assert.ok(rules(c).includes("merge_pr"), c);
  assert.ok(rules("curl -X POST https://indexing.googleapis.com/v3/urlNotifications:publish").includes("indexing_api"));
  assert.ok(rules("curl 'https://api.indexnow.org/indexnow?url=a&key=k'").includes("bulk_index_request"));
  assert.ok(rules("curl https://www.google.com/ping?sitemap=https://x.com/s.xml").includes("bulk_index_request"));
});

test("lint FP: dal push'u, commit mesajinda/echo/grep icinde gecen kelimeler, salt-okunur komutlar temiz", () => {
  for (const c of [
    "git push -u origin claude/sprint-change-safety", "git push origin HEAD:claude/x", "git commit -m \"deploy ve main yazisi\"", "git commit -m \"a && vercel --prod\"",
    "echo vercel --prod yasak", "grep -r 'git push origin main' docs/", "git log --grep=deploy", "vercel ls", "vercel inspect abc", "gh pr create --draft", "npm test && npm run typecheck", "git status; git diff",
    "node --experimental-strip-types src/cli.ts inspect-index config/sites.yaml --site pamistanbul",
  ]) assert.deepEqual(rules(c), [], c);
});

test("lint: eylem turleri (kind) - yazma turleri red, guvenli turler gecer, taninmayan fail-closed", () => {
  const bad = ["push_main", "deploy", "indexing_api", "bulk_index_request", "merge_pr"];
  for (const kind of bad) assert.equal(lintPlannedActions([{ kind }]).ok, false, kind);
  assert.equal(lintPlannedActions([{ kind: "index_request", urls: ["a", "b"] }]).violations[0].rule, "bulk_index_request");
  assert.equal(lintPlannedActions([{ kind: "index_request", urls: ["a"] }]).ok, false); // tek URL de onaysiz yapilmaz
  assert.equal(lintPlannedActions([{ kind: "index_request" }]).violations[0].rule, "bulk_index_request"); // sayi bilinmiyor = toplu say
  assert.equal(lintPlannedActions([{ kind: "branch_push", branch: "main" }]).ok, false);
  assert.equal(lintPlannedActions([{ kind: "branch_push" }]).ok, false);
  assert.equal(lintPlannedActions([{ kind: "teleport" }]).violations[0].rule, "unclassified");
  assert.equal(lintPlannedActions([{ kind: "shell" }]).ok, false);
  const ok = ["read", "measure", "report_write", "local_commit", "open_draft_pr", "propose"].map((kind) => ({ kind }));
  assert.equal(lintPlannedActions([...ok, { kind: "branch_push", branch: "claude/sprint-x" }]).ok, true);
});

test("lint http_write: uretim host'una yazma red, GET ve baska host gecer; indeks raporlanir", () => {
  const o = { productionHosts: ["pamistanbul.com"] };
  assert.equal(lintPlannedActions([{ kind: "http_write", method: "POST", host: "pamistanbul.com" }], o).ok, false);
  assert.equal(lintPlannedActions([{ kind: "http_write", method: "PUT", host: "PAMISTANBUL.com" }], o).ok, false);
  assert.equal(lintPlannedActions([{ kind: "http_write", method: "POST" }], o).ok, false); // host yok
  assert.equal(lintPlannedActions([{ kind: "http_write", method: "GET", host: "pamistanbul.com" }], o).ok, true);
  assert.equal(lintPlannedActions([{ kind: "http_write", method: "POST", host: "localhost" }], o).ok, true);
  const r = lintPlannedActions([{ kind: "read" }, { kind: "deploy" }, { kind: "read" }, { kind: "shell", command: "git push origin main" }]);
  assert.deepEqual(r.violations.map((v) => v.index), [1, 3]);
});

test("splitCommands tirnak duyarli", () => {
  assert.deepEqual(splitCommands("a && b | c; d"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitCommands("git commit -m \"x && y\" && ls"), ["git commit -m \"x && y\"", "ls"]);
});

// --- Iki yol: A (READ_ONLY_RECOMMENDATION) / B (PRODUCTION_MUTATION) -----------------------------------------
import * as CS from "../src/change-safety.ts";
import { readFileSync } from "node:fs";
import {
  authorizeProductionMutation, checkReadOnlyRecommendation, requireAuthorization, isProductionMutationAuthorization,
  type ProductionMutationInput, type ProductionMutationAuthorization, type ArmToken, type MutationGate,
} from "../src/change-safety.ts";

const READ_OK: KillSwitchState = { engaged: false, source: "FILE", reason: "kapali", site_id: "pamistanbul", read_at: new Date(NOW.getTime() - 30_000).toISOString() };
const ARM: ArmToken = { armed: true, armed_by: "Sefa Yamak", armed_at: "2026-10-02T09:30:00Z", scope: { site_id: "pamistanbul", change_classes: ["content"], expires_at: "2026-10-02T12:00:00Z" } };
const SAFE = [{ kind: "open_draft_pr", branch: "claude/x" }];
function approvedRecord(p = prop()) {
  const a = advance(newRecord(p), "REVIEW_REQUIRED", { now: NOW, killSwitch: OPEN, evaluation: ev(p) });
  if (!a.ok) return newRecord(p); // onay yolu zaten kapaliysa kayit PROPOSED kalir: ilgili kapi bunu yakalar
  const b = advance(a.record, "OWNER_APPROVED", { now: NOW, killSwitch: OPEN, approver: OWNER });
  return b.ok ? b.record : newRecord(p);
}
function bin(over: Partial<ProductionMutationInput> = {}): ProductionMutationInput {
  const p = over.proposal ?? prop();
  return { proposal: p, arm: ARM, record: approvedRecord(p), approver: OWNER, killSwitch: READ_OK, ledger: [], plannedActions: SAFE, registry: REG, now: NOW, ...over };
}
const gates = (i: ProductionMutationInput): MutationGate[] => { const d = authorizeProductionMutation(i); return d.decision === "BLOCKED" ? d.failed.map((f) => f.gate) : []; };

test("FP: tum kapilar saglanirsa yalniz AUTHORIZED_FOR_HUMAN_EXECUTION (uygulama degil)", () => {
  const d = authorizeProductionMutation(bin());
  assert.equal(d.decision, "AUTHORIZED_FOR_HUMAN_EXECUTION");
  if (d.decision !== "AUTHORIZED_FOR_HUMAN_EXECUTION") return;
  assert.deepEqual(d.failed, []);
  assert.match(d.note, /uygulayan hicbir sey yok/);
  assert.equal(isProductionMutationAuthorization(d.authorization), true);
  assert.equal(requireAuthorization(d.authorization), d.authorization);
});

test("FN: her kapi tek basina eksikse BLOCKED ve o kapi listelenir", () => {
  const cases: [string, Partial<ProductionMutationInput>, MutationGate][] = [
    ["kill-switch ABSENT", { killSwitch: { engaged: false, source: "ABSENT", reason: "yok", site_id: "pamistanbul", read_at: READ_OK.read_at } }, "kill_switch"],
    ["kill-switch UNKNOWN/yok", { killSwitch: undefined as any }, "kill_switch"],
    ["kill-switch FAIL_CLOSED", { killSwitch: { engaged: true, source: "FAIL_CLOSED", reason: "bozuk", site_id: "pamistanbul" } }, "kill_switch"],
    ["kill-switch bayat", { killSwitch: { ...READ_OK, read_at: new Date(NOW.getTime() - 600_000).toISOString() } }, "kill_switch"],
    ["kill-switch read_at yok", { killSwitch: { ...READ_OK, read_at: undefined } }, "kill_switch"],
    ["kill-switch baska site icin", { killSwitch: { ...READ_OK, site_id: "spryhand" } }, "kill_switch"],
    ["arm yok", { arm: undefined }, "armed"],
    ["arm suresi dolmus", { arm: { ...ARM, scope: { ...ARM.scope, expires_at: "2026-10-02T09:59:00Z" } } }, "armed"],
    ["arm expires_at yok (sonsuz)", { arm: { ...ARM, scope: { ...ARM.scope, expires_at: undefined as any } } }, "armed"],
    ["arm 24 saati asiyor", { arm: { ...ARM, scope: { ...ARM.scope, expires_at: "2026-10-04T09:30:00Z" } } }, "armed"],
    ["arm otomasyon kimligiyle", { arm: { ...ARM, armed_by: "claude-session" } }, "armed"],
    ["arm armed_by bos", { arm: { ...ARM, armed_by: "" } }, "armed"],
    ["arm armed:false", { arm: { ...ARM, armed: false as any } }, "armed"],
    ["arm yanlis site", { arm: { ...ARM, scope: { ...ARM.scope, site_id: "spryhand" } } }, "arm_scope"],
    ["arm yanlis sinif", { arm: { ...ARM, scope: { ...ARM.scope, change_classes: ["internal_link"] } } }, "arm_scope"],
    ["onay (approver) yok", { approver: undefined }, "approval"],
    ["onay: otomasyon", { approver: { ...OWNER, name: "github-actions" } }, "approval"],
    ["onay kaydi yok", { record: undefined }, "approval"],
    ["onay kaydi PROPOSED", { record: newRecord(prop()) }, "approval"],
    ["rollback yok", { proposal: prop({ rollback: undefined }) }, "rollback"],
    ["rollback dolgu", { proposal: prop({ rollback: { ...RB, method: "TODO" } }) }, "rollback"],
    ["butce asildi", { ledger: [led("o", "content", ago(1), 5)] }, "budget"],
    ["hard-gated sinif (butce 0)", { proposal: prop({ change_class: "robots" }), arm: { ...ARM, scope: { ...ARM.scope, change_classes: ["robots"] } } }, "budget"],
    ["lint: main'e push", { plannedActions: [{ kind: "push_main" }] }, "lint"],
    ["lint: bos eylem listesi", { plannedActions: [] }, "lint"],
    ["cross-site hedef", { proposal: prop({ targets: ["https://spryhand.com/a"] }) }, "proposal"],
  ];
  for (const [name, over, gate] of cases) {
    const d = authorizeProductionMutation(bin(over));
    assert.equal(d.decision, "BLOCKED", name);
    assert.ok(d.decision === "BLOCKED" && d.failed.some((f) => f.gate === gate && f.reasons.length > 0), `${name}: ${gate} listelenmedi`);
  }
});

test("hicbir kapi kisa devre yapmaz: coklu ihlal hepsini listeler", () => {
  const g = gates(bin({ arm: undefined, approver: undefined, plannedActions: [{ kind: "deploy" }], killSwitch: { ...READ_OK, source: "ABSENT" } }));
  for (const x of ["kill_switch", "armed", "arm_scope", "approval", "lint"] as MutationGate[]) assert.ok(g.includes(x), x);
});

test("A vs B: ABSENT kill-switch A'yi gecirir, B'yi engeller; engaged ikisini de engeller", () => {
  const absent: KillSwitchState = { engaged: false, source: "ABSENT", reason: "yok" };
  assert.equal(checkReadOnlyRecommendation(absent).allowed, true);
  assert.equal(authorizeProductionMutation(bin({ killSwitch: absent })).decision, "BLOCKED");
  assert.equal(checkReadOnlyRecommendation(ENGAGED).allowed, false);
  assert.ok(gates(bin({ killSwitch: { ...ENGAGED, site_id: "pamistanbul", read_at: READ_OK.read_at } })).includes("kill_switch"));
  assert.equal(checkReadOnlyRecommendation(undefined as any).allowed, false);
});

test("B gercek dosyadan: ABSENT dosya BLOCKED, taze okunmus kapali dosya gecer; opt-out bayragi yok sayilir", () => {
  const d = tmp();
  assert.ok(gates(bin({ killSwitch: readKillSwitch(join(d, "yok.json"), "pamistanbul") })).includes("kill_switch"));
  writeFileSync(join(d, "ks.json"), JSON.stringify({ schema: "sgos.kill-switch.v1", global: { engaged: false }, sites: {} }));
  const k = readKillSwitch(join(d, "ks.json"), "pamistanbul", { knownSiteIds: IDS });
  assert.equal(k.source, "FILE");
  assert.ok(k.read_at && k.site_id === "pamistanbul");
  // readKillSwitch read_at'i GERCEK saatten uretir (saat enjekte edilemez). Sabit tarihli ARM, duvar saati
  // 2026-10-02T12:00Z'yi gecince suresi dolmus sayilip bu testi kirdi (zaman bombasi). Arm penceresi bu yuzden
  // read_at'e gore turetilir: test hangi gun kosarsa kossun ayni sonucu verir.
  const readAt = new Date(k.read_at!).getTime();
  const arm: ArmToken = { ...ARM, armed_at: new Date(readAt - 30 * 60_000).toISOString(), scope: { ...ARM.scope, expires_at: new Date(readAt + 60 * 60_000).toISOString() } };
  assert.equal(authorizeProductionMutation({ ...bin(), arm, killSwitch: k, now: new Date(k.read_at!) }).decision, "AUTHORIZED_FOR_HUMAN_EXECUTION");
  assert.ok(gates({ ...bin({ killSwitch: { engaged: false, source: "ABSENT", reason: "yok" } }), strict: false, allowAbsent: true } as any).includes("kill_switch"));
});

test("fail-closed: istisna ve bozuk girdi BLOCKED, asla throw/AUTHORIZED", () => {
  for (const bad of [undefined, null, {}, { now: "x" }, { ...bin(), now: new Date("x") }, { ...bin(), proposal: null }, { ...bin(), plannedActions: null }]) {
    let d: ReturnType<typeof authorizeProductionMutation> | undefined;
    assert.doesNotThrow(() => { d = authorizeProductionMutation(bad as any); });
    assert.equal(d!.decision, "BLOCKED");
  }
  const boom = { ...bin(), get ledger(): LedgerEntry[] { throw new Error("patladi"); } };
  assert.equal(authorizeProductionMutation(boom as any).decision, "BLOCKED");
});

test("tip sozlesmesi: yazici yetki nesnesi ister; sahte nesne tip ve calisma zamaninda reddedilir", () => {
  // Hayali yazici (gercek degil, hicbir sey yapmaz): imza yetkiyi zorunlu kilar.
  const hypotheticalWriter = (auth: ProductionMutationAuthorization): string => requireAuthorization(auth).proposal_id;
  const forged = { proposal_id: "p1", site_id: "pamistanbul", change_class: "content", targets: [], authorized_at: "x", arm_expires_at: "y" };
  // @ts-expect-error sahte nesne marka olmadan ProductionMutationAuthorization degildir
  assert.throws(() => hypotheticalWriter(forged));
  const d = authorizeProductionMutation(bin());
  assert.equal(d.decision, "AUTHORIZED_FOR_HUMAN_EXECUTION");
  if (d.decision !== "AUTHORIZED_FOR_HUMAN_EXECUTION") return;
  assert.throws(() => requireAuthorization({ ...d.authorization })); // kopya da gecmez
  assert.throws(() => requireAuthorization(undefined));
  assert.equal(hypotheticalWriter(d.authorization), "p1");
  assert.equal(Object.isFrozen(d.authorization), true);
});

test("arm tokeni modulden uretilemez: kurucu/varsayilan export yok; kaynakta yazma/ag yok", () => {
  const names = Object.keys(CS);
  assert.deepEqual(names.filter((n) => /^(make|create|issue|grant|build|new|default|mint)/i.test(n) && /arm|auth/i.test(n)), []);
  assert.deepEqual(names.filter((n) => /arm/i.test(n) && typeof (CS as any)[n] === "function"), []);
  const src = readFileSync(new URL("../src/change-safety.ts", import.meta.url), "utf8");
  assert.equal(/armed\s*:\s*true\s*[,}]/.test(src), false); // yalniz `armed: true;` tip bildirimi var, deger literal'i yok
  assert.equal(/writeFile|appendFile|fetch\(|node:https?|node:net|child_process/.test(src), false);
});
