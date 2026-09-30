import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config.mjs';

// Loading build configuration must not read developer secrets or change test ENVs.
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// MAIL-INBOX-001 references this shared build config for standalone packaging.
describe('Next.js workspace transpilation (MAIL-INBOX-001 technical packaging)', () => {
  it('transpiles every workspace runtime dependency from injected node_modules', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const workspaceDependencies = Object.entries(manifest.dependencies)
      .filter(([, version]) => version.startsWith('workspace:'))
      .map(([name]) => name);

    // Workspace packages export TypeScript source. pnpm injection makes them
    // physical node_modules packages, which need explicit Next transpilation.
    expect(workspaceDependencies.length).toBeGreaterThan(0);
    expect(
      workspaceDependencies.filter((name) => !nextConfig.transpilePackages?.includes(name)),
    ).toEqual([]);
  });
});
