// =============================================================================
// Offene Portal-Formulare — eine Regel für Formularliste und Startseite
//
// Fachkatalog: REQ-LIFECYCLE-001. Ein Formular ist für den Mandanten nur offen,
// solange es selbst PENDING/DRAFT ist UND seine Anforderung noch offen ist. Ist
// die gebundene Anforderung geschlossen oder abgebrochen (oder fehlt sie), zeigt
// /portal/forms das Formular als „Geschlossen“; die Startseite darf es dann
// weder zählen noch als To-do anbieten.
// =============================================================================

export const PORTAL_FORM_OPEN_STATUSES = ['PENDING', 'DRAFT'] as const;

const OPEN_REQUEST_STATUSES: ReadonlySet<string> = new Set(['OPEN', 'IN_PROGRESS']);

export interface PortalFormOpenCandidate {
  readonly status: string;
  readonly requestId: string | null;
  /** Anforderungen mit Rücklink auf das Formular (Tenant und Mandant gefiltert). */
  readonly requests: ReadonlyArray<{ readonly id: string; readonly status: string }>;
}

/**
 * Geschlossen, sobald die gebundene Anforderung (requestId) fehlt oder nicht
 * mehr offen ist; ohne requestId fail-closed über alle verknüpften
 * Anforderungen (Altbestände ohne eindeutigen Rücklink).
 */
export function isPortalFormRequestClosed(submission: PortalFormOpenCandidate): boolean {
  const requests = submission.requestId
    ? submission.requests.filter((candidate) => candidate.id === submission.requestId)
    : submission.requests;
  if (submission.requestId && requests.length !== 1) return true;
  return requests.some((request) => !OPEN_REQUEST_STATUSES.has(request.status));
}

export function isPortalFormOpen(submission: PortalFormOpenCandidate): boolean {
  return (
    (PORTAL_FORM_OPEN_STATUSES as readonly string[]).includes(submission.status) &&
    !isPortalFormRequestClosed(submission)
  );
}
