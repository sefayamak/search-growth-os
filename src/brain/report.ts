// Brain calismasi -> okunur Markdown. Prompt metni, ham yanit, anahtar YOK: yalniz izler, kodlar, bulgular.
import type { BrainRun } from "./contracts.ts";

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
    L.push("## Çağrı izi", "", "| ajan | rol | durum | HTTP | hata | ihlaller | çıktı bulguları |", "|---|---|---|---|---|---|---|");
    for (const t of run.agent_trace) L.push(`| ${t.agent_id} | ${t.role} | ${t.status} | ${t.http_status ?? "—"} | ${t.stop_reason ?? "—"} | ${t.error_code ?? "—"} | ${t.violations.join(", ") || "—"} | ${t.output_finding_ids.join(", ") || "—"} |`);
    L.push("");
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
