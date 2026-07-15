export interface VerificationDocument {
  gwgCheckId: string;
  documentSetId: string;
  type: string;
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  verifiedAt: Date | null;
  naturalClientSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
  identityAssignmentConfirmedAt: Date | null;
  identityAssignmentConfirmedBy: string | null;
  documentId: string | null;
  document: {
    clientId: string | null;
    classification: string;
    deletedAt: Date | null;
    gwgDestructionRequestedAt: Date | null;
    gwgDestroyedAt: Date | null;
    /** Neueste persistierte Version (Queries sortieren versionNo DESC, take 1). */
    versions: Array<{ scanStatus: string; scanCompletedAt: Date | null }>;
  } | null;
}

export interface GwgVerificationSnapshot {
  checkId: string;
  clientId: string;
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES';
  legalForm: string | null;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  representatives: Array<{ id: string; gwgCheckId: string; fullName: string; position: number }>;
  ownershipStructureNotes: string | null;
  beneficialOwners: Array<{
    fullName: string;
    birthDate: Date | null;
    birthPlace: string | null;
    residence: string | null;
    nationality: string | null;
  }>;
  idDocuments: VerificationDocument[];
}

function startOfUtcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function hasAttachedEvidence(doc: VerificationDocument, clientId: string): boolean {
  return Boolean(
    doc.documentId &&
    doc.document &&
    doc.document.clientId === clientId &&
    doc.document.classification === 'GWG_EVIDENCE' &&
    doc.document.deletedAt === null &&
    doc.document.gwgDestructionRequestedAt === null &&
    doc.document.gwgDestroyedAt === null &&
    doc.document.versions.length === 1 &&
    doc.document.versions[0]?.scanStatus === 'CLEAN' &&
    doc.document.versions[0].scanCompletedAt !== null,
  );
}

interface ValidPersonalIdSet {
  naturalClientSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
}

function personalIdSets(
  documents: VerificationDocument[],
  clientId: string,
  now: Date,
): ValidPersonalIdSet[] {
  const groups = new Map<string, VerificationDocument[]>();
  for (const document of documents) {
    if (document.type !== 'PERSONALAUSWEIS' && document.type !== 'REISEPASS') continue;
    const group = groups.get(document.documentSetId) ?? [];
    group.push(document);
    groups.set(document.documentSetId, group);
  }

  const valid: ValidPersonalIdSet[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const sameSet = group.every(
      (entry) =>
        entry.gwgCheckId === first.gwgCheckId &&
        entry.type === first.type &&
        entry.number === first.number &&
        entry.issuedBy === first.issuedBy &&
        entry.issueDate?.getTime() === first.issueDate?.getTime() &&
        entry.expiryDate?.getTime() === first.expiryDate?.getTime() &&
        entry.naturalClientSubjectId === first.naturalClientSubjectId &&
        entry.beneficialOwnerSubjectId === first.beneficialOwnerSubjectId &&
        entry.representativeSubjectId === first.representativeSubjectId,
    );
    const subjectCount = [
      first.naturalClientSubjectId,
      first.beneficialOwnerSubjectId,
      first.representativeSubjectId,
    ].filter(Boolean).length;
    const documentIds = group.map((entry) => entry.documentId).filter(Boolean);
    const uniqueDocuments = new Set(documentIds).size === documentIds.length;
    const completeAndAvailable = group.every(
      (entry) =>
        entry.verifiedAt !== null &&
        entry.identityAssignmentConfirmedAt !== null &&
        entry.identityAssignmentConfirmedBy !== null &&
        Boolean(entry.number?.trim()) &&
        Boolean(entry.issuedBy?.trim()) &&
        entry.issueDate !== null &&
        entry.expiryDate !== null &&
        startOfUtcDay(entry.expiryDate) >= startOfUtcDay(now) &&
        hasAttachedEvidence(entry, clientId),
    );
    if (sameSet && uniqueDocuments && subjectCount === 1 && completeAndAvailable) {
      valid.push({
        naturalClientSubjectId: first.naturalClientSubjectId,
        beneficialOwnerSubjectId: first.beneficialOwnerSubjectId,
        representativeSubjectId: first.representativeSubjectId,
      });
    }
  }
  return valid;
}

/**
 * Fachliche Mindestanforderungen vor Uebergabe und Entscheidung. Identitaeten
 * werden ausschliesslich ueber bestaetigte Fremdschluessel bewertet; ownerName
 * ist nur ein historischer Anzeigesnapshot und nie ein Berechtigungskriterium.
 */
export function gwgVerificationErrors(
  snapshot: GwgVerificationSnapshot,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  const personalIds = personalIdSets(snapshot.idDocuments, snapshot.clientId, now);

  if (snapshot.clientKind === 'NATPERS') {
    if (!personalIds.some((set) => set.naturalClientSubjectId === snapshot.clientId)) {
      errors.push(
        'Fuer die natuerliche Person ist ein gueltiger, explizit diesem Mandanten zugeordneter und bestaetigter Personalausweis/Reisepass erforderlich (\u00a7\u00a7 8, 12 GwG).',
      );
    }
    return errors;
  }

  if (snapshot.beneficialOwners.length < 1) {
    errors.push(
      'Mindestens ein wirtschaftlich Berechtigter (gegebenenfalls fiktiv wirtschaftlich Berechtigter) ist zu erfassen.',
    );
  }
  snapshot.beneficialOwners.forEach((owner, index) => {
    const missing: string[] = [];
    if (!owner.fullName.trim()) missing.push('Name');
    if (!owner.birthDate) missing.push('Geburtsdatum');
    if (!owner.birthPlace?.trim()) missing.push('Geburtsort');
    if (!owner.residence?.trim()) missing.push('Wohnsitz');
    if (!owner.nationality?.trim()) missing.push('Staatsangehoerigkeit');
    if (missing.length > 0) {
      errors.push(
        `Wirtschaftlich Berechtigter ${index + 1}: ${missing.join(', ')} ${missing.length === 1 ? 'fehlt' : 'fehlen'} (\u00a7 11 Abs. 5 GwG).`,
      );
    }
  });
  if (!snapshot.legalForm?.trim()) {
    errors.push('Rechtsform des Rechtstraegers fehlt (\u00a7 11 Abs. 4 Nr. 2 GwG).');
  }
  if (!snapshot.noRegisterEntry) {
    if (!snapshot.registerNumber?.trim()) {
      errors.push(
        'Registernummer fehlt; alternativ muss "kein Registereintrag vorhanden" dokumentiert werden.',
      );
    }
    if (!snapshot.registerAuthority?.trim()) {
      errors.push('Register/Registergericht fehlt (\u00a7 11 Abs. 4 Nr. 2 GwG).');
    }
  }
  if (snapshot.representatives.length === 0) {
    errors.push(
      'Mindestens ein Mitglied des Vertretungsorgans/gesetzlicher Vertreter ist zu erfassen.',
    );
  }
  if (!snapshot.ownershipStructureNotes?.trim()) {
    errors.push(
      'Die Eigentums- und Kontrollstruktur sowie die Ermittlung des wirtschaftlich Berechtigten sind zu dokumentieren.',
    );
  }

  const entityEvidence = snapshot.idDocuments.some(
    (document) =>
      (snapshot.noRegisterEntry
        ? document.type === 'GESELLSCHAFTSVERTRAG'
        : document.type === 'HANDELSREGISTERAUSZUG' || document.type === 'GESELLSCHAFTSVERTRAG') &&
      hasAttachedEvidence(document, snapshot.clientId),
  );
  if (!entityEvidence) {
    errors.push(
      snapshot.noRegisterEntry
        ? 'Bei fehlender Registerpflicht ist ein Gesellschaftsvertrag oder gleichwertiges Gruendungsdokument mit Datei erforderlich (\u00a7 12 Abs. 2 GwG).'
        : 'Registerauszug oder beweiskraeftiges Gruendungsdokument mit Datei ist erforderlich (\u00a7 12 Abs. 2 GwG).',
    );
  }

  const transparencyEvidence =
    snapshot.noRegisterEntry ||
    snapshot.idDocuments.some(
      (document) =>
        document.type === 'TRANSPARENZREGISTER_AUSZUG' &&
        hasAttachedEvidence(document, snapshot.clientId),
    );
  if (!transparencyEvidence) {
    errors.push(
      'Nachweis/Auszug aus dem Transparenzregister ist fuer den eingetragenen Rechtstraeger erforderlich (\u00a7 12 Abs. 3 GwG).',
    );
  }

  const representativeIds = new Set(
    snapshot.representatives
      .filter((representative) => representative.gwgCheckId === snapshot.checkId)
      .map((representative) => representative.id),
  );
  if (
    !personalIds.some(
      (set) =>
        set.representativeSubjectId !== null && representativeIds.has(set.representativeSubjectId),
    )
  ) {
    errors.push(
      'Mindestens eine auftretende vertretungsberechtigte Person muss mit gueltigem Ausweis explizit zugeordnet und bestaetigt sein.',
    );
  }

  return errors;
}
