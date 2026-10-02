// CLI baglama SOZLESME testleri (docs/integration/cli-wiring-plan.md). 12 yeni komut, GERCEK child process
// (node --experimental-strip-types src/cli.ts ...), her biri gecici bir sandbox dizininde (cwd = sandbox).
// Kurallar: ag YOK (her kosu fetch + ham soket yasaklayan bir preload ile calisir; denenirse isaret dosyasi dolar ve test duser),
// gercek deponun data/ dizinine yazilmaz, canli API cagrilmaz. Her komut icin: --help, mutlu yol, eksik girdi, bozuk girdi,
// yanlis site (uygulanabildigi yerde); ASSERT = cikis kodu + anahtar cikti. Atlanan test yok.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.ts");
const FX = join(ROOT, "tests", "fixtures", "cli-wiring");
const NO_NET = join(FX, "no-network.mjs");
const MOCK_PSI = join(FX, "mock-psi.mjs");
const MARKS = mkdtempSync(join(tmpdir(), "cliwire-marks-"));
let seq = 0;

const COMMANDS = ["clarity-takeover-status", "deployment-timeline", "deployment-ingest", "content-validate", "content-classify", "index-alarms", "agent-contracts-validate", "performance-measure", "change-eval", "change-lint", "scorecard", "orchestration-check"];

/** Her test kendi sandbox'inda calisir: cwd = gecici dizin, config/sites.yaml kopyasi var. Yazma yalniz buraya olabilir. */
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "cliwire-"));
  mkdirSync(join(d, "config"));
  copyFileSync(join(ROOT, "config", "sites.yaml"), join(d, "config", "sites.yaml"));
  return d;
}
const put = (dir: string, name: string, data: unknown) => { const p = join(dir, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data)); return p; };
const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();

interface Run { status: number | null; stdout: string; stderr: string; net: string; }
/** Ortam bilerek bos (yalniz PATH): PAGESPEED_API_KEY vb. sizamaz. `preload` verilmezse ag yasagi preload'i kullanilir. */
function cli(cwd: string, args: string[], o: { env?: Record<string, string>; preload?: string } = {}): Run {
  const mark = join(MARKS, `m${++seq}.log`);
  const r = spawnSync(process.execPath, ["--import", o.preload ?? NO_NET, "--experimental-strip-types", CLI, ...args], {
    cwd, env: { PATH: process.env.PATH ?? "", NET_MARK: mark, ...o.env }, encoding: "utf8", timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, net: existsSync(mark) ? readFileSync(mark, "utf8") : "" };
}
/** Ag yasagi preload'i devredeyken HICBIR ag denemesi olmamali (mock'lu testler haric). */
function offline(r: Run, what = ""): Run { assert.equal(r.net, "", `${what}: ag denemesi: ${r.net}`); return r; }
/** Bozuk girdi bir yigin izi ile cokmemeli: tek satir hata + exit 1. */
const noStack = (r: Run, what = "") => assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at .+\(.+:\d+:\d+\)|node:internal|TypeError|SyntaxError: /, `${what}: yigin izi sizdi: ${r.stderr.slice(0, 300)}`);

// --- fixture kurucular ---------------------------------------------------------------------------------------------------
const gscRow = (site: string, page: string, over: Record<string, unknown> = {}) => ({ site, page, query: "q", impressions: 120, clicks: 2, position: 12, source: "gsc", date_start: "2026-09-01", date_end: "2026-09-28", ...over });
const contentItem = (rows: unknown[], site = "pamistanbul") => ({ schema: "sgos.content-item.v1", site, id: "item-001", opportunity_source: "gsc_evidence", gsc_rows: rows, classification: "refresh", stage: "OPPORTUNITY", evidence_label: "INFERENCE", confidence: "CANDIDATE", approval: { state: "pending", approver: null }, risk: "low" });
const depEvent = (site: string) => ({ schema: "sgos.deployment-event.v1", site, environment: "production", commit_sha: "a".repeat(40), deployed_at: "2026-10-01T10:00:00Z", verification_state: "UNVERIFIED", provenance: { source: "manual_fixture", retrieved_at: "2026-10-02T00:00:00Z", ref: "x" }, evidence: "FACT" });
const timeline = (site: string, evSite = site) => ({ schema: "sgos.deployment-timeline.v1", site, events: [depEvent(evSite)] });
const linkInput = (target: string) => ({ id: "link-001", kind: "internal_link", site: "pamistanbul", source_url: "https://pamistanbul.com/a", target_url_or_entity: target, reason: "test", evidence: { refs: ["https://pamistanbul.com/a"], label: "INFERENCE" }, confidence: "CANDIDATE", risk: "low", expected_change: { hypothesis: "daha iyi gezinme", test: "dokunulan ve dokunulmayan sayfalari kiyasla" }, approval_state: "PROPOSED", mutation: "none" });
const proposal = (cls: string, site = "pamistanbul") => ({ id: "p1", site_id: site, change_class: cls, targets: ["https://pamistanbul.com/a"], proposed_by: "claude-session", evidence_label: "RECOMMENDATION", confidence: "CANDIDATE", rollback: { method: "git_revert", revert_ref: "commit abc1234", verification_probe: "durum kodu ve canonical ayni" } });
const ghDeployments = [{ id: 7, environment: "production", sha: "b".repeat(40), created_at: "2026-10-01T10:00:00Z" }];

// =============================================================================================================================
// Genel
// =============================================================================================================================

test("global kullanim: bilinmeyen komut exit 1 ve 12 yeni komutun hepsini listeler", () => {
  const r = offline(cli(sandbox(), ["nope"]));
  assert.equal(r.status, 1);
  for (const c of COMMANDS) assert.ok(r.stderr.includes(c), `${c} global kullanim satirinda yok`);
});

test("--help: her yeni komut kendi kullanim satirini basar, exit 0, stderr bos, dosya yazmaz, ag yok", () => {
  for (const c of COMMANDS) {
    const d = sandbox();
    const before = tree(d);
    for (const h of ["--help", "-h"]) {
      const r = offline(cli(d, [c, h]), c);
      assert.equal(r.status, 0, `${c} ${h}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`^kullanim: ${c}\\b`), c);
      assert.equal(r.stderr, "", c);
    }
    assert.deepEqual(tree(d), before, `${c} --help dosya yazdi`);
  }
});

test("--help yan etkisiz: gerekli dosya argumani/registry olmadan da calisir (performance-measure anahtar varken bile istek atmaz)", () => {
  const empty = mkdtempSync(join(tmpdir(), "cliwire-empty-"));
  const r = offline(cli(empty, ["performance-measure", "--help"], { env: { PAGESPEED_API_KEY: "DUMMY-help-key-1" } }));
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes("DUMMY-help-key-1"));
  assert.deepEqual(readdirSync(empty), []);
});

test("dosya girdili komutlar: dosya argumani yoksa kullanim + exit 1 (sessiz 0 yok)", () => {
  for (const c of ["deployment-timeline", "deployment-ingest", "content-validate", "content-classify", "agent-contracts-validate", "change-eval", "change-lint"]) {
    const r = offline(cli(sandbox(), [c]), c);
    assert.equal(r.status, 1, c);
    assert.match(r.stderr, /kullanim/, c);
    noStack(r, c);
  }
});

test("registry verilirse ve gecersizse: registry kullanan komutlar fail-closed exit 1 (yigin izi yok)", () => {
  const d = sandbox();
  const bad = put(d, "bad-registry.yaml", "sites: [oops");
  const f = put(d, "x.json", []);
  for (const args of [["clarity-takeover-status", bad], ["scorecard", bad], ["index-alarms", bad, "--site", "pamistanbul"], ["performance-measure", bad], ["content-validate", f, "--registry", bad], ["agent-contracts-validate", f, "--registry", bad], ["change-lint", f, "--registry", bad], ["deployment-timeline", f, "--registry", bad]]) {
    const r = offline(cli(d, args), args[0]);
    assert.equal(r.status, 1, `${args[0]}: ${r.stdout}${r.stderr}`);
    noStack(r, args[0]);
  }
});

test("izolasyon: yeni komut blogu fetch/child_process/exec/spawn icermez; tek ag yolu performance.ts -> performance-psi.ts", () => {
  const src = readFileSync(CLI, "utf8");
  const block = src.slice(src.indexOf('case "clarity-takeover-status"'), src.indexOf("    default:\n      console.error(\"commands:"));
  assert.ok(block.length > 3000);
  assert.doesNotMatch(block, /\bfetch\s*\(|child_process|execSync|execFile|\bexec\(|\bspawn(Sync)?\(|git push|gh pr/);
});

// =============================================================================================================================
// clarity-takeover-status
// =============================================================================================================================

test("clarity-takeover-status: gercek commit'li history ile salt-okunur rapor, exit 0; FULL_TAKEOVER_SUCCESS iddia edilmez", () => {
  const r = offline(cli(ROOT, ["clarity-takeover-status", "config/sites.yaml", "--history", "data/clarity-history"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Clarity takeover durumu/);
  assert.match(r.stdout, /history\.source_run_id/);
  assert.doesNotMatch(r.stdout, /--runs/);
  const j = offline(cli(ROOT, ["clarity-takeover-status", "--json"]));
  assert.equal(j.status, 0);
  const s = JSON.parse(j.stdout);
  assert.equal(s.evidence_source, "history.source_run_id");
  assert.notEqual(s.chain_state, "FULL_TAKEOVER_SUCCESS");
});

test("clarity-takeover-status: bos/eksik history dizini = zincir NONE (UNKNOWN), 0 uydurulmaz; bozuk site gecmisi exit 1", () => {
  const d = sandbox();
  const none = offline(cli(d, ["clarity-takeover-status", "--history", join(d, "yok")]));
  assert.equal(none.status, 0);
  assert.match(none.stdout, /Zincir: `NONE`/);
  assert.doesNotMatch(none.stdout, /FULL_TAKEOVER_SUCCESS|COVERAGE_VALIDATION_SUCCESS/);
  put(d, "hist/pamistanbul.json", "{bozuk");
  const bad = offline(cli(d, ["clarity-takeover-status", "--history", join(d, "hist")]));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /Site sorunlari[\s\S]*pamistanbul/);
  noStack(bad);
});

// =============================================================================================================================
// deployment-timeline
// =============================================================================================================================

test("deployment-timeline: mutlu yol (UNVERIFIED sayilir, VERIFIED iddiasi yok); eksik dosya, bozuk JSON, yanlis schema = exit 1", () => {
  const d = sandbox();
  const ok = offline(cli(d, ["deployment-timeline", put(d, "g.json", timeline("pamistanbul"))]));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /UNVERIFIED=1/);
  assert.match(ok.stdout, /VERIFIED yalniz canli SHA/);
  for (const [name, content] of [["yok.json", null], ["bozuk.json", "{bozuk"], ["schema.json", { x: 1 }]] as const) {
    const r = offline(cli(d, ["deployment-timeline", content === null ? join(d, name) : put(d, name, content)]), name);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /deployment-timeline HATA/);
    noStack(r, name);
  }
});

test("deployment-timeline: yabanci site olayi, registry'de olmayan site ve --site uyusmazligi reddedilir", () => {
  const d = sandbox();
  const foreignEvent = cli(d, ["deployment-timeline", put(d, "b.json", timeline("pamistanbul", "pamaistudio"))]);
  assert.equal(foreignEvent.status, 1);
  const unknown = cli(d, ["deployment-timeline", put(d, "u.json", timeline("yok-site"))]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /registry'de yok/);
  const mismatch = cli(d, ["deployment-timeline", put(d, "m.json", timeline("pamistanbul")), "--site", "pamaistudio"]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /uyusmuyor/);
});

// =============================================================================================================================
// deployment-ingest
// =============================================================================================================================

test("deployment-ingest: --write olmadan dosya yazmaz; --write yalniz sandbox'a yazar; HICBIR olay VERIFIED olmaz", () => {
  const d = sandbox();
  const src = put(d, "gh.json", ghDeployments);
  const dry = offline(cli(d, ["deployment-ingest", src, "--site", "pamistanbul", "--provider", "github", "--timeline", "tl"]));
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1 olay okundu · 1 yeni · 0 reddedildi/);
  assert.match(dry.stdout, /hicbir dosya yazilmadi/);
  assert.ok(!existsSync(join(d, "tl")));
  const w = offline(cli(d, ["deployment-ingest", src, "--site", "pamistanbul", "--provider", "github", "--timeline", "tl", "--write"]));
  assert.equal(w.status, 0, w.stderr);
  const tl = JSON.parse(readFileSync(join(d, "tl", "pamistanbul.json"), "utf8"));
  assert.equal(tl.site, "pamistanbul");
  assert.ok(tl.events.length >= 1);
  for (const e of tl.events) { assert.notEqual(e.verification_state, "VERIFIED"); assert.equal(e.verification_state, "UNVERIFIED"); }
  const vercel = put(d, "v.json", { deployments: [{ uid: "dpl_1", target: "production", created: Date.UTC(2026, 9, 1, 10), meta: { githubCommitSha: "c".repeat(40) } }] });
  const v = offline(cli(d, ["deployment-ingest", vercel, "--site", "pamistanbul", "--provider", "vercel", "--timeline", "tl", "--write"]));
  assert.equal(v.status, 0, v.stderr);
  const tl2 = JSON.parse(readFileSync(join(d, "tl", "pamistanbul.json"), "utf8"));
  assert.ok(tl2.events.length >= 2);
  assert.ok(tl2.events.every((e: { verification_state: string }) => e.verification_state === "UNVERIFIED"));
});

test("deployment-ingest: satir bazli ret yazdirilir (sessiz dusmez); bozuk/eksik girdi, bilinmeyen site/provider = exit 1", () => {
  const d = sandbox();
  const partial = offline(cli(d, ["deployment-ingest", put(d, "p.json", [ghDeployments[0], { id: 8, environment: "production", sha: "kisa", created_at: "x" }]), "--site", "pamistanbul", "--provider", "github"]));
  assert.equal(partial.status, 0);
  assert.match(partial.stdout, /REDDEDILDI #1/);
  const base = ["--site", "pamistanbul", "--provider", "github"];
  for (const [name, args] of [
    ["eksik", [join(d, "yok.json"), ...base]], ["bozuk", [put(d, "b.json", "{x"), ...base]], ["sekil", [put(d, "o.json", { a: 1 }), ...base]],
    ["site", [put(d, "g.json", ghDeployments), "--site", "yok-site", "--provider", "github"]], ["provider", [put(d, "g2.json", ghDeployments), "--site", "pamistanbul", "--provider", "gitlab"]],
  ] as const) {
    const r = offline(cli(d, ["deployment-ingest", ...args]), name);
    assert.equal(r.status, 1, name);
    noStack(r, name);
  }
});

test("deployment-ingest: mevcut cizelge baska siteye aitse reddedilir ve DOSYA DEGISMEZ; --timeline cwd disina yazamaz", () => {
  const d = sandbox();
  const foreign = put(d, "tl/pamistanbul.json", timeline("pamaistudio"));
  const before = readFileSync(foreign, "utf8");
  const r = offline(cli(d, ["deployment-ingest", put(d, "gh.json", ghDeployments), "--site", "pamistanbul", "--provider", "github", "--timeline", "tl", "--write"]));
  assert.equal(r.status, 1);
  assert.equal(readFileSync(foreign, "utf8"), before);
  const out = offline(cli(d, ["deployment-ingest", join(d, "gh.json"), "--site", "pamistanbul", "--provider", "github", "--timeline", "../escape", "--write"]));
  assert.equal(out.status, 1);
  assert.match(out.stderr, /repo-yerel/);
  assert.ok(!existsSync(join(d, "..", "escape")));
});

// =============================================================================================================================
// content-validate / content-classify
// =============================================================================================================================

test("content-validate: temiz kayit OK (yanlis pozitif yok); yabanci site GSC satiri GECERSIZ (yanlis negatif yok)", () => {
  const d = sandbox();
  const good = offline(cli(d, ["content-validate", put(d, "good.json", contentItem([gscRow("pamistanbul", "https://pamistanbul.com/a")]))]));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /^OK pamistanbul\/item-001/m);
  const bad = offline(cli(d, ["content-validate", put(d, "bad.json", contentItem([gscRow("pamaistudio", "https://pamaistudio.com/x")]))]));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /GECERSIZ/);
  const unknown = offline(cli(d, ["content-validate", put(d, "u.json", contentItem([gscRow("yok-site", "https://x.test/a")], "yok-site"))]));
  assert.equal(unknown.status, 1);
});

test("content-validate: eksik dosya, bozuk JSON, nesne olmayan kayit, gecersiz --to = exit 1 (yigin izi yok)", () => {
  const d = sandbox();
  for (const [name, args] of [["eksik", [join(d, "yok.json")]], ["bozuk", [put(d, "b.json", "{x")]], ["null", [put(d, "n.json", "null")]], ["dizi-ici-sayi", [put(d, "j.json", [null, 1, "a"])]], ["to", [put(d, "g.json", contentItem([gscRow("pamistanbul", "https://pamistanbul.com/a")])), "--to", "YAYINLA"]]] as const) {
    const r = offline(cli(d, ["content-validate", ...args]), name);
    assert.equal(r.status, 1, name);
    noStack(r, name);
  }
});

test("content-classify: esik alti satir CONFIRMED uretmez (INFERENCE); dizi/{rows} kabul; bos, nesne olmayan, bozuk, eksik = exit 1", () => {
  const d = sandbox();
  const low = offline(cli(d, ["content-classify", put(d, "low.json", [gscRow("pamistanbul", "https://pamistanbul.com/a", { impressions: 3, position: 4 })])]));
  assert.equal(low.status, 0, low.stderr);
  const out = JSON.parse(low.stdout);
  assert.equal(out.classification, "skip");
  assert.equal(out.evidence_label, "INFERENCE");
  assert.notEqual(out.confidence, "CONFIRMED");
  const wrapped = offline(cli(d, ["content-classify", put(d, "w.json", { rows: [gscRow("pamistanbul", "https://pamistanbul.com/a")] })]));
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(JSON.parse(wrapped.stdout).evidence_label, "INFERENCE");
  for (const [name, f] of [["obj", put(d, "o.json", { nope: 1 })], ["bos", put(d, "e.json", [])], ["bozuk", put(d, "b.json", "{x")], ["eksik", join(d, "yok.json")], ["null-satir", put(d, "n.json", [null])]] as const) {
    const r = offline(cli(d, ["content-classify", f]), name);
    assert.equal(r.status, 1, name);
    noStack(r, name);
  }
});

test("content-classify: site izolasyonu: karisik siteli, sitesiz ve kayitsiz site satirlari reddedilir (havuzlanmaz)", () => {
  const d = sandbox();
  const mixed = offline(cli(d, ["content-classify", put(d, "m.json", [gscRow("pamistanbul", "https://pamistanbul.com/a"), gscRow("pamaistudio", "https://pamaistudio.com/a")])]));
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /SITE IZOLASYONU/);
  const nosite = offline(cli(d, ["content-classify", put(d, "n.json", [{ impressions: 200, position: 10 }])]));
  assert.equal(nosite.status, 1);
  const unknown = offline(cli(d, ["content-classify", put(d, "u.json", [gscRow("yok-site", "https://x.test/a")])]));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /site bulunamadi: yok-site/);
});

// =============================================================================================================================
// index-alarms
// =============================================================================================================================

test("index-alarms: gecmis yokken UNKNOWN (sorun yok DEGIL), exit 0, dosya yazmaz; probe ile --write yalniz sandbox'a yazar", () => {
  const d = sandbox();
  const bare = offline(cli(d, ["index-alarms", "config/sites.yaml", "--site", "pamistanbul", "--data", "data"]));
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /UNKNOWN|NO_ALARM_IN_SAMPLE|ORNEKLEM|ornek/i);
  assert.match(bare.stdout, /hicbir dosya yazilmadi/);
  assert.ok(!existsSync(join(d, "data")));
  const dry = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "data", "--probe", join(FX, "probe.pamistanbul.json")]));
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!existsSync(join(d, "data")), "--write yokken yazilmamali");
  const w = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "data", "--probe", join(FX, "probe.pamistanbul.json"), "--write"]));
  assert.equal(w.status, 0, w.stderr);
  const files = tree(join(d, "data")).map((f) => f.slice(d.length + 1)).sort();
  assert.deepEqual(files, ["data/canonical-backlog/pamistanbul.json", "data/index-history/pamistanbul.json"]);
  assert.equal(JSON.parse(readFileSync(join(d, "data/index-history/pamistanbul.json"), "utf8")).site, "pamistanbul");
});

test("index-alarms: yabanci siteye ait probe reddedilir ve HICBIR dosya yazilmaz; bilinmeyen site, --write probe'suz, eksik/bozuk probe = exit 1", () => {
  const d = sandbox();
  const foreign = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "data", "--probe", join(FX, "probe.foreign.json"), "--write"]));
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /SITE IZOLASYONU/);
  assert.ok(!existsSync(join(d, "data")));
  assert.equal(offline(cli(d, ["index-alarms", "--site", "yok-site"])).status, 1);
  assert.equal(offline(cli(d, ["index-alarms"])).status, 1);
  const nowrite = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "data", "--write"]));
  assert.equal(nowrite.status, 1);
  assert.match(nowrite.stderr, /--probe/);
  for (const [name, p] of [["eksik", join(d, "yok.json")], ["bozuk", put(d, "b.json", "{x")], ["sekil", put(d, "o.json", { a: 1 })]] as const) {
    const r = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "data", "--probe", p]), name);
    assert.equal(r.status, 1, name);
    noStack(r, name);
  }
});

test("index-alarms: bozuk gecmis dosyasi fail-closed (exit 1); --data cwd disina yazamaz", () => {
  const d = sandbox();
  put(d, "data/index-history/pamistanbul.json", "{bozuk");
  const r = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "data"]));
  assert.equal(r.status, 1);
  noStack(r);
  const out = offline(cli(d, ["index-alarms", "--site", "pamistanbul", "--data", "../escape-data", "--probe", join(FX, "probe.pamistanbul.json"), "--write"]));
  assert.equal(out.status, 1);
  assert.match(out.stderr, /repo-yerel/);
  assert.ok(!existsSync(join(d, "..", "escape-data")));
});

// =============================================================================================================================
// agent-contracts-validate
// =============================================================================================================================

test("agent-contracts-validate: sozlesmeye uygun oge ACCEPTED exit 0 (uygulama izni degil); yabanci hedef BLOCKED_CROSS_SITE exit 1", () => {
  const d = sandbox();
  const ok = offline(cli(d, ["agent-contracts-validate", put(d, "ok.json", [{ kind: "internal_link", input: linkInput("https://pamistanbul.com/b") }])]));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ACCEPTED/);
  const bad = offline(cli(d, ["agent-contracts-validate", put(d, "bad.json", [{ kind: "internal_link", input: linkInput("https://pamaistudio.com/b") }])]));
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /BLOCKED_CROSS_SITE/);
});

test("agent-contracts-validate: eksik dosya, bozuk JSON, dizi olmayan, bilinmeyen kind, cop girdi = exit 1 (yigin izi yok)", () => {
  const d = sandbox();
  for (const [name, f] of [["eksik", join(d, "yok.json")], ["bozuk", put(d, "b.json", "{x")], ["obj", put(d, "o.json", { a: 1 })], ["kind", put(d, "k.json", [{ kind: "baska", input: {} }])], ["cop", put(d, "c.json", [null, 1])], ["bos-input", put(d, "i.json", [{ kind: "internal_link", input: null }])]] as const) {
    const r = offline(cli(d, ["agent-contracts-validate", f]), name);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    noStack(r, name);
  }
});

// =============================================================================================================================
// performance-measure (TEK ag yolu)
// =============================================================================================================================

test("performance-measure: anahtar YOK = NOT_CONNECTED, exit 0, SIFIR ag denemesi, gecmise yazmaz", () => {
  const d = sandbox();
  const r = cli(d, ["performance-measure", "config/sites.yaml", "--site", "pamistanbul", "--history", "perf", "--write", "--out", "out"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.net, "", "anahtarsiz kosu ag denedi");
  assert.match(r.stdout, /NOT_CONNECTED/);
  assert.doesNotMatch(r.stdout, /\| MEASURED \|/);
  assert.ok(!existsSync(join(d, "perf")), "NOT_CONNECTED gecmise yazmamali");
  assert.deepEqual(readdirSync(join(d, "out")).sort(), ["performance-report.json", "performance-report.md"]);
  const rep = JSON.parse(readFileSync(join(d, "out", "performance-report.json"), "utf8"));
  assert.equal(rep.budget.used, 0);
  // Tum portfoy (site filtresiz) de ayni: ag yok, exit 0.
  const all = cli(d, ["performance-measure"]);
  assert.equal(all.status, 0);
  assert.equal(all.net, "");
  // Bos anahtar da anahtar sayilmaz.
  const blank = cli(d, ["performance-measure", "--site", "pamistanbul"], { env: { PAGESPEED_API_KEY: "   " } });
  assert.equal(blank.status, 0);
  assert.equal(blank.net, "");
  assert.match(blank.stdout, /NOT_CONNECTED/);
});

test("performance-measure: sahte anahtar + sahte fetch = MEASURED kayit, anahtar istek parametresinde dogru, hicbir cikti/dosyada ANAHTAR YOK", () => {
  const d = sandbox();
  const KEY = "DUMMY-psi-key-abc123/+=";
  const env = { PAGESPEED_API_KEY: KEY, EXPECT_KEY: KEY, MOCK_MODE: "ok" };
  const r = cli(d, ["performance-measure", "--site", "pamistanbul", "--history", "perf", "--write", "--out", "out"], { env, preload: MOCK_PSI });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\| MEASURED \| field \| 2100 \(GOOD\)/);
  assert.equal(r.net.trim().split("\n").length, 1);
  assert.match(r.net, /^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed strategy=mobile keyOk=true$/m);
  const hist = JSON.parse(readFileSync(join(d, "perf", "pamistanbul.json"), "utf8"));
  assert.equal(hist.records.length, 1);
  assert.equal(hist.records[0].state, "MEASURED");
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  for (const f of tree(d)) assert.ok(!readFileSync(f, "utf8").includes(KEY), `${f} anahtar iceriyor`);
  // Ayni gun ikinci kosu: tekrar istek atmaz (ALREADY_MEASURED_TODAY), gecmis cogalmaz.
  const again = cli(d, ["performance-measure", "--site", "pamistanbul", "--history", "perf", "--write"], { env, preload: MOCK_PSI });
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(readFileSync(join(d, "perf", "pamistanbul.json"), "utf8")).records.length, 1);
});

test("performance-measure: fetch hatasi mesaji anahtarli URL tasisa bile anahtar SIZMAZ; ERROR kaydi exit 1", () => {
  const d = sandbox();
  const KEY = "DUMMY-leak-key-xyz789";
  const r = cli(d, ["performance-measure", "--site", "pamistanbul", "--history", "perf", "--write", "--out", "out"], { env: { PAGESPEED_API_KEY: KEY, EXPECT_KEY: KEY, MOCK_MODE: "fail" }, preload: MOCK_PSI });
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  assert.match(r.stdout, /ERROR/);
  assert.ok(!existsSync(join(d, "perf")), "ERROR kaydi gecmise yazilmamali");
  for (const f of tree(d)) assert.ok(!readFileSync(f, "utf8").includes(KEY), `${f} anahtar iceriyor`);
});

test("performance-measure: anahtar CLI argumani olarak REDDEDILIR (exit 1), deger yankilanmaz, ag yok", () => {
  const d = sandbox();
  for (const a of [["--api-key", "SECRET-VALUE-123"], ["--api-key=SECRET-VALUE-123"], ["--key", "SECRET-VALUE-123"], ["--pagespeed-key=SECRET-VALUE-123"], ["--token", "SECRET-VALUE-123"], ["-key", "SECRET-VALUE-123"]]) {
    const r = offline(cli(d, ["performance-measure", ...a]), a[0]);
    assert.equal(r.status, 1, a[0]);
    assert.ok(!(r.stdout + r.stderr).includes("SECRET-VALUE-123"), `${a[0]} deger yankilandi`);
    assert.match(r.stderr, /CLI argumani olarak kabul edilmez/);
  }
});

test("performance-measure: bilinmeyen site, --url --site'siz, yabanci host URL'i, kotu strateji/sayi, bozuk gecmis = exit 1; yigin izi yok", () => {
  const d = sandbox();
  const cases: [string, string[]][] = [
    ["site", ["--site", "yok-site"]], ["url-sitesiz", ["--url", "https://pamistanbul.com/"]], ["yabanci-host", ["--site", "pamistanbul", "--url", "https://pamaistudio.com/"]],
    ["strateji", ["--site", "pamistanbul", "--strategy", "tablet"]], ["sayi", ["--site", "pamistanbul", "--max-requests", "abc"]], ["sayi0", ["--site", "pamistanbul", "--urls-per-site", "0"]],
  ];
  for (const [name, a] of cases) {
    const r = offline(cli(d, ["performance-measure", ...a]), name);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    noStack(r, name);
  }
  put(d, "perf/pamistanbul.json", "{bozuk");
  const bad = offline(cli(d, ["performance-measure", "--site", "pamistanbul", "--history", "perf"]));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /gecmis dosyasi JSON degil/);
});

test("performance-measure: --write/--out hedefi cwd disina cikamaz (repo-yerel)", () => {
  const d = sandbox();
  const a = offline(cli(d, ["performance-measure", "--site", "pamistanbul", "--history", "../escape-perf", "--write"]));
  assert.equal(a.status, 1);
  const b = offline(cli(d, ["performance-measure", "--site", "pamistanbul", "--out", "/tmp/cliwire-escape-out"]));
  assert.equal(b.status, 1);
  assert.match(b.stderr, /repo-yerel/);
  assert.ok(!existsSync("/tmp/cliwire-escape-out") && !existsSync(join(d, "..", "escape-perf")));
});

// =============================================================================================================================
// change-eval / change-lint
// =============================================================================================================================

test("change-eval: kill-switch dosyasi yoksa VARSAYILAN strict = BLOCK_KILL_SWITCH exit 1; bayrakla yalniz INCELEMEYE gider (uygulama izni degil); robots hep insan", () => {
  const d = sandbox();
  const p = put(d, "content.json", proposal("content"));
  const strict = offline(cli(d, ["change-eval", p, "--kill-switch", join(d, "yok.json")]));
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /BLOCK_KILL_SWITCH/);
  const strictDefaultPath = offline(cli(d, ["change-eval", p]));
  assert.equal(strictDefaultPath.status, 1, "varsayilan data/kill-switch.json yok -> strict engeller");
  assert.match(strictDefaultPath.stdout, /BLOCK_KILL_SWITCH/);
  const ok = offline(cli(d, ["change-eval", p, "--kill-switch", join(d, "yok.json"), "--allow-absent-kill-switch"]));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ALLOW_FOR_REVIEW/);
  assert.match(ok.stdout, /uygulama izni degildir/);
  const robots = offline(cli(d, ["change-eval", put(d, "robots.json", proposal("robots")), "--kill-switch", join(d, "yok.json"), "--allow-absent-kill-switch"]));
  assert.equal(robots.status, 1);
  assert.match(robots.stdout, /BLOCK_HIGH_RISK_NEEDS_OWNER/);
});

test("change-eval: acik kill-switch engeller; bozuk kill-switch dosyasi fail-closed (dosya VAR olsa bile bayrak onu yumusatmaz)", () => {
  const d = sandbox();
  const p = put(d, "c.json", proposal("content"));
  const engaged = put(d, "ks-on.json", { schema: "sgos.kill-switch.v1", global: { engaged: true, reason: "test" }, sites: {} });
  const r = offline(cli(d, ["change-eval", p, "--kill-switch", engaged, "--allow-absent-kill-switch"]));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /BLOCK_KILL_SWITCH/);
  const broken = put(d, "ks-bad.json", "{bozuk");
  const b = offline(cli(d, ["change-eval", p, "--kill-switch", broken, "--allow-absent-kill-switch"]));
  assert.equal(b.status, 1);
  assert.match(b.stdout, /BLOCK_KILL_SWITCH/);
});

test("change-eval: bilinmeyen/yabanci site BLOCK_CROSS_SITE; bozuk, eksik, nesne olmayan girdi ve bozuk ledger = exit 1 (yigin izi yok)", () => {
  const d = sandbox();
  const unknown = offline(cli(d, ["change-eval", put(d, "u.json", proposal("content", "yok-site")), "--allow-absent-kill-switch"]));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /BLOCK_CROSS_SITE/);
  for (const [name, a] of [["eksik", [join(d, "yok.json")]], ["bozuk", [put(d, "b.json", "{x")]], ["null", [put(d, "n.json", "null")]], ["dizi", [put(d, "a.json", [])]], ["gecersiz", [put(d, "g.json", { x: 1 }), "--allow-absent-kill-switch"]], ["ledger", [put(d, "p.json", proposal("content")), "--ledger", put(d, "l.json", "{x"), "--allow-absent-kill-switch"]]] as const) {
    const r = offline(cli(d, ["change-eval", ...a]), name);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    noStack(r, name);
  }
});

test("change-lint: main'e push ve uretim host'una yazma ihlaldir (exit 1); salt-okunur eylem ve claude/* dali temizdir (exit 0)", () => {
  const d = sandbox();
  const bad = offline(cli(d, ["change-lint", put(d, "bad.json", [{ kind: "shell", command: "git push origin main" }])]));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /IHLAL #0/);
  const ok = offline(cli(d, ["change-lint", put(d, "ok.json", [{ kind: "read" }, { kind: "branch_push", branch: "claude/sprint-x" }])]));
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /ihlal yok \(statik tarama/);
});

test("change-lint: eksik dosya, bozuk JSON, dizi olmayan, turu olmayan eylem = exit 1 (yigin izi yok)", () => {
  const d = sandbox();
  for (const [name, f] of [["eksik", join(d, "yok.json")], ["bozuk", put(d, "b.json", "{x")], ["obj", put(d, "o.json", { a: 1 })], ["cop", put(d, "c.json", [null, 1, "a"])]] as const) {
    const r = offline(cli(d, ["change-lint", f]), name);
    assert.equal(r.status, 1, name);
    noStack(r, name);
  }
});

// =============================================================================================================================
// scorecard
// =============================================================================================================================

test("scorecard: gercek data/clarity-history ile calisir, diger boyutlar UNKNOWN (hicbiri OK degil); salt-okunur, exit 0", () => {
  const d = sandbox();
  const empty = (n: string) => { mkdirSync(join(d, n)); return join(d, n); };
  const r = offline(cli(ROOT, ["scorecard", "config/sites.yaml", "--site", "pamistanbul", "--json", "--clarity", "data/clarity-history", "--performance", empty("p"), "--index", empty("i"), "--deployments", empty("dp")]));
  assert.equal(r.status, 0, r.stderr);
  const dims = JSON.parse(r.stdout).sites[0].dimensions as { dimension: string; state: string; basis: string }[];
  const by = Object.fromEntries(dims.map((x) => [x.dimension, x]));
  for (const k of ["performance", "index_health", "deployment_change", "search_opportunity"]) assert.equal(by[k].state, "UNKNOWN", `${k}: girdi yokken UNKNOWN olmali`);
  assert.ok(dims.every((x) => x.state !== "OK" || x.dimension === "measurement_health" || x.dimension === "ux_friction"), "girdisiz boyut OK olamaz");
  const md = offline(cli(ROOT, ["scorecard", "--site", "pamistanbul", "--performance", empty("p2"), "--index", empty("i2"), "--deployments", empty("dp2")]));
  assert.equal(md.status, 0);
  assert.match(md.stdout, /Tek skor yok/);
});

test("scorecard: girdisiz sandbox'ta tum 7 site karti, hicbir boyut OK degil; bilinmeyen site, bozuk artifact, olmayan --clarity yolu = exit 1", () => {
  const d = sandbox();
  const all = offline(cli(d, ["scorecard", "--json"]));
  assert.equal(all.status, 0, all.stderr);
  const sites = JSON.parse(all.stdout).sites as { site_id: string; dimensions: { state: string }[] }[];
  assert.equal(sites.length, 7);
  assert.ok(sites.every((s) => s.dimensions.every((x) => x.state !== "OK")));
  const unknown = offline(cli(d, ["scorecard", "--site", "yok-site"]));
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /site bulunamadi/);
  put(d, "bad/pamistanbul.json", "{bozuk");
  const corrupt = offline(cli(d, ["scorecard", "--site", "pamistanbul", "--performance", "bad"]));
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /bozuk girdi/);
  noStack(corrupt);
  const missing = offline(cli(d, ["scorecard", "--clarity", join(d, "yok")]));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /yolu yok/);
});

// =============================================================================================================================
// orchestration-check
// =============================================================================================================================

test("orchestration-check: exit kodu ERROR bulgusu/drift ile BIREBIR (belgelenen kural); gercek workflow'lar --drift ile okunur", () => {
  const plain = offline(cli(ROOT, ["orchestration-check"]));
  assert.match(plain.stdout, /Orkestrasyon modeli/);
  assert.ok(plain.status === 0 || plain.status === 1, `beklenmeyen exit ${plain.status}`);
  assert.equal(plain.status, offline(cli(ROOT, ["orchestration-check", "--json"])).status, "--json ayni kodu verir");
  const j = offline(cli(ROOT, ["orchestration-check", "--drift", "--json"]));
  const parsed = JSON.parse(j.stdout) as { issues: { severity: string }[]; drift: unknown[] };
  const expected = parsed.issues.some((i) => i.severity === "ERROR") || parsed.drift.length > 0 ? 1 : 0;
  assert.equal(j.status, expected, `exit ${j.status}, beklenen ${expected}`);
  const drift = offline(cli(ROOT, ["orchestration-check", "--drift"]));
  assert.equal(drift.status, expected);
});

test("orchestration-check --drift: .github/workflows okunamiyorsa exit 1 (sessiz 0 yok), yigin izi yok", () => {
  const d = sandbox();
  const r = offline(cli(d, ["orchestration-check", "--drift"]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orchestration-check HATA/);
  noStack(r);
});
