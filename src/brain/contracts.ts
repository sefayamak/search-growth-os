// Brain sozlesmeleri. Burasi tek dogruluk kaynagi: schemas/brain-*.schema.json bu sabitlerle
// ayni sayilari tasir ve tests/brain.test.ts ikisi ayrisirsa kirilir.
//
// Evidence ontolojisi DEGISMEZ: alti etiket + dort guven. "EDITORIAL" bir etiket degildir
// (policies/evidence-labels.md); kasitli olarak burada yoktur ve dogrulayici onu reddeder.
import type { EvidenceLabel, Confidence } from "../types.ts";

export type { EvidenceLabel, Confidence };

export const EVIDENCE_LABELS: readonly EvidenceLabel[] = ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"];
export const CONFIDENCES: readonly Confidence[] = ["CONFIRMED", "CANDIDATE", "FALSE_POSITIVE", "UNKNOWN"];

/** DRAFT_PR_CANDIDATE bu fazda yalnizca ETIKETTIR: hicbir PR acilmaz, hicbir yere yazilmaz. */
export const ACTIONABILITY = ["MONITOR", "HUMAN_REVIEW", "DRAFT_PR_CANDIDATE"] as const;
export type Actionability = (typeof ACTIONABILITY)[number];

export const RUN_STATUSES = ["SUCCESS", "PARTIAL", "NOT_CONFIGURED", "ERROR"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Kaynak sozlesmeleri. AI_VISIBILITY ve COMPETITOR yonlendirme icin gerekli; baglanti yoksa
 *  bu kaynaklar pakette hic bulunmaz (uydurma veri yok). */
export const EVIDENCE_SOURCES = ["GSC", "GA4", "CLARITY", "CRAWL", "INDEX", "REGISTRY", "AI_VISIBILITY", "COMPETITOR"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const EVIDENCE_CATEGORIES = [
  "SEARCH_PERFORMANCE", "CONTENT_OPPORTUNITY", "BEHAVIOR", "TECHNICAL", "INDEXING",
  "STRUCTURED_DATA", "AI_VISIBILITY", "COMPETITOR", "REGISTRY",
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

/** MEASURED/PARTIAL: bir arac olcum yapti. RECORDED: sahibin kayda gectigi (registry) — olcum degil.
 *  Gerisi veri YOK demektir ve hicbir ajani tetiklemez. */
export const MEASUREMENT_STATES = ["MEASURED", "PARTIAL", "RECORDED", "ERROR", "NOT_CONNECTED", "NOT_AVAILABLE", "UNKNOWN"] as const;
export type MeasurementState = (typeof MEASUREMENT_STATES)[number];
export const USABLE_STATES: readonly MeasurementState[] = ["MEASURED", "PARTIAL", "RECORDED"];

export const EVIDENCE_SCHEMA = "sgos.brain.evidence.v1";
export const EVIDENCE_BUNDLE_SCHEMA = "sgos.brain.evidence-bundle.v1";
export const AGENT_RESULT_SCHEMA = "sgos.brain.agent-result.v1";
export const RUN_SCHEMA = "sgos.brain.run.v1";
export const MEMORY_SCHEMA = "sgos.brain.memory.v1";

export const CANONICAL_AGENTS = [
  "chief-search-strategist",
  "technical-search-auditor",
  "search-measurement-scientist",
  "content-evidence-strategist",
  "aeo-geo-strategist",
  "competitor-intelligence-analyst",
  "entity-structured-data-specialist",
  "search-performance-engineer",
  "search-policy-compliance-officer",
] as const;
export type AgentId = (typeof CANONICAL_AGENTS)[number];
export type SpecialistId = Exclude<AgentId, "chief-search-strategist" | "search-policy-compliance-officer">;

// --- maliyet korumasi (kodda zorlanir, yapilandirma ile gevsetilemez) --------------------------
export const MAX_SPECIALISTS = 3;
/** 3 uzman + 1 Chief + 1 uyum incelemesi. */
export const MAX_API_CALLS = 5;
// Uzman tavani iki canli pilotta kesildi: 2000/2000 (MALFORMED_JSON) ve 4000/4000 (stop_reason=max_tokens, MODEL_OUTPUT_TRUNCATED).
// Phase 2C.2 = daha fazla token (6000) + SINIRLI cikti (asagidaki uzman limitleri). Chief ve uyum tavanlari, cagri sayisi ve uzman sayisi degismedi.
export const OUTPUT_TOKEN_CAPS = { specialist: 6000, chief: 5000, compliance: 1500 } as const;

/** Uzman ciktisinin deterministik ust sinirlari. Asan cikti INVALID_OUTPUT'tur; sessiz kesme YOK. Chief bu limitlere tabi degildir. */
export const MAX_FINDINGS_PER_SPECIALIST = 5;
export const SPECIALIST_FIELD_LIMITS = { title: 120, summary: 500, impact: 300, recommended_action: 300, verification_plan: 300, risk: 120, category: 60 } as const;
export const MAX_SPECIALIST_UNKNOWNS = 5;
export const MAX_SPECIALIST_CONFLICTS = 5;

/** Chief nihai sentezi (Phase 2C final): canli pilot 6'da Chief 3000 tokenda kesildi (stop_reason=max_tokens). Tavan 5000 + SINIRLI cikti.
 *  Alan sinirlari uzmanla ayni sayilardir ama bagimsiz sabitlerdir (uzman donduruldu). Asan cikti INVALID_OUTPUT; sessiz kesme YOK. */
export const MAX_CHIEF_FINDINGS = 5;
export const CHIEF_FIELD_LIMITS = { title: 120, summary: 500, impact: 300, recommended_action: 300, verification_plan: 300, risk: 120, category: 60 } as const;
// unknowns/conflicts bilincli dar tutulur: 5 bulgu alan tavanlarinda iken en kotu durum cikti 5000 token tavanina sigsin (bkz. docs, testle kilitli).
export const MAX_CHIEF_UNKNOWNS = 3;
export const MAX_CHIEF_CONFLICTS = 2;
export const CHIEF_UNKNOWN_CHARS = 150;
export const CHIEF_CONFLICT_CHARS = 200;

/** Uyum incelemesi KISA karardir (bulgulari yeniden yazmaz): en fazla 5 inceleme (= Chief bulgu tavani), gerekce <= 300 karakter.
 *  1500 token tavani bu sinirlarla yeterlidir: bkz. docs/brain/cloud-brain.md (en kotu durum hesabi, testle kilitli). */
export const MAX_COMPLIANCE_REVIEWS = MAX_CHIEF_FINDINGS;
export const COMPLIANCE_REASON_MAX_CHARS = 300;

/** Her bulgunun ZORUNLU alanlari (BrainFinding + brain-agent-result.schema.json ile ayni; site_id basta). Istem bu listeden uretilir. */
export const FINDING_REQUIRED_FIELDS = [
  "site_id", "finding_id", "title", "category", "evidence_ids", "evidence_label", "confidence", "summary", "impact", "recommended_action", "actionability", "risk", "verification_plan",
] as const;

/** Dogrulama tani ayrintisi (Phase 2C.4). YALNIZ sinirli, guvenli alanlar: ham tamamlama/istem/sir YOK. */
export const MAX_VIOLATION_DETAILS = 10;
export const MAX_DETAIL_PATH_CHARS = 160;
export const MAX_DETAIL_OBSERVED_CHARS = 120;
export const MAX_DETAIL_EVIDENCE_IDS = 10;
export const VIOLATION_DETAIL_KEYS = ["code", "path", "expected", "observed", "evidence_ids_checked", "reason", "corpus_size"] as const;
export interface ViolationDetail {
  code: string;
  /** JSON yolu, ornek `$.site_id` / `$.findings[0].summary`. */
  path: string;
  expected?: string;
  /** Modelin urettigi deger; en fazla 120 karakter, sir icerirse yazilmaz. */
  observed?: string;
  evidence_ids_checked?: string[];
  /** Kisa kural kodu (ornek NOT_IN_CITED_EVIDENCE); serbest metin degil. */
  reason?: string;
  /** Destek aranan kanit zarflarindaki farkli sayi adedi. */
  corpus_size?: number;
}
export const SPECIALIST_UNKNOWN_CHARS = 200;
export const SPECIALIST_CONFLICT_CHARS = 300;

/** Anthropic'in bildirdigi durma nedeni. Bilinmeyen/eksik deger "UNKNOWN"a indirgenir; ham yanit saklanmaz. */
export const STOP_REASONS = ["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "UNKNOWN"] as const;
export type StopReason = (typeof STOP_REASONS)[number];
/** Model ciktisi token tavaninda kesildi: HTTP 200 olsa bile gecerli tamamlama sayilmaz. */
export const MODEL_OUTPUT_TRUNCATED = "MODEL_OUTPUT_TRUNCATED";
/** Modele giden sikistirilmis kanit paketinin ust siniri (serilestirilmis bayt). */
export const MAX_EVIDENCE_BYTES_PER_RUN = 60_000;
/** Tek bir kanit kaydinin sikistirma sonrasi ust siniri. */
export const MAX_EVIDENCE_BYTES_PER_ITEM = 8_000;
export const MAX_EVIDENCE_ITEMS = 40;

export const HANDOFF_SCHEMA = "sgos.brain.handoff.v1";

/** Kanitin hangi workflow/kosu/artifact'tan geldigi. ADDITIVE ve istege bagli: yoksa zarf degismez. Alanlar
 *  yalniz katı kalip dogrulanmis kimlik/zaman degerleridir; GitHub'dan gelen serbest metin (baslik,
 *  commit mesaji, dal aciklamasi...) buraya ASLA girmez ve talimat olarak yorumlanmaz. */
export interface EvidenceProvenance {
  handoff: typeof HANDOFF_SCHEMA;
  source_workflow: string;
  source_run_id: string;
  source_run_attempt: number | "UNKNOWN";
  source_head_sha: string;
  source_artifact_name: string;
  source_artifact_id: string;
  source_artifact_digest: string | "UNKNOWN";
  source_measured_at: string;
  handoff_run_id: string | "UNKNOWN";
}
export const PROVENANCE_KEYS = ["handoff", "source_workflow", "source_run_id", "source_run_attempt", "source_head_sha", "source_artifact_name", "source_artifact_id", "source_artifact_digest", "source_measured_at", "handoff_run_id"] as const;

export interface EvidenceEnvelope {
  schema: typeof EVIDENCE_SCHEMA;
  evidence_id: string;
  site_id: string;
  source: EvidenceSource;
  source_ref: string;
  /** UTC ISO-8601. */
  measured_at: string;
  measurement_state: MeasurementState;
  evidence_label: EvidenceLabel;
  confidence: Confidence;
  category: EvidenceCategory;
  payload: Record<string, unknown>;
  /** Istege bagli, additive: artifact devrinden geldiyse kaynak izi. */
  provenance?: EvidenceProvenance;
}

export interface EvidenceBundle {
  schema: typeof EVIDENCE_BUNDLE_SCHEMA;
  site_id: string;
  evidence: EvidenceEnvelope[];
}

export interface BrainFinding {
  finding_id: string;
  site_id: string;
  title: string;
  category: string;
  evidence_ids: string[];
  evidence_label: EvidenceLabel;
  confidence: Confidence;
  summary: string;
  impact: string;
  recommended_action: string;
  actionability: Actionability;
  risk: string;
  verification_plan: string;
}

export interface BrainConflict {
  description: string;
  evidence_ids: string[];
}

export interface AgentResult {
  schema: typeof AGENT_RESULT_SCHEMA;
  agent_id: AgentId;
  site_id: string;
  findings: BrainFinding[];
  unknowns: string[];
  conflicts: BrainConflict[];
}

export type ComplianceVerdict = "PASS" | "FLAG" | "REJECT";
export interface ComplianceReview { finding_id: string; verdict: ComplianceVerdict; reason: string; reviewed_by: "deterministic_gate" | "search-policy-compliance-officer" }

/** Nihai bulgu = Chief'in dogrulanmis bulgusu + uyum sonucu. `execution_candidate` yalnizca
 *  DRAFT_PR_CANDIDATE etiketli VE uyumdan PASS almis bulgu icin true'dur; bu fazda "aday"
 *  yalnizca bir etikettir, uygulanacak bir sey yoktur. */
export interface FinalFinding extends BrainFinding {
  compliance: ComplianceReview | null;
  execution_candidate: boolean;
}

export type TraceStatus = "OK" | "INVALID_OUTPUT" | "ERROR" | "SKIPPED";
export interface AgentTrace {
  agent_id: AgentId;
  role: "specialist" | "chief" | "compliance";
  started_at: string;
  completed_at: string;
  status: TraceStatus;
  input_evidence_ids: string[];
  output_finding_ids: string[];
  error_code: string | null;
  /** Reddedilen cikti icin ihlal kodlari (metin icermez). */
  violations: string[];
  /** `violations`a EK (additive): hangi yol/deger reddedildi. Eski alan `violations: string[]` aynen korunur. */
  violation_details: ViolationDetail[];
  http_status: number | null;
  /** Yanit alinmadiysa null; alindiysa normalize edilmis durma nedeni. */
  stop_reason: StopReason | null;
  input_tokens: number | "UNKNOWN";
  output_tokens: number | "UNKNOWN";
  /** Yuklenen profil govdesinin sha256'si: hangi talimatla kosuldugunun izi, talimatin kendisi degil. */
  profile_sha256: string;
}

export interface CostGuard {
  max_calls: number;
  calls_used: number;
  max_specialists: number;
  specialists_called: number;
  evidence_bytes: number;
  output_token_caps: { specialist: number; chief: number; compliance: number };
  /** Yalniz API'nin kendi `usage` alanindan; yoksa "UNKNOWN". */
  input_tokens_measured: number | "UNKNOWN";
  output_tokens_measured: number | "UNKNOWN";
  /** Fiyat tarifesi burada bilinmiyor: tahmin yazilmaz. */
  estimated_cost_usd: "UNKNOWN";
}

export interface AgentConsidered { agent_id: AgentId; decision: "CALLED" | "NOT_ROUTED" | "SPECIALIST_CAP" | "NOT_CONFIGURED" | "SKIPPED"; reason: string }

export interface BrainRecommendation { finding_id: string; recommended_action: string; actionability: Actionability; execution_candidate: boolean; compliance_verdict: ComplianceVerdict | "NOT_REVIEWED" }

export interface BrainRun {
  schema: typeof RUN_SCHEMA;
  run_id: string;
  site_id: string;
  started_at: string;
  completed_at: string;
  status: RunStatus;
  /** NOT_CONFIGURED / ERROR / PARTIAL icin nedenin kisa kodu. */
  status_reason: string | null;
  input_evidence_ids: string[];
  agents_considered: AgentConsidered[];
  agents_called: AgentId[];
  agent_results: AgentResult[];
  agent_trace: AgentTrace[];
  findings: FinalFinding[];
  recommendations: BrainRecommendation[];
  unknowns: string[];
  conflicts: BrainConflict[];
  cost_guard: CostGuard;
  /** Bu fazda her zaman false: brain hicbir seye yazmaz. */
  production_write: false;
}

export const FINDING_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
