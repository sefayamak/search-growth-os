# Clarity takeover durum değerlendiricisi (offline)

`src/clarity-takeover-status.ts` — commit'li `data/clarity-history/*.json` dosyalarından takeover zincirinin nerede olduğunu
hesaplar. **Ağ yok, Clarity API çağrısı yok, secret yok, workflow tetiklemesi yok.** Hiçbir şeye yazmaz; yalnız rapor üretir.

```bash
node --experimental-strip-types bin/clarity-takeover-status.ts            # markdown
node --experimental-strip-types bin/clarity-takeover-status.ts --json     # JSON
node --experimental-strip-types bin/clarity-takeover-status.ts config/sites.yaml --history data/clarity-history
```

Siteler `config/sites.yaml` registry'sinden gelir (7). Her site yalnız kendi history dosyasından okunur; bozuk bir dosya
yalnız kendi sitesini düşürür (`site_problems`), başka siteyi etkilemez.

## Kanonik kanıt kaynağı: history kaydındaki `source_run_id`

Takeover başarısı iki şeydir: (1) 7/7 `measurement_success`; (2) o koşuda 7/7 **taze** ölçüm. Aynı-gün guard'ı ile atlanan site
önceki ölçümden miras kalır. Tek bir kaynak seçildi: `clarity-daily`'nin her `DailyRecord`'a zaten yazdığı `source_run_id`
(`cli.ts`: `GITHUB_RUN_ID` → `toRecord`). 2026-10-02 kayıtlarının yedisinde de var.

| Seçenek | Karar | Neden |
|---|---|---|
| **History `source_run_id`** | **SEÇİLDİ** | Zaten üretiliyor ve commit'te; tek yazar (clarity-daily'nin mevcut commit adımı); secret yok; sandbox'ta okunur; workflow değişikliği gerekmez. Guard atlanan site yazılmaz, kaydı eski koşunun id'sini taşır → taze/miras kayıt düzeyinde ayırt edilir |
| GitHub Actions run metadata | Kod kaynağı DEĞİL | Sandbox artifact/run API'sine ulaşamaz; elle yapıştırılan JSON ikinci, doğrulanamaz kaynak olur. Owner'ın elle çapraz kontrolü olarak kalır (aşağıda) |
| clarity-daily çıktısı (`clarity-alerts.json`, artifact) | Reddedildi | Artifact 30 gün yaşar, sandbox indiremez, commit'li değil |
| Ayrı doğrulama defteri (`data/clarity-validation/ledger.json`) | Reddedildi | İkinci yazar + yeni commit yolu (workflow değişikliği), history ile ayrışabilir; history zaten aynı bilgiyi taşıyor |

Eski "koşu kaydı JSON'u" (`--runs`) kaldırıldı: hiçbir şey üretmiyordu ve ikinci kaynak olurdu.

### Kural (UTC gün başına tek giriş)

- **Taze 7/7** ⇔ o günün 7 kaydının hepsi `measurement_success` **ve** hepsi aynı `source_run_id`'yi taşır. Bir koşu yalnız
  kendi ölçtüğünü kendi id'siyle yazar; ilk-başarı-kazanır kuralı id'yi korur (`--force` mevcut başarılı kaydı değiştirmez).
- **Guard atlama sayısı (gözlenen)** = en son (en büyük) run id'yi **taşımayan** başarılı kayıt sayısı. **Alt sınırdır**: hiçbir
  kayıt yazmayan (7'sini de atlayan) koşu history'de görünmez. Herhangi bir kayıtta id yoksa `UNKNOWN`.
- **Kayıtta id yoksa** (eski kayıt, yerel/Actions dışı koşu) tazelik `UNKNOWN`, gün en fazla `COVERAGE_VALIDATION_SUCCESS`.
- Gün raporu hangi koşunun kaç site yazdığını (`runs`) gösterir; FULL günde ortak id `qualifying_run_id`'dir.

### Forgery direnci (kısmi; commit'li dosya elle düzenlenebilir)

Şu tutarsızlıklar 7/7 başarılı günü `INCONSISTENT` yapar ve hiçbir başarı iddia edilmez (zincir kırılır):

1. Aynı run id iki farklı UTC günde kayıt yazmış (bir koşu tek gün; 2_OF_2'nin iki ayrı koşu istemesini de korur).
2. Aynı run id'nin kayıtları workflow timeout'undan (15 dk) uzun aralığa yayılmış (yeniden deneme / rerun / elle düzenleme belirtisi;
   `GITHUB_RUN_ID` rerun'da aynı kalır, bu yüzden bilerek konservatif).
3. Run id tarihle ters: eski günün id'si yeni günün id'sinden büyük ya da eşit (Actions run id'leri zamanla artar; sayısal karşılaştırma).

**Sınır:** bu kontroller kaba/kazara tutarsızlığı yakalar; kendi içinde tutarlı uydurma bir history'yi tek başına engelleyemez.
Legacy'yi kapatma kararından önce owner, FULL günlerin `qualifying_run_id` değerini Actions arayüzünde elle doğrulamalıdır
(Run workflow: başarılı, `main`, o UTC gün, 7 satır `MEASURED`); bu araç bunu kodla yapmaz.

### Üretici tarafı ve workflow

- `src/clarity-daily.ts` (main'de var olan dosya) yalnız şunu kazandı: `source_run_id` **varsa** `^\d{1,20}$` olmalı, değilse geçmiş
  dosyası bozuk sayılır. Alan opsiyoneldir; id'siz eski kayıtlar aynen okunur. Same-day-guard, first-success-wins, `toRecord`,
  `mergeRecord` değişmedi.
- **Workflow değişikliği GEREKMİYOR**: `GITHUB_RUN_ID` Actions'ta otomatik tanımlıdır ve `clarity-daily` adımı zaten
  `process.env`'den okur.
- **İsteğe bağlı (owner onayıyla, ayrı PR)**: `clarity-daily.yml`'deki "Gecmisi main'e yaz" adımının commit mesajına koşu kimliğini
  eklemek (tek satır: mesaj dizgisine ` run ${GITHUB_RUN_ID}`). Commit geçmişinde ikinci bir göz sağlar; zorunlu değildir.
  Bu PR `.github/workflows/*.yml` dosyalarına dokunmaz.

## Gün durumları (UTC gün başına tek giriş)

| Durum | Anlamı |
|---|---|
| `FULL_TAKEOVER_SUCCESS` | 7/7 `measurement_success` **ve** 7 kaydın hepsi aynı `source_run_id`'yi taşıyor (7/7 taze) ve çapraz kontroller temiz |
| `COVERAGE_VALIDATION_SUCCESS` | 7/7 `measurement_success` var, ama taze 7/7 değil (`NOT_FULL`: kayıtlar farklı koşulardan) ya da bilinmiyor (`UNKNOWN`: id'siz kayıt) |
| `NOT_SUCCESS` | O gün 7/7 `measurement_success` yok (eksik kayıt de başarı sayılmaz) |
| `INCONSISTENT` | 7/7 başarılı ama run id kanıtları çelişiyor (yukarıdaki üç kontrol); hiçbir başarı iddia edilmez |

## Zincir durumu

`NONE` | `FULL_TAKEOVER_1_OF_2` | `FULL_TAKEOVER_2_OF_2`.

- Belge: "İki ardışık tam takeover doğrulaması: her biri 7/7 `measurement_success=true` ve bu koşuda 7/7 taze ölçüm."
- **İki FARKLI UTC gün** gerekir; aynı günde iki tam koşu tek sayılır (`1_OF_2`). Aynı run id iki günde görünürse `INCONSISTENT`.
- Yorum (belge takvim bitişikliğini açıkça istemez): *ardışık* = doğrulamalar dizisinde araya giren olmaması. Değerlendirilen
  günler arasına giren, FULL olmayan bir gün zinciri **kırar**. Veri olmayan takvim günleri gün sayılmaz; aradaki boşluk raporda
  not düşülür. Bu yorum owner'ın daha katı (takvim bitişik) bir kural istemesi hâlinde tek yerden (`evaluateTakeover` içindeki
  zincir döngüsü) değiştirilir.
- Zincir **sondan geriye** sayılır: son değerlendirilen gün FULL değilse durum `NONE`.

Mevcut commit'li history (yalnız 2026-10-02) için sonuç: gün `COVERAGE_VALIDATION_SUCCESS`, tazelik `NOT_FULL` (6 site koşu
36983089184'ten, pamistanbul 36978486153'ten miras), guard atlama 1, zincir `NONE`. Bu, `DEVAM.md` ile uyumlu (PAM taze ölçülmedi).
Yani bir sonraki FULL gün için kaynak koşunun 7 siteyi tek koşuda ölçmesi gerekir; o gün zaten kısmi (miras) kayıtla başladıysa
FULL olamaz, ertesi UTC gün beklenir.

## Owner adımları

Dört adım **her zaman** `OWNER_ACTION_PENDING` raporlanır: `legacy_disable`, `credential_rotation`, `flag_set`,
`first_scheduled_verification`. Kod bunları ne "yapıldı" işaretler ne de başka verilerden çıkarım yapar; `legacy_takeover_complete`
alanı sabit `false`'tur. Tamamlandığını yalnız owner beyanı ve belge günceli söyler.

## Doğrulama owner'ın Mac'i olmadan yapılabilir mi?

**Evet, ölçüm kısmı yapılabilir.** `.github/workflows/clarity-daily.yml` içinde doğrulandı (2026-10-02):

- `workflow_dispatch` işi tamamen GitHub Actions üzerinde (`ubuntu-latest`) koşar: checkout, Node 24, `clarity-daily` CLI, step summary,
  artifact. Kullanıcı makinesinden hiçbir şey gerekmez. Elle başlatma `SEARCH_GROWTH_CLARITY_DAILY_ENABLED` bayrağına bağlı değildir.
- Geçmiş commit'i yalnız `github.ref == refs/heads/main` iken yapılır; yani koşu `main` üzerinde başlatılmalıdır
  (aksi hâlde kayıt commit'lenmez ve bu araç için kanıt oluşmaz).

Owner'ın (veya yetkili bir yolun) gerektiği yerler:

| Şey | Kim |
|---|---|
| Workflow'u başlatmak (Run workflow) | Owner tarayıcıdan/telefondan (Mac gerekmez); ya da ilgili yetkiyle bir ajan oturumu `workflow_dispatch` tetikler |
| Secret yazmak/rotasyon (`SEARCH_GROWTH_CLARITY_TOKENS_JSON`) | Yalnız owner |
| Legacy routine'i kapatmak | Yalnız owner |
| `SEARCH_GROWTH_CLARITY_DAILY_ENABLED=true` repo değişkeni | Yalnız owner |

Not: Bu araç hiçbirini yapmaz; yalnız commit'li geçmişi okur. İki tam doğrulama için iki ayrı UTC günde, her birinde tek koşuda 7/7
taze ölçüm gerekir (kota: site başına 3 istek/gün). Aynı UTC günde ikinci elle koşu, atlanan sitelerin ölçümünü değil yalnız
eksik/başarısız siteleri ölçer; bu da o günü FULL yapmaz.
