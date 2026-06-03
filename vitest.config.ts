import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // index.ts and fastly.ts import `fastly:*` platform modules and use the
      // Fastly Compute global runtime, so they can't run under node/vitest.
      // The testable logic lives in the platform-agnostic modules below.
      include: ['src/fragments.ts', 'src/proxy.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
      },
    },
  },
});
