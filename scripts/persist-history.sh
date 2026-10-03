#!/usr/bin/env bash
# Ortak GÜVENLİ KALICILIK sözleşmesi: main'e commit eden workflow'lar (measure.yml, clarity-daily.yml)
# commit+push adımını yalnız bu betikle yapar. Ayrıntı ve gerekçe: docs/persistence-safety.md
#
# Kullanım: scripts/persist-history.sh -m "<commit mesajı>" <yol> [<yol>...]
#
# NİYE: düz `git push` main başka yazıcıyla ilerlediyse reddedilir ve rapor commit'i sessizce kaybolurdu
# (artifact kalır, depo kaydı kalmaz). Burada: yalnız izinli yollar stage edilir, değişiklik yoksa commit yok,
# push öncesi fetch+rebase, sınırlı yeniden deneme, ASLA force, çatışmada otomatik çözüm yok (yüksek sesle düş).
#
# Çıkış kodları: 0 başarılı / değişiklik yok; 1 push denemeleri tükendi; 2 rebase çatışması (abort edildi);
#                3 kullanım hatası ya da izin listesi dışı yol (hiçbir şey stage edilmedi).
set -euo pipefail

# İzin listesi: fail-closed. Yeni bir yazıcı yolu eklemek bu dizinin (ve docs'un) bilinçli değişmesi demektir.
ALLOWED=("data/clarity-history/" "reports/" "content/topic-ledger.json")
# Sert tavan; ortam değişkeni yalnız AŞAĞI çekebilir. Sonsuz döngü yok.
MAX_ATTEMPTS=3
if [[ "${PERSIST_MAX_ATTEMPTS:-}" =~ ^[1-3]$ ]]; then MAX_ATTEMPTS="$PERSIST_MAX_ATTEMPTS"; fi
# Denemeler arası bekleme (sn): 1. ve 2. başarısızlıktan sonra. Testler 0 verir.
BACKOFF="${PERSIST_BACKOFF_SECONDS:-5 10}"

msg=""
paths=()
while (($#)); do
  case "$1" in
    -m)
      [[ $# -ge 2 ]] || { echo "persist: -m mesaj ister" >&2; exit 3; }
      msg="$2"
      shift 2
      ;;
    --)
      shift
      paths+=("$@")
      break
      ;;
    -*)
      echo "persist: bilinmeyen seçenek $1" >&2
      exit 3
      ;;
    *)
      paths+=("$1")
      shift
      ;;
  esac
done
[[ -n "$msg" ]] || { echo "persist: commit mesajı (-m) zorunlu" >&2; exit 3; }
((${#paths[@]})) || { echo "persist: en az bir yol gerekli" >&2; exit 3; }

allowed_path() {
  local p="$1" a
  [[ -n "$p" && "$p" != /* && "$p" != *..* && "$p" != *$'\n'* ]] || return 1
  for a in "${ALLOWED[@]}"; do
    if [[ "$a" == */ ]]; then
      [[ "$p" == "$a"* ]] && return 0
    else
      [[ "$p" == "$a" ]] && return 0
    fi
  done
  return 1
}

# Önce HEPSİNİ doğrula, sonra stage et: kısmi add olmasın.
for p in "${paths[@]}"; do
  if ! allowed_path "$p"; then
    echo "persist: REDDEDİLDİ — '$p' izin listesi dışında (${ALLOWED[*]}). Hiçbir şey stage edilmedi." >&2
    exit 3
  fi
done

# Var olmayan yol (ör. henüz oluşmamış ledger) hata değildir; olan yollar eklenir.
for p in "${paths[@]}"; do
  if [[ -e "$p" ]]; then git add -- "$p"; fi
done

# İzinli DİZİN altına düşen her dosya `git add -- dizin/` ile alınırdı; bir adım yanlışlıkla credentials.json / token.txt
# bıraksa main'e push edilirdi (.gitignore yalnız .env*'i korur). Beklenen yazıcı çıktıları .md/.json; gizli-görünümlü
# adlar ve diğer uzantılar stage'den geri alınır (yüksek sesle, düşmeden: kalıcılık işi gizli dosya yüzünden kaybolmasın).
while IFS= read -r -d '' f; do
  base="${f##*/}"; lower="${base,,}"
  if [[ ! "$lower" =~ \.(md|json)$ || "$lower" =~ (secret|credential|token|passw|\.env|\.pem|\.key|id_rsa|\.p12) ]]; then
    git reset -q -- "$f"
    echo "persist: UYARI — '$f' beklenen ad/uzantı desenine uymuyor (.md/.json, gizli-görünümlü ad yok); stage'den çıkarıldı, commit edilmeyecek" >&2
  fi
done < <(git diff --cached --name-only -z)

if git diff --cached --quiet; then
  echo "persist: değişiklik yok, commit atılmadı"
  exit 0
fi

# Hedef dal = checkout edilen dal (Actions'ta tetiklenen ref). Eski düz push da bunu yapıyordu; HEAD:main yazmak,
# bir dal dispatch'inde dal commit'ini main'e itmek olurdu. Detached HEAD'de hedef belirsiz: fail-closed.
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
if [[ -z "$BRANCH" ]]; then
  echo "persist: REDDEDİLDİ — detached HEAD, hedef dal belirsiz" >&2
  exit 3
fi

git commit -q -m "$msg"
echo "persist: commit atıldı $(git rev-parse --short HEAD)"

read -r -a waits <<<"$BACKOFF"
attempt=1
while ((attempt <= MAX_ATTEMPTS)); do
  echo "persist: deneme $attempt/$MAX_ATTEMPTS"
  if git fetch -q origin "$BRANCH"; then
    # --autostash: izin listesi dışındaki izlenen dosya kirliyse (ör. adım bir şeyi değiştirdi) düz `git rebase` "unstaged
    # changes" diye reddeder ve bu yanlışlıkla çatışma (exit 2) sayılırdı; veri push edilemezdi.
    if ! git rebase --autostash "origin/$BRANCH" >/dev/null 2>&1; then
      # Çatışma deterministiktir; tekrar denemek işe yaramaz ve otomatik çözüm veri bozabilir.
      git rebase --abort >/dev/null 2>&1 || true
      echo "persist: HATA — rebase çatışması. Otomatik çözüm yok; yerel commit korundu ($(git rev-parse --short HEAD)), push edilmedi. Geçmiş artifact'ta duruyor." >&2
      exit 2
    fi
    if git push -q origin "HEAD:refs/heads/$BRANCH"; then
      echo "persist: push başarılı"
      # Değişmez: LOCAL_PERSISTED_SHA == REMOTE_MAIN_SHA. Yerel HEAD'e güvenmek yerine push
      # SONRASI origin/$BRANCH'i yeniden çözüp doğrula (fail-closed Option B gereği).
      LOCAL_PERSISTED_SHA="$(git rev-parse HEAD)"
      if ! git fetch -q origin "$BRANCH"; then
        echo "persist: HATA — push sonrası origin/$BRANCH yeniden çözülemedi (fetch başarısız); persisted_sha YAYINLANMADI" >&2
        exit 1
      fi
      REMOTE_MAIN_SHA="$(git rev-parse "origin/$BRANCH")"
      if [[ "$LOCAL_PERSISTED_SHA" != "$REMOTE_MAIN_SHA" ]]; then
        echo "persist: HATA — yerel push edilen SHA ($LOCAL_PERSISTED_SHA) remote main SHA'sinden ($REMOTE_MAIN_SHA) farkli; fail-closed, persisted_sha YAYINLANMADI" >&2
        exit 1
      fi
      echo "persist: dogrulandi — persisted_sha=$REMOTE_MAIN_SHA"
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        echo "persisted_sha=$REMOTE_MAIN_SHA" >>"$GITHUB_OUTPUT"
      fi
      exit 0
    fi
    echo "persist: push reddedildi (deneme $attempt)" >&2
  else
    echo "persist: fetch başarısız (deneme $attempt)" >&2
  fi
  if ((attempt < MAX_ATTEMPTS)); then
    sleep "${waits[$((attempt - 1))]:-5}"
  fi
  attempt=$((attempt + 1))
done
echo "persist: HATA — $MAX_ATTEMPTS denemede push edilemedi. Yerel commit korundu, veri kaybolmadı (artifact'ta); iş kırmızı." >&2
exit 1
