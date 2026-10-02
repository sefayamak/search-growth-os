# Clarity günlük geçmiş

Üreten: `clarity-daily` (`.github/workflows/clarity-daily.yml`). Site başına **tek dosya**: `<site_id>.json`, şema `sgos.clarity-history.v1`.

- (site, UTC gün) başına **tek kayıt**. Kullanılabilir kayıt aynı günün ikinci koşusuyla değişmez; kullanılamaz kayıt (hata, eksik, UNKNOWN) kullanılabilir kaydı asla ezmez.
- `UNKNOWN` = ölçülemedi, sıfır değildir. `usable=false` kayıt baz olamaz ve alert üretmez.
- En fazla 120 gün tutulur. **Elle düzenleme**: bozuk dosya sessizce düzeltilmez, koşu kırmızı biter.
- Yalnız ölçüm sayıları vardır; token, ham yanıt, URL listesi yoktur.
