// @vitest-environment jsdom
// Fachkatalog: CLIENT-OFFBOARDING-001, CLIENT-MANDATE-LIFECYCLE-001, VDB-PREPARATION-001
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OffboardingPage from '../offboarding/page';
import VdbPage from '../vdb/page';

const clientId = '11111111-1111-4111-8111-111111111111';
const { runs, source, poas } = vi.hoisted(() => ({
  runs: vi.fn(),
  source: vi.fn(),
  poas: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      mandateOffboarding: { findMany: runs },
      powerOfAttorney: { findMany: poas },
      documentVersion: { findMany: async () => [] },
    }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: vi.fn() }));
vi.mock('@/server/mandate-expansion/service', () => ({
  visibleMandateTx: async () => ({ id: clientId, name: 'Testmandat' }),
}));
vi.mock('@/server/mandate-expansion/offboarding', () => ({ offboardingSourceTx: source }));
vi.mock('@/server/mandate-expansion/artifacts', () => ({
  handoverPreparationHash: () => 'freigabe',
}));
vi.mock('../common', () => ({
  expansionPage: async () => ({ ctx: {}, session: { user: { tenantId: 'tenant' } } }),
  ExpansionNavigation: () => null,
  ClientSelect: () => null,
}));
vi.mock('../actions', () => ({
  archiveOffboardingAction: vi.fn(),
  prepareOffboardingAction: vi.fn(),
  finishOffboardingAction: vi.fn(),
  recordVdbStateAction: vi.fn(),
}));

const snapshot = {
  deadlines: [],
  notices: [],
  requests: [],
  gwgChecks: [],
  contactIds: [],
  documents: [],
};
const midnight = '2026-06-30T22:00:00Z';
const draft = {
  id: 'vorbereitung',
  createdAt: new Date(midnight),
  completedAt: null,
  endDate: new Date('2026-06-15T00:00:00Z'),
  documents: [],
  artifacts: [],
};
const params = { searchParams: Promise.resolve({ clientId }) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(midnight));
  source.mockResolvedValue({ snapshot, client: { mandateEndedAt: null } });
  runs.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

it.each([
  ['2026-06-30T21:59:59Z', '2026-06-30', '2026-07-01'],
  [midnight, '2026-07-01', '2026-07-02'],
  ['2026-12-31T23:00:00Z', '2027-01-01', '2027-01-02'],
])(
  'uses the Berlin day for the VDB and offboarding inputs at %s',
  async (instant, today, tomorrow) => {
    vi.setSystemTime(new Date(instant));
    poas.mockResolvedValue([
      { id: 'vollmacht', subject: 'Testvollmacht', status: 'SIGNED', vdbRecords: [] },
    ]);
    render(await VdbPage(params));
    render(await OffboardingPage(params));
    for (const label of ['Datum des externen Vorgangs', 'Tatsächliches Mandatsende']) {
      const field = screen.getByLabelText<HTMLInputElement>(label);
      expect(field.value).toBe(today);
      expect(field.max).toBe(today);
      expect(field.checkValidity()).toBe(true);
      fireEvent.change(field, { target: { value: tomorrow } });
      expect(field.validity.rangeOverflow).toBe(true);
    }
  },
);

it('preserves a prepared end date and shows the preparation on the Berlin day it happened', async () => {
  runs.mockResolvedValue([draft]);
  render(await OffboardingPage(params));
  const field = screen.getByLabelText<HTMLInputElement>('Tatsächliches Mandatsende');
  expect(field.value).toBe('2026-06-15');
  expect(field.max).toBe('2026-07-01');
  expect(screen.getByRole('heading', { name: /2026-07-01 · Vorbereitet/ })).toBeTruthy();
});

it('shows the Berlin end day for an already ended mandate', async () => {
  source.mockResolvedValue({ snapshot, client: { mandateEndedAt: new Date(midnight) } });
  render(await OffboardingPage(params));
  expect(screen.getByText(/Mandat beendet seit 2026-07-01/)).toBeTruthy();
  expect(screen.queryByLabelText('Tatsächliches Mandatsende')).toBeNull();
});
