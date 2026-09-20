// PreToolUse hook: runs the compliance gate on every Write/Edit payload.
// Exit 2 blocks the tool call and feeds the reason back to Claude.
// Exit 0 with a JSON "additionalContext" flags but allows.
// Scope guard: only public-web-facing paths are gated; the CRM and unrelated code are untouched.
import { readFileSync } from "node:fs";
import { checkCompliance, kindFromPath } from "../src/compliance.ts";

interface HookInput { tool_name: string; tool_input: { file_path?: string; content?: string; new_string?: string } }

let input: HookInput;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }

const path = input.tool_input?.file_path ?? "";
const content = input.tool_input?.content ?? input.tool_input?.new_string ?? "";
if (!content) process.exit(0);

// Gate only content that can reach a public site or a search-affecting plan.
const gated = /\.(html?|tsx|jsx|astro|vue|svelte|md|mdx|json|jsonld|txt|xml|ts|js|mjs)$/i.test(path) && !/search-growth-os\/(tests|evals|policies|agents|skills|docs|templates|src|hooks)\//.test(path) && !/node_modules/.test(path);
if (!gated) process.exit(0);

const res = checkCompliance(content, { kind: kindFromPath(path), path });
if (res.verdict === "REJECT") {
  process.stderr.write(`Search Growth OS compliance gate REJECTED this write.\n${res.hits.map((h) => `- ${h.rule}: ${h.evidence} (see ${h.policyRef})`).join("\n")}\nDo not rationalize around the policy; change the approach.`);
  process.exit(2);
}
if (res.verdict === "FLAG") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Compliance FLAG (human review required before PR): ${res.hits.map((h) => `${h.rule}: ${h.evidence} → ${h.policyRef}`).join("; ")}` } }));
}
process.exit(0);
