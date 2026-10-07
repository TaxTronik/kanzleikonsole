// Fachkatalog: BACKUP-DRILL-INTEGRITY-001
import { beforeEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  timestampPortFor: vi.fn(),
}));

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
  BACKUP_DRILL_RESULT_SETTING_KEY: 'backup_drill_result',
}));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@taxtronik/db', () => ({ withSystemContext: vi.fn() }));
vi.mock('../../notify', () => ({ notify: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../tsa-port', () => ({ timestampPortFor: mocks.timestampPortFor }));

import {
  withDbName,
  missingTenantResult,
  restoreEvidenceServiceFor,
  restoreRequiresExternalTsa,
  drillDatabaseUrl,
  drillRestoreList,
} from '../backup-drill';

beforeEach(() => vi.clearAllMocks());

describe('withDbName', () => {
  it('tauscht nur den DB-Namen und erhält Query-Parameter (?schema=)', () => {
    expect(
      withDbName(
        'postgresql://taxtronik:pw@postgres:5432/taxtronik?schema=public',
        'taxtronik_drill',
      ),
    ).toBe('postgresql://taxtronik:pw@postgres:5432/taxtronik_drill?schema=public');
  });

  it('funktioniert ohne Query und ohne Port', () => {
    expect(withDbName('postgresql://u:p@host/db', 'drill')).toBe('postgresql://u:p@host/drill');
  });
});

describe('S-01: Drill-Rolle', () => {
  const owner = 'postgresql://taxtronik_owner:pw@postgres:5432/taxtronik?schema=public';
  const drill = 'postgresql://taxtronik_drill:pw@postgres:5432/postgres?schema=public';

  it('nutzt DATABASE_DRILL_URL der validierten ENV statt der Owner-Verbindung ohne CREATEDB', () => {
    expect(
      drillDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: owner, DATABASE_DRILL_URL: drill }),
    ).toBe(drill);
    expect(
      drillDatabaseUrl({ NODE_ENV: 'development', DATABASE_URL: owner, DATABASE_DRILL_URL: drill }),
    ).toBe(drill);
  });

  it('fällt nur außerhalb von Produktion auf DATABASE_URL zurück', () => {
    expect(drillDatabaseUrl({ NODE_ENV: 'development', DATABASE_URL: owner })).toBe(owner);
    expect(() => drillDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: owner })).toThrow(
      /DATABASE_DRILL_URL fehlt/,
    );
  });

  it('liest die Prozess-ENV nicht direkt (S-01: nur über das Worker-Profil)', () => {
    vi.stubEnv('DATABASE_DRILL_URL', drill);
    try {
      expect(drillDatabaseUrl({ NODE_ENV: 'development', DATABASE_URL: owner })).toBe(owner);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lässt nur die DEFAULT-ACL-Einträge der TOC aus', () => {
    const toc = [
      '; Archive created at 2026-10-06',
      '3200; 1259 614000 TABLE public tenant taxtronik',
      '3202; 826 614572 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES taxtronik',
      '3203; 826 614573 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES taxtronik',
      '3204; 0 0 ACL public TABLE tenant taxtronik',
      '3205; 0 0 COMMENT - EXTENSION pgcrypto ',
    ].join('\r\n');
    expect(drillRestoreList(toc).split('\n')).toEqual([
      '; Archive created at 2026-10-06',
      '3200; 1259 614000 TABLE public tenant taxtronik',
      '3204; 0 0 ACL public TABLE tenant taxtronik',
      '3205; 0 0 COMMENT - EXTENSION pgcrypto ',
    ]);
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

describe('Restore-TSA-Policy', () => {
  it('lädt den TSA-Adapter für jeden wiederhergestellten Tenant über den Produktionspfad', async () => {
    const port = { mode: 'rfc3161' };
    mocks.timestampPortFor.mockResolvedValueOnce(port);

    await expect(restoreEvidenceServiceFor('tenant-1')).resolves.toBeDefined();
    // F-12: reine Prüfung — in Produktion ohne Netz- oder DNS-Zugriff.
    expect(mocks.timestampPortFor).toHaveBeenCalledWith('tenant-1', 'verify');
  });

  it('erzwingt im Produktivmodus oder bei expliziter Vorgabe eine externe TSA', () => {
    expect(restoreRequiresExternalTsa('production')).toBe(true);
    expect(restoreRequiresExternalTsa('development', 'true')).toBe(true);
    expect(restoreRequiresExternalTsa('development')).toBe(false);
  });
});
