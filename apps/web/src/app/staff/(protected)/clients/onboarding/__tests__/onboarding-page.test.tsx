// @vitest-environment jsdom
// Fachkatalog: GWG-RISK-REVIEW-001 (GwG-Schritt nur nach vollständigem Berufsträger-Review erledigt)
// Mandanten-Onboarding (Schritte 2 bis n) als Render- und Verhaltenstest
// (B-08, Welle 15) statt Quelltextprüfung. Ersetzt contact-navigation.test.ts
// und gwg-completion.test.ts.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  addContact: vi.fn(),
  sendGwg: vi.fn(),
  skip: vi.fn(),
  complete: vi.fn(),
  captureInOffice: vi.fn(),
  client: {} as Record<string, unknown>,
  contactCount: 0,
  gwgCheck: null as Record<string, unknown> | null,
  invite: null as Record<string, unknown> | null,
  poaCount: 0,
}));

vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/auth/rbac', () => ({ canAccessClient: vi.fn(async () => true) }));
vi.mock('@/server/settings/modules', () => ({
  readModules: vi.fn(async () => ({ poaMode: 'BASIC' })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      client: { findUnique: vi.fn(async () => h.client) },
      clientContact: {
        count: vi.fn(async () => h.contactCount),
        findFirst: vi.fn(async () => null),
      },
      gwgOnboardingInvite: { findFirst: vi.fn(async () => h.invite) },
      gwgCheck: { findFirst: vi.fn(async () => h.gwgCheck) },
      powerOfAttorney: { count: vi.fn(async () => h.poaCount) },
      request: { count: vi.fn(async () => 0) },
    }),
  ),
}));
vi.mock('@/server/gwg-onboarding/invite-uploads', () => ({
  loadInviteUploadedDocumentsTx: vi.fn(async () => []),
}));
vi.mock('@/server/request-creation-options', () => ({
  readRequestCreationOptionsTx: vi.fn(async () => ({
    requestTemplates: [],
    requestFormTemplates: [],
    templatesLimited: false,
    formTemplatesLimited: false,
  })),
}));
vi.mock('@/server/mail/delivery-status', () => ({
  loadMailDeliveryTx: vi.fn(async () => new Map()),
}));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));
vi.mock('../[id]/actions', () => ({
  onboardingAddContactAction: h.addContact,
  onboardingSendGwgAction: h.sendGwg,
  onboardingSkipAction: h.skip,
  onboardingCompleteAction: h.complete,
  onboardingCaptureGwgInOfficeAction: h.captureInOffice,
}));
vi.mock('@/app/staff/(protected)/clients/[id]/requests/actions', () => ({
  createQuickRequestAction: vi.fn(),
}));
vi.mock('@/components/gwg-submission-summary', () => ({ GwgSubmissionSummary: () => null }));
vi.mock('@/components/quick-request-dialog', () => ({ QuickRequestDialog: () => null }));

import OnboardingStepPage from '../[id]/page';

function verifiedCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 'check-1',
    status: 'VERIFIED',
    verifiedAt: new Date('2026-10-01T08:00:00.000Z'),
    verifiedBy: 'staff-2',
    reviewSubmittedAt: new Date('2026-09-30T08:00:00.000Z'),
    reviewSubmittedBy: 'staff-1',
    validUntil: null,
    beneficialOwners: [],
    idDocuments: [],
    ...overrides,
  };
}

async function renderStep(step: string) {
  return renderServer(
    OnboardingStepPage({
      params: Promise.resolve({ id: CLIENT_ID }),
      searchParams: Promise.resolve({ step }),
    }),
  );
}

function stepper(): HTMLElement {
  return document.querySelector('ol') as HTMLElement;
}

function stepItem(label: string): HTMLElement {
  return within(stepper()).getByText(label).closest('li') as HTMLElement;
}

function formData(mock: ReturnType<typeof vi.fn>) {
  return Object.fromEntries(mock.mock.calls[0]![1] as FormData);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.client = {
    id: CLIENT_ID,
    name: 'Muster GmbH',
    kind: 'JURPERS',
    street: 'Hauptstr. 1',
    postalCode: '36304',
    city: 'Alsfeld',
    countryIso: 'DE',
    allowActive: false,
    onboardingCompletedAt: null,
  };
  h.contactCount = 0;
  h.gwgCheck = null;
  h.invite = null;
  h.poaCount = 0;
  for (const action of [h.addContact, h.sendGwg, h.skip, h.captureInOffice]) {
    action.mockResolvedValue({ ok: false, error: 'nicht im Test' });
  }
});

describe('Ansprechpartner-Schritt im Onboarding', () => {
  it('verschachtelt die Überspringen-Aktion nicht im Kontaktformular', async () => {
    await renderStep('contact');
    const name = screen.getByLabelText(/^Name/);
    const contactForm = name.closest('form')!;
    const skip = screen.getByRole('button', { name: 'Überspringen' });
    const create = screen.getByRole('button', { name: 'Anlegen & weiter' }) as HTMLButtonElement;

    expect(contactForm.contains(skip)).toBe(false);
    expect(skip.closest('form')).not.toBe(contactForm);
    // Der Absenden-Button steht außerhalb, gehört aber per form-Attribut dazu.
    expect(contactForm.contains(create)).toBe(false);
    expect(create.form).toBe(contactForm);

    await act(async () => {
      fireEvent.click(skip);
    });
    expect(h.addContact).not.toHaveBeenCalled();
    expect(formData(h.skip)).toEqual({ clientId: CLIENT_ID, next: 'gwg' });

    fireEvent.change(name, { target: { value: 'Max Muster' } });
    // Pflichtfelder füllen: jsdom prüft wie der Browser die Formularvalidierung.
    fireEvent.change(screen.getByLabelText(/^E-Mail/), {
      target: { value: 'max@mandant.example' },
    });
    await act(async () => {
      fireEvent.click(create);
    });
    expect(formData(h.addContact)).toMatchObject({ clientId: CLIENT_ID, fullName: 'Max Muster' });
    expect(h.skip).toHaveBeenCalledOnce();
  });
});

describe('abgeschlossene GwG im Onboarding', () => {
  it('zeigt nach der Verifikation nur noch den nächsten Schritt an', async () => {
    h.gwgCheck = verifiedCheck();
    await renderStep('gwg');
    expect(screen.queryByRole('button', { name: 'Einladung senden' })).toBeNull();
    expect(screen.queryByLabelText(/^Name des Mandanten/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'In der Kanzlei erfassen' })).toBeNull();
    const next = screen.getByRole('button', { name: 'Weiter' });
    await act(async () => {
      fireEvent.click(next);
    });
    expect(formData(h.skip)).toEqual({ clientId: CLIENT_ID, next: 'poa' });
    // Im Stepper gilt der GwG-Schritt als erledigt.
    expect(stepItem('GwG-Onboarding').querySelector('svg.lucide-check')).not.toBeNull();
  });

  it('behandelt einen unvollständigen Legacy-VERIFIED-Status fail-closed', async () => {
    h.gwgCheck = verifiedCheck({ reviewSubmittedAt: null, reviewSubmittedBy: null });
    await renderStep('gwg');
    expect(screen.getByText(/keinen vollständigen, dokumentierten/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Neuen Prüfzyklus starten' }).getAttribute('href'),
    ).toBe(`/staff/clients/${CLIENT_ID}/gwg?from=onboarding`);
    expect(screen.queryByRole('button', { name: 'Weiter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Einladung senden' })).toBeNull();
    expect(screen.queryByLabelText(/^Name des Mandanten/)).toBeNull();
    expect(stepItem('GwG-Onboarding').querySelector('svg.lucide-check')).toBeNull();
  });

  it('bietet ohne Prüfung Einladung und Kanzleierfassung an', async () => {
    await renderStep('gwg');
    expect(screen.getByRole('button', { name: 'Einladung senden' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'In der Kanzlei erfassen' })).toBeTruthy();
    expect(screen.queryByText(/keinen vollständigen, dokumentierten/)).toBeNull();
  });
});

describe('Navigation zwischen Wizard-Schritten', () => {
  it('verlinkt bereits durchlaufene Schritte und den vorherigen Schritt', async () => {
    h.contactCount = 1;
    await renderStep('poa');
    const href = (label: string) =>
      within(stepItem(label)).queryByRole('link')?.getAttribute('href') ?? null;
    expect(href('Stammdaten')).toBeNull();
    expect(href('Ansprechpartner + Portal-Zugang')).toBe(
      `/staff/clients/onboarding/${CLIENT_ID}?step=contact`,
    );
    expect(href('GwG-Onboarding')).toBe(`/staff/clients/onboarding/${CLIENT_ID}?step=gwg`);
    expect(href('Vollmacht')).toBeNull();
    expect(href('Erste Anforderung')).toBeNull();
    expect(href('Fertig')).toBeNull();
    // Die Verlinkung ändert keinen Abschlusszustand: GwG bleibt offen.
    expect(stepItem('GwG-Onboarding').querySelector('svg.lucide-check')).toBeNull();
    expect(screen.getByRole('link', { name: 'Zurück: GwG-Onboarding' }).getAttribute('href')).toBe(
      `/staff/clients/onboarding/${CLIENT_ID}?step=gwg`,
    );
  });

  it('verlinkt auch spätere, bereits erledigte Schritte', async () => {
    h.poaCount = 1;
    await renderStep('contact');
    const links = within(stepper())
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(links).toEqual([`/staff/clients/onboarding/${CLIENT_ID}?step=poa`]);
  });

  it('verlinkt nach Abschluss alle Schritte außer Stammdaten und dem aktuellen', async () => {
    h.client = { ...h.client, onboardingCompletedAt: new Date('2026-10-01T08:00:00.000Z') };
    await renderStep('contact');
    const links = within(stepper())
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(links).toEqual(
      ['gwg', 'poa', 'first_request', 'done'].map(
        (step) => `/staff/clients/onboarding/${CLIENT_ID}?step=${step}`,
      ),
    );
    // Vor dem Ansprechpartner-Schritt liegen nur die Stammdaten: kein Zurück-Link.
    expect(screen.queryByRole('link', { name: /^Zurück:/ })).toBeNull();
  });
});
