export interface VerificationDocument {
  type: string;
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  expiryDate: Date | null;
  documentId: string | null;
  document: {
    clientId: string | null;
    classification: string;
    deletedAt: Date | null;
  } | null;
}

export interface GwgVerificationSnapshot {
  clientId: string;
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES';
  legalForm: string | null;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  ownershipStructureNotes: string | null;
  beneficialOwnerCount: number;
  idDocuments: VerificationDocument[];
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
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
    doc.document.deletedAt === null,
  );
}

function isValidPersonalId(doc: VerificationDocument, clientId: string, now: Date): boolean {
  return (
    (doc.type === 'PERSONALAUSWEIS' || doc.type === 'REISEPASS') &&
    hasAttachedEvidence(doc, clientId) &&
    Boolean(doc.number?.trim()) &&
    Boolean(doc.issuedBy?.trim()) &&
    doc.expiryDate !== null &&
    startOfUtcDay(doc.expiryDate) >= startOfUtcDay(now)
  );
}

/**
 * Fachliche Mindestanforderungen vor der Berufsträger-Entscheidung.
 * Der Helfer validiert bewusst den gespeicherten Snapshot und nicht nur
 * Formularwerte, damit direkte DB-/Action-Aufrufe denselben Gate passieren.
 */
export function gwgVerificationErrors(
  snapshot: GwgVerificationSnapshot,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  const personalIds = snapshot.idDocuments.filter((d) =>
    isValidPersonalId(d, snapshot.clientId, now),
  );

  if (snapshot.clientKind === 'NATPERS') {
    if (personalIds.length === 0) {
      errors.push(
        'Für eine natürliche Person ist ein gültiger Personalausweis/Reisepass mit Kopie, Nummer und ausstellender Behörde erforderlich (§§ 8, 12 GwG).',
      );
    }
    return errors;
  }

  if (snapshot.beneficialOwnerCount < 1) {
    errors.push(
      'Mindestens ein wirtschaftlich Berechtigter (gegebenenfalls fiktiv wirtschaftlich Berechtigter) ist zu erfassen.',
    );
  }
  if (!snapshot.legalForm?.trim()) {
    errors.push('Rechtsform des Rechtsträgers fehlt (§ 11 Abs. 4 Nr. 2 GwG).');
  }
  if (!snapshot.noRegisterEntry) {
    if (!snapshot.registerNumber?.trim()) {
      errors.push(
        'Registernummer fehlt; alternativ muss „kein Registereintrag vorhanden“ dokumentiert werden.',
      );
    }
    if (!snapshot.registerAuthority?.trim()) {
      errors.push('Register/Registergericht fehlt (§ 11 Abs. 4 Nr. 2 GwG).');
    }
  }
  const representatives = snapshot.representativeNames.map((name) => name.trim()).filter(Boolean);
  if (representatives.length === 0) {
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
    (d) =>
      (d.type === 'HANDELSREGISTERAUSZUG' || d.type === 'GESELLSCHAFTSVERTRAG') &&
      hasAttachedEvidence(d, snapshot.clientId),
  );
  if (!entityEvidence) {
    errors.push(
      'Registerauszug oder beweiskräftiges Gründungsdokument mit Datei ist erforderlich (§ 12 Abs. 2 GwG).',
    );
  }

  const transparencyEvidence = snapshot.idDocuments.some(
    (d) => d.type === 'TRANSPARENZREGISTER_AUSZUG' && hasAttachedEvidence(d, snapshot.clientId),
  );
  if (!transparencyEvidence) {
    errors.push(
      'Nachweis/ Auszug aus dem Transparenzregister ist für die neue Geschäftsbeziehung erforderlich (§ 12 Abs. 3 GwG).',
    );
  }

  const representativeSet = new Set(representatives.map(normalizedName));
  const identifiedRepresentative = personalIds.some((d) =>
    representativeSet.has(normalizedName(d.ownerName)),
  );
  if (!identifiedRepresentative) {
    errors.push(
      'Mindestens eine auftretende vertretungsberechtigte Person muss mit gültigem Ausweis identifiziert sein.',
    );
  }

  return errors;
}
