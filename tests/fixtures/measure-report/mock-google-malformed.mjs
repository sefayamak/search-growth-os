// Test-only preload: mock-google.mjs'ten SONRA yuklenir. pamistanbul icin BOZUK upstream yaniti uretir
// (bir satirda `impressions` yok, diger satirda NaN'a donusen metin); diger siteler degismez. Ag YOK.
const inner = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const res = await inner(url, init);
  const u = String(url);
  if (!u.includes("sc-domain%3Apamistanbul.test") || !u.includes("searchAnalytics/query")) return res;
  const body = await res.json();
  if (JSON.parse(init.body).dimensions.length === 1 && body.rows?.length) {
    body.rows[0] = { keys: body.rows[0].keys, clicks: body.rows[0].clicks, ctr: 0.1, position: 2 };       // impressions yok
    if (body.rows[1]) body.rows[1] = { ...body.rows[1], clicks: "abc" };                                    // sayi degil
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
