#!/usr/bin/env node --experimental-strip-types
// Scorecard'u yerel artifact dizinlerinden uretir. Ag yok, secret yok, yalniz okuma.
//   node --experimental-strip-types bin/scorecard.ts config/sites.yaml [--clarity data/clarity-history]
//     [--performance DIR] [--index DIR] [--deployments DIR] [--measure FILE] [--json] [--site ID]
// Kayitli HER site icin olcum karti uretilir (kural 3: olcum her kayitli site icin yapilabilir);
// tavsiye uretilmez, onboarding durumu karta yazilir.
import { loadRegistry } from "../src/registry.ts";
import { buildPortfolio, loadInputs, scorecardToMarkdown } from "../src/scorecard.ts";

const a = process.argv.slice(2);
const flag = (n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const regPath = a.find((x) => !x.startsWith("--") && x.endsWith(".yaml")) ?? "config/sites.yaml";
const reg = loadRegistry(regPath);
if (!reg.ok || !reg.registry) { console.error(`registry gecersiz: ${reg.errors.join("; ")}`); process.exit(1); }
const only = flag("site");
const paths = { clarityDir: flag("clarity") ?? "data/clarity-history", performanceDir: flag("performance"), indexDir: flag("index"), deploymentDir: flag("deployments"), measureFile: flag("measure") };
const sites = reg.registry.sites.filter((s) => !only || s.id === only);
if (!sites.length) { console.error(`site bulunamadi: ${only}`); process.exit(1); }
const p = buildPortfolio(sites.map((s) => loadInputs(paths, s.id, s.onboarding_status)));
console.log(a.includes("--json") ? JSON.stringify(p, null, 2) : scorecardToMarkdown(p));
