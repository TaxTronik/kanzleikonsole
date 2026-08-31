import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: mocks.access }));
import { GwgControlListTooLargeError, loadGwgControlListTx } from '../control-list';

const session = { user: { tenantId: 'tenant', staffId: 'staff' } } as never;
const filters = { query: '', state: 'ALL' as const, clientId: '' };
const now = new Date('2026-08-31T10:00:00Z');

function client(id: string, number: string) {
  const owner = {
    id: `owner-${id}`,
    fullName: 'Gleicher Name',
    birthDate: new Date('1980-01-01'),
    personAnchorId: `anchor-${id}`,
  };
  return {
    id,
    name: `Firma ${id}`,
    kind: 'JURPERS',
    datevNo: '00012',
    gwgNaturalPersonAnchor: null,
    gwgChecks: [
      {
        id: `check-${id}`,
        status: 'DRAFT',
        verifiedBy: null,
        verifiedAt: null,
        beneficialOwners: [owner],
        representatives: [
          {
            id: `rep-${id}`,
            fullName: owner.fullName,
            birthDate: owner.birthDate,
            personAnchorId: owner.personAnchorId,
            linkedBeneficialOwnerId: owner.id,
          },
        ],
        idDocuments: [
          {
            id: `doc-${id}`,
            documentSetId: `set-${id}`,
            naturalClientSubjectId: null,
            beneficialOwnerSubjectId: null,
            representativeSubjectId: `rep-${id}`,
            type: 'PERSONALAUSWEIS',
            number,
            issuedBy: 'Berlin',
            issueDate: new Date('2020-01-01'),
            expiryDate: new Date('2030-01-01'),
            verifiedAt: now,
            identityAssignmentConfirmedAt: now,
            identityAssignmentConfirmedBy: 'reviewer',
            document: {
              clientId: id,
              classification: 'GWG_EVIDENCE',
              deletedAt: null,
              gwgDestroyedAt: null,
              gwgDestructionRequestedAt: null,
              versions: [{ scanStatus: 'CLEAN', scanCompletedAt: now }],
            },
          },
        ],
      },
    ],
  };
}
function database(clients = [client('a', '00123'), client('b', '00999')]) {
  return {
    client: { findMany: vi.fn().mockResolvedValue(clients) },
    staffUser: { findMany: vi.fn().mockResolvedValue([{ id: 'reviewer', fullName: 'Prüferin' }]) },
    gwgPersonLink: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'ab', fromAnchorId: 'anchor-a', toAnchorId: 'anchor-b' }]),
    },
  };
}

describe('GWG-CONTROL-EXPORT-001 / GWG-PERSON-LINKS-001 authorized control projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ id: { in: ['a', 'b'] } });
  });

  it('applies client visibility before reading evidence and takes only the latest surviving snapshot', async () => {
    const tx = database();
    const result = await loadGwgControlListTx(tx as never, session, filters, now);
    expect(tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ id: { in: ['a', 'b'] } }, { anonymizedAt: null }] },
        select: expect.objectContaining({
          gwgChecks: expect.objectContaining({
            where: { destroyedAt: null },
            take: 1,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        }),
      }),
    );
    expect(tx.gwgPersonLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fromAnchorId: { in: ['anchor-a', 'anchor-b'] },
          toAnchorId: { in: ['anchor-a', 'anchor-b'] },
        },
      }),
    );
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map((row) => row.groupId)).size).toBe(1);
    expect(result.rows.map((row) => row.number)).toEqual(['00123', '00999']);
    expect(
      result.rows.every(
        (row) =>
          row.roles.length === 2 && row.identityReviewedBy === 'Prüferin' && row.state === 'VALID',
      ),
    ).toBe(true);
    expect(result.rows.every((row) => row.approvedBy === '' && row.checkStatus === 'DRAFT')).toBe(
      true,
    );
  });

  it('keeps missing people and evidence explicit, without inventing an ID or approval', async () => {
    const source = client('a', '00123');
    source.gwgChecks[0]!.representatives = [];
    source.gwgChecks[0]!.beneficialOwners = [];
    const tx = database([source]);
    const result = await loadGwgControlListTx(tx as never, session, filters, now);
    expect(result.rows).toEqual([
      expect.objectContaining({
        personName: 'Keine Person erfasst',
        missingPerson: true,
        state: 'MISSING',
        number: '',
        identityReviewedBy: '',
        anchorId: null,
      }),
    ]);
    expect(tx.gwgPersonLink.findMany).not.toHaveBeenCalled();
    expect(result.people).toEqual([]);
  });

  it('shows both conflicting values in one set and does not present it as checked', async () => {
    const source = client('a', '00123');
    source.gwgChecks[0]!.idDocuments.push({
      ...source.gwgChecks[0]!.idDocuments[0]!,
      id: 'back',
      number: '00999',
    });
    const result = await loadGwgControlListTx(database([source]) as never, session, filters, now);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ number: '00123 / 00999', state: 'UNCHECKED' });
  });

  it('does not let an absent endpoint bridge the visible rows even if a repository returns a stray edge', async () => {
    const tx = database();
    tx.gwgPersonLink.findMany.mockResolvedValue([
      { id: 'ax', fromAnchorId: 'anchor-a', toAnchorId: 'hidden' },
      { id: 'xb', fromAnchorId: 'hidden', toAnchorId: 'anchor-b' },
    ]);
    const result = await loadGwgControlListTx(tx as never, session, filters, now);
    expect(new Set(result.rows.map((row) => row.groupId)).size).toBe(2);
    expect(JSON.stringify(result.rows)).not.toContain('hidden');
    expect(result.links).toEqual([]);
  });

  it('fails before evidence or graph projection if the client bound is exceeded', async () => {
    const tx = database(Array.from({ length: 10_001 }, () => client('a', '00123')));
    await expect(loadGwgControlListTx(tx as never, session, filters, now)).rejects.toBeInstanceOf(
      GwgControlListTooLargeError,
    );
    expect(tx.staffUser.findMany).not.toHaveBeenCalled();
    expect(tx.gwgPersonLink.findMany).not.toHaveBeenCalled();
  });
});
