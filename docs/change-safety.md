# Change safety v1

Bu surumde **uretim yazma yolu yoktur**. `src/change-safety.ts` yalnizca "bir degisiklik, yazma yoluna girmeden once
hangi kapilardan gecmeli" sorusunu cevaplar. Her karar fail-closed: belirsizlik engeldir. Neden: yanlis pozitif
insana sorulur, yanlis negatif uretimde yasar (CLAUDE.md kural 6).

Bu modul su an hicbir yere bagli degil (`cli.ts` degismedi); baglanti notlari en altta.

## 1. Degisiklik butcesi

Site basina, **rolling 7 gunluk** pencerede sinif bazinda tavan. Birim = benzersiz hedef URL sayisi.

| Sinif | Varsayilan | Not |
|---|---|---|
| content | 5 | |
| internal_link | 20 | |
| sitemap | 1 | |
| robots, canonical, hreflang, redirect, schema (structured data) | **0** | Her zaman insan onayli. Kod bu tavani **yukseltemez**: `budgets` override'i bu siniflar icin yok sayilir. |

Rakamlar bir olcum degil, muhafazakar bir baslangic politikasidir; sahibi `options.budgets` ile site bazinda ayarlar
(negatif/NaN = 0). Defterde okunamayan ya da gelecekteki tarihli kayit pencerede **sayilir** (eksik saymak butceyi sisirir).

`evaluate(proposal, ledger, {registry, killSwitch, now, budgets?})` sirasiyla:

1. `BLOCK_KILL_SWITCH`: kill-switch engaged (proposal'dan once bakilir).
2. `REJECT_INVALID_PROPOSAL`: rollback eksik, etiket `RECOMMENDATION` degil, bilinmeyen sinif, bos hedef, site onboard degil.
   (Spec'teki bes karara eklenen tek sonuc; "reddedilir" ifadesinin karsiligi.)
3. `BLOCK_CROSS_SITE`: hedef/varlik sitenin kayitli alanlarinin disinda.
4. `BLOCK_HIGH_RISK_NEEDS_OWNER`: butce-0 sinif.
5. `BLOCK_OVER_BUDGET`.
6. `ALLOW_FOR_REVIEW`: **yalniz inceleme icin**, uygulama izni degil.

## 2. Rollback sozlesmesi

Her proposal su uc alani tasir; biri eksikse ya da dolgu ise (`TODO`, `n/a`, `-`, 3 karakterden kisa) proposal reddedilir:

```json
{ "method": "git_revert", "revert_ref": "commit abc1234 veya config anahtari", "verification_probe": "geri almadan sonra ne olculur" }
```

- `method`: nasil geri alinir (git_revert, config_revert, manual_restore ...).
- `revert_ref`: geri alinacak sey (commit/PR/config degeri). `policies/change-management.md`: "tam geri alma".
- `verification_probe`: geri almanin isledigini kanitlayan olcum (or. durum kodu + canonical ayni).

## 3. Kill-switch

Dosya: `data/kill-switch.json`, `schema: "sgos.kill-switch.v1"`. **Depoda varsayilan dosya yoktur** (sessizce
"kapali" bir dosya uretmiyoruz). Ornek: `schemas/kill-switch.example.json`; kullanmak icin `data/kill-switch.json` olarak kopyalanir.

```json
{ "schema": "sgos.kill-switch.v1",
  "global": { "engaged": false },
  "sites": { "spryhand": { "engaged": true, "reason": "neden" } } }
```

- `global.engaged: true` tum siteleri, `sites.<id>.engaged: true` yalniz o siteyi durdurur.
- Okuma **fail-closed**: okunamayan dosya, bozuk JSON, yanlis `schema`, boolean olmayan `engaged` (`"false"` dahil),
  eksik `global`, `knownSiteIds` verilmisse bilinmeyen site anahtari (yazim hatasi) => **engaged**.
- Dosya **yoksa** (ENOENT) engaged degildir ama `source: "ABSENT"` olarak gorunur; `{strict: true}` bunu da engaged yapar.
  Bu yalniz Yol A icin kabul edilebilir; Yol B (bolum 7) ABSENT'i her zaman engeller, `strict` secimine birakilmaz.
- Engaged iken `evaluate` `BLOCK_KILL_SWITCH` doner ve `advance` hicbir gecise izin vermez (yarim kalan degisiklik donar).

## 4. Onay durum makinesi

`PROPOSED -> REVIEW_REQUIRED -> OWNER_APPROVED -> MERGED -> DEPLOYED -> VERIFIED`. Yalniz tek adim ileri; atlama ve geri yok.

- `REVIEW_REQUIRED`: `evaluate` sonucu `ALLOW_FOR_REVIEW` ya da `BLOCK_HIGH_RISK_NEEDS_OWNER` olmali (yuksek riskli sinif
  insan incelemesine girebilir; otomatik serit degil). Diger bloklar giremez.
- `OWNER_APPROVED`: tek yol, cagiranin verdigi acik `approver {name, approved_at, channel}`. Kod bunu hicbir zaman
  uretmez/cikarmaz. Otomasyon kimlikleri (`bot`, `claude`, `agent`, `system`...) ve oneren kisinin kendisi onaylayamaz.
- `MERGED / DEPLOYED / VERIFIED`: anlamli bir `ref` (PR, deploy kimligi, probe sonucu) ister. Bu gecisler yalniz **kayit** tutar;
  merge/deploy'u yapan bir sey yoktur.

## 5. Cross-site guard

Hedef URL'ler sitenin `production_domain`, `canonical_hostname` ve `known_subdomains` host'larindan biri olmali; goreli yol (`/x`) gecer.
Kayitsiz alt alan adi, lookalike (`site.com.evil.io`), userinfo hilesi (`site.com@evil.com`), `//host`, `javascript:`/`ftp:` ve
ayristirilamayan hedef engellenir. `entities` baska sitenin `brand_entities`/`people_entities` listesindeyse engellenir
(`policies/portfolio-isolation.md`). Bilinmeyen site de engellenir.

## 6. Uretim mutasyonu lint'i

`lintPlannedActions(actions, {productionHosts?})` planlanan eylemleri tarar ve su dogrudan yazmalari reddeder:
korumali dala (`main/master/production/prod/release/*`) push (refspec, `+`, `--all/--mirror`, hedefsiz `git push` dahil),
deploy (`vercel`, `netlify`, `wrangler`, `firebase`, `fly`), `gh pr merge`, Google Indexing API, IndexNow/sitemap ping ve
coklu URL indeksleme istegi, `productionHosts` host'larina GET/HEAD/OPTIONS disi HTTP istegi. Taninmayan eylem turu reddedilir.

Komut taramasi tirnak duyarlidir (`git commit -m "vercel --prod"` temiz) ve `bash -c "..."`, `sudo`, `npx`, `VAR=x` onlerini acar.
Sinir: bu bir **statik** tarayicidir; degiskenle/kodlanmis kurulan komutlari (`$CMD`, base64) goremez. Gercek koruma yazma yolunun
bu surumde hic olmamasi ve branch protection'dir; lint ikinci kattir.

## 7. Iki yol: A (okuma/oneri) ve B (uretim mutasyonu)

Kill-switch dosyasi yoksa (`ABSENT`) bugun engaged degildir; bu **yalniz Yol A** icin kabul edilebilir. Gelecekteki
bir uretim yazicisi asla "fail-open" olmamali; bu yuzden iki yol kodda ayridir (`src/change-safety.ts` bolum 8).

```
                      kill-switch durumu
                 ┌────────────┴─────────────┐
   Yol A: READ_ONLY_RECOMMENDATION      Yol B: PRODUCTION_MUTATION
   (rapor, taslak, PR onerisi)          (hayali uretim yazici)
   checkReadOnlyRecommendation()        authorizeProductionMutation()
   ABSENT / UNKNOWN: tolere edilir      ABSENT / UNKNOWN / okunamaz / bozuk / bayat: BLOCKED
   engaged: DURUR                       engaged: BLOCKED
                                        + 7 kapinin HEPSI gecmeli (opt-out bayragi YOK):
                                          1 kill_switch  acikca okundu (source=FILE), acikca kapali,
                                                         bu site icin, taze (<= 5 dk; yalniz daha siki yapilabilir)
                                          2 armed        insan arm'i: armed_by + armed_at + scope.expires_at,
                                                         omur <= 24 saat, otomasyon kimligi olamaz
                                          3 arm_scope    arm.site_id ve change_class proposal ile ayni
                                          4 approval     ChangeRecord OWNER_APPROVED + gecerli approver
                                          5 rollback     validateRollback temiz
                                          6 proposal/budget  evaluate temiz; butce-0 siniflar (robots,
                                                         canonical, hreflang, redirect, schema) HIC gecmez
                                          7 lint         lintPlannedActions temiz ve liste bos degil
                                        sonuc: AUTHORIZED_FOR_HUMAN_EXECUTION | BLOCKED
```

- Tum kapilar degerlendirilir (kisa devre yok); `BLOCKED` sonucu basarisiz her kapiyi sebepleriyle listeler.
  Herhangi bir istisna fail-closed `BLOCKED` olur, asla throw ya da yetki degil.
- **Arm'i bu modul uretmez.** `ArmToken` yalniz bir tip ve dogrulayicidir; kurucu, varsayilan ya da cikarim yoktur.
  Arm verisi insandan gelir; suresi dolar, baska site/sinifa tasinamaz, belirsiz sure verilemez.
- **Tip sozlesmesi:** basarili karar `ProductionMutationAuthorization` tasir (marka'li tip, dondurulmus, modul-ici
  `WeakSet` ile calisma zamaninda da dogrulanir). Hayali bir yazici `(auth: ProductionMutationAuthorization)` ister ve
  ilk satirda `requireAuthorization(auth)` cagirir; sahte ya da kopyalanmis nesne tip denetiminde ve calisma zamaninda reddedilir.
- Basari **uygulama degildir**: `AUTHORIZED_FOR_HUMAN_EXECUTION` yalniz bir insanin yurutmesi icin yetkidir. Bu repoda
  yazici, ag cagrisi ya da dosya yazimi yoktur ve `data/kill-switch.json` uretilmemistir.
- `KillSwitchState`'e iki opsiyonel alan eklendi: `site_id` (parse eder) ve `read_at` (`readKillSwitch` doldurur).
  Elle kurulmus durumda `read_at` yoksa Yol B bunu bayat sayar.

### Sinirlar

- `read_at`/`site_id` cagiranin verdigi nesnede taklit edilebilir; tip markasi ve WeakSet yalniz bu modulun disindan
  sahte yetki uretmeyi zorlastirir, bir saldirgan koduna karsi kriptografik garanti degildir. Gercek koruma yazma yolunun
  olmamasi ve branch protection'dir.
- Butce-0 siniflar Yol B'den gecmez (muhafazakar tercih); onlarin yolu insan state machine + PR'dir.
- Arm'in kendisinin nasil saklanip imzalandigi (dosya, imza) bu PR'in kapsami disindadir.

## Baglanti icin gerekenler (bu PR'da yok)

- `cli.ts`: `change-eval` komutu (proposal JSON + ledger -> `Evaluation`), `readKillSwitch(data/kill-switch.json, site, {knownSiteIds, strict: true})`.
- Ledger icin kalici bir depo (su an yalniz parametre).
- Yazma yolu eklenirse: her yazmadan once `lintPlannedActions` + `advance` durum kontrolu + kill-switch.
