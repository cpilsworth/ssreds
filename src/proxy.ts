// Platform-agnostic request/response helpers shared by the edge-function
// entry point (`index.ts`). Deliberately free of any `fastly:*` imports so it
// can run under vitest/node — the Fastly-specific fetch options (backend,
// cacheOverride) are built in `index.ts` and threaded through as a plain
// `RequestInit`.

const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Rebuild the incoming request against the EDS origin: same path + query, but
 * the origin's protocol/host. Hop-by-hop and proxy-leakage headers are
 * stripped; the `host` header is set to the upstream host so EDS routes to the
 * right site.
 */
export function buildUpstreamRequest(request: Request, origin: string): Request {
  const reqUrl = new URL(request.url);
  const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, origin);

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const lk = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lk)) continue;
    if (lk.startsWith('x-forwarded-')) continue;
    headers.set(key, value);
  }
  headers.set('host', upstreamUrl.host);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // Fastly Compute does not follow redirects (it returns the redirect response
  // verbatim), so there is no `redirect` option to set.
  // `duplex: 'half'` is required by the Fetch standard whenever a streaming
  // body is sent; both Fastly's runtime and Node/undici expect it.
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(upstreamUrl.toString(), init);
}

export function isHtmlResponse(response: Response): boolean {
  const ct = response.headers.get('content-type') ?? '';
  return ct.toLowerCase().includes('text/html');
}
