// Fachkatalog: YEAR-END-CAMPAIGN-001
// P-19: Rollout lädt Freischaltung und vorhandene Zuordnungen vorab und legt
// Submissions, Requests und Einträge mit je einem createMany an.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';

const m = vi.hoisted(() => ({ assertClientAccessTx: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: m.assertClientAccessTx }));

import {
  rolloutCampaignTx,
  YEAR_END_REQUEST_DESCRIPTION,
  YEAR_END_ROLLOUT_MAX_CLIENTS,
  type RolloutCampaign,
} from '../year-end-rollout';
import { ActionError } from '@/server/actions/action-error';

const CAMPAIGN: RolloutCampaign = {
  id: 'campaign-1',
  templateId: 'template-1',
  schemaSnapshot: { version: 1, fields: [] },
  name: 'Jahreswechsel',
  year: 2026,
  dueAt: new Date('2026-12-31T22:59:00Z'),
};
const G = { session: {} as never, tenantId: 'tenant-1', staffId: 'staff-1' };

function makeTx(opts: { eligible?: string[]; assigned?: string[] } = {}) {
  return {
    client: {
      findMany: vi.fn(async () => (opts.eligible ?? []).map((id) => ({ id }))),
    },
    yearEndCampaignEntry: {
      findMany: vi.fn(async () => (opts.assigned ?? []).map((clientId) => ({ clientId }))),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    formSubmission: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    request: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
  };
}

type Rows = Array<Record<string, unknown>>;
const rows = (fn: { mock: { calls: unknown[][] } }): Rows =>
  (fn.mock.calls[0]![0] as { data: Rows }).data;

beforeEach(() => {
  vi.clearAllMocks();
  m.assertClientAccessTx.mockResolvedValue(undefined);
});

describe('rolloutCampaignTx', () => {
  it('legt je neuem Mandanten verknüpfte Submission, Request und Eintrag gesammelt an', async () => {
    const tx = makeTx({ eligible: ['c1', 'c2', 'c3'], assigned: ['c2'] });

    const created = await rolloutCampaignTx(tx as unknown as TxClient, G, CAMPAIGN, [
      'c1',
      'c2',
      'c3',
      'c1',
    ]);

    expect(created).toBe(2);
    expect(tx.client.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2', 'c3'] }, allowActive: true, mandateEndedAt: null },
      select: { id: true },
    });
    expect(tx.yearEndCampaignEntry.findMany).toHaveBeenCalledWith({
      where: { campaignId: 'campaign-1', clientId: { in: ['c1', 'c2', 'c3'] } },
      select: { clientId: true },
    });
    for (const fn of [
      tx.formSubmission.createMany,
      tx.request.createMany,
      tx.yearEndCampaignEntry.createMany,
    ])
      expect(fn).toHaveBeenCalledTimes(1);

    const submissions = rows(tx.formSubmission.createMany);
    const requests = rows(tx.request.createMany);
    const entries = rows(tx.yearEndCampaignEntry.createMany);
    expect(submissions.map((s) => s.clientId)).toEqual(['c1', 'c3']);
    submissions.forEach((submission, i) => {
      const request = requests[i]!;
      const entry = entries[i]!;
      expect(submission).toEqual({
        id: expect.any(String),
        tenantId: 'tenant-1',
        clientId: submission.clientId,
        templateId: 'template-1',
        schemaSnapshot: CAMPAIGN.schemaSnapshot,
        name: 'Jahreswechsel 2026',
        createdByStaff: 'staff-1',
        requestId: request.id,
      });
      expect(request).toEqual({
        id: expect.any(String),
        tenantId: 'tenant-1',
        clientId: submission.clientId,
        title: 'Jahreswechsel 2026',
        description: YEAR_END_REQUEST_DESCRIPTION,
        formSubmissionId: submission.id,
        dueAt: CAMPAIGN.dueAt,
        createdByStaff: 'staff-1',
      });
      expect(entry).toEqual({
        tenantId: 'tenant-1',
        campaignId: 'campaign-1',
        clientId: submission.clientId,
        submissionId: submission.id,
        requestId: request.id,
      });
    });
    expect(new Set(submissions.map((s) => s.id)).size).toBe(2);
    expect(tx.formSubmission.createMany).toHaveBeenCalledBefore(tx.request.createMany);
    expect(tx.request.createMany).toHaveBeenCalledBefore(tx.yearEndCampaignEntry.createMany);
  });

  it('braucht unabhängig von der Auswahlgröße gleich viele Statements', async () => {
    const ids = Array.from({ length: YEAR_END_ROLLOUT_MAX_CLIENTS }, (_, i) => `client-${i}`);
    const tx = makeTx({ eligible: ids });

    expect(await rolloutCampaignTx(tx as unknown as TxClient, G, CAMPAIGN, ids)).toBe(ids.length);

    const statements = [
      tx.client.findMany,
      tx.yearEndCampaignEntry.findMany,
      tx.formSubmission.createMany,
      tx.request.createMany,
      tx.yearEndCampaignEntry.createMany,
    ].reduce((sum, fn) => sum + fn.mock.calls.length, 0);
    expect(statements).toBe(5);
    expect(rows(tx.yearEndCampaignEntry.createMany)).toHaveLength(ids.length);
  });

  it('schreibt nichts, wenn alle Mandanten bereits zugeordnet sind', async () => {
    const tx = makeTx({ eligible: ['c1'], assigned: ['c1'] });

    expect(await rolloutCampaignTx(tx as unknown as TxClient, G, CAMPAIGN, ['c1'])).toBe(0);
    expect(tx.formSubmission.createMany).not.toHaveBeenCalled();
    expect(tx.request.createMany).not.toHaveBeenCalled();
    expect(tx.yearEndCampaignEntry.createMany).not.toHaveBeenCalled();
  });

  it('prüft je Mandant in Auswahlreihenfolge erst Zugriff, dann Freischaltung', async () => {
    // c1 ist nicht freigeschaltet, c2 nicht zugänglich: wie bisher gewinnt c1.
    const tx = makeTx({ eligible: ['c2'] });
    m.assertClientAccessTx.mockImplementation(async (_tx, _session, clientId: string) => {
      if (clientId === 'c2') throw new Error('Kein Zugriff auf diesen Mandanten.');
    });

    await expect(
      rolloutCampaignTx(tx as unknown as TxClient, G, CAMPAIGN, ['c1', 'c2']),
    ).rejects.toEqual(new ActionError('Mandant ohne freigeschaltetes Portal.'));
    expect(tx.formSubmission.createMany).not.toHaveBeenCalled();

    await expect(
      rolloutCampaignTx(tx as unknown as TxClient, G, CAMPAIGN, ['c2', 'c1']),
    ).rejects.toThrow('Kein Zugriff auf diesen Mandanten.');
    // Auch bereits zugeordnete Mandanten müssen weiterhin zugänglich und freigeschaltet sein.
    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, G.session, 'c1');
  });
});
