// Brain calismasi -> okunur Markdown. Prompt metni, ham yanit, anahtar YOK: yalniz izler, kodlar, bulgular.
import {
  MAX_DETAIL_EVIDENCE_IDS, MAX_DETAIL_OBSERVED_CHARS, MAX_DETAIL_PATH_CHARS, MAX_VIOLATION_DETAILS, VIOLATION_DETAIL_KEYS, type BrainRun, type ViolationDetail,
} from "./contracts.ts";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function brainRunToMarkdown(run: BrainRun): string {
  const g = run.cost_guard;
  const L: string[] = [
    `# Search Growth Brain — ${run.site_id}`, "",
    `Durum: **${run.status}**${run.status_reason ? ` (${run.status_reason})` : ""} · run \`${run.run_id}\``, "",
    "Bu rapor yalnızca verilen kanıttan akıl yürütür. Hiçbir şey yazılmadı, yayınlanmadı, PR açılmadı (`production_write: false`). `DRAFT_PR_CANDIDATE` yalnızca bir etikettir.", "",
    "## Maliyet koruması", "",
    `- API çağrısı: ${g.calls_used}/${g.max_calls} · uzman: ${g.specialists_called}/${g.max_specialists} · kanıt: ${g.evidence_bytes} bayt`,
    `- Ölçülen token (API \`usage\`): giriş ${g.input_tokens_measured}, çıkış ${g.output_tokens_measured} · tahmini maliyet: ${g.estimated_cost_usd}`, "",
    "## Ajan kararı", "", "| ajan | karar | neden |", "|---|---|---|",
    ...run.agents_considered.map((a) => `| ${a.agent_id} | ${a.decision} | ${cell(a.reason)} |`), "",
  ];
  if (run.agent_trace.length) {
    L.push("## Çağrı izi", "", "| ajan | rol | durum | HTTP | stop_reason | hata | ihlaller | çıktı bulguları |", "|---|---|---|---|---|---|---|---|");
    for (const t of run.agent_trace) L.push(`| ${t.agent_id} | ${t.role} | ${t.status} | ${t.http_status ?? "—"} | ${t.stop_reason ?? "—"} | ${t.error_code ?? "—"} | ${t.violations.join(", ") || "—"} | ${t.output_finding_ids.join(", ") || "—"} |`);
    L.push("");
    const dl = run.agent_trace.flatMap((t) => (t.violation_details ?? []).map((d) => `- ${t.agent_id}: ${detailLine(d)}`));
    if (dl.length) L.push("## Doğrulama ayrıntıları", "", ...dl, "");
  }
  L.push("## Bulgular", "");
  if (!run.findings.length) L.push("Bulgu yok.", "");
  for (const f of run.findings) {
    L.push(`### ${f.title}`, "",
      `- \`${f.finding_id}\` · ${f.evidence_label} / ${f.confidence} · ${f.category} · **${f.actionability}**${f.execution_candidate ? " (uyum PASS: aday etiketi)" : ""}`,
      `- Kanıt: ${f.evidence_ids.map((i) => `\`${i}\``).join(", ")}`,
      `- Uyum: ${f.compliance ? `${f.compliance.verdict} (${f.compliance.reviewed_by}) — ${cell(f.compliance.reason)}` : "NOT_REVIEWED"}`,
      "", f.summary, "", `**Etki:** ${f.impact}`, "", `**Önerilen eylem:** ${f.recommended_action}`, "", `**Risk:** ${f.risk}`, "", `**Doğrulama planı:** ${f.verification_plan}`, "");
  }
  L.push("## Bilinmeyenler", "");
  L.push(...(run.unknowns.length ? run.unknowns.map((u) => `- ${u}`) : ["- yok"]), "");
  if (run.conflicts.length) { L.push("## Çelişkiler", "", ...run.conflicts.map((c) => `- ${c.description} (${c.evidence_ids.join(", ")})`), ""); }
  return L.join("\n");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const safe = (v: unknown, n: number) => clip(String(v).replace(/[\u0000-\u001f\u007f`|]+/g, " "), n);

/** Tek satir: kod yol expected/observed. Dosyadan okunan veri de burada yeniden sinirlanir (yalniz izinli alanlar). */
export function detailLine(d: ViolationDetail): string {
  const parts = [`\`${safe(d.code, 40)}\``, `\`${safe(d.path, MAX_DETAIL_PATH_CHARS)}\``];
  if (d.expected !== undefined) parts.push(`beklenen=\`${safe(d.expected, MAX_DETAIL_OBSERVED_CHARS)}\``);
  if (d.observed !== undefined) parts.push(`gözlenen=\`${safe(d.observed, MAX_DETAIL_OBSERVED_CHARS)}\``);
  if (d.reason !== undefined) parts.push(`neden=\`${safe(d.reason, 60)}\``);
  if (typeof d.corpus_size === "number") parts.push(`kanıttaki_sayı_adedi=${d.corpus_size}`);
  if (Array.isArray(d.evidence_ids_checked)) parts.push(`bakılan_kanıt=[${d.evidence_ids_checked.slice(0, MAX_DETAIL_EVIDENCE_IDS).map((i) => safe(i, 80)).join(", ")}]`);
  return parts.join(" ");
}

/** GitHub Actions Ozet adimi icin guvenli iz ozeti. Ham tamamlama, istem, anahtar YOK; yalniz izin verilen alanlar, her deger sinirli. */
export function traceSummaryMarkdown(trace: unknown): string {
  if (!Array.isArray(trace)) return "agent-trace okunamadı (dizi değil).";
  if (!trace.length) return "agent-trace boş: hiçbir ajan çağrılmadı.";
  const L: string[] = ["### Ajan izi (güvenli özet)", ""];
  for (const t of trace as Record<string, unknown>[]) {
    if (!t || typeof t !== "object") continue;
    const viol = Array.isArray(t.violations) ? (t.violations as unknown[]).slice(0, 20).map((x) => safe(x, 60)).join(", ") : "";
    L.push(`- **${safe(t.agent_id, 60)}** (${safe(t.role, 20)}): status=${safe(t.status, 20)} error_code=${t.error_code == null ? "null" : safe(t.error_code, 60)} http_status=${t.http_status == null ? "null" : safe(t.http_status, 10)} stop_reason=${t.stop_reason == null ? "null" : safe(t.stop_reason, 20)} input_tokens=${safe(t.input_tokens, 12)} output_tokens=${safe(t.output_tokens, 12)}`);
    L.push(`  - violations: ${viol || "—"}`);
    const det = Array.isArray(t.violation_details) ? (t.violation_details as Record<string, unknown>[]).slice(0, MAX_VIOLATION_DETAILS) : [];
    for (const d of det) {
      if (!d || typeof d !== "object") continue;
      const picked = Object.fromEntries(Object.entries(d).filter(([k]) => (VIOLATION_DETAIL_KEYS as readonly string[]).includes(k))) as unknown as ViolationDetail;
      L.push(`  - ${detailLine(picked)}`);
    }
  }
  return L.join("\n");
}
