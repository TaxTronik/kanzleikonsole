export type DsgvoWorkflowStatus = 'RECEIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
export type DsgvoWorkflowType =
  | 'ACCESS'
  | 'RECTIFICATION'
  | 'ERASURE'
  | 'RESTRICTION'
  | 'PORTABILITY'
  | 'OBJECTION';

const TRANSITIONS: Record<DsgvoWorkflowStatus, readonly DsgvoWorkflowStatus[]> = {
  RECEIVED: ['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'],
  IN_PROGRESS: ['IN_PROGRESS', 'COMPLETED', 'REJECTED'],
  COMPLETED: [],
  REJECTED: [],
};

export interface DsgvoStatusEvidence {
  from: DsgvoWorkflowStatus;
  to: DsgvoWorkflowStatus;
  type: DsgvoWorkflowType;
  notes: string;
  responseSentAt: Date | null;
  responseMethod: string;
  rejectionReason: string;
  rejectionNoticeComplete: boolean;
  hasResultArtifact: boolean;
  resultReviewed: boolean;
  resultReviewedOn: Date | null;
}

/** Liefert die fachliche Fehlermeldung oder null, wenn der Wechsel belastbar ist. */
export function validateDsgvoStatusEvidence(input: DsgvoStatusEvidence): string | null {
  if (!TRANSITIONS[input.from].includes(input.to)) {
    return `Statuswechsel ${input.from} → ${input.to} ist nicht zulässig.`;
  }

  if (input.to === 'COMPLETED') {
    if (input.notes.trim().length < 10) {
      return 'Für den Abschluss müssen die durchgeführten Maßnahmen dokumentiert werden.';
    }
    if ((input.type === 'ACCESS' || input.type === 'PORTABILITY') && !input.hasResultArtifact) {
      return 'Auskunft oder Portabilität darf nur mit erzeugtem bzw. hinterlegtem Ergebnis abgeschlossen werden.';
    }
    if ((input.type === 'ACCESS' || input.type === 'PORTABILITY') && !input.resultReviewed) {
      return 'Das Ergebnis muss vor Versand und Abschluss personell auf Vollständigkeit geprüft werden.';
    }
    if (
      (input.type === 'ACCESS' || input.type === 'PORTABILITY') &&
      input.responseSentAt &&
      input.resultReviewedOn &&
      input.responseSentAt < input.resultReviewedOn
    ) {
      return 'Der Antwortversand darf nicht vor der dokumentierten Ergebnisprüfung liegen.';
    }
  }

  if (input.to === 'COMPLETED' || input.to === 'REJECTED') {
    if (!input.responseSentAt || input.responseMethod.trim().length < 2) {
      return 'Für den Abschluss sind Versandtag und Antwortweg erforderlich.';
    }
  }

  if (input.to === 'REJECTED') {
    if (input.rejectionReason.trim().length < 10) {
      return 'Eine Ablehnung benötigt eine nachvollziehbare Begründung.';
    }
    if (!input.rejectionNoticeComplete) {
      return 'Die Ablehnungsmitteilung muss auf Beschwerdemöglichkeit und gerichtlichen Rechtsbehelf hinweisen.';
    }
  }

  return null;
}
