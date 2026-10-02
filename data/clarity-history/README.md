# Clarity günlük geçmiş

Üreten: `clarity-daily` (`.github/workflows/clarity-daily.yml`). Site başına **tek dosya**: `<site_id>.json`, şema `sgos.clarity-history.v1`.

- (site, UTC gün) başına **tek kayıt**. Başarılı ölçüm (`measurement_success`; doğrulanmış sıfır dahil) aynı günün ikinci koşusuyla değişmez; başarısız kayıt (hata, eksik, UNKNOWN) başarılı kaydı asla ezmez.
- `measurement_success` = MEASURED + CONFIRMED + rows_complete (takeover ölçütü). `usable` = measurement_success ve sıfır değil (yalnız baz/alert uygunluğu). Eski kayıtlarda `measurement_success` yoktur, aynı kuraldan türetilir.
- `UNKNOWN` = ölçülemedi, sıfır değildir. `usable=false` kayıt baz olamaz ve alert üretmez (doğrulanmış sıfır dahil; o yine de başarılı bir ölçümdür).
- En fazla 120 gün tutulur. **Elle düzenleme**: bozuk dosya sessizce düzeltilmez, koşu kırmızı biter.
- Yalnız ölçüm sayıları vardır; token, ham yanıt, URL listesi yoktur.
