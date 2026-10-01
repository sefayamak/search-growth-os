// Evidence ontolojisi ile icerik KAYNAGI ayri eksenlerdir. "editorial" bir kanit etiketi
// degildir: bir fikrin arkasinda arama sinyali OLMADIGINI soyler, ne kadar emin
// oldugumuzu degil. Karistirilirsa, tekrar eden editoryal oneri zamanla "kanitli" gibi okunur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { weeklyTopics } from "../src/measure.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SITE = { business_category: "photo, film and AI production studio", primary_language: "tr", secondary_languages: ["en"] };

test("evidence etiket sozlugu AYNEN alti etiket; EDITORIAL yok", () => {
  const doc = read("policies/evidence-labels.md");
  const rows = [...doc.matchAll(/^\| ([A-Z_]+) \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows, ["FACT", "INFERENCE", "HYPOTHESIS", "RECOMMENDATION", "IMPLEMENTED_CHANGE", "VERIFIED_RESULT"]);
  const types = read("src/types.ts");
  const union = /export type EvidenceLabel =([\s\S]*?);/.exec(types)![1];
  assert.deepEqual([...union.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]), rows);
  const schema = JSON.parse(read("schemas/opportunity.schema.json"));
  assert.ok(!schema.properties.label.enum.includes("EDITORIAL"));
});

test("opportunity_source ayri alan: gsc_evidence | editorial", () => {
  const schema = JSON.parse(read("schemas/opportunity.schema.json"));
  assert.deepEqual(schema.properties.opportunity_source.enum, ["gsc_evidence", "editorial"]);
  assert.ok(!schema.required.includes("opportunity_source"), "mevcut kayitlar gecerli kalir");
});

test("weeklyTopics her satirda kaynagi tasir; kanit ve editoryal karismaz", () => {
  const opp = { query: "comfyui nedir", impressions: 162, clicks: 0, position: 7.8, score: 20 };
  const t = weeklyTopics(SITE, [opp], 0, 2);
  assert.equal(t.length, 2);
  assert.equal(t[0].opportunity_source, "gsc_evidence");
  assert.equal(t[0].source, "kanit");
  assert.equal(t[1].opportunity_source, "editorial");
  assert.equal(t[1].source, "editoryal");
  assert.match(t[1].note, /arama verisi DEĞİL/);
});

test("kanit yoksa hepsi editorial ve not bunu acikca soyler", () => {
  for (const t of weeklyTopics(SITE, [], 3, 2)) { assert.equal(t.opportunity_source, "editorial"); assert.match(t.note, /DEĞİL/); }
});
