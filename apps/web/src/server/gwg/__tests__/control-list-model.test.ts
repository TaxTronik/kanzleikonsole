import { describe, expect, it } from 'vitest';
// Fachkatalog: GWG-PERSON-LINKS-001
// Fachkatalog: GWG-CONTROL-EXPORT-001
import {
  canonicalPersonPair,
  evidenceState,
  filterControlRows,
  groupVisibleControlRows,
  type ControlEvidence,
  type ControlRow,
} from '../control-list-model';
export const row = (anchorId: string, overrides: Partial<ControlRow> = {}): ControlRow => ({
  rowId: anchorId,
  groupId: '',
  anchorId,
  clientId: `client-${anchorId}`,
  clientName: `Firma ${anchorId}`,
  datevNo: '00012',
  checkId: 'check',
  checkStatus: 'DRAFT',
  personName: 'Erika Beispiel',
  birthDate: '1980-01-02',
  roles: ['Vertreter'],
  documentSetId: 'set',
  documentType: 'PERSONALAUSWEIS',
  number: '00123456',
  expiryDate: '2030-01-01',
  identityReviewedBy: 'Prüfer',
  identityReviewedAt: '2026-08-31',
  approvedBy: '',
  approvedAt: '',
  state: 'VALID',
  missingPerson: false,
  ...overrides,
});
describe('GWG-PERSON-LINKS-001 visible person graph', () => {
  it('groups only explicitly linked people and keeps independent mandate details', () => {
    const rows = groupVisibleControlRows(
      [row('a'), row('b', { number: '999' }), row('c')],
      [{ id: 'ab', fromAnchorId: 'a', toAnchorId: 'b' }],
    );
    expect(rows[0]!.groupId).toBe(rows[1]!.groupId);
    expect(rows[2]!.groupId).not.toBe(rows[0]!.groupId);
    expect(rows.map((value) => value.number)).toEqual(['00123456', '999', '00123456']);
  });
  it('does not use a hidden person as a bridge or count its existence', () => {
    const rows = groupVisibleControlRows(
      [row('a'), row('c')],
      [
        { id: 'ab', fromAnchorId: 'a', toAnchorId: 'hidden' },
        { id: 'bc', fromAnchorId: 'hidden', toAnchorId: 'c' },
      ],
    );
    expect(rows[0]!.groupId).not.toBe(rows[1]!.groupId);
    expect(rows).toHaveLength(2);
  });
  it('handles cycles, reversed edges and two sets of one local person deterministically', () => {
    const rows = groupVisibleControlRows(
      [row('b'), row('a'), row('a', { rowId: 'second-set' })],
      [
        { id: 'ba', fromAnchorId: 'b', toAnchorId: 'a' },
        { id: 'ab', fromAnchorId: 'a', toAnchorId: 'b' },
      ],
    );
    expect(new Set(rows.map((value) => value.groupId)).size).toBe(1);
    expect(canonicalPersonPair('b', 'a')).toEqual(['a', 'b']);
    expect(() => canonicalPersonPair('a', 'a')).toThrow();
  });
  it('filters open states and text without matching confidential identifiers', () => {
    expect(
      filterControlRows([row('a'), row('b', { state: 'MISSING' })], {
        query: 'erika',
        state: 'OPEN',
        clientId: '',
      }).map((value) => value.anchorId),
    ).toEqual(['b']);
  });
});
describe('GWG-CONTROL-EXPORT-001 evidence states', () => {
  const evidence = (): ControlEvidence => ({
    id: 'doc',
    documentSetId: 'set',
    type: 'PERSONALAUSWEIS',
    naturalClientSubjectId: 'client',
    representativeSubjectId: null,
    beneficialOwnerSubjectId: null,
    number: '0012345',
    issuedBy: 'Stadt',
    issueDate: new Date('2020-01-01'),
    expiryDate: new Date('2026-08-31'),
    verifiedAt: new Date(),
    identityAssignmentConfirmedAt: new Date(),
    identityAssignmentConfirmedBy: 'staff',
    document: {
      clientId: 'client',
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      gwgDestroyedAt: null,
      gwgDestructionRequestedAt: null,
      versions: [{ scanStatus: 'CLEAN', scanCompletedAt: new Date() }],
    },
  });
  it('keeps missing, expired, unreviewed, unavailable and multiple states separate', () => {
    expect(evidenceState([], 'client', '2026-08-31', false)).toBe('MISSING');
    expect(evidenceState([evidence()], 'client', '2026-08-31', false)).toBe('VALID');
    expect(evidenceState([evidence()], 'client', '2026-09-01', false)).toBe('EXPIRED');
    expect(
      evidenceState([{ ...evidence(), verifiedAt: null }], 'client', '2026-08-31', false),
    ).toBe('UNCHECKED');
    expect(evidenceState([{ ...evidence(), document: null }], 'client', '2026-08-31', false)).toBe(
      'UNAVAILABLE',
    );
    expect(evidenceState([evidence()], 'other-client', '2026-08-31', false)).toBe('UNAVAILABLE');
    expect(evidenceState([evidence()], 'client', '2026-08-31', true)).toBe('MULTIPLE');
  });
  it('does not report inconsistent front and back metadata as checked', () => {
    expect(
      evidenceState(
        [evidence(), { ...evidence(), number: 'other' }],
        'client',
        '2026-08-31',
        false,
      ),
    ).toBe('UNCHECKED');
  });
  it('does not reuse a confirmed crop on a different source version', () => {
    const file = evidence();
    file.viewports = [
      {
        side: 'front',
        versionId: '11111111-1111-4111-8111-111111111111',
        page: 1,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
      },
    ];
    file.document!.versions[0]!.id = '22222222-2222-4222-8222-222222222222';
    expect(evidenceState([file], 'client', '2026-08-31', false)).toBe('UNAVAILABLE');
    file.document!.versions[0]!.id = '11111111-1111-4111-8111-111111111111';
    expect(evidenceState([file], 'client', '2026-08-31', false)).toBe('VALID');
  });
});
