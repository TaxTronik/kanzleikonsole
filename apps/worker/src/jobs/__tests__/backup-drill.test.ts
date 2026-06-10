import { describe, it, expect, vi } from 'vitest';

// Der Job-Modul-Import zieht Queue/Redis/S3/Prisma — alles mocken, getestet
// werden die exportierten puren Helfer (URL-Ableitung + Missing-Tenant-Logik).
vi.mock('bullmq', () => ({
  Worker: class {
    on() {
      return this;
    }
  },
  Queue: class {},
}));
vi.mock('ioredis', () => ({ default: class {} }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class {}, GetObjectCommand: class {} }));
vi.mock('@prisma/client', () => ({ PrismaClient: class {} }));
vi.mock('@taxtronik/db/prisma-adapter', () => ({ createPostgresAdapter: () => ({}) }));
vi.mock('@taxtronik/config', () => ({
  env: {
    DATABASE_URL: 'postgresql://taxtronik:pw@postgres:5432/taxtronik?schema=public',
    S3_ENDPOINT: 'http://seaweedfs:8333',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'y',
    TIMESTAMP_AUTHORITY_URL: '',
  },
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {},
  LocalTimestampAdapter: class {},
  Rfc3161HttpAdapter: class {},
  BACKUP_DRILL_RESULT_SETTING_KEY: 'backup_drill_result',
}));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: vi.fn() }));
vi.mock('../../notify', () => ({ upsertNotification: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { withDbName, missingTenantResult } from '../backup-drill';

describe('withDbName', () => {
  it('tauscht nur den DB-Namen und erhält Query-Parameter (?schema=)', () => {
    expect(
      withDbName('postgresql://taxtronik:pw@postgres:5432/taxtronik?schema=public', 'taxtronik_drill'),
    ).toBe('postgresql://taxtronik:pw@postgres:5432/taxtronik_drill?schema=public');
  });

  it('funktioniert ohne Query und ohne Port', () => {
    expect(withDbName('postgresql://u:p@host/db', 'drill')).toBe('postgresql://u:p@host/drill');
  });
});

describe('missingTenantResult', () => {
  const backupAt = new Date('2026-06-01T05:00:00Z');

  it('Tenant jünger als das Backup → ok (erwartbar, beim nächsten Drill dabei)', () => {
    const r = missingTenantResult(new Date('2026-06-05T10:00:00Z'), backupAt);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
  });

  it('Tenant älter als das Backup → Fehler (Backup lückenhaft)', () => {
    const r = missingTenantResult(new Date('2026-05-01T10:00:00Z'), backupAt);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('lückenhaft');
  });

  it('Backup ohne finishedAt → konservativ Fehler', () => {
    const r = missingTenantResult(new Date('2026-06-05T10:00:00Z'), null);
    expect(r.ok).toBe(false);
  });
});
