// @vitest-environment jsdom
// Fachkatalog: AUDIT-VERIFY-ALERT-001
//
// Admin-Übersicht: Status-Karten zeigen nur bereits geladene Daten (P-21).
// Render-Test gegen eine gemockte Tenant-Transaktion (B-08, Welle 15); ersetzt
// den Quelltextabschnitt aus presentation-extraction.test.ts.
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  BACKUP_DRILL_RESULT_SETTING_KEY,
} from '@taxtronik/evidence';
import { renderServer } from '@/__tests__/render-helpers';
import { UPDATE_CHECK_RESULT_SETTING_KEY } from '@/server/update/manifest';

const h = vi.hoisted(() => ({
  requireStaffPage: vi.fn(),
  withTenantContext: vi.fn(),
  readTenantSettingValue: vi.fn(),
  settings: {} as Record<string, unknown>,
  lastBackup: null as unknown,
  checkForUpdates: vi.fn(),
  countDueGwgRetentionItems: vi.fn(),
  countDueGwgDeletionDocs: vi.fn(),
  findDueGwgDeletionDocs: vi.fn(),
  countDueClientAnonymizations: vi.fn(),
  tx: {
    backupRecord: { findFirst: vi.fn() },
    dsgvoRequest: { count: vi.fn() },
    serviceProvider: { count: vi.fn() },
    clientContact: { count: vi.fn() },
    documentVersion: { count: vi.fn() },
  },
}));

vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: h.requireStaffPage }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/tenant-settings', () => ({
  readTenantSettingValue: h.readTenantSettingValue,
}));
vi.mock('@/server/update/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/update/manifest')>()),
  checkForUpdates: h.checkForUpdates,
}));
vi.mock('@/server/license/state', () => ({ getLicenseInfo: async () => ({ valid: true }) }));
vi.mock('@/server/setup/status', () => ({
  getSetupStatus: async () => ({
    items: [],
    doneCount: 0,
    totalCount: 0,
    allDone: true,
    dismissed: false,
  }),
}));
vi.mock('@/server/gwg/retention', () => ({
  countDueGwgRetentionItems: h.countDueGwgRetentionItems,
  countDueGwgDeletionDocs: h.countDueGwgDeletionDocs,
  findDueGwgDeletionDocs: h.findDueGwgDeletionDocs,
}));
vi.mock('@/server/dsgvo/client-retention', () => ({
  countDueClientAnonymizations: h.countDueClientAnonymizations,
}));
vi.mock('../license-card', () => ({ LicenseCard: () => null }));
vi.mock('../backup-run-button', () => ({ BackupRunButton: () => null }));
vi.mock('../setup-actions', () => ({
  dismissSetupChecklistAction: vi.fn(),
  restoreSetupChecklistAction: vi.fn(),
}));

import AdminPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  // CountUp fragt prefers-reduced-motion ab; reduziert = Endwert sofort.
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  h.settings = {};
  h.lastBackup = null;
  h.requireStaffPage.mockResolvedValue({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } });
  h.withTenantContext.mockImplementation(async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run(h.tx),
  );
  h.readTenantSettingValue.mockImplementation(
    async (_tx: unknown, _tenantId: string, key: string) => h.settings[key] ?? null,
  );
  h.tx.backupRecord.findFirst.mockImplementation(async () => h.lastBackup);
  h.tx.dsgvoRequest.count.mockResolvedValue(0);
  h.tx.serviceProvider.count.mockResolvedValue(3);
  h.tx.clientContact.count.mockResolvedValue(5);
  h.tx.documentVersion.count.mockResolvedValue(0);
  h.countDueGwgRetentionItems.mockResolvedValue({ documents: 2, checks: 1 });
  h.countDueClientAnonymizations.mockResolvedValue(1);
});

function card(heading: string): HTMLElement {
  return screen.getByRole('heading', { name: heading }).closest<HTMLElement>('.card')!;
}

describe('Admin-Übersicht: Status-Karten nur aus bereits geladenen Daten', () => {
  it('AUDIT-VERIFY-ALERT-001: liest das persistierte Prüfergebnis und rechnet im Render nichts nach', async () => {
    h.settings[AUDIT_VERIFY_RESULT_SETTING_KEY] = {
      ok: false,
      recovered: true,
      error: null,
      checked: 120,
      sealsChecked: 4,
      sealBreaks: 0,
      checkedAt: '2026-10-13T03:00:00.000Z',
      firstBreak: { auditId: 42 },
    };
    await renderServer(AdminPage());

    expect(h.requireStaffPage).toHaveBeenCalledWith({ admin: true });
    expect(h.readTenantSettingValue).toHaveBeenCalledWith(
      h.tx,
      'tenant-1',
      AUDIT_VERIFY_RESULT_SETTING_KEY,
    );
    expect(h.readTenantSettingValue).toHaveBeenCalledWith(
      h.tx,
      'tenant-1',
      BACKUP_DRILL_RESULT_SETTING_KEY,
    );
    // Eine einzige Tenant-Transaktion; die Karten öffnen keine eigene.
    expect(h.withTenantContext).toHaveBeenCalledOnce();

    const audit = card('Audit-Hash-Chain');
    expect(
      within(audit).getByText('Historischer Bruch — Recovery-Checkpoint gesetzt'),
    ).toBeTruthy();
    expect(within(audit).getByText('Bei Audit-ID 42')).toBeTruthy();
    expect(screen.getByText('Historischer Chain-Bruch (Recovery gesetzt)')).toBeTruthy();
  });

  it('AUDIT-VERIFY-ALERT-001: meldet einen fehlgeschlagenen Prüflauf statt eines Bruchs', async () => {
    h.settings[AUDIT_VERIFY_RESULT_SETTING_KEY] = {
      ok: false,
      recovered: false,
      error: 'Datenbank nicht erreichbar',
      checked: 0,
      sealsChecked: 0,
      sealBreaks: 0,
      checkedAt: '2026-10-13T03:00:00.000Z',
      firstBreak: null,
    };
    await renderServer(AdminPage());
    const audit = card('Audit-Hash-Chain');
    expect(within(audit).getByText('Verifikationslauf fehlgeschlagen')).toBeTruthy();
    expect(within(audit).getByText('Datenbank nicht erreichbar')).toBeTruthy();
    expect(within(audit).queryByText('Hash-Chain gebrochen!')).toBeNull();
    expect(screen.getByText('Audit-Verifikationslauf fehlgeschlagen')).toBeTruthy();
  });

  it('ruft den Update-Server nicht auf und zählt Löschfälle per COUNT (P-21)', async () => {
    await renderServer(AdminPage());

    expect(h.readTenantSettingValue).toHaveBeenCalledWith(
      h.tx,
      'tenant-1',
      UPDATE_CHECK_RESULT_SETTING_KEY,
    );
    expect(h.checkForUpdates).not.toHaveBeenCalled();
    // Welle 15: Belege und Aufzeichnungen wie Review-Queue und Worker-Hinweis.
    expect(h.countDueGwgRetentionItems).toHaveBeenCalledWith(h.tx);
    expect(h.countDueGwgDeletionDocs).not.toHaveBeenCalled();
    expect(h.countDueClientAnonymizations).toHaveBeenCalledWith(h.tx);
    expect(h.findDueGwgDeletionDocs).not.toHaveBeenCalled();
    expect(within(card('Versionen / Updates')).getByText(/Noch nicht geprüft/)).toBeTruthy();
    expect(screen.getByText('3 GwG-Einträge löschreif (für Sie sichtbar)')).toBeTruthy();
    expect(screen.getByText('1 DSGVO-Anonymisierung fällig')).toBeTruthy();
    expect(screen.getByText('3 löschreif')).toBeTruthy();
    expect(screen.getByText('1 fällig')).toBeTruthy();
  });

  it('zeigt das geladene Backup und den Restore-Test in der Backup-Karte', async () => {
    const { unmount } = await renderServer(AdminPage());
    expect(within(card('Letztes Backup')).getByText('Noch nie gesichert')).toBeTruthy();
    expect(screen.getByText('Noch kein Backup erstellt')).toBeTruthy();
    expect(within(card('Letztes Backup')).getByText(/Restore-Test: noch kein Lauf/)).toBeTruthy();
    unmount();

    h.lastBackup = {
      id: 'backup-1',
      status: 'FAILED',
      startedAt: new Date('2026-10-12T02:00:00.000Z'),
      sizeBytes: null,
      bucket: 'backups',
      key: null,
      errorMsg: 'Upload abgebrochen',
    };
    h.settings[BACKUP_DRILL_RESULT_SETTING_KEY] = {
      ok: false,
      checkedAt: '2026-10-01T05:00:00.000Z',
      auditChecked: 0,
      error: 'Prüfsumme weicht ab',
    };
    await renderServer(AdminPage());
    const box = card('Letztes Backup');
    expect(within(box).getByText(/— FAILED$/)).toBeTruthy();
    expect(within(box).getByText('Upload abgebrochen')).toBeTruthy();
    expect(within(box).getByText(/fehlgeschlagen — Prüfsumme weicht ab/)).toBeTruthy();
    expect(screen.getByText('Letztes Backup fehlgeschlagen')).toBeTruthy();
    expect(screen.getByText('Restore-Test fehlgeschlagen')).toBeTruthy();
  });
});
