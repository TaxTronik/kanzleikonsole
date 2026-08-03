// =============================================================================
// Workflow-Schritt-Typen — reine Konstanten, Labels und Defaults.
//
// Bewusst OHNE zod: Die Builder-UI (add-step-form, Template-Editor) importiert
// diese Werte in Client-Komponenten. Als sie noch in
// `server/workflows/step-config.ts` lagen, zog der Import das komplette
// zod-Bundle (~280 KB unkomprimiert) in den Client-Chunk der Workflow- und
// Nachbarseiten — für ein Dropdown mit sechs Einträgen. Die zod-Schemata
// (Validierung ist Server-Sache) bleiben in `server/workflows/step-config.ts`,
// das die Werte hier re-exportiert.
//
// Gleiche Aufteilung wie `lib/subsumtion-rights.ts` / `lib/staff-permissions.ts`.
// =============================================================================

// Erlaubte Dokumentenklassen — Wiederholung aus packages/storage, damit wir
// nicht hart auf die Storage-Schicht koppeln (die UI braucht das in einem
// Drop-down ohne Server-Roundtrip).
export const DOCUMENT_CLASSIFICATIONS = [
  'GOBD_INVOICE',
  'GOBD_CONTRACT',
  'GOBD_TAX',
  'GWG_EVIDENCE',
  'PERSONNEL',
  'STAFF_PRIVATE',
  'GENERAL',
] as const;

export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

export const WORKFLOW_STEP_KINDS = [
  'TASK',
  'DOCUMENT_UPLOAD',
  'CLIENT_REQUEST',
  'CLIENT_FORM',
  'CLIENT_EMAIL',
  'N8N_TRIGGER',
] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export function defaultConfigFor(kind: WorkflowStepKind): unknown {
  switch (kind) {
    case 'TASK':
      return {};
    case 'DOCUMENT_UPLOAD':
      return { expectedClassification: 'GENERAL' };
    case 'CLIENT_REQUEST':
      return {
        requestTemplateId: undefined,
        requestTitle: '',
        requestDescription: '',
        priority: 'NORMAL',
      };
    case 'CLIENT_FORM':
      return {
        formTemplateId: '',
        requestTitle: 'Bitte Formular ausfüllen',
        requestDescription: '',
      };
    case 'CLIENT_EMAIL':
      return { emailTemplateId: undefined, subject: '', bodyMd: '' };
    case 'N8N_TRIGGER':
      return {};
  }
}

export const KIND_LABELS: Record<WorkflowStepKind, string> = {
  TASK: 'Manuelle Aufgabe',
  DOCUMENT_UPLOAD: 'Dokument hochladen',
  CLIENT_REQUEST: 'Anforderung an Mandant',
  CLIENT_FORM: 'Formular an Mandant',
  CLIENT_EMAIL: 'E-Mail an Mandant',
  N8N_TRIGGER: 'n8n-Webhook auslösen',
};

export const KIND_DESCRIPTIONS: Record<WorkflowStepKind, string> = {
  TASK: 'Reine Checkliste — Mitarbeiter hakt ab, wenn erledigt.',
  DOCUMENT_UPLOAD:
    'Mitarbeiter lädt ein Dokument hoch. Die Klassifizierung ist vorgegeben — das Dokument landet automatisch im richtigen Bucket.',
  CLIENT_REQUEST:
    'Beim Anstoßen wird eine Anforderung an den Mandanten erzeugt. Der Schritt ist erledigt, sobald die Anforderung geschlossen wird.',
  CLIENT_FORM:
    'Beim Anstoßen wird ein Formular an den Mandanten geschickt. Erledigt, sobald der Mandant es abgeschickt hat.',
  CLIENT_EMAIL: 'Sendet eine vordefinierte E-Mail an alle aktiven Portal-Kontakte des Mandanten.',
  N8N_TRIGGER: 'Feuert ausschließlich den hinterlegten n8n-Webhook. Was dort passiert, regelt n8n.',
};
