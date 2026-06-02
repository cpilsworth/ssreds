/// <reference types="@fastly/js-compute" />

// All `fastly:*` platform imports are isolated here so the rest of the source
// (proxy.ts, fragments.ts) stays node-runnable under vitest.

import { ConfigStore } from 'fastly:config-store';
import { CacheOverride } from 'fastly:cache-override';

/**
 * Named backend for the upstream EDS origin. Declared in `fastly.toml`
 * (`[local_server.backends.eds_origin]`) for local dev and provisioned by the
 * AEM Edge Functions service in production. Every upstream/fragment fetch
 * routes through this single backend.
 */
export const BACKEND = 'eds_origin';

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
