# Performance test harness

Measures the ssreds edge function on two layers at once:

1. **Client-observed proxy performance** — wall-clock latency percentiles
   (p50/p90/p99), throughput (req/s), status mix, and response bytes, as seen
   by a client hitting the function.
2. **Fastly server-side metrics** — the function emits a `Server-Timing` header
   (and `x-compute-*` headers) when a request carries `x-perf-trace`, breaking
   each execution into:
   - `vcpu` — **Fastly vCPU ms** (`vCpuTime()` from `fastly:compute`): the
     thread CPU "work time" Fastly bills, distinct from wall time.
   - `upstream` — time for the origin page fetch.
   - `fragments` — time spent fetching + inlining fragments (with the number of
     fragment fetches in `desc`).
   - `total` — whole-handler wall time.
   - `x-compute-backend-reqs` — total backend requests this execution made
     (relevant to Fastly's **32 backend-requests-per-execution** limit).

The harness sends `x-perf-trace` and aggregates these across all requests.

## Run

Against local dev (start it first with `npm run dev`):

```bash
npm run dev          # serves on http://127.0.0.1:7676
npm run perf         # defaults: --base http://127.0.0.1:7676, 200 req/scenario, c=10
```

Against a deployed site:

```bash
npm run perf -- --base https://your-edge-delivery-site.example -n 500 -c 25
```

Options (`node perf/loadtest.mjs --help`):

| flag | default | meaning |
|---|---|---|
| `--base <url>` | `http://127.0.0.1:7676` | target origin |
| `--requests, -n` | `200` | requests per scenario (after warmup) |
| `--concurrency, -c` | `10` | in-flight requests |
| `--warmup <n>` | `10` | unmeasured priming requests (also warms the fragment cache) |
| `--scenarios <file>` | `perf/scenarios.json` | scenario list |
| `--json <file>` | – | also write raw aggregates as JSON (for trend tracking) |
| `--no-trace` | – | don't send `x-perf-trace` (pure client-side timing only) |
| `--timeout <ms>` | `30000` | per-request timeout |

## Scenarios

Edit [`scenarios.json`](scenarios.json). The defaults contrast three cost
profiles — tune the `path`s to your site:

- a **fragment-heavy** document (full inlining work),
- a **`.plain.html`** (raw fragment, minimal work),
- a **non-HTML asset** (pure pass-through, no inlining).

## Interpreting results & caveats

- **vCPU vs wall time.** `vcpu` is CPU work only; `total` includes time blocked
  on `upstream`/`fragment` fetches. A big gap between them means the handler is
  I/O-bound (waiting on origin), not CPU-bound — expected for a proxy.
- **Fragment cache.** Fragment and page fetches use a 300s `CacheOverride`, so
  after warmup `upstream`/`fragments` reflect **cache hits**, not cold origin
  latency. Drop `--warmup 0` and use unique paths to measure cold cost.
- **Local Viceroy is not production.** Viceroy is a local dev runtime; absolute
  vCPU/latency numbers are not representative of the Fastly edge. Use it for
  relative comparisons and regression detection; use a deployed environment for
  real figures. Viceroy also logs WASM heap + wall time per request in the
  `npm run dev` output (`request completed using N MB … in N ms`).
- **`vcpu` missing?** The runtime didn't report it (older Viceroy, or
  `--no-trace`). Client latency, upstream, and fragment metrics still work.
- **Production source of truth.** For fleet-wide vCPU/usage, Fastly's
  Observability dashboards and real-time/historical Stats API are authoritative;
  the in-code `vCpuTime()` header is the per-request view this harness uses.
