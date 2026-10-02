# Clarity takeover durum değerlendiricisi (offline)

`src/clarity-takeover-status.ts` — commit'li `data/clarity-history/*.json` (+ isteğe bağlı koşu kayıtları) dosyalarından
takeover zincirinin nerede olduğunu hesaplar. **Ağ yok, Clarity API çağrısı yok, secret yok, workflow tetiklemesi yok.**
Hiçbir şeye yazmaz; yalnız rapor üretir.

```bash
node --experimental-strip-types bin/clarity-takeover-status.ts                      # markdown
node --experimental-strip-types bin/clarity-takeover-status.ts --json               # JSON
node --experimental-strip-types bin/clarity-takeover-status.ts config/sites.yaml --history data/clarity-history --runs runs.json
```

Siteler `config/sites.yaml` registry'sinden gelir (7). Her site yalnız kendi history dosyasından okunur; bozuk bir dosya
yalnız kendi sitesini düşürür (`site_problems`), başka siteyi etkilemez.

## Neden koşu kaydı gerekiyor

Takeover başarısı iki şeydir:

1. **7/7 `measurement_success`** — history'den okunur.
2. **O koşuda 7/7 taze ölçüm** — yalnız koşu kaydı bilir. Aynı-gün guard'ı ile atlanan site önceki ölçümden miras kalır ve
   history'de taze olandan ayırt edilemez (bkz. `docs/integrations/clarity-daily.md`).

Bu yüzden **koşu kaydı yoksa tazelik `UNKNOWN`'dur ve `FULL_TAKEOVER_SUCCESS` iddia edilmez.** Bu bilinçli: yanlış pozitif,
legacy'yi erken kapatmak demektir.

Koşu kaydı: küçük bir JSON listesi (`--runs`). Her eleman:
`{ "date_utc": "2026-10-02", "run_id": "36983089184", "fresh_measurement_success": 7, "total_sites": 7, "measurement_success": 7 }`.
Geçersiz elemanlar (yanlış `total_sites`, taze > başarılı, tekrar `run_id`, bozuk tarih) atılır ve `run_record_problems`'te
nedeniyle listelenir; sessizce düzeltilmez.

## Gün durumları (UTC gün başına tek giriş)

| Durum | Anlamı |
|---|---|
| `FULL_TAKEOVER_SUCCESS` | History'de 7/7 `measurement_success` **ve** aynı gün bir koşu kaydı 7/7 başarılı + 7/7 taze diyor |
| `COVERAGE_VALIDATION_SUCCESS` | 7/7 `measurement_success` var, ama taze 7/7 değil ya da bilinmiyor (`freshness`: `NOT_FULL` / `UNKNOWN`) |
| `NOT_SUCCESS` | O gün 7/7 `measurement_success` yok (eksik kayıt de başarı sayılmaz) |
| `INCONSISTENT` | Koşu kaydı "7/7" diyor ama history desteklemiyor; hiçbir başarı iddia edilmez |

## Zincir durumu

`NONE` | `FULL_TAKEOVER_1_OF_2` | `FULL_TAKEOVER_2_OF_2`.

- Belge: "İki ardışık tam takeover doğrulaması: her biri 7/7 `measurement_success=true` ve bu koşuda 7/7 taze ölçüm."
- **İki FARKLI UTC gün** gerekir; aynı günde iki tam koşu tek sayılır (`1_OF_2`).
- Yorum (belge takvim bitişikliğini açıkça istemez): *ardışık* = doğrulamalar dizisinde araya giren olmaması. Değerlendirilen
  günler arasına giren, FULL olmayan bir gün (7/7 değil, tazelik bilinmiyor, taze < 7) zinciri **kırar**. Veri olmayan takvim günleri
  gün sayılmaz; aradaki boşluk raporda not düşülür. Bu yorum owner'ın daha katı (takvim bitişik) bir kural istemesi hâlinde
  tek yerden (`evaluateTakeover` içindeki zincir döngüsü) değiştirilir.
- Zincir **sondan geriye** sayılır: son değerlendirilen gün FULL değilse durum `NONE`.

Mevcut commit'li history (yalnız 2026-10-02, koşu kaydı yok) için sonuç: gün `COVERAGE_VALIDATION_SUCCESS`, tazelik `UNKNOWN`,
zincir `NONE`. Bu, `DEVAM.md` ile uyumlu (PAM taze ölçülmedi).

## Owner adımları

Dört adım **her zaman** `OWNER_ACTION_PENDING` raporlanır: `legacy_disable`, `credential_rotation`, `flag_set`,
`first_scheduled_verification`. Kod bunları ne "yapıldı" işaretler ne de başka verilerden çıkarım yapar; `legacy_takeover_complete`
alanı sabit `false`'tur. Tamamlandığını yalnız owner beyanı ve belge günceli söyler.

## Doğrulama owner'ın Mac'i olmadan yapılabilir mi?

**Evet, ölçüm kısmı yapılabilir.** `.github/workflows/clarity-daily.yml` içinde doğrulandı (2026-10-02):

- `workflow_dispatch` işi tamamen GitHub Actions üzerinde (`ubuntu-latest`) koşar: checkout, Node 24, `clarity-daily` CLI, step summary,
  artifact. Kullanıcı makinesinden hiçbir şey gerekmez. Elle başlatma `SEARCH_GROWTH_CLARITY_DAILY_ENABLED` bayrağına bağlı değildir.
- Geçmiş commit'i yalnız `github.ref == refs/heads/main` iken yapılır; yani koşu `main` üzerinde başlatılmalıdır.

Owner'ın (veya yetkili bir yolun) gerektiği yerler:

| Şey | Kim |
|---|---|
| Workflow'u başlatmak (Run workflow) | Owner tarayıcıdan/telefondan (Mac gerekmez); ya da ilgili yetkiyle bir ajan oturumu `workflow_dispatch` tetikler |
| Secret yazmak/rotasyon (`SEARCH_GROWTH_CLARITY_TOKENS_JSON`) | Yalnız owner |
| Legacy routine'i kapatmak | Yalnız owner |
| `SEARCH_GROWTH_CLARITY_DAILY_ENABLED=true` repo değişkeni | Yalnız owner |

Not: Bu araç hiçbirini yapmaz; yalnız commit'li geçmişi okur. İki tam doğrulama için iki ayrı UTC günde, her birinde 7/7 taze
ölçüm veren bir koşu ve ilgili koşu kaydı gerekir (kota: site başına 3 istek/gün).
