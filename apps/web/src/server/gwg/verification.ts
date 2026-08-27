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
  supersededAt?: Date | null;
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
  representatives: Array<{
    id: string;
    gwgCheckId: string;
    fullName: string;
    birthDate: Date | null;
    birthPlace: string | null;
    residence: string | null;
    nationality: string | null;
    isPep: boolean | null;
    position: number;
    linkedBeneficialOwnerId: string | null;
  }>;
  ownershipStructureNotes: string | null;
  beneficialOwners: Array<{
    fullName: string;
    birthDate: Date | null;
    birthPlace: string | null;
    residence: string | null;
    nationality: string | null;
    isPep: boolean;
  }>;
  idDocuments: VerificationDocument[];
}

export interface GwgDecisionGateSnapshot extends GwgVerificationSnapshot {
  riskScore: number | null;
  riskLevel: string | null;
  riskAnswers: unknown;
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
    if (document.supersededAt != null) continue;
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
    if (
      group.length <= 2 &&
      sameSet &&
      uniqueDocuments &&
      subjectCount === 1 &&
      completeAndAvailable
    ) {
      valid.push({
        naturalClientSubjectId: first.naturalClientSubjectId,
        beneficialOwnerSubjectId: first.beneficialOwnerSubjectId,
        representativeSubjectId: first.representativeSubjectId,
      });
    }
  }
  return valid;
}

function hasMultipleActivePersonalIdSets(documents: VerificationDocument[]): boolean {
  const setIdsBySubject = new Map<string, Set<string>>();
  for (const document of documents) {
    if (document.supersededAt != null) continue;
    if (document.type !== 'PERSONALAUSWEIS' && document.type !== 'REISEPASS') continue;
    const subjectKeys = [
      document.naturalClientSubjectId ? `client:${document.naturalClientSubjectId}` : null,
      document.beneficialOwnerSubjectId ? `owner:${document.beneficialOwnerSubjectId}` : null,
      document.representativeSubjectId
        ? `representative:${document.representativeSubjectId}`
        : null,
    ].filter((value): value is string => value !== null);
    if (subjectKeys.length !== 1) continue;
    const setIds = setIdsBySubject.get(subjectKeys[0]!) ?? new Set<string>();
    setIds.add(document.documentSetId);
    setIdsBySubject.set(subjectKeys[0]!, setIds);
  }
  return [...setIdsBySubject.values()].some((setIds) => setIds.size > 1);
}

/**
 * Fachliche Mindestanforderungen vor Übergabe und Entscheidung. Identitäten
 * werden ausschließlich über bestätigte Fremdschlüssel bewertet; ownerName
 * ist nur ein historischer Anzeigesnapshot und nie ein Berechtigungskriterium.
 */
export function gwgVerificationErrors(
  snapshot: GwgVerificationSnapshot,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  const personalIds = personalIdSets(snapshot.idDocuments, snapshot.clientId, now);
  if (hasMultipleActivePersonalIdSets(snapshot.idDocuments)) {
    errors.push(
      'Für eine Person dürfen nicht mehrere aktive Ausweissätze gleichzeitig als Prüfgrundlage geführt werden. Bitte einen aktuellen Ausweis festlegen; die übrigen Sätze müssen als alte Nachweise abgelöst werden.',
    );
  }

  if (snapshot.clientKind === 'NATPERS') {
    if (!personalIds.some((set) => set.naturalClientSubjectId === snapshot.clientId)) {
      errors.push(
        'Für die natürliche Person ist ein gültiger, explizit diesem Mandanten zugeordneter und bestätigter Personalausweis/Reisepass erforderlich (\u00a7\u00a7 8, 12 GwG).',
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
    if (!owner.nationality?.trim()) missing.push('Staatsangehörigkeit');
    if (missing.length > 0) {
      errors.push(
        `Wirtschaftlich Berechtigter ${index + 1}: ${missing.join(', ')} ${missing.length === 1 ? 'fehlt' : 'fehlen'} (\u00a7 11 Abs. 5 GwG).`,
      );
    }
  });
  if (!snapshot.legalForm?.trim()) {
    errors.push('Rechtsform des Rechtsträgers fehlt (\u00a7 11 Abs. 4 Nr. 2 GwG).');
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
  snapshot.representatives.forEach((representative, index) => {
    const missing: string[] = [];
    if (!representative.fullName.trim()) missing.push('Name');
    if (!representative.birthDate) missing.push('Geburtsdatum');
    if (!representative.birthPlace?.trim()) missing.push('Geburtsort');
    if (!representative.residence?.trim()) missing.push('Wohnsitz');
    if (!representative.nationality?.trim()) missing.push('Staatsangehörigkeit');
    if (representative.isPep == null) missing.push('PEP-Status');
    if (missing.length > 0) {
      errors.push(
        `Gesetzliche Vertretung ${index + 1}: ${missing.join(', ')} ${missing.length === 1 ? 'fehlt' : 'fehlen'}.`,
      );
    }
  });
  if (!snapshot.ownershipStructureNotes?.trim()) {
    errors.push(
      'Die Eigentums- und Kontrollstruktur sowie die Ermittlung des wirtschaftlich Berechtigten sind zu dokumentieren.',
    );
  }

  const entityEvidence = snapshot.idDocuments.some(
    (document) =>
      document.supersededAt == null &&
      (snapshot.noRegisterEntry
        ? document.type === 'GESELLSCHAFTSVERTRAG'
        : document.type === 'HANDELSREGISTERAUSZUG' || document.type === 'GESELLSCHAFTSVERTRAG') &&
      hasAttachedEvidence(document, snapshot.clientId),
  );
  if (!entityEvidence) {
    errors.push(
      snapshot.noRegisterEntry
        ? 'Bei fehlender Registerpflicht ist ein Gesellschaftsvertrag oder gleichwertiges Gründungsdokument mit Datei erforderlich (\u00a7 12 Abs. 2 GwG).'
        : 'Registerauszug oder beweiskräftiges Gründungsdokument mit Datei ist erforderlich (\u00a7 12 Abs. 2 GwG).',
    );
  }

  const transparencyEvidence =
    snapshot.noRegisterEntry ||
    snapshot.idDocuments.some(
      (document) =>
        document.supersededAt == null &&
        document.type === 'TRANSPARENZREGISTER_AUSZUG' &&
        hasAttachedEvidence(document, snapshot.clientId),
    );
  if (!transparencyEvidence) {
    errors.push(
      'Nachweis/Auszug aus dem Transparenzregister ist für den eingetragenen Rechtsträger erforderlich (\u00a7 12 Abs. 3 GwG).',
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
      'Mindestens eine auftretende vertretungsberechtigte Person muss mit gültigem Ausweis explizit zugeordnet und bestätigt sein.',
    );
  }

  return errors;
}

/**
 * Canonical fachliche Schranke for both hand-off and final approval. Keeping
 * both transitions on the same strict rule set prevents a draft accepted for
 * review from becoming impossible to approve (or vice versa) after rule
 * changes.
 */
export function gwgDecisionGateErrors(
  snapshot: GwgDecisionGateSnapshot,
  requiredRiskFactorKeys: readonly string[],
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  if (snapshot.riskScore === null || snapshot.riskLevel === null) {
    errors.push('Bitte zuerst die Risikobewertung vollständig speichern.');
  }

  const savedAnswers =
    snapshot.riskAnswers &&
    typeof snapshot.riskAnswers === 'object' &&
    !Array.isArray(snapshot.riskAnswers)
      ? (snapshot.riskAnswers as Record<string, unknown>)
      : {};
  if (requiredRiskFactorKeys.some((key) => savedAnswers[key] == null)) {
    errors.push(
      'Die Risikoanalyse ist unvollständig — bitte alle Risikofaktoren bewerten (§ 10 Abs. 2 GwG).',
    );
  }

  errors.push(...gwgVerificationErrors(snapshot, now));

  if (!snapshot.idDocuments.some((document) => document.supersededAt == null)) {
    errors.push('Mindestens ein Identitätsdokument erforderlich.');
  }
  if (snapshot.beneficialOwners.some((owner) => owner.isPep) && savedAnswers['pep'] !== 3) {
    errors.push('PEP-Fall: Der PEP-Risikofaktor muss ausdrücklich als PEP bewertet werden.');
  }
  if (snapshot.beneficialOwners.some((owner) => owner.isPep) && snapshot.riskLevel !== 'HIGH') {
    errors.push(
      'PEP-Fall: Die Risikobewertung muss HIGH ergeben (§ 15 GwG: zwingend hohes Risiko).',
    );
  }

  return [...new Set(errors)];
}
