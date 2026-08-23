export interface DataRetrievalEvidenceInput {
  deliveryMethod: string;
  provisionDate: Date;
  issuedAt: Date | null;
  notificationDate: Date | null;
  notificationDisputedOrLate: boolean;
  retrievedAt: Date | null;
  today: Date;
}

export type DataRetrievalEvidenceResult =
  | {
      ok: true;
      issuedAt: Date | null;
      notificationDate: Date | null;
      notificationDisputedOrLate: boolean;
      retrievedAt: Date | null;
    }
  | { ok: false; error: string };

function emptyEvidenceResult(): DataRetrievalEvidenceResult {
  return {
    ok: true,
    issuedAt: null,
    notificationDate: null,
    notificationDisputedOrLate: false,
    retrievedAt: null,
  };
}

function validateNonRetrievalEvidence(
  input: DataRetrievalEvidenceInput,
): DataRetrievalEvidenceResult {
  const hasRetrievalEvidence = [
    input.issuedAt,
    input.notificationDate,
    input.notificationDisputedOrLate,
    input.retrievedAt,
  ].some(Boolean);
  if (hasRetrievalEvidence) {
    return {
      ok: false,
      error: 'Abrufdaten dürfen nur für die Bekanntgabe zum Datenabruf erfasst werden.',
    };
  }
  return emptyEvidenceResult();
}

function validateNewLawEvidence(
  input: DataRetrievalEvidenceInput,
  issuedAt: Date,
): DataRetrievalEvidenceResult {
  const hasOldLawEvidence = [
    input.notificationDate,
    input.notificationDisputedOrLate,
    input.retrievedAt,
  ].some(Boolean);
  if (hasOldLawEvidence) {
    return {
      ok: false,
      error:
        'Für nach dem 31.12.2025 erlassene Bescheide gilt beim Datenabruf ausschließlich Bereitstellung + 4 Tage; altrechtliche Benachrichtigungs-/Abrufangaben sind nicht zulässig.',
    };
  }
  return {
    ok: true,
    issuedAt,
    notificationDate: null,
    notificationDisputedOrLate: false,
    retrievedAt: null,
  };
}

function validateOldLawEvidence(
  input: DataRetrievalEvidenceInput,
  issuedAt: Date,
): DataRetrievalEvidenceResult {
  if (!input.notificationDate) {
    return {
      ok: false,
      error:
        'Für einen bis 31.12.2025 erlassenen Bescheid ist der Versandtag der elektronischen Benachrichtigung erforderlich.',
    };
  }
  if (input.notificationDate > input.today) {
    return { ok: false, error: 'Der Benachrichtigungstag darf nicht in der Zukunft liegen.' };
  }
  if (input.notificationDate < input.provisionDate) {
    return {
      ok: false,
      error: 'Der Benachrichtigungstag darf nicht vor der Bereitstellung liegen.',
    };
  }
  if (input.retrievedAt && input.retrievedAt > input.today) {
    return { ok: false, error: 'Der tatsächliche Abruftag darf nicht in der Zukunft liegen.' };
  }
  if (input.retrievedAt && input.retrievedAt < input.provisionDate) {
    return { ok: false, error: 'Der tatsächliche Abruf darf nicht vor der Bereitstellung liegen.' };
  }
  if (!input.notificationDisputedOrLate && input.retrievedAt) {
    return {
      ok: false,
      error:
        'Ein tatsächlicher Abruftag ist nur bei bestrittener oder verspäteter Benachrichtigung fristauslösend.',
    };
  }

  return {
    ok: true,
    issuedAt,
    notificationDate: input.notificationDate,
    notificationDisputedOrLate: input.notificationDisputedOrLate,
    retrievedAt: input.retrievedAt,
  };
}

/**
 * Validiert die zum gesetzlichen Stichtag unterschiedliche §-122a-Evidenz.
 * Die Funktion ist bewusst rein, damit Server-Action und Tests dieselbe
 * fachliche Regel verwenden.
 */
export function validateDataRetrievalEvidence(
  input: DataRetrievalEvidenceInput,
): DataRetrievalEvidenceResult {
  if (input.deliveryMethod !== 'DATA_RETRIEVAL') {
    return validateNonRetrievalEvidence(input);
  }

  if (!input.issuedAt) {
    return {
      ok: false,
      error: 'Beim Datenabruf ist das Erlass-/Bescheiddatum erforderlich.',
    };
  }
  if (input.issuedAt > input.today) {
    return { ok: false, error: 'Das Erlass-/Bescheiddatum darf nicht in der Zukunft liegen.' };
  }
  if (input.issuedAt > input.provisionDate) {
    return {
      ok: false,
      error: 'Die Bereitstellung darf nicht vor Erlass des Bescheids liegen.',
    };
  }

  const usesOldLaw = input.issuedAt.getTime() < Date.UTC(2026, 0, 1);
  if (!usesOldLaw) {
    return validateNewLawEvidence(input, input.issuedAt);
  }
  return validateOldLawEvidence(input, input.issuedAt);
}
