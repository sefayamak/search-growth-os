# CLI bağlama planı — #31–#38 üretici modülleri `src/cli.ts`'e nasıl bağlanır

**Durum (2026-10-02):** yalnız plan + doğrulanmış yama. Bu belge kod değiştirmez; `docs/integration/cli-wiring.patch` ancak
#31–#38 main'e merge edildikten sonra uygulanır (**tek başına main'de DERLENMEZ**). Hiçbir komut üretim sitesine, Vercel'e veya
GitHub'a yazmaz; **üretim-mutasyon komutu yoktur ve eklenmeyecektir**. Ölçülmeyen sayı yazılmaz: aşağıdaki sayılar bu oturumda
geçici bir worktree'de ölçüldü (bkz. bölüm 7).

Taban: `origin/main` = `031d0e8`. Sekiz üretici dalın hiçbiri `src/cli.ts`'e dokunmuyor (dal başına `git diff --stat` ile
doğrulandı); bu yüzden bağlama tek ayrı PR'dır ve dallarla çakışmaz.

---

## 1. Mevcut CLI sözleşmesi (tam olarak)

Kaynak: `src/cli.ts` (779 satır, `origin/main`), `CLAUDE.md`, `DEVAM.md`.

**Yapı.** `const args = process.argv.slice(2); const cmd = args[0];` ardından tek `switch (cmd)`. `main().catch(e => { console.error(e);
process.exitCode = 1 })`. Çalıştırma: `node --experimental-strip-types src/cli.ts <komut> …` (npm script `cli`). Yardım: `default` dalındaki
tek satırlık `commands: a | b | …` + dosya başındaki yorum bloğu — **ikisi de elle tutulur**; yeni komut ikisine de yazılmalı.

**Argüman ayrıştırma.**

| Mekanizma | Davranış |
|---|---|
| `opt(name, def?)` | `--name değer` (iki ayrı argüman). `--name=değer` yok. Aynı seçenek tekrarlanırsa ilki geçerli → tekrar eden seçenek için kendi `flatMap`'imiz gerekir |
| `flag(name)` | boolean, `args.includes("--name")` |
| Konumsal | `args[1]` (dosya/dizin ya da registry) |
| Registry | **İki kalıp.** (A) `[registry]` konumsal, `--` ile başlamıyorsa, varsayılan `config/sites.yaml`: `measure`, `detail`, `topics`, `smoke`, `clarity-*`, `brain-*`, `inspect-index`. (B) `--registry path`, varsayılan `config/sites.yaml`: `audit`, `import-health` |
| Site | `--site id`; bilinmiyorsa `site bulunamadi: <id>` + exit 1. Onboarding kapısı yalnız tavsiye/tarama üreten komutlarda (`audit --site`, `brain-*`, `inspect-index`): `onboard edilmemis` + exit 1. **Ölçüm** komutları her kayıtlı siteye çalışır (kural 3) |

**Çıktı.** stdout: insanın okuyacağı Türkçe metin/markdown. stderr: tanı ve hata. `--out dir`: JSON+MD yazılan dizin
(`reports/runs`, `clarity-out`, `brain-out`, `handoff-out`). **`cli.ts`'te `--json` yoktur** (yalnız `bin/*.ts` betiklerinde). Yazma bayrakları iki yönlü:
opt-in `--write` (`import-health`, `inspect-index`, `topics --write-ledger`; bayrak yoksa "hicbir dosya yazilmadi" satırı basılır) ve opt-out
`--no-write-history` (`clarity-daily`).

**Gizli bilgi.** Token/anahtar yalnız ortam değişkeninden; CLI argümanı olarak verilirse **reddedilir ve değeri yankılanmaz** (`clarity-*`, `brain-run`).

**Yükleme.** Yeni komutlar `await import("./x.ts")` ile tembel yüklenir (`measure`, `clarity-*`, `brain-*`, `import-health`, `inspect-index`); eski komutlar
dosya başında statik import.

**Çıkış kodları (mevcut, komuta özel):**

| Kod | Kim | Anlam |
|---|---|---|
| 0 | hepsi | tamam. `NOT_CONNECTED`, alert, atlanan site, `NOT_CONFIGURED` **hata değildir** (kimlik yok ≠ hata) |
| 1 | hepsi | kullanım hatası, registry geçersiz, site yok, G/Ç hatası, ERROR/PARTIAL ölçüm, bozuk geçmiş; `compliance` için FLAG |
| 2 | `compliance` | REJECT |
| 3 | `crawl`/`audit` | hedef erişilemez |
| 4 | `portfolio` | en az bir host ölçülemedi |
| 5 | `llmstxt` | canlı dosya, owner-onaylı bir olguyla çelişiyor (CONFIRMED) |

3–5 komuta özeldir; yeni numara icat edilmez.

---

## 2. Önerilen komutlar (mevcut kebab desenini izler)

Desen: `<alan>-<fiil/ad>` (`clarity-daily`, `import-health`, `inspect-index`, `brain-validate`) ya da tek kelime (`portfolio`, `measure`). Yeni
bir adlandırma standardı **icat edilmedi**; her ad bir üretici modülün kendi adından/önerisinden türedi.

| # | Komut | Modül (PR) | Okur | Yazar | Ağ | Kimlik | Exit 1 olduğu durumlar | Exit 0 kalan (kasıtlı) |
|---|---|---|---|---|---|---|---|---|
| 1 | `clarity-takeover-status [registry] [--history dir] [--runs file] [--json]` | `clarity-takeover-status.ts` (#31) | `data/clarity-history/*.json`, `--runs` | yalnız stdout | yok | yok | registry geçersiz/okunamıyor | zincir `NONE`, `NOT_SUCCESS` günler, koşu kaydı sorunları, `site_problems` (rapora yazılır; bu bir kapı değil durum raporu) |
| 2 | `deployment-timeline <timeline.json> [--registry path] [--site id]` | `deployment-timeline.ts` (#32) | verilen dosya | stdout | yok | yok | `parseTimeline` fail-closed ret (tek bozuk olay, yabancı site, tekrar, sıra), site registry'de yok, `--site` uyuşmuyor, dosya yok | — |
| 3 | `deployment-ingest <providerJson> --site id --provider github\|vercel [--registry path] [--timeline dir] [--write]` | #32 | kayıtlı sağlayıcı JSON'u + varsa `data/deployment-timeline/<site>.json` | `--write` ile **yalnız** `<dir>/<site>.json` | yok (CLI ağsız; JSON'u workflow `gh api` ile çeker) | yok | tanınmayan gövde şekli, site/provider geçersiz, mevcut çizelge bozuk | satır bazlı `REDDEDILDI` satırları (yazdırılır, sessiz düşmez) |
| 4 | `content-validate <file.json> [--registry path] [--to STAGE]` | `content-pipeline.ts` (#33) | dosya (kayıt ya da dizi) | stdout | yok | yok | herhangi bir kayıt/geçiş geçersiz, dosya okunamadı | — |
| 5 | `content-classify <rows.json>` | #33 | GSC satırları (`[...]` ya da `{rows}`) | stdout | yok | yok | girdi dizi değil, dosya okunamadı | çıktı her zaman `INFERENCE`; eşik altı → `skip`/`UNKNOWN` |
| 6 | `index-alarms [registry] --site id [--probe index-probe.json] [--data dir] [--write] [--now iso]` | `index-alarms.ts` (#34) | `data/index-history/<site>.json`, `data/canonical-backlog/<site>.json`, `--probe` | `--write` **ve** `--probe` ile bu iki yol | yok | yok | site yok, geçmiş/backlog bozuk (fail-closed), `--probe` index-probe çıktısı değil / **başka siteye ait** (`SITE IZOLASYONU`), `--probe`suz `--write` | alarm yok (`NO_ALARM_IN_SAMPLE`), bellek boş (`UNKNOWN`). Çıktı ÖRNEKLEMdir |
| 7 | `agent-contracts-validate <oneriler.json> [--registry path]` | `agent-contracts.ts` (#35) | `[{kind: internal_link\|schema_entity, input}]` | stdout | yok | yok | herhangi bir öğe `ACCEPTED` değil (`BLOCKED_CROSS_SITE`, `BLOCKED_NOT_ONBOARDED`, `REJECTED_FABRICATED`, `INVALID`), bozuk girdi | — (`ACCEPTED` = sözleşmeye uygun, **uygulama izni değil**) |
| 8 | `performance-measure [registry] [--site id] [--url u]… [--urls-per-site N] [--strategy mobile,desktop] [--max-requests N] [--history dir] [--write] [--out dir]` | `performance.ts`, `performance-psi.ts` (#36) | `data/performance-history/<site>.json` | `--write` ile **yalnız** `--history` dizini; `--out` ile JSON+MD | **evet: yalnız PageSpeed Insights (Google), GET** | `PAGESPEED_API_KEY` (env). Argüman olarak reddedilir | bozuk geçmiş (`HISTORY_CORRUPT`), herhangi bir `ERROR` kaydı, kötü argüman, `--url` `--site`siz, `--api-key` argümanı | anahtar yok → `NOT_CONNECTED`, **istek yok, geçmişe yazılmaz**; regresyon adayı (alert, hata değil) |
| 9 | `change-eval <proposal.json> [--registry path] [--ledger file] [--kill-switch path] [--allow-absent-kill-switch] [--now iso]` | `change-safety.ts` (#37) | proposal, ledger, `data/kill-switch.json` | stdout | yok | yok | `ALLOW_FOR_REVIEW` dışındaki her karar (`BLOCK_*`, `REJECT_INVALID_PROPOSAL`) ya da okunamayan girdi | yalnız `ALLOW_FOR_REVIEW`. **İnceleme içindir, uygulama izni değildir** |
| 10 | `change-lint <planned-actions.json> [--registry path]` | #37 | eylem listesi | stdout | yok | yok | herhangi bir ihlal (korumalı dala push, deploy, `gh pr merge`, toplu indeksleme isteği, üretim host'una yazma) | ihlal yok (**statik tarama**; `$CMD`/base64 ile kurulan komutu görmez) |
| 11 | `scorecard [registry] [--site id] [--json] [--clarity d] [--performance d] [--index d] [--deployments d] [--measure f]` | `scorecard.ts` (#38) | artifact dizinleri (`<dir>/<site>.json`) | stdout | yok | yok | registry geçersiz, site yok | `UNKNOWN`/`UNKNOWN-STALE`/`ATTENTION` normal durumlardır; tek skor yok |
| 12 | `orchestration-check [--drift] [--json]` | `orchestration.ts` (#38) | model + (`--drift`) `.github/workflows/*.yml` | stdout | yok | yok | herhangi bir `ERROR` bulgusu ya da drift. **Bugün 1** (`DUPLICATE_SCHEDULER`, legacy rutin kapanana kadar) | `WARN`/`INFO` |

**Ortak kurallar (hepsi):** üretim sitesine HTTP yazısı yok; Vercel/GitHub'a yazı yok; yazma yalnız bu deponun `data/` yoluna ve yalnız `--write` ile
(varsayılan **yazmaz**: `import-health`/`inspect-index` deseni); secret CLI argümanı değil; her komut portföy izolasyonunu korur (yabancı site kaydı/probe'u/URL'si ret).
Ağ gereken **tek** komut `performance-measure`.

**Sınıflar.** *Rapor* komutları (1, 6, 11, 12'nin WARN'ları, 8'in alert'leri): bulgu = çıktı, kırmızı değil; yalnız ölçüm/okuma **hatası** 1 döner (`clarity-daily` deseni).
*Kapı* komutları (2, 4, 7, 9, 10): aday girdiyi doğrular; kabul = 0, her ret = 1, nedeni stdout'ta (ayrı kod icat edilmedi; `compliance`'ın 2'si ona özeldir).

**Adlandırma kararları.** `lighthouse` adı verilmedi: modül PSI çağırır, Lighthouse'u kendisi koşmaz → `performance-measure` (`clarity-measure` ile paralel).
`deployment-verify` **ayrılmadı**: canlı SHA probe'u (`LiveProbe`) bu depoda yok; o ad henüz doğrulama yapmayan bir komutta yanlış izlenim verirdi.
`orchestration-check` ve `agent-contracts-validate` modül adından; `brain-validate` ile aynı fiil.

**Bilerek bağlanmayanlar:** `verifyDeployment`/`correlate` (canlı probe + metrik değişimi girdisi yok); `advance()` onay durum makinesi ve `parseKillSwitch` (kalıcı
kayıt/ledger yazarı yok — bkz. B5); `attachRow`. Bunlar kütüphane işlevidir; bir komut çıplak çağırırsa "yarım doğrulama" üretirdi.

**Sapmalar (owner'ın bilmesi gereken, yamadadır):**
(1) `--json` yalnız #1, #11, #12'de: üreticilerin `bin/*.ts` betikleri zaten bu bayrağı tanımlıyor; cli'de yeni global bir standart değil. İstenmezse kaldırması tek satır.
(2) `--url` tekrarlanabilir (`opt` tekrarı desteklemez) — yamada kendi `flatMap`'i var.
(3) Dosya girdili komutlar `<dosya> [--registry path]` (B kalıbı, `import-health` gibi); registry odaklı olanlar `[registry]` (A kalıbı).
(4) `bin/clarity-takeover-status.ts` ve `bin/scorecard.ts` yamayla **kaldırılmaz**; iki giriş noktası zamanla ayrışabilir → bağlama sonrası ince sarmalayıcıya çevrilmesi önerilir (ayrı iş).

---

## 3. Merge bağımlılıkları

| Komut | Gerektirdiği PR | Ek ön koşul (main'de var) |
|---|---|---|
| `clarity-takeover-status` | #31 `claude/sprint-clarity-takeover-status` | `clarity-daily.ts` (`loadHistory`, `measurementSuccessOf`) |
| `deployment-timeline`, `deployment-ingest` | #32 `…-deployment-verifier` | `types.ts` |
| `content-validate`, `content-classify` | #33 `…-content-pipeline` | `registry.ts`, `types.ts` |
| `index-alarms` | #34 `…-index-alarms` | `index-probe.ts`, `canonical-relations.ts` |
| `agent-contracts-validate` | #35 `…-link-schema-contracts` | `registry.ts` |
| `performance-measure` | #36 `…-lighthouse` | `registry.ts` |
| `change-eval`, `change-lint` | #37 `…-change-safety` | `registry.ts` |
| `scorecard`, `orchestration-check` | #38 `…-scorecard-orchestration` | — (girdi şemaları id ile okunur; başka modül import etmez) |

Sekiz dal **birbirinden bağımsız** (dosya kümeleri ayrık; geçici worktree'de hepsi çakışmasız merge edildi) → merge sırası serbest.
`scorecard`'ın *anlamlı* çıktısı #31 (clarity geçmişi main'de zaten var), #34/#36/#32'nin yazdığı verilere bağlı (bölüm 5, sözleşme uyuşmazlığı).
`cli-wiring.patch` **sekizinin hepsi** merge olduktan sonra tek PR olarak uygulanır (statik tip denetimi bütün dinamik import'ları çözer). Kısmi bağlama
istenirse yamadan ilgili `case` blokları ve usage satırı elle ayıklanır; bloklar bağımsızdır.

---

## 4. Yama (`docs/integration/cli-wiring.patch`)

**DOES NOT COMPILE ON MAIN ALONE** (başlık yamanın içinde de yazılı; `git apply` başlığı yok sayar). Kapsam: yalnız `src/cli.ts` (+214 satır: 12 komut etiketi,
dosya başı yorum, `readdirSync` import, `default` usage satırı) ve `tests/cli-wiring.test.ts` (13 test). `.github/`, `package.json`, secret, üretim sitesi: dokunulmadı.

Testler (yanlış pozitif + yanlış negatif, depo kuralı): yabancı site GSC satırı kabul edilmez / temiz kayıt reddedilmez; eşik altı satır `CONFIRMED` üretmez; kill-switch dosyası yokken
`change-eval` engeller, bayrakla yalnız incelemeye gider, `robots` her zaman insana; `main`'e push ihlal, salt-okunur eylem temiz; PSI anahtarı yokken `NOT_CONNECTED` + geçmişe yazmaz +
anahtar argümanı yankılanmaz; yabancı site olayı çizelgeyi reddeder; yabancı probe `index-alarms`'ta reddedilir ve dosya yazılmaz; çapraz-site hedef `BLOCKED_CROSS_SITE`; koşu kaydı
yokken `FULL_TAKEOVER_SUCCESS` iddia edilmez ve girdisiz scorecard boyutu `OK` olmaz; `orchestration-check` çıkış kodu ERROR bulgusuyla birebir (legacy kapanınca kendiliğinden 0);
yeni blok içinde `fetch(`/`child_process` yok.

---

## 5. Entegrasyon bulguları (bu oturumda doğrulandı)

**B1 — Scorecard okuma sözleşmesi, üreticilerin gerçek yazdığı şekille uyuşmuyor (FACT, sentetik fixture ile ölçüldü).** Üreticilerin kendi fonksiyonlarıyla yazılan dosyalar
scorecard'a verildi (geçici worktree, `data/` dışı fixture):

| Boyut | Üretici ne yazıyor | Scorecard ne okuyor | Sonuç |
|---|---|---|---|
| `performance` | `sgos.performance-history.v1`, `records[]`, `state`, `site` | aynı şema, `records[]`, `measurement_state` (yoksa kontrol atlanır) | **çalışıyor** (kayıt: `lcp_ms=9000` → `ATTENTION`, INFERENCE/CANDIDATE). Geçmişe yalnız `MEASURED` yazıldığı için `state` farkı zararsız |
| `index_health` | `sgos.index-history.v1`, **`snapshots[]`**, `entries[]` | **`records[]`**, `sample_size`, `not_indexed_count` | `UNKNOWN` "index gecmisi var ama kayit yok": iki ardışık `NOT_INDEXED` snapshot'ı **görünmez** |
| `deployment_change` | zaman çizelgesi `sgos.deployment-timeline.v1`, olaylarda **`site`** | `{generated_at, events[]}`, olayda **`site_id`** | `UNKNOWN` "generated_at/as_of yok": `MISMATCH` bir deploy bile **görünmez** |
| `search_opportunity` | `measure` yalnız Markdown üretir | `sgos.measure-report.v1` JSON | `UNKNOWN` (girdi yok) — zaten belgelenmişti |

Hepsi **güvenli yönde** başarısız (`UNKNOWN`, asla yanlış `OK`) ama dört boyutun ikisi veri geldikçe de **kör kalır**. Öneri: düzeltme **okuyucuda** (#38) — scorecard üreticilerin
gerçek şeklini kabul etsin (`snapshots[]`'tan `sample_size`/`not_indexed_count` türet; olayda `site`; çizelge dosyasının tazeliği için `retrieved_at`/en son `provenance.retrieved_at`),
çünkü üreticiler kendi şemalarını testle sabitledi. Alternatif: tek yönlü adaptör. Karar: owner/orkestratör; bu oturum #38'e dokunmadı.

**B2 — `orchestration-check` bugün kırmızı ve bu doğru.** `DUPLICATE_SCHEDULER` (ERROR): `clarity-daily` (GATED) + legacy rutin (ACTIVE) aynı Clarity havuzunda. Legacy `DISABLED` olunca söner.
Bu komutu **zorunlu CI kapısı yapma**; workflow'da `continue-on-error: true` ile bilgi olarak koş, legacy kapanınca kaldır (`workflow-architecture.md`).

**B3 — İki mevcut test, yeni workflow'lar için bilinçli güncelleme ister** (workflow PR'ında, bağlama PR'ında değil):
`tests/index-candidates.test.ts:286` (`index-probe.yml`'de `schedule` YOK) → bu yüzden indeks alarmı **yeni bir workflow**'dadır, `index-probe.yml` değişmez; `tests/orchestration.test.ts:97`
(dört yeni katman `PLANNED`) → her workflow PR'ı yalnız kendi işinin durumunu çevirir, testi o iş için günceller. `orchestration.ts` modeli her workflow değişikliğiyle **aynı PR'da** güncellenmeli (drift testi).

**B4 — Takeover için koşu kaydı üreticisi yok.** `clarity-takeover-status` `--runs` ister (`{date_utc, run_id, fresh_measurement_success, total_sites, measurement_success}`); `clarity-daily` bunu üretmiyor
(yalnız `clarity-alerts.json` içinde `coverage` sayıları var). Kayıt olmadan tazelik `UNKNOWN`, `FULL_TAKEOVER_SUCCESS` iddia edilmez (doğru, ama zincir `FULL_TAKEOVER_2_OF_2`'ye hiç ulaşamaz). Ayrı küçük iş:
`clarity-daily`'nin `clarity-out/clarity-alerts.json`'dan kayıt üretmesi ya da workflow adımı.

**B5 — Değişiklik ledger'ının yazarı yok.** `change-eval --ledger` bir dosya bekler; onaylanan/uygulanan değişiklikleri o dosyaya yazan hiçbir şey yok. Bütçe kontrolü yalnız verilen dosya kadar doğrudur
(yanlış negatif riski: boş ledger = bütçe dolu değil). Yazma yolu olmadığı sürece (bu planın kapsamı dışı) sonuç yalnız bilgi.

---

## 6. Yapılmayanlar (bilerek)

- Üretim sitesine/Vercel'e/GitHub'a yazan, deploy eden, toplu indeksleme isteyen, `robots`/canonical/hreflang/structured data uygulayan **hiçbir komut**.
- Canlı SHA probe'u (`deployment-verify`): sitede meta/header açılması site sahibiyle karar ister.
- `measure` çıktısını `GscRow`'a çeviren adaptör ve `sites/<site>/drafts/` sözleşmesi (içerik hattı şu an elle/CLI).
- `package.json` script'leri, `README`/`CLAUDE.md` komut listesi ve test sayısı (`459`): bağlama PR'ından sonra owner günceller. Ölçülen sayılar: 8 PR sonrası **669**, yama ile **682**.

---

## 7. Doğrulama kaydı (2026-10-02, geçici worktree'ler silindi)

1. `origin/main` (`031d0e8`) üstüne 8 dal tek `git merge` ile: **çakışma yok**. `npm run typecheck` temiz; `npm test` **669/669** (459 + 210).
2. Yama bu worktree'ye uygulandı: `git apply --check` + `git apply` temiz; `npm run typecheck` temiz; `npm test` **682/682** (669 + 13).
3. Yama **yalnız main'e** uygulandı: uygulanır, ama `npm run typecheck` **23 TS hatası** (modüller yok) → başlıktaki uyarının kanıtı.
4. Komutlar elle koşuldu: `clarity-takeover-status` (commit'li history → `COVERAGE_VALIDATION_SUCCESS`, tazelik `UNKNOWN`, zincir `NONE`), `orchestration-check --drift` (exit 1, `DUPLICATE_SCHEDULER`),
   `scorecard` (bölüm 5 B1 tablosu).
5. Ağ yok, secret yok, canlı API çağrısı yok.

## 8. Owner kararları (açık)

| # | Karar | Varsayılan önerim |
|---|---|---|
| K1 | B1: scorecard okuyucusu mu düzeltilsin, adaptör mü? | Okuyucu (#38) |
| K2 | `--json` yeni komutlarda kalsın mı (sapma 1)? | Kalsın (bin betikleri zaten kullanıyor) |
| K3 | `bin/*.ts` sarmalayıcıya çevrilsin mi (sapma 4)? | Evet, ayrı iş |
| K4 | `change-eval` kill-switch dosyası yokken engellesin mi (strict)? | Evet (producer önerisi; `--allow-absent-kill-switch` yalnız deneme) |
