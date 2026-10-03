// index-probe.yml job timeout sozlesmesi. Workflow'u CALISTIRMAZ; metni statik olarak okur.
//
// NEDEN: 7 site sirayla (izole, try/catch) calisiyor; canli dogrulama (run 37139472893) sirasinda
// toplam sure gozlemsel olarak ~17.5-21 dakika surdu ve eski 15 dakikalik is zaman asimi isi
// GitHub tarafindan iptal etti (4/7 site tamamlandi, 1 yarim, 2 hic calismadi). Bu test, timeout
// degerinin o gozlemlenen sureyi tekrar karsilamayacak kadar dusuk bir degere REGRESYON yapmasini
// yakalar. Diger workflow alanlarina (site dongusu, limitler, tetikleyiciler, zamanlama) kasitli
// olarak DOKUNMAZ — bkz. tests/index-probe.test.ts (CLI/mantik) ve src/orchestration.ts (model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WF = readFileSync(new URL("../.github/workflows/index-probe.yml", import.meta.url), "utf8");

// Gozlemlenen 7-site sirali kosu suresi ~17.5-21 dakika (run 37139472893, 2026-10-03).
// Mevcut bir degisiklik olmadan (paralellik/orneklem kucultme) bu tavanin altina inilmemeli.
const MIN_SAFE_TIMEOUT_MINUTES = 25;

test("job timeout, gozlemlenen 7-site sirali kosu suresini (~17.5-21dk) karsilayacak kadar yuksek", () => {
  const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(WF);
  assert.ok(m, "timeout-minutes alani bulunamadi");
  const minutes = Number(m![1]);
  assert.ok(
    minutes >= MIN_SAFE_TIMEOUT_MINUTES,
    `timeout-minutes=${minutes} < ${MIN_SAFE_TIMEOUT_MINUTES} (7-site sirali kosu icin yetersiz; run 37139472893'te 15dk zaman asimina ugramisti)`,
  );
});

test("tam olarak tek bir timeout-minutes alani var (baska bir job/degisiklik sessizce eklenmemis)", () => {
  const matches = [...WF.matchAll(/^\s*timeout-minutes:\s*\d+\s*$/gm)];
  assert.equal(matches.length, 1, "beklenenden farkli sayida timeout-minutes alani");
});
