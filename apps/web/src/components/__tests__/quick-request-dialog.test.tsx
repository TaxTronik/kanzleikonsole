// @vitest-environment jsdom
// Quick-Anforderungsdialog als Render- und Verhaltenstest (B-08, Welle 15)
// statt Quelltextprüfung: Dialog, Formular mit gemeinsamer Mandantensuche und
// die Einbindung in Anforderungsliste, Mandantenliste und Mandanten-Cockpit.
// Die Einbindung im Onboarding prüft
// app/staff/(protected)/clients/onboarding/__tests__/onboarding-page.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  dialogs: [] as Array<Record<string, unknown>>,
  createQuick: vi.fn(),
  tx: {
    client: { findMany: vi.fn(), count: vi.fn() },
    request: { findMany: vi.fn(), count: vi.fn() },
  },
}));

const router = { refresh: vi.fn(), push: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/staff/requests',
}));
vi.mock('@/app/staff/(protected)/clients/[id]/requests/actions', () => ({
  createQuickRequestAction: h.createQuick,
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/auth/rbac', () => ({
  hasStaffPermission: () => false,
  accessibleClientsWhereFor: vi.fn(async () => ({ OR: [{ vertraulich: false }] })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx)),
}));
vi.mock('@/server/request-creation-options', () => ({
  readRequestCreationOptionsTx: vi.fn(async () => ({
    requestTemplates: [],
    requestFormTemplates: [],
    templatesLimited: false,
    formTemplatesLimited: false,
  })),
}));
vi.mock('@/components/recent-clients', () => ({ RecentClients: () => null }));
vi.mock('@/components/saved-views', () => ({ SavedViews: () => null }));
vi.mock('@/app/staff/(protected)/requests/bulk-toolbar', () => ({ BulkToolbar: () => null }));
vi.mock('@/server/risk/availability', () => ({ isRiskLayerAvailable: () => false }));
// Für die Seiten wird nur mitgeschnitten, welche Props der Dialog erhält; der
// Dialog selbst läuft in den ersten Tests echt.
vi.mock('@/components/quick-request-dialog', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/quick-request-dialog')>();
  return {
    QuickRequestDialog: (props: Parameters<typeof original.QuickRequestDialog>[0]) => {
      h.dialogs.push(props as unknown as Record<string, unknown>);
      return original.QuickRequestDialog(props);
    },
  };
});

import { QuickRequestDialog } from '@/components/quick-request-dialog';
import ClientsPage from '@/app/staff/(protected)/clients/page';
import RequestsPage from '@/app/staff/(protected)/requests/page';
import { ClientCockpitHeader } from '@/app/staff/(protected)/clients/[id]/cockpit-header';

function clientSearch(clients: Array<{ id: string; name: string; allowActive: boolean }>) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      clients: clients.map((client) => ({
        datevNo: null,
        addisonNo: null,
        mandateEnded: false,
        ...client,
      })),
      limited: false,
      mode: 'search',
    }),
  }));
}

function dialog(props: Partial<Parameters<typeof QuickRequestDialog>[0]> = {}) {
  return (
    <QuickRequestDialog
      createAction={h.createQuick}
      requestId={REQUEST_ID}
      templates={[]}
      formTemplates={[]}
      {...props}
    />
  );
}

async function openDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Anforderung erstellen' }));
  });
  const modal = screen.getByRole('dialog', { name: 'Anforderung erstellen' });
  // Das Formular wird erst beim Öffnen nachgeladen (next/dynamic).
  await waitFor(() => expect(modal.querySelector('form')).not.toBeNull(), { timeout: 10_000 });
  return modal;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dialogs.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Quick-Anforderungsdialog', () => {
  it('öffnet einen barrierearmen Dialog und sendet beim Öffnen noch nichts', async () => {
    render(dialog());
    const trigger = screen.getByRole('button', { name: 'Anforderung erstellen' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    const modal = await openDialog();
    expect(within(modal).getByRole('heading', { name: 'Anforderung erstellen' })).toBeTruthy();
    expect(h.createQuick).not.toHaveBeenCalled();
  });

  it('sperrt den Auslöser für noch nicht aktive Mandanten mit Begründung', () => {
    render(
      dialog({
        client: {
          id: 'client-1',
          name: 'Muster GmbH',
          datevNo: null,
          addisonNo: null,
          allowActive: false,
        },
      }),
    );
    const trigger = screen.getByRole('button', {
      name: 'Anforderung erstellen',
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(screen.getByText('Erst nach abgeschlossener GwG-Prüfung möglich.')).toBeTruthy();
  });

  it('verlangt die bestätigte Formulareingabe, sperrt während Pending und hält den Dialog offen', async () => {
    vi.stubGlobal(
      'fetch',
      clientSearch([
        { id: '22222222-2222-4222-8222-222222222222', name: 'Muster GmbH', allowActive: true },
        { id: '33333333-3333-4333-8333-333333333333', name: 'Neu KG', allowActive: false },
      ]),
    );
    let finish!: (value: unknown) => void;
    h.createQuick.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    render(dialog());
    const modal = await openDialog();
    const form = modal.querySelector('form')!;
    const submit = within(form).getByRole('button', {
      name: 'Anforderung erstellen',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(form.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(
      [...form.querySelectorAll<HTMLInputElement>('[name]')].map((element) => element.name),
    ).toEqual(
      expect.arrayContaining([
        'requestId',
        'clientId',
        'title',
        'description',
        'priority',
        'dueAt',
      ]),
    );

    const search = within(form).getByRole('combobox', { name: 'Mandant suchen' });
    fireEvent.change(search, { target: { value: 'Mu' } });
    const listbox = await within(form).findByRole('listbox', {}, { timeout: 3_000 });
    const inactive = (await within(listbox).findByText('Neu KG', {}, { timeout: 3_000 })).closest(
      'li',
    )!;
    const [url] = (vi.mocked(fetch).mock.calls[0] ?? []) as unknown as [string];
    expect(url).toContain('filter=notAnonymized');
    expect(
      within(inactive).getByText('Noch nicht auswählbar: GwG-Prüfung ausstehend'),
    ).toBeTruthy();
    fireEvent.click(within(listbox).getByRole('option', { name: /Muster GmbH/ }));
    expect(submit.disabled).toBe(false);

    fireEvent.change(within(form).getByLabelText(/^Titel/), { target: { value: 'Belege Q3' } });
    fireEvent.change(within(form).getByLabelText(/^Beschreibung/), {
      target: { value: 'Bitte hochladen.' },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(h.createQuick).toHaveBeenCalledOnce();
    expect(Object.fromEntries(h.createQuick.mock.calls[0]![1] as FormData)).toMatchObject({
      requestId: REQUEST_ID,
      clientId: '22222222-2222-4222-8222-222222222222',
      title: 'Belege Q3',
    });
    // Während der Erstellung: Absenden gesperrt, Schließen wirkungslos.
    expect(within(form).getByRole('button', { name: 'Wird erstellt…' })).toBeTruthy();
    fireEvent.keyDown(modal, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Anforderung erstellen' })).toBeTruthy();

    await act(async () => finish({ ok: false, error: 'Abgelehnt.' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Einbindung des Quick-Dialogs', () => {
  beforeEach(() => {
    h.tx.client.findMany.mockResolvedValue([]);
    h.tx.client.count.mockResolvedValue(0);
    h.tx.request.findMany.mockResolvedValue([]);
    h.tx.request.count.mockResolvedValue(0);
  });

  it.each([
    ['Anforderungsliste', () => RequestsPage({ searchParams: Promise.resolve({}) })],
    ['Mandantenliste', () => ClientsPage({ searchParams: Promise.resolve({}) })],
  ])('bindet den Dialog in die %s mit der Quick-Action ein', async (_page, page) => {
    await renderServer(page());
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]!.createAction).toBe(h.createQuick);
    expect(h.dialogs[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('bindet den Dialog im Mandanten-Cockpit mit Aktivierungsstand statt Seitenwechsel ein', () => {
    const { container } = render(
      <ClientCockpitHeader
        header={
          {
            client: {
              id: 'client-1',
              name: 'Muster GmbH',
              kind: 'JURPERS',
              datevNo: '10001',
              addisonNo: null,
              allowActive: false,
              responsibilities: [],
            },
            requestTemplates: [],
            requestFormTemplates: [],
            templatesLimited: false,
            formTemplatesLimited: false,
          } as never
        }
      />,
    );
    expect(h.dialogs[0]).toMatchObject({
      createAction: h.createQuick,
      client: expect.objectContaining({ id: 'client-1', allowActive: false }),
    });
    expect(container.querySelector('a[href="/staff/clients/client-1/requests/new"]')).toBeNull();
  });
});
