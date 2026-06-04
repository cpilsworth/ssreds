# SSREDS - SSR fragment inliner for Adobe Edge Delivery Services

An **AEM Edge Function** that fronts an Adobe Edge Delivery Services (EDS) site
and inlines `div.fragment` block content server-side. The HTML returned to the
client already contains every fragment's resolved markup — so crawlers, LLMs,
and JS-disabled clients see the full page on first byte, without executing
`fragment.js`. In JS-enabled browsers the post-decoration DOM is identical to
origin (no extra wrappers, no double fetches).

AEM Edge Functions run JavaScript at Adobe's Managed CDN layer, which is
**Fastly Compute** under the hood. This project is written in TypeScript,
compiled to JS and then to WASM via [`@fastly/js-compute`](https://www.npmjs.com/package/@fastly/js-compute),
and deployed with the **Adobe I/O (`aio`) CLI**.

## How it works

1. A request for an HTML document arrives. Adobe's Managed CDN routes it to this
   edge function (see [`config/cdn.yaml`](config/cdn.yaml) origin selectors).
2. The function proxies the request to the EDS origin through the `eds_origin`
   backend, stripping hop-by-hop and `x-forwarded-*` headers and rewriting
   `Host` to the upstream. The origin is read from the `EDS_ORIGIN` ConfigStore
   value (see [Configuration](#configuration)).
3. For `text/html` responses, it parses the body for `<div class="fragment">`
   blocks. For each one it fetches `<href>.plain.html` from the same origin
   (in parallel, with a 5-minute cache override) and:
   - tags the block with `data-ssr="inlined"` so client-side `fragment.js` can
     short-circuit (see [Required fragment.js change](#required-fragmentjs-change))
   - decorates the inlined content with `<div class="section"><div class="default-content-wrapper">…</div></div>` to mirror what `decorateSections` would produce in the browser
   - adds `fragment-container` to the surrounding section
4. Nested fragments are resolved recursively (depth-capped at 5; a visited-set
   breaks cycles).
5. Everything else (CSS, JS, images, JSON, redirects, error responses) streams
   through unchanged.

> **Fastly limit:** a single execution may make at most **32 backend requests**.
> The page fetch plus recursive fragment fan-out (`MAX_DEPTH` = 5) all share
> that budget — keep fragment graphs shallow on heavily-fragmented pages.

## Configuration

This function fronts a **single** EDS origin. Two pieces of configuration drive
it:

- **`EDS_ORIGIN`** — the EDS hostname (or full origin URL) to proxy, read from
  the `config_default` ConfigStore at runtime by `getOrigin()` in
  [`src/fastly.ts`](src/fastly.ts). e.g. `main--repo--owner.aem.live`.
- **`eds_origin` backend** — the named Fastly backend every upstream and
  fragment fetch routes through.

For **local development** both live in [`fastly.toml`](fastly.toml) under
`[local_server]`:

```toml
[local_server.backends.eds_origin]
  url = "https://main--repo--owner.aem.live"

[local_server.config_stores.config_default.contents]
  EDS_ORIGIN = "main--repo--owner.aem.live"
```

In **production** the backend and config value are provisioned by the AEM Edge
Functions service ([`config/edgeFunctions.yaml`](config/edgeFunctions.yaml)) and
the Adobe Managed CDN. [`config/cdn.yaml`](config/cdn.yaml) decides which request
paths are routed to the function (by default, HTML document paths).

## Required fragment.js change

This function tags inlined fragment blocks with `data-ssr="inlined"`. Your
site's `blocks/fragment/fragment.js` should short-circuit on that marker:

```js
export default async function decorate(block) {
  if (block.dataset.ssr === 'inlined') {
    block.replaceWith(...block.childNodes);
    return;
  }
  // …existing logic
}
```

What this gives you:

- `aem.js`'s `decorateBlock` still adds `fragment-wrapper` to the parent and
  `fragment-container` to the section (same as origin).
- `fragment.js` then unwraps the `<div class="fragment">` so the final DOM is
  `fragment-wrapper > section > default-content-wrapper > …`, byte-for-byte
  identical in structure to what the unproxied origin produces after JS runs.
- No fetch, no flash of unstyled content, no extra wrapper layer.

The function still works without this change — the content is visible to
crawlers either way — but the in-browser DOM will have an extra
`<div class="fragment block">` layer until you ship it.

## Local development

Requires the [`aio` CLI](https://github.com/adobe/aio-cli) with the AEM Edge
Functions plugin installed:

```bash
npm install -g @adobe/aio-cli
aio plugins:install @adobe/aio-cli-plugin-aem-edge-functions
```

Then, in this repo:

```bash
npm install
npm run dev          # aio aem edge-functions serve
```

The local runtime serves at `http://127.0.0.1:7676/`. Point the `eds_origin`
backend and `EDS_ORIGIN` value in [`fastly.toml`](fastly.toml) at the site you
are developing against, then:

```bash
curl -i http://127.0.0.1:7676/
```

## Build

```bash
npm run build        # tsc -> build/*.js, then js-compute-runtime -> bin/main.wasm
```

`prebuild` transpiles the TypeScript in `src/` to `build/` with `tsc`, then
`build` compiles `build/index.js` to `bin/main.wasm` with `js-compute-runtime`.
Both `build/` and `bin/` are git-ignored.

## Tests

```bash
npm test                # vitest run
npm run test:watch      # vitest watch mode
npm run test:coverage   # full coverage report
```

Coverage thresholds (enforced): 90% lines / 80% branches / 90% functions /
90% statements, measured over the platform-agnostic modules
([`src/fragments.ts`](src/fragments.ts) and [`src/proxy.ts`](src/proxy.ts)).
`src/index.ts` and `src/fastly.ts` import `fastly:*` modules and use the Fastly
Compute global runtime, so they can't run under node/vitest and are excluded
from coverage. Two suites:

- [`test/fragments.test.ts`](test/fragments.test.ts) — fragment inliner: empty pages, single/multiple fragments, 404s, network errors, recursive nesting, cycle detection, depth limit, malformed hrefs, multi-section `.plain.html`, entity-decoded hrefs, trailing-slash + pre-suffixed paths.
- [`test/proxy.test.ts`](test/proxy.test.ts) — request/response helpers: upstream URL rebuilding, host rewriting, header stripping, POST body forwarding (with `duplex: 'half'`), and HTML content-type detection.

## Performance

A load/perf harness lives in [`perf/`](perf/). It measures two layers per
request:

**Client-side latency** — `performance.now()` brackets each `fetch()` in
[`perf/loadtest.mjs:104`](perf/loadtest.mjs#L104), covering full round-trip
including body download, reduced to p50/p90/p99/max by
[`summarize()`](perf/loadtest.mjs#L72).

**Fastly server-side metrics** — opt-in via `x-perf-trace: 1`
([`src/proxy.ts:66`](src/proxy.ts#L66) `PERF_TRACE_HEADER`), detected in
[`src/index.ts:38`](src/index.ts#L38), which then:
- reads **vCPU work time** via [`vCpuTimeMs()`](src/fastly.ts#L35) (wraps
  `vCpuTime()` from `fastly:compute` — CPU cycles only, not I/O wait)
- serialises **upstream / fragments / total** wall times as a `Server-Timing`
  header via [`formatServerTiming()`](src/proxy.ts#L80)
  ([`src/index.ts:101`](src/index.ts#L101))
- writes **backend-request count** as `x-compute-backend-reqs`
  ([`src/index.ts:102`](src/index.ts#L102))

The harness parses `Server-Timing` via
[`parseServerTiming()`](perf/loadtest.mjs#L87) and falls back to
`x-compute-vcpu-ms` for vCPU if needed
([`loadtest.mjs:118`](perf/loadtest.mjs#L118)).

```bash
npm run dev                                   # start local server first
npm run perf                                  # hit http://127.0.0.1:7676
npm run perf -- --base https://your-site -n 500 -c 25   # or a deployed site
```

See [`perf/README.md`](perf/README.md) for options, scenarios, and how to read
vCPU vs wall time (and why local Viceroy numbers aren't production-representative).

## Lint and typecheck

```bash
npm run lint
npm run typecheck
```

ESLint is on `typescript-eslint`'s `recommendedTypeChecked` ruleset with a
relaxation of `require-await` in tests (fetch mocks idiomatically declare
`async () => new Response(...)` even when they don't await).

## CI / Deploy

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) defines the pipeline:

| Trigger | Steps |
|---|---|
| Pull request to `main` | lint → typecheck → test → build (WASM) |
| Push to `main` | lint → typecheck → test → build → deploy |
| `workflow_dispatch` | full pipeline |

The deploy job installs the `aio` CLI + edge-functions plugin and runs
`aio aem edge-functions deploy ssreds`. It uses the GitHub environment named
`build`, which must hold these secrets (Edge Delivery Site variant):

- `AEM_EDGE_FUNCTIONS_PROGRAM_ID` — Cloud Manager program ID
- `AEM_EDGE_FUNCTIONS_SITE_DOMAIN` — the Edge Delivery site domain
- `AEM_EDGE_FUNCTIONS_ADC_CLIENT_ID` / `_CLIENT_SECRET` / `_SCOPES` — OAuth
  Server-to-Server credentials from the Adobe Developer Console

For manual deploys:

```bash
npm run deploy       # aio aem edge-functions deploy ssreds
```

## Verifying a deploy

```bash
SITE=https://your-edge-delivery-site.example

# Origin should have at least one fragment block
curl -s "$SITE/" | grep -c 'class="fragment"'         # > 0

# Through the edge function, fragment blocks are inlined
curl -s "$SITE/" | grep -c 'data-ssr="inlined"'       # > 0  (function marker)
curl -s "$SITE/" | grep -c 'fragment-container'       # > 0  (section annotation)

# Non-HTML pass-through (not routed to the function)
curl -sI "$SITE/styles/styles.css"                    # 200, text/css
curl -sI "$SITE/scripts/scripts.js"                   # 200, javascript
```

## Project layout

```
ssreds/
├── src/
│   ├── index.ts          # addEventListener fetch handler: proxy + dispatch
│   ├── proxy.ts          # platform-agnostic request/response helpers
│   ├── fastly.ts         # fastly:* imports (backend, ConfigStore, CacheOverride)
│   └── fragments.ts      # fragment detection, fetch, decoration, substitution
├── test/
│   ├── fragments.test.ts
│   └── proxy.test.ts
├── perf/
│   ├── loadtest.mjs      # load harness: latency percentiles + Fastly vCPU
│   ├── scenarios.json    # default perf scenarios
│   └── README.md
├── config/
│   ├── edgeFunctions.yaml  # AEM Edge Functions service declaration
│   └── cdn.yaml            # Managed CDN origin-selector routing
├── .github/workflows/
│   └── ci.yml            # lint + typecheck + test + build + deploy
├── fastly.toml           # Fastly Compute manifest + local_server config
├── eslint.config.js
├── tsconfig.json         # typecheck config (noEmit)
├── tsconfig.build.json   # build config (emits to build/)
├── vitest.config.ts
└── package.json
```
