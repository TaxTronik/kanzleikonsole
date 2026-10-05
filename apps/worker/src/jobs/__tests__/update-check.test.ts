// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
// P-21: Der Update-Check läuft im Worker und speichert ein kompaktes Ergebnis je
// Tenant; ein nicht erreichbarer Server ist ein gespeichertes Ergebnis.
import { describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Worker: class WorkerMock {
    on() {
      return this;
    }
  },
}));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: {} }));

import { runUpdateCheck, type UpdateCheckDeps } from '../update-check';
import type { CheckResult } from '@taxtronik/config/update-manifest';

const NOW = new Date('2026-10-05T12:00:00.000Z');

function deps(check: UpdateCheckDeps['check']) {
  const stored: Array<[string, unknown]> = [];
  return {
    stored,
    deps: {
      check,
      tenantIds: async () => ['tenant-a', 'tenant-b'],
      store: async (tenantId: string, result: unknown) => {
        stored.push([tenantId, result]);
      },
      now: () => NOW,
    } satisfies UpdateCheckDeps,
  };
}

describe('runUpdateCheck', () => {
  it('speichert die geprüfte Versionsliste ohne Notes für jeden Tenant', async () => {
    const result: CheckResult = {
      ok: true,
      hasUpdate: true,
      manifest: {
        schemaVersion: 2,
        current: '1.4.0',
        channel: 'stable',
        versions: [
          {
            version: '1.4.0',
            releasedAt: '2026-06-10T12:00:00Z',
            commitSha: 'c'.repeat(40),
            artifacts: {
              web: { image: 'r.example/t/web:1.4.0', digest: 'sha256:' + 'a'.repeat(64) },
              worker: { image: 'r.example/t/worker:1.4.0', digest: 'sha256:' + 'b'.repeat(64) },
            },
            migrationsRequired: true,
            notes: 'lange Release-Notes',
          },
        ],
      },
    };
    const { stored, deps: d } = deps(async () => result);

    const persisted = await runUpdateCheck(d);

    expect(persisted).toEqual({
      checkedAt: NOW.toISOString(),
      ok: true,
      channel: 'stable',
      versions: [
        { version: '1.4.0', releasedAt: '2026-06-10T12:00:00Z', migrationsRequired: true },
      ],
    });
    expect(stored).toEqual([
      ['tenant-a', persisted],
      ['tenant-b', persisted],
    ]);
  });

  it('speichert Fehler des Update-Servers als Ergebnis statt den Job scheitern zu lassen', async () => {
    const { stored, deps: d } = deps(async () => {
      throw new Error('ETIMEDOUT');
    });

    const persisted = await runUpdateCheck(d);

    expect(persisted).toEqual({
      checkedAt: NOW.toISOString(),
      ok: false,
      error: 'Update-Prüfung fehlgeschlagen: ETIMEDOUT',
    });
    expect(stored).toHaveLength(2);
  });
});
