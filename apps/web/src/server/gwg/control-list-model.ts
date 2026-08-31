// GWG-PERSON-LINKS-001 / GWG-CONTROL-EXPORT-001: no shared personal data.
import { IdentityViewportsSchema } from '@/lib/gwg/identity-viewport';

export const CONTROL_ROW_LIMIT = 10_000;
export const CONTROL_STATES = [
  'ALL',
  'OPEN',
  'MISSING',
  'EXPIRED',
  'UNCHECKED',
  'UNAVAILABLE',
  'MULTIPLE',
  'VALID',
] as const;
export type ControlState = Exclude<(typeof CONTROL_STATES)[number], 'ALL' | 'OPEN'>;
export const CONTROL_STATE_LABELS: Record<ControlState, string> = {
  MISSING: 'Nachweis fehlt',
  EXPIRED: 'Ausweis abgelaufen',
  UNCHECKED: 'Nicht vollständig geprüft',
  UNAVAILABLE: 'Datei nicht verfügbar',
  MULTIPLE: 'Mehrere aktive Ausweissätze',
  VALID: 'Ausweis geprüft',
};
export interface ControlFilters {
  query: string;
  state: (typeof CONTROL_STATES)[number];
  clientId: string;
}
export function controlFilters(
  input: Record<string, string | string[] | undefined>,
): ControlFilters {
  const one = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  const state = one('state');
  return {
    query: one('q').trim().slice(0, 150),
    state: CONTROL_STATES.includes(state as never) ? (state as ControlFilters['state']) : 'ALL',
    clientId: /^[a-f\d-]{36}$/i.test(one('clientId')) ? one('clientId') : '',
  };
}
export interface ControlRow {
  rowId: string;
  groupId: string;
  anchorId: string | null;
  clientId: string;
  clientName: string;
  datevNo: string;
  checkId: string | null;
  checkStatus: string;
  personName: string;
  birthDate: string;
  roles: string[];
  documentSetId: string | null;
  documentType: string;
  number: string;
  expiryDate: string;
  identityReviewedBy: string;
  identityReviewedAt: string;
  approvedBy: string;
  approvedAt: string;
  state: ControlState;
  missingPerson: boolean;
}
export interface VisiblePersonLink {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
}

/** The callers pass authorized rows, and this helper rejects edges to every
 * absent endpoint as an additional boundary. Hidden vertices never bridge groups. */
export function groupVisibleControlRows(
  rows: ControlRow[],
  links: readonly VisiblePersonLink[],
): ControlRow[] {
  const parents = new Map(
    rows.flatMap((row) => (row.anchorId ? [[row.anchorId, row.anchorId] as const] : [])),
  );
  const find = (id: string): string => {
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root)!;
    let node = id;
    while (node !== root) {
      const next = parents.get(node)!;
      parents.set(node, root);
      node = next;
    }
    return root;
  };
  for (const link of links) {
    if (!parents.has(link.fromAnchorId) || !parents.has(link.toAnchorId)) continue;
    const [left, right] = [find(link.fromAnchorId), find(link.toAnchorId)].sort();
    parents.set(right!, left!);
  }
  const roots = [
    ...new Set(rows.map((row) => (row.anchorId ? find(row.anchorId) : row.rowId))),
  ].sort();
  const ids = new Map(roots.map((root, index) => [root, `P${String(index + 1).padStart(5, '0')}`]));
  return rows.map((row) => ({
    ...row,
    groupId: ids.get(row.anchorId ? find(row.anchorId) : row.rowId)!,
  }));
}

export function filterControlRows(rows: ControlRow[], filters: ControlFilters): ControlRow[] {
  const query = filters.query.toLocaleLowerCase('de-DE');
  return rows.filter(
    (row) =>
      (!filters.clientId || row.clientId === filters.clientId) &&
      (filters.state === 'ALL' ||
        (filters.state === 'OPEN' ? row.state !== 'VALID' : row.state === filters.state)) &&
      (!query ||
        `${row.personName} ${row.clientName} ${row.datevNo}`
          .toLocaleLowerCase('de-DE')
          .includes(query)),
  );
}

export interface ControlEvidence {
  id: string;
  documentSetId: string;
  type: string;
  naturalClientSubjectId: string | null;
  representativeSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  number: string | null;
  expiryDate: Date | null;
  issueDate: Date | null;
  issuedBy: string | null;
  verifiedAt: Date | null;
  identityAssignmentConfirmedAt: Date | null;
  identityAssignmentConfirmedBy: string | null;
  viewports?: unknown;
  document: {
    clientId: string | null;
    classification: string;
    deletedAt: Date | null;
    gwgDestroyedAt: Date | null;
    gwgDestructionRequestedAt: Date | null;
    versions: { id?: string; scanStatus: string; scanCompletedAt: Date | null }[];
  } | null;
}
export function evidenceState(
  files: ControlEvidence[],
  clientId: string,
  today: string,
  multiple: boolean,
): ControlState {
  if (!files.length) return 'MISSING';
  if (multiple) return 'MULTIPLE';
  if (
    files.some(
      (file) =>
        !file.document ||
        file.document.clientId !== clientId ||
        file.document.classification !== 'GWG_EVIDENCE' ||
        file.document.deletedAt ||
        file.document.gwgDestroyedAt ||
        file.document.gwgDestructionRequestedAt ||
        file.document.versions[0]?.scanStatus !== 'CLEAN' ||
        !file.document.versions[0]?.scanCompletedAt,
    )
  )
    return 'UNAVAILABLE';
  for (const file of files) {
    const views = IdentityViewportsSchema.safeParse(file.viewports ?? []);
    if (!views.success) return 'UNCHECKED';
    if (views.data.some((view) => view.versionId !== file.document?.versions[0]?.id))
      return 'UNAVAILABLE';
  }
  if (files.some((file) => file.expiryDate && file.expiryDate.toISOString().slice(0, 10) < today))
    return 'EXPIRED';
  const first = files[0]!;
  if (
    files.length > 2 ||
    files.some(
      (file) =>
        !file.number?.trim() ||
        !file.issuedBy?.trim() ||
        !file.issueDate ||
        !file.expiryDate ||
        !file.verifiedAt ||
        !file.identityAssignmentConfirmedAt ||
        !file.identityAssignmentConfirmedBy ||
        file.type !== first.type ||
        file.number !== first.number ||
        file.issuedBy !== first.issuedBy ||
        file.issueDate.toISOString() !== first.issueDate?.toISOString() ||
        file.expiryDate.toISOString() !== first.expiryDate?.toISOString() ||
        file.issueDate.toISOString().slice(0, 10) > today ||
        file.issueDate > file.expiryDate,
    )
  )
    return 'UNCHECKED';
  return 'VALID';
}

export function canonicalPersonPair(left: string, right: string): [string, string] {
  if (left === right) throw new Error('Bitte zwei unterschiedliche Personen auswählen.');
  return [left, right].sort() as [string, string];
}
