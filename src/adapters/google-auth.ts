/**
 * Google service-account auth — sifir bagimlilik, `node:crypto` ile RS256.
 *
 * GIZLILIK SOZLESMESI (degistirilemez):
 *   - Anahtar YALNIZCA ortam degiskeninden okunur (inline JSON ya da dosya yolu).
 *   - Anahtar, private_key, access_token ve JWT HICBIR sekilde loglanmaz,
 *     hata mesajina girmez, dosyaya yazilmaz. Asagidaki hata metinleri bilerek
 *     "hangi alan eksik" demekle yetinir; degeri asla tasimaz.
 *   - Kimlik yoksa cagiran NOT_CONNECTED gorur; sahte sayi URETILMEZ.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

/** Ortam degiskenini service account'a cevir. Yoksa null — bu bir hata degil,
 *  "bagli degil" durumudur ve cagiran onu oyle raporlar. */
export function loadServiceAccount(envVar: string): ServiceAccount | null {
  const raw = process.env[envVar];
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();
  // Yol mu, inline JSON mu? JSON bir '{' ile baslar; gerisi dosya yolu sayilir.
  if (!text.startsWith("{")) {
    try { text = readFileSync(text, "utf8"); }
    catch { throw new Error(`${envVar}: dosya okunamadi (yol gecerli mi?)`); }
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`${envVar}: JSON ayristirilamadi`); }
  const client_email = typeof parsed.client_email === "string" ? parsed.client_email : "";
  const private_key = typeof parsed.private_key === "string" ? parsed.private_key : "";
  if (!client_email || !private_key) throw new Error(`${envVar}: client_email ve private_key zorunlu`);
  const token_uri = typeof parsed.token_uri === "string" ? parsed.token_uri : undefined;
  return { client_email, private_key, token_uri };
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RS256 imzali JWT bearer — Google'in dokumante ettigi server-to-server akisi. */
export function signJwt(sa: ServiceAccount, scopes: string[], now = Math.floor(Date.now() / 1000), subject?: string): string {
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // exp en fazla 1 saat; 3600 sinirin tam ustunde reddedilir, 3600 kabul edilir.
  const claims: Record<string, unknown> = { iss: sa.client_email, scope: scopes.join(" "), aud, iat: now, exp: now + 3600 };
  // Domain-wide delegation: yalnizca acikca istendiginde. Servis hesabina
  // kullanici kimligi giydirmek genis bir yetkidir, varsayilan olamaz.
  if (subject) claims.sub = subject;
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  // `private_key` ortam degiskeninden geldiginde \n'ler kacirilmis olabilir.
  const key = sa.private_key.includes("\\n") ? sa.private_key.replace(/\\n/g, "\n") : sa.private_key;
  return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

interface CacheEntry { token: string; expiresAt: number }
const cache = new Map<string, CacheEntry>();

/**
 * Access token al. Sureden 60 sn once yenilenir — saat kaymasi yuzunden
 * suresi dolmus bir token'la istek atmak, tesirini tek bir 401 olarak
 * gosterir ve "GSC bagli degil" gibi okunur.
 */
export async function accessToken(sa: ServiceAccount, scopes: string[], subject?: string): Promise<string> {
  const key = `${sa.client_email}\u0000${scopes.join(" ")}\u0000${subject ?? ""}`;
  const hit = cache.get(key);
  const now = Math.floor(Date.now() / 1000);
  if (hit && hit.expiresAt - 60 > now) return hit.token;

  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(sa, scopes, now, subject) }),
  });
  if (!res.ok) {
    // Google'in hata govdesi assertion'i yankilamaz, ama yine de govdeyi
    // olduğu gibi tasimiyoruz: yalniz kod + kisa aciklama.
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`token alinamadi (HTTP ${res.status}) ${body.replace(/[\r\n]+/g, " ")}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("token yanitinda access_token yok");
  cache.set(key, { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) });
  return json.access_token;
}

/** Test icin: onbellegi bosalt. */
export function _resetTokenCache(): void { cache.clear(); }

/** Google API'lerine yetkili JSON istegi. 429/5xx uzerinde ustel geri cekilme:
 *  GSC gunluk kotasi dar ve tek bir 429 tum olcumu NOT_CONNECTED'a dusururdu. */
export async function googleJson<T>(url: string, token: string, init?: { method?: string; body?: unknown }, attempt = 0): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    return googleJson<T>(url, token, init, attempt + 1);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${url.split("?")[0]} — ${body.replace(/[\r\n]+/g, " ")}`);
  }
  return (await res.json()) as T;
}
