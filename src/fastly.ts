/// <reference types="@fastly/js-compute" />

// All `fastly:*` platform imports are isolated here so the rest of the source
// (proxy.ts, fragments.ts) stays node-runnable under vitest.

import { ConfigStore } from 'fastly:config-store';
import { CacheOverride } from 'fastly:cache-override';
import { vCpuTime } from 'fastly:compute';

/**
 * Resolve the EDS origin from the `config_default` ConfigStore. `EDS_ORIGIN`
 * holds the bare EDS hostname, e.g. `main--repo--owner.aem.live`. Throws if it
 * is missing so the caller can return a 502.
 */
export function getOrigin(): string {
  const store = new ConfigStore('config_default');
  const value = store.get('EDS_ORIGIN');
  if (!value) {
    throw new Error('EDS_ORIGIN is not configured in config_default');
  }
  // Accept either a bare hostname or a full origin URL.
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function buildCacheOverride(ttl: number): CacheOverride {
  return new CacheOverride('override', { ttl });
}

/**
 * Elapsed vCPU time (ms) for the current request handler — Fastly's internal
 * "work time" billing metric, distinct from wall-clock time. Returns undefined
 * if the runtime doesn't support it (e.g. older Viceroy local builds), so
 * callers can omit it from instrumentation cleanly.
 */
export function vCpuTimeMs(): number | undefined {
  try {
    return vCpuTime();
  } catch {
    return undefined;
  }
}
