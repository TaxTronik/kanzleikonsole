// Fachkatalog: ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireStaffPage: vi.fn(),
  withTenantContext: vi.fn(),
  findUnique: vi.fn(),
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: mocks.requireStaffPage }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/auth/webauthn', () => ({ isHardwareAccessConfigured: () => false }));
vi.mock('../password-form', () => ({ ChangePasswordForm: () => null }));
vi.mock('../hardware-key-settings', () => ({ HardwareKeySettings: () => null }));
vi.mock('@/components/accessible-display', () => ({ AccessibleDisplaySettings: () => null }));

import StaffProfilePage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffPage.mockResolvedValue({
    user: {
      tenantId: 'tenant-a',
      staffId: 'staff-a',
      roles: ['EMPLOYEE'],
      fullName: 'Testperson',
      email: 'test@example.test',
    },
  });
  mocks.withTenantContext.mockImplementation(async (_ctx, run) =>
    run({ staffUser: { findUnique: mocks.findUnique } }),
  );
});

describe('eigene Kontodaten', () => {
  it('zeigt die eigene DATEV-Nummer mit führenden Nullen ohne Bearbeitungsfeld', async () => {
    mocks.findUnique.mockResolvedValue({ datevAdvisorNumber: '000042' });
    const html = renderToStaticMarkup(await StaffProfilePage());
    expect(html).toContain('DATEV-Beraternummer (intern)');
    expect(html).toContain('>000042</dd>');
    expect(html).not.toContain('<input');
    expect(mocks.withTenantContext).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'STAFF' },
      expect.any(Function),
    );
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'staff-a' },
        select: expect.objectContaining({ datevAdvisorNumber: true }),
      }),
    );
  });

  it('kennzeichnet eine fehlende Nummer im Anzeigezustand', async () => {
    mocks.findUnique.mockResolvedValue({ datevAdvisorNumber: null });
    const html = renderToStaticMarkup(await StaffProfilePage());
    expect(html).toContain('>Nicht hinterlegt</dd>');
  });
});
