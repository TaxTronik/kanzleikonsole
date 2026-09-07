import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BwaPlanBasis } from '@/server/bwa/plan-basis';

const fixture = vi.hoisted(() => ({
  periods: [] as Array<{
    id: string;
    periodKey: string;
    periodType: 'YEAR';
    source: 'DATEV' | 'ADDISON' | 'MANUAL';
    positions: Array<{ number: number; amount: number }>;
  }>,
  bases: [] as Array<BwaPlanBasis & { id: string }>,
  taxProps: null as { resultBeforeTax: number | null } | null,
  withTenantContext: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
}));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: async () => ({
    user: { tenantId: 'tenant-test', contactId: 'contact-test', clientId: 'client-test' },
  }),
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 'tenant-test', staffId: 'staff-test' } }),
}));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeatures: async () => ({ bwaPlanning: true }),
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: fixture.withTenantContext }));
vi.mock('@/app/portal/(protected)/bwa/plan/actions', () => ({ createPlanAction: vi.fn() }));
vi.mock('@/app/staff/(protected)/clients/[id]/bwa/plans/actions', () => ({
  createStaffPlanAction: vi.fn(),
}));
vi.mock('@/app/portal/(protected)/bwa/plan/plan-wizard', () => ({
  PlanWizard: ({ bases }: { bases: typeof fixture.bases }) => {
    fixture.bases = bases;
    return null;
  },
}));
vi.mock('@/app/staff/(protected)/clients/[id]/bwa/[periodId]/tax-estimator-card', () => ({
  TaxEstimatorCard: (props: typeof fixture.taxProps) => {
    fixture.taxProps = props;
    return null;
  },
}));

import PortalNewPlanPage from '@/app/portal/(protected)/bwa/plan/new/page';
import StaffNewPlanPage from '@/app/staff/(protected)/clients/[id]/bwa/plans/new/page';
import BwaPeriodDetailPage from '@/app/staff/(protected)/clients/[id]/bwa/[periodId]/page';

const datev = [
  [1020, 1000],
  [1040, 0],
  [1045, 0],
  [1051, 1000],
  [1060, 200],
  [1090, 25],
  [1100, 400],
  [1240, 50],
  [1280, 600],
  [1300, 225],
  [1320, 0],
  [1330, 20],
  [1345, 245],
  [1380, 170],
].map(([number, amount]) => ({ number: number!, amount: amount! }));
const addison = [
  [1990, 1000],
  [3150, 800],
  [3250, 250],
  [3030, 400],
  [3010, 200],
  [3100, 50],
  [1010, 50],
].map(([number, amount]) => ({ number: number!, amount: amount! }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.bases = [];
  fixture.taxProps = null;
  fixture.periods = [
    { id: 'datev', periodKey: '2025', periodType: 'YEAR', source: 'DATEV', positions: datev },
    { id: 'addison', periodKey: '2024', periodType: 'YEAR', source: 'ADDISON', positions: addison },
    {
      id: 'incomplete',
      periodKey: '2023',
      periodType: 'YEAR',
      source: 'DATEV',
      positions: datev.filter((p) => p.number !== 1020),
    },
    { id: 'manual', periodKey: '2022', periodType: 'YEAR', source: 'MANUAL', positions: addison },
  ];
  fixture.findMany.mockImplementation(async () => fixture.periods);
  fixture.withTenantContext.mockImplementation(async (_context, run) =>
    run({
      client: { findUnique: async () => ({ id: 'client-test', name: 'Synthetischer Mandant' }) },
      bwaPeriod: { findMany: fixture.findMany, findFirst: fixture.findFirst },
    }),
  );
});

describe('BWA-IMPORT-MAPPING-001 / BWA-PROJECTION-001: beide Planseiten verwenden validierte Quellachsen', () => {
  for (const mode of ['portal', 'staff'] as const) {
    it(`${mode}: DATEV, Addison und unvollständige Perioden bis zum echten Wizard-Vertrag`, async () => {
      renderToStaticMarkup(
        await (mode === 'portal'
          ? PortalNewPlanPage()
          : StaffNewPlanPage({ params: Promise.resolve({ id: 'client-test' }) })),
      );
      expect(fixture.bases).toMatchObject([
        {
          id: 'datev',
          canApply: true,
          revenue: 1000,
          resultBeforeTax: 245,
          material: 200,
          depreciation: 50,
          otherIncome: 45,
        },
        {
          id: 'addison',
          canApply: true,
          revenue: 1000,
          resultBeforeTax: 250,
          material: 200,
          depreciation: 50,
          otherIncome: 50,
        },
        { id: 'incomplete', canApply: false, revenue: null },
        {
          id: 'manual',
          canApply: false,
          revenue: null,
          material: null,
          depreciation: null,
          otherIncome: null,
        },
      ]);
      expect(fixture.withTenantContext).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-test',
          actorId: mode === 'portal' ? 'contact-test' : 'staff-test',
          actorType: mode === 'portal' ? 'CLIENT_CONTACT' : 'STAFF',
        },
        expect.any(Function),
      );
      expect(fixture.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'client-test' } }),
      );
    });
  }
});

describe('BWA-TAX-ESTIMATE-001: Periodenseite gibt die verfügbare Vorsteuerbasis weiter', () => {
  it.each([0, 245, null])(
    'zeigt die Steuerkarte auch ohne vorläufiges Nachsteuerergebnis (%s)',
    async (basis) => {
      fixture.findFirst.mockResolvedValue({
        ...fixture.periods[0],
        positions: datev
          .filter((p) => p.number !== 1380 && p.number !== 1345)
          .concat(basis === null ? [] : [{ number: 1345, amount: basis }])
          .map((position) => ({
            ...position,
            label: `Position ${position.number}`,
            sharePct: null,
          })),
        fromDate: new Date('2025-01-01'),
        toDate: new Date('2025-12-31'),
        sourceRef: null,
        client: { name: 'Synthetischer Mandant', kind: 'JURPERS' },
      });
      renderToStaticMarkup(
        await BwaPeriodDetailPage({
          params: Promise.resolve({ id: 'client-test', periodId: 'datev' }),
        }),
      );
      expect(fixture.taxProps).toMatchObject({ resultBeforeTax: basis });
    },
  );
});
