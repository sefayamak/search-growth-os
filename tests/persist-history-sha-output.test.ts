// Option B: clarity-daily.yml persist-sonrasi dogrulama akisi icin testler.
// A/B: persist-history.sh'nin basarili push sonrasi persisted_sha ciktisi (GITHUB_OUTPUT) ve
//      fail-closed davranisi (local/remote SHA uyusmazligi / push basarisizliginda cikti YOK).
// C/D/E: workflow YAML yapisi uzerinde string/parse duzeyinde statik dogrulamalar (calistirma yok).
// Ag yok, gercek GitHub'a push yok, gercek Clarity cagrisi yok — hepsi yerel bare-repo fixture'lari
// ya da dosya okuma/regex uzerinden. bkz. tests/persist-history.test.ts icin aynı desen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts/persist-history.sh");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} -> ${r.stderr}`);
  return r.stdout.trim();
}

interface Env { remote: string; a: string }
function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), "persist-sha-"));
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  git(seed, "config", "user.name", "t"); git(seed, "config", "user.email", "t@t");
  mkdirSync(join(seed, "data/clarity-history"), { recursive: true });
  writeFileSync(join(seed, "data/clarity-history/x.json"), "{}\n");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "seed"); git(seed, "push", "-q", "origin", "HEAD:main");
  const a = join(base, "a");
  git(base, "clone", "-q", remote, a);
  git(a, "config", "user.name", "t"); git(a, "config", "user.email", "t@t");
  return { remote, a };
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, PERSIST_BACKOFF_SECONDS: "0 0", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const remoteHead = (e: Env) => git(e.remote, "rev-parse", "main");

// ---- A: basarili persistence -> persisted_sha == local == remote, GITHUB_OUTPUT'a yazilir ----
test("(A) basarili push: persisted_sha GITHUB_OUTPUT dosyasina yazilir ve local==remote SHA'ye esittir", () => {
  const e = setup();
  writeFileSync(join(e.a, "data/clarity-history/y.json"), "{\"d\":1}\n");
  const outFile = join(e.a, "github_output.txt");
  writeFileSync(outFile, "");
  const r = run(e.a, ["-m", "clarity: sha test", "data/clarity-history/"], { GITHUB_OUTPUT: outFile });
  assert.equal(r.code, 0, r.out);
  const pushedSha = git(e.a, "rev-parse", "HEAD");
  const remoteSha = remoteHead(e);
  assert.equal(pushedSha, remoteSha, "local persisted SHA remote main SHA'siyle esit olmali");
  const outContent = readFileSync(outFile, "utf8");
  assert.equal(outContent.trim(), `persisted_sha=${remoteSha}`);
});

// ---- A2: GITHUB_OUTPUT yokken (yerel/testte olagan) script yine de calisir, hata vermez ----
test("(A2) GITHUB_OUTPUT ayarlanmamis: script basarili olur, cikti emisyonu atlanir, hata yok", () => {
  const e = setup();
  writeFileSync(join(e.a, "data/clarity-history/z.json"), "{\"d\":2}\n");
  const r = run(e.a, ["-m", "clarity: no output var", "data/clarity-history/"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(remoteHead(e), git(e.a, "rev-parse", "HEAD"));
});

// ---- B: fail-closed yolu — push tukenirse (sürekli reddeden remote) persisted_sha asla yayinlanmaz ----
test("(B) push basarisiz (sürekli reddeden remote) -> cikis 1, persisted_sha YOK, GITHUB_OUTPUT bos", () => {
  const e = setup();
  const hook = join(e.remote, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho reddedildi >&2\nexit 1\n");
  spawnSync("chmod", ["+x", hook]);
  writeFileSync(join(e.a, "data/clarity-history/w.json"), "{\"d\":3}\n");
  const outFile = join(e.a, "github_output.txt");
  writeFileSync(outFile, "");
  const r = run(e.a, ["-m", "clarity: fail closed", "data/clarity-history/"], { GITHUB_OUTPUT: outFile });
  assert.equal(r.code, 1, r.out);
  assert.ok(!/persisted_sha=/.test(readFileSync(outFile, "utf8")), "basarisiz push'ta persisted_sha yazilmamali");
});

// ---- C: tests-reusable.yml / tests.yml yapisal dogrulama ----
const WF_DIR = join(ROOT, ".github/workflows");
const REUSABLE = readFileSync(join(WF_DIR, "tests-reusable.yml"), "utf8");
const TESTS = readFileSync(join(WF_DIR, "tests.yml"), "utf8");
const CLARITY = readFileSync(join(WF_DIR, "clarity-daily.yml"), "utf8");

test("(C1) tests-reusable.yml: workflow_call girdisi 'ref' zorunlu ve string", () => {
  assert.match(REUSABLE, /on:\s*\n\s*workflow_call:\s*\n\s*inputs:\s*\n\s*ref:/);
  assert.match(REUSABLE, /ref:\s*\n\s*description:[^\n]*\n\s*required:\s*true\s*\n\s*type:\s*string/);
});

test("(C2) tests.yml: test job'u tests-reusable.yml'e delege eder, adimlari tekrarlamaz", () => {
  assert.match(TESTS, /uses:\s*\.\/\.github\/workflows\/tests-reusable\.yml/);
  assert.match(TESTS, /with:\s*\n\s*ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  // Eski dogrudan adimlar (checkout/setup-node/npm test) tests.yml'de artik YOK — tek kopya reusable'da.
  assert.ok(!/actions\/checkout@/.test(TESTS), "tests.yml artik checkout adimini dogrudan icermemeli");
  assert.ok(!/npm test\b/.test(TESTS), "tests.yml artik npm test adimini dogrudan icermemeli");
});

test("(C3) tests-reusable.yml: checkout acikca inputs.ref kullanir (github.sha/bare default degil)", () => {
  assert.match(REUSABLE, /actions\/checkout@v4\s*\n\s*with:\s*\n\s*ref:\s*\$\{\{\s*inputs\.ref\s*\}\}/);
});

test("(C4) tests-reusable.yml: HEAD/ref esitlik dogrulama adimi var (fail closed)", () => {
  assert.match(REUSABLE, /git rev-parse HEAD/);
  assert.match(REUSABLE, /fail closed/i);
  assert.match(REUSABLE, /exit 1/);
});

// ---- D: clarity-daily.yml handoff yapisi ----
test("(D1) clarity-daily.yml: clarity-daily job'u persisted_sha ciktisi persist step id'sinden gelir", () => {
  assert.match(CLARITY, /id:\s*persist/);
  assert.match(CLARITY, /outputs:\s*\n\s*persisted_sha:\s*\$\{\{\s*steps\.persist\.outputs\.persisted_sha\s*\}\}/);
});

test("(D2) clarity-daily.yml: verify-persistence job'u reusable testleri persisted_sha ile cagirir, github.sha ile DEGIL", () => {
  const verifyBlock = CLARITY.slice(CLARITY.indexOf("verify-persistence:"));
  assert.match(verifyBlock, /needs:\s*clarity-daily/);
  assert.match(verifyBlock, /uses:\s*\.\/\.github\/workflows\/tests-reusable\.yml/);
  assert.match(verifyBlock, /ref:\s*\$\{\{\s*needs\.clarity-daily\.outputs\.persisted_sha\s*\}\}/);
  assert.ok(!/ref:\s*\$\{\{\s*github\.sha\s*\}\}/.test(verifyBlock), "verify-persistence github.sha KULLANMAMALI");
});

// ---- E: dogrulama-basarisizligi semantigi — maskeleme yok, rollback/force-push yok ----
test("(E1) clarity-daily.yml: verify-persistence cagrisi continue-on-error/if:always() ile maskelenmemis", () => {
  const verifyJobBlock = CLARITY.split(/\n  [a-zA-Z-]+:\n/).find((b) => b.includes("tests-reusable.yml") && b.includes("needs: clarity-daily")) ?? "";
  assert.ok(!/continue-on-error:\s*true/.test(verifyJobBlock), "verify-persistence continue-on-error: true ICERMEMELI");
  // 'if:' verify-persistence'ta sadece persisted_sha bos degilse kosullu calisma icin var, always() degil.
  const ifLine = verifyJobBlock.match(/if:\s*([^\n]+)/)?.[1] ?? "";
  assert.ok(!/always\(\)/.test(ifLine), "verify-persistence if kosulu always() ICERMEMELI");
});

test("(E2) clarity-daily.yml ve persist-history.sh: revert/force-push/rollback mantigi yok", () => {
  const scriptSrc = readFileSync(join(ROOT, "scripts/persist-history.sh"), "utf8");
  for (const [name, src] of [["clarity-daily.yml", CLARITY], ["persist-history.sh", scriptSrc]] as const) {
    assert.ok(!/git revert/.test(src), `${name}: git revert OLMAMALI`);
    assert.ok(!/push[^\n]*(-f\b|--force)/.test(src), `${name}: force push OLMAMALI`);
    assert.ok(!/rollback/i.test(src), `${name}: rollback mantigi OLMAMALI`);
  }
});

// ---- F: mevcut Tests tetikleri degismedi ----
test("(F) tests.yml: pull_request / push:branches:[main] / workflow_dispatch korunuyor", () => {
  assert.match(TESTS, /on:\s*\n\s*pull_request:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]\s*\n\s*workflow_dispatch:/);
  assert.match(TESTS, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(TESTS, /concurrency:\s*\n\s*group:\s*tests-\$\{\{\s*github\.event\.pull_request\.number\s*\|\|\s*github\.ref\s*\}\}/);
});
