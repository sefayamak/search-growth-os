// Dependency-free HTML extractor. Regex-driven on purpose: the audit reads
// signals (title, robots, canonical, links, JSON-LD), it does not need a DOM.
// Trade-off: pathological markup may be misread; every finding carries the
// raw evidence so a human can verify.
import type { ParsedHtml, Link, ImageRef, JsonLdBlock } from "./types.ts";

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\s*[a-zA-Z0-9:-]+/, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function tags(html: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return html.match(re) ?? [];
}

function elements(html: string, name: string): { tag: string; inner: string }[] {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, "gi");
  const out: { tag: string; inner: string }[] = [];
  for (const m of html.matchAll(re)) out.push({ tag: `<${name}${m[1]}>`, inner: m[2] });
  return out;
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function absolutize(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

function directives(content: string | undefined): string[] {
  if (!content) return [];
  return content.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export function parseHtml(html: string, baseUrl: string): ParsedHtml {
  const baseTag = tags(html, "base")[0];
  const base = baseTag ? (absolutize(parseAttrs(baseTag).href ?? "", baseUrl) ?? baseUrl) : baseUrl;
  const host = new URL(baseUrl).host;

  const titleEl = elements(html.replace(/<svg[\s\S]*?<\/svg>/gi, ""), "title")[0];
  const title = titleEl ? stripTags(titleEl.inner) : null;

  const metas = tags(html, "meta").map(parseAttrs);
  const metaByName = (n: string) => metas.find((m) => (m.name ?? "").toLowerCase() === n)?.content;
  const openGraph: Record<string, string> = {};
  for (const m of metas) {
    const p = (m.property ?? "").toLowerCase();
    if (p.startsWith("og:") && m.content !== undefined) openGraph[p] = m.content;
  }

  const linkTags = tags(html, "link").map(parseAttrs);
  const canonicals = linkTags.filter((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const canonical = canonicals[0]?.href ? absolutize(canonicals[0].href, base) : null;
  const hreflang = linkTags
    .filter((l) => (l.rel ?? "").toLowerCase() === "alternate" && l.hreflang)
    .map((l) => ({ lang: l.hreflang!, href: absolutize(l.href ?? "", base) ?? l.href ?? "" }));

  const headings: { level: number; text: string }[] = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    headings.push({ level: Number(m[1]), text: stripTags(m[2]) });
  }

  const links: Link[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const a = parseAttrs(`<a${m[1]}>`);
    if (!a.href) continue;
    const abs = absolutize(a.href, base);
    if (!abs) continue;
    links.push({
      href: abs, raw: a.href, text: stripTags(m[2]).slice(0, 200),
      rel: (a.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean),
      internal: new URL(abs).host === host,
    });
  }

  const images: ImageRef[] = tags(html, "img").map(parseAttrs).map((a) => ({
    src: absolutize(a.src ?? a["data-src"] ?? "", base) ?? (a.src ?? ""),
    alt: "alt" in a ? a.alt : null,
    width: a.width, height: a.height, loading: a.loading,
    // width/height exist to reserve the box before the file arrives. CSS can reserve
    // the same box three other ways, and then the attributes add nothing: an explicit
    // aspect-ratio; a next/image fill (which rejects width/height outright); or
    // width AND height both at 100%, which hands the box to the parent entirely.
    // Recorded so the CLS check can tell "no dimensions" from "dimensions do not apply".
    reservesSpace: a["data-nimg"] === "fill"
      || /aspect-ratio\s*:/i.test(a.style ?? "")
      || (/\bwidth\s*:\s*100%/i.test(a.style ?? "") && /\bheight\s*:\s*100%/i.test(a.style ?? "")),
  }));

  const jsonLd: JsonLdBlock[] = elements(html, "script")
    .filter((s) => /type\s*=\s*["']?application\/ld\+json/i.test(s.tag))
    .map((s) => {
      const raw = s.inner.trim();
      try {
        const parsed = JSON.parse(raw);
        return { raw, parsed, types: collectTypes(parsed) };
      } catch (e) {
        return { raw, parsed: null, parseError: String((e as Error).message), types: [] };
      }
    });

  // Visible text approximation: drop script/style/template/noscript, then tags.
  const noscriptText = elements(html, "noscript").map((n) => stripTags(n.inner)).join(" ");
  const bodyHtml = (html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? html)
    .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const textContent = stripTags(bodyHtml);
  const wordCount = textContent ? textContent.split(/\s+/).length : 0;
  const hasNoscriptOnly = wordCount < 20 && noscriptText.split(/\s+/).length > 50;

  // Hidden-text suspects: inline styles that hide content while it carries text.
  const hiddenTextSuspects: string[] = [];
  let inlineStyleHidden = 0;
  for (const m of bodyHtml.matchAll(/<([a-z0-9]+)\b[^>]*style\s*=\s*["']([^"']*)["'][^>]*>([\s\S]{0,400}?)<\/\1>/gi)) {
    const style = m[2].toLowerCase().replace(/\s/g, "");
    // `font-size:0` must not match `font-size:0.95rem`, and `opacity:0` must not match
    // `opacity:0.8`. Measured against a real site: the naive prefix match turned every
    // ordinary inline font-size into a hidden-text accusation.
    const hidden = /display:none|visibility:hidden|font-size:0(?:px|em|rem|%|pt)?(?![.\d])|opacity:0(?![.\d])|text-indent:-\d{3,}|left:-\d{3,}px/.test(style);
    if (!hidden) continue;
    inlineStyleHidden++;
    const t = stripTags(m[3]);
    if (t.split(/\s+/).length >= 8) hiddenTextSuspects.push(t.slice(0, 160));
  }

  return {
    title,
    metaDescription: metaByName("description") ?? null,
    metaRobots: directives(metaByName("robots")),
    metaGooglebot: directives(metaByName("googlebot")),
    canonical,
    canonicalCount: canonicals.length,
    hreflang,
    headings,
    links,
    images,
    jsonLd,
    openGraph,
    lang: parseAttrs(tags(html, "html")[0] ?? "<html>").lang ?? null,
    viewport: metaByName("viewport") ?? null,
    textContent,
    wordCount,
    hasNoscriptOnly,
    hiddenTextSuspects,
    externalScripts: tags(html, "script").filter((t) => /\bsrc=/i.test(t)).length,
    inlineStyleHidden,
  };
}

function collectTypes(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) { node.forEach((n) => collectTypes(n, acc)); return acc; }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") acc.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && acc.push(x));
    if (Array.isArray(o["@graph"])) collectTypes(o["@graph"], acc);
    for (const [k, v] of Object.entries(o)) if (k !== "@graph" && v && typeof v === "object") collectTypes(v, acc);
  }
  return acc;
}
