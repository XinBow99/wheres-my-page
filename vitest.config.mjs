import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*_test.ts', 'test/**/*_test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*_test.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
