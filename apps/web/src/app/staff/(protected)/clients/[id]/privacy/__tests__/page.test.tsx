import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyConsent, type ConsentSelections } from '@/server/privacy/consent';

const mocks = vi.hoisted(() => ({ withTenantContext: vi.fn() }));

vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn().mockResolvedValue({ user: { tenantId: 'tenant', staffId: 'staff' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: () => false }));
vi.mock('@/server/privacy/service', () => ({ renderNoticeForTenantTx: vi.fn() }));
vi.mock('@/server/privacy/notice', () => ({
  readPrivacyConfigTx: vi.fn(),
  isPrivacyConfigComplete: vi.fn(),
}));
vi.mock('@/server/privacy/consent-catalog', () => ({ readResolvedConsentOptionsTx: vi.fn() }));
vi.mock('@/components/notice-view', () => ({ NoticeView: () => null }));
vi.mock('../consent-editor', () => ({ ConsentEditor: () => null }));
vi.mock('../actions', () => ({ revokeAllConsentAction: vi.fn() }));

import ClientPrivacyPage from '../page';

function requiredConfirmation(): ConsentSelections {
  return {
    ...emptyConsent(),
    optionSelections: [
      {
        optionId: '44444444-4444-4444-8444-444444444444',
        labelSnapshot: 'Notwendige Bestätigung',
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: true,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
    ],
  };
}

async function renderPage(consents: ConsentSelections, isRevocation: boolean) {
  mocks.withTenantContext.mockResolvedValue({
    client: { id: 'client', name: 'Mandant' },
    history: [
      {
        id: 'consent',
        consents,
        isRevocation,
        createdAt: new Date('2026-09-14T10:00:00Z'),
        signedByName: 'Erika Mustermann',
        source: 'STAFF',
      },
    ],
    contacts: [],
    notice: { version: 4, body: 'Datenschutzhinweise', complete: true },
    consentOptions: [],
    configComplete: true,
  });
  return renderToStaticMarkup(
    await ClientPrivacyPage({ params: Promise.resolve({ id: 'client' }) }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('DSGVO-CONSENT-SNAPSHOT-001: Datenschutz-Auswahl in der Kanzleiansicht', () => {
  it('bietet nach einem Teilwiderruf den Widerruf verbleibender Pflicht-Kontakt- und Marketingauswahlen an', async () => {
    const consents = requiredConfirmation();
    consents.communication.phone = true;
    consents.marketing.emailNewsletter = true;
    consents.optionSelections.push(
      {
        ...consents.optionSelections[0]!,
        optionId: 'communication.phone',
        labelSnapshot: 'Telefon',
        section: 'COMMUNICATION',
      },
      {
        ...consents.optionSelections[0]!,
        optionId: 'marketing.emailNewsletter',
        labelSnapshot: 'Newsletter',
        section: 'MARKETING',
      },
    );

    const html = await renderPage(consents, true);

    expect(html).toContain('Einwilligungen widerrufen');
    expect(html).toContain('3 Datenschutz-Option(en) aktiv');
    expect(html).not.toContain('Einzeleinwilligung(en) aktiv');
  });

  it.each([false, true])(
    'bietet für ausschließlich erforderliche OTHER-Bestätigungen keinen Widerruf an (Widerrufs-Snapshot: %s)',
    async (isRevocation) => {
      const html = await renderPage(requiredConfirmation(), isRevocation);

      expect(html).toContain('1 Datenschutz-Option(en) aktiv');
      expect(html).not.toContain('Einwilligungen widerrufen');
    },
  );
});
