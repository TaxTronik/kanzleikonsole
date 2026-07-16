export interface IdentitySubjectSource {
  clientId: string;
  clientName: string;
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES';
  representatives: Array<{
    id: string;
    fullName: string;
    position: number;
    linkedBeneficialOwnerId?: string | null;
  }>;
  beneficialOwners: Array<{ id: string; fullName: string; birthDate: Date | string | null }>;
}

export type IdentitySubjectKind = 'NATURAL_CLIENT' | 'REPRESENTATIVE' | 'BENEFICIAL_OWNER';

export interface IdentitySubjectOption {
  key: string;
  id: string;
  kind: IdentitySubjectKind;
  name: string;
  roles: Array<'MANDANT' | 'VERTRETUNGSBERECHTIGT' | 'WIRTSCHAFTLICH_BERECHTIGT'>;
  position?: number;
  birthDateLabel?: string;
  linkedBeneficialOwnerId?: string;
  linkedRepresentativeId?: string;
}

export interface PersistedIdentityAssignment {
  naturalClientSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
}

export function identitySubjectRoleLabel(option: IdentitySubjectOption): string {
  return option.roles
    .map((role) => {
      if (role === 'MANDANT') return 'Mandant';
      if (role === 'WIRTSCHAFTLICH_BERECHTIGT') {
        return [
          'wirtschaftlich berechtigt',
          option.birthDateLabel ? `geb. ${option.birthDateLabel}` : null,
          option.position === undefined ? null : `Eintrag ${option.position + 1}`,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      return option.position === undefined
        ? 'vertretungsberechtigt'
        : `vertretungsberechtigt · Eintrag ${option.position + 1}`;
    })
    .join(', ');
}

function cleanName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function formatBirthDate(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Liefert nur persistierte Personen-UUIDs aus dem aktuellen GwG-Snapshot.
 * Namen werden absichtlich weder als Schluessel verwendet noch dedupliziert:
 * zwei gleichnamige Vertreter bleiben zwei eindeutig auswaehlbare Personen.
 * Bei natuerlichen Mandanten ist ausschliesslich der Mandant selbst zulaessig.
 */
export function identitySubjectOptions(source: IdentitySubjectSource): IdentitySubjectOption[] {
  if (source.clientKind === 'NATPERS') {
    const name = cleanName(source.clientName);
    return name
      ? [
          {
            key: `client:${source.clientId}`,
            id: source.clientId,
            kind: 'NATURAL_CLIENT',
            name,
            roles: ['MANDANT'],
          },
        ]
      : [];
  }

  const representatives = [...source.representatives]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .flatMap((representative): IdentitySubjectOption[] => {
      const name = cleanName(representative.fullName);
      const linkedOwner = representative.linkedBeneficialOwnerId
        ? source.beneficialOwners.find(
            (owner) => owner.id === representative.linkedBeneficialOwnerId,
          )
        : null;
      return name
        ? [
            {
              key: `representative:${representative.id}`,
              id: representative.id,
              kind: 'REPRESENTATIVE',
              name,
              roles: linkedOwner
                ? ['VERTRETUNGSBERECHTIGT', 'WIRTSCHAFTLICH_BERECHTIGT']
                : ['VERTRETUNGSBERECHTIGT'],
              position: representative.position,
              birthDateLabel: linkedOwner ? formatBirthDate(linkedOwner.birthDate) : undefined,
              linkedBeneficialOwnerId: linkedOwner?.id,
            },
          ]
        : [];
    });
  const owners = source.beneficialOwners.flatMap((owner, position): IdentitySubjectOption[] => {
    const name = cleanName(owner.fullName);
    const linkedRepresentative = source.representatives.find(
      (representative) => representative.linkedBeneficialOwnerId === owner.id,
    );
    return name
      ? [
          {
            key: `owner:${owner.id}`,
            id: owner.id,
            kind: 'BENEFICIAL_OWNER',
            name,
            roles: ['WIRTSCHAFTLICH_BERECHTIGT'],
            position,
            birthDateLabel: formatBirthDate(owner.birthDate),
            linkedRepresentativeId: linkedRepresentative?.id,
          },
        ]
      : [];
  });
  return [...representatives, ...owners];
}

/**
 * Für eine ausdrücklich verknüpfte Doppelrolle erscheint genau eine Auswahl:
 * der Vertreter-Datensatz, weil das Verify-Gate diesen Rollenbezug benötigt.
 * Die Owner-Option bleibt intern verfügbar, damit lokale Rollenänderungen ohne
 * Seitenreload neu abgeleitet werden können.
 */
export function selectableIdentitySubjectOptions(
  options: IdentitySubjectOption[],
): IdentitySubjectOption[] {
  return options.filter(
    (option) => !(option.kind === 'BENEFICIAL_OWNER' && option.linkedRepresentativeId),
  );
}

/** Loest einen Browserwert ausschliesslich gegen den aktuellen DB-Snapshot auf. */
export function resolveIdentitySubject(
  source: IdentitySubjectSource,
  subjectKey: string,
): IdentitySubjectOption | null {
  return (
    selectableIdentitySubjectOptions(identitySubjectOptions(source)).find(
      (option) => option.key === subjectKey,
    ) ?? null
  );
}

export function identityAssignmentForSubject(
  subject: IdentitySubjectOption,
): PersistedIdentityAssignment {
  return {
    naturalClientSubjectId: subject.kind === 'NATURAL_CLIENT' ? subject.id : null,
    beneficialOwnerSubjectId: subject.kind === 'BENEFICIAL_OWNER' ? subject.id : null,
    representativeSubjectId: subject.kind === 'REPRESENTATIVE' ? subject.id : null,
  };
}

export function subjectKeyForAssignment(assignment: PersistedIdentityAssignment): string | null {
  if (assignment.naturalClientSubjectId) return `client:${assignment.naturalClientSubjectId}`;
  if (assignment.representativeSubjectId) {
    return `representative:${assignment.representativeSubjectId}`;
  }
  if (assignment.beneficialOwnerSubjectId) return `owner:${assignment.beneficialOwnerSubjectId}`;
  return null;
}
