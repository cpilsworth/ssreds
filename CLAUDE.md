# Project context for Claude

An **AEM Edge Function** (Fastly Compute, deployed via the `aio` CLI) that
fronts an Adobe Edge Delivery Services (EDS) site and inlines `div.fragment`
block content server-side. Pre-decorates HTML so crawlers see content without
JS, and so the post-JS DOM matches origin byte-for-byte in structure.

See [README.md](README.md) for full usage. This file captures the non-obvious
things that have caused real bugs during development.

## Architecture

Written in TypeScript, compiled to JS (`tsc` → `build/`) and then to WASM
(`js-compute-runtime` → `bin/main.wasm`). Runs at Adobe's Managed CDN
(Fastly Compute). Entry point is `addEventListener("fetch", …)` in
[`src/index.ts`](src/index.ts). Fronts a **single** EDS origin (read from the
`EDS_ORIGIN` ConfigStore value, fetched through the `eds_origin` backend);
`config/cdn.yaml` decides which paths route to the function.

Module split is deliberate:
- `src/fastly.ts` — the **only** file importing `fastly:*` modules (ConfigStore,
  CacheOverride, backend constant).
- `src/proxy.ts` + `src/fragments.ts` — platform-agnostic, no `fastly:*`
  imports, so they run under vitest/node. Fastly fetch options (`backend`,
  `cacheOverride`) are built in `index.ts` and threaded in as a plain
  `RequestInit`. **Keep it this way** — importing `fastly:*` into these modules
  breaks the test run.

## Commands

```bash
npm run dev            # aio aem edge-functions serve on 127.0.0.1:7676
npm run build          # tsc -> build/*.js, then js-compute-runtime -> bin/main.wasm
npm run deploy         # aio aem edge-functions deploy ssreds
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, includes test/
npm test               # vitest run
npm run test:coverage  # with v8 coverage; thresholds 90/80/90/90
```

CI: `.github/workflows/ci.yml` runs lint+typecheck+test+build on PRs to `main`,
and deploys on push to `main` via the `build` GitHub environment (which holds
the `AEM_EDGE_FUNCTIONS_*` Adobe credentials — see README CI section).

## Non-obvious things

### Fastly `fetch` requires a backend; `RequestInit` has no `redirect`

Fastly Compute `fetch()` only reaches declared/dynamic backends — there is no
open `fetch`. Every upstream/fragment fetch passes `{ backend: 'eds_origin' }`.
Also, `@fastly/js-compute`'s `RequestInit` type has **no `redirect` option**
(the runtime never follows redirects — it returns the redirect response
verbatim). `tsc` will error on `redirect: 'manual'`; don't add it back.

### Cache control is `CacheOverride`, not Cloudflare's `cf:`

The old Worker used `fetch(url, { cf: { cacheTtl, cacheEverything } })`. On
Fastly that's `new CacheOverride('override', { ttl })` from
`fastly:cache-override`, passed as the `cacheOverride` fetch option. It is built
once in `index.ts` and reused for the page and all fragment fetches.

### Fastly 32-backend-requests-per-execution limit

A single function execution may make at most **32 backend requests**. The page
fetch plus recursive fragment fan-out (`MAX_DEPTH` = 5, parallel per level) all
draw from that budget. Deeply/heavily-fragmented pages can hit it — watch this
if changing `MAX_DEPTH` or fragment parallelism.

### `tsc` emit feeds `js-compute-runtime` directly — no bundler

`js-compute-runtime` bundles `build/index.js` and its imports into WASM itself,
so the build is just `tsc` (emit to `build/`) then `js-compute-runtime`. No
esbuild/rollup step is needed. `tsconfig.build.json` does the emit
(`noEmit: false`, `outDir: build`); `tsconfig.json` stays `noEmit` for
typechecking.

### EDS sites can patch `fragment.js`

The default boilerplate `blocks/fragment/fragment.js` guards its `fetch` with
`if (path && path.startsWith('/'))`. Some sites (e.g. `j2retail`) have this
commented out, so `fragment.js` will fetch *any* href — including a `#…`
fragment identifier, which the browser resolves to the current document, and
the current document gets inlined into itself. The preferred path is for sites
to add the 3-line `data-ssr === 'inlined'` short-circuit (see README).

### Cooperation pattern with the site's `fragment.js`

The function tags each inlined block with `data-ssr="inlined"`. The site's
`blocks/fragment/fragment.js` is expected to short-circuit on that marker:

```js
if (block.dataset.ssr === 'inlined') {
  block.replaceWith(...block.childNodes);
  return;
}
```

Without this, the in-browser DOM has an extra `<div class="fragment block">`
wrapper layer; crawlers are still fine.

### `URL.host` doesn't clear the port

```ts
const u = new URL('http://example.com:8787/x');
u.host = 'aem.live';        // becomes "aem.live:8787" — port leaked!
u.hostname = 'aem.live';    // becomes "aem.live", port still 8787
u.port = '';                // now correct
```

`resolveFragmentUrl` sets `hostname` and `port` separately for this reason.
(Originally surfaced as a 75-second hang when a local dev port leaked into
fragment fetches.)

### `duplex: 'half'` needed for body-forwarding `fetch()`

Node's undici (used by vitest in node environment) throws
`RequestInit: duplex option is required when sending a body` without it; the
Fastly runtime accepts it too. `buildUpstreamRequest` adds `duplex: 'half'`
only when there's a body; harmless in both runtimes.

### EDS sites use a per-request nonce CSP

`<script nonce="…" src="/scripts/aem.js" type="module">`. An earlier iteration
injected an inline `<script>` to neutralise `fragment.js` via
`MutationObserver`; CSP silently blocked it (no nonce). That approach is gone —
the `data-ssr` marker cooperation pattern replaced it.

### Test mocks: `async () => new Response(...)` is normal

Fetch handlers are commonly declared `async` to match the Fetch API shape
even when they synchronously return a `Response`. ESLint's `require-await`
is disabled for `test/**/*.ts` to allow this idiom. Don't "fix" the warnings
by removing `async` from mock handlers — the API contract is what we're
mocking.

### `findFragmentEnd` vs `findDivClose`

`findFragmentEnd` is a thin wrapper around `findDivClose` kept for one call
site (`findMainSections`). It returns just the close-tag end position; the
underlying `findDivClose` returns both `innerEnd` (position of `<`) and
`closeTagEnd` (position after `>`). Use `findDivClose` directly when you
need the inner range; the wrapper is fine when you only need the boundary.

## Trust boundaries

Unlike the previous multi-tenant Worker (which proxied any `*.aem.live` /
`*.aem.page` label), this function fronts a **single** configured `EDS_ORIGIN`
and runs inside that site's own Managed CDN pipeline — so the open-proxy /
attacker-controlled-label concern is gone. `Host` is rewritten to the upstream
and `x-forwarded-*` headers are stripped before forwarding.
