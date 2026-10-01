/**
 * Microsoft Clarity Data Export API istemcisi — dogrudan, GitHub Actions runner'dan.
 *
 * Bu modul site-health-monitor'a, kisisel bilgisayara, Chrome'a ya da eski
 * `CLARITY_TOKENS_JSON` secret'ina BAGLI DEGILDIR. Kanonik secret
 * `SEARCH_GROWTH_CLARITY_TOKENS_JSON` (site id -> proje token'i).
 *
 * Sozlesme (GSC / GA4 ile ayni ruh):
 *   - token yok            -> NOT_CONNECTED
 *   - token var, API hata  -> ERROR (sebebiyle: UNAUTHORIZED, FORBIDDEN, RATE_LIMITED, ...)
 *   - 200 ve veri          -> MEASURED
 *   - 200 ve GERCEKTEN bos -> MEASURED, row_count 0 ("olculdu, sifir")
 *   "Veri yok / olculemedi" ASLA sifira donusmez: hata durumunda row_count "UNKNOWN".
 *
 * Gizlilik sozlesmesi (degistirilemez):
 *   - Token yalnizca ortam degiskeninden okunur ve yalnizca `Authorization` basligina girer.
 *     Log, hata mesaji, rapor, artifact ya da CLI argumani olarak ASLA gecmez.
 *   - Yanit govdesi hata durumunda HIC tasinmaz (yalniz HTTP durumu + kod). Cikan her metin
 *     ayrica token alt dizgelerinden temizlenir (redact).
 *   - Satirlardaki URL'lerden sorgu dizesi ve fragment atilir; kisisel veri olabilecek alanlar
 *     (e-posta, IP, kullanici/oturum kimligi, cerez) saklanmaz.
 *   - Uc nokta KODA GOMULUDUR; ortam degiskeniyle degistirilemez (token'i baska bir sunucuya
 *     yonlendirme yolu olmasin).
 *
 * Microsoft sinirlari (proje sahibinin gorevde verdigi, Microsoft Clarity Data Export API
 * dokumanindan; bu sandbox'tan dokumana ERISILEMEDI, burada yeniden dogrulanmadi):
 *   numOfDays yalniz 1/2/3 · proje basina gunde en fazla 10 istek · istek basina en fazla 3
 *   boyut · yanit en fazla 1000 satir, sayfalama yok · 401/403 yetki · 429 gunluk limit · UTC.
 */

export const CLARITY_ENV = "SEARCH_GROWTH_CLARITY_TOKENS_JSON";
export const CLARITY_ENDPOINT = "https://www.clarity.ms/export-data/api/v1/project-live-insights";

/** Resmi gunluk limit (proje basina). Burada yalnizca belgelenir ve butce hesabinda kullanilir. */
export const OFFICIAL_DAILY_LIMIT_PER_PROJECT = 10;
/** Bir kosuda bir site icin PROFIL istegi sayisi. */
export const PROFILE_REQUESTS_PER_SITE = 3;
/** Bir kosuda bir site icin TOPLAM HTTP denemesi tavani (3 profil + 1 paylasimli 5xx yeniden denemesi).
 *  Gunluk limitin yarisindan azdir: ayni gun ikinci bir elle kosu hala sigar. */
export const MAX_HTTP_ATTEMPTS_PER_SITE = 4;
/** Yanit satir siniri (sayfalama yok). Ulasan yanit KESILMIS olabilir. */
export const RESPONSE_ROW_LIMIT = 1000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_5XX_RETRIES_PER_REQUEST = 1;

export type ClarityErrorCode =
  | "INVALID_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "HTTP_ERROR"
  | "SERVER_ERROR" | "INVALID_RESPONSE" | "TIMEOUT" | "NETWORK_ERROR" | "BUDGET_EXHAUSTED";

export type RequestState = "MEASURED" | "ERROR" | "SKIPPED";
export type SiteState = "MEASURED" | "PARTIAL" | "ERROR" | "NOT_CONNECTED";

export interface ProfileRequest {
  id: "device" | "acquisition" | "content";
  numOfDays: 1;
  dimensions: string[];
}

/**
 * 3 istek / site / kosu. Boyut adi "Url": site-health-monitor'un calisan kodu bu yazimi
 * kullaniyor (Microsoft dokumanina erisilemedigi icin buyuk/kucuk harf duyarliligi dogrulanmadi);
 * satir anahtarlari buyuk/kucuk harfe duyarsiz okunur.
 */
export const PROFILE: readonly ProfileRequest[] = [
  { id: "device", numOfDays: 1, dimensions: ["Device"] },
  { id: "acquisition", numOfDays: 1, dimensions: ["Source", "Medium"] },
  { id: "content", numOfDays: 1, dimensions: ["Url"] },
];

/** Profil sinirlari ihlal ediyorsa hata: istek ASLA kurulmaz. */
export function validateProfile(profile: readonly ProfileRequest[] = PROFILE): void {
  if (profile.length > PROFILE_REQUESTS_PER_SITE) throw new Error(`Clarity profili en fazla ${PROFILE_REQUESTS_PER_SITE} istek icerebilir`);
  for (const p of profile) {
    if (p.numOfDays !== 1) throw new Error("Clarity istegi numOfDays=1 olmak zorunda");
    if (p.dimensions.length < 1 || p.dimensions.length > 3) throw new Error("Clarity istegi 1-3 boyut icerebilir");
  }
}

export function buildUrl(p: ProfileRequest): string {
  validateProfile([p]);
  const q = new URLSearchParams({ numOfDays: String(p.numOfDays) });
  p.dimensions.forEach((d, i) => q.set(`dimension${i + 1}`, d));
  return `${CLARITY_ENDPOINT}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Token ortam degiskeni
// ---------------------------------------------------------------------------

export interface TokenParse {
  /** site id -> token. Token DEGERLERI bu nesnenin disina asla yazilmaz. */
  tokens: Map<string, string>;
  /** Insan icin sorunlar; token degeri ICERMEZ. */
  problems: string[];
}

/** `{ "<site id>": "<token>" }`. Ayristirilamazsa tokens bos + sorun metni; hata mesaji degeri tasimaz. */
export function parseClarityTokens(raw: string | undefined): TokenParse {
  const out: TokenParse = { tokens: new Map(), problems: [] };
  if (!raw || !raw.trim()) return out;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { out.problems.push(`${CLARITY_ENV}: JSON ayristirilamadi`); return out; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { out.problems.push(`${CLARITY_ENV}: {site_id: token} nesnesi bekleniyor`); return out; }
  for (const [site, tok] of Object.entries(data as Record<string, unknown>)) {
    if (typeof tok !== "string" || !tok.trim()) { out.problems.push(`${CLARITY_ENV}: '${site}' icin token bos ya da metin degil`); continue; }
    out.tokens.set(site, tok.trim());
  }
  return out;
}

/** Hata/rapor metinlerinden tum bilinen token alt dizgelerini temizle. */
export function redact(text: string, secrets: Iterable<string>): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join("[REDACTED]");
  return t;
}

// ---------------------------------------------------------------------------
// Normalizasyon
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Bilinen metrik adlari (normalize karsilastirma: "Dead Click Count" == "DeadClickCount"). */
const KNOWN_METRICS: Record<string, string> = {
  traffic: "traffic",
  engagementtime: "engagement_time",
  scrolldepth: "scroll_depth",
  popularpages: "popular_pages",
  deadclickcount: "dead_click_count",
  rageclickcount: "rage_click_count",
  quickbackclick: "quickback_click",
  excessivescroll: "excessive_scroll",
  scripterrorcount: "script_error_count",
  errorclickcount: "error_click_count",
};

/** Kisisel veri olabilecek alanlar: satirdan DUSURULUR. */
const PII_KEY = /(token|secret|password|e-?mail|ip-?address|^ip$|user-?id|client-?id|cookie|session-?id|visitor-?id|device-?id)/i;

/** Sorgu dizesi ve fragment atilir (sorguda e-posta vb. olabilir). Bozuksa degeri olduguna yakin birakmayiz. */
export function sanitizeUrl(v: string): string {
  try { const u = new URL(v); return `${u.origin}${u.pathname}`; }
  catch { return v.split(/[?#]/)[0]; }
}

export interface MetricResult {
  request_id: ProfileRequest["id"];
  /** API'nin dondurdugu HAM ad; bilinmeyen metrikler de burada korunur. */
  metric_name: string;
  /** Bilinen metrikse normalize anahtar, degilse null (sessizce atilmaz). */
  metric_key: string | null;
  row_count: number;
  rows: Record<string, unknown>[];
}

export interface RequestResult {
  id: ProfileRequest["id"];
  window_days: 1;
  dimensions: string[];
  state: RequestState;
  http_status: number | null;
  attempts: number;
  error_code?: ClarityErrorCode;
  /** Atlama sebebi (SKIPPED). */
  note?: string;
  /** Hata/atlama durumunda "UNKNOWN": veri yok sifir degildir. */
  row_count: number | "UNKNOWN";
  rows_complete: boolean | "UNKNOWN";
}

export interface ClaritySiteResult {
  schema: "sgos.clarity.v1";
  site_id: string;
  source: "microsoft_clarity_data_export_api";
  /** Olculen bir veri: FACT. INFERENCE bu katmanda uretilmez. */
  evidence_label: "FACT";
  measurement_state: SiteState;
  /** CONFIRMED yalniz eksiksiz veri; kesilmis ya da kismi veri CANDIDATE; olculememis UNKNOWN. */
  confidence: "CONFIRMED" | "CANDIDATE" | "UNKNOWN";
  /** UTC, ISO-8601. */
  measured_at: string;
  window_days: 1;
  requests: RequestResult[];
  metrics: MetricResult[];
  /** Olculen isteklerin toplam satiri; olculememisse "UNKNOWN". */
  row_count: number | "UNKNOWN";
  rows_complete: boolean | "UNKNOWN";
  /** MEASURED ve satir sayisi 0: gercek sifir. Hata durumunda false (sifir DEGIL). */
  is_zero: boolean;
  error_code?: ClarityErrorCode;
  note?: string;
}

function sanitizeRow(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (PII_KEY.test(k)) continue;
    out[k] = /^(url|pageurl|page)$/i.test(k) && typeof v === "string" ? sanitizeUrl(v) : v;
  }
  return out;
}

type ParsedResult = { ok: true; metrics: Omit<MetricResult, "request_id">[]; totalRows: number } | { ok: false };

/** Beklenen sekil: [{ metricName, information: [ {...} ] }]. Baska sekil = INVALID_RESPONSE (sifir degil). */
export function parseResponse(body: unknown): ParsedResult {
  if (!Array.isArray(body)) return { ok: false };
  const metrics: Omit<MetricResult, "request_id">[] = [];
  let total = 0;
  for (const m of body) {
    if (!m || typeof m !== "object" || typeof (m as { metricName?: unknown }).metricName !== "string") return { ok: false };
    const info = (m as { information?: unknown }).information;
    if (info !== undefined && !Array.isArray(info)) return { ok: false };
    const rows = (info ?? []).map(sanitizeRow).filter((r): r is Record<string, unknown> => r !== null);
    total += (info ?? []).length;
    const name = (m as { metricName: string }).metricName;
    metrics.push({ metric_name: name, metric_key: KNOWN_METRICS[norm(name)] ?? null, row_count: rows.length, rows });
  }
  return { ok: true, metrics, totalRows: total };
}

// ---------------------------------------------------------------------------
// Olcum
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface MeasureOptions {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  profile?: readonly ProfileRequest[];
}

const STOP_ON = new Set<ClarityErrorCode>(["UNAUTHORIZED", "FORBIDDEN", "RATE_LIMITED"]);
const statusToCode = (s: number): ClarityErrorCode =>
  s === 400 ? "INVALID_REQUEST" : s === 401 ? "UNAUTHORIZED" : s === 403 ? "FORBIDDEN" : s === 429 ? "RATE_LIMITED" : s >= 500 ? "SERVER_ERROR" : "HTTP_ERROR";

const defaultFetch: FetchFn = (url, init) => fetch(url, { method: "GET", headers: init.headers, signal: init.signal });

/** Bir site, bir token. Baska sitenin token'i bu fonksiyona ASLA girmez. */
export async function measureSite(siteId: string, token: string | undefined, o: MeasureOptions = {}): Promise<ClaritySiteResult> {
  const now = (o.now ?? (() => new Date()))().toISOString();
  const base = { schema: "sgos.clarity.v1" as const, site_id: siteId, source: "microsoft_clarity_data_export_api" as const, evidence_label: "FACT" as const, measured_at: now, window_days: 1 as const };
  if (!token) {
    return { ...base, measurement_state: "NOT_CONNECTED", confidence: "UNKNOWN", requests: [], metrics: [], row_count: "UNKNOWN", rows_complete: "UNKNOWN", is_zero: false, note: `${CLARITY_ENV} icinde '${siteId}' icin token yok` };
  }
  const profile = o.profile ?? PROFILE;
  validateProfile(profile);
  const fetchFn = o.fetchFn ?? defaultFetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const requests: RequestResult[] = [];
  const metrics: MetricResult[] = [];
  let attemptsTotal = 0;
  let stopped: ClarityErrorCode | null = null;

  for (const p of profile) {
    if (stopped) {
      requests.push({ id: p.id, window_days: 1, dimensions: p.dimensions, state: "SKIPPED", http_status: null, attempts: 0, note: `${stopped} nedeniyle atlandi (yeniden denenmez, gunluk butce korunur)`, row_count: "UNKNOWN", rows_complete: "UNKNOWN" });
      continue;
    }
    const r: RequestResult = { id: p.id, window_days: 1, dimensions: p.dimensions, state: "ERROR", http_status: null, attempts: 0, row_count: "UNKNOWN", rows_complete: "UNKNOWN" };
    let retries = 0;
    for (;;) {
      if (attemptsTotal >= MAX_HTTP_ATTEMPTS_PER_SITE) { r.error_code = r.error_code ?? "BUDGET_EXHAUSTED"; break; }
      attemptsTotal++; r.attempts++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let status = 0; let text = ""; let netErr: ClarityErrorCode | null = null;
      try {
        const res = await fetchFn(buildUrl(p), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: ctrl.signal });
        status = res.status;
        text = await res.text();
      } catch (e) {
        netErr = (e as { name?: string })?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
      } finally { clearTimeout(timer); }

      if (netErr) { r.error_code = netErr; r.http_status = null; break; }
      r.http_status = status;
      if (status === 200) {
        let body: unknown;
        try { body = JSON.parse(text); } catch { r.error_code = "INVALID_RESPONSE"; break; }
        const parsed = parseResponse(body);
        if (!parsed.ok) { r.error_code = "INVALID_RESPONSE"; break; }
        r.state = "MEASURED"; delete r.error_code;
        r.row_count = parsed.metrics.reduce((n, m) => n + m.row_count, 0);
        // Sayfalama yok: sinira ulasan yanit KESILMIS olabilir.
        r.rows_complete = parsed.totalRows < RESPONSE_ROW_LIMIT;
        for (const m of parsed.metrics) metrics.push({ request_id: p.id, ...m });
        break;
      }
      r.error_code = statusToCode(status);
      // 5xx: sinirli, paylasimli yeniden deneme. 4xx (429 dahil) ASLA yeniden denenmez.
      if (status >= 500 && retries < MAX_5XX_RETRIES_PER_REQUEST && attemptsTotal < MAX_HTTP_ATTEMPTS_PER_SITE) {
        retries++;
        await sleep(1000 * 2 ** (retries - 1));
        continue;
      }
      break;
    }
    if (r.state === "ERROR" && r.error_code && STOP_ON.has(r.error_code)) stopped = r.error_code;
    requests.push(r);
  }

  const ok = requests.filter((r) => r.state === "MEASURED");
  const bad = requests.filter((r) => r.state === "ERROR");
  const state: SiteState = ok.length === 0 ? "ERROR" : bad.length || ok.length < requests.length ? "PARTIAL" : "MEASURED";
  const rowsComplete: boolean | "UNKNOWN" = ok.length === 0 ? "UNKNOWN" : ok.every((r) => r.rows_complete === true) && state === "MEASURED" ? true : ok.some((r) => r.rows_complete === false) ? false : "UNKNOWN";
  const rowCount: number | "UNKNOWN" = ok.length === 0 ? "UNKNOWN" : ok.reduce((n, r) => n + (r.row_count as number), 0);
  const result: ClaritySiteResult = {
    ...base,
    measurement_state: state,
    confidence: state === "ERROR" ? "UNKNOWN" : state === "MEASURED" && rowsComplete === true ? "CONFIRMED" : "CANDIDATE",
    requests, metrics, row_count: rowCount, rows_complete: rowsComplete,
    is_zero: state === "MEASURED" && rowCount === 0,
  };
  if (state === "ERROR") result.error_code = bad[0]?.error_code ?? "BUDGET_EXHAUSTED";
  // Kismi veri: hangi istegin neden dustugu rapora yazilir.
  if (state === "PARTIAL") result.note = bad.map((r) => `${r.id}: ${r.error_code ?? "SKIPPED"}`).concat(requests.filter((r) => r.state === "SKIPPED").map((r) => `${r.id}: SKIPPED`)).join(", ");
  return result;
}

/** Bir sitenin sonucu yalnizca KENDI kaydina yazilabilir. */
export function assertResultSite(result: ClaritySiteResult, siteId: string): void {
  if (result.site_id !== siteId) throw new Error(`izolasyon ihlali: ${siteId} deposuna ${result.site_id} sonucu yazilamaz`);
}

/**
 * Registry'deki siteler icin olcum. Bir sitenin hatasi digerlerini ETKILEMEZ: her site kendi
 * try/catch'inde, kendi token'iyla. Token haritasindaki registry'de olmayan site kimlikleri
 * KULLANILMAZ (yalnizca adlari sorun listesine yazilir).
 */
export async function measureSites(siteIds: string[], tokens: Map<string, string>, o: MeasureOptions = {}): Promise<{ results: ClaritySiteResult[]; ignoredTokenSites: string[] }> {
  const secrets = [...tokens.values()];
  const results: ClaritySiteResult[] = [];
  for (const id of siteIds) {
    try {
      results.push(await measureSite(id, tokens.get(id), o));
    } catch (e) {
      // Beklenmeyen hata bile token tasimaz ve baska siteyi etkilemez.
      const now = (o.now ?? (() => new Date()))().toISOString();
      results.push({ schema: "sgos.clarity.v1", site_id: id, source: "microsoft_clarity_data_export_api", evidence_label: "FACT", measurement_state: "ERROR", confidence: "UNKNOWN", measured_at: now, window_days: 1, requests: [], metrics: [], row_count: "UNKNOWN", rows_complete: "UNKNOWN", is_zero: false, error_code: "NETWORK_ERROR", note: redact(String((e as Error)?.message ?? e), secrets).slice(0, 160) });
    }
  }
  const known = new Set(siteIds);
  return { results, ignoredTokenSites: [...tokens.keys()].filter((k) => !known.has(k)) };
}

/** Bagli mi? (Cagri yapmaz: kimlik var ile API cevap verdi ayri seylerdir.) */
export function clarityStatus(env: Record<string, string | undefined> = process.env): { state: "NOT_CONNECTED" | "UNKNOWN"; note: string } {
  const p = parseClarityTokens(env[CLARITY_ENV]);
  return p.tokens.size
    ? { state: "UNKNOWN", note: `${p.tokens.size} site icin token var; canli cagri bu calismada denenmedi (clarity-measure)` }
    : { state: "NOT_CONNECTED", note: `set ${CLARITY_ENV} (docs/integrations/clarity.md)` };
}

// ---------------------------------------------------------------------------
// Rapor
// ---------------------------------------------------------------------------

/** Tek satir, token/yanit dokumu YOK. */
export function summaryLine(r: ClaritySiteResult): string {
  if (r.measurement_state === "NOT_CONNECTED") return `NOT_CONNECTED ${r.site_id}`;
  const okCount = r.requests.filter((q) => q.state === "MEASURED").length;
  if (r.measurement_state === "ERROR") return `ERROR ${r.site_id} — ${r.error_code}`;
  const tail = r.rows_complete === false ? " (KESILMIS: 1000 satir siniri, rows_complete=false)" : r.is_zero ? " (olculdu, sifir)" : "";
  const head = r.measurement_state === "PARTIAL" ? "PARTIAL" : "OK";
  return `${head} ${r.site_id} — ${okCount}/${r.requests.length} request, ${r.measurement_state}${tail}${r.measurement_state === "PARTIAL" && r.note ? ` [${r.note}]` : ""}`;
}

export function resultsToMarkdown(results: ClaritySiteResult[], ignoredTokenSites: string[]): string {
  const L: string[] = ["# Clarity ölçümü", "",
    "Salt-okunur (Clarity Data Export API, GET). Token, ham yanıt ve kişisel veri raporlanmaz. `UNKNOWN` = ölçülemedi, **sıfır DEĞİLDİR**; `NOT_CONNECTED` = token yok.", "",
    "| site | durum | güven | istek | satır | rows_complete | not |", "|---|---|---|---|---|---|---|"];
  for (const r of results) {
    const okCount = r.requests.filter((q) => q.state === "MEASURED").length;
    L.push(`| ${r.site_id} | ${r.measurement_state}${r.error_code ? ` (${r.error_code})` : ""} | ${r.confidence} | ${okCount}/${r.requests.length} | ${r.row_count}${r.is_zero ? " (sıfır)" : ""} | ${r.rows_complete} | ${r.note ?? ""} |`);
  }
  const keys = new Set<string>();
  for (const r of results) for (const m of r.metrics) keys.add(`${m.metric_key ?? "?"}|${m.metric_name}`);
  if (keys.size) {
    L.push("", "## Metrikler (ham ad korunur; `?` = bilinmeyen metrik)", "");
    for (const k of [...keys].sort()) L.push(`- ${k.split("|")[1]}${k.startsWith("?|") ? " (bilinmeyen, normalize edilmedi)" : ` → ${k.split("|")[0]}`}`);
  }
  if (ignoredTokenSites.length) L.push("", `Registry'de olmayan site kimliği (token KULLANILMADI): ${ignoredTokenSites.join(", ")}`);
  return L.join("\n") + "\n";
}
