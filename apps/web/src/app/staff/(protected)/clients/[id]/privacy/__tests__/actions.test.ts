import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyConsent } from '@/server/privacy/consent';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_ID = '33333333-3333-4333-8333-333333333333';
const REQUIRED_ID = '44444444-4444-4444-8444-444444444444';
const OPTIONAL_ID = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  assertClientInTenant: vi.fn(),
  consentFindFirst: vi.fn(),
  consentCreate: vi.fn(),
  renderNotice: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: mocks.staffActionGuard }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: mocks.assertClientAccessTx }));
vi.mock('@/server/db/assert-tenant', () => ({ assertClientInTenant: mocks.assertClientInTenant }));
vi.mock('@/server/privacy/service', () => ({ renderNoticeForTenantTx: mocks.renderNotice }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));

import { revokeAllConsentAction } from '../actions';

const tx = {
  clientConsent: {
    findFirst: mocks.consentFindFirst,
    create: mocks.consentCreate,
  },
};

function requiredSelection() {
  return {
    optionId: REQUIRED_ID,
    labelSnapshot: 'Notwendige Bestätigung',
    descriptionSnapshot: 'Bei Mandatsannahme erforderlich',
    section: 'OTHER' as const,
    requiredSnapshot: true,
    recommendedSnapshot: false,
    serviceProviderSnapshot: null,
  };
}

function mixedConsent() {
  const consent = emptyConsent();
  consent.communication.phone = true;
  consent.thirdParties = [{ recipient: 'Bank', purpose: 'Kredit', data: 'BWA', channel: 'Portal' }];
  consent.specialists = [
    {
      entity: 'Gutachter GmbH',
      service: 'Bewertung',
      accessType: 'Datenraum',
      requirements: 'Verschwiegenheit',
    },
  ];
  consent.optionSelections = [
    requiredSelection(),
    {
      ...requiredSelection(),
      optionId: OPTIONAL_ID,
      labelSnapshot: 'Freiwillige Zusatzoption',
      requiredSnapshot: false,
    },
  ];
  return consent;
}

function formData(): FormData {
  const form = new FormData();
  form.set('clientId', CLIENT_ID);
  form.set('signedByName', 'Erika Mustermann');
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: TENANT_ID,
    staffId: STAFF_ID,
    ctx: { tenantId: TENANT_ID, actorId: STAFF_ID, actorType: 'STAFF' },
    session: { user: { id: STAFF_ID, tenantId: TENANT_ID } },
  });
  mocks.withTenantContext.mockImplementation(
    async (_ctx: unknown, callback: (transaction: typeof tx) => Promise<void>) => callback(tx),
  );
  mocks.renderNotice.mockResolvedValue({ version: 2, body: 'Aktueller Datenschutzhinweis' });
  mocks.consentCreate.mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' });
});

describe('revokeAllConsentAction', () => {
  it('widerruft aus einem Mixed-Snapshot nur freiwillige Auswahlen', async () => {
    const previousConsent = mixedConsent();
    mocks.consentFindFirst.mockResolvedValue({ consents: previousConsent });

    await revokeAllConsentAction(formData());

    expect(mocks.consentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consents: {
          ...emptyConsent(),
          optionSelections: [previousConsent.optionSelections[0]],
        },
        isRevocation: true,
      }),
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ after: expect.objectContaining({ revokedCount: 4 }) }),
    );
  });

  it('legt bei ausschließlich verpflichtenden Bestätigungen keinen Widerruf an', async () => {
    const consent = emptyConsent();
    consent.optionSelections = [requiredSelection()];
    mocks.consentFindFirst.mockResolvedValue({ consents: consent });

    await revokeAllConsentAction(formData());

    expect(mocks.renderNotice).not.toHaveBeenCalled();
    expect(mocks.consentCreate).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});
