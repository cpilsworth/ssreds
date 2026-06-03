import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inlineFragments } from '../src/fragments';

const ORIGIN = 'https://main--site--owner.aem.live';
const BASE_URL = `${ORIGIN}/page`;

// Pre-built building blocks for HTML fixtures.
function fragmentBlock(href: string): string {
  return `<div class="fragment"><div><div><a href="${href}">${href}</a></div></div></div>`;
}

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body><main>${body}</main></body></html>`;
}

interface MockResponse {
  status?: number;
  body?: string;
}

function installFetchMock(routes: Record<string, MockResponse | (() => MockResponse)>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const handler = routes[url];
      if (!handler) {
        return new Response('not mocked: ' + url, { status: 599 });
      }
      const r = typeof handler === 'function' ? handler() : handler;
      return new Response(r.body ?? '', { status: r.status ?? 200 });
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inlineFragments', () => {
  it('returns unchanged HTML when there are no fragment blocks', async () => {
    const html = page('<h1>hello</h1>');
    installFetchMock({});
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toBe(html);
  });

  it('inlines a single fragment, tags it data-ssr="inlined", and adds fragment-container to its section', async () => {
    const html = page(`<div><h2>x</h2>${fragmentBlock('/fragments/x')}</div>`);
    installFetchMock({
      [`${ORIGIN}/fragments/x.plain.html`]: { body: '<div><p>X content</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('data-ssr="inlined"');
    expect(out).toContain('class="fragment-container"');
    expect(out).toContain('<div class="section"><div class="default-content-wrapper"><p>X content</p></div></div>');
    expect(out).not.toMatch(/<a href="\/fragments\/x"/);
  });

  it('invokes the onFetch callback once per backend fragment fetch', async () => {
    const html = page(`<div>${fragmentBlock('/a')}${fragmentBlock('/b')}</div>`);
    installFetchMock({
      [`${ORIGIN}/a.plain.html`]: { body: '<div><p>A</p></div>' },
      [`${ORIGIN}/b.plain.html`]: { body: '<div><p>B</p></div>' },
    });
    let fetches = 0;
    await inlineFragments(html, ORIGIN, BASE_URL, 0, new Set(), {}, () => { fetches++; });
    expect(fetches).toBe(2);
  });

  it('inlines multiple fragments in the same section and annotates the section once', async () => {
    const html = page(`<div>${fragmentBlock('/a')}${fragmentBlock('/b')}</div>`);
    installFetchMock({
      [`${ORIGIN}/a.plain.html`]: { body: '<div><p>A</p></div>' },
      [`${ORIGIN}/b.plain.html`]: { body: '<div><p>B</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    // exactly one fragment-container class on the section
    expect(out.match(/fragment-container/g)?.length).toBe(1);
    expect(out).toContain('<p>A</p>');
    expect(out).toContain('<p>B</p>');
    expect((out.match(/data-ssr="inlined"/g) ?? []).length).toBe(2);
  });

  it('leaves the fragment markup intact when the upstream returns 404 (graceful degradation)', async () => {
    const html = page(`<div>${fragmentBlock('/missing')}</div>`);
    installFetchMock({
      [`${ORIGIN}/missing.plain.html`]: { status: 404, body: 'not found' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('class="fragment"');
    expect(out).toContain('href="/missing"');
    expect(out).not.toContain('data-ssr="inlined"');
    expect(out).not.toContain('fragment-container');
  });

  it('preserves any sections that contain only failed fragments (no annotation)', async () => {
    const html = page(`<div>${fragmentBlock('/ok')}</div><div>${fragmentBlock('/bad')}</div>`);
    installFetchMock({
      [`${ORIGIN}/ok.plain.html`]: { body: '<div><p>OK</p></div>' },
      [`${ORIGIN}/bad.plain.html`]: { status: 500, body: '' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    // first section annotated; second still has unprocessed fragment markup
    expect(out.match(/fragment-container/g)?.length).toBe(1);
    expect(out).toContain('href="/bad"');
  });

  it('recursively resolves nested fragments', async () => {
    const html = page(`<div>${fragmentBlock('/outer')}</div>`);
    installFetchMock({
      [`${ORIGIN}/outer.plain.html`]: {
        body: `<div><p>outer</p>${fragmentBlock('/inner')}</div>`,
      },
      [`${ORIGIN}/inner.plain.html`]: { body: '<div><p>inner</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>outer</p>');
    expect(out).toContain('<p>inner</p>');
    // outer fragment is data-ssr="inlined"; the nested .plain.html does NOT contain a <main>,
    // so no fragment-container appears for the inner section.
    expect((out.match(/data-ssr="inlined"/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('breaks fragment cycles via the visited set', async () => {
    const html = page(`<div>${fragmentBlock('/loop')}</div>`);
    const fetchCounts = { '/loop.plain.html': 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === `${ORIGIN}/loop.plain.html`) {
          fetchCounts['/loop.plain.html']++;
          return new Response(`<div><p>loop</p>${fragmentBlock('/loop')}</div>`, { status: 200 });
        }
        return new Response('miss', { status: 599 });
      }),
    );
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>loop</p>');
    // /loop is fetched once at the top level; the recursive self-reference returns '' via visited set.
    expect(fetchCounts['/loop.plain.html']).toBe(1);
  });

  it('stops recursing at MAX_DEPTH (5) without throwing', async () => {
    // Each fragment links to a unique path so visited-set doesn't short-circuit.
    const chain = [0, 1, 2, 3, 4, 5, 6, 7];
    const routes: Record<string, MockResponse> = {};
    for (const i of chain) {
      const next = i + 1;
      routes[`${ORIGIN}/d${i}.plain.html`] = {
        body: `<div><p>d${i}</p>${fragmentBlock(`/d${next}`)}</div>`,
      };
    }
    installFetchMock(routes);
    const html = page(`<div>${fragmentBlock('/d0')}</div>`);
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    // d0..d4 should be inlined (5 levels). d5 fragment markup should remain unprocessed.
    expect(out).toContain('<p>d0</p>');
    expect(out).toContain('<p>d4</p>');
    // d5's fragment block markup is reached but its recursion stops — the inner href text remains visible.
    expect(out).toContain('href="/d5"');
  });

  it('rewrites a fragment href onto the origin host even if the href is absolute to a different host', async () => {
    const html = page(`<div>${fragmentBlock('https://main--other--owner.aem.page/foo')}</div>`);
    installFetchMock({
      [`${ORIGIN}/foo.plain.html`]: { body: '<div><p>foo</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>foo</p>');
  });

  it('skips fragments whose href is missing entirely', async () => {
    // A fragment block that contains no <a href> at all should be left alone.
    const html = page('<div><div class="fragment"><div><div>no link here</div></div></div></div>');
    installFetchMock({});
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toBe(html);
  });

  it('decodes HTML entities in the fragment href (&amp;)', async () => {
    const html = page(`<div>${fragmentBlock('/a&amp;b')}</div>`);
    installFetchMock({
      [`${ORIGIN}/a&b.plain.html`]: { body: '<div><p>amp</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>amp</p>');
  });

  it('produces multiple sections when .plain.html has multiple top-level divs', async () => {
    const html = page(`<div>${fragmentBlock('/multi')}</div>`);
    installFetchMock({
      [`${ORIGIN}/multi.plain.html`]: {
        body: '<div><p>section-a</p></div><div><p>section-b</p></div>',
      },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    // Two <div class="section">...</div> sections inside the fragment block
    expect((out.match(/<div class="section">/g) ?? []).length).toBe(2);
    expect(out).toContain('<p>section-a</p>');
    expect(out).toContain('<p>section-b</p>');
  });

  it('wraps loose text outside divs in default-content-wrapper inside a section', async () => {
    const html = page(`<div>${fragmentBlock('/loose')}</div>`);
    installFetchMock({
      [`${ORIGIN}/loose.plain.html`]: { body: '<p>standalone p with no div wrapper</p>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<div class="section"><div class="default-content-wrapper"><p>standalone p with no div wrapper</p></div></div>');
  });

  it('passes through fragment markup when fetch throws a network error', async () => {
    const html = page(`<div>${fragmentBlock('/err')}</div>`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    // Silence the expected console.error from fetchAndInline
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('class="fragment"');
    expect(out).not.toContain('data-ssr="inlined"');
  });

  it('skips fragment-container annotation if no <main> element is present', async () => {
    // No <main> — inlineFragments should still inline but skip section annotation.
    const html = `<html><body><div>${fragmentBlock('/x')}</div></body></html>`;
    installFetchMock({
      [`${ORIGIN}/x.plain.html`]: { body: '<div><p>X</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>X</p>');
    expect(out).not.toContain('fragment-container');
  });

  it('does not double-add fragment-container if the section already has it', async () => {
    const html = `<html><body><main><div class="fragment-container">${fragmentBlock('/x')}</div></main></body></html>`;
    installFetchMock({
      [`${ORIGIN}/x.plain.html`]: { body: '<div><p>X</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect((out.match(/fragment-container/g) ?? []).length).toBe(1);
  });

  it('preserves a trailing slash on the fragment href by stripping it before appending .plain.html', async () => {
    const html = page(`<div>${fragmentBlock('/foo/')}</div>`);
    installFetchMock({
      [`${ORIGIN}/foo.plain.html`]: { body: '<div><p>slash</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>slash</p>');
  });

  it('annotates a section that already has classes by appending fragment-container', async () => {
    const html = `<html><body><main><div class="theme-dark">${fragmentBlock('/x')}</div></main></body></html>`;
    installFetchMock({
      [`${ORIGIN}/x.plain.html`]: { body: '<div><p>X</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('class="theme-dark fragment-container"');
  });

  it('handles an empty class attribute on the section', async () => {
    const html = `<html><body><main><div class="">${fragmentBlock('/x')}</div></main></body></html>`;
    installFetchMock({
      [`${ORIGIN}/x.plain.html`]: { body: '<div><p>X</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('class="fragment-container"');
  });

  it('leaves the fragment markup intact if the href is not a valid URL', async () => {
    // ":::" cannot be parsed as a URL relative to baseUrl
    const html = page(`<div>${fragmentBlock('http://::: badhost ::: /x')}</div>`);
    installFetchMock({});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('class="fragment"');
    expect(out).not.toContain('data-ssr="inlined"');
  });

  it('does not re-append .plain.html if the href already ends with it', async () => {
    const html = page(`<div>${fragmentBlock('/foo.plain.html')}</div>`);
    installFetchMock({
      [`${ORIGIN}/foo.plain.html`]: { body: '<div><p>already</p></div>' },
    });
    const out = await inlineFragments(html, ORIGIN, BASE_URL);
    expect(out).toContain('<p>already</p>');
  });
});
