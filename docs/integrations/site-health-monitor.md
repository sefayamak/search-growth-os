# site-health-monitor → Search Growth OS: sınır sözleşmesi

Durum: **Phase 1** (2026-10-01). `search-growth-os` canonical sistemdir;
`site-health-monitor` (shm) ondan ayrı çalışan günlük izleme rutinidir ve **çalışmaya devam eder**.

## Sınır

```
shm rutini ──yazar──▶ snapshot DİZİNİ (history/, cache/, alerts/)
                              │   (nereden geldiği bu sistemin bilgisi değil:
                              │    git clone, artifact, elle kopya)
                              ▼
        src/adapters/site-health-import.ts   salt-okunur doğrulayıcı
                              ▼
        sites/<id>/health-import.json        yalnız --write ile, site başına
```

- Importer **yerel bir dizin** okur. Ağ, git, token, belirli bir repo adresi yok; Phase 1'de
  yeni bir GitHub token'ı ya da private-repo erişimi gerekmez. (`tests/site-health-import.test.ts`
  bunu kaynak metni tarayarak zorlar.)
- shm'nin Python kodu bu depoya **kopyalanmadı**. Bu sistem shm'yi çalıştırmaz, değiştirmez,
  ona yazmaz.

## Ne doğrulanır — "veri yok ≠ sıfır"

| Durum | Sonuç |
|---|---|
| Ham yanıt (cache) başarısız (`status: null` / ≠200) | `UNKNOWN`, metrik yok (sıfır bile değil) |
| Tamamı sıfır satır ve kanıtlayan cache yok | `UNKNOWN` |
| Tamamı sıfır satır, tüm çağrılar 200 | `MEASURED`, sıfır, `CONFIRMED` |
| Sıfır olmayan satır, cache yok | `MEASURED`, `CANDIDATE` (tek başına history satırı) |
| Aynı tarih için aynı satırlar | tek kayda iner (`duplicates_collapsed`) |
| Aynı tarih için **farklı** satırlar | `UNKNOWN`, hiçbiri seçilmez |
| GSC ham yanıtı 200 satıra ulaştı | `MEASURED` ama `totals_complete: false`, `CANDIDATE` (toplam alt sınır) |

Her kayıt `label: FACT` taşır; `UNKNOWN` kayıt asla `CONFIRMED` olmaz.

**Gerçek örnek (2026-09-28):** shm, 7 sitenin 7'sinde Clarity'ye erişemedi ama history'ye sıfır
satır yazdı; pamistanbul ve spryhand için aynı güne iki farklı satır da var. İkisi de
`UNKNOWN` olarak içeri alınır. Fixture: `tests/fixtures/site-health/`.

## Site izolasyonu

Yalnızca registry'de kayıtlı domain'lerin dosyaları açılır; kayıtsız domain
`rejectedDomains`'te görünür ama hiçbir yere karışmaz. `sites/<id>/health-import.json`'a
yalnız o sitenin kaydı yazılabilir (`writeSiteStore` yabancı kaydı reddeder).

## Idempotency

`mergeRecords`: aynı snapshot'ı iki kez almak dosyayı bayt-bayt değiştirmez. Bir ölçüm asla
`UNKNOWN`'a düşürülmez (`refusedDowngrade`); iki farklı ölçüm üst üste yazılmaz (`conflicts`,
eskisi korunur, insan bakar).

## Kullanım

```bash
node --experimental-strip-types src/cli.ts import-health <snapshotDir>           # yazmaz, raporlar
node --experimental-strip-types src/cli.ts import-health <snapshotDir> --write   # sites/<id>/health-import.json
```

## Phase 2'ye bırakılanlar

Clarity client'ı (sgos tarafında), shm'nin OAuth GSC yolunun emekliliği, shm rutininin
kendisinin kapatılması/arşivlenmesi, deploy geçmişi adapter'ı. Hiçbiri Phase 1'de yapılmadı.
