// persist-history.sh için ek hata-yüzeyi testleri. Actions ortamını taklit eder: remote LOKAL BARE depo,
// checkout = `git clone --depth 1 file://...` (SHALLOW), main dalı, workflow'un ayarladığı git kimliği.
// Ağ yok, gerçek remote yok; anahtar benzeri dizgeler sahte. Mevcut tests/persist-history.test.ts'i tamamlar, yerine geçmez.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/persist-history.sh");
const FAKE_KEY = "sk-FAKE-0000000000000000000000000000dummy"; // sahte, gerçek değil

// Kullanıcının/CI'ın global git ayarı testi etkilemesin.
const CLEAN_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PERSIST_BACKOFF_SECONDS: "0 0",
};
for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "PERSIST_MAX_ATTEMPTS"]) delete CLEAN_ENV[k];

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}, dropKeys: string[] = []) {
  const e = { ...CLEAN_ENV, ...env };
  for (const k of dropKeys) delete e[k];
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: e });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: (r.stdout ?? "").trim() };
}
function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, "git", args);
  assert.equal(r.code, 0, `git ${args.join(" ")} -> ${r.out}`);
  return r.stdout;
}
const gitTry = (cwd: string, ...args: string[]) => sh(cwd, "git", args);

interface Env { base: string; remote: string; mk: (name: string, o?: { shallow?: boolean; identity?: boolean }) => string }

function setup(branch = "main"): Env {
  const base = mkdtempSync(join(tmpdir(), "persist-hard-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", branch, remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", `file://${remote}`, seed);
  git(seed, "checkout", "-q", "-B", branch);
  git(seed, "config", "user.name", "seed"); git(seed, "config", "user.email", "seed@t");
  w(seed, "data/clarity-history/a.json", "{}\n");
  w(seed, "data/clarity-history/b.json", "{}\n");
  w(seed, "reports/measure-latest.md", "base\n");
  w(seed, "README.md", "readme\n");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "seed"); git(seed, "push", "-q", "origin", `HEAD:${branch}`);
  const mk = (name: string, o: { shallow?: boolean; identity?: boolean } = {}) => {
    const c = join(base, name);
    const args = ["clone", "-q", ...(o.shallow === false ? [] : ["--depth", "1"]), "--branch", branch, `file://${remote}`, c];
    git(base, ...args);
    if (o.identity !== false) { git(c, "config", "user.name", "github-actions[bot]"); git(c, "config", "user.email", "bot@t"); }
    return c;
  };
  return { base, remote, mk };
}

function w(c: string, p: string, s: string) { mkdirSync(dirname(join(c, p)), { recursive: true }); writeFileSync(join(c, p), s); }
function run(cwd: string, args: string[], env: Record<string, string> = {}, dropKeys: string[] = []) {
  return sh(cwd, "bash", [SCRIPT, ...args], env, dropKeys);
}
const rhead = (e: Env, b = "main") => git(e.remote, "rev-parse", b);
const remoteFiles = (e: Env, b = "main") => git(e.remote, "ls-tree", "-r", "--name-only", b).split("\n");
const stagedNames = (c: string) => git(c, "diff", "--cached", "--name-only");
function noRebaseState(c: string) {
  const g = git(c, "rev-parse", "--git-dir");
  const gd = g.startsWith("/") ? g : join(c, g);
  assert.ok(!existsSync(join(gd, "rebase-merge")), "rebase-merge kaldı");
  assert.ok(!existsSync(join(gd, "rebase-apply")), "rebase-apply kaldı");
}

// pre-receive hook: her push'u reddeder; denemeleri sayar.
function rejectingHook(e: Env) {
  const hook = join(e.remote, "hooks/pre-receive");
  const counter = join(e.base, "attempts");
  writeFileSync(hook, `#!/bin/sh\necho x >> "${counter}"\necho "rejected by test hook" >&2\nexit 1\n`);
  chmodSync(hook, 0o755);
  return () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0);
}
// sleep stub'ı: gerçekten beklemez, argümanı kaydeder.
function sleepStub(e: Env) {
  const bin = join(e.base, "bin"); mkdirSync(bin);
  const log = join(e.base, "sleeps");
  writeFileSync(join(bin, "sleep"), `#!/bin/sh\necho "$1" >> "${log}"\n`); chmodSync(join(bin, "sleep"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, read: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("A: shallow clone + kimlik, temiz main + tek geçmiş değişikliği -> commit+push", () => {
  const e = setup(); const a = e.mk("a");
  assert.equal(git(a, "rev-parse", "--is-shallow-repository"), "true");
  w(a, "data/clarity-history/2026-10-02.json", '{"d":1}\n');
  const r = run(a, ["-m", "clarity: a", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /push başarılı/);
  assert.equal(rhead(e), git(a, "rev-parse", "HEAD"));
  assert.ok(remoteFiles(e).includes("data/clarity-history/2026-10-02.json"));
  assert.equal(git(a, "status", "--porcelain"), "");
});

test("B1: shallow clone, remote ilgisiz dosyada ilerledi -> rebase+push, ikisi de kalır", () => {
  const e = setup(); const a = e.mk("a"); const b = e.mk("b");
  w(b, "README.md", "changed\n"); git(b, "commit", "-qam", "unrelated"); git(b, "push", "-q", "origin", "HEAD:main");
  w(a, "data/clarity-history/new.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(e.remote, "show", "main:README.md"), "changed");
  assert.ok(remoteFiles(e).includes("data/clarity-history/new.json"));
  assert.equal(rhead(e), git(a, "rev-parse", "HEAD"));
  noRebaseState(a);
});

test("B2: shallow clone, remote ilgisiz GEÇMİŞ dosyasında ilerledi -> ikisi de kalır", () => {
  const e = setup(); const a = e.mk("a"); const b = e.mk("b");
  w(b, "data/clarity-history/b.json", '{"other":1}\n'); git(b, "commit", "-qam", "other hist"); git(b, "push", "-q", "origin", "HEAD:main");
  w(a, "data/clarity-history/a.json", '{"mine":1}\n');
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(e.remote, "show", "main:data/clarity-history/a.json"), '{"mine":1}');
  assert.equal(git(e.remote, "show", "main:data/clarity-history/b.json"), '{"other":1}');
});

test("B3: remote iki commit ilerlemiş (shallow derinlik 1'in ötesinde) -> yine başarılı", () => {
  const e = setup(); const a = e.mk("a"); const b = e.mk("b", { shallow: false });
  for (const n of [1, 2]) { w(b, "README.md", `v${n}\n`); git(b, "commit", "-qam", `u${n}`); }
  git(b, "push", "-q", "origin", "HEAD:main");
  w(a, "data/clarity-history/n.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(e.remote, "show", "main:README.md"), "v2");
  assert.ok(remoteFiles(e).includes("data/clarity-history/n.json"));
});

test("C: aynı geçmiş dosyasında çatışma -> abort temiz, exit 2, force yok, commit kurtarılabilir", () => {
  const e = setup(); const a = e.mk("a"); const b = e.mk("b");
  w(b, "data/clarity-history/a.json", '{"theirs":1}\n'); git(b, "commit", "-qam", "theirs"); git(b, "push", "-q", "origin", "HEAD:main");
  const remoteBefore = rhead(e);
  w(a, "data/clarity-history/a.json", '{"mine":1}\n');
  const r = run(a, ["-m", "mine", "data/clarity-history/"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /rebase çatışması/);
  assert.equal(rhead(e), remoteBefore, "remote değişmemeli");
  noRebaseState(a);
  assert.equal(git(a, "status", "--porcelain"), "", "çalışma ağacı temiz olmalı");
  assert.equal(git(a, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(a, "log", "-1", "--format=%s"), "mine");
  assert.equal(git(a, "show", "HEAD:data/clarity-history/a.json"), '{"mine":1}');
  assert.match(git(a, "reflog", "-n", "5"), /commit: mine/);
});

test("D1: sürekli ret -> tam 3 deneme (<=3), exit 1, remote değişmez, commit kalır", () => {
  const e = setup(); const a = e.mk("a"); const attempts = rejectingHook(e);
  const before = rhead(e);
  w(a, "data/clarity-history/z.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 1, r.out);
  assert.ok(attempts() <= 3);
  assert.equal(attempts(), 3);
  assert.equal(rhead(e), before);
  assert.equal(git(a, "log", "-1", "--format=%s"), "m");
  assert.notEqual(git(a, "rev-parse", "HEAD"), before);
  noRebaseState(a);
});

test("D2: PERSIST_MAX_ATTEMPTS yalnız aşağı çeker; aralık dışı değerler yok sayılır", () => {
  for (const [val, expected] of [["1", 1], ["2", 2], ["3", 3], ["0", 3], ["4", 3], ["-1", 3], ["abc", 3], ["", 3], ["1 2", 3], ["99", 3]] as const) {
    const e = setup(); const a = e.mk("a"); const attempts = rejectingHook(e);
    w(a, "data/clarity-history/z.json", "{}\n");
    const r = run(a, ["-m", "m", "data/clarity-history/"], { PERSIST_MAX_ATTEMPTS: val });
    assert.equal(r.code, 1, `${val}: ${r.out}`);
    assert.equal(attempts(), expected, `PERSIST_MAX_ATTEMPTS='${val}'`);
  }
});

test("D3: PERSIST_BACKOFF_SECONDS='0 0' -> uykular 0 (testler hızlı)", () => {
  const e = setup(); const a = e.mk("a"); rejectingHook(e); const s = sleepStub(e);
  w(a, "data/clarity-history/z.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"], { PATH: s.PATH });
  assert.equal(r.code, 1);
  assert.deepEqual(s.read(), ["0", "0"]);
});

test("D4: env yok -> varsayılan bekleme 5 ve 10 (en çok 2 uyku, toplam <= 15 sn); sleep stub'lı, gerçek bekleme yok", () => {
  const e = setup(); const a = e.mk("a"); rejectingHook(e); const s = sleepStub(e);
  w(a, "data/clarity-history/z.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"], { PATH: s.PATH }, ["PERSIST_BACKOFF_SECONDS"]);
  assert.equal(r.code, 1, r.out);
  const sl = s.read().map(Number);
  assert.deepEqual(sl, [5, 10]);
  assert.ok(sl.reduce((x, y) => x + y, 0) <= 15);
});

test("E: detached HEAD -> exit 3, hiçbir şey commit edilmedi", () => {
  const e = setup(); const a = e.mk("a");
  git(a, "checkout", "-q", "--detach");
  const head = git(a, "rev-parse", "HEAD"); const rem = rhead(e);
  w(a, "data/clarity-history/d.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /detached HEAD/);
  assert.equal(git(a, "rev-parse", "HEAD"), head);
  assert.equal(rhead(e), rem);
});

test("F: izin dışı yol (izinlilerle birlikte) -> exit 3, index boş, commit yok", () => {
  const cases: Array<[string, ((c: string) => void) | null]> = [
    ["README.md", null],
    ["../outside", null],
    ["data/clarity-history/../../README.md", null],
    ["/etc/passwd", null],
    ["", null],
    ["data/clarity-history/x\ny", null],
    ["data/clarity-history-evil/x", (c) => w(c, "data/clarity-history-evil/x", "e\n")],
    ["reports-evil/x", (c) => w(c, "reports-evil/x", "e\n")],
    ["content/topic-ledger.json.bak", (c) => w(c, "content/topic-ledger.json.bak", "e\n")],
    ["content/", null],
    ["data/", null],
    [".", null],
    ["reports", null],
  ];
  for (const [bad, prep] of cases) {
    const e = setup(); const a = e.mk("a");
    w(a, "data/clarity-history/ok.json", "{}\n"); w(a, "reports/ok.md", "ok\n");
    if (prep) prep(a);
    const head = git(a, "rev-parse", "HEAD");
    const r = run(a, ["-m", "m", "data/clarity-history/", "reports/", bad]);
    assert.equal(r.code, 3, `${JSON.stringify(bad)}: ${r.out}`);
    assert.equal(stagedNames(a), "", `stage edilmemeli: ${JSON.stringify(bad)}`);
    assert.equal(git(a, "rev-parse", "HEAD"), head);
    assert.equal(rhead(e), head);
  }
});

test("F2: izinli dizin altında dışarıyı gösteren symlink -> hedef içeriği değil link metni (hedef yolu) commit edilir", () => {
  const e = setup(); const a = e.mk("a");
  const outside = join(e.base, "outside-secret.txt"); writeFileSync(outside, FAKE_KEY);
  symlinkSync(outside, join(a, "reports/link.md"));
  const r = run(a, ["-m", "m", "reports/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(e.remote, "show", "main:reports/link.md"), outside);
  assert.equal(gitTry(e.remote, "grep", "-q", FAKE_KEY, "main", "--").code, 1, "hedef içeriği sızmamalı");
});

test("F3: izinli yolun KENDİSİ dışarıyı gösteren symlink ise -> içerik asla remote'a gitmez", () => {
  const e = setup(); const a = e.mk("a");
  const outDir = join(e.base, "outdir"); mkdirSync(outDir); writeFileSync(join(outDir, "s.txt"), FAKE_KEY);
  rmSync(join(a, "reports"), { recursive: true }); symlinkSync(outDir, join(a, "reports"));
  run(a, ["-m", "m", "reports/"]); // çıkış kodu uygulamaya bağlı (git add 'beyond a symbolic link' verebilir); değişmez olan sızıntı yokluğu
  assert.ok(!remoteFiles(e).some((f) => f.endsWith("s.txt")));
  assert.equal(gitTry(e.remote, "grep", "-q", FAKE_KEY, "main", "--").code, 1);
});

test("G: değişiklik yok -> exit 0, HEAD aynı, push yok", () => {
  const e = setup(); const a = e.mk("a");
  const head = git(a, "rev-parse", "HEAD");
  const r = run(a, ["-m", "m", "data/clarity-history/", "reports/", "content/topic-ledger.json"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /değişiklik yok/);
  assert.equal(git(a, "rev-parse", "HEAD"), head);
  assert.equal(rhead(e), head);
});

test("X1: var olmayan izinli yol hata değil; izinli olmayan yol var olmasa da reddedilir", () => {
  const e = setup(); const a = e.mk("a");
  const r = run(a, ["-m", "m", "content/topic-ledger.json", "reports/not-allowed-missing/../x"]);
  assert.equal(r.code, 3, r.out);
  const r2 = run(a, ["-m", "m", "content/topic-ledger.json", "reports/runs/"]);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /değişiklik yok/);
});

test("X2: gitignore'lanmış ama var olan yol -> git add reddeder, betik düşer; commit/push yok", () => {
  const e = setup(); const a = e.mk("a");
  writeFileSync(join(a, ".gitignore"), "content/topic-ledger.json\n"); git(a, "add", ".gitignore"); git(a, "commit", "-qm", "ign");
  const head = git(a, "rev-parse", "HEAD");
  w(a, "content/topic-ledger.json", "{}\n");
  const r = run(a, ["-m", "m", "content/topic-ledger.json"]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(git(a, "rev-parse", "HEAD"), head);
  assert.equal(rhead(e), git(a, "rev-parse", "origin/main"));
  assert.equal(stagedNames(a), "");
});

test("X3: depo alt dizininden çalıştırma -> yollar CWD'ye göre; kök-göreli yol bulunamaz, veri kalıcılaşmaz ama kaybolmaz", () => {
  const e = setup(); const a = e.mk("a");
  w(a, "data/clarity-history/sub.json", "{}\n");
  mkdirSync(join(a, "scripts"), { recursive: true });
  const before = rhead(e);
  const r = run(join(a, "scripts"), ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /değişiklik yok/);
  assert.equal(rhead(e), before);
  assert.ok(existsSync(join(a, "data/clarity-history/sub.json")));
});

test("X4: commit mesajı özel karakter / tırnak / satır sonu / $ / ` korunur", () => {
  const e = setup(); const a = e.mk("a");
  const msg = "clarity: \"q\" 'a' $HOME `id` $(id)\nsatır2 ğüşiçö %s \\n";
  w(a, "data/clarity-history/m.json", "{}\n");
  const r = run(a, ["-m", msg, "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(e.remote, "log", "-1", "--format=%B", "main").trimEnd(), msg.trimEnd());
});

test("X5: kimlik YOK -> davranış kaydı: commit düşer (128), push yok, dosya stage'de kalır", () => {
  const e = setup(); const a = e.mk("a", { identity: false });
  const head = git(a, "rev-parse", "HEAD");
  w(a, "data/clarity-history/i.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"], { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" });
  assert.equal(r.code, 128, r.out);
  assert.match(r.out, /(empty ident|identity unknown|useConfigOnly|no email)/i);
  assert.equal(rhead(e), head);
  assert.equal(git(a, "rev-parse", "HEAD"), head);
  assert.equal(stagedNames(a), "data/clarity-history/i.json");
});

test("X6: farklı varsayılan dal (trunk) + core.autocrlf=true -> hedef = checkout edilen dal", () => {
  const e = setup("trunk"); const a = e.mk("a");
  git(a, "config", "core.autocrlf", "true");
  w(a, "data/clarity-history/crlf.json", "{\r\n}\r\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(rhead(e, "trunk"), git(a, "rev-parse", "HEAD"));
  assert.ok(remoteFiles(e, "trunk").includes("data/clarity-history/crlf.json"));
});

test("X7: dal dispatch'i -> remote'ta olmayan dalda main'e yazılmaz (fetch başarısız, exit 1)", () => {
  const e = setup(); const a = e.mk("a");
  git(a, "checkout", "-q", "-b", "feature/x");
  const mainBefore = rhead(e);
  w(a, "data/clarity-history/f.json", "{}\n");
  const r = run(a, ["-m", "m", "data/clarity-history/"]);
  assert.equal(rhead(e), mainBefore);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fetch başarısız/);
});

test("X8: bilinmeyen seçenek / -m eksik / yol yok / boş mesaj -> exit 3", () => {
  const e = setup(); const a = e.mk("a");
  assert.equal(run(a, ["--force", "-m", "m", "reports/"]).code, 3);
  assert.equal(run(a, ["-m"]).code, 3);
  assert.equal(run(a, ["reports/"]).code, 3);
  assert.equal(run(a, ["-m", "m"]).code, 3);
  assert.equal(run(a, ["-m", "", "reports/"]).code, 3);
});
