import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/golden.test.ts'] },
      },
      {
        // Golden hashes run without V8's Maglev tier: Node 24's Maglev intermittently corrupts registry
        // candidates (a gulf picks up a later bay's numeric fields), which makes landmark hashes flaky
        // under load. Without Maglev the pipeline is deterministic run to run.
        extends: true,
        test: { name: 'golden', include: ['tests/golden.test.ts'], execArgv: ['--no-maglev'] },
      },
    ],
  },
});
