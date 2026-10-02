#!/usr/bin/env node --experimental-strip-types
// READ-ONLY başlangıç/durum denetimi. Yeni bilgisayarda / sıfır bağlamlı Claude oturumunda İLK çalıştırılacak komut.
// usage: node --experimental-strip-types bin/project-status.ts [--remote] [--json] [--no-fsck] [--no-gh]
//   (varsayılan: yalnız YEREL inceleme, ağ yok)  --remote: açık bayrak; `git fetch origin main` + `gh pr list` (salt-okunur).
// exit 0: rapor üretildi, devam edilebilir (bilgi/uyarı olabilir) · exit 1: DUR (WRONG_REPOSITORY, GIT_OBJECT_ERROR, REMOTE_UNREACHABLE, UNKNOWN).
// YAPMAZ: merge/pull/reset/checkout/rebase/push/clean/stash, workflow dispatch, secret okuma, üretim çağrısı.
import { inspect, reportToText } from "../src/project-status.ts";

const a = process.argv.slice(2);
const unknown = a.filter((x) => !["--remote", "--json", "--no-fsck", "--no-gh"].includes(x));
if (unknown.length) { console.error(`bilinmeyen argüman: ${unknown.join(" ")}\nkullanım: project-status [--remote] [--json] [--no-fsck] [--no-gh]`); process.exit(1); }
const report = inspect({ cwd: process.cwd(), remote: a.includes("--remote"), fsck: !a.includes("--no-fsck"), gh: !a.includes("--no-gh") });
console.log(a.includes("--json") ? JSON.stringify(report, null, 2) : reportToText(report));
process.exitCode = report.stop ? 1 : 0;
