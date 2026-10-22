// @vitest-environment jsdom
// Einwilligungsrichtlinien in der Oberfläche als Render- und Verhaltenstests
// (B-08, Welle 15). Der Dateiname bleibt, weil DSGVO-CONSENT-SNAPSHOT-001 ihn
// als test_ref führt; daher createElement statt JSX. Nur die Phasenreihenfolge
// der serverseitigen Einreichungstransaktion bleibt ein Strukturguard (letzter
// describe-Block). Pflichtoptionen und Anzeige-Revision im Wizard prüft
// app/gwg-onboarding/__tests__/wizard-flow.test.tsx.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import {
  consentForNewDeclaration,
  defaultConsentOptionsCatalog,
  type ConsentSelections,
  type ResolvedConsentOption,
} from '../consent';
import { consentDisplayRevision, visibleConsentOptions } from '../consent-display';

const h = vi.hoisted(() => ({
  saveOptions: vi.fn(),
  wizardProps: [] as Array<Record<string, unknown>>,
  portalConsent: null as unknown,
  staffConsentHistory: [] as unknown[],
  notice: { complete: true, body: '# Hinweise', version: 3 } as Record<string, unknown>,
  options: [] as unknown[],
}));

vi.mock('@/components/gwg/identity-capture', () => ({ IdentityCapture: () => null }));
vi.mock('@/app/gwg-onboarding/actions', () => ({ loadOnboardingIdentitySourceAction: vi.fn() }));
vi.mock('@/app/staff/(protected)/admin/privacy/actions', () => ({
  saveConsentOptionsAction: h.saveOptions,
}));
// Öffentliche Onboarding-Seite: Token, Rate-Limit und Tenant-Daten nachgebildet.
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '203.0.113.7',
  checkIpOrGlobalLimit: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/server/gwg-onboarding/service', () => ({
  GENERIC_TOKEN_ERROR: 'Link ungültig.',
  loadInviteByRawToken: vi.fn(async () => ({
    ok: true,
    invite: {
      tenant: { id: 'tenant-1', name: 'Kanzlei Muster' },
      inviteName: 'Max Muster',
      client: { id: 'client-1', name: 'Muster GmbH', kind: 'JURPERS' },
      draft: null,
    },
  })),
}));
vi.mock('@/server/privacy/service', () => ({
  renderNoticeForTenantTx: vi.fn(async () => h.notice),
}));
vi.mock('@/server/privacy/consent-catalog', () => ({
  readResolvedConsentOptionsTx: vi.fn(async () => h.options),
}));
vi.mock('@/app/gwg-onboarding/wizard', () => ({
  OnboardingWizard: (props: Record<string, unknown>) => {
    h.wizardProps.push(props);
    return null;
  },
}));
// Portal-Einstellungen und Datenschutzseite des Mandanten.
vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: 'client-1' },
  })),
}));
vi.mock('@/app/portal/(protected)/settings/actions', () => ({
  revokeOwnConsentAction: vi.fn(),
  saveNotificationSettingAction: vi.fn(),
}));
vi.mock('@/components/accessible-display', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/accessible-display')>()),
  AccessibleDisplaySettings: () => null,
}));
vi.mock('@/server/auth/client-page-access', () => ({
  requireClientPageAccess: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: () => false }));
vi.mock('@/server/privacy/notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/privacy/notice')>()),
  readPrivacyConfigTx: vi.fn(async () => ({})),
  readPrivacyConfig: vi.fn(async () => ({})),
  isPrivacyConfigComplete: () => true,
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('@/server/settings/legal', () => ({ readLegal: vi.fn(async () => ({})) }));
vi.mock('@/app/staff/(protected)/admin/settings/legal-form', () => ({ LegalForm: () => null }));
vi.mock('@/app/staff/(protected)/admin/privacy/config-form', () => ({
  PrivacyConfigForm: () => null,
}));
vi.mock('@/app/staff/(protected)/clients/[id]/privacy/consent-editor', () => ({
  ConsentEditor: () => null,
}));
vi.mock('@/app/staff/(protected)/clients/[id]/privacy/actions', () => ({
  revokeAllConsentAction: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  // Onboarding-Seite: keine Uploads und kein Zwischenstand (GWG-SELF-ONBOARDING-001).
  withSystemContext: vi.fn(async (_tenant: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      document: { findMany: vi.fn(async () => []) },
      gwgOnboardingDraft: { findUnique: vi.fn(async () => null) },
    }),
  ),
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      clientContact: {
        findUnique: vi.fn(async () => ({
          notificationsEnabled: true,
          fullName: 'Max Muster',
          email: 'max@mandant.example',
          clientId: 'client-1',
        })),
        findMany: vi.fn(async () => []),
      },
      clientConsent: {
        findFirst: vi.fn(async () => h.portalConsent),
        findMany: vi.fn(async () => h.staffConsentHistory),
      },
      client: { findUnique: vi.fn(async () => ({ id: 'client-1', name: 'Muster GmbH' })) },
      serviceProvider: { findMany: vi.fn(async () => []) },
      tenantSetting: { findUnique: vi.fn(async () => null) },
    }),
  ),
}));

import { PrivacyStep } from '@/app/gwg-onboarding/wizard-steps';
import { ConsentOptionsEditor } from '@/app/staff/(protected)/admin/privacy/consent-options-editor';
import { ConsentFields } from '@/components/consent-fields';
import GwgOnboardingPage from '@/app/gwg-onboarding/page';
import PortalSettingsPage from '@/app/portal/(protected)/settings/page';
import ClientPrivacyPage from '@/app/staff/(protected)/clients/[id]/privacy/page';
import AdminPrivacyPage from '@/app/staff/(protected)/admin/privacy/page';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(webRoot, relativePath), 'utf8');
}

function optionsWithRequiredSections(): ResolvedConsentOption[] {
  return [
    ...defaultConsentOptionsCatalog().options.map((option) => ({
      ...option,
      required: ['communication.phone', 'marketing.emailNewsletter'].includes(option.id),
      serviceProvider: null,
      providerMissing: false,
    })),
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      builtin: false,
      section: 'OTHER',
      label: 'Eigene Bestätigung',
      description: null,
      active: true,
      required: true,
      recommended: false,
      sortOrder: 200,
      serviceProviderId: null,
      serviceProvider: null,
      providerMissing: false,
    },
  ];
}

function renderPrivacyStep(consentOptions: ResolvedConsentOption[]) {
  return renderToStaticMarkup(
    createElement(PrivacyStep, {
      noticeVersion: 4,
      noticeBody: '# Datenschutzhinweise',
      consent: consentForNewDeclaration(),
      consentOptions,
      noticeAck: false,
      signedByName: '',
      onConsentChange: vi.fn(),
      onNoticeAckChange: vi.fn(),
      onSignedByNameChange: vi.fn(),
    }),
  );
}

function checkboxesIn(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(([input]) => input);
}

function catalogJson(container: HTMLElement): {
  version: number;
  options: Array<Record<string, unknown>>;
} {
  return JSON.parse(container.querySelector<HTMLInputElement>('input[name="catalogJson"]')!.value);
}

/** Nur eine rechtlich notwendige (zwingende, eigene) Bestätigung – nicht widerrufbar. */
function requiredOnlyConsent(): ConsentSelections {
  return consentWith((consent) => {
    consent.optionSelections = [
      {
        optionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        labelSnapshot: 'Eigene Bestätigung',
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: true,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
    ];
  });
}

function consentWith(patch: (consent: ConsentSelections) => void): ConsentSelections {
  const consent = consentForNewDeclaration();
  patch(consent);
  return consent;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.wizardProps.length = 0;
});

describe('Einwilligungsrichtlinien in der UI', () => {
  it('bietet für jede aktive Option eine Kanzleivorgabe ohne Vorauswahl an', async () => {
    h.saveOptions.mockResolvedValue({ ok: true });
    const options = optionsWithRequiredSections();
    const custom = options.at(-1)!;
    const { container } = render(
      createElement(ConsentOptionsEditor, { initial: options, providers: [], revision: 'rev-1' }),
    );
    const requiredLabels = within(container)
      .getAllByRole('checkbox', { name: /Zwingend/ })
      .map((checkbox) => checkbox.closest('label')!.textContent);
    expect(requiredLabels.length).toBeGreaterThan(0);
    expect(
      requiredLabels.every((label) =>
        label!.includes('Ohne Bestätigung kann das Onboarding nicht abgeschlossen werden.'),
      ),
    ).toBe(true);
    const recommendation = within(container)
      .getAllByRole('checkbox', { name: /Als Empfehlung hervorheben/ })
      .map((checkbox) => checkbox.closest('label')!.textContent);
    expect(recommendation.every((label) => label!.includes('Bleibt im Portal ungekreuzt'))).toBe(
      true,
    );

    // Auch eigene Optionen („Weitere Optionen“) lassen sich frei einordnen.
    fireEvent.change(container.querySelector(`[id="consent-option-${custom.id}-section"]`)!, {
      target: { value: 'COMMUNICATION' },
    });
    const saved = catalogJson(container);
    expect(saved.version).toBe(2);
    expect(saved.options.find((option) => option.id === custom.id)).toMatchObject({
      section: 'COMMUNICATION',
      required: true,
    });
    expect(saved.options.every((option) => !('defaultSelected' in option))).toBe(true);

    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    const [, formData] = h.saveOptions.mock.calls[0]!;
    expect(JSON.parse((formData as FormData).get('catalogJson') as string).version).toBe(2);
    expect((formData as FormData).get('expectedRevision')).toBe('rev-1');
  });

  it('DSGVO-CONSENT-SNAPSHOT-001: renders a mandatory toggle for all active catalogue options', () => {
    const options = optionsWithRequiredSections();
    options[0] = { ...options[0]!, active: false, required: false };
    const html = renderToStaticMarkup(
      createElement(ConsentOptionsEditor, { initial: options, providers: [], revision: 'fixture' }),
    );
    const requiredLabels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map(([, content]) => content!)
      .filter((content) => content.includes('Zwingend'));
    expect(requiredLabels).toHaveLength(options.filter((option) => option.active).length);
    expect(requiredLabels.filter((label) => /\bchecked=""/.test(label))).toHaveLength(3);
  });

  it('DSGVO-CONSENT-SNAPSHOT-001: marks only acknowledgement as required in the standard catalogue', () => {
    const html = renderPrivacyStep(
      defaultConsentOptionsCatalog().options.map((option) => ({
        ...option,
        serviceProvider: null,
        providerMissing: false,
      })),
    );
    const checkboxes = checkboxesIn(html);
    expect(checkboxes).toHaveLength(12);
    expect(checkboxes.filter((input) => /\brequired=""/.test(input))).toHaveLength(1);
    expect(checkboxes.every((input) => !/\bchecked=""/.test(input))).toBe(true);
    expect(html).toContain('Zwingend');
    expect(html).toContain('Ich habe die Datenschutzhinweise zur Kenntnis genommen.');
    expect(html).toContain('Alle Optionen in diesem Bereich sind optional.');
    expect(html).toContain('Einwilligungen bleiben widerrufbar.');
    expect(html.indexOf('Kenntnisnahme')).toBeLessThan(html.indexOf('Kontaktwege'));
  });

  it('DSGVO-CONSENT-SNAPSHOT-001: renders required communication, marketing and custom choices unchecked', () => {
    const html = renderPrivacyStep(optionsWithRequiredSections());
    const checkboxes = checkboxesIn(html);
    expect(checkboxes).toHaveLength(13);
    expect(checkboxes.filter((input) => /\brequired=""/.test(input))).toHaveLength(4);
    expect(checkboxes.every((input) => !/\bchecked=""/.test(input))).toBe(true);
    const requiredLabels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map(([, content]) => content!)
      .filter((content) => /\brequired=""/.test(content));
    for (const text of [
      'Kenntnis genommen',
      'Telefon',
      'E-Mail-Newsletter',
      'Eigene Bestätigung',
    ]) {
      expect(requiredLabels.some((label) => label.includes(text))).toBe(true);
    }
    expect(html).toContain(
      'Zwingend markierte Optionen müssen für den Onboarding-Abschluss bestätigt werden.',
    );
    expect(html).not.toContain('Alle Optionen in diesem Bereich sind optional.');
    expect(html).toContain('Einwilligungen bleiben widerrufbar.');
  });

  it('keeps partial staff recording possible while showing the onboarding requirement', () => {
    const html = renderToStaticMarkup(
      createElement(ConsentFields, { options: optionsWithRequiredSections(), mode: 'staff' }),
    );
    expect(checkboxesIn(html).some((input) => /\brequired=""/.test(input))).toBe(false);
    expect(html).toContain('Zwingend');
  });

  it('beginnt neue Erklärungen ungekreuzt und zeigt Empfehlungen nur semantisch an', () => {
    const options = optionsWithRequiredSections().map((option) =>
      option.id === 'marketing.emailNewsletter' ? { ...option, recommended: true } : option,
    );
    const { container } = render(createElement(ConsentFields, { options, mode: 'catalog-only' }));
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
    const recommended = screen.getByText('(Empfehlung der Kanzlei)').closest('label')!;
    expect(recommended.textContent).toContain(
      'Nicht vorausgewählt – Sie entscheiden durch aktives Anklicken.',
    );
    expect((within(recommended).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    // Kein Kanzlei-Verwaltungshinweis im Portal.
    expect(container.textContent).not.toContain(
      'Empfänger, Kommunikationsdetails und Spezialdienstleister werden zentral',
    );
  });

  it('bindet die angezeigte Auswahl im öffentlichen Onboarding an eine Anzeige-Revision', async () => {
    // Eine deaktivierte Option ist nicht sichtbar und geht nicht in die Revision ein.
    h.options = optionsWithRequiredSections().map((option, index) =>
      index === 0 ? { ...option, active: false } : option,
    );
    await renderServer(GwgOnboardingPage({ searchParams: Promise.resolve({ token: 'tok' }) }));
    const visible = visibleConsentOptions(h.options as ResolvedConsentOption[]);
    expect(h.wizardProps).toEqual([
      expect.objectContaining({
        consentOptions: visible,
        consentDisplayRevision: consentDisplayRevision(h.notice as never, visible),
      }),
    ]);
  });

  it('benennt die Datenschutz-Zentrale neutral für Auswahl und Bestätigungen', async () => {
    h.options = optionsWithRequiredSections();
    await renderServer(AdminPrivacyPage());
    expect(screen.getByText(/Datenschutz-Auswahl und Bestätigungen/)).toBeTruthy();
    expect(screen.getByText('Hinweise & Datenschutz-Auswahl')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Kanzlei-Hinweise, freiwillige Einwilligungen');
  });

  it('unterscheidet im Portal aktive Auswahlen von widerrufbaren Einwilligungen', async () => {
    h.portalConsent = {
      consents: consentWith((consent) => {
        consent.marketing.emailNewsletter = true;
      }),
      createdAt: new Date(),
      isRevocation: false,
      signedByContact: 'contact-1',
    };
    const own = await renderServer(PortalSettingsPage());
    expect(
      screen.getByText(
        /Für 1 Datenschutz-Option\(en\) ist derzeit eine aktive Auswahl dokumentiert\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Rechtlich\s+notwendige Bestätigungen bleiben als Nachweis/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Widerrufbare Auswahl zurückziehen' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /freiwillige Einzeleinwilligung\(en\)|Alle freiwilligen Einwilligungen widerrufen/,
    );
    own.unmount();

    // Von einer anderen Person erklärt: kein Selbstwiderruf, Hinweis auf die Kanzlei.
    h.portalConsent = { ...(h.portalConsent as object), signedByContact: 'contact-2' };
    const other = await renderServer(PortalSettingsPage());
    expect(screen.queryByRole('button', { name: 'Widerrufbare Auswahl zurückziehen' })).toBeNull();
    expect(screen.getByText(/über die Kanzlei zurückgezogen werden/)).toBeTruthy();
    other.unmount();

    // Nur eine rechtlich notwendige Bestätigung: aktiv dokumentiert, nichts widerrufbar.
    h.portalConsent = {
      consents: requiredOnlyConsent(),
      createdAt: new Date(),
      isRevocation: false,
      signedByContact: 'contact-1',
    };
    await renderServer(PortalSettingsPage());
    expect(
      screen.getByText(
        /Für 1 Datenschutz-Option\(en\) ist derzeit eine aktive Auswahl dokumentiert\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Widerrufbare Auswahl zurückziehen' })).toBeNull();
    expect(screen.queryByText(/über die Kanzlei zurückgezogen werden/)).toBeNull();
  });

  it('bietet in der Kanzlei den Widerruf nur bei widerrufbarer Auswahl an', async () => {
    h.options = optionsWithRequiredSections();
    h.staffConsentHistory = [
      {
        id: 'consent-1',
        consents: consentWith((consent) => {
          consent.marketing.emailNewsletter = true;
        }),
        createdAt: new Date(),
        isRevocation: false,
        signedByName: 'Max Muster',
        signedByContact: null,
        noticeVersion: 3,
      },
    ];
    const withRevocable = await renderServer(
      ClientPrivacyPage({ params: Promise.resolve({ id: 'client-1' }) }),
    );
    expect(screen.getByRole('heading', { name: 'Einwilligungen widerrufen' })).toBeTruthy();
    withRevocable.unmount();

    h.staffConsentHistory = [
      { ...(h.staffConsentHistory[0] as object), consents: requiredOnlyConsent() },
    ];
    await renderServer(ClientPrivacyPage({ params: Promise.resolve({ id: 'client-1' }) }));
    expect(screen.queryByRole('heading', { name: 'Einwilligungen widerrufen' })).toBeNull();
  });
});

// Strukturguard (bewusst Quelltext): Phasenreihenfolge und Lock-Fenster der
// serverseitigen Einreichungstransaktion; ein Verhaltenstest braucht die
// echte Datenbank (siehe submission-transaction-structure.test.ts).
describe('Einreichungstransaktion: Pflichtoptionen und Lock-Fenster', () => {
  it('erzwingt Pflichtoptionen im öffentlichen Onboarding auch serverseitig', () => {
    const transaction = read('server/gwg-onboarding/submission-transaction.ts');

    expect(transaction).toContain('enforceRequired: true');
    expect(transaction).toContain('expectedDisplay:');
    expect(transaction).toContain('await lockConsentCatalogTx(tx, input.invite.tenantId)');
    expect(transaction).toContain('noticeSnapshot: notice.body');
  });

  it('hält den exklusiven Tenant-Lock nur im finalen Display-CAS-Fenster', () => {
    const transaction = read('server/gwg-onboarding/submission-transaction.ts');
    const scriptAt = transaction.indexOf(
      'export async function runOnboardingSubmissionTransactionTx',
    );
    const notifyAt = transaction.indexOf('await notifySubmissionTx(', scriptAt);
    const finalizationAt = transaction.indexOf(
      'await persistSubmissionConsentFinalizationTx(',
      notifyAt,
    );

    expect(notifyAt).toBeGreaterThan(-1);
    expect(finalizationAt).toBeGreaterThan(notifyAt);

    const finalizationStart = transaction.indexOf(
      'async function persistSubmissionConsentFinalizationTx',
    );
    const finalizationEnd = transaction.indexOf(
      '/**\n * The transaction body stays as a readable phase script.',
      finalizationStart,
    );
    const lockedWindow = transaction.slice(finalizationStart, finalizationEnd);
    expect(lockedWindow).toContain('await lockConsentCatalogTx(tx, input.invite.tenantId)');
    expect(lockedWindow).toContain('renderNoticeForTenantTx');
    expect(lockedWindow).toContain('resolveConsentSelectionsTx');
    expect(lockedWindow).toContain('tx.clientConsent.create');
    expect(lockedWindow).not.toContain('tx.gwg');
    expect(lockedWindow).not.toContain('notifyMany');
  });
});
