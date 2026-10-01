// Kanit zarfi (sgos.brain.evidence.v1) + paket dogrulamasi + deterministik sikistirma.
//
// Brain ham metni "gercek" kabul etmez. Modele giden her sey buradan gecer:
//   - bir site yalniz kendi kanitini tasir (site izolasyonu: yabanci kanit pakette REDDEDILIR),
//   - etiket/guven/durum sabit kumelerden biri olmak zorunda (EDITORIAL dahil degil),
//   - kanit sirri/anahtari tasiyorsa model hic cagrilmaz,
//   - buyuk payload'lar sikistirilir ve sikistirildigi isaretlenir (sessizce kesilmez).
import { createHash } from "node:crypto";
import {
  EVIDENCE_BUNDLE_SCHEMA, EVIDENCE_CATEGORIES, EVIDENCE_LABELS, EVIDENCE_SCHEMA, EVIDENCE_SOURCES, CONFIDENCES, MEASUREMENT_STATES,
  MAX_EVIDENCE_BYTES_PER_ITEM, MAX_EVIDENCE_BYTES_PER_RUN, MAX_EVIDENCE_ITEMS, USABLE_STATES,
  type EvidenceBundle, type EvidenceEnvelope, type MeasurementState,
} from "./contracts.ts";
import type { ClaritySiteResult } from "../adapters/clarity.ts";
import type { SiteEntry } from "../registry.ts";

export const EVIDENCE_ID_RE = /^[a-z0-9][a-z0-9._:-]{2,95}$/i;

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"private_key"\s*:/,
];

/** Metin bilinen bir sirri ya da sir benzeri bir kalibi tasiyor mu? Sirrin KENDISI hic yazdirilmaz. */
export function containsSecret(text: string, secrets: readonly string[] = []): boolean {
  for (const s of secrets) if (s && s.length >= 8 && text.includes(s)) return true;
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const byteLen = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

// --- deterministik sikistirma ----------------------------------------------------------------

function compactValue(v: unknown, arrayLimit: number, depth: number): unknown {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…[kesildi: ${v.length - 300} karakter]` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "[derinlik siniri]";
  if (Array.isArray(v)) return v.slice(0, arrayLimit).map((x) => compactValue(x, arrayLimit, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val) && val.length > arrayLimit) out[`${k}__truncated`] = { kept: arrayLimit, total: val.length };
    out[k] = compactValue(val, arrayLimit, depth + 1);
  }
  return out;
}

/** Payload'i tek kayit sinirina indirir; sigmazsa null doner (cagiran REDDEDER, veri uydurmaz). */
export function compactPayload(payload: Record<string, unknown>, maxBytes = MAX_EVIDENCE_BYTES_PER_ITEM): Record<string, unknown> | null {
  for (const limit of [25, 10, 5, 3]) {
    const c = compactValue(payload, limit, 0) as Record<string, unknown>;
    if (byteLen(c) <= maxBytes) return c;
  }
  return null;
}

// --- zarf dogrulamasi ------------------------------------------------------------------------

export interface EnvelopeCheck { ok: boolean; errors: string[] }

export function validateEnvelope(raw: unknown, siteId: string): EnvelopeCheck {
  const errors: string[] = [];
  const e = raw as Partial<EvidenceEnvelope> | null;
  if (!e || typeof e !== "object" || Array.isArray(e)) return { ok: false, errors: ["INVALID_ENVELOPE"] };
  if (e.schema !== EVIDENCE_SCHEMA) errors.push("INVALID_SCHEMA");
  if (typeof e.evidence_id !== "string" || !EVIDENCE_ID_RE.test(e.evidence_id)) errors.push("INVALID_EVIDENCE_ID");
  if (e.site_id !== siteId) errors.push("FOREIGN_SITE_EVIDENCE");
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(e.source as string)) errors.push("INVALID_SOURCE");
  if (typeof e.source_ref !== "string" || !e.source_ref) errors.push("INVALID_SOURCE_REF");
  if (typeof e.measured_at !== "string" || Number.isNaN(Date.parse(e.measured_at))) errors.push("INVALID_MEASURED_AT");
  if (!(MEASUREMENT_STATES as readonly string[]).includes(e.measurement_state as string)) errors.push("INVALID_MEASUREMENT_STATE");
  // EDITORIAL dahil, alti etiket disindaki her sey burada reddedilir.
  if (!(EVIDENCE_LABELS as readonly string[]).includes(e.evidence_label as string)) errors.push("INVALID_EVIDENCE_LABEL");
  if (!(CONFIDENCES as readonly string[]).includes(e.confidence as string)) errors.push("INVALID_CONFIDENCE");
  if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(e.category as string)) errors.push("INVALID_CATEGORY");
  if (!e.payload || typeof e.payload !== "object" || Array.isArray(e.payload)) errors.push("INVALID_PAYLOAD");
  return { ok: errors.length === 0, errors };
}

export interface BundleResult {
  ok: boolean;
  /** Kod listesi; kanit icerigi ya da sir icermez. */
  errors: string[];
  bundle?: EvidenceBundle;
  /** Sikistirilan kayitlar: modelin neyin kesildigini bilmesi icin. */
  compaction: { evidence_id: string; original_bytes: number; compact_bytes: number }[];
  evidence_bytes: number;
}

export function parseEvidenceBundle(raw: unknown, siteId: string, opts: { secrets?: readonly string[] } = {}): BundleResult {
  const fail = (errors: string[]): BundleResult => ({ ok: false, errors, compaction: [], evidence_bytes: 0 });
  if (!raw || typeof raw !== "object") return fail(["INVALID_BUNDLE"]);
  const b = raw as { schema?: unknown; site_id?: unknown; evidence?: unknown };
  const list = Array.isArray(raw) ? (raw as unknown[]) : b.evidence;
  if (!Array.isArray(raw) && b.site_id !== undefined && b.site_id !== siteId) return fail(["FOREIGN_SITE_BUNDLE"]);
  if (!Array.isArray(list)) return fail(["INVALID_BUNDLE"]);
  if (list.length > MAX_EVIDENCE_ITEMS) return fail(["TOO_MANY_EVIDENCE_ITEMS"]);

  const errors: string[] = [];
  const seen = new Set<string>();
  const items: EvidenceEnvelope[] = [];
  const compaction: BundleResult["compaction"] = [];
  list.forEach((rawItem, i) => {
    const chk = validateEnvelope(rawItem, siteId);
    if (!chk.ok) { for (const c of chk.errors) errors.push(`${c}@${i}`); return; }
    const e = rawItem as EvidenceEnvelope;
    if (seen.has(e.evidence_id)) { errors.push(`DUPLICATE_EVIDENCE_ID@${i}`); return; }
    seen.add(e.evidence_id);
    if (containsSecret(JSON.stringify(e), opts.secrets)) { errors.push(`EVIDENCE_CONTAINS_SECRET@${i}`); return; }
    const originalBytes = byteLen(e.payload);
    const compact = compactPayload(e.payload);
    if (!compact) { errors.push(`EVIDENCE_ITEM_TOO_LARGE@${i}`); return; }
    const out: EvidenceEnvelope = { ...e, payload: compact };
    const compactBytes = byteLen(compact);
    if (compactBytes !== originalBytes) compaction.push({ evidence_id: e.evidence_id, original_bytes: originalBytes, compact_bytes: compactBytes });
    items.push(out);
  });
  if (errors.length) return { ok: false, errors, compaction, evidence_bytes: 0 };

  const evidenceBytes = byteLen(items);
  if (evidenceBytes > MAX_EVIDENCE_BYTES_PER_RUN) return { ok: false, errors: ["EVIDENCE_TOO_LARGE"], compaction, evidence_bytes: evidenceBytes };
  return { ok: true, errors: [], bundle: { schema: EVIDENCE_BUNDLE_SCHEMA, site_id: siteId, evidence: items }, compaction, evidence_bytes: evidenceBytes };
}

export const isUsable = (e: EvidenceEnvelope) => USABLE_STATES.includes(e.measurement_state);

// --- adaptor siniri: mevcut normalize ciktilar kanita cevrilir (yeniden yazilmaz) -------------

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
export function makeEvidenceId(site: string, source: string, ref: string, measuredAt: string): string {
  return `ev-${site}-${source.toLowerCase()}-${measuredAt.slice(0, 10)}-${shortHash(`${site}|${source}|${ref}|${measuredAt}`)}`;
}

/** Clarity sonucu -> kanit. Olculemeyen (ERROR / NOT_CONNECTED) sonuc SAYI tasimaz: yalniz durum
 *  ve hata kodu gider; "veri yok" sifira donusmez. */
export function evidenceFromClarity(r: ClaritySiteResult): EvidenceEnvelope {
  const ref = `clarity:${r.site_id}:${r.measured_at.slice(0, 10)}`;
  const state: MeasurementState = r.measurement_state;
  const usable = state === "MEASURED" || state === "PARTIAL";
  const payload: Record<string, unknown> = usable
    ? {
        window_days: r.window_days,
        requests: r.requests.map((q) => ({ id: q.id, dimensions: q.dimensions, state: q.state, http_status: q.http_status, row_count: q.row_count, metric_row_count_total: q.metric_row_count_total, max_metric_row_count: q.max_metric_row_count, rows_complete: q.rows_complete })),
        metrics: r.metrics.map((m) => ({ request_id: m.request_id, metric_name: m.metric_name, metric_key: m.metric_key, row_count: m.row_count, top_rows: m.rows.slice(0, 10) })),
        row_count: r.row_count, metric_row_count_total: r.metric_row_count_total, max_metric_row_count: r.max_metric_row_count,
        rows_complete: r.rows_complete, is_zero: r.is_zero,
      }
    : { error_code: r.error_code ?? null, note: r.note ?? null };
  return {
    schema: EVIDENCE_SCHEMA, evidence_id: makeEvidenceId(r.site_id, "CLARITY", ref, r.measured_at), site_id: r.site_id, source: "CLARITY",
    source_ref: ref, measured_at: r.measured_at, measurement_state: state, evidence_label: "FACT", confidence: r.confidence,
    category: "BEHAVIOR", payload,
  };
}

/** Registry -> yalnizca O sitenin kendi kayitlari. Baska sitenin satiri bu fonksiyona hic girmez. */
export function evidenceFromRegistry(site: SiteEntry, measuredAt: string): EvidenceEnvelope {
  const payload: Record<string, unknown> = {
    id: site.id, onboarding_status: site.onboarding_status, production_domain: site.production_domain, canonical_hostname: site.canonical_hostname,
    primary_language: site.primary_language, secondary_languages: site.secondary_languages, target_markets: site.target_markets,
    business_category: site.business_category, foundation_year: site.foundation_year,
    primary_business_objectives: site.primary_business_objectives, primary_conversion_events: site.primary_conversion_events,
    sitemap_locations: site.sitemap_locations, core_commercial_topics: site.core_commercial_topics, core_informational_topics: site.core_informational_topics,
    competitor_set: site.competitor_set, risk_level: site.risk_level, deployment_approval_policy: site.deployment_approval_policy,
  };
  return {
    schema: EVIDENCE_SCHEMA, evidence_id: makeEvidenceId(site.id, "REGISTRY", "config/sites.yaml", measuredAt), site_id: site.id, source: "REGISTRY",
    source_ref: "config/sites.yaml", measured_at: measuredAt, measurement_state: "RECORDED", evidence_label: "FACT", confidence: "CONFIRMED",
    category: "REGISTRY", payload,
  };
}
