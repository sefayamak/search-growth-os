// Test yardimcisi: `node --import <bu dosya> src/cli.ts brain-run ...` ile globalThis.fetch'i SAHTE bir Anthropic
// sunucusuyla degistirir. Gercek agaya HIC cikilmaz. Her cagri FAKE_ANTHROPIC_LOG dosyasina bir JSON satiri olarak yazilir
// (istem/yanit govdesi degil; yalniz test'in dogrulamasi icin gereken meta). FAKE_MODE senaryoyu secer.
import { appendFileSync } from "node:fs";

const LOG = process.env.FAKE_ANTHROPIC_LOG;
const MODE = process.env.FAKE_MODE ?? "ok";
const KEY = process.env.SEARCH_GROWTH_ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.SEARCH_GROWTH_ANTHROPIC_MODEL ?? "";
const RAW_MARK = "RAW-COMPLETION-MARKER-XYZ";

const findingBase = (agent, ids, over = {}) => ({
  finding_id: `${agent.slice(0, 8)}-finding-1`, site_id: "pamistanbul", title: "Davranis kaniti incelendi", category: "behavior", evidence_ids: ids,
  evidence_label: "INFERENCE", confidence: "CANDIDATE", summary: "Clarity kaniti davranis sinyali tasiyor.", impact: "Kullanici deneyimi icin onemli olabilir.",
  recommended_action: "Insan incelemesi ile dogrula.", actionability: "HUMAN_REVIEW", risk: "Dusuk.", verification_plan: "Sonraki olcumde karsilastir.", ...over,
});
const result = (agent, findings) => JSON.stringify({ schema: "sgos.brain.agent-result.v1", agent_id: agent, site_id: "pamistanbul", findings, unknowns: ["Baska kaynaklar baglanmadi"], conflicts: [] });

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const agent = /^AGENT_ID: (.+)$/m.exec(body.system)?.[1] ?? "?";
  const role = /^ROLE: (.+)$/m.exec(body.system)?.[1] ?? "?";
  const user = body.messages[0].content;
  const ids = [...user.matchAll(/"evidence_id":"([^"]+)"/g)].map((m) => m[1]).filter((i) => !i.includes("-registry-"));
  appendFileSync(LOG, JSON.stringify({
    url, agent, role, mode: MODE, keyInHeaderOnly: init.headers["x-api-key"] === KEY && !init.body.includes(KEY) && !body.system.includes(KEY),
    modelFromEnv: body.model === MODEL, maxTokens: body.max_tokens, hasDataBlock: user.includes("<EVIDENCE_DATA_BLOCK>"),
    systemHasEvidence: ids.some((i) => body.system.includes(i)),
  }) + "\n");
  // Varsayilan durma nedeni end_turn; FAKE_MODE "truncated-*" / "unknown-stop" modlari bunu degistirir.
  const stop = MODE === "truncated-malformed" || MODE === "truncated-valid" || (MODE === "chief-truncated" && role === "chief") || (MODE === "compliance-truncated" && role === "compliance") ? "max_tokens" : MODE === "unknown-stop" ? "brand_new_reason" : "end_turn";
  const reply = (status, text) => ({ status, text: async () => (status === 200 ? JSON.stringify({ content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 111, output_tokens: 22 } }) : "{}") });
  if (MODE === "429") return reply(429, "");
  if (MODE === "500") return reply(500, "");
  if (role === "specialist") {
    if (MODE === "truncated-malformed") return reply(200, `${RAW_MARK} {"schema":"sgos.brain.agent-result.v1","findings":[{"finding_id":"x`);
    if (MODE === "truncated-valid") return reply(200, result(agent, [findingBase(agent, ids.slice(0, 1))]));
    if (MODE === "malformed") return reply(200, `${RAW_MARK} bu JSON degil sk-ant-LEAKLEAKLEAK1234567890 {`);
    if (MODE === "invented-number") return reply(200, result(agent, [findingBase(agent, ids.slice(0, 1), { summary: "Oturum sayisi 4711 olarak gorunuyor." })]));
    if (MODE === "unknown-id") return reply(200, result(agent, [findingBase(agent, ["ev-uydurma-0001"])]));
    if (MODE === "foreign-site") return reply(200, result(agent, [findingBase(agent, ids.slice(0, 1), { site_id: "spryhand" })]));
    if (MODE === "editorial") return reply(200, result(agent, [findingBase(agent, ids.slice(0, 1), { evidence_label: "EDITORIAL" })]));
    return reply(200, result(agent, [findingBase(agent, ids.slice(0, 1))]));
  }
  if (role === "chief") {
    if (MODE === "chief-malformed") return reply(200, `${RAW_MARK} chief bozuk`);
    if (MODE === "chief-truncated") return reply(200, `${RAW_MARK} {"schema":"sgos.brain.agent-result.v1","findings":[`);
    // Mevcut orkestrator kurali: MONITOR dışı (degisiklik oneren) bulgu uyum incelemesine girer. "ok" = MONITOR (uyum yok).
    const draft = MODE === "ok-draft" || MODE === "ok-draft-reject";
    const actionability = draft ? "DRAFT_PR_CANDIDATE" : MODE === "ok-human" || MODE === "compliance-truncated" || MODE === "compliance-malformed" ? "HUMAN_REVIEW" : "MONITOR";
    return reply(200, result(agent, [findingBase(agent, ids.slice(0, 1), { actionability })]));
  }
  // compliance
  if (MODE === "compliance-truncated") return reply(200, `${RAW_MARK} {"schema":"sgos.brain.agent-result.v1","reviews":[`);
  if (MODE === "compliance-malformed") return reply(200, `${RAW_MARK} sk-ant-LEAKLEAKLEAK1234567890 uyum bozuk`);
  const fids = [...user.matchAll(/"finding_id":"([^"]+)"/g)].map((m) => m[1]);
  const verdict = MODE === "ok-draft-reject" ? "REJECT" : "PASS";
  return reply(200, JSON.stringify({ schema: "sgos.brain.agent-result.v1", agent_id: agent, site_id: "pamistanbul", reviews: fids.map((id) => ({ finding_id: id, verdict, reason: "Politika ile celismiyor." })) }));
};
