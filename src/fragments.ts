const MAX_DEPTH = 5;

interface FragmentMatch {
  start: number;
  openTagEnd: number;
  innerEnd: number;
  end: number;
  href: string;
}

function classListIncludes(classAttr: string, name: string): boolean {
  return classAttr.split(/\s+/).includes(name);
}

function findFragmentEnd(html: string, fromIdx: number): number {
  const r = findDivClose(html, fromIdx);
  return r ? r.closeTagEnd : -1;
}

function findDivClose(html: string, fromIdx: number): { innerEnd: number; closeTagEnd: number } | null {
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRe.lastIndex = fromIdx;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return { innerEnd: m.index, closeTagEnd: m.index + m[0].length };
    } else {
      depth++;
    }
  }
  return null;
}

/**
 * Decorates raw EDS .plain.html into one-or-more `<div class="section">`
 * elements, mirroring what aem.js decorateSections produces. Used to fill
 * the inside of a preserved `<div class="fragment">` block. The fragment
 * wrapper itself is kept intact so client-side decorateBlock can still
 * apply `fragment-wrapper` and `fragment-container` classes as it would at
 * origin.
 */
function decoratePlainHtmlInline(html: string): string {
  const sections: string[] = [];
  let pos = 0;
  let buffer = '';

  const flushBufferAsSection = (): void => {
    if (buffer.trim()) {
      sections.push(`<div class="section"><div class="default-content-wrapper">${buffer.trim()}</div></div>`);
    }
    buffer = '';
  };

  while (pos < html.length) {
    const divOpen = /<div\b[^>]*>/i.exec(html.slice(pos));
    if (!divOpen) {
      buffer += html.slice(pos);
      break;
    }
    const divOpenStart = pos + divOpen.index;
    buffer += html.slice(pos, divOpenStart);
    flushBufferAsSection();

    const divOpenEnd = divOpenStart + divOpen[0].length;
    const close = findDivClose(html, divOpenEnd);
    if (!close) {
      buffer += html.slice(divOpenStart);
      break;
    }
    const openTag = html.slice(divOpenStart, divOpenEnd);
    const inner = html.slice(divOpenEnd, close.innerEnd);
    const newOpenTag = addClassToOpenTag(openTag, 'section');
    sections.push(`${newOpenTag}${decorateSectionInner(inner)}</div>`);
    pos = close.closeTagEnd;
  }
  flushBufferAsSection();

  return sections.join('');
}

/**
 * Inside a section, group consecutive non-DIV top-level nodes into a
 * default-content-wrapper. DIV children (block containers) pass through
 * untouched so client-side block decoration still applies to them.
 */
function decorateSectionInner(html: string): string {
  const out: string[] = [];
  let pos = 0;
  let buffer = '';

  const flushBuffer = (): void => {
    if (buffer.trim()) {
      out.push(`<div class="default-content-wrapper">${buffer.trim()}</div>`);
    }
    buffer = '';
  };

  while (pos < html.length) {
    const divOpen = /<div\b[^>]*>/i.exec(html.slice(pos));
    if (!divOpen) {
      buffer += html.slice(pos);
      break;
    }
    const divOpenStart = pos + divOpen.index;
    buffer += html.slice(pos, divOpenStart);
    flushBuffer();

    const divOpenEnd = divOpenStart + divOpen[0].length;
    const close = findDivClose(html, divOpenEnd);
    if (!close) {
      buffer += html.slice(divOpenStart);
      break;
    }
    out.push(html.slice(divOpenStart, close.closeTagEnd));
    pos = close.closeTagEnd;
  }
  flushBuffer();
  return out.join('');
}

function findFragments(html: string): FragmentMatch[] {
  const matches: FragmentMatch[] = [];
  const openRe = /<div\b[^>]*\bclass\s*=\s*"([^"]*)"[^>]*>/gi;
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"/i;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    if (!classListIncludes(m[1], 'fragment')) continue;
    const openTagEnd = m.index + m[0].length;
    const close = findDivClose(html, openTagEnd);
    if (!close) continue;
    const inner = html.slice(openTagEnd, close.innerEnd);
    const hrefMatch = inner.match(hrefRe);
    if (!hrefMatch) continue;
    matches.push({
      start: m.index,
      openTagEnd,
      innerEnd: close.innerEnd,
      end: close.closeTagEnd,
      href: decodeHtmlAttr(hrefMatch[1]),
    });
    openRe.lastIndex = close.closeTagEnd;
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

function resolveFragmentUrl(
  href: string,
  origin: string,
  baseUrl: string,
  allowedHosts: ReadonlySet<string>,
): { url: URL; external: boolean } {
  const u = new URL(href, baseUrl);
  if (allowedHosts.has(u.hostname)) {
    // Whitelisted external URL — fetch as-is, no host rewrite and no
    // .plain.html suffix (this is an API endpoint, not an EDS document).
    u.hash = '';
    return { url: u, external: true };
  }
  // Default behaviour: rewrite to the EDS origin and append .plain.html.
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
  return { url: u, external: false };
}

interface SectionRange {
  openStart: number;
  openEnd: number;
  close: number;
}

function findMainSections(html: string): SectionRange[] {
  const mainOpen = /<main\b[^>]*>/i.exec(html);
  if (!mainOpen) return [];
  const mainOpenEnd = mainOpen.index + mainOpen[0].length;
  const mainClose = /<\/main\s*>/i.exec(html.slice(mainOpenEnd));
  if (!mainClose) return [];
  const mainEnd = mainOpenEnd + mainClose.index;

  const sections: SectionRange[] = [];
  let pos = mainOpenEnd;
  const divOpenRe = /<div\b[^>]*>/gi;
  while (pos < mainEnd) {
    divOpenRe.lastIndex = pos;
    const m = divOpenRe.exec(html);
    if (!m || m.index >= mainEnd) break;
    const openStart = m.index;
    const openEnd = m.index + m[0].length;
    const close = findFragmentEnd(html, openEnd);
    if (close < 0 || close > mainEnd) break;
    sections.push({ openStart, openEnd, close });
    pos = close;
  }
  return sections;
}

function addClassToOpenTag(openTag: string, className: string): string {
  const classAttrRe = /(\bclass\s*=\s*")([^"]*)(")/i;
  const m = openTag.match(classAttrRe);
  if (m) {
    if (classListIncludes(m[2], className)) return openTag;
    const updated = m[2] ? `${m[2]} ${className}` : className;
    return openTag.replace(classAttrRe, `$1${updated}$3`);
  }
  return openTag.replace(/\s*>$/, ` class="${className}">`);
}

export async function inlineFragments(
  html: string,
  origin: string,
  baseUrl: string,
  allowedHosts: ReadonlySet<string> = new Set(),
  depth = 0,
  visited: ReadonlySet<string> = new Set(),
): Promise<string> {
  if (depth >= MAX_DEPTH) return html;

  const matches = findFragments(html);
  if (matches.length === 0) return html;

  const replacements = await Promise.all(
    matches.map((mt) => fetchAndInline(mt.href, origin, baseUrl, allowedHosts, depth, visited)),
  );

  // Find which top-level <main> sections contain at least one fragment that
  // was successfully inlined. The post-decoration origin DOM has
  // `fragment-container` on the section (added by aem.js decorateBlock); we
  // mirror that here so styles targeting `.fragment-container` still apply.
  const sections = findMainSections(html);
  const sectionsToAnnotate = new Set<number>();
  for (let i = 0; i < matches.length; i++) {
    if (replacements[i] === null) continue;
    const mt = matches[i];
    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s];
      if (mt.start >= sec.openStart && mt.end <= sec.close) {
        sectionsToAnnotate.add(s);
        break;
      }
    }
  }

  // Build a sorted edit list (section-class edits + fragment replacements).
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const s of sectionsToAnnotate) {
    const sec = sections[s];
    const openTag = html.slice(sec.openStart, sec.openEnd);
    const newOpenTag = addClassToOpenTag(openTag, 'fragment-container');
    if (newOpenTag !== openTag) {
      edits.push({ start: sec.openStart, end: sec.openEnd, replacement: newOpenTag });
    }
  }
  // Replace each <div class="fragment"> block. We:
  //   1. Tag the opening tag with data-ssr="inlined" so the site's
  //      fragment.js can detect the pre-rendered marker and short-circuit.
  //   2. Replace the inner markup with the decorated .plain.html content
  //      so the DOM ends up as: fragment > section > default-content-wrapper.
  // Keeping the <div class="fragment"> wrapper means aem.js's decorateBlock
  // still adds `fragment-wrapper` to the parent and `fragment-container` to
  // the section; fragment.js then unwraps the block, yielding a final DOM
  // identical to origin's post-decoration shape.
  for (let i = 0; i < matches.length; i++) {
    if (replacements[i] === null) continue;
    const mt = matches[i];
    const openTag = html.slice(mt.start, mt.openTagEnd);
    const newOpenTag = openTag.replace(/<div\b/i, '<div data-ssr="inlined"');
    edits.push({
      start: mt.start,
      end: mt.innerEnd,
      replacement: newOpenTag + replacements[i],
    });
  }
  edits.sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const ed of edits) {
    out += html.slice(cursor, ed.start);
    out += ed.replacement;
    cursor = ed.end;
  }
  out += html.slice(cursor);
  return out;
}

async function fetchAndInline(
  href: string,
  origin: string,
  baseUrl: string,
  allowedHosts: ReadonlySet<string>,
  depth: number,
  visited: ReadonlySet<string>,
): Promise<string | null> {
  let resolved: { url: URL; external: boolean };
  try {
    resolved = resolveFragmentUrl(href, origin, baseUrl, allowedHosts);
  } catch {
    return null;
  }
  const { url, external } = resolved;
  // Cache key includes host so an external URL is never confused with an
  // origin-scoped path with the same pathname.
  const key = `${url.host}${url.pathname}${url.search}`;
  if (visited.has(key)) return '';

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { accept: 'text/html' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch (err) {
    console.error('fragment fetch failed', url.toString(), err);
    return null;
  }
  if (!res.ok) return null;

  const fragHtml = await res.text();
  const nextVisited = new Set(visited);
  nextVisited.add(key);

  // External whitelisted hosts: inline the response verbatim under a section
  // wrapper. We don't recurse into them looking for nested EDS fragment
  // markup — that's the EDS origin's job, not arbitrary third-party APIs.
  if (external) {
    return `<div class="section"><div class="default-content-wrapper">${fragHtml}</div></div>`;
  }
  const inlined = await inlineFragments(fragHtml, origin, url.toString(), allowedHosts, depth + 1, nextVisited);
  return decoratePlainHtmlInline(inlined);
}
