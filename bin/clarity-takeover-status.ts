#!/usr/bin/env node --experimental-strip-types
// OFFLINE: ag/API/secret yok.
// usage: node --experimental-strip-types bin/clarity-takeover-status.ts [registry] [--history dir] [--runs file.json] [--json]
import { loadAndEvaluate, statusToMarkdown } from "../src/clarity-takeover-status.ts";

const a = process.argv.slice(2);
const val = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const registry = a.find((x, i) => !x.startsWith("--") && (i === 0 || !a[i - 1].startsWith("--"))) ?? "config/sites.yaml";
const s = loadAndEvaluate(registry, val("--history") ?? "data/clarity-history", val("--runs"));
console.log(a.includes("--json") ? JSON.stringify(s, null, 2) : statusToMarkdown(s));
