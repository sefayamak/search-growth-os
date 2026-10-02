// Test-only preload (node --import): sabit saat + sahte Google yanitlari. Ag YOK.
// Amaci: `measure` CLI'sini deterministik calistirip Markdown/stdout ciktisini
// degismeden kanitlamak (tests/fixtures/measure-report/measure-stdout.golden.txt).
const FIXED = Date.parse("2026-10-02T06:40:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

const row = (q, clicks, impressions, position) =>
  ({ keys: [q], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const total = (clicks, impressions, position) => ({ rows: [{ clicks, impressions, ctr: impressions ? clicks / impressions : 0, position }] });

// property -> { cur, ya } | "403"
const DATA = {
  "sc-domain:pamistanbul.test": {
    cur: { query: [row("pam istanbul", 41, 70, 2.9), row("video production istanbul", 10, 900, 7.2), row("ai film maker", 0, 400, 12.5), row("fotograf cekimi fiyat", 3, 250, 9.1), row("rare thing", 0, 10, 40)], total: total(54, 5000, 6.1) },
    ya: { query: [row("pam istanbul", 10, 20, 3.0), row("video production istanbul", 2, 100, 8.0)], total: total(12, 800, 7.0) },
  },
  // Dogrulanmis sifir: API 200 dondu, satir yok.
  "sc-domain:pamaistudio.test": { cur: { query: [], total: { rows: [] } }, ya: { query: [], total: { rows: [] } } },
  "sc-domain:spryhand.test": "403",
  "sc-domain:rightlisted.test": {
    cur: { query: [row("rightlisted", 2, 20, 1.5), row("directory listing", 1, 60, 14)], total: total(3, 90, 8.0) },
    ya: { query: [row("rightlisted", 1, 10, 2)], total: total(1, 12, 2) },
  },
  "sc-domain:untitledportraits.test": {
    cur: { query: [row("portrait studio", 5, 300, 6.0), row("headshot near me", 0, 120, 18.0), row("untitled portraits", 9, 40, 1.2)], total: total(14, 500, 5.0) },
    ya: { query: [row("portrait studio", 3, 200, 7.0)], total: total(3, 210, 7.0) },
  },
  "sc-domain:myhappymade.test": {
    cur: { query: [row("handmade gifts", 4, 80, 11.0)], total: total(4, 100, 11.0) },
    ya: { query: [], total: { rows: [] } },
  },
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("oauth2.googleapis.com/token")) return json(200, { access_token: "fake-token", expires_in: 3600 });
  const m = u.match(/sites\/([^/]+)\/searchAnalytics\/query/);
  if (!m) return json(404, { error: "unmocked " + u });
  const prop = decodeURIComponent(m[1]);
  const d = DATA[prop];
  if (!d) return json(404, { error: "unknown property " + prop });
  if (d === "403") return json(403, { error: { message: "User does not have sufficient permission" } });
  const body = JSON.parse(init.body);
  const per = body.startDate >= "2026" ? d.cur : d.ya;
  return json(200, body.dimensions.length === 0 ? per.total : { rows: per.query });
};
