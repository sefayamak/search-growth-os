// Brain bellegi: sozlesme + okuma/ekleme kutuphanesi. Bu fazda VARSAYILAN olarak diske KALICI YAZMA YOK.
//
// Bellek, brain'in ileride "ne onerdim, ne oldu" sorusunu ogrenebilmesi icin vardir. Ama:
//   * workflow repoya bellek COMMIT ETMEZ (brain.yml contents: read),
//   * `appendMemory` acik `write: true` kapisi olmadan HICBIR SEY yazmaz (CLI: --write-memory),
//   * bir sitenin belleği yalniz kendi dosyasina (`brain/memory/<site>.jsonl`) gider.
// Kalici bulut bellegi daha sonraki, guvenli bir dilimde acilacak.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_SCHEMA, type BrainRun } from "./contracts.ts";

export const MEMORY_STATUSES = ["OPEN", "WAITING_FOR_RESULT", "VERIFIED_POSITIVE", "VERIFIED_NEGATIVE", "INCONCLUSIVE", "REJECTED"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface MemoryEntry {
  schema: typeof MEMORY_SCHEMA;
  memory_id: string;
  site_id: string;
  created_at: string;
  finding_id: string;
  action: string;
  expected_signal: string;
  /** Sonuc henuz olculmediyse "UNKNOWN": beklenen sinyal gerceklesmis gibi yazilmaz. */
  observed_result: string;
  status: MemoryStatus;
  evidence_ids: string[];
}

const SITE_RE = /^[a-z0-9]+$/;
export const memoryPath = (root: string, siteId: string) => {
  if (!SITE_RE.test(siteId)) throw new Error("gecersiz site kimligi");
  return join(root, "brain", "memory", `${siteId}.jsonl`);
};

export function validateMemoryEntry(raw: unknown, siteId: string): string[] {
  const e = raw as Partial<MemoryEntry> | null;
  const errors: string[] = [];
  if (!e || typeof e !== "object") return ["INVALID_ENTRY"];
  if (e.schema !== MEMORY_SCHEMA) errors.push("INVALID_SCHEMA");
  for (const k of ["memory_id", "finding_id", "action", "expected_signal", "observed_result"] as const) if (typeof e[k] !== "string" || !e[k]) errors.push(`INVALID_${k.toUpperCase()}`);
  if (e.site_id !== siteId) errors.push("FOREIGN_SITE_MEMORY");
  if (typeof e.created_at !== "string" || Number.isNaN(Date.parse(e.created_at))) errors.push("INVALID_CREATED_AT");
  if (!(MEMORY_STATUSES as readonly string[]).includes(e.status as string)) errors.push("INVALID_STATUS");
  if (!Array.isArray(e.evidence_ids) || !e.evidence_ids.length || !e.evidence_ids.every((x) => typeof x === "string")) errors.push("INVALID_EVIDENCE_IDS");
  return errors;
}

export function parseMemoryJsonl(text: string, siteId: string): { entries: MemoryEntry[]; errors: string[] } {
  const entries: MemoryEntry[] = []; const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let v: unknown;
    try { v = JSON.parse(line); } catch { errors.push(`BAD_JSON@${i + 1}`); return; }
    const errs = validateMemoryEntry(v, siteId);
    if (errs.length) errors.push(...errs.map((c) => `${c}@${i + 1}`)); else entries.push(v as MemoryEntry);
  });
  return { entries, errors };
}

export function readMemory(root: string, siteId: string): { entries: MemoryEntry[]; errors: string[] } {
  const p = memoryPath(root, siteId);
  return existsSync(p) ? parseMemoryJsonl(readFileSync(p, "utf8"), siteId) : { entries: [], errors: [] };
}

/** Kalici ekleme. `write: true` verilmeden ASLA yazmaz (varsayilan: salt-okunur). */
export function appendMemory(root: string, entry: MemoryEntry, gate: { write: boolean }): string {
  if (gate.write !== true) throw new Error("bellek yazimi kapali: acik --write-memory kapisi gerekli");
  const errs = validateMemoryEntry(entry, entry.site_id);
  if (errs.length) throw new Error(`gecersiz bellek kaydi: ${errs.join(", ")}`);
  const p = memoryPath(root, entry.site_id);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
  return p;
}

/** Bir calismadan bellek ADAYLARI uretir; diske yazmaz. REJECT olan oneriler REJECTED olarak kaydedilir. */
export function memoryEntriesFromRun(run: BrainRun): MemoryEntry[] {
  return run.findings.map((f) => ({
    schema: MEMORY_SCHEMA,
    memory_id: `mem-${run.run_id}-${f.finding_id}`.slice(0, 120),
    site_id: run.site_id,
    created_at: run.completed_at,
    finding_id: f.finding_id,
    action: f.recommended_action,
    expected_signal: f.verification_plan,
    observed_result: "UNKNOWN",
    status: f.compliance?.verdict === "REJECT" ? "REJECTED" : "OPEN",
    evidence_ids: f.evidence_ids,
  }));
}
