import type { TxClient } from '@taxtronik/db';
import type { GwgBeneficialOwner, GwgRepresentative, GwgCheck } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import {
  CONTROL_ROW_LIMIT,
  evidenceState,
  filterControlRows,
  groupVisibleControlRows,
  type ControlFilters,
  type ControlRow,
  type VisiblePersonLink,
} from './control-list-model';

export class GwgControlListTooLargeError extends Error {
  constructor() {
    super(
      'Die Kontrollliste überschreitet 10.000 Detailzeilen. Bitte einen Mandanten auswählen. Es wurde kein unvollständiger Export erstellt.',
    );
  }
}
const date = (value: Date | null | undefined) => value?.toISOString().slice(0, 10) ?? '';
const joined = (values: Array<string | null>) => [...new Set(values.filter(Boolean))].join(' / ');

interface ControlPerson {
  id: string;
  name: string;
  birthDate: Date | null;
  anchorId: string | null;
  roles: string[];
  ownerId: string | null;
  representativeId: string | null;
}

function controlCheckFields(
  client: {
    id: string;
    name: string;
    datevNo: string | null;
    gwgChecks: Array<Pick<GwgCheck, 'id' | 'status' | 'verifiedBy' | 'verifiedAt'>>;
  },
  names: ReadonlyMap<string, string>,
) {
  const check = client.gwgChecks[0];
  return {
    clientId: client.id,
    clientName: client.name,
    datevNo: client.datevNo ?? '',
    checkId: check?.id ?? null,
    checkStatus: check?.status ?? 'KEINE_PRÜFUNG',
    approvedBy: check?.verifiedBy ? (names.get(check.verifiedBy) ?? 'Unbekannter Mitarbeiter') : '',
    approvedAt: date(check?.verifiedAt),
    groupId: '',
  };
}

/** Collapse only an explicit local double role, never people with similar names. */
function controlPeople(client: {
  id: string;
  name: string;
  kind: string;
  gwgNaturalPersonAnchor: { id: string } | null;
  gwgChecks: Array<{
    representatives: GwgRepresentative[];
    beneficialOwners: GwgBeneficialOwner[];
  }>;
}): ControlPerson[] {
  if (client.kind === 'NATPERS')
    return [
      {
        id: client.id,
        name: client.name,
        birthDate: null,
        anchorId: client.gwgNaturalPersonAnchor?.id ?? null,
        roles: ['Mandant'],
        ownerId: null,
        representativeId: null,
      },
    ];
  const check = client.gwgChecks[0];
  const representatives = check?.representatives ?? [];
  const owners = check?.beneficialOwners ?? [];
  const people: ControlPerson[] = representatives.map((rep) => {
    const owner = owners.find((owner) => owner.id === rep.linkedBeneficialOwnerId);
    return {
      id: rep.id,
      name: owner?.fullName ?? rep.fullName,
      birthDate: owner?.birthDate ?? rep.birthDate,
      anchorId: rep.personAnchorId ?? owner?.personAnchorId ?? null,
      roles: owner ? ['Vertreter', 'Wirtschaftlich berechtigt'] : ['Vertreter'],
      ownerId: owner?.id ?? null,
      representativeId: rep.id,
    };
  });
  for (const owner of owners) {
    if (representatives.some((rep) => rep.linkedBeneficialOwnerId === owner.id)) continue;
    people.push({
      id: owner.id,
      name: owner.fullName,
      birthDate: owner.birthDate,
      anchorId: owner.personAnchorId,
      roles: ['Wirtschaftlich berechtigt'],
      ownerId: owner.id,
      representativeId: null,
    });
  }
  return people.length
    ? people
    : [
        {
          id: `missing-${client.id}`,
          name: 'Keine Person erfasst',
          birthDate: null,
          anchorId: null,
          roles: [],
          ownerId: null,
          representativeId: null,
        },
      ];
}

/** GWG-CONTROL-EXPORT-001: a current working list, not a full compliance dossier. */
export async function loadGwgControlListTx(
  tx: TxClient,
  session: StaffSession,
  filters: ControlFilters,
  now = new Date(),
) {
  const access = await accessibleClientsWhereFor(tx, session);
  const clients = await tx.client.findMany({
    where: {
      AND: [
        access,
        { anonymizedAt: null },
        ...(filters.clientId ? [{ id: filters.clientId }] : []),
      ],
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: CONTROL_ROW_LIMIT + 1,
    select: {
      id: true,
      name: true,
      datevNo: true,
      kind: true,
      gwgNaturalPersonAnchor: { select: { id: true } },
      gwgChecks: {
        where: { destroyedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        include: {
          beneficialOwners: true,
          representatives: true,
          idDocuments: {
            where: { supersededAt: null, type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] } },
            include: {
              document: {
                select: {
                  clientId: true,
                  classification: true,
                  deletedAt: true,
                  gwgDestroyedAt: true,
                  gwgDestructionRequestedAt: true,
                  versions: {
                    orderBy: { versionNo: 'desc' },
                    take: 1,
                    select: { id: true, scanStatus: true, scanCompletedAt: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (clients.length > CONTROL_ROW_LIMIT) throw new GwgControlListTooLargeError();
  const staffIds = [
    ...new Set(
      clients.flatMap((client) =>
        client.gwgChecks.flatMap((check) => [
          check.verifiedBy,
          ...check.idDocuments.map((doc) => doc.identityAssignmentConfirmedBy),
        ]),
      ),
    ),
  ].filter((id): id is string => Boolean(id));
  const staff = staffIds.length
    ? await tx.staffUser.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, fullName: true },
      })
    : [];
  const names = new Map(staff.map((person) => [person.id, person.fullName]));
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now);
  const rows: ControlRow[] = [];
  for (const client of clients) {
    const check = client.gwgChecks[0];
    const base = controlCheckFields(client, names);
    for (const person of controlPeople(client)) {
      const documents = (check?.idDocuments ?? []).filter((doc) =>
        client.kind === 'NATPERS'
          ? doc.naturalClientSubjectId === client.id
          : (person.ownerId !== null && doc.beneficialOwnerSubjectId === person.ownerId) ||
            (person.representativeId !== null &&
              doc.representativeSubjectId === person.representativeId),
      );
      const sets = [...new Set(documents.map((doc) => doc.documentSetId))];
      for (const setId of sets.length ? sets : [null]) {
        const files = documents.filter((doc) => doc.documentSetId === setId);
        rows.push({
          ...base,
          rowId: `${client.id}:${person.id}:${setId ?? 'missing'}`,
          anchorId: person.anchorId,
          personName: person.name,
          birthDate: date(person.birthDate),
          roles: person.roles,
          documentSetId: setId,
          documentType: joined(files.map((file) => file.type)),
          number: joined(files.map((file) => file.number)),
          expiryDate: joined(files.map((file) => date(file.expiryDate))),
          identityReviewedBy: joined(
            files.map((file) =>
              file.identityAssignmentConfirmedBy
                ? (names.get(file.identityAssignmentConfirmedBy) ?? 'Unbekannter Mitarbeiter')
                : '',
            ),
          ),
          identityReviewedAt: joined(files.map((file) => date(file.identityAssignmentConfirmedAt))),
          state: evidenceState(files, client.id, today, sets.length > 1),
          missingPerson: person.roles.length === 0,
        });
        if (rows.length > CONTROL_ROW_LIMIT) throw new GwgControlListTooLargeError();
      }
    }
  }
  // Both endpoints are taken exclusively from the authorized current rows.
  const ids = [...new Set(rows.flatMap((row) => (row.anchorId ? [row.anchorId] : [])))];
  const foundLinks: VisiblePersonLink[] = ids.length
    ? await tx.gwgPersonLink.findMany({
        where: { fromAnchorId: { in: ids }, toAnchorId: { in: ids } },
        select: { id: true, fromAnchorId: true, toAnchorId: true },
      })
    : [];
  const visibleIds = new Set(ids);
  const links = foundLinks.filter(
    (link) => visibleIds.has(link.fromAnchorId) && visibleIds.has(link.toAnchorId),
  );
  return {
    rows: filterControlRows(groupVisibleControlRows(rows, links), filters),
    links,
    people: [
      ...new Map(
        rows
          .filter((row) => row.anchorId)
          .map((row) => [
            row.anchorId!,
            {
              id: row.anchorId!,
              name: row.personName,
              clientId: row.clientId,
              clientName: row.clientName,
            },
          ]),
      ).values(),
    ],
  };
}
