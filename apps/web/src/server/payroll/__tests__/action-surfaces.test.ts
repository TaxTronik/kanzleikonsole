// Fachkatalog: PAYROLL-INTAKE-001
// Review-Befund K-02: Die Lohn-Actions der Kanzlei und des Arbeitgeber-Portals
// laufen über staffAction/portalAction. Gate, Schreib-Backstop, Lohn-eigenes
// Fehler-Mapping (payrollActionError) und die drei revalidierten Oberflächen
// bleiben unverändert.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({
  staffGuard: vi.fn(),
  portalGuard: vi.fn(),
  revalidatePath: vi.fn(),
  createPayroll: vi.fn(),
  saveEmployer: vi.fn(),
  issueEmployeeInvite: vi.fn(),
  payrollGuard: vi.fn(),
  persistPayrollFile: vi.fn(),
  writeLimit: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: vi.fn() }));
vi.mock('@/server/rate-limit', () => ({ checkPortalWriteLimit: h.writeLimit }));
vi.mock('@/server/payroll/export', () => ({ createPayrollExport: vi.fn() }));
vi.mock('@/server/payroll/service', () => ({
  createPayroll: h.createPayroll,
  saveEmployer: h.saveEmployer,
  issueEmployeeInvite: h.issueEmployeeInvite,
  reviewPayroll: vi.fn(),
  confirmPayrollNumbers: vi.fn(),
  recordImmediateRegistration: vi.fn(),
  checkDatevGate: vi.fn(),
  payrollGuard: h.payrollGuard,
}));
vi.mock('@/server/payroll/storage', () => ({
  persistPayrollFile: h.persistPayrollFile,
  PayrollUploadError: class PayrollUploadError extends Error {
    constructor(readonly pendingId: string) {
      super('Upload gespeichert, aber noch nicht abgeschlossen: ' + pendingId);
    }
  },
}));
vi.mock('@/server/documents/pdf-fonts', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  return { UnsupportedPdfTextError: class UnsupportedPdfTextError extends ActionError {} };
});
vi.mock('@/server/actions/staff-action', async () => {
  const { createActionRunner } = await vi.importActual<
    typeof import('@/server/actions/action-runner')
  >('@/server/actions/action-runner');
  return { staffAction: createActionRunner(h.staffGuard) };
});
vi.mock('@/server/actions/portal-action', async () => {
  const { createActionRunner } = await vi.importActual<
    typeof import('@/server/actions/action-runner')
  >('@/server/actions/action-runner');
  return { portalAction: createActionRunner(h.portalGuard) };
});

import { ActionError } from '@/server/actions/action-error';
import { PayrollUploadError } from '@/server/payroll/storage';
import { payrollActionError } from '@/server/payroll/action-result';
import { createPayrollAction, uploadPayrollAction } from '@/app/staff/(protected)/payroll/actions';
import {
  issueEmployeeInviteAction,
  saveEmployerAction,
} from '@/app/portal/(protected)/payroll/actions';

const PAYROLL_PATHS = ['/staff/payroll', '/portal/payroll', '/payroll/employee'];
const FALLBACK =
  'Der Vorgang konnte nicht gespeichert werden. Bitte neu laden oder die Kanzlei kontaktieren.';

function revalidated(): string[] {
  return h.revalidatePath.mock.calls.map(([path]) => path as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.staffGuard.mockResolvedValue({ ok: true, tenantId: 'tenant-1', staffId: 'staff-1' });
  h.portalGuard.mockResolvedValue({ ok: true, tenantId: 'tenant-1', contactId: 'contact-1' });
  h.writeLimit.mockResolvedValue({ ok: true });
});

describe('payrollActionError: Lohn-eigenes Fehler-Mapping', () => {
  it('ordnet Upload-, Fach-, Eingabe- und technische Fehler wie bisher ein', () => {
    expect(payrollActionError(new PayrollUploadError('pending-1'))).toEqual({
      ok: false,
      error: 'Upload gespeichert, aber noch nicht abgeschlossen: pending-1',
      pendingId: 'pending-1',
    });
    expect(payrollActionError(new ActionError('Vorgang ist abgeschlossen.'))).toEqual({
      ok: false,
      error: 'Vorgang ist abgeschlossen.',
    });
    expect(payrollActionError(z.uuid().safeParse('x').error)).toEqual({
      ok: false,
      error: 'Eingaben und Pflichtfelder prüfen.',
    });
    expect(payrollActionError(new Error('connection reset'))).toEqual({
      ok: false,
      error: FALLBACK,
    });
  });
});

describe('Lohn-Actions der Kanzlei über staffAction', () => {
  it('prüft Modul und PAYROLL_MANAGE und gibt die Ablehnung unverändert zurück', async () => {
    h.staffGuard.mockResolvedValueOnce({
      ok: false,
      error: 'Keine Berechtigung (PAYROLL_MANAGE).',
    });

    await expect(createPayrollAction(new FormData())).resolves.toEqual({
      ok: false,
      error: 'Keine Berechtigung (PAYROLL_MANAGE).',
    });
    expect(h.staffGuard).toHaveBeenCalledWith({
      module: 'payrollIntake',
      requirePermission: 'PAYROLL_MANAGE',
    });
    expect(h.createPayroll).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('liefert den Link und revalidiert alle drei Oberflächen', async () => {
    h.createPayroll.mockResolvedValueOnce('intake-1');

    await expect(createPayrollAction(new FormData())).resolves.toEqual({
      ok: true,
      link: '/staff/payroll?id=intake-1',
    });
    expect(revalidated()).toEqual(PAYROLL_PATHS);
  });

  it('meldet eine ungültige Vorgangs-ID als Eingabefehler, ohne zu revalidieren', async () => {
    const data = new FormData();
    data.set('id', 'kein-vorgang');

    await expect(uploadPayrollAction(data)).resolves.toEqual({
      ok: false,
      error: 'Eingaben und Pflichtfelder prüfen.',
    });
    expect(h.persistPayrollFile).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('gibt bei einem unterbrochenen Upload die Upload-ID zur Fortsetzung zurück', async () => {
    h.persistPayrollFile.mockRejectedValueOnce(new PayrollUploadError('pending-2'));
    const data = new FormData();
    data.set('id', '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f');
    data.set('file', new File(['%PDF-'], 'lohn.pdf', { type: 'application/pdf' }));

    await expect(uploadPayrollAction(data)).resolves.toEqual({
      ok: false,
      error: 'Upload gespeichert, aber noch nicht abgeschlossen: pending-2',
      pendingId: 'pending-2',
    });
  });
});

describe('Lohn-Actions des Arbeitgebers über portalAction', () => {
  it('prüft den Schreib-Backstop vor der Arbeit', async () => {
    h.writeLimit.mockResolvedValueOnce({ ok: false, retryAfter: 60 });

    await expect(saveEmployerAction(new FormData())).resolves.toEqual({
      ok: false,
      error: 'Zu viele Aktionen.',
    });
    expect(h.portalGuard).toHaveBeenCalledWith({ module: 'payrollIntake' });
    expect(h.writeLimit).toHaveBeenCalledWith('contact-1');
    expect(h.payrollGuard).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('liefert den Einmallink samt Hinweis und revalidiert alle drei Oberflächen', async () => {
    h.issueEmployeeInvite.mockResolvedValueOnce('/payroll/employee#invite=t');

    await expect(issueEmployeeInviteAction(new FormData())).resolves.toEqual({
      ok: true,
      link: '/payroll/employee#invite=t',
      message:
        'Neuer Einmallink. Frühere Links und Sessions sind widerrufen. Bitte ausschließlich an die betroffene Person übermitteln.',
    });
    expect(revalidated()).toEqual(PAYROLL_PATHS);
  });

  it('meldet technische Fehler mit der Lohn-Meldung statt der allgemeinen', async () => {
    h.issueEmployeeInvite.mockRejectedValueOnce(new Error('connection reset'));

    await expect(issueEmployeeInviteAction(new FormData())).resolves.toEqual({
      ok: false,
      error: FALLBACK,
    });
  });
});
