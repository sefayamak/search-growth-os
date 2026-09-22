# Bir kez kur, bir daha uğraşma

Amaç: GSC ve GA4 rakamlarının, kimsenin bilgisayarına ve tarayıcı oturumuna
bağlı olmadan okunabilmesi.

Kurgu şu: **anahtar GitHub Secret'ta durur.** Haftalık bir iş onu kullanıp
`reports/measure-latest.md` dosyasını üretir. Rakamlara bakmak isteyen —insan
ya da ajan— o dosyayı okur. Anahtarı kimsenin görmesi gerekmez; sohbete,
depoya, log'a hiç girmez.

Toplam süre: ~15 dakika. Bir kez.

---

## 1. Servis hesabı aç (Google Cloud)

1. <https://console.cloud.google.com> → üstten bir proje seç ya da yeni aç.
2. **APIs & Services → Library** → şu ikisini **Enable** et:
   - `Google Search Console API`
   - `Google Analytics Data API`
3. **APIs & Services → Credentials → Create credentials → Service account**
   - İsim: `search-growth-os` (fark etmez)
   - Rol verme, **Continue → Done**. Proje içi role gerek yok; yetkiyi GSC ve
     GA4 tarafında vereceğiz.
4. Açılan servis hesabına tıkla → **Keys → Add key → Create new key → JSON**.
   İnen dosyayı **bilgisayarında tut**, hiçbir yere yükleme.
5. Aynı ekrandaki **e-posta adresini** kopyala. Şuna benzer:
   `search-growth-os@<proje>.iam.gserviceaccount.com`

> Bu e-posta bir kullanıcı gibi davranır. Yetkiyi ona vereceğiz.

---

## 2. Yetki ver

### Search Console

<https://search.google.com/search-console> → sol altta **Settings** →
**Users and permissions** → **Add user**

- E-posta: yukarıdaki servis hesabı adresi
- İzin: **Restricted** (salt-okunur, yeterli)

Her property için ayrı ayrı yap. `sc-domain:pamistanbul.com` gibi bir **Domain
property** varsa o tek başına apex ve www'yu birlikte kapsar.

### GA4

<https://analytics.google.com> → **Admin** → ilgili property → **Property
access management** → sağ üstte **+** → **Add users**

- E-posta: aynı adres
- Rol: **Viewer**

Her property için ayrı ayrı. Portföydeki property numaraları
`config/sites.yaml` içinde yazılı.

---

## 3. Anahtarı GitHub'a koy

`sefayamak/search-growth-os` → **Settings → Secrets and variables → Actions →
New repository secret**

| Secret adı | Değeri |
|---|---|
| `SEARCH_GROWTH_GSC_CREDENTIALS_JSON` | JSON dosyasının **tüm içeriği** (kopyala-yapıştır) |
| `SEARCH_GROWTH_GA4_CREDENTIALS_JSON` | aynı JSON (tek servis hesabı ikisine de yetkili) |

> JSON'u olduğu gibi yapıştır — `{` ile başlayıp `}` ile biten her şey.
> GitHub Secret geri okunamaz; kaybedersen yenisini üretirsin, bulamazsın.
> Bu yüzden inen dosyayı da kendi tarafında bir parola yöneticisinde sakla.

---

## 4. Çalıştığını gör

`sefayamak/search-growth-os` → **Actions → "Ölçüm (GSC + GA4)" → Run workflow**

Bittiğinde:

- **Summary** sekmesinde rakamlar görünür.
- `reports/measure-latest.md` depoya yazılır.

Rapordaki **Bağlantı durumu** bölümü tek tek söyler:

```
OK   GSC pamistanbul sc-domain:pamistanbul.com — 28 günlük satır
FAIL GA4 spryhand 551083665 — HTTP 403 ...
```

`FAIL ... 403` demek, **o property'ye servis hesabını eklemeyi atlamışsın**
demektir. Adım 2'ye dönüp o property'yi ekle. Anahtarla ilgisi yoktur.

---

## Sonrası

Her pazartesi 09:40'ta (Europe/Istanbul) kendiliğinden koşar ve raporu
günceller. Elle de tetikleyebilirsin.

Bir sonraki oturumda "rakamlara bak" dendiğinde yapılacak tek şey
`reports/measure-latest.md` dosyasını okumak. Kurulum tekrar istenmez.

---

## Değişmeyen kurallar

- Kapsam **salt-okunur**: `webmasters.readonly`, `analytics.readonly`. Sitemap
  gönderme, URL kaldırma, Indexing API bu katmanda yok.
- Kimlik yoksa rapor `NOT_CONNECTED` yazar ve **sayı uydurmaz**. "Ölçemedim"
  ile "ölçtüm, sıfır çıktı" bu projede asla karışmaz.
- Anahtar depoya commit edilmez, log'a basılmaz, hata mesajına girmez
  (`tests/google-adapters.test.ts` bunu pinliyor).
- İş fork PR'larda koşmaz; fork bir PR secret'a erişemez.
