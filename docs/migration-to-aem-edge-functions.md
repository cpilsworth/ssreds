# Convert ssreds from Cloudflare Worker → AEM Edge Function (Fastly Compute)

## Context

`ssreds` was originally a **Cloudflare Worker** (`wrangler`-deployed) that fronts
Adobe EDS sites and inlines `div.fragment` content server-side. This document is
the implementation plan for re-platforming it as an **AEM Edge Function** —
JavaScript that runs at Adobe's Managed CDN layer, which is **Fastly Compute**
under the hood, deployed via the **Adobe I/O (`aio`) CLI** plugin
`@adobe/aio-cli-plugin-aem-edge-functions`.

The canonical template is [`adobe/aem-edge-functions-boilerplate`](https://github.com/adobe/aem-edge-functions-boilerplate):
Fastly Compute (`@fastly/js-compute` → WASM), `addEventListener("fetch", …)`
entry, named backends, `ConfigStore`/`SecretStore`, and Adobe config files
(`config/edgeFunctions.yaml`, `config/cdn.yaml`, `fastly.toml`).

**Confirmed decisions:** keep **TypeScript** (transpile → WASM); adopt the native
**single-origin declared-backend + `cdn.yaml`** model (drop the multi-tenant
HOST_MAP proxy); keep **vitest** for the pure fragment logic.

The core fragment-inlining algorithm in `src/fragments.ts` is platform-agnostic
string manipulation and is **preserved as-is**, with one change: it must not
import `fastly:*` modules (so vitest/node can still run it), so Fastly fetch
options are passed in from the entry point.

## Target architecture

```
incoming HTML request
  → Adobe Managed CDN  (cdn.yaml originSelectors route HTML paths to the edge fn)
  → addEventListener("fetch")  [src/index.ts]
      → fetch(EDS origin, { backend: "eds_origin", cacheOverride })
      → if HTML: inlineFragments(html, …, fetchInit)  [src/fragments.ts unchanged logic]
          → fetch(*.plain.html, { backend, cacheOverride })   (same single origin)
  → rewritten HTML response
```

Origin is a single EDS host (e.g. `main--repo--owner.aem.live`) read from
`ConfigStore('config_default')` key `EDS_ORIGIN`, fetched through one declared
backend `eds_origin`. HOST_MAP / `X-Forwarded-Host` multi-tenant routing is removed.

## File-by-file changes

### `src/index.ts` — rewrite entry/handler (keep TS)
- Replace `export default { fetch(request, env) }` with:
  ```ts
  /// <reference types="@fastly/js-compute" />
  addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
  ```
- `handleRequest(event)` reads `event.request`; drop the `Env` param and the
  `HOST_MAP` JSON parsing. Replace `resolveOrigin` with `getOrigin()` reading
  `ConfigStore('config_default').get('EDS_ORIGIN')`.
- Keep `STRIPPED_REQUEST_HEADERS` and `buildUpstreamRequest`. Set the upstream
  URL host to the EDS origin host so EDS sees the right `Host`.
- Upstream fetch becomes `fetch(upstreamRequest, { backend: BACKEND, cacheOverride })`
  using `new CacheOverride('override', { ttl: 300 })` from `fastly:cache-override`.
- Pass a fetch-init `{ backend: BACKEND, cacheOverride }` into `inlineFragments`
  so fragment sub-fetches use the same backend.
- Keep `isHtmlResponse`; on non-HTML, return upstream response unchanged.
- Wrap in try/catch returning a 500.

### `src/fastly.ts` — new, isolates `fastly:*` imports
- Export `BACKEND = "eds_origin"`, `getOrigin()` (ConfigStore lookup that throws
  → 502), and `buildCacheOverride(ttl)`. Only `index.ts` imports this; tested
  modules never do, keeping vitest node-runnable.

### `src/proxy.ts` — new, platform-agnostic helpers
- `buildUpstreamRequest` and `isHtmlResponse`, no `fastly:*` imports. Note:
  Fastly's `RequestInit` has **no `redirect` option** (the runtime never follows
  redirects), so it is omitted.

### `src/fragments.ts` — minimal, surgical change
- Algorithm is **unchanged**.
- `inlineFragments(...)` and `fetchAndInline(...)` gain an optional
  `fetchInit: RequestInit = {}` param, threaded through recursion.
- In `fetchAndInline`, replace the Cloudflare-specific
  `fetch(url, { headers, cf: { cacheTtl, cacheEverything } })` with
  `fetch(url, { ...fetchInit, headers: { accept: 'text/html' } })`. The
  `CacheOverride` object is built in `index.ts` and arrives via `fetchInit`,
  so `fragments.ts` imports no `fastly:*` module.

## New / replaced config files

- **`fastly.toml`** (replaces `wrangler.toml`): `language = "javascript"`,
  `manifest_version = 3`, `[scripts] build = "npm run build"`,
  `post_init = "npm install"`, and `[local_server]` with
  `backends.eds_origin.url` and `config_stores.config_default.contents.EDS_ORIGIN`
  for local dev.
- **`config/edgeFunctions.yaml`**: `kind: EdgeFunctions`, one service `name: ssreds`.
- **`config/cdn.yaml`**: `kind: CDN` originSelectors routing HTML document paths
  to `originName: edgefunction-ssreds`.
- **Delete** `wrangler.toml`.

## package.json / tsconfig / build pipeline

- Scripts: `prebuild` = `tsc -p tsconfig.build.json` (emit JS to `build/`),
  `build` = `js-compute-runtime ./build/index.js ./bin/main.wasm`, `dev` =
  `aio aem edge-functions serve` (local at `127.0.0.1:7676`), `deploy` =
  `aio aem edge-functions deploy ssreds`. Keep `typecheck`, `lint`, `test`,
  `test:coverage`.
- deps: add `@fastly/js-compute` (^3.41.x). Remove `wrangler` and
  `@cloudflare/workers-types`. `tsc` emit alone feeds `js-compute-runtime`
  (which bundles) — no esbuild step needed.
- `tsconfig.json`: swap `types: ["@cloudflare/workers-types"]` →
  `["@fastly/js-compute"]`, keep `noEmit` for typecheck. `tsconfig.build.json`
  extends it with `noEmit: false` + `outDir: build`. Add `bin/`, `build/` to
  `.gitignore`.

## Tests (vitest, kept)

- **`test/fragments.test.ts`**: unchanged — `inlineFragments`'s new `fetchInit`
  param defaults to `{}`, so existing mocks keep passing.
- **`test/index.test.ts`** → **`test/proxy.test.ts`**: the old file imported
  `worker, { Env }` and asserted HOST_MAP behavior — gone. New tests cover
  `proxy.ts` (`buildUpstreamRequest`, `isHtmlResponse`) directly.
- Coverage `include` narrowed to `src/fragments.ts` + `src/proxy.ts`; `index.ts`
  and `fastly.ts` (fastly globals) are excluded since they can't run under node.

## CI (`.github/workflows/ci.yml`)

- Keep lint + typecheck + test; add a `build` step (`npm run build`) to catch
  WASM-compile breakage.
- Replace the `cloudflare/wrangler-action` deploy job with an `aio`-based deploy
  (install `@adobe/aio-cli` + the edge-functions plugin, then
  `aio aem edge-functions deploy ssreds`). Edge Delivery Site secrets in the
  `build` environment: `AEM_EDGE_FUNCTIONS_PROGRAM_ID`,
  `AEM_EDGE_FUNCTIONS_SITE_DOMAIN`, and `AEM_EDGE_FUNCTIONS_ADC_CLIENT_ID` /
  `_CLIENT_SECRET` / `_SCOPES`.

## Docs

- **`README.md`** + **`CLAUDE.md`**: rewrite the platform sections (Cloudflare/
  wrangler → AEM Edge Functions / Fastly Compute / aio). Preserve the still-true
  EDS cooperation notes (`data-ssr="inlined"`, `fragment.js` short-circuit,
  `URL.host` port gotcha, `findFragmentEnd` vs `findDivClose`). Replace
  wrangler/HOST_MAP/Universal-SSL notes with backend/`ConfigStore`/`cdn.yaml` and
  the **32-backend-requests-per-execution** Fastly limit.

## Verification

1. `npm install` then `npm run typecheck` — clean.
2. `npm run lint` — clean.
3. `npm run test:coverage` — fragment + proxy tests pass, thresholds met.
4. `npm run build` — produces `bin/main.wasm` (proves Fastly/WASM compile works).
5. `npm run dev` (`aio aem edge-functions serve`, `127.0.0.1:7676`) with a real
   EDS origin in `fastly.toml` local backend; `curl` an HTML page and confirm
   `data-ssr="inlined"` fragments are inlined and a `.plain.html` page passes
   through unchanged. (Requires `aio` CLI + plugin installed locally.)
