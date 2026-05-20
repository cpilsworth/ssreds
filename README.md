# ssreds — SSR fragment inliner for Adobe Edge Delivery Services

A Cloudflare Worker that sits in front of an Adobe Edge Delivery Services (EDS)
site and inlines `div.fragment` block content into the HTML response, so that
crawlers and LLMs see the embedded fragment content without executing the
client-side `fragment.js`.

## How it works

1. The worker proxies every request to the EDS `ORIGIN` configured in
   `wrangler.toml`.
2. For `text/html` responses, the body is parsed for `<div class="fragment">`
   blocks. For each one, the worker fetches `<href>.plain.html` from the origin
   and substitutes the fetched markup in place of the fragment block.
3. Nested fragments are resolved recursively (depth-capped, with a visited-set
   to break cycles).
4. Everything else (CSS, JS, images, JSON, redirects, errors) is streamed
   through unchanged.

## Configure

Edit `ORIGIN` in `wrangler.toml`:

```toml
[vars]
ORIGIN = "https://main--your-site--your-org.aem.live"
```

## Run locally

```bash
npm install
npm run dev
```

Then `curl http://localhost:8787/<path>` — fragment blocks on the page are
replaced with their resolved content.

## Deploy

```bash
npm run deploy
```

## Verify

```bash
# Pick a page on the origin that contains a fragment block
ORIGIN=https://main--your-site--your-org.aem.live
PAGE=/path/with/a/fragment

curl -s "$ORIGIN$PAGE"            | grep -c 'class="fragment"'   # >0
curl -s "http://localhost:8787$PAGE" | grep -c 'class="fragment"'   # 0
```
