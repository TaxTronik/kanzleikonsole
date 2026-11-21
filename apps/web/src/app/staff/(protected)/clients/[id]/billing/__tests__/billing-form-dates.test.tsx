// @vitest-environment jsdom
// INV-NUMBER-ALLOCATION-001: bearbeitbare Datumsvorschläge bei der Stundenabrechnung.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import ClientBillingPage from '../page';

const { createInvoice, push } = vi.hoisted(() => ({ createInvoice: vi.fn(), push: vi.fn() }));
vi.mock('../actions', () => ({ createInvoiceFromTimeEntriesAction: createInvoice }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/server/auth/client-page-access', () => ({
  requireClientPageAccess: async () => ({ user: { tenantId: 'tenant', staffId: 'staff' } }),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: async () => undefined }));
vi.mock('@/server/auth/rbac', () => ({ hasStaffPermission: () => true }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      client: {
        findUnique: async () => ({ id: 'mandant', name: 'Testmandat', allowActive: true }),
      },
      timeEntry: {
        findMany: async () => [
          {
            id: 'stunde',
            startedAt: new Date('2026-03-01T10:00:00Z'),
            endedAt: new Date('2026-03-01T11:00:00Z'),
            staff: { fullName: 'Testperson' },
          },
        ],
      },
    }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([
  ['2026-03-28T23:30:00Z', '2026-03-29', '2026-04-28', 'März 2026'],
  ['2026-10-24T22:30:00Z', '2026-10-25', '2026-11-24', 'Oktober 2026'],
  ['2026-12-31T23:30:00Z', '2027-01-01', '2027-01-31', 'Januar 2027'],
])(
  'behält beim Hydrieren den Berliner Stichtag vom Server (%s)',
  async (now, issue, due, month) => {
    createInvoice.mockResolvedValue({ invoiceId: 'entwurf' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const page = await ClientBillingPage({ params: Promise.resolve({ id: 'mandant' }) });
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    expect(container.querySelector<HTMLInputElement>('#issueDate')?.value).toBe(issue);
    expect(container.querySelector<HTMLInputElement>('#dueDate')?.value).toBe(due);

    vi.setSystemTime(new Date('2027-02-02T09:00:00Z'));
    document.body.appendChild(container);
    render(page, { container, hydrate: true });
    expect(screen.getByLabelText<HTMLInputElement>('Datum').value).toBe(issue);
    expect(screen.getByLabelText<HTMLInputElement>('Fällig').value).toBe(due);
    expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
      `Beratungsleistungen ${month}`,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Rechnung erstellen/ }));
    });
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        issueDate: issue,
        dueDate: due,
        subject: `Beratungsleistungen ${month}`,
      }),
    );
  },
);

it('übergibt die vom Bearbeiter geänderten Kalendertage an die Rechnungsanlage', async () => {
  createInvoice.mockResolvedValue({ invoiceId: 'entwurf' });
  render(await ClientBillingPage({ params: Promise.resolve({ id: 'mandant' }) }));
  fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2027-01-04' } });
  fireEvent.change(screen.getByLabelText('Fällig'), { target: { value: '2027-02-12' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Rechnung erstellen/ }));
  });
  expect(createInvoice).toHaveBeenCalledWith(
    expect.objectContaining({
      clientId: 'mandant',
      issueDate: '2027-01-04',
      dueDate: '2027-02-12',
    }),
  );
  expect(push).toHaveBeenCalledWith('/staff/invoices/entwurf');
});
