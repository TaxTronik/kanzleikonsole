import { describe, it, expect, vi } from 'vitest';

// Nur der pure Builder wird getestet — der Collector zieht DB/Settings und
// wird hier nicht importiert (Modul-Mocks verhindern den ENV-/DB-Zugriff der
// transitiv importierten Module).
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn() }));
vi.mock('@/server/settings/tsa', () => ({ readTsaConfig: vi.fn() }));
vi.mock('@taxtronik/evidence', () => ({
  AUDIT_VERIFY_RESULT_SETTING_KEY: 'audit_verify_result',
  BACKUP_DRILL_RESULT_SETTING_KEY: 'backup_drill_result',
  getTsaProvider: vi.fn(),
}));

import { buildVerfahrensdoku, type VerfahrensdokuData } from '../verfahrensdoku';

const base: VerfahrensdokuData = {
  tenantName: 'Musterkanzlei GmbH',
  generatedAt: '2026-06-10T12:00:00Z',
  generatedBy: 'Rey Koxha',
  appVersion: '1.4.0',
  gitSha: 'abc1234',
  modules: { bwa: true, knowledge: false } as VerfahrensdokuData['modules'],
  tsaLabel: 'GlobalSign (RFC-3161)',
  lastBackup: { at: '2026-06-10T03:00:00Z', status: 'SUCCESS', sizeBytes: 150 * 1024 * 1024 },
  drill: {
    checkedAt: '2026-06-01T05:00:00Z',
    ok: true,
    backupKey: 'pgdump/2026/06/01/x.dump',
    backupFinishedAt: '2026-06-01T03:00:00Z',
    auditChecked: 1234,
    error: null,
  },
  auditVerify: {
    checkedAt: '2026-06-10T02:45:00Z',
    ok: true,
    checked: 5000,
    sealsChecked: 120,
    sealBreaks: 0,
    policyBreaks: [],
    firstBreak: null,
    error: null,
  },
  counts: {
    staffActive: 12,
    clients: 240,
    portalContactsActive: 310,
    documents: 9876,
    auditEntries: 5000,
    archiveSegments: 4,
  },
};

describe('buildVerfahrensdoku', () => {
  it('rendert Kanzlei, Version, Mengengerüst und Drill-/Verify-Status', () => {
    const md = buildVerfahrensdoku(base);
    expect(md).toContain('Musterkanzlei GmbH');
    expect(md).toContain('TaxTronik 1.4.0 (Commit abc1234)');
    expect(md).toContain('240 Mandanten');
    expect(md).toContain('ERFOLGREICH; 1234 Audit-Einträge');
    expect(md).toContain('Kette intakt (5000 Einträge, 120 Tagesversiegelungen)');
    expect(md).toContain('GlobalSign (RFC-3161)');
    expect(md).toContain('BWA-Auswertungen');
    expect(md).not.toContain('Wissensdatenbank'); // Modul deaktiviert
  });

  it('warnt deutlich bei fehlendem Backup und fehlgeschlagenem Drill', () => {
    const md = buildVerfahrensdoku({
      ...base,
      lastBackup: null,
      drill: { ...base.drill!, ok: false, error: 'pg_restore exit 1' },
      auditVerify: { ...base.auditVerify!, ok: false },
    });
    expect(md).toContain('NOCH KEINE — Backup-Einrichtung prüfen!');
    expect(md).toContain('FEHLGESCHLAGEN (pg_restore exit 1)');
    expect(md).toContain('BRUCH FESTGESTELLT');
  });

  it('verkraftet fehlende Drill-/Verify-Ergebnisse (frische Installation)', () => {
    const md = buildVerfahrensdoku({ ...base, drill: null, auditVerify: null });
    expect(md).toContain('noch kein Lauf');
    expect(md).toContain('noch kein persistiertes Ergebnis');
  });
});
