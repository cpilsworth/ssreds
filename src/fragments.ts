const MAX_DEPTH = 5;

interface FragmentMatch {
  start: number;
  end: number;
  href: string;
}

function classListIncludes(classAttr: string, name: string): boolean {
  return classAttr.split(/\s+/).includes(name);
}

function findFragmentEnd(html: string, fromIdx: number): number {
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRe.lastIndex = fromIdx;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else {
      depth++;
    }
  }
  return -1;
}

function findFragments(html: string): FragmentMatch[] {
  const matches: FragmentMatch[] = [];
  const openRe = /<div\b[^>]*\bclass\s*=\s*"([^"]*)"[^>]*>/gi;
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"/i;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    if (!classListIncludes(m[1], 'fragment')) continue;
    const openTagEnd = m.index + m[0].length;
    const end = findFragmentEnd(html, openTagEnd);
    if (end < 0) continue;
    const inner = html.slice(openTagEnd, end);
    const hrefMatch = inner.match(hrefRe);
    if (!hrefMatch) continue;
    matches.push({ start: m.index, end, href: decodeHtmlAttr(hrefMatch[1]) });
    openRe.lastIndex = end;
  }
  return matches;
}

function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function resolveFragmentUrl(href: string, origin: string, baseUrl: string): URL {
  const u = new URL(href, baseUrl);
  const originUrl = new URL(origin);
  u.protocol = originUrl.protocol;
  u.hostname = originUrl.hostname;
  u.port = originUrl.port;
  if (!u.pathname.endsWith('.plain.html')) {
    const path = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    u.pathname = path + '.plain.html';
  }
  u.search = '';
  u.hash = '';
  return u;
}

export async function inlineFragments(
  html: string,
  origin: string,
  baseUrl: string,
  depth = 0,
  visited: ReadonlySet<string> = new Set(),
): Promise<string> {
  if (depth >= MAX_DEPTH) return html;

  const matches = findFragments(html);
  if (matches.length === 0) return html;

  const replacements = await Promise.all(
    matches.map((mt) => fetchAndInline(mt.href, origin, baseUrl, depth, visited)),
  );

  let out = '';
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const mt = matches[i];
    out += html.slice(cursor, mt.start);
    out += replacements[i] !== null ? (replacements[i] as string) : html.slice(mt.start, mt.end);
    cursor = mt.end;
  }
  out += html.slice(cursor);
  return out;
}

async function fetchAndInline(
  href: string,
  origin: string,
  baseUrl: string,
  depth: number,
  visited: ReadonlySet<string>,
): Promise<string | null> {
  let url: URL;
  try {
    url = resolveFragmentUrl(href, origin, baseUrl);
  } catch {
    return null;
  }
  const key = url.pathname;
  if (visited.has(key)) return '';

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { accept: 'text/html' },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
  } catch (err) {
    console.error('fragment fetch failed', url.toString(), err);
    return null;
  }
  if (!res.ok) return null;

  const fragHtml = await res.text();
  const nextVisited = new Set(visited);
  nextVisited.add(key);
  return inlineFragments(fragHtml, origin, url.toString(), depth + 1, nextVisited);
}
