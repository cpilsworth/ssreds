#!/usr/bin/env node
/*
 * Dependency-free load/perf harness for the ssreds AEM Edge Function.
 *
 * Measures two layers at once:
 *   1. Client-observed proxy performance — wall-clock latency percentiles
 *      (p50/p90/p99), throughput (req/s), status mix, response bytes.
 *   2. Fastly server-side metrics — parsed from the function's Server-Timing /
 *      x-compute-* response headers (enabled by the `x-perf-trace` request
 *      header this harness sends): vCPU ms, upstream fetch ms, fragment-phase
 *      ms, and backend-request count (relevant to Fastly's 32-req/exec limit).
 *
 * Works against local Viceroy (`npm run dev`, http://127.0.0.1:7676) or a
 * deployed site. vCPU is only present if the runtime reports it (recent Fastly;
 * local Viceroy may omit it — the harness degrades gracefully).
 *
 * Usage:
 *   node perf/loadtest.mjs --base http://127.0.0.1:7676 \
 *       [--requests 200] [--concurrency 10] [--warmup 10] \
 *       [--scenarios perf/scenarios.json] [--json out.json] \
 *       [--no-trace] [--timeout 30000]
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ---- args -----------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    base: 'http://127.0.0.1:7676',
    requests: 200,
    concurrency: 10,
    warmup: 10,
    scenarios: new URL('./scenarios.json', import.meta.url).pathname,
    json: null,
    trace: true,
    timeout: 30000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--base': args.base = next().replace(/\/$/, ''); break;
      case '--requests': case '-n': args.requests = Number(next()); break;
      case '--concurrency': case '-c': args.concurrency = Number(next()); break;
      case '--warmup': args.warmup = Number(next()); break;
      case '--scenarios': args.scenarios = next(); break;
      case '--json': args.json = next(); break;
      case '--no-trace': args.trace = false; break;
      case '--timeout': args.timeout = Number(next()); break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default: console.error(`unknown arg: ${a}`); process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n')
    .filter((l) => l.startsWith(' *') || l.startsWith('/*')).join('\n'));
}

// ---- stats helpers --------------------------------------------------------

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function summarize(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    n: arr.length,
    mean: sum / arr.length,
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    p99: percentile(arr, 99),
    max: arr[arr.length - 1],
  };
}

// Parse a Server-Timing header value into { name: durMs } pairs.
function parseServerTiming(value) {
  const out = {};
  if (!value) return out;
  for (const entry of value.split(',')) {
    const name = entry.split(';')[0].trim();
    const m = /dur=([0-9.]+)/.exec(entry);
    if (name && m) out[name] = Number(m[1]);
  }
  return out;
}

// ---- request loop ---------------------------------------------------------

async function runScenario(scenario, args) {
  const url = `${args.base}${scenario.path}`;
  const headers = args.trace ? { 'x-perf-trace': '1' } : {};

  const oneRequest = async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), args.timeout);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      const buf = await res.arrayBuffer(); // fully consume the body
      const latency = performance.now() - t0;
      const st = parseServerTiming(res.headers.get('server-timing'));
      return {
        ok: true,
        status: res.status,
        latency,
        bytes: buf.byteLength,
        vcpu: st.vcpu ?? num(res.headers.get('x-compute-vcpu-ms')),
        upstream: st.upstream,
        fragments: st.fragments,
        total: st.total,
        backendReqs: num(res.headers.get('x-compute-backend-reqs')),
      };
    } catch (err) {
      return { ok: false, status: 0, latency: performance.now() - t0, error: String(err?.name || err) };
    } finally {
      clearTimeout(timer);
    }
  };

  // warmup (not recorded) — also primes the fragment fetch cache (ttl 300s)
  for (let i = 0; i < args.warmup; i++) await oneRequest();

  const results = [];
  let issued = 0;
  const wallStart = performance.now();
  const worker = async () => {
    while (issued < args.requests) {
      issued++;
      results.push(await oneRequest());
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  const wallSec = (performance.now() - wallStart) / 1000;

  return { scenario, results, wallSec };
}

function num(v) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---- reporting ------------------------------------------------------------

function ms(v) { return v == null || !Number.isFinite(v) ? '   -  ' : v.toFixed(2).padStart(7); }

function report({ scenario, results, wallSec }) {
  const ok = results.filter((r) => r.ok && r.status < 500);
  const errs = results.length - ok.length;
  const rps = results.length / wallSec;

  const latency = summarize(ok.map((r) => r.latency));
  const vcpu = summarize(ok.map((r) => r.vcpu));
  const upstream = summarize(ok.map((r) => r.upstream));
  const fragments = summarize(ok.map((r) => r.fragments));
  const backend = summarize(ok.map((r) => r.backendReqs));
  const bytes = summarize(ok.map((r) => r.bytes));

  const statusMix = {};
  for (const r of results) statusMix[r.status] = (statusMix[r.status] || 0) + 1;

  console.log(`\n■ ${scenario.name}  (${scenario.path})`);
  console.log(`  requests=${results.length}  errors=${errs}  rps=${rps.toFixed(1)}  status=${JSON.stringify(statusMix)}`);
  console.log('                       mean      p50      p90      p99      max');
  console.log(`  client latency ms  ${ms(latency?.mean)} ${ms(latency?.p50)} ${ms(latency?.p90)} ${ms(latency?.p99)} ${ms(latency?.max)}`);
  if (vcpu) console.log(`  fastly vCPU ms     ${ms(vcpu.mean)} ${ms(vcpu.p50)} ${ms(vcpu.p90)} ${ms(vcpu.p99)} ${ms(vcpu.max)}`);
  else console.log('  fastly vCPU ms       (not reported by runtime — local Viceroy or trace disabled)');
  if (upstream) console.log(`  upstream fetch ms  ${ms(upstream.mean)} ${ms(upstream.p50)} ${ms(upstream.p90)} ${ms(upstream.p99)} ${ms(upstream.max)}`);
  if (fragments) console.log(`  fragment phase ms  ${ms(fragments.mean)} ${ms(fragments.p50)} ${ms(fragments.p90)} ${ms(fragments.p99)} ${ms(fragments.max)}`);
  if (backend) console.log(`  backend requests   ${ms(backend.mean)} ${ms(backend.p50)} ${ms(backend.p90)} ${ms(backend.p99)} ${ms(backend.max)}  (limit 32/exec)`);
  if (bytes) console.log(`  response bytes     mean=${Math.round(bytes.mean)}  max=${bytes.max}`);

  return {
    name: scenario.name, path: scenario.path,
    requests: results.length, errors: errs, rps, statusMix,
    latency, vcpu, upstream, fragments, backendReqs: backend, bytes,
  };
}

// ---- main -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(args.scenarios, 'utf8'));
  const scenarios = cfg.scenarios ?? [];

  console.log(`ssreds perf harness → ${args.base}`);
  console.log(`requests/scenario=${args.requests}  concurrency=${args.concurrency}  warmup=${args.warmup}  trace=${args.trace}`);

  const out = [];
  for (const scenario of scenarios) {
    const run = await runScenario(scenario, args);
    out.push(report(run));
  }

  if (args.json) {
    const fs = await import('node:fs');
    fs.writeFileSync(args.json, JSON.stringify({ base: args.base, args, scenarios: out }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
