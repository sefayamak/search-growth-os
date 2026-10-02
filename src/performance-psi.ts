// PageSpeed Insights v5 istemcisi. Testler bunu ASLA cagirmaz: fetcher enjekte edilir (fixture-first).
// Neden ayri dosya: ag + anahtar yalnizca burada yasar; ayristirma/gecmis/regresyon saf fonksiyonlardir.
//
// Anahtar kurali: API anahtari yalnizca ORTAM DEGISKENI ADIYLA taninir. Anahtar hicbir fonksiyon
// argumani, donus degeri, hata mesaji ya da log satirinda tasinmaz; sorgu dizgesine yalniz bu dosyada
// ve yalniz istek aninda girer. Hata metni kullaniciya donmeden once anahtardan arindirilir.
//
// Yeniden deneme politikasi (KASITLI): YOK. 429/5xx/timeout tek istek olarak biter; kota ortak ve ucretsizdir,
// kota tuketen bir yeniden-deneme dongusu olcumden pahalidir. Karar: docs/integrations/performance-cwv.md.

export const PSI_ENV = "PAGESPEED_API_KEY" as const;
export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
/** PSI lab kosusu 20-40 sn surebilir; sonsuz beklemek bir CI isini kilitler. */
export const PSI_TIMEOUT_MS = 60_000;

export type Strategy = "mobile" | "desktop";

/** Fetcher'in gordugu istek anahtar IÇERMEZ — anahtar istemcinin kapanisinda kalir. */
export interface PsiRequest { url: string; strategy: Strategy }
/** `body` ham JSON (parse edilmis); gelmediyse null. Fetcher atarsa cagiran ERROR'a cevirir. */
export interface PsiResponse { status: number; body: unknown }
export type PsiFetcher = (req: PsiRequest) => Promise<PsiResponse>;

export const hasPsiKey = (env: Record<string, string | undefined>): boolean => typeof env[PSI_ENV] === "string" && env[PSI_ENV]!.trim() !== "";

/** Fetcher hatasi: yalniz kod + anahtardan arindirilmis kisa metin. Kod, cagiranin timeout'u ag hatasindan ayirmasini saglar. */
export class PsiFetchError extends Error {
  code: "TIMEOUT" | "NETWORK";
  constructor(code: "TIMEOUT" | "NETWORK", msg: string) { super(msg); this.code = code; }
}

/** Anahtarin metinde gorunebilecegi tum kodlamalar: ham, encodeURIComponent, URLSearchParams (bosluk '+', !'()* %-kodlu),
 *  ayrica `key=<deger>` kalibi. Yalniz ham + encodeURIComponent aramak ozel karakterli anahtari sizdirirdi. */
export function redactKey(text: string, key: string): string {
  const raw = key.trim();
  const forms = new Set<string>([raw, key, encodeURIComponent(raw), new URLSearchParams({ k: raw }).toString().slice(2)]);
  let out = text;
  for (const f of [...forms].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) out = out.split(f).join("[REDACTED]");
  return out.replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED]");
}

/** Anahtar yoksa null: cagiran bunu NOT_CONNECTED sayar (sifir degil, tahmin degil). */
export function createPsiFetcher(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PSI_TIMEOUT_MS,
): PsiFetcher | null {
  if (!hasPsiKey(env)) return null;
  const key = env[PSI_ENV]!.trim();
  return async (req) => {
    const qs = new URLSearchParams({ url: req.url, strategy: req.strategy, category: "performance" });
    qs.set("key", key);
    try {
      // 429/5xx yeniden DENENMEZ (bkz. dosya basi).
      const res = await fetchImpl(`${PSI_ENDPOINT}?${qs.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } catch (e) {
      // Hata metni anahtar iceren bir URL tasiyabilir; yalnizca kod + arindirilmis ozet disari cikar.
      const name = String((e as Error)?.name ?? "");
      const code = name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK";
      throw new PsiFetchError(code, `PSI_FETCH_FAILED: ${redactKey(String((e as Error)?.message ?? e), key).slice(0, 120)}`);
    }
  };
}
