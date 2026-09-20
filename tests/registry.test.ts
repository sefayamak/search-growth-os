import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, validateRegistry, parseYamlSubset, onboardedSites } from "../src/registry.ts";

const cfg = (n: string) => join(dirname(fileURLToPath(import.meta.url)), "..", "config", n);
const example = cfg("sites.example.yaml");

test("sites.example.yaml parses and validates", () => {
  const r = loadRegistry(example);
  assert.ok(r.ok, r.errors.join("\n"));
  assert.equal(r.registry!.sites[0].id, "pamistanbul");
  assert.equal(r.registry!.sites[0].google_search_console_property, "NOT_CONNECTED");
  assert.ok(Array.isArray(r.registry!.sites[0].competitor_set));
});

test("rejects placeholders and blanks instead of sentinels", () => {
  const r = loadRegistry(example);
  const site = { ...r.registry!.sites[0], ga4_property: "TODO", cdn_log_source: "" };
  const v = validateRegistry({ version: 1, sites: [site] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /placeholder/.test(e)));
  assert.ok(v.errors.some((e) => /empty/.test(e)));
});

test("yaml subset handles nested maps, block lists, inline lists, quotes", () => {
  const y = parseYamlSubset(`version: 1\nsites:\n  - id: a\n    tags: [x, y]\n    list:\n      - "one"\n      - two\n    nested:\n      k: "v: with colon"\n`) as any;
  assert.equal(y.version, 1);
  assert.deepEqual(y.sites[0].tags, ["x", "y"]);
  assert.deepEqual(y.sites[0].list, ["one", "two"]);
  assert.equal(y.sites[0].nested.k, "v: with colon");
});

test("live registry holds the whole portfolio with only the pilot onboarded", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  assert.ok(r.ok, r.errors.join("\n"));
  const sites = r.registry!.sites;
  assert.equal(sites.length, 7);
  const pilots = sites.filter((s) => s.onboarding_status === "pilot_onboarding");
  assert.deepEqual(pilots.map((s) => s.id), ["pamistanbul"]);
  assert.equal(onboardedSites(r.registry!).length, 1, "only the pilot may be crawled");
  // Every other portfolio site is registered but explicitly out of scope.
  for (const s of sites.filter((s) => s.id !== "pamistanbul")) {
    assert.equal(s.onboarding_status, "registered_not_onboarded", s.id);
  }
  // A property identifier may be known before credentials exist, but it is either a
  // sentinel or a real GA4 numeric id — never a guess, and never a measurement ID.
  for (const s of sites) {
    const ga4 = String(s.ga4_property);
    assert.ok(ga4 === "NOT_CONNECTED" || ga4 === "UNKNOWN" || /^\d{9,12}$/.test(ga4), `${s.id}: ga4_property "${ga4}"`);
    assert.doesNotMatch(ga4, /^G-/, `${s.id}: measurement ID is not a property ID`);
  }
  // The pilot's GA4 property is not yet confirmed, so it must not claim one.
  const pilot = sites.find((s) => s.id === "pamistanbul")!;
  assert.equal(pilot.ga4_property, "UNKNOWN");
  // A Search Console property is either a sentinel or a real property string in one of
  // Google's two forms. A bare hostname is not a property and would silently return nothing.
  for (const s of sites) {
    const p = String(s.google_search_console_property);
    assert.ok(["NOT_CONNECTED", "UNKNOWN"].includes(p) || /^sc-domain:[a-z0-9.-]+$/.test(p) || /^https?:\/\/.+\/$/.test(p), `${s.id}: "${p}"`);
  }
  for (const s of sites) assert.ok(["NOT_CONNECTED", "UNKNOWN"].includes(String(s.bing_webmaster_property)), s.id);
});

test("portfolio isolation: a non-onboarded site cannot carry inherited strategy", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  const pilot = r.registry!.sites.find((s) => s.id === "pamistanbul")!;
  const other = r.registry!.sites.find((s) => s.id === "spryhand")!;
  // Simulate the failure this guards: copying the pilot's commercial context onto another site.
  const leaked = { ...other, competitor_set: ["example-competitor.com"], core_commercial_topics: pilot.core_commercial_topics.concat("ürün fotoğrafı") };
  const v = validateRegistry({ version: 1, sites: [leaked] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /never inherit it from another site/.test(e)), v.errors.join("\n"));
});

test("onboarding_status is required and validated", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  const s = r.registry!.sites[0];
  assert.equal(validateRegistry({ version: 1, sites: [{ ...s, onboarding_status: "live" }] }).ok, false);
  const { onboarding_status: _drop, ...without } = s;
  const v = validateRegistry({ version: 1, sites: [without] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /missing field onboarding_status/.test(e)));
});

test("foundation year is owner-confirmed truth, and never a guess", () => {
  const r = loadRegistry(cfg("sites.yaml"));
  assert.ok(r.ok, r.errors.join("\n"));
  const pilot = r.registry!.sites.find((s) => s.id === "pamistanbul")!;
  assert.equal(pilot.foundation_year, 2018);
  assert.equal(pilot.google_search_console_property, "sc-domain:pamistanbul.com");
  // Sites nobody has confirmed stay UNKNOWN rather than inheriting the pilot's year.
  //
  // pamaistudio is the one named exception, and it is an exception by confirmation rather
  // than by convenience: PAM AI Studio is PAM İstanbul's own AI unit, its pages state the
  // parent's founding year as a fact about themselves, and the owner confirmed 2018 for it
  // on 2026-09-20. Without that year recorded the contradiction check has nothing to
  // compare against — which is precisely why that site served the wrong year undetected
  // through two scans. Any site added to this map must earn it the same way: a written
  // owner confirmation, never a copy of the pilot's value because it was convenient.
  const CONFIRMED_YEARS: Record<string, number> = { pamistanbul: 2018, pamaistudio: 2018 };
  for (const s of r.registry!.sites) {
    assert.equal(s.foundation_year, CONFIRMED_YEARS[s.id] ?? "UNKNOWN", s.id);
  }
  // Implausible or fabricated years are rejected.
  for (const bad of [1700, 3000, "2018" as unknown as number]) {
    assert.equal(validateRegistry({ version: 1, sites: [{ ...pilot, foundation_year: bad }] }).ok, false, String(bad));
  }
});
