// Brain calismasi sozlesme kontrolu: artifact'e YAZILMADAN ONCE kendi ciktimizi dogrular.
//
// Neden: orkestrator zaten her ajan ciktisini dogruluyor, ama artifact'in "dogru sonuc" gibi
// durmasi icin son halka da dogrulanmali: model metni tasiyan alanlar (bulgular) yalnizca
// dogrulanmis cikti olabilir, izlerde istem/yanit govdesi bulunamaz, sir sizamaz ve sayaçlar
// sert sinirlari asamaz. Ihlal varsa bulgu/sonuc ARTIFACT'e yazilmaz (quarantineRun).
import {
  ACTIONABILITY, CANONICAL_AGENTS, CONFIDENCES, EVIDENCE_LABELS, MAX_API_CALLS, MAX_SPECIALISTS, RUN_SCHEMA, RUN_STATUSES, type BrainRun,
} from "./contracts.ts";
import { containsSecret } from "./evidence.ts";

export const RUN_REQUIRED_KEYS = [
  "schema", "run_id", "site_id", "started_at", "completed_at", "status", "status_reason", "input_evidence_ids", "agents_considered", "agents_called",
  "agent_results", "agent_trace", "findings", "recommendations", "unknowns", "conflicts", "cost_guard", "production_write",
] as const;

/** Izde YALNIZ bu alanlar bulunabilir: istem govdesi, yanit govdesi, ham tamamlama icin yer yok. */
export const TRACE_KEYS = [
  "agent_id", "role", "started_at", "completed_at", "status", "input_evidence_ids", "output_finding_ids", "error_code", "violations", "http_status", "input_tokens", "output_tokens", "profile_sha256",
] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = (v: unknown, list: readonly string[]) => typeof v === "string" && list.includes(v);

/** Ihlal KODLARI doner (icerik/sir icermez). Bos liste = sozlesmeye uygun. */
export function validateBrainRun(run: unknown, opts: { secrets?: readonly string[] } = {}): string[] {
  if (!isObj(run)) return ["NOT_AN_OBJECT"];
  const v = new Set<string>();
  for (const k of RUN_REQUIRED_KEYS) if (!(k in run)) v.add(`MISSING_${k.toUpperCase()}`);
  if (v.size) return [...v].sort();
  if (run.schema !== RUN_SCHEMA) v.add("BAD_SCHEMA");
  if (!oneOf(run.status, RUN_STATUSES)) v.add("BAD_STATUS");
  if (run.production_write !== false) v.add("PRODUCTION_WRITE_NOT_FALSE");
  if (typeof run.site_id !== "string" || !run.site_id) v.add("BAD_SITE_ID");
  const ids = new Set(Array.isArray(run.input_evidence_ids) ? (run.input_evidence_ids as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const siteId = run.site_id;

  const checkIds = (list: unknown) => { if (!Array.isArray(list) || !list.every((i) => typeof i === "string" && ids.has(i))) v.add("EVIDENCE_ID_NOT_IN_INPUT"); };
  const checkFinding = (f: unknown, final: boolean) => {
    if (!isObj(f)) { v.add("BAD_FINDING"); return; }
    if (f.site_id !== siteId) v.add("FOREIGN_SITE_FINDING");
    if (!oneOf(f.evidence_label, EVIDENCE_LABELS)) v.add("BAD_EVIDENCE_LABEL");
    if (!oneOf(f.confidence, CONFIDENCES)) v.add("BAD_CONFIDENCE");
    if (!oneOf(f.actionability, ACTIONABILITY)) v.add("BAD_ACTIONABILITY");
    if (!Array.isArray(f.evidence_ids) || f.evidence_ids.length === 0) v.add("FINDING_WITHOUT_EVIDENCE"); else checkIds(f.evidence_ids);
    if (final) {
      if (typeof f.execution_candidate !== "boolean") v.add("BAD_EXECUTION_CANDIDATE");
      // Aday yalniz DRAFT_PR_CANDIDATE + acik uyum PASS: baska her sey aday olamaz.
      const verdict = isObj(f.compliance) ? f.compliance.verdict : null;
      if (f.execution_candidate === true && !(f.actionability === "DRAFT_PR_CANDIDATE" && verdict === "PASS")) v.add("EXECUTION_CANDIDATE_WITHOUT_PASS");
    }
  };
  if (!Array.isArray(run.findings)) v.add("BAD_FINDINGS"); else for (const f of run.findings) checkFinding(f, true);
  if (!Array.isArray(run.agent_results)) v.add("BAD_AGENT_RESULTS");
  else for (const r of run.agent_results) {
    if (!isObj(r) || r.site_id !== siteId || !oneOf(r.agent_id, CANONICAL_AGENTS)) { v.add("BAD_AGENT_RESULT"); continue; }
    if (Array.isArray(r.findings)) for (const f of r.findings) checkFinding(f, false);
  }
  if (!Array.isArray(run.agents_called) || !run.agents_called.every((a) => oneOf(a, CANONICAL_AGENTS))) v.add("BAD_AGENTS_CALLED");

  const trace = Array.isArray(run.agent_trace) ? (run.agent_trace as unknown[]) : (v.add("BAD_TRACE"), []);
  for (const t of trace) {
    if (!isObj(t)) { v.add("BAD_TRACE"); continue; }
    if (Object.keys(t).some((k) => !(TRACE_KEYS as readonly string[]).includes(k))) v.add("TRACE_UNKNOWN_KEY");
    if (!oneOf(t.agent_id, CANONICAL_AGENTS)) v.add("BAD_TRACE");
    if (!oneOf(t.status, ["OK", "INVALID_OUTPUT", "ERROR", "SKIPPED"])) v.add("BAD_TRACE_STATUS");
  }

  const g = run.cost_guard;
  if (!isObj(g)) v.add("BAD_COST_GUARD");
  else {
    if (g.max_calls !== MAX_API_CALLS || g.max_specialists !== MAX_SPECIALISTS) v.add("COST_LIMITS_ALTERED");
    if (typeof g.calls_used !== "number" || g.calls_used > MAX_API_CALLS || g.calls_used < 0) v.add("CALL_BUDGET_EXCEEDED");
    if (typeof g.specialists_called !== "number" || g.specialists_called > MAX_SPECIALISTS) v.add("SPECIALIST_CAP_EXCEEDED");
    if (g.estimated_cost_usd !== "UNKNOWN") v.add("COST_NOT_UNKNOWN");
    if (typeof g.calls_used === "number" && trace.filter((t) => isObj(t) && t.status !== "SKIPPED").length > g.calls_used) v.add("TRACE_EXCEEDS_CALLS");
  }

  // Durum tutarliligi: NOT_CONFIGURED hic cagri/bulgu tasimaz; SUCCESS tum izlerin OK olmasini ister.
  if (run.status === "NOT_CONFIGURED" && (isObj(g) && g.calls_used !== 0 || (Array.isArray(run.findings) && run.findings.length > 0))) v.add("NOT_CONFIGURED_WITH_CALLS");
  if (run.status === "SUCCESS" && trace.some((t) => isObj(t) && t.status !== "OK")) v.add("SUCCESS_WITH_FAILED_AGENT");
  if ((run.status === "ERROR") && Array.isArray(run.findings) && run.findings.length > 0) v.add("ERROR_WITH_FINDINGS");

  if (containsSecret(JSON.stringify(run), opts.secrets)) v.add("SECRET_IN_RUN");
  return [...v].sort();
}

/** Sozlesme ihlalinde model kaynakli metin (bulgu, sonuc, bilinmeyen, celiski) artifact'e GIRMEZ; sayaclar ve izler kalir. */
export function quarantineRun(run: BrainRun, codes: readonly string[]): BrainRun {
  return {
    ...run, status: "ERROR", status_reason: `RUN_CONTRACT_VIOLATION: ${codes.join(",").slice(0, 300)}`,
    agent_results: [], findings: [], recommendations: [], unknowns: [], conflicts: [],
    agent_trace: run.agent_trace.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => (TRACE_KEYS as readonly string[]).includes(k))) as unknown as BrainRun["agent_trace"][number]),
  };
}

/** Artifact'e yazilacak son halka: sozlesmeye uygunsa aynen, degilse quarantine. CLI YALNIZ bunu kullanir. */
export function sealRun(run: BrainRun, opts: { secrets?: readonly string[] } = {}): { run: BrainRun; violations: string[] } {
  const violations = validateBrainRun(run, opts);
  return { run: violations.length ? quarantineRun(run, violations) : run, violations };
}
