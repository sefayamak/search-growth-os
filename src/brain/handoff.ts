// Clarity artifact -> Brain kanit paketi (sgos.brain.evidence.v1) devri. YEREL, AG YOK: workflow GitHub'dan
// run/artifact metadatasini ve artifact'in kendisini dosya olarak indirir; bu modul o dosyalari DOGRULAR.
//
// Tasarim:
//   * Secim BELIRSIZ degildir: acik bir run kimligi (`clarity_run_id`). "En son artifact" yok.
//   * Run, bu reponun `clarity.yml` workflow'unun, `main` uzerindeki, elle tetiklenmis ve BASARILI bir
//     kosusu olmak zorunda; artifact adi `clarity-<run_id>` ve ayni run'a (id + head_sha) ait olmak zorunda.
//   * Yalniz secilen sitenin `clarity-<site>.json` dosyasi okunur. Ayni artifact baska sitelerin dosyalarini
//     da tasiyabilir; onlar ACILMAZ. Dosyanin icindeki `site_id` secilen siteyle ayni degilse FAIL.
//   * Artifact yoksa/suresi dolduysa/dosya yoksa NOT_AVAILABLE (acik durum; sahte veri yok).
//   * GitHub metadata ve artifact icerigi VERIDIR, talimat degil: provenance'a yalniz katı kalipli kimlik/zaman
//     alanlari girer; baslik, commit mesaji gibi serbest metin hicbir yere kopyalanmaz.
//   * Hicbir sey depoya yazilmaz; model cagrisi yok.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaritySiteResult } from "../adapters/clarity.ts";
import type { SiteEntry } from "../registry.ts";
import { HANDOFF_SCHEMA, EVIDENCE_BUNDLE_SCHEMA, type EvidenceBundle, type EvidenceProvenance } from "./contracts.ts";
import { containsSecret, evidenceFromClarity, evidenceFromRegistry, isUsable, parseEvidenceBundle, validateProvenance } from "./evidence.ts";

export const CLARITY_WORKFLOW_PATH = ".github/workflows/clarity.yml";
export const HANDOFF_STATUS_SCHEMA = "sgos.brain.handoff-status.v1";
const MAX_CLARITY_FILE_BYTES = 2_000_000;

export type HandoffState = "OK" | "NOT_AVAILABLE" | "FAILED";
export interface HandoffInput {
  siteId: string;
  site: SiteEntry;
  runId: string;
  /** "owner/repo" — run ve artifact BU depodan olmak zorunda. */
  repo: string;
  /** Indirilmis artifact'in acildigi dizin. */
  artifactDir: string;
  /** `gh api repos/<repo>/actions/runs/<id>` ciktisi. */
  runMetaPath: string;
  /** `gh api repos/<repo>/actions/runs/<id>/artifacts` ciktisi. */
  artifactsMetaPath: string;
  handoffRunId?: string;
  now?: () => Date;
}
export interface HandoffResult {
  schema: typeof HANDOFF_STATUS_SCHEMA;
  state: HandoffState;
  /** Kisa makine kodu; icerik/sir tasimaz. */
  code: string | null;
  site_id: string;
  source_run_id: string;
  /** Kanit kullanilabilir mi (MEASURED/PARTIAL)? ERROR/NOT_CONNECTED olcum "OK devir" ama kullanilamaz. */
  usable: boolean | null;
  /** Yalniz kod listesi (EVIDENCE_REJECTED icin). */
  detail: string[];
  bundle?: EvidenceBundle;
  provenance?: EvidenceProvenance;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readJson(path: string): { state: "missing" } | { state: "invalid" } | { state: "ok"; value: unknown } {
  if (!existsSync(path)) return { state: "missing" };
  try { return { state: "ok", value: JSON.parse(readFileSync(path, "utf8")) }; } catch { return { state: "invalid" }; }
}

/** Clarity adaptor sozlesmesi (sgos.clarity.v1). Olculememis sonucun sayi tasimasi bile sozlesme ihlalidir. */
export function validateClarityContract(c: unknown): string[] {
  if (!isObj(c)) return ["NOT_AN_OBJECT"];
  const e: string[] = [];
  if (c.schema !== "sgos.clarity.v1") e.push("BAD_SCHEMA");
  if (c.source !== "microsoft_clarity_data_export_api") e.push("BAD_SOURCE");
  if (typeof c.site_id !== "string" || !/^[a-z0-9]+$/.test(c.site_id)) e.push("BAD_SITE_ID");
  if (c.evidence_label !== "FACT") e.push("BAD_EVIDENCE_LABEL");
  if (!["MEASURED", "PARTIAL", "ERROR", "NOT_CONNECTED"].includes(c.measurement_state as string)) e.push("BAD_MEASUREMENT_STATE");
  if (!["CONFIRMED", "CANDIDATE", "UNKNOWN"].includes(c.confidence as string)) e.push("BAD_CONFIDENCE");
  if (typeof c.measured_at !== "string" || Number.isNaN(Date.parse(c.measured_at))) e.push("BAD_MEASURED_AT");
  if (c.window_days !== 1) e.push("BAD_WINDOW");
  if (!Array.isArray(c.requests) || !Array.isArray(c.metrics)) e.push("BAD_SHAPE");
  else {
    const usable = c.measurement_state === "MEASURED" || c.measurement_state === "PARTIAL";
    if (usable && c.requests.length === 0) e.push("USABLE_WITHOUT_REQUESTS");
    if (!usable && (c.metrics.length > 0 || (typeof c.row_count === "number"))) e.push("NUMBERS_WITHOUT_MEASUREMENT");
    if (!usable && c.confidence !== "UNKNOWN") e.push("BAD_CONFIDENCE");
  }
  return e;
}

const result = (i: HandoffInput, state: HandoffState, code: string | null, extra: Partial<HandoffResult> = {}): HandoffResult =>
  ({ schema: HANDOFF_STATUS_SCHEMA, state, code, site_id: i.siteId, source_run_id: i.runId, usable: null, detail: [], ...extra });

export function runHandoff(i: HandoffInput): HandoffResult {
  const fail = (code: string, detail: string[] = []) => result(i, "FAILED", code, { detail });
  const na = (code: string) => result(i, "NOT_AVAILABLE", code);

  if (!/^[a-z0-9]+$/.test(i.siteId) || i.site.id !== i.siteId) return fail("INVALID_INPUT");
  if (!/^\d{1,20}$/.test(i.runId) || !/^[A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*$/.test(i.repo)) return fail("INVALID_INPUT");
  if (i.handoffRunId !== undefined && !/^\d{1,20}$/.test(i.handoffRunId)) return fail("INVALID_INPUT");
  const name = `clarity-${i.runId}`;

  // 1) run: bu reponun clarity.yml'inin main uzerindeki basarili, elle tetiklenmis kosusu mu?
  const rm = readJson(i.runMetaPath);
  if (rm.state === "missing") return na("RUN_NOT_AVAILABLE");
  if (rm.state === "invalid" || !isObj(rm.value)) return fail("RUN_META_INVALID");
  const run = rm.value;
  if (String(run.id) !== i.runId) return fail("RUN_ID_MISMATCH");
  if (run.path !== CLARITY_WORKFLOW_PATH) return fail("RUN_NOT_CLARITY_WORKFLOW");
  if (run.event !== "workflow_dispatch") return fail("RUN_EVENT_NOT_DISPATCH");
  if (run.status !== "completed") return fail("RUN_NOT_COMPLETED");
  if (run.conclusion !== "success") return fail("RUN_NOT_SUCCESS");
  if (run.head_branch !== "main") return fail("RUN_NOT_MAIN");
  const repoOf = (k: string) => (isObj(run[k]) ? (run[k] as Record<string, unknown>).full_name : undefined);
  if (repoOf("repository") !== i.repo || repoOf("head_repository") !== i.repo) return fail("RUN_FOREIGN_REPOSITORY");
  if (typeof run.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(run.head_sha)) return fail("RUN_META_INVALID");

  // 2) artifact: ad TAM `clarity-<run_id>`, ayni run'a ait, suresi dolmamis.
  const am = readJson(i.artifactsMetaPath);
  if (am.state === "missing") return na("ARTIFACT_LIST_NOT_AVAILABLE");
  if (am.state === "invalid" || !isObj(am.value) || !Array.isArray(am.value.artifacts)) return fail("ARTIFACTS_META_INVALID");
  const found = (am.value.artifacts as unknown[]).filter((a): a is Record<string, unknown> => isObj(a) && a.name === name);
  if (found.length === 0) return na("ARTIFACT_NOT_AVAILABLE");
  if (found.length > 1) return fail("ARTIFACT_AMBIGUOUS");
  const art = found[0];
  if (art.expired === true) return na("ARTIFACT_EXPIRED");
  const wr = isObj(art.workflow_run) ? art.workflow_run : null;
  if (!wr || String(wr.id) !== i.runId || wr.head_sha !== run.head_sha) return fail("ARTIFACT_RUN_MISMATCH");
  if (!/^\d{1,20}$/.test(String(art.id))) return fail("ARTIFACTS_META_INVALID");

  // 3) yalniz secilen sitenin dosyasi; baska sitelerin dosyalari ACILMAZ.
  const target = [join(i.artifactDir, "clarity-out", `clarity-${i.siteId}.json`), join(i.artifactDir, `clarity-${i.siteId}.json`)].find((p) => existsSync(p));
  if (!target) return na("CLARITY_FILE_NOT_AVAILABLE");
  const st = lstatSync(target);
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_CLARITY_FILE_BYTES) return fail("CLARITY_FILE_UNSAFE");
  const text = readFileSync(target, "utf8");
  if (containsSecret(text)) return fail("CLARITY_SECRET_DETECTED");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail("CLARITY_JSON_INVALID"); }
  if (isObj(parsed) && typeof parsed.site_id === "string" && parsed.site_id !== i.siteId) return fail("FOREIGN_SITE_ARTIFACT");
  const contract = validateClarityContract(parsed);
  if (contract.length) return fail("CLARITY_CONTRACT_INVALID", contract);
  const clarity = parsed as unknown as ClaritySiteResult;

  // 4) provenance: yalniz dogrulanmis kimlik/zaman. Serbest metin (baslik, mesaj, not) KOPYALANMAZ.
  const digest = typeof art.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(art.digest) ? art.digest : "UNKNOWN";
  const provenance: EvidenceProvenance = {
    handoff: HANDOFF_SCHEMA, source_workflow: CLARITY_WORKFLOW_PATH, source_run_id: i.runId,
    source_run_attempt: Number.isInteger(run.run_attempt) && (run.run_attempt as number) >= 1 ? (run.run_attempt as number) : "UNKNOWN",
    source_head_sha: run.head_sha, source_artifact_name: name, source_artifact_id: String(art.id), source_artifact_digest: digest,
    source_measured_at: clarity.measured_at, handoff_run_id: i.handoffRunId ?? "UNKNOWN",
  };
  const perr = validateProvenance(provenance);
  if (perr.length) return fail("PROVENANCE_INVALID", perr);

  // 5) olculememis sonuc: serbest metin notu da dusulur; payload zaten yalniz durum + hata kodu tasir.
  const sanitized: ClaritySiteResult = clarity.measurement_state === "ERROR" || clarity.measurement_state === "NOT_CONNECTED"
    ? { ...clarity, note: undefined, requests: [], metrics: [] } : clarity;
  const now = (i.now ?? (() => new Date()))().toISOString();
  const clarityEv = evidenceFromClarity(sanitized, { source_ref: `github-actions:clarity.yml:run/${i.runId}:artifact/${name}`, provenance });
  const parsedBundle = parseEvidenceBundle({ schema: EVIDENCE_BUNDLE_SCHEMA, site_id: i.siteId, evidence: [evidenceFromRegistry(i.site, now), clarityEv] }, i.siteId);
  if (!parsedBundle.ok || !parsedBundle.bundle) return fail("EVIDENCE_REJECTED", parsedBundle.errors);
  return result(i, "OK", null, { usable: isUsable(clarityEv), bundle: parsedBundle.bundle, provenance });
}
