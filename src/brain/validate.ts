// LLM ciktisina GUVENME: her ajan sonucu ayristirilir ve dogrulanir. Tek bir ihlal sonucun TAMAMINI
// reddeder — kismen "kurtarilmis" bir cikti, modelin neyi uydurdugunu gizler. Reddedilen cikti yerine
// uydurma sonuc konmaz: calisma PARTIAL/ERROR olur.
//
// Ihlaller yalniz KOD olarak doner (metin/kanit/sir icermez): izler ve artifact bu kodlari tasir.
import {
  ACTIONABILITY, AGENT_RESULT_SCHEMA, CONFIDENCES, EVIDENCE_LABELS, FINDING_ID_RE,
  type AgentId, type AgentResult, type BrainFinding, type ComplianceReview, type ComplianceVerdict, type EvidenceEnvelope,
} from "./contracts.ts";
import { containsSecret, isUsable } from "./evidence.ts";

/** Modelin cevabini JSON nesnesine cevirir. Cit yalniz `json` kod citiyle sarili olabilir; baska hicbir
 *  ayiklama yapilmaz (yarim JSON'u onarmaya calismak uydurmaya acik kapi). */
export function parseAgentJson(text: string): unknown | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// --- yasakli icerik ---------------------------------------------------------------------------

const PRODUCTION_WRITE_PATTERNS: RegExp[] = [
  /\bgit\s+(push|commit)\b/i,
  /\bforce[- ]?push\b/i,
  /\b(auto[- ]?merge|automatically\s+(merge|deploy|publish|push|apply))\b/i,
  /\bdeploy(ing)?\s+(it\s+)?(directly\s+)?(to|on)\s+(production|prod|live)\b/i,
  /\b(push|merge|publish|write|upload|commit)\s+(directly\s+)?(to|into|on)\s+(production|prod|main|master|live)\b/i,
  /\bvercel\s+(deploy|--prod)\b/i,
  /\b(rm\s+-rf|curl\s+[^|\n]*-X\s*(POST|PUT|DELETE|PATCH))\b/i,
  /(doğrudan|otomatik(?:man|\s+olarak)?)\s+(yayınla|yayına\s+al|deploy\s+et|canlıya\s+al|production)/i,
  /\bcanlıya\s+(al|yaz|yükle|gönder)\b/i,
  /\bproduction['’]?(a|ı|e|ye)\s+(yaz|yükle|deploy|gönder|push)/i,
];

export const looksLikeProductionWrite = (text: string) => PRODUCTION_WRITE_PATTERNS.some((re) => re.test(text));

// --- sayi kurali ------------------------------------------------------------------------------

const NUM_RE = /\d+(?:[.,]\d+)*/g;
const THOUSANDS_RE = /^\d{1,3}(?:[.,]\d{3})+$/;
const numbersIn = (text: string) => text.match(NUM_RE) ?? [];

/** Kanit zarfinin (payload + olcum zamani + kimlik) icinde GECEN sayilar. */
function numberCorpus(evidence: readonly EvidenceEnvelope[]): Set<string> {
  return new Set(evidence.flatMap((e) => numbersIn(JSON.stringify(e))));
}

function numberSupported(token: string, corpus: Set<string>): boolean {
  if (corpus.has(token)) return true;
  // "58.071" / "58,071" -> 58071: binlik ayirici yazimi ayni sayidir.
  if (THOUSANDS_RE.test(token) && corpus.has(token.replace(/[.,]/g, ""))) return true;
  return false;
}

// --- ortak dogrulayici ------------------------------------------------------------------------

const MAX_FINDINGS = 12;
const MAX_FIELD = 1500;
const TEXT_FIELDS = ["title", "category", "summary", "impact", "recommended_action", "risk", "verification_plan"] as const;
/** Sayi kurali yalniz IDDIA alanlarina uygulanir; recommended_action/verification_plan "28 gun sonra" gibi
 *  planlama sayilari tasiyabilir ve kanit degil plan sayilir. */
const CLAIM_FIELDS = ["title", "summary", "impact"] as const;
const FACT_LIKE = new Set(["FACT", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"]);

export interface ValidationContext {
  agentId: AgentId;
  siteId: string;
  /** Bu ajanin GORDUGU kanit: izin verilen kimlikler yalniz bunlardir. */
  allowed: ReadonlyMap<string, EvidenceEnvelope>;
  secrets?: readonly string[];
}
export interface ValidationOutcome<T> { ok: boolean; violations: string[]; result?: T }

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validateFindingsResult(raw: unknown, ctx: ValidationContext): ValidationOutcome<AgentResult> {
  const v = new Set<string>();
  if (!isObj(raw)) return { ok: false, violations: ["BAD_SHAPE"] };
  if (raw.schema !== AGENT_RESULT_SCHEMA) v.add("BAD_SCHEMA");
  if (raw.agent_id !== ctx.agentId) v.add("WRONG_AGENT_ID");
  if (raw.site_id !== ctx.siteId) v.add("WRONG_SITE");
  if (!Array.isArray(raw.findings) || !Array.isArray(raw.unknowns) || !Array.isArray(raw.conflicts)) return { ok: false, violations: [...v, "BAD_SHAPE"] };
  if (raw.findings.length > MAX_FINDINGS) v.add("TOO_MANY_FINDINGS");

  const findings: BrainFinding[] = [];
  const ids = new Set<string>();
  for (const f of raw.findings.slice(0, MAX_FINDINGS)) {
    if (!isObj(f)) { v.add("BAD_SHAPE"); continue; }
    if (!isStr(f.finding_id) || !FINDING_ID_RE.test(f.finding_id)) v.add("INVALID_FINDING_ID");
    else if (ids.has(f.finding_id)) v.add("DUPLICATE_FINDING_ID");
    else ids.add(f.finding_id);
    if (f.site_id !== ctx.siteId) v.add(isStr(f.site_id) && f.site_id !== ctx.siteId ? "FOREIGN_SITE_FINDING" : "WRONG_SITE");
    for (const k of TEXT_FIELDS) {
      if (!isStr(f[k]) || !f[k].trim()) v.add("EMPTY_FIELD");
      else if (f[k].length > MAX_FIELD) v.add("FIELD_TOO_LONG");
    }
    const label = f.evidence_label;
    if (isStr(label) && label.trim().toUpperCase() === "EDITORIAL") v.add("EDITORIAL_LABEL");
    if (!isStr(label) || !(EVIDENCE_LABELS as readonly string[]).includes(label)) v.add("INVALID_EVIDENCE_LABEL");
    if (!isStr(f.confidence) || !(CONFIDENCES as readonly string[]).includes(f.confidence)) v.add("INVALID_CONFIDENCE");
    if (!isStr(f.actionability) || !(ACTIONABILITY as readonly string[]).includes(f.actionability)) v.add("INVALID_ACTIONABILITY");

    const eids = f.evidence_ids;
    const cited: EvidenceEnvelope[] = [];
    if (!Array.isArray(eids) || eids.length === 0 || !eids.every(isStr)) v.add("MISSING_EVIDENCE_ID");
    else for (const id of eids as string[]) {
      const e = ctx.allowed.get(id);
      if (!e) v.add("UNKNOWN_EVIDENCE_ID"); else cited.push(e);
    }

    // FACT terfisi yok: FACT / IMPLEMENTED_CHANGE / VERIFIED_RESULT ayni etiketi tasiyan, kullanilabilir bir kanita dayanmak zorunda.
    if (isStr(label) && FACT_LIKE.has(label) && cited.length && !cited.some((e) => e.evidence_label === label && isUsable(e))) v.add("FACT_WITHOUT_FACT_EVIDENCE");
    // CONFIRMED yalniz olculmus, tam ve onayli kanitla; cikarim/hipotez/oneri asla CONFIRMED olamaz.
    if (f.confidence === "CONFIRMED" && cited.length) {
      const strong = isStr(label) && FACT_LIKE.has(label)
        && cited.every((e) => e.confidence === "CONFIRMED" && (e.measurement_state === "MEASURED" || e.measurement_state === "RECORDED"));
      if (!strong) v.add("CONFIDENCE_OVERCLAIM");
    }

    // Kanitta olmayan sayi uretme.
    if (cited.length) {
      const corpus = numberCorpus(cited);
      for (const k of CLAIM_FIELDS) if (isStr(f[k]) && numbersIn(f[k] as string).some((n) => !numberSupported(n, corpus))) v.add("UNSUPPORTED_NUMBER");
    }

    for (const k of TEXT_FIELDS) {
      const t = f[k];
      if (!isStr(t)) continue;
      if (looksLikeProductionWrite(t)) v.add("PRODUCTION_WRITE_INSTRUCTION");
      if (containsSecret(t, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
    }
    findings.push(f as unknown as BrainFinding);
  }

  const unknowns = raw.unknowns as unknown[];
  if (unknowns.length > 20 || !unknowns.every((u) => isStr(u) && u.length <= 300)) v.add("BAD_UNKNOWNS");
  for (const u of unknowns) if (isStr(u) && containsSecret(u, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
  const conflicts = raw.conflicts as unknown[];
  if (conflicts.length > 10) v.add("BAD_CONFLICTS");
  for (const c of conflicts) {
    if (!isObj(c) || !isStr(c.description) || !Array.isArray(c.evidence_ids) || !c.evidence_ids.every(isStr)) { v.add("BAD_CONFLICTS"); continue; }
    if ((c.evidence_ids as string[]).some((id) => !ctx.allowed.has(id))) v.add("UNKNOWN_EVIDENCE_ID");
    if (looksLikeProductionWrite(c.description)) v.add("PRODUCTION_WRITE_INSTRUCTION");
    if (containsSecret(c.description, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
  }

  if (v.size) return { ok: false, violations: [...v].sort() };
  return {
    ok: true, violations: [],
    result: { schema: AGENT_RESULT_SCHEMA, agent_id: ctx.agentId, site_id: ctx.siteId, findings, unknowns: unknowns as string[], conflicts: conflicts as AgentResult["conflicts"] },
  };
}

export function validateComplianceResult(raw: unknown, ctx: { siteId: string; findingIds: ReadonlySet<string>; secrets?: readonly string[] }): ValidationOutcome<ComplianceReview[]> {
  const v = new Set<string>();
  if (!isObj(raw)) return { ok: false, violations: ["BAD_SHAPE"] };
  if (raw.schema !== AGENT_RESULT_SCHEMA) v.add("BAD_SCHEMA");
  if (raw.agent_id !== "search-policy-compliance-officer") v.add("WRONG_AGENT_ID");
  if (raw.site_id !== ctx.siteId) v.add("WRONG_SITE");
  if (!Array.isArray(raw.reviews)) return { ok: false, violations: [...v, "BAD_SHAPE"] };
  const out: ComplianceReview[] = [];
  const seen = new Set<string>();
  for (const r of raw.reviews) {
    if (!isObj(r) || !isStr(r.finding_id) || !isStr(r.reason) || !isStr(r.verdict)) { v.add("BAD_SHAPE"); continue; }
    if (!ctx.findingIds.has(r.finding_id)) v.add("UNKNOWN_FINDING_ID");
    if (seen.has(r.finding_id)) v.add("DUPLICATE_FINDING_ID");
    seen.add(r.finding_id);
    if (!["PASS", "FLAG", "REJECT"].includes(r.verdict)) v.add("INVALID_VERDICT");
    if (r.reason.length > 600) v.add("FIELD_TOO_LONG");
    if (containsSecret(r.reason, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
    out.push({ finding_id: r.finding_id, verdict: r.verdict as ComplianceVerdict, reason: r.reason, reviewed_by: "search-policy-compliance-officer" });
  }
  if (v.size) return { ok: false, violations: [...v].sort() };
  return { ok: true, violations: [], result: out };
}
