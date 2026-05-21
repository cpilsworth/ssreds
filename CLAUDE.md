# Project context for Claude

A Cloudflare Worker that fronts Adobe Edge Delivery Services (EDS) sites and
inlines `div.fragment` block content server-side. Pre-decorates HTML so
crawlers see content without JS, and so the post-JS DOM matches origin byte-
for-byte in structure.

See [README.md](README.md) for full usage. This file captures the non-obvious
things that have caused real bugs during development.

## Commands

```bash
npm run dev            # wrangler dev on 127.0.0.1:8787
npm run deploy         # wrangler deploy to ssreds.cpilsworth.workers.dev + routes
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, includes test/
npm test               # vitest run
npm run test:coverage  # with v8 coverage; thresholds 90/80/90/90
```

CI: `.github/workflows/ci.yml` runs lint+typecheck+test on PRs to `main`, and
deploys on push to `main` via the `build` GitHub environment (which holds
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

## Non-obvious things

### EDS sites can patch `fragment.js`

The default boilerplate `blocks/fragment/fragment.js` guards its `fetch` with
`if (path && path.startsWith('/'))`. Some sites (e.g. `j2retail`) have this
commented out, so `fragment.js` will fetch *any* href — including a `#…`
fragment identifier, which the browser resolves to the current document, and
the current document gets inlined into itself. Don't assume the default; the
worker now uses `/__ssr_inlined__` (a path that 404s) when it needs to put a
neutralisation href in the DOM, but the preferred path is for sites to add
the 3-line `data-ssr === 'inlined'` short-circuit (see README).

### Cooperation pattern with the site's `fragment.js`

The worker tags each inlined block with `data-ssr="inlined"`. The site's
`blocks/fragment/fragment.js` is expected to short-circuit on that marker:

```js
if (block.dataset.ssr === 'inlined') {
  block.replaceWith(...block.childNodes);
  return;
}
```

Without this, the in-browser DOM has an extra `<div class="fragment block">`
wrapper layer; crawlers are still fine.

### Universal SSL only covers one wildcard level

`*.diffatech.co.uk` is covered by Universal SSL for free. `*.live.diffatech.co.uk`
(two levels) is **not** — that would need Advanced Certificate Manager (paid).
That's why we encode the EDS env into the leading label as a suffix
(`--live`, `--page`) on a single-level wildcard instead of using a separate
`live.` / `page.` subdomain.

### `URL.host` doesn't clear the port

```ts
const u = new URL('http://example.com:8787/x');
u.host = 'aem.live';        // becomes "aem.live:8787" — port leaked!
u.hostname = 'aem.live';    // becomes "aem.live", port still 8787
u.port = '';                // now correct
```

This caused a 75-second hang the first time the worker was tested under
`wrangler dev` — the dev port (8787) leaked into fragment fetches against
`www.aem.live:8787`. Fix is to set `hostname` and `port` separately (see
`resolveFragmentUrl`).

### `duplex: 'half'` needed for body-forwarding `fetch()`

Cloudflare's runtime accepts `new Request(url, { body: stream })` without
`duplex`. Node's undici (used by vitest in node environment) does not — it
throws `RequestInit: duplex option is required when sending a body`. Tests
caught this. The fix in `buildUpstreamRequest` adds `duplex: 'half'` only
when there's a body; harmless in both runtimes.

### EDS sites use a per-request nonce CSP

`<script nonce="…" src="/scripts/aem.js" type="module">`. An earlier iteration
of this worker injected an inline `<script>` to neutralise `fragment.js` via
`MutationObserver`. CSP silently blocked it (no nonce). We extracted the
nonce from existing scripts and applied it to the injected one — that
worked, but the user preferred a cleaner cooperation with `fragment.js`
itself. The MutationObserver approach is gone; the `data-ssr` marker pattern
replaced it.

### `wrangler.toml` route-vs-workers.dev interaction

If `[[routes]]` are present and `workers_dev` is unset in `wrangler.toml`,
wrangler 4.x silently *disables* the workers.dev URL on next deploy. Keep
`workers_dev = true` explicitly if you want both routes and the workers.dev
URL.

### `HOST_MAP` recognises both wrapper hostnames and raw EDS hostnames

```jsonc
{
  "--live.diffatech.co.uk": "aem.live",  // wildcard route hostname
  "--page.diffatech.co.uk": "aem.page",
  ".aem.live": "aem.live",                // raw EDS hostname (X-Forwarded-Host case)
  ".aem.page": "aem.page"
}
```

The "identity" mappings (`.aem.live` → `aem.live`) exist so an upstream CDN
fronting this worker can pass the original EDS hostname through
`X-Forwarded-Host` and we'll route correctly. Don't remove them.

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

The worker is effectively a free anonymising proxy for any EDS site
(`*.aem.live` / `*.aem.page`). `HOST_MAP` constrains the *suffix* but the
label is attacker-controlled, and `X-Forwarded-Host` is currently trusted
from any caller. If multi-tenant proxying is *not* deliberate, add a shared-
secret header check in `resolveOrigin`. See the security review notes in
session history for more.
