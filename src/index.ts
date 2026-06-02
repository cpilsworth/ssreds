/// <reference types="@fastly/js-compute" />

import { inlineFragments } from './fragments';
import { buildUpstreamRequest, isHtmlResponse } from './proxy';
import { BACKEND, buildCacheOverride, getOrigin } from './fastly';

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
  let origin: string;
  try {
    origin = getOrigin();
  } catch {
    return new Response('No EDS origin configured', { status: 502 });
  }

  // Single backend + cache override reused for the page fetch and every
  // fragment sub-fetch. Mind Fastly's limit of 32 backend requests per
  // execution — deep fragment recursion (MAX_DEPTH) plus fan-out shares it.
  const fetchInit: RequestInit = {
    backend: BACKEND,
    cacheOverride: buildCacheOverride(300),
  };

  try {
    const upstreamRequest = buildUpstreamRequest(event.request, origin);
    const upstreamResponse = await fetch(upstreamRequest, fetchInit);

    if (!isHtmlResponse(upstreamResponse)) {
      return upstreamResponse;
    }

    const originalHtml = await upstreamResponse.text();
    const rewrittenHtml = await inlineFragments(
      originalHtml,
      origin,
      event.request.url,
      0,
      new Set(),
      fetchInit,
    );

    const headers = new Headers(upstreamResponse.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(rewrittenHtml, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  } catch (err) {
    console.error(err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
