import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyConsent } from '@/server/privacy/consent';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const REQUIRED_ID = '44444444-4444-4444-8444-444444444444';
const OPTIONAL_ID = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => ({
  withPortalContext: vi.fn(),
  contactFindFirst: vi.fn(),
  consentFindFirst: vi.fn(),
  consentCreate: vi.fn(),
  evidenceRecord: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/server/actions/portal-action', () => {
  class ActionError extends Error {}
  return { ActionError, withPortalContext: mocks.withPortalContext };
});
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/logger', () => ({ log: { warn: mocks.logWarn } }));

import { revokeOwnConsentAction } from '../actions';

const tx = {
  clientContact: { findFirst: mocks.contactFindFirst },
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
  consent.communication.emailTls = true;
  consent.marketing.emailNewsletter = true;
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withPortalContext.mockImplementation(
    async (
      callback: (
        transaction: typeof tx,
        context: { tenantId: string; contactId: string; clientId: string },
      ) => Promise<void>,
    ) => {
      await callback(tx, { tenantId: TENANT_ID, contactId: CONTACT_ID, clientId: CLIENT_ID });
      return { ok: true };
    },
  );
  mocks.contactFindFirst.mockResolvedValue({ fullName: 'Erika Mustermann' });
  mocks.consentCreate.mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' });
});

describe('revokeOwnConsentAction', () => {
  it('widerruft aus einem Mixed-Snapshot nur freiwillige Auswahlen', async () => {
    const previousConsent = mixedConsent();
    mocks.consentFindFirst.mockResolvedValue({
      consents: previousConsent,
      noticeVersion: 2,
      noticeSnapshot: 'Gezeigter Datenschutzhinweis',
      signedByContact: CONTACT_ID,
    });

    await revokeOwnConsentAction();

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
      expect.objectContaining({ after: expect.objectContaining({ revokedCount: 5 }) }),
    );
  });

  it('legt bei ausschließlich verpflichtenden Bestätigungen keinen Widerruf an', async () => {
    const consent = emptyConsent();
    consent.optionSelections = [requiredSelection()];
    mocks.consentFindFirst.mockResolvedValue({
      consents: consent,
      noticeVersion: 2,
      noticeSnapshot: 'Gezeigter Datenschutzhinweis',
      signedByContact: CONTACT_ID,
    });

    await revokeOwnConsentAction();

    expect(mocks.consentCreate).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});
