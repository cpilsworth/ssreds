import { inlineFragments } from './fragments';

export interface Env {
  ORIGIN: string;
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
  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });
}

function isHtmlResponse(response: Response): boolean {
  const ct = response.headers.get('content-type') ?? '';
  return ct.toLowerCase().includes('text/html');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ORIGIN) {
      return new Response('ORIGIN env var is not configured', { status: 500 });
    }

    const upstreamRequest = buildUpstreamRequest(request, env.ORIGIN);
    const upstreamResponse = await fetch(upstreamRequest);

    if (!isHtmlResponse(upstreamResponse)) {
      return upstreamResponse;
    }

    const originalHtml = await upstreamResponse.text();
    const rewrittenHtml = await inlineFragments(originalHtml, env.ORIGIN, request.url);

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
