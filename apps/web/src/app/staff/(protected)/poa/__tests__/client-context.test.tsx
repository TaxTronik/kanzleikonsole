// @vitest-environment jsdom
// Vollmachten im Mandantenkontext als Render- und Verhaltenstest (B-08,
// Welle 15) statt Quelltextprüfung. Den Einstieg aus dem Onboarding
// (Link mit clientId und from=onboarding) prüft zusätzlich
// clients/onboarding/__tests__/onboarding-page.test.tsx.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import { DEFAULT_MODULES } from '@/server/settings/modules';
import { resolveClientNavigation } from '@/lib/navigation-registry';

const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_ID = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  canAccess: vi.fn(),
  hasPickerOption: vi.fn(),
  loadContacts: vi.fn(),
  createPoa: vi.fn(),
  tx: {
    client: { findFirst: vi.fn(), findMany: vi.fn() },
    powerOfAttorney: { findMany: vi.fn() },
  },
}));

vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@/server/settings/modules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/settings/modules')>()),
  readModules: vi.fn(async () => ({ poaMode: 'MARKDOWN_OTP' })),
}));
vi.mock('@/server/auth/rbac', () => ({
  canAccessClientTx: h.canAccess,
  hasStaffPermission: () => true,
  accessibleClientsWhereFor: vi.fn(async () => ({ vertraulich: false })),
  isStaffAdmin: () => true,
}));
vi.mock('@/server/clients/picker', () => ({ hasClientPickerOptionTx: h.hasPickerOption }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx)),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/requests/actions', () => ({
  createQuickRequestAction: vi.fn(),
}));
vi.mock('@/components/quick-request-dialog', () => ({ QuickRequestDialog: () => null }));
vi.mock('@/server/risk/availability', () => ({ isRiskLayerAvailable: () => false }));
vi.mock('../actions', () => ({
  createPoaAction: h.createPoa,
  loadPoaSignerContactsAction: h.loadContacts,
}));
// Die Serversuche des Mandantenfelds ist eigener Prüfgegenstand; hier genügt
// ein Stellvertreter, der Wert, Sperre und Auswahl sichtbar macht.
vi.mock('@/components/ui/client-combobox', () => ({
  ClientCombobox: (props: {
    name: string;
    value: { id: string; name: string } | null;
    disabled?: boolean;
    onChange: (value: { id: string; name: string } | null) => void;
  }) => (
    <div>
      <input
        aria-label="Mandant"
        readOnly
        value={props.value?.name ?? ''}
        disabled={props.disabled}
      />
      <input
        type="hidden"
        name={props.name}
        value={props.value?.id ?? ''}
        disabled={props.disabled}
      />
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => props.onChange({ id: 'client-b', name: 'Beispiel KG' })}
      >
        Beispiel KG wählen
      </button>
    </div>
  ),
}));

import NewPoaPage from '../new/page';
import PoaListPage from '../page';
import { ClientCockpitNav } from '../../clients/[id]/cockpit-header';

const requestedClient = {
  id: CLIENT_ID,
  name: 'Muster GmbH',
  contacts: [{ id: 'contact-1', fullName: 'Max Muster', email: 'max@mandant.example' }],
};

async function renderNew(query: Record<string, string>) {
  return renderServer(NewPoaPage({ searchParams: Promise.resolve(query) }));
}

function hiddenValue(name: string): string | null {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`),
  ].filter((input) => !input.disabled);
  return inputs.length ? inputs.map((input) => input.value).join(',') : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.canAccess.mockResolvedValue(true);
  h.hasPickerOption.mockResolvedValue(true);
  h.tx.client.findFirst.mockResolvedValue(requestedClient);
  h.tx.powerOfAttorney.findMany.mockResolvedValue([]);
});

describe('Vollmachten im Mandantenkontext', () => {
  it('übernimmt den Mandanten aus dem Onboarding gesperrt in das Anlageformular', async () => {
    await renderNew({ clientId: CLIENT_ID, from: 'onboarding' });
    // Nur der angeforderte Mandant wird geladen: mit Zugriffsprüfung, nie
    // beendet oder anonymisiert, keine Gesamtliste.
    expect(h.canAccess).toHaveBeenCalledWith(h.tx, expect.anything(), CLIENT_ID);
    expect(h.tx.client.findFirst.mock.calls[0]![0].where).toEqual({
      id: CLIENT_ID,
      anonymizedAt: null,
      mandateEndedAt: null,
    });
    expect(h.tx.client.findMany).not.toHaveBeenCalled();

    const client = screen.getByLabelText('Mandant') as HTMLInputElement;
    expect(client.value).toBe('Muster GmbH');
    expect(client.disabled).toBe(true);
    expect(hiddenValue('clientId')).toBe(CLIENT_ID);
    expect(hiddenValue('returnContext')).toBe('onboarding');
    expect(screen.getByRole('option', { name: 'Max Muster (max@mandant.example)' })).toBeTruthy();
    expect(screen.getByLabelText('Zurück').getAttribute('href')).toBe(
      `/staff/clients/onboarding/${CLIENT_ID}?step=poa`,
    );
  });

  it('fällt bei fehlendem Zugriff nicht still auf einen anderen Mandanten zurück', async () => {
    h.canAccess.mockResolvedValueOnce(false);
    await renderNew({ clientId: CLIENT_ID, from: 'onboarding' });
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
    expect(screen.getByText(/nicht mehr vorhanden oder für Sie nicht/)).toBeTruthy();
    expect(screen.queryByLabelText('Mandant')).toBeNull();
  });

  it('lässt ohne Onboarding-Kontext die Mandantenwahl offen und lädt die Kontakte nach', async () => {
    h.loadContacts.mockResolvedValueOnce({
      ok: true,
      contacts: [{ id: 'contact-9', fullName: 'Erika Beispiel', email: 'erika@beispiel.example' }],
    });
    await renderNew({});
    expect(hiddenValue('returnContext')).toBeNull();
    expect((screen.getByLabelText('Mandant') as HTMLInputElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Beispiel KG wählen' }));
    });
    expect(h.loadContacts).toHaveBeenCalledWith('client-b');
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: 'Erika Beispiel (erika@beispiel.example)' }),
      ).toBeTruthy(),
    );
  });

  it('sperrt die Mandantenwahl bei einem erhaltenen Upload und verlinkt die Fortsetzung', async () => {
    h.createPoa.mockResolvedValueOnce({
      ok: false,
      error: 'Signaturdatei fehlt.',
      pendingDocumentId: DOCUMENT_ID,
    });
    const { container } = await renderNew({ clientId: CLIENT_ID, from: 'onboarding' });
    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    const resume = await screen.findByRole('link', { name: 'Vorgang fortsetzen' });
    expect(resume.getAttribute('href')).toBe(
      `/staff/poa/new?clientId=${CLIENT_ID}&pendingDocumentId=${DOCUMENT_ID}&from=onboarding`,
    );
    expect((screen.getByLabelText('Mandant') as HTMLInputElement).disabled).toBe(true);
  });

  it('öffnet vom Mandanten aus eine vollständig gefilterte Vollmachtenliste', async () => {
    expect(
      resolveClientNavigation({ ...DEFAULT_MODULES, poaMode: 'MARKDOWN_OTP' }, 'client-1').poa,
    ).toBe('/staff/poa?clientId=client-1');
    expect(resolveClientNavigation({ ...DEFAULT_MODULES, poaMode: 'OFF' }, 'client-1').poa).toBe(
      undefined,
    );
    const nav = render(
      <ClientCockpitNav
        client={{ id: 'client-1', _count: { poas: 2 } } as never}
        clientNav={resolveClientNavigation(
          { ...DEFAULT_MODULES, poaMode: 'MARKDOWN_OTP' },
          'client-1',
        )}
        pendingChangeRequests={0}
        canSubsumtion={false}
      />,
    );
    expect(screen.getByRole('link', { name: /^Vollmachten/ }).getAttribute('href')).toBe(
      '/staff/poa?clientId=client-1',
    );
    nav.unmount();

    h.tx.client.findFirst.mockResolvedValueOnce({ id: CLIENT_ID, name: 'Muster GmbH' });
    await renderServer(PoaListPage({ searchParams: Promise.resolve({ clientId: CLIENT_ID }) }));
    const [listArgs] = h.tx.powerOfAttorney.findMany.mock.calls[0]!;
    expect(listArgs.where).toEqual({ clientId: CLIENT_ID });
    expect(listArgs.take).toBeUndefined();
    expect(screen.getByText('Alle Vollmachten für Muster GmbH')).toBeTruthy();
  });

  it('begrenzt die ungefilterte Liste und filtert sie nach Mandantenzugriff', async () => {
    await renderServer(PoaListPage({ searchParams: Promise.resolve({}) }));
    const [listArgs] = h.tx.powerOfAttorney.findMany.mock.calls[0]!;
    expect(listArgs.take).toBe(200);
    expect(listArgs.where).not.toHaveProperty('clientId', expect.any(String));
  });
});
