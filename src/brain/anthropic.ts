// Anthropic Messages API istemcisi (bulut akil yuruten katman). Sifir bagimlilik: yalniz fetch.
//
// Kimlik: YALNIZ API anahtari (SEARCH_GROWTH_ANTHROPIC_API_KEY). Claude Max oturumu/cerezi yok.
// Model KODA GOMULU DEGILDIR: SEARCH_GROWTH_ANTHROPIC_MODEL (workflow'da repo variable).
// Anahtar ya da model yoksa durum NOT_CONFIGURED'dur ve HICBIR HTTP cagrisi yapilmaz.
//
// Maliyet: istemci HIC yeniden deneme yapmaz. 429/5xx bir cagridir ve ERROR olarak doner; sessiz
// retry butceyi gorunmez sekilde ikiye katlardi. Uc nokta koda gomulu (anahtari baska sunucuya
// yonlendirme yolu olmasin). Anahtar yalniz `x-api-key` basligina girer; hata metnine, rapora,
// artifact'e, CLI argumanina girmez ve cikan her metin redact edilir.
export const ANTHROPIC_KEY_ENV = "SEARCH_GROWTH_ANTHROPIC_API_KEY";
export const ANTHROPIC_MODEL_ENV = "SEARCH_GROWTH_ANTHROPIC_MODEL";
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const REQUEST_TIMEOUT_MS = 90_000;

export type AnthropicConfig =
  | { state: "NOT_CONFIGURED"; missing: string[] }
  | { state: "CONFIGURED"; apiKey: string; model: string };

export function loadAnthropicConfig(env: Record<string, string | undefined> = process.env): AnthropicConfig {
  const key = (env[ANTHROPIC_KEY_ENV] ?? "").trim();
  const model = (env[ANTHROPIC_MODEL_ENV] ?? "").trim();
  const missing: string[] = [];
  if (!key) missing.push(ANTHROPIC_KEY_ENV);
  if (!model) missing.push(ANTHROPIC_MODEL_ENV);
  if (missing.length) return { state: "NOT_CONFIGURED", missing };
  return { state: "CONFIGURED", apiKey: key, model };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface CompleteRequest { system: string; user: string; maxTokens: number }
export type CompleteResult =
  | { ok: true; text: string; http_status: number; input_tokens: number | "UNKNOWN"; output_tokens: number | "UNKNOWN" }
  | { ok: false; error_code: "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "HTTP_ERROR" | "SERVER_ERROR" | "INVALID_RESPONSE" | "TIMEOUT" | "NETWORK_ERROR" | "REFUSED_OR_EMPTY"; http_status: number | null };

export interface AnthropicClient { complete(req: CompleteRequest): Promise<CompleteResult> }

function codeFor(status: number): Extract<CompleteResult, { ok: false }>["error_code"] {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

export function createAnthropicClient(cfg: Extract<AnthropicConfig, { state: "CONFIGURED" }>, fetchFn: FetchLike = fetch as unknown as FetchLike): AnthropicClient {
  return {
    async complete(req) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await fetchFn(ANTHROPIC_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION },
            body: JSON.stringify({ model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content: req.user }] }),
            signal: ctrl.signal,
          });
        } catch (e) {
          return { ok: false, error_code: (e as Error)?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", http_status: null };
        }
        if (res.status !== 200) return { ok: false, error_code: codeFor(res.status), http_status: res.status };
        let body: { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
        try { body = JSON.parse(await res.text()); } catch { return { ok: false, error_code: "INVALID_RESPONSE", http_status: 200 }; }
        if (!body || !Array.isArray(body.content)) return { ok: false, error_code: "INVALID_RESPONSE", http_status: 200 };
        const text = body.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
        if (!text.trim()) return { ok: false, error_code: "REFUSED_OR_EMPTY", http_status: 200 };
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : "UNKNOWN" as const);
        return { ok: true, text, http_status: 200, input_tokens: n(body.usage?.input_tokens), output_tokens: n(body.usage?.output_tokens) };
      } finally { clearTimeout(timer); }
    },
  };
}

/** Hard cap: cagri yapilmadan ONCE sayilir. Sinir asilirsa istemci hic cagrilmaz. */
export class CallBudget {
  used = 0;
  readonly max: number;
  constructor(max: number) { this.max = max; }
  take(): boolean { if (this.used >= this.max) return false; this.used++; return true; }
}
