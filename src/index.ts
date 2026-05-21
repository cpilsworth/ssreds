import { inlineFragments } from './fragments';

export interface Env {
  HOST_MAP: string;
}

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

function resolveOrigin(request: Request, env: Env): string | null {
  let map: Record<string, string>;
  try {
    const parsed = JSON.parse(env.HOST_MAP) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    map = parsed as Record<string, string>;
  } catch {
    return null;
  }

  const candidates: string[] = [new URL(request.url).hostname];
  const forwarded = request.headers.get('x-forwarded-host');
  if (forwarded) {
    for (const value of forwarded.split(',')) {
      const host = value.trim().split(':')[0].toLowerCase();
      if (host) candidates.push(host);
    }
  }

  for (const host of candidates) {
    for (const suffix of Object.keys(map)) {
      if (host.endsWith(suffix) && host.length > suffix.length) {
        const label = host.slice(0, -suffix.length);
        return `https://${label}.${map[suffix]}`;
      }
    }
  }
  return null;
}

function buildUpstreamRequest(request: Request, origin: string): Request {
  const reqUrl = new URL(request.url);
  const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, origin);

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const lk = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lk)) continue;
    if (lk.startsWith('cf-')) continue;
    if (lk.startsWith('x-forwarded-')) continue;
    headers.set(key, value);
  }
  headers.set('host', upstreamUrl.host);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // `duplex: 'half'` is required by the Fetch standard whenever a streaming
  // body is sent; Cloudflare's runtime accepts it, Node/undici requires it.
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(upstreamUrl.toString(), init);
}

function isHtmlResponse(response: Response): boolean {
  const ct = response.headers.get('content-type') ?? '';
  return ct.toLowerCase().includes('text/html');
}

// The worker tags each inlined fragment block with `data-ssr="inlined"`.
// The site's blocks/fragment/fragment.js must check for this and unwrap
// the block before invoking its normal fetch-and-replace logic, e.g.:
//
//   export default async function decorate(block) {
//     if (block.dataset.ssr === 'inlined') {
//       block.replaceWith(...block.childNodes);
//       return;
//     }
//     // ...existing logic
//   }
//
// With this in place, aem.js's decorateBlock still adds `fragment-wrapper`
// to the parent and `fragment-container` to the section, then fragment.js
// unwraps the block — yielding a DOM identical to origin's post-decoration
// shape without any network round-trips.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = resolveOrigin(request, env);
    if (!origin) {
      return new Response('No origin configured for this host', { status: 502 });
    }

    const upstreamRequest = buildUpstreamRequest(request, origin);
    const upstreamResponse = await fetch(upstreamRequest);

    if (!isHtmlResponse(upstreamResponse)) {
      return upstreamResponse;
    }

    const originalHtml = await upstreamResponse.text();
    const rewrittenHtml = await inlineFragments(originalHtml, origin, request.url);

    const headers = new Headers(upstreamResponse.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(rewrittenHtml, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  },
};
