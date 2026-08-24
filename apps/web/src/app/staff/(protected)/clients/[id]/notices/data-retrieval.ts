// Fachkatalog: TAX-NOTICE-DATARETRIEVAL-001

export type RetrievalConsentStatus = 'NOT_APPLICABLE' | 'CONFIRMED' | 'NOT_GIVEN' | 'UNKNOWN';
export type RetrievalEligibilityStatus = 'NOT_APPLICABLE' | 'CONFIRMED' | 'NOT_MET' | 'UNKNOWN';
export type RetrievalPostalRequestStatus =
  | 'NOT_APPLICABLE'
  | 'NONE_EFFECTIVE'
  | 'EFFECTIVE'
  | 'UNKNOWN';
export type RetrievalNotificationStatus = 'NOT_RECORDED' | 'SENT' | 'FAILED' | 'UNKNOWN';

export interface DataRetrievalEvidenceInput {
  deliveryMethod: string;
  /** Bei § 122a AO der dokumentierte Bereitstellungstag. */
  provisionDate: Date;
  issuedAt: Date | null;
  notificationDate: Date | null;
  notificationDisputedOrLate: boolean;
  retrievedAt: Date | null;
  consentStatus: RetrievalConsentStatus;
  eligibility2027Status: RetrievalEligibilityStatus;
  postalRequestStatus: RetrievalPostalRequestStatus;
  postalRequestReceivedAt: Date | null;
  notificationStatus: RetrievalNotificationStatus;
  today: Date;
}

export type DataRetrievalEvidenceResult = { ok: true } | { ok: false; error: string };

function invalid(error: string): DataRetrievalEvidenceResult {
  return { ok: false, error };
}

function validateNonRetrievalEvidence(
  input: DataRetrievalEvidenceInput,
): DataRetrievalEvidenceResult {
  const hasRetrievalEvidence =
    Boolean(input.issuedAt) ||
    Boolean(input.notificationDate) ||
    input.notificationDisputedOrLate ||
    Boolean(input.retrievedAt) ||
    Boolean(input.postalRequestReceivedAt) ||
    input.consentStatus !== 'NOT_APPLICABLE' ||
    input.eligibility2027Status !== 'NOT_APPLICABLE' ||
    input.postalRequestStatus !== 'NOT_APPLICABLE' ||
    input.notificationStatus !== 'NOT_RECORDED';

  return hasRetrievalEvidence
    ? invalid('§-122a-Angaben sind nur beim Bekanntgabeweg Datenabruf zulässig.')
    : { ok: true };
}

/**
 * Validiert die rechtsstandsabhängigen §-122a-Eingaben. Bereitstellung,
 * Benachrichtigung, Abruf, Einwilligung und Postantrag bleiben getrennte
 * Tatsachen; insbesondere sind Benachrichtigung und Abruf im Neurecht als
 * Kontrollinformation zulässig und kein Ersatz für die Bereitstellung.
 */
export function validateDataRetrievalEvidence(
  input: DataRetrievalEvidenceInput,
): DataRetrievalEvidenceResult {
  if (input.deliveryMethod !== 'DATA_RETRIEVAL') {
    return validateNonRetrievalEvidence(input);
  }

  if (!input.issuedAt) return invalid('Beim Datenabruf ist das Erlassdatum erforderlich.');
  if (input.issuedAt > input.today || input.issuedAt > input.provisionDate) {
    return invalid('Das Erlassdatum darf weder zukünftig noch nach der Bereitstellung liegen.');
  }

  for (const [date, label] of [
    [input.notificationDate, 'Benachrichtigung'],
    [input.retrievedAt, 'Abruf'],
    [input.postalRequestReceivedAt, 'Postantrag'],
  ] as const) {
    if (date && date > input.today) {
      return invalid(`${label}: Datum darf nicht in der Zukunft liegen.`);
    }
  }
  if (input.notificationDate && input.notificationDate < input.provisionDate) {
    return invalid('Die Benachrichtigung darf nicht vor der Bereitstellung liegen.');
  }
  if (input.retrievedAt && input.retrievedAt < input.provisionDate) {
    return invalid('Der Abruf darf nicht vor der Bereitstellung liegen.');
  }
  if (input.notificationStatus === 'SENT' && !input.notificationDate) {
    return invalid('Für eine versandte Benachrichtigung ist das Versanddatum erforderlich.');
  }
  if (input.notificationStatus === 'NOT_RECORDED' && input.notificationDate) {
    return invalid(
      'Ein Benachrichtigungsdatum darf nicht zugleich als „nicht erfasst“ eingeordnet werden.',
    );
  }

  const year = input.issuedAt.getUTCFullYear();
  if (year <= 2025) {
    if (!input.notificationDate) {
      return invalid('Im Altrecht ist der Versandtag der Benachrichtigung erforderlich.');
    }
    if (
      input.consentStatus !== 'NOT_APPLICABLE' ||
      input.eligibility2027Status !== 'NOT_APPLICABLE' ||
      input.postalRequestStatus !== 'NOT_APPLICABLE' ||
      input.postalRequestReceivedAt
    ) {
      return invalid(
        'Einwilligung und Postantrag des Neurechts sind auf diesen Altfall nicht anwendbar.',
      );
    }
    if (!input.notificationDisputedOrLate && input.notificationStatus !== 'SENT') {
      return invalid(
        'Im Altrecht darf nur ein bestätigter Versand der Benachrichtigung die Fiktionsberechnung auslösen.',
      );
    }
    return { ok: true };
  }

  if (input.notificationDisputedOrLate) {
    return invalid(
      'Der Streit-/Verspätungsmarker zum Benachrichtigungszugang ist nur im Altrecht bis 2025 anwendbar.',
    );
  }

  if (year === 2026) {
    if (input.consentStatus === 'NOT_APPLICABLE') {
      return invalid('Für 2026 muss der Einwilligungsstatus dokumentiert werden.');
    }
    if (
      input.eligibility2027Status !== 'NOT_APPLICABLE' ||
      input.postalRequestStatus !== 'NOT_APPLICABLE' ||
      input.postalRequestReceivedAt
    ) {
      return invalid(
        'Die Ab-2027-Angaben sind auf einen 2026 erlassenen Bescheid nicht anwendbar.',
      );
    }
    return { ok: true };
  }

  if (
    input.eligibility2027Status === 'NOT_APPLICABLE' ||
    input.postalRequestStatus === 'NOT_APPLICABLE'
  ) {
    return invalid('Ab 2027 müssen Voraussetzungen und Postantrag getrennt bewertet werden.');
  }
  if (input.consentStatus !== 'NOT_APPLICABLE') {
    return invalid('Der besondere 2026-Einwilligungsstatus ist ab 2027 nicht anwendbar.');
  }
  if (input.postalRequestStatus === 'EFFECTIVE' && !input.postalRequestReceivedAt) {
    return invalid('Für einen wirksamen Postantrag ist dessen Zugangstag erforderlich.');
  }
  if (
    ['NOT_APPLICABLE', 'NONE_EFFECTIVE'].includes(input.postalRequestStatus) &&
    input.postalRequestReceivedAt
  ) {
    return invalid(
      'Ohne wirksamen Postantrag darf kein Zugangstag des Postantrags gespeichert werden.',
    );
  }

  return { ok: true };
}
