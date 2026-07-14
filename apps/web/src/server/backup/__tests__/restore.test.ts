import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/config', () => ({
  env: {
    S3_ENDPOINT: 'http://seaweedfs:8333',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'unit-test-access',
    S3_SECRET_KEY: 'unit-test-secret',
  },
}));

vi.mock('@taxtronik/db/prisma-client', () => ({
  PrismaClient: class PrismaClient {},
}));

vi.mock('@taxtronik/db/prisma-adapter', () => ({
  createPostgresAdapter: vi.fn(),
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    backupRecord: { findFirst: vi.fn() },
  },
}));

import { parseRestoreArgs, PRODUCTION_RESTORE_CONFIRMATION, targetIsEmpty } from '../restore';

describe('parseRestoreArgs', () => {
  it('accepts read-only list without a target', () => {
    expect(parseRestoreArgs(['--list'])).toMatchObject({
      list: true,
      productionTarget: false,
    });
  });

  it('rejects options combined with read-only list', () => {
    expect(() => parseRestoreArgs(['--list', '--target-url', 'postgresql://db/test'])).toThrow(
      '--list ist read-only',
    );
  });

  it.each([
    [['--latest'], 'Genau ein Ziel ist Pflicht'],
    [['--target-url', 'postgresql://db/test'], 'Genau eine Quelle ist Pflicht'],
    [
      ['--latest', '--key', 'pgdump/example.dump', '--target-url', 'postgresql://db/test'],
      'Genau eine Quelle ist Pflicht',
    ],
    [
      ['--latest', '--target-url', 'postgresql://db/test', '--production-target'],
      'Genau ein Ziel ist Pflicht',
    ],
    [['--latest', '--target-url'], '--target-url erwartet'],
    [['--latest', '--target-url', 'https://db.example/test'], '--target-url muss mit postgres'],
    [['--latest', '--wat'], 'Unbekannte Restore-Option'],
    [['--latest', '--latest', '--target-url', 'postgresql://db/test'], 'Option doppelt angegeben'],
  ])('rejects invalid arguments %#', (argv, message) => {
    expect(() => parseRestoreArgs(argv)).toThrow(message);
  });

  it('requires the exact strong confirmation for production', () => {
    expect(() =>
      parseRestoreArgs(['--latest', '--production-target', '--confirm-production-restore', 'yes']),
    ).toThrow(PRODUCTION_RESTORE_CONFIRMATION);
  });

  it('accepts an explicitly confirmed production target', () => {
    expect(
      parseRestoreArgs([
        '--latest',
        '--production-target',
        '--confirm-production-restore',
        PRODUCTION_RESTORE_CONFIRMATION,
        '--release-version',
        '1.2.3',
        '--confirm-overwrite',
      ]),
    ).toMatchObject({
      latest: true,
      productionTarget: true,
      productionConfirmation: PRODUCTION_RESTORE_CONFIRMATION,
      releaseVersion: '1.2.3',
      confirmOverwrite: true,
    });
  });

  it('requires a SemVer release contract for a production restore', () => {
    expect(() =>
      parseRestoreArgs([
        '--latest',
        '--production-target',
        '--confirm-production-restore',
        PRODUCTION_RESTORE_CONFIRMATION,
      ]),
    ).toThrow('--release-version X.Y.Z');
  });

  it('rejects production confirmation for an isolated target', () => {
    expect(() =>
      parseRestoreArgs([
        '--latest',
        '--target-url',
        'postgresql://db/test',
        '--confirm-production-restore',
        PRODUCTION_RESTORE_CONFIRMATION,
      ]),
    ).toThrow('nur zusammen mit --production-target');
  });
});

describe('targetIsEmpty', () => {
  function probeWith(result: unknown) {
    const query = vi.fn().mockResolvedValue(result);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    return {
      query,
      disconnect,
      factory: () => ({ $queryRaw: query, $disconnect: disconnect }),
    };
  }

  it('treats a database without user relations as empty', async () => {
    const probe = probeWith([{ hasUserObjects: false }]);

    await expect(targetIsEmpty('postgresql://db/empty', probe.factory)).resolves.toBe(true);
    expect(probe.disconnect).toHaveBeenCalledOnce();
  });

  it('detects any user relation, not only the Prisma migration table', async () => {
    const probe = probeWith([{ hasUserObjects: true }]);

    await expect(targetIsEmpty('postgresql://db/populated', probe.factory)).resolves.toBe(false);
    const sql = (probe.query.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('pg_catalog.pg_class');
    expect(sql).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')");
    expect(sql).not.toContain('_prisma_migrations');
  });

  it('fails closed when the relation probe errors', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const factory = () => ({
      $queryRaw: vi.fn().mockRejectedValue(new Error('connection lost')),
      $disconnect: disconnect,
    });

    await expect(targetIsEmpty('postgresql://db/error', factory)).rejects.toThrow(
      'Ziel-DB-Leerheitspruefung fehlgeschlagen: connection lost',
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('fails closed on a malformed probe result', async () => {
    const probe = probeWith([]);

    await expect(targetIsEmpty('postgresql://db/invalid', probe.factory)).rejects.toThrow(
      'kein gueltiges Ergebnis',
    );
  });
});
