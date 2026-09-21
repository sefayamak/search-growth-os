# Ofis bilgisayarı — hiçbir şey kurmadan çalışma

İş bilgisayarına Node, git, terminal, klon — **hiçbiri gerekmiyor.** Tarayıcı yeter.

---

## Önce: hangi araç neyi yapıyor

Karışıklığın en sık çıktığı yer burası, o yüzden net olsun:

| Araç | Ne yapıyor | Search Growth OS'i çalıştırır mı |
|---|---|---|
| **GitHub** | Kod burada, ölçümler burada koşuyor (Actions), PR'lar burada | **Evet — ölçümlerin çalıştığı yer burası** |
| **Vercel** | Yedi web sitesini yayına alıyor (pamistanbul.com vb.) | **Hayır, gerek de yok** |
| **claude.ai/code** | Claude Code'un tarayıcı sürümü | Evet — konuşarak çalışmak için |

**Vercel'in bu sistemle ilgisi yok** ve olması gerekmiyor. Vercel bir web sitesi
sunucusu; Search Growth OS ise bir ölçüm aracı — web sayfası değil, arka planda
çalışan bir iş. Vercel'e koymak ne mümkün ne de faydalı.

Vercel'in tek rolü şu: bir PR merge ettiğinde ilgili siteyi otomatik yayına alır.
Onu zaten kendiliğinden yapıyor, senin bir şey yapmana gerek yok.

---

## 1. PR merge etmek (tarayıcı)

1. [pamistanbul-site#89](https://github.com/sefayamak/pamistanbul-site/pull/89) →
   sağ üstte **Ready for review** → aşağıda **Merge pull request**
2. [pamistanbul-site#90](https://github.com/sefayamak/pamistanbul-site/pull/90) → aynısı
3. [pamaistudio#40](https://github.com/sefayamak/pamaistudio/pull/40) → aynısı

Merge eder etmez Vercel siteyi yeniden yayına alır. Birkaç dakika sürer.

---

## 2. Ölçüm çalıştırmak (tarayıcı)

**github.com/sefayamak/search-growth-os → Actions** sekmesi.

### İçerik ritmi + llms.txt envanteri (7 site)

Sol menüden **Portfolio content check (read-only)** → sağda **Run workflow**:

| Alan | Ne yazacaksın |
|---|---|
| site | boş bırak = 7 sitenin hepsi · ya da tek id: `pamistanbul` |
| onboarded_only | `false` |
| sample | `6` |
| delay_ms | `800` |

Yeşil düğmeye bas, 1–2 dakika sürer. Bitince **run'a tıkla → Summary** sekmesinde
tablolar çıkar. Dosya olarak indirmek istersen aynı sayfada **Artifacts**.

### Teknik SEO denetimi (tek site)

**Search audit (read-only)** → Run workflow:

| Alan | Ne yazacaksın |
|---|---|
| site | `pamistanbul` |
| mode | `sample` (hızlı) veya `full` (726 URL, ~12 dk) |
| max_pages | `120` hızlı · `1000` tam |
| delay_ms | `800` |

**İkisi de her pazartesi kendiliğinden çalışıyor** (09:10 ve 09:40, İstanbul).
Sen hiçbir şey yapmasan da haftalık ölçüm birikiyor.

Hiçbiri şifre, anahtar veya kurulum istemiyor — halka açık siteleri ölçmek için
kimlik bilgisi gerekmiyor.

---

## 3. Claude ile konuşmak (tarayıcı)

**claude.ai/code** → repo olarak `sefayamak/search-growth-os` seç → **"devam et"** yaz.

`CLAUDE.md` otomatik yüklenir, oradan `DEVAM.md`'ye gider ve kaldığı yerden sürer.
İş bilgisayarına hiçbir şey kurulmaz; her şey tarayıcıda çalışır.

Söyleyebileceklerin: "siteleri kontrol et", "ne yayınlamalıyım",
"rakip keşfi başlat", "trafik düştü sebebini bul".

---

## 4. Durumu okumak (tarayıcı)

GitHub'da doğrudan açılır, hiçbir şey indirmeden:

| Dosya | Ne anlatıyor |
|---|---|
| [`DEVAM.md`](DEVAM.md) | Nerede kaldık, sıradaki adım, verilmiş kararlar |
| [`reports/2026-09-20-portfolio-cadence-baseline.md`](reports/2026-09-20-portfolio-cadence-baseline.md) | 7 sitenin içerik ritmi |
| [`reports/2026-09-20-llmstxt-portfolio-inventory.md`](reports/2026-09-20-llmstxt-portfolio-inventory.md) | llms.txt envanteri ve kararı |
| [`policies/references/llms-txt.md`](policies/references/llms-txt.md) | llms.txt araştırması, tarihli kaynaklar |

---

## Terminal ne zaman gerekir

Yalnızca **kod değiştirirken**. Ölçüm almak, rapor okumak, PR merge etmek ve
Claude ile konuşmak için gerekmez.

Kod değişikliği gerekiyorsa claude.ai/code üzerinden yaptırabilirsin — o da
tarayıcıda çalışır ve PR olarak önüne getirir.
