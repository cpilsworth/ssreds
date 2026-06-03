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
  // We rewrite the HTML body, so the origin must return it uncompressed.
  // Fastly's fetch() does NOT auto-decompress, so a gzip/br body would make
  // response.text() throw "malformed UTF-8". Strip accept-encoding to force an
  // identity response; the outer Managed CDN re-compresses for the client.
  'accept-encoding',
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

// Opt-in request header that turns on perf instrumentation (Server-Timing +
// x-compute-* response headers). Off by default so normal traffic is unaffected.
export const PERF_TRACE_HEADER = 'x-perf-trace';

export interface TimingMetric {
  /** duration in milliseconds */
  dur: number;
  /** optional human description (Server-Timing `desc`) */
  desc?: string;
}

/**
 * Render a `Server-Timing` header value from named metrics, e.g.
 *   { total: { dur: 12.3 }, fragments: { dur: 3, desc: '4 fetches' } }
 *   => "total;dur=12.300, fragments;dur=3.000;desc=\"4 fetches\""
 */
export function formatServerTiming(metrics: Record<string, TimingMetric>): string {
  return Object.entries(metrics)
    .map(([name, m]) => {
      const base = `${name};dur=${m.dur.toFixed(3)}`;
      return m.desc ? `${base};desc="${m.desc}"` : base;
    })
    .join(', ');
}
