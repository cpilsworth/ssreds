/// <reference types="@fastly/js-compute" />

import { inlineFragments } from './fragments';
import {
  buildUpstreamRequest,
  formatServerTiming,
  isHtmlResponse,
  PERF_TRACE_HEADER,
  type TimingMetric,
} from './proxy';
import { buildCacheOverride, getOrigin, vCpuTimeMs } from './fastly';

// AEM Edge Function entry point. Runs as a Fastly Compute service at Adobe's
// Managed CDN layer; `cdn.yaml` originSelectors route HTML document paths here.
//
// The function fronts a single EDS origin (configured via the `EDS_ORIGIN`
// ConfigStore value, fetched through the `eds_origin` backend) and inlines
// `div.fragment` block content server-side so crawlers see content without JS
// and the post-JS DOM matches origin structure.
//
// Cooperation with the site's blocks/fragment/fragment.js: each inlined block
// is tagged `data-ssr="inlined"` so fragment.js can short-circuit, e.g.:
//
//   export default async function decorate(block) {
//     if (block.dataset.ssr === 'inlined') {
//       block.replaceWith(...block.childNodes);
//       return;
//     }
//     // ...existing logic
//   }

addEventListener('fetch', (event) => event.respondWith(handleRequest(event)));

async function handleRequest(event: FetchEvent): Promise<Response> {
  const start = performance.now();
  // Opt-in perf tracing: only attach Server-Timing / x-compute-* headers when
  // the caller (e.g. the load harness) sends the trace header.
  const trace = event.request.headers.has(PERF_TRACE_HEADER);

  let origin: string;
  try {
    origin = getOrigin();
  } catch {
    return new Response('No EDS origin configured', { status: 502 });
  }

  // No explicit `backend` option: the AEM Edge Functions runtime resolves the
  // upstream from the request URL host (dynamic backends), and local Viceroy
  // matches it against the `eds_origin` backend declared in fastly.toml. Naming
  // a backend that isn't provisioned in production makes fetch() throw. The
  // cache override is reused for the page fetch and every fragment sub-fetch.
  // Mind Fastly's limit of 32 backend requests per execution — deep fragment
  // recursion (MAX_DEPTH) plus fan-out shares it.
  const fetchInit: RequestInit = {
    cacheOverride: buildCacheOverride(300),
  };

  try {
    const upstreamRequest = buildUpstreamRequest(event.request, origin);
    const upstreamStart = performance.now();
    const upstreamResponse = await fetch(upstreamRequest, fetchInit);
    const upstreamMs = performance.now() - upstreamStart;

    let backendReqs = 1; // the page fetch above
    let fragmentMs = 0;
    let body: BodyInit | null;
    const headers = new Headers(upstreamResponse.headers);

    if (isHtmlResponse(upstreamResponse)) {
      const originalHtml = await upstreamResponse.text();
      const fragmentStart = performance.now();
      body = await inlineFragments(
        originalHtml,
        origin,
        event.request.url,
        0,
        new Set(),
        fetchInit,
        () => {
          backendReqs++;
        },
      );
      fragmentMs = performance.now() - fragmentStart;
      headers.delete('content-length');
      headers.delete('content-encoding');
    } else {
      body = upstreamResponse.body;
    }

    if (trace) {
      const metrics: Record<string, TimingMetric> = {
        total: { dur: performance.now() - start },
        upstream: { dur: upstreamMs },
        fragments: { dur: fragmentMs, desc: `${backendReqs - 1} fetches` },
      };
      const vcpu = vCpuTimeMs();
      if (vcpu !== undefined) {
        metrics.vcpu = { dur: vcpu };
        headers.set('x-compute-vcpu-ms', vcpu.toFixed(3));
      }
      headers.set('Server-Timing', formatServerTiming(metrics));
      headers.set('x-compute-backend-reqs', String(backendReqs));
    }

    return new Response(body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  } catch (err) {
    console.error(err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
