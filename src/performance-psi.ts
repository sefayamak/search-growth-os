// PageSpeed Insights v5 istemcisi. Testler bunu ASLA cagirmaz: fetcher enjekte edilir (fixture-first).
// Neden ayri dosya: ag + anahtar yalnizca burada yasar; ayristirma/gecmis/regresyon saf fonksiyonlardir.
//
// Anahtar kurali: API anahtari yalnizca ORTAM DEGISKENI ADIYLA taninir. Anahtar hicbir fonksiyon
// argumani, donus degeri, hata mesaji ya da log satirinda tasinmaz; sorgu dizgesine yalniz bu dosyada
// ve yalniz istek aninda girer. Hata metni kullaniciya donmeden once anahtardan arindirilir.

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

/** Anahtar yoksa null: cagiran bunu NOT_CONNECTED sayar (sifir degil, tahmin degil). */
export function createPsiFetcher(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): PsiFetcher | null {
  if (!hasPsiKey(env)) return null;
  const key = env[PSI_ENV]!.trim();
  return async (req) => {
    const qs = new URLSearchParams({ url: req.url, strategy: req.strategy, category: "performance" });
    qs.set("key", key);
    try {
      // 429/5xx yeniden DENENMEZ: kota tuketen bir dongu, olcumden daha pahali bir hatadir.
      const res = await fetchImpl(`${PSI_ENDPOINT}?${qs.toString()}`, { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } catch (e) {
      // Hata metni anahtar iceren bir URL tasiyabilir; yalnizca ad + arindirilmis ozet disari cikar.
      const msg = String((e as Error)?.message ?? e).split(key).join("[REDACTED]").split(encodeURIComponent(key)).join("[REDACTED]");
      throw new Error(`PSI_FETCH_FAILED: ${msg.slice(0, 120)}`);
    }
  };
}
