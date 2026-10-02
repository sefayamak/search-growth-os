# Güvenli kalıcılık sözleşmesi (main'e commit eden workflow'lar)

Karar: K1=A (owner onayı). Kapsam: `scripts/persist-history.sh`, `measure.yml` ve `clarity-daily.yml`'in **yalnız commit adımları**,
`tests/persist-history.test.ts`. Cron, kapı, `permissions`, `concurrency`, secret ve tetikleyiciler **değişmedi** (test zorlar).

## 1. Denetim: eski durum (FACT, dosyalardan)

| | `measure.yml` | `clarity-daily.yml` |
|---|---|---|
| Yazdığı yol | `reports/measure-latest.md`, `reports/runs/`, `content/topic-ledger.json` | `data/clarity-history/` |
| Eski push | `git commit` + düz `git push` (**rebase yok**) | `git commit` + `git pull --rebase origin main` + `git push` |
| Ref koruması | yok (dal dispatch'inde dala yazar) | `github.ref == 'refs/heads/main'` |
| Deneme | tek | tek |

Hata kipleri (eski):

1. **Push reddi -> veri kaybı (measure).** İş sürerken main ilerlerse (clarity-daily, insan merge'i, başka bot) düz push non-fast-forward ile reddedilir.
   Rapor commit'i yalnız runner'da kalır ve runner silinir. Artifact (30 gün) kalır, depo kaydı kalmaz. Adım kırmızı olur ama kalıcı kayıt yoktu.
2. **Rebase çatışması (clarity-daily).** `git pull --rebase` çatışmada yarım rebase durumunda çıkar; adım kırmızı olur ama depo durumu belirsiz kalır, mesaj yönlendirmez.
3. **Rebase ile push arası yarış.** `pull --rebase` ile `push` arasında main yine ilerleyebilir: tek deneme, yeniden deneme yok.
4. **Kısmi add.** measure'da `git add reports/measure-latest.md reports/runs/` ilk yol yoksa hata verir ve ledger eklenmeden çıkabilir; `[ -f ledger ] && git add` ise `-e` altında sessiz geçer. Tutarsız.
5. **İki iş arası yarış.** Farklı concurrency grupları (`measure`, `clarity`) birbirini kilitlemez; bugün saatler ayrı (Pzt 06:40 / günlük 07:20) olduğu için çakışma *zamanlama şansı*. Yeni yazıcılar
   (`docs/integration/workflow-architecture.md`, `docs/history-ownership.md`; ilgili dallarda) bunu gerçek yapar.

## 2. Sözleşme

`bash scripts/persist-history.sh -m "<mesaj>" <yol>...` — iki workflow da yalnız bunu çağırır; satır içi `git add/commit/pull/push` kalmadı.

1. **İzin listesi (fail-closed):** `data/clarity-history/`, `reports/`, `content/topic-ledger.json`. Herhangi bir yol dışındaysa (mutlak yol, `..`, boş dâhil) **hiçbir şey stage edilmeden** çıkış 3.
   Önce hepsi doğrulanır, sonra eklenir: kısmi add yok. Var olmayan yol atlanır (ledger henüz yoksa hata değil).
2. Stage edilmiş fark yoksa **commit yok**, çıkış 0.
3. Commit, sonra **en fazla 3 deneme** (sert tavan; `PERSIST_MAX_ATTEMPTS` yalnız aşağı çeker): `git fetch origin <dal>` -> `git rebase origin/<dal>` -> düz `git push`. Denemeler arası 5 sn, 10 sn.
   **`--force` / `--force-with-lease` yok** (test betiği tarar).
4. **Rebase çatışması:** `git rebase --abort`, çıkış 2. Otomatik çözüm yok (`-X ours/theirs`, `reset --hard` yok), yeniden deneme yok (çatışma deterministik). Yerel commit korunur, push edilmez.
5. **Denemeler tükendi:** çıkış 1. İş kırmızı. Yerel commit korunur.
6. Hedef dal = checkout edilen dal (eski düz `git push` ile aynı davranış; `HEAD:main` yazılsaydı dal dispatch'i main'e yazardı). Detached HEAD -> çıkış 3.
7. **Tek yazıcı sahipliği:** measure yalnız `reports/` + ledger'ı, clarity-daily yalnız `data/clarity-history/` yolunu geçirir (test zorlar). Yollar ayrık olduğu için bot-bot rebase çatışması yapısal olarak yok.

## 3. Davranış matrisi

| Durum | Çıkış | Remote | Yerel commit | İş | Veri |
|---|---|---|---|---|---|
| Değişiklik yok | 0 | aynı | yok | yeşil | — |
| Temiz push | 0 | ilerler | var | yeşil | kalıcı |
| Main başka yolda ilerlemiş | 0 | ilerler (rebase sonrası) | yeniden yazılmış | yeşil | iki geçmiş de kalıcı |
| Geçici ret (<=2) | 0 | ilerler | var | yeşil | kalıcı |
| Aynı dosyada çatışma | 2 | **değişmez** | korunur, rebase abort | **kırmızı** | artifact'ta |
| 3 ret | 1 | değişmez | korunur | **kırmızı** | artifact'ta |
| İzin dışı yol | 3 | değişmez | yok, stage yok | **kırmızı** | artifact'ta |

## 4. Neden ortak concurrency grubu YOK

GitHub bir grupta en fazla bir çalışan + bir bekleyen iş tutar; yeni bekleyen eskisini **iptal eder** (`cancel-in-progress: false` bunu engellemez). `measure` ve `clarity-daily` (ileride lighthouse,
index-alarms, deployment-timeline) tek gruba konursa zamanlanmış bir koşu sessizce iptal edilebilir: haftalık/günlük kayıt delik kalır ve kimse görmez. Ayrıca `clarity` grubu zaten Clarity kotası için
`clarity.yml` ile paylaşımlıdır. Koruma bu yüzden serileştirme değil **fetch+rebase+sınırlı yeniden deneme**. Grup, kota/sahiplik içindir.

## 5. Hata olduğunda owner ne görür

- Adım kırmızı, log'da `persist: HATA — ...` (çatışma ya da 3 deneme). Run listesinde başarısız zamanlanmış koşu (GitHub varsayılan e-postası).
- Veri kaybı yok: `Artifact` adımı `if: always()`; measure `reports/measure-latest.md`, clarity `clarity-out/` yüklenir. Depoya yazma, sonraki başarılı koşuyla (clarity: aynı-gün guard'ı
  nedeniyle ertesi gün yeniden ölçer; kayıt eksik gün olarak görünür) ya da insanın artifact'tan PR açmasıyla tamamlanır. **Otomatik telafi yok** (yeni API çağrısı/kota harcamaz).
- Çatışma (çıkış 2) yalnız biri ayrık yol sözünü bozarsa olur (ör. insan `reports/measure-latest.md`'yi elle düzenlemiş). Önce kim yazdığına bak.

## 6. Orkestrasyon modeli ile ilişki (sonraki birleştirme için)

`tests/orchestration*` ve `src/orchestration.ts` yalnız `claude/sprint-scorecard-orchestration` dalında; bu PR onlara **dokunmaz**. O dal merge edilirken:
`measure` işinin `push_strategy` alanı `plain_push` -> **rebase+retry** değerine (ör. `rebase_retry_3`), `clarity-daily`'nin `pull_rebase` -> aynı değere güncellenmeli; `PUSH_WITHOUT_REBASE`
uyarısı söner. `commit_group` alanları (bu sözleşmeyi paylaşan işler) aynı kümeye alınmalı; drift testi `git push` satırını workflow'da artık bulamaz (push betikte), bu yüzden
`COMMIT_NOT_IN_MODEL` / `MODEL_COMMIT_NOT_IN_WORKFLOW` / `PUSH_STRATEGY_DRIFT` / `GIT_ADD_NOT_IN_MODEL` tespiti `persist-history.sh` çağrısını (ve yol argümanlarını) okuyacak şekilde güncellenmeli.

## 7. Owner kararı bekleyen noktalar

- `content/topic-ledger.json` izin listesine **eklendi** (measure bunu zaten commit ediyordu; çıkarmak davranış gerilemesi olurdu). Görev metnindeki liste yalnız iki yoldu; istenmiyorsa ledger
  ayrı bir yazıcıya taşınmalı.
- Rebase çatışması otomatik yeniden denenmez (bilinçli). Alarm/bildirim entegrasyonu yok; yalnız kırmızı koşu.
- Branch protection eklenirse tüm yazıcılar kırmızı olur (bu sözleşme bunu çözmez; bypass ya da PR akışı gerekir).
