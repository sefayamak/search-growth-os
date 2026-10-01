// LLM ciktisina GUVENME: her ajan sonucu ayristirilir ve dogrulanir. Tek bir ihlal sonucun TAMAMINI
// reddeder — kismen "kurtarilmis" bir cikti, modelin neyi uydurdugunu gizler. Reddedilen cikti yerine
// uydurma sonuc konmaz: calisma PARTIAL/ERROR olur.
//
// Ihlaller yalniz KOD olarak doner (metin/kanit/sir icermez): izler ve artifact bu kodlari tasir.
import {
  ACTIONABILITY, AGENT_RESULT_SCHEMA, CONFIDENCES, EVIDENCE_LABELS, FINDING_ID_RE, MAX_FINDINGS_PER_SPECIALIST, MAX_SPECIALIST_CONFLICTS,
  CHIEF_CONFLICT_CHARS, CHIEF_FIELD_LIMITS, CHIEF_UNKNOWN_CHARS, COMPLIANCE_REASON_MAX_CHARS, MAX_CHIEF_CONFLICTS, MAX_CHIEF_FINDINGS, MAX_CHIEF_UNKNOWNS, MAX_COMPLIANCE_REVIEWS,
  MAX_DETAIL_EVIDENCE_IDS, MAX_DETAIL_OBSERVED_CHARS, MAX_DETAIL_PATH_CHARS, MAX_SPECIALIST_UNKNOWNS, MAX_VIOLATION_DETAILS, SPECIALIST_CONFLICT_CHARS, SPECIALIST_FIELD_LIMITS, SPECIALIST_UNKNOWN_CHARS,
  type AgentId, type AgentResult, type ViolationDetail, type BrainFinding, type ComplianceReview, type ComplianceVerdict, type EvidenceEnvelope,
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
  /** "specialist" / "chief": kisa-cikti limitleri (en fazla 5 bulgu, alan uzunluklari, unknowns/conflicts siniri). Verilmezse eski genis sinirlar. */
  role?: "specialist" | "chief";
}
export interface ValidationOutcome<T> { ok: boolean; violations: string[]; result?: T; details?: ViolationDetail[] }

// --- tani ayrintisi (Phase 2C.4): validator ANLAMI degismez, yalniz neyin reddedildigi sinirli bicimde kaydedilir ------------
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Modelin urettigi degeri guvenli, sinirli metne cevirir: kontrol karakteri yok, sir yok, en fazla 120 karakter. */
export function describeObserved(v: unknown, secrets?: readonly string[]): string {
  if (v === undefined) return "<missing>";
  if (v === null) return "<null>";
  if (typeof v !== "string") return Array.isArray(v) ? "<array>" : `<${typeof v}>`;
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return containsSecret(flat, secrets) ? "[REDACTED_SECRET]" : clip(flat, MAX_DETAIL_OBSERVED_CHARS);
}
class DetailSink {
  readonly list: ViolationDetail[] = [];
  add(d: ViolationDetail) {
    if (this.list.length >= MAX_VIOLATION_DETAILS) return;
    const out: ViolationDetail = { code: d.code, path: clip(d.path, MAX_DETAIL_PATH_CHARS) };
    if (d.expected !== undefined) out.expected = clip(d.expected, MAX_DETAIL_OBSERVED_CHARS);
    if (d.observed !== undefined) out.observed = d.observed;
    if (d.evidence_ids_checked) out.evidence_ids_checked = d.evidence_ids_checked.slice(0, MAX_DETAIL_EVIDENCE_IDS);
    if (d.reason !== undefined) out.reason = clip(d.reason, 60);
    if (d.corpus_size !== undefined) out.corpus_size = d.corpus_size;
    this.list.push(out);
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validateFindingsResult(raw: unknown, ctx: ValidationContext): ValidationOutcome<AgentResult> {
  const v = new Set<string>();
  const dt = new DetailSink();
  const fail = (): ValidationOutcome<AgentResult> => ({ ok: false, violations: [...v].sort(), details: dt.list });
  if (!isObj(raw)) return { ok: false, violations: ["BAD_SHAPE"], details: [] };
  if (raw.schema !== AGENT_RESULT_SCHEMA) { v.add("BAD_SCHEMA"); dt.add({ code: "BAD_SCHEMA", path: "$.schema", expected: AGENT_RESULT_SCHEMA, observed: describeObserved(raw.schema, ctx.secrets) }); }
  if (raw.agent_id !== ctx.agentId) { v.add("WRONG_AGENT_ID"); dt.add({ code: "WRONG_AGENT_ID", path: "$.agent_id", expected: ctx.agentId, observed: describeObserved(raw.agent_id, ctx.secrets) }); }
  if (raw.site_id !== ctx.siteId) { v.add("WRONG_SITE"); dt.add({ code: "WRONG_SITE", path: "$.site_id", expected: ctx.siteId, observed: describeObserved(raw.site_id, ctx.secrets) }); }
  if (!Array.isArray(raw.findings) || !Array.isArray(raw.unknowns) || !Array.isArray(raw.conflicts)) { v.add("BAD_SHAPE"); return fail(); }
  // Rol sinirlari: uzman ve Chief SIKI (kisa cikti), rol verilmezse eski genis sinirlar (yalniz geriye donuk testler icin).
  const lim = ctx.role === "specialist"
    ? { findings: MAX_FINDINGS_PER_SPECIALIST, fields: SPECIALIST_FIELD_LIMITS, unknowns: MAX_SPECIALIST_UNKNOWNS, unknownChars: SPECIALIST_UNKNOWN_CHARS, conflicts: MAX_SPECIALIST_CONFLICTS, conflictChars: SPECIALIST_CONFLICT_CHARS }
    : ctx.role === "chief"
      ? { findings: MAX_CHIEF_FINDINGS, fields: CHIEF_FIELD_LIMITS, unknowns: MAX_CHIEF_UNKNOWNS, unknownChars: CHIEF_UNKNOWN_CHARS, conflicts: MAX_CHIEF_CONFLICTS, conflictChars: CHIEF_CONFLICT_CHARS }
      : null;
  if (raw.findings.length > (lim ? lim.findings : MAX_FINDINGS)) v.add("TOO_MANY_FINDINGS");

  const findings: BrainFinding[] = [];
  const ids = new Set<string>();
  for (const [fi, f] of raw.findings.slice(0, MAX_FINDINGS).entries()) {
    if (!isObj(f)) { v.add("BAD_SHAPE"); continue; }
    if (!isStr(f.finding_id) || !FINDING_ID_RE.test(f.finding_id)) v.add("INVALID_FINDING_ID");
    else if (ids.has(f.finding_id)) v.add("DUPLICATE_FINDING_ID");
    else ids.add(f.finding_id);
    if (f.site_id !== ctx.siteId) {
      const code = isStr(f.site_id) && f.site_id !== ctx.siteId ? "FOREIGN_SITE_FINDING" : "WRONG_SITE";
      v.add(code);
      dt.add({ code, path: `$.findings[${fi}].site_id`, expected: ctx.siteId, observed: describeObserved(f.site_id, ctx.secrets) });
    }
    for (const k of TEXT_FIELDS) {
      if (!isStr(f[k]) || !f[k].trim()) v.add("EMPTY_FIELD");
      else if (f[k].length > (lim ? lim.fields[k] : MAX_FIELD)) v.add("FIELD_TOO_LONG");
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
      for (const k of CLAIM_FIELDS) {
        if (!isStr(f[k])) continue;
        for (const n of numbersIn(f[k] as string)) {
          if (numberSupported(n, corpus)) continue;
          v.add("UNSUPPORTED_NUMBER");
          dt.add({ code: "UNSUPPORTED_NUMBER", path: `$.findings[${fi}].${k}`, observed: n, evidence_ids_checked: cited.map((e) => e.evidence_id), reason: "NOT_IN_CITED_EVIDENCE", corpus_size: corpus.size });
        }
      }
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
  if (unknowns.length > (lim ? lim.unknowns : 20) || !unknowns.every((u) => isStr(u) && u.length <= (lim ? lim.unknownChars : 300))) v.add("BAD_UNKNOWNS");
  for (const u of unknowns) if (isStr(u) && containsSecret(u, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
  const conflicts = raw.conflicts as unknown[];
  if (conflicts.length > (lim ? lim.conflicts : 10)) v.add("BAD_CONFLICTS");
  for (const c of conflicts) {
    if (!isObj(c) || !isStr(c.description) || !Array.isArray(c.evidence_ids) || !c.evidence_ids.every(isStr)) { v.add("BAD_CONFLICTS"); continue; }
    if ((c.evidence_ids as string[]).some((id) => !ctx.allowed.has(id))) v.add("UNKNOWN_EVIDENCE_ID");
    if (lim && c.description.length > lim.conflictChars) v.add("BAD_CONFLICTS");
    if (looksLikeProductionWrite(c.description)) v.add("PRODUCTION_WRITE_INSTRUCTION");
    if (containsSecret(c.description, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
  }

  if (v.size) return fail();
  return {
    ok: true, violations: [], details: [],
    result: { schema: AGENT_RESULT_SCHEMA, agent_id: ctx.agentId, site_id: ctx.siteId, findings, unknowns: unknowns as string[], conflicts: conflicts as AgentResult["conflicts"] },
  };
}

/** Uyum sonucu: KISA karar listesi. Her gonderilen bulgu icin TAM BIR inceleme (eksik/fazla/yinelenen/yabanci kimlik reddedilir),
 *  gerekce <= 300 karakter. Tek ihlal sonucun tamamini reddeder; reddedilen uyum sonucu bulguyu asla "uyumlu" yapmaz. */
export function validateComplianceResult(raw: unknown, ctx: { siteId: string; findingIds: ReadonlySet<string>; secrets?: readonly string[] }): ValidationOutcome<ComplianceReview[]> {
  const v = new Set<string>();
  const dt = new DetailSink();
  const fail = (): ValidationOutcome<ComplianceReview[]> => ({ ok: false, violations: [...v].sort(), details: dt.list });
  if (!isObj(raw)) return { ok: false, violations: ["BAD_SHAPE"], details: [] };
  if (raw.schema !== AGENT_RESULT_SCHEMA) { v.add("BAD_SCHEMA"); dt.add({ code: "BAD_SCHEMA", path: "$.schema", expected: AGENT_RESULT_SCHEMA, observed: describeObserved(raw.schema, ctx.secrets) }); }
  if (raw.agent_id !== "search-policy-compliance-officer") { v.add("WRONG_AGENT_ID"); dt.add({ code: "WRONG_AGENT_ID", path: "$.agent_id", expected: "search-policy-compliance-officer", observed: describeObserved(raw.agent_id, ctx.secrets) }); }
  if (raw.site_id !== ctx.siteId) { v.add("WRONG_SITE"); dt.add({ code: "WRONG_SITE", path: "$.site_id", expected: ctx.siteId, observed: describeObserved(raw.site_id, ctx.secrets) }); }
  if (!Array.isArray(raw.reviews)) { v.add("BAD_SHAPE"); return fail(); }
  if (raw.reviews.length > MAX_COMPLIANCE_REVIEWS) { v.add("TOO_MANY_REVIEWS"); dt.add({ code: "TOO_MANY_REVIEWS", path: "$.reviews", expected: `<= ${MAX_COMPLIANCE_REVIEWS}`, observed: String(raw.reviews.length) }); }
  const out: ComplianceReview[] = [];
  const seen = new Set<string>();
  for (const [ri, r] of raw.reviews.slice(0, MAX_COMPLIANCE_REVIEWS).entries()) {
    if (!isObj(r) || !isStr(r.finding_id) || !isStr(r.reason) || !isStr(r.verdict)) { v.add("BAD_SHAPE"); dt.add({ code: "BAD_SHAPE", path: `$.reviews[${ri}]`, observed: isObj(r) ? "<missing-or-non-string-field>" : describeObserved(r, ctx.secrets) }); continue; }
    if (!ctx.findingIds.has(r.finding_id)) { v.add("UNKNOWN_FINDING_ID"); dt.add({ code: "UNKNOWN_FINDING_ID", path: `$.reviews[${ri}].finding_id`, observed: describeObserved(r.finding_id, ctx.secrets) }); }
    if (seen.has(r.finding_id)) v.add("DUPLICATE_FINDING_ID");
    seen.add(r.finding_id);
    if (!["PASS", "FLAG", "REJECT"].includes(r.verdict)) { v.add("INVALID_VERDICT"); dt.add({ code: "INVALID_VERDICT", path: `$.reviews[${ri}].verdict`, expected: "PASS|FLAG|REJECT", observed: describeObserved(r.verdict, ctx.secrets) }); }
    if (!r.reason.trim()) v.add("EMPTY_FIELD");
    if (r.reason.length > COMPLIANCE_REASON_MAX_CHARS) { v.add("FIELD_TOO_LONG"); dt.add({ code: "FIELD_TOO_LONG", path: `$.reviews[${ri}].reason`, expected: `<= ${COMPLIANCE_REASON_MAX_CHARS}`, observed: String(r.reason.length) }); }
    if (containsSecret(r.reason, ctx.secrets)) v.add("SECRET_IN_OUTPUT");
    out.push({ finding_id: r.finding_id, verdict: r.verdict as ComplianceVerdict, reason: r.reason, reviewed_by: "search-policy-compliance-officer" });
  }
  // Gonderilen HER bulgu incelenmeli: eksik inceleme "incelenmedi" kalmaz, sonucun tamami reddedilir.
  for (const id of ctx.findingIds) if (!seen.has(id)) { v.add("MISSING_REVIEW"); dt.add({ code: "MISSING_REVIEW", path: "$.reviews", observed: describeObserved(id, ctx.secrets) }); }
  if (v.size) return fail();
  return { ok: true, violations: [], details: [], result: out };
}
