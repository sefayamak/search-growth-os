# CLI bağlama — #31–#38, #40, #41 üretici modülleri `src/cli.ts`'e nasıl bağlandı

**Durum (2026-10-02):** **uygulandı.** Üretici PR'ların hepsi (#31–#38, #40, #41) `origin/main`'e **MERGE EDİLDİ** (`a2c8700`); on iki komut `src/cli.ts`'te gerçek
koddur, sözleşme testleri `tests/cli-wiring.test.ts`'tedir. Bu belge artık "plan"dan çok **komut referansı + güvenlik sözleşmesidir**.
Hiçbir komut üretim sitesine, Vercel'e veya GitHub'a yazmaz; **üretim-mutasyon komutu yoktur ve eklenmeyecektir**. Ölçülmeyen sayı yazılmaz.

**Tarihsel not.** Bu dalın ilk sürümü, üretici dallar henüz merge edilmemişken yazılmış bir yama (`docs/integration/cli-wiring.patch`) taşıyordu
(o sırada "tek başına main'de derlenmez" idi). Yama, gerçek uygulamayla **yerine geçildi (superseded) ve silindi**: kod artık doğrudan `src/cli.ts`'te.
Yamadan farklar: `--runs` kalktı (aşağıda), `--help` her komutta, ortak hata sarmalayıcısı, repo-yerel yazma kapısı, ek site izolasyonu ve bozuk-girdi kapıları,
13 yerine ~37 sözleşme testi. Yama dosyası git geçmişinde durur (`git show d14ce68:docs/integration/cli-wiring.patch`).

---

## 1. Mevcut CLI sözleşmesi (tam olarak)

Kaynak: `src/cli.ts`, `CLAUDE.md`, `DEVAM.md`.

**Yapı.** `const args = process.argv.slice(2); const cmd = args[0];` ardından tek `switch (cmd)`. Çalıştırma: `node --experimental-strip-types src/cli.ts <komut> …`.
Yardım: `default` dalındaki `commands: a | b | …` satırı + dosya başındaki yorum bloğu (**ikisi de elle tutulur**) + yeni komutlar için `INTEGRATION_USAGE` tablosu.

**Argüman ayrıştırma.**

| Mekanizma | Davranış |
|---|---|
| `opt(name, def?)` | `--name değer` (iki ayrı argüman). `--name=değer` yok. Tekrarlanan seçenekte ilki geçerli → `--url` için kendi `flatMap`'imiz var |
| `flag(name)` | boolean, `args.includes("--name")` |
| Konumsal | `args[1]` (dosya/dizin ya da registry) |
| Registry | **İki kalıp.** (A) `[registry]` konumsal, `--` ile başlamıyorsa, varsayılan `config/sites.yaml`: `clarity-takeover-status`, `index-alarms`, `performance-measure`, `scorecard` (+ mevcut `measure`, `clarity-*`, `brain-*`, `inspect-index`). (B) `--registry path`, varsayılan `config/sites.yaml`: dosya girdili komutlar (`deployment-*`, `content-*`, `agent-contracts-validate`, `change-*`) (+ mevcut `audit`, `import-health`) |
| Site | `--site id`; bilinmiyorsa `site bulunamadi: <id>` + exit 1. **Ölçüm** komutları her kayıtlı siteye çalışır (kural 3); tavsiye üretimi yalnız onboard edilmiş siteye |

**Çıktı.** stdout: Türkçe metin/markdown (ya da `--json`). stderr: hata. `--json` yalnız `clarity-takeover-status`, `scorecard`, `orchestration-check`'te (üreticilerin `bin/*.ts` betikleri bu bayrağı zaten tanımlıyor).
**Yazma yalnız iki yoldan:** opt-in `--write` (varsayılan **yazmaz**, çıktı "hicbir dosya yazilmadi" der) ve `--out dir` (JSON+MD raporu). Yazma hedefi **repo-yerel olmalı** (cwd altında; `../` ya da mutlak yol dışarı çıkamaz → exit 1, `localOnly()`).

**Gizli bilgi.** Anahtar yalnız ortam değişkeninden. `performance-measure` için `--api-key`, `--key`, `--token`, `--secret` içeren **her** argüman (`--x=değer` dahil) **reddedilir ve değer yankılanmaz**.

**Hata sarmalayıcısı.** Yeni 12 komutta beklenmeyen istisna yığın izi değil `<komut> HATA: <tek satır>` + exit 1'dir (`main().catch` yalnız bu komutlar için sarılı; mevcut komutların davranışı **değişmedi**).

**`--help`.** `<komut> --help` (ya da `-h`) yalnız o komutun kullanım satırını basar: exit 0, hiçbir dosya okunmaz/yazılmaz, ağ yok, anahtar okunmaz.

**Çıkış kodları.** Bu çalışma **yeni numara icat etmedi**: yeni komutlar yalnız **0 ve 1** kullanır. Mevcut komuta-özel 2 (`compliance` REJECT), 3 (`crawl`/`audit` erişilemez), 4 (`portfolio`), 5 (`llmstxt`) korunur.
`NOT_CONNECTED`, alert, `UNKNOWN`, atlanan site **hata değildir** (kimlik/veri yok ≠ hata); okuma/ayrıştırma/izolasyon ihlali ve kapı reddi = 1.

---

## 2. Komut tablosu (nihai)

Hepsi **çevrimdışıdır, tek istisna `performance-measure`** (PageSpeed Insights GET). Hiçbiri shell/`child_process` kullanmaz.

| # | Komut ve argümanlar | Okur | Yazar | Ağ | Exit 0 | Exit 1 |
|---|---|---|---|---|---|---|
| 1 | `clarity-takeover-status [registry] [--history dir] [--json]` | `data/clarity-history/<site>.json` (kanıt = `source_run_id`) | stdout | yok | rapor üretildi; zincir `NONE`, `NOT_SUCCESS` günler, eksik history dizini = UNKNOWN (hata değil) | registry geçersiz; bir site geçmişi okunamadı/bozuk (`Site sorunlari` raporda yazılır) |
| 2 | `deployment-timeline <timeline.json> [--registry path] [--site id]` | verilen dosya | stdout | yok | çizelge geçerli (özet: ortam ve `verification_state` sayıları) | dosya yok/bozuk/schema hatalı; olay yabancı siteye ait; site registry'de yok; `--site` dosya sitesiyle uyuşmuyor |
| 3 | `deployment-ingest <providerJson> --site id --provider github\|vercel [--registry path] [--timeline dir] [--write]` | sağlayıcı JSON'u + varsa `<timeline dir>/<site>.json` | `--write` ile **yalnız** `<timeline dir>/<site>.json` (repo-yerel) | yok (JSON'u workflow `gh api`/Vercel API ile çeker) | okundu; **satır bazlı `REDDEDILDI` satırları yazdırılır, exit 0** (kısmi kabul belgeli). **Hiçbir olay `VERIFIED` olmaz, hepsi `UNVERIFIED`** | girdi yok/bozuk/tanınmayan şekil; site registry'de yok; provider geçersiz; mevcut çizelge bozuk ya da başka siteye ait; `--timeline` cwd dışı (`--write` ile) |
| 4 | `content-validate <file.json> [--registry path] [--to STAGE]` | dosya (kayıt ya da dizi) | stdout | yok | tüm kayıtlar geçerli | herhangi bir kayıt geçersiz (yabancı site GSC satırı, nesne olmayan kayıt, geçersiz geçiş), dosya yok/bozuk, `--to` bilinmiyor |
| 5 | `content-classify <rows.json> [--registry path]` | GSC satırları (`[...]` ya da `{rows}`) | stdout | yok | tek siteye ait satırlar; çıktı her zaman `INFERENCE`, eşik altı → `skip`/UNKNOWN | girdi dizi değil/boş/bozuk/yok; **karışık, sitesiz ya da kayıtsız site satırı** (`SITE IZOLASYONU`) |
| 6 | `index-alarms [registry] --site id [--probe index-probe.json] [--data dir] [--write] [--now iso]` | `<data>/index-history/<site>.json`, `<data>/canonical-backlog/<site>.json`, `--probe` | `--write` **ve** `--probe` ile bu iki yol (repo-yerel `--data`) | yok | rapor (`NO_ALARM_IN_SAMPLE` / alarm / bellek boş = UNKNOWN). Çıktı **ÖRNEKLEM**dir, tam coverage değil | site yok; geçmiş/backlog bozuk; `--probe` yok/bozuk/index-probe çıktısı değil/**başka siteye ait**; `--write` `--probe`suz; `--data` cwd dışı |
| 7 | `agent-contracts-validate <oneriler.json> [--registry path]` | `[{kind: internal_link\|schema_entity, input}]` | stdout | yok | tüm öğeler `ACCEPTED` (= sözleşmeye uygun, **uygulama izni değil**) | `ACCEPTED` olmayan öğe (`BLOCKED_CROSS_SITE`, `BLOCKED_NOT_ONBOARDED`, `REJECTED_FABRICATED`, `INVALID`); dosya yok/bozuk; dizi değil; bilinmeyen `kind` |
| 8 | `performance-measure [registry] [--site id] [--url u]… [--urls-per-site N] [--strategy mobile,desktop] [--max-requests N] [--history dir] [--write] [--out dir]` | `<history>/<site>.json` | `--write` ile **yalnız** `--history` dizini; `--out` ile JSON+MD (ikisi de repo-yerel) | **evet: yalnız PageSpeed Insights, GET.** `PAGESPEED_API_KEY` **yoksa/boşsa SIFIR istek**, kayıtlar `NOT_CONNECTED`, geçmişe yazılmaz | anahtar yok → `NOT_CONNECTED` (hata değil); regresyon adayı (alert) | bozuk geçmiş (`HISTORY_CORRUPT`); herhangi bir `ERROR` kaydı; kötü argüman (`--site` yok, `--url` `--site`siz, **başka siteye ait host'lu `--url`**, strateji/sayı geçersiz); **anahtar/token/secret argümanı**; `--history`/`--out` cwd dışı |
| 9 | `change-eval <proposal.json> [--registry path] [--ledger file] [--kill-switch path] [--allow-absent-kill-switch] [--now iso]` | proposal, ledger, `data/kill-switch.json` (varsayılan) | stdout | yok | yalnız `ALLOW_FOR_REVIEW` (**inceleme içindir, uygulama izni değildir**) | `ALLOW_FOR_REVIEW` dışındaki her karar. **Varsayılan strict:** kill-switch dosyası yoksa `BLOCK_KILL_SWITCH`; dosya bozuksa fail-closed; bilinmeyen site `BLOCK_CROSS_SITE`; girdi yok/bozuk/nesne değil |
| 10 | `change-lint <planned-actions.json> [--registry path]` | eylem listesi | stdout | yok | ihlal yok (**statik tarama**; `$CMD`/base64 ile kurulan komutu görmez) | herhangi bir ihlal (korumalı dala push, deploy, `gh pr merge`, toplu indeksleme isteği, üretim host'una yazma, türü olmayan eylem); girdi yok/bozuk/dizi değil |
| 11 | `scorecard [registry] [--site id] [--json] [--clarity d] [--performance d] [--index d] [--deployments d] [--measure f]` | `<dir>/<site>.json` artifact'ları (varsayılan `data/*-history`, `data/deployment-timeline`) | stdout | yok | kart üretildi; eksik girdi = `UNKNOWN`, `ATTENTION` normal durumdur; tek skor yok | registry geçersiz; site yok; **bozuk (JSON olmayan) artifact**; açıkça verilen yol yok |
| 12 | `orchestration-check [--drift] [--json]` | model + (`--drift`) `.github/workflows/*.yml` | stdout | yok | `ERROR` bulgusu ve drift yok (`WARN`/`INFO` hata değil) | herhangi bir `ERROR` bulgusu ya da drift; `--drift` iken workflow dizini okunamıyor. **Bugün 1** (`DUPLICATE_SCHEDULER`, legacy rutin kapanana kadar) |

**Ortak kurallar (hepsi):** üretim sitesine HTTP yazısı yok; Vercel/GitHub'a yazı yok; yazma yalnız repo-yerel yola ve yalnız `--write`/`--out` ile; secret CLI argümanı değil;
her komut portföy izolasyonunu korur (yabancı site kaydı/probe'u/URL'si/satırı reddedilir); eksik/bozuk girdi sessiz `0`/`OK` üretmez.

**Sınıflar.** *Rapor* komutları (1, 6, 8'in alert'leri, 11, 12'nin WARN'ları): bulgu = çıktı, kırmızı değil; yalnız ölçüm/okuma **hatası** 1 döner.
*Kapı* komutları (2, 4, 7, 9, 10): aday girdiyi doğrular; kabul = 0, her ret = 1, nedeni stdout'ta (ayrı kod icat edilmedi).

**Adlandırma kararları.** `lighthouse` adı verilmedi: modül PSI çağırır, Lighthouse'u kendisi koşmaz → `performance-measure` (`clarity-measure` ile paralel).
`deployment-verify` **ayrılmadı**: canlı SHA probe'u (`LiveProbe`) bu depoda yok; o ad henüz doğrulama yapmayan bir komutta yanlış izlenim verirdi.

**Bilerek bağlanmayanlar:** `verifyDeployment`/`correlate` (canlı probe + metrik değişimi girdisi yok); `advance()` onay durum makinesi ve `parseKillSwitch` (kalıcı kayıt/ledger yazarı yok — bkz. B5);
`attachRow`. Bunlar kütüphane işlevidir; bir komut çıplak çağırırsa "yarım doğrulama" üretirdi.

**Sapmalar (owner'ın bilmesi gereken):**
(1) `--json` yalnız #1, #11, #12'de (bin betikleriyle aynı bayrak; yeni global standart değil).
(2) `--url` tekrarlanabilir (`opt` tekrarı desteklemez) — kendi `flatMap`'i var.
(3) Dosya girdili komutlar `<dosya> [--registry path]` (B kalıbı, `import-health` gibi); registry odaklı olanlar `[registry]` (A kalıbı).
(4) `bin/clarity-takeover-status.ts` ve `bin/scorecard.ts` **kaldırılmadı**; iki giriş noktası zamanla ayrışabilir → ince sarmalayıcıya çevrilmesi önerilir (ayrı iş, K3).
(5) Yazma hedefleri cwd ile sınırlı: Actions'ta cwd = depo kökü olduğundan workflow'lar etkilenmez; depo dışına yazmak isteyen bir kullanım bilerek desteklenmez.

---

## 3. Merge durumu

Hepsi **MERGE EDİLDİ** (`origin/main` = `a2c8700`): #31 clarity takeover status, #32 deployment timeline, #33 content pipeline, #34 index alarms, #35 agent contracts,
#36 performance (PSI), #37 change safety, #38 orchestration + scorecard, #40, #41 (`sgos.measure-report.v1`, `measure` komutuna `--json`/rapor çıktısı eklendi; bu çalışma `measure` case'ine **dokunmadı**).
Ön koşul kalmadı: bağlama PR'ı doğrudan `origin/main` üstündedir; yama uygulama sırası/uyarısı gerekmez.

---

## 4. Yama (`docs/integration/cli-wiring.patch`) — SUPERSEDED, silindi

Yama artık yoktur; gerçek uygulama `src/cli.ts`'tedir. Eski yamanın kapsamı (`src/cli.ts` +214 satır, 13 test) bu uygulamada aşıldı. Testler (yanlış pozitif **ve** yanlış negatif, depo kuralı):
`tests/cli-wiring.test.ts` her komut için `--help`, mutlu yol, eksik girdi, bozuk girdi ve yanlış site durumunu **gerçek child process**'te, gecici sandbox dizininde (cwd) koşar;
her koşu fetch + ham soket yasaklayan bir preload'la çalışır (`tests/fixtures/cli-wiring/no-network.mjs`), ağ denenirse test düşer. `performance-measure` için sahte PSI
(`mock-psi.mjs`): anahtar çıktıda/dosyada hiçbir yerde görünmez. Testler gerçek deponun `data/`'sına yazmaz (yalnız `data/clarity-history` ve `.github/workflows` **okunur**).

---

## 5. Entegrasyon bulguları

**B1 — ÇÖZÜLDÜ (#38).** Scorecard artık üreticilerin gerçek yazdığı şekli okuyor (`snapshots[]`, `site`, `retrieved_at`…). Doğrulandı (FACT, bu oturum): üretici fixture'ları
(`tests/fixtures/scorecard-contracts/*`) `<dir>/pamistanbul.json` olarak verilince `scorecard` `index_health` = ATTENTION, `performance` = ATTENTION, `deployment_change` = OK (VERIFIED production deploy),
`search_opportunity` = ATTENTION üretir; artık `UNKNOWN` ile kör kalmaz. Sözleşme testi: `tests/scorecard-contract.test.ts`. (Eski sürümde bu boyutların ikisi görünmezdi.)

**B2 — `orchestration-check` bugün kırmızı ve bu doğru.** `DUPLICATE_SCHEDULER` (ERROR): `clarity-daily` (GATED) + legacy rutin (ACTIVE) aynı Clarity havuzunda. Legacy `DISABLED` olunca söner.
Bu komutu **zorunlu CI kapısı yapma**; workflow'da `continue-on-error: true` ile bilgi olarak koş, legacy kapanınca kaldır (`workflow-architecture.md`).

**B3 — İki mevcut test, yeni workflow'lar için bilinçli güncelleme ister** (workflow PR'ında): `tests/index-candidates.test.ts` (`index-probe.yml`'de `schedule` YOK) → indeks alarmı **yeni bir workflow**'dadır;
`tests/orchestration.test.ts` (yeni katmanlar `PLANNED`) → her workflow PR'ı yalnız kendi işinin durumunu çevirir. `orchestration.ts` modeli her workflow değişikliğiyle **aynı PR'da** güncellenmeli (drift testi).

**B4 — ÇÖZÜLDÜ (#31).** Takeover kanıtı ayrı bir koşu kaydı değil, history kayıtlarındaki mevcut `source_run_id` alanıdır (`clarity-daily` zaten yazıyor). `clarity-takeover-status` bu yüzden
`--runs` seçeneği **taşımaz**; yeni bir koşu-kaydı dosyası da yoktur. Kanıt kaynağı çıktıda `history.source_run_id` olarak yazılır. (Eski "koşu kaydı üreticisi yok" bulgusu tarihseldir; geçersiz.)

**B5 — Değişiklik ledger'ının yazarı yok (AÇIK).** `change-eval --ledger` bir dosya bekler; onaylanan/uygulanan değişiklikleri o dosyaya yazan hiçbir şey yok. Bütçe kontrolü yalnız verilen dosya kadar doğrudur
(yanlış negatif riski: boş ledger = bütçe dolu değil). Yazma yolu olmadığı sürece sonuç yalnız bilgi.

**B6 — Bu uygulamada kapatılan boşluklar (gerçek koşularla bulundu).** (a) `scorecard` JSON'u bozuk bir artifact'ı "dosya yok" sayıp `UNKNOWN`'a düşürüyordu (güvenli ama yanıltıcı sebep) → CLI artık bozuk dosyayı `bozuk girdi` ile reddeder.
(b) `content-classify` satırların site alanına bakmıyordu; karışık siteli satırlar tek havuzda sınıflanırdı (kural 3) → tek-site + kayıtlı-site zorunlu. (c) `clarity-takeover-status` bozuk site geçmişini raporlayıp exit 0 veriyordu → exit 1.
(d) Boş/`null` satır ve nesne olmayan kayıtlar yığın izi/yanıltıcı mesaj üretiyordu → tek satır hata. (e) `performance-measure` yabancı host'lu `--url`'yi rapora yazıp exit 0 veriyordu → exit 1.
(f) Yazma hedefi sınırsızdı → repo-yerel kapısı.

---

## 6. Yapılmayanlar (bilerek)

- Üretim sitesine/Vercel'e/GitHub'a yazan, deploy eden, toplu indeksleme isteyen, `robots`/canonical/hreflang/structured data uygulayan **hiçbir komut**.
- Canlı SHA probe'u (`deployment-verify`): sitede meta/header açılması site sahibiyle karar ister.
- `measure` çıktısını `GscRow`'a çeviren adaptör ve `sites/<site>/drafts/` sözleşmesi (içerik hattı şu an elle/CLI).
- `package.json` script'leri, `README`/`CLAUDE.md` komut listesi ve test sayısı: bu PR'da **güncellenmedi** (CLAUDE.md/DEVAM.md başka işin kapsamında); owner günceller.

---

## 7. Doğrulama kaydı (2026-10-02)

1. `origin/main` (`a2c8700`) `claude/sprint-integration-plan` içine merge edildi (merge commit, rebase/force yok); eski yama `git apply` ile temiz uygulandı, ardından iyileştirildi.
2. `npm run typecheck` temiz; `npm test`: **840 test, 0 skip**; `tests/cli-wiring.test.ts` 37/37 geçer. Tek kırmızı test bu çalışmadan bağımsızdır: `tests/change-safety.test.ts` "B gercek dosyadan…" (zaman bombası: `ARM.expires_at = 2026-10-02T12:00Z` sabit, test ise `readKillSwitch`'in duvar saatini `now` olarak kullanıyor; 12:00 UTC sonrası düşer). Bu PR'a ait değil; ayrı düzeltme ister (sabit saat enjekte et).
3. Komutlar gerçek koşuldu (sandbox cwd): bozuk/eksik/yanlış-site girdilerinde yığın izi yok, deterministik 0/1.
4. Ağ: yalnız `performance-measure`; anahtar yokken sıfır istek **test ile** kanıtlandı (fetch + ham soket yasağı preload'u). **Canlı API çağrısı yapılmadı** (PSI, GSC, GA4, Clarity yok), workflow dispatch yok.

## 8. Owner kararları (açık)

| # | Karar | Varsayılan önerim |
|---|---|---|
| K2 | `--json` yeni komutlarda kalsın mı (sapma 1)? | Kalsın |
| K3 | `bin/*.ts` sarmalayıcıya çevrilsin mi (sapma 4)? | Evet, ayrı iş |
| K4 | `change-eval` kill-switch dosyası yokken engellesin mi (strict)? | Evet (uygulandı; `--allow-absent-kill-switch` yalnız deneme). Depoda `data/kill-switch.json` bilerek yok |
| K5 | Yazma hedefleri cwd ile sınırlı kalsın mı (sapma 5)? | Kalsın |
