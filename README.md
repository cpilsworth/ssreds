# ssreds — SSR fragment inliner for Adobe Edge Delivery Services

A Cloudflare Worker that fronts one or more Adobe Edge Delivery Services (EDS)
sites and inlines `div.fragment` block content server-side. The HTML returned
to the client already contains every fragment's resolved markup — so crawlers,
LLMs, and JS-disabled clients see the full page on first byte, without
executing `fragment.js`. In JS-enabled browsers the post-decoration DOM is
identical to origin (no extra wrappers, no double fetches).

## How it works

1. A request arrives. The worker resolves the upstream EDS origin from
   `HOST_MAP` (see [Configuration](#configuration)).
2. It proxies the request transparently, stripping hop-by-hop and `cf-*` /
   `x-forwarded-*` headers and rewriting `Host` to the upstream.
3. For `text/html` responses, it parses the body for `<div class="fragment">`
   blocks. For each one it fetches `<href>.plain.html` from the same origin
   (in parallel, with a 5-minute edge cache) and:
   - tags the block with `data-ssr="inlined"` so client-side `fragment.js` can
     short-circuit (see [Required fragment.js change](#required-fragmentjs-change))
   - decorates the inlined content with `<div class="section"><div class="default-content-wrapper">…</div></div>` to mirror what `decorateSections` would produce in the browser
   - adds `fragment-container` to the surrounding section
4. Nested fragments are resolved recursively (depth-capped at 5; visited-set
   breaks cycles).
5. Everything else (CSS, JS, images, JSON, redirects, error responses) streams
   through unchanged.

## Configuration

The worker is multi-tenant — a single deployment can front any number of EDS
sites via the host name. Configuration lives in [`wrangler.toml`](wrangler.toml):

```toml
[vars]
HOST_MAP = '{"--live.diffatech.co.uk":"aem.live","--page.diffatech.co.uk":"aem.page",".aem.live":"aem.live",".aem.page":"aem.page"}'

[[routes]]
pattern = "*--live.diffatech.co.uk/*"
zone_name = "diffatech.co.uk"

[[routes]]
pattern = "*--page.diffatech.co.uk/*"
zone_name = "diffatech.co.uk"
```

`HOST_MAP` is a JSON object mapping **hostname suffix → EDS host suffix**.
At request time the worker:

1. Reads the request's hostname.
2. Falls back to each value in the `X-Forwarded-Host` header (left-to-right)
   if no match — useful when this worker is itself fronted by another CDN.
3. For the first matching suffix, strips it from the host and rebuilds the
   origin: `https://<remaining-label>.<eds-host-suffix>`.

### Examples (with the default `HOST_MAP`)

| Request hostname | Resolved origin |
|---|---|
| `main--repo--owner--live.diffatech.co.uk` | `https://main--repo--owner.aem.live` |
| `main--repo--owner--page.diffatech.co.uk` | `https://main--repo--owner.aem.page` |
| `main--repo--owner.aem.live` (via `X-Forwarded-Host`) | `https://main--repo--owner.aem.live` |
| anything else | — (returns `502 No origin configured for this host`) |

To use your own zone, swap `diffatech.co.uk` in both `HOST_MAP` and the
`[[routes]]` patterns. You'll also need a wildcard DNS record in that zone:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `AAAA` | `*` | `100::` | Proxied |

Universal SSL covers the single-level wildcard for free. The two routes are
intentionally narrow (`*--live.<zone>` and `*--page.<zone>`) so unrelated
subdomains on the same zone are unaffected.

## Required fragment.js change

This worker tags inlined fragment blocks with `data-ssr="inlined"`. Your
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

The worker still works without this change — the content is visible to
crawlers either way — but the in-browser DOM will have an extra
`<div class="fragment block">` layer until you ship it.

## Local development

```bash
npm install
npm run dev          # wrangler dev, defaults to whatever HOST_MAP is in wrangler.toml
```

The dev server runs at `http://127.0.0.1:8787/`. Hit it with an
`X-Forwarded-Host` header to test against an arbitrary EDS site:

```bash
curl -i \
  -H "X-Forwarded-Host: main--j2retail--cpilsworth.aem.page" \
  http://127.0.0.1:8787/
```

Or override `HOST_MAP` per-run:

```bash
npx wrangler dev --var ORIGIN:... --var HOST_MAP:...
```

## Tests

```bash
npm test                # vitest run
npm run test:watch      # vitest watch mode
npm run test:coverage   # full coverage report
```

Coverage thresholds (enforced): 90% lines / 80% branches / 90% functions /
90% statements. Two suites:

- [`test/fragments.test.ts`](test/fragments.test.ts) — fragment inliner: empty pages, single/multiple fragments, 404s, network errors, recursive nesting, cycle detection, depth limit, malformed hrefs, multi-section `.plain.html`, entity-decoded hrefs, trailing-slash + pre-suffixed paths.
- [`test/index.test.ts`](test/index.test.ts) — worker fetch handler: origin resolution (HOST_MAP suffixes, raw EDS hostnames, `X-Forwarded-Host` chain, ports stripped), 502s, header stripping/rewriting, non-HTML pass-through, content-length/-encoding stripping, POST body forwarding (with `duplex: 'half'`).

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
| Pull request to `main` | lint → typecheck → test |
| Push to `main` | lint → typecheck → test → deploy |
| `workflow_dispatch` | full pipeline |

The deploy job uses the GitHub environment named `build`, which must hold:

- `CLOUDFLARE_API_TOKEN` — token with these permissions:
  - **Account** Workers Scripts: Edit, Account Settings: Read
  - **Zone** (your zone) Workers Routes: Edit
  - **User** User Details: Read
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

For manual deploys:

```bash
npm run deploy
```

## Verifying a deploy

```bash
PAGE_HOST=main--your-site--your-org--page.diffatech.co.uk
ORIGIN=https://main--your-site--your-org.aem.page

# Origin should have at least one fragment block
curl -s "$ORIGIN/" | grep -c 'class="fragment"'         # > 0

# Through the proxy, fragment blocks are inlined
curl -s "https://$PAGE_HOST/" | grep -c 'class="fragment"'  # > 0  (the <div class="fragment"> wrapper, with content now inside)
curl -s "https://$PAGE_HOST/" | grep -c 'data-ssr="inlined"'  # > 0  (worker marker)
curl -s "https://$PAGE_HOST/" | grep -c 'fragment-container'  # > 0  (section annotation)

# Non-HTML pass-through
curl -sI "https://$PAGE_HOST/styles/styles.css"          # 200, text/css
curl -sI "https://$PAGE_HOST/scripts/scripts.js"         # 200, javascript
```

## Project layout

```
ssreds/
├── src/
│   ├── index.ts          # fetch handler: origin resolution, proxy, dispatch
│   └── fragments.ts      # fragment detection, fetch, decoration, substitution
├── test/
│   ├── fragments.test.ts
│   └── index.test.ts
├── .github/workflows/
│   └── ci.yml            # lint + test + deploy on push to main
├── wrangler.toml         # name, routes, HOST_MAP
├── eslint.config.js
├── tsconfig.json
├── vitest.config.ts
└── package.json
```
