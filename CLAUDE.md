# Search Growth OS — devralma notu

**Bu depoyu açtıysan önce [`DEVAM.md`](DEVAM.md) oku.** İşin nerede bırakıldığı,
açık PR'lar, verilmiş kararlar ve sıradaki tek adım orada.

Sefa Yamak'ın yedi web sitesi için SEO / AEO / GEO ölçüm ve öneri sistemi.
Türkçe konuş; teknik terimler İngilizce kalabilir. Laf kalabalığı yok, sonuçla başla.

---

## Bu ne, ne değil

**Ne:** ölçen bir sistem. Siteleri salt-okunur tarar, kanıt üretir, öneri sunar.

**Ne değil:** otomatik yayıncı. Hiçbir üretim sitesine doğrudan yazmaz. Her
değişiklik PR olarak gelir, insan merge eder.

Yedi site: pamistanbul (pilot), pamaistudio, spryhand, decideplan, rightlisted,
untitledportraits, myhappymade.

---

## Tartışılmaz kurallar

1. **Ölçülmeyen sayı yazılmaz.** Bağlı olmayan entegrasyon `NOT_CONNECTED`,
   bilinmeyen değer `UNKNOWN`. Tahmini rakam yok.

2. **Her bulgu iki etiket taşır.** Kanıt türü (FACT / INFERENCE / HYPOTHESIS /
   RECOMMENDATION / IMPLEMENTED_CHANGE / VERIFIED_RESULT) ve güven (CONFIRMED /
   CANDIDATE / FALSE_POSITIVE / UNKNOWN). Bir çıkarım, onaylanmış gibi
   raporlanamaz — test bunu zorluyor.

3. **Portföy izolasyonu.** Bir sitenin anahtar kelimesi, rakibi, konusu,
   stratejisi, baseline'ı asla diğerine taşınmaz. Aynı kişinin sahibi olması
   gerekçe değil. Ölçüm her kayıtlı site için yapılabilir; **tavsiye yalnızca
   onboard edilmiş site için** üretilir. Bkz. `policies/portfolio-isolation.md`.

4. **Uydurma istatistik REJECT seviyesi ihlaldir.** Arama hacmi, büyüme yüzdesi,
   sıralama, rakip trafiği — bağlı bir araç üretmediyse yazılmaz.

5. **Resmi doküman > SEO folkloru.** Bir iddia kaynağıyla ve erişim tarihiyle
   yazılır. Kaynağa erişilemediyse bu açıkça belirtilir.

6. **Yanlış negatif, yanlış pozitiften tehlikelidir.** Haksız suçlanan siteye
   itiraz edilir; "sende sorun yok" denen siteye inanılır ve gerçek ölçüm hiç
   yapılmaz. Bir kontrol bir şey bulamadığında, neye baktığını da yazdır.

---

## Çalıştırma

```bash
node --experimental-strip-types src/cli.ts portfolio     # içerik ritmi, 7 site
node --experimental-strip-types src/cli.ts llmstxt       # llms.txt envanteri
node --experimental-strip-types src/cli.ts audit --site pamistanbul --full
node --experimental-strip-types src/cli.ts registry config/sites.yaml
node --experimental-strip-types src/cli.ts compliance <dosya>
npm test        # 65 doğrulama
npm run typecheck
```

Çalışma bağımlılığı yok — sadece Node 24. Yalnız `typescript` ve `@types/node`
geliştirme bağımlılığı var.

Terminalsiz kullanım: GitHub → Actions → **Portfolio content check** veya
**Search audit** → Run workflow. İkisi de haftalık otomatik koşuyor ve hiçbir
secret gerektirmiyor.

---

## Kod yazarken

- Yorumlar **neden** öyle yapıldığını anlatır, ne yapıldığını değil.
- Yeni bir kontrol eklediysen yanlış pozitif **ve** yanlış negatif testini de ekle.
  Bu depodaki her kontrol en az bir kez yanlış çalıştı; hepsi teste bağlandı.
- Bir tarama deseni yazarken iki dili de düşün: Türkçe yılı fiilden önce koyar
  (`2018'de kuruldu`), İngilizce sonra (`founded in 2018`). Tek yön taramak
  iki dilli bir sitenin yarısını sessizce atlar.
- Kelime sınırı ihmal edilmez: `beri` deseni `rehberi` kelimesinin içinde eşleşti
  ve kendi dosyamızda 7 yanlış alarm üretti.

---

## Üretim sitelerine dokunma kuralları

Yapılabilir: salt-okunur tarama, ölçüm, rapor, PR önerisi.

Yapılamaz: doğrudan push, deploy, toplu sayfa üretimi, toplu indeksleme talebi,
`robots.txt` / canonical / hreflang / structured data değişikliğini onaysız
uygulamak.

Bir PR açtıysan **draft** aç ve merge kararını Sefa'ya bırak.
