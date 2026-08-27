export type PersonIdentityEvidenceStatus =
  | 'bestaetigt'
  | 'mehrfach'
  | 'abgelaufen'
  | 'offen'
  | 'fehlt';

interface EvidenceWithSupersession {
  /** Während eines Rolling Deployments kann ein alter Prozess das neue Feld
   * noch nicht projizieren. Fehlend und NULL bedeuten deshalb beide „aktiv“. */
  supersededAt?: Date | string | null;
}

interface IdentityStatusGroup {
  documents: Array<{
    expiryDate: string | null;
    identityAssignmentConfirmedAt: string | null;
  }>;
}

export function isSupersededEvidence(evidence: EvidenceWithSupersession): boolean {
  return evidence.supersededAt !== null && evidence.supersededAt !== undefined;
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Reiner Anzeigestatus. Die eigentliche Freigabeentscheidung bleibt im
 * serverseitigen GwG-Gate; hier wird insbesondere „abgelaufen“ nicht als
 * „fehlt“ verschleiert (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export function personIdentityEvidenceStatus(
  groups: IdentityStatusGroup[],
  now: Date = new Date(),
): PersonIdentityEvidenceStatus {
  if (groups.length === 0) return 'fehlt';
  if (groups.length > 1) return 'mehrfach';

  const today = utcDateKey(now);
  const validGroups = groups.filter(
    (group) =>
      group.documents.length > 0 &&
      group.documents.every(
        (document) => document.expiryDate !== null && document.expiryDate >= today,
      ),
  );
  if (
    validGroups.some((group) =>
      group.documents.every((document) => document.identityAssignmentConfirmedAt !== null),
    )
  ) {
    return 'bestaetigt';
  }

  const allGroupsExpired = groups.every(
    (group) =>
      group.documents.length > 0 &&
      group.documents.every(
        (document) => document.expiryDate !== null && document.expiryDate < today,
      ),
  );
  return allGroupsExpired ? 'abgelaufen' : 'offen';
}
