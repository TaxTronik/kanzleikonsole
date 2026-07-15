export interface IdentitySubjectSource {
  clientId: string;
  clientName: string;
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES';
  representatives: Array<{ id: string; fullName: string; position: number }>;
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
      return name
        ? [
            {
              key: `representative:${representative.id}`,
              id: representative.id,
              kind: 'REPRESENTATIVE',
              name,
              roles: ['VERTRETUNGSBERECHTIGT'],
              position: representative.position,
            },
          ]
        : [];
    });
  const owners = source.beneficialOwners.flatMap((owner, position): IdentitySubjectOption[] => {
    const name = cleanName(owner.fullName);
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
          },
        ]
      : [];
  });
  return [...representatives, ...owners];
}

/** Loest einen Browserwert ausschliesslich gegen den aktuellen DB-Snapshot auf. */
export function resolveIdentitySubject(
  source: IdentitySubjectSource,
  subjectKey: string,
): IdentitySubjectOption | null {
  return identitySubjectOptions(source).find((option) => option.key === subjectKey) ?? null;
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
