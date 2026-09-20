// Minimal sitemap / sitemap-index reader. Only <loc> values are needed for
// index-consistency checks; lastmod is recorded when present for freshness audits.
export interface SitemapEntry { loc: string; lastmod?: string }

export function parseSitemap(xml: string): { entries: SitemapEntry[]; children: string[] } {
  const children: string[] = [];
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    if (loc) children.push(loc.trim());
  }
  for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const loc = m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    const lastmod = m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1];
    if (loc) entries.push({ loc: loc.trim(), lastmod: lastmod?.trim() });
  }
  return { entries, children };
}
