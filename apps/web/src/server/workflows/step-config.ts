// =============================================================================
// Workflow-Schritt-Konfiguration
//
// Jeder Schritt-Typ hat seine eigene Konfig-Struktur, die als JSON in
// `workflow_step.config` (Vorlage) bzw. `workflow_item.config` (Instanz)
// liegt. Hier liegen die Zod-Schemata + ein typsicheres Discriminated-Union.
// =============================================================================

import { z } from 'zod';

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

// -----------------------------------------------------------------------------
// Per-Kind-Schemata
// -----------------------------------------------------------------------------

export const TaskConfig = z.object({}).strict();
export const DocumentUploadConfig = z
  .object({
    expectedClassification: z.enum(DOCUMENT_CLASSIFICATIONS),
  })
  .strict();
export const ClientRequestConfig = z
  .object({
    // Wenn requestTemplateId gesetzt ist, werden Titel/Beschreibung/Priorität
    // zur Laufzeit aus der Vorlage gelesen — die Inline-Felder sind dann nur
    // Fallback für den Fall, dass die Vorlage gelöscht wurde.
    requestTemplateId: z.string().uuid().optional(),
    requestTitle: z.string().max(200).default(''),
    requestDescription: z.string().max(5000).default(''),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    dueAfterDays: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .refine(
    (v) => v.requestTemplateId || v.requestTitle.trim().length > 0,
    { message: 'Vorlage wählen oder Titel angeben.' },
  );
export const ClientFormConfig = z
  .object({
    formTemplateId: z.string().uuid(),
    requestTitle: z.string().min(1).max(200).default('Bitte Formular ausfüllen'),
    requestDescription: z.string().max(2000).default(''),
  })
  .strict();
export const ClientEmailConfig = z
  .object({
    // Wenn emailTemplateId gesetzt ist, werden Subject/Body zur Laufzeit aus
    // der Vorlage gelesen. Die Inline-Felder sind dann Fallback.
    emailTemplateId: z.string().uuid().optional(),
    subject: z.string().max(200).default(''),
    bodyMd: z.string().max(10_000).default(''),
  })
  .strict()
  .refine(
    (v) => v.emailTemplateId || (v.subject.trim().length > 0 && v.bodyMd.trim().length > 0),
    { message: 'Vorlage wählen oder Betreff + Text inline angeben.' },
  );
export const N8nTriggerConfig = z
  .object({
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

export type WorkflowStepConfig =
  | { kind: 'TASK';            config: z.infer<typeof TaskConfig> }
  | { kind: 'DOCUMENT_UPLOAD'; config: z.infer<typeof DocumentUploadConfig> }
  | { kind: 'CLIENT_REQUEST';  config: z.infer<typeof ClientRequestConfig> }
  | { kind: 'CLIENT_FORM';     config: z.infer<typeof ClientFormConfig> }
  | { kind: 'CLIENT_EMAIL';    config: z.infer<typeof ClientEmailConfig> }
  | { kind: 'N8N_TRIGGER';     config: z.infer<typeof N8nTriggerConfig> };

const SCHEMA_BY_KIND = {
  TASK: TaskConfig,
  DOCUMENT_UPLOAD: DocumentUploadConfig,
  CLIENT_REQUEST: ClientRequestConfig,
  CLIENT_FORM: ClientFormConfig,
  CLIENT_EMAIL: ClientEmailConfig,
  N8N_TRIGGER: N8nTriggerConfig,
} as const;

export function parseStepConfig(
  kind: keyof typeof SCHEMA_BY_KIND,
  raw: unknown,
):
  | { ok: true; value: unknown }
  | { ok: false; error: string } {
  const schema = SCHEMA_BY_KIND[kind];
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, value: parsed.data };
}

export function defaultConfigFor(kind: keyof typeof SCHEMA_BY_KIND): unknown {
  switch (kind) {
    case 'TASK': return {};
    case 'DOCUMENT_UPLOAD': return { expectedClassification: 'GENERAL' };
    case 'CLIENT_REQUEST': return { requestTemplateId: undefined, requestTitle: '', requestDescription: '', priority: 'NORMAL' };
    case 'CLIENT_FORM': return { formTemplateId: '', requestTitle: 'Bitte Formular ausfüllen', requestDescription: '' };
    case 'CLIENT_EMAIL': return { emailTemplateId: undefined, subject: '', bodyMd: '' };
    case 'N8N_TRIGGER': return {};
  }
}

export const KIND_LABELS: Record<keyof typeof SCHEMA_BY_KIND, string> = {
  TASK: 'Manuelle Aufgabe',
  DOCUMENT_UPLOAD: 'Dokument hochladen',
  CLIENT_REQUEST: 'Anforderung an Mandant',
  CLIENT_FORM: 'Formular an Mandant',
  CLIENT_EMAIL: 'E-Mail an Mandant',
  N8N_TRIGGER: 'n8n-Webhook auslösen',
};

export const KIND_DESCRIPTIONS: Record<keyof typeof SCHEMA_BY_KIND, string> = {
  TASK: 'Reine Checkliste — Mitarbeiter hakt ab, wenn erledigt.',
  DOCUMENT_UPLOAD: 'Mitarbeiter lädt ein Dokument hoch. Die Klassifizierung ist vorgegeben — das Dokument landet automatisch im richtigen Bucket.',
  CLIENT_REQUEST: 'Beim Anstoßen wird eine Anforderung an den Mandanten erzeugt. Der Schritt ist erledigt, sobald die Anforderung geschlossen wird.',
  CLIENT_FORM: 'Beim Anstoßen wird ein Formular an den Mandanten geschickt. Erledigt, sobald der Mandant es abgeschickt hat.',
  CLIENT_EMAIL: 'Sendet eine vordefinierte E-Mail an alle aktiven Portal-Kontakte des Mandanten.',
  N8N_TRIGGER: 'Feuert ausschließlich den hinterlegten n8n-Webhook. Was dort passiert, regelt n8n.',
};
