import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const HOST_MAP_JSON = JSON.stringify({
  '--live.diffatech.co.uk': 'aem.live',
  '--page.diffatech.co.uk': 'aem.page',
  '.aem.live': 'aem.live',
  '.aem.page': 'aem.page',
});

function mockUpstream(handler: (req: Request) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    return handler(req);
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker.fetch — origin resolution', () => {
  it('returns 502 when HOST_MAP is invalid JSON', async () => {
    const env: Env = { HOST_MAP: 'not json' };
    const res = await worker.fetch(
      new Request('https://anything.example.com/'),
      env,
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when HOST_MAP parses to non-object (null)', async () => {
    const env: Env = { HOST_MAP: 'null' };
    const res = await worker.fetch(new Request('https://x.example.com/'), env);
    expect(res.status).toBe(502);
  });

  it('returns 502 when no suffix in HOST_MAP matches the request host', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    const res = await worker.fetch(new Request('https://no-match.example.com/'), env);
    expect(res.status).toBe(502);
  });

  it('resolves --live suffix to the corresponding aem.live origin', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://main--repo--owner--live.diffatech.co.uk/path?q=1'),
      env,
    );
    expect(upstreamUrl).toBe('https://main--repo--owner.aem.live/path?q=1');
  });

  it('resolves --page suffix to the corresponding aem.page origin', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://main--repo--owner--page.diffatech.co.uk/'),
      env,
    );
    expect(upstreamUrl).toBe('https://main--repo--owner.aem.page/');
  });

  it('resolves a raw .aem.live host (used by upstream CDN forwarding)', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://main--repo--owner.aem.live/'),
      env,
    );
    expect(upstreamUrl).toBe('https://main--repo--owner.aem.live/');
  });

  it('falls back to X-Forwarded-Host when the request host does not match HOST_MAP', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://workers.dev-style.example/', {
        headers: { 'x-forwarded-host': 'main--repo--owner.aem.page' },
      }),
      env,
    );
    expect(upstreamUrl).toBe('https://main--repo--owner.aem.page/');
  });

  it('tries each comma-separated X-Forwarded-Host value left-to-right', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://workers.dev-style.example/', {
        headers: { 'x-forwarded-host': 'main--repo--owner.aem.live, edge.example.com' },
      }),
      env,
    );
    expect(upstreamUrl).toBe('https://main--repo--owner.aem.live/');
  });

  it('strips a port from X-Forwarded-Host values before matching', async () => {
    const env: Env = { HOST_MAP: HOST_MAP_JSON };
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://nomatch.example/', {
        headers: { 'x-forwarded-host': 'main--repo--owner.aem.page:8443' },
      }),
      env,
    );
    expect(upstreamUrl).toBe('https://main--repo--owner.aem.page/');
  });
});

describe('worker.fetch — proxying behaviour', () => {
  const env: Env = { HOST_MAP: HOST_MAP_JSON };

  it('passes through non-HTML responses unchanged', async () => {
    mockUpstream(async () => {
      return new Response('body { color: red }', {
        status: 200,
        headers: { 'content-type': 'text/css' },
      });
    });
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/styles.css'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css');
    expect(await res.text()).toBe('body { color: red }');
  });

  it('passes through upstream 404 unchanged', async () => {
    mockUpstream(async () => {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    });
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/missing'),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('rewrites HTML responses, inlining fragment blocks from the resolved origin', async () => {
    mockUpstream(async (req) => {
      if (req.url === 'https://main--r--o.aem.page/') {
        return new Response(
          '<!DOCTYPE html><html><head></head><body><main><div><h2>x</h2>' +
            '<div class="fragment"><div><div><a href="/frag/x">/frag/x</a></div></div></div>' +
            '</div></main></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (req.url === 'https://main--r--o.aem.page/frag/x.plain.html') {
        return new Response('<div><p>FRAG-X</p></div>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('miss', { status: 599 });
    });
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/'),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<p>FRAG-X</p>');
    expect(body).toContain('data-ssr="inlined"');
    expect(body).toContain('fragment-container');
  });

  it('drops content-length and content-encoding headers when rewriting HTML', async () => {
    mockUpstream(async () => {
      return new Response('<html><head></head><body></body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': '50',
          'content-encoding': 'br',
          'cache-control': 'max-age=60',
        },
      });
    });
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/'),
      env,
    );
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('max-age=60');
  });

  it('passes ALLOWED_FRAGMENT_HOSTS through to the inliner so external URLs are fetched as-is', async () => {
    const envWithHosts: Env = {
      HOST_MAP: HOST_MAP_JSON,
      ALLOWED_FRAGMENT_HOSTS: '["api.example.com"]',
    };
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        seen.push(url);
        if (url === 'https://main--r--o.aem.page/') {
          return new Response(
            '<!DOCTYPE html><html><head></head><body><main><div>' +
              '<div class="fragment"><div><div><a href="https://api.example.com/data">x</a></div></div></div>' +
              '</div></main></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
        if (url === 'https://api.example.com/data') {
          return new Response('<p>from external host</p>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response('miss', { status: 599 });
      }),
    );
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/'),
      envWithHosts,
    );
    expect(seen).toContain('https://api.example.com/data');
    const body = await res.text();
    expect(body).toContain('<p>from external host</p>');
  });

  it('treats malformed ALLOWED_FRAGMENT_HOSTS as an empty set (no crash)', async () => {
    const envBad: Env = { HOST_MAP: HOST_MAP_JSON, ALLOWED_FRAGMENT_HOSTS: 'not json' };
    mockUpstream(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/'),
      envBad,
    );
    expect(res.status).toBe(200);
  });

  it('treats a non-array ALLOWED_FRAGMENT_HOSTS as an empty set', async () => {
    const envObj: Env = { HOST_MAP: HOST_MAP_JSON, ALLOWED_FRAGMENT_HOSTS: '{"not":"an array"}' };
    mockUpstream(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/'),
      envObj,
    );
    expect(res.status).toBe(200);
  });

  it('forwards a body on non-GET/HEAD requests', async () => {
    let received: Request | undefined;
    mockUpstream(async (req) => {
      received = req;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env,
    );
    expect(received?.method).toBe('POST');
    expect(await received?.text()).toBe('{"hello":"world"}');
  });

  it('ignores empty values in a comma-separated X-Forwarded-Host header', async () => {
    let upstreamUrl = '';
    mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://nomatch.example/', {
        headers: { 'x-forwarded-host': ', main--r--o.aem.page, ' },
      }),
      env,
    );
    expect(upstreamUrl).toBe('https://main--r--o.aem.page/');
  });

  it('strips hop-by-hop, cf-*, and x-forwarded-* request headers before forwarding upstream', async () => {
    let received: Headers | undefined;
    mockUpstream(async (req) => {
      received = req.headers;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await worker.fetch(
      new Request('https://main--r--o--page.diffatech.co.uk/', {
        headers: {
          'accept': 'text/html',
          'cf-ray': 'should-be-dropped',
          'x-forwarded-for': '1.2.3.4',
          'x-forwarded-host': 'main--r--o.aem.page', // used for resolution, also stripped on forward
          'connection': 'keep-alive',
        },
      }),
      env,
    );
    expect(received?.get('accept')).toBe('text/html');
    expect(received?.get('cf-ray')).toBeNull();
    expect(received?.get('x-forwarded-for')).toBeNull();
    expect(received?.get('x-forwarded-host')).toBeNull();
    expect(received?.get('connection')).toBeNull();
    // Host should be rewritten to upstream host
    expect(received?.get('host')).toBe('main--r--o.aem.page');
  });
});
