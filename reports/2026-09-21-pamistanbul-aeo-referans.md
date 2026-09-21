# PAM İstanbul — SEO/AEO/GEO/LLMO referans uygulaması

Ölçüm 2026-09-21, depo kaynağından (804 HTML). Canlı HTTP doğrulaması bu
oturumdan yapılamadı: egress proxy pamistanbul.com ve pamaistudio.com dahil
tüm dış alan adlarını blokluyor. Canlı doğrulama GitHub Actions runner'ından
yapılır; aşağıdaki her satır **dosya düzeyinde** kanıtlanmıştır.

Bu dosya diğer altı siteye uygulanacak yöntemin referansıdır.

## Dört katman

| # | Katman | Soru | pamistanbul |
|---|---|---|---|
| 1 | Erişim | Bot sayfayı alabiliyor mu? | temiz |
| 2 | Kimlik | Sayfa ne hakkında, kim söylüyor? | temiz |
| 3 | Cevap (AEO) | Sayfa bir soruyu alıntılanabilir cevaplıyor mu? | **587 orphan düzeltildi** |
| 4 | Atıf (GEO/LLMO) | Model bu sayfayı kaynak gösterir mi? | **28 yanlış URL çıkarıldı** |

Sıra değişmez: AEO'yu indekslenmeyen sayfada yapamazsın.

## Katman 1–2 — ölçüldü, temiz

| Kontrol | Sonuç |
|---|---|
| title yok / mükerrer | 0 / 0 |
| canonical yok | 0 |
| H1 yok | 2 (ikisi de 301 ile emekliye ayrılmış) |
| JSON-LD bozuk | 0 / 1.741 blok |
| URL tutarlılığı | `cleanUrls: true`, sitemap 726 URL uzantısız |
| hreflang karşılıklı değil | 2 |

## Katman 3 — FAQPage ↔ görünür içerik

Asıl bulgu: **1.501 schema sorusunun 587'si (%39,1) sayfada hiç görünmüyordu.**

`projects/monk.html` örneği belirleyici: sayfanın kendi görünür FAQ'ı var
(4 soru), schema'da tamamen başka 4 soru duruyor. Örtüşme sıfır. Schema
sorusu bozuk Türkçe — makine üretmiş, kimse okumamış.

| | Önce | Sonra |
|---|---|---|
| FAQPage sayfa | 355 | 109 |
| Schema sorusu | 1.501 | 479 |
| Orphan soru | 587 | **0** |
| **Görünür metni değişen dosya** | — | **0 / 261** |

Kural: schema sayfada görünmeyen hiçbir şeyi iddia etmez. Görünür içerik
asla schema yüzünden silinmez.

## Katman 4 — llms.txt

| | Önce | Sonra |
|---|---|---|
| Benzersiz URL | 225 | 71 |
| **Cross-domain canonical URL** | **28** | **0** |
| Markdown link | 173 | 41 |
| Karakter | 50.877 | 10.335 |
| Portfolyo (proje) linki | **0** | 6 |

28 URL, otoritesi pamaistudio.com'a devredilmiş sayfaları işaret ediyordu —
yani model yanlış URL'yi alıntılardı.

## Cross-domain canonical — 74 sayfa, karar: KEEP

Bu bir kusur değil, bilinçli konsolidasyon. Depo bunu zaten koruyor:
`test-repo-integrity.mjs` içinde "cross-domain canonical sayfaya hreflang
eklenirse → FAIL (PR #59 kuralı)".

| Kontrol | Sonuç |
|---|---|
| Toplam | 74 (37 TR + 37 EN) |
| Dil eşleşmesi doğru (TR→TR, EN→EN) | **74 / 74** |
| pamistanbul sitemap'inde | **0 / 74** (doğru) |
| İç link alan (UX rolü var) | **74 / 74** — 54'ü 5+ link |

Hiçbiri REDIRECT CANDIDATE değil: hepsi navigasyonda gerçek rol oynuyor.
Bu sayfalara hreflang EKLENMEZ — canonical'la çelişir.

## İnce içerik — 227 sayfa, karar: KEEP

Kelime sayısı ranking metriği değildir ve `<300 kelime = noindex` gibi bir
kural kurulmadı.

| Sınıf | Adet | Gerekçe |
|---|---|---|
| **KEEP** | **223** | Görsel/video taşıyan gerçek portfolyo sayfası |
| **Zaten çözülmüş** | 2 | `modern-architecture-corporate` — vercel.json'da 301 |
| **Utility** | 2 | 404 sayfaları |

Toplu metin üretilmedi. 223 sayfanın 223'ü özgün görsel taşıyor; eksik olan
kelime değil, zaten yok olan bir şey değil.

## Diğer sitelere taşınabilir araçlar

| Araç | Ne yakalar |
|---|---|
| `tools/audit/faq-schema-parity.mjs` | Schema'da olup sayfada görünmeyen soru |
| `tools/audit/llms-txt-guard.mjs` | llms.txt'te canonical'ı başkasına ait URL, link şişmesi |

İkisi de dizin kuralı ve eşiği dosya başında sabit tutuyor; siteye
hardcode edilmedi.
