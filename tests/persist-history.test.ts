// Güvenli kalıcılık sözleşmesi: scripts/persist-history.sh geçici git depolarında (bare remote + iki clone) sınanır.
// Ağ yok. Testlerin çoğu NE YAPILMAMASI gerektiği hakkında: veri kaybetmek, force push, çatışmayı ezmek,
// izin listesi dışına yazmak, sonsuz denemek.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/persist-history.sh");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} -> ${r.stderr}`);
  return r.stdout.trim();
}

interface Env { remote: string; a: string; b: string }

function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), "persist-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  for (const c of [seed]) { git(c, "config", "user.name", "t"); git(c, "config", "user.email", "t@t"); }
  mkdirSync(join(seed, "data/clarity-history"), { recursive: true });
  mkdirSync(join(seed, "reports"), { recursive: true });
  writeFileSync(join(seed, "data/clarity-history/x.json"), "{}\n");
  writeFileSync(join(seed, "reports/measure-latest.md"), "base\n");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "seed"); git(seed, "push", "-q", "origin", "HEAD:main");
  const a = join(base, "a"); const b = join(base, "b");
  for (const c of [a, b]) {
    git(base, "clone", "-q", remote, c);
    git(c, "config", "user.name", "t"); git(c, "config", "user.email", "t@t");
  }
  return { remote, a, b };
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, PERSIST_BACKOFF_SECONDS: "0 0", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const remoteHead = (e: Env) => git(e.remote, "rev-parse", "main");

test("(a) değişiklik yok -> commit yok, çıkış 0", () => {
  const e = setup();
  const before = git(e.a, "rev-parse", "HEAD");
  const r = run(e.a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /değişiklik yok/);
  assert.equal(git(e.a, "rev-parse", "HEAD"), before);
  assert.equal(remoteHead(e), before);
});

test("(b) temiz push: commit atılır ve remote ilerler", () => {
  const e = setup();
  writeFileSync(join(e.a, "data/clarity-history/y.json"), "{\"d\":1}\n");
  const r = run(e.a, ["-m", "clarity: test", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(remoteHead(e), git(e.a, "rev-parse", "HEAD"));
  assert.equal(git(e.remote, "log", "-1", "--format=%s", "main"), "clarity: test");
});

test("(b2) var olmayan yol hata değil; olan yol eklenir (ledger henüz yok)", () => {
  const e = setup();
  writeFileSync(join(e.a, "reports/measure-latest.md"), "yeni\n");
  const r = run(e.a, ["-m", "m", "reports/measure-latest.md", "reports/runs/", "content/topic-ledger.json"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(e.remote, "show", "main:reports/measure-latest.md"), "yeni");
});

test("(c) başka yazıcı farklı yolda main'i ilerletti -> rebase+push, iki geçmiş de var", () => {
  const e = setup();
  // B (clarity yazıcısı) önce push eder; A (measure) onun haberi olmadan commit'lemeye hazır.
  writeFileSync(join(e.b, "data/clarity-history/y.json"), "{\"b\":1}\n");
  assert.equal(run(e.b, ["-m", "clarity", "data/clarity-history/"]).code, 0);
  writeFileSync(join(e.a, "reports/measure-latest.md"), "A rapor\n");
  const r = run(e.a, ["-m", "olcum", "reports/measure-latest.md"]);
  assert.equal(r.code, 0, r.out);
  const log = git(e.remote, "log", "--format=%s", "main");
  assert.match(log, /olcum/); assert.match(log, /clarity/); assert.match(log, /seed/);
  assert.equal(git(e.remote, "show", "main:data/clarity-history/y.json"), "{\"b\":1}");
  assert.equal(git(e.remote, "show", "main:reports/measure-latest.md"), "A rapor");
});

test("(d) aynı dosyada çatışma -> fail-closed, çıkış 2, remote değişmez, yerel commit korunur", () => {
  const e = setup();
  writeFileSync(join(e.b, "reports/measure-latest.md"), "B sürümü\n");
  assert.equal(run(e.b, ["-m", "b", "reports/"]).code, 0);
  const remoteAfterB = remoteHead(e);
  writeFileSync(join(e.a, "reports/measure-latest.md"), "A sürümü\n");
  const r = run(e.a, ["-m", "a", "reports/"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /çatışma/);
  assert.equal(remoteHead(e), remoteAfterB, "remote değişmemeli");
  assert.equal(git(e.remote, "show", "main:reports/measure-latest.md"), "B sürümü");
  // yerel commit duruyor, rebase yarım kalmadı, çalışma ağacı temiz
  assert.equal(git(e.a, "log", "-1", "--format=%s"), "a");
  assert.equal(git(e.a, "status", "--porcelain"), "");
  assert.ok(!existsSync(join(e.a, ".git/rebase-merge")) && !existsSync(join(e.a, ".git/rebase-apply")));
  assert.equal(readFileSync(join(e.a, "reports/measure-latest.md"), "utf8"), "A sürümü\n");
});

test("(e) izin listesi dışı yol reddedilir; hiçbir şey stage/commit edilmez", () => {
  const e = setup();
  writeFileSync(join(e.a, "reports/ok.md"), "ok\n");
  writeFileSync(join(e.a, "src.ts"), "x\n");
  const before = git(e.a, "rev-parse", "HEAD");
  for (const bad of ["src.ts", "../x", "/etc/passwd", "data/other/", "reports/../src.ts", "content/other.json", ""]) {
    const r = run(e.a, ["-m", "m", "reports/ok.md", bad]);
    assert.equal(r.code, 3, `${bad}: ${r.out}`);
    assert.equal(git(e.a, "diff", "--cached", "--name-only"), "", "izinli yol bile stage edilmemeli (kısmi add yok)");
  }
  assert.equal(git(e.a, "rev-parse", "HEAD"), before);
  assert.equal(run(e.a, ["data/clarity-history/"]).code, 3, "mesajsız çağrı reddedilir");
});

function rejectingHook(e: Env, rejectFirst: number | "always") {
  const hook = join(e.remote, "hooks/pre-receive");
  const counter = join(e.remote, "rejects");
  writeFileSync(counter, "0");
  const script = rejectFirst === "always"
    ? "#!/bin/sh\necho reddedildi >&2\nexit 1\n"
    : `#!/bin/sh\nn=$(cat "${counter}")\nif [ "$n" -lt ${rejectFirst} ]; then echo $((n+1)) > "${counter}"; echo reddedildi >&2; exit 1; fi\nexit 0\n`;
  writeFileSync(hook, script); chmodSync(hook, 0o755);
}

test("(f) sürekli reddeden remote -> tam 3 deneme, çıkış 1, commit korunur, sonsuz döngü yok", () => {
  const e = setup();
  rejectingHook(e, "always");
  writeFileSync(join(e.a, "reports/measure-latest.md"), "A\n");
  const base = remoteHead(e);
  const r = run(e.a, ["-m", "a", "reports/"]);
  assert.equal(r.code, 1, r.out);
  assert.equal((r.out.match(/persist: deneme \d\/3/g) ?? []).length, 3);
  assert.equal(remoteHead(e), base);
  assert.equal(git(e.a, "log", "-1", "--format=%s"), "a");
});

test("(f2) iki ret sonra kabul -> 3. denemede başarı (geçici yarış toparlanır)", () => {
  const e = setup();
  rejectingHook(e, 2);
  writeFileSync(join(e.a, "reports/measure-latest.md"), "A\n");
  const r = run(e.a, ["-m", "a", "reports/"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /deneme 3\/3/);
  assert.equal(git(e.remote, "log", "-1", "--format=%s", "main"), "a");
});

test("(f3) PERSIST_MAX_ATTEMPTS yalnız aşağı çeker; 99 verilse de tavan 3", () => {
  const e = setup();
  rejectingHook(e, "always");
  writeFileSync(join(e.a, "reports/measure-latest.md"), "A\n");
  const r = run(e.a, ["-m", "a", "reports/"], { PERSIST_MAX_ATTEMPTS: "99" });
  assert.equal(r.code, 1);
  assert.equal((r.out.match(/persist: deneme/g) ?? []).length, 3);
  const e2 = setup();
  rejectingHook(e2, "always");
  writeFileSync(join(e2.a, "reports/measure-latest.md"), "A\n");
  const r2 = run(e2.a, ["-m", "a", "reports/"], { PERSIST_MAX_ATTEMPTS: "1" });
  assert.equal((r2.out.match(/persist: deneme/g) ?? []).length, 1);
});

test("(g) betikte force push yok; döngü sınırlı", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/--force|--force-with-lease|--mirror|\bpush\b[^\n]*\s-f\b|\bpush\b[^\n]*\s\+/.test(code), "force push yok");
  assert.ok(!/while\s+(true|:)/.test(code), "sonsuz döngü yok");
  assert.match(code, /MAX_ATTEMPTS=3/);
  assert.ok(!/reset --hard|checkout --theirs|checkout --ours|-X (ours|theirs)|rebase [^\n]*--strategy/.test(code), "otomatik çatışma çözümü yok");
});

// --- workflow sözleşmesi -------------------------------------------------------------------------------------

const MEASURE = readFileSync(join(ROOT, ".github/workflows/measure.yml"), "utf8");
const CLARITY = readFileSync(join(ROOT, ".github/workflows/clarity-daily.yml"), "utf8");

test("iki workflow betiği çağırır, satır içi git push/pull/commit yok", () => {
  for (const [name, wf] of [["measure", MEASURE], ["clarity-daily", CLARITY]] as const) {
    const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.match(code, /bash scripts\/persist-history\.sh/, name);
    assert.ok(!/git push/.test(code), `${name}: satır içi git push`);
    assert.ok(!/git pull/.test(code), `${name}: satır içi git pull`);
    assert.ok(!/git commit/.test(code), `${name}: satır içi git commit`);
    assert.ok(!/git add/.test(code), `${name}: satır içi git add`);
  }
});

test("tek yazıcı: her workflow yalnız kendi yolunu geçirir", () => {
  const call = (wf: string) => wf.match(/persist-history\.sh[^\n]*\\?\n?[^\n]*/)![0];
  assert.ok(!/reports|content\//.test(call(CLARITY)));
  assert.ok(!/data\/clarity-history/.test(call(MEASURE)));
  assert.match(call(MEASURE), /reports\/measure-latest\.md reports\/runs\/ content\/topic-ledger\.json/);
  assert.match(call(CLARITY), /data\/clarity-history\//);
});

test("workflow cron / kapı / izin / concurrency değişmedi", () => {
  assert.match(MEASURE, /cron: "40 6 \* \* 1"/);
  assert.match(MEASURE, /permissions:\n {2}contents: write/);
  assert.match(MEASURE, /concurrency:\n {2}group: measure\n {2}cancel-in-progress: false/);
  assert.match(MEASURE, /if: github\.event_name == 'schedule' \|\| inputs\.commit_report/);
  assert.match(CLARITY, /cron: "20 7 \* \* \*"/);
  assert.match(CLARITY, /permissions:\n {2}contents: write/);
  assert.match(CLARITY, /concurrency:\n {2}group: clarity\n {2}cancel-in-progress: false/);
  assert.match(CLARITY, /if: github\.event_name == 'workflow_dispatch' \|\| vars\.SEARCH_GROWTH_CLARITY_DAILY_ENABLED == 'true'/);
  assert.match(CLARITY, /if: always\(\) && github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'schedule' \|\| inputs\.commit_history\)/);
  // yeni tetik/secret eklenmedi: her iki dosyada da tek schedule girdisi
  assert.equal((MEASURE.match(/cron:/g) ?? []).length, 1);
  assert.equal((CLARITY.match(/cron:/g) ?? []).length, 1);
  // artifact adımı hâlâ always()
  assert.match(MEASURE, /- name: Artifact\n {8}if: always\(\)/);
  assert.match(CLARITY, /- name: Artifact\n {8}if: always\(\)/);
});
